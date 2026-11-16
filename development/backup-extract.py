"""Strict data-only extraction into a newly created isolated directory.

No live-install mode, links, special files, permission restoration or execution.
The Node parent authenticates the entire ciphertext before starting this helper
and publishes the directory only after the second authentication succeeds.
"""
import json
import gzip
import os
import pathlib
import re
import sys
import tarfile

ALLOWED = {"sessions", "projects", "workbench", "applications"}
FORBIDDEN = {"secrets", "root-secrets", "credentials", "credentials.json", "auth.json", "device-access", "device-registry.json", "revocations.json", "tailscale", "vault", "machine-identity.json"}
RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)


def extract(root, budget):
    root = pathlib.Path(root)
    if not root.is_absolute() or root.is_symlink() or root.resolve() != root or any(root.iterdir()):
        raise ValueError("RESTORE_TARGET_NOT_EMPTY")
    seen = set()
    spellings = {}
    count = 0
    size = 0
    headers = 0
    metadata_bytes = 0

    class BoundedTarInfo(tarfile.TarInfo):
        @classmethod
        def frombuf(cls, buf, encoding, errors):
            nonlocal headers, metadata_bytes
            info = super().frombuf(buf, encoding, errors)
            headers += 1
            if headers > 200000:
                raise tarfile.InvalidHeaderError("HEADER_LIMIT")
            if info.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
                metadata_bytes += info.size
                if info.size < 0 or info.size > 16384 or metadata_bytes > 8 * 1024 ** 2:
                    raise tarfile.InvalidHeaderError("METADATA_LIMIT")
            return info

    class BoundedInflation:
        def __init__(self):
            self.source = gzip.GzipFile(fileobj=sys.stdin.buffer, mode="rb")
            self.bytes = 0

        def read(self, amount):
            data = self.source.read(min(amount, 1024 * 1024))
            self.bytes += len(data)
            if self.bytes > budget + 128 * 1024 ** 2:
                raise ValueError("INFLATION_LIMIT")
            return data

    inflated = BoundedInflation()
    with tarfile.open(fileobj=inflated, mode="r|", tarinfo=BoundedTarInfo, errorlevel=2) as archive:
        for member in archive:
            name = member.name.rstrip("/")
            parts = name.split("/")
            if (not name or len(name) > 1024 or "\\" in name or any(not p or p in (".", "..") or ":" in p or p[-1:] in (".", " ") or any(ord(c) < 32 for c in p) or RESERVED.match(p) for p in parts)
                    or parts[0] not in ALLOWED or any(p.lower() in FORBIDDEN for p in parts)):
                raise ValueError("RESTORE_PATH_REFUSED")
            folded = name.casefold()
            if folded in seen or len(seen) >= 100000:
                raise ValueError("RESTORE_ENTRY_LIMIT_OR_ALIAS")
            seen.add(folded)
            # Archive members can create parents implicitly. Compare every
            # component prefix before touching disk, even on case-sensitive
            # hosts, so a Windows restore never silently merges source trees.
            for length in range(1, len(parts) + 1):
                prefix = "/".join(parts[:length])
                key = prefix.casefold()
                if key in spellings and spellings[key] != prefix:
                    raise ValueError("RESTORE_PARENT_ALIAS")
                spellings[key] = prefix
                if len(spellings) > 100000:
                    raise ValueError("RESTORE_PATH_NODE_LIMIT")
            if not (member.isfile() or member.isdir()) or member.issparse():
                raise ValueError("RESTORE_TYPE_REFUSED")
            target = root.joinpath(*parts)
            for length in range(1, len(parts)):
                parent = root.joinpath(*parts[:length])
                if not parent.exists():
                    parent.mkdir(mode=0o700)
            for parent in target.parents:
                if parent == root:
                    break
                if parent.exists() and (parent.is_symlink() or not parent.is_dir()):
                    raise ValueError("RESTORE_PARENT_REFUSED")
            if member.isdir():
                target.mkdir(mode=0o700, exist_ok=True)
                continue
            if member.size < 0 or member.size > 1024 ** 3 or size + member.size > budget:
                raise ValueError("RESTORE_SIZE_LIMIT")
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("RESTORE_CONTENT_MISSING")
            remaining = member.size
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as output:
                while remaining:
                    data = source.read(min(remaining, 1024 * 1024))
                    if not data:
                        raise ValueError("RESTORE_CONTENT_TRUNCATED")
                    output.write(data)
                    remaining -= len(data)
                output.flush()
                os.fsync(output.fileno())
            count += 1
            size += member.size
    # Consume and validate the gzip trailer; hidden trailing inflated data is
    # bounded too, and the parent can authenticate the entire source stream.
    while inflated.read(1024 * 1024):
        pass
    if not count:
        raise ValueError("RESTORE_EMPTY")
    return {"version": 1, "complete": True, "files": count, "bytes": size}


if __name__ == "__main__":
    try:
        print(json.dumps(extract(sys.argv[1], int(sys.argv[2]))))
    except Exception:
        print("BACKUP_EXTRACTION_FAILED", file=sys.stderr)
        sys.exit(1)
