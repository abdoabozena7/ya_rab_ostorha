"""Read-only Windows process/system counters; CPU deltas use wall seconds."""
import ctypes
from ctypes import wintypes
import os
import json
import re
import subprocess


class ProcessMemory(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in ('PeakWorkingSetSize', 'WorkingSetSize',
        'QuotaPeakPagedPoolUsage', 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage',
        'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage', 'PrivateUsage')]


def process_resources(pid):
    if os.name != 'nt':
        raise OSError('Windows process counters unavailable on this host')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x410, False, int(pid))
    if not handle:
        raise OSError('Cannot read process memory: '+str(pid))
    try:
        counter = ProcessMemory()
        counter.cb = ctypes.sizeof(counter)
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD]
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counter), counter.cb):
            raise OSError('GetProcessMemoryInfo failed')
        times = [wintypes.FILETIME() for _ in range(4)]
        kernel.GetProcessTimes.argtypes = [ctypes.c_void_p]+[ctypes.POINTER(wintypes.FILETIME)]*4
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            raise OSError('GetProcessTimes failed')
        cpu = sum((t.dwHighDateTime << 32)+t.dwLowDateTime for t in times[2:])/10_000_000
        return {'pid':int(pid), 'working_set_mib':counter.WorkingSetSize/1048576,
                'private_mib':counter.PrivateUsage/1048576, 'cpu_seconds':cpu,
                'page_fault_count':counter.PageFaultCount, 'page_fault_scope':'SOFT_AND_HARD_CUMULATIVE'}
    finally:
        kernel.CloseHandle(handle)


class SystemMemory(ctypes.Structure):
    _fields_ = [('dwLength', wintypes.DWORD), ('dwMemoryLoad', wintypes.DWORD)] + [
        (name, ctypes.c_ulonglong) for name in ('ullTotalPhys', 'ullAvailPhys',
        'ullTotalPageFile', 'ullAvailPageFile', 'ullTotalVirtual', 'ullAvailVirtual', 'ullAvailExtendedVirtual')]


def system_memory_status():
    if os.name != 'nt':
        raise OSError('Windows system memory counters unavailable on this host')
    counter = SystemMemory()
    counter.dwLength = ctypes.sizeof(counter)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(SystemMemory)]
    if not kernel.GlobalMemoryStatusEx(ctypes.byref(counter)):
        raise OSError('GlobalMemoryStatusEx failed')
    return {'source':'WINDOWS_GLOBAL_MEMORY_STATUS_EX', 'physical_load_percent':counter.dwMemoryLoad,
            'physical_total_bytes':counter.ullTotalPhys, 'physical_available_bytes':counter.ullAvailPhys,
            'commit_limit_bytes':counter.ullTotalPageFile, 'commit_available_bytes':counter.ullAvailPageFile}


def system_cpu_times():
    if os.name != 'nt':
        raise OSError('Windows system CPU counters unavailable on this host')
    times = [wintypes.FILETIME() for _ in range(3)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetSystemTimes.argtypes = [ctypes.POINTER(wintypes.FILETIME)]*3
    if not kernel.GetSystemTimes(*(ctypes.byref(t) for t in times)):
        raise OSError('GetSystemTimes failed')
    idle, kernel_time, user = ((t.dwHighDateTime << 32)+t.dwLowDateTime for t in times)
    return idle/10_000_000, (kernel_time+user)/10_000_000


def wddm_process_memory(pids):
    if os.name != 'nt':
        raise OSError('WDDM counters unavailable on this host')
    selected = sorted(set(int(pid) for pid in pids))
    if not selected or any(pid <= 0 for pid in selected):
        raise ValueError('WDDM counters require owned positive process IDs')
    filters = ' OR '.join(f"Name LIKE 'pid_{pid}_%'" for pid in selected)
    command = ('Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory '
        f'-Filter "{filters}" -ErrorAction Stop | Select-Object Name,DedicatedUsage,SharedUsage | ConvertTo-Json -Compress')
    result = subprocess.run(['powershell','-NoProfile','-Command',command],
        capture_output=True,text=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise OSError('WDDM process query failed: '+result.stderr.strip()[:300])
    entries = json.loads(result.stdout) if result.stdout.strip() else []
    entries = [entries] if isinstance(entries,dict) else entries
    grouped = {}
    for entry in entries:
        match = re.match(r'^pid_(\d+)_',entry.get('Name',''))
        if match is None or int(match[1]) not in selected:
            raise ValueError('Unexpected WDDM process counter identity')
        pid = int(match[1])
        dedicated,shared = entry['DedicatedUsage'],entry['SharedUsage']
        if any(type(v) is not int or v < 0 for v in (dedicated,shared)):
            raise ValueError('Invalid WDDM memory counter')
        row = grouped.setdefault(pid,{'pid':pid,'usedMiB':0.,'sharedMiB':0.,'adapters':[]})
        row['usedMiB'] += dedicated/1048576
        row['sharedMiB'] += shared/1048576
        row['adapters'].append({'instance':entry['Name'],'dedicatedMiB':dedicated/1048576,
            'sharedMiB':shared/1048576})
    return {'status':'MEASURED' if grouped else 'UNAVAILABLE','source':'WINDOWS_WDDM_CIM_PROCESS_COUNTERS',
        'scope':'ALL_ADAPTERS_ALLOCATIONS_NOT_DEVICE_RESIDENCY',
        'processes':list(grouped.values()), 'missingPids':sorted(set(selected)-set(grouped))}


def wddm_process_engines(pids):
    if os.name != 'nt':
        raise OSError('WDDM counters unavailable on this host')
    selected = sorted(set(pids))
    if not selected or any(type(pid) is not int or pid <= 0 for pid in selected):
        raise ValueError('WDDM engine counters require owned positive integer process IDs')
    filters = ' OR '.join(f"Name LIKE 'pid_{pid}_%'" for pid in selected)
    command = ('Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine '
        f'-Filter "{filters}" -ErrorAction Stop | Select-Object Name,UtilizationPercentage | ConvertTo-Json -Compress')
    result = subprocess.run(['powershell','-NoProfile','-Command',command],
        capture_output=True,text=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise OSError('WDDM engine query failed: '+result.stderr.strip()[:300])
    entries = json.loads(result.stdout) if result.stdout.strip() else []
    entries = [entries] if isinstance(entries,dict) else entries
    grouped = {}
    for entry in entries:
        match = re.fullmatch(r'pid_(\d+)_(luid_0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+_phys_\d+)_eng_(\d+)_engtype_(.+)',
                             entry.get('Name',''))
        if match is None or int(match[1]) not in selected:
            raise ValueError('Unexpected WDDM engine counter identity')
        utilization = entry['UtilizationPercentage']
        if type(utilization) not in (int,float) or not 0 <= utilization <= 100:
            raise ValueError('Invalid WDDM engine utilization counter')
        pid = int(match[1])
        row = grouped.setdefault(pid,{'pid':pid,'engines':[]})
        row['engines'].append({'instance':entry['Name'],'adapter':match[2],'engine':int(match[3]),
                              'engine_type':match[4],'utilization_percent':utilization})
    return {'status':'MEASURED' if grouped else 'UNAVAILABLE','source':'WINDOWS_WDDM_CIM_ENGINE_COUNTERS',
            'scope':'PER_PROCESS_PER_ADAPTER_PER_ENGINE_NOT_SUMMED_NOT_DEVICE_TOTAL',
            'processes':list(grouped.values()),'missingPids':sorted(set(selected)-set(grouped))}
