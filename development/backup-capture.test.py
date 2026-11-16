"""Synthetic fixtures only; gzip tar stays in BytesIO, not a plaintext file."""
import importlib.util
import io
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

SOURCE = pathlib.Path(__file__).with_name("backup-capture.py")
spec = importlib.util.spec_from_file_location("backup_capture", SOURCE)
capture = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = capture
spec.loader.exec_module(capture)


class CaptureTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix="homeai-capture-test-")
        self.addCleanup(temporary.cleanup)
        root = pathlib.Path(temporary.name).resolve() / "synthetic-root"
        (root / "home/.dsh/sessions").mkdir(parents=True)
        (root / "workspaces/projects/a").mkdir(parents=True)
        (root / "home/.dsh/sessions/session.jsonl").write_text('{"fixture":true}\n')
        return root

    def collect(self, root, limits=capture.Limits()):
        stream = io.BytesIO()
        report = capture.capture(root, stream, limits)
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode="r:gz") as archive:
            members = archive.getmembers()
            files = {member.name: archive.extractfile(member).read() for member in members if member.isfile()}
        return report, members, files

    def test_selected_mapping_and_closed_database_roundtrip_with_explicit_coverage(self):
        root = self.fixture()
        (root / "workspaces/projects/a/main.py").write_text("print('synthetic')\n")
        (root / "workspaces/projects/a" / ("ž" * 70 + ".txt")).write_text("PAX unicode fixture")
        (root / "workspaces/projects/a/node_modules/dependency").mkdir(parents=True)
        (root / "workspaces/projects/a/node_modules/dependency/index.js").write_text("derived")
        (root / "workspaces/projects/a/credentials.json").write_text("DO_NOT_CAPTURE")
        (root / "root-secrets").mkdir()
        (root / "root-secrets/key").write_text("OUTSIDE_MAPPING")
        (root / "state/workbench").mkdir(parents=True)
        (root / "state/workbench/index.json").write_text('{"synthetic":true}')
        (root / "home/.dsh/storages").mkdir(parents=True)
        (root / "home/.dsh/storages/workspace.json").write_text('{"workspace":[]}')
        database = root / "workspaces/projects/a/closed.sqlite"
        with sqlite3.connect(database) as connection:
            connection.execute("create table notes (text)")
            connection.execute("insert into notes values ('synthetic note')")
        connection.close()
        report, members, files = self.collect(root)
        self.assertIn("workbench/sdk/workspace.json", files)
        self.assertIn("workbench/registry/index.json", files)
        self.assertNotIn(b"DO_NOT_CAPTURE", b"".join(files.values()))
        self.assertNotIn(b"OUTSIDE_MAPPING", b"".join(files.values()))
        self.assertFalse(any("node_modules" in item.name for item in members))
        coverage = json.loads(files["workbench/backup-coverage.json"])
        self.assertEqual(coverage, report)
        self.assertEqual(coverage["exclusions"]["security"]["entries"], 1)
        self.assertEqual(coverage["exclusions"]["derived"]["subtrees"], 1)
        self.assertIn("Docker raw disk and volumes", coverage["notIncluded"])
        self.assertTrue(any(not row["present"] for row in coverage["sources"]))
        self.assertTrue(all(item.mode == (0o700 if item.isdir() else 0o600) for item in members))
        recovered = root.parent / "recovered.sqlite"
        recovered.write_bytes(files["projects/a/closed.sqlite"])
        with sqlite3.connect(recovered) as connection:
            self.assertEqual(connection.execute("select text from notes").fetchone()[0], "synthetic note")
        connection.close()

    def test_links_specials_and_intermediate_symlinks_fail_without_private_error_output(self):
        for kind in ("file-link", "directory-link", "hard-link", "fifo", "ancestor-link"):
            with self.subTest(kind=kind):
                root = self.fixture()
                private = root.parent / "PRIVATE_CANARY_NOT_FOR_STDERR"
                private.write_text("PRIVATE_CONTENT")
                target = root / "workspaces/projects/a/unsupported"
                if kind == "file-link":
                    target.symlink_to(private)
                elif kind == "directory-link":
                    target.symlink_to(root.parent, target_is_directory=True)
                elif kind == "hard-link":
                    os.link(private, target)
                elif kind == "fifo":
                    os.mkfifo(target)
                else:
                    (root / "state").symlink_to(root.parent, target_is_directory=True)
                result = subprocess.run([sys.executable, str(SOURCE), "--root", str(root)], capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr.decode(), r"^CAPTURE_[A-Z_]+\n$")
                self.assertNotIn(b"PRIVATE", result.stderr)

    def test_path_aliases_reserved_names_and_missing_required_sources_are_refused(self):
        for bad in ("CON.txt", "trailing.", "trailing ", "drive:name", "slash\\name", "control\x01name"):
            with self.subTest(bad=bad):
                root = self.fixture()
                (root / "workspaces/projects/a" / bad).write_text("synthetic")
                with self.assertRaisesRegex(capture.CaptureError, "PATH_REFUSED"):
                    self.collect(root)
        root = self.fixture()
        (root / "workspaces/projects/a/Name").mkdir()
        (root / "workspaces/projects/a/name").mkdir()
        with self.assertRaisesRegex(capture.CaptureError, "ALIAS"):
            self.collect(root)
        root = self.fixture()
        (root / "workspaces/projects/a").rmdir()
        (root / "workspaces/projects").rmdir()
        with self.assertRaisesRegex(capture.CaptureError, "REQUIRED_SOURCE_MISSING"):
            self.collect(root)

    def test_bounds_and_mid_capture_mutation_prevent_success(self):
        root = self.fixture()
        target = root / "workspaces/projects/a/file.txt"
        target.write_text("synthetic file")
        for limits in (capture.Limits(entries=2), capture.Limits(total_bytes=4), capture.Limits(file_bytes=4)):
            with self.subTest(limits=limits), self.assertRaises(capture.CaptureError):
                self.collect(root, limits)
        original = tarfile.TarFile.addfile

        def changed(archive, member, source=None):
            result = original(archive, member, source)
            if member.name == "projects/a/file.txt":
                target.write_text("changed during capture")
            return result

        with mock.patch.object(tarfile.TarFile, "addfile", changed):
            with self.assertRaisesRegex(capture.CaptureError, "SOURCE_CHANGED"):
                self.collect(root)


if __name__ == "__main__":
    unittest.main()
