"""Start the pinned local NLP model. Run setup_nlp.py first."""
import argparse
import subprocess
from pathlib import Path
from setup_nlp import MODEL_NAME

ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8081)
    parser.add_argument('--cpu',action='store_true',help='Use CPU instead of Vulkan GPU')
    args=parser.parse_args()
    runtime=ROOT/'.runtime/llama/llama-server.exe'
    model=ROOT/'.cache/models/nlp'/MODEL_NAME
    if not runtime.exists() or not model.exists():
        parser.error('Run python tools/setup_nlp.py first')
    command=[str(runtime),'-m',str(model),'--alias',model.stem,'--host','127.0.0.1','--port',str(args.port),'--ctx-size','4096','--gpu-layers','0' if args.cpu else '99','--threads','4','--parallel','1','--reasoning','off','--cors-origins','localhost','--no-webui']
    try:return subprocess.call(command,cwd=ROOT)
    except KeyboardInterrupt:return 0

if __name__=='__main__':raise SystemExit(main())
