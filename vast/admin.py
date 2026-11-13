"""Local-only server administration. Pairing codes are private, short lived and single use."""
import urllib.request,json,pathlib,sys
root=pathlib.Path('/data/harness');action=sys.argv[1] if len(sys.argv)>1 else 'state'
if action not in ('state','paircode'):raise SystemExit('Usage: admin.py state|paircode')
key=(root/'secrets/webpush-internal.key').read_text().strip()
req=urllib.request.Request('http://127.0.0.1:3091/internal/'+action,data=b'{}',headers={'X-Harness-Notify-Key':key,'Content-Type':'application/json'},method='POST')
with urllib.request.urlopen(req,timeout=5) as response:print(json.dumps(json.load(response)))
