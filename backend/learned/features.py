"""Compatibility import; implementation lives in backend.learning.supervised.features."""
import sys
from importlib import import_module
sys.modules[__name__] = import_module("backend.learning.supervised.features")
