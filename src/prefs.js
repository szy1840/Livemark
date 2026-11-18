// Settings and the Settings window.

import { platform, isNative } from './platform.js';
import { h, modal, showMenu, ask } from './ui.js';
import { t, lang, langPref } from './i18n.js';
import { DEFAULT_LIST, FIXED, TEMPLATES, SCHEMA, COMMAND_PRESETS, PAPER_MM, templateName, configOf, newEntry, argPreview } from './export-config.js';

export const THEMES = [
  ['github', 'Github'],
  ['gothic', 'Gothic'],
  ['newsprint', 'Newsprint'],
  ['night', 'Night'],
  ['pixyll', 'Pixyll'],
  ['whitey', 'Whitey'],
];

// Suggested in Settings → Default Code Language.
const CODE_LANGS = ['javascript', 'typescript', 'json', 'python', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'swift', 'kotlin', 'ruby', 'php', 'shell', 'bash', 'sql', 'html', 'css', 'scss', 'xml', 'yaml', 'markdown', 'latex', 'lua', 'perl', 'r', 'scala', 'haskell', 'objectivec', 'dart', 'diff', 'dockerfile', 'nginx', 'mermaid'];

const DEFAULTS = {
  lang: langPref,
  // --- files
  launch: 'new', // 'new' | 'restoreFolders' | 'restore' (files and folders) | 'folder'
  launchFolder: '',
  dropFile: 'open', // 'open' | 'link'
  dropFolder: 'open',
  dropImport: 'import', // files Pandoc can import: 'import' | 'link'
  defaultExt: 'md', // 'md' | 'markdown' | 'text' | any custom extension
  draftBackup: true,
  autoSave: false,
  saveOnSwitch: false,
  recordRecent: true,
  showHidden: false,
  treeFilter: 'supported', // 'supported' | 'custom' | 'all'
  treePatterns: [],
  libraryFilter: 'supported', // 'supported' | 'custom'
  libraryPatterns: [],
  pinned: [],
  treeSort: 'natural-asc', // <name | natural | date | created>-<asc | desc>
  listSort: 'natural-asc',
  listGroup: false,
  textPack: true,
  indentSize: 2,
  prettyIndent: false,
  mathLegacy: false,
  mathDelims: true, // \\( \\) and \\[ \\] delimiters
  mathCopyFormat: 'svg',
  spellcheckCode: false,
  lineEnding: 'lf',
  finalNewline: true,
  outlineCollapsible: true,
  alwaysWordCount: true,
  readingSpeed: 382,
  wordCountUnit: 'words', // status bar: 'words' | 'chars' | 'lines' | 'minutes'
  findOpts: { caseSensitive: false, wholeWord: false, regex: false },
  sideSearchOpts: { caseSensitive: false, wholeWord: false, regex: false },
  sidebarWidth: 0, // 0: the theme's width
  treeGroup: true, // file tree: folders first
  // --- editor
  autoPair: true,
  autoPairMd: false,
  smartMode: 'input', // 'input' | 'render'
  smartQuotes: false,
  smartDashes: false,
  remapPunct: false,
  typewriterCenter: true,
  codeIndent: 4,
  shiftTabIndentCode: false,
  sourceOnFocus: false,
  copyPlainSource: true,
  copyLine: false,
  emojiComplete: true,
  defaultCodeLang: '',
  defaultLangOnMd: true,
  defaultLangOnMenu: true,
  spellcheck: false,
  spellLang: 'auto',
  indentFirstLine: false,
  visibleBr: true, // Typora shows the <br/> source by default (hideBrAndLineBreak off)
  preserveBreaks: true,
  exportBreaks: true, // Export / Print keeps single line breaks (Typora sets this on first launch)
  // --- image
  imageAction: 'keep', // 'keep' | 'copy-cur' | 'copy-assets' | 'copy-name' | 'copy' | 'upload'
  imageFolder: './assets',
  imgRuleLocal: true,
  imgRuleOnline: false,
  imageRelative: true,
  imgDotSlash: false,
  imgEscape: true,
  imgYamlUpload: false,
  imgSyntax: 'md', // 'md' | 'html'
  uploader: '', // '' (none) | 'custom' | 'picgo-app' | 'piclist' | 'upic' | 'picgo-core'
  uploaderPath: '',
  uploadCommand: '',
  // --- markdown
  strictMode: true,
  headingStyle: 'atx', // 'atx' | 'setext' | 'atx-closed' | 'setext-wide'
  ulMarker: '-',
  olMarker: '.',
  olStyle: 'increment', // 'increment' (1. 2. 3.) | 'same' (1. 1. 1.)
  mathInline: false,
  subscript: false,
  superscript: false,
  highlight: false,
  emoji: true,
  diagrams: true,
  autoLinks: true,
  alerts: true,
  mathFence: false,
  mathNumbering: 'none', // 'none' | 'ams' | 'all'
  mathPhysics: false,
  defLocation: 'doc', // 'doc' | 'section' | 'block'
  refLinks: false,
  lineNumbers: false,
  codeWrap: true,
  // --- export: the user's list of export entries and every entry's settings (see export-config.js)
  exportList: structuredClone(DEFAULT_LIST),
  exportCfg: {}, // key -> { field: value }; 'general' holds the Export page's own settings
  pandocPath: '',
  // --- appearance
  theme: 'github',
  darkTheme: 'night',
  followSystem: true, // Typora turns on a separate dark-mode theme on first launch (useSeparateDarkTheme)
  fontSizeCustom: false, // Auto: the theme's size
  fontSize: 14,
  contentWidth: 860,
  zoom: 1,
  windowStyle: 'unibody', // 'classic' | 'unibody' — Typora starts with the seamless window (use_seamless_window)
  toolbar: false,
  statusBar: true,
  wheelZoom: false,
  magnification: false,
  customCss: '',
  sidebar: true,
  sidebarTab: 'outline',
  focusMode: false,
  typewriter: false,
  alwaysOnTop: false,
  // --- general
  quitOnLastWindow: false,
  debug: false,
  dismissed: {},
  recent: [],
  recentFolders: [],
  closed: [],
  folder: null,
  lastFile: null,
};

export const settings = { ...DEFAULTS };
const listeners = new Set();
export const onSettings = (fn) => listeners.add(fn);

// Settings saved by earlier versions used a few different names.
function migrate(saved) {
  const out = { ...saved };
  if ('restoreLast' in out && !('launch' in out)) out.launch = out.restoreLast ? 'restore' : 'new';
  if ('smartPunct' in out && !('smartQuotes' in out)) out.smartQuotes = out.smartDashes = !!out.smartPunct;
  if (typeof out.mathNumbering === 'boolean') out.mathNumbering = out.mathNumbering ? 'all' : 'none';
  if ('exportMargin' in out && !('exportMarginTop' in out)) for (const side of ['Top', 'Right', 'Bottom', 'Left']) out[`exportMargin${side}`] = out.exportMargin;
  // One sort order for both file panels became one per panel.
  if ('fileSort' in out) { out.treeSort = out.treeSort || out.fileSort; out.listSort = out.listSort || out.fileSort; }
  if ('fileGroup' in out && !('listGroup' in out)) out.listGroup = out.fileGroup;
  delete out.fileSort;
  delete out.fileGroup;
  // The margins every side used to default to; the defaults are now 45 / 36.
  if (['Top', 'Right', 'Bottom', 'Left'].every((side) => out[`exportMargin${side}`] === 40)) {
    out.exportMarginTop = out.exportMarginBottom = 45;
    out.exportMarginLeft = out.exportMarginRight = 36;
  }
  // One "show all files" switch and one pattern list became a filter per panel.
  if ('treeAllFiles' in out || 'filePatterns' in out) {
    const pats = String(out.filePatterns || '').split('\n').map((x) => x.trim()).filter(Boolean);
    out.treeFilter = out.treeFilter || (out.treeAllFiles ? 'all' : pats.length ? 'custom' : 'supported');
    out.treePatterns = out.treePatterns || pats;
  }
  if ('subSup' in out && !('subscript' in out)) out.subscript = out.superscript = !!out.subSup;
  if (out.defaultExt === 'txt') out.defaultExt = 'text';
  // Older versions always applied their own font size.
  if ('fontSize' in out && !('fontSizeCustom' in out)) out.fontSizeCustom = out.fontSize !== 16;
  // One set of PDF / HTML / Image / Pandoc settings became one per export entry.
  if (!out.exportCfg && ['exportPaper', 'exportHeader', 'htmlHead', 'imageWidth', 'customExports', 'afterExport', 'exportCommand', 'exportFolder', 'pandocArgs'].some((k) => k in out)) {
    const cfg = {};
    const mm = (pt) => Math.round((pt * 25.4) / 72);
    const margins = ['Top', 'Right', 'Bottom', 'Left'].map((sd) => out[`exportMargin${sd}`]);
    const customMargin = margins.some((v) => v !== undefined) && !(margins[0] === 45 && margins[2] === 45 && margins[1] === 36 && margins[3] === 36);
    cfg.pdf = { paper: out.exportPaper && out.exportPaper !== 'A4' ? out.exportPaper : out.exportPaper === 'A4' ? 'A4' : '', exportTheme: out.exportTheme || '', splitPages: !!out.exportPageBreak, header: out.exportHeader || '', footer: out.exportFooter || '', outline: out.exportOutline !== false, allowPerFileSetting: out.exportYaml !== false };
    if (customMargin) Object.assign(cfg.pdf, { 'paper.margin': 'custom', 'paper.marginTop': mm(margins[0] ?? 45), 'paper.marginRight': mm(margins[1] ?? 36), 'paper.marginBottom': mm(margins[2] ?? 45), 'paper.marginLeft': mm(margins[3] ?? 36) });
    cfg.html = { exportTheme: out.exportTheme || '', appendHead: out.htmlHead || '', appendBody: out.htmlBody || '', allowPerFileSetting: out.exportYaml !== false };
    cfg['html-plain'] = { appendHead: out.htmlHead || '', appendBody: out.htmlBody || '', allowPerFileSetting: out.exportYaml !== false };
    cfg.image = { imageWidth: out.imageWidth || 640, quality: out.imageFormat === 'jpeg' ? 2 : 0 };
    cfg.general = { exportFolder: out.exportFolder === 'custom' ? 'custom' : out.exportFolder === 'same' ? 'same' : '', customExportPath: out.exportFolderPath || '', openExportLocation: out.afterExport === 'reveal' };
    const list = structuredClone(DEFAULT_LIST);
    const extra = [out.pandocWrap && out.pandocWrap !== 'preserve' ? `--wrap=${out.pandocWrap}` : '', out.pandocAscii ? '--ascii' : '', out.pandocArgs || ''].filter(Boolean).join(' ');
    for (const e of list) cfg[e.key] = extra ? { extraArguments: extra } : {};
    (out.customExports || []).forEach((x, k) => {
      const key = k ? `custom${k}` : 'custom';
      list.push({ key, name: x.name || 'Custom', type: 'custom' });
      cfg[key] = { command: x.command || '', saveDialog: 'saveFile', extensions: x.ext || '' };
    });
    for (const e of [...FIXED, ...list]) {
      if (e.type === 'custom') continue;
      if (out.afterExport === 'open') cfg[e.key].openExportFile = true;
      if ((out.exportCommand || '').trim()) Object.assign(cfg[e.key], { runCommand: true, runCommandStr: out.exportCommand, showOutput: !!out.exportShowOutput });
    }
    out.exportCfg = cfg;
    out.exportList = list;
  }
  for (const k of ['exportPaper', 'exportMarginTop', 'exportMarginRight', 'exportMarginBottom', 'exportMarginLeft', 'exportHeader', 'exportFooter', 'exportPageBreak', 'exportOutline', 'exportTheme', 'htmlHead', 'htmlBody', 'imageWidth', 'imageFormat', 'imageQuality', 'exportFolder', 'exportFolderPath', 'exportYaml', 'afterExport', 'exportCommand', 'exportShowOutput', 'pandocWrap', 'pandocAscii', 'pandocArgs', 'customExports']) delete out[k];
  delete out.treeAllFiles;
  delete out.filePatterns;
  delete out.subSup;
  delete out.restoreLast;
  delete out.smartPunct;
  delete out.exportMargin;
  return out;
}

export async function loadSettings() {
  const saved = await platform.storeGet('settings');
  if (saved && typeof saved === 'object') Object.assign(settings, migrate(saved));
  settings.lang = langPref;
  return settings;
}

let saveTimer = null;
export function set(patch, { quiet = false } = {}) {
  Object.assign(settings, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => platform.storeSet('settings', settings), 200);
  if (!quiet) listeners.forEach((fn) => fn(patch));
}

export function addRecent(key, value, max = 12) {
  if (!settings.recordRecent) return;
  set({ [key]: [value, ...settings[key].filter((x) => x !== value)].slice(0, max) });
}

// The folder newly inserted images are copied to, as a path that may use
// ${filename} for the document's name without its extension.
export const IMAGE_FOLDERS = { 'copy-cur': './', 'copy-assets': './assets', 'copy-name': './${filename}.assets' };

// Command line for each supported upload tool; the image paths are appended.
export function uploaderCommand(s = settings) {
  const q = (p) => `"${p}"`;
  switch (s.uploader) {
    case 'picgo-app': return `${q(s.uploaderPath || '/Applications/PicGo.app/Contents/MacOS/PicGo')} upload`;
    case 'piclist': return `${q(s.uploaderPath || '/Applications/PicList.app/Contents/MacOS/PicList')} upload`;
    case 'upic': return `${q(s.uploaderPath || '/Applications/uPic.app/Contents/MacOS/uPic')} -o url -u`;
    case 'picgo-core': return `${s.uploaderPath ? q(s.uploaderPath) : 'picgo'} upload`;
    case 'custom': return s.uploadCommand.trim();
    default: return '';
  }
}

// --- the window ---------------------------------------------------------------


// [key, kind, label, hint, extra, opts]. opts: { native } hides a row in the
// browser, { when } shows it only while a condition on the settings holds.
// The categories and their order follow the usual layout of a Mac Markdown
// editor's settings: Files first, General last.
const SECTIONS = (ctx) => [
  ['Files', [
    ['head', 'On Launch'],
    ['launch', 'select', '', 'This option may be overridden by "Close windows when quitting an application" in System Preferences', [['new', 'Open new file'], ['restoreFolders', 'Restore last closed folders'], ['restore', 'Restore last closed files and folders'], ['folder', 'Open custom folder']]],
    ['launchFolder', 'folder', 'Select Custom Folder…', '', null, { when: (s) => s.launch === 'folder', native: true }],
    ['head', 'Outline'],
    ['outlineCollapsible', 'check', 'Collapsible Outline on Left Panel'],
    ['head', 'Default File Type / Extension'],
    ['defaultExt', 'ext', ''],
    ['textPack', 'check', 'Support TextPack (.textpack)', '', null, { native: true }],
    ['head', 'Save & Recover'],
    ['saveOnSwitch', 'check', 'Save without asking when switch files on side panel', 'Edited files will be saved without asking when switch files in left panel.  When "Ask to keep changes when closing documents" is disabled in System Preference, this is always enabled.'],
    ['autoSave', 'check', 'Auto Save'],
    ['draftBackup', 'check', 'Back Up Unsaved Drafts'],
    ['finalNewline', 'check', 'Insert final new line on save'],
    ['lineEnding', 'select', 'Default Line Ending', '', [['lf', 'LF (Unix Style)'], ['crlf', 'CRLF (Windows Style)']]],
    ['recoverDrafts', 'button', 'Recover Unsaved Drafts'],
    ['head', 'Recent Locations'],
    ['recordRecent', 'check', 'Record recent files and folders'],
    ['clearRecent', 'button', 'Clear Recent Folders and Files'],
    ['clearPinned', 'button', 'Clear Recent and Pinned Folders / Files'],
    ['head', 'When drop file / folder into Livemark'],
    ['dropFolder', 'select', 'When drop folder', '', [['open', 'Open in Livemark'], ['link', 'Insert Folder Link']], { native: true }],
    ['dropFile', 'select', 'When drop markdown file', '', [['open', 'Open in Livemark'], ['link', 'Insert File Link']], { native: true }],
    ['dropImport', 'select', 'When drop files that can be imported', '', [['import', 'Import File'], ['link', 'Insert File Link']], { native: true }],
    ['head', 'File Tree / Library'],
    ['showHidden', 'check', 'Show hidden folders / files', '', null, { native: true }],
    ['treeFilter', 'filter', 'File Tree', 'Choose which files appear in the file tree and file library.', [['supported', 'Supported Files (Markdown & Plain Text)'], ['custom', 'Custom'], ['all', 'All Files']], { patterns: 'treePatterns', title: 'File Tree — Custom Patterns' }],
    ['libraryFilter', 'filter', 'File Library', '', [['supported', 'Supported Files (Markdown & Plain Text)'], ['custom', 'Custom']], { patterns: 'libraryPatterns', title: 'File Library — Custom Patterns' }],
  ]],
  ['Editor', [
    ['head', 'Indent Size on Save'],
    ['indentSize', 'select', '', 'only apply to quotes and lists created from menu bar or hybrid view', [[0, 'Auto'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [-1, 'Tab']]],
    ['prettyIndent', 'check', 'Pretty indentation'],
    ['indentPreview', 'indentPreview', ''],
    ['head', 'Auto Pair'],
    ['autoPair', 'check', 'Auto pair brackets and quotes'],
    ['autoPairMd', 'check', 'Auto pair common Markdown syntax', '', null, { disabled: (s) => !s.autoPair }],
    ['head', 'Auto Complete'],
    ['emojiComplete', 'check', 'Enable autocomplete for Emojis'],
    ['head', 'Live Rendering'],
    ['sourceOnFocus', 'check', 'Display source for simple blocks (including headings, etc.) on focus'],
    ['head', 'Default Copy Behavior', '( ⌘C )'],
    ['copyPlainSource', 'check', 'Copy Markdown source as plain text'],
    ['copyLine', 'check', 'Copy or cut the whole lines that have cursors on them, if there is no selection when doing copy / cut.'],
    ['head', 'Typewriter Mode'],
    ['typewriterCenter', 'check', 'Always keep caret in middle of screen when typewriter mode is enabled'],
    ['exitModes', 'button', 'Turn off Typewriter / Focus Mode'],
    ['head', 'Spell Check'],
    ['spellcheck', 'check', 'Check spelling while typing'],
    ['spellcheckCode', 'check', 'Spell check in code and links', '', null, { when: (s) => s.spellcheck }],
    ['spellLang', 'select', 'Spell Check', '', [['auto', 'Auto Detect Language'], ...ctx.spellLangs], { native: true, when: (s) => s.spellcheck }],
  ]],
  ['Image', [
    ['head', 'When Insert…', '', 'docs/images.md'],
    ['imageAction', 'select', '', '', [['keep', 'No special action'], ['copy-cur', 'Copy image to current folder (./)'], ['copy-assets', 'Copy image to ./assets'], ['copy-name', 'Copy image to ./${filename}.assets'], ['upload', 'Upload image'], ['copy', 'Copy image to custom folder']]],
    ['imageFolder', 'text', '', 'Please specify a relative path to current folder which begins with \'./\' or \'../\', or an absolute folder path. (`${filename}` representing for currents filename.)', null, { when: (s) => s.imageAction === 'copy', validate: async (v) => {
      // An absolute folder must exist, and may not be the root of the disk.
      if (!v.startsWith('/') || v.includes('${filename}')) return null;
      if (/^\/+$/.test(v)) return t('Cannot use root path.');
      const st = await platform.stat(v).catch(() => ({ exists: false }));
      return st.exists && st.isDir ? null : t('Folder not exist at %@, please input another path.').replace('%@', v);
    } }],
    ['imgRuleLocal', 'check', 'Apply above rules to local images'],
    ['imgRuleOnline', 'check', 'Apply above rules to online images', '', null, { native: true }],
    ['imgYamlUpload', 'check', 'Allow upload images automatically based on YAML settings', '', null, { native: true }],
    ['head', 'Preferred Image Syntax', '', 'docs/images.md'],
    ['imgSyntax', 'select', 'Preferred Image Syntax', '', [['md', 'Markdown Style'], ['html', 'HTML Style']]],
    ['imageRelative', 'check', 'Use relative path if possible'],
    ['imgDotSlash', 'check', 'Add ./ for relative path', 'When enabled, Livemark will use pattern like ./assets/image.png instead of assets/image.png when generating relative path for inserted images.', null, { disabled: (s) => !s.imageRelative }],
    ['imgEscape', 'check', 'Auto escape image URL when insert', "For example, if you insert a file at 'img/example file.png', it will become 'img/example%20file.png'."],
    ['head', 'Image Upload Setting', '', 'docs/images.md'],
    ['uploader', 'select', 'Image Uploader', '', [['', 'None'], ['upic', 'uPic'], ['picgo-core', 'PicGo-Core (command line)'], ['picgo-app', 'PicGo.app'], ['piclist', 'PicList'], ['custom', 'Custom Command']], { native: true }],
    ['uploaderPath', 'text', 'Executable', 'Leave empty for the default location', null, { native: true, empty: true, when: (s) => s.uploader && s.uploader !== 'custom' }],
    ['uploadCommand', 'text', 'Command', 'The image paths are appended; the command prints one URL per image, e.g. picgo upload', null, { native: true, empty: true, when: (s) => s.uploader === 'custom' }],
    ['testUploader', 'button', 'Test Uploader', '', null, { native: true, when: (s) => !!s.uploader }],
    ['uploaderDownload', 'button', 'Download {0}', '', null, { native: true, when: (s) => ['upic', 'picgo-app', 'piclist'].includes(s.uploader), label: (s) => ({ upic: 'uPic', 'picgo-app': 'PicGo', piclist: 'PicList' })[s.uploader] }],
    ['uploaderHelp', 'button', 'Instructions', '', null, { native: true, when: (s) => !!s.uploader }],
  ]],
  ['Markdown', [
    ['head', 'Syntax Preference', 'only apply to quotes and lists created from menu bar or hybrid view'],
    ['strictMode', 'check', 'Strict Mode', '(more strict to GFM spec)'],
    ['headingStyle', 'select', 'Heading Style', '', [['atx', 'atx (#)'], ['setext', 'setext (===)'], ['atx-closed', 'atx with suffix (# ⋯ #)'], ['setext-wide', 'variable-width setext (=====)']]],
    ['ulMarker', 'select', 'Unordered List', '', [['-', '-'], ['+', '+'], ['*', '*']]],
    ['olStyle', 'select', 'Ordered List', '', [['increment', '1. ⋯ 2. ⋯ 3. ⋯'], ['same', '1. ⋯ 1. ⋯ 1. ⋯']]],
    ['olMarker', 'select', 'Ordered List Delimiter', '', [['.', '1.'], [')', '1)']]],
    ['head', 'Syntax Support'],
    ['autoLinks', 'check', 'Auto Links (e.g: https://example.com)', 'When enabled, Livemark will auto recognize and highlight URLs (e.g: https://example.com ) without the need to wrap them in <>.'],
    ['mathInline', 'check', 'Inline Math  (e.g: $\\LaTeX$)'],
    ['subscript', 'check', 'Subscript    (e.g: H~2~O)'],
    ['superscript', 'check', 'Superscript (e.g: X^2^)'],
    ['highlight', 'check', 'Highlight     (e.g: ==key==)'],
    ['alerts', 'check', 'Github Style Alert'],
    ['diagrams', 'check', 'Diagrams', '(Sequence, Flowchart and Mermaid)'],
    ['emoji', 'check', 'Emoji (e.g. :smile:)'],
    ['head', 'Smart Punctuation', '', 'docs/markdown-reference.md'],
    ['smartMode', 'select', '', '<strong>Convert on Input</strong>: Input ASCII dashes or quotes, converted and saved as smart punctuation. <strong>Convert on Rendering</strong>: Input ASCII dashes or quotes, saved as ASCII ones, but displayed as smart punctuation.', [['input', 'Convert on Input'], ['render', 'Convert on Rendering']]],
    ['smartQuotes', 'check', 'Smart Quotes', 'You could set quote patterns in System Preferences → Keyboard → Text. If it is changed, you need to restart Livemark to apply that change.'],
    ['smartDashes', 'check', 'Smart Dashes', 'Convert -- to – (en dash), and --- to — (em dash)'],
    ['remapPunct', 'check', 'Remap Unicode Punctuation on Parse', '》 blockquote → > blockquote', null, { forced: (s) => s.smartMode === 'input' && (s.smartQuotes || s.smartDashes) }],
    ['head', 'Code Fences'],
    ['lineNumbers', 'check', 'Display line numbers for code fences'],
    ['codeWrap', 'check', 'Auto wrap long lines'],
    ['shiftTabIndentCode', 'check', 'Use Shift+Tab to auto indent selected code', 'When disabled, Shift+Tab will outdent selected code or current line.'],
    ['codeIndent', 'select', 'Indent Size for Code', '', [[2, '2'], [3, '3'], [4, '4'], [5, '5'], [0, 'Preserve tabs']]],
    ['defaultCodeLang', 'codeLang', 'Default Code Language'],
    ['defaultLangWhen', 'langWhen', 'Apply Default Code Language When'],
    ['head', 'Math', '', 'docs/markdown-reference.md'],
    ['mathInline', 'check', 'Inline Math  (e.g: $\\LaTeX$)'],
    ['mathDelims', 'check', 'LaTeX Math Delimiter \\( \\) \\[ \\]'],
    ['mathFence', 'check', 'Code Block Math  (```math code block)'],
    ['mathPhysics', 'check', 'Enable physics package', 'Physics package will redefine some latex macros, such as \\div, \\Re, etc.'],
    ['mathLegacy', 'check', 'Use legacy inline math parsing (compatible mode)', 'Off: inline math follows Pandoc-style rules (no space just inside the $ signs, and the closing $ is not followed by a digit). On: any pair of $ signs counts as math unless the closing one is escaped.', null, { when: (s) => s.mathInline }],
    ['mathNumbering', 'select', 'Auto Numbering Math Equations', '', [['none', 'No Automatic Equation Numbering'], ['ams', 'Use AMS Numbering Rules'], ['all', 'Auto Numbering for All Math Equations']]],
    ['mathCopyFormat', 'select', 'When copy / export as HTML (without style)', 'Take effects when export as HTML (without styles) or copy as HTML code, or copy without theme styling.', [['svg', 'Use Rendered SVG'], ['latex', 'Use LaTeX Source']]],
    ['head', 'Whitespace / Line Break', '', 'docs/markdown-reference.md'],
    ['indentFirstLine', 'check', 'Indent first line of paragraphs'],
    ['preserveBreaks', 'select', 'When Writing', '', [[true, 'Preserve sequential whitespace and single line break'], [false, 'Ignore sequential whitespace and single line break']]],
    ['visibleBr', 'check', 'Visible <br/>'],
    ['exportBreaks', 'select', 'Export / Print', '', [[true, 'Preserve sequential whitespace and single line break'], [false, 'Ignore sequential whitespace and single line break']]],
    ['head', 'Links and Footnotes'],
    ['refLinks', 'check', 'Use reference-style links rather than inline links'],
    ['defLocation', 'select', 'Footnotes and References Location', '', [['doc', 'End of document'], ['section', 'End of current section'], ['block', 'End of current (top-level) block']]],
  ]],
  ['Export', [
    ['exportPane', 'exportPane', ''],
  ]],
  ['Appearance', [
    ['head', 'Window Style'],
    ['windowStyle', 'radio', '', '', [['classic', 'Classic'], ['unibody', 'Seamless']], { native: true }],
    ['head', 'Font Size'],
    ['fontSize', 'fontSize', ''],
    ['contentWidth', 'number', 'Text Column Width', 'px', [560, 1600, 20]],
    ['head', 'Zoom'],
    ['zoom', 'zoom', ''],
    ['wheelZoom', 'check', 'Zoom when using mouse wheel and holding Command key'],
    ['head', 'Word Count'],
    ['alwaysWordCount', 'check', 'Always Show Word Count'],
    ['readingSpeed', 'speed', 'Reading Speed'],
    ['head', 'Toolbar'],
    ['toolbar', 'check', 'Show editor toolbar'],
    ['statusBar', 'check', 'Show status bar'],
    ['head', 'Themes', '', 'docs/custom-themes.md'],
    ['theme', 'select', 'Theme', '', THEMES],
    ['followSystem', 'check', 'Use separate theme in dark mode', 'Supported on macOS ≥ 10.15 or Windows 10 ≥ 1903'],
    ['darkTheme', 'select', 'Dark Theme', '', THEMES, { when: (s) => s.followSystem }],
    ['openThemes', 'button', 'Open Theme Folder', '', null, { native: true }],
    ['customCss', 'textarea', 'Custom CSS', ''],
  ]],
  ['General', [
    ['head', 'Quit'],
    ['quitOnLastWindow', 'check', 'Quit Livemark when last window is closed', '', null, { native: true }],
    ['head', 'Language', '(applied after restart)'],
    ['lang', 'select', '', '', [['system', 'System Language'], ['en', 'English'], ['zh', '简体中文']]],
    ['head', 'Shortcut Keys'],
    ['shortcutKeys', 'button', 'Custom Shortcut Keys'],
    ['head', 'Dialogs'],
    ['resetDialogs', 'button', 'Reset All Dialog Warnings'],
    ['head', 'Advanced Settings'],
    ['debug', 'check', 'Enable Debug', '', null, { native: true }],
    ['openAdvanced', 'button', 'Open Advanced Settings', '', null, { native: true }],
    ['resetAdvanced', 'button', 'Reset Advanced Settings', '', null, { native: true }],
  ]],
];

// Settings → Export: the list of export entries on the left (General, the fixed four,
// then the user's entries), the selected entry's settings on the right.
let exportSel = 'general';
function exportPane(actions) {
  const root = h('div', { class: 'export-pane' });
  const listBox = h('div', { class: 'export-list' });
  const form = h('div', { class: 'export-form' });
  const tools = h('div', { class: 'export-tools' });
  let renaming = false;
  const userList = () => settings.exportList || [];
  const entryOf = (key) => [...FIXED, ...userList()].find((x) => x.key === key);
  const saveCfg = (key, patch) => set({ exportCfg: { ...settings.exportCfg, [key]: { ...(settings.exportCfg[key] || {}), ...patch } } });

  const drawList = () => {
    const item = (key, name) => {
      if (renaming && key === exportSel) {
        const input = h('input', { type: 'text', class: 'field export-item', value: name, spellcheck: false });
        const commit = (e) => {
          const v = input.value.trim().replace(/[&→]/g, '');
          if (!v) { input.select(); e?.preventDefault(); return; }
          renaming = false;
          set({ exportList: userList().map((x) => (x.key === key ? { ...x, name: v } : x)) });
          draw();
        };
        input.addEventListener('keydown', (e) => e.key === 'Enter' && commit(e));
        input.addEventListener('blur', commit);
        setTimeout(() => { input.focus(); input.select(); });
        return input;
      }
      return h('div', { class: `export-item${key === exportSel ? ' active' : ''}`, onclick: () => { exportSel = key; renaming = false; draw(); } }, t(name));
    };
    listBox.replaceChildren(item('general', 'General'), h('div', { class: 'export-sep' }),
      ...FIXED.map((x) => item(x.key, x.name)), h('div', { class: 'export-sep' }),
      ...userList().map((x) => item(x.key, x.name)));
    const k = userList().findIndex((x) => x.key === exportSel);
    const btn = (label, glyph, enabled, run) => h('button', { type: 'button', class: 'btn export-tool', title: t(label), 'aria-label': t(label), disabled: !enabled, onclick: run }, glyph);
    const move = (d) => {
      const list = [...userList()];
      [list[k], list[k + d]] = [list[k + d], list[k]];
      set({ exportList: list });
      draw();
    };
    tools.replaceChildren(
      btn('Add', '+', true, addFromTemplate),
      btn('Delete', '−', k >= 0, async () => {
        if (!(await modal({ title: '', body: h('p', {}, t('Delete this export option ?')), buttons: [{ label: t('Cancel'), value: false }, { label: t('Delete'), value: true, primary: true }] }))) return;
        const key = exportSel;
        const cfg = { ...settings.exportCfg };
        delete cfg[key];
        set({ exportList: userList().filter((x) => x.key !== key), exportCfg: cfg });
        exportSel = 'general';
        draw();
      }),
      btn('Rename', '✎', k >= 0, () => { renaming = true; drawList(); }),
      btn('Move Down', '↓', k >= 0 && k < userList().length - 1, () => move(1)),
      btn('Move Up', '↑', k > 0, () => move(-1)));
  };

  const addFromTemplate = async () => {
    const pick = h('select', { class: 'field', size: 12 }, TEMPLATES.map(([type], n) => h('option', { value: type, selected: n === 0 }, t(templateName(type)))));
    const ok = await modal({ title: t('Add From a Template'), body: pick, buttons: [{ label: t('Cancel'), value: false }, { label: t('Add'), value: true, primary: true }] });
    if (!ok) return;
    const entry = newEntry(userList(), pick.value);
    set({ exportList: [...userList(), entry] });
    exportSel = entry.key;
    renaming = true;
    draw();
  };

  const fieldRow = (key, type, c, [f, kind, label, inline, opts = {}]) => {
    if (opts.when && !opts.when(c)) return null;
    const put = (v, patch = null) => {
      saveCfg(key, patch || { [f]: v });
      // Fields that change the Arguments line or show other fields redraw the form.
      drawForm();
    };
    const lab = h('label', { class: 'export-label' }, label ? t(label) : '');
    let input;
    switch (kind) {
      case 'arg':
        input = h('input', { type: 'text', class: 'field', value: argPreview(type, c), disabled: true });
        break;
      case 'check': {
        const box = h('input', { type: 'checkbox', checked: !!c[f], onchange: () => put(box.checked) });
        input = h('label', { class: 'pref-radio' }, box, t(inline));
        break;
      }
      case 'select':
        input = h('select', { class: 'field', onchange: () => put(opts.choices[input.selectedIndex][0]) }, opts.choices.map(([v, name]) => h('option', { selected: String(c[f] ?? opts.choices[0][0]) === String(v) }, t(name))));
        break;
      case 'radio':
        input = h('div', { class: 'pref-inline' }, ...opts.choices.map(([v, name]) => {
          const r = h('input', { type: 'radio', name: `exp-${key}-${f}`, checked: Number(c[f] || 0) === v, onchange: () => r.checked && put(v) });
          return h('label', { class: 'pref-radio' }, r, t(name));
        }));
        break;
      case 'number': {
        const num = h('input', { type: 'number', class: 'field pref-num', min: opts.min, max: opts.max, value: c[f], onchange: () => put(Math.max(opts.min, Math.min(opts.max, Number(num.value) || opts.reset))) });
        input = h('div', { class: 'pref-inline' }, num, inline ? h('span', { class: 'pref-unit' }, inline) : null, opts.reset !== undefined ? h('button', { type: 'button', class: 'btn', onclick: () => put(opts.reset) }, t('Reset to Default')) : null);
        break;
      }
      case 'textarea':
        input = h('textarea', { class: 'field', rows: 3, spellcheck: false, onchange: () => saveCfg(key, { [f]: input.value }) }, c[f] || '');
        break;
      case 'file': {
        const text = h('input', { type: 'text', class: 'field', value: c[f] || '', spellcheck: false, onchange: () => put(text.value.trim()) });
        input = h('div', { class: 'pref-inline' }, text, h('button', { type: 'button', class: 'btn', title: t('Select'), onclick: async () => {
          const p = await platform.pickFile({ extensions: opts.extensions });
          if (p) put(p);
        } }, '…'));
        break;
      }
      case 'theme':
        input = h('select', { class: 'field', onchange: () => put(['', ...THEMES.map(([id]) => id)][input.selectedIndex]) }, [['', 'Current Theme'], ...THEMES].map(([v, name]) => h('option', { selected: (c[f] || '') === v }, t(name))));
        break;
      case 'preset':
      case 'command': {
        const presets = kind === 'command' ? COMMAND_PRESETS : opts.presets;
        const text = h('input', { type: 'text', class: 'field', value: c[f] || '', placeholder: t(inline), spellcheck: false, onchange: () => saveCfg(key, { [f]: text.value }) });
        const more = h('button', { type: 'button', class: 'btn', onclick: () => {
          const r = more.getBoundingClientRect();
          showMenu([{ id: 'p-custom', title: t('Custom'), run: () => text.focus() }, { separator: true }, ...presets.map((v, n) => ({ id: `p-${n}`, title: v, run: () => put(v) })), { separator: true }, { id: 'p-none', title: t('None'), run: () => put('') }], r.left, r.bottom + 2);
        } }, '…');
        input = h('div', { class: 'pref-inline' }, text, more);
        break;
      }
      case 'suggest': {
        const id = `exp-sug-${key}-${f}`;
        const text = h('input', { type: 'text', class: 'field', value: c[f] || '', placeholder: t(inline), list: id, spellcheck: false, onchange: () => put(text.value.trim()) });
        input = h('div', {}, text, h('datalist', { id }, opts.suggest.map((v) => h('option', { value: v }))));
        break;
      }
      case 'paper': {
        // Paper size, then margins (Default or four custom values in mm), then the size in mm.
        const paper = c.paper || '';
        const sel = h('select', { class: 'field', onchange: () => put(opts.choices[sel.selectedIndex][0]) }, opts.choices.map(([v, name]) => h('option', { selected: paper === v }, t(name))));
        const marginCustom = c['paper.margin'] === 'custom';
        const mSel = h('select', { class: 'field', onchange: () => put(undefined, { 'paper.margin': mSel.selectedIndex ? 'custom' : '' }) }, [h('option', { selected: !marginCustom }, t('Default')), h('option', { selected: marginCustom }, t('Custom'))]);
        const mm = (k, def) => {
          const n = h('input', { type: 'number', class: 'field pref-num', min: 0, max: 200, value: c[k] ?? def, onchange: () => saveCfg(key, { [k]: Number(n.value) || 0 }) });
          return n;
        };
        const size = paper === 'custom' ? (c['paper.custom'] || [210, 297]) : PAPER_MM[paper] || [210, 297];
        const wh = [0, 1].map((n) => {
          const x = h('input', { type: 'number', class: 'field pref-num', value: size[n], disabled: paper !== 'custom', onchange: () => {
            const v = [...(c['paper.custom'] || [210, 297])];
            v[n] = Number(x.value) || v[n];
            saveCfg(key, { 'paper.custom': v });
          } });
          return x;
        });
        input = h('div', { class: 'export-paper' }, sel,
          h('div', { class: 'pref-inline' }, h('span', {}, t('Margin')), mSel),
          marginCustom ? h('div', { class: 'export-margins' }, ...[['Top', 'paper.marginTop'], ['Bottom', 'paper.marginBottom'], ['Left', 'paper.marginLeft'], ['Right', 'paper.marginRight']].map(([side, k]) => h('label', { class: 'pref-inline' }, t(`Margin ${side}`), mm(k, 16), 'mm'))) : null,
          h('div', { class: 'pref-inline' }, h('span', {}, t('Width x Height')), wh[0], '×', wh[1], 'mm'));
        break;
      }
      default:
        input = h('input', { type: 'text', class: 'field', value: c[f] || '', placeholder: inline ? t(inline) : '', spellcheck: false, onchange: () => put(input.value) });
    }
    const hint = kind === 'theme' && inline ? h('span', { class: 'pref-hint' }, t(inline)) : null;
    return h('div', { class: 'export-row' }, lab, h('div', { class: 'export-field' }, input, hint));
  };

  const drawForm = () => {
    if (exportSel === 'general') {
      const g = settings.exportCfg.general || {};
      const folder = h('select', { class: 'field', onchange: () => { saveCfg('general', { exportFolder: ['', 'same', 'custom'][folder.selectedIndex] }); drawForm(); } },
        [['', 'Auto'], ['same', 'Same folder with current file'], ['custom', 'Custom location']].map(([v, name]) => h('option', { selected: (g.exportFolder || '') === v }, t(name))));
      const custom = g.exportFolder === 'custom' && h('div', { class: 'pref-inline' }, h('input', { type: 'text', class: 'field', value: g.customExportPath || '', placeholder: '~/Documents', onchange: (e) => saveCfg('general', { customExportPath: e.target.value.trim() }) }),
        h('button', { type: 'button', class: 'btn', title: t('Select custom folder'), onclick: async () => {
          const dir = await platform.pickFolder();
          if (dir) { saveCfg('general', { customExportPath: dir }); drawForm(); }
        } }, '…'));
      const pandoc = h('input', { type: 'text', class: 'field', value: settings.pandocPath, placeholder: t('(Auto Detect)'), spellcheck: false, onchange: () => set({ pandocPath: pandoc.value.trim() }) });
      const loc = h('input', { type: 'checkbox', checked: !!g.openExportLocation, onchange: () => saveCfg('general', { openExportLocation: loc.checked }) });
      form.replaceChildren(
        h('h3', { class: 'pref-head' }, t('Default Folder for Exported File')), h('div', { class: 'pref-row stack' }, folder, custom || null),
        h('h3', { class: 'pref-head' }, t('Pandoc Path'), h('a', { href: '#', class: 'pref-learn', onclick: (e) => { e.preventDefault(); actions.learnMore?.('docs/pandoc.md'); } }, t('Learn More…'))),
        h('div', { class: 'pref-row stack' }, h('div', { class: 'pref-inline' }, pandoc, h('button', { type: 'button', class: 'btn', title: t('Select'), onclick: async () => {
          const p = await platform.pickFile({});
          if (p) { set({ pandocPath: p }); pandoc.value = p; }
        } }, '…'))),
        h('h3', { class: 'pref-head' }, t('After Export')), h('div', { class: 'pref-row check' }, loc, h('label', {}, t('Open exported file location'))));
      return;
    }
    const entry = entryOf(exportSel);
    if (!entry) { exportSel = 'general'; return drawForm(); }
    const c = configOf(settings, entry.key, entry.type);
    form.replaceChildren(h('h3', { class: 'pref-head' }, t(entry.name), h('span', { class: 'pref-head-hint' }, ` ${t(templateName(entry.type))}`)),
      ...(SCHEMA[entry.type] || []).map((row) => fieldRow(entry.key, entry.type, c, row)).filter(Boolean));
  };
  const draw = () => { drawList(); drawForm(); };
  draw();
  root.append(h('div', { class: 'export-side' }, listBox, tools), form);
  return root;
}

// The custom file patterns of the file tree or the file library: Markdown and
// text files are always included; each row is a glob, "!" in front excludes.
async function editPatterns(key, title) {
  const rows = h('div', { class: 'pref-patterns' });
  const addRow = (value = '') => {
    const field = h('input', { type: 'text', class: 'field', value, placeholder: t('e.g: *.md'), spellcheck: false });
    const del = h('button', { type: 'button', class: 'btn pref-pattern-del', title: t('Delete'), 'aria-label': t('Delete'), onclick: () => {
      row.remove();
      if (!rows.children.length) addRow();
    } }, '−');
    const row = h('div', { class: 'pref-pattern' }, field, del);
    rows.append(row);
    return field;
  };
  (settings[key].length ? settings[key] : ['']).forEach((v) => addRow(v));
  const body = h('div', {},
    h('p', { class: 'dialog-detail' }, t('Add glob patterns to choose which files are shown. Prefix a pattern with "!" to exclude. Example: *.csv or !**/draft-*.md')),
    h('div', { class: 'pref-pattern fixed' }, h('span', {}, t('Markdown and text files')), h('span', { class: 'pref-hint' }, t('Included by default. To exclude some formats, use a "!" pattern.'))),
    rows,
    h('button', { type: 'button', class: 'btn', onclick: () => addRow().focus() }, t('Add Pattern')));
  const ok = await modal({ title: t(title), body, buttons: [{ label: t('Cancel'), value: false }, { label: t('OK'), value: true, primary: true }] });
  if (ok) set({ [key]: [...rows.querySelectorAll('input')].map((x) => x.value.trim()).filter(Boolean) });
}

let openDialog = null;
export function openPreferences(section, actions = {}, ctx = {}) {
  if (openDialog) return openDialog;
  const sections = SECTIONS({ spellLangs: [], ...ctx });
  let current = Math.max(0, sections.findIndex(([name]) => name === section));
  const pane = h('div', { class: 'prefs-pane' });
  const list = h('div', { class: 'prefs-list', role: 'tablist' });
  const search = h('input', { type: 'search', class: 'field', placeholder: t('Search…'), 'aria-label': t('Search'), spellcheck: false });
  const visible = ([, , , , , opts]) => !(opts?.native && !isNative) && !(opts?.when && !opts.when(settings));
  let redraw = () => {};
  const change = (patch) => {
    set(patch);
    // Rows that depend on another setting appear and disappear with it.
    if (sections.some(([, rows]) => rows.some((r) => r[5]?.when))) redraw();
  };

  const ids = new Map();
  const control = ([key, kind, label, hint, extra, opts]) => {
    if (key === 'head') {
      // A section title, an optional note after it, and an optional "Learn More…" link to the help.
      const more = hint && h('a', { href: '#', class: 'pref-learn', onclick: (e) => { e.preventDefault(); actions.learnMore?.(hint); } }, t('Learn More…'));
      return h('h3', { class: 'pref-head' }, t(kind), label ? h('span', { class: 'pref-head-hint' }, ` ${t(label)}`) : null, more || null);
    }
    // A setting may appear twice (Inline Math sits under Syntax Support and Math).
    const n = (ids.get(key) || 0) + 1;
    ids.set(key, n);
    const id = n > 1 ? `pref-${key}-${n}` : `pref-${key}`;
    const hintEl = hint && h('span', { class: 'pref-hint' });
    if (hintEl) hintEl.innerHTML = t(hint);
    let input;
    if (kind === 'button') {
      const text = opts?.label ? t(label, opts.label(settings)) : t(label);
      return h('div', { class: 'pref-row single' }, h('button', { type: 'button', class: 'btn', onclick: () => actions[key]?.() }, text));
    }
    if (kind === 'exportPane') return exportPane(actions);
    if (kind === 'check') {
      const forced = opts?.forced?.(settings);
      const off = forced || opts?.disabled?.(settings);
      input = h('input', { type: 'checkbox', id, checked: forced ? true : opts?.disabled?.(settings) ? false : !!settings[key], disabled: !!off, onchange: () => change({ [key]: input.checked }) });
      return h('div', { class: `pref-row check${off ? ' disabled' : ''}` }, input, h('label', { for: id }, t(label), hintEl));
    }
    if (kind === 'radio') {
      return h('div', { class: 'pref-row radios' }, ...extra.map(([v, name], k) => {
        const r = h('input', { type: 'radio', name: id, id: `${id}-${k}`, checked: settings[key] === v, onchange: () => r.checked && change({ [key]: v }) });
        return h('label', { class: 'pref-radio', for: `${id}-${k}` }, r, t(name));
      }));
    }
    if (kind === 'fontSize') {
      // Auto leaves the size to the theme; Customized sets it (9–24 px).
      const num = h('input', { type: 'number', class: 'field pref-num', min: 9, max: 24, step: 1, value: settings.fontSize, style: settings.fontSizeCustom ? '' : 'visibility:hidden', oninput: () => {
        const v = Number(num.value);
        if (v >= 9 && v <= 24) set({ fontSize: v });
      }, onblur: () => {
        const v = Math.max(9, Math.min(24, Math.round(Number(num.value) || 14)));
        num.value = v;
        change({ fontSize: v });
      } });
      const radio = (custom, name) => {
        const r = h('input', { type: 'radio', name: id, checked: !!settings.fontSizeCustom === custom, onchange: () => r.checked && change({ fontSizeCustom: custom }) });
        return h('label', { class: 'pref-radio' }, r, t(name));
      };
      return h('div', { class: 'pref-row radios' }, radio(false, 'Auto ( Recommended )'), radio(true, 'Customized'), num, h('span', { class: 'pref-unit', style: num.style.cssText }, 'px'));
    }
    if (kind === 'zoom') {
      const ZOOMS = [0.5, 0.67, 0.8, 0.9, null, 1, null, 1.1, 1.25, 1.5, 1.75, 2];
      const known = ZOOMS.includes(settings.zoom);
      input = h('select', { id, class: 'field', onchange: () => change({ zoom: Number(input.value) }) },
        ...(known ? [] : [h('option', { value: settings.zoom, selected: true }, `${Math.round(settings.zoom * 100)}%`)]),
        ...ZOOMS.map((z) => (z === null ? h('option', { disabled: true }, '──────────') : h('option', { value: z, selected: settings.zoom === z }, `${Math.round(z * 100)}%`))));
      return h('div', { class: 'pref-row' }, h('label', { for: id }, t('Zoom')), h('div', { class: 'pref-inline' }, input, h('button', { type: 'button', class: 'btn', onclick: () => change({ zoom: 1 }) }, t('Reset to Default'))));
    }
    if (kind === 'speed') {
      input = h('input', { type: 'number', id, class: 'field pref-num', min: 1, max: 999, value: settings.readingSpeed, onchange: () => {
        const v = Number(input.value);
        const val = Number.isNaN(v) || input.value.trim() === '' ? 382 : Math.max(1, Math.min(999, Math.round(v)));
        input.value = val;
        change({ readingSpeed: val });
      } });
      const menuBtn = h('button', { type: 'button', class: 'btn pref-split-caret', 'aria-label': t('Reset to Default') }, '▾');
      menuBtn.addEventListener('click', () => {
        const r = menuBtn.getBoundingClientRect();
        showMenu([[120, '120  words/minute (Slow)'], [240, '240  words/minute (Medium)'], [382, '382  words/minute (Fast)']].map(([v, name]) => ({ id: `wpm-${v}`, title: t(name), run: () => change({ readingSpeed: v }) })), r.left, r.bottom + 2);
      });
      return h('div', { class: 'pref-row' }, h('label', { for: id }, `${t(label)}:`), h('div', { class: 'pref-inline' }, input, h('span', { class: 'pref-unit' }, t('words / min')),
        h('span', { class: 'pref-split' }, h('button', { type: 'button', class: 'btn', onclick: () => change({ readingSpeed: 382 }) }, t('Reset to Default')), menuBtn)));
    }
    if (kind === 'ext') {
      // Markdown (.md), Markdown (.markdown), Text File (.text) or any other extension.
      const PRESET = ['md', 'markdown', 'text'];
      const custom = !PRESET.includes(settings.defaultExt);
      const field = h('input', { type: 'text', class: 'field', placeholder: t('e.g: txt'), value: custom ? settings.defaultExt : '', spellcheck: false, onblur: () => {
        const m = /^\.?[a-z0-9_-]+(\.[a-z0-9_-]+)*/.exec(field.value.trim().toLowerCase());
        if (m) change({ defaultExt: m[0].replace(/^\./, '') });
      } });
      input = h('select', { id, class: 'field', onchange: () => {
        const v = ['md', 'markdown', 'text', 'custom'][input.selectedIndex];
        if (v === 'custom') { redraw(); field.focus(); } else change({ defaultExt: v });
      } }, ...[['md', 'Markdown (.md)'], ['markdown', 'Markdown (.markdown)'], ['text', 'Text File (.text)'], ['custom', 'Custom']].map(([v, name]) => h('option', { selected: custom ? v === 'custom' : settings.defaultExt === v }, t(name))));
      const row = h('div', { class: 'pref-row stack' }, input);
      if (custom || input.selectedIndex === 3) {
        row.append(h('label', {}, t('Custom Extension:')), field, h('span', { class: 'pref-hint' }, t('Following extensions are supported: %@').replace('%@', 'md, markdown, mmd, mdown, mkd, mdwn, mdtxt, mdtext, txt, text, rmd, rmarkdown')));
      }
      input.addEventListener('change', () => {
        if (input.selectedIndex === 3 && !row.contains(field)) row.append(h('label', {}, t('Custom Extension:')), field);
      });
      return row;
    }
    if (kind === 'filter') {
      input = h('select', { id, class: 'field', onchange: () => change({ [key]: extra[input.selectedIndex][0] }) }, extra.map(([v, name]) => h('option', { selected: settings[key] === v }, t(name))));
      const cfg = settings[key] === 'custom' && h('button', { type: 'button', class: 'btn', onclick: () => editPatterns(opts.patterns, opts.title) }, t('Configure…'));
      return h('div', { class: 'pref-row' }, h('label', { for: id }, t(label), hintEl), h('div', { class: 'pref-inline' }, input, cfg || null));
    }
    if (kind === 'indentPreview') {
      // How a quote and a nested list come out with the chosen indent.
      const size = Number(settings.indentSize);
      const unit = size === -1 ? '\t' : ' '.repeat(size > 0 ? size : 2);
      const pad = (marker) => (settings.prettyIndent && size > 0 ? marker.padEnd(size, ' ') : `${marker} `);
      const text = [`${pad('>')}Quote`, `${pad('-')}List item`, `${unit}${pad('1.')}sub-bullet`, `${unit}${size > 0 && settings.prettyIndent ? ' '.repeat(size) : ' '.repeat(3)}line2`].join('\n');
      return h('div', { class: 'pref-row single' }, h('pre', { class: 'pref-preview' }, text));
    }
    if (kind === 'langWhen') {
      const now = settings.defaultLangOnMd && settings.defaultLangOnMenu ? 2 : settings.defaultLangOnMenu ? 1 : 0;
      input = h('select', { id, class: 'field', onchange: () => {
        const k = input.selectedIndex;
        change({ defaultLangOnMd: k !== 1, defaultLangOnMenu: k !== 0 });
      } }, ...['When add code fences via Markdown', 'When add code fences via Menubar', 'Both'].map((name, k) => h('option', { selected: k === now }, t(name))));
      return h('div', { class: 'pref-row' }, h('label', { for: id }, t(label)), input);
    }
    if (kind === 'codeLang') {
      // A language, nothing, or whatever language the last code block used.
      const last = settings[key] === '__LAST';
      const listId = `${id}-list`;
      input = h('input', { type: 'text', id, class: 'field', value: last ? '' : settings[key], placeholder: t(last ? 'Last Used' : '(None)'), list: listId, spellcheck: false, onchange: () => {
        const v = input.value.trim();
        const value = v === t('Last Used') ? '__LAST' : v === t('(None)') ? '' : v;
        change({ [key]: value });
        input.value = value === '__LAST' ? '' : value;
        input.placeholder = t(value === '__LAST' ? 'Last Used' : '(None)');
      } });
      const list = h('datalist', { id: listId }, [t('(None)'), t('Last Used'), ...CODE_LANGS].map((v) => h('option', { value: v })));
      return h('div', { class: 'pref-row' }, h('label', { for: id }, t(label), hintEl), h('div', {}, input, list));
    }
    if (kind === 'textarea') {
      input = h('textarea', { id, class: 'field', rows: 3, spellcheck: false, onchange: () => change({ [key]: input.value }) }, settings[key] || '');
      return h('div', { class: 'pref-row stack' }, h('label', { for: id }, t(label), hintEl), input);
    }
    if (kind === 'folder') {
      const shown = h('span', { class: 'pref-path' }, settings[key] || t('(None)'));
      return h('div', { class: 'pref-row' }, h('label', {}, t(label), shown), h('button', { type: 'button', class: 'btn', onclick: async () => {
        const dir = await platform.pickFolder();
        if (!dir) return;
        change({ [key]: dir });
        shown.textContent = dir;
      } }, t('Select')));
    }
    if (kind === 'select') {
      // Option values keep their type (booleans stay booleans).
      input = h('select', { id, class: 'field', onchange: () => change({ [key]: extra[input.selectedIndex][0] }) }, extra.map(([v, name]) => h('option', { selected: settings[key] === v }, t(name))));
    } else if (kind === 'number') {
      const [min, max, step] = extra;
      input = h('input', { type: 'number', id, class: 'field', min, max, step, value: settings[key], onchange: () => {
        const v = Math.max(min, Math.min(max, Number(input.value) || settings[key]));
        input.value = v;
        change({ [key]: v });
      } });
    } else {
      input = h('input', { type: 'text', id, class: 'field', value: settings[key], spellcheck: false, onchange: async () => {
        const value = opts?.empty ? input.value.trim() : input.value.trim() || DEFAULTS[key];
        const problem = opts?.validate ? await opts.validate(value) : null;
        if (problem) {
          await ask({ message: problem, style: 'warning' });
          input.value = settings[key];
          return;
        }
        change({ [key]: value });
      } });
    }
    if (!label) return h('div', { class: 'pref-row stack' }, input, hintEl || null);
    return h('div', { class: 'pref-row' }, h('label', { for: id }, t(label), hintEl), input);
  };

  const show = (k) => {
    current = k;
    search.value = '';
    for (const [n, b] of [...list.children].entries()) b.setAttribute('aria-selected', n === k);
    // A heading stays only when a setting under it is shown.
    const rows = sections[k][1].filter(visible).filter((row, n, all) => row[0] !== 'head' || (all[n + 1] && all[n + 1][0] !== 'head'));
    ids.clear();
    pane.replaceChildren(...rows.map(control));
    pane.scrollTop = 0;
  };
  redraw = () => {
    if (search.value.trim()) return;
    const top = pane.scrollTop;
    const active = document.activeElement?.id;
    show(current);
    pane.scrollTop = top;
    if (active) document.getElementById(active)?.focus();
  };
  // Typing in the search box lists every matching setting, whatever its page.
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return show(current);
    for (const b of list.children) b.setAttribute('aria-selected', 'false');
    const hits = sections.flatMap(([, rows]) => rows.filter((row) => row[0] !== 'head' && visible(row) && `${t(row[2])} ${row[3] ? t(row[3]) : ''}`.toLowerCase().includes(q)));
    return pane.replaceChildren(...(hits.length ? hits.map(control) : [h('p', { class: 'dialog-detail' }, t('No Results'))]));
  });
  sections.forEach(([name], k) => list.append(h('button', { type: 'button', role: 'tab', onclick: () => show(k) }, t(name))));
  show(current);

  openDialog = modal({ title: '', panel: true, body: h('div', { class: 'prefs' }, h('div', { class: 'prefs-nav' }, search, list), pane), buttons: [{ label: t('Close'), value: true }] }).finally(() => {
    openDialog = null;
  });
  return openDialog;
}

export const resetSettings = (keys) => set(Object.fromEntries(keys.map((k) => [k, structuredClone(DEFAULTS[k])])));
export const DEFAULT_SETTINGS = DEFAULTS;
