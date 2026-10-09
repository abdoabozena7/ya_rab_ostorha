"""Bounded English character recognition on image-derived text proposals."""
import numpy as np


def text_regions(rgb, detections):
    import cv2
    height,width=rgb.shape[:2]
    regions=[]
    for detection in detections:
        if detection['class']=='stop sign':
            x1,y1,x2,y2=detection['xyxy'];w=x2-x1;h=y2-y1
            regions.append((int(x1+w*.18),int(y1+h*.3),int(x2-w*.18),int(y2-h*.3)))
    # Small horizontal high-contrast connected components; never model labels.
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    edges=cv2.morphologyEx(gray,cv2.MORPH_GRADIENT,cv2.getStructuringElement(cv2.MORPH_RECT,(3,3)))
    _,mask=cv2.threshold(edges,0,255,cv2.THRESH_BINARY|cv2.THRESH_OTSU)
    mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_RECT,(9,1)))
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    proposals=[]
    for contour in contours:
        x,y,w,h=cv2.boundingRect(contour)
        if 25<=w<=width*.4 and 8<=h<=height*.12 and 1.8<=w/h<=12 and y<height*.7:
            density=cv2.countNonZero(mask[y:y+h,x:x+w])/(w*h)
            if .2<=density<=.9: proposals.append((w*h,(x,y,x+w,y+h)))
    for _,box in sorted(proposals,reverse=True):
        if not any(abs(box[0]-r[0])+abs(box[1]-r[1])<20 for r in regions):regions.append(box)
    return [(max(0,x1),max(0,y1),min(width,x2),min(height,y2)) for x1,y1,x2,y2 in regions[:2]]


class EnglishRecognizer:
    def __init__(self, directory):
        import torch
        import easyocr
        torch.set_num_threads(1);torch.set_num_interop_threads(1)
        self.reader=easyocr.Reader(['en'],gpu=False,detector=False,quantize=True,
            model_storage_directory=str(directory),download_enabled=False,verbose=False)

    def read(self, rgb, regions):
        import cv2
        result=[]
        for x1,y1,x2,y2 in regions[:2]:
            crop=rgb[y1:y2,x1:x2]
            if crop.size==0:continue
            gray=cv2.cvtColor(crop,cv2.COLOR_RGB2GRAY)
            if gray.shape[0]<32: gray=cv2.resize(gray,None,fx=32/gray.shape[0],fy=32/gray.shape[0])
            for _,text,confidence in self.reader.recognize(gray,detail=1,reformat=False,
                    decoder='greedy',workers=0,batch_size=1):
                if confidence>=.45 and len(text.strip())>=2:
                    result.append({'text':text,'confidence':float(confidence),'language':'en',
                        'polygon':[[x1,y1],[x2,y1],[x2,y2],[x1,y2]],'method':'IMAGE_CROP_RECOGNIZER'})
        return result
