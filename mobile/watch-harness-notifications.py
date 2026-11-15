"""Read committed Harness events locally. Never transmit message bodies or code."""
import json
import hashlib
import pathlib
import sys
import time
import urllib.request
import argparse
from notification_watcher_state import WatcherStateStore

ROOT=pathlib.Path(__file__).resolve().parents[2]
def read_rows(file):
    try:
        import compression.zstd as zstd
    except ImportError:
        import zstandard as zstd
    try:
        with zstd.open(file,'rt',encoding='utf-8') as stream:
            for line in stream:
                try: yield json.loads(line)
                except json.JSONDecodeError: return
    except (OSError,EOFError,zstd.ZstdError): return

def post(route,data,*,key_file,port):
    key=key_file.read_text(encoding='utf-8').strip()
    req=urllib.request.Request('http://127.0.0.1:'+str(port)+'/internal/'+route,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','X-Harness-Notify-Key':key},method='POST')
    with urllib.request.urlopen(req,timeout=5) as response:
        raw=response.read(65537)
        if len(raw)>65536:raise ValueError('Internal receipt exceeds limit')
        return json.loads(raw)

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

class NotificationWatcher:
    def __init__(self, session_root, store, send, *, clock=time.time, reader=read_rows):
        self.root=pathlib.Path(session_root);self.store=store;self.send=send;self.clock=clock;self.reader=reader
        self.fingerprints={};self.last_heartbeat=0;self.state=store.load()
        if self.state is None:
            self.state={'version':1,'initializedAt':int(clock()*1000),'cursors':{},'pending':{}}
            # Ignore pre-installation history exactly once. Subsequent process
            # starts resume durable cursors rather than baselining away downtime.
            for file in self.files():
                self.state['cursors'][self.key(file)]=max((r.get('seq',0) for r in reader(file) if type(r.get('seq',0)) is int),default=0)
            self.store.save(self.state)

    def files(self):
        files=[]
        for file in self.root.glob('*/*/session.v4.jsonl.zstd'):
            files.append(file)
            if len(files)>10000:raise RuntimeError('Watcher session limit')
        return sorted(files)

    def key(self,file):return file.relative_to(self.root).as_posix()

    def tick(self):
        now=int(self.clock()*1000);dirty=False
        if now-self.last_heartbeat>10000:
            try:self.send('heartbeat',{});self.last_heartbeat=now
            except Exception:pass
        files=self.files();present={self.key(file) for file in files}
        for old in set(self.state['cursors'])-present:
            del self.state['cursors'][old];dirty=True
        for file in files:
            key=self.key(file)
            try:info=file.stat();stamp=(info.st_mtime_ns,info.st_size)
            except OSError:continue
            if self.fingerprints.get(key)==stamp:continue
            last=self.state['cursors'].get(key,0);highest=last;delegation=0;sid=file.parent.name
            for event in self.reader(file):
                if event.get('type')=='session':delegation=event.get('delegationDepth',0);continue
                sequence=event.get('seq',0)
                if type(sequence) is not int or sequence<0:continue
                highest=max(highest,sequence);occurred=event.get('time',0)
                if sequence<=last or type(occurred) is not int or occurred<self.state['initializedAt'] or delegation>0:continue
                intent=event_intent(event)
                if not intent:continue
                action,category,item=intent
                pending_key=hashlib.sha256((sid+'\0'+item).encode()).hexdigest()
                if action=='resolve':self.state['pending'].pop(pending_key,None)
                elif action in ('pending','outcome'):
                    if action=='outcome':
                        for old in [p for p,row in self.state['pending'].items() if row['sessionId']==sid]:self.state['pending'].pop(old,None)
                        pending_key='outcome:'+sid+':'+str(sequence)
                    self.state['pending'][pending_key]={'sessionId':sid,'eventId':sid+':'+str(sequence),'category':category,'dueAt':now+(3000 if action=='pending' else 0),'occurredAt':occurred,'expiresAt':occurred+300000}
            self.state['cursors'][key]=highest;self.fingerprints[key]=stamp;dirty=True
        # Cursor advancement and pending intent are one durable snapshot before
        # the first enqueue request. An uncertain receipt reuses the same ID.
        if dirty:self.store.save(self.state)
        for item,row in list(self.state['pending'].items()):
            if row['expiresAt']<=now:self.state['pending'].pop(item,None)
            elif row['dueAt']>now:continue
            else:
                try:
                    receipt=self.send('event',{'id':row['eventId'],'category':row['category'],'occurredAt':row['occurredAt']})
                    if receipt.get('persisted') is not True:raise RuntimeError('Durable receipt required')
                    self.state['pending'].pop(item,None)
                except Exception:row['dueAt']=now+10000
            self.store.save(self.state)


def main(argv=None):
    options=argparse.ArgumentParser()
    options.add_argument('--session-root',type=pathlib.Path,default=pathlib.Path.home()/'.dsh/sessions')
    options.add_argument('--key-file',type=pathlib.Path,default=ROOT/'work/.secrets/webpush-internal.key')
    options.add_argument('--port',type=int,default=3091)
    options.add_argument('--state-file',type=pathlib.Path)
    options.add_argument('--once',action='store_true')
    args=options.parse_args(argv)
    if not 1<=args.port<=65535:raise ValueError('Invalid internal port')
    with WatcherStateStore(args.state_file or args.key_file.parent/'notification-watcher-state.json') as store:
        watcher=NotificationWatcher(args.session_root,store,lambda route,data:post(route,data,key_file=args.key_file,port=args.port))
        while True:
            watcher.tick()
            if args.once:return
            time.sleep(2)

if __name__=='__main__':
    try:main()
    except KeyboardInterrupt:sys.exit(0)
    except Exception as error:
        print('Notification watcher failed: '+type(error).__name__,file=sys.stderr)
        sys.exit(1)
