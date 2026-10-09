"""Compatibility import; implementation lives in backend.signals.timing."""
import sys
from importlib import import_module
sys.modules[__name__] = import_module("backend.signals.timing")
