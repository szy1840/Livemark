// The command set: one tree drives the native menu bar, the in-page menu
// bar, the keyboard shortcuts and the context menus. The menu layout follows
// the conventional Mac Markdown-editor arrangement: File, Edit, Paragraph,
// Format, View, Themes, Window, Help.

import { platform, isNative, on, path } from './platform.js';
import { DIAGRAM_LANGS } from './rich.js';
import { showMenu, contextMenu, keyLabel } from './ui.js';
import { THEMES, settings } from './prefs.js';
import { isMac } from './editor.js';
import { t } from './i18n.js';

const sep = { separator: true };

export function createCommands(app) {
  const ed = app.editor;
  // e(): needs the live editor (ignored in source mode or while another
  // field has focus).
  // Shortcuts can be remapped in the advanced settings file, by command id
  // or by menu title; an empty string removes one.
  // On German, Swiss German and Spanish keyboards "/", "=" and "\\" are typed with Shift
  // (or Option): those default shortcuts take the extra modifier so they can be pressed.
  const LAYOUT_KEYS = {
    german: { source: 'shift+cmd+/', headingUp: 'shift+cmd+=', clearFormat: 'alt+shift+cmd+7' },
    spanish: { source: 'shift+cmd+/', headingUp: 'shift+cmd+=', clearFormat: 'alt+cmd+º' },
  };
  const layoutKind = () => {
    const l = app.keyboardLayout?.() || '';
    return /german/i.test(l) ? 'german' : /keylayout\.Spanish$/i.test(l) || /^Spanish$/i.test(l) ? 'spanish' : null;
  };
  const keyFor = (id, title, key) => {
    const map = app.keymap?.() || {};
    if (id in map) return map[id] || null;
    if (title in map) return map[title] || null;
    return LAYOUT_KEYS[layoutKind()]?.[id] || key;
  };
  const c = (id, title, key, run, opts = {}) => ({ id, title: t(title), key: keyFor(id, title, key), run, ...opts });
  const e = (id, title, key, run, opts = {}) => c(id, title, key, run, { editor: true, ...opts });
  const role = (r, title, key) => ({ role: r, title: title ? t(title) : undefined, key });
  const sub = (title, items) => ({ title: t(title), items });
  const flag = (key) => () => !!settings[key];
  const inTable = () => !!ed.currentCell();
  const onImage = () => !!ed.imageAtCaret();
  const hasFile = () => !!app.currentPath();
  // Copy as … works on a selection (Typora greys these items out without one).
  const hasSelection = () => (app.sourceMode() ? true : !!ed.getSel() && !ed.getSel().collapsed);

  // Typora keeps "Reopen Closed File" inside Open Recent.
  const recentItems = () => [
    c('reopenClosed', 'Reopen Closed File', 'shift+cmd+t', () => app.reopenClosed(), { enabled: () => app.canReopenClosed() }),
    sep,
    ...settings.pinned.map((p, k) => ({ id: `pinned-${k}`, title: `${path.basename(p)}/`, run: () => app.openFolder(p) })),
    settings.pinned.length ? sep : null,
    // Files with the same name say which folder they are in.
    ...settings.recent.map((p, k) => ({ id: `recent-${k}`, title: settings.recent.filter((x) => path.basename(x) === path.basename(p)).length > 1 ? `${path.basename(p)} — ${path.basename(path.dirname(p))}` : path.basename(p), run: () => app.openPath(p) })),
    settings.recent.length ? sep : null,
    ...settings.recentFolders.map((p, k) => ({ id: `recentdir-${k}`, title: `${path.basename(p)}/`, run: () => app.openFolder(p) })),
    settings.recentFolders.length ? sep : null,
    c('clearRecent', 'Clear Menu', null, () => app.clearRecent(), { enabled: () => settings.recent.length + settings.recentFolders.length > 0 }),
  ].filter(Boolean);

  // File → Export: the fixed entries, then the user's list from Settings → Export.
  const exportItems = () => {
    const entries = app.exportEntries();
    const item = (x) => ({ id: `export-${x.key}`, title: t(x.name), run: () => app.exportAs(x.key),
      enabled: () => (x.type === 'image' || x.type === 'custom' ? isNative : true) });
    return [
      ...entries.slice(0, 4).map(item),
      sep,
      ...entries.slice(4).map(item),
      entries.length > 4 ? sep : null,
      c('exportPrev', 'Export with Previous', 'shift+cmd+e', () => app.exportAgain(), { enabled: () => app.canExportAgain() }),
      c('exportOverwrite', 'Export and Overwrite with Previous', null, () => app.exportOverwrite(), { enabled: () => app.canExportAgain() }),
      c('exportSettings', 'Export Setting…', null, () => app.preferences('Export')),
    ].filter(Boolean);
  };

  const tableOp = (act, title, key) => e(`table-${act}`, title, key, () => ed.tableOp(act), { enabled: inTable });
  const tableItems = () => [
    e('tableInsert', 'Insert Table', 'alt+cmd+t', () => app.insertTableDialog()),
    e('tableResize', 'Resize Table', null, () => app.insertTableDialog(true), { enabled: () => !!ed.currentCell() }),
    sep,
    tableOp('rowAbove', 'Add Row Above'),
    tableOp('rowBelow', 'Add Row Below', 'cmd+enter'),
    sep,
    tableOp('colBefore', 'Add Column Before'),
    tableOp('colAfter', 'Add Column After'),
    sep,
    tableOp('rowUp', 'Move Table Row Up', 'ctrl+cmd+up'),
    tableOp('rowDown', 'Move Table Row Down', 'ctrl+cmd+down'),
    tableOp('colLeft', 'Move Table Column Left', 'ctrl+cmd+left'),
    tableOp('colRight', 'Move Table Column Right', 'ctrl+cmd+right'),
    sep,
    tableOp('rowDelete', 'Delete Row', 'shift+cmd+backspace'),
    tableOp('colDelete', 'Delete Column'),
    sep,
    e('tableCopy', 'Copy Table', null, () => app.copyTable(ed.tableMarkdown()), { enabled: inTable }),
    e('tablePrettify', 'Prettify Source Code', null, () => app.prettifyTable(), { enabled: inTable }),
    tableOp('tableDelete', 'Delete Table'),
  ];

  // Zoom steps as Typora groups them; "-" is a separator.
  const ZOOM_STEPS = ['25%', '33%', '50%', '67%', '80%', '-', '100%', '-', '150%', '200%'];
  // Zoom items for a right-clicked picture: they act on that picture. "Zoom Image to 50%"
  // appears once its pixel ratio is known and is not 1 (a Retina screenshot).
  const zoomItems = (imgEl) => {
    const ratio = app.imageRatio(imgEl);
    return [
      ratio ? c('ctxZoomSmart', t('Zoom Image to {0}', ratio), null, () => ed.zoomImage(ratio, imgEl)) : null,
      sub('Zoom Image', ZOOM_STEPS.map((f) => (f === '-' ? sep : c(`ctxZoom-${parseInt(f, 10)}`, f, null, () => ed.zoomImage(f, imgEl))))),
    ];
  };

  // Format → Image, in Typora's order and with its items.
  const imageItems = () => [
    // Typora's Insert Image puts "![]()" at the caret; picking files is Insert Local Images….
    e('imageInsert', 'Insert Image', 'ctrl+cmd+i', () => app.insertImageFromClipboard()),
    e('imageInsertLocal', 'Insert Local Images…', null, () => app.insertImageFromFile(true)),
    sep,
    c('imageOpenLocation', 'Open Image Location…', null, () => app.revealImage(), { enabled: onImage }),
    sub('Zoom Image', ZOOM_STEPS.map((f) => (f === '-' ? sep : { id: `imageZoom-${parseInt(f, 10)}`, title: f, editor: true, run: () => ed.zoomImage(f), enabled: onImage }))),
    sub('Switch Image Syntax', [
      e('imageMd', 'Markdown Style', null, () => app.setImageSyntax(false), { enabled: onImage }),
      e('imageHtml', 'HTML Style', null, () => app.setImageSyntax(true), { enabled: onImage }),
    ]),
    c('imageDeleteFile', 'Delete Image File', null, () => app.deleteImageFile(), { enabled: () => isNative && app.localImageAtCaret() }),
    sep,
    c('imageCopyTo', 'Copy Image to…', null, () => app.relocateImage(false), { enabled: () => isNative && app.localImageAtCaret() }),
    c('imageMoveTo', 'Rename or Move Image to…', null, () => app.relocateImage(true), { enabled: () => isNative && app.localImageAtCaret() }),
    c('imageUpload', 'Upload Image', null, () => app.uploadImage(), { enabled: onImage }),
    sep,
    c('imageCopyAll', 'Copy All Images to…', null, () => app.collectImages(false), { enabled: () => isNative && hasFile() }),
    c('imageMoveAll', 'Move All Images to…', null, () => app.collectImages(true), { enabled: () => isNative && hasFile() }),
    c('imageUploadAll', 'Upload All Local Images', null, () => app.uploadAllImages()),
    c('imageReload', 'Reload All Images', null, () => ed.rerenderAll()),
    sep,
    sub('When Insert Local Image', [
      c('imgCopy', 'Copy Image File to Folder…', null, () => app.setDocImageAction(app.docImageAction() === 'copy' ? 'keep' : 'copy'), { checked: () => app.docImageAction() === 'copy' }),
      c('imgUpload', 'Upload Image', null, async () => {
        if (app.docImageAction() === 'upload') return app.setDocImageAction('keep');
        if (await app.requireUploader()) app.setDocImageAction('upload');
      }, { checked: () => app.docImageAction() === 'upload' }),
    ]),
    c('imageRoot', 'Use Image Root Path', null, () => app.setImageRoot(), { checked: () => !!app.imageRoot(), enabled: () => isNative }),
    c('imageSettings', 'Global Image Settings…', null, () => app.preferences('Image')),
  ];

  // Items that are null (not shown in this build or with these settings) drop out.
  const prune = (list) => list.filter(Boolean).map((it) => (it.items ? { ...it, items: prune(it.items) } : it));
  const tree = () => prune(buildTree());
  const buildTree = () => [
    { title: 'Livemark', items: [
      c('about', 'About Livemark', null, () => app.about()),
      sep,
      c('prefs', 'Settings…', 'cmd+,', () => app.preferences()),
      sep,
      role('services', 'Services'),
      sep,
      role('hide', 'Hide Livemark', 'cmd+h'),
      role('hideOthers', 'Hide Others', 'alt+cmd+h'),
      role('showAll', 'Show All'),
      sep,
      role('quit', 'Quit Livemark', 'cmd+q'),
    ] },
    { title: t('File'), items: [
      c('new', 'New', 'cmd+n', () => app.newDoc()),
      c('newTab', 'New Tab', 'cmd+t', () => app.newTab(), { enabled: () => isNative }),
      c('newWindow', 'New Window', 'shift+cmd+n', () => app.newWindow()),
      sep,
      c('open', 'Open…', 'cmd+o', () => app.openDialog()),
      sub('Open Recent', recentItems()),
      c('quickOpen', 'Open Quickly…', 'shift+cmd+o', () => app.quickOpen()),
      sep,
      c('properties', 'Get Info…', null, () => app.properties()),
      c('revealLibrary', 'Reveal in Library', null, () => app.revealInSidebar('list'), { enabled: hasFile }),
      c('revealTree', 'Reveal in File Tree', null, () => app.revealInSidebar('tree'), { enabled: hasFile }),
      c('reveal', 'Open File Location', null, () => app.revealFile(), { enabled: () => hasFile() && isNative }),
      c('deleteFile', 'Delete…', null, () => app.deleteFile(), { enabled: hasFile }),
      sep,
      isNative ? role('close', 'Close', 'cmd+w') : c('close', 'Close', null, () => app.newDoc()),
      // macOS adds Close All itself, as the Option alternate of Close.
      isNative ? null : c('closeAll', 'Close All', 'alt+cmd+w', () => app.closeAll()),
      sep,
      c('save', 'Save…', 'cmd+s', () => app.save()),
      c('saveAs', 'Save As…', 'shift+cmd+s', () => app.saveAs()),
      c('duplicate', 'Duplicate', null, () => app.saveCopy()),
      c('rename', 'Rename…', null, () => app.renameFile(), { enabled: hasFile }),
      c('moveTo', 'Move To…', null, () => app.moveFile(), { enabled: () => hasFile() && isNative }),
      sub('Revert To', [
        c('revertSaved', 'Revert to Saved', null, () => app.revertToSaved(), { enabled: () => hasFile() && app.isDirty() }),
        c('versions', 'Browse All Versions…', null, () => app.browseVersions()),
      ]),
      c('reload', 'Reload from Disk', null, () => app.reloadFromDisk(), { enabled: hasFile }),
      c('share', 'Share', null, () => app.share(), { enabled: () => isNative }),
      sep,
      c('import', 'Import…', null, () => app.importFile()),
      sub('Export', exportItems()),
      sep,
      c('pageSetup', 'Page Setup…', 'shift+cmd+p', () => app.pageSetup(), { enabled: () => isNative }),
      c('print', 'Print…', 'cmd+p', () => app.print()),
    ] },
    { title: t('Edit'), items: [
      // In Source Code Mode these act on the source text's own history.
      c('undo', 'Undo', 'cmd+z', () => app.undo()),
      c('redo', 'Redo', 'shift+cmd+z', () => app.redo()),
      sep,
      role('cut', 'Cut', 'cmd+x'),
      role('copy', 'Copy', 'cmd+c'),
      c('copyImage', 'Copy Image Content', null, () => app.copyImageContent(), { enabled: onImage }),
      role('paste', 'Paste', 'cmd+v'),
      sep,
      e('copyPlain', 'Copy as Plain Text', null, () => app.copyAs('plain'), { enabled: hasSelection }),
      e('copyMarkdown', 'Copy as Markdown', 'shift+cmd+c', () => app.copyAs('markdown'), { enabled: hasSelection }),
      e('copyHtml', 'Copy as HTML Code', null, () => app.copyAs('html'), { enabled: hasSelection }),
      e('copyRich', 'Copy without Theme Styling', null, () => app.copyAs('simple'), { enabled: hasSelection }),
      sep,
      e('pastePlain', 'Paste as Plain Text', 'shift+cmd+v', () => app.pastePlain()),
      e('pasteMatch', 'Paste and Match Style', 'alt+shift+cmd+v', () => app.pastePlain()),
      sep,
      sub('Selection', [
        role('selectAll', 'Select All', 'cmd+a'),
        e('selectBlock', 'Select Paragraph / Block', 'alt+cmd+p', () => ed.selectBlock()),
        e('selectLine', 'Select Line / Sentence', 'cmd+l', () => ed.selectLine()),
        e('selectScope', 'Select Styled Scope', 'cmd+e', () => ed.selectScope()),
        e('selectWord', 'Select Word', 'cmd+d', () => ed.selectWord()),
        sep,
        e('jumpTop', 'Jump to Top', 'cmd+up', () => ed.jump('top')),
        e('jumpSelection', 'Jump to Selection', 'cmd+j', () => ed.jump('selection')),
        e('jumpBottom', 'Jump to Bottom', 'cmd+down', () => ed.jump('bottom')),
        e('jumpLineStart', 'Jump to Line Start', 'ctrl+a', () => ed.jump('lineStart')),
        e('jumpLineEnd', 'Jump to Line End', 'ctrl+e', () => ed.jump('lineEnd')),
      ]),
      e('blockUp', 'Move Row Up', 'alt+up', () => ed.moveBlock(-1)),
      e('blockDown', 'Move Row Down', 'alt+down', () => ed.moveBlock(1)),
      sep,
      role('delete', 'Delete'),
      sub('Delete Range', [
        e('deleteBlock', 'Delete Paragraph / Block', 'alt+shift+cmd+p', () => ed.deleteBlock()),
        e('deleteLine', 'Delete Line / Sentence', 'alt+shift+cmd+l', () => ed.deleteLine()),
        e('deleteScope', 'Delete Styled Scope', 'alt+shift+cmd+e', () => ed.deleteScope()),
        e('deleteWord', 'Delete Word', 'shift+cmd+d', () => ed.deleteWord()),
        sep,
        e('blockDuplicate', 'Duplicate Paragraph / Block', null, () => ed.duplicateBlock()),
      ]),
      sep,
      sub('Math Tools', [
        c('mathRefresh', 'Refresh All Math Expressions', null, () => ed.rerenderAll()),
        c('mathNumber', 'Auto Numbering Math Equations', null, () => app.toggleSetting('mathNumbering'), { checked: flag('mathNumbering') }),
      ]),
      sub('Line Endings', [
        c('eolCrlf', 'Windows Line Endings (CRLF)', null, () => app.setLineEnding(true), { checked: () => app.lineEnding() === 'crlf' }),
        c('eolLf', 'Unix Line Endings (LF)', null, () => app.setLineEnding(false), { checked: () => app.lineEnding() === 'lf' }),
        sep,
        c('finalNewline', 'Insert Final New Line On Save', null, () => app.toggleFinalNewline(), { checked: () => app.finalNewline() }),
      ]),
      sub('Whitespace and Line Breaks', [
        c('indentFirstLine', 'Indent first line of paragraphs', null, () => app.toggleSetting('indentFirstLine'), { checked: flag('indentFirstLine') }),
        c('visibleBr', 'Visible <br/>', null, () => app.toggleSetting('visibleBr'), { checked: flag('visibleBr') }),
        c('preserveBreaks', 'Preserve single line break', null, () => app.toggleSetting('preserveBreaks'), { checked: flag('preserveBreaks') }),
        sep,
        c('whitespaceHelp', 'Learn More…', null, () => app.openHelp('docs/markdown-reference.md', '段落和换行')),
      ]),
      sub('Substitutions', [
        c('smartOnInput', 'Convert on Input', null, () => app.setSetting({ smartMode: 'input' }), { checked: () => settings.smartMode === 'input' }),
        c('smartOnRender', 'Convert on Rendering', null, () => app.setSetting({ smartMode: 'render' }), { checked: () => settings.smartMode === 'render' }),
        sep,
        c('smartQuotes', 'Smart Quotes', null, () => app.toggleSetting('smartQuotes'), { checked: flag('smartQuotes') }),
        c('smartDashes', 'Smart Dashes', null, () => app.toggleSetting('smartDashes'), { checked: flag('smartDashes') }),
        isNative ? role('toggleTextReplacement', 'Text Replacement') : null,
        sep,
        c('remapPunct', 'Remap Unicode Punctuation on Parse', null, () => app.toggleSetting('remapPunct'), { checked: flag('remapPunct') }),
        sep,
        c('substitutionOptions', 'More Options…', null, () => app.preferences('Editor')),
      ].filter(Boolean)),
      sub('Spelling and Grammar', [
        isNative ? role('showSpelling', 'Show Spelling and Grammar', 'shift+cmd+;') : null,
        isNative ? role('checkSpelling', 'Check Document Now', 'cmd+;') : null,
        isNative ? sep : null,
        c('spellcheck', 'Check Spelling While Typing', null, () => app.toggleSetting('spellcheck'), { checked: flag('spellcheck') }),
        isNative ? role('toggleGrammar', 'Check Grammar With Spelling') : null,
        isNative ? role('toggleSpellCorrection', 'Correct Spelling Automatically') : null,
      ].filter(Boolean)),
      sub('Find', [
        c('find', 'Find…', 'cmd+f', () => app.find(false)),
        c('findNext', 'Find Next', 'cmd+g', () => app.findStep(1)),
        c('findPrev', 'Find Previous', 'shift+cmd+g', () => app.findStep(-1)),
        c('replace', 'Find and Replace…', 'alt+cmd+f', () => app.find(true)),
        c('replaceNext', 'Replace Next', 'alt+cmd+e', () => app.replaceNext()),
        e('findJump', 'Jump to Selection', 'cmd+j', () => ed.jump('selection')),
      ]),
      sub('Speech', [c('startSpeaking', 'Start Speaking', null, () => app.speak()), c('stopSpeaking', 'Stop Speaking', null, () => app.stopSpeaking())]),
      // macOS puts its AutoFill item above Start Dictation…, as in Typora.
      sep,
      isNative ? role('startDictation', 'Start Dictation…') : null,
      role('emojiPicker', 'Emoji & Symbols', 'ctrl+cmd+space'),
    ] },
    { title: t('Paragraph'), items: [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `h${n}`, title: `${t('Heading')} ${n}`, key: `cmd+${n}`, editor: true, run: () => ed.setHeading(n) })),
      sep,
      e('paragraph', 'Paragraph', 'cmd+0', () => ed.setHeading(0)),
      sep,
      e('headingUp', 'Increase Heading Level', 'cmd+=', () => ed.changeHeading(1)),
      e('headingDown', 'Decrease Heading Level', 'cmd+-', () => ed.changeHeading(-1)),
      sep,
      sub('Table', tableItems()),
      e('mathBlock', 'Math Block', 'alt+cmd+b', () => ed.insertMath()),
      e('codeFences', 'Code Fences', 'alt+cmd+c', () => ed.insertCode(app.defaultCodeLang('menu'))),
      sub('Code Tools', [
        e('codeCopy', 'Copy Code Content', null, () => app.copyCode(), { enabled: () => ed.currentBlock()?.b.type === 'code' }),
        e('codeIndent', 'Auto Indent Whole Code', null, () => ed.autoIndentCode(), { enabled: () => ed.currentBlock()?.b.type === 'code' }),
        e('codeIndentSel', 'Auto Indent Selected Code', null, () => ed.autoIndentCode(true), { enabled: () => ed.currentBlock()?.b.type === 'code' }),
      ]),
      sep,
      !settings.alerts ? null : sub('Alert', [['note', 'Note Block'], ['tip', 'Tip Block'], ['important', 'Important Block'], ['warning', 'Warning Block'], ['caution', 'Caution Block']].map(([k, title]) => e(`alert-${k}`, title, null, () => ed.setAlert(k)))),
      e('quote', 'Quote', 'alt+cmd+q', () => ed.toggleQuote()),
      sep,
      e('ol', 'Ordered List', 'alt+cmd+o', () => ed.toggleList('ol')),
      e('ul', 'Unordered List', 'alt+cmd+u', () => ed.toggleList('ul')),
      e('task', 'Task List', 'alt+cmd+x', () => ed.toggleList('task')),
      sub('Task Status', [
        e('taskToggle', 'Toggle Task Status', 'ctrl+x', () => ed.setTask()),
        sep,
        e('taskDone', 'Mark as Complete', null, () => ed.setTask(true)),
        e('taskUndone', 'Mark as Incomplete', null, () => ed.setTask(false)),
      ]),
      sub('List Indentation', [
        e('indent', 'Indent', 'cmd+]', () => ed.indentList(1)),
        e('outdent', 'Outdent', 'cmd+[', () => ed.outdent()),
      ]),
      sep,
      e('paraBefore', 'Insert Paragraph Before', null, () => ed.insertParagraph(true)),
      e('paraAfter', 'Insert Paragraph After', null, () => ed.insertParagraph(false)),
      sep,
      e('linkRef', 'Link Reference', 'alt+cmd+l', () => ed.insertLinkRefDef()),
      e('footnote', 'Footnotes', 'alt+cmd+r', () => ed.insertFootnoteDef()),
      sep,
      e('hr', 'Horizontal Line', 'alt+cmd+-', () => ed.insertHr()),
      e('toc', 'Table of Contents', null, () => ed.insertToc()),
      e('yaml', 'YAML Front Matter', null, () => ed.insertMeta()),
    ] },
    { title: t('Format'), items: [
      e('strong', 'Strong', 'cmd+b', () => ed.toggleInline('**')),
      e('em', 'Emphasis', 'cmd+i', () => ed.toggleInline('*')),
      e('underline', 'Underline', 'cmd+u', () => ed.toggleInline('<u>', '</u>')),
      e('code', 'Code', 'ctrl+`', () => ed.toggleInline('`')),
      sep,
      // Syntax that is turned off in Settings → Markdown has no menu item (Typora hides
      // Superscript with the Subscript switch, as it does here).
      settings.mathInline ? e('inlineMath', 'Inline Math', 'ctrl+m', () => ed.toggleInline('$')) : null,
      e('strike', 'Strike', 'ctrl+shift+`', () => ed.toggleInline('~~')),
      settings.highlight ? e('highlight', 'Highlight', 'shift+cmd+h', () => ed.toggleInline('==')) : null,
      settings.subscript ? e('sup', 'Superscript', null, () => ed.toggleInline('^')) : null,
      settings.subscript ? e('sub', 'Subscript', null, () => ed.toggleInline('~')) : null,
      e('comment', 'Comment', 'ctrl+-', () => ed.toggleInline('<!--', '-->')),
      sep,
      e('link', 'Hyperlink', 'cmd+k', () => app.insertLinkFromClipboard()),
      sub('Hyperlink Actions', [
        e('linkOpen', 'Open Link', null, () => app.openLinkAtCaret()),
        e('linkCopy', 'Copy Link Address', null, () => app.copyLinkAtCaret()),
      ]),
      sub('Image', imageItems()),
      isNative ? role('importFromDevice', 'Take Picture') : null,
      sep,
      e('clearFormat', 'Clear Format', 'cmd+\\', () => ed.clearFormat()),
    ].filter(Boolean) },
    { title: t('View'), items: [
      isNative ? role('showTabBar', 'Show Tab Bar') : null,
      isNative ? role('showAllTabs', 'Show All Tabs', 'shift+cmd+\\') : null,
      isNative ? sep : null,
      c('source', 'Source Code Mode', 'cmd+/', () => app.toggleSource(), { checked: () => app.sourceMode(), enabled: () => !ed.readOnly || app.sourceMode() }),
      c('readonly', 'Readonly Mode', null, () => app.toggleReadOnly(), { checked: () => ed.readOnly, enabled: () => !app.readOnlyForced() }),
      sep,
      c('focusMode', 'Focus Mode', 'f8', () => app.toggleSetting('focusMode'), { checked: flag('focusMode') }),
      c('typewriter', 'Typewriter Mode', 'f9', () => app.toggleSetting('typewriter'), { checked: flag('typewriter') }),
      sep,
      c('toolbar', 'Toolbar', null, () => app.toggleSetting('toolbar'), { checked: flag('toolbar') }),
      sep,
      c('sidebar', 'Toggle Sidebar', 'shift+cmd+l', () => app.toggleSetting('sidebar'), { checked: flag('sidebar') }),
      c('sideOutline', 'Outline', 'ctrl+cmd+1', () => app.showSidebar('outline', { toggle: true }), { checked: () => settings.sidebar && settings.sidebarTab === 'outline' }),
      c('sideList', 'Articles', 'ctrl+cmd+2', () => app.showSidebar('list', { toggle: true }), { checked: () => settings.sidebar && settings.sidebarTab === 'list' }),
      c('sideTree', 'File Tree', 'ctrl+cmd+3', () => app.showSidebar('tree', { toggle: true }), { checked: () => settings.sidebar && settings.sidebarTab === 'tree' }),
      c('sideSearch', 'Search', 'shift+cmd+f', () => app.showSidebar('search'), { checked: () => app.sidebarTab?.() === 'search' }),
      sep,
      c('wordCount', 'Toggle Word Count Popover', null, () => app.wordCountPopover()),
      c('outlinePopover', 'Toggle Outline Popover', null, () => app.outlinePopover()),
      sep,
      c('magnification', 'Allow Magnification', null, () => app.toggleSetting('magnification'), { checked: flag('magnification'), enabled: () => isNative }),
      c('zoomReset', 'Actual Size', 'shift+cmd+0', () => app.zoom(0)),
      c('zoomIn', 'Zoom In', 'shift+cmd+=', () => app.zoom(1)),
      c('zoomOut', 'Zoom Out', 'shift+cmd+-', () => app.zoom(-1)),
      sep,
      c('alwaysOnTop', 'Always on Top', null, () => app.toggleSetting('alwaysOnTop'), { checked: flag('alwaysOnTop'), enabled: () => isNative }),
      isNative ? role('toggleFullScreen', 'Full Screen', 'ctrl+cmd+f') : c('fullscreen', 'Full Screen', null, () => platform.toggleFullScreen()),
      isNative && settings.debug ? role('devtools', 'Toggle DevTools', 'alt+cmd+i') : null,
    ].filter(Boolean) },
    { title: t('Themes'), items: [
      ...THEMES.map(([id, name]) => ({ id: `theme-${id}`, title: name, run: () => app.setSetting({ theme: id, followSystem: false }), checked: () => app.activeTheme() === id })),
    ] },
    { title: t('Window'), items: [
      role('minimize', 'Minimize', 'cmd+m'),
      role('zoom', 'Zoom'),
      sep,
      role('bringAllToFront', 'Bring All to Front'),
      ...(isNative ? [sep, role('selectPreviousTab', 'Show Previous Tab'), role('selectNextTab', 'Show Next Tab'), role('moveTabToNewWindow', 'Move Tab to New Window'), role('mergeAllWindows', 'Merge All Windows')] : []),
      role('windowList', ''),
    ] },
    { title: t('Help'), role: 'help', items: [
      c('helpNew', "What's New…", null, () => app.openHelp('docs/changelog.md')),
      sep,
      c('helpWelcome', 'Quick Start', 'shift+cmd+/', () => app.openHelp('welcome.md')),
      c('helpMarkdown', 'Markdown Reference', null, () => app.openHelp('docs/markdown-reference.md')),
      c('helpPandoc', 'Install and Use Pandoc', null, () => app.openHelp('docs/pandoc.md')),
      c('helpThemes', 'Custom Themes', null, () => app.openHelp('docs/custom-themes.md')),
      c('helpImages', 'Use Images in Livemark', null, () => app.openHelp('docs/images.md')),
      c('helpMore', 'More Topics...', null, () => app.openHelp('docs/topics.md')),
      sep,
      c('helpCredits', 'Credits', null, () => app.openHelp('docs/credits.md')),
      c('helpChangelog', 'Change Log', null, () => app.openHelp('docs/changelog.md')),
      c('helpPrivacy', 'Privacy Policy', null, () => app.openHelp('docs/privacy.md')),
    ] },
  ];

  // --- lookup tables --------------------------------------------------------

  let flat = new Map();
  let keys = new Map();
  const index = () => {
    flat = new Map();
    keys = new Map();
    const walk = (items) => {
      for (const it of items) {
        if (!it || it.separator) continue;
        if (it.items) walk(it.items);
        else if (it.id) {
          flat.set(it.id, it);
          if (it.key) {
            const k = normKey(it.key);
            if (!keys.has(k)) keys.set(k, []);
            keys.get(k).push(it);
          }
        }
      }
    };
    walk(tree());
    // Checkmarks and enabling that follow the caret: its block's kind in Paragraph,
    // the styles around it in Format (Typora's refresh on every cursor change).
    const st = () => ed.caretState?.() || null;
    const blockIs = (test) => () => {
      const s = st();
      return !!s && test(s.b);
    };
    const styled = (name) => () => !!st()?.styles.has(name);
    const prose = () => {
      const s = st();
      return !s || !['code', 'math', 'html', 'meta'].includes(s.b.type);
    };
    const STATE = {
      paragraph: { checked: blockIs((b) => b.type === 'p') },
      quote: { checked: blockIs((b) => b.q > 0) },
      ol: { checked: blockIs((b) => b.type === 'li' && b.kind === 'ol') },
      ul: { checked: blockIs((b) => b.type === 'li' && b.kind === 'ul') },
      task: { checked: blockIs((b) => b.type === 'li' && b.kind === 'task') },
      taskToggle: { enabled: blockIs((b) => b.type === 'li' && b.kind === 'task') },
      taskDone: { enabled: blockIs((b) => b.type === 'li' && b.kind === 'task'), checked: blockIs((b) => b.type === 'li' && b.kind === 'task' && !!b.checked) },
      taskUndone: { enabled: blockIs((b) => b.type === 'li' && b.kind === 'task'), checked: blockIs((b) => b.type === 'li' && b.kind === 'task' && !b.checked) },
      mathBlock: { checked: blockIs((b) => b.type === 'math') },
      codeFences: { checked: blockIs((b) => b.type === 'code') },
      yaml: { checked: blockIs((b) => b.type === 'meta') },
      linkRef: { checked: blockIs((b) => b.type === 'def' && !b.text.startsWith('[^')) },
      footnote: { checked: blockIs((b) => b.type === 'def' && b.text.startsWith('[^')) },
      paraBefore: { enabled: blockIs((b) => b.type !== 'meta') },
      linkOpen: { enabled: () => !!st()?.styles.has('link') },
      linkCopy: { enabled: () => !!st()?.styles.has('link') },
    };
    for (let n = 1; n <= 6; n++) STATE[`h${n}`] = { checked: blockIs((b) => b.type === 'h' && b.level === n) };
    for (const id of ['strong', 'em', 'underline', 'code', 'inlineMath', 'strike', 'highlight', 'sup', 'sub', 'comment']) STATE[id] = { checked: styled(id), enabled: prose };
    STATE.link = { checked: styled('link'), enabled: prose };
    STATE.clearFormat = { enabled: prose };
    // Undo / Redo are greyed out with nothing to undo or redo.
    STATE.undo = { enabled: () => app.canUndo?.() !== false };
    STATE.redo = { enabled: () => app.canRedo?.() !== false };
    for (const [id, extra] of Object.entries(STATE)) {
      const it = flat.get(id);
      if (!it) continue;
      if (extra.checked && !it.checked) it.checked = extra.checked;
      if (extra.enabled && !it.enabled) it.enabled = extra.enabled;
    }
    // In Source Code Mode the Paragraph and Format commands (and the line-break view
    // options) do not apply: they are greyed out rather than doing nothing.
    const SOURCE_OFF = new Set(['indentFirstLine', 'visibleBr', 'preserveBreaks']);
    for (const it of flat.values()) {
      if (!it.editor && !SOURCE_OFF.has(it.id)) continue;
      const own = it.enabled;
      it.enabled = () => !app.sourceMode() && (own ? own() !== false : true);
    }
  };

  const editorReady = () => !app.sourceMode() && (ed.root.contains(document.activeElement) || document.activeElement === document.body || !document.activeElement);

  // In the Mac app one keystroke can arrive twice: once as a native menu key
  // equivalent and once as a keydown in the page. Drop the echo, but only
  // across the two sources, so key repeat still works.
  let lastRun = { id: '', at: 0, via: '' };
  function run(id, via = 'ui') {
    let it = flat.get(id);
    if (!it) return false;
    // Two commands may share a shortcut and split it by context.
    if (it.when && !it.when()) {
      const other = it.key && keys.get(normKey(it.key))?.find((x) => x !== it && (!x.when || x.when()));
      if (!other) return false;
      it = other;
    }
    const now = performance.now();
    if (lastRun.id === it.id && lastRun.via !== via && via !== 'ui' && lastRun.via !== 'ui' && now - lastRun.at < 120) return true;
    lastRun = { id: it.id, at: now, via };
    if (it.enabled && it.enabled() === false) return false;
    if (it.editor && app.sourceMode()) return false;
    it.run();
    syncState();
    return true;
  }

  // --- keyboard ---------------------------------------------------------------

  const CODE_KEY = { Slash: '/', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Enter: 'enter', NumpadEnter: 'enter', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', Escape: 'escape', Space: 'space', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown' };
  const ORDER = ['ctrl', 'alt', 'shift', 'cmd'];
  function normKey(key) {
    const parts = key.toLowerCase().split('+');
    const main = parts.pop();
    // Off the Mac, the "cmd" shortcuts live on Ctrl.
    const mods = new Set(parts.map((m) => (m === 'cmd' && !isMac ? 'ctrl' : m)));
    return [...ORDER.filter((m) => mods.has(m)), main].join('+');
  }
  function eventKey(ev) {
    const code = ev.code || '';
    let main = CODE_KEY[code];
    if (!main && /^Key[A-Z]$/.test(code)) main = code[3].toLowerCase();
    if (!main && /^Digit\d$/.test(code)) main = code[5];
    if (!main && /^F\d{1,2}$/.test(code)) main = code.toLowerCase();
    if (!main) return null;
    const mods = [];
    if (ev.ctrlKey) mods.push('ctrl');
    if (ev.altKey) mods.push('alt');
    if (ev.shiftKey) mods.push('shift');
    if (ev.metaKey) mods.push(isMac ? 'cmd' : 'ctrl');
    return [...ORDER.filter((m) => mods.includes(m)), main].join('+');
  }

  function handleKey(ev) {
    if (ev.isComposing || ev.keyCode === 229) return false;
    let key = eventKey(ev);
    // Cmd+Y is a second shortcut for Redo.
    if (key === 'cmd+y' && !keys.has(key) && flat.get('redo')?.key) key = normKey(flat.get('redo').key);
    const list = key && keys.get(key);
    const it = list?.find((x) => !x.when || x.when()) || list?.[0];
    if (!it || it.role) return false;
    if (it.editor && !editorReady()) return false;
    // Plain keys (F8…) are fine anywhere; never steal typing keys.
    if (!ev.metaKey && !ev.ctrlKey && !/^f\d+$/.test(key) && !/^alt\+(up|down)$/.test(key)) return false;
    ev.preventDefault();
    ev.stopPropagation();
    run(it.id, 'key');
    return true;
  }

  // --- presenting -------------------------------------------------------------

  const val = (v) => (typeof v === 'function' ? v() : v);
  const resolve = (items) => items.filter(Boolean).map((it) => {
    if (it.separator) return it;
    if (it.items) return { title: it.title, items: resolve(it.items) };
    // Values may already be resolved when a submenu is processed twice.
    return { ...it, checked: it.checked === undefined ? undefined : !!val(it.checked), enabled: it.enabled === undefined ? undefined : val(it.enabled) !== false };
  });
  const forNative = (items) => items.filter(Boolean).map((it) => {
    if (it.separator) return { separator: true };
    if (it.items) return { title: it.title, items: forNative(it.items) };
    if (it.role) return { role: it.role, title: it.title || undefined, key: it.key || undefined };
    return { id: it.id, title: it.title, key: it.key || undefined, checked: it.checked ? !!val(it.checked) : false, enabled: it.enabled ? val(it.enabled) !== false : true };
  });
  const tidy = (items) => items.filter((it, k, arr) => !(it.separator && (k === 0 || arr[k - 1].separator || k === arr.length - 1)));
  // In the browser the roles the page cannot perform are simply left out.
  const forWeb = (items) => tidy(resolve(items).filter((it) => it.separator || it.items || !it.role).map((it) => (it.items ? { ...it, items: forWeb(it.items) } : it)));

  function renderMenubar(host) {
    host.textContent = '';
    if (isNative) return;
    tree().slice(1).forEach((menu, k) => {
      if (menu.title === t('Window')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menubar-item';
      btn.textContent = menu.title;
      btn.dataset.menuAnchor = '1';
      const open = () => {
        index();
        const items = forWeb(tree()[k + 1].items);
        if (k === 0) items.push(sep, ...forWeb([tree()[0].items[2]]));
        const r = btn.getBoundingClientRect();
        showMenu(items, r.left, r.bottom + 2, (it) => run(it.id));
        host.dataset.open = '1';
      };
      btn.addEventListener('click', open);
      btn.addEventListener('mouseenter', () => host.dataset.open === '1' && open());
      host.append(btn);
    });
    document.addEventListener('menusclosed', () => {
      delete host.dataset.open;
    });
  }

  let pushed = false;
  function pushNativeMenu() {
    index();
    if (!isNative) return;
    platform.setMenu(tree().map((m) => ({ title: m.title, items: forNative(m.items), ...(m.role ? { role: m.role } : {}) })));
    pushed = true;
  }

  // Keep check marks and enabled states in step after anything changes.
  let syncTimer = null;
  function syncState() {
    if (!isNative || !pushed) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      const items = [];
      for (const it of flat.values()) if (it.checked || it.enabled) items.push({ id: it.id, checked: it.checked ? !!val(it.checked) : false, enabled: it.enabled ? val(it.enabled) !== false : true });
      platform.updateMenu(items);
    }, 60);
  }

  // Right-click menu in the editor, laid out as Typora's macOS menu: items for what was
  // clicked (link, image, emoji, inline math) come first; then the standard block (spelling,
  // Cut, Copy, Paste, Copy / Paste As…), then Paragraph / Format / Insert (not on a picture),
  // then the block's own items (table, code, HTML, math, diagram), then Reveal in Sidebar.
  async function editorContextMenu(ev, ctx) {
    ev.preventDefault();
    index();
    const pick = (...ids) => ids.map((id) => (id === '-' ? sep : flat.get(id))).filter(Boolean);
    const before = [];
    const afterCopy = [];
    const after = [];
    let onPicture = false;
    if (ctx.image) {
      ed.selectImage(ctx.image);
      const img = ctx.image;
      const pic = ed.imageAtCaret(img);
      const local = !!pic && app.isLocalImage(pic.src);
      const remote = /^https?:\/\//i.test(pic?.src || '');
      const loaded = img.complete && img.naturalWidth > 0 && !img.closest('[data-err]');
      const folder = app.imageFolderName(pic);
      const list = [];
      if (folder) list.push(c('ctxCopyToFolder', t('Copy to {0}', folder), null, () => app.copyImageToTarget(false)));
      if (loaded) {
        list.push(flat.get('imageCopyTo'));
        if (local) {
          if (folder) list.push(c('ctxMoveToFolder', t('Move to {0}', folder), null, () => app.copyImageToTarget(true)));
          list.push(flat.get('imageMoveTo'));
        }
        const upload = c('ctxUpload', 'Upload Image', null, () => app.uploadImage());
        if (app.docImageAction() === 'upload') list.unshift(upload);
        else list.push(upload);
        afterCopy.push(c('ctxCopyImage', 'Copy Image Content', null, () => app.copyImageContent(img)));
      }
      if (local) list.unshift(c('ctxImgLocation', 'Open Image Location…', null, () => app.revealImage()));
      else if (remote) list.unshift(c('ctxImgBrowser', 'Open Image in Browser…', null, () => app.openLink(pic.src)));
      list.push(sub('Zoom Image', ZOOM_STEPS.map((f) => (f === '-' ? sep : c(`ctxZoom-${parseInt(f, 10)}`, f, null, () => ed.zoomImage(f, img))))));
      list.push(sub('Switch Image Syntax', [
        c('ctxImgMd', 'Markdown ![alt](src)', null, () => ed.setImageSyntax(false, img), { checked: () => pic && !pic.isHtml }),
        c('ctxImgHtml', 'HTML <img src="src" />', null, () => ed.setImageSyntax(true, img), { checked: () => pic?.isHtml }),
      ]));
      list.push(local ? c('ctxDeleteImgFile', 'Delete Image File', null, () => app.deleteImageFile()) : c('ctxDeleteImage', 'Delete Image', null, () => ed.deleteImage(img)));
      before.push(...list, sep);
      after.push(c('ctxSaveImage', t('Save {0} As…', t('Image')), null, () => app.saveMediaAs(pic?.src || img.getAttribute('src') || '')));
      onPicture = true;
    } else if (ctx.link) {
      before.push(c('ctxOpenLink', 'Open Link', null, () => app.openLink(ctx.link)), sep);
      afterCopy.push(c('ctxCopyLink', 'Copy Link Address', null, () => app.copyText(ctx.link)));
    }
    if (ctx.media) after.push(c('ctxSaveVideo', t('Save {0} As…', t('Video')), null, () => app.saveMediaAs(ctx.media.currentSrc || ctx.media.getAttribute('src') || '')));
    if (ctx.emoji) before.unshift(c('ctxCopyEmoji', t("Copy '{0}'", ctx.emoji), null, () => app.copyText(ctx.emoji)), sep);
    const copyMath = (tex) => sub('Copy Math', [
      c('ctxMathImage', 'Copy as Image', null, () => (ctx.block?.type === 'math' ? app.copyBlockImage(ctx.index) : app.copyInlineMathImage(ev.target))),
      c('ctxMathTex', 'Copy as Tex', null, () => app.copyText(tex)),
      c('ctxMathMl', 'Copy as MathML', null, () => app.copyMathML(tex)),
    ]);
    if (ctx.inlineMath != null && ctx.block?.type !== 'math') before.unshift(copyMath(ctx.inlineMath), sep);

    // The block's own items, after the standard ones.
    const diagram = ctx.block?.type === 'code' && DIAGRAM_LANGS.has(String(ctx.block.lang || '').trim().toLowerCase());
    const codeTools = sub('Code Tools', pick('codeCopy', 'codeIndent', 'codeIndentSel'));
    const edit = c('ctxEdit', 'Edit', null, () => ed.focusBlock(ctx.index));
    const paras = pick('paraBefore', 'paraAfter');
    const del = (title) => c('ctxDelete', title, null, () => {
      ed.focusBlock(ctx.index);
      ed.deleteBlock();
    });
    if (ctx.inTable) after.push(sep, sub('Table', tableItems()), sep, ...paras);
    else if (ctx.block?.type === 'html') after.push(sep, edit, codeTools, sep, ...paras, del('Delete'));
    else if (ctx.block?.type === 'math') after.push(sep, edit, copyMath(ctx.block.text), c('ctxSaveMath', t('Save {0} As…', t('Math')), null, () => app.saveBlockImage(ctx.index, 'math')), codeTools, sep, ...paras, del('Delete'));
    else if (diagram) after.push(sep, edit, c('ctxDiagramImage', 'Copy as Image', null, () => app.copyBlockImage(ctx.index)), c('ctxSaveDiagram', t('Save {0} As…', t('Diagram')), null, () => app.saveBlockImage(ctx.index, 'diagram')), codeTools, sep, ...paras, del('Delete'));
    else if (ctx.block?.type === 'code') after.push(sep, codeTools, sep, ...paras, del('Delete Code Block'));
    else if (ctx.block?.type === 'hr' || ctx.block?.type === 'toc') after.push(...paras, del('Delete'));

    const normal = [];
    if (ctx.word && settings.spellcheck && platform.spellCheck) {
      const info = await platform.spellCheck(ctx.word).catch(() => null);
      if (info?.misspelled) {
        // The checker's corrections first, as the system menu has them.
        const range = ctx.wordRange;
        (info.guesses || []).forEach((g, k) => normal.push(c(`ctxGuess${k}`, g, null, () => ed.replaceRange(range?.from, range?.to, g), { enabled: () => !!range })));
        if (!(info.guesses || []).length) normal.push(c('ctxNoGuess', 'No Guesses Found', null, () => {}, { enabled: () => false }));
        normal.push(sep, c('ctxLearn', 'Learn Spelling', null, () => app.learnWord(ctx.word, true)), sep);
      }
      else if (info?.learned) normal.push(c('ctxUnlearn', 'Unlearn Spelling', null, () => app.learnWord(ctx.word, false)), sep);
    }
    if (ctx.hasSelection) normal.push(c('ctxSearch', 'Search with Google', null, () => app.searchWeb()), sep);
    normal.push(
      c('ctxCut', 'Cut', null, () => app.cut(), { enabled: () => ctx.hasSelection }),
      c('ctxCopy', 'Copy', null, () => app.copyAs('rich'), { enabled: () => ctx.hasSelection }),
      ...afterCopy,
      c('ctxPaste', 'Paste', null, () => app.pasteFromClipboard()),
      sub('Copy / Paste As…', [
        ...pick('copyMarkdown', 'copyHtml'),
        c('ctxCopySimple', 'Copy without Theme Styling', null, () => app.copyAs('simple'), { enabled: () => ctx.hasSelection }),
        ...pick('copyPlain', '-', 'pastePlain'),
      ]),
    );
    if (!onPicture && !ed.readOnly) {
      normal.push(sep,
        sub('Paragraph', pick('h1', 'h2', 'h3', 'h4', 'h5', 'h6', '-', 'quote', 'ol', 'ul', 'task', '-', 'paragraph')),
        sub('Format', pick('strong', 'em', 'underline', 'code', 'strike', 'highlight', '-', 'link', '-', 'clearFormat')),
        sub('Insert', [c('ctxInsImage', 'Image', null, () => run('imageInsert')), sep, ...pick('codeFences', 'mathBlock').concat(pick('tableInsert').map((it) => ({ ...it, id: 'ctxInsTable', title: t('Table') }))), ...pick('-', 'hr', 'paraBefore', 'paraAfter')]));
    }
    if (after.length) normal.push(sep, ...after, sep);
    // Look Up: the dictionary panel for the selected text or the word clicked.
    const lookup = (ctx.hasSelection ? window.getSelection().toString() : ctx.word || '').trim();
    if (isNative && lookup && !onPicture && lookup.length < 200) normal.push(sep, c('ctxLookUp', t('Look Up “{0}”', lookup.length > 24 ? `${lookup.slice(0, 24)}…` : lookup), null, () => platform.lookUp?.({ text: lookup, x: ev.clientX, y: ev.clientY })));
    if (app.hasFile()) normal.push(sep, c('ctxRevealSidebar', 'Reveal in Sidebar', null, () => app.revealInSidebar()));
    const items = [...before, ...normal];
    // Registered commands go through run() so state stays in sync; one-off
    // items keep their own handler.
    const wire = (list) => tidy(list.filter(Boolean).map((it) => {
      if (it.separator) return it;
      if (it.items) return { title: it.title, items: wire(it.items) };
      return { id: it.id, title: it.title, key: it.key, checked: it.checked ? !!val(it.checked) : undefined, enabled: it.enabled ? val(it.enabled) !== false : undefined, run: flat.has(it.id) ? () => run(it.id) : it.run };
    }));
    contextMenu(wire(items), ev.clientX, ev.clientY);
  }

  on('command', ({ id }) => run(id, 'menu'));
  index();

  return { run, handleKey, renderMenubar, pushNativeMenu, syncState, editorContextMenu, zoomItems, tree, keyOf: (id) => keyLabel(flat.get(id)?.key), reindex: index };
}
