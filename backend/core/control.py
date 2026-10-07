"""Control policy, watchdog and arbitration only. No vehicle motion is computed."""
from enum import Enum
import time
from .contracts import CommandSource, ControlCommand, finite


class ControlMode(str, Enum):
    DISCONNECTED = 'DISCONNECTED'
    PAUSED = 'PAUSED'
    MANUAL = 'MANUAL'
    ASSISTED = 'ASSISTED'
    AI = 'AI'
    EMERGENCY_STOP = 'EMERGENCY_STOP'


TRANSITIONS = {
    ControlMode.DISCONNECTED: {ControlMode.MANUAL},
    ControlMode.MANUAL: {ControlMode.PAUSED, ControlMode.ASSISTED, ControlMode.EMERGENCY_STOP, ControlMode.DISCONNECTED},
    ControlMode.ASSISTED: {ControlMode.MANUAL, ControlMode.PAUSED, ControlMode.AI, ControlMode.EMERGENCY_STOP, ControlMode.DISCONNECTED},
    ControlMode.AI: {ControlMode.MANUAL, ControlMode.PAUSED, ControlMode.ASSISTED, ControlMode.EMERGENCY_STOP, ControlMode.DISCONNECTED},
    ControlMode.PAUSED: {ControlMode.MANUAL, ControlMode.EMERGENCY_STOP, ControlMode.DISCONNECTED},
    ControlMode.EMERGENCY_STOP: {ControlMode.PAUSED, ControlMode.DISCONNECTED},
}


class ControlStateMachine:
    def __init__(self, *, allow_automation=False):
        self.mode = ControlMode.DISCONNECTED
        self.allow_automation = allow_automation

    def transition(self, target, *, connected, explicit=False):
        target = ControlMode(target)
        if target == self.mode:
            return
        if target not in TRANSITIONS[self.mode]:
            raise ValueError(f'Invalid control transition {self.mode.value} -> {target.value}')
        if target != ControlMode.DISCONNECTED and not connected:
            raise ValueError('A live connection is required')
        if target in (ControlMode.AI, ControlMode.ASSISTED) and not (self.allow_automation and explicit):
            raise ValueError('Automation requires explicit opt-in; it is disabled by default')
        if self.mode == ControlMode.EMERGENCY_STOP and target == ControlMode.PAUSED and not explicit:
            raise ValueError('Emergency stop requires an explicit acknowledgement')
        self.mode = target


def safe_command(frame_id=0, timestamp_s=0, *, source=CommandSource.SAFETY):
    return ControlCommand(frame_id, timestamp_s, 0., 1., 0., False, False, source)


class ControlSafetyLayer:
    def __init__(self, *, command_timeout_s=.35, max_sim_age_s=.35, future_tolerance_s=.001,
                 max_rate_hz=50, now=time.monotonic):
        command_timeout_s = finite(command_timeout_s, 'command_timeout_s')
        max_sim_age_s = finite(max_sim_age_s, 'max_sim_age_s')
        future_tolerance_s = finite(future_tolerance_s, 'future_tolerance_s')
        max_rate_hz = finite(max_rate_hz, 'max_rate_hz')
        if min(command_timeout_s, max_sim_age_s, max_rate_hz) <= 0 or future_tolerance_s < 0:
            raise ValueError('Invalid safety limits')
        self.timeout_s, self.max_age_s = command_timeout_s, max_sim_age_s
        self.future_tolerance_s, self.min_interval_s, self.now = future_tolerance_s, 1/max_rate_hz, now
        self.receipts = {}
        self.latest = {}
        self.emergency = False
        self.armed_at = now()

    @staticmethod
    def normalize(data):
        values = dict(data)
        for field, lower in (('throttle', 0), ('brake', 0), ('steering', -1)):
            values[field] = min(1., max(lower, finite(values[field], field)))
        values['source'] = CommandSource(values['source'])
        # A handbrake/brake request cannot simultaneously apply engine power.
        if values.get('handbrake') is True or values['brake'] > 0:
            values['throttle'] = 0.
        return ControlCommand(**values)

    def accept(self, command, *, frame_id, timestamp_s):
        if not isinstance(command, ControlCommand):
            raise ValueError('Expected a ControlCommand')
        age = finite(timestamp_s)-command.timestamp_s
        if command.frame_id > frame_id or age < -self.future_tolerance_s or age > self.max_age_s:
            raise ValueError('Command is stale or references a future simulation frame/time')
        previous = self.latest.get(command.source)
        if previous and (command.frame_id < previous.frame_id or command.timestamp_s < previous.timestamp_s):
            raise ValueError('Out-of-order command')
        now = self.now()
        if command.source in self.receipts and now-self.receipts[command.source] < self.min_interval_s:
            raise ValueError('Command rate limit exceeded')
        command = self.normalize({**command.__dict__, 'source': command.source})
        self.receipts[command.source] = now
        self.latest[command.source] = command
        return command

    def fresh(self, source):
        return source in self.receipts and self.now()-self.receipts[source] <= self.timeout_s

    def clear(self):
        self.latest.clear()
        self.receipts.clear()
        self.armed_at = self.now()


class CommandArbiter:
    PRIORITY = (CommandSource.SAFETY, CommandSource.MANUAL, CommandSource.ASSISTED, CommandSource.AI, CommandSource.SYSTEM)

    def __init__(self, safety=None, machine=None):
        self.safety = safety or ControlSafetyLayer()
        self.machine = machine or ControlStateMachine()
        self.last_selection = None
        self.reason = 'disconnected'

    def submit(self, command, *, frame_id, timestamp_s, connected):
        if not connected or self.machine.mode in (ControlMode.DISCONNECTED, ControlMode.PAUSED, ControlMode.EMERGENCY_STOP):
            raise RuntimeError('Controls suspended in the current state')
        if command.source == CommandSource.AI and self.machine.mode != ControlMode.AI:
            raise ValueError('AI commands are not enabled')
        if command.source == CommandSource.ASSISTED and self.machine.mode != ControlMode.ASSISTED:
            raise ValueError('Assisted commands are not enabled')
        accepted = self.safety.accept(command, frame_id=frame_id, timestamp_s=timestamp_s)
        if command.source == CommandSource.MANUAL and self.machine.mode in (ControlMode.AI, ControlMode.ASSISTED):
            self.machine.transition(ControlMode.MANUAL, connected=True)
            # Old automated commands must never resume when manual input expires.
            for source in (CommandSource.AI, CommandSource.ASSISTED):
                self.safety.latest.pop(source, None)
                self.safety.receipts.pop(source, None)
        return accepted

    def choose(self, *, frame_id, timestamp_s, connected):
        mode = self.machine.mode
        if not connected or mode in (ControlMode.DISCONNECTED, ControlMode.PAUSED, ControlMode.EMERGENCY_STOP) or self.safety.emergency:
            self.reason = 'disconnected' if not connected else mode.value.lower()
            self.last_selection = safe_command(frame_id, timestamp_s)
            return self.last_selection
        allowed = {CommandSource.MANUAL, CommandSource.SAFETY, CommandSource.SYSTEM}
        if mode == ControlMode.AI:
            allowed.add(CommandSource.AI)
        if mode == ControlMode.ASSISTED:
            allowed.add(CommandSource.ASSISTED)
        for source in self.PRIORITY:
            if source in allowed and self.safety.fresh(source):
                command = self.safety.latest[source]
                if timestamp_s-command.timestamp_s <= self.safety.max_age_s:
                    self.last_selection, self.reason = command, source.value
                    return command
        if not self.safety.receipts and self.safety.now()-self.safety.armed_at <= self.safety.timeout_s:
            self.reason = 'waiting_for_first_command'
            self.last_selection = safe_command(frame_id, timestamp_s)
            return self.last_selection
        self.machine.transition(ControlMode.PAUSED, connected=True)
        self.safety.clear()
        self.reason = 'command_timeout'
        self.last_selection = safe_command(frame_id, timestamp_s)
        return self.last_selection

    def emergency_stop(self, *, connected):
        self.safety.clear()
        self.safety.emergency = True
        if connected:
            self.machine.transition(ControlMode.EMERGENCY_STOP, connected=True)

    def acknowledge_stop(self, *, connected):
        self.machine.transition(ControlMode.PAUSED, connected=connected, explicit=True)
        self.safety.emergency = False
        self.safety.clear()

    def disconnect(self):
        self.safety.clear()
        self.machine.transition(ControlMode.DISCONNECTED, connected=False)
