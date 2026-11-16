"""Offline extraction of one verified, inherited read-only archive FD.

Only a new exclusive destination is written. No lifecycle scripts or downloads.
The caller verifies artifact integrity and retains the FD through completion.
"""
import argparse
import json
import os
import pathlib
import posixpath
import resource
import stat
import sys
import tarfile
import zipfile

MAX_BYTES = 8 * 1024 ** 3
MAX_FILE = 2 * 1024 ** 3
MAX_ENTRIES = 100000


def unpack(fd, destination, strip, kind, max_bytes=MAX_BYTES, max_entries=MAX_ENTRIES):
    if not 0 <= strip <= 3 or kind not in ("tar", "zip"):
        raise ValueError("configuration")
    if not 1 <= max_bytes <= MAX_BYTES or not 1 <= max_entries <= MAX_ENTRIES:
        raise ValueError("limits")
    target = pathlib.Path(destination)
    if not target.is_absolute() or target == pathlib.Path("/") or str(target.resolve()) != str(target):
        raise ValueError("destination")
    target.mkdir(mode=0o700)  # exclusive; never merge with existing artifacts
    seen, count, total, written = set(), 0, 0, 0

    def written_entry():
        nonlocal written
        written += 1
        if written > max_entries:
            raise ValueError("expanded entry limit")

    def name_of(raw):
        nonlocal count
        count += 1
        if count > max_entries or not isinstance(raw, str) or len(raw) > 2048 or raw.startswith("/") or "\\" in raw or any(ord(c) < 32 for c in raw):
            raise ValueError("path")
        parts = raw.rstrip("/").split("/")
        while parts and parts[0] == ".":
            parts.pop(0)
        if any(p in ("", ".", "..") for p in parts):
            raise ValueError("path")
        parts = parts[strip:]
        if not parts:
            return None
        name = "/".join(parts)
        if name in seen or len(parts) > 48:
            raise ValueError("duplicate or depth")
        seen.add(name)
        return name

    def parents(name):
        current = target
        for component in name.split("/")[:-1]:
            current /= component
            try:
                info = current.lstat()
            except FileNotFoundError:
                written_entry()
                current.mkdir(mode=0o700)
                info = current.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ValueError("parent link")
        return target / name

    def member(name, size, mode, directory=False, link=None, stream=None):
        nonlocal total
        output = parents(name)
        if directory:
            try:
                if not output.exists():
                    written_entry()
                output.mkdir(mode=0o700)
            except FileExistsError:
                if not output.is_dir() or output.is_symlink():
                    raise ValueError("directory alias")
            return
        if link is not None:
            if not link or len(link) > 2048 or link.startswith("/") or "\\" in link or any(ord(c) < 32 for c in link):
                raise ValueError("link")
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
            if resolved == ".." or resolved.startswith("../"):
                raise ValueError("outside link")
            written_entry()
            output.symlink_to(link)
            return
        if not 0 <= size <= MAX_FILE or total + size > max_bytes:
            raise ValueError("size")
        total += size
        written_entry()
        handle = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(handle, "wb", closefd=False) as sink:
                copied = 0
                while chunk := stream.read(min(1024 * 1024, size - copied + 1)):
                    copied += len(chunk)
                    if copied > size:
                        raise ValueError("expanded size")
                    sink.write(chunk)
                if copied != size:
                    raise ValueError("truncated")
            os.fchmod(handle, 0o444 | (mode & 0o111))
            os.fsync(handle)
        finally:
            os.close(handle)

    with os.fdopen(os.dup(fd), "rb") as source:
        if kind == "tar":
            with tarfile.open(fileobj=source, mode="r:*") as archive:
                for entry in archive:
                    name = name_of(entry.name)
                    if name is None:
                        continue
                    if entry.issparse() or not (entry.isdir() or entry.isfile() or entry.issym()):
                        raise ValueError("unsupported type")
                    if entry.isfile():
                        with archive.extractfile(entry) as stream:
                            member(name, entry.size, entry.mode, stream=stream)
                    else:
                        member(name, 0, entry.mode, directory=entry.isdir(), link=entry.linkname if entry.issym() else None)
        else:
            with zipfile.ZipFile(source) as archive:
                if len(archive.infolist()) > max_entries:
                    raise ValueError("entry limit")
                for entry in archive.infolist():
                    name = name_of(entry.filename)
                    if name is None:
                        continue
                    mode = entry.external_attr >> 16
                    if stat.S_ISLNK(mode):
                        if entry.file_size > 2048:
                            raise ValueError("link size")
                        member(name, 0, mode, link=archive.read(entry).decode("utf-8", "strict"))
                    elif entry.is_dir():
                        member(name, 0, mode, directory=True)
                    elif stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                        raise ValueError("unsupported type")
                    else:
                        with archive.open(entry) as stream:
                            member(name, entry.file_size, mode, stream=stream)
    return {"entries": written, "bytes": total}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fd", type=int, required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--strip", type=int, required=True)
    parser.add_argument("--format", choices=("tar", "zip"), required=True)
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    parser.add_argument("--max-entries", type=int, default=MAX_ENTRIES)
    args = parser.parse_args()
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 ** 2, 512 * 1024 ** 2))
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    try:
        if not stat.S_ISREG(os.fstat(args.fd).st_mode):
            raise ValueError("descriptor")
        result = unpack(args.fd, args.destination, args.strip, args.format, args.max_bytes, args.max_entries)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception:
        print("TOOLCHAIN_EXTRACTION_REFUSED", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
