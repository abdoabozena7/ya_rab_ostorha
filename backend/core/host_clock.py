"""Precise elapsed host time aligned with the legacy monotonic clock epoch."""
import time


_OFFSET=time.monotonic()-time.perf_counter()


def monotonic():
    return time.perf_counter()+_OFFSET
