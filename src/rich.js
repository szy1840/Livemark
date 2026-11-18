// Everything that turns source text into something richer than styled text:
// code highlighting, math, diagrams, HTML blocks. The libraries live in
// vendor/ and are loaded on demand.

import { esc, attr, inlineCtx, safeUrl, safeStyle } from './inline.js';
import { t } from './i18n.js';

const loading = new Map();
export function loadScript(src) {
  if (!loading.has(src)) {
    loading.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(t('无法加载 {0}', src)));
      document.head.appendChild(s);
    }));
  }
  return loading.get(src);
}

const listeners = new Set();
// Called whenever a library or language finishes loading, so blocks that were
// rendered as plain text can be re-rendered.
export const onRichReady = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());

let katexSheet = null;
export async function initRich() {
  const jobs = [
    loadScript('./vendor/katex/katex.min.js').then(async () => {
      const css = await (await fetch('./vendor/katex/katex.min.css')).text();
      // Shadow roots (inline math) need the rules; the fonts come from the
      // copy linked in the main document.
      katexSheet = new CSSStyleSheet();
      katexSheet.replaceSync(css.replace(/@font-face\{[^}]*\}/g, ''));
      await loadScript('./vendor/katex/mhchem.min.js').catch(() => {});
    }),
    loadScript('./vendor/hljs/highlight.min.js'),
    fetch('./vendor/emoji.json').then((r) => r.json()).then((table) => {
      inlineCtx.emoji = table;
    }),
  ];
  await Promise.allSettled(jobs);
  notify();
}

// --- code -----------------------------------------------------------------

const ALIAS = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', py3: 'python', rb: 'ruby', sh: 'bash', zsh: 'bash',
  shell: 'bash', console: 'shell', yml: 'yaml', 'c++': 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  'c#': 'csharp', objc: 'objectivec', 'objective-c': 'objectivec', golang: 'go', rs: 'rust', kt: 'kotlin',
  docker: 'dockerfile', tex: 'latex', hs: 'haskell', ex: 'elixir', erl: 'erlang', clj: 'clojure',
  ps1: 'powershell', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', jsonc: 'json', json5: 'json',
  md: 'markdown', text: 'plaintext', txt: 'plaintext', plain: 'plaintext', 'f#': 'fsharp', vb: 'vbnet',
  pl: 'perl', mm: 'objectivec', proto: 'protobuf', tf: 'hcl', make: 'makefile', mk: 'makefile',
  gql: 'graphql', asm: 'x86asm', bat: 'dos', cmd: 'dos', patch: 'diff', conf: 'ini', toml: 'ini',
};
export const DIAGRAM_LANGS = new Set(['mermaid', 'flow', 'flowchart', 'sequence', 'gantt', 'pie']);
const tried = new Set();

// The language of a fence's info string: "python", "language-python", "lang-python",
// "{.python}" or "{.python .numberLines startFrom=\"10\"}" all mean python.
export const langName = (lang) => {
  let info = (lang || '').trim().toLowerCase();
  const braced = /^\{([^}]*)\}/.exec(info);
  if (braced) info = (/(?:^|\s)\.([\w+#-]+)/.exec(braced[1])?.[1] || '').replace(/^numberlines$/, '');
  const l = info.split(/[\s{,]/)[0].replace(/^(?:language|lang)-/, '');
  return ALIAS[l] || l;
};

// Line numbering asked for by the fence itself: {.numberLines startFrom="N"} (the whole
// info string in braces). Returns the first number, or null.
export const fenceNumbering = (lang) => {
  const braced = /^\s*\{([^}]*)\}\s*$/.exec(lang || '');
  if (!braced || !/(?:^|\s)\.numberLines\b/i.test(braced[1])) return null;
  return Number(/startFrom\s*=\s*["']?(\d+)/i.exec(braced[1])?.[1] || 1);
};

export function highlight(code, lang = '') {
  const tail = code === '' || code.endsWith('\n') ? '<br>' : '';
  const name = langName(lang);
  const hljs = window.hljs;
  if (!hljs || !name || name === 'plaintext' || DIAGRAM_LANGS.has(name)) return esc(code) + tail;
  if (hljs.getLanguage(name)) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value + tail;
    } catch {
      return esc(code) + tail;
    }
  }
  if (!tried.has(name) && /^[\w-]+$/.test(name)) {
    tried.add(name);
    loadScript(`./vendor/hljs/languages/${name}.min.js`).then(notify, () => {});
  }
  return esc(code) + tail;
}

export function languageList() {
  const base = window.hljs ? window.hljs.listLanguages() : [];
  return [...new Set([...base, 'mermaid', 'c', 'cpp', 'java', 'go', 'rust', 'swift', 'kotlin', 'php', 'ruby', 'sql', 'latex', 'dockerfile', 'nginx', 'haskell', 'scala', 'dart', 'elixir', 'powershell', 'matlab', 'r'])].sort();
}

// --- math -----------------------------------------------------------------

const KATEX_OPTS = { throwOnError: false, strict: false, trust: false, output: 'html' };
export const mathOptions = { physics: false };
// The commonly used part of the LaTeX physics package, as KaTeX macros.
const PHYSICS = {
  '\\qty': '\\left(#1\\right)', '\\pqty': '\\left(#1\\right)', '\\bqty': '\\left[#1\\right]', '\\Bqty': '\\left\\{#1\\right\\}', '\\vqty': '\\left|#1\\right|',
  '\\abs': '\\left|#1\\right|', '\\norm': '\\left\\|#1\\right\\|', '\\eval': '\\left.#1\\right|', '\\order': '\\mathcal{O}\\left(#1\\right)',
  '\\comm': '\\left[#1,#2\\right]', '\\acomm': '\\left\\{#1,#2\\right\\}', '\\pb': '\\left\\{#1,#2\\right\\}',
  '\\vb': '\\mathbf{#1}', '\\va': '\\vec{\\mathbf{#1}}', '\\vu': '\\hat{\\mathbf{#1}}', '\\vdot': '\\cdot', '\\cross': '\\times', '\\cp': '\\times',
  '\\grad': '\\nabla', '\\div': '\\nabla\\cdot', '\\curl': '\\nabla\\times', '\\laplacian': '\\nabla^2',
  '\\dd': '\\mathrm{d}', '\\dv': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}', '\\pdv': '\\frac{\\partial #1}{\\partial #2}', '\\fdv': '\\frac{\\delta #1}{\\delta #2}',
  '\\var': '\\delta', '\\Re': '\\operatorname{Re}', '\\Im': '\\operatorname{Im}', '\\tr': '\\operatorname{tr}', '\\Tr': '\\operatorname{Tr}', '\\rank': '\\operatorname{rank}', '\\erf': '\\operatorname{erf}', '\\Res': '\\operatorname{Res}',
  '\\ev': '\\left\\langle #1 \\right\\rangle', '\\expval': '\\left\\langle #1 \\right\\rangle', '\\mel': '\\left\\langle #1 \\middle| #2 \\middle| #3 \\right\\rangle',
  '\\dyad': '\\left|#1\\right\\rangle\\!\\left\\langle #2\\right|', '\\ketbra': '\\left|#1\\right\\rangle\\!\\left\\langle #2\\right|', '\\braket': '\\left\\langle #1 \\middle| #2 \\right\\rangle',
  '\\mqty': '\\begin{matrix}#1\\end{matrix}', '\\pmqty': '\\begin{pmatrix}#1\\end{pmatrix}', '\\bmqty': '\\begin{bmatrix}#1\\end{bmatrix}', '\\vmqty': '\\begin{vmatrix}#1\\end{vmatrix}',
  '\\qq': '\\quad\\text{#1}\\quad', '\\qand': '\\quad\\text{and}\\quad', '\\qif': '\\quad\\text{if}\\quad', '\\qthen': '\\quad\\text{then}\\quad',
};
// Equation numbers are drawn by the page (one counter for the whole
// document), so numbered environments are rendered in their starred form.
const NUMBERED = /\\(begin|end)\{(equation|align|gather|multline|alignat|flalign)\}/g;
export const hasNumberedEnv = (tex) => /\\begin\{(equation|align|gather|multline|alignat|flalign)\}/.test(tex);

// Equation references: \label{x} names the equation's number (or its \tag), and
// \ref{x} / \eqref{x} print it. The numbers are worked out by the editor from the
// whole document (see Editor#updateMathLabels); an unknown name prints ??.
export const mathRefs = { labels: new Map() };
export const hasMathRefs = (tex) => /\\(?:eqref|ref)\{/.test(tex || '');
function withRefs(tex) {
  if (!/\\(?:label|eqref|ref)\{/.test(tex)) return tex;
  return tex.replace(/\\label\{[^}]*\}/g, '').replace(/\\(eqref|ref)\{([^}]*)\}/g, (_, kind, name) => {
    const n = String(mathRefs.labels.get(name.trim()) ?? '??').replace(/[{}\\]/g, '');
    return kind === 'eqref' ? `\\text{(${n})}` : `\\text{${n}}`;
  });
}

export function renderMathInto(el, tex, display) {
  if (!window.katex) {
    el.textContent = tex;
    return;
  }
  try {
    el.classList.remove('math-error');
    window.katex.render(withRefs(tex || '\\ ').replace(NUMBERED, '\\$1{$2*}'), el, { ...KATEX_OPTS, displayMode: display, macros: mathOptions.physics ? { ...PHYSICS } : {} });
  } catch (err) {
    el.textContent = err.message;
    el.classList.add('math-error');
  }
}

// Inline math views are empty spans inside editable text. Their rendering
// goes into a shadow root, which keeps it out of textContent and selections.
export function hydrate(root) {
  for (const el of root.querySelectorAll('.math-view')) {
    if (el.shadowRoot) continue;
    const shadow = el.attachShadow({ mode: 'open' });
    if (katexSheet) shadow.adoptedStyleSheets = [katexSheet];
    const box = document.createElement('span');
    shadow.appendChild(box);
    // An empty formula ($$ just typed) shows a placeholder, as an empty math block does.
    if (!el.dataset.tex) renderMathInto(box, '<Empty \\space Inline \\space Math>', false);
    else renderMathInto(box, el.dataset.tex, el.dataset.display === '1');
  }
}

// --- diagrams -------------------------------------------------------------

let mermaidReady = null;
let diagramSeq = 0;
const isDark = () => document.documentElement.dataset.dark === '1';

// A theme can tune diagrams with CSS variables on :root: --mermaid-theme (default, dark,
// forest, neutral), --mermaid-sequence-numbers (on), --mermaid-flowchart-curve (basis,
// linear, …) and --mermaid--gantt-left-padding (a number of pixels).
function mermaidInit() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim().replace(/^["']|["']$/g, '');
  const theme = v('--mermaid-theme') || (isDark() ? 'dark' : 'default');
  const curve = v('--mermaid-flowchart-curve');
  const pad = parseFloat(v('--mermaid--gantt-left-padding'));
  window.mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit',
    sequence: { showSequenceNumbers: /^(on|true|1)$/i.test(v('--mermaid-sequence-numbers')) },
    ...(curve ? { flowchart: { curve } } : {}),
    ...(pad ? { gantt: { leftPadding: pad } } : {}),
  });
}

// Typora also accepts the older "sequence" and "flow" fences. Their common
// forms map onto mermaid's sequenceDiagram and flowchart.
function toMermaid(code, lang) {
  const l = langName(lang);
  if (l === 'sequence') return /^\s*sequenceDiagram/.test(code) ? code : `sequenceDiagram\n${code.replace(/^\s*title\s*:\s*(.*)$/gim, 'title $1').replace(/^(\s*)note (left|right) of ([^:]+):/gim, '$1Note $2 of $3:').replace(/^(\s*)note over ([^:]+):/gim, '$1Note over $2:')}`;
  if (l === 'flow') return /^\s*(graph|flowchart)/.test(code) ? code : flowToMermaid(code);
  if (l === 'gantt' || l === 'pie') return new RegExp(`^\\s*${l}`).test(code) ? code : `${l}\n${code}`;
  return code;
}

// flowchart.js syntax: "id=>type: label" definitions, then "a->b(yes)->c".
function flowToMermaid(code) {
  const nodes = new Map();
  const edges = [];
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const def = /^(\w+)=>(\w+):\s*(.*)$/.exec(line);
    if (def) {
      nodes.set(def[1], { type: def[2], label: def[3].replace(/:>.*$/, '').replace(/"/g, "'") || def[1] });
      continue;
    }
    const parts = line.split('->').map((p) => /^(\w+)(?:\(([^)]*)\))?$/.exec(p.trim())).filter(Boolean);
    for (let k = 0; k + 1 < parts.length; k++) {
      const cond = (parts[k][2] || '').split(',').map((s) => s.trim()).find((s) => !/^(left|right|top|bottom)$/.test(s));
      edges.push([parts[k][1], parts[k + 1][1], cond]);
    }
  }
  const shape = (id, n) => {
    if (!n) return id;
    if (n.type === 'start' || n.type === 'end') return `${id}(["${n.label}"])`;
    if (n.type === 'condition') return `${id}{"${n.label}"}`;
    if (n.type === 'inputoutput') return `${id}[/"${n.label}"/]`;
    if (n.type === 'subroutine') return `${id}[["${n.label}"]]`;
    return `${id}["${n.label}"]`;
  };
  const out = ['flowchart TD'];
  for (const [id, n] of nodes) out.push(`  ${shape(id, n)}`);
  for (const [a, b, cond] of edges) out.push(cond ? `  ${a} -->|${cond}| ${b}` : `  ${a} --> ${b}`);
  return out.join('\n');
}

export async function renderDiagram(el, code, lang) {
  const token = (el._token = (el._token || 0) + 1);
  // An empty diagram says so, as Typora draws it: a sequence diagram titled "Empty
  // Diagram", a flowchart with one such start node, otherwise the words alone.
  if (!code.trim()) {
    const kind = String(lang || '').trim().toLowerCase();
    if (kind === 'sequence') code = `title: ${t('Empty Diagram')}`;
    else if (kind === 'flow') code = `st=>start: ${t('Empty Diagram')}\ne=>end\nst->e`;
    else {
      el.classList.remove('diagram-error');
      el.replaceChildren(Object.assign(document.createElement('span'), { className: 'hint', textContent: t('Empty Diagram') }));
      return;
    }
  }
  try {
    if (!mermaidReady) mermaidReady = loadScript('./vendor/mermaid/mermaid.min.js').then(mermaidInit);
    await mermaidReady;
    const src = toMermaid(code, lang);
    const ok = await window.mermaid.parse(src, { suppressErrors: true });
    if (el._token !== token) return;
    if (!ok) {
      // Keep the last good drawing while the source is mid-edit, with the parser's
      // message (it names the line) under it.
      let message = '';
      try {
        await window.mermaid.parse(src);
      } catch (e) {
        message = String(e?.message || e?.str || e || '').trim();
      }
      if (el._token !== token) return;
      el.classList.add('diagram-error');
      const line = /line (\d+)/i.exec(message)?.[1];
      if (line) el.dataset.errorLine = line;
      else delete el.dataset.errorLine;
      if (!el.querySelector('svg')) el.replaceChildren();
      let box = el.querySelector(':scope > .diagram-error-msg');
      if (!box) {
        box = document.createElement('div');
        box.className = 'diagram-error-msg';
        el.append(box);
      }
      box.textContent = message ? `${t('图表语法有误')}\n${message.split('\n').slice(0, 4).join('\n')}` : t('图表语法有误');
      return;
    }
    const { svg } = await window.mermaid.render(`mmd-${Date.now()}-${diagramSeq++}`, src);
    if (el._token !== token) return;
    el.classList.remove('diagram-error');
    delete el.dataset.errorLine;
    el.innerHTML = svg;
  } catch (err) {
    if (el._token === token) {
      el.classList.add('diagram-error');
      el.textContent = t('图表渲染失败：{0}', err.message || err);
    }
  }
}

export function refreshDiagramTheme() {
  if (window.mermaid) mermaidInit();
}

// --- HTML blocks ----------------------------------------------------------

const DROP = new Set(['script', 'object', 'embed', 'link', 'meta', 'base', 'style', 'template', 'noscript', 'frame', 'frameset', 'applet']);
const URL_ATTRS = new Set(['href', 'src', 'poster', 'action', 'formaction', 'xlink:href', 'data', 'background']);
const LOCAL_SRC = new Set(['img', 'video', 'audio', 'source', 'track']);

// Allow-list by removal: scripts, event handlers and script URLs are
// stripped; iframes are sandboxed. The rest of the markup is kept, since
// HTML blocks exist precisely to embed arbitrary layout and media.
// Embed codes from these sites come with a script of theirs. Such a block is shown in a
// sandboxed frame of its own (scripts on, no access to this page), not in the document.
const EMBED_SCRIPTS = /^https?:\/\/(?:gist\.github\.com|platform\.twitter\.com|(?:cpwebassets|static|assets)\.codepen\.io|(?:www\.)?instagram\.com|s\.imgur\.com|speakerdeck\.com|jsfiddle\.net|cssdeck\.com)\//i;

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const scripts = [...doc.querySelectorAll('script[src]')].map((sc) => (/^\s*\/\//.test(sc.getAttribute('src')) ? `https:${sc.getAttribute('src').trim()}` : sc.getAttribute('src')));
  if (scripts.length && scripts.every((src) => EMBED_SCRIPTS.test(src))) {
    const page = html.replace(/(<script[^>]*\ssrc=["'])\/\//gi, '$1https://');
    return `<iframe class="html-embed" sandbox="allow-scripts allow-popups" referrerpolicy="no-referrer" srcdoc="${attr(`<!doctype html><meta charset="utf-8"><base target="_blank"><body style="margin:0">${page}</body>`)}"></iframe>`;
  }
  const walk = (node) => {
    for (const el of [...node.children]) {
      const tag = el.tagName.toLowerCase();
      if (DROP.has(tag)) {
        el.remove();
        continue;
      }
      for (const a of [...el.attributes]) {
        const name = a.name.toLowerCase();
        // Event handlers go; media do not start on their own or preload in the editor.
        if (name.startsWith('on') || name === 'contenteditable' || name === 'autoplay' || name === 'preload') el.removeAttribute(a.name);
        else if (name === 'srcdoc' && tag !== 'iframe') el.removeAttribute(a.name);
        else if (URL_ATTRS.has(name)) {
          // Protocol-relative addresses (embed codes such as //player.example.com/…) mean https.
          let v = safeUrl(/^\s*\/\//.test(a.value) ? `https:${a.value.trim()}` : a.value);
          if (name === 'src' && LOCAL_SRC.has(tag)) v = inlineCtx.resolveSrc(v);
          el.setAttribute(a.name, v);
        } else if (name === 'style') el.setAttribute('style', safeStyle(a.value));
      }
      if (tag === 'iframe') {
        el.setAttribute('referrerpolicy', 'no-referrer');
        if (el.hasAttribute('srcdoc')) {
          // Inline page content: shown, with nothing able to run.
          el.setAttribute('sandbox', '');
          el.removeAttribute('src');
        } else {
          el.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
          if (!/^https?:\/\//i.test(el.getAttribute('src') || '')) el.removeAttribute('src');
          // Shown loading until the page arrives.
          el.classList.add('frame-loading');
        }
      }
      if (tag === 'video' || tag === 'audio') {
        el.setAttribute('controlslist', 'nodownload');
        if (tag === 'audio') el.setAttribute('controls', '');
      }
      if (tag === 'a') el.setAttribute('rel', 'noopener noreferrer');
      walk(el);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export { esc, attr };

// Feedback for media in HTML blocks: a video or audio file that cannot be played says
// which file it was; a frame stops showing as loading once its page has come.
export function watchHtmlMedia(root) {
  for (const el of root.querySelectorAll('video, audio')) {
    if (el._watched) continue;
    el._watched = true;
    el.addEventListener('error', () => {
      const src = el.currentSrc || el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || '';
      const note = document.createElement('div');
      note.className = 'media-missing';
      note.textContent = `${t('Cannot play')}: ${decodeURI(src)}`;
      el.replaceWith(note);
    }, true);
  }
  for (const el of root.querySelectorAll('iframe.frame-loading')) {
    if (el._watched) continue;
    el._watched = true;
    if (!el.getAttribute('src')) {
      el.classList.remove('frame-loading');
      el.classList.add('frame-blank');
      continue;
    }
    el.addEventListener('load', () => el.classList.remove('frame-loading'), { once: true });
  }
}
