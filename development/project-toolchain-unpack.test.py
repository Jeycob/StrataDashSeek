"""Tiny synthetic archives only. Never builds or examines a real toolchain."""
import importlib.util
import io
import os
import pathlib
import stat
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("toolchain_unpack", pathlib.Path(__file__).with_name("project-toolchain-unpack.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UnpackTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix="homeai-toolchain-archive-")
        self.addCleanup(temporary.cleanup)
        root = pathlib.Path(temporary.name).resolve()
        return root, root / "archive", root / "output"

    def extract(self, archive, destination, kind="tar", strip=1):
        with archive.open("rb") as source:
            module.unpack(source.fileno(), str(destination), strip, kind)

    def tar(self, archive, entries):
        with tarfile.open(archive, "w:gz") as output:
            for name, kind, value in entries:
                info = tarfile.TarInfo(name)
                info.mode = 0o755
                if kind == "file":
                    info.size = len(value)
                    output.addfile(info, io.BytesIO(value))
                else:
                    info.type = {"link": tarfile.SYMTYPE, "hard": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE}[kind]
                    info.linkname = value
                    output.addfile(info)

    def test_verified_fd_style_tar_and_zip_extract_only_payload_and_internal_link(self):
        root, archive, destination = self.fixture()
        self.tar(archive, [("package/bin/tool", "file", b"synthetic"), ("package/bin/alias", "link", "tool")])
        self.extract(archive, destination)
        self.assertEqual((destination / "bin/tool").read_bytes(), b"synthetic")
        self.assertEqual((destination / "bin/alias").read_bytes(), b"synthetic")
        self.assertEqual((destination / "bin/tool").stat().st_mode & 0o777, 0o555)
        with zipfile.ZipFile(root / "browser.zip", "w") as output:
            info = zipfile.ZipInfo("browser/bin")
            info.external_attr = (stat.S_IFREG | 0o755) << 16
            output.writestr(info, b"synthetic browser")
        self.extract(root / "browser.zip", root / "browser-output", kind="zip", strip=0)
        self.assertEqual((root / "browser-output/browser/bin").read_bytes(), b"synthetic browser")

    def test_traversal_absolute_paths_links_hardlinks_and_special_types_refused(self):
        for name, kind, value in [("../escape", "file", b"bad"), ("/absolute", "file", b"bad"), ("package/link", "link", "../../outside"), ("package/link", "link", "/etc/passwd"), ("package/hard", "hard", "package/file"), ("package/pipe", "fifo", "")]:
            with self.subTest(name=name, kind=kind):
                root, archive, destination = self.fixture()
                self.tar(archive, [(name, kind, value)])
                with self.assertRaises(ValueError):
                    self.extract(archive, destination)
                self.assertFalse((root / "escape").exists())

    def test_duplicate_file_and_parent_symlink_alias_refused_without_following_target(self):
        for entries in [[("package/a", "file", b"one"), ("package/a", "file", b"two")], [("package/dir", "link", "inside"), ("package/dir/file", "file", b"bad")]]:
            root, archive, destination = self.fixture()
            self.tar(archive, entries)
            with self.assertRaises(ValueError):
                self.extract(archive, destination)

    def test_existing_destination_and_expanded_size_bound_are_fail_closed(self):
        root, archive, destination = self.fixture()
        self.tar(archive, [("package/a", "file", b"synthetic")])
        destination.mkdir()
        with self.assertRaises(FileExistsError):
            self.extract(archive, destination)
        before = module.MAX_FILE
        module.MAX_FILE = 1
        try:
            with self.assertRaises(ValueError):
                self.extract(archive, root / "too-large")
        finally:
            module.MAX_FILE = before
        self.tar(archive, [("package/a/b/c", "file", b"x")])
        with archive.open("rb") as source:
            with self.assertRaises(ValueError):
                module.unpack(source.fileno(), str(root / "entry-bound"), 1, "tar", max_entries=1)


if __name__ == "__main__":
    unittest.main()
