"""Extract a verified Git archive without links, traversal or unbounded expansion."""
import os
import pathlib
import sys
import tarfile


def extract(archive, destination, max_bytes=64 * 1024 * 1024):
    root = pathlib.Path(destination)
    if root.exists():
        raise ValueError('Release staging path already exists')
    with tarfile.open(archive, 'r:') as source:
        members = source.getmembers()
        if len(members) > 4096:
            raise ValueError('Release has too many entries')
        total = 0
        names = set()
        for member in members:
            name = pathlib.PurePosixPath(member.name)
            if (not member.name or name.is_absolute() or '..' in name.parts
                    or '\\' in member.name or str(name) in ('.', '')
                    or not (member.isfile() or member.isdir())):
                raise ValueError('Release contains an unsafe archive entry')
            if str(name) in names:
                raise ValueError('Release contains a duplicate path')
            names.add(str(name))
            total += member.size
            if member.size > 16 * 1024 * 1024 or total > max_bytes:
                raise ValueError('Release exceeds the extraction budget')
        root.mkdir(mode=0o755)
        for member in members:
            target = root.joinpath(*pathlib.PurePosixPath(member.name).parts)
            if member.isdir():
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                with source.extractfile(member) as incoming, target.open('xb') as output:
                    while chunk := incoming.read(1024 * 1024):
                        output.write(chunk)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    return {'files': len(members), 'bytes': total}


if __name__ == '__main__':
    import json
    print(json.dumps(extract(sys.argv[1], sys.argv[2])))
