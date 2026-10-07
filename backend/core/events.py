"""Immutable simulation events; subscribers run in registration order."""
from dataclasses import dataclass
from enum import Enum
import threading
from typing import Any, Mapping
from .contracts import Contract


class EventType(str, Enum):
    SimulationStarted = 'SimulationStarted'
    SimulationStopped = 'SimulationStopped'
    VehicleSpawned = 'VehicleSpawned'
    VehicleDestroyed = 'VehicleDestroyed'
    ControlChanged = 'ControlChanged'
    CollisionDetected = 'CollisionDetected'
    SensorStarted = 'SensorStarted'
    SensorStopped = 'SensorStopped'
    ConnectionLost = 'ConnectionLost'
    EmergencyStop = 'EmergencyStop'
    RunRecordingStarted = 'RunRecordingStarted'
    RunRecordingStopped = 'RunRecordingStopped'


@dataclass(frozen=True)
class SimulationEvent(Contract):
    event_type: EventType
    frame_id: int | None
    timestamp_s: float | None
    payload: Mapping[str, Any]


class EventBus:
    def __init__(self):
        self._subscribers = []
        self._lock = threading.RLock()

    def subscribe(self, callback, event_type=None):
        entry = (event_type, callback)
        with self._lock:
            self._subscribers.append(entry)
        def unsubscribe():
            with self._lock:
                if entry in self._subscribers:
                    self._subscribers.remove(entry)
        return unsubscribe

    def publish(self, event):
        if not isinstance(event, SimulationEvent):
            raise ValueError('Expected a SimulationEvent')
        with self._lock:
            subscribers = tuple(self._subscribers)
        # Deliver to every subscriber even if one fails; do not hide the failure.
        failures = []
        for event_type, callback in subscribers:
            if event_type is None or event_type == event.event_type:
                try:
                    callback(event)
                except Exception as error:
                    failures.append(error)
        if failures:
            raise RuntimeError('Event subscriber failed: ' + '; '.join(map(str, failures)))
