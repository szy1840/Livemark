// One interface over two hosts:
//   - the native Mac shell (WKWebView + a message bridge), where paths are
//     real file-system paths;
//   - a plain browser, where files come from the File System Access API and
//     "paths" are virtual names mapped to file handles.
// The rest of the app only ever talks to `platform`.

const bridge = window.webkit?.messageHandlers?.livemark;
export const isNative = !!bridge;
const call = (cmd, args = {}) => bridge.postMessage({ cmd, args });

// --- events from the host --------------------------------------------------
const handlers = new Map();
export const on = (name, fn) => {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(fn);
};
const emit = (name, payload) => handlers.get(name)?.forEach((fn) => fn(payload || {}));
window.__livemark = { emit };

// --- path helpers (POSIX style; virtual browser paths use the same shape) ---
export const path = {
  dirname: (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '/' : ''),
  basename: (p) => p.slice(p.lastIndexOf('/') + 1),
  extname: (p) => {
    const b = p.slice(p.lastIndexOf('/') + 1);
    const k = b.lastIndexOf('.');
    return k > 0 ? b.slice(k).toLowerCase() : '';
  },
  stem: (p) => {
    const b = p.slice(p.lastIndexOf('/') + 1);
    const k = b.lastIndexOf('.');
    return k > 0 ? b.slice(0, k) : b;
  },
  join: (...parts) => path.normalize(parts.filter(Boolean).join('/')),
  normalize: (p) => {
    const abs = p.startsWith('/');
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop();
        else if (!abs) out.push('..');
      } else out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/');
  },
  resolve: (base, rel) => (rel.startsWith('/') ? path.normalize(rel) : path.join(base, rel)),
  relative: (from, to) => {
    const a = path.normalize(from).split('/').filter(Boolean);
    const b = path.normalize(to).split('/').filter(Boolean);
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    return [...a.slice(k).map(() => '..'), ...b.slice(k)].join('/') || '.';
  },
};

export const MD_EXT = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mmd', 'mdtext', 'mdtxt', 'txt', 'text', 'rmd', 'rmarkdown'];
export const isBundle = (name) => /\.textbundle\/?$/i.test(name || '');
// A TextPack is a zipped TextBundle.
export const isPack = (name) => /\.textpack$/i.test(name || '');
export const isMarkdownName = (name) => MD_EXT.includes(path.extname(name).slice(1).toLowerCase()) || isBundle(name) || isPack(name);
export const isImageName = (name) => /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i.test(name);

// --- browser implementation ------------------------------------------------
const handles = new Map(); // virtual path -> FileSystemHandle
let pickSeq = 0;
const hasFsApi = 'showOpenFilePicker' in window;
const types = (extensions) => [{ description: '文档', accept: { 'text/plain': (extensions || MD_EXT).map((e) => `.${e}`) } }];
const cancelled = (err) => err?.name === 'AbortError';

async function dirHandle(p) {
  const h = handles.get(p);
  if (h?.kind === 'directory') return h;
  throw new Error(`没有这个文件夹的访问权限：${p}`);
}

async function fileHandle(p, create = false) {
  const h = handles.get(p);
  if (h?.kind === 'file') return h;
  const dir = handles.get(path.dirname(p));
  if (dir?.kind === 'directory') {
    const fh = await dir.getFileHandle(path.basename(p), { create });
    handles.set(p, fh);
    return fh;
  }
  throw new Error(`没有这个文件的访问权限：${p}`);
}

const lsGet = (key) => {
  try {
    const v = localStorage.getItem(`livemark:${key}`);
    return v === null ? null : JSON.parse(v);
  } catch {
    return null;
  }
};
const lsSet = (key, value) => {
  try {
    localStorage.setItem(`livemark:${key}`, JSON.stringify(value));
  } catch {
    /* storage may be unavailable; the app works without it */
  }
  return true;
};

const browser = {
  async ready() {
    return { openPath: null, home: '', appSupport: '', documents: '', pandoc: null, version: 'web' };
  },
  async pickFile({ extensions } = {}) {
    if (!hasFsApi) {
      return new Promise((resolve) => {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: (extensions || MD_EXT).map((e) => `.${e}`).join(',') });
        input.onchange = () => {
          const file = input.files[0];
          if (!file) return resolve(null);
          const p = `/picked-${pickSeq++}/${file.name}`;
          handles.set(p, { kind: 'file', name: file.name, getFile: async () => file, readonly: true });
          return resolve(p);
        };
        input.click();
      });
    }
    try {
      const [h] = await window.showOpenFilePicker({ types: types(extensions) });
      const p = `/picked-${pickSeq++}/${h.name}`;
      handles.set(p, h);
      return p;
    } catch (err) {
      if (cancelled(err)) return null;
      throw err;
    }
  },
  async pickFolder() {
    if (!window.showDirectoryPicker) throw new Error('这个浏览器不支持打开文件夹，请使用 Chrome 或 Mac 应用。');
    try {
      const h = await window.showDirectoryPicker({ mode: 'readwrite' });
      const p = `/${h.name}`;
      handles.set(p, h);
      return p;
    } catch (err) {
      if (cancelled(err)) return null;
      throw err;
    }
  },
  async pickSave({ suggestedName, extensions } = {}) {
    if (!window.showSaveFilePicker) return `/download/${suggestedName || '未命名.md'}`;
    try {
      const h = await window.showSaveFilePicker({ suggestedName, types: types(extensions) });
      const p = `/picked-${pickSeq++}/${h.name}`;
      handles.set(p, h);
      return p;
    } catch (err) {
      if (cancelled(err)) return null;
      throw err;
    }
  },
  async readText(p, encoding) {
    const file = await (await fileHandle(p)).getFile();
    const text = encoding ? new TextDecoder(encoding).decode(await file.arrayBuffer()) : await file.text();
    return { text, mtime: file.lastModified };
  },
  async writeBlob(p, blob) {
    if (p.startsWith('/download/')) {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: path.basename(p) });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return { mtime: Date.now() };
    }
    const h = await fileHandle(p, true);
    if (h.readonly) throw new Error('这个文件是只读打开的，请用“另存为”。');
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    return { mtime: Date.now() };
  },
  writeText(p, text) {
    return browser.writeBlob(p, new Blob([text], { type: 'text/plain' }));
  },
  async writeBase64(p, base64) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return browser.writeBlob(p, new Blob([bytes]));
  },
  async list(p) {
    const dir = await dirHandle(p);
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue;
      const child = `${p}/${name}`;
      handles.set(child, h);
      let mtime = 0;
      let size = 0;
      if (h.kind === 'file' && (isMarkdownName(name) || isImageName(name))) {
        const f = await h.getFile();
        mtime = f.lastModified;
        size = f.size;
      }
      out.push({ name, path: child, isDir: h.kind === 'directory', mtime, size });
    }
    return out;
  },
  async stat(p) {
    try {
      const h = handles.get(p) || (await fileHandle(p));
      if (h.kind === 'directory') return { exists: true, isDir: true, mtime: 0, size: 0 };
      const f = await h.getFile();
      return { exists: true, isDir: false, mtime: f.lastModified, size: f.size };
    } catch {
      return { exists: false, isDir: false, mtime: 0, size: 0 };
    }
  },
  async mkdir(p) {
    const parent = await dirHandle(path.dirname(p));
    handles.set(p, await parent.getDirectoryHandle(path.basename(p), { create: true }));
    return true;
  },
  async rename(from, to) {
    const h = handles.get(from) || (await fileHandle(from));
    if (!h.move) throw new Error('这个浏览器不支持重命名。');
    if (path.dirname(from) === path.dirname(to)) await h.move(path.basename(to));
    else await h.move(await dirHandle(path.dirname(to)), path.basename(to));
    handles.delete(from);
    handles.set(to, h);
    return true;
  },
  async copy(from, to) {
    const file = await (await fileHandle(from)).getFile();
    await browser.writeBlob(to, file);
    return true;
  },
  async trash(p) {
    // Browsers have no Trash: this deletes for good, so callers confirm first.
    const parent = await dirHandle(path.dirname(p));
    await parent.removeEntry(path.basename(p), { recursive: true });
    handles.delete(p);
    return true;
  },
  async reveal() {
    return false;
  },
  async openExternal(url) {
    window.open(url, '_blank', 'noopener');
    return true;
  },
  async clipboardWrite({ text, html }) {
    if (html && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text || ''], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
    } else await navigator.clipboard.writeText(text || '');
    return true;
  },
  async clipboardRead() {
    return { text: await navigator.clipboard.readText(), html: null, imagePngBase64: null, filePaths: [] };
  },
  async storeGet(key) {
    return lsGet(key);
  },
  async storeSet(key, value) {
    return lsSet(key, value);
  },
  async storeKeys(prefix = '') {
    const out = [];
    try {
      for (let k = 0; k < localStorage.length; k++) {
        const key = localStorage.key(k);
        if (key?.startsWith(`livemark:${prefix}`)) out.push(key.slice('livemark:'.length));
      }
    } catch {
      /* storage unavailable */
    }
    return out.sort();
  },
  async watchFolder() {
    /* the browser build has no file watching */
  },
  async watchFile() {},
  setTitle({ title }) {
    document.title = title;
  },
  newWindow() {
    window.open(location.href, '_blank');
  },
  closeWindow() {
    window.close();
  },
  startDrag() {},
  titlebarDoubleClick() {},
  setAlwaysOnTop() {},
  toggleFullScreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  },
  setMenu() {},
  updateMenu() {},
  popupMenu: null,
  message: null,
  messageWithCheckbox: null,
  startFileDrag: null,
  previewFile: null,
  applicationsForFile: null,
  setChrome: null,
  keyboardLayout: null,
  openWithApplication: null,
  async print() {
    window.print();
    return true;
  },
  exportPdf: null,
  exportImage: null,
  pandoc: null,
  newTab: null,
  closeAll: null,
  share: null,
  pageSetup: null,
  upload: null,
  clipboardWriteImage: null,
  pickFiles: null,
  pickDocsOrFolders: null,
  quickLook: null,
  download: null,
  setWindowStyle: null,
  setZoom: null,
  speak: (text) => { try { speechSynthesis.cancel(); if (text) speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch { /* no speech in this browser */ } },
  stopSpeaking: () => { try { speechSynthesis.cancel(); } catch { /* nothing to stop */ } },
  setMagnification: null,
  commandAll: null,
  touchBar: null,
  spellInfo: null,
  spellCheck: null,
  spellLearn: null,
  spellUnlearn: null,
  systemQuotes: null,
  imageScale: null,
  clipboardSnapshot: null,
  archiveUnpack: null,
  archivePack: null,
  spellSetLanguage: null,
  // Local images can only be shown through object URLs here.
  fileUrl: () => null,
  async blobUrl(p) {
    const file = await (await fileHandle(p)).getFile();
    return URL.createObjectURL(file);
  },
};

// --- native implementation -------------------------------------------------
const native = {
  ready: () => call('app.ready'),
  pickFile: async ({ extensions, directory, formats, formatLabels } = {}) => (await call('dialog.openFile', { extensions: extensions || [...MD_EXT, 'textbundle', 'textpack'], directory, formats, formatLabels }))[0] || null,
  pickFolder: () => call('dialog.openFolder'),
  pickSave: (args = {}) => call('dialog.save', args),
  readText: (p, encoding) => call('fs.readText', encoding ? { path: p, encoding } : { path: p }),
  writeText: (p, text) => call('fs.writeText', { path: p, text }),
  writeBase64: (p, base64) => call('fs.writeBase64', { path: p, base64 }),
  list: (p, opts = {}) => call('fs.list', { path: p, ...opts }),
  stat: (p) => call('fs.stat', { path: p }),
  mkdir: (p) => call('fs.mkdir', { path: p }),
  rename: (from, to) => call('fs.rename', { from, to }),
  copy: (from, to) => call('fs.copy', { from, to }),
  trash: (p) => call('fs.trash', { path: p }),
  removePermanently: (p) => call('fs.removePermanently', { path: p }),
  reveal: (p) => call('fs.reveal', { path: p }),
  startFileDrag: (p) => call('fs.startDrag', { path: p }),
  openExternal: (url) => (/^(https?:|mailto:)/i.test(url) ? call('shell.openExternal', { url }) : call('shell.openPath', { path: url })),
  openURL: (url) => call('shell.openURL', { url }),
  clipboardWrite: (data) => call('clipboard.write', data),
  clipboardRead: () => call('clipboard.read'),
  storeGet: (key) => call('store.get', { key }),
  storeKeys: (prefix = '') => call('store.keys', { prefix }),
  watchFolder: (p) => call('fs.watch', { path: p || null }),
  watchFile: (p) => call('fs.watchFile', { path: p || null }),
  storeSet: (key, value) => call('store.set', { key, value }),
  setTitle: (args) => call('window.setTitle', args),
  newWindow: (p = null) => call('window.new', { path: p }),
  focusWindow: () => call('window.focus'),
  noteRecent: (p) => call('app.noteRecent', { path: p }),
  fileVersions: (p) => call('fs.versions', { path: p }),
  showInfo: (p) => call('fs.showInfo', { path: p }),
  lookUp: (args) => call('text.lookUp', args),
  pandocCancel: () => call('pandoc.cancel'),
  focusPath: (p) => call('window.focusPath', { path: p }),
  newTab: (p = null) => call('window.newTab', { path: p }),
  closeAll: () => call('window.closeAll'),
  share: (args) => call('share.show', args),
  pageSetup: () => call('export.pageSetup'),
  upload: (command, files) => call('uploader.run', { command, files }),
  clipboardWriteImage: (p) => call('clipboard.writeImage', { path: p }),
  pickFiles: ({ extensions, directory } = {}) => call('dialog.openFile', { extensions: extensions || MD_EXT, directory, multiple: true }),
  // File → Open…: documents and folders, several at once.
  pickDocsOrFolders: ({ formats, formatLabels } = {}) => call('dialog.openFile', { extensions: [...MD_EXT, 'textbundle', 'textpack'], multiple: true, folders: true, formats, formatLabels }),
  quickLook: (p) => call('file.quickLook', { path: p }),
  download: (url, p) => call('net.download', { url, path: p }),
  setWindowStyle: (style) => call('window.setStyle', { style }),
  setZoom: (zoom) => call('window.setZoom', { zoom }),
  speak: (text) => call('speech.start', { text }),
  stopSpeaking: () => call('speech.stop'),
  setMagnification: (allow) => call('window.setMagnification', { on: allow }),
  commandAll: (id) => call('window.commandAll', { id }),
  touchBar: (mode, state = {}) => call('touchbar.set', { mode, state }),
  spellInfo: () => call('spell.info'),
  spellCheck: (word) => call('spell.check', { word }),
  spellLearn: (word) => call('spell.learn', { word }),
  spellUnlearn: (word) => call('spell.unlearn', { word }),
  systemQuotes: () => call('system.quotes'),
  imageScale: (url) => call('image.scale', { url }),
  clipboardSnapshot: (rect) => call('clipboard.writeSnapshot', rect),
  archiveUnpack: (p, to) => call('archive.unpack', { path: p, to }),
  archivePack: (dir, to) => call('archive.pack', { path: dir, to }),
  spellSetLanguage: (language) => call('spell.setLanguage', { language }),
  closeWindow: () => call('window.close', { force: true }),
  startDrag: () => call('window.startDrag'),
  titlebarDoubleClick: () => call('window.titlebarDoubleClick'),
  setAlwaysOnTop: (onTop) => call('window.setAlwaysOnTop', { on: onTop }),
  toggleFullScreen: () => call('window.toggleFullScreen'),
  setMenu: (menus) => call('menu.set', { menus }),
  updateMenu: (items) => call('menu.update', { items }),
  popupMenu: async (items, x, y) => (await call('menu.popup', { items, x, y })).id,
  message: async (args) => (await call('dialog.message', args)).index,
  messageWithCheckbox: (args) => call('dialog.message', args),
  previewFile: (p) => call('shell.quickLook', { path: p }),
  applicationsForFile: (p) => call('shell.applicationsForFile', { path: p }),
  setChrome: (state) => call('window.setChrome', state),
  keyboardLayout: () => call('system.keyboardLayout'),
  openWithApplication: (p, app) => call('shell.openWithApplication', { path: p, app }),
  print: (args = {}) => call('export.print', args),
  exportPdf: (args) => call('export.pdf', args),
  snapshot: (args) => call('export.snapshot', args),
  exportImage: (args) => call('export.image', args),
  pandoc: (args, stdin, cwd) => call('pandoc.run', { args, stdin, cwd }),
  fileUrl: (p) => `livemark://fs/${encodeURIComponent(p)}`,
  blobUrl: async (p) => `livemark://fs/${encodeURIComponent(p)}`,
};

export const platform = isNative ? native : browser;
export const canPickFolder = isNative || !!window.showDirectoryPicker;
