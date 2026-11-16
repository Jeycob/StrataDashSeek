"""Stream selected cold data as gzip tar to stdout, never a plaintext archive.

The trusted caller owns continuous writer exclusion and must require exit 0.
No scheduler, fence inference, private-key handling or production reads on import.
Python 3.12+, POSIX dir_fd/O_NOFOLLOW support required.
"""
import argparse
import gzip
import io
import json
import os
import re
import stat
import sys
import tarfile
from dataclasses import dataclass


# Must agree with backup-extract.py. Security names are excluded without reading
# contents; unsupported links/types are rejected even when named as exclusions.
FORBIDDEN = {"secrets", "root-secrets", "credentials", "credentials.json", "auth.json", "device-access", "device-registry.json", "revocations.json", "tailscale", "vault", "machine-identity.json"}
DERIVED = {"node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".npm", ".pnpm-store", ".cache"}
RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)
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


class CaptureError(Exception):
    """A fixed safe error code, never a source path or exception payload."""


@dataclass(frozen=True)
class Limits:
    entries: int = 100000
    total_bytes: int = 2 * 1024 ** 3
    file_bytes: int = 1024 ** 3
    depth: int = 64


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Capture:
    def __init__(self, root, output, limits):
        self.root = os.fspath(root)
        self.output = output
        self.limits = limits
        if (not os.path.isabs(self.root) or self.root == "/" or
                os.path.normpath(self.root) != self.root or os.path.realpath(self.root) != self.root):
            raise CaptureError("CAPTURE_ROOT_REFUSED")
        if (not 1 <= limits.entries <= 100000 or not 1 <= limits.total_bytes <= 64 * 1024 ** 3 or
                not 1 <= limits.file_bytes <= 1024 ** 3 or not 1 <= limits.depth <= 64):
            raise CaptureError("CAPTURE_LIMIT_INVALID")
        self.count = self.bytes = self.files = self.visited = 0
        self.header_count = self.metadata_bytes = self.overhead_bytes = 0
        self.seen = set()
        self.spellings = {}
        self.excluded = {key: {"entries": 0, "subtrees": 0, "known_file_bytes": 0,
                               "descendant_counts": "not traversed"} for key in ("security", "derived")}
        self.sources = []

    def member(self, name, size=0, directory=False):
        parts = name.split("/")
        if (not name or len(name) > 1024 or "\\" in name or parts[0] not in {"sessions", "projects", "workbench", "applications"}
                or any(not p or p in (".", "..") or ":" in p or p[-1:] in (".", " ")
                       or any(ord(c) < 32 for c in p) or RESERVED.match(p) or p.casefold() in FORBIDDEN for p in parts)):
            raise CaptureError("CAPTURE_ARCHIVE_PATH_REFUSED")
        folded = name.casefold()
        if folded in self.seen or self.count >= self.limits.entries:
            raise CaptureError("CAPTURE_ENTRY_LIMIT_OR_ALIAS")
        self.seen.add(folded)
        for length in range(1, len(parts) + 1):
            prefix = "/".join(parts[:length])
            key = prefix.casefold()
            if key in self.spellings and self.spellings[key] != prefix:
                raise CaptureError("CAPTURE_PARENT_ALIAS")
            self.spellings[key] = prefix
            if len(self.spellings) > self.limits.entries:
                raise CaptureError("CAPTURE_PATH_NODE_LIMIT")
        if size < 0 or size > self.limits.file_bytes or self.bytes + size > self.limits.total_bytes:
            raise CaptureError("CAPTURE_SIZE_LIMIT")
        info = tarfile.TarInfo(name)
        info.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
        info.mode = 0o700 if directory else 0o600
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mtime = 0
        info.size = size
        # Mirror extractor bounds for generated PAX path metadata and padding.
        encoded = info.tobuf(tarfile.PAX_FORMAT, "utf-8", "strict")
        cursor = 0
        while cursor < len(encoded):
            self.header_count += 1
            header = encoded[cursor:cursor + 512]
            cursor += 512
            if header[156:157] in (tarfile.XHDTYPE, tarfile.XGLTYPE):
                metadata_size = int(header[124:136].rstrip(b"\0 ") or b"0", 8)
                self.metadata_bytes += metadata_size
                if metadata_size > 16384:
                    raise CaptureError("CAPTURE_METADATA_LIMIT")
                cursor += (metadata_size + 511) // 512 * 512
        self.overhead_bytes += len(encoded) + ((size + 511) // 512 * 512 - size)
        if self.header_count > 200000 or self.metadata_bytes > 8 * 1024 ** 2 or self.overhead_bytes > 128 * 1024 ** 2 - tarfile.RECORDSIZE:
            raise CaptureError("CAPTURE_METADATA_LIMIT")
        self.count += 1
        self.bytes += size
        if not directory:
            self.files += 1
        return info

    def walk(self, parent, name, archive_name, archive, depth=0, device=None):
        self.visited += 1
        if self.visited > self.limits.entries or depth > self.limits.depth:
            raise CaptureError("CAPTURE_WALK_LIMIT")
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        directory = stat.S_ISDIR(before.st_mode)
        if not (directory or stat.S_ISREG(before.st_mode)) or (not directory and before.st_nlink != 1):
            raise CaptureError("CAPTURE_UNSUPPORTED_TYPE_OR_LINK")
        if device is not None and before.st_dev != device:
            raise CaptureError("CAPTURE_NESTED_MOUNT_UNSUPPORTED")
        category = "security" if name.casefold() in FORBIDDEN else "derived" if directory and name in DERIVED else None
        if category:
            count = self.excluded[category]
            count["entries"] += 1
            count["subtrees"] += int(directory)
            count["known_file_bytes"] += 0 if directory else before.st_size
            return
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if directory:
            flags |= os.O_DIRECTORY
        fd = os.open(name, flags, dir_fd=parent)
        try:
            opened = os.fstat(fd)
            if fingerprint(opened) != fingerprint(before):
                raise CaptureError("CAPTURE_SOURCE_CHANGED")
            if directory:
                archive.addfile(self.member(archive_name, directory=True))
                with os.scandir(fd) as children:
                    for child in children:
                        self.walk(fd, child.name, archive_name + "/" + child.name, archive, depth + 1, opened.st_dev)
            else:
                info = self.member(archive_name, opened.st_size)
                with os.fdopen(os.dup(fd), "rb") as source:
                    archive.addfile(info, source)
            if fingerprint(os.fstat(fd)) != fingerprint(opened):
                raise CaptureError("CAPTURE_SOURCE_CHANGED")
        finally:
            os.close(fd)

    def mapping(self, root_fd, source, destination, archive):
        components = source.split("/")
        parent = os.dup(root_fd)
        try:
            for component in components[:-1]:
                try:
                    info = os.stat(component, dir_fd=parent, follow_symlinks=False)
                    if not stat.S_ISDIR(info.st_mode):
                        raise CaptureError("CAPTURE_UNSUPPORTED_SOURCE_PATH")
                    child = os.open(component, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=parent)
                except FileNotFoundError:
                    return False
                os.close(parent)
                parent = child
            try:
                info = os.stat(components[-1], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                return False
            if (not source.endswith(".json")) != stat.S_ISDIR(info.st_mode):
                raise CaptureError("CAPTURE_SOURCE_SHAPE_REFUSED")
            self.walk(parent, components[-1], destination, archive)
            return True
        finally:
            os.close(parent)

    def run(self):
        root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            with gzip.GzipFile(filename="", fileobj=self.output, mode="wb", compresslevel=6, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                    for identity, source, destination, required in MAPPINGS:
                        files_before, bytes_before = self.files, self.bytes
                        present = self.mapping(root_fd, source, destination, archive)
                        self.sources.append({"id": identity, "destination": destination, "present": present,
                                             "files": self.files - files_before, "bytes": self.bytes - bytes_before})
                        if required and not present:
                            raise CaptureError("CAPTURE_REQUIRED_SOURCE_MISSING")
                    if not self.files:
                        raise CaptureError("CAPTURE_NO_DATA")
                    coverage = {"version": 1, "scope": "selected-known-data", "completeForSelectedMappings": True,
                                "writerExclusion": "external continuous cold fence required",
                                "sources": self.sources, "files": self.files, "bytes": self.bytes,
                                "exclusions": self.excluded,
                                "notIncluded": ["Docker raw disk and volumes", "control credentials", "device authentication and revocations",
                                                "root secrets", "runtime machine identities", "excluded derived dependency subtrees"],
                                "unsupported": ["symlinks", "hard-linked regular files", "special files", "nested mounts"],
                                "archiveModes": {"file": "0600", "directory": "0700"},
                                "sourceFileModesRestored": False}
                    data = json.dumps(coverage, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
                    archive.addfile(self.member("workbench/backup-coverage.json", len(data)), io.BytesIO(data))
            return coverage
        finally:
            os.close(root_fd)


def capture(root, output, limits=Limits()):
    if sys.version_info < (3, 12) or os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
        raise CaptureError("CAPTURE_RUNTIME_UNSUPPORTED")
    return Capture(root, output, limits).run()


def main():
    class SafeParser(argparse.ArgumentParser):
        def error(self, message):
            raise CaptureError("CAPTURE_ARGUMENT_INVALID")
    parser = SafeParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--max-entries", type=int, default=100000)
    parser.add_argument("--max-bytes", type=int, default=2 * 1024 ** 3)
    parser.add_argument("--max-file-bytes", type=int, default=1024 ** 3)
    try:
        args = parser.parse_args()
        capture(args.root, sys.stdout.buffer, Limits(args.max_entries, args.max_bytes, args.max_file_bytes))
    except CaptureError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("CAPTURE_FAILED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
