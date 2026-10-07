"""Connection generations, timeout and cleanup for any SimulationProvider."""
from enum import Enum
import threading
import time
from .contracts import finite


class ConnectionState(str, Enum):
    CONNECTING = 'CONNECTING'
    CONNECTED = 'CONNECTED'
    DISCONNECTED = 'DISCONNECTED'
    ERROR = 'ERROR'


class ConnectionLifecycle:
    def __init__(self, timeout_s=10, now=time.monotonic):
        if finite(timeout_s) <= 0:
            raise ValueError('Connection timeout must be positive')
        self.timeout_s, self.now = timeout_s, now
        self.state = ConnectionState.DISCONNECTED
        self.error = None
        self.deadline = None
        self.generation = 0

    def begin(self):
        if self.state in (ConnectionState.CONNECTING, ConnectionState.CONNECTED):
            raise RuntimeError('Disconnect the current session before reconnecting')
        self.generation += 1
        self.state, self.error = ConnectionState.CONNECTING, None
        self.deadline = self.now()+self.timeout_s
        return self.generation

    def connected(self, generation):
        self.poll()
        if generation != self.generation or self.state != ConnectionState.CONNECTING:
            return False
        self.state = ConnectionState.CONNECTED
        self.deadline = None
        return True

    def fail(self, error):
        self.state, self.error, self.deadline = ConnectionState.ERROR, str(error), None

    def poll(self):
        if self.state == ConnectionState.CONNECTING and self.now() >= self.deadline:
            self.fail('Connection timeout; late completion cannot enable controls')
        return self.state

    def disconnect(self):
        self.generation += 1
        self.state, self.deadline = ConnectionState.DISCONNECTED, None


class ConnectionSupervisor:
    """Bounded caller wait; SDK cancellation is not assumed.

    A late connection is closed in its worker. Reconnect is rejected while that
    worker is still active. Shutdown reports an unconfirmed cleanup if it cannot
    join; it never claims an uncancellable SDK call has been interrupted.
    """
    def __init__(self, timeout_s=10):
        self.lifecycle = ConnectionLifecycle(timeout_s)
        self.lock = threading.RLock()
        self.thread = self.provider = None
        self.finished = threading.Event()
        self.cleanup_error = None

    def connect(self, provider):
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise RuntimeError('Previous connection attempt is still cleaning up')
            generation = self.lifecycle.begin()
            self.provider = provider
            self.finished.clear()
            self.cleanup_error = None
        def work():
            try:
                provider.connect()
                if not provider.is_connected():
                    raise RuntimeError('Provider did not confirm a native connection')
                with self.lock:
                    accepted = self.lifecycle.connected(generation)
                if not accepted:
                    self._close(provider)
            except Exception as error:
                with self.lock:
                    if self.lifecycle.generation == generation:
                        self.lifecycle.fail(error)
                try:
                    self._close(provider)
                except Exception as cleanup:
                    self.cleanup_error = str(cleanup)
            finally:
                self.finished.set()
        self.thread = threading.Thread(target=work, name='provider-connection', daemon=True)
        self.thread.start()
        if not self.finished.wait(self.lifecycle.timeout_s):
            with self.lock:
                self.lifecycle.fail('Connection timeout; waiting for provider cleanup')
            raise TimeoutError(self.lifecycle.error)
        with self.lock:
            if self.lifecycle.state != ConnectionState.CONNECTED:
                raise RuntimeError(self.lifecycle.error or 'Connection cancelled')
        return provider

    @staticmethod
    def _close(provider):
        provider.close()
        errors = getattr(provider, 'cleanup_errors', [])
        if isinstance(errors, (list, tuple)) and errors:
            raise RuntimeError('; '.join(errors))

    def disconnect(self, cleanup_timeout_s=15):
        with self.lock:
            was_connected = self.lifecycle.state == ConnectionState.CONNECTED
            self.lifecycle.disconnect()
        if self.thread and self.thread.is_alive():
            self.thread.join(cleanup_timeout_s)
            if self.thread.is_alive():
                raise RuntimeError('Connection worker still active; cleanup unconfirmed')
        if was_connected and self.provider:
            self._close(self.provider)
        if self.cleanup_error:
            raise RuntimeError('Connection cleanup unconfirmed: '+self.cleanup_error)
        self.provider = None
