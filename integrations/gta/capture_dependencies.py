"""Inspect bounded primary-source capture candidates, never execute an installer."""
import argparse
import hashlib
import io
import json
from pathlib import Path,PurePosixPath
import re
import subprocess
import urllib.error
import urllib.request
import uuid
import zipfile
import preflight

HERE=Path(__file__).resolve().parent
CACHE=HERE/'downloads/render'
SPECS={
 'ReShade_Setup_6.8.0_Addon.exe':('https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe',16_000_000),
 'natives.json':('https://raw.githubusercontent.com/alloc8or/gta5-nativedb-data/master/natives.json',5_000_000),
 'reshade-LICENSE.md':('https://raw.githubusercontent.com/crosire/reshade/v6.8.0/LICENSE.md',64_000),
}
SDK_PREFIX='https://raw.githubusercontent.com/crosire/reshade/v6.8.0/include/'
HEADER=r'reshade(?:_[a-z0-9]+)*\.hpp'


def validate_url(url):
    if url not in {s[0] for s in SPECS.values()} and not re.fullmatch(re.escape(SDK_PREFIX)+HEADER,url):
        raise ValueError('Unapproved primary source URL')
    return url


class FixedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        validate_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def safe_members(archive):
    for info in archive.infolist():
        name=info.orig_filename;path=PurePosixPath(name)
        if ('\\' in name or ':' in name or path.is_absolute() or '..' in path.parts
                or ((info.external_attr>>16)&0o170000)==0o120000):
            raise ValueError('Unsafe candidate archive path')
    return archive.infolist()


def fetch(name,ledger):
    if re.fullmatch(HEADER,name):url,maximum=SDK_PREFIX+name,1_000_000
    else:url,maximum=SPECS[name]
    validate_url(url)
    record=CACHE/(name+'.metadata.json');target=CACHE/name
    if target.exists():
        metadata=json.loads(record.read_text())
        if (metadata['source_url']!=url or target.stat().st_size!=metadata['bytes']
                or hashlib.sha256(target.read_bytes()).hexdigest()!=metadata['sha256']):
            raise ValueError('Cached candidate provenance/hash mismatch')
        return metadata
    reservation=ledger.reserve(maximum,url);actual=0
    partial=CACHE/(name+'.partial-'+uuid.uuid4().hex)
    try:
        request=urllib.request.Request(url,headers={'User-Agent':'Ostorha-GTA-compatibility/1.0'})
        opener=urllib.request.build_opener(FixedRedirect())
        with opener.open(request,timeout=45) as response,partial.open('xb') as output:
            validate_url(response.url)
            length=response.headers.get('Content-Length')
            if length and int(length)>maximum:raise ValueError('Candidate exceeds reserved payload ceiling')
            while actual<maximum:
                body=response.read1(min(65536,maximum-actual))
                if not body:break
                output.write(body);actual+=len(body)
            if actual==maximum:raise ValueError('Candidate reached payload ceiling; no overshoot allowed')
            if length and actual!=int(length):raise ValueError('Incomplete candidate payload')
        partial.rename(target)
        metadata={'source_url':url,'bytes':actual,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
        preflight.write_json(record,metadata);return metadata
    finally:
        ledger.finish(reservation,actual)


def inspect_candidates():
    runtime=CACHE/'ReShade64.dll'
    with zipfile.ZipFile(CACHE/'ReShade_Setup_6.8.0_Addon.exe') as archive:
        safe_members(archive)
        info=archive.getinfo('ReShade64.dll')
        if info.file_size>32_000_000:raise ValueError('Expanded runtime exceeds bounded cache size')
        body=archive.read(info)
        if not body.startswith(b'MZ'):raise ValueError('Runtime is not a PE candidate')
        runtime.write_bytes(body)
    sdk=CACHE/'sdk';(sdk/'include').mkdir(parents=True,exist_ok=True)
    headers=list(CACHE.glob('reshade*.hpp'))
    if '#define RESHADE_API_VERSION 20' not in (CACHE/'reshade.hpp').read_text():
        raise ValueError('Unexpected versioned ReShade API header')
    for header in headers:(sdk/'include'/header.name).write_bytes(header.read_bytes())
    (sdk/'LICENSE.md').write_bytes((CACHE/'reshade-LICENSE.md').read_bytes())
    natives=json.loads((CACHE/'natives.json').read_text(encoding='utf-8-sig'))
    if not any(v.get('name')=='GET_GAME_TIMER' for group in natives.values() for v in group.values()):
        raise ValueError('Invalid native API metadata')
    script=("$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'); "
            "$a=Get-AuthenticodeSignature -LiteralPath '"+str(CACHE/'ReShade_Setup_6.8.0_Addon.exe').replace("'","''")+
            "'; [pscustomobject]@{Status=[string]$a.Status;Thumbprint=$a.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress")
    query=subprocess.run(['powershell.exe','-NoProfile','-Command',script],capture_output=True,text=True,timeout=30,check=True)
    signature=json.loads(query.stdout)
    if not signature.get('Status'):raise ValueError('Signature query produced no actual status')
    version=preflight.file_version(runtime)
    if not version.startswith('6.8.0.'):raise ValueError('Unexpected extracted runtime version')
    # The full-addon runtime is unsigned by design; its exact official package
    # provenance is recorded. An absent signature is not called a valid signature.
    return {'runtime_sha256':hashlib.sha256(body).hexdigest(),'runtime_bytes':len(body),'runtime_file_version':version,
            'sdk_header_count':len(list((sdk/'include').glob('*.hpp'))),'setup_signature':signature,
            'sdk_version':'v6.8.0','native_metadata_namespaces':len(natives),
            'installer_executed':False,'native_capture_accepted':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    CACHE.mkdir(parents=True,exist_ok=True)
    result={'dependencies_available':False,'native_capture_accepted':False,'installer_executed':False,'payloads':{}}
    lock=CACHE/'fetch.lock'
    with lock.open('x') as stream:stream.write(str(__import__('os').getpid()))
    ledger=preflight.DownloadLedger(HERE/'downloads/payload-ledger.json')
    try:
        for name in ('ReShade_Setup_6.8.0_Addon.exe',):
            result['payloads'][name]=fetch(name,ledger)
            preflight.write_json(output/'dependencies.json',result)
        pending=['reshade.hpp'];seen=set()
        while pending:
            name=pending.pop(0)
            if name in seen:continue
            if len(seen)>=32:raise ValueError('SDK dependency count exceeds bounded scope')
            seen.add(name);result['payloads'][name]=fetch(name,ledger)
            text=(CACHE/name).read_text(encoding='utf-8-sig')
            pending.extend(re.findall(r'#include\s+"('+HEADER+r')"',text))
            preflight.write_json(output/'dependencies.json',result)
        for name in ('reshade-LICENSE.md','natives.json'):
            result['payloads'][name]=fetch(name,ledger)
            preflight.write_json(output/'dependencies.json',result)
        result.update(inspect_candidates(),dependencies_available=True)
    except Exception as error:result['error']=str(error)
    finally:
        result['payload_ledger']=ledger.state
        preflight.write_json(output/'dependencies.json',result);lock.unlink()
    print(json.dumps(result,indent=2));return int(not result['dependencies_available'])


if __name__=='__main__':raise SystemExit(main())
