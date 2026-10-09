import sys
from importlib import import_module
sys.modules[__name__]=import_module("backend.computer_vision.service")
