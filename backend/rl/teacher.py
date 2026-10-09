"""Compatibility import; implementation lives in backend.learning.rl.teacher."""
import sys
from importlib import import_module
sys.modules[__name__] = import_module("backend.learning.rl.teacher")
