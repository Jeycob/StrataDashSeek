"""Source contract and actual offline-verifier failure cases; never installs."""
import hashlib, json, os, pathlib, shutil, subprocess, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent

class SourceContract(unittest.TestCase):
    def test_pins_and_complete_serialization(self):
        lock = json.loads((HERE / 'os-packages.lock.json').read_text())
        packages = lock['packages']
        self.assertEqual(len(packages), 170)
        self.assertEqual(len({p['name'] for p in packages}), len(packages))
        self.assertTrue(set(sum(lock['selection']['requested'].values(), [])) <= {p['name'] for p in packages})
        tsv = ''.join('\t'.join(str(p[k]) for k in ['name', 'version', 'architecture', 'sha256', 'archiveBytes', 'localFilename']) + '\n' for p in packages)
        self.assertEqual(tsv, (HERE / 'os-packages.lock.tsv').read_text())
        self.assertIn(hashlib.sha256(tsv.encode()).hexdigest(), (HERE / 'Dockerfile').read_text())
        for p in packages:
            self.assertRegex(p['sha256'], r'^[a-f0-9]{64}$')
            self.assertTrue(p['url'].startswith('https://snapshot.debian.org/archive/'))
            self.assertIn('/' + lock['snapshot'] + '/', p['url'])
            self.assertTrue(p['url'].endswith('/' + p['filename']))
            self.assertEqual(p['localFilename'], p['name'] + '_' + p['architecture'] + '.deb')

    def test_no_toolchain_copy_or_network_install(self):
        docker = (HERE / 'Dockerfile').read_text()
        self.assertIn('FROM --platform=linux/amd64 docker.io/library/debian@sha256:', docker)
        self.assertEqual(docker.splitlines()[0], '# syntax=docker/dockerfile:1.27.1@sha256:7b32114e84ca21aeb2d6f871a0b62b3a0762193f75d9afd048ee4cbe889f3148')
        self.assertIn('--network=none --mount=type=bind,source=packages', docker)
        copies = [x for x in docker.splitlines() if x.startswith('COPY ')]
        self.assertEqual(copies, ['COPY os-packages.lock.tsv install-offline.sh /usr/local/lib/homeai-os-base/', 'COPY code-server.yaml /etc/homeai/code-server.yaml'])
        policy = (HERE.parents[1] / 'vast/apps-project-runtime-policy.cjs').read_text()
        for name in ['code-server', 'homeai', 'dotnet', 'playwright', 'npm']:
            self.assertIn("'" + name + "'", policy)
        self.assertIn("ReadOnly:true", policy)
        self.assertNotIn('ENTRYPOINT', docker)

class OfflineVerifier(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='homeai-os-deb-fixture-')
        self.root = pathlib.Path(self.tmp.name)
        self.packages = self.root / 'packages'; self.packages.mkdir()
        tree = self.root / 'tree'; (tree / 'DEBIAN').mkdir(parents=True)
        (tree / 'DEBIAN/control').write_text('Package: homeai-os-fixture\nVersion: 1.0\nArchitecture: all\nMaintainer: Test <test@example.invalid>\nDescription: Empty synthetic verification fixture\n')
        self.deb = self.packages / 'homeai-os-fixture_all.deb'
        subprocess.run(['dpkg-deb', '--root-owner-group', '--build', str(tree), str(self.deb)], check=True, stdout=subprocess.DEVNULL)
        shutil.copyfile(HERE / 'install-offline.sh', self.root / 'install-offline.sh')
        self.write_lock()

    def tearDown(self):
        self.tmp.cleanup()

    def write_lock(self, version='1.0'):
        data = self.deb.read_bytes()
        (self.root / 'os-packages.lock.tsv').write_text('homeai-os-fixture\t' + version + '\tall\t' + hashlib.sha256(data).hexdigest() + '\t' + str(len(data)) + '\t' + self.deb.name + '\n')

    def run_verify(self):
        return subprocess.run(['/bin/sh', str(self.root / 'install-offline.sh'), str(self.packages)], capture_output=True, text=True)

    def test_valid_default_only_verifies(self):
        result = self.run_verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Verified 1 locked', result.stdout)

    def test_relative_package_directory_only_verifies(self):
        result = subprocess.run(['/bin/sh', str(self.root / 'install-offline.sh'), 'packages'],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Verified 1 locked', result.stdout)

    def test_corruption(self):
        data = bytearray(self.deb.read_bytes()); data[-1] ^= 1; self.deb.write_bytes(data)
        self.assertIn('SHA256 mismatch', self.run_verify().stderr)

    def test_identity(self):
        self.write_lock(version='2.0')
        self.assertIn('identity mismatch', self.run_verify().stderr)

    def test_extra(self):
        (self.packages / 'extra').write_text('extra')
        self.assertIn('package set mismatch', self.run_verify().stderr)

    def test_symlink(self):
        target = self.root / 'target'; self.deb.rename(target); self.deb.symlink_to(target)
        self.assertIn('linked package', self.run_verify().stderr)

    def test_hardlink(self):
        os.link(self.deb, self.root / 'another-link')
        self.assertIn('hardlink', self.run_verify().stderr)

class PinnedPolicy(unittest.TestCase):
    # Exact public base bytes, never executed as a program by these tests.
    content = b'#!/bin/sh\n\n# For most Docker users, "apt-get install" only happens during "docker build",\n# where starting services doesn\'t work and often fails in humorous ways. This\n# prevents those failures by stopping the services from attempting to start.\n\nexit 101\n'

    def setUp(self):
        if os.getuid() != 0:
            self.skipTest('root needed only for isolated UID0 public-policy fixtures')
        self.tmp = tempfile.TemporaryDirectory(prefix='homeai-public-policy-test-')
        self.root = pathlib.Path(self.tmp.name)
        self.policy = self.root / 'policy-rc.d'
        self.policy.write_bytes(self.content); self.policy.chmod(0o755)
        # Source only the production functions, without its install entry point.
        self.functions = (HERE / 'install-offline.sh').read_text().split('# Package verification and install entry point.')[0]

    def tearDown(self):
        if hasattr(self, 'tmp'): self.tmp.cleanup()

    def run_policy(self, commands):
        script = self.root / 'test.sh'
        script.write_text(self.functions + '\n' + commands)
        return subprocess.run(['/bin/sh', str(script), str(self.policy)], capture_output=True, text=True)

    def test_preserve_restore_exact_bytes_and_metadata(self):
        os.utime(self.policy, (1793827419, 1793827419))
        result = self.run_policy('preserve_policy "$1"\nprintf changed > "$1"\nchmod 0600 "$1"\nrestore_policy\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.policy.read_bytes(), self.content)
        self.assertEqual(self.policy.stat().st_mode & 0o777, 0o755)
        self.assertEqual(int(self.policy.stat().st_mtime), 1793827419)

    def test_failure_trap_restores_and_retains_exit(self):
        result = self.run_policy('trap policy_exit EXIT\npreserve_policy "$1"\nprintf changed > "$1"\nexit 37\n')
        self.assertEqual(result.returncode, 37, result.stderr)
        self.assertEqual(self.policy.read_bytes(), self.content)

    def test_unknown_policy_rejected(self):
        self.policy.write_bytes(b'x' * 255)
        result = self.run_policy('preserve_policy "$1"\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SHA256 mismatch', result.stderr)
        self.assertEqual(self.policy.read_bytes(), b'x' * 255)

    def test_linked_policy_rejected(self):
        target = self.root / 'target'; self.policy.rename(target); self.policy.symlink_to(target)
        self.assertIn('regular file', self.run_policy('preserve_policy "$1"\n').stderr)

if __name__ == '__main__':
    unittest.main(verbosity=2)
