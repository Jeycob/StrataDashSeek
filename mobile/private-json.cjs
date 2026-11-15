'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function target(file) {
  try {const info = fs.lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.platform !== 'win32' && info.mode & 0o022) throw Error('Unsafe private JSON target');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
}
function atomicJson(file, value) {
  const parent = path.dirname(file); fs.mkdirSync(parent, {recursive: true, mode: 0o700});
  const directory = fs.lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && directory.mode & 0o022) throw Error('Unsafe private JSON directory');
  target(file);
  const temporary = path.join(parent, '.' + path.basename(file) + '.' + crypto.randomBytes(12).toString('hex'));
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const current = fs.lstatSync(parent);
    if (current.isSymbolicLink() || current.dev !== directory.dev || current.ino !== directory.ino) throw Error('Private JSON parent changed');
    target(file); fs.renameSync(temporary, file);
    if (process.platform !== 'win32') {const parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); try {fs.fsyncSync(parentFd);} finally {fs.closeSync(parentFd);}}
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {fs.unlinkSync(temporary);} catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
}
module.exports = {atomicJson};
