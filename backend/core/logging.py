"""Structured JSON logging with distinct host UTC and simulator time fields."""
from datetime import datetime, timezone
from enum import Enum
import json
import logging
from .contracts import freeze_json, to_dict


class LogCategory(str, Enum):
    SIMULATION = 'SIMULATION'
    CONNECTION = 'CONNECTION'
    VEHICLE = 'VEHICLE'
    CONTROL = 'CONTROL'
    SENSOR = 'SENSOR'
    RECORDING = 'RECORDING'
    REPLAY = 'REPLAY'
    EVALUATION = 'EVALUATION'
    AI = 'AI'
    SAFETY = 'SAFETY'


class JsonFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({'timestamp_utc': datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
                           'level': record.levelname, **getattr(record, 'structured', {'message': record.getMessage()})}, allow_nan=False)


def configure_logging(stream=None, level=logging.INFO):
    logger = logging.getLogger('simulation')
    logger.setLevel(level)
    logger.propagate = False
    if not logger.handlers:
        handler = logging.StreamHandler(stream)
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
    return logger


def log(category, message, *, frame_id=None, timestamp_s=None, run_id=None, level=logging.INFO, **payload):
    if not isinstance(category, LogCategory):
        raise ValueError('Logging category must be explicit')
    record = {'category': category.value, 'message': message, 'frame_id': frame_id,
              'simulation_timestamp_s': timestamp_s, 'run_id': run_id, 'payload': payload}
    freeze_json(record)
    logging.getLogger('simulation').log(level, message, extra={'structured': to_dict(record)})
