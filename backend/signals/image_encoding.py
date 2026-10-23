"""One in-flight native image and one replaceable pending image per camera."""
import threading
from ..core.host_clock import monotonic


class LatestImageEncoder:
    def __init__(self, callback, *, name):
        self.callback = callback
        self.condition = threading.Condition()
        self.pending = None
        self.stopped = False
        self.error = None
        self.submitted = self.completed = self.dropped = 0
        self.failed = 0
        self.maximum_pending = 0
        self.queue_wait_ms = self.processing_ms = None
        self.thread = threading.Thread(target=self._run, name=name, daemon=True)
        self.thread.start()

    def submit(self, image, received_wall_s, received_unix_s):
        with self.condition:
            if self.stopped:
                return False
            self.submitted += 1
            if self.pending is not None:
                self.dropped += 1
            self.pending = (image, received_wall_s, received_unix_s)
            self.maximum_pending = 1
            self.condition.notify()
            return True

    def _run(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.stopped or self.pending is not None)
                if self.stopped:
                    return
                image, received, received_unix = self.pending
                self.pending = None
            began = monotonic()
            try:
                accepted = self.callback(image, received, received_unix)
            except Exception as error:
                from ..core.logging import log, LogCategory
                self.error = str(error)
                log(LogCategory.SENSOR, 'Image encoder failed', error=str(error))
                with self.condition:
                    self.stopped = True
                    self.pending = None
                return
            with self.condition:
                self.completed += int(accepted is not False)
                self.failed += int(accepted is False)
                self.queue_wait_ms = max(0., (began-received)*1000)
                self.processing_ms = (monotonic()-began)*1000

    def snapshot(self):
        with self.condition:
            return {'submitted': self.submitted, 'encoded': self.completed, 'failed':self.failed,
                'droppedBeforeEncoding': self.dropped, 'pending': int(self.pending is not None),
                'capacity': 1, 'maximumPending': self.maximum_pending,
                'queueWaitMs': self.queue_wait_ms, 'processingMs': self.processing_ms,
                'error': self.error}

    def close(self):
        with self.condition:
            self.stopped = True
            self.pending = None
            self.condition.notify_all()
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise RuntimeError('Image encoder did not stop within five seconds')
