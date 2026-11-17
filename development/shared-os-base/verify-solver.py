"""Reproduce the closure using only verified public metadata and empty status.

APT runs --simulate. This never updates, downloads or installs packages.
"""
import json, lzma, pathlib, re, runpy, shutil, subprocess, sys, tempfile

HERE = pathlib.Path(__file__).resolve().parent

def verify(metadata):
    runpy.run_path(str(HERE / 'verify-provenance.py'))['verify'](metadata)
    lock = json.loads((HERE / 'os-packages.lock.json').read_text())
    with tempfile.TemporaryDirectory(prefix='homeai-os-apt-simulation-') as tmp:
        root = pathlib.Path(tmp)
        lists = root / 'lists'; (lists / 'partial').mkdir(parents=True)
        sources = []
        for release in lock['provenance']['releases']:
            suite = release['suite']
            archive = 'debian-security' if suite.endswith('security') else 'debian'
            prefix = 'snapshot.debian.org_archive_' + archive + '_' + lock['snapshot'] + '_dists_' + suite
            (lists / (prefix + '_main_binary-amd64_Packages')).write_bytes(lzma.decompress((metadata / (suite + '-Packages.xz')).read_bytes()))
            shutil.copyfile(HERE / 'provenance' / (suite + '-InRelease'), lists / (prefix + '_InRelease'))
            sources.append('deb [arch=amd64] https://snapshot.debian.org/archive/' + archive + '/' + lock['snapshot'] + '/ ' + suite + ' main')
        (root / 'sources.list').write_text('\n'.join(sources) + '\n')
        (root / 'status').touch()
        options = {
            'Dir::Etc::main': '-', 'Dir::Etc::parts': '-',
            'Dir::Etc::sourcelist': str(root / 'sources.list'), 'Dir::Etc::sourceparts': '-',
            'Dir::State::lists': str(lists), 'Dir::State::status': str(root / 'status'),
            'Dir::Cache::pkgcache': str(root / 'pkgcache'), 'Dir::Cache::srcpkgcache': str(root / 'srcpkgcache'),
            'APT::Architecture': 'amd64', 'Debug::NoLocking': 'true'
        }
        command = ['/usr/bin/apt-get']
        for key, value in options.items(): command += ['-o', key + '=' + value]
        requested = sorted(set(sum(lock['selection']['requested'].values(), [])))
        # --no-download would also demand local .deb payloads even in simulate
        # mode on APT3.2.1. --simulate itself performs no acquire/install step.
        command += ['--simulate', '--no-install-recommends', 'install', *requested]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, env={'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LC_ALL': 'C'})
        if result.returncode: raise RuntimeError(result.stdout + result.stderr)
        selected = []
        for line in result.stdout.splitlines():
            if not line.startswith('Inst '): continue
            match = re.fullmatch(r'Inst ([^ :]+)(?::amd64)? \((\S+) .*\[(amd64|all)\]\)(?: \[\])?', line)
            assert match, line
            selected.append(match.groups())
        expected = [(p['name'], p['version'], p['architecture']) for p in lock['packages']]
        assert sorted(selected) == sorted(expected), 'resolved closure differs from lock'
        return len(selected)

if __name__ == '__main__':
    assert len(sys.argv) == 2, 'provide only the public metadata directory'
    print(json.dumps({'solverClosurePackages': verify(pathlib.Path(sys.argv[1])), 'simulationOnly': True, 'payloadDownloadOrInstall': False}))
