"""Portable helpers for Windows -> Linux Harness history. Keep the header in its own Zstd frame."""
import json
try:
    import compression.zstd as zstd
    def compress_frame(data):return zstd.compress(data)
except ImportError:
    import zstandard
    def compress_frame(data):return zstandard.ZstdCompressor(level=3).compress(data)
def map_windows_path(value,mapping):
    normalized=value.replace('\\','/')
    for source,target in mapping.items():
        prefix=source.replace('\\','/').rstrip('/')
        if normalized.casefold()==prefix.casefold() or normalized.casefold().startswith(prefix.casefold()+'/'):return target.rstrip('/')+normalized[len(prefix):]
    return value
def encode_session_rows(rows):
    if not rows or rows[0].get('type')!='session':raise ValueError('First row must be the session header')
    return b''.join(compress_frame((json.dumps(row,ensure_ascii=False)+'\n').encode('utf-8')) for row in rows)
