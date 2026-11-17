"""Offline verification of public keys -> InRelease -> Packages.xz -> package pins.

Usage: python3 verify-provenance.py DIRECTORY_CONTAINING_SUITE-Packages.xz
No networking, downloads, installs or writes outside a temporary own GPG home.
"""
import hashlib, json, lzma, pathlib, re, subprocess, sys, tempfile

HERE = pathlib.Path(__file__).resolve().parent

def sha(data):
    return hashlib.sha256(data).hexdigest()

def verify(metadata):
    lock = json.loads((HERE / 'os-packages.lock.json').read_text())
    with tempfile.TemporaryDirectory(prefix='homeai-os-public-signatures-') as tmp:
        home = pathlib.Path(tmp)
        home.chmod(0o700)
        common = ['--batch', '--homedir', str(home)]
        ring = b''
        for key in lock['provenance']['keys']:
            source = HERE / 'provenance' / key['name']
            assert sha(source.read_bytes()) == key['sha256'], key['name']
            output = subprocess.check_output(['gpg', *common, '--with-colons', '--show-keys', str(source)], stderr=subprocess.DEVNULL).decode()
            primary = next(line.split(':')[9] for line in output.splitlines() if line.startswith('fpr:'))
            assert primary == key['fingerprint'], key['name']
            ring += subprocess.check_output(['gpg', *common, '--output', '-', '--dearmor', str(source)])
        (home / 'trusted.gpg').write_bytes(ring)
        indexes = {}
        for release in lock['provenance']['releases']:
            suite = release['suite']
            source = HERE / 'provenance' / (suite + '-InRelease')
            assert sha(source.read_bytes()) == release['inReleaseSha256'], suite
            plain = home / (suite + '-Release')
            result = subprocess.run(['gpgv', '--homedir', str(home), '--keyring', str(home / 'trusted.gpg'), '--status-fd', '1', '--output', str(plain), str(source)], capture_output=True, check=True)
            signers = [line.split()[-1] for line in result.stdout.decode().splitlines() if line.startswith('[GNUPG:] VALIDSIG ')]
            assert sorted(signers) == sorted(release['validSignerPrimaryFingerprints']), suite
            signed = plain.read_text()
            compressed = (metadata / (suite + '-Packages.xz')).read_bytes()
            assert len(compressed) == release['packagesBytes'] and sha(compressed) == release['packagesSha256'], suite
            for suffix, data in [('.xz', compressed), ('', lzma.decompress(compressed))]:
                row = re.search(r'^ ([a-f0-9]{64})\s+(\d+) main/binary-amd64/Packages' + re.escape(suffix) + '$', signed, re.M)
                assert row and row[1] == sha(data) and int(row[2]) == len(data), suite
            records = {}
            for paragraph in lzma.decompress(compressed).decode().split('\n\n'):
                fields = dict(line.split(': ', 1) for line in paragraph.splitlines() if not line.startswith(' ') and ': ' in line)
                if all(k in fields for k in ['Package', 'Version', 'Architecture']):
                    records[(fields['Package'], fields['Version'], fields['Architecture'])] = fields
            indexes[suite] = records
        for package in lock['packages']:
            record = indexes[package['suite']][(package['name'], package['version'], package['architecture'])]
            for name, field in [('sha256', 'SHA256'), ('filename', 'Filename'), ('archiveBytes', 'Size')]:
                assert str(package[name]) == record[field], (package['name'], name)
    return len(lock['packages'])

if __name__ == '__main__':
    assert len(sys.argv) == 2, 'provide only the public metadata directory'
    print(json.dumps({'verifiedPackages': verify(pathlib.Path(sys.argv[1])), 'debPayloadsRead': False, 'networkUsed': False}))
