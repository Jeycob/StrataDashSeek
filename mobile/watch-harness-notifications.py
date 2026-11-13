"""Read committed Harness events locally. Never transmit message bodies or code."""
try:
    import compression.zstd as zstd
except ImportError:
    import zstandard as zstd
import json
import pathlib
import sys
import time
import urllib.request
import argparse

ROOT=pathlib.Path(__file__).resolve().parents[2]
options=argparse.ArgumentParser()
options.add_argument('--session-root',type=pathlib.Path,default=pathlib.Path.home()/'.dsh/sessions')
options.add_argument('--key-file',type=pathlib.Path,default=ROOT/'work/.secrets/webpush-internal.key')
options.add_argument('--port',type=int,default=3091)
args=options.parse_args()
SESSION_ROOT=args.session_root
KEY_FILE=args.key_file

def read_rows(file):
    try:
        with zstd.open(file,'rt',encoding='utf-8') as stream:
            for line in stream:
                try: yield json.loads(line)
                except json.JSONDecodeError: return
    except (OSError,EOFError,zstd.ZstdError): return

def post(route,data):
    key=KEY_FILE.read_text(encoding='utf-8').strip()
    req=urllib.request.Request('http://127.0.0.1:'+str(args.port)+'/internal/'+route,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','X-Harness-Notify-Key':key},method='POST')
    with urllib.request.urlopen(req,timeout=5) as response:
        return json.loads(response.read())

def event_intent(event):
    """Only terminal outcomes and unresolved attention; no generated content."""
    data=event.get('data',{})
    kind=event.get('type')
    if kind=='turn/end':
        reason=data.get('reason',{})
        reason=reason.get('kind') if isinstance(reason,dict) else reason
        if reason=='completed': return ('outcome','done',str(data.get('turn','')))
        if reason in ('max-tokens','failed','error','blocked'): return ('outcome','error',str(data.get('turn','')))
    if kind=='approval/asked': return ('pending','attention',str(data.get('id','')))
    if kind=='approval/decided': return ('resolve','attention',str(data.get('id','')))
    if kind=='tool/call':
        call=data.get('call',data)
        name=call.get('name') or data.get('toolName') or data.get('tool')
        call_id=call.get('id') or data.get('callId') or data.get('id')
        if name=='ask_user_question' and call_id:return ('pending','attention',str(call_id))
    if kind=='tool/result':
        result=data.get('message',data.get('result',data))
        call_id=data.get('callId') or result.get('callId') or result.get('toolCallId') or data.get('id')
        if call_id:return ('resolve','attention',str(call_id))
    return None

def main():
    started=int(time.time()*1000)
    cursors={};fingerprints={};pending={};last_heartbeat=0
    # Baseline all existing history, without replaying previous completions.
    for file in SESSION_ROOT.glob('*/*/session.v4.jsonl.zstd'):
        key=str(file);cursors[key]=max((r.get('seq',0) for r in read_rows(file)),default=0)
    while True:
        now=time.time()
        if now-last_heartbeat>10:
            try:post('heartbeat',{});last_heartbeat=now
            except Exception:pass
        for file in SESSION_ROOT.glob('*/*/session.v4.jsonl.zstd'):
            key=str(file)
            try:stat=file.stat();stamp=(stat.st_mtime_ns,stat.st_size)
            except OSError:continue
            if fingerprints.get(key)==stamp:continue
            fingerprints[key]=stamp
            sid=file.parent.name;last=cursors.get(key,0);highest=last;delegation=0
            for event in read_rows(file):
                if event.get('type')=='session':delegation=event.get('delegationDepth',0);continue
                seq=event.get('seq',0);highest=max(highest,seq)
                if seq<=last or event.get('time',0)<started or delegation>0:continue
                intent=event_intent(event)
                if not intent:continue
                action,category,item=intent
                pkey=(sid,item)
                if action=='pending':pending[pkey]=(now+3,category,sid+':'+str(seq))
                elif action=='resolve':pending.pop(pkey,None)
                elif action=='outcome':
                    for old in [p for p in pending if p[0]==sid]:pending.pop(old,None)
                    try:post('event',{'id':sid+':'+str(seq),'category':category})
                    except Exception:pending[(sid,'retry:'+str(seq))]=(now+5,category,sid+':'+str(seq))
            cursors[key]=highest
        for item,(due,category,event_id) in list(pending.items()):
            if due>now:continue
            try:post('event',{'id':event_id,'category':category});pending.pop(item,None)
            except Exception:pending[item]=(now+10,category,event_id)
        time.sleep(2)

if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:sys.exit(0)
