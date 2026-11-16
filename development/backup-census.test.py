"""Synthetic metadata fixtures. No production census is executed by these tests."""
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


def module(filename, name):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


census = module("backup-census.py", "backup_census")
capture = module("backup-capture.py", "backup_capture_contract")


class CensusTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix="homeai-census-test-")
        self.addCleanup(temporary.cleanup)
        root = pathlib.Path(temporary.name).resolve() / "synthetic-root"
        (root / "home/.dsh/sessions").mkdir(parents=True)
        (root / "workspaces/projects/PRIVATE_PROJECT_NAME").mkdir(parents=True)
        (root / "home/.dsh/sessions/PRIVATE_SESSION_NAME").write_bytes(b"PRIVATE_CONTENT")
        return root, root / "workspaces/projects/PRIVATE_PROJECT_NAME"

    def test_policy_contract_payload_exclusions_and_exact_presence(self):
        self.assertEqual(census.MAPPINGS, capture.MAPPINGS)
        self.assertEqual(census.FORBIDDEN, capture.FORBIDDEN)
        self.assertEqual(census.DERIVED, capture.DERIVED)
        root, project = self.fixture()
        (project / "main.py").write_bytes(b"12345")
        (project / "node_modules/private-dependency").mkdir(parents=True)
        (project / "node_modules/private-dependency/index.js").write_bytes(b"excluded")
        (project / "credentials.json").write_bytes(b"excluded-security")
        (root / "home/.dsh/storages").mkdir()
        (root / "home/.dsh/storages/workspace.json").write_bytes(b"{}")
        report = census.census(root)
        self.assertTrue(report["censusComplete"])
        self.assertFalse(report["backupReady"])
        self.assertEqual(report["totals"]["regularSingleLinkBytes"], 15 + 5 + 2)
        self.assertEqual(report["totals"]["regularSingleLinkFiles"], 3)
        self.assertEqual(report["exclusions"]["derived"]["subtrees"], 1)
        self.assertFalse(report["exclusions"]["derived"]["descendantsCounted"])
        rows = {row["id"]: row for row in report["sources"]}
        self.assertTrue(rows["sessions"]["present"])
        self.assertTrue(rows["projects"]["present"])
        self.assertFalse(rows["applications"]["present"])
        self.assertEqual(report["capacity"]["reserveBytes"], 2 * 1024 ** 3)
        self.assertFalse(report["capacity"]["compressedArchiveSizeKnown"])

    def test_no_content_opens_and_unsupported_git_metadata_no_follow(self):
        root, project = self.fixture()
        outside = root.parent / "PRIVATE_OUTSIDE_TARGET"
        outside.write_bytes(b"PRIVATE_OUTSIDE_CONTENT")
        (project / "symlink").symlink_to(outside)
        os.link(outside, project / "hardlink")
        os.mkfifo(project / "pipe")
        (project / ".git/objects/info").mkdir(parents=True)
        (project / ".git/objects/info/alternates").write_bytes(b"PRIVATE_ALTERNATE_PATH")
        (project / "nested").mkdir()
        (project / "nested/.git").write_bytes(b"gitdir: PRIVATE_GITDIR")
        original_open = os.open
        def directories_only(path, flags, *args, **kwargs):
            self.assertTrue(flags & os.O_DIRECTORY)
            self.assertTrue(flags & os.O_NOFOLLOW)
            return original_open(path, flags, *args, **kwargs)
        with mock.patch.object(census.os, "open", side_effect=directories_only), mock.patch.object(census.os, "readlink", side_effect=AssertionError("no target reads")):
            report = census.census(root)
        counts = report["totals"]
        for key in ("symlinkEntries", "hardlinkedFileEntries", "specialEntries", "gitDirectories", "gitPointerFiles", "gitObjectAlternateFiles"):
            self.assertEqual(counts[key], 1, key)
        self.assertNotIn("PRIVATE_", json.dumps(report))

    def test_bounded_partial_counts_preserve_presence_and_safe_output(self):
        root, project = self.fixture()
        for number in range(12):
            (project / str(number)).write_bytes(b"x")
        report = census.census(root, census.Limits(entries=3))
        self.assertFalse(report["censusComplete"])
        self.assertIn("ENTRY_LIMIT", report["partialReasons"])
        self.assertEqual(report["visitedEntries"], 3)
        self.assertTrue(next(row for row in report["sources"] if row["id"] == "projects")["present"])
        runner = census.Census(root, census.Limits())
        runner.started -= 11
        with self.assertRaisesRegex(census.CensusError, "TIME_LIMIT"):
            runner.check()
        (root / "state").symlink_to(root.parent, target_is_directory=True)
        report = census.census(root)
        row = next(row for row in report["sources"] if row["id"] == "registry")
        self.assertIsNone(row["present"])
        self.assertEqual(row["unresolvedReason"], "NON_DIRECTORY_ANCESTOR")
        self.assertNotIn("PRIVATE_", json.dumps(report))

    def test_shape_alias_and_capture_refusal_categories_are_visible(self):
        root, project = self.fixture()
        (project / "CON.txt").write_bytes(b"x")
        (project / "same").write_bytes(b"x")
        (project / "SAME").write_bytes(b"x")
        (root / "state").mkdir()
        (root / "state/applications").write_bytes(b"wrong shape")
        report = census.census(root)
        self.assertEqual(report["totals"]["archivePathRefusals"], 1)
        self.assertEqual(report["totals"]["caseAliasEntries"], 1)
        row = next(row for row in report["sources"] if row["id"] == "applications")
        self.assertTrue(row["present"])
        self.assertFalse(row["shapeMatches"])


if __name__ == "__main__":
    unittest.main()
