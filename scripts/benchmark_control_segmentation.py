"""CPU SegFormer-B0 benchmark on recorded CARLA images; outputs stay unadmitted."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import sys
import time
from backend.learning.pilot_budget import PilotBudget,DEFAULT_ROOT

MODEL='nvidia/segformer-b0-finetuned-cityscapes-1024-1024'


def main():
    parser=argparse.ArgumentParser();parser.add_argument('recording',type=Path)
    parser.add_argument('--labels',type=Path,help='Optional exact-frame Cityscapes-ID npy labels, independently collected')
    parser.add_argument('--seconds',type=float,default=300.);args=parser.parse_args()
    budget=PilotBudget();ticket=budget.reserve('scenario_prediction',args.seconds)
    report={'model':MODEL,'device':'CPU','control_admitted':False,'samples':[],
            'accuracy_status':'UNMEASURED_NO_INDEPENDENT_LABELS','purpose':'latency and CARLA-domain benchmark'}
    try:
        import numpy as np
        import torch
        from PIL import Image
        import transformers
        from transformers import SegformerForSemanticSegmentation
        from huggingface_hub import HfApi,hf_hub_download
        torch.set_num_threads(1)
        revision=HfApi().model_info(MODEL).sha
        model=SegformerForSemanticSegmentation.from_pretrained(MODEL,revision=revision,cache_dir='.cache/segformer').eval()
        preprocessing_path=hf_hub_download(MODEL,'preprocessor_config.json',revision=revision,cache_dir='.cache/segformer')
        preprocessing=json.loads(Path(preprocessing_path).read_text())
        report['preprocessor_sha256']=hashlib.sha256(Path(preprocessing_path).read_bytes()).hexdigest()
        report.update(revision=revision,transformers_version=transformers.__version__,torch_version=torch.__version__)
        paths=sorted((args.recording/'rgb').glob('*frontCamera*.jpg'))
        if not paths:paths=sorted((args.recording/'rgb').glob('*.jpg'))
        if not paths:raise RuntimeError('No recorded native RGB images')
        selected=[paths[i] for i in sorted(set([0,len(paths)//2,len(paths)-1]))]
        intersection=np.zeros(19,np.int64);union=np.zeros(19,np.int64)
        for path in selected:
            if time.monotonic()-ticket[1]>args.seconds-15:raise TimeoutError('Segmentation benchmark deadline')
            rgb=Image.open(path).convert('RGB');began=time.perf_counter()
            resized=np.asarray(rgb.resize((320,180),Image.Resampling.BILINEAR),np.float32)*preprocessing.get('rescale_factor',1/255.)
            normalized=(resized-np.asarray(preprocessing['image_mean']))/np.asarray(preprocessing['image_std'])
            inputs={'pixel_values':torch.from_numpy(normalized.transpose(2,0,1).copy()).float()[None]}
            with torch.inference_mode():logits=model(**inputs).logits
            labels=torch.nn.functional.interpolate(logits,size=(rgb.height,rgb.width),mode='bilinear',align_corners=False).argmax(1)[0].numpy()
            elapsed=(time.perf_counter()-began)*1000
            item={'file':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'latency_ms':elapsed,
                  'width':rgb.width,'height':rgb.height,'classes_present':np.unique(labels).tolist()}
            if args.labels and (args.labels/(path.stem+'.npy')).is_file():
                truth=np.load(args.labels/(path.stem+'.npy'),allow_pickle=False)
                if truth.shape!=labels.shape:raise ValueError('Independent labels must match the exact camera frame dimensions')
                valid=(truth>=0)&(truth<19)
                for category in range(19):
                    intersection[category]+=np.sum(valid&(labels==category)&(truth==category))
                    union[category]+=np.sum(valid&((labels==category)|(truth==category)))
                item['independent_pixels']=int(valid.sum())
            report['samples'].append(item)
        report['median_latency_ms']=statistics.median(v['latency_ms'] for v in report['samples'])
        if union.any():
            report.update(accuracy_status='INDEPENDENT_EXACT_FRAME_LABELS',mean_iou=float(np.mean(intersection[union>0]/union[union>0])))
        else:report['mean_iou']=None
    except Exception as error:report['error']=str(error)
    finally:
        try:budget.finish(ticket)
        except Exception as error:report['budget_error']=str(error)
        report['budget']=budget.status()
        target=DEFAULT_ROOT/('segmentation-'+ticket[0]+'.json');target.write_text(json.dumps(report,indent=2),encoding='utf8')
        print(json.dumps({'report':str(target),'median_latency_ms':report.get('median_latency_ms'),'mean_iou':report.get('mean_iou'),'error':report.get('error')}))
    return 0 if report['samples'] and not report.get('error') else 1


if __name__=='__main__':sys.exit(main())
