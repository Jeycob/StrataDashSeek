"""Exercise real APT archive-path handling; never invoke dpkg install actions.

Run non-root. All APT state/configuration belongs to temporary empty fixtures.
Debug::pkgDPkgPM suppresses action execution; an additional dpkg guard rejects
all actions even if that debug behavior changes. Only dpkg metadata is allowed.
"""
import hashlib, json, os, pathlib, shlex, subprocess, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent

@unittest.skipIf(os.getuid() == 0, 'real APT no-op regression must run non-root')
class OfflineAptPaths(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='homeai-offline-apt-test-')
        self.root = r = pathlib.Path(self.tmp.name)
        for d in ['tree/DEBIAN', 'packages', 'etc/parts', 'etc/sources',
                  'state/lists/partial', 'cache/archives/partial', 'log', 'bin']:
            (r / d).mkdir(parents=True, exist_ok=True)
        self.packages = r / 'packages'
        self.debs = []
        rows = []
        for name, version in [('homeai-path-fixture', '1:1.0-1'),
                              ('homeai-path-fixture-extra', '2.0~rc1+bin.1-2')]:
            (r / 'tree/DEBIAN/control').write_text(
                f'Package: {name}\nVersion: {version}\nArchitecture: all\n'
                'Maintainer: Test <test@example.invalid>\nDescription: Empty path fixture\n')
            deb = self.packages / (name + '_all.deb')
            subprocess.run(['dpkg-deb', '--root-owner-group', '--build',
                            str(r / 'tree'), str(deb)], check=True, stdout=subprocess.DEVNULL)
            self.debs.append(deb)
            rows.append('\t'.join([name, version, 'all', hashlib.sha256(deb.read_bytes()).hexdigest(), str(deb.stat().st_size), deb.name]))
        self.lock = r / 'os-packages.lock.tsv'; self.lock.write_text('\n'.join(rows) + '\n')
        (r / 'state/status').touch()
        self.original = {d: d.read_bytes() for d in self.debs}
        self.guard = r / 'dpkg-guard'
        self.guard.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_DPKG_TRACE"
if [ "$1" = --admindir ]; then
    [ "$2" = "$FIXTURE_ADMIN/" ] || exit 98
    shift 2
fi
case "$1" in
    --print-architecture|--print-foreign-architectures|--assert-*) exec /usr/bin/dpkg --admindir "$FIXTURE_ADMIN" "$@";;
    --version) exec /usr/bin/dpkg --version;;
    *) echo forbidden-dpkg-action >&2; exit 97;;
esac
''')
        self.guard.chmod(0o700)
        opts = {'Dir::Etc::main': '/dev/null', 'Dir::Etc::parts': str(r / 'etc/parts'),
                'Dir::Etc::sourcelist': '/dev/null', 'Dir::Etc::sourceparts': str(r / 'etc/sources'),
                'Dir::State': str(r / 'state'), 'Dir::State::status': str(r / 'state/status'),
                'Dir::State::lists': str(r / 'state/lists'), 'Dir::Cache': str(r / 'cache'),
                'Dir::Cache::archives': str(r / 'cache/archives'), 'Dir::Log': str(r / 'log'),
                'Dir::Bin::dpkg': str(self.guard), 'APT::Architecture': 'amd64',
                'Debug::pkgDPkgPM': 'true', 'Debug::NoLocking': 'true', 'DPkg::Use-Pty': 'false'}
        config = r / 'apt.conf'
        config.write_text('\n'.join(k + ' ' + json.dumps(v) + ';' for k, v in opts.items()) + '\n')
        self.env = {'PATH': str(r / 'bin') + ':/usr/bin:/bin', 'HOME': str(r), 'LC_ALL': 'C',
                    'APT_CONFIG': str(config), 'FIXTURE_ADMIN': str(r / 'state'),
                    'FIXTURE_DPKG_TRACE': str(r / 'dpkg-trace'), 'FIXTURE_CACHE_PATH': str(r / 'cache-path')}
        self.functions = (HERE / 'install-offline.sh').read_text().split('# Package verification and install entry point.')[0]

    def tearDown(self):
        self.assertEqual((self.root / 'state/status').read_bytes(), b'')
        for deb, content in self.original.items():
            self.assertEqual(deb.read_bytes(), content)
            self.assertEqual(deb.stat().st_nlink, 1)
        trace = self.root / 'dpkg-trace'
        for line in trace.read_text().splitlines() if trace.exists() else []:
            args = shlex.split(line)
            if args[0] == '--admindir': args = args[2:]
            self.assertTrue(args[0].startswith(('--print-', '--assert-', '--version')), line)
        self.tmp.cleanup()

    def run_helpers(self):
        script = self.functions + '''
tab=$(printf '\\t')
trap 'status=$?; trap - EXIT; cleanup_apt_cache || status=1; exit "$status"' EXIT
prepare_apt_cache "$1" "$2"
printf '%s' "$apt_scratch" > "$FIXTURE_CACHE_PATH"
run_offline_apt "$1"
'''
        return subprocess.run(['/bin/sh', '-c', script, 'fixture', str(self.packages), str(self.lock)],
                              capture_output=True, text=True, timeout=20, env=self.env)

    def test_uncached_absolute_input_reproduces_internal_relative_path(self):
        result = subprocess.run(['/usr/bin/apt-get', '--yes', '--no-download', '--no-remove',
                                 '--no-install-recommends', 'install', str(self.debs[0])],
                                capture_output=True, text=True, timeout=15, env=self.env)
        self.assertEqual(result.returncode, 100, result.stderr)
        self.assertIn("Pathname to install is not absolute 'homeai-path-fixture_1%3a1.0-1_all.deb'", result.stderr)

    def test_production_options_reach_only_absolute_noop_dpkg_paths(self):
        result = self.run_helpers()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('Unable to read', result.stderr)
        self.assertNotIn('forbidden-dpkg-action', result.stderr)
        unpack = next(shlex.split(line) for line in result.stderr.splitlines() if ' --unpack ' in line)
        paths = [x for x in unpack if x.endswith('.deb')]
        self.assertEqual(len(paths), 2, result.stderr)
        self.assertTrue(all(pathlib.Path(x).is_absolute() for x in paths))
        self.assertEqual({pathlib.Path(x).name for x in paths},
                         {'homeai-path-fixture_1%3a1.0-1_all.deb',
                          'homeai-path-fixture-extra_2.0~rc1+bin.1-2_all.deb'})
        self.assertFalse(pathlib.Path((self.root / 'cache-path').read_text()).exists())

    def test_failure_removes_only_owned_cache_and_retains_status(self):
        apt = self.root / 'bin/apt-get'; apt.write_text('#!/bin/sh\nexit 37\n'); apt.chmod(0o700)
        sentinel = self.root / 'keep'; sentinel.write_text('unrelated fixture data')
        result = self.run_helpers()
        self.assertEqual(result.returncode, 37, result.stderr)
        self.assertFalse(pathlib.Path((self.root / 'cache-path').read_text()).exists())
        self.assertEqual(sentinel.read_text(), 'unrelated fixture data')

    def test_cleanup_failure_preserves_unexpected_data(self):
        script = self.functions + '''
tab=$(printf '\\t')
prepare_apt_cache "$1" "$2"
printf '%s' "$apt_scratch" > "$FIXTURE_CACHE_PATH"
printf keep > "$apt_scratch/archives/partial/unexpected"
cleanup_apt_cache
'''
        result = subprocess.run(['/bin/sh', '-c', script, 'fixture', str(self.packages), str(self.lock)],
                                capture_output=True, text=True, timeout=5, env=self.env)
        cache = pathlib.Path((self.root / 'cache-path').read_text())
        try:
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((cache / 'archives/partial/unexpected').read_text(), 'keep')
        finally:
            # Remove only this test's explicitly created files/empty directories.
            self.assertEqual(cache.parent, pathlib.Path('/tmp'))
            self.assertTrue(cache.name.startswith('homeai-offline-apt.'))
            (cache / 'archives/partial/unexpected').unlink()
            for d in ['archives/partial', 'archives', 'empty-sources', '.']:
                (cache / d).rmdir()

if __name__ == '__main__':
    unittest.main(verbosity=2)
