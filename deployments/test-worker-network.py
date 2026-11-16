"""Real firewall test. MUST run in a new network namespace; never touches host rules.

unshare -n -- python3 test-worker-network.py GENERATED_FIREWALL_SH IPTABLES_BIN_DIR
"""
import json, os, pathlib, signal, subprocess, sys, time

def main():
    if os.geteuid() != 0 or os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
        raise RuntimeError('Refusing to touch the host network: use a new root network namespace')
    firewall = str(pathlib.Path(sys.argv[1]).resolve())
    env = dict(os.environ, PATH=sys.argv[2]+':/usr/sbin:/usr/bin:/sbin:/bin')
    children, child_names = [], {}
    def command(args, namespace=None, timeout=5, **options):
        prefix = ['nsenter', '-t', str(namespace), '-n', '--'] if namespace else []
        return subprocess.run(prefix+args, env=env, check=True, capture_output=True,
                              text=True, timeout=timeout, **options).stdout.strip()
    def spawn(args, namespace=None, name=None):
        prefix = ['nsenter', '-t', str(namespace), '-n', '--'] if namespace else []
        child = subprocess.Popen(prefix+args, env=env, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.PIPE)
        children.append(child)
        child_names[child.pid] = name or 'unnamed-fixture'
        return child
    def network(name):
        child = spawn(['unshare', '-n', '--', 'sleep', '60'], name=name)
        for _ in range(50):
            if child.poll() is not None:
                raise RuntimeError('Cannot create a temporary child network namespace')
            if os.readlink(f'/proc/{child.pid}/ns/net') != os.readlink('/proc/self/ns/net'):
                command(['ip', 'link', 'set', 'lo', 'up'], child.pid)
                return child.pid
            time.sleep(.02)
        raise RuntimeError('Child namespace did not start')
    http_server = '''from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import sys
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(sys.argv[2].encode())
 def log_message(self,*args): pass
ThreadingHTTPServer(('0.0.0.0',int(sys.argv[1])),Handler).serve_forever()
'''
    http_query = '''import urllib.request,sys
try:
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(sys.argv[1],timeout=float(sys.argv[2]) if len(sys.argv)>2 else 1) as r: print(r.read().decode())
except Exception: print('DENIED')
'''
    udp_server = '''import socket,sys
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('0.0.0.0',int(sys.argv[1])))
while True:
 data,address=s.recvfrom(1024);s.sendto(b'UDP_OK',address)
'''
    udp_query = '''import socket,sys
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(float(sys.argv[3]) if len(sys.argv)>3 else 1);s.sendto(b'check',(sys.argv[1],int(sys.argv[2])));print(s.recv(1024).decode())
'''
    def http(namespace, url): return command([sys.executable,'-c',http_query,url],namespace)
    def wait_fixtures(host, app):
        # One deadline for every positive route, before a persistent connection
        # or isolation rules exist. Never retry a denial check after firewall.
        endpoints = [
            ('host-to-control', host, [http_query,'http://10.0.2.15:2375/'], 'CONTROL_OK'),
            ('app-to-bridge-control', app, [http_query,'http://172.18.0.1:2375/'], 'CONTROL_OK'),
            ('app-to-worker-control', app, [http_query,'http://10.0.2.15:2375/'], 'CONTROL_OK'),
            ('app-to-host-loopback', app, [http_query,'http://10.0.2.2:19075/'], 'HOST_LOOPBACK_OK'),
            ('worker-to-host-loopback', None, [http_query,'http://10.0.2.2:19075/'], 'HOST_LOOPBACK_OK'),
            ('host-to-published-preview', host, [http_query,'http://10.0.2.15:18080/'], 'APPLICATION_OK'),
            ('app-to-dns', app, [udp_query,'10.0.2.3','53'], 'UDP_OK'),
            ('worker-to-dhcp', None, [udp_query,'10.0.2.2','67'], 'UDP_OK'),
        ]
        started = time.monotonic()
        deadline = started + 10
        outcomes = {name: 'NOT_CHECKED' for name, _, _, _ in endpoints}
        pending = set(outcomes)
        def failed(reason):
            return RuntimeError('FIXTURE_READINESS_FAILED '+json.dumps(dict(
                reason=reason, deadlineMs=10000,
                elapsedMs=round((time.monotonic()-started)*1000),
                lastEndpointOutcomes=outcomes,
                childExitCodes={child_names[c.pid]: c.poll() for c in children}), sort_keys=True))
        while pending:
            if any(c.poll() is not None for c in children):
                raise failed('CHILD_EXIT')
            for name, namespace, query, expected in endpoints:
                if name not in pending:
                    continue
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    raise failed('DEADLINE')
                probe_timeout = min(.5, remaining/2)
                try:
                    outcome = command([sys.executable,'-c',*query,str(probe_timeout)],
                                      namespace, timeout=min(remaining, probe_timeout+.5))
                    outcomes[name] = outcome if outcome in ['CONTROL_OK','HOST_LOOPBACK_OK','APPLICATION_OK','UDP_OK','DENIED'] else 'UNEXPECTED_RESPONSE'
                    if outcome == expected:
                        pending.remove(name)
                except subprocess.TimeoutExpired:
                    outcomes[name] = 'PROBE_TIMEOUT'
                except subprocess.CalledProcessError as error:
                    outcomes[name] = 'PROBE_EXIT_'+str(error.returncode)
                except OSError:
                    outcomes[name] = 'PROBE_EXEC_ERROR'
            if pending:
                time.sleep(max(0, min(.02, deadline-time.monotonic())))
        if any(c.poll() is not None for c in children):
            raise failed('CHILD_EXIT')
        if time.monotonic() > deadline:
            raise failed('DEADLINE')
        return dict(ready=True, positiveEndpoints=len(endpoints), deadlineMs=10000,
                    elapsedMs=round((time.monotonic()-started)*1000))
    try:
        command(['ip','link','set','lo','up'])
        host, app = network('host-namespace'), network('app-namespace')
        command(['ip','link','add','eth0','type','veth','peer','name','hostpeer'])
        command(['ip','link','set','hostpeer','netns',str(host)])
        command(['ip','addr','add','10.0.2.15/24','dev','eth0'])
        command(['ip','link','set','eth0','up'])
        for address in ['10.0.2.2/24','10.0.2.3/24']:
            command(['ip','addr','add',address,'dev','hostpeer'],host)
        command(['ip','link','set','hostpeer','up'],host)
        command(['ip','link','add','docker0','type','veth','peer','name','apppeer'])
        command(['ip','link','set','apppeer','netns',str(app)])
        command(['ip','addr','add','172.18.0.1/24','dev','docker0'])
        command(['ip','link','set','docker0','up'])
        command(['ip','addr','add','172.18.0.2/24','dev','apppeer'],app)
        command(['ip','link','set','apppeer','up'],app)
        command(['ip','route','add','10.0.2.0/24','via','172.18.0.1'],app)
        command(['ip','route','add','172.18.0.0/24','via','10.0.2.15'],host)
        pathlib.Path('/proc/sys/net/ipv4/ip_forward').write_text('1')
        command(['iptables','-N','DOCKER-USER'])
        command(['iptables','-A','FORWARD','-j','DOCKER-USER'])
        command(['iptables','-A','FORWARD','-j','ACCEPT'])
        command(['iptables','-t','nat','-A','PREROUTING','-i','eth0','-p','tcp','--dport','18080','-j','DNAT','--to-destination','172.18.0.2:8080'])
        spawn([sys.executable,'-c',http_server,'2375','CONTROL_OK'],name='control-http')
        spawn([sys.executable,'-c',http_server,'19075','HOST_LOOPBACK_OK'],host,name='host-loopback-http')
        spawn([sys.executable,'-c',http_server,'8080','APPLICATION_OK'],app,name='application-http')
        spawn([sys.executable,'-c',udp_server,'53'],host,name='dns-udp')
        spawn([sys.executable,'-c',udp_server,'67'],host,name='dhcp-udp')
        fixture_readiness = wait_fixtures(host, app)
        assert http(app,'http://172.18.0.1:2375/') == 'CONTROL_OK'
        assert http(app,'http://10.0.2.2:19075/') == 'HOST_LOOPBACK_OK'
        persistent_code = '''import socket,sys
s=socket.create_connection(('10.0.2.2',19075));s.settimeout(1);print('CONNECTED',flush=True);input()
try:
 s.sendall(b'GET / HTTP/1.0\\r\\nHost: test\\r\\n\\r\\n');print('ALLOWED' if s.recv(1024) else 'DENIED',flush=True)
except Exception: print('DENIED',flush=True)
'''
        persistent = subprocess.Popen(['nsenter','-t',str(app),'-n','--',sys.executable,'-c',persistent_code],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        children.append(persistent)
        assert persistent.stdout.readline().strip() == 'CONNECTED'
        command(['sh',firewall])
        persistent.stdin.write('check\n');persistent.stdin.flush()
        assert persistent.stdout.readline().strip() == 'DENIED', 'Old application connections must not bypass isolation'
        rules = command(['iptables','-S'])
        command(['sh',firewall])
        assert command(['iptables','-S']) == rules, 'Rules must be idempotent'
        assert http(host,'http://10.0.2.15:2375/') == 'CONTROL_OK'
        assert http(app,'http://172.18.0.1:2375/') == 'DENIED'
        assert http(app,'http://10.0.2.15:2375/') == 'DENIED'
        assert http(app,'http://10.0.2.2:19075/') == 'DENIED'
        assert http(None,'http://10.0.2.2:19075/') == 'DENIED'
        assert http(host,'http://10.0.2.15:18080/') == 'APPLICATION_OK'
        assert command([sys.executable,'-c',udp_query,'10.0.2.3','53'],app) == 'UDP_OK'
        assert command([sys.executable,'-c',udp_query,'10.0.2.2','67']) == 'UDP_OK'
        command(['ip','link','set','docker0','name','br-compose'])
        assert http(app,'http://172.18.0.1:2375/') == 'DENIED'
        assert http(host,'http://10.0.2.15:18080/') == 'APPLICATION_OK'
        assert pathlib.Path('/proc/sys/net/ipv6/conf/all/disable_ipv6').read_text().strip() == '1'
        print(json.dumps(dict(realLinuxFirewall=True,dockerRuntime=False,
            hostControlAllowed=True,containerControlDenied=True,
            composeControlDenied=True,hostLoopbackDenied=True,
            workerProcessLoopbackDenied=True,preexistingAppConnectionDenied=True,previewPreserved=True,
            dnsAndDhcpPreserved=True,idempotent=True,ipv6Disabled=True,
            fixtureReadiness=fixture_readiness)))
    finally:
        for child in reversed(children):
            child.terminate()
        for child in reversed(children):
            try: child.wait(timeout=2)
            except subprocess.TimeoutExpired: child.kill(); child.wait()

if __name__ == '__main__':
    # A bounded fixture timeout must still terminate its own namespace children.
    def terminate(_signal, _frame):
        raise SystemExit(143)
    signal.signal(signal.SIGTERM, terminate)
    main()
