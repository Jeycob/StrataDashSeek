import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('extractor', pathlib.Path(__file__).with_name('startup-extract.py'))
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


class ExtractionTests(unittest.TestCase):
    def check_archive(self, name='vast/supervisor.cjs', kind=tarfile.REGTYPE, size=2):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = pathlib.Path(temporary.name)
        archive = root / 'source.tar'
        with tarfile.open(archive, 'w') as output:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = size if kind == tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                member.linkname = '/etc/passwd'
            output.addfile(member, io.BytesIO(b'{}' + b' ' * max(0, size-2)) if member.size else None)
        return archive, root / 'release'

    def test_normal_source(self):
        archive, destination = self.check_archive()
        result = extractor.extract(archive, destination)
        self.assertEqual(result['files'], 1)
        self.assertEqual((destination / 'vast/supervisor.cjs').read_text(), '{}')

    def test_traversal(self):
        archive, destination = self.check_archive('../outside')
        with self.assertRaises(ValueError):
            extractor.extract(archive, destination)
        self.assertFalse(destination.exists())

    def test_absolute_path(self):
        archive, destination = self.check_archive('/tmp/outside')
        with self.assertRaises(ValueError):
            extractor.extract(archive, destination)

    def test_symlink(self):
        archive, destination = self.check_archive(kind=tarfile.SYMTYPE)
        with self.assertRaises(ValueError):
            extractor.extract(archive, destination)

    def test_hardlink(self):
        archive, destination = self.check_archive(kind=tarfile.LNKTYPE)
        with self.assertRaises(ValueError):
            extractor.extract(archive, destination)

    def test_device(self):
        archive, destination = self.check_archive(kind=tarfile.CHRTYPE)
        with self.assertRaises(ValueError):
            extractor.extract(archive, destination)

    def test_bounded_expansion(self):
        archive, destination = self.check_archive(size=32)
        with self.assertRaises(ValueError):
            extractor.extract(archive, destination, max_bytes=16)


if __name__ == '__main__':
    unittest.main()
