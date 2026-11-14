import pathlib, time, os, signal, json
def rx():
    return sum(int(line.split(':',1)[1].split()[0]) for line in pathlib.Path('/proc/net/dev').read_text().splitlines() if ':' in line and line.split(':')[0].strip()!='lo')
initial=rx()
while True:
    received=rx()-initial
    pathlib.Path('/data/lab/network.json').write_text(json.dumps({'at':time.time(),'receivedBytesSinceGuardStart':received,'limitBytes':140000000000}))
    if received>140000000000:
        pid=int(pathlib.Path('/data/lab/strata.pid').read_text())
        os.killpg(pid,signal.SIGTERM)
        pathlib.Path('/data/lab/network-limit-reached').touch()
        break
    time.sleep(2)
