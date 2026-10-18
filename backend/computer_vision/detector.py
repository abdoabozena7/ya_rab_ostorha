"""Pretrained Nano detection using CPU ONNX; no control or CARLA dependencies."""
import numpy as np

ROAD_CLASSES = {0:'person', 1:'bicycle', 2:'car', 3:'motorcycle', 5:'bus',
                7:'truck', 9:'traffic light', 11:'stop sign'}


class RoadDetector:
    def __init__(self, path):
        import cv2
        cv2.setNumThreads(1);cv2.ocl.setUseOpenCL(False)
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.model = ort.InferenceSession(str(path), sess_options=options,
                                         providers=['CPUExecutionProvider'])
        self.input = self.model.get_inputs()[0].name

    def predict(self, rgb):
        import cv2
        height, width = rgb.shape[:2]
        ratio = min(320/width, 320/height)
        resized = cv2.resize(rgb, (round(width*ratio), round(height*ratio)))
        top, left = (320-resized.shape[0])//2, (320-resized.shape[1])//2
        padded = np.full((320,320,3), 114, np.uint8)
        padded[top:top+resized.shape[0],left:left+resized.shape[1]] = resized
        tensor = padded.transpose(2,0,1)[None].astype(np.float32)/255.
        output = self.model.run(None, {self.input:tensor})[0][0].T
        boxes, scores, labels = [], [], []
        for row in output:
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
        return sorted(results,key=lambda d:d['confidence'],reverse=True)[:20]
