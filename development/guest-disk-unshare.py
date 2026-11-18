"""Owned worker helper: one exact inherited regular-file range, no path input."""
import ctypes
import json
import os
import stat
import sys


def main():
    if sys.platform != "linux" or os.getuid() != 0 or len(sys.argv) != 2 or ctypes.sizeof(ctypes.c_void_p) != 8 or ctypes.sizeof(ctypes.c_long) != 8:
        raise RuntimeError("COPYUP_UNSHARE_ENVIRONMENT")
    size = int(sys.argv[1])
    before = os.fstat(3)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 1048576 <= size <= 1099511627776 or before.st_size != size:
        raise RuntimeError("COPYUP_UNSHARE_INPUT")
    # Linux UAPI FALLOC_FL_UNSHARE_RANGE, not a guessed util-linux CLI flag.
    libc = ctypes.CDLL(None, use_errno=True)
    call = libc.fallocate
    call.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_longlong, ctypes.c_longlong]
    call.restype = ctypes.c_int
    result = call(3, 0x40, 0, size)
    error = ctypes.get_errno() if result != 0 else 0
    if result == 0:
        os.fsync(3)
    after = os.fstat(3)
    if (before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode, before.st_nlink, size) != (after.st_dev, after.st_ino, after.st_uid, after.st_gid, after.st_mode, after.st_nlink, after.st_size):
        raise RuntimeError("COPYUP_UNSHARE_CHANGED")
    print(json.dumps({"kind": "OWNED_UNSHARE_RANGE", "flag": 64, "bytes": size, "ok": result == 0, "errno": error}))
    return 0 if result == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        print('{"kind":"OWNED_UNSHARE_RANGE","ok":false,"code":"COPYUP_UNSHARE_UNCONFIRMED"}')
        sys.exit(2)
