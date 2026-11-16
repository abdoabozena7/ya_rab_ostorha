"""Download selected Microsoft Rocketbox models/animations at a pinned revision.

Only data assets are downloaded. Every file is checked against its Git blob SHA.
"""
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parents[1]
REVISION='0943055db6ec570bcef9f2c8b41c9e5467c808f9'
CHARACTERS=['Male_Adult_01','Male_Adult_05','Female_Adult_01','Female_Adult_04']
DEST=ROOT/'assets'/'source'/'rocketbox'

def main():
    request=Request(f'https://api.github.com/repos/microsoft/Microsoft-Rocketbox/git/trees/{REVISION}?recursive=1',headers={'User-Agent':'Ostorha-asset-setup'})
    with urlopen(request,timeout=30) as response: tree=json.load(response)['tree']
    selected=[]
    for item in tree:
        path=item['path']
        if item['type']!='blob':continue
        keep=path=='LICENSE.md'
        for name in CHARACTERS:
            prefix=f'Assets/Avatars/Adults/{name}/'
            keep |= path==prefix+f'Export/{name}.fbx'
            keep |= path.startswith(prefix+'Textures/') and path.endswith(('_color.tga','_normal.tga'))
        for gender in ['m','f']:
            keep |= path==f'Assets/Animations/all_animations_max_motextr_xy/{gender}_walk_neutral.max.fbx'
            keep |= path==f'Assets/Animations/all_animations_max_motextr_xy/{gender}_run_neutral.max.fbx'
            keep |= path==f'Assets/Animations/all_animations_max_motextr_static/{gender}_idle_neutral_01.max.fbx'
        if keep:selected.append(item)
    def fetch(item):
        path=DEST/item['path'];path.parent.mkdir(parents=True,exist_ok=True)
        def valid(data):return hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()==item['sha']
        if path.exists() and valid(path.read_bytes()):return
        url=f'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/{REVISION}/'+quote(item['path'])
        with urlopen(url,timeout=90) as response:data=response.read()
        if not valid(data):raise ValueError('Asset checksum mismatch: '+item['path'])
        path.write_bytes(data)
        print(item['path'],flush=True)
    with ThreadPoolExecutor(max_workers=3) as executor:list(executor.map(fetch,selected))
    (DEST/'manifest.json').write_text(json.dumps({'revision':REVISION,'files':selected},indent=2))
    print(f'Verified {len(selected)} source files',flush=True)

if __name__=='__main__':main()
