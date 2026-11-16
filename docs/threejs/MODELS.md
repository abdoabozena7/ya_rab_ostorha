# النماذج المحلية وحدودها

## فهم اللغة في التليفون

- [Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)، بترخيص Apache 2.0. الملف المستخدم هو [نسخة GGUF Q4_K_M من Unsloth](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) عند revision `a06e946bb6b655725eafa393f4a9745d460374c9`؛ SHA256: `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`.
- استدلال محلي عبر [llama.cpp](https://github.com/ggml-org/llama.cpp) إصدار `b11146`، ملف Windows Vulkan مثبت ببصمة `55a378aa095b466979d85075234f66d7655c7a7483222af0c006c0e55b4d7bd6`.
- `python tools/setup_nlp.py` ينزل الملفين ويتحقق من بصمتهما. `python tools/start_nlp.py` يشغّل النموذج على `127.0.0.1:8081`؛ اترك العملية شغالة مع `python -m backend.server`. يعمل `--cpu` بلا Vulkan بسرعة أقل. النموذج ليس جزءًا من Git لأن حجمه يقارب 2.5 GB.
- `GET /api/nlp/health` يتحقق من هوية النموذج الجاري. `POST /api/intent` يقبل `text` و`environment` و`history`، ثم يرجع `action` و`destination` و`message` و`model` و`latencyMs`. يرفض الوجهات خارج القائمة، ولا يأخذ الإحداثيات من النموذج. التليفون وحده يرسل أمر الحركة إلى `World` بعد مطابقة المعرّف بقائمة الأماكن.
- `python tools/evaluate_nlp.py` يختبر 24 جملة فعلية، وآخر تقرير محلي 20/24 في `output/nlp-evaluation.json`. المجموعة صارت **مجموعة ضبط ورجوع** بعد تحسين التعليمات عليها. مجموعة الـ16 جملة سجلت 10/16 بعد تغيير لغة الرد، لكنها استُخدمت أثناء تعديل التعليمات ولم تعد مستقلة. مجموعة جديدة من 14 جملة لم تُستخدم في الضبط سجلت **7/14** في `output/nlp-holdout-2026-09-27.json`؛ لتكرارها: `python tools/evaluate_nlp.py --cases tests/fixtures/nlp-holdout-2026-09-27.json --report output/nlp-holdout-2026-09-27.json`. أخفق النموذج في فهم خدمة علاج ضمنية، طلب قطار وكورنيش، حكاية ماضية، وطلب مكان غير موجود في المختبر. لا يمكن اعتماد التليفون بوصفه فهمًا موثوقًا بعد.

## الأصول المرئية

- الشخصيات الحالية من [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox)؛ `tools/setup_people.py` ينزّل FBX والحركات ببصمات Git، و`tools/export_rocketbox.py` يصدر أربعة GLB مع خامات وحركات. ملفات Blender القابلة للتعديل في `assets/source/rocketbox/editable/`.
- عربية اللاعب من [Khronos Car Concept](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept) بإصدار مثبت `c6a6bd13ab2b3c685c7903d03561b8a9392f38b8`. `tools/setup_car.py` ينزّل المصدر الأصلي إلى `.cache/`؛ `tools/export_car.py` يحذف شعار المقود ولوحة العلامة ويجمع أجزاء الجسم الثابتة، ويكتب GLB وملف Blender قابل للتعديل. عجلاته الأربعة منفصلة وتتحرك مع `steer` والمسافة الفعلية.
- انعكاس خامات المدينة من [Poly Haven Urban Alley 01](https://polyhaven.com/a/urban_alley_01)، نسخة HDR بحجم 1K وCC0. يظهر فقط كإضاءة مواد؛ خلفية المشهد ما زالت من المحرك.
- عربيات المرور العادية تستخدم أربعة موديلات [Road Car Showroom Lineup](https://3dassets.dev/packs/road-car-showroom-lineup) بتفاصيل وعجل منفصل، مع لون تاكسي مشتق من السيدان. `python tools/setup_traffic.py` يتحقق من بصماتها، وملفات Blender القابلة للتعديل في `assets/source/traffic/`. موديلات التكاتك والمباني أبسط كثيرًا من نموذج اللاعب، والمجموعة الجديدة نفسها خفيفة التفاصيل. لا يزال المستوى البصري بعيدًا عن GTA. التفاصيل والتراخيص في [assets/LICENSES.md](../assets/LICENSES.md).

## الرؤية من صورة الكاميرا

- النموذج هو [YOLOX-Tiny الرسمي](https://github.com/Megvii-BaseDetection/YOLOX/blob/main/demo/ONNXRuntime/README.md)، إصدار ONNX `0.1.1rc0` بمدخل 416×416، وترخيص [Apache 2.0](https://github.com/Megvii-BaseDetection/YOLOX/blob/main/LICENSE). `python tools/setup_cv.py` ينزّل الملف إلى `.cache/models/cv/` ويتحقق من SHA256 `427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7`؛ وزنه نحو 20 MB ولا يدخل Git.
- `backend/computer_vision/detector.py` يستقبل JPEG الكاميرا فقط، ويعيد صناديق الأشخاص والعربيات والعجل والموتوسيكلات والأتوبيسات والنقل مع الثقة وزمن الاستدلال. واجهة الكاميرا تعرضها فوق الصورة، و`GET /api/detections` يعيد آخر نتيجة. `actors` لا تدخل النموذج أو رسم الصناديق؛ تستخدم فقط كحقيقة مرجعية عند بناء تقييم لاحق.
- هذا نموذج COCO عام؛ **لا يملك فئة حائط أو حاجز أو توكتوك**. وقد أخطأ فعليًا في لقطة من الشارع المبسط وصنّف مبنى بعيدًا كأتوبيس. لذلك الرؤية الحالية تشخيصية فقط ولا تتحكم في فرامل العربية. يلزم صور تقييم مستقلة، فئات مصرية/حواجز، قياس recall وfalse positives وزمن التأخير، ثم فصل السلامة والتحكم قبل وصلها بالقيادة.

## أشياء لم تتحول إلى نموذج بعد

لا يوجد OCR من لافتات الصورة، ولا سياسة reinforcement learning محفوظة كـweights، ولا تقييم A/B متعلم. كاشف الأجسام تجريبي وغير صالح وحده لمنع الحوادث. هذه متطلبات مفتوحة في [سجل الهدف](SIMULATION_GOAL.md).
