"""Compatibility import; implementation lives in backend.learning.rl.demonstrations."""
import sys
from importlib import import_module
sys.modules[__name__] = import_module("backend.learning.rl.demonstrations")
