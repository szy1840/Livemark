// The application: document lifecycle, files, images, export, view modes,
// and the wiring between editor, sidebar, finder and menus.

import { Editor, leafText, features, cols as tableCols, isDiagram } from './editor.js';
import { plainOf } from './editor-ops.js';
import { inlineCtx } from './inline.js';
import { initRich, onRichReady, languageList, refreshDiagramTheme, mathOptions, loadScript, highlight } from './rich.js';
import { platform, isNative, on, path, isMarkdownName, isImageName, isBundle, isPack, MD_EXT } from './platform.js';
import { settings, loadSettings, set as setPref, onSettings, addRecent, openPreferences, THEMES, uploaderCommand, IMAGE_FOLDERS, resetSettings } from './prefs.js';
import { $, h, modal, ask, prompt, toast, debounce, popover, showMenu, closeMenus, contextMenu } from './ui.js';
import { t, lang, langPref, setLang } from './i18n.js';
import { Finder } from './find.js';
import { Sidebar, quickOpen } from './sidebar.js';
import { createCommands } from './menus.js';
import { configOf, exportEntries, pandocOptions, PANDOC_TARGET } from './export-config.js';
import { standaloneHtml, clipboardHtml, htmlToMarkdown, markdownToHtml, convertOptions } from './convert.js';
import { blockText, slugify, parseMarkdown, mdOptions, numberLists, serialize, sourceRanges, uid, findAnchor } from './markdown.js';
import { installEmojiComplete } from './complete.js';
import { createToolbar } from './toolbar.js';

const els = {
  app: $('#app'),
  write: $('#write'),
  source: $('#source'),
  scroller: $('#scroller'),
  title: $('#doc-title'),
  dirty: $('#dirty'),
  titlebar: $('#titlebar'),
  toolbar: $('#toolbar'),
  menubar: $('#menubar'),
  sidebarBtn: $('#btn-sidebar'),
  sourceBtn: $('#btn-source'),
  words: $('#wordcount'),
  modes: $('#modes'),
};

const untitled = () => t('未命名.md').replace(/\.md$/, `.${settings.defaultExt === 'textbundle' ? 'md' : settings.defaultExt}`);
const UNTITLED = t('未命名.md');
// `path` is what the user sees and picks (for a TextBundle, the bundle);
// `file` is the text file that is actually read and written.
// crlf / finalNewline: the open file's own line endings and final newline (Edit → Line Endings).
const doc = { path: null, file: null, name: UNTITLED, saved: '', mtime: 0, dirty: false, crlf: false, finalNewline: true, eolChanged: false };
let keymap = {};
let spellLangs = [];
let info = { pandoc: null, appSupport: '' };
let sourceMode = false;
let sidebarBeforeSource = false;
let stats = { words: 0, chars: 0, charsNoSpace: 0, lines: 0 };
let caretBlock = 0;
let headings = [];
let docEncoding = 'auto';
let lastExport = null;

// --- image paths --------------------------------------------------------------

const blobCache = new Map();
const safeDecode = (s) => {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
};
// Absolute file-system path for a local image reference, or null.
// The folder relative references in the document are resolved against.
const docDir = () => (doc.path ? (isBundle(doc.path) ? doc.path : path.dirname(doc.path)) : null);

// "key: value" pairs of the YAML front matter (flat keys are all we read).
let fmCache = ['', {}];
function frontMatter() {
  const meta = editor.doc[0]?.type === 'meta' ? editor.doc[0].text : '';
  if (fmCache[0] !== meta) {
    const out = {};
    const parents = [];
    for (const line of meta.split('\n')) {
      const m = /^(\s*)([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const depth = m[1].length;
      while (parents.length && parents[parents.length - 1].depth >= depth) parents.pop();
      const key = [...parents.map((x) => x.key), m[2]].join('.');
      if (m[3] === '') parents.push({ depth, key: m[2] });
      else {
        const value = m[3].replace(/^(["'])(.*)\1$/, '$2');
        if (!depth) out[m[2]] = value;
        out[key] = value;
      }
    }
    fmCache = [meta, out];
  }
  return fmCache[1];
}
// Set or remove one key of the front matter, creating the block if needed.
function setFrontMatter(key, value) {
  const has = editor.doc[0]?.type === 'meta';
  const lines = has ? editor.doc[0].text.split('\n') : [];
  const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (value == null) {
    if (at < 0) return;
    lines.splice(at, 1);
  } else if (at >= 0) lines[at] = `${key}: ${value}`;
  else lines.push(`${key}: ${value}`);
  const text = lines.filter((l, k) => l.trim() || k < lines.length - 1).join('\n');
  const sel = editor.sel();
  let next;
  if (has) next = text.trim() ? [{ ...editor.doc[0], text }, ...editor.doc.slice(1)] : editor.doc.slice(1);
  else next = [{ id: `meta${Date.now().toString(36)}`, q: 0, indent: 0, type: 'meta', text }, ...editor.doc];
  const shift = next.length - editor.doc.length;
  const move = (pos) => ({ ...pos, i: Math.max(0, pos.i + shift) });
  editor.apply(next, sel ? { anchor: move(sel.anchor), focus: move(sel.focus) } : { i: 0, leaf: 0, off: 0 });
}

// `typora-root-url` in the front matter: the base that image paths are
// resolved against, as other Markdown editors read it.
function imageRoot() {
  const root = frontMatter()['typora-root-url'];
  if (!root) return null;
  const p = safeDecode(root.replace(/^file:\/\//, ''));
  return p.startsWith('/') ? p : docDir() ? path.resolve(docDir(), p) : null;
}

function localPath(url) {
  if (!url || /^(https?:|data:|blob:|livemark:|mailto:|#)/i.test(url)) return null;
  // Another scheme is not a path (a one-letter "scheme" is a Windows drive).
  if (/^[a-z][a-z0-9+.-]+:/i.test(url) && !/^file:/i.test(url)) return null;
  const p = safeDecode(url.startsWith('file://') ? url.slice(7) : url);
  const root = imageRoot();
  if (root) return path.join(root, p);
  if (p.startsWith('/')) return p;
  return docDir() ? path.resolve(docDir(), p) : null;
}
const rerenderSoon = debounce(() => editor.rerenderAll(), 150);
inlineCtx.imageButtons = { url: t('input image URL'), file: t('Select image from local file') };
inlineCtx.refHints = { image: t('Please define image reference by \n[{0}]: http://example.png') };
inlineCtx.resolveSrc = (url) => {
  const p = localPath(url);
  if (!p) return url;
  if (isNative) return platform.fileUrl(p);
  if (blobCache.get(p)) return blobCache.get(p);
  if (!blobCache.has(p)) {
    blobCache.set(p, null);
    platform.blobUrl(p).then((u) => {
      blobCache.set(p, u);
      rerenderSoon();
    }, () => {});
  }
  return url;
};

// --- editor ---------------------------------------------------------------------

const editor = new Editor(els.write, els.scroller, {
  onChange,
  onResizeTable: () => insertTableDialog(true),
  onSelection,
  onContextMenu: (e, ctx) => commands.editorContextMenu(e, ctx),
  toHtml: clipboardHtml,
  // With "copy Markdown source as plain text" off, plain-text pastes get
  // the readable text instead of the source.
  toPlain: (md) => (settings.copyPlainSource ? md : plainText(md)),
  fromHtml: htmlToMarkdown,
  onPasteText: (text, html) => pasteOnlineImage(text, html) || (!html && pasteUrlWithTitle(text)),
  onCopied: (md) => {
    try {
      localStorage.setItem('livemark:copyOrigin', JSON.stringify({ text: md, dir: docDir() || '' }));
    } catch {
      /* storage unavailable */
    }
  },
  transformPaste: (text) => rebasePastedImages(text),
  onPasted: (text) => applyRulesToPastedImages(text),
  onImageFiles: (files, how) => handleImageFiles(files, how),
  onOpenLink: (href) => openLink(href),
  onImageOpen: (img) => openLink(img.getAttribute('src')),
  onImageLoaded: (img) => afterImageLoaded(img),
  onPickImages: () => insertImageFromFile(true),
  onNotify: (html) => toast(Object.assign(document.createElement('div'), { innerHTML: html }).textContent, 4000),
  onLinkHint: () => showHint({ key: 'noHintForOpenLink', ticked: true, title: t('You can press <strong>⌘ + Click</strong> to open <a href="#">links</a> or jump to footnote definition.') }),
  onLinkModifierUsed: () => !settings.dismissed.noHintForOpenLink && setPref({ dismissed: { ...settings.dismissed, noHintForOpenLink: true } }),
  labels: { imageFailed: t('Image load failed'), imageLoading: t('Image is loading…'), edit: t('Edit'), finishEditing: t('Finish Editing'), mathPlaceholder: t('Input Math TeX here'), backToDocument: t('back to document'), undefinedLink: t('Need to define the reference link <b>[{0}]</b> with syntax <b>[{1}]: www.example.com</b>'), undefinedFootnote: t('Need to define the reference footnote <b>{0}</b> with syntax <a>[^{1}]: www.example.com</a>') },
});

const finder = new Finder({ editor, host: $('#find-host'), source: els.source, scroller: els.scroller, isSourceMode: () => sourceMode, opts: settings.findOpts, onOpts: (findOpts) => { setPref({ findOpts }); syncTouchBar(); } });
// Find Next with the panel closed starts from the selection.
finder.seedText = () => (sourceMode ? els.source.value.slice(els.source.selectionStart, els.source.selectionEnd) : plainSelection());
// Hits in Source Code Mode: a copy of the text laid out exactly like the text area,
// behind it, with the matches marked.
const sourceMarks = h('div', { id: 'source-marks', 'aria-hidden': 'true', hidden: true });
els.scroller.prepend(sourceMarks);
finder.onSourceMarks = (matches, index) => {
  const ta = els.source;
  if (!matches.length || ta.hidden) {
    sourceMarks.hidden = true;
    return;
  }
  const cs = getComputedStyle(ta);
  Object.assign(sourceMarks.style, { left: `${ta.offsetLeft}px`, top: `${ta.offsetTop}px`, width: `${ta.offsetWidth}px`, padding: cs.padding, font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, tabSize: cs.tabSize, boxSizing: cs.boxSizing, borderWidth: cs.borderWidth });
  const v = ta.value;
  const parts = [];
  let at = 0;
  matches.forEach((m, k) => {
    parts.push(document.createTextNode(v.slice(at, m.from)), h('mark', { class: k === index ? 'current' : '' }, v.slice(m.from, m.to)));
    at = m.to;
  });
  parts.push(document.createTextNode(`${v.slice(at)}\n`));
  sourceMarks.replaceChildren(...parts);
  sourceMarks.hidden = false;
};
// Typing in the source closes the panel (its hits would be stale).
els.source.addEventListener('input', () => {
  if (finder.isOpen && !finder.replacing) finder.close({ keepCaret: true });
});

// Going back to the document closes the find panel: a click in the text (the caret
// goes where clicked) or Esc outside the panel.
for (const host of [els.write, els.source]) {
  host.addEventListener('mousedown', () => {
    if (finder.isOpen) finder.close({ keepCaret: true });
  }, true);
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !finder.isOpen || e.isComposing) return;
  if ($('#find-host')?.contains(e.target) || document.querySelector('.overlay, .popover')) return;
  e.preventDefault();
  finder.close();
});
// The find bar coming and going (and its replace row) switches the Touch Bar.
for (const name of ['open', 'close', 'setReplace']) {
  const fn = finder[name].bind(finder);
  finder[name] = (...args) => {
    const out = fn(...args);
    syncTouchBar();
    return out;
  };
}

const app = {
  editor,
  currentPath: () => doc.path,
  sourceMode: () => sourceMode,
  hasPandoc: () => !!info.pandoc,
  activeTheme,
  newDoc,
  newWindow: () => platform.newWindow(),
  openDialog,
  openPath,
  openFolder,
  quickOpen: () => quickOpen({ sidebar, recent: settings.recent, folders: [...settings.pinned, ...(settings.recentFolders || []).filter((p) => !settings.pinned.includes(p))], onPick: (p) => openPath(p), onPickFolder: (p) => openFolder(p) }),
  clearRecent: () => {
    setPref({ recent: [], recentFolders: [] });
    closedFiles = [];
    platform.storeSet('closed', []);
    commands.pushNativeMenu();
  },
  save,
  saveAs,
  saveCopy,
  renameFile,
  moveFile,
  reloadFromDisk,
  browseVersions,
  importFile,
  exportAs,
  print: printDoc,
  revealFile: () => doc.path && platform.reveal(doc.path),
  properties,
  preferences: (section) => openPreferences(section, {
    clearRecent: () => app.clearRecent(),
    clearPinned: () => {
      setPref({ pinned: [] });
      app.clearRecent();
      sidebar.refresh();
    },
    recoverDrafts: () => browseVersions(),
    testUploader,
    openThemes: () => app.openThemesFolder(),
    shortcutKeys: () => openHelp('docs/shortcuts.md'),
    openAdvanced: () => openAdvanced(false),
    resetAdvanced: () => openAdvanced(true),
    exitModes: () => {
      setPref({ focusMode: false, typewriter: false });
      $('#hint-bar')?.classList.remove('show');
      ask({ message: t('Typewriter / Focus Mode have been turned off.'), buttons: [t('OK')] });
    },
    uploaderDownload: () => platform.openExternal({ upic: 'https://github.com/gee1k/uPic', 'picgo-app': 'https://github.com/Molunerfinn/PicGo', piclist: 'https://github.com/Kuingsmile/PicList' }[settings.uploader]),
    uploaderHelp: () => openHelp('docs/images.md'),
    learnMore: (docPath) => openHelp(docPath),
    resetDialogs: () => {
      setPref({ dismissed: {} });
      toast(t('Dialog warnings have been reset.'));
    },
  }, { spellLangs }),
  newTab: () => platform.newTab?.(),
  closeAll: () => platform.closeAll?.(),
  share: () => platform.share?.(doc.path ? { path: doc.path } : { text: currentText() }),
  pageSetup: () => platform.pageSetup?.(),
  deleteFile,
  revealInSidebar,
  reopenWithEncoding,
  encoding: () => docEncoding,
  // Export with Previous: the same entry, the save panel starting at the last file.
  exportAgain: () => lastExport && exportAs(lastExport.key, { start: lastExport.target }),
  // Export and Overwrite with Previous: write over the last file after a warning.
  exportOverwrite: async () => {
    const last = await previousExport();
    if (!last) return;
    lastExport = last;
    if (!settings.dismissed.noWarningForExportOverwrite) {
      const message = t('"Export and Overwrite with Previous" will overwrite file at %@, would you continue?').replace('%@', lastExport.target);
      const res = platform.messageWithCheckbox
        ? await platform.messageWithCheckbox({ message, buttons: [t('Continue'), t('Cancel')], cancel: 1, style: 'warning', checkbox: t('Do not show this again') }).catch(() => null)
        : { index: await ask({ message, buttons: [t('Continue'), t('Cancel')], style: 'warning' }), checked: false };
      if (!res || res.index !== 0) return;
      if (res.checked) setPref({ dismissed: { ...settings.dismissed, noWarningForExportOverwrite: true } });
    }
    return exportAs(lastExport.key, { reuse: lastExport.target });
  },
  exportEntries: () => exportEntries(settings),
  canExportAgain: () => !!lastExport || !!exportMemory[doc.path || ''],
  prettifyTable,
  setImageSyntax: (html) => {
    const img = editor.imageAtCaret();
    if (img && img.isHtml !== html) editor.switchImageSyntax();
  },
  canUpload: () => isNative && !!uploaderCommand(),
  keymap: () => keymap,
  isDirty: () => doc.dirty,
  reopenClosed,
  canReopenClosed: () => closedFiles.some((p) => p !== doc.path),
  saveAll: () => platform.commandAll?.('save'),
  revertToSaved,
  localImageAtCaret: () => !!localImageAtCaret(),
  imageRatio: (imgEl) => imageRatio(imgEl),
  imageFolderName: (pic) => imageFolderName(pic),
  isLocalImage: (src) => !!localPath(src),
  copyImageToTarget: (move) => copyImageToTarget(move),
  hasFile: () => !!doc.path,
  suggestedFileName: () => suggestedFileName(),
  deleteImageFile,
  relocateImage,
  docImageAction: () => imageTarget().mode,
  setDocImageAction,
  imageRoot: () => frontMatter()['typora-root-url'] || '',
  setImageRoot,
  defaultCodeLang: (via) => ((via === 'menu' ? settings.defaultLangOnMenu : settings.defaultLangOnMd) ? settings.defaultCodeLang : ''),
  exportCustom,
  uploadImage,
  requireUploader,
  uploadAllImages,
  copyImageContent,
  copyBlockImage,
  // Copy as Image on inline math: a picture of the formula clicked.
  copyInlineMathImage: async (target) => {
    const view = target?.closest?.('.math-view') || target?.closest?.('.tok[data-t="math"]')?.querySelector('.math-view');
    if (!view || !platform.clipboardSnapshot) return;
    const r = view.getBoundingClientRect();
    await platform.clipboardSnapshot({ x: r.left - 2, y: r.top - 2, width: r.width + 4, height: r.height + 4 }).then(() => toast(t('已复制')), (err) => toast(t('无法复制：{0}', err.message || err)));
  },
  // Insert Image: a picture address on the clipboard is filled in.
  insertImageFromClipboard: async () => {
    const clip = isNative ? await platform.clipboardRead().catch(() => null) : null;
    const text = (clip?.url || clip?.text || '').trim();
    const isPic = /^(https?:\/\/|file:\/\/|\/|\.{1,2}\/)\S+\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?|heic)(\?\S*)?$/i.test(text);
    editor.insertImage(isPic ? text : '');
  },
  // Hyperlink: an address on the clipboard is filled in.
  insertLinkFromClipboard: async () => {
    const clip = isNative ? await platform.clipboardRead().catch(() => null) : null;
    const text = (clip?.url || clip?.text || '').trim();
    editor.insertLink(/^(https?:\/\/|mailto:|www\.)\S+$/i.test(text) ? text : '');
  },
  saveMediaAs,
  saveBlockImage,
  learnWord,
  formatCode,
  canFormat: (b) => !!parserFor(b?.lang),
  // One block (a table, say) as Markdown and as rich text.
  copyBlock: async (block) => {
    const md = serialize([block]);
    await platform.clipboardWrite({ text: md, html: clipboardHtml(md) });
    toast(t('已复制'));
  },
  // MathML as rich text, or (for Word) as plain text only, which Word turns into an equation.
  copyMathML: async (tex, forWord = false) => {
    try {
      const html = window.katex.renderToString(tex, { throwOnError: false, output: 'mathml', displayMode: true });
      const mathml = /<math[\s\S]*<\/math>/.exec(html)?.[0] || '';
      await platform.clipboardWrite(forWord ? { text: mathml } : { text: mathml, html: mathml });
      toast(t('已复制'));
    } catch (err) {
      toast(t('导出失败：{0}', err.message || err), 4000);
    }
  },
  replaceNext: () => {
    if (!finder.isOpen) finder.open({ replace: true, seed: plainSelection() });
    else finder.replaceOne();
  },
  outlinePopover,
  searchWeb: () => {
    const q = plainSelection();
    if (q) platform.openExternal(`https://www.google.com/search?q=${encodeURIComponent(q)}`);
  },
  copyText,
  copyTable,
  undo: () => historyStep('undo'),
  canUndo: () => (sourceMode ? document.queryCommandEnabled?.('undo') ?? true : editor.hIndex > 0),
  canRedo: () => (sourceMode ? document.queryCommandEnabled?.('redo') ?? true : editor.hIndex < editor.history.length - 1),
  selectAll: () => selectAllScoped(),
  homeDir: () => info.home || '',
  keyboardLayout: () => editor.opts.keyboardLayout || '',
  focusDocument: () => (sourceMode ? els.source.focus() : editor.lastSel ? editor.setSel(editor.lastSel.focus) : editor.focus()),
  redo: () => historyStep('redo'),
  previewFile,
  copyAs,
  cut,
  pastePlain,
  pasteFromClipboard,
  // Code Tools → Copy Code Content: the code, and the same code as an HTML <pre>.
  copyCode: () => {
    const b = editor.currentBlock()?.b;
    if (!b) return null;
    return platform.clipboardWrite({ text: b.text || '', html: `<pre lang="${escHtml(b.lang || '')}">${escHtml(b.text || '')}</pre>` }).then(() => toast(t('已复制')), (err) => toast(t('无法复制：{0}', err.message || err)));
  },
  find: (replace) => finder.open({ replace, seed: sourceMode ? els.source.value.slice(els.source.selectionStart, els.source.selectionEnd) : plainSelection() }),
  findStep: (dir) => finder.step(dir),
  toggleSource,
  toggleReadOnly: () => setReadOnlyMode(!editor.readOnly),
  readOnlyForced: () => !!doc.lockedReason,
  // Edit → Line Endings: the current file's line endings and final newline; the change
  // needs a save, like any edit.
  // Edit → Speech: the selection, or the whole document when nothing is selected.
  speak: () => {
    let text;
    if (sourceMode) text = els.source.value.slice(els.source.selectionStart, els.source.selectionEnd) || els.source.value;
    else {
      const sel = editor.sel();
      text = sel && !sel.collapsed ? plainOf(editor.rangeMarkdown(sel)) : editor.doc.map((b) => plainOf(blockText(b))).filter(Boolean).join('\n');
    }
    platform.speak(text);
  },
  stopSpeaking: () => platform.stopSpeaking(),
  lineEnding: () => (doc.crlf ? 'crlf' : 'lf'),
  setLineEnding: (crlf) => {
    if (doc.crlf === crlf) return;
    doc.crlf = crlf;
    doc.eolChanged = !doc.eolChanged;
    setDirty(true);
  },
  finalNewline: () => doc.finalNewline,
  // An undo step of its own (the text itself does not change).
  toggleFinalNewline: () => {
    const flip = () => {
      doc.finalNewline = !doc.finalNewline;
      setDirty(true);
      commands.syncState();
    };
    flip();
    if (!sourceMode) {
      editor.record('option', true);
      editor.attachEffect({ undo: flip, redo: flip });
    }
  },
  toggleSetting: (key) => {
    setPref({ [key]: !settings[key] });
    // Turning on Focus or Typewriter Mode says so, with a way to silence it;
    // turning it off takes the notice away.
    const mode = { focusMode: ['noWarnigForFocusMode', 'Focus Mode'], typewriter: ['noWarnigForTypeWriterMode', 'Typewriter Mode'] }[key];
    if (!mode) return;
    if (settings[key]) {
      showHint({ key: mode[0], title: t('<strong>%@</strong> has been turned on.').replace('%@', t(mode[1])), body: t('You could turn it off from `View` menu.') });
    } else $('#hint-bar')?.classList.remove('show');
  },
  setSetting: (patch) => setPref(patch),
  showSidebar: (tab, { toggle = false } = {}) => {
    // View → Outline / Articles / File Tree on the panel already showing hides the sidebar.
    if (toggle && settings.sidebar && sidebar.tab === tab) return setPref({ sidebar: false });
    setPref({ sidebar: true, sidebarTab: tab });
    sidebar.setTab(tab);
  },
  // Outline out of the sidebar into the floating panel, and back (its pin button).
  unpinOutline: () => {
    setPref({ sidebar: false });
    outlinePopover();
  },
  wordCountPopover,
  zoom: (dir) => {
    setPref({ zoom: dir === 0 ? 1 : Math.max(0.6, Math.min(2.4, Math.round((settings.zoom + dir * 0.1) * 10) / 10)) });
    showZoomHint();
  },
  insertTableDialog,
  insertImageFromFile,
  revealImage,
  collectImages,
  openLink,
  openLinkAtCaret: () => {
    const href = linkAtCaret();
    if (href) openLink(href);
  },
  copyLinkAtCaret: () => {
    const href = linkAtCaret();
    if (href) copyText(href);
  },
  openHelp,
  about,
  openThemesFolder: async () => {
    const dir = await themesDir();
    if (dir) platform.reveal(path.join(dir, 'my-theme.css'));
  },
  jumpToBlock: (i) => {
    if (sourceMode) toggleSource();
    editor.focusBlock(i);
  },
  // From the outline: bring the heading to the top, leave the caret alone.
  jumpToHeading: (i) => {
    if (sourceMode) toggleSource();
    const el = els.write.children[i];
    if (!el) return;
    els.scroller.scrollTo({ top: els.scroller.scrollTop + el.getBoundingClientRect().top - els.scroller.getBoundingClientRect().top - 10, behavior: 'smooth' });
    editor.focus();
  },
  sidebarTab: () => (settings.sidebar ? sidebar.tab : null),
  selectedText: () => (sourceMode ? els.source.value.slice(els.source.selectionStart, els.source.selectionEnd) : window.getSelection().toString()),
  isDiscardable: () => !doc.path && !doc.dirty && !editor.getMarkdown().trim(),
  // The open file was deleted from the sidebar: what it held is gone with it, so the
  // next file replaces it without asking.
  openAfterDelete: async (p) => {
    doc.dirty = false;
    clearDraft();
    return openPath(p);
  },
  pathMoved: async (from, to) => {
    // Recent files and folders follow the rename (a folder's contents too).
    const remap = (list) => (list || []).map((p) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p));
    setPref({ recent: remap(settings.recent), recentFolders: remap(settings.recentFolders), pinned: remap(settings.pinned) }, { quiet: true });
    const next = doc.path === from ? to : doc.path?.startsWith(`${from}/`) ? to + doc.path.slice(from.length) : null;
    if (next) setPath(next, await bundleTextFile(next));
    if (doc.path === to && next === to) await followImages(from, to);
  },
  pathRemoved: async (p) => {
    const keep = (list) => (list || []).filter((x) => x !== p && !x.startsWith(`${p}/`));
    setPref({ recent: keep(settings.recent), recentFolders: keep(settings.recentFolders) }, { quiet: true });
    if (doc.path === p || doc.path?.startsWith(`${p}/`)) {
      doc.path = null;
      doc.file = null;
      setDirty(true);
      updateTitle();
    }
  },
};

const sidebar = new Sidebar({ host: $('#sidebar'), app });
// The outline follows what is on screen.
let outlineTick = 0;
els.scroller.addEventListener('scroll', () => {
  clearTimeout(outlineTick);
  outlineTick = setTimeout(() => sidebar.setActive(activeHeading()), 100);
}, { passive: true });
const commands = createCommands(app);

// --- change tracking --------------------------------------------------------------

// Words are counted the way writers of mixed-script text expect: every
// kana, ideograph or other East Asian character is one word; everything else
// is split at spaces and at most punctuation, with tokens that are only
// punctuation left out. Hangul is split at spaces like Latin text.
function countWords(text) {
  if (!text.trim()) return 0;
  let wide = 0;
  const rest = text
    .replace(/[぀-꯿힤-﫿]/g, () => {
      wide++;
      return ' ';
    })
    .replace(/['’]\w+/g, 'b')
    .replace(/(^|\s+)[　-〿!-/:-@[-`{-~]+(?=\s|$)/gm, ' ');
  return wide + rest.split(/[　-〿\s!-,\\:-@[-`{-~]+/).filter(Boolean).length;
}
function countText(t) {
  return { words: countWords(t), chars: [...t].length, charsNoSpace: [...t.replace(/\s/g, '')].length };
}

function currentText() {
  return sourceMode ? els.source.value : editor.getMarkdown();
}

function onChange(blocks) {
  headings = [];
  blocks.forEach((b, i) => {
    if (b.type === 'h') headings.push({ i, id: b.id, level: b.level, text: plainOf(b.text) });
  });
  sidebar.setOutline(headings, activeHeading());

  const text = blocks.map(blockText).join('\n');
  stats = { ...countText(text), lines: blocks.reduce((n, b) => n + blockText(b).split('\n').length, 0) };
  els.words.textContent = countLabel();

  afterEdit(editor.getMarkdown());
  if ((frontMatter()['typora-root-url'] || '') !== lastRoot) {
    lastRoot = frontMatter()['typora-root-url'] || '';
    rerenderSoon();
  }
  finder.refresh();
  commands.syncState();
}

function afterEdit(md) {
  if (floatingOutline) floatingOutline.draw();
  setDirty(md !== doc.saved || doc.eolChanged);
  saveDraft(md);
  if (doc.dirty && doc.path && settings.autoSave && !sourceMode) autoSave();
}

let lastRoot = '';
let touchMode = '';
// The Touch Bar follows what the caret is in: the kind of block, the styles at
// the caret (lit), an open dialog, the find bar, source code mode.
function touchBarFor() {
  const box = document.querySelector('.overlay .dialog');
  if (box) {
    if (box.dataset.touch !== 'insertTable') return { mode: 'dialog' };
    const n = (sel) => Number(box.querySelector(sel)?.value) || 1;
    return { mode: 'insertTable', state: { values: { tableRows: n('[data-touch=rows]'), tableCols: n('[data-touch=cols]') } } };
  }
  if (finder.isOpen) {
    const on = [finder.opts.caseSensitive && 'findCase', finder.opts.wholeWord && 'findWord', !finder.replaceRow.hidden && 'findReplaceMode'];
    return { mode: 'find', state: { on: on.filter(Boolean) } };
  }
  if (sourceMode) return { mode: 'source' };
  const b = editor.doc[caretBlock];
  const type = b?.type;
  if (type === 'code') return { mode: 'code', state: { titles: { codeLang: b.lang || t('Language') } } };
  // The caret on a picture: its own bar (alt text, address, delete).
  if (editor.imageAtCaret?.()) return { mode: 'image', state: { on: ['imageInsert'] } };
  if (type === 'math' || type === 'html') return { mode: 'raw' };
  if (type === 'toc' || type === 'meta' || type === 'hr') return { mode: 'selectable' };
  const on = [];
  const s = window.getSelection();
  for (let el = s?.rangeCount ? s.focusNode : null; el && el !== els.write; el = el.parentElement) {
    const k = el.nodeType === 1 && el.classList.contains('tok') && el.dataset.t;
    if (k === 'strong' || k === 'em') on.push(k);
    else if (k === 'link' || k === 'url') on.push('link');
    else if (k === 'image') on.push('imageInsert');
  }
  const state = { on: [...new Set(on)] };
  // The text before the caret, for typing suggestions.
  const cur = editor.getSel?.();
  if (cur?.collapsed && typeof b?.text === 'string') state.context = b.text.slice(Math.max(0, cur.focus.off - 80), cur.focus.off);
  if (type === 'table') return { mode: 'table', state };
  if (type === 'def') return { mode: 'def', state: { ...state, titles: { defJump: t(/^\[\^/.test(b.text) ? 'Content' : 'Link') } } };
  if (type === 'li' || (b?.indent || 0) > 0) return { mode: 'list', state };
  return { mode: 'text', state };
}
function syncTouchBar() {
  if (!platform.touchBar) return;
  const { mode, state = {} } = touchBarFor();
  const key = mode + JSON.stringify(state);
  if (key === touchMode) return;
  touchMode = key;
  platform.touchBar(mode, state).catch(() => {});
}
// Dialogs coming and going change the bar too.
new MutationObserver(() => syncTouchBar()).observe(document.body, { childList: true });

// Touch Bar controls that are not menu commands.
const touchCommands = {
  dialogOK: () => document.querySelector('.overlay .dialog .btn.primary')?.click(),
  dialogCancel: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  findCase: () => finder.caseBtn.click(),
  findWord: () => finder.wordBtn.click(),
  findReplaceMode: () => finder.setReplace(finder.replaceRow.hidden),
  // Code block: its language field; the caret between the block's first and last line.
  codeLang: () => {
    const el = els.write.children[caretBlock]?.querySelector('.lang');
    el?.focus();
    el?.select();
  },
  codeJump: () => {
    const sel = editor.getSel();
    const b = editor.doc[caretBlock];
    if (!sel || b?.type !== 'code') return;
    editor.setSel({ i: caretBlock, leaf: 0, off: sel.focus.off < b.text.length / 2 ? b.text.length : 0 });
    editor.revealCaret();
  },
  // A picture: select its alt text or its address, or remove it.
  imageAlt: () => editor.selectImagePart?.('alt'),
  imageSrc: () => editor.selectImagePart?.('src'),
  imageDelete: () => {
    const img = editor.imageAtCaret();
    if (img) editor.deleteImage(img);
  },
  // Math / HTML block: done editing, the caret moves on past the block.
  rawDone: () => {
    if (caretBlock + 1 < editor.doc.length) editor.focusBlock(caretBlock + 1, false);
    else editor.insertParagraph(false);
  },
  // Footnote or link-reference definition: back to where it is used.
  defJump: () => {
    const b = editor.doc[caretBlock];
    const m = b?.type === 'def' && /^\[(\^?)([^\]]+)\]:/.exec(b.text);
    if (!m) return;
    const label = m[2].toLowerCase();
    const use = m[1] ? `[^${label}]` : null;
    const re = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A link reference is used as [text][label] or as a bare [label].
    const used = use ? (text) => text.toLowerCase().includes(use) : (text) => new RegExp(`\\]\\[${re}\\]|\\[${re}\\](?![(:])`, 'i').test(text);
    const i = editor.doc.findIndex((x, k) => k !== caretBlock && x.type !== 'def' && typeof x.text === 'string' && used(x.text));
    if (i >= 0) editor.focusBlock(i);
  },
};
on('command', ({ id }) => touchCommands[id]?.());
// A typing suggestion from the Touch Bar replaces the word being typed.
on('touchCandidate', ({ text }) => {
  const sel = editor.getSel();
  if (!sel?.collapsed || !text) return;
  const b = editor.doc[sel.focus.i];
  const before = (typeof b?.text === 'string' ? b.text : '').slice(0, sel.focus.off);
  const word = /[\p{L}\p{N}'’_-]*$/u.exec(before)[0];
  editor.setSel({ ...sel.focus, off: sel.focus.off - word.length }, sel.focus);
  editor.insertText(`${text}${/\s/.test(b.text[sel.focus.off] || ' ') ? '' : ' '}`);
});
on('touchValue', ({ id, value }) => {
  const field = document.querySelector(`.overlay .dialog [data-touch=${id === 'tableRows' ? 'rows' : 'cols'}]`);
  if (!field) return;
  field.value = String(Math.round(value));
  field.dispatchEvent(new Event('input', { bubbles: true }));
});

function onSelection(sel) {
  caretBlock = sel.focus.i;
  syncTouchBar();
  sidebar.setActive(activeHeading());
  if (!sel.collapsed) els.words.textContent = selectionCount(plainOf(editor.rangeMarkdown(sel)));
  else els.words.textContent = countLabel();
  commands.syncState();
}

// "12 / 340 Words" (or Characters) for a selection, in the unit the status bar counts in.
function selectionCount(text) {
  const unit = settings.wordCountUnit || 'words';
  const all = sourceMode ? els.source.value : editor.getMarkdown();
  if (unit === 'chars') return t('{0} / {1} 字符', text.length, all.length);
  if (unit === 'lines') return t('{0} / {1} 行', text.split('\n').length, all.split('\n').length);
  return t('{0} / {1} 词', countText(text).words, stats.words || countText(all).words);
}

// The heading the outline marks: the first one in view, else the nearest one
// above the visible part of the document.
function activeHeading() {
  if (!headings.length) return -1;
  const view = els.scroller.getBoundingClientRect();
  if (sourceMode || !view.height) {
    let active = -1;
    for (const hd of headings) if (hd.i <= caretBlock) active = hd.i;
    return active;
  }
  let above = headings[0].i;
  for (const hd of headings) {
    const r = els.write.children[hd.i]?.getBoundingClientRect();
    if (!r) continue;
    if (r.bottom <= view.top) above = hd.i;
    else if (r.top < view.bottom) return hd.i;
    else break;
  }
  return above;
}

function plainSelection() {
  const sel = editor.sel();
  return sel && !sel.collapsed ? plainOf(editor.rangeMarkdown(sel)) : '';
}

function setDirty(dirty) {
  if (doc.dirty === dirty) return;
  doc.dirty = dirty;
  updateTitle();
}

// Readonly Mode covers the source view too. A locked or unwritable file keeps it on.
function setReadOnlyMode(on) {
  if (!on && doc.lockedReason) return;
  editor.setReadOnly(on);
  els.source.readOnly = on;
  commands.syncState();
}

let watchedFile = null;
let completer = null;
function updateTitle() {
  // The open file is watched, so a change made by another app shows up right away.
  if (isNative && watchedFile !== doc.file) {
    watchedFile = doc.file;
    platform.watchFile?.(doc.file).catch(() => {});
  }
  els.title.textContent = doc.name;
  els.dirty.hidden = !doc.dirty;
  els.dirty.textContent = `— ${t('已编辑')}`;
  const title = `${doc.name}${doc.dirty ? ` — ${t('已编辑')}` : ''}`;
  platform.setTitle({ title: isNative ? doc.name : `${title} — Livemark`, path: isNative ? doc.path : null, dirty: doc.dirty });
}

function setPath(p, file = p) {
  const moved = doc.path !== p;
  doc.path = p;
  doc.file = file;
  doc.name = p ? path.basename(p) : untitled();
  updateTitle();
  sidebar.markCurrent();
  followFolder();
  if (moved) editor.rerenderAll();
}

// --- TextPack --------------------------------------------------------------------

// A .textpack is unpacked next to the app's data and edited as the bundle
// inside it; every save packs it up again.
const hashOf = (s) => [...s].reduce((h, ch) => ((h * 31 + ch.charCodeAt(0)) >>> 0), 7).toString(36);
async function openPack(p, opts) {
  if (!isNative) return toast(t('无法打开这个链接'));
  try {
    const dir = path.join(info.appSupport, 'textpack', `${path.stem(path.basename(p))}-${hashOf(p)}`);
    await platform.archiveUnpack(p, dir);
    const entries = await platform.list(dir);
    const inner = entries.find((e) => e.isDir && isBundle(e.name))?.path;
    const bundle = inner || ((await platform.stat(path.join(dir, 'text.md'))).exists ? dir : null);
    if (!bundle) throw new Error(t('No text.md inside the TextPack'));
    const ok = await openPath(bundle, opts);
    if (ok) {
      doc.pack = p;
      doc.name = path.basename(p);
      updateTitle();
      addRecent('recent', p);
    platform.noteRecent?.(p).catch(() => {});
      setPref({ lastFile: p }, { quiet: true });
      sidebar.markCurrent();
    }
    return ok;
  } catch (err) {
    toast(t('无法打开：{0}', err.message || err), 4000);
    return null;
  }
}

// --- pictures and media -----------------------------------------------------------

// A picture rendered from source (math, a diagram) as a bitmap on the clipboard.
async function copyBlockImage(i) {
  const view = els.write.children[i]?.querySelector('.preview');
  if (!view || !platform.clipboardSnapshot) return;
  const r = view.getBoundingClientRect();
  try {
    await platform.clipboardSnapshot({ x: r.left, y: r.top, width: r.width, height: r.height });
    toast(t('已复制'));
  } catch (err) {
    toast(t('导出失败：{0}', err.message || err), 4000);
  }
}

// "Save Math / Diagram As…": the rendered block as a PNG file.

// --- export helpers ---------------------------------------------------------------
// Diagrams drawn again for a theme (its --mermaid-* variables), waiting until they are.
// keep: the page's theme is already switched (the print layout); otherwise it is switched
// only while the diagrams are drawn.
async function diagramsInTheme(theme, { keep = false } = {}) {
  const root = document.documentElement;
  const screen = root.dataset.theme;
  if (!theme || (!keep && theme === screen)) return;
  const blocks = editor.doc.map((b, i) => [b, i]).filter(([b]) => isDiagram(b));
  if (!blocks.length) return;
  if (!keep) root.dataset.theme = theme;
  refreshDiagramTheme();
  for (const [, i] of blocks) {
    const el = els.write.children[i];
    if (el) editor.updatePreview(el, editor.doc[i]);
  }
  await new Promise((r) => setTimeout(r, 900));
  if (!keep) {
    root.dataset.theme = screen;
    refreshDiagramTheme();
    // The on-screen drawings come back once the export has read them.
    setTimeout(() => {
      for (const [, i] of blocks) {
        const el = els.write.children[i];
        if (el) editor.updatePreview(el, editor.doc[i]);
      }
    }, 0);
  }
}
// "Export and Overwrite with Previous" remembers, per document, the last export (format
// and file), across launches. A document never exported here goes next to the last
// output under its own name.
let exportMemory = {};
platform.storeGet('exports').then((v) => (exportMemory = v || {}), () => {});
function rememberExport(last) {
  exportMemory = { ...exportMemory, [last.docPath || '']: { key: last.key, target: last.target } };
  const keys = Object.keys(exportMemory);
  if (keys.length > 200) delete exportMemory[keys[0]];
  platform.storeSet('exports', exportMemory).catch(() => {});
}
async function previousExport() {
  const own = exportMemory[doc.path || ''];
  if (own) return { ...own, docPath: doc.path };
  if (!lastExport) return null;
  const ext = path.extname(lastExport.target);
  const stem = doc.path ? path.stem(doc.name) : path.stem(suggestedFileName());
  return { key: lastExport.key, target: path.join(path.dirname(lastExport.target), `${stem}${ext}`), docPath: doc.path };
}

// A diagram as a file of its own: the SVG with the styles it uses written into it.
function standaloneSvg(svg) {
  const copy = svg.cloneNode(true);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const css = [...document.styleSheets].flatMap((sheet) => {
    try {
      return [...sheet.cssRules].map((r) => r.cssText).filter((text) => /^(svg|g|path|rect|text|tspan|line|circle|ellipse|polygon|marker|\.node|\.edge|\.label|#mmd)/.test(text));
    } catch {
      return [];
    }
  });
  if (css.length) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = css.join('\n');
    copy.prepend(style);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}\n`;
}

// The caret on a diagram or a math block (or the whole of one selected): the HTML that
// draws it (SVG, or KaTeX's markup); null otherwise.
function renderedBlockHtml() {
  const sel = editor.getSel();
  if (!sel || sel.anchor.i !== sel.focus.i) return null;
  const b = editor.doc[sel.focus.i];
  if (!b || !(b.type === 'math' || isDiagram(b))) return null;
  const view = els.write.children[sel.focus.i]?.querySelector('.preview');
  return view ? view.innerHTML : null;
}

async function saveBlockImage(i, kind = 'math') {
  const view = els.write.children[i]?.querySelector('.preview');
  if (!view || !platform.clipboardSnapshot) return;
  const svg = kind === 'diagram' ? view.querySelector('svg') : null;
  const target = await platform.pickSave({ suggestedName: `${kind}.${svg ? 'svg' : 'png'}`, directory: docDir() || undefined, extensions: svg ? ['svg', 'png', 'jpg'] : ['png', 'jpg'], formats: (svg ? [['svg', 'SVG']] : []).concat([['png', 'PNG'], ['jpg', 'JPEG']]).map(([ext, name]) => ({ ext, name })), formatLabel: t('File Format:') });
  if (!target) return;
  if (/\.svg$/i.test(target) && svg) {
    try {
      await platform.writeText(target, standaloneSvg(svg));
      toast(t('已保存'));
    } catch (err) {
      toast(t('导出失败：{0}', err.message || err), 4000);
    }
    return;
  }
  const r = view.getBoundingClientRect();
  try {
    await platform.clipboardSnapshot({ x: r.left, y: r.top, width: r.width, height: r.height, path: target });
    toast(t('已保存'));
  } catch (err) {
    toast(t('导出失败：{0}', err.message || err), 4000);
  }
}

async function saveMediaAs(url) {
  const local = localPath(url);
  if (!platform.download && !local) return;
  const name = path.basename((local || url).split(/[?#]/)[0]) || 'image';
  const target = await platform.pickSave({ suggestedName: name, directory: docDir() || undefined });
  if (!target) return;
  try {
    await (local ? platform.copy(local, target) : platform.download(url, target));
    toast(t('已保存'));
  } catch (err) {
    toast(t('导出失败：{0}', err.message || err), 4000);
  }
}

async function learnWord(word, learn) {
  try {
    await (learn ? platform.spellLearn(word) : platform.spellUnlearn(word));
    editor.rerenderAll();
  } catch (err) {
    toast(err.message || String(err), 4000);
  }
}

// --- code formatting (prettier) -------------------------------------------------

const PARSERS = { js: 'babel', javascript: 'babel', jsx: 'babel', mjs: 'babel', cjs: 'babel', json: 'json', json5: 'json5', jsonc: 'json', ts: 'typescript', typescript: 'typescript', tsx: 'typescript', css: 'css', scss: 'scss', less: 'less', html: 'html', vue: 'vue', markdown: 'markdown', md: 'markdown', yaml: 'yaml', yml: 'yaml', graphql: 'graphql', gql: 'graphql' };
const PLUGINS = { babel: ['babel', 'estree'], json: ['babel', 'estree'], json5: ['babel', 'estree'], typescript: ['typescript', 'estree'], css: ['postcss'], scss: ['postcss'], less: ['postcss'], html: ['html', 'babel', 'estree', 'postcss'], vue: ['html', 'babel', 'estree', 'postcss'], markdown: ['markdown', 'babel', 'estree'], yaml: ['yaml'], graphql: ['graphql'] };
const parserFor = (lang) => PARSERS[String(lang || '').trim().toLowerCase()] || null;
let prettierLoading = null;
async function loadPrettier(parser) {
  if (!window.prettier) await (prettierLoading ||= loadScript('./vendor/prettier/standalone.js'));
  window.prettierPlugins ||= {};
  for (const name of PLUGINS[parser] || []) if (!window.prettierPlugins[name]) await loadScript(`./vendor/prettier/plugins/${name}.js`);
}
async function formatCode(i, selectedOnly) {
  const b = editor.doc[i];
  const parser = parserFor(b?.lang);
  if (!b || b.type !== 'code' || !parser) return;
  let from = 0;
  let to = b.text.length;
  if (selectedOnly) {
    const sel = editor.sel();
    if (!sel || sel.collapsed || sel.start.i !== i || sel.end.i !== i) return;
    from = sel.start.off;
    to = sel.end.off;
  }
  try {
    await loadPrettier(parser);
    const text = b.text.slice(from, to);
    const out = (await window.prettier.format(text, { parser, plugins: Object.values(window.prettierPlugins), tabWidth: Number(settings.codeIndent) || 2 })).replace(/\n$/, text.endsWith('\n') ? '\n' : '');
    editor.setBlockText(i, out, from, to);
  } catch (err) {
    toast(t('Could not format the code: {0}', String(err.message || err).split('\n')[0]), 5000);
  }
}

// --- drafts, autosave, versions ---------------------------------------------------

// Unsaved work survives a crash or a forced quit. Each document has its own
// draft: saved files by path, untitled documents by window.
const untitledDraftKey = () => `draft:untitled:${info.windowId || 1}`;
const draftKey = (p = doc.path) => (p ? `draft:file:${p}` : untitledDraftKey());
let draftAt = null; // where the current document's draft is stored
function clearDraft(key = draftAt) {
  if (!key) return;
  platform.storeSet(key, null);
  if (key === draftAt) draftAt = null;
}
const saveDraft = debounce((text) => {
  const key = draftKey();
  // Renamed, moved or saved under a new name: the old draft goes.
  if (draftAt && draftAt !== key) clearDraft(draftAt);
  const keep = settings.draftBackup && (doc.path ? doc.dirty : !!(text.trim() || doc.saved));
  if (!keep) return clearDraft(key);
  draftAt = key;
  return platform.storeSet(key, { path: doc.path || null, name: doc.name, text, saved: doc.saved, at: Date.now() });
}, 600);

async function loadDrafts() {
  const out = { untitled: [], files: [] };
  if (!platform.storeKeys) return out;
  // An older version kept one shared draft under "draft".
  const legacy = await platform.storeGet('draft').catch(() => null);
  if (legacy && typeof legacy.text === 'string' && (legacy.text.trim() || legacy.saved)) out.untitled.push({ ...legacy, key: 'draft', at: 0 });
  for (const key of await platform.storeKeys('draft:').catch(() => [])) {
    const d = await platform.storeGet(key).catch(() => null);
    if (!d || typeof d.text !== 'string') continue;
    (key.startsWith('draft:file:') ? out.files : out.untitled).push({ ...d, key });
  }
  out.untitled.sort((a, b) => (b.at || 0) - (a.at || 0));
  out.files.sort((a, b) => (b.at || 0) - (a.at || 0));
  return out;
}

// Opening a file that has a draft from an earlier session (a crash, a forced
// quit): its changes come back, unless the file itself changed since.
async function recoverDraft(p, diskText) {
  const draft = await platform.storeGet(draftKey(p)).catch(() => null);
  if (!draft || typeof draft.text !== 'string' || draft.text === diskText) {
    if (draft) clearDraft(draftKey(p));
    return;
  }
  if (draft.saved !== diskText) {
    const pick = await ask({ message: t('Unsaved changes to “{0}” were found from a previous session.', path.basename(p)), detail: t('The file has also changed on disk since then.'), buttons: [t('Keep the Unsaved Changes'), t('Use the File on Disk')], style: 'warning' });
    if (pick !== 0) return clearDraft(draftKey(p));
  }
  loadInto(draft.text);
  setDirty(editor.getMarkdown() !== doc.saved);
  draftAt = draftKey(p);
  showHint({ title: t('Recovered unsaved changes to “{0}”.', path.basename(p)), actions: [{ label: t('Discard'), run: () => { loadInto(diskText); setDirty(false); clearDraft(draftKey(p)); } }] });
}

const autoSave = debounce(() => {
  if (doc.dirty && doc.path && settings.autoSave) save({ silent: true });
}, 1800);

const hash = (s) => {
  let x = 2166136261;
  for (let k = 0; k < s.length; k++) x = Math.imul(x ^ s.charCodeAt(k), 16777619);
  return (x >>> 0).toString(36);
};
const versionKey = () => `versions:${hash(doc.path || `untitled:${doc.name}`)}`;
let lastVersionAt = 0;

async function saveVersion(text, force = false) {
  if (!text.trim() || text.length > 400000) return;
  if (!force && Date.now() - lastVersionAt < 5 * 60 * 1000) return;
  lastVersionAt = Date.now();
  const key = versionKey();
  const list = (await platform.storeGet(key)) || [];
  if (list[0]?.text === text) return;
  await platform.storeSet(key, [{ t: Date.now(), text }, ...list].slice(0, 30));
}

async function browseVersions() {
  const own = (await platform.storeGet(versionKey())) || [];
  // Versions macOS keeps of the file (other apps' saves included) are listed with ours.
  const system = doc.path && isNative && platform.fileVersions ? ((await platform.fileVersions(doc.file || doc.path).catch(() => [])) || []).map((v) => ({ ...v, system: true })) : [];
  const seen = new Set(own.map((v) => v.text));
  const list = [...own, ...system.filter((v) => !seen.has(v.text))].sort((a, b) => b.t - a.t);
  if (!list.length) return toast(t('这个文档还没有历史版本'));
  let picked = list[0];
  const preview = h('pre', { class: 'version-preview' }, picked.text);
  const items = h('div', { class: 'version-list' }, list.map((v, k) => h('button', { type: 'button', class: `version-item${k === 0 ? ' active' : ''}`, onclick: (e) => {
    picked = v;
    preview.textContent = v.text;
    for (const b of items.children) b.classList.toggle('active', b === e.currentTarget);
  } }, new Date(v.t).toLocaleString(), h('span', {}, `${t('{0} 词', countText(v.text).words)}${v.system ? ` · ${t('macOS')}` : ''}`))));
  const ok = await modal({ title: t('历史版本'), wide: true, body: h('div', { class: 'versions' }, items, preview), buttons: [{ label: t('取消'), value: null }, { label: t('恢复这个版本'), value: true, primary: true }] });
  if (!ok) return null;
  await saveVersion(currentText(), true);
  loadInto(picked.text);
  return toast(t('已恢复，可以用撤销回到恢复前'));
}

// --- loading & saving -------------------------------------------------------------

// Put text in the editor as an undoable edit of the current document.
function loadInto(text) {
  if (sourceMode) {
    els.source.value = text;
    afterEdit(text);
  } else editor.apply(parseMarkdown(text), { i: 0, leaf: 0, off: 0 });
}

// --- file preview -------------------------------------------------------------------
// A file from the sidebar that is not Markdown is shown in the window instead of the
// document: pictures, video, audio, PDF and text/code; a bar on top opens it in another app.
const PREVIEW_KIND = [
  [/\.(png|jpe?g|gif|webp|svg|bmp|avif|tiff?|heic|ico)$/i, 'image'],
  [/\.(mp4|m4v|mov|webm|ogv)$/i, 'video'],
  [/\.(mp3|m4a|wav|aac|flac|oga|ogg|opus)$/i, 'audio'],
  [/\.pdf$/i, 'pdf'],
  [/\.(txt|text|log|csv|tsv|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|m|mm|cs|php|pl|lua|r|sql|sh|bash|zsh|fish|ps1|bat|tex|bib|rst|org|adoc|vue|svelte|dart|scala|ex|exs|erl|hs|clj|el|vim|diff|patch|gitignore|env|properties|gradle|cmake|makefile|dockerfile)$/i, 'code'],
];
let previewing = null;
// Text, not binary: no NUL characters and few undecodable ones near the start.
function looksLikeText(text) {
  const head = (text || '').slice(0, 8000);
  if (head.includes('\u0000')) return false;
  const bad = (head.match(/\uFFFD/g) || []).length;
  return bad <= head.length / 100;
}
async function previewFile(p) {
  if (!(await confirmDiscard({ switching: true }))) return;
  const name = path.basename(p);
  const kind = (PREVIEW_KIND.find(([re]) => re.test(name)) || [])[1] || (/^(makefile|dockerfile|license|readme)$/i.test(name) ? 'code' : '');
  let box = $('#file-preview');
  if (!box) {
    box = h('section', { id: 'file-preview', 'aria-label': t('Preview') });
    els.scroller.after(box);
  }
  previewing = p;
  document.body.classList.add('previewing');
  const content = h('div', { class: 'preview-content' });
  const openBtn = h('button', { type: 'button', class: 'btn preview-open', onclick: () => platform.openExternal(p) }, t('Open'));
  const more = h('button', { type: 'button', class: 'btn preview-more', 'aria-label': t('Open with…'), onclick: (ev) => previewMenu(p, ev.currentTarget) }, '▾');
  box.replaceChildren(h('div', { class: 'preview-bar' }, h('span', { class: 'preview-name', title: p }, name), h('span', { class: 'preview-actions' }, openBtn, more)), content);
  platform.setTitle({ title: name, path: p, dirty: false });
  const unsupported = () => content.replaceChildren(h('div', { class: 'preview-unsupported' }, t('This file cannot be opened in Livemark.')));
  const url = platform.fileUrl(p);
  try {
    if (kind === 'image') content.append(h('img', { class: 'preview-media', src: url, alt: name, onerror: unsupported }));
    else if (kind === 'video' || kind === 'audio') content.append(h(kind, { class: 'preview-media', src: url, controls: true, onerror: unsupported }));
    else if (kind === 'pdf') content.append(h('iframe', { class: 'preview-frame', src: url, title: name }));
    else if (kind === 'code') {
      const { text } = await platform.readText(p);
      const lang = path.extname(name).slice(1).toLowerCase();
      const code = h('code', {});
      code.innerHTML = highlight(text, lang);
      content.append(h('pre', { class: 'preview-code' }, code));
    } else {
      // Not a known kind: shown as text when it reads as text (and is not huge).
      const st = await platform.stat(p).catch(() => ({}));
      const { text } = st.size && st.size < 4 * 1024 * 1024 ? await platform.readText(p) : { text: null };
      if (text != null && looksLikeText(text)) {
        const code = h('code', {});
        code.textContent = text;
        content.append(h('pre', { class: 'preview-code' }, code));
      } else unsupported();
    }
  } catch {
    unsupported();
  }
  // "Open in <the default app>", once the system says which that is.
  platform.applicationsForFile?.(p).then((res) => {
    if (previewing === p && res?.defaultApp?.name) openBtn.textContent = t('Open in %@').replace('%@', res.defaultApp.name);
  }, () => {});
}

async function previewMenu(p, anchor) {
  const res = await platform.applicationsForFile?.(p).catch(() => null);
  const r = anchor.getBoundingClientRect();
  contextMenu([
    { id: 'asMarkdown', title: t('Open as Markdown'), run: async () => {
      // A file that is not text would only show garbage: say so first.
      const { text } = await platform.readText(p).catch(() => ({ text: '' }));
      if (!looksLikeText(text) && (await ask({ message: t('“{0}” does not look like a text file. Open it as Markdown anyway?', path.basename(p)), buttons: [t('Open'), t('取消')], style: 'warning' })) !== 0) return;
      openPath(p, { asText: true });
    } },
    { separator: true },
    ...(res?.apps || []).map((app, k) => ({ id: `app-${k}`, title: app.name, run: () => platform.openWithApplication(p, app.url) })),
    (res?.apps || []).length ? { separator: true } : null,
    { id: 'reveal', title: t('Show in Finder'), run: () => platform.reveal(p) },
  ].filter(Boolean), r.left, r.bottom + 4);
}

function hidePreview() {
  if (!previewing) return;
  previewing = null;
  document.body.classList.remove('previewing');
  $('#file-preview')?.replaceChildren();
  updateTitle();
}

// Where the caret and the view were in each file, so going back to a file (now
// or after a relaunch) lands there again. Newest first, at most 100 files.
let positions = null;
async function loadPositions() {
  if (!positions) positions = (await platform.storeGet('positions').catch(() => null)) || {};
  return positions;
}
function rememberPosition() {
  if (!doc.path || !positions) return;
  const sel = editor.getSel();
  const entry = { i: sel ? sel.focus.i : 0, leaf: sel ? sel.focus.leaf : 0, off: sel ? sel.focus.off : 0, scroll: els.scroller.scrollTop, at: Date.now() };
  positions[doc.path] = entry;
  const keys = Object.keys(positions).sort((a, b) => positions[b].at - positions[a].at);
  for (const k of keys.slice(100)) delete positions[k];
  platform.storeSet('positions', positions);
}
async function restorePosition(p) {
  const at = (await loadPositions())[p];
  if (!at || doc.path !== p) return;
  const b = editor.doc[at.i];
  if (b) {
    const off = Math.min(at.off, leafText(b, Math.min(at.leaf, Math.max(0, (b.type === 'table' ? b.rows.length * tableCols(b) : 1) - 1))).length);
    try {
      editor.setSel({ i: at.i, leaf: at.leaf, off });
    } catch {
      /* the file changed shape since: the top will do */
    }
  }
  els.scroller.scrollTop = at.scroll || 0;
}
window.addEventListener('blur', () => rememberPosition());
window.addEventListener('pagehide', () => rememberPosition());

function showText(text, { file = null, textFile = file, name = untitled(), saved = text, mtime = 0 } = {}) {
  hidePreview();
  rememberPosition();
  // The lock belonged to the document being replaced.
  if (doc.lockedReason) {
    doc.lockedReason = null;
    setReadOnlyMode(false);
  }
  // The document being replaced was saved or its changes were declined: its draft goes.
  if (draftAt && draftAt !== draftKey(file)) clearDraft();
  if (sourceMode) toggleSource(true);
  if (doc.path && doc.path !== file) rememberClosed(doc.path);
  doc.path = file;
  doc.file = textFile;
  doc.pack = null;
  doc.name = file ? path.basename(file) : name;
  doc.mtime = mtime;
  const clean = text.replace(/\r\n?/g, '\n');
  // A file keeps its own line endings: CRLF if it has any, LF if it has line breaks,
  // otherwise the default; and its final newline when it has text.
  doc.crlf = text.includes('\r\n') ? true : text.includes('\n') ? false : settings.lineEnding === 'crlf';
  doc.finalNewline = text.length ? /\n$/.test(text) : settings.finalNewline;
  doc.eolChanged = false;
  sidebar.resetOutline();
  // Like Typora, a file of more than two million characters is not rendered: the page
  // says so and offers Quick Look, and nothing can be saved over it.
  doc.oversize = !!file && clean.length > MAX_FILE_SIZE;
  showOversize(doc.oversize);
  editor.setMarkdown(doc.oversize ? '' : clean);
  // Compare against the normalized form, so opening a file does not mark it
  // edited just because of trailing whitespace.
  doc.saved = doc.oversize ? '' : saved === text ? editor.getMarkdown() : saved;
  doc.eolChanged = false;
  doc.dirty = editor.getMarkdown() !== doc.saved;
  updateTitle();
  els.scroller.scrollTop = 0;
  editor.focus();
  sidebar.markCurrent();
  followFolder();
  lastVersionAt = 0;
}

const MAX_FILE_SIZE = 2e6;

function showOversize(on) {
  let el = $('#oversize');
  if (!on) {
    el?.remove();
    els.write.hidden = false;
    return;
  }
  if (!el) {
    const look = h('button', { type: 'button', class: 'oversize-look' }, t('QuickLook'));
    look.addEventListener('click', () => doc.path && platform.previewFile?.(doc.path));
    el = h('div', { id: 'oversize', role: 'alert' },
      h('div', { class: 'oversize-mark' }, '⚠'),
      h('div', { class: 'oversize-text' }, t('The file is too large to render in Livemark.')),
      isNative ? h('div', { class: 'oversize-actions' }, look) : null);
    els.scroller.append(el);
  }
  els.write.hidden = true;
}

async function confirmDiscard({ switching = false } = {}) {
  if (!doc.dirty) return true;
  if (switching && settings.saveOnSwitch && doc.path) return save({ silent: true });
  const pick = await ask({ message: t('要保存对“{0}”的修改吗？', doc.name), detail: t('不保存的话，修改会丢失。'), buttons: [t('保存'), t('取消'), t('不保存')], style: 'warning' });
  if (pick === 0) return save();
  return pick === 2;
}

async function newDoc() {
  if (!(await confirmDiscard())) return;
  showText('');
  clearDraft();
}

// A TextBundle is a folder holding text.md, info.json and an assets folder.
async function bundleTextFile(p) {
  if (!isBundle(p)) return p;
  const list = await platform.list(p).catch(() => []);
  return list.find((f) => /^text\.(md|markdown|txt)$/i.test(f.name))?.path || path.join(p, 'text.md');
}
async function prepareBundle(p) {
  await platform.mkdir(p);
  await platform.mkdir(path.join(p, 'assets'));
  if (!(await platform.stat(path.join(p, 'info.json'))).exists) {
    await platform.writeText(path.join(p, 'info.json'), `${JSON.stringify({ version: 2, type: 'net.daringfireball.markdown', transient: false, creatorIdentifier: 'dev.livemark.app' }, null, 2)}\n`);
  }
}

// Files closed in any window, most recent first, for "Reopen Closed File".
let closedFiles = [];
async function rememberClosed(p) {
  if (!p || !settings.recordRecent) return;
  const list = (await platform.storeGet('closed')) || [];
  closedFiles = [p, ...list.filter((x) => x !== p)].slice(0, 20);
  await platform.storeSet('closed', closedFiles);
  commands.syncState();
}
async function reopenClosed() {
  closedFiles = (await platform.storeGet('closed')) || [];
  for (const p of closedFiles) {
    if (p === doc.path || !(await platform.stat(p)).exists) continue;
    closedFiles = closedFiles.filter((x) => x !== p);
    await platform.storeSet('closed', closedFiles);
    if (isNative && (doc.path || doc.dirty)) return platform.newWindow(p);
    return openPath(p);
  }
  return toast(t('No recently closed file'));
}

async function revertToSaved() {
  if (!doc.dirty) return;
  if ((await ask({ message: t('放弃未保存的修改并重新载入？'), buttons: [t('重新载入'), t('取消')], style: 'warning' })) !== 0) return;
  doc.dirty = false;
  if (doc.path) await reloadFromDisk();
  else loadInto(doc.saved);
}

// File → Open…: Markdown files and folders, several at once (a folder becomes the
// sidebar's root; every file after the first opens in a window of its own).
async function openDialog() {
  try {
    if (platform.pickDocsOrFolders) {
      const picked = await platform.pickDocsOrFolders(fileFormats([['Markdown', MD_EXT], ['TextBundle', ['textbundle', 'textpack']]]));
      let first = true;
      for (const p of picked || []) {
        const st = await platform.stat(p).catch(() => ({}));
        if (st.isDir && !isBundle(p)) await openFolder(p);
        else if (first) { first = false; await openPath(p); }
        else platform.newWindow(p);
      }
      return;
    }
    const p = await platform.pickFile({ extensions: MD_EXT });
    if (p) await openPath(p);
  } catch (err) {
    toast(t('无法打开：{0}', err.message || err));
  }
}

async function openPath(p, opts = {}) {
  if (isPack(p) && p !== doc.pack) return openPack(p, opts);
  // A folder (Finder, the Dock, `open -a`): it opens in the sidebar.
  if (isNative && !isBundle(p) && (await platform.stat(p).catch(() => ({})))?.isDir) return openFolder(p);
  if (p !== doc.path) {
    if (!isMarkdownName(p) && isImageName(p) && !opts.asText) return placeImagePath(p);
    // Open in another window already: that window comes forward (one document, one editor).
    if (isNative && platform.focusPath && (await platform.focusPath(p).catch(() => null))?.found) return null;
    if (!(await confirmDiscard({ switching: true }))) return null;
    // A file that is gone (a stale recent entry, say): Typora warns once more unless
    // told not to.
    if (isNative && !(await platform.stat(p).catch(() => ({ exists: true }))).exists) {
      // Asked to open a document that is not there (command line, another app):
      // offer to create it at that path.
      if (opts.external && isMarkdownName(p)) {
        const pick = await ask({ message: t('File does not exist'), detail: t('File does not exist at path %@, do you want to create one at that path ?').replace('%@', p), buttons: [t('Create File'), t('Cancel')] });
        if (pick !== 0) return null;
        try {
          await platform.writeText(p, '');
        } catch (err) {
          await ask({ message: t('Failed to create file.'), detail: String(err.message || err), style: 'warning' });
          return null;
        }
        return openPath(p);
      }
      if (!settings.dismissed.noFileNonExistWarning && platform.messageWithCheckbox) {
        const r = await platform.messageWithCheckbox({ message: t('File does not exist at path %@.').replace('%@', p), buttons: [t('好')], style: 'warning', checkbox: t('Do not show this again') }).catch(() => null);
        if (r?.checked) setPref({ dismissed: { ...settings.dismissed, noFileNonExistWarning: true } });
      }
      return null;
    }
    try {
      const file = await bundleTextFile(p);
      const { text, mtime } = await platform.readText(file);
      docEncoding = 'auto';
      showText(text, { file: p, textFile: file, mtime });
      // A file locked in Finder, or one this user cannot write, opens in Readonly Mode.
      const st = isNative ? await platform.stat(file).catch(() => ({})) : {};
      if (st.locked || st.writable === false) {
        doc.lockedReason = st.locked ? 'locked' : 'unwritable';
        setReadOnlyMode(true);
        toast(t(st.locked ? '“{0}” is locked, so it opens in Readonly Mode.' : '“{0}” cannot be written, so it opens in Readonly Mode.', path.basename(p)), 4000);
      }
      if (isNative) await recoverDraft(p, text);
      if (!opts.line && !opts.find && !opts.anchor) await restorePosition(p);
      addRecent('recent', p);
    platform.noteRecent?.(p).catch(() => {});
      setPref({ lastFile: p }, { quiet: true });
      commands.pushNativeMenu();
    } catch (err) {
      toast(t('无法打开“{0}”：{1}', path.basename(p), err.message || err));
      return null;
    }
  }
  if (opts.find) {
    // The search result's options come along (a regex result searches the pattern).
    finder.opts.caseSensitive = !!opts.caseSensitive;
    finder.opts.wholeWord = !!opts.wholeWord;
    finder.opts.regex = !!opts.regex;
    finder.open({ seed: opts.find, reseed: true });
    // Jump to the hit the search result pointed at: the n-th occurrence,
    // counting the ones on earlier lines.
    const fold = (t) => (opts.caseSensitive ? t : t.toLowerCase());
    const before = fold(currentText().split('\n').slice(0, opts.line).join('\n'));
    let n = 0;
    if (opts.regex) {
      try {
        n = (before.match(new RegExp(opts.find, `g${opts.caseSensitive ? '' : 'i'}u`)) || []).length;
      } catch {
        n = 0;
      }
    } else {
      const needle = fold(opts.find);
      for (let at = before.indexOf(needle); at >= 0; at = before.indexOf(needle, at + needle.length)) n++;
    }
    if (finder.matches.length) finder.index = Math.min(n, finder.matches.length - 1);
    finder.reveal();
  }
  return true;
}

// With no folder opened, the file panels show the folder the document is in.
function followFolder() {
  if (!isNative || !doc.path || (sidebar.root && !sidebar.implicit)) return;
  const dir = path.dirname(doc.path);
  if (dir === sidebar.root) return sidebar.markCurrent();
  sidebar.implicit = true;
  sidebar.setRoot(dir).catch(() => {});
}

async function openFolder(p = null) {
  try {
    const dir = p || (await platform.pickFolder());
    if (!dir) return;
    // A recent or pinned folder that has gone away: say so, and forget it.
    if (isNative && !(await platform.stat(dir).catch(() => ({ exists: false }))).exists) {
      await ask({ message: t('Open Operation Failed'), detail: t('Folder does not exist at %@').replace('%@', dir), style: 'warning' });
      setPref({ recentFolders: (settings.recentFolders || []).filter((x) => x !== dir) });
      return;
    }
    sidebar.implicit = false;
    await sidebar.setRoot(dir);
    setPref({ folder: isNative ? dir : null, sidebar: true, sidebarTab: sidebar.tab === 'outline' ? 'tree' : sidebar.tab });
    if (sidebar.tab === 'outline') sidebar.setTab('tree');
    addRecent('recentFolders', dir, 6);
    commands.pushNativeMenu();
  } catch (err) {
    toast(t('无法打开文件夹：{0}', err.message || err));
  }
}

function outText() {
  let text = currentText();
  if (doc.finalNewline && !text.endsWith('\n')) text += '\n';
  if (!doc.finalNewline) text = text.replace(/\n+$/, '');
  return doc.crlf ? text.replace(/\n/g, '\r\n') : text;
}

async function writeTo(p) {
  if (isBundle(p)) await prepareBundle(p);
  const text = outText();
  const { mtime } = await platform.writeText(await bundleTextFile(p), text);
  if (isBundle(p)) await pruneBundleAssets(p, text);
  return mtime || Date.now();
}

// A TextBundle keeps only the assets its text uses: the others go to the Trash on save.
async function pruneBundleAssets(bundle, text) {
  if (!isNative) return;
  const dir = path.join(bundle, 'assets');
  const files = await platform.list(dir).catch(() => []);
  const used = safeDecode(text);
  for (const f of files) {
    if (f.isDir || f.name.startsWith('.')) continue;
    if (!used.includes(`assets/${f.name}`)) await platform.trash(f.path).catch(() => {});
  }
}

// File extensions offered when saving, the default one first.
const saveExtensions = () => [settings.defaultExt, ...['md', 'markdown', 'txt', ...(isNative ? ['textbundle'] : [])].filter((x) => x !== settings.defaultExt)];
const saveFormats = () => [['md', 'Markdown (.md)'], ['markdown', 'Markdown (.markdown)'], ['txt', t('Plain Text (.txt)')], ...(isNative ? [['textbundle', 'TextBundle (.textbundle)']] : [])].map(([ext, name]) => ({ ext, name }));
const withDefaultExt = (name) => `${path.stem(name)}.${settings.defaultExt}`;

// The name offered when an unsaved document is first saved, picked as Typora picks it:
// "date-title" from the front matter, else the first H1–H3 heading, else the first line
// of the first block (a long one is cut at its first period); at most 120 characters,
// without characters a file name cannot hold, "Untitled" when nothing is left.
function suggestedFileName() {
  let name = '';
  try {
    const fm = frontMatter();
    const date = (/\d+-\d+-\d+/.exec(String(fm.date || '')) || /\d+\/\d+\/\d+/.exec(String(fm.date || '')) || [''])[0];
    name = String(fm.title || '').replace(/(^\s*("|'))|(("|')\s*)/gi, '').replace(/\s+(.)/g, '-$1');
    name = date && name ? `${date}-${name}` : name;
    if (!name.trim() || name === '-') {
      const heading = editor.doc.find((b) => b.type === 'h' && b.level <= 3);
      if (heading) name = plainOf(heading.text).replace(/\r?\n/g, '');
      else {
        const first = editor.doc.find((b) => b.type !== 'meta');
        const text = first && typeof first.text === 'string' ? plainOf(first.text) : '';
        name = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : undefined) || text;
        if (name.length > 60) name = name.slice(0, name.indexOf('.') > 0 ? name.indexOf('.') : undefined) || name;
      }
    }
    if (name.length > 120) name = name.slice(0, 120);
  } catch {
    name = '';
  }
  name = name.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
  return name || t('Untitled');
}

async function save({ silent = false } = {}) {
  if (doc.oversize) return false;
  if (!doc.path) return silent ? false : saveAs();
  try {
    doc.mtime = await writeTo(doc.path);
    if (doc.pack) await platform.archivePack(doc.path, doc.pack);
    doc.saved = currentText();
    doc.eolChanged = false;
    setDirty(false);
    saveVersion(doc.saved, !silent);
    clearDraft();
    return true;
  } catch (err) {
    if (!silent) toast(t('保存失败：{0}', err.message || err));
    return false;
  }
}

async function saveAs() {
  try {
    const p = await platform.pickSave({ suggestedName: doc.path ? doc.name : withDefaultExt(suggestedFileName()), directory: doc.path ? path.dirname(doc.path) : sidebar.root || undefined, extensions: saveExtensions(), formats: saveFormats(), formatLabel: t('File Format:') });
    if (!p) return false;
    // Pictures stored inside a bundle move with the document.
    const from = docDir();
    doc.mtime = await writeTo(p);
    if (isBundle(p) && from) await adoptImagesInto(p, from);
    const was = doc.path;
    doc.saved = currentText();
    doc.eolChanged = false;
    setPath(p, await bundleTextFile(p));
    if (was && !isBundle(p)) await followImages(was, p, { copy: true });
    setDirty(false);
    addRecent('recent', p);
    platform.noteRecent?.(p).catch(() => {});
    saveVersion(doc.saved, true);
    clearDraft();
    commands.pushNativeMenu();
    if (sidebar.root && p.startsWith(sidebar.root)) sidebar.refresh();
    return true;
  } catch (err) {
    toast(t('保存失败：{0}', err.message || err));
    return false;
  }
}

async function saveCopy() {
  try {
    const p = await platform.pickSave({ suggestedName: withDefaultExt(t('{0} 副本.md', path.stem(doc.name))), directory: doc.path ? path.dirname(doc.path) : undefined, extensions: saveExtensions() });
    if (!p) return;
    await writeTo(p);
    toast(t('副本已保存'));
    if (sidebar.root && p.startsWith(sidebar.root)) sidebar.refresh();
  } catch (err) {
    toast(t('保存失败：{0}', err.message || err));
  }
}

async function renameFile() {
  if (!doc.path) return;
  const name = await prompt({ title: t('重命名'), value: doc.name, ok: t('重命名') });
  if (!name || name === doc.name) return;
  const to = path.join(path.dirname(doc.path), /\.\w+$/.test(name) ? name : `${name}.md`);
  try {
    if ((await platform.stat(to)).exists) return toast(t('同名文件已存在'));
    const from = doc.path;
    await platform.rename(doc.path, to);
    setPref({ recent: settings.recent.filter((x) => x !== from) }, { quiet: true });
    setPath(to, await bundleTextFile(to));
    addRecent('recent', to);
    platform.noteRecent?.(to).catch(() => {});
    sidebar.refresh();
    await followImages(from, to);
  } catch (err) {
    toast(t('无法重命名：{0}', err.message || err));
  }
  return null;
}

// After the document was renamed or moved: when its image folder rule now names
// another folder (./${filename}.assets after a rename, ./assets after a move), offer
// to move the pictures it uses from the old folder and point the references there.
async function followImages(from, to, { copy = false } = {}) {
  if (!isNative || !from || !to || isBundle(from) || isBundle(to)) return;
  const target = imageTarget();
  if (target.mode !== 'copy' || !target.folder || target.folder.startsWith('/')) return;
  const dirFor = (p) => path.resolve(path.dirname(p), target.folder.replace(/\$\{filename\}/g, path.stem(path.basename(p))));
  const oldDir = dirFor(from);
  const newDir = dirFor(to);
  if (oldDir === newDir) return;
  const md = editor.getMarkdown();
  const refs = new Map();
  const re = /(!\[[^\]]*\]\(\s*<?)([^)\s>]+)|(<img\b[^>]*?\ssrc=["'])([^"']+)/gi;
  for (const m of md.matchAll(re)) {
    const src = m[2] || m[4];
    if (!src || /^([a-z][\w+.-]*:|\/\/|#)/i.test(src)) continue;
    const abs = src.startsWith('/') ? src : path.resolve(path.dirname(from), safeDecode(src.split(/[?#]/)[0]));
    if (abs.startsWith(`${oldDir}/`) && (await platform.stat(abs).catch(() => ({}))).exists) refs.set(src, abs);
  }
  if (!refs.size) return;
  const pick = copy
    ? await ask({ message: t('Would you like to copy the images in “{0}” to “{1}” and update the image references?', path.basename(oldDir), path.basename(newDir)), buttons: [t('Copy Images'), t('Don’t Copy')] })
    : await ask({ message: t('Would you like to move the images in “{0}” to “{1}” and update the image references?', path.basename(oldDir), path.basename(newDir)), buttons: [t('Move Images'), t('Don’t Move')] });
  if (pick !== 0) return;
  let text = md;
  try {
    for (const [src, abs] of refs) {
      const dest = path.join(newDir, abs.slice(oldDir.length + 1));
      await platform.mkdir(path.dirname(dest));
      if ((await platform.stat(abs).catch(() => ({}))).exists && !(await platform.stat(dest).catch(() => ({}))).exists) await (copy ? platform.copy(abs, dest) : platform.rename(abs, dest));
      let ref = imageRef(dest);
      if (/%[0-9a-f]{2}/i.test(src) || /\s/.test(ref)) ref = encodeURI(ref);
      text = text.split(`](${src}`).join(`](${ref}`).split(`](<${src}`).join(`](<${ref}`).split(`src="${src}"`).join(`src="${ref}"`).split(`src='${src}'`).join(`src='${ref}'`);
    }
    if (!copy && (await platform.list(oldDir).catch(() => [null])).length === 0) await platform.removePermanently(oldDir).catch(() => {});
  } catch (err) {
    toast(t('Failed to move images: {0}', err.message || err), 5000);
  }
  if (text !== md) {
    editor.replaceMarkdown(text, true);
    await save({ silent: true });
  }
  if (sidebar.root) sidebar.refresh();
}

async function moveFile() {
  if (!doc.path) return;
  const dir = await platform.pickFolder();
  if (!dir) return;
  const to = path.join(dir, doc.name);
  try {
    if ((await platform.stat(to)).exists) return toast(t('目标位置已有同名文件'));
    const from = doc.path;
    await platform.rename(doc.path, to);
    setPref({ recent: settings.recent.filter((x) => x !== from) }, { quiet: true });
    setPath(to, await bundleTextFile(to));
    addRecent('recent', to);
    platform.noteRecent?.(to).catch(() => {});
    sidebar.refresh();
    await followImages(from, to);
  } catch (err) {
    toast(t('无法移动：{0}', err.message || err));
  }
  return null;
}

async function deleteFile() {
  if (!doc.path) return;
  const pick = await ask({ message: t('把“{0}”移到废纸篓？', doc.name), buttons: [t('移到废纸篓'), t('取消')], style: 'warning' });
  if (pick !== 0) return;
  try {
    await platform.trash(doc.path);
    doc.dirty = false;
    doc.path = null;
    showText('');
    clearDraft();
    sidebar.refresh();
    toast(t('已移到废纸篓'));
  } catch (err) {
    toast(t('无法删除：{0}', err.message || err));
  }
}

// Show the current file in the sidebar, opening its folder if needed.
async function revealInSidebar(tab) {
  if (!doc.path) return;
  if (!sidebar.root || !doc.path.startsWith(`${sidebar.root}/`)) await openFolder(path.dirname(doc.path));
  app.showSidebar(tab);
  if (tab === 'tree') await sidebar.reveal(doc.path);
  else sidebar.body.querySelector('.active')?.scrollIntoView({ block: 'center' });
}

async function reopenWithEncoding(enc) {
  if (!doc.path || !(await confirmDiscard())) return;
  try {
    const { text, mtime } = await platform.readText(doc.file, enc === 'auto' ? undefined : enc);
    showText(text, { file: doc.path, textFile: doc.file, mtime });
    docEncoding = enc;
    commands.syncState();
  } catch (err) {
    toast(t('无法用这个编码读取：{0}', err.message || err));
  }
}

async function reloadFromDisk() {
  if (!doc.path) return;
  if (doc.dirty && (await ask({ message: t('放弃未保存的修改并重新载入？'), buttons: [t('重新载入'), t('取消')], style: 'warning' })) !== 0) return;
  try {
    const { text, mtime } = await platform.readText(doc.file);
    showText(text, { file: doc.path, textFile: doc.file, mtime });
  } catch (err) {
    toast(t('无法读取：{0}', err.message || err));
  }
}

// Another program may have changed the file while we were in the background.
let checking = false;
async function checkDisk() {
  if (!doc.path || checking || !isNative) return;
  checking = true;
  try {
    let st = await platform.stat(doc.file);
    if (!st.exists) {
      // Other apps often save by replacing the file: look again before calling it gone.
      await new Promise((r) => setTimeout(r, 500));
      st = await platform.stat(doc.file);
      if (!st.exists && doc.file) {
        toast(t('“{0}” was moved or deleted. The document is kept here as an unsaved copy.', doc.name), 5000);
        doc.path = null;
        doc.file = null;
        setDirty(true);
        updateTitle();
        return;
      }
    }
    if (st.exists && st.mtime > doc.mtime + 1000) {
      doc.mtime = st.mtime;
      if (!doc.dirty && !doc.oversize) {
        // A clean document follows the file, as one undoable change that keeps the caret and scroll.
        const { text } = await platform.readText(doc.file);
        const top = els.scroller.scrollTop;
        editor.replaceMarkdown(text, true);
        doc.saved = editor.getMarkdown();
        doc.eolChanged = false;
        setDirty(false);
        els.scroller.scrollTop = top;
      } else if (!doc.dirty) {
        const { text } = await platform.readText(doc.file);
        showText(text, { file: doc.path, textFile: doc.file, mtime: st.mtime });
      } else if ((await ask({ message: `${t('File content is changed by external applications. Reload content from disk ?')} ${t('You could undo this operation later via `Edit` → `Undo`.')}`, buttons: [t('好'), t('取消')], style: 'warning' })) === 0) {
        // As in Typora: the disk version comes in as an undoable change.
        const { text } = await platform.readText(doc.file);
        doc.saved = text;
        doc.eolChanged = false;
        editor.replaceMarkdown(text);
      }
    }
  } catch {
    /* the file may be temporarily unavailable; try again on next focus */
  } finally {
    checking = false;
  }
}

// --- clipboard --------------------------------------------------------------------

async function copyText(text) {
  if (!text) return;
  try {
    await platform.clipboardWrite({ text });
    toast(t('已复制'));
  } catch (err) {
    toast(t('无法复制：{0}', err.message || err));
  }
}

function selectionMarkdown() {
  if (sourceMode) return els.source.value.slice(els.source.selectionStart, els.source.selectionEnd) || els.source.value;
  const sel = editor.sel();
  return sel && !sel.collapsed ? editor.rangeMarkdown(sel) : editor.getMarkdown();
}

// Markdown source -> the text a reader sees. Headings, quotes and inline
// syntax lose their markers; list items keep one (numbers recounted) and stay
// tight; code is indented; table cells line up in tab-separated columns.
function plainText(md) {
  const blocks = parseMarkdown(md);
  if (blocks.length === 1 && blocks[0].type === 'p' && !blocks[0].q && !blocks[0].indent) return plainOf(blocks[0].text);
  const nums = numberLists(blocks);
  const listed = (b) => b && (b.type === 'li' || (b.indent || 0) > 0);
  const lines = [];
  let cols = [];
  let kinds = [];
  let wq = -1;
  let prev = null;
  blocks.forEach((b, k) => {
    const q = b.q || 0;
    const d = b.indent || 0;
    if (q !== wq) {
      cols = [];
      kinds = [];
      wq = q;
    }
    const pad = d > 0 ? cols[d - 1] ?? d * 2 : 0;
    let body;
    let opens = false; // the first item of a list
    if (b.type === 'li') {
      const kind = b.kind === 'ol' ? 'ol' : 'ul';
      opens = cols.length <= d || kinds[d] !== kind;
      const marker = kind === 'ol' ? `${nums[k]}. ` : '- ';
      cols.length = d;
      kinds.length = d;
      cols[d] = pad + marker.length;
      kinds[d] = kind;
      body = plainOf(b.text).split('\n').map((l, n) => (n ? ' '.repeat(marker.length) : marker) + l);
    } else {
      cols.length = Math.min(cols.length, d);
      kinds.length = Math.min(kinds.length, d);
      if (b.type === 'code') body = b.text.split('\n').map((l) => `    ${l}`);
      else if (b.type === 'table') {
        const cells = b.rows.map((r) => r.map((c) => plainOf(c)));
        const widths = cells[0].map((_, c) => Math.max(4, ...cells.map((r) => (r[c] || '').length)));
        const fit = (t, c) => {
          const room = ' '.repeat(Math.max(0, widths[c] - t.length));
          if (b.align?.[c] === 'right') return room + t;
          if (b.align?.[c] === 'center') return room.slice(0, room.length >> 1) + t + room.slice(room.length >> 1);
          return t + room;
        };
        body = cells.map((r) => `  ${r.map((t, c) => fit(t || '', c)).join('\t')}`);
      } else if (b.type === 'hr') body = ['---'];
      else if (b.type === 'toc') body = ['[toc]'];
      else if (b.type === 'p' || b.type === 'h') body = plainOf(b.text).split('\n');
      else body = (b.text || '').split('\n');
    }
    if (prev && !(listed(b) && listed(prev) && (prev.q || 0) === q && !(opens && d === 0))) lines.push('');
    for (const l of body) lines.push(l === '' ? '' : ' '.repeat(pad) + l);
    prev = b;
  });
  return `${lines.join('\n')}\n`;
}

// Paragraph → Table → Copy Table: the Markdown source, and an HTML table with
// visible cell borders for pasting into mail or a word processor.
async function copyTable(md) {
  if (!md) return;
  const html = clipboardHtml(md).replace(/<(td|th)(\s[^>]*)?>/g, (all, tag, rest = '') => {
    const align = /style="text-align:\s*(\w+)/.exec(rest)?.[1];
    return `<${tag} style="border: 1px solid #ccc; padding: 2px 6px;${align ? ` text-align: ${align};` : ''}">`;
  }).replace(/<table>/, '<table style="border-collapse: collapse;">');
  try {
    await platform.clipboardWrite({ text: md, html });
    toast(t('已复制'));
  } catch (err) {
    toast(t('无法复制：{0}', err.message || err));
  }
}

async function copyAs(kind) {
  const md = selectionMarkdown();
  try {
    if (kind === 'markdown') await platform.clipboardWrite({ text: md });
    // HTML code for pasting into another page: headings carry no anchor ids.
    else if (kind === 'html') {
      const drawn = renderedBlockHtml();
      await platform.clipboardWrite({ text: drawn || markdownToHtml(md).replace(/<(h[1-6]) id="[^"]*">/g, '<$1>') });
    }
    else if (kind === 'plain') await platform.clipboardWrite({ text: plainText(md) });
    // Without theme styling: plain HTML, and the plain-text flavour follows the
    // "copy Markdown source as plain text" setting, as an ordinary copy does.
    else if (kind === 'simple') await platform.clipboardWrite({ text: settings.copyPlainSource ? md : plainText(md), html: clipboardHtml(md) });
    else await platform.clipboardWrite({ text: settings.copyPlainSource ? md : plainText(md), html: clipboardHtml(md) });
    toast(t('已复制'));
  } catch (err) {
    toast(t('无法复制：{0}', err.message || err));
  }
}

async function cut() {
  const sel = editor.sel();
  if (!sel || sel.collapsed) return;
  await copyAs('rich');
  editor.deleteRange(sel);
}

async function pasteFromClipboard(plain = false) {
  try {
    const data = await platform.clipboardRead();
    const converted = (!plain && data.html && htmlToMarkdown(data.html, data.text)) || '';
    const text = converted || data.text || '';
    if (sourceMode) {
      els.source.setRangeText(text, els.source.selectionStart, els.source.selectionEnd, 'end');
      els.source.dispatchEvent(new Event('input'));
    } else editor.pasteText(text, { plain, fromHtml: !!converted });
  } catch (err) {
    toast(t('无法读取剪贴板：{0}', err.message || err));
  }
}
function pastePlain() {
  return pasteFromClipboard(true);
}

// --- images -----------------------------------------------------------------------

// yyyyMMddHHmmssSSS in local time, the usual stamp in pasted-image names.
const stamp = () => {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}`;
};
// The description an inserted picture gets: its file name without extension.
const altFor = (p) => safeDecode(path.stem(p.split(/[?#]/)[0])).replace(/^\./, '');
// A path as it is written into the document.
function mdPath(p) {
  if (!/[\s()]/.test(p)) return p;
  return settings.imgEscape ? p.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/') : `<${p}>`;
}
const toBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});
const insertImageRef = (src, alt = '') => editor.insertImageText(settings.imgSyntax === 'html' ? `<img src="${src}" alt="${alt}" />` : `![${alt}](${src})`);
// Pictures that have no better home: pasted into a document that is not
// saved yet, or with no folder rule set.
const userImagesDir = () => (isNative && info.appSupport ? path.join(info.appSupport, 'user-images') : null);

// What happens to a newly inserted image: { mode: 'keep' | 'copy' | 'upload',
// folder }. The document's front matter (typora-copy-images-to) wins over
// the global setting; a TextBundle always keeps its pictures inside itself.
function imageTarget() {
  if (doc.path && isBundle(doc.path)) return { mode: 'copy', folder: './assets' };
  const own = frontMatter()['typora-copy-images-to'];
  if (own === 'upload') {
    if (!settings.imgYamlUpload) warnUploadDisabled();
    return settings.imgYamlUpload && app.canUpload() ? { mode: 'upload' } : { mode: 'keep' };
  }
  if (own) return { mode: 'copy', folder: own, fromYaml: true };
  if (settings.imageAction === 'upload') return app.canUpload() ? { mode: 'upload' } : { mode: 'keep' };
  if (settings.imageAction === 'keep') return { mode: 'keep' };
  return { mode: 'copy', folder: IMAGE_FOLDERS[settings.imageAction] || settings.imageFolder || './assets' };
}

// The document's YAML asks for uploads but the setting that allows that is off: say so,
// with a way to the setting and to silence the warning (Typora's checkAutoUploadIsAllowed).
async function warnUploadDisabled() {
  if (settings.dismissed.noWarnigUploadDisabled) return;
  const message = t('The option `%@` must be enabled first to automatically upload images.').replace('%@', t('Allow upload images automatically based on YAML settings'));
  const buttons = [t('Enable this feature on preferences panel'), t('Close')];
  const res = platform.messageWithCheckbox
    ? await platform.messageWithCheckbox({ message, buttons, cancel: 1, style: 'warning', checkbox: t('Do not show this again') }).catch(() => null)
    : { index: await ask({ message, buttons, style: 'warning' }), checked: false };
  if (!res) return;
  if (res.checked) setPref({ dismissed: { ...settings.dismissed, noWarnigUploadDisabled: true } });
  if (res.index === 0) app.preferences('Image');
}

// The folder images are copied to, created on demand. Pasted image data
// needs a file even when the rule says "no special action".
async function imageDir(forData = false) {
  const target = imageTarget();
  let dir = null;
  if (doc.path && target.mode === 'copy') {
    const folder = (target.folder || './assets').replace(/\$\{filename\}/g, path.stem(doc.name));
    dir = folder.startsWith('/') ? folder : path.resolve(docDir(), folder);
  } else if (forData) dir = userImagesDir() || (doc.path ? path.resolve(docDir(), './assets') : null);
  if (!dir) return null;
  const st = await platform.stat(dir).catch(() => ({ exists: false }));
  if (st.exists && !st.isDir) {
    toast(t('%@ is a file, not a directory').replace('%@', dir), 5000);
    return null;
  }
  // A folder named by the document's front matter is only created after asking;
  // the one from Settings is created silently.
  if (!st.exists && target.fromYaml && isNative) {
    const pick = await ask({ message: t('Copy Images To…'), detail: t('The YAML front matter of this document sends new images to %@, but that folder does not exist. Create it now?').replace('%@', dir), buttons: [t('Create Folder and Continue'), t('Cancel')], style: 'warning' });
    if (pick !== 0) return null;
  }
  try {
    await platform.mkdir(dir);
    return dir;
  } catch (err) {
    toast(t('Failed to Copy Image to Target Folder.') + ` ${err.message || err}`, 5000);
    return null;
  }
}

// Images pasted or dropped as data: write them next to the document when it
// has a home, otherwise embed them.
async function handleImageFiles(files, { pasted = false } = {}) {
  // Files copied in Finder arrive as data too, but the clipboard also has
  // their paths: reference the originals, as a dropped file would be.
  if (pasted && isNative) {
    const clip = await platform.clipboardRead().catch(() => null);
    const paths = (clip?.filePaths || []).filter(isImageName);
    if (paths.length) {
      for (const p of paths) await placeImagePath(p);
      return;
    }
  }
  const uploading = imageTarget().mode === 'upload';
  const dir = uploading ? path.join(info.appSupport, 'uploads') : await imageDir(true);
  if (uploading) await platform.mkdir(dir).catch(() => {});
  for (const file of files) {
    try {
      const dataUrl = await toBase64(file);
      const ext = (/\.(\w+)$/.exec(file.name || '')?.[1] || file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      const named = file.name && !/^image\.\w+$/i.test(file.name);
      // Clipboard pictures are called image-<time>; named files keep their name.
      const base = named ? path.stem(file.name).replace(/[^\p{L}\p{N}_.-]+/gu, '-') : `image-${stamp()}`;
      if (dir) {
        let target = path.join(dir, `${base}.${ext}`);
        if ((await platform.stat(target)).exists) target = path.join(dir, `${base}-${stamp()}.${ext}`);
        await platform.writeBase64(target, dataUrl.slice(dataUrl.indexOf(',') + 1));
        blobCache.delete(target);
        if (uploading) insertImageRef((await uploadPaths([target]))[0], base);
        else insertImageRef(mdPath(target.startsWith(`${userImagesDir()}/`) ? target : imageRef(target)), altFor(target));
      } else {
        if (file.size > 1500000) toast(t('图片已内嵌进文档；先保存文档，之后粘贴的图片会存成文件'));
        insertImageRef(dataUrl, base);
      }
    } catch (err) {
      toast(t('无法插入图片：{0}', err.message || err));
    }
  }
}

// An image that already exists on disk (picked or dragged from Finder).

// --- images in the Markdown text ---------------------------------------------------
// Every picture address the text uses: ![…](src), <img src="…">, and the targets of
// reference definitions that pictures use (![alt][id] → [id]: src).
function imageSrcsIn(md) {
  const out = new Set();
  for (const m of md.matchAll(/!\[(?:\[[^\]]*\]|[^[\]])*\]\(\s*<?([^)\s>]+)/g)) out.add(m[1]);
  for (const m of md.matchAll(/<img\b[^>]*?\ssrc=["']([^"']+)["']/gi)) out.add(m[1]);
  const refs = new Set([...md.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g)].map((m) => (m[2] || m[1]).toLowerCase()));
  for (const m of md.matchAll(/^ {0,3}\[([^\]^][^\]]*)\]:\s*<?(\S+?)>?(?:\s|$)/gm)) if (refs.has(m[1].toLowerCase())) out.add(m[2]);
  return [...out];
}
// The text with one picture address replaced everywhere it is used as one.
function rewriteSrc(md, from, to) {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return md
    .replace(new RegExp(`(\\]\\(\\s*<?)${esc}(?=[>)\\s])`, 'g'), `$1${to}`)
    .replace(new RegExp(`(<img\\b[^>]*?\\ssrc=["'])${esc}(["'])`, 'gi'), `$1${to}$2`)
    .replace(new RegExp(`^( {0,3}\\[[^\\]^][^\\]]*\\]:\\s*<?)${esc}(?=>?(\\s|$))`, 'gm'), `$1${to}`);
}
// A free name in `dir` for `name` ("name-<time>.ext" when it is taken).
async function freeName(dir, name) {
  const dest = path.join(dir, name);
  if (!(await platform.stat(dest).catch(() => ({}))).exists) return dest;
  return path.join(dir, `${path.stem(name)}-${stamp()}${path.extname(name)}`);
}
// Asks before moving or deleting a picture file, with "Do not show this again".
async function confirmImageFileOp(key, message) {
  if (settings.dismissed[key]) return true;
  const buttons = [t('Continue'), t('取消')];
  const res = platform.messageWithCheckbox
    ? await platform.messageWithCheckbox({ message, buttons, cancel: 1, style: 'warning', checkbox: t('Do not show this again') }).catch(() => null)
    : { index: await ask({ message, buttons, style: 'warning' }), checked: false };
  if (!res || res.index !== 0) return false;
  if (res.checked) setPref({ dismissed: { ...settings.dismissed, [key]: true } });
  return true;
}
// A picture that is not a local file (on the web, or data:) saved into `dir`.
async function fetchImageInto(src, dir, alt = '') {
  if (/^data:image\/([\w+.-]+);base64,/i.test(src)) {
    const ext = { jpeg: 'jpg', 'svg+xml': 'svg' }[RegExp.$1.toLowerCase()] || RegExp.$1.toLowerCase();
    const base = (alt || '').replace(/[\\/:*?"<>|]+/g, '').trim() || new Date().toISOString().replace(/[:.]/g, '-');
    const dest = await freeName(dir, `${base}.${ext}`);
    await platform.writeBase64(dest, src.split(',')[1]);
    return dest;
  }
  if (/^https?:\/\//i.test(src) && platform.download) {
    const name = decodeURIComponent(new URL(src).pathname.split('/').pop() || '') || `image-${stamp()}.png`;
    const dest = await freeName(dir, /\.\w{2,5}$/.test(name) ? name : `${name}.png`);
    await platform.download(src, dest);
    return dest;
  }
  return null;
}

// Text copied in one document and pasted into another (in another folder): relative
// picture addresses are made to point at the same files from here.
function rebasePastedImages(text) {
  let origin = null;
  try {
    origin = JSON.parse(localStorage.getItem('livemark:copyOrigin') || 'null');
  } catch {
    origin = null;
  }
  const here = docDir() || '';
  if (!origin?.dir || origin.dir === here || !text.includes(origin.text.trim().slice(0, 200))) return text;
  let out = text;
  for (const src of imageSrcsIn(text)) {
    if (/^([a-z][\w+.-]*:|\/|#)/i.test(src)) continue;
    const abs = path.resolve(origin.dir, safeDecode(src.split(/[?#]/)[0]));
    const ref = here ? imageRef(abs) : abs;
    out = rewriteSrc(out, src, /\s/.test(ref) ? encodeURI(ref) : ref);
  }
  return out;
}

// After a paste: the image rules (Preferences > Image) apply to every pasted picture,
// local ones when "apply to local images" is on, web ones when "apply to online images" is.
async function applyRulesToPastedImages(text) {
  if (!isNative || !doc.path) return;
  const target = imageTarget();
  if (target.mode === 'keep') return;
  const jobs = [];
  for (const src of imageSrcsIn(text)) {
    const local = localPath(src);
    if (local && settings.imgRuleLocal) jobs.push({ src, local });
    else if (/^https?:\/\//i.test(src) && settings.imgRuleOnline) jobs.push({ src });
  }
  if (!jobs.length) return;
  const dir = target.mode === 'copy' ? await imageDir() : null;
  const done = [];
  for (const job of jobs) {
    try {
      if (target.mode === 'upload') {
        if (!job.local) continue;
        const [url] = await uploadPaths([job.local], { confirmed: true });
        done.push([job.src, url]);
      } else if (dir) {
        if (job.local && path.dirname(job.local) === dir) continue;
        if (job.local && !(await platform.stat(job.local).catch(() => ({}))).exists) continue;
        const dest = job.local ? await freeName(dir, path.basename(job.local)) : await fetchImageInto(job.src, dir);
        if (!dest) continue;
        if (job.local) await platform.copy(job.local, dest);
        done.push([job.src, mdPath(imageRef(dest))]);
      }
    } catch {
      /* that one stays as it was */
    }
  }
  if (!done.length) return;
  let md = editor.getMarkdown();
  for (const [from, to] of done) md = rewriteSrc(md, from, to);
  editor.replaceMarkdown(md, true);
}

async function placeImagePath(p) {
  const target = settings.imgRuleLocal ? imageTarget() : { mode: 'keep' };
  if (target.mode === 'upload') {
    try {
      insertImageRef((await uploadPaths([p]))[0], altFor(p));
      return;
    } catch (err) {
      toast(t('上传失败：{0}', err.message || err), 5000);
    }
  }
  const dir = target.mode === 'copy' ? await imageDir() : null;
  let dest = p;
  try {
    if (dir && path.dirname(p) !== dir) {
      dest = path.join(dir, path.basename(p));
      if ((await platform.stat(dest)).exists) dest = path.join(dir, `${path.stem(p)}-${stamp()}${path.extname(p)}`);
      await platform.copy(p, dest);
    }
  } catch (err) {
    toast(t('无法复制图片：{0}', err.message || err));
    dest = p;
  }
  insertImageRef(mdPath(imageRef(dest)), altFor(dest));
}

// How a local image file is written into the document: relative to it when
// that is sensible, absolute otherwise.
function imageRef(target) {
  const root = imageRoot();
  if (root && target.startsWith(`${root}/`)) return target.slice(root.length);
  if (!doc.path || !settings.imageRelative) return target;
  const rel = path.relative(docDir(), target);
  if (rel.startsWith('..') && rel.split('../').length > 4) return target;
  return settings.imgDotSlash && !rel.startsWith('.') ? `./${rel}` : rel;
}

// A pasted link to a picture on the web: with "apply the rules to online
// images" on, it is downloaded and treated like a local picture.
const ONLINE_IMAGE = /^(?:!\[([^\]]*)\]\()?(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:\?[^\s)]*)?)\)?$/i;
function pasteUrlWithTitle(text) {
  const url = (text || '').trim();
  if (!isNative || !/^https?:\/\/\S+$/i.test(url)) return false;
  const sel = editor.getSel();
  const b = sel && editor.doc[sel.focus.i];
  if (!b || ['code', 'math', 'html', 'meta'].includes(b.type)) return false;
  platform.clipboardRead().then((clip) => {
    const title = (clip?.urlTitle || '').trim();
    editor.insertText(title && clip?.url?.trim() === url ? `[${title.replace(/[[\]]/g, '\\$&')}](${url})` : url);
  }, () => editor.insertText(url));
  return true;
}

function pasteOnlineImage(text, html) {
  if (!settings.imgRuleOnline || !platform.download || !doc.path || imageTarget().mode === 'keep') return false;
  const fromHtml = html && /^\s*(?:<meta[^>]*>)?\s*<img[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>\s*$/i.exec(html);
  const m = fromHtml ? [null, '', fromHtml[1]] : ONLINE_IMAGE.exec((text || '').trim());
  if (!m) return false;
  (async () => {
    try {
      const uploading = imageTarget().mode === 'upload';
      const dir = uploading ? path.join(info.appSupport, 'uploads') : await imageDir(true);
      const name = safeDecode(path.basename(m[2].split(/[?#]/)[0])) || `image-${stamp()}.png`;
      let dest = path.join(dir, /\.\w+$/.test(name) ? name : `${name}.png`);
      if ((await platform.stat(dest)).exists) dest = path.join(dir, `${path.stem(dest)}-${stamp()}${path.extname(dest)}`);
      await platform.download(m[2], dest);
      insertImageRef(uploading ? (await uploadPaths([dest]))[0] : mdPath(imageRef(dest)), m[1] || '');
    } catch (err) {
      toast(t('无法下载图片：{0}', err.message || err), 4000);
      insertImageRef(m[2], m[1] || '');
    }
  })();
  return true;
}

// Moving a document into a TextBundle takes its local pictures along.
async function adoptImagesInto(bundle, fromDir) {
  let md = editor.getMarkdown();
  const moved = new Map();
  for (const m of md.matchAll(/!\[[^\]]*\]\(<?([^)\s>]+)/g)) {
    const src = m[1];
    if (moved.has(src) || /^(https?:|data:|blob:)/i.test(src)) continue;
    const from = src.startsWith('/') ? safeDecode(src) : path.resolve(fromDir, safeDecode(src));
    if (from.startsWith(`${bundle}/`)) continue;
    try {
      const to = path.join(bundle, 'assets', path.basename(from));
      await platform.copy(from, to);
      moved.set(src, mdPath(`assets/${path.basename(from)}`));
    } catch {
      /* a picture that cannot be read keeps its old reference */
    }
  }
  if (!moved.size) return;
  for (const [src, to] of moved) md = md.split(`](${src}`).join(`](${to}`);
  doc.path = bundle;
  loadInto(md);
  await platform.writeText(await bundleTextFile(bundle), outText());
}

const quote = (v) => `"${String(v).replace(/(["\\$`])/g, '\\$1')}"`;
// Run a shell command through the host; resolves to { code, stdout, stderr }.
const sh = (command, files = []) => platform.upload(command, files);

// Uploading hands the image paths to another program. Say so once.
async function confirmUpload() {
  if (settings.dismissed.upload) return true;
  const pick = await ask({ message: t('Upload Image'), detail: t('Livemark will launch a 3rd party app with file paths of all local images. The image uploader and cloud image storage will then have access to your local images. Are you sure to continue?'), buttons: [t('Continue'), t('Cancel'), t('Do not show this again')], style: 'warning' });
  if (pick === 2) setPref({ dismissed: { ...settings.dismissed, upload: true } });
  return pick === 0 || pick === 2;
}

// Run the upload tool; it prints one URL per image.
// The addresses an uploader printed, one per line: http(s), ftp or file URLs, or a bare
// "host.tld/path" (taken as http).
function uploadedUrls(stdout) {
  return stdout.split('\n').map((l) => l.trim()).filter((l) => /^(https?|ftp|file):\/\//i.test(l) || /^[\w-]+(\.[\w-]+)+\/\S+$/.test(l)).map((l) => (/^[\w-]+(\.[\w-]+)+\//.test(l) ? `http://${l}` : l));
}

async function uploadPaths(paths, { confirmed = false } = {}) {
  if (!confirmed && !(await confirmUpload())) throw new Error(t('Cancelled'));
  const command = uploaderCommand();
  // A command with ${filepath} / ${filename} runs once per picture with it filled in.
  if (/\$\{file(path|name)\}/.test(command)) {
    const urls = [];
    for (const p of paths) {
      const one = command.replace(/\$\{filepath\}/g, quote(p)).replace(/\$\{filename\}/g, quote(path.basename(p)));
      const res = await sh(one, []);
      const url = uploadedUrls(res.stdout).pop();
      if (res.code !== 0 || !url) throw new Error((res.stderr || res.stdout).trim().split('\n').pop() || `exit ${res.code}`);
      urls.push(url);
    }
    return urls;
  }
  const res = await sh(command, paths);
  const urls = uploadedUrls(res.stdout).slice(-paths.length);
  if (res.code !== 0 || urls.length !== paths.length) throw new Error((res.stderr || res.stdout).trim().split('\n').pop() || `exit ${res.code}`);
  return urls;
}

// Upload a generated picture and show what the tool printed.
async function testUploader() {
  if (!app.canUpload()) return toast(t('Please set an image uploader in Preferences panel before using this function.'));
  const dir = path.join(info.appSupport, 'uploads');
  const file = path.join(dir, 'livemark-upload-test.png');
  const canvas = Object.assign(document.createElement('canvas'), { width: 240, height: 120 });
  const g = canvas.getContext('2d');
  g.fillStyle = '#4183c4';
  g.fillRect(0, 0, 240, 120);
  g.fillStyle = '#fff';
  g.font = '20px sans-serif';
  g.fillText('Livemark', 78, 66);
  await platform.mkdir(dir).catch(() => {});
  await platform.writeBase64(file, canvas.toDataURL('image/png').split(',')[1]);
  const command = uploaderCommand();
  toast(t('Running… Waiting for results.'));
  const res = await sh(command, [file]).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message || err) }));
  const ok = res.code === 0 && /^https?:\/\//m.test(res.stdout);
  return modal({ title: t(ok ? 'Validation Succeed' : 'Validation Failed'), wide: true, body: [
    h('p', {}, t(ok ? 'Successfully get uploaded image url.' : 'Failed to fetch uploaded image from command output.')),
    h('p', { class: 'dialog-detail' }, t('Testing image uploading using command:')), h('pre', { class: 'version-preview' }, `${command} ${quote(file)}`),
    h('p', { class: 'dialog-detail' }, t(res.stderr.trim() && !ok ? 'Error from the console:' : 'Output from the console:')), h('pre', { class: 'version-preview' }, (ok ? res.stdout : res.stderr || res.stdout).trim() || `exit ${res.code}`),
  ] });
}

// Upload commands with no uploader chosen: say where to choose one.
async function requireUploader() {
  if (app.canUpload()) return true;
  await ask({ message: t('Please set an image uploader in Preferences panel before using this function.'), style: 'warning' });
  return false;
}

async function uploadImage() {
  if (!(await requireUploader())) return;
  const img = editor.imageAtCaret();
  const p = img && localPath(img.src);
  if (!p) return toast(t('没有可上传的本地图片'));
  try {
    showHint({ title: t('Uploading in progress…') });
    const [url] = await uploadPaths([p]);
    $('#hint-bar')?.classList.remove('show');
    // One picture: Typora says nothing when it works.
    editor.replaceImage(img, img.isHtml ? img.text.replace(img.src, url) : `![${img.alt}](${url})`);
    return null;
  } catch (err) {
    return uploadError(err, 'Failed to upload image. Error Message:');
  }
}

async function uploadAllImages() {
  if (!(await requireUploader())) return;
  let md = editor.getMarkdown();
  const found = new Map();
  for (const src of imageSrcsIn(md)) {
    const p = localPath(src);
    if (p && !found.has(src)) found.set(src, p);
  }
  if (!found.size) return showHint({ title: t('No local images found.') });
  showHint({ title: t('Uploading in progress…') });
  const srcs = [...found.keys()];
  let urls;
  let lastError = null;
  try {
    urls = await uploadPaths([...found.values()]);
  } catch (err) {
    if (String(err?.message) === t('Cancelled')) return null;
    // Not every picture came back: try them one by one, so the ones that work are still replaced.
    lastError = err;
    urls = [];
    for (const p of found.values()) urls.push(await uploadPaths([p], { confirmed: true }).then((u) => u[0], (e) => ((lastError = e), null)));
  }
  const done = urls.filter(Boolean).length;
  if (!done) return uploadError(lastError, 'Failed to upload images:');
  srcs.forEach((src, k) => {
    if (urls[k]) md = rewriteSrc(md, src, urls[k]);
  });
  // One undoable step, offered back right in the notification (as in Typora).
  if (sourceMode) loadInto(md);
  else editor.replaceMarkdown(md);
  const title = done === srcs.length ? t('Successfully uploaded {0} images.', done) : t('Successfully uploaded {0} images, {1} failed.', done, srcs.length - done);
  return showHint({ title, actions: [{ label: t('Undo'), run: () => editor.undo() }] });
}

// Upload failures show the uploader's message (cut at 600 characters) in the notification bar.
function uploadError(err, lead) {
  const msg = String(err?.message || err || '');
  showHint({ title: `${t(lead)} <code class="hint-code">${escHtml(msg.length > 600 ? `${msg.slice(0, 600)}…` : msg)}</code>` });
}

// --- the image file under the caret ---------------------------------------------

function localImageAtCaret() {
  const img = editor.imageAtCaret();
  const p = img && localPath(img.src);
  return p ? { img, file: p } : null;
}

const withSrc = (img, src) => (img.isHtml ? img.text.replace(img.src, src) : `![${img.alt}](${src})`);

// Undo of a change that moved picture files moves them back (and redo again).
function undoableMoves(pairs) {
  const swap = async (list) => {
    for (const [from, to] of list) {
      if ((await platform.stat(from).catch(() => ({}))).exists && !(await platform.stat(to).catch(() => ({}))).exists) await platform.rename(from, to).catch(() => {});
    }
    editor.rerenderAll();
  };
  editor.attachEffect({ undo: () => swap(pairs.map(([a, b]) => [b, a]).reverse()), redo: () => swap(pairs) });
}

async function deleteImageFile() {
  const hit = localImageAtCaret();
  if (!hit) return;
  if (!(await confirmImageFileOp('noWarningForDeleteImage', `${t('Are you sure you want to delete {0}?', path.basename(hit.file))} ${t('You can restore from the Trash.')}`))) return;
  try {
    // A copy is kept so that Undo can put the file back.
    let keep = null;
    if (isNative && info.appSupport) {
      keep = path.join(info.appSupport, 'image-undo', `${Date.now()}-${path.basename(hit.file)}`);
      await platform.mkdir(path.dirname(keep));
      await platform.copy(hit.file, keep).catch(() => (keep = null));
    }
    const file = hit.file;
    await platform.trash(file);
    editor.replaceImage(hit.img, '');
    if (keep) {
      editor.attachEffect({
        undo: async () => {
          if (!(await platform.stat(file).catch(() => ({}))).exists) await platform.copy(keep, file).catch(() => {});
          editor.rerenderAll();
        },
        redo: () => platform.trash(file).catch(() => {}),
      });
    }
  } catch (err) {
    toast(t('无法删除：{0}', err.message || err));
  }
}

// Copy the picture somewhere, or rename / move it, and point the document
// at the new place.
async function relocateImage(move) {
  const hit = localImageAtCaret();
  const pic = !hit && editor.imageAtCaret();
  if (pic && !move) {
    const to = await platform.pickFolder?.();
    if (!to) return;
    try {
      const dest = await fetchImageInto(pic.src, to, pic.alt);
      if (dest) editor.replaceImage(pic, withSrc(pic, mdPath(imageRef(dest))));
    } catch (err) {
      toast(t('无法复制图片：{0}', err.message || err));
    }
    return;
  }
  if (!hit) return;
  if (move && !(await confirmImageFileOp('noWarningForMoveImage', t('Move image will delete the image file at original path, are you sure to continue?')))) return;
  const ext = path.extname(hit.file).slice(1);
  const to = await platform.pickSave({ suggestedName: path.basename(hit.file), directory: path.dirname(hit.file), extensions: ext ? [ext] : undefined });
  if (!to || to === hit.file) return;
  try {
    await (move ? platform.rename(hit.file, to) : platform.copy(hit.file, to));
    editor.replaceImage(hit.img, withSrc(hit.img, mdPath(imageRef(to))));
    if (move) undoableMoves([[hit.file, to]]);
    toast(t(move ? 'Images moved to {0}.' : 'Images copied to {0}.', path.dirname(to)));
  } catch (err) {
    toast(t(move ? '无法移动：{0}' : '无法复制图片：{0}', err.message || err));
  }
}

// A one-line hint at the top of the editor, with "Do not show this again" and Dismiss
// (Typora's notification bar). A hint whose key is in the dismissed list stays hidden.
function showHint({ key, title, body = '', actions = null, onLink = null, ticked = false }) {
  if (key && settings.dismissed[key]) return;
  let bar = $('#hint-bar');
  if (!bar) {
    bar = h('div', { id: 'hint-bar', role: 'status' });
    document.body.append(bar);
  }
  const head = h('p', { class: 'hint-title' });
  head.innerHTML = title;
  const check = h('input', { type: 'checkbox' });
  check.checked = false;
  check.addEventListener('change', () => setPref({ dismissed: { ...settings.dismissed, [key]: check.checked } }));
  // A hint meant to be seen once comes with the box already ticked (and saved).
  if (ticked && key) {
    check.checked = true;
    setPref({ dismissed: { ...settings.dismissed, [key]: true } });
  }
  const close = h('button', { type: 'button', class: 'hint-dismiss' }, t('Dismiss'));
  close.addEventListener('click', () => bar.classList.remove('show'));
  // Notifications may carry their own buttons (Create File…) or a link to follow.
  const buttons = (actions || []).map(({ label, run }) => {
    const b = h('button', { type: 'button', class: 'hint-dismiss' }, label);
    b.addEventListener('click', () => {
      bar.classList.remove('show');
      run();
    });
    return b;
  });
  if (onLink) head.querySelector('a')?.addEventListener('click', (e) => {
    e.preventDefault();
    bar.classList.remove('show');
    onLink();
  });
  bar.replaceChildren(head, h('div', { class: 'hint-row' }, h('div', { class: 'hint-body' }, body || '\u00a0'),
    key ? h('label', { class: 'hint-suppress' }, check, t('Do not show this again')) : null, ...buttons, close));
  bar.classList.add('show');
}

// After a zoom step, a small panel at the top right shows the factor with −, + and
// Reset buttons for three seconds, as Typora does.
let zoomHintTimer = null;
function showZoomHint() {
  let el = $('#zoom-hint');
  if (!el) {
    const btn = (cls, label, dir, text = '') => {
      const b = h('span', { class: `zoom-hint-button ${cls}`, role: 'button', 'aria-label': label }, text);
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        app.zoom(dir);
      });
      return b;
    };
    el = h('div', { id: 'zoom-hint', role: 'status' }, h('span', { class: 'zoom-hint-current' }), btn('zoom-hint-minus', t('Zoom Out'), -1), btn('zoom-hint-plus', t('Zoom In'), 1), btn('zoom-hint-reset', t('Actual Size'), 0, t('Reset')));
    document.body.append(el);
  }
  el.querySelector('.zoom-hint-current').textContent = `${String(settings.zoom * 100).replace(/\..+/, '')}%`;
  el.classList.add('show');
  document.body.classList.add('on-zoom');
  clearTimeout(zoomHintTimer);
  zoomHintTimer = setTimeout(() => {
    el.classList.remove('show');
    document.body.classList.remove('on-zoom');
  }, 3000);
}

// --- the picture popover ---------------------------------------------------------
// When a Markdown picture the caret sits in finishes loading (one just inserted
// or typed), a small menu under the caret offers what to do with it: copy or move
// the file into the image folder, upload it, zoom it. It closes once the caret
// leaves the picture. Pixel ratios found here also give the right-click menu its
// "Zoom Image to 50%".
const imageRatios = new Map();
let quietImageUrl = '';
let imagePopover = null;

const srcKey = (img) => (img.getAttribute('src') || '').replace(/\?(.+)$/, '');
const usefulRatio = (r) => (Number.isFinite(r) && r > 0 && r !== 1 ? r : null);

function imageRatio(imgEl) {
  const r = imgEl && usefulRatio(imageRatios.get(srcKey(imgEl)));
  return r ? `${Math.round(100 / r)}%` : null;
}

// The folder the image rule copies into, without creating it.
function imageTargetDir() {
  const target = imageTarget();
  if (!doc.path || target.mode !== 'copy') return null;
  const folder = (target.folder || './assets').replace(/\$\{filename\}/g, path.stem(doc.name));
  return folder.startsWith('/') ? folder : path.resolve(docDir(), folder);
}

// The image folder's name, when a picture is not directly inside it yet ("Copy to assets").
function imageFolderName(pic) {
  const dir = imageTargetDir();
  if (!dir || !pic) return null;
  const file = localPath(pic.src) || pic.src;
  return path.dirname(file) !== dir ? path.basename(dir) : null;
}

const caretIn = (tok) => {
  const sel = getSelection();
  return !!(sel.rangeCount && tok.isConnected && sel.anchorNode && tok.contains(sel.anchorNode));
};

function afterImageLoaded(img) {
  const tok = img.closest('.tok');
  const key = srcKey(img);
  if (!tok || key === quietImageUrl || !caretIn(tok)) return;
  const pic = editor.imageAtCaret(img);
  if (!pic) return;
  const items = [];
  if (!(doc.path && (isBundle(doc.path) || isPack(doc.path)))) {
    const dir = imageTargetDir();
    let folder = null;
    if (dir) {
      const file = localPath(pic.src) || pic.src;
      if (path.dirname(file) !== dir) folder = path.basename(dir);
      else quietImageUrl = key;
    }
    if (folder) items.push({ title: t('Copy to {0}', folder), run: () => copyImageToTarget(false) });
    items.push({ title: t('Copy Image to…'), run: () => relocateImage(false) });
    if (folder) items.push({ title: t('Move to {0}', folder), run: () => copyImageToTarget(true) });
    items.push({ title: t('Rename or Move Image to…'), run: () => relocateImage(true) });
    if (app.canUpload()) {
      const upload = { title: t('Upload Image'), run: () => uploadImage() };
      if (imageTarget().mode === 'upload') items.unshift(upload);
      else items.push(upload);
    }
  }
  const show = () => {
    // Only for a Markdown picture the caret is still in, and not while it is being moved.
    if (!caretIn(tok) || editor.imageAtCaret(img)?.isHtml) return;
    setTimeout(() => {
      const sel = getSelection();
      if (!sel.rangeCount || !caretIn(tok)) return;
      const range = sel.getRangeAt(0).cloneRange();
      let rects = range.getClientRects();
      let rect = rects.length && rects[rects.length - 1];
      if (!rect || (!rect.left && !rect.height)) {
        range.selectNodeContents(range.commonAncestorContainer);
        rects = range.getClientRects();
        rect = rects.length && rects[rects.length - 1];
      }
      if (!rect || (!rect.left && !rect.height)) return;
      const menu = showMenu([...items, ...commands.zoomItems(img).filter(Boolean)], 0, 0);
      menu.classList.add('image-popover', 'show');
      const blockLeft = tok.closest('[data-id]')?.getBoundingClientRect().left || 0;
      menu.style.top = `${rect.bottom}px`;
      menu.style.left = `${Math.max(blockLeft, rect.right - menu.offsetWidth + 20)}px`;
      imagePopover = menu;
      const follow = () => {
        if (!menu.isConnected) {
          els.scroller.removeEventListener('scroll', follow);
          window.removeEventListener('resize', follow);
          return;
        }
        const r = img.getBoundingClientRect();
        menu.style.top = `${r.bottom}px`;
        menu.style.left = `${Math.max(tok.closest('[data-id]')?.getBoundingClientRect().left || 0, r.right - menu.offsetWidth + 20)}px`;
      };
      els.scroller.addEventListener('scroll', follow, { passive: true });
      window.addEventListener('resize', follow);
    }, 100);
  };
  show();
  if (isNative && platform.imageScale && !imageRatios.has(key)) {
    platform.imageScale(localPath(pic.src) || pic.src).then((r) => {
      imageRatios.set(key, Number(r));
      if (usefulRatio(Number(r))) show();
    }, () => {});
  }
}

// The popover goes away once the caret is no longer in a picture.
document.addEventListener('selectionchange', () => {
  if (!imagePopover) return;
  if (!imagePopover.isConnected) {
    imagePopover = null;
    return;
  }
  if (!editor.imageAtCaret()) {
    closeMenus();
    imagePopover = null;
  }
});

// "Copy to <folder>" / "Move to <folder>": put the picture's file into the folder
// the image rule uses and point the picture at it. Moving asks first, as it
// removes the original.
async function copyImageToTarget(move) {
  const hit = localImageAtCaret();
  const pic = !hit && editor.imageAtCaret();
  // A picture from the web (or a data: one) is saved into the folder.
  if (pic) {
    const dir = await imageDir();
    if (!dir) return;
    try {
      const dest = await fetchImageInto(pic.src, dir, pic.alt);
      if (dest) editor.replaceImage(pic, withSrc(pic, mdPath(imageRef(dest))));
    } catch (err) {
      toast(t('无法复制图片：{0}', err.message || err));
    }
    return;
  }
  const dir = hit && (await imageDir());
  if (!dir) return;
  if (move && !(await confirmImageFileOp('noWarningForMoveImage', t('Move image will delete the image file at original path, are you sure to continue?')))) return;
  let dest = path.join(dir, path.basename(hit.file));
  if (dest === hit.file) return;
  try {
    if ((await platform.stat(dest)).exists) dest = path.join(dir, `${path.stem(hit.file)}-${stamp()}${path.extname(hit.file)}`);
    await (move ? platform.rename(hit.file, dest) : platform.copy(hit.file, dest));
    editor.replaceImage(hit.img, withSrc(hit.img, mdPath(imageRef(dest))));
    if (move) undoableMoves([[hit.file, dest]]);
  } catch (err) {
    toast(t(move ? '无法移动：{0}' : '无法复制图片：{0}', err.message || err));
  }
}

// "When Insert Local Image" in the Format menu is a per-document choice,
// kept in the front matter.
async function setDocImageAction(kind) {
  if (kind === 'upload') return setFrontMatter('typora-copy-images-to', 'upload');
  if (kind === 'keep') {
    setFrontMatter('typora-copy-images-to', null);
    if (settings.imageAction !== 'keep') setPref({ imageAction: 'keep' });
    return null;
  }
  if (!doc.path) {
    // The folder is written relative to the document, which needs a place on disk first.
    await ask({ message: t('Document must be saved first.'), detail: t('New images are copied to a folder relative to this document, so save it first.') });
    return null;
  }
  const dir = isNative ? await platform.pickFolder() : './assets';
  if (!dir) return null;
  const rel = dir.startsWith('/') ? path.relative(docDir(), dir) : dir;
  return setFrontMatter('typora-copy-images-to', rel.startsWith('..') && rel.split('../').length > 4 ? dir : rel === '.' ? './' : rel);
}

async function setImageRoot() {
  if (frontMatter()['typora-root-url']) return setFrontMatter('typora-root-url', null);
  const dir = await platform.pickFolder();
  return dir ? setFrontMatter('typora-root-url', dir) : null;
}

// Put the picture itself on the clipboard.
async function copyImageContent(el = null) {
  const img = el || els.write.querySelector('.tok[data-open] > img') || els.write.querySelector('.tok[data-t="image"] > img');
  const fromCaret = editor.imageAtCaret();
  const src = el ? el.getAttribute('src') : fromCaret?.src;
  try {
    const p = !el && src ? localPath(src) : null;
    if (isNative && p) await platform.clipboardWriteImage(p);
    else {
      if (!img) throw new Error('no image');
      const canvas = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
      canvas.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }
    toast(t('已复制图片'));
  } catch {
    toast(t('无法复制图片内容'));
  }
}

// Align the columns of the current table in the Markdown source.
function prettifyTable() {
  const cell = editor.currentCell();
  if (!cell) return;
  const sel = editor.sel();
  editor.apply(editor.doc.map((b, k) => (k === cell.i ? { ...b, pretty: true } : b)), sel && { anchor: sel.anchor, focus: sel.focus });
}

async function insertImageFromFile(multiple = false) {
  if (isNative) {
    const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'tiff', 'heic'];
    const picked = multiple ? await platform.pickFiles({ extensions }) : [await platform.pickFile({ extensions })];
    for (const p of picked.filter(Boolean)) {
      await placeImagePath(p);
      if (multiple) editor.insertText('\n');
    }
    return;
  }
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true });
  input.onchange = () => handleImageFiles([...input.files]);
  input.click();
}

function revealImage() {
  const img = editor.imageAtCaret();
  const p = img && localPath(img.src);
  if (p && isNative) platform.reveal(p);
  else if (img) openLink(img.src);
}

// Copy every local image into one folder and point the document at the copies.
async function collectImages(move = false) {
  if (!doc.path) return toast(t('请先保存文档'));
  const dir = await platform.pickFolder();
  if (!dir) return null;
  let md = editor.getMarkdown();
  if (move && !(await confirmImageFileOp('noWarningForMoveImage', t('Move image will delete the image file at original path, are you sure to continue?')))) return null;
  const seen = new Map();
  const moved = [];
  for (const src of imageSrcsIn(md)) {
    const from = localPath(src);
    if (!from || seen.has(src)) continue;
    try {
      const to = path.dirname(from) === dir ? from : await freeName(dir, path.basename(from));
      if (from !== to) await (move ? platform.rename(from, to) : platform.copy(from, to));
      if (move && from !== to) moved.push([from, to]);
      seen.set(src, mdPath(imageRef(to)));
    } catch {
      /* skip images that cannot be read; their links stay as they were */
    }
  }
  if (!seen.size) return showHint({ title: t('No local images found.') });
  for (const [src, to] of seen) md = rewriteSrc(md, src, to);
  if (sourceMode) loadInto(md);
  else {
    editor.replaceMarkdown(md);
    if (moved.length) undoableMoves(moved);
  }
  return showHint({ title: t(move ? 'Images moved to %@.' : 'Images copied to %@.').replace('%@', `<code class="hint-code">${escHtml(dir)}</code>`) });
}

// --- links ------------------------------------------------------------------------

function linkAtCaret() {
  const node = window.getSelection().focusNode;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const def = el?.closest('a.def-url');
  if (def) return def.getAttribute('href');
  return el?.closest('.tok[data-t="link"], .tok[data-t="url"]')?.querySelector('a')?.getAttribute('href') || null;
}

async function openLink(href) {
  if (!href || href === '#') return;
  if (href.startsWith('#')) {
    const i = findAnchor(editor.doc, safeDecode(href.slice(1)));
    if (i >= 0) editor.focusBlock(i);
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    platform.openExternal(href);
    return;
  }
  if (/^(data:|blob:|livemark:)/i.test(href)) {
    window.open(href, '_blank');
    return;
  }
  // Any other scheme (zotero://, obsidian://, ftp://, x-devonthink-item://…) goes to the
  // app that handles it; a script URL does nothing.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(file|[a-z]):/i.test(href)) {
    if (!/^(javascript|vbscript):/i.test(href)) platform.openURL ? platform.openURL(href).catch(() => toast(t('无法打开这个链接'))) : platform.openExternal(href);
    return;
  }
  const [file, anchor] = href.split('#');
  const p = localPath(file);
  if (!p) return toast(t('无法打开这个链接'));
  // As Typora resolves a local link: the path itself, else with .md / .markdown /
  // .textbundle / .textpack added.
  for (const c of [p, `${p}.md`, `${p}.markdown`, `${p}.textbundle`, `${p}.textpack`]) {
    const st = isNative ? await platform.stat(c).catch(() => ({ exists: false })) : { exists: c === p };
    if (!st.exists) continue;
    if (isMarkdownName(c) || isBundle(c) || isPack(c)) {
      if ((await openPath(c)) && anchor) openLink(`#${anchor}`);
    } else if (st.isDir && !/\.app$/i.test(c)) openFolder(c);
    // A program or script is shown in Finder rather than run from a link.
    else if (isNative && (/\.(app|command|sh|tool|pkg|mpkg|scpt|workflow|action|terminal|exe|bat|cmd)$/i.test(c) || st.executable)) platform.reveal(c);
    else if (isNative) platform.openExternal(c);
    return;
  }
  // Nothing there: offer to create it when it looks like a document (or has no
  // extension at all), otherwise suggest it was meant as a web address.
  const ext = path.extname(p).slice(1).toLowerCase();
  const head = file.split(/[\\/]/)[0];
  const creatable = ext ? MD_EXT.includes(ext) : !head.includes('.');
  if (creatable) {
    const create = async (asFolder) => {
      try {
        if (asFolder) {
          await platform.mkdir(p);
          openFolder(p);
        } else {
          const target = ext ? p : `${p}.md`;
          await platform.mkdir(path.dirname(target));
          await platform.writeText(target, '');
          openPath(target);
        }
      } catch (err) {
        toast(err.message || String(err), 4000);
      }
    };
    showHint({
      title: t('Cannot open location <code>$1</code>, would you want to create file at <code>$2</code> and continue?').replace('$1', escHtml(file)).replace('$2', escHtml(ext ? p : `${p}.md`)),
      actions: ext ? [{ label: t('Create File'), run: () => create(false) }] : [{ label: t('Create Folder'), run: () => create(true) }, { label: t('Create File'), run: () => create(false) }],
    });
  } else {
    const web = (/^\S+@\S+\.\S+$/.test(href) && !/[\\/]/.test(href) ? 'mailto:' : 'https://') + href;
    showHint({
      title: t("Cannot open location <code>$1</code>, do you mean <a href='$3' target='_blank'>$2</a> ?").replace('$3', escHtml(web)).replace('$2', escHtml(web)).replace('$1', escHtml(p)),
      onLink: () => platform.openExternal(web),
    });
  }
}
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// --- export, import, print --------------------------------------------------------

let cssCache = null;
async function exportCss() {
  if (!cssCache) cssCache = (await Promise.all(['./vendor/fonts/fonts.css', './styles/editor.css', './styles/themes.css'].map((u) => fetch(u).then((r) => r.text())))).join('\n');
  // The user's themes (each scoped to its data-theme), base.user.css, <theme>.user.css and
  // Settings > Custom CSS travel with the page. A theme can ask for more with a comment
  // `@include-when-export url(…)`, which becomes an @import.
  const user = [...document.querySelectorAll('style[data-user-theme]')].map((el) => el.textContent);
  const imports = user.flatMap((css) => [...css.matchAll(/@include-when-export\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => `@import url("${m[2]}");`));
  return [...new Set(imports), cssCache, ...user, settings.customCss || ''].join('\n');
}
const diagramSvg = (b) => {
  const el = [...els.write.children].find((x) => x.dataset.id === b.id);
  return el?.querySelector('.preview svg')?.outerHTML || '';
};

// In-document links in an exported PDF: each link and its destination get a private
// address while WebKit prints, and the PDF step turns the pair into a page jump.
// Covers #heading links, [TOC] entries, footnote references and their back links.
async function withPdfLinks(fn) {
  const write = els.write;
  const undo = [];
  const marks = new Map();
  const target = (el) => {
    if (!el) return null;
    if (!marks.has(el)) {
      const id = String(marks.size);
      const mark = h('a', { class: 'pdf-mark', href: `livemark-pdf:to-${id}`, style: 'display:inline-block;width:1px;height:1px;overflow:hidden;vertical-align:top' }, '\u200b');
      el.prepend(mark);
      undo.push(() => mark.remove());
      marks.set(el, id);
    }
    return marks.get(el);
  };
  const link = (el, dest) => {
    const id = target(dest);
    if (id == null) return;
    const to = `livemark-pdf:from-${id}`;
    if (el.tagName === 'A') {
      const had = el.getAttribute('href');
      el.setAttribute('href', to);
      undo.push(() => (had == null ? el.removeAttribute('href') : el.setAttribute('href', had)));
    } else {
      const a = h('a', { href: to, style: 'color:inherit;text-decoration:none' });
      el.replaceWith(a);
      a.append(el);
      undo.push(() => a.replaceWith(el));
    }
  };
  const byId = (id) => write.querySelector(`.b[data-id="${CSS.escape(id)}"]`);
  const heading = (name) => {
    const i = findAnchor(editor.doc, safeDecode(name));
    return (i >= 0 && write.children[i]) || [...write.querySelectorAll('[id]')].find((el) => el.id === name) || null;
  };
  const def = (label) => write.querySelector(`.fn-back[data-label="${CSS.escape(label)}"]`)?.closest('.b');
  const ref = (label) => write.querySelector(`sup.fn-view[data-label="${CSS.escape(label)}"]`);
  for (const a of write.querySelectorAll('.tok a[href^="#"]')) link(a, heading(a.getAttribute('href').slice(1)));
  for (const a of write.querySelectorAll('.toc-item[data-id]')) link(a, byId(a.dataset.id));
  for (const sup of [...write.querySelectorAll('sup.fn-view[data-label]')]) link(sup, def(sup.dataset.label));
  for (const back of write.querySelectorAll('.fn-back[data-label]')) link(back, ref(back.dataset.label));
  try {
    return await fn();
  } finally {
    undo.reverse().forEach((f) => f());
  }
}

// Lay the page out as a printable document, run `fn`, then restore. `cfg` is the
// export entry's settings (theme, page breaks, font size for images).
async function withPrintLayout(fn, cfg = configOf(settings, 'pdf', 'pdf'), meta = exportMeta(cfg)) {
  if (sourceMode) toggleSource(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  editor.setFocusBlock(-1);
  editor.updateExpand(null);
  document.body.classList.add('printing');
  document.body.classList.toggle('print-ignore-breaks', !settings.exportBreaks);
  document.body.classList.toggle('page-break-h1', !!cfg.splitPages);
  const screenTheme = document.documentElement.dataset.theme;
  const theme = meta.theme || cfg.exportTheme;
  if (theme) document.documentElement.dataset.theme = theme;
  if (theme && theme !== screenTheme) await diagramsInTheme(theme, { keep: true });
  // A video prints as its poster, or as its first frame (loaded for the occasion).
  await Promise.all([...els.write.querySelectorAll('video:not([poster])')].map((v) => new Promise((done) => {
    if (v.readyState >= 2) return done();
    v.preload = 'auto';
    v.addEventListener('loadeddata', done, { once: true });
    v.addEventListener('error', done, { once: true });
    v.load();
    setTimeout(done, 1500);
  })));
  // Wait for the new layout to be painted. Animation frames do not fire in
  // a hidden or minimised window, so a timer backs them up.
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
    setTimeout(resolve, 150);
  });
  try {
    return await fn();
  } finally {
    document.body.classList.remove('printing', 'page-break-h1', 'print-ignore-breaks');
    document.documentElement.dataset.theme = screenTheme;
    if (theme && theme !== screenTheme) diagramsInTheme(screenTheme, { keep: true });
  }
}

// Printing does not carry background colours, so a dark theme prints badly: Typora
// warns and offers the default theme or a PDF export instead.
async function printDoc() {
  const cfg = configOf(settings, 'pdf', 'pdf');
  if (isDark() && !cfg.exportTheme && isNative) {
    const pick = await ask({ message: t("Sorry, current version of Livemark won't print background color.\nSo dark theme is not yet supported for printing. \n\nPlease choose a light theme or export this document to PDF."), buttons: [t('Print with default theme'), t('Export to PDF'), t('Cancel')], style: 'warning' });
    if (pick === 1) return exportAs('pdf');
    if (pick !== 0) return null;
    return withPrintLayout(() => platform.print({ splitPages: !!cfg.splitPages, splitLabel: t('Start each top-level heading on a new page') }), { ...cfg, exportTheme: 'github' });
  }
  await withPrintLayout(() => platform.print({ splitPages: !!cfg.splitPages, splitLabel: t('Start each top-level heading on a new page') }), cfg);
}

// The document as Pandoc gets it: [TOC] becomes a list of links to the headings (given
// explicit ids), and rendered diagrams become pictures of themselves.
async function pandocInput() {
  const list = editor.doc;
  const heads = list.filter((b) => b.type === 'h');
  const hasToc = list.some((b) => b.type === 'toc');
  const out = [];
  let shot = 0;
  const shots = isNative && platform.snapshot && info.appSupport ? path.join(info.appSupport, 'export-diagrams') : null;
  if (shots) await platform.mkdir(shots).catch(() => {});
  for (const b of list) {
    if (b.type === 'h' && hasToc) {
      out.push({ ...b, text: `${b.text} {#toc-${heads.indexOf(b) + 1}}` });
    } else if (b.type === 'toc') {
      const top = Math.min(...heads.map((x) => x.level));
      for (const [k, x] of heads.entries()) out.push({ id: uid(), type: 'li', kind: 'ul', checked: false, q: b.q, indent: x.level - top, text: `[${x.text.replace(/[[\]]/g, '\\$&')}](#toc-${k + 1})` });
      if (!heads.length) continue;
    } else if (shots && isDiagram(b)) {
      const el = [...els.write.children].find((x) => x.dataset.id === b.id)?.querySelector('.preview svg, .preview');
      let file = null;
      if (el) {
        el.scrollIntoView({ block: 'center' });
        // Animation frames do not run in a hidden window: a timer backs the frame up.
        await new Promise((r) => {
          requestAnimationFrame(() => setTimeout(r, 30));
          setTimeout(r, 120);
        });
        const r = el.getBoundingClientRect();
        file = path.join(shots, `diagram-${Date.now()}-${++shot}.png`);
        const shotTaken = platform.snapshot({ path: file, x: r.left, y: r.top, width: r.width, height: r.height }).then(() => true, () => false);
        const timedOut = new Promise((done) => setTimeout(() => done(false), 4000));
        if (!r.width || !r.height || !(await Promise.race([shotTaken, timedOut]))) file = null;
      }
      out.push(file ? { id: uid(), type: 'p', q: b.q, indent: b.indent, text: `![](${encodeURI(file)})` } : b);
    } else out.push(b);
  }
  return serialize(out);
}

const PANDOC_FROM = 'markdown+pipe_tables+task_lists+strikeout+tex_math_dollars+footnotes+yaml_metadata_block+hard_line_breaks+autolink_bare_uris+emoji+mark-implicit_figures';

// Title, author, header and footer for an export: the entry's settings, overridden
// by the document's front matter when the entry allows it.
// What an export takes from the document's front matter (with "read export settings
// from front matter" on): each key also as typora-<key> or under export:, "unset" for none.
function exportMeta(cfg = {}) {
  const fm = cfg.allowPerFileSetting ? frontMatter() : {};
  const pick = (k) => {
    const v = fm[`export.${k}`] ?? fm[`typora-${k}`] ?? fm[k];
    return v === 'unset' ? '' : v;
  };
  const theme = pick('theme');
  return {
    title: pick('title') || (doc.path ? path.stem(doc.name) : path.stem(suggestedFileName())),
    author: pick('author') ?? cfg.author ?? '',
    subject: pick('subject') ?? '',
    creator: pick('creator') ?? '',
    keywords: pick('keywords') ?? '',
    header: pick('header') ?? cfg.header ?? '',
    footer: pick('footer') ?? cfg.footer ?? '',
    theme: theme && THEMES.some(([id]) => id === theme) ? theme : '',
    overrides: cfg.allowPerFileSetting ? Object.fromEntries([
      ['split-level', 'splitPages', (v) => Number(v) === 1 || v === 'true'],
      ['toc-depth', 'tocDepth', Number],
      ['sidebar', 'sidebar', (v) => v === 'true' || v === 'yes'],
      ['append-head', 'appendHead', String],
      ['append-body', 'appendBody', String],
    ].filter(([k]) => pick(k) !== undefined).map(([k, key, fn]) => [key, fn(pick(k))])) : {},
  };
}
// ${title}, ${author} and ${today} are filled in here; the page numbers are
// left for the PDF writer.
const fillPlaceholders = (text, meta) => (text || '').replace(/\$\{([\w.-]+)\}/g, (m, k) => {
  if (k === 'title') return meta.title;
  if (k === 'author') return meta.author;
  const vars = exportVars(null);
  const hit = Object.keys(vars).find((x) => x.toLowerCase() === k.toLowerCase());
  return hit ? vars[hit] : m;
});

// Split a command line the way a shell would, honouring quotes.
const shellWords = (line) => (line.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'));

async function runPandoc(args, stdin, cwd) {
  if (!settings.pandocPath.trim()) return platform.pandoc(args, stdin, cwd);
  // A pandoc at a custom location is run as a command, reading the
  // Markdown from a scratch file.
  let input = [];
  if (stdin !== undefined) {
    const tmp = path.join(info.appSupport, 'pandoc-input.md');
    await platform.writeText(tmp, stdin);
    input = [tmp];
  }
  return sh(`${cwd ? `cd ${quote(cwd)} && ` : ''}${quote(settings.pandocPath.trim())} ${args.map(quote).join(' ')}`, input);
}

// ${outputPath}, ${outputDir}, ${currentPath}, ${currentFolder} and ${filename} in a command.
// ${…} in export commands, headers and footers: the output and current file's paths and
// names, today's date (YYYY-MM-DD), and any front matter key (dotted for nested ones).
const exportVars = (target) => ({
  ...frontMatter(),
  today: new Date().toISOString().slice(0, 10),
  outputPath: target || '', outputDir: target ? path.dirname(target) : '', outputFileName: target ? path.basename(target) : '', outputFolderName: target ? path.basename(path.dirname(target)) : '',
  currentPath: doc.path || '', currentFolder: docDir() || '', currentFileName: doc.path ? path.basename(doc.path) : '', currentFolderName: docDir() ? path.basename(docDir()) : '',
  filename: path.stem(doc.name),
});
const fillVars = (cmd, vars) => cmd.replace(/\$\{([\w.-]+)\}/g, (m, k) => {
  const hit = Object.keys(vars).find((x) => x.toLowerCase() === k.toLowerCase());
  return hit ? quote(vars[hit]) : m;
});
const pre = (text) => h('pre', { class: 'version-preview' }, text || t('(empty)'));

// After a file is written: the entry's command, then a notice (or a dialog with the
// command's output), then show the file in Finder and / or open it.
async function afterExported(target, type, cfg, { warning = '', args = null } = {}) {
  let failed = false;
  let output = '';
  let error = warning;
  let reveal = type !== 'custom' || !!cfg.saveDialog;
  const command = type === 'custom' ? cfg.command : cfg.runCommandStr;
  if (type !== 'custom' && cfg.runCommand && isNative) {
    reveal = true;
    const res = await sh(`cd ${quote(docDir() || info.home || '/')} && ${fillVars(cfg.runCommandStr || '', exportVars(target))}`).catch((err) => ({ code: -1, stdout: '', stderr: String(err.message || err) }));
    output = res.stdout || '';
    if (res.code !== 0) { failed = true; error = res.stderr || ''; }
  } else if (type === 'custom') output = args?.stdout || '';
  if (failed || cfg.showOutput) {
    const pick = await modal({
      title: t(failed ? 'Run command after export failed' : 'Export Success!'), wide: true,
      body: h('div', { class: 'export-result' }, h('div', {}, t('Command Arguments:')), pre(command || args?.command), h('div', {}, t('Console Output:')), error ? pre(error) : null, !output && error ? null : pre(output)),
      buttons: reveal && target ? [{ label: t('Reveal in Finder'), value: 'reveal' }, { label: t('Close'), value: null, primary: true }] : [{ label: t('Close'), value: null, primary: true }],
    });
    if (pick === 'reveal') platform.reveal(target);
  } else {
    let title = t(warning ? 'Export operation succeeded with warnings.' : 'Export operation finished successfully.');
    if ((type === 'custom' && cfg.showOutput) || (type !== 'custom' && cfg.runCommand)) title = output.trim().split('\n').pop() || title;
    const body = [warning, type === 'custom' && args?.command ? `${t('Command Arguments:')} ${args.command}` : ''].filter(Boolean).join('\n----------\n');
    showHint({ title: escHtml(title), body: escHtml(body), actions: reveal && target && isNative ? [{ label: t('Reveal in Finder'), run: () => platform.reveal(target) }] : null });
  }
  if (!isNative || !target) return;
  if (cfg.openExportLocation) {
    platform.reveal(target);
    if (!warning) setTimeout(() => $('#hint-bar')?.classList.remove('show'), 2000);
  }
  if (cfg.openExportFile) {
    platform.openExternal(target);
    if (!warning) setTimeout(() => $('#hint-bar')?.classList.remove('show'), 2000);
  }
}

// The folder the save panel starts in: Settings → Export → General.
function exportDirectory() {
  const g = settings.exportCfg.general || {};
  if (g.exportFolder === 'custom' && g.customExportPath) return g.customExportPath;
  if (g.exportFolder === 'same') return docDir() || undefined;
  return lastExport ? path.dirname(lastExport.target) : docDir() || undefined;
}

function exportFailed(target, err) {
  $('#hint-bar')?.classList.remove('show');
  const div = h('div');
  div.innerHTML = t('Failed to export file to <em>{0}</em>', escHtml(target || t('Export Failed')));
  modal({ title: div.textContent, body: pre(String(err?.message || err || '')), buttons: [{ label: t('OK'), value: true, primary: true }] });
}

const entryByKey = (key) => exportEntries(settings).find((e) => e.key === key) || exportEntries(settings).find((e) => e.type === key);

// Export the document with one entry of Settings → Export. `reuse` is a path to write to
// without asking (Export and Overwrite with Previous); `start` prefills the save panel.
async function exportAs(key, { reuse = null, start = null } = {}) {
  const entry = entryByKey(key === 'png' ? 'image' : key === 'mediawiki' ? 'wiki' : key);
  if (!entry) return null;
  // Every export works from the rendered document: leave Source Code Mode first,
  // so what was typed there is what gets exported.
  if (sourceMode) toggleSource(true);
  const { type } = entry;
  const cfg = configOf(settings, entry.key, type);
  if (type === 'custom') return exportCustom(entry, cfg, { reuse, start });
  if (!['pdf', 'html', 'html-plain', 'image'].includes(type) && !(await requirePandoc())) return null;
  const meta = exportMeta(cfg);
  // Front matter export options (split-level, sidebar, append-head…) for this export only.
  Object.assign(cfg, meta.overrides);
  if (type === 'pdf' && !isNative) return printDoc();
  const stem = doc.path ? path.stem(doc.name) : path.stem(suggestedFileName());
  const directory = docDir() || undefined;
  const imageKind = cfg.quality === 1 || cfg.quality === 2 ? 'jpeg' : 'png';
  const pandocExt = type === 'pandoc' ? ((cfg.extensions || '').split(/\s+/).filter(Boolean).map((x) => x.replace(/^\./, ''))) : null;
  const ext = type === 'html' || type === 'html-plain' ? 'html' : type === 'image' ? (imageKind === 'jpeg' ? 'jpg' : 'png') : type === 'pdf' ? 'pdf' : type === 'pandoc' ? pandocExt[0] || (cfg.targetFormat || '').trim() || 'txt' : PANDOC_TARGET[type]?.[1] || type;
  const target = reuse || (await platform.pickSave({ suggestedName: start ? path.basename(start) : `${stem}.${ext}`, directory: start ? path.dirname(start) : exportDirectory(), extensions: type === 'pandoc' && !pandocExt.length ? undefined : type === 'pandoc' ? pandocExt : [ext] }));
  if (!target) return null;
  lastExport = { key: entry.key, target, docPath: doc.path };
  rememberExport(lastExport);
  showHint({ title: t('Exporting in progress...') });
  try {
    let warning = '';
    if (type === 'html' || type === 'html-plain') {
      // Export / Print: keep or drop single line breaks, independent of the editing view.
      const keepBreaks = inlineCtx.preserveBreaks;
      inlineCtx.preserveBreaks = settings.exportBreaks;
      let html;
      try {
        await diagramsInTheme(meta.theme || cfg.exportTheme || '');
        html = standaloneHtml(editor.doc, { title: meta.title, author: meta.author, css: type === 'html' ? await exportCss() : '', theme: meta.theme || cfg.exportTheme || activeTheme(), dark: isDark(), preview: diagramSvg, head: cfg.appendHead || '', bodyEnd: cfg.appendBody || '', outline: type === 'html' && !!cfg.sidebar });
      } finally {
        inlineCtx.preserveBreaks = keepBreaks;
      }
      await platform.writeText(target, html);
    } else if (type === 'pdf') {
      const pt = (v) => (Number(v) * 72) / 25.4;
      const custom = cfg['paper.margin'] === 'custom';
      const paper = cfg.paper === 'custom' ? { width: pt((cfg['paper.custom'] || [210])[0]), height: pt((cfg['paper.custom'] || [, 297])[1]) } : cfg.paper || undefined;
      // "Append Extra Content (HTML)" goes after the document on the last page.
      const extra = cfg.appendBody ? h('div', { class: 'export-append' }) : null;
      if (extra) { extra.innerHTML = cfg.appendBody; els.write.after(extra); }
      await withPrintLayout(() => withPdfLinks(() => platform.exportPdf({
        internalLinks: true,
        // The PDF's own Title / Author / Subject / Creator.
        info: { title: meta.title, author: meta.author, subject: meta.subject, creator: meta.creator || 'Livemark', keywords: meta.keywords },
        path: target,
        ...(paper ? { paper } : {}),
        margins: custom ? { top: pt(cfg['paper.marginTop'] ?? 16), right: pt(cfg['paper.marginRight'] ?? 16), bottom: pt(cfg['paper.marginBottom'] ?? 16), left: pt(cfg['paper.marginLeft'] ?? 16) } : { top: 45, right: 36, bottom: 45, left: 36 },
        header: fillPlaceholders(meta.header, meta),
        footer: fillPlaceholders(meta.footer, meta),
        outline: cfg.outline !== false ? headings.map((hd) => ({ level: hd.level, text: hd.text })) : [],
      })), cfg, meta).finally(() => extra?.remove());
    } else if (type === 'image') {
      // One picture of the whole document at the chosen width; Best keeps PNG at twice
      // the resolution, Medium and High are JPEG, Auto is PNG.
      const width = Math.max(100, Math.min(4096, Number(cfg.imageWidth) || 640));
      document.body.classList.add('image-export');
      document.documentElement.style.setProperty('--image-width', `${width}px`);
      const root = document.documentElement;
      const hadCustom = root.classList.contains('custom-font-size');
      const userFs = root.style.getPropertyValue('--fs-user');
      if (!cfg.useThemeFontSize) {
        root.classList.add('custom-font-size');
        root.style.setProperty('--fs-user', `${Number(cfg.imageFontSize) || 24}px`);
      }
      try {
        await withPrintLayout(() => platform.exportImage({ path: target, width, height: Math.ceil(els.write.getBoundingClientRect().height), scale: cfg.quality === 3 ? 2 : 1, format: imageKind, quality: cfg.quality === 1 ? 0.3 : 1 }), cfg, meta);
      } finally {
        document.body.classList.remove('image-export');
        document.documentElement.style.removeProperty('--image-width');
        root.classList.toggle('custom-font-size', hadCustom);
        root.style.setProperty('--fs-user', userFs);
      }
    } else {
      // Pandoc: the template's writer and options, then the entry's extra arguments.
      const to = type === 'pandoc' ? (cfg.raw || cfg.targetFormat || '').trim() : type === 'native' ? (cfg.targetFormat || 'native').trim() : PANDOC_TARGET[type][0];
      const args = ['-f', PANDOC_FROM, ...(to ? ['-t', to] : []), '-s', '-o', target, ...pandocOptions(type, cfg)];
      if (directory) args.push('--resource-path', directory);
      args.push('--metadata', `title=${meta.title}`);
      if (meta.author) args.push('--metadata', `author=${meta.author}`);
      args.push(...shellWords(fillVars(cfg.extraArguments || '', exportVars(target)).replace(/"/g, '')));
      const res = await runPandoc(args, await pandocInput(), directory);
      if (res.code !== 0) throw new Error(res.stderr.trim() || t('pandoc 转换失败'));
      warning = res.stderr.trim();
    }
    $('#hint-bar')?.classList.remove('show');
    await afterExported(target, type, cfg, { warning });
  } catch (err) {
    exportFailed(target, err);
  }
  return null;
}

// A Custom entry: a shell command run in the document's folder, with or without
// a save panel for the output.
async function exportCustom(entry, cfg, { reuse = null, start = null } = {}) {
  if (!isNative) return null;
  if (!doc.path || doc.dirty) {
    if (!(await save())) return null;
  }
  let target = '';
  if (cfg.saveDialog === 'saveFile') {
    const ext = (cfg.extensions || '').split(/\s+/).filter(Boolean).map((x) => x.replace(/^\./, ''));
    target = reuse || (await platform.pickSave({ suggestedName: start ? path.basename(start) : `${path.stem(doc.name)}${ext[0] ? `.${ext[0]}` : ''}`, directory: start ? path.dirname(start) : exportDirectory(), extensions: ext.length ? ext : undefined }));
    if (!target) return null;
  } else if (cfg.saveDialog === 'saveFolder') {
    target = reuse || (await platform.pickFolder());
    if (!target) return null;
  }
  lastExport = { key: entry.key, target, docPath: doc.path };
  const command = fillVars(cfg.command || '', exportVars(target));
  try {
    const res = await sh(`cd ${quote(docDir())} && ${command}`);
    if (res.code !== 0) throw new Error(res.stderr.trim() || `exit ${res.code}`);
    await afterExported(target, 'custom', cfg, { args: { command, stdout: res.stdout } });
  } catch (err) {
    exportFailed(target, err);
  }
  return null;
}

// Pandoc is needed for import and the Pandoc exports: without it Typora explains and
// offers its install guide or the Pandoc Path setting instead of greying the commands out.
async function requirePandoc(opening = false) {
  if (info.pandoc || settings.pandocPath.trim()) return true;
  // A dropped or opened Word/LaTeX/… file gets Typora's shorter wording.
  const message = t(opening ? 'Pandoc is needed for importing these file formats' : 'Require Pandoc to Continue...');
  const detail = opening ? t('Check help->Install and use Pandoc from menubar for detail') : t('Import function and several export formats requires Pandoc (≥%@) to be installed.').replace('%@', '2.0');
  const pick = await ask({ message, detail, buttons: [t('Follow instructions to install Pandoc'), t('Set Pandoc Path'), t('Cancel')], style: 'warning' });
  if (pick === 0) openHelp('docs/pandoc.md');
  else if (pick === 1) app.preferences('Export');
  return false;
}

// The "File Format" pop-up of an open panel: [[name, extensions], …] and its labels.
function fileFormats(list) {
  return { formats: list, formatLabels: { label: t('File Format:'), all: t('All Supported Formats') } };
}

async function importFile(given) {
  if (!(await requirePandoc(!!given))) return;
  const p = given || await platform.pickFile({ extensions: ['docx', 'html', 'htm', 'tex', 'latex', 'ltx', 'rst', 'rest', 'odt', 'epub', 'opml', 'textile', 'wiki', 'dokuwiki', 'org', 'rtf', 'ipynb', 'csv'], ...fileFormats([
    ['Word (.docx)', ['docx']], ['HTML', ['html', 'htm']], ['LaTeX', ['tex', 'latex', 'ltx']], ['reStructuredText', ['rst', 'rest']], ['OpenOffice', ['odt']],
    ['Epub', ['epub']], ['OPML', ['opml']], ['Textile', ['textile']], ['Media Wiki', ['wiki']], ['DokuWiki', ['dokuwiki']], ['Org Mode', ['org']], ['RTF', ['rtf']], ['Jupyter Notebook', ['ipynb']], ['CSV', ['csv']],
  ]) });
  if (!p || !(await confirmDiscard())) return;
  showHint({ title: t('Importing in progress...'), body: t('Converting file with Pandoc. This may take some time.'), actions: platform.pandocCancel ? [{ label: t('Abort'), run: () => platform.pandocCancel().catch(() => {}) }] : null });
  try {
    const res = await runPandoc([p, '-t', 'gfm+tex_math_dollars', '--wrap=none'], undefined, path.dirname(p));
    if (res.code !== 0) throw new Error(res.stderr.trim() || t('pandoc 转换失败'));
    $('#hint-bar')?.classList.remove('show');
    showText(res.stdout, { name: `${path.stem(p)}.md`, saved: '' });
  } catch (err) {
    $('#hint-bar')?.classList.remove('show');
    modal({ title: t('Import Failed'), body: h('pre', { class: 'version-preview' }, String(err.message || err)), buttons: [{ label: t('OK'), value: true, primary: true }] });
  }
}

// --- view state -------------------------------------------------------------------

const systemDark = matchMedia('(prefers-color-scheme: dark)');
function activeTheme() {
  return settings.followSystem && systemDark.matches ? settings.darkTheme : settings.theme;
}
// A theme counts as dark when its background is, built-in or custom.
let darkCache = ['', false];
function isDark() {
  const theme = activeTheme();
  if (darkCache[0] !== theme) {
    document.documentElement.dataset.theme = theme;
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(bg);
    const rgb = hex ? [0, 2, 4].map((k) => parseInt(hex[1].slice(k, k + 2), 16)) : (bg.match(/\d+/g) || []).slice(0, 3).map(Number);
    darkCache = [theme, rgb.length === 3 && rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 < 128];
  }
  return darkCache[1];
}

// Edit → Undo / Redo: the editor's history, or in Source Code Mode the
// textarea's own (WebKit keeps it across typing, cut, paste and replace).
function historyStep(kind) {
  if (!sourceMode) return kind === 'undo' ? editor.undo() : editor.redo();
  els.source.focus({ preventScroll: true });
  document.execCommand(kind);
  els.source.dispatchEvent(new Event('input'));
  return null;
}

// --- source mode: the same place in both views ------------------------------------

// Pixel offset of a character in the source textarea (measured on a hidden copy).
function sourceCaretTop(index) {
  const ta = els.source;
  const cs = getComputedStyle(ta);
  const mirror = h('div', { style: `position:absolute;visibility:hidden;top:0;left:-9999px;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:${cs.boxSizing};width:${ta.clientWidth}px;padding:${cs.padding};border:${cs.border};font:${cs.font};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing};tab-size:${cs.tabSize}` });
  mirror.textContent = ta.value.slice(0, index);
  const mark = h('span', {}, '\u200b');
  mirror.append(mark);
  document.body.append(mirror);
  const y = mark.offsetTop;
  mirror.remove();
  return ta.offsetTop + y;
}

// Rendered position -> offset in the Markdown text.
function sourceOffsetOf(md, pos) {
  const ranges = sourceRanges(md);
  const r = ranges[pos.i];
  if (!r) return 0;
  const lines = md.split('\n');
  const lineStart = (n) => lines.slice(0, n).reduce((a, l) => a + l.length + 1, 0);
  const b = editor.doc[pos.i];
  if (b.type === 'table') {
    const n = tableCols(b);
    const row = Math.floor(pos.leaf / n);
    const line = r.start + (row === 0 ? 0 : row + 1);
    const cells = (lines[line] || '').split('|');
    const lead = (lines[line] || '').trimStart().startsWith('|') ? 1 : 0;
    const before = cells.slice(0, lead + (pos.leaf % n)).join('|').length + 1;
    const cell = cells[lead + (pos.leaf % n)] || '';
    return lineStart(line) + before + (cell.length - cell.trimStart().length) + pos.off;
  }
  const text = leafText(b, pos.leaf);
  const prefix = text.slice(0, pos.off);
  const k = (prefix.match(/\n/g) || []).length;
  const textLine = text.split('\n')[k] || '';
  const offInLine = prefix.length - (prefix.lastIndexOf('\n') + 1);
  // Code: line 0 of the block is the fence.
  const srcLine = b.type === 'code' ? r.start + 1 + k : r.start + k;
  const src = lines[srcLine] || '';
  const marker = textLine ? Math.max(0, src.indexOf(textLine)) : src.length - src.trimStart().replace(/^([#>*+-]|\d+[.)]|\[[ xX]\])\s*/g, '').length;
  return lineStart(srcLine) + Math.min(src.length, marker + offInLine);
}

// Offset in the Markdown text -> rendered position.
function renderedPosOf(md, index) {
  const ranges = sourceRanges(md);
  const lines = md.split('\n');
  let line = 0;
  let acc = 0;
  while (line < lines.length - 1 && acc + lines[line].length < index) acc += lines[line++].length + 1;
  const col = index - acc;
  let i = ranges.findIndex((r) => r && r.start <= line && line <= r.end);
  if (i < 0) i = Math.max(0, ranges.reduce((best, r, k) => (r && r.start <= line ? k : best), -1));
  const b = editor.doc[i];
  const r = ranges[i];
  if (!b || !r) return null;
  // A rule or table of contents holds no caret: the next block does.
  if (b.type === 'hr' || b.type === 'toc') return i + 1 < editor.doc.length ? { i: i + 1, leaf: 0, off: 0 } : null;
  if (b.type === 'table') {
    const row = line - r.start <= 1 ? 0 : line - r.start - 1;
    const src = lines[line] || '';
    const lead = src.trimStart().startsWith('|') ? 1 : 0;
    const c = Math.max(0, Math.min(tableCols(b) - 1, (src.slice(0, col).match(/\|/g) || []).length - lead));
    const leaf = Math.min(row, b.rows.length - 1) * tableCols(b) + c;
    // Within the cell: from the first character after the pipe and its padding.
    let pipe = -1;
    for (let k = 0; k < c + lead; k++) pipe = src.indexOf('|', pipe + 1);
    const cellStart = pipe + 1 + ((src.slice(pipe + 1).match(/^ */) || [''])[0].length);
    return { i, leaf, off: Math.max(0, Math.min(leafText(b, leaf).length, col - cellStart)) };
  }
  const text = leafText(b, 0);
  const tl = text.split('\n');
  const k = Math.max(0, Math.min(tl.length - 1, b.type === 'code' ? line - r.start - 1 : line - r.start));
  if (b.type === 'code' && line === r.start) return { i, leaf: 0, off: 0 };
  const src = lines[line] || '';
  const marker = tl[k] ? Math.max(0, src.indexOf(tl[k])) : src.length;
  const before = tl.slice(0, k).reduce((a, l) => a + l.length + 1, 0);
  return { i, leaf: 0, off: Math.min(text.length, before + Math.max(0, Math.min(tl[k].length, col - marker))) };
}

function toggleSource(quiet = false) {
  // Where the caret is, and how far down the window it sits, before switching.
  const scrollerTop = els.scroller.getBoundingClientRect().top;
  let caretY = null;
  let srcIndex = 0;
  let richPos = null;
  if (!sourceMode) {
    const sel = editor.getSel();
    const rect = window.getSelection().rangeCount ? window.getSelection().getRangeAt(0).getClientRects()[0] : null;
    if (sel && rect) caretY = rect.top - scrollerTop;
    if (sel) srcIndex = sourceOffsetOf(editor.getMarkdown(), sel.focus);
  } else {
    srcIndex = els.source.selectionEnd;
    caretY = sourceCaretTop(srcIndex) - els.scroller.scrollTop;
  }
  if (finder.isOpen) finder.close({ keepCaret: true });
  sourceMode = !sourceMode;
  if (sourceMode && settings.sidebar) {
    sidebarBeforeSource = true;
    document.body.classList.add('source-hides-sidebar');
  } else if (!sourceMode && sidebarBeforeSource) {
    sidebarBeforeSource = false;
    document.body.classList.remove('source-hides-sidebar');
  }
  const top = els.scroller.scrollTop;
  if (sourceMode) els.source.value = editor.getMarkdown();
  else if (els.source.value !== editor.getMarkdown()) {
    const before = { saved: doc.saved };
    editor.setMarkdown(els.source.value);
    doc.saved = before.saved;
    doc.eolChanged = false;
  }
  if (!sourceMode) richPos = renderedPosOf(els.source.value, srcIndex);
  els.write.hidden = sourceMode;
  els.source.hidden = !sourceMode;
  els.sourceBtn.setAttribute('aria-pressed', sourceMode);
  if (!quiet) {
    // The caret keeps its place in the text and its height in the window.
    if (sourceMode) {
      fitSource();
      els.source.setSelectionRange(srcIndex, srcIndex);
      els.source.focus({ preventScroll: true });
      els.scroller.scrollTop = caretY === null ? top : sourceCaretTop(srcIndex) - caretY;
    } else {
      editor.focus();
      if (richPos) editor.setSel(richPos);
      const rect = window.getSelection().rangeCount ? window.getSelection().getRangeAt(0).getClientRects()[0] : null;
      if (rect && caretY !== null) els.scroller.scrollTop += rect.top - els.scroller.getBoundingClientRect().top - caretY;
      else els.scroller.scrollTop = top;
    }
  }
  fitSource();
  drawGutter();
  drawSourceFocus();
  if (finder.isOpen) finder.refresh(true);
  applyView();
  syncTouchBar();
}

// Safari has no field-sizing yet, so grow the textarea to its content by hand.
function fitSource() {
  if (CSS.supports('field-sizing', 'content') || els.source.hidden) return;
  els.source.style.height = 'auto';
  els.source.style.height = `${els.source.scrollHeight + 2}px`;
}
window.addEventListener('resize', fitSource);
// Resizing keeps the block that was at the top of the view where it was.
let resizeAnchor = null;
let resizeTimer = 0;
window.addEventListener('resize', () => {
  const view = els.scroller;
  if (!resizeAnchor) {
    const r = view.getBoundingClientRect();
    const host = sourceMode ? null : els.write;
    const el = host && [...host.children].find((b) => b.getBoundingClientRect().bottom > r.top + 40);
    resizeAnchor = el ? { el, offset: el.getBoundingClientRect().top - r.top } : null;
  }
  if (resizeAnchor?.el.isConnected) view.scrollTop += resizeAnchor.el.getBoundingClientRect().top - view.getBoundingClientRect().top - resizeAnchor.offset;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => (resizeAnchor = null), 300);
});

// Line numbers beside the source text, one per Markdown line (a wrapped line keeps
// one number). Measured on a hidden copy laid out like the text area.
const sourceGutter = h('div', { id: 'source-gutter', 'aria-hidden': 'true', hidden: true });
els.scroller.append(sourceGutter);
function drawGutter() {
  const ta = els.source;
  if (ta.hidden) {
    sourceGutter.hidden = true;
    return;
  }
  const cs = getComputedStyle(ta);
  const mirror = h('div', { style: `position:absolute;visibility:hidden;top:0;left:-9999px;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:${cs.boxSizing};width:${ta.clientWidth}px;padding:${cs.padding};border:${cs.border};font:${cs.font};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing};tab-size:${cs.tabSize}` });
  const lines = ta.value.split('\n');
  mirror.append(...lines.map((l) => h('div', {}, l || '\u200b')));
  document.body.append(mirror);
  const tops = [...mirror.children].map((d) => d.offsetTop);
  mirror.remove();
  const pad = parseFloat(cs.paddingLeft) || 0;
  Object.assign(sourceGutter.style, { left: `${ta.offsetLeft}px`, top: `${ta.offsetTop}px`, width: `${Math.max(24, pad - 10)}px`, font: cs.font, lineHeight: cs.lineHeight });
  sourceGutter.replaceChildren(...tops.map((y, k) => h('div', { style: `top:${y}px` }, String(k + 1))));
  sourceGutter.hidden = false;
}
const drawGutterSoon = debounce(drawGutter, 120);
window.addEventListener('resize', drawGutterSoon);
els.source.addEventListener('input', drawGutterSoon);

els.source.addEventListener('input', () => {
  fitSource();
  const text = els.source.value;
  els.words.textContent = countLabel(text);
  afterEdit(text);
});
// --- Source Code Mode editing aids ---------------------------------------------
// Changes go through insertText so the text area's own undo keeps them.
function srcReplace(from, to, text, selStart = from + text.length, selEnd = selStart) {
  const ta = els.source;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(from, to);
  if (!document.execCommand(text ? 'insertText' : 'delete', false, text)) ta.setRangeText(text, from, to, 'end');
  ta.setSelectionRange(selStart, selEnd);
  ta.dispatchEvent(new Event('input'));
}
// [start, end) of the whole lines the selection touches.
function srcLines(v, s, e) {
  const a = v.lastIndexOf('\n', s - 1) + 1;
  let z = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
  if (z < 0) z = v.length;
  return [a, z];
}
const SRC_LIST = /^(\s*)(?:(>\s?)+|([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const SRC_PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
els.source.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const ta = els.source;
  const v = ta.value;
  const s = ta.selectionStart;
  const end = ta.selectionEnd;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    const [a, z] = srcLines(v, s, end);
    const lines = v.slice(a, z).split('\n');
    const listLine = SRC_LIST.test(lines[0]) && !/^\s*>/.test(lines[0]);
    if (!e.shiftKey && s === end && !listLine) return srcReplace(s, end, '  ');
    // Several lines, a selection or a list item: whole lines move in or out.
    const unit = (line) => {
      const m = SRC_LIST.exec(line);
      return m && !m[2] ? (m[3] ? 2 : (m[4] + m[5]).length + 1) : 2;
    };
    const out = lines.map((line) => {
      if (!e.shiftKey) return line ? ' '.repeat(unit(line)) + line : line;
      const lead = /^( +|\t)/.exec(line)?.[0] || '';
      return line.slice(Math.min(lead.length, lead === '\t' ? 1 : unit(line.trimStart())));
    });
    const delta0 = out[0].length - lines[0].length;
    const text = out.join('\n');
    return srcReplace(a, z, text, Math.max(a, s + delta0), s === end ? Math.max(a, s + delta0) : a + text.length - (z - end));
  }
  if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey && s === end) {
    const a = v.lastIndexOf('\n', s - 1) + 1;
    const line = v.slice(a, s);
    const m = SRC_LIST.exec(line);
    if (!m || m[0].length > line.length) return;
    e.preventDefault();
    // Enter on an empty item ends the list.
    if (line.trim() === m[0].trim()) return srcReplace(a, s, '');
    const marker = m[2] ? m[2].trim() + ' ' : m[3] ? m[3] + m[6] : `${Number(m[4]) + 1}${m[5]}${m[6]}`;
    const prefix = m[2] ? m[1] + line.slice(m[1].length).match(/^(>\s?)+/)[0] : m[1] + marker + (m[7] ? '[ ] ' : '');
    return srcReplace(s, s, '\n' + prefix);
  }
  if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const [a, z] = srcLines(v, s, end);
    const block = v.slice(a, z);
    if (e.key === 'ArrowUp') {
      if (a === 0) return;
      const pa = v.lastIndexOf('\n', a - 2) + 1;
      const prev = v.slice(pa, a - 1);
      return srcReplace(pa, z, `${block}\n${prev}`, s - prev.length - 1, end - prev.length - 1);
    }
    if (z >= v.length) return;
    let nz = v.indexOf('\n', z + 1);
    if (nz < 0) nz = v.length;
    const next = v.slice(z + 1, nz);
    return srcReplace(a, nz, `${next}\n${block}`, s + next.length + 1, end + next.length + 1);
  }
  if (!mod && !e.altKey && e.key.length === 1 && settings.autoPair !== false) {
    const close = SRC_PAIRS[e.key];
    if (s !== end && close) {
      e.preventDefault();
      return srcReplace(s, end, e.key + v.slice(s, end) + close, s + 1, end + 1);
    }
    if (s === end && Object.values(SRC_PAIRS).includes(e.key) && v[s] === e.key && (e.key !== SRC_PAIRS[e.key] || /\S/.test(v[s - 1] || ''))) {
      e.preventDefault();
      return ta.setSelectionRange(s + 1, s + 1);
    }
    if (s === end && close && /^($|[\s)\]},.;:!?])/.test(v.slice(s, s + 1)) && !(close === e.key && /[\p{L}\p{N}]/u.test(v[s - 1] || ''))) {
      e.preventDefault();
      return srcReplace(s, s, e.key + close, s + 1);
    }
  }
  if (e.key === 'Backspace' && s === end && s > 0 && SRC_PAIRS[v[s - 1]] && v[s] === SRC_PAIRS[v[s - 1]] && settings.autoPair !== false) {
    e.preventDefault();
    return srcReplace(s - 1, s + 1, '');
  }
});
// Source Code Mode: the selection's count in the status bar; Typewriter Mode keeps the
// caret's line in the middle (after the mouse is let go); otherwise the view scrolls
// when the caret gets within 60px of the bottom.
document.addEventListener('selectionchange', () => {
  if (!sourceMode || document.activeElement !== els.source) return;
  const ta = els.source;
  els.words.textContent = ta.selectionStart !== ta.selectionEnd ? selectionCount(ta.value.slice(ta.selectionStart, ta.selectionEnd)) : countLabel(ta.value);
  if (sourceMouseDown) return;
  sourceFollowCaret();
});
let sourceMouseDown = false;
els.source.addEventListener('mousedown', () => (sourceMouseDown = true));
document.addEventListener('mouseup', () => {
  if (!sourceMouseDown) return;
  sourceMouseDown = false;
  if (sourceMode) sourceFollowCaret();
});
// Focus Mode in Source Code Mode: the text is dimmed and the paragraph with the caret
// is drawn again on top, at full strength.
const sourceFocus = h('div', { id: 'source-focus', 'aria-hidden': 'true', hidden: true });
els.scroller.append(sourceFocus);
function drawSourceFocus() {
  const ta = els.source;
  const on = sourceMode && settings.focusMode && !ta.hidden;
  document.body.classList.toggle('source-focus', on);
  if (!on) {
    sourceFocus.hidden = true;
    return;
  }
  const v = ta.value;
  const at = ta.selectionStart;
  const start = v.lastIndexOf('\n\n', at - 1) + 1 || 0;
  let end = v.indexOf('\n\n', at);
  if (end < 0) end = v.length;
  const cs = getComputedStyle(ta);
  Object.assign(sourceFocus.style, { left: `${ta.offsetLeft}px`, top: `${ta.offsetTop}px`, width: `${ta.offsetWidth}px`, padding: cs.padding, font: cs.font, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, tabSize: cs.tabSize, boxSizing: cs.boxSizing, borderWidth: cs.borderWidth });
  sourceFocus.replaceChildren(h('span', { class: 'off' }, v.slice(0, start)), h('span', { class: 'on' }, v.slice(start, end)), h('span', { class: 'off' }, `${v.slice(end)}\n`));
  sourceFocus.hidden = false;
}
document.addEventListener('selectionchange', () => {
  if (sourceMode) drawSourceFocus();
});
els.source.addEventListener('input', () => drawSourceFocus());
onSettings((patch) => {
  if ('focusMode' in patch) drawSourceFocus();
});

function sourceFollowCaret() {
  const ta = els.source;
  if (ta.selectionStart !== ta.selectionEnd) return;
  const y = sourceCaretTop(ta.selectionStart);
  const view = els.scroller;
  if (settings.typewriter) view.scrollTo({ top: y - view.clientHeight / 2, behavior: 'smooth' });
  else if (y - view.scrollTop > view.clientHeight - 60) view.scrollTop = y - view.clientHeight + 60;
}

// Copy or cut with nothing selected takes the whole line.
for (const kind of ['copy', 'cut']) {
  els.source.addEventListener(kind, (e) => {
    const ta = els.source;
    if (ta.selectionStart !== ta.selectionEnd) return;
    const v = ta.value;
    const [a, z] = srcLines(v, ta.selectionStart, ta.selectionStart);
    e.preventDefault();
    e.clipboardData.setData('text/plain', v.slice(a, z) + '\n');
    if (kind === 'cut') srcReplace(a, Math.min(v.length, z + 1), '');
  });
}

let editorToolbar = null, toolbarShown = null, appliedZoom = 1;
let appliedInline = '';
let systemQuotes = null;
// The native window follows the page: the theme's background and light/dark
// controls, and its title kept clear of the sidebar while that is showing.
let chromeKey = '';
function syncChrome() {
  if (!isNative || !platform.setChrome) return;
  // The theme's own background (the page fades to it, so not the body's current colour).
  const probe = h('span', { style: 'position:absolute;visibility:hidden;color:var(--bg)' });
  document.body.append(probe);
  const bg = getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) || null;
  probe.remove();
  const side = settings.sidebar ? Math.round($('#sidebar')?.getBoundingClientRect().width || 0) : 0;
  const state = { background: bg, dark: isDark(), titleInset: side || null };
  const key = JSON.stringify(state);
  if (key === chromeKey) return;
  chromeKey = key;
  platform.setChrome(state).catch(() => {});
}

function applyView() {
  // Now, and again once the sidebar has finished sliding.
  requestAnimationFrame(syncChrome);
  setTimeout(syncChrome, 350);
  const root = document.documentElement;
  els.app.classList.toggle('sidebar-open', settings.sidebar);
  document.body.classList.toggle('focus-mode', settings.focusMode);
  document.body.classList.toggle('typewriter-mode', settings.typewriter);
  document.body.classList.toggle('no-status', !settings.statusBar);
  document.body.classList.toggle('indent-first-line', settings.indentFirstLine);
  document.body.classList.toggle('visible-br', settings.visibleBr);
  document.body.classList.toggle('ignore-line-break', !settings.preserveBreaks);
  document.body.classList.toggle('math-numbering', settings.mathNumbering === 'all');
  document.body.classList.toggle('math-ams', settings.mathNumbering === 'ams');
  editor.updateMathLabels?.();
  document.body.classList.toggle('flat-outline', !settings.outlineCollapsible);
  document.body.classList.toggle('source-on-focus', settings.sourceOnFocus);
  editor.opts.sourceOnFocus = !!settings.sourceOnFocus;
  document.body.classList.toggle('quiet-wordcount', !settings.alwaysWordCount);
  document.body.classList.toggle('has-toolbar', settings.toolbar);
  document.body.classList.toggle('unibody', isNative && settings.windowStyle === 'unibody');
  if (settings.toolbar && !editorToolbar) editorToolbar = createToolbar({ host: els.toolbar, commands, editor, app });
  if (editorToolbar && toolbarShown !== settings.toolbar) editorToolbar.setVisible(settings.toolbar);
  toolbarShown = settings.toolbar;
  let userCss = document.getElementById('custom-css');
  if (!userCss) {
    userCss = h('style', { id: 'custom-css' });
    document.head.append(userCss);
  }
  if (userCss.textContent !== settings.customCss) userCss.textContent = settings.customCss;
  root.dataset.theme = activeTheme();
  root.dataset.dark = isDark() ? '1' : '0';
  // Font size: Auto leaves it to the theme, Customized overrides the theme's size.
  root.classList.toggle('custom-font-size', settings.fontSizeCustom);
  root.style.setProperty('--fs-user', `${settings.fontSize}px`);
  // Zoom scales the whole window, as View → Zoom does.
  if (appliedZoom !== settings.zoom) {
    appliedZoom = settings.zoom;
    if (platform.setZoom) platform.setZoom(settings.zoom);
    else root.style.zoom = settings.zoom === 1 ? '' : String(settings.zoom);
  }
  // 860 is the stock width: leave it to the theme and the wide-window rules.
  if (settings.contentWidth === 860) root.style.removeProperty('--content-width');
  else root.style.setProperty('--content-width', `${settings.contentWidth}px`);
  els.sidebarBtn.setAttribute('aria-pressed', settings.sidebar);
  els.modes.textContent = [sourceMode && t('源代码'), editor.readOnly && t('只读'), settings.focusMode && t('专注'), settings.typewriter && t('打字机'), settings.zoom !== 1 && `${Math.round(settings.zoom * 100)}%`].filter(Boolean).join(' · ');
  editor.typewriter = settings.typewriter;
  els.write.spellcheck = settings.spellcheck;
  els.source.spellcheck = settings.spellcheck;
  const onInput = settings.smartMode === 'input';
  editor.setOptions({
    quotes: systemQuotes, spellcheckCode: settings.spellcheckCode,
    autoPair: settings.autoPair, autoPairMd: settings.autoPairMd, smartQuotes: onInput && settings.smartQuotes, smartDashes: onInput && settings.smartDashes,
    lineNumbers: settings.lineNumbers, codeWrap: settings.codeWrap, codeIndent: settings.codeIndent, shiftTabIndentCode: settings.shiftTabIndentCode, copyLine: settings.copyLine,
    defaultCodeLang: settings.defaultLangOnMd ? settings.defaultCodeLang : '', typewriterCenter: settings.typewriterCenter, defLocation: settings.defLocation, refLinks: settings.refLinks,
  });
  Object.assign(inlineCtx, {
    math: settings.mathInline, sub: settings.subscript, sup: settings.superscript, legacyMathDelims: settings.mathDelims, highlight: settings.highlight, emojiOn: settings.emoji, preserveBreaks: settings.preserveBreaks,
    autoLinks: settings.autoLinks, smartRender: !onInput, smartQuotes: settings.smartQuotes, smartDashes: settings.smartDashes,
    mathLegacy: settings.mathLegacy, spellcheckCode: settings.spellcheckCode, quotes: systemQuotes,
  });
  convertOptions.mathAsTex = settings.mathCopyFormat === 'latex';
  Object.assign(mdOptions, { strict: settings.strictMode, headingStyle: settings.headingStyle, ulMarker: settings.ulMarker, olMarker: settings.olMarker, olStyle: settings.olStyle, alerts: settings.alerts, remapPunct: settings.remapPunct, indent: Number(settings.indentSize) || 0, prettyIndent: settings.prettyIndent });
  features.diagrams = settings.diagrams;
  features.mathFence = settings.mathFence;
  mathOptions.physics = settings.mathPhysics;
  const sig = [settings.mathInline, settings.subscript, settings.superscript, settings.mathDelims, settings.highlight, settings.emoji, settings.diagrams, root.dataset.dark, settings.autoLinks, settings.smartMode, settings.smartQuotes, settings.smartDashes, settings.alerts, settings.mathFence, settings.mathPhysics, settings.mathLegacy, settings.spellcheckCode, systemQuotes].join();
  if (appliedInline && sig !== appliedInline) {
    refreshDiagramTheme();
    editor.rerenderAll();
  }
  appliedInline = sig;
  if (sidebar.tab !== settings.sidebarTab && settings.sidebarTab) sidebar.setTab(settings.sidebarTab);
  commands.syncState();
}

onSettings((patch) => {
  if ('lang' in patch && patch.lang !== langPref) {
    // Strings are bound at load, so a new language needs a fresh page.
    setLang(patch.lang);
    setTimeout(() => location.reload(), 300);
    return;
  }
  applyView();
  if (['mathInline', 'highlight', 'subscript', 'superscript', 'alerts', 'debug', 'exportList', 'pinned'].some((k) => k in patch)) commands.pushNativeMenu();
  if ('alwaysOnTop' in patch) platform.setAlwaysOnTop(settings.alwaysOnTop);
  if ('typewriter' in patch && settings.typewriter) editor.centerCaret();
  if ('windowStyle' in patch) platform.setWindowStyle?.(settings.windowStyle);
  if ('magnification' in patch) platform.setMagnification?.(settings.magnification);
  if ('spellLang' in patch) platform.spellSetLanguage?.(settings.spellLang);
  // The saved text is compared with what the editor would write now, so a
  // change of dialect shows up as an edited document.
  if (['headingStyle', 'ulMarker', 'olMarker'].some((k) => k in patch) && !sourceMode) setDirty(editor.getMarkdown() !== doc.saved);
  if (['showHidden', 'treeFilter', 'treePatterns', 'libraryFilter', 'libraryPatterns', 'fileSort', 'fileGroup'].some((k) => k in patch)) sidebar.refresh();
});

// Hold ⌘ (Ctrl elsewhere) and turn the wheel to zoom, when that is enabled.
let wheelAcc = 0;
window.addEventListener('wheel', (e) => {
  if (!settings.wheelZoom || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) < 40) return;
  app.zoom(wheelAcc < 0 ? 1 : -1);
  wheelAcc = 0;
}, { passive: false });

// --- advanced settings file -------------------------------------------------------

// conf.user.json in the app's support folder holds what has no place in the
// Settings window; today that is the shortcut map.
const ADVANCED_TEMPLATE = `{
  "keyBinding": {
    // "Command title or id": "shortcut". An empty string removes a shortcut.
    // "Strong": "cmd+b",
    // "Code Fences": "ctrl+shift+k"
  },
  // With "Indent first line of paragraphs" on, indent empty paragraphs too.
  "indentEmptyParagraphs": false
}
`;
const advancedPath = () => path.join(info.appSupport, 'conf.user.json');

async function loadAdvanced() {
  if (!isNative || !info.appSupport) return;
  try {
    if (!(await platform.stat(advancedPath())).exists) return;
    const { text } = await platform.readText(advancedPath());
    // The file may carry // comments and trailing commas.
    const conf = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    keymap = conf.keyBinding && typeof conf.keyBinding === 'object' ? conf.keyBinding : {};
    // With first-line indent on, empty paragraphs are not indented unless this says so.
    document.body.classList.toggle('indent-empty-p', conf.indentEmptyParagraphs === true);
  } catch (err) {
    toast(t('Could not read the advanced settings: {0}', err.message || err), 5000);
  }
}

async function openAdvanced(reset) {
  if (!isNative) return;
  if (reset) {
    if ((await ask({ message: t('Revert advanced setting file to default one ?'), buttons: [t('Reset to Default'), t('Cancel')], style: 'warning' })) !== 0) return;
    await platform.writeText(advancedPath(), ADVANCED_TEMPLATE);
    keymap = {};
    commands.pushNativeMenu();
    return;
  }
  if (!(await platform.stat(advancedPath())).exists) await platform.writeText(advancedPath(), ADVANCED_TEMPLATE);
  platform.openExternal(advancedPath());
  toast(t('Some settings will only apply after a reload'));
}
systemDark.addEventListener('change', applyView);

// --- custom themes ----------------------------------------------------------------

// CSS files in the themes folder are loaded at startup. base.user.css always
// applies; any other file becomes an entry in the Themes menu and should
// scope its rules to :root[data-theme="<file name>"].
const TEMPLATE_THEME = `/* 复制这个文件并改名（例如 ocean.css），再把下面的 my-theme 换成新文件名，
   重新打开 Livemark 后它会出现在“主题”菜单里。 */
:root[data-theme="my-theme"] {
  --bg: #fbfaf7;
  --text: #2b2b2b;
  --muted: #6f6f6f;
  --faint: #b5b5b5;
  --border: #e2ded6;
  --soft: #f3f0ea;
  --accent: #b2542d;
  --font-body: Georgia, "Songti SC", serif;
  --font-heading: var(--font-body);
  --line-height: 1.8;
}
`;

async function themesDir() {
  if (!isNative || !info.appSupport) return null;
  const dir = path.join(info.appSupport, 'themes');
  await platform.mkdir(dir);
  if (!(await platform.stat(path.join(dir, 'my-theme.css'))).exists) await platform.writeText(path.join(dir, 'my-theme.css'), TEMPLATE_THEME);
  return dir;
}

async function loadCustomThemes() {
  const dir = await themesDir().catch(() => null);
  if (!dir) return;
  const files = (await platform.list(dir)).filter((f) => f.name.endsWith('.css'));
  for (const f of files) {
    const { text } = await platform.readText(f.path);
    document.head.append(h('style', { dataset: { userTheme: f.name } }, text));
    const id = path.stem(f.name);
    if (id !== 'base.user' && !THEMES.some(([x]) => x === id)) THEMES.push([id, id]);
  }
}

// --- small dialogs ----------------------------------------------------------------

// The status bar's count, in the unit picked in the word count popover (Typora's
// word count delimiter): words, characters, lines or reading minutes.
function countLabel(text = null) {
  const unit = settings.wordCountUnit || 'words';
  const md = text ?? editor.getMarkdown();
  if (unit === 'chars') return t('{0} 字符', md.length);
  if (unit === 'lines') return t('{0} 行', md.split('\n').length);
  if (unit === 'minutes') {
    const m = Math.round((text === null ? stats.words : countText(text).words) / (settings.readingSpeed || 382));
    return m < 1 ? t('≤ 1 分钟') : t('{0} 分钟', m);
  }
  return t('{0} 词', text === null ? stats.words : countText(text).words);
}

function wordCountPopover() {
  const sel = editor.sel();
  const picked = sel && !sel.collapsed ? countText(plainOf(editor.rangeMarkdown(sel))) : null;
  const minutes = Math.max(1, Math.round(stats.words / (settings.readingSpeed || 382)));
  // Clicking a row shows that count in the status bar from now on.
  const row = (label, value, extra, unit) => {
    const tr = h('tr', { class: unit ? `stats-pick${(settings.wordCountUnit || 'words') === unit ? ' current' : ''}` : '' }, h('th', {}, label), h('td', {}, String(value)), picked ? h('td', {}, extra === undefined ? '' : String(extra)) : null);
    if (unit) tr.addEventListener('click', () => { setPref({ wordCountUnit: unit }); els.words.textContent = countLabel(); });
    return tr;
  };
  popover(els.words, h('table', { class: 'stats' },
    picked ? h('tr', {}, h('th', {}, ''), h('td', {}, t('全文')), h('td', {}, t('In Selection'))) : null,
    row(t('词数'), stats.words, picked?.words, 'words'),
    row(t('字符数'), stats.chars, picked?.chars, 'chars'),
    row(t('字符数（不含空格）'), stats.charsNoSpace, picked?.charsNoSpace),
    row(t('行数'), stats.lines, undefined, 'lines'),
    row(t('预计阅读'), t('{0} 分钟', minutes), undefined, 'minutes')));
}

// The outline as a floating panel, for when the sidebar is closed.
// The floating outline (Typora's unpinned outline panel): stays open while the document
// scrolls, folds like the sidebar's, follows the current heading; ✕ closes it, the pin
// puts it back in the sidebar.
let floatingOutline = null;
function outlinePopover() {
  if (floatingOutline) return closeFloatingOutline();
  const nav = h('nav', { class: 'outline outline-pop' });
  const draw = () => {
    const nodes = sidebar.outlineNodes((i) => app.jumpToHeading(i), draw);
    nav.replaceChildren(...(nodes.length ? nodes : [h('div', { class: 'side-empty' }, t('Outline is Empty.'))]));
    nav.querySelector('.outline-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const head = h('div', { class: 'outline-float-head' },
    h('span', { class: 'outline-float-title' }, t('Outline')),
    h('button', { type: 'button', class: 'outline-pin', title: t('Pin Outline'), 'aria-label': t('Pin Outline'), onclick: () => {
      closeFloatingOutline();
      app.showSidebar('outline');
    } }, '⇤'),
    h('button', { type: 'button', class: 'outline-close', title: t('Close'), 'aria-label': t('Close'), onclick: closeFloatingOutline }, '✕'));
  const panel = h('div', { class: 'outline-float', role: 'dialog', 'aria-label': t('Outline') }, head, nav);
  // The title bar moves it.
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (m) => Object.assign(panel.style, { left: `${Math.max(0, m.clientX - dx)}px`, top: `${Math.max(0, m.clientY - dy)}px`, right: 'auto' });
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  document.body.append(panel);
  floatingOutline = { panel, draw };
  sidebar.onActive = draw;
  draw();
}
function closeFloatingOutline() {
  floatingOutline?.panel.remove();
  floatingOutline = null;
  sidebar.onActive = null;
}

async function insertTableDialog(resize = false) {
  const cell = resize ? editor.currentCell() : null;
  const colsIn = h('input', { type: 'number', class: 'field', min: 1, max: 20, value: cell ? cell.n : 3, 'aria-label': t('列数'), dataset: { touch: 'cols' } });
  const rowsIn = h('input', { type: 'number', class: 'field', min: 1, max: 100, value: cell ? cell.b.rows.length - 1 : 2, 'aria-label': t('行数'), dataset: { touch: 'rows' } });
  // The Touch Bar shows steppers for the two numbers while this dialog is up.
  const sync = () => { touchMode = ''; syncTouchBar(); };
  colsIn.addEventListener('input', sync);
  rowsIn.addEventListener('input', sync);
  const ok = await modal({ title: resize ? t('调整表格大小') : t('插入表格'), body: h('div', { class: 'grid-form' }, h('label', {}, t('列')), colsIn, h('label', {}, t('行')), rowsIn), buttons: [{ label: t('取消'), value: null }, { label: resize ? t('调整') : t('插入'), value: true, primary: true }], onOpen: (box) => { box.dataset.touch = 'insertTable'; sync(); } });
  if (!ok) return;
  const c = Math.max(1, Math.min(20, Number(colsIn.value) || 3));
  const r = Math.max(1, Math.min(100, Number(rowsIn.value) || 2));
  if (resize) editor.resizeTable(c, r);
  else editor.insertTable(c, r);
}

async function properties() {
  // A saved document: Finder's Get Info window (the in-app summary when that is not available).
  if (isNative && doc.path && platform.showInfo && (await platform.showInfo(doc.path).catch(() => false))) return;
  let st = null;
  if (doc.path) st = await platform.stat(doc.path).catch(() => null);
  const row = (k, v) => h('tr', {}, h('th', {}, k), h('td', {}, v));
  modal({ title: t('属性'), body: h('table', { class: 'stats' },
    row(t('名称'), doc.name),
    row(t('位置'), doc.path ? path.dirname(doc.path) : t('尚未保存')),
    st?.exists ? row(t('大小'), `${(st.size / 1024).toFixed(1)} KB`) : null,
    st?.exists ? row(t('修改时间'), new Date(st.mtime).toLocaleString()) : null,
    row(t('词数'), String(stats.words)),
    row(t('字符数'), String(stats.chars)),
    row(t('行数'), String(stats.lines))) });
}

function about() {
  modal({ title: 'Livemark', body: [h('p', { class: 'dialog-detail' }, t('即时渲染的 Markdown 编辑器。')), h('p', { class: 'dialog-detail' }, t('版本 {0} · {1}', '0.4', t(isNative ? 'Mac 应用' : '浏览器')) + (info.pandoc ? t(' · 已检测到 pandoc') : '')), h('p', { class: 'dialog-detail' }, t('使用了 KaTeX、Mermaid、highlight.js。'))] });
}

async function openHelp(file, heading = '') {
  try {
    const res = await fetch(`./${file}`);
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    const name = `${t({ 'welcome.md': '快速上手', 'docs/markdown-reference.md': 'Markdown 参考', 'docs/shortcuts.md': '快捷键' }[file]) || path.stem(file)}.md`;
    // A document is open here: the help page gets a window of its own (a copy
    // under Application Support), like a help link opening elsewhere.
    if (isNative && info.appSupport && (doc.path || doc.dirty)) {
      const copy = path.join(info.appSupport, 'help', name);
      await platform.mkdir(path.dirname(copy)).catch(() => {});
      await platform.writeText(copy, text);
      platform.newWindow(copy);
      return;
    }
    if (!(await confirmDiscard())) return;
    showText(text, { name });
    setDirty(false);
    doc.saved = editor.getMarkdown();
    doc.eolChanged = false;
    const at = heading ? editor.doc.findIndex((b) => b.type === 'h' && b.text.trim().toLowerCase() === heading.toLowerCase()) : -1;
    if (at >= 0) editor.focusBlock(at, false);
  } catch (err) {
    toast(t('无法打开帮助：{0}', err.message || err));
  }
}

// --- window chrome ----------------------------------------------------------------

document.addEventListener('keydown', (e) => commands.handleKey(e), true);
els.sidebarBtn.addEventListener('click', () => app.toggleSetting('sidebar'));
els.sourceBtn.addEventListener('click', () => toggleSource());
els.words.addEventListener('click', wordCountPopover);

if (isNative) document.body.classList.add('native');

on('openFile', ({ path: p }) => openPath(p, { external: true }));
// Files and folders dropped on the window: open them or link to them, as
// the Files settings say; pictures are inserted.
const IMPORT_DROP = /\.(latex|ltx|tex|wiki|dokuwiki|docx|rst|rest|org|textile|opml)$/i;
on('dropFiles', async ({ paths = [], x, y }) => {
  // Onto the folder tree: the files move into that folder.
  const zoom = appliedZoom || 1;
  const dir = Number.isFinite(x) ? sidebar.dropFolderAt(document.elementFromPoint(x / zoom, y / zoom)) : null;
  if (dir) return sidebar.moveInto(paths, dir);
  // Into the document: at the drop point.
  if (Number.isFinite(x) && !sourceMode) editor.caretAtPoint(x / zoom, y / zoom);
  return dropPaths(paths);
});
on('fileDragEnded', () => sidebar.dragEnded());
// A file dragged from the sidebar and let go over the document: as if it came from Finder.
window.addEventListener('drop', async (e) => {
  const from = sidebar.dragging;
  if (!from || sidebar.body.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  sidebar.dragEnded();
  const st = await platform.stat(from).catch(() => ({}));
  // A folder opens (in a window of its own when this one is in use) unless folders are linked.
  if (st.isDir && !isBundle(from) && settings.dropFolder !== 'link') {
    if (isNative && (doc.path || doc.dirty || sidebar.root)) return platform.newWindow(from);
    return openFolder(from);
  }
  // A file from the sidebar becomes a link (a picture an image) where it is dropped.
  if (!sourceMode) editor.caretAtPoint(e.clientX, e.clientY);
  if (isImageName(from)) return placeImagePath(from);
  editor.insertText(`[${path.basename(from)}](${mdPath(doc.path ? path.relative(docDir(), from) : from)})`);
}, true);
window.addEventListener('dragover', (e) => {
  if (!sidebar.dragging || sidebar.body.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
}, true);
async function dropPaths(paths) {
  let placed = 0;
  for (const p of paths) {
    const st = await platform.stat(p).catch(() => ({ exists: false }));
    if (!st.exists) continue;
    // Several files: each one in a paragraph of its own.
    const inserts = !(st.isDir && !isBundle(p) && settings.dropFolder !== 'link') && !(isMarkdownName(p) && settings.dropFile !== 'link') && !(IMPORT_DROP.test(p) && settings.dropImport !== 'link');
    if (inserts && placed++ > 0 && !sourceMode) {
      const sel = editor.getSel() || editor.lastSel;
      if (sel) editor.enter(sel);
    }
    const link = () => editor.insertText(`[${path.basename(p)}](${mdPath(doc.path ? path.relative(docDir(), p) : p)})`);
    if (st.isDir && !isBundle(p)) {
      if (settings.dropFolder === 'link') link();
      else if (isNative && (doc.path || doc.dirty || sidebar.root)) platform.newWindow(p);
      else await openFolder(p);
    } else if (IMPORT_DROP.test(p)) {
      // Formats Pandoc reads: import them, or link to them, as the Files settings say.
      if (settings.dropImport === 'link') link();
      else await importFile(p);
    } else if (isMarkdownName(p)) {
      if (settings.dropFile === 'link') link();
      else if (doc.path || doc.dirty) platform.newWindow(p);
      else await openPath(p);
    } else if (isImageName(p)) await placeImagePath(p);
    else if (/\.(mp4|m4v|mov|webm|ogv)$/i.test(p)) editor.insertBlockAfter({ id: uid(), q: 0, indent: 0, type: 'html', text: `<video src="${mdPath(doc.path ? path.relative(docDir(), p) : p)}" controls></video>` });
    else if (/\.(mp3|m4a|wav|aac|flac|oga|ogg|opus)$/i.test(p)) editor.insertBlockAfter({ id: uid(), q: 0, indent: 0, type: 'html', text: `<audio src="${mdPath(doc.path ? path.relative(docDir(), p) : p)}" controls></audio>` });
    else link();
  }
}
on('closeRequested', async () => {
  rememberPosition();
  if (!(await confirmDiscard())) return;
  await rememberClosed(doc.path);
  // Closing after "Don't Save" (or with nothing unsaved) leaves no draft to
  // bring back; drafts are for crashes and forced quits.
  clearDraft();
  platform.closeWindow();
});
on('focus', checkDisk);
// The print panel's "new page for each top-level heading" box.
on('printSplit', ({ on: split }) => document.body.classList.toggle('page-break-h1', !!split));
const imageStamps = new Map();
async function refreshLocalImages() {
  if (!isNative) return;
  const imgs = [...els.write.querySelectorAll('img, video')].slice(0, 80);
  for (const el of imgs) {
    const raw = el.getAttribute('src') || '';
    const base = raw.replace(/([?&])lm=\d+$/, '').replace(/[?&]$/, '');
    const file = /^livemark:\/\/fs\//.test(base) ? decodeURIComponent(base.slice('livemark://fs/'.length)) : /^file:\/\//.test(base) ? decodeURIComponent(base.slice(7)) : null;
    if (!file) continue;
    const st = await platform.stat(file).catch(() => null);
    if (!st?.exists) continue;
    const before = imageStamps.get(file);
    imageStamps.set(file, st.mtime);
    if (before && before !== st.mtime) el.setAttribute('src', `${base}${base.includes('?') ? '&' : '?'}lm=${st.mtime}`);
  }
}
on('focus', () => refreshLocalImages());
on('fileChanged', ({ path: p }) => {
  if (p === doc.file) checkDisk();
});
// Edit > Select All (menu or Cmd+A) within the field, code block or front matter being edited.
on('selectAll', () => selectAllScoped());
function selectAllScoped() {
  const el = document.activeElement;
  const field = el && el !== els.write && !els.write.contains(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  if (field) return el.select ? el.select() : document.execCommand('selectAll');
  if (sourceMode) return els.source.select();
  if (!editor.selectBlockText()) document.execCommand('selectAll');
}
// Holding Cmd (or Ctrl) shows the pointer over links, as Cmd+click opens them.
const cmdHeld = (on) => document.body.classList.toggle('cmd-held', on);
document.addEventListener('keydown', (e) => cmdHeld(e.metaKey || e.ctrlKey));
document.addEventListener('keyup', (e) => cmdHeld(e.metaKey || e.ctrlKey));
window.addEventListener('blur', () => cmdHeld(false));
// In Focus + Typewriter Mode, scrolling with the wheel shows the whole document until
// the caret moves again.
els.scroller.addEventListener('wheel', (e) => {
  if (e.metaKey || e.ctrlKey || !settings.focusMode || !settings.typewriter) return;
  document.body.classList.add('focus-lifted');
}, { passive: true });
document.addEventListener('selectionchange', () => document.body.classList.remove('focus-lifted'));

// The sidebar's folder changed on disk (another app, Finder, git…).
let folderTimer = 0;
on('folderChanged', ({ root, rootGone }) => {
  if (root !== sidebar.root) return;
  clearTimeout(folderTimer);
  folderTimer = setTimeout(async () => {
    if (rootGone) return sidebar.setRoot(null);
    const top = sidebar.body.scrollTop;
    await sidebar.refresh();
    sidebar.body.scrollTop = top;
  }, 150);
});
on('fullscreen', ({ on: full }) => document.body.classList.toggle('fullscreen', !!full));
window.addEventListener('focus', checkDisk);
// The keyboard layout can change between visits to the window.
async function syncKeyboardLayout() {
  if (!platform.keyboardLayout) return;
  const was = editor.opts.keyboardLayout;
  editor.opts.keyboardLayout = await platform.keyboardLayout().catch(() => '');
  // Some shortcuts depend on the layout (see menus.js): the menus follow a change.
  if (was !== undefined && was !== editor.opts.keyboardLayout) commands.pushNativeMenu();
}
window.addEventListener('focus', syncKeyboardLayout);
syncKeyboardLayout();
window.addEventListener('beforeunload', (e) => {
  if (!isNative && doc.dirty && doc.path) e.preventDefault();
});

// Dropping a Markdown file anywhere on the window opens it (browser).
window.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
window.addEventListener('drop', async (e) => {
  const file = [...e.dataTransfer.files].find((f) => isMarkdownName(f.name));
  if (!file) return;
  e.preventDefault();
  if (await confirmDiscard()) showText(await file.text(), { name: file.name, saved: '' });
});

// --- boot -------------------------------------------------------------------------

async function boot() {
  try {
    info = { ...info, ...(await platform.ready()) };
  } catch {
    /* running without a host bridge */
  }
  await loadSettings();
  await loadAdvanced();
  // Smart quotes follow the system's keyboard preference (System Settings → Keyboard → Text).
  if (platform.systemQuotes) systemQuotes = await platform.systemQuotes().then((q) => (Array.isArray(q) && q.length === 4 ? q : null)).catch(() => null);
  await loadCustomThemes().catch(() => {});
  closedFiles = (await platform.storeGet('closed')) || [];
  if (platform.spellInfo) {
    platform.spellInfo().then((res) => {
      spellLangs = (res.languages || []).map((l) => [l.id, l.name]);
    }, () => {});
    if (settings.spellLang !== 'auto') platform.spellSetLanguage(settings.spellLang).catch(() => {});
  }
  if (settings.windowStyle !== 'classic') platform.setWindowStyle?.(settings.windowStyle);
  if (settings.magnification) platform.setMagnification?.(true);
  completer = installEmojiComplete(editor, () => settings.emojiComplete && settings.emoji, { languages: () => languageList() });
  applyView();
  commands.renderMenubar(els.menubar);
  commands.pushNativeMenu();
  if (settings.alwaysOnTop) platform.setAlwaysOnTop(true);

  onRichReady(() => {
    editor.rerenderAll();
    const list = $('#lang-list');
    if (list && !list.childElementCount) list.append(...languageList().map((l) => h('option', { value: l })));
  });
  initRich();

  await loadPositions();
  const firstWindow = !isNative || info.windowId === 1;
  // Drafts left by the last session: untitled documents come back in this window,
  // files with unsaved changes come back when opened (the newest one right away).
  const drafts = firstWindow ? await loadDrafts() : { untitled: [], files: [] };
  const draft = drafts.untitled[0];
  const fileDraft = !draft && drafts.files[0];
  if (info.openPath) await openPath(info.openPath, { external: true });
  else if (draft) {
    showText(draft.text, { name: draft.name || UNTITLED, saved: draft.saved || '' });
    // It now lives under this window's key; any further untitled drafts come back on later launches.
    if (draft.key !== untitledDraftKey()) platform.storeSet(draft.key, null);
    saveDraft(draft.text);
  } else if (fileDraft && (await platform.stat(fileDraft.path).catch(() => ({}))).exists) await openPath(fileDraft.path);
  // Only the window the app launches with picks up where the last session
  // left off; a new window or tab starts empty.
  else if (firstWindow && settings.launch === 'restore' && isNative && (await restoreSession())) {
    /* every window open at quit is back */
  } else if (firstWindow && settings.launch === 'restore' && isNative && settings.lastFile && (await platform.stat(settings.lastFile)).exists) await openPath(settings.lastFile);
  else if (!settings.recent.length) {
    const text = await (await fetch('./welcome.md')).text();
    showText(text, { name: `${t('快速上手')}.md` });
  } else showText('');

  const startFolder = settings.launch === 'folder' ? settings.launchFolder : settings.launch === 'restore' || settings.launch === 'restoreFolders' ? settings.folder : null;
  if (firstWindow && isNative && startFolder && (await platform.stat(startFolder)).exists) {
    sidebar.implicit = false;
    await sidebar.setRoot(startFolder);
    if (settings.launch === 'folder') app.showSidebar('tree');
  }
  document.body.classList.add('ready');
  // A window that opens in Focus or Typewriter Mode says so (as turning it on does).
  for (const [key, hint, label] of [['focusMode', 'noWarnigForFocusMode', 'Focus Mode'], ['typewriter', 'noWarnigForTypeWriterMode', 'Typewriter Mode']]) {
    if (settings[key]) showHint({ key: hint, title: t('<strong>%@</strong> has been turned on.').replace('%@', t(label)), body: t('You could turn it off from `View` menu.') });
  }
}

// The files that were open in windows when the app last quit: the front one opens
// here, the others in windows of their own. False when there is nothing to bring back.
async function restoreSession() {
  const list = await platform.storeGet('session').catch(() => null);
  if (!Array.isArray(list)) return false;
  const paths = [];
  for (const p of list) if (typeof p === 'string' && (await platform.stat(p).catch(() => ({}))).exists) paths.push(p);
  if (!paths.length) return false;
  await openPath(paths[0]);
  for (const p of paths.slice(1).reverse()) await platform.newWindow(p).catch(() => {});
  // The window that was in front at quit stays in front.
  if (paths.length > 1) setTimeout(() => platform.focusWindow?.().catch(() => {}), 800);
  return true;
}

// A handle for the console and for automated checks.
window.livemark = { editor, app, commands, finder, sidebar, doc };

boot();
