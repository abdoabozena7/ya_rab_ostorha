"""Measured RGB detection with a full view and a central focus; no simulator inputs."""
import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np

def default_model_path():return Path(__file__).resolve().parents[2]/'models/yolov8s-640.onnx'

ROAD_CLASSES = {0:'person', 1:'bicycle', 2:'car', 3:'motorcycle', 5:'bus',
                7:'truck', 9:'traffic light', 11:'stop sign'}
_ROAD_LABELS = np.array(sorted(ROAD_CLASSES))


def decode_output(output, *, width, height, ratio, left, top):
    """Decode one YOLOv8 view (rows x [box, classes]) into road detections.

    A vectorized prefilter removes rows the per-row rules would reject (same
    argmax and the same skip comparison, including NaN handling); accepted
    rows are decoded by the unchanged scalar arithmetic in their original order.
    """
    import cv2
    classes = output[:, 4:]
    best = classes.argmax(axis=1)
    confidence = classes[np.arange(len(best)), best].astype(np.float64)
    minimum = np.where(np.isin(best, (9, 11)), .65, .25)
    candidates = np.flatnonzero(np.isin(best, _ROAD_LABELS) & ~(confidence < minimum))
    boxes, scores, labels = [], [], []
    for row in output[candidates]:
        label = int(row[4:].argmax()); confidence = float(row[4+label])
        if label not in ROAD_CLASSES or confidence < (.65 if label in (9,11) else .25): continue
        x,y,w,h = row[:4]
        x1,y1 = max(0.,float((x-w/2-left)/ratio)),max(0.,float((y-h/2-top)/ratio))
        x2,y2 = min(width,float((x+w/2-left)/ratio)),min(height,float((y+h/2-top)/ratio))
        if x2 <= x1 or y2 <= y1: continue
        boxes.append([x1,y1,x2-x1,y2-y1]);scores.append(confidence);labels.append(label)
    results = []
    # Class-wise NMS must not suppress a person overlapping a vehicle.
    for label in ROAD_CLASSES:
        indices = [i for i,l in enumerate(labels) if l==label]
        chosen = cv2.dnn.NMSBoxes([boxes[i] for i in indices], [scores[i] for i in indices], .25,.45)
        for local in np.asarray(chosen).reshape(-1):
            i=indices[int(local)];x,y,w,h=boxes[i]
            results.append({'class':ROAD_CLASSES[label],'confidence':scores[i],'xyxy':[x,y,x+w,y+h],
                'classification_status':'SUPPORTED' if scores[i]>=.65 else 'UNCERTAIN'})
    return sorted(results,key=lambda d:d['confidence'],reverse=True)[:256]


class RoadDetector:
    def __init__(self, path, *, profile_id=None):
        import cv2
        cv2.setNumThreads(1);cv2.ocl.setUseOpenCL(False)
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.model = ort.InferenceSession(str(path), sess_options=options,
                                         providers=['CPUExecutionProvider'])
        self.input = self.model.get_inputs()[0].name
        shape=self.model.get_inputs()[0].shape
        if len(shape)!=4 or shape[2]!=shape[3] or shape[2] not in (320,640):raise ValueError('Unsupported detector input shape')
        self.size=shape[2]
        selected=profile_id or ('YOLOV8S_640_FRONT_AND_FOCUS_V3' if self.size==640 else 'LEGACY_320')
        if selected not in ('YOLOV8S_640_FRONT_AND_FOCUS_V1','YOLOV8S_640_FRONT_AND_FOCUS_V2','YOLOV8S_640_FRONT_AND_FOCUS_V3','LEGACY_320'):raise ValueError('Unknown detector preprocessing profile')
        if (self.size==320)!=(selected=='LEGACY_320'):raise ValueError('Detector model and preprocessing profile differ')
        self.focus_divisor=2 if selected.endswith('_V1') else 4
        self.profile={'id':selected,
            'input_size':self.size,'model_sha256':hashlib.sha256(Path(path).read_bytes()).hexdigest()}

    def predict(self, rgb, *, frame_id=None):
        import cv2
        height,width=rgb.shape[:2]
        views=[rgb];offsets=[(0,0)]
        if self.size==640 and width>=600:
            side=min(height,width//self.focus_divisor);top=(height-side)//2
            # The full frame retains peripheral coverage. A single central
            # enlargement resolves small crossing people without three extra
            # CPU passes aging otherwise valid measurements out of control.
            lefts=[(width-side)//2]
            if self.profile['id'].endswith('_V3'):
                if type(frame_id)is not int or frame_id<0:raise ValueError('Roadside focus requires the canonical frame identity')
                # Keep the critical central view on every frame. One additional
                # alternating roadside crop resolves lateral people early,
                # without four simultaneous focus passes. Frame parity makes
                # the exact preprocessing reproducible in the saved export.
                lefts.append(max(0,min(width-side,(width//4 if frame_id%2==0 else 3*width//4)-side//2)))
            for left in lefts:
                views.append(rgb[top:top+side,left:left+side]);offsets.append((left,top))
        if getattr(self,'_executor',None)is None:
            # CPU EP supports concurrent Run calls. Each graph stays single
            # threaded; the fixed three-view bound avoids serially delaying
            # the central hazard result behind peripheral inference.
            self._executor=ThreadPoolExecutor(max_workers=3,thread_name_prefix='rgb-view')
        results=[]
        for found,(left,top) in zip(self._executor.map(self._view,views),offsets):
            for detection in found:
                x1,y1,x2,y2=detection['xyxy'];detection['xyxy']=[x1+left,y1+top,x2+left,y2+top];results.append(detection)
        merged=[]
        for name in ROAD_CLASSES.values():
            group=[r for r in results if r['class']==name]
            boxes=[[r['xyxy'][0],r['xyxy'][1],r['xyxy'][2]-r['xyxy'][0],r['xyxy'][3]-r['xyxy'][1]] for r in group]
            chosen=cv2.dnn.NMSBoxes(boxes,[r['confidence'] for r in group],.25,.45)
            merged.extend(group[int(i)] for i in np.asarray(chosen).reshape(-1))
        return sorted(merged,key=lambda d:d['confidence'],reverse=True)[:256]

    def close(self):
        executor=getattr(self,'_executor',None)
        if executor is not None:executor.shutdown(wait=True,cancel_futures=True);self._executor=None

    def _view(self, rgb):
        import cv2
        height, width = rgb.shape[:2]
        size=self.size;ratio = min(size/width, size/height)
        resized = cv2.resize(rgb, (round(width*ratio), round(height*ratio)))
        top, left = (size-resized.shape[0])//2, (size-resized.shape[1])//2
        padded = np.full((size,size,3), 114, np.uint8)
        padded[top:top+resized.shape[0],left:left+resized.shape[1]] = resized
        tensor = padded.transpose(2,0,1)[None].astype(np.float32)/255.
        output = self.model.run(None, {self.input:tensor})[0][0].T
        return decode_output(output, width=width, height=height, ratio=ratio, left=left, top=top)
