"""Bounded metadata-only census of the cold backup's selected mappings.

Standalone for trusted stdin execution. Opens directories only, never reads file
contents or symlink targets, and emits only fixed categories and mapping names.
The caller must also impose a hard process timeout: filesystem syscalls can block.
This live estimate is neither a writer fence nor a successful backup.
"""
import argparse
import json
import os
import re
import stat
import sys
import time
from dataclasses import dataclass


# Kept standalone; contract test checks equality with backup-capture.py.
FORBIDDEN = {"secrets", "root-secrets", "credentials", "credentials.json", "auth.json", "device-access", "device-registry.json", "revocations.json", "tailscale", "vault", "machine-identity.json"}
DERIVED = {"node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".npm", ".pnpm-store", ".cache"}
MAPPINGS = (
    ("sessions", "home/.dsh/sessions", "sessions", True),
    ("projects", "workspaces/projects", "projects", True),
    ("registry", "state/workbench", "workbench/registry", False),
    ("sdk-workspaces", "home/.dsh/storages/workspace.json", "workbench/sdk/workspace.json", False),
    ("sdk-projection-directory", "home/.dsh/storages/session_projcache", "workbench/sdk/session_projcache", False),
    ("sdk-projection-file", "home/.dsh/storages/session_projcache.json", "workbench/sdk/session_projcache.json", False),
    ("sdk-schedules", "home/.dsh/storages/schedule.json", "workbench/sdk/schedule.json", False),
    ("applications", "state/applications", "applications/state", False),
)
RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
GIB = 1024 ** 3


class CensusError(Exception):
    """Fixed category only; never include an OS exception or private path."""


@dataclass(frozen=True)
class Limits:
    entries: int = 100000
    seconds: float = 10
    depth: int = 64


def counters():
    return {"regularSingleLinkFiles": 0, "regularSingleLinkBytes": 0,
            "directories": 0, "symlinkEntries": 0, "hardlinkedFileEntries": 0,
            "specialEntries": 0, "nestedMountEntries": 0, "filesOverProducerLimit": 0,
            "archivePathRefusals": 0, "caseAliasEntries": 0,
            "gitDirectories": 0, "gitPointerFiles": 0, "gitSymlinks": 0,
            "gitObjectAlternateFiles": 0}


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Census:
    def __init__(self, root, limits):
        self.root, self.limits = os.fspath(root), limits
        if (not os.path.isabs(self.root) or self.root == "/" or
                os.path.normpath(self.root) != self.root or len(self.root) > 4096):
            raise CensusError("CENSUS_ROOT_REFUSED")
        if not (1 <= limits.entries <= 100000 and 0 < limits.seconds <= 30 and 1 <= limits.depth <= 64):
            raise CensusError("CENSUS_LIMIT_INVALID")
        self.started = time.monotonic()
        self.visited = 0
        self.reasons = set()
        self.sources = []
        self.excluded = {key: {"entries": 0, "subtrees": 0, "knownFileBytes": 0,
                               "descendantsCounted": False} for key in ("security", "derived")}

    def check(self, entry=False, depth=0):
        if time.monotonic() - self.started >= self.limits.seconds:
            raise CensusError("TIME_LIMIT")
        if depth > self.limits.depth:
            raise CensusError("DEPTH_LIMIT")
        if entry:
            if self.visited >= self.limits.entries:
                raise CensusError("ENTRY_LIMIT")
            self.visited += 1

    def directory(self, parent, name, expected=None):
        self.check()
        info = expected or os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISDIR(info.st_mode):
            raise CensusError("NON_DIRECTORY_ANCESTOR")
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        if fingerprint(os.fstat(fd)) != fingerprint(info):
            os.close(fd)
            raise CensusError("SOURCE_CHANGED")
        return fd

    def open_root(self):
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            for component in self.root.split("/")[1:]:
                child = self.directory(fd, component)
                os.close(fd)
                fd = child
            return fd
        except BaseException:
            os.close(fd)
            raise

    def locate(self, root_fd, source):
        """Open only fixed mapping parents; caller owns the returned FD."""
        parent = os.dup(root_fd)
        try:
            for component in source.split("/")[:-1]:
                child = self.directory(parent, component)
                os.close(parent)
                parent = child
            name = source.split("/")[-1]
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            return parent, name, info
        except BaseException:
            os.close(parent)
            raise

    def walk(self, parent, name, archive_name, result, depth=0, device=None):
        self.check(entry=True, depth=depth)
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        directory, regular, symlink = (stat.S_ISDIR(info.st_mode), stat.S_ISREG(info.st_mode), stat.S_ISLNK(info.st_mode))
        if name == ".git":
            for key, present in (("gitDirectories", directory), ("gitPointerFiles", regular), ("gitSymlinks", symlink)):
                result[key] += int(present)
        if archive_name.endswith("/.git/objects/info/alternates") and regular:
            result["gitObjectAlternateFiles"] += 1
        if symlink:
            result["symlinkEntries"] += 1
            return
        if regular and info.st_nlink != 1:
            result["hardlinkedFileEntries"] += 1
            return
        if not directory and not regular:
            result["specialEntries"] += 1
            return
        if device is not None and info.st_dev != device:
            result["nestedMountEntries"] += 1
            return
        category = "security" if name.casefold() in FORBIDDEN else "derived" if directory and name in DERIVED else None
        if category:
            excluded = self.excluded[category]
            excluded["entries"] += 1
            excluded["subtrees"] += int(directory)
            excluded["knownFileBytes"] += 0 if directory else info.st_size
            return
        # Count payload candidates even when an invalid archive name would make
        # capture fail. The blockers are reported separately, never hidden.
        if (len(archive_name) > 1024 or any(not p or p in (".", "..") or "\\" in p or ":" in p
                or p[-1:] in (".", " ") or any(ord(c) < 32 for c in p) or RESERVED.match(p)
                for p in archive_name.split("/"))):
            result["archivePathRefusals"] += 1
        if regular:
            result["regularSingleLinkFiles"] += 1
            result["regularSingleLinkBytes"] += info.st_size
            result["filesOverProducerLimit"] += int(info.st_size > GIB)
            return
        result["directories"] += 1
        fd = self.directory(parent, name, info)
        try:
            seen = set()
            with os.scandir(fd) as children:
                for child in children:
                    folded = child.name.casefold()
                    if folded in seen:
                        result["caseAliasEntries"] += 1
                    seen.add(folded)
                    try:
                        self.walk(fd, child.name, archive_name + "/" + child.name, result, depth + 1, info.st_dev)
                    except OSError:
                        self.reasons.add("ENTRY_INACCESSIBLE_OR_CHANGED")
            if fingerprint(os.fstat(fd)) != fingerprint(info):
                self.reasons.add("SOURCE_CHANGED")
        finally:
            os.close(fd)

    def run(self):
        root_fd = self.open_root()
        pending = []
        try:
            space = os.fstatvfs(root_fd)
            available = max(0, space.f_bavail) * space.f_frsize
            capacity = {"filesystemTotalBytes": space.f_blocks * space.f_frsize,
                        "filesystemFreeBytes": space.f_bfree * space.f_frsize,
                        "filesystemAvailableBytes": available, "reserveBytes": 2 * GIB,
                        "availableAfterReserveBytes": max(0, available - 2 * GIB),
                        "outboxAllocationFitsAfterReserve": {
                            str(mib): available >= 2 * GIB + mib * 1024 ** 2 for mib in (128, 256)},
                        "scope": "root filesystem only; no quota or outbox mount verification",
                        "compressedArchiveSizeKnown": False, "reclaimableBytesKnown": False}
            # Establish every fixed source's existence before a large project
            # can consume the walk budget. An unresolved ancestor is not absent.
            for identity, source, destination, required in MAPPINGS:
                row = {"id": identity, "source": source, "required": required, "present": None,
                       "expectedShape": "file" if source.endswith(".json") else "directory",
                       "shapeMatches": None, "counts": counters(), "traversed": False}
                self.sources.append(row)
                try:
                    parent, name, info = self.locate(root_fd, source)
                    row["present"] = True
                    row["shapeMatches"] = stat.S_ISREG(info.st_mode) if source.endswith(".json") else stat.S_ISDIR(info.st_mode)
                    pending.append((parent, name, info, destination, row))
                except FileNotFoundError:
                    row["present"] = False
                except CensusError as error:
                    row["unresolvedReason"] = str(error)
                    self.reasons.add(str(error))
                except OSError:
                    row["unresolvedReason"] = "SOURCE_INACCESSIBLE"
                    self.reasons.add("SOURCE_INACCESSIBLE")
            for parent, name, info, destination, row in pending:
                try:
                    self.walk(parent, name, destination, row["counts"])
                    row["traversed"] = True
                    if fingerprint(os.stat(name, dir_fd=parent, follow_symlinks=False)) != fingerprint(info):
                        self.reasons.add("SOURCE_CHANGED")
                except CensusError as error:
                    self.reasons.add(str(error))
                    if str(error) in {"TIME_LIMIT", "ENTRY_LIMIT"}:
                        break
                except OSError:
                    self.reasons.add("SOURCE_INACCESSIBLE_OR_CHANGED")
        finally:
            for parent, *_ in pending:
                os.close(parent)
            os.close(root_fd)
        total = {key: sum(row["counts"][key] for row in self.sources) for key in counters()}
        return {"version": 1, "scope": "metadata-only selected-known-data",
                "censusComplete": not self.reasons, "partialReasons": sorted(self.reasons),
                "visitedEntries": self.visited, "elapsedSeconds": round(time.monotonic() - self.started, 3),
                "limits": {"entries": self.limits.entries, "seconds": self.limits.seconds, "depth": self.limits.depth},
                "runtime": {"pythonVersion": ".".join(map(str, sys.version_info[:3])), "os": sys.platform,
                            "kernelRelease": os.uname().release, "producerPythonSupported": sys.version_info >= (3, 12)},
                "sources": self.sources, "totals": total, "exclusions": self.excluded, "capacity": capacity,
                "payloadEstimate": "single-link regular bytes after exclusions; not capture eligibility, tar overhead or compression",
                "producerDefaultRawBudgetBytes": 2 * GIB,
                "estimatedPayloadExceedsDefaultBudget": total["regularSingleLinkBytes"] > 2 * GIB,
                "writerFence": False, "backupReady": False,
                "limitations": ["live non-atomic metadata estimate; external cold writer fence still required",
                                "excluded descendants not traversed or checked for unsupported types",
                                "git pointer and alternates contents not read; external repository data not counted",
                                "filesystem capacity does not establish ciphertext size or reclaimability",
                                "outer hard process timeout required for blocking filesystem syscalls"]}


def census(root, limits=Limits()):
    if sys.version_info < (3, 8) or os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
        raise CensusError("CENSUS_RUNTIME_UNSUPPORTED")
    return Census(root, limits).run()


def main():
    class SafeParser(argparse.ArgumentParser):
        def error(self, message):
            raise CensusError("CENSUS_ARGUMENT_INVALID")
    parser = SafeParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--max-entries", type=int, default=100000)
    parser.add_argument("--max-seconds", type=float, default=10)
    try:
        args = parser.parse_args()
        report = census(args.root, Limits(args.max_entries, args.max_seconds))
        print(json.dumps(report, separators=(",", ":"), ensure_ascii=True))
        return 0 if report["censusComplete"] else 2
    except CensusError as error:
        print(str(error), file=sys.stderr)
    except Exception:
        print("CENSUS_FAILED", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
