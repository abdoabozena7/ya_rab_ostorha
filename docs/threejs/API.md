# عقد الـAPI المحلي

الخادم `python -m backend.server` يعمل افتراضيًا على `127.0.0.1:8000`. كل المسارات أدناه من نفس الأصل. هذه واجهة محاكاة محلية، وبيانات `actors` ليست خرج كاشف الصورة.

| المسار | الوظيفة |
| --- | --- |
| `GET /api/health` | حالة الخادم |
| `POST /api/state` / `GET /api/state` | آخر حقيقة محاكاة منشورة من المتصفح |
| `POST /api/frame` / `GET /api/frame` | أحدث JPEG من كاميرا العربية، 480×270 بكسل حاليًا |
| `GET /api/detections` | آخر استدلال YOLOX-Tiny من بكسلات JPEG |
| `GET /api/nlp/health` | حالة نموذج فهم اللغة المحلي |
| `POST /api/intent` | جملة عربية → نية ومعرّف وجهة من القائمة |
| `GET /api/training` | عدد الحلقات المحفوظة وحالة العملية وملخص مقارنة A/B |
| `POST /api/training/start` / `POST /api/training/stop` | تشغيل/استكمال 24 حلقة أو إيقاف العملية، بدون جسم طلب |

`POST /api/state` يقبل JSON حتى 16 KB. الحقول المستخدمة الآن: `speedKmh` كم/س، `mode` (`manual`/`auto`)، `safety` سبب توقف أو حماية، `position` بإحداثيات المحاكاة `{x,z}` بالمتر، `onRoad`، `destination`، و`actors` القريبون بإحداثياتهم وسرعاتهم، و`sensorsM` كمصفوفة خمس مسافات مترية مفلترة بالترتيب `[-70,-35,0,35,70]` درجة حول مقدمة العربية. مصدر `sensorsM` هو هندسة المحاكاة، ويُحدَّث عند 10 Hz بفلتر median ثم low-pass، وليس من الكاميرا أو حساسات حقيقية. هذه بيانات **ground truth** للمراجعة والتدريب لاحقًا؛ لا يجوز إظهارها أو تمريرها على أنها رصد من الكاميرا. `GET /api/state` يرجع آخر رسالة مع `connected` الذي يصبح `false` إذا انقطع التحديث لأكثر من ثانيتين.

`POST /api/frame` يقبل `Content-Type: image/jpeg` حتى 400 KB. يرجع `frameId` متزايدًا. `GET /api/frame` يرجع الملف الخام و`X-Frame-Id`. تحليل الرؤية يعمل في عامل منفصل، ويستبدل الصور المنتظرة بالأحدث حتى لا يتراكم تأخير الفيديو.

مثال `GET /api/detections` بعد تثبيت النموذج ووصول صورة:

```json
{
  "schemaVersion": 1,
  "source": "camera-pixels",
  "available": true,
  "model": "YOLOX-Tiny / COCO",
  "status": "ready",
  "error": null,
  "latestFrameId": 42,
  "result": {
    "frameId": 42,
    "width": 480,
    "height": 270,
    "latencyMs": 35.3,
    "detections": [
      {
        "classId": 2,
        "label": "car",
        "labelAr": "عربية",
        "confidence": 0.535,
        "box": [431.0, 128.0, 467.3, 143.0]
      }
    ]
  }
}
```

`box` هو `[x1,y1,x2,y2]` ببكسلات الصورة، يبدأ من أعلى اليسار. `confidence` بين 0 و1. `latestFrameId` قد يسبق `result.frameId` لأن الاستدلال غير متزامن؛ المستهلك يجب أن يتحقق من قدم النتيجة. `status` يمكن أن يكون `waiting` أو`ready` أو`error`، و`available=false` عند غياب الوزن أو حزم Python. الصناديق تشخيصية وتجريبية، وليست مدخلًا موثوقًا للفرامل بعد.

التليفون يرسل `POST /api/intent` مثل `{"text":"عايز أشتري حاجات للبيت","environment":"city","history":[]}`. نتيجة النموذج تحوي `action` و`destination` و`message` و`model` و`latencyMs`. الخادم يرفض معرّفات الأماكن غير الموجودة؛ المتصفح فقط هو الذي يحول النية إلى أمر `World`. تفاصيل النموذج وحدوده في [MODELS.md](MODELS.md).

## عقد سياسة السرعة التجريبية

`output/policy-lab.json` ملف JSON بإصدار `schemaVersion: 1` وخوارزمية `tabular-q-learning` وصفوف `q`. الملاحظة في كل قرار كل 30 خطوة هي `{near|middle|far|clear}:{clear|person|obstacle}:{slow|medium|fast}` من حقيقة المحاكاة، وليس من YOLOX. الإجراءات أربعة حدود للسرعة القصوى: `0.35` و`0.6` و`0.8` و`1`. يختار الوكيل أعلى قيمة Q في الصف. المكافأة كل نصف ثانية: `0.2 × المسافة المقطوعة - 0.05 × الانتظار - 5 × تدخلات الحماية - 0.5`، مع `+10` عند الوصول و`-20` لكل مخالفة في تدقيق الحالة. السياسة تخفض السرعة المطلوبة فقط؛ `safeSpeed` وفحص الحركة يطبقان بعد ذلك.

`GET /api/training` يرجع `schemaVersion`, `running`, `exitCode`, `episodes`, `weightsReady`, و`report` بعد انتهاء تقييم ناجح. كل تجربة مكتملة تُحفظ في الملف قبل بدء التالية، بحيث يمكن الاستكمال بعد الإيقاف. مقارنة A/B تستعمل نفس seeds والإعدادات للطرفين، وتقيس الوصول، الزمن، انتظار اللاعب، تدخلات الحماية والمخالفات. التقرير الكامل في `output/policy-lab-evaluation.json`، وملف التدريب في `output/policy-lab-training.log`. المقارنة الحالية لا تُثبت تحسنًا؛ السياسة معطلة افتراضيًا.
