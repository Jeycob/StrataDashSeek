import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const {atomicJson} = createRequire(import.meta.url)('../mobile/private-json.cjs');
const FILE_LIMIT = 512 * 1024;
const unsafe = () => Object.assign(Error('Saved preview information is unavailable.'), {code: 'PREVIEW_RESULT_UNAVAILABLE', status: 409});

export function previewResults(root) {
  const directory = path.join(root, 'host-preview-results');

  function file(sessionId) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw unsafe();
    return path.join(directory, sessionId + '.json');
  }

  function checkDirectory() {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' &&
      ((info.mode & 0o077) || info.uid !== process.getuid())) || fs.realpathSync(directory) !== directory) throw unsafe();
  }

  function read(sessionId) {
    try {
      checkDirectory();
      const name = file(sessionId);
      const fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      try {
        const stat = fs.fstatSync(fd);
        const named = fs.lstatSync(name);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > FILE_LIMIT || named.isSymbolicLink() ||
          stat.dev !== named.dev || stat.ino !== named.ino || (process.platform !== 'win32' &&
          ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw unsafe();
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = fs.readSync(fd, bytes, length, bytes.length - length);
          if (!count) break;
          length += count;
        }
        if (length !== stat.size) throw unsafe();
        const row = JSON.parse(bytes.subarray(0, length));
        if (row?.version !== 1 || row.sessionId !== sessionId || typeof row.settled !== 'boolean' ||
          !/^[a-f0-9]{32}$/.test(row.resultId) || !row.recipe?.args ||
          !/^[a-f0-9]{64}$/.test(row.recipe.specSha256)) throw unsafe();
        return row;
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw unsafe();
    }
  }

  return {
    read,
    save(row) {
      fs.mkdirSync(directory, {recursive: true, mode: 0o700});
      checkDirectory();
      read(row.sessionId);
      if (Buffer.byteLength(JSON.stringify(row, null, 2)) > FILE_LIMIT) throw unsafe();
      atomicJson(file(row.sessionId), row);
    },
  };
}
