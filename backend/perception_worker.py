import sys
from importlib import import_module
module=import_module("backend.computer_vision.worker")
if __name__=="__main__":module.main()
else:sys.modules[__name__]=module
