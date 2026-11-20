'use strict';
const vscode = require('vscode');
const { FileSystemError: FsError, FileType, FileChangeType } = vscode;
const encode = new TextEncoder();
const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const missing = new Set(['ENOENT', 'FS_NOT_FOUND']);
const denied = new Set(['READ_ONLY', 'SESSION_NOT_LIVE', 'OUTSIDE_PROJECT', 'INVALID_PATH']);
const stale = new Set(['FS_STALE_VERSION', 'FS_ALREADY_EXISTS', 'PROJECT_CHANGED', 'FS_EXISTS']);
const editorText = text => text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
const messages = {
  en: {
    stale: 'The project file changed on disk. Your draft is still open. Compare it with the saved file before deciding what to keep.',
    held: 'The agent is writing to this project. Your draft is still open. Save again when the write completes.',
    denied: 'Editing is unavailable in this conversation. Your draft is still open.',
    binary: 'Only UTF-8 text files up to 1 MiB can be edited here. Use Project Files to download this file.',
    folder: 'This operation is available for individual files.',
    unavailable: 'Project files are temporarily unavailable.',
  },
  cs: {
    stale: 'Projektový soubor se změnil na disku. Rozpracovaný text zůstává otevřený. Porovnejte ho s uloženým souborem.',
    held: 'Agent zapisuje do tohoto projektu. Rozpracovaný text zůstává otevřený. Uložte ho znovu po dokončení zápisu.',
    denied: 'V tomto chatu není zápis dostupný. Rozpracovaný text zůstává otevřený.',
    binary: 'Zde lze upravovat textové soubory UTF-8 do 1 MiB. Soubor můžete stáhnout v Souborech projektu.',
    folder: 'Tato operace je dostupná pro jednotlivé soubory.',
    unavailable: 'Soubory projektu jsou dočasně nedostupné.',
  },
};

function activate(context) {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (folder?.scheme !== 'homeai' || !/^[a-zA-Z0-9_-]{1,128}$/.test(folder.authority) || folder.path !== '/Project') return;
  const copy = messages[vscode.env.language] || messages.en;
  const emitter = new vscode.EventEmitter();
  const metadata = new Map();
  const directories = new Map();
  const versions = new Map();
  const readsDuringEdit = new Map();
  const dirty = new Map(Object.entries(context.workspaceState.get('draftVersions', {})));
  const api = new URL('/api/workbench', globalThis.location.origin);
  let clock = Date.now();
  let polling = false;
  let disposed = false;

  function relative(uri) {
    if (uri.scheme !== folder.scheme || uri.authority !== folder.authority || uri.query || uri.fragment) throw FsError.NoPermissions();
    if (uri.path === folder.path) return '';
    const name = uri.path.slice(folder.path.length + 1);
    if (!uri.path.startsWith(folder.path + '/') || !name || name.length > 1024 ||
        name.split('/').some(part => !part || ['.', '..', '.git', '.harness'].includes(part) || /[\x00\\]/u.test(part))) {
      throw FsError.NoPermissions();
    }
    return name;
  }

  function fileUri(name) {
    return name ? folder.with({ path: folder.path + '/' + name }) : folder;
  }

  async function request(operation, args) {
    let value;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(api, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'file', sessionId: folder.authority, operation, args }),
        signal: controller.signal,
      });
      value = await response.json();
      if (response.ok) return value;
    } catch { throw FsError.Unavailable(copy.unavailable); }
    finally { clearTimeout(timeout); }
    if (missing.has(value.code)) throw FsError.FileNotFound();
    if (denied.has(value.code)) throw FsError.NoPermissions(copy.denied);
    if (['TOO_LARGE', 'BINARY_FILE', 'INVALID_TEXT'].includes(value.code)) throw FsError.Unavailable(copy.binary);
    if (stale.has(value.code) || value.code === 'READ_CHANGED' || value.code === 'PROJECT_WRITER_HELD') {
      const text = value.code === 'PROJECT_WRITER_HELD' ? copy.held : copy.stale;
      if (operation === 'write') void vscode.window.showWarningMessage(text);
      throw FsError.Unavailable(text);
    }
    throw FsError.Unavailable(copy.unavailable);
  }

  function update(name, value) {
    const previous = metadata.get(name);
    const current = {
      version: value.version,
      type: value.type === 'directory' ? FileType.Directory : FileType.File,
      ctime: previous?.ctime ?? clock,
      mtime: previous && previous.version === value.version ? previous.mtime : ++clock,
      size: value.bytes ?? 0,
    };
    metadata.set(name, current);
    return current;
  }

  async function listing(name) {
    const { entries } = await request('list', { path: name });
    return new Map(entries.filter(entry => !entry.symlink).map(entry => [entry.name, entry.directory ? FileType.Directory : FileType.File]));
  }

  function persistVersions() {
    void context.workspaceState.update('draftVersions', Object.fromEntries(dirty));
  }

  function trackDirty(document) {
    if (document.uri.scheme !== folder.scheme || document.uri.authority !== folder.authority || !document.isDirty) return;
    const name = relative(document.uri);
    if (!dirty.has(name) && versions.has(name)) {
      dirty.set(name, versions.get(name));
      persistVersions();
    }
  }

  async function poll() {
    if (disposed || polling) return;
    polling = true;
    const changes = [];
    try {
      const opened = [...new Set(vscode.workspace.textDocuments
        .filter(document => document.uri.scheme === folder.scheme && document.uri.authority === folder.authority)
        .map(document => relative(document.uri)))].slice(0, 50);
      const watched = [...directories.keys()].slice(-20);
      for (const name of opened) {
        const old = metadata.get(name);
        if (!old) continue;
        try {
          const value = await request('stat', { path: name });
          if (value.version !== old.version) {
            update(name, value);
            const type = !value.version ? FileChangeType.Deleted : !old.version ? FileChangeType.Created : FileChangeType.Changed;
            changes.push({ type, uri: fileUri(name) });
          }
        } catch (error) {
          if (error.code === 'FileNotFound' && old.version) {
            update(name, {});
            changes.push({ type: FileChangeType.Deleted, uri: fileUri(name) });
          }
        }
      }
      for (const name of watched) {
        const old = directories.get(name);
        const child = item => fileUri(name ? name + '/' + item : item);
        try {
          const current = await listing(name);
          if (directories.get(name) !== old) continue;
          directories.set(name, current);
          for (const [item, kind] of old) {
            if (current.get(item) !== kind) changes.push({ type: FileChangeType.Deleted, uri: child(item) });
          }
          for (const [item, kind] of current) {
            if (old.get(item) !== kind) changes.push({ type: FileChangeType.Created, uri: child(item) });
          }
        } catch { /* The parent directory reports a removed child. */ }
      }
      if (changes.length && !disposed) emitter.fire(changes);
    } finally { polling = false; }
  }

  const provider = {
    onDidChangeFile: emitter.event,
    watch() { return new vscode.Disposable(() => {}); },
    async stat(uri) {
      const name = relative(uri);
      if (!name) return { type: FileType.Directory, size: 0, mtime: 0, ctime: 0 };
      const value = await request('stat', { path: name });
      if (!value.version || !['file', 'directory'].includes(value.type)) throw FsError.FileNotFound(uri);
      return update(name, value);
    },
    async readDirectory(uri) {
      const name = relative(uri);
      const entries = await listing(name);
      directories.delete(name);
      directories.set(name, entries);
      if (directories.size > 20) directories.delete(directories.keys().next().value);
      return [...entries];
    },
    async readFile(uri) {
      const name = relative(uri);
      const value = await request('read', { path: name, preserveBom: true });
      const bytes = encode.encode(value.text);
      const editing = vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.toString() === uri.toString());
      if (editing) readsDuringEdit.set(name, { version: value.version, text: editorText(value.text) });
      else versions.set(name, value.version);
      update(name, { ...value, type: 'file', bytes: bytes.length });
      return bytes;
    },
    async writeFile(uri, bytes, options) {
      const name = relative(uri);
      const version = options.overwrite ? dirty.get(name) || versions.get(name) : undefined;
      let text;
      try { text = decode.decode(bytes); } catch { throw FsError.Unavailable(copy.binary); }
      const result = await request('write', { path: name, text, version });
      versions.set(name, result.version);
      readsDuringEdit.delete(name);
      if (dirty.delete(name)) persistVersions();
      update(name, { type: 'file', bytes: bytes.length, version: result.version });
      emitter.fire([{ type: version ? FileChangeType.Changed : FileChangeType.Created, uri }]);
    },
    async createDirectory(uri) {
      await request('mkdir', { path: relative(uri) });
      emitter.fire([{ type: FileChangeType.Created, uri }]);
    },
    async delete(uri) {
      const name = relative(uri), info = await provider.stat(uri);
      if (info.type !== FileType.File || dirty.has(name)) throw FsError.NoPermissions(copy.folder);
      await request('delete', { path: name, version: info.version });
      metadata.delete(name);
      versions.delete(name);
      emitter.fire([{ type: FileChangeType.Deleted, uri }]);
    },
    async rename(from, to, options) {
      const name = relative(from), destination = relative(to), info = await provider.stat(from);
      if (info.type !== FileType.File || dirty.has(name) || dirty.has(destination)) throw FsError.NoPermissions(copy.folder);
      if (options.overwrite) {
        const current = await request('stat', { path: destination });
        if (current.version) throw FsError.FileExists(to);
      }
      await request('rename', { path: name, destination, version: info.version });
      metadata.delete(name);
      versions.delete(name);
      emitter.fire([{ type: FileChangeType.Deleted, uri: from }, { type: FileChangeType.Created, uri: to }]);
    },
  };
  context.subscriptions.push(
    emitter,
    vscode.workspace.registerFileSystemProvider(folder.scheme, provider, { isCaseSensitive: true }),
    vscode.workspace.onDidOpenTextDocument(trackDirty),
    vscode.workspace.onDidChangeTextDocument(event => {
      const { document } = event;
      if (document.uri.scheme !== folder.scheme || document.uri.authority !== folder.authority) return;
      if (document.isDirty) { trackDirty(document); return; }
      const name = relative(document.uri);
      const loaded = readsDuringEdit.get(name);
      // Revert can read the replacement while the current editor is still dirty.
      // Bind its version only when the clean editor actually contains that read.
      if (loaded?.text === editorText(document.getText())) versions.set(name, loaded.version);
      readsDuringEdit.delete(name);
      if (dirty.delete(name)) persistVersions();
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme !== folder.scheme || document.uri.authority !== folder.authority) return;
      const name = relative(document.uri);
      readsDuringEdit.delete(name);
      if (!document.isDirty && dirty.delete(name)) persistVersions();
    }),
  );
  const timer = setInterval(() => void poll(), 1200);
  context.subscriptions.push(new vscode.Disposable(() => { disposed = true; clearInterval(timer); }));
}

module.exports = { activate };
