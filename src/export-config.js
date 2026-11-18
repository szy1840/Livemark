// Export configurations, as Settings → Export lists them: four fixed entries
// (PDF, HTML, HTML without styles, Image) and a user list made from templates.
// Every entry has its own settings, stored in settings.exportCfg[key].

export const TEMPLATES = [
  ['pdf', 'PDF (Livemark / Webkit)'],
  ['latex-pdf', 'PDF (LaTeX / Pandoc)'],
  ['html', 'HTML'],
  ['html-plain', 'HTML (without Styles)'],
  ['image', 'Image'],
  ['docx', 'Word (.docx)'],
  ['odt', 'OpenOffice'],
  ['rtf', 'RTF'],
  ['epub', 'Epub'],
  ['latex', 'LaTeX'],
  ['wiki', 'Media Wiki'],
  ['rst', 'reStructuredText'],
  ['textile', 'Textile'],
  ['opml', 'OPML'],
  ['markdown', 'Markdown (Other Spec)'],
  ['native', 'Native (Pandoc)'],
  ['pandoc', 'Pandoc'],
  ['custom', 'Custom'],
];
// The template name shown for PDF reads "Livemark / WebKit" in this app.
export const templateName = (type) => ((TEMPLATES.find(([t]) => t === type) || [, type])[1]);

export const FIXED = [
  { key: 'pdf', name: 'PDF', type: 'pdf' },
  { key: 'html', name: 'HTML', type: 'html' },
  { key: 'html-plain', name: 'HTML (without Styles)', type: 'html-plain' },
  { key: 'image', name: 'Image', type: 'image' },
];
export const DEFAULT_LIST = [
  { key: 'docx', name: 'Word (.docx)', type: 'docx' },
  { key: 'odt', name: 'OpenOffice', type: 'odt' },
  { key: 'rtf', name: 'RTF', type: 'rtf' },
  { key: 'epub', name: 'Epub', type: 'epub' },
  { key: 'latex', name: 'LaTeX', type: 'latex' },
  { key: 'wiki', name: 'Media Wiki', type: 'wiki' },
  { key: 'rst', name: 'reStructuredText', type: 'rst' },
  { key: 'textile', name: 'Textile', type: 'textile' },
  { key: 'opml', name: 'OPML', type: 'opml' },
];

// Pandoc's writer and the file extension for each Pandoc template.
export const PANDOC_TARGET = { docx: ['docx', 'docx'], odt: ['odt', 'odt'], rtf: ['rtf', 'rtf'], epub: ['epub', 'epub'], latex: ['latex', 'tex'], wiki: ['mediawiki', 'wiki'], rst: ['rst', 'rst'], textile: ['textile', 'textile'], opml: ['opml', 'opml'], 'latex-pdf': ['pdf', 'pdf'], markdown: ['markdown', 'md'], native: ['native', 'native'] };

const q = (s) => JSON.stringify(s);
const BASE = '-f native -s -o ${outputPath}';
// The read-only "Arguments" line each Pandoc template shows, from its fields.
export function argPreview(type, c = {}) {
  const has = (k) => String(c[k] ?? '').trim();
  switch (type) {
    case 'docx': return `${BASE} -t docx${has('reference-doc') ? ` --reference-doc ${q(c['reference-doc'])}` : ''}`;
    case 'odt': return `${BASE} -t odt${has('template') ? ` --template ${q(c.template)}` : ''}`;
    case 'epub': return `${BASE} -t epub${has('css') ? ` --css ${q(c.css)}` : ''}${has('toc-depth') ? ` --toc-depth=${c['toc-depth']}` : ''}`;
    case 'rtf': case 'latex': case 'rst': case 'textile': case 'opml': return `${BASE} -t ${type}`;
    case 'wiki': return `${BASE} -t mediawiki`;
    case 'latex-pdf': return `${BASE}${has('pdf-engine') ? ` --pdf-engine=${q(c['pdf-engine'])}` : ''}${has('template') ? ` --template=${c.template}` : ''}`;
    case 'pandoc': return has('targetFormat') ? `${BASE} -t ${c.targetFormat}` : BASE;
    case 'markdown': return [`${BASE} -t ${c.variants || 'markdown'}`,
      c.hardLineWrap ? `--columns=${c.columns || 130}` : '',
      c.eol ? `--eol=${c.eol}` : '',
      c.tab ? (c.tab === 'tab' ? '--preserve-tabs' : `--tab-stop=${c.tab}`) : '',
      c.ascii ? '--ascii' : '',
      c['reference-links'] ? '--reference-links' : '',
      c['reference-location'] ? `--reference-location=${c['reference-location']}` : '',
      c['markdown-headings'] ? `--markdown-headings=${c['markdown-headings']}` : '',
      c.webtex ? `--webtex=https://latex.codecogs.com/${c['webtex-format'] || 'png'}.latex` : ''].filter(Boolean).join(' ');
    default: return '';
  }
}

// The Pandoc command-line options (after the input) for one export.
export function pandocOptions(type, c = {}) {
  const out = [];
  const add = (...x) => out.push(...x);
  const has = (k) => String(c[k] ?? '').trim();
  if (type === 'docx' && has('reference-doc')) add('--reference-doc', c['reference-doc']);
  if (type === 'odt' && has('template')) add('--template', c.template);
  if (type === 'epub') {
    if (has('css')) add('--css', c.css);
    add(`--toc-depth=${c['toc-depth'] || 3}`);
  }
  if (type === 'latex-pdf') {
    if (has('pdf-engine')) add(`--pdf-engine=${c['pdf-engine']}`);
    if (has('template')) add(`--template=${c.template}`);
  }
  if (type === 'markdown') {
    if (c.hardLineWrap) add(`--columns=${c.columns || 130}`, '--wrap=auto');
    if (c.eol) add(`--eol=${c.eol}`);
    if (c.tab) add(c.tab === 'tab' ? '--preserve-tabs' : `--tab-stop=${c.tab}`);
    if (c.ascii) add('--ascii');
    if (c['reference-links']) add('--reference-links');
    if (c['reference-location']) add(`--reference-location=${c['reference-location']}`);
    if (c['markdown-headings']) add(`--markdown-headings=${c['markdown-headings']}`);
    if (c.webtex) add(`--webtex=https://latex.codecogs.com/${c['webtex-format'] || 'png'}.latex`);
  }
  return out;
}

const AFTER = [
  ['openExportLocation', 'check', 'After Export', 'Open exported file location'],
  ['openExportFile', 'check', '', 'Open exported file'],
  ['runCommand', 'check', '', 'Run command'],
  ['runCommandStr', 'command', '', 'Command', { when: (c) => c.runCommand }],
  ['showOutput', 'check', '', 'Show command output', { when: (c) => c.runCommand }],
];
const EXTRA = [['extraArguments', 'text', 'Extra Arguments', '']];
const ARG = [['arg', 'arg', 'Arguments', '']];
const PAPERS = [['', 'Default'], ['A5', 'A5'], ['A4', 'A4'], ['A3', 'A3'], ['Letter', 'US Letter'], ['Legal', 'US Legal'], ['Tabloid', 'Tabloid'], ['custom', 'Custom']];
export const PAPER_MM = { A5: [148, 210], A4: [210, 297], A3: [297, 420], Letter: [216, 279], Legal: [216, 356], Tabloid: [279, 432] };
const PER_FILE = ['allowPerFileSetting', 'check', 'General', 'Read and overwrite export settings from YAML front matters'];

// [field, kind, label, inline label / placeholder, opts]
export const SCHEMA = {
  pdf: [
    ['paper', 'paper', 'Paper Size', '', { choices: PAPERS }],
    ['exportTheme', 'theme', 'Theme', 'Change this option to specify a separated theme for export.'],
    ['splitPages', 'check', 'Page Break', 'Page Break Between Top Headings'],
    ['header', 'preset', 'Header', 'None', { presets: ['${title}', '${author}', '${pageNo}', '${today}'] }],
    ['footer', 'preset', 'Footer', 'None', { presets: ['${title}', 'No. ${pageNo} / ${totalPages}', 'Written in Livemark', 'CONFIDENTIAL'] }],
    ['author', 'text', 'Author', 'Empty'],
    ['outline', 'check', 'Outline', 'Include Outline Sidebar'],
    ['appendBody', 'textarea', 'Append Extra Content (HTML)', ''],
    PER_FILE,
  ],
  'latex-pdf': [...ARG, ['pdf-engine', 'suggest', 'PDF Engine', '', { suggest: ['pdflatex', 'lualatex', 'xelatex', 'latexmk', 'tectonic', 'wkhtmltopdf', 'weasyprint', 'prince', 'context', 'pdfroff'] }],
    ['template', 'file', 'Template', '', { extensions: ['tex', 'latex', 'context', 'ms', 'html'] }], ...EXTRA, ['author', 'text', 'Author', 'Empty']],
  html: [['sidebar', 'check', 'Outline', 'Include Outline Sidebar'], ['exportTheme', 'theme', 'Theme', 'Change this option to specify a separated theme for export.'],
    ['appendHead', 'textarea', 'Append in <head />', ''], ['appendBody', 'textarea', 'Append in <body />', ''], PER_FILE],
  'html-plain': [['appendHead', 'textarea', 'Append in <head />', ''], ['appendBody', 'textarea', 'Append in <body />', ''], PER_FILE],
  image: [
    ['imageWidth', 'number', 'Width', 'px', { min: 100, max: 4096, reset: 640 }],
    ['quality', 'select', 'Image Quality', '', { choices: [[0, 'Auto'], [1, 'Medium'], [2, 'High'], [3, 'Best']] }],
    ['useThemeFontSize', 'radio', 'Font Size', '', { choices: [[0, 'Use custom font size'], [1, 'Use theme font size']] }],
    ['imageFontSize', 'number', '', 'px', { min: 8, max: 72, reset: 24, when: (c) => !c.useThemeFontSize }],
    ['exportTheme', 'theme', 'Theme', 'Change this option to specify a separated theme for export.'],
  ],
  docx: [...ARG, ...EXTRA, ['reference-doc', 'file', 'Style Reference', '', { extensions: ['docx'] }]],
  odt: [...ARG, ...EXTRA, ['template', 'file', 'Template', '', { extensions: ['opendocument', 'odt', 'ott'] }]],
  rtf: [...ARG, ...EXTRA],
  epub: [...ARG, ...EXTRA, ['css', 'file', 'Custom CSS', '', { extensions: ['css'] }], ['toc-depth', 'select', 'Chapter Level in Outline', '', { choices: [1, 2, 3, 4, 5, 6].map((n) => [String(n), String(n)]) }]],
  latex: [...ARG, ...EXTRA],
  wiki: [...ARG, ...EXTRA],
  rst: [...ARG, ...EXTRA],
  textile: [...ARG, ...EXTRA],
  opml: [...ARG, ...EXTRA],
  markdown: [...ARG,
    ['variants', 'select', 'Markdown Variants', '', { choices: [['', 'Pandoc Markdown'], ['markdown_phpextra', 'PHP Markdown Extra'], ['markdown_mmd', 'MultiMarkdown'], ['markdown_strict', 'Original Unextended Markdown'], ['commonmark', 'CommonMark'], ['gfm', 'Github-Flavored Markdown'], ['commonmark_x', 'CommonMark with many pandoc extensions']] }],
    ['hardLineWrap', 'check', 'Line Wrap', 'Hard line wrap'],
    ['columns', 'number', 'Text Column Width', '', { min: 10, max: 9999, reset: 130, when: (c) => c.hardLineWrap }],
    ['eol', 'select', 'Line Endings', '', { choices: [['', 'Auto (based on current OS)'], ['crlf', 'Windows Line Endings (CRLF)'], ['lf', 'Unix Line Endings (LF)']] }],
    ['tab', 'select', 'Indent', '', { choices: [['2', '2 spaces per tab'], ['3', '3 spaces per tab'], ['tab', 'Preserve tabs'], ['', '4 spaces per tab']] }],
    ['ascii', 'check', 'Unicode Characters', 'Use only ASCII characters in output'],
    ['reference-links', 'check', 'Link Reference', 'Use reference-style links rather than inline links'],
    ['reference-location', 'select', 'Footnotes and References Location', '', { choices: [['', 'End of document'], ['block', 'End of current (top-level) block'], ['section', 'End of current section']] }],
    ['markdown-headings', 'select', 'Heading Style', '', { choices: [['', 'Auto'], ['atx', 'atx (#)'], ['setext', 'setext (===)']] }],
    ['webtex', 'check', 'Math', 'Convert TeX formulas to web images'],
    ['webtex-format', 'select', 'Image Format', '', { choices: [['', 'png'], ['svg', 'svg']], when: (c) => c.webtex }],
    ...EXTRA],
  native: [['targetFormat', 'suggest', 'Target Format', '', { suggest: ['asciidoc', 'beamer', 'commonmark', 'context', 'docbook', 'docx', 'dokuwiki', 'epub', 'gfm', 'html', 'ipynb', 'jira', 'json', 'latex', 'man', 'markdown', 'mediawiki', 'ms', 'native', 'odt', 'opml', 'org', 'plain', 'pptx', 'rst', 'rtf', 'texinfo', 'textile', 'revealjs', 'zimwiki'] }]],
  pandoc: [...ARG,
    ['targetFormat', 'suggest', 'Target Format', 'auto detect based on target file path', { suggest: ['pdf', 'docx', 'odt', 'rtf', 'epub', 'latex', 'mediawiki', 'rst', 'textile', 'opml'] }],
    ['extensions', 'text', 'Target File Extensions (separate by whitespace)', 'e.g: .text .asciidoc or leave this empty'],
    ['raw', 'select', 'Raw Type', '', { choices: [['', 'Auto'], ['html', 'html'], ['mediawiki', 'mediawiki'], ['rst', 'rst'], ['textile', 'textile'], ['latex', 'latex'], ['docx', 'docx'], ['opml', 'opml']] }],
    ...EXTRA],
  custom: [
    ['command', 'text', 'Command', "e.g: git commit -am 'save'; git push;"],
    ['saveDialog', 'select', 'Show Save File Dialog', '', { choices: [['', 'Do not popup save file dialog'], ['saveFile', 'Select file path to save'], ['saveFolder', 'Select folder path to save']] }],
    ['extensions', 'text', 'Target File Extensions (separate by whitespace)', '', { when: (c) => c.saveDialog === 'saveFile' }],
    ['showOutput', 'check', '', 'Show command output'],
    ['openExportLocation', 'check', 'After Export', 'Open exported file location', { when: (c) => !!c.saveDialog }],
    ['openExportFile', 'check', '', 'Open exported file', { when: (c) => c.saveDialog === 'saveFile' }],
  ],
};
// Every template but Custom ends with the after-export options.
for (const type of Object.keys(SCHEMA)) if (type !== 'custom') SCHEMA[type].push(...AFTER);

export const COMMAND_PRESETS = ['pbcopy < "${outputPath}"', 'git add "${outputPath}"'];

// The settings of one entry, with the template's defaults filled in. "Open exported
// file location" falls back to the General setting, and to on for the HTML exports.
export function configOf(settings, key, type) {
  const c = { ...((settings.exportCfg || {})[key] || {}) };
  if (type === 'image') {
    c.imageWidth ??= 640;
    c.quality ??= 0;
    c.useThemeFontSize ??= 0;
    c.imageFontSize ??= 24;
  }
  if (type === 'epub') c['toc-depth'] ??= '3';
  if (type === 'markdown') c.columns ??= 130;
  if (c.openExportLocation === undefined) {
    const general = (settings.exportCfg || {}).general || {};
    c.openExportLocation = general.openExportLocation ?? (type === 'html' || type === 'html-plain');
  }
  if (SCHEMA[type]?.some(([f]) => f === 'arg')) c.arg = argPreview(type, c);
  return c;
}

// All entries in menu order: the fixed four, then the user's list.
export const exportEntries = (settings) => [...FIXED, ...(settings.exportList || DEFAULT_LIST)];

// A key for a new entry made from a template: the type, numbered when taken
// (the fixed types always get a number).
export function newEntry(list, type) {
  const taken = new Set([...FIXED.map((x) => x.key), ...list.map((x) => x.key)]);
  let key = type;
  let n = 0;
  while (taken.has(key)) key = `${type}${++n}`;
  const base = templateName(type);
  return { key, name: n ? `${base}-${n}` : base, type };
}
