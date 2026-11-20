"""Bounded owned-engine snapshots; never a source of driving decisions."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import time


def inspect_snapshot(path, pid):
    if type(pid) is not int or pid <= 0:
        raise ValueError('Engine snapshot requires its positive owned process ID')
    path = Path(path)
    size = path.stat().st_size
    if not 32 <= size <= 256 * 1024**2:
        raise ValueError('Engine snapshot size is outside its bound')
    with path.open('rb') as stream:
        header = stream.read(32)
        magic, _, count, directory, _, timestamp, flags = struct.unpack('<4sIIIIIQ', header)
        if magic != b'MDMP' or not 1 <= count <= 1024 or directory + count*12 > size:
            raise ValueError('Invalid engine minidump header')
        if flags & (0x2 | 0x40 | 0x200):
            raise ValueError('Engine profiling forbids full, indirect or private-heap dumps')
        stream.seek(directory)
        entries = [struct.unpack('<III', stream.read(12)) for _ in range(count)]
        if any(offset + length > size for _,length,offset in entries):
            raise ValueError('Engine minidump stream exceeds the file')
        misc = next(((length,offset) for kind,length,offset in entries if kind == 15), None)
        if misc is None or misc[0] < 12:
            raise ValueError('Engine minidump omitted target identity')
        stream.seek(misc[1])
        _, present, actual_pid = struct.unpack('<III', stream.read(12))
        if not present & 1 or actual_pid != pid:
            raise ValueError('Engine minidump target PID differs from its owned process')
        threads = next(((length,offset) for kind,length,offset in entries if kind == 17), None)
        if threads is None or threads[0] < 12:
            raise ValueError('Engine minidump omitted thread CPU information')
        stream.seek(threads[1])
        header_size, entry_size, thread_count = struct.unpack('<III',stream.read(12))
        if (header_size < 12 or entry_size < 64 or not 1 <= thread_count <= 16384
                or header_size+entry_size*thread_count > threads[0]):
            raise ValueError('Invalid engine thread CPU information')
        stream.seek(0)
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path':str(path),'pid':pid,'size_bytes':size,'sha256':digest,
            'flags':flags,'timestamp':timestamp,'thread_info':True,'thread_count':thread_count}


class EngineSnapshots:
    def __init__(self, args, folder, executable, validate_ticket, identities, own_job):
        self.args, self.folder, self.executable = args, Path(folder), executable
        self.validate_ticket, self.identities, self.own_job = validate_ticket, identities, own_job
        self.first_frame = None
        self.children = []
        self.evidence = {'requested':True,'status':'REQUESTED','captures':[],
            'scope':'OWNED_ENGINE_SNAPSHOTS_NOT_PRODUCTION_TIMING','error':None,'cleanup_confirmed':False}

    def after_control(self, service):
        if service.presentation.data.get('status') != 'DRIVING':
            return
        frame = service.observation.frame_id
        if self.first_frame is None:
            self.first_frame = frame
        ordinal = len(self.children)
        if ordinal >= 2 or frame-self.first_frame < (80,380)[ordinal]:
            return
        self.validate_ticket(self.args)
        engines = [row for row in self.identities()
                   if row.get('ExecutablePath','').lower().endswith('carlaue4-win64-shipping.exe')]
        if len(engines) != 1:
            raise RuntimeError('Engine profiling requires exactly one verified owned shipping process')
        identity = engines[0]
        pid = int(identity['ProcessId'])
        if self.evidence['captures'] and pid != self.evidence['captures'][0]['identity']['ProcessId']:
            raise RuntimeError('Owned engine identity changed during profiling')
        target = self.folder / ('engine-snapshot-' + str(ordinal+1) + '.dmp')
        if target.exists():
            raise FileExistsError('Refuse to overwrite an engine snapshot')
        log = (self.folder / ('engine-snapshot-' + str(ordinal+1) + '.log')).open('xb')
        command = [self.executable,'-accepteula','-mc','0','-n','1',str(pid),str(target)]
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        try:
            close_job = self.own_job(child)
        except BaseException:
            child.kill();child.wait(timeout=3);log.close()
            raise
        row = {'identity':identity,'frame_id':frame,'timestamp_s':service.observation.timestamp_s,
               'started_monotonic_s':time.monotonic(),'argv':command,'capture_pid':child.pid,
               'path':str(target),'log_path':str(log.name)}
        self.children.append((child,log,close_job,row))
        self.evidence['captures'].append(row)
        self.evidence['status'] = 'RUNNING'
        self.save()

    def save(self):
        from backend.learning.egypt_budget import save_json
        save_json(self.folder/'engine-profile-status.json',self.evidence)

    def finish(self, deadline):
        errors = []
        for child,log,close_job,row in self.children:
            try:
                try:
                    child.wait(timeout=max(0.,min(10.,deadline-time.monotonic()-3.)))
                except subprocess.TimeoutExpired:
                    child.kill();child.wait(timeout=2)
                    raise TimeoutError('Owned engine snapshot exceeded its finalization bound')
                row['returncode'] = child.returncode
                log.close()
                row['dump'] = inspect_snapshot(row['path'], int(row['identity']['ProcessId']))
                if child.returncode not in (0,1):
                    raise RuntimeError('Owned engine snapshot tool failed: '+str(child.returncode))
                raw_log = Path(row['log_path']).read_bytes()
                text = raw_log.replace(b'\x00',b'').decode('utf8',errors='replace')
                row['log_sha256'] = hashlib.sha256(raw_log).hexdigest()
                row['dump_completion_observed'] = 'Dump 1 complete' in text
                if not row['dump_completion_observed']:
                    raise RuntimeError('Owned engine snapshot omitted its completed-dump diagnostic')
            except (OSError,ValueError,RuntimeError,subprocess.TimeoutExpired) as error:
                row['error'] = str(error);errors.append(str(error))
            finally:
                if not log.closed:log.close()
                if close_job is not None:close_job()
                row['ended_monotonic_s'] = time.monotonic()
        if len(self.children) != 2:
            errors.append('Both declared driving engine snapshots were not captured')
        self.evidence.update(status='ERROR' if errors else 'CAPTURED',
            error='; '.join(errors) if errors else None,
            cleanup_confirmed=all(child.poll() is not None for child,_,_,_ in self.children))
        self.save()
        return self.evidence


def captured(evidence):
    return (evidence.get('requested') is True and evidence.get('status') == 'CAPTURED'
            and evidence.get('cleanup_confirmed') is True and not evidence.get('error')
            and len(evidence.get('captures',[])) == 2
            and all(row.get('dump',{}).get('thread_info') is True and not row.get('error')
                    for row in evidence['captures']))
