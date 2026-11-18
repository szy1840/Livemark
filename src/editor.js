// The live editor core.
//
// How typing stays instant:
//   1. Ordinary keystrokes are NOT handled by this code. The browser's native
//      contenteditable inserts the character, so there is no input latency.
//   2. After the keystroke lands, only the one block under the caret is
//      re-styled ("brushed"): its text is re-parsed and, only if the resulting
//      markup differs from what is already in the DOM, replaced.
//   3. Markdown markers stay in the DOM, hidden by CSS. Moving the caret into
//      a token just flips an attribute to reveal them. No re-render at all.
//   4. Anything structural (Enter, Backspace at a block edge, paste, edits
//      spanning several blocks) is intercepted and applied to the block model,
//      then reconciled into the DOM by block id.
//
// Commands (formatting, tables, selection helpers…) live in editor-ops.js.

import { renderInline, renderDef, parseDef, inlineCtx, headingHtml } from './inline.js';
import { highlight, hydrate, renderMathInto, hasNumberedEnv, renderDiagram, sanitizeHtml, watchHtmlMedia, langName, fenceNumbering, DIAGRAM_LANGS, esc, mathRefs, hasMathRefs } from './rich.js';
import { parseMarkdown, serialize, numberLists, splitRow, uid, ALERT, isAlert, slugify, sourceLead, headingIds } from './markdown.js';
import { installOps } from './editor-ops.js';
import { t } from './i18n.js';

export const TEXTY = new Set(['p', 'h', 'li']); // can be split and merged as prose
const RAW = new Set(['code', 'math', 'html', 'meta']); // one leaf of raw text
const NOLEAF = new Set(['hr', 'toc']);
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// --- block / position helpers -------------------------------------------
// A position is { i: block index, leaf: editable leaf within the block, off:
// character offset in that leaf's source text }. Every block has one leaf,
// except tables (one per cell) and rules / tables of contents (none).

export const mk = (type, props = {}, like = null) => ({ id: uid(), q: like?.q || 0, indent: like?.indent || 0, type, ...props });
export const P = (text = '', like = null) => mk('p', { text }, like);
export const cols = (b) => b.rows[0].length;
export const leafCount = (b) => (b.type === 'table' ? b.rows.length * cols(b) : NOLEAF.has(b.type) ? 0 : 1);
export const leafText = (b, leaf = 0) => {
  if (NOLEAF.has(b.type)) return '';
  if (b.type !== 'table') return b.text;
  return b.rows[Math.floor(leaf / cols(b))][leaf % cols(b)];
};
export const withLeaf = (b, leaf, text) => {
  if (b.type !== 'table') return { ...b, text };
  const n = cols(b);
  const rows = b.rows.slice();
  const r = Math.floor(leaf / n);
  rows[r] = rows[r].slice();
  rows[r][leaf % n] = text;
  return { ...b, rows };
};
export const leavesOf = (el) => (el.hasAttribute('data-leaf') ? [el] : [...el.querySelectorAll('[data-leaf]')]);
export const cmp = (a, b) => a.i - b.i || a.leaf - b.leaf || a.off - b.off;
export const sameLeaf = (a, b) => a.i === b.i && a.leaf === b.leaf;
export const startOf = (doc, i) => (NOLEAF.has(doc[i].type) ? startOf(doc, i + 1) : { i, leaf: 0, off: 0 });
export const endOf = (doc, i) => {
  const b = doc[i];
  if (NOLEAF.has(b.type)) return startOf(doc, i + 1);
  const leaf = leafCount(b) - 1;
  return { i, leaf, off: leafText(b, leaf).length };
};
export const splice = (doc, i, n, items = []) => [...doc.slice(0, i), ...items, ...doc.slice(i + n)];
// The document always ends in a prose block, so the caret can always get
// below a trailing code block, table or rule.
export const normalize = (doc) => (doc.length && TEXTY.has(doc[doc.length - 1].type) ? doc : [...doc, P()]);
// Switches the app can flip at run time.
export const features = { diagrams: true, mathFence: false };
const isMathFence = (b) => features.mathFence && b.type === 'code' && langName(b.lang) === 'math';
// Code blocks that show a rendered preview: diagrams and ```math.
export const isDiagram = (b) => b.type === 'code' && ((features.diagrams && DIAGRAM_LANGS.has(langName(b.lang))) || isMathFence(b));
// Blocks whose source is hidden behind a rendered preview until focused.
export const isIsland = (b) => b.type === 'math' || b.type === 'html' || isDiagram(b);

// [element, startOffset, endOffset] for every inline token inside a leaf.
export function tokenSpans(leaf) {
  const res = [];
  let off = 0;
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) off += c.length;
      else if (c.nodeType === 1) {
        const start = off;
        walk(c);
        if (c.classList.contains('tok')) res.push([c, start, off]);
      }
    }
  };
  walk(leaf);
  return res;
}

// Tokens shown as a symbol instead of their text.
const ATOMIC = new Set(['emoji', 'smart']);

// Tokens whose markers are not a style that can be closed and reopened.
const NO_SPLIT = new Set(['link', 'image', 'url', 'html', 'math', 'emoji', 'smart', 'escape', 'fnref', 'comment']);

const BACKWARD = new Set(['deleteContentBackward', 'deleteWordBackward', 'deleteSoftLineBackward', 'deleteHardLineBackward']);
const FORWARD = new Set(['deleteContentForward', 'deleteWordForward', 'deleteSoftLineForward', 'deleteHardLineForward']);
const RUNTIME_ATTRS = / data-(?:open|err)=""/g;

const OPEN = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '（': '）', '「': '」', '『': '』', '《': '》', '【': '】', '“': '”', '‘': '’' };
// Markdown markers pair up only when that option is on; the backtick is one of them.
const MD_PAIRS = new Set(['*', '_', '~', '=', '$', '`']);
const CLOSERS = new Set(Object.values(OPEN));


// HTML elements that never have a closing tag.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param', 'keygen']);
const BLOCK_HTML = /^<(address|article|aside|blockquote|details|dialog|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|center|video|audio|iframe|picture|svg)(\s[^>]*)?>$/i;
// The innermost tag still open at the end of `text` (null when none).
function openTagAt(text) {
  const stack = [];
  for (const m of text.matchAll(/<(\/?)([a-zA-Z][\w:-]*)\b[^<>]*?(\/?)>/g)) {
    const name = m[2].toLowerCase();
    if (m[3] || VOID_TAGS.has(name)) continue;
    if (!m[1]) stack.push(m[2]);
    else {
      const k = stack.map((x) => x.toLowerCase()).lastIndexOf(name);
      if (k >= 0) stack.length = k;
    }
  }
  return stack.length ? stack[stack.length - 1] : null;
}
const isHtmlFence = (b) => b.type === 'code' && /^(html|xml|xhtml|svg|vue|jsx|tsx)$/i.test(langName(b.lang || ''));

export class Editor {
  constructor(root, scroller, hooks = {}) {
    this.root = root;
    this.scroller = scroller;
    this.hooks = hooks;
    this.doc = [P()];
    this.history = [];
    this.hIndex = -1;
    this.composing = false;
    this.mouseDown = false;
    this.typewriter = false;
    this.readOnly = false;
    this.opts = { autoPair: true, autoPairMd: false, smartQuotes: false, smartDashes: false, lineNumbers: false, codeWrap: true, codeIndent: 4, shiftTabIndentCode: false, copyLine: false, defaultCodeLang: '', typewriterCenter: true };
    this.tpl = document.createElement('div');
    this.diagramTimers = new Map();

    root.contentEditable = 'true';
    root.spellcheck = false;
    root.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('keydown', (e) => this.onKeyDown(e));
    root.addEventListener('compositionstart', () => this.beginComposition());
    root.addEventListener('compositionend', (e) => this.endComposition(e.data || ''));
    root.addEventListener('paste', (e) => this.onPaste(e));
    root.addEventListener('copy', (e) => this.onCopy(e, false));
    root.addEventListener('cut', (e) => this.onCopy(e, true));
    root.addEventListener('drop', (e) => this.onDrop(e));
    root.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (types.includes('Files') || (!this.draggingOwn && (types.includes('text/plain') || types.includes('text/html') || types.includes('text/uri-list')))) e.preventDefault();
    });
    root.addEventListener('dragstart', () => (this.draggingOwn = true));
    document.addEventListener('dragend', () => (this.draggingOwn = false));
    root.addEventListener('mousedown', (e) => this.onMouseDown(e));
    // The page area under the text, outside the editing host.
    scroller?.addEventListener('mousedown', (e) => {
      if (e.target === scroller && e.button === 0 && e.detail < 2 && this.clickInMargin(e)) e.preventDefault();
    });
    root.addEventListener('mouseover', (e) => this.onFootnoteHover(e));
    root.addEventListener('mouseover', (e) => {
      if (e.target.tagName === 'IMG' && !e.target.complete && !e.target.title) e.target.title = this.hooks.labels?.imageLoading || 'Image is loading…';
    });
    root.addEventListener('mouseout', (e) => this.onFootnoteLeave(e));
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    root.addEventListener('contextmenu', (e) => this.hooks.onContextMenu?.(e, this.contextAt(e)));
    root.addEventListener('error', (e) => this.onImageState(e, true), true);
    root.addEventListener('load', (e) => this.onImageState(e, false), true);
    document.addEventListener('mouseup', () => {
      if (!this.mouseDown) return;
      this.mouseDown = false;
      this.onSelectionChange();
    });
    document.addEventListener('selectionchange', () => this.onSelectionChange());
    this.render();
  }

  // --- public API ---------------------------------------------------------

  setMarkdown(md) {
    this.doc = normalize(parseMarkdown(md));
    this.root.textContent = '';
    this.labelKey = null;
    this.updateMathLabels();
    this.render();
    this.history = [];
    this.hIndex = -1;
    this.record('load');
    this.changed();
  }

  // New text as one undoable step (reloading after another program changed the file),
  // so Edit → Undo brings the previous text back.
  // Replaces the whole document as one undoable step. `keepCaret`: the caret stays at
  // the same block and offset as far as the new text allows.
  replaceMarkdown(md, keepCaret = false) {
    const next = normalize(parseMarkdown(md));
    const cur = keepCaret && (this.getSel() || this.lastSel);
    let at = startOf(next, 0);
    if (cur) {
      const i = Math.min(cur.focus.i, next.length - 1);
      const b = next[i];
      at = leafCount(b) ? { i, leaf: Math.min(cur.focus.leaf, leafCount(b) - 1), off: 0 } : startOf(next, i);
      if (leafCount(b)) at.off = Math.min(cur.focus.off, leafText(b, at.leaf).length);
    }
    this.apply(next, at, 'reload');
  }

  // A default code language: "__LAST" stands for the language of the last
  // code block whose language was typed or chosen.
  codeLang(lang) {
    return lang === '__LAST' ? this.lastCodeLang || '' : lang || '';
  }

  getMarkdown() {
    this.flushIme();
    return serialize(this.doc);
  }

  focus() {
    this.setSel(startOf(this.doc, 0));
  }

  focusBlock(i, smooth = true) {
    this.setSel(endOf(this.doc, i));
    this.root.children[i]?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  }

  setOptions(opts) {
    const before = this.opts;
    this.opts = { ...before, ...opts };
    if (before.lineNumbers !== this.opts.lineNumbers || before.codeWrap !== this.opts.codeWrap) this.rerenderAll();
  }

  setReadOnly(on) {
    this.readOnly = on;
    this.root.contentEditable = on ? 'false' : 'true';
    this.root.classList.toggle('readonly', on);
  }

  // Drop every element and rebuild: used when something global changed
  // (theme, image root, a library finished loading).
  rerenderAll() {
    const sel = this.getSel();
    this.root.textContent = '';
    this.focusEl = null;
    this.render();
    if (sel && document.activeElement && this.root.contains(document.activeElement)) this.setSel(sel.anchor, sel.focus);
  }

  // --- DOM <-> position ---------------------------------------------------

  indexOfEl(bel) {
    return Array.prototype.indexOf.call(this.root.children, bel);
  }

  toPos(node, offset) {
    if (node === this.root) {
      const n = this.root.children.length;
      if (!n) return null;
      return offset >= n ? endOf(this.doc, n - 1) : startOf(this.doc, offset);
    }
    const el = node.nodeType === 1 ? node : node.parentElement;
    const bel = el.closest('[data-id]');
    if (!bel || bel.parentElement !== this.root) return null;
    const i = this.indexOfEl(bel);
    if (i < 0 || i >= this.doc.length) return null;
    const leaf = el.closest('[data-leaf]');
    if (!leaf) return node === bel && offset === 0 ? startOf(this.doc, i) : endOf(this.doc, i);
    const r = document.createRange();
    r.setStart(leaf, 0);
    r.setEnd(node, offset);
    // Range#toString counts hidden marker text too, which is exactly the
    // source offset we want.
    return { i, leaf: leavesOf(bel).indexOf(leaf), off: this.snapOut(leaf, el, r.toString().length) };
  }

  // While a token is collapsed its markers are hidden, so the browser can
  // only put the caret at the ends of the visible text. Those two places
  // stand for the token's outer edges: arriving from the right lands after
  // the closing marker, arriving from the left before the opening one.
  snapOut(leaf, el, off) {
    let tok = el.closest('.tok');
    if (!tok || !leaf.contains(tok)) return off;
    for (let up = tok.parentElement.closest('.tok'); up && leaf.contains(up); up = up.parentElement.closest('.tok')) tok = up;
    if (tok.hasAttribute('data-open')) return off;
    const r = document.createRange();
    r.setStart(leaf, 0);
    r.setEndBefore(tok);
    const a = r.toString().length;
    const z = a + tok.textContent.length;
    if (off <= a || off >= z) return off;
    let before = 0;
    let after = 0;
    let pos = a;
    const w = document.createTreeWalker(tok, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const from = pos;
      pos += n.length;
      const mk = n.parentElement.closest('.mk');
      if (mk && getComputedStyle(mk).display === 'none') continue;
      before += Math.max(0, Math.min(off, pos) - from);
      after += Math.max(0, pos - Math.max(off, from));
    }
    // Nothing visible on either side: a token shown as a picture or symbol
    // (emoji, smart punctuation, inline math). Step over it whole.
    if (!before && !after) return this.arrowDir === 'left' ? a : z;
    // Coming from the right the caret stops inside, before the closing
    // marker; coming from the left it stays outside, before the opening one.
    if (!after) {
      const last = tok.lastElementChild;
      const closing = last && last.classList.contains('mk') && !NO_SPLIT.has(tok.dataset.t) ? last.textContent.length : 0;
      return z - closing;
    }
    if (!before) return a;
    return off;
  }

  toDom(pos) {
    const bel = this.root.children[pos.i];
    const leaf = bel && leavesOf(bel)[pos.leaf];
    if (!leaf) return { node: this.root, offset: Math.min(pos.i, this.root.children.length), host: this.root };
    const host = leaf.closest('[contenteditable="true"]') || this.root;
    const w = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
    let rem = pos.off;
    let last = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (rem <= n.length) return { node: n, offset: rem, host };
      rem -= n.length;
      last = n;
    }
    return last ? { node: last, offset: last.length, host } : { node: leaf, offset: 0, host };
  }

  selFrom(anchor, focus = anchor) {
    const back = cmp(anchor, focus) > 0;
    return { anchor, focus, start: back ? focus : anchor, end: back ? anchor : focus, collapsed: cmp(anchor, focus) === 0 };
  }

  getSel() {
    const s = window.getSelection();
    if (!s.rangeCount || !s.anchorNode || !this.root.contains(s.anchorNode) || !this.root.contains(s.focusNode)) return null;
    const anchor = this.toPos(s.anchorNode, s.anchorOffset);
    const focus = this.toPos(s.focusNode, s.focusOffset);
    return anchor && focus ? this.selFrom(anchor, focus) : null;
  }

  // The last selection inside the editor, kept so menu commands still work
  // after focus moved to a menu or dialog.
  sel() {
    this.flushIme();
    return this.getSel() || this.lastSel || null;
  }

  setSel(anchor, focus = anchor) {
    // The block must be marked focused first: an island's source is hidden
    // until then, and a caret cannot sit inside display:none text. Same for
    // markers around the target.
    this.setFocusBlock(focus.i);
    this.updateExpand(this.selFrom(anchor, focus));
    const a = this.toDom(anchor);
    const f = this.toDom(focus);
    // Table cells are separate editing hosts: focus must follow the caret.
    if (document.activeElement !== a.host) a.host.focus({ preventScroll: true });
    window.getSelection().setBaseAndExtent(a.node, a.offset, f.node, f.offset);
    this.lastSel = this.selFrom(anchor, focus);
  }

  domInLeaf() {
    const s = window.getSelection();
    const ok = (n) => !!(n && (n.nodeType === 1 ? n : n.parentElement).closest('[data-leaf]'));
    return ok(s.anchorNode) && ok(s.focusNode);
  }

  // --- rendering ----------------------------------------------------------

  leafHtml(b, leaf = 0) {
    if (b.type === 'code') return highlight(b.text, b.lang);
    // Formula and HTML sources are coloured as TeX and HTML.
    if (b.type === 'math' && b.text) return highlight(b.text, 'latex');
    if (b.type === 'html' && b.text) return highlight(b.text, 'xml');
    if (RAW.has(b.type)) return esc(b.text) + (b.text === '' || b.text.endsWith('\n') ? '<br>' : '');
    if (b.type === 'def') return renderDef(b.text);
    return renderInline(leafText(b, leaf));
  }

  setLeafHtml(leaf, html) {
    leaf.innerHTML = html;
    hydrate(leaf);
  }

  renderBlock(b) {
    const make = (tag, cls) => {
      const el = document.createElement(tag);
      el.className = `b ${cls}`;
      el.dataset.id = b.id;
      el._b = b;
      if (b.q) {
        el.dataset.q = b.q;
        el.style.setProperty('--q', b.q);
      }
      if (b.indent) {
        el.dataset.indent = b.indent;
        el.style.setProperty('--indent', b.indent);
      }
      return el;
    };
    let el;
    switch (b.type) {
      case 'h':
        el = make(`h${b.level}`, 'h');
        el.dataset.level = b.level;
        el.id = `h-${(this.headingIdMap?.get(b)) ?? slugify(b.text)}`;
        break;
      case 'li':
        el = make('div', 'li');
        el.dataset.kind = b.kind;
        if (b.kind === 'task') el.dataset.checked = b.checked ? '1' : '0';
        break;
      case 'def':
        el = make('div', 'def');
        break;
      case 'meta':
        el = make('pre', 'meta');
        el.spellcheck = false;
        break;
      case 'hr':
        el = make('div', 'hr');
        el.contentEditable = 'false';
        el.appendChild(document.createElement('hr'));
        return el;
      case 'toc':
        el = make('div', 'toc');
        el.contentEditable = 'false';
        this.fillToc(el);
        return el;
      case 'code':
        return this.renderCode(b, make('pre', 'code'));
      case 'math':
      case 'html':
        return this.renderIsland(b, make('div', `${b.type} island`));
      case 'table':
        return this.renderTable(b, make('figure', 'table'));
      default:
        // A heading being edited as its Markdown line keeps the heading's look.
        el = b.srcHeading ? make(`h${Math.min(6, /^#{1,6}/.exec(b.text)?.[0].length || 1)}`, 'p src-heading') : make('p', 'p');
        if (b.q && isAlert(b.text)) el.classList.add('alert-label');
    }
    el.dataset.leaf = '';
    this.setLeafHtml(el, this.leafHtml(b));
    return el;
  }

  renderIsland(b, el) {
    const src = document.createElement('pre');
    src.className = 'src';
    src.dataset.leaf = '';
    src.spellcheck = false;
    src.innerHTML = this.leafHtml(b);
    const view = document.createElement('div');
    view.className = 'preview';
    view.contentEditable = 'false';
    el.append(src, view);
    // HTML and math blocks carry a small bar (shown on hover and while editing) with
    // their kind and an Edit / Finish Editing button.
    if (b.type === 'html' || b.type === 'math') {
      const tip = document.createElement('div');
      tip.className = 'raw-tip';
      tip.contentEditable = 'false';
      const name = document.createElement('span');
      name.className = 'raw-tip-name';
      name.textContent = b.type === 'html' ? 'HTML' : 'Math';
      const editBtn = document.createElement('span');
      editBtn.className = 'raw-tip-btn raw-tip-edit';
      editBtn.title = this.hooks.labels?.edit || 'Edit';
      const done = document.createElement('span');
      done.className = 'raw-tip-btn raw-tip-done';
      done.title = this.hooks.labels?.finishEditing || 'Finish Editing';
      tip.append(name, editBtn, done);
      el.append(tip);
    }
    this.updatePreview(el, b);
    return el;
  }

  renderCode(b, el) {
    const code = document.createElement('code');
    code.dataset.leaf = '';
    code.spellcheck = !!this.opts.spellcheckCode;
    code.innerHTML = this.leafHtml(b);
    el.appendChild(code);
    // Numbered when the setting says so, or when the fence asks ({.numberLines}).
    const numbered = (this.opts.lineNumbers || fenceNumbering(b.lang) != null) && !isDiagram(b);
    el.classList.toggle('nowrap', !this.opts.codeWrap || numbered);
    if (numbered) {
      const gutter = document.createElement('span');
      gutter.className = 'gutter';
      gutter.contentEditable = 'false';
      gutter.setAttribute('aria-hidden', 'true');
      el.classList.add('lineno');
      el.appendChild(gutter);
    }
    const wrap = document.createElement('span');
    wrap.className = 'cmp lang-wrap';
    wrap.contentEditable = 'false';
    const lang = document.createElement('input');
    lang.className = 'lang';
    lang.value = b.lang || '';
    lang.placeholder = t('选择语言');
    lang.spellcheck = false;
    lang.setAttribute('list', 'lang-list');
    lang.setAttribute('aria-label', t('代码语言'));
    lang.addEventListener('input', () => {
      const i = this.doc.findIndex((x) => x.id === el.dataset.id);
      if (i < 0) return;
      const was = isDiagram(this.doc[i]);
      const nb = { ...this.doc[i], lang: lang.value.trim() };
      this.lastCodeLang = nb.lang;
      this.doc = splice(this.doc, i, 1, [nb]);
      el._b = nb;
      if (was !== isDiagram(nb)) {
        // Switching to or from a diagram changes the block's structure.
        el._b = null;
        this.render();
        const fresh = this.root.children[i].querySelector('.lang');
        fresh?.focus();
        fresh?.setSelectionRange(fresh.value.length, fresh.value.length);
      } else {
        code.innerHTML = this.leafHtml(nb);
        this.updatePreview(el, nb);
      }
      this.record('type');
      this.changed();
    });
    lang.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Backspace at its start (or when empty) goes back into the code; Delete at its
      // end goes on to the block after the code block.
      const atStart = lang.selectionStart === 0 && lang.selectionEnd === 0;
      const atEnd = lang.selectionStart === lang.value.length && lang.selectionEnd === lang.value.length;
      const back = e.key === 'Backspace' && atStart;
      const forward = e.key === 'Delete' && atEnd;
      if (e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'ArrowUp' && !back && !forward) return;
      e.preventDefault();
      const i = this.doc.findIndex((x) => x.id === el.dataset.id);
      if (i < 0) return;
      if (forward) {
        const doc = i + 1 < this.doc.length ? this.doc : [...this.doc, P()];
        if (doc === this.doc) this.setSel(startOf(doc, i + 1));
        else this.apply(doc, startOf(doc, i + 1));
      } else this.setSel(e.key === 'Enter' ? startOf(this.doc, i) : endOf(this.doc, i));
    });
    wrap.appendChild(lang);
    el.appendChild(wrap);
    if (isDiagram(b)) {
      el.classList.add('island', 'diagram');
      const view = document.createElement('div');
      view.className = 'preview';
      view.contentEditable = 'false';
      el.appendChild(view);
    }
    this.updatePreview(el, b);
    return el;
  }

  // Keeps everything derived from a raw block's text in step with it.
  updatePreview(el, b) {
    const view = el.querySelector(':scope > .preview');
    if (b.type === 'math') {
      // An empty math block shows a placeholder formula, as in Typora.
      renderMathInto(view, b.text.trim() ? b.text : '<Empty \\space Math \\space Block>', true);
      el.querySelector(':scope > .src')?.setAttribute('data-placeholder', this.hooks.labels?.mathPlaceholder || 'Input Math TeX here');
      el.classList.toggle('empty', !b.text.trim());
      el.toggleAttribute('data-ams', hasNumberedEnv(b.text));
    }
    else if (b.type === 'html') {
      view.innerHTML = b.text.trim() ? sanitizeHtml(b.text) : `<span class="hint">${t('空的 HTML 块')}</span>`;
      watchHtmlMedia(view);
    }
    else if (b.type === 'code') {
      const gutter = el.querySelector(':scope > .gutter');
      const first = fenceNumbering(b.lang) ?? 1;
      if (gutter) gutter.textContent = b.text.split('\n').map((_, n) => n + first).join('\n');
      if (view) {
        clearTimeout(this.diagramTimers.get(b.id));
        const draw = () => (isMathFence(b) ? renderMathInto(view, b.text, true) : renderDiagram(view, b.text, b.lang).then(() => this.markDiagramError(el, view, b)));
        // First paint is immediate; while typing, wait for a pause.
        if (!view.firstChild) draw();
        else this.diagramTimers.set(b.id, setTimeout(draw, 350));
      }
    }
  }

  // The source line a diagram's parser complained about gets a tinted band (Mermaid
  // counts lines from the first line inside the fence).
  markDiagramError(el, view, b) {
    const src = el.querySelector(':scope > .src, :scope > pre, :scope > code');
    if (!src) return;
    const line = Number(view.dataset.errorLine);
    if (!line || (b.lang && !/^mermaid$/i.test(langName(b.lang)))) {
      src.classList.remove('error-line');
      src.style.removeProperty('background-position');
      return;
    }
    const cs = getComputedStyle(src);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    src.classList.add('error-line');
    src.style.backgroundSize = `100% ${lh}px`;
    src.style.backgroundPosition = `0 ${(parseFloat(cs.paddingTop) || 0) + (line - 1) * lh}px`;
  }

  renderTable(b, el) {
    el.contentEditable = 'false';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    b.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      row.forEach((cell, c) => {
        const td = document.createElement(r ? 'td' : 'th');
        td.dataset.leaf = '';
        td.contentEditable = 'true';
        this.setLeafHtml(td, renderInline(cell));
        if (b.align?.[c]) td.style.textAlign = b.align[c];
        tr.appendChild(td);
      });
      (r ? tbody : thead).appendChild(tr);
    });
    table.append(thead, tbody);
    const tools = document.createElement('div');
    tools.className = 'cmp table-tools';
    const btn = (act, label, title) => `<button type="button" data-act="${act}" title="${t(title)}" aria-label="${t(title)}">${label}</button>`;
    // Alignment on the left, structure in the middle, delete at the far end.
    tools.innerHTML = [
      btn('alignLeft', '⇤', '左对齐'), btn('alignCenter', '↔', '居中'), btn('alignRight', '⇥', '右对齐'), '<i></i>',
      btn('resize', '⊞', '调整表格大小'), '<i></i>',
      btn('rowBelow', t('＋行'), '在下方插入行'), btn('colAfter', t('＋列'), '在右侧插入列'), btn('rowDelete', t('－行'), '删除当前行'), btn('colDelete', t('－列'), '删除当前列'),
      '<i class="gap"></i>', btn('tableDelete', t('删除'), '删除表格'),
    ].join('');
    // The scroll container is inside the figure so that the quote bar drawn
    // beside the figure is not clipped.
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.appendChild(table);
    // Grips for dragging the row or column under the pointer to another place.
    const rowGrip = document.createElement('div');
    rowGrip.className = 'cmp table-grip row-grip';
    rowGrip.title = t('拖动以移动行');
    const colGrip = document.createElement('div');
    colGrip.className = 'cmp table-grip col-grip';
    colGrip.title = t('拖动以移动列');
    el.append(tools, scroll, rowGrip, colGrip);
    this.installTableGrips(el, table, rowGrip, colGrip);
    return el;
  }

  installTableGrips(el, table, rowGrip, colGrip) {
    let hover = null;
    const place = (cell) => {
      const box = el.getBoundingClientRect();
      const tr = cell.parentElement;
      const r = tr.getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      Object.assign(rowGrip.style, { top: `${r.top - box.top}px`, height: `${r.height}px`, display: 'block' });
      Object.assign(colGrip.style, { left: `${c.left - box.left}px`, width: `${c.width}px`, display: 'block' });
      hover = { row: [...table.rows].indexOf(tr), col: cell.cellIndex };
    };
    table.addEventListener('mouseover', (e) => {
      const cell = e.target.closest?.('td, th');
      if (cell && !this.readOnly && !this.dragGrip) place(cell);
    });
    el.addEventListener('mouseleave', () => {
      if (this.dragGrip) return;
      rowGrip.style.display = 'none';
      colGrip.style.display = 'none';
    });
    const drag = (kind) => (e) => {
      if (e.button !== 0 || !hover) return;
      e.preventDefault();
      const from = kind === 'row' ? hover.row : hover.col;
      let to = from;
      this.dragGrip = kind;
      el.classList.add(`dragging-${kind}`);
      const move = (m) => {
        if (kind === 'row') {
          const rows = [...table.rows];
          to = rows.findIndex((tr) => m.clientY < tr.getBoundingClientRect().bottom);
          if (to < 0) to = rows.length - 1;
          rows.forEach((tr, k) => tr.classList.toggle('drop-target', k === to && k !== from));
        } else {
          const cells = [...table.rows[0].cells];
          to = cells.findIndex((td) => m.clientX < td.getBoundingClientRect().right);
          if (to < 0) to = cells.length - 1;
          for (const tr of table.rows) [...tr.cells].forEach((td, k) => td.classList.toggle('drop-target', k === to && k !== from));
        }
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        this.dragGrip = null;
        el.classList.remove(`dragging-${kind}`);
        for (const x of table.querySelectorAll('.drop-target')) x.classList.remove('drop-target');
        const i = this.indexOfEl(el);
        if (i >= 0 && to !== from) this.moveTablePart(i, kind, from, to);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    };
    rowGrip.addEventListener('pointerdown', drag('row'));
    colGrip.addEventListener('pointerdown', drag('col'));
  }

  // One undo step: a row (the header included) or a column (with its alignment) moved.
  moveTablePart(i, kind, from, to) {
    const b = this.doc[i];
    const shift = (arr) => {
      const out = arr.slice();
      const [x] = out.splice(from, 1);
      out.splice(to, 0, x);
      return out;
    };
    const nb = kind === 'row' ? { ...b, rows: shift(b.rows) } : { ...b, rows: b.rows.map(shift), align: shift(b.align || b.rows[0].map(() => '')) };
    const n = cols(nb);
    const leaf = kind === 'row' ? to * n : to;
    this.apply(splice(this.doc, i, 1, [nb]), { i, leaf, off: 0 });
  }

  fillToc(el) {
    const heads = this.doc.filter((b) => b.type === 'h');
    el.innerHTML = heads.length
      ? heads.map((h) => `<a class="toc-item l${h.level}" data-id="${h.id}">${headingHtml(h.text) || '&nbsp;'}</a>`).join('')
      : `<span class="hint">${t('目录：文档里还没有标题')}</span>`;
    hydrate(el);
    // On hover: what the block is, with a way to delete it.
    const tip = document.createElement('span');
    tip.className = 'cmp toc-tip';
    tip.contentEditable = 'false';
    tip.innerHTML = `<span>[TOC]</span><button type="button" class="toc-delete" title="${t('删除')}" aria-label="${t('删除')}">✕</button>`;
    tip.querySelector('button').addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const i = this.indexOfEl(el);
      if (i < 0) return;
      const doc = normalize(splice(this.doc, i, 1));
      this.apply(doc, startOf(doc, Math.min(i, doc.length - 1)));
    });
    el.append(tip);
  }

  refreshToc() {
    for (const el of this.root.querySelectorAll(':scope > .toc')) this.fillToc(el);
  }

  // Link reference definitions feed [text][id] links elsewhere in the doc.
  rebuildRefs() {
    const refs = new Map();
    for (const b of this.doc) {
      if (b.type !== 'def') continue;
      const d = parseDef(b.text);
      if (d && !refs.has(d.label)) refs.set(d.label, d);
    }
    const sig = JSON.stringify([...refs]);
    const changed = sig !== this.refSig;
    this.refSig = sig;
    inlineCtx.refs = refs;
    return changed;
  }

  // Reconcile the DOM with this.doc, keyed by block id. A block whose model
  // object is unchanged keeps its element untouched.
  render() {
    // Heading anchors depend on the whole document (repeats get -1, -2…): set them on
    // every heading once this render is done, reused elements included.
    this.headingIdMap = headingIds(this.doc);
    queueMicrotask(() => {
      for (const [b, id] of this.headingIdMap) {
        const el = this.root.children[this.doc.indexOf(b)];
        if (el && el.id !== `h-${id}`) el.id = `h-${id}`;
      }
    });
    const refsChanged = this.rebuildRefs();
    const nums = numberLists(this.doc);
    const old = new Map();
    for (const node of [...this.root.childNodes]) {
      if (node.nodeType === 1 && node.dataset.id) old.set(node.dataset.id, node);
      else node.remove();
    }
    const used = new Set();
    let ref = this.root.firstElementChild;
    let alert = null;
    this.doc.forEach((b, k) => {
      let el = old.get(b.id);
      const stale = refsChanged && TEXTY.has(b.type) && b.text.includes('[');
      if (!el || el._b !== b || stale) {
        if (el) {
          if (ref === el) ref = el.nextElementSibling;
          el.remove();
        }
        el = this.renderBlock(b);
      }
      if (b.type === 'li') el.dataset.n = nums[k];
      // An alert label colours the whole quote run that follows it.
      if (!b.q || (alert && b.q < alert.q)) alert = null;
      if (b.q && b.type === 'p' && isAlert(b.text)) alert = { q: b.q, kind: ALERT.exec(b.text)[1].toLowerCase() };
      if (alert) el.dataset.alert = alert.kind;
      else delete el.dataset.alert;
      if (el !== ref) this.root.insertBefore(el, ref);
      else ref = ref.nextElementSibling;
      used.add(el);
    });
    for (const el of [...this.root.children]) if (!used.has(el)) el.remove();
    this.refreshToc();
    this.refreshFootnoteBacklinks();
  }

  // A footnote definition ends with one ↩ per reference to it; each jumps back to its
  // reference (Typora's "back to document"). The arrows are drawn by CSS, so the line's
  // text stays its Markdown source.
  refreshFootnoteBacklinks() {
    const counts = new Map();
    for (const v of this.root.querySelectorAll('.tok[data-t="fnref"] > .fn-view')) {
      const key = String(v.dataset.label).toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    this.doc.forEach((b, k) => {
      if (b.type !== 'def' || !b.text.startsWith('[^')) return;
      const el = this.root.children[k];
      if (!el) return;
      const label = /^\[\^([^\]]+)\]:/.exec(b.text)?.[1] || '';
      const n = counts.get(label.toLowerCase()) || 0;
      let area = el.querySelector(':scope > .fn-back-area');
      if (!n) return area?.remove();
      if (area && area.childElementCount === n) return;
      area?.remove();
      area = document.createElement('span');
      area.className = 'fn-back-area';
      area.contentEditable = 'false';
      for (let j = 0; j < n; j++) {
        const a = document.createElement('a');
        a.className = 'fn-back';
        a.title = this.hooks.labels?.backToDocument || 'back to document';
        a.dataset.label = label;
        a.dataset.index = j;
        area.append(a);
      }
      el.append(area);
    });
  }

  jumpToFootnoteRef(label, index) {
    const refs = [...this.root.querySelectorAll('.tok[data-t="fnref"] > .fn-view')].filter((v) => String(v.dataset.label).toLowerCase() === label.toLowerCase());
    const tok = refs[index]?.parentElement;
    const leaf = tok?.closest('[data-leaf]');
    const pos = leaf && this.toPos(leaf, 0);
    const span = leaf && tokenSpans(leaf).find(([el]) => el === tok);
    if (pos && span) {
      this.setSel({ ...pos, off: span[1] });
      this.revealCaret();
    }
  }

  // Re-style a single leaf from its model text. Skips the DOM write entirely
  // when the browser's own edit already produced the right markup, which is
  // the common case while typing plain text.
  brush(i, leafIdx) {
    const b = this.doc[i];
    const bel = this.root.children[i];
    const leaf = bel && leavesOf(bel)[leafIdx];
    if (!leaf) return false;
    const html = this.leafHtml(b, leafIdx);
    this.tpl.innerHTML = html;
    if (this.tpl.innerHTML === leaf.innerHTML.replace(RUNTIME_ATTRS, '').replace(/<span class="fn-back-area"[^]*$/, '')) return false;
    const sel = this.getSel();
    this.setLeafHtml(leaf, html);
    if (b.type === 'def') this.refreshFootnoteBacklinks();
    if (sel && (sel.anchor.i === i || sel.focus.i === i)) this.setSel(sel.anchor, sel.focus);
    return true;
  }

  // Show the Markdown markers of every token the selection touches.
  updateExpand(sel) {
    const want = new Set();
    const add = (pos, from, to) => {
      const b = this.doc[pos.i];
      const bel = this.root.children[pos.i];
      const leaf = bel && b && !RAW.has(b.type) && leavesOf(bel)[pos.leaf];
      if (!leaf) return;
      for (const [el, a, z] of tokenSpans(leaf)) if (a <= to && z >= from) want.add(el);
    };
    if (sel) {
      if (sameLeaf(sel.start, sel.end)) add(sel.start, sel.start.off, sel.end.off);
      else {
        add(sel.start, sel.start.off, Infinity);
        add(sel.end, 0, sel.end.off);
      }
    }
    // An open token shows the markers of everything nested in it as well.
    for (const el of [...want]) for (const inner of el.querySelectorAll('.tok')) want.add(inner);
    for (const el of this.root.querySelectorAll('[data-open]')) if (!want.has(el)) el.removeAttribute('data-open');
    for (const el of want) if (!el.hasAttribute('data-open')) el.setAttribute('data-open', '');
  }

  setFocusBlock(i) {
    const el = this.root.children[i];
    if (el === this.focusEl) return;
    this.focusEl?.classList.remove('focus');
    el?.classList.add('focus');
    this.focusEl = el;
  }

  onImageState(e, failed) {
    if (e.target.tagName !== 'IMG') return;
    const token = e.target.closest('.tok');
    if (!token) return;
    // Hovering a picture that did not load says so.
    if (failed) {
      token.setAttribute('data-err', '');
      e.target.title = this.hooks.labels?.imageFailed || 'Image load failed';
    } else {
      token.removeAttribute('data-err');
      if (e.target.title === (this.hooks.labels?.imageFailed || 'Image load failed') || e.target.title === (this.hooks.labels?.imageLoading || 'Image is loading…')) e.target.removeAttribute('title');
      this.hooks.onImageLoaded?.(e.target);
    }
  }

  // --- change bookkeeping -------------------------------------------------

  apply(doc, sel, kind = 'edit') {
    if (this.readOnly) return;
    // Where the selection was before this edit: undo puts it back there.
    if (!this.preSel) this.preSel = this.lastSel;
    this.doc = normalize(doc);
    this.render();
    if (sel) {
      this.setSel(sel.anchor || sel, sel.focus || sel.anchor || sel);
      this.revealCaret();
    }
    this.record(kind);
    this.changed();
  }

  changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.updateMathLabels();
      this.hooks.onChange?.(this.doc);
    }, 120);
  }

  // The number each \label{} in a math block stands for, as the page numbers the
  // equations (all display math, or the AMS environments only, or \tag). Math that
  // refers to a label is drawn again when the numbers move.
  updateMathLabels() {
    const mode = document.body.classList.contains('math-numbering') ? 'all' : document.body.classList.contains('math-ams') ? 'ams' : 'none';
    const labels = new Map();
    let n = 0;
    for (const b of this.doc) {
      if (b.type !== 'math') continue;
      const numbered = mode === 'all' || (mode === 'ams' && hasNumberedEnv(b.text));
      const tag = /\\tag\*?\{([^}]*)\}/.exec(b.text);
      if (numbered && !tag) n++;
      for (const m of b.text.matchAll(/\\label\{([^}]*)\}/g)) labels.set(m[1].trim(), tag ? tag[1] : numbered ? n : '??');
    }
    const key = JSON.stringify([...labels]);
    if (key === this.labelKey) return;
    this.labelKey = key;
    mathRefs.labels = labels;
    let inline = false;
    this.doc.forEach((b, i) => {
      if (b.type === 'math' && hasMathRefs(b.text)) {
        const el = this.root.children[i];
        if (el) this.updatePreview(el, b);
      } else if (TEXTY.has(b.type) && hasMathRefs(b.text)) inline = true;
    });
    if (inline) this.rerenderAll();
  }

  // Snapshots are cheap: blocks are immutable, so a snapshot is just the
  // array. Typing ('type') and deleting ('del') in one block collapse into
  // one undo step for up to three seconds from the first keystroke; anything
  // else, a move to another block, or `fresh` starts a new step. Each step
  // remembers where the selection was before it, which is where undo puts it.
  record(kind, fresh = false, at = null) {
    const s = at ? { anchor: at, focus: at } : this.getSel();
    const now = Date.now();
    const pre = this.preSel || this.lastSel;
    this.preSel = null;
    const state = { doc: this.doc, sel: s && { anchor: s.anchor, focus: s.focus }, before: pre && { anchor: pre.anchor, focus: pre.focus }, kind, t0: now, id: s && this.doc[s.focus.i]?.id };
    const top = this.history[this.hIndex];
    const atTip = this.hIndex === this.history.length - 1;
    const open = !fresh && !this.groupClosed && atTip && top;
    this.groupClosed = false;
    if ((kind === 'type' || kind === 'del') && open && top.kind === kind && top.id === state.id && now - top.t0 < 3000) {
      state.t0 = top.t0;
      state.before = top.before;
      this.history[this.hIndex] = state;
      return;
    }
    this.history.length = this.hIndex + 1;
    this.history.push(state);
    if (this.history.length > 400) this.history.shift();
    this.hIndex = this.history.length - 1;
  }

  undo() {
    if (this.hIndex <= 0) return;
    const undone = this.history[this.hIndex];
    this.restore(--this.hIndex, undone.before);
    undone.effect?.undo?.();
  }

  redo() {
    if (this.hIndex >= this.history.length - 1) return;
    this.restore(++this.hIndex);
    this.history[this.hIndex].effect?.redo?.();
  }

  // Something outside the text that the last change did (a picture file deleted or
  // moved): undo and redo of that change do it back and again.
  attachEffect(effect) {
    const top = this.history[this.hIndex];
    if (top) top.effect = effect;
  }

  restore(index, at) {
    const st = this.history[index];
    this.doc = st.doc;
    this.render();
    const sel = at || st.sel;
    this.groupClosed = true;
    this.preSel = null;
    if (sel) {
      this.setSel(sel.anchor, sel.focus);
      this.lastSel = this.getSel() || this.lastSel;
      this.revealCaret();
    }
    this.changed();
  }

  // --- native input path --------------------------------------------------

  inComponent(target) {
    return !!target.closest?.('.cmp');
  }

  onBeforeInput(e) {
    if (this.inComponent(e.target)) return;
    const t = e.inputType;
    if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault();
      if (t === 'historyUndo') this.undo();
      else this.redo();
      return;
    }
    // Input method composition. WebKit and Chrome disagree on the order of
    // compositionstart and the first composition beforeinput, and WebKit
    // commits with its own deleteCompositionText / insertFromComposition
    // pair, so every composition input type is recognised here.
    if (/omposition/.test(t)) {
      if (t === 'insertCompositionText') this.beginComposition();
      return;
    }
    if (this.composing) return;
    // The previous composition's text may not be in the model yet (it is
    // written a tick after the composition ends). Anything that edits must
    // see it first.
    this.flushIme();
    this.preSel = this.getSel();
    if (t === 'formatBold' || t === 'formatItalic' || t === 'formatUnderline') {
      e.preventDefault();
      if (t === 'formatBold') this.toggleInline('**');
      else if (t === 'formatItalic') this.toggleInline('*');
      else this.toggleInline('<u>', '</u>');
      return;
    }
    // Paste and cut have their own handlers; drag and rich formatting are off.
    if (t.startsWith('format') || /^(insertFromPaste|insertFromDrop|insertFromYank|deleteByDrag|deleteByCut)$/.test(t)) {
      e.preventDefault();
      return;
    }

    const sel = this.getSel();
    if (!sel) {
      e.preventDefault();
      return;
    }
    // Typing or deleting over a selection is an undo step of its own.
    if (!sel.collapsed) this.groupClosed = true;
    if (t === 'insertParagraph') {
      e.preventDefault();
      this.enter(sel);
      return;
    }
    if (t === 'insertLineBreak') {
      e.preventDefault();
      const lb = this.doc[sel.start.i];
      // A second line break in a row (next to an existing one) is a paragraph break.
      if (lb.type === 'p' && sel.collapsed && (lb.text[sel.start.off] === '\n' || lb.text[sel.start.off - 1] === '\n')) {
        const at = lb.text[sel.start.off - 1] === '\n' ? sel.start.off - 1 : sel.start.off;
        const nb = { ...lb, text: lb.text.slice(0, at) + lb.text.slice(at + 1) };
        return this.enter({ start: { ...sel.start, off: at }, end: { ...sel.start, off: at }, anchor: { ...sel.start, off: at }, focus: { ...sel.start, off: at }, collapsed: true }, nb);
      }
      if (lb.type !== 'table') this.insertText('\n', sel);
      else this.insertText('<br>', sel);
      return;
    }

    const isDelete = t.startsWith('delete');
    if (!sameLeaf(sel.start, sel.end)) {
      e.preventDefault();
      if (isDelete) this.deleteRange(sel);
      else if (e.data != null) this.insertText(e.data, sel);
      return;
    }
    const b = this.doc[sel.start.i];
    const text = leafText(b, sel.start.leaf);
    if (sel.collapsed) {
      if (BACKWARD.has(t) && sel.start.off === 0) {
        e.preventDefault();
        this.backspaceAtStart(sel.start);
        return;
      }
      if (FORWARD.has(t) && sel.start.off === text.length) {
        e.preventDefault();
        this.deleteAtEnd(sel.start);
        return;
      }
      // Backspace inside an empty pair removes both halves.
      const o = sel.start.off;
      if (t === 'deleteContentBackward' && this.opts.autoPair && OPEN[text[o - 1]] && OPEN[text[o - 1]] === text[o]) {
        e.preventDefault();
        const nb = withLeaf(b, sel.start.leaf, text.slice(0, o - 1) + text.slice(o + 1));
        this.apply(splice(this.doc, sel.start.i, 1, [nb]), { ...sel.start, off: o - 1 }, 'pair');
        return;
      }
      // An empty Markdown pair (**|**, `|`, $$|$$…) made by auto-pairing goes as a whole.
      if (t === 'deleteContentBackward' && this.opts.autoPair && this.opts.autoPairMd && !RAW.has(b.type) && MD_PAIRS.has(text[o - 1])) {
        const ch = text[o - 1];
        let n = 1;
        while (n < 3 && text[o - 1 - n] === ch) n++;
        if (text.slice(o, o + n) === ch.repeat(n) && text[o + n] !== ch && text[o - 1 - n] !== ch) {
          e.preventDefault();
          const nb = withLeaf(b, sel.start.leaf, text.slice(0, o - n) + text.slice(o + n));
          this.apply(splice(this.doc, sel.start.i, 1, [nb]), { ...sel.start, off: o - n }, 'pair');
          return;
        }
      }
    }
    if (t === 'insertText' && e.data && e.data.length === 1 && this.typedChar(e.data, sel, b, text)) {
      e.preventDefault();
      return;
    }
    // The caret can end up directly in the root (next to a rule or table).
    // Native editing there would write outside any block, so do it by model.
    if (!this.domInLeaf()) {
      e.preventDefault();
      if (!isDelete && e.data != null) this.insertText(e.data, sel);
      else if (isDelete && !sel.collapsed) this.deleteRange(sel);
    }
    // Otherwise: let the browser edit, then catch up in onInput.
  }

  // Auto-pairing and smart punctuation. Returns true when the keystroke was
  // handled here instead of natively.
  typedChar(ch, sel, b, text) {
    const s = sel.start.off;
    const e = sel.end.off;
    const put = (insert, caretFrom, caretTo = caretFrom) => {
      const nb = withLeaf(b, sel.start.leaf, text.slice(0, s) + insert + text.slice(e));
      this.apply(splice(this.doc, sel.start.i, 1, [nb]), { anchor: { ...sel.start, off: s + caretFrom }, focus: { ...sel.start, off: s + caretTo } }, 'pair');
      return true;
    };
    const prose = !RAW.has(b.type);

    // HTML tags: "</" closes the innermost open tag (in text and in HTML code blocks);
    // in an HTML code block ">" ending an opening tag adds its closing tag.
    if (sel.collapsed && (prose || isHtmlFence(b) || b.type === 'html') && ch === '/' && text[s - 1] === '<' && this.opts.autoPair !== false) {
      const open = openTagAt(text.slice(0, s - 1));
      if (open && !text.slice(s).startsWith(`${open}>`)) return put(`/${open}>`, open.length + 2);
    }
    if (sel.collapsed && isHtmlFence(b) && ch === '>' && this.opts.autoPair !== false && text[s - 1] !== '/') {
      const m = /<([a-zA-Z][\w:-]*)(?:\s[^<>]*)?$/.exec(text.slice(0, s));
      if (m && !VOID_TAGS.has(m[1].toLowerCase()) && !/^<\//.test(text.slice(s))) return put(`></${m[1]}>`, 1);
    }

    if (this.opts.autoPair) {
      // Nothing pairs after a backslash (it escapes the character).
      const escaped = text[s - 1] === '\\' && sel.collapsed;
      const mdPair = prose && this.opts.autoPairMd && MD_PAIRS.has(ch) && !escaped;
      const close = escaped && (MD_PAIRS.has(ch) || inlineCtx.mathLegacy) ? null : OPEN[ch] || (mdPair ? ch : null);
      // With smart quotes on, the pair made for " and ' is the curly one.
      const smartQ = this.opts.smartQuotes && prose && (ch === '"' || ch === "'") && !this.inInlineCode(text, s);
      const q = this.opts.quotes || ['“', '”', '‘', '’'];
      const [qo, qc] = ch === '"' ? [q[0], q[1]] : [q[2], q[3]];
      if (smartQ && !sel.collapsed) return put(qo + text.slice(s, e) + qc, 1, 1 + e - s);
      if (smartQ && text[s] === qc && text.slice(0, s).split(qo).length > text.slice(0, s).split(qc).length) {
        this.setSel({ ...sel.start, off: s + 1 });
        return true;
      }
      if (close && !sel.collapsed) return put(ch + text.slice(s, e) + close, 1, 1 + e - s);
      if (sel.collapsed) {
        // Typing a closer that is already there just steps over it.
        if (CLOSERS.has(ch) && text[s] === ch && (ch !== OPEN[ch] || text[s - 1] !== undefined)) {
          const opens = [...text.slice(0, s)].filter((c) => OPEN[c] === ch).length;
          if (opens > 0) {
            this.setSel({ ...sel.start, off: s + 1 });
            return true;
          }
        }
        if (close) {
          const next = text[s];
          const prev = text[s - 1];
          const roomAfter = next === undefined || /[\s)\]}>,.;:!?，。；：！？）】」』》”’]/.test(next);
          const quote = ch === close;
          const wordBefore = prev !== undefined && /[\p{L}\p{N}]/u.test(prev);
          // With a Ukrainian keyboard the apostrophe is a letter: no pair at the start of an empty paragraph.
          const letterApostrophe = ch === "'" && text === '' && /ukrain/i.test(this.opts.keyboardLayout || '');
          if (roomAfter && !(quote && wordBefore) && !(ch === "'" && !prose && wordBefore) && !letterApostrophe) return put(smartQ ? qo + qc : ch + close, 1);
        }
      }
    }

    if ((this.opts.smartQuotes || this.opts.smartDashes) && prose && sel.collapsed && !this.inInlineCode(text, s) && text[s - 1] !== '\\' && !this.inRawToken(sel.start)) {
      const prev = text[s - 1];
      // A quote opens after space, brackets, dashes, a slash or an opening marker.
      const openQuote = prev === undefined || /[\s([{“‘—–\-/*_~]/.test(prev);
      const q = this.opts.quotes || ['“', '”', '‘', '’'];
      // Two undo steps, as typed: the plain character, then its replacement (so the
      // first Undo gives back what was typed).
      const twoStep = (back, insert) => {
        put(ch, 1);
        const b2 = this.doc[sel.start.i];
        const t2 = leafText(b2, sel.start.leaf);
        this.groupClosed = true;
        const nb = withLeaf(b2, sel.start.leaf, t2.slice(0, s - back) + insert + t2.slice(s + 1));
        this.apply(splice(this.doc, sel.start.i, 1, [nb]), { ...sel.start, off: s - back + insert.length }, 'smart');
        this.groupClosed = true;
        return true;
      };
      if (this.opts.smartQuotes && ch === '"') return twoStep(0, openQuote ? q[0] : q[1]);
      if (this.opts.smartQuotes && ch === "'") return twoStep(0, openQuote ? q[2] : q[3]);
      if (this.opts.smartDashes && ch === '-' && prev === '-' && text[s - 2] !== '-' && text[s - 2] !== '\\') return twoStep(1, '–');
      if (this.opts.smartDashes && ch === '-' && prev === '–') return twoStep(1, '—');
      if (this.opts.smartDashes && ch === '.' && text.slice(s - 2, s) === '..') return twoStep(2, '…');
    }
    return false;
  }

  // Inside a link's address, an image, a URL, HTML or math: no smart punctuation there.
  inRawToken(pos) {
    const el = leavesOf(this.root.children[pos.i] || this.root)[pos.leaf];
    if (!el) return false;
    return tokenSpans(el).some(([tok, a, z]) => ['url', 'image', 'html', 'math', 'code', 'escape', 'entity'].includes(tok.dataset.t) && pos.off > a && pos.off < z)
      || tokenSpans(el).some(([tok, a, z]) => tok.dataset.t === 'link' && pos.off > a && pos.off < z && leafText(this.doc[pos.i], pos.leaf).slice(a, pos.off).includes(']('));
  }

  inInlineCode(text, off) {
    return (text.slice(0, off).match(/`/g) || []).length % 2 === 1;
  }

  replaceBefore(sel, b, text, n, insert) {
    const s = sel.start.off;
    const nb = withLeaf(b, sel.start.leaf, text.slice(0, s - n) + insert + text.slice(s));
    this.apply(splice(this.doc, sel.start.i, 1, [nb]), { ...sel.start, off: s - n + insert.length }, 'pair');
    return true;
  }

  // --- input method composition -------------------------------------------
  // While the user composes (pinyin, kana…), the browser owns the DOM around
  // the caret and nothing here touches it: any re-render would cancel the
  // composition. The model is not updated either. When the composition ends
  // the committed string is written into the model at the position recorded
  // when it began, and the block is rebuilt from the model, whatever shape
  // the browser's own commit left the DOM in.

  beginComposition() {
    if (this.composing) return;
    this.flushIme();
    this.composing = true;
    // compositionstart (and the first composition beforeinput) fire before
    // the browser changes anything, so the selection here is exactly what
    // the composed text will replace.
    const sel = this.getSel();
    this.imeSel = sel ? { start: sel.start, end: sel.end } : null;
  }

  endComposition(data) {
    if (!this.composing) return;
    this.composing = false;
    this.pendingIme = { sel: this.imeSel, data };
    this.imeSel = null;
    // Let the browser finish its own commit first.
    this.imeTimer = setTimeout(() => this.flushIme(), 0);
  }

  flushIme() {
    const job = this.pendingIme;
    if (!job) return;
    this.pendingIme = null;
    clearTimeout(this.imeTimer);
    const { sel, data } = job;
    const b = sel && this.doc[sel.start.i];
    if (!b || sel.start.leaf >= leafCount(b)) {
      // No usable position: fall back to what the page shows now.
      if (this.structureIntact()) this.afterNative('insertText');
      else this.rerenderAll();
      return;
    }
    // Rebuild every block the composition could have touched, even where the
    // model is unchanged: the browser may have restructured them.
    const near = new Set();
    for (let k = sel.start.i - 1; k <= sel.end.i + 1; k++) if (this.doc[k]) near.add(this.doc[k].id);
    for (const el of this.root.children) if (near.has(el.dataset.id)) el._b = null;
    // A selection spanning blocks was replaced by the composed text.
    let pos = sel.start;
    if (!sameLeaf(sel.start, sel.end)) ({ doc: this.doc, pos } = this.deleted(this.selFrom(sel.start, sel.end)));
    const { i, leaf } = pos;
    const block = this.doc[i];
    const cur = leafText(block, leaf);
    const from = Math.min(pos.off, cur.length);
    const to = sameLeaf(sel.start, sel.end) ? Math.min(Math.max(sel.end.off, from), cur.length) : from;
    const caret = from + data.length;
    this.doc = splice(this.doc, i, 1, [withLeaf(block, leaf, cur.slice(0, from) + data + cur.slice(to))]);
    if (data && this.blockShortcut(i, caret, cur)) return;
    this.render();
    this.setSel({ i, leaf, off: caret });
    if (this.typewriter) this.centerCaret();
    this.record('type');
    this.changed();
  }

  onInput(e) {
    if (this.inComponent(e.target) || this.composing || e.isComposing || /omposition/.test(e.inputType || '')) return;
    this.afterNative(e.inputType, e.data);
  }

  structureIntact() {
    const kids = this.root.childNodes;
    if (kids.length !== this.doc.length) return false;
    for (let k = 0; k < kids.length; k++) if (kids[k].nodeType !== 1 || kids[k].dataset.id !== this.doc[k].id) return false;
    return true;
  }

  afterNative(type) {
    if (!this.structureIntact()) {
      // A native edit broke the block structure. The model is the truth.
      this.render();
      return;
    }
    const sel = this.getSel();
    if (!sel) return;
    const { i, leaf } = sel.focus;
    const bel = this.root.children[i];
    const leafEl = leavesOf(bel)[leaf];
    if (!leafEl) return;
    const text = leafEl.textContent;
    const b = this.doc[i];
    if (leafText(b, leaf) === text) return;

    const nb = withLeaf(b, leaf, text);
    this.doc = splice(this.doc, i, 1, [nb]);
    bel._b = nb;
    if (/^insert/.test(type || '') && this.blockShortcut(i, sel.focus.off, b.text)) return;
    this.brush(i, leaf);
    this.afterLeafChange(i, bel, b, nb);
    this.updateExpand(this.getSel());
    if (this.typewriter) this.centerCaret();
    this.record(/^deleteContent/.test(type || '') ? 'del' : /^insert|omposition/.test(type || '') ? 'type' : 'edit');
    this.changed();
  }

  // Side effects of one block's text changing in place.
  afterLeafChange(i, bel, before, nb) {
    if (RAW.has(nb.type)) this.updatePreview(bel, nb);
    if (nb.type === 'h') {
      this.headingIdMap = headingIds(this.doc);
      for (const [b, id] of this.headingIdMap) {
        const el = this.root.children[this.doc.indexOf(b)];
        if (el) el.id = `h-${id}`;
      }
      this.refreshToc();
    }
    if (nb.type === 'def' && this.rebuildRefs()) {
      this.doc.forEach((x, k) => {
        if (k !== i && TEXTY.has(x.type) && x.text.includes('[')) this.brush(k, 0);
      });
    }
    if (nb.type === 'p' && nb.q && isAlert(nb.text) !== isAlert(before.text || '')) {
      bel._b = null;
      const sel = this.getSel();
      this.render();
      if (sel) this.setSel(sel.anchor, sel.focus);
    }
  }

  // "# " -> heading, "- " -> list, "1. " -> numbered list, "> " -> quote,
  // "[ ] " inside a bullet -> task. Fires when an insertion completes the
  // prefix, whether it arrived as one space or as a whole committed string
  // (IME, dictation, autocorrect).
  blockShortcut(i, caret, before) {
    let b = this.doc[i];
    let off = caret;
    let changed = false;
    for (;;) {
      const t = b.text;
      let m;
      let nb = null;
      if (b.type === 'p') {
        if ((m = /^(#{1,6}) /.exec(t))) nb = { ...b, type: 'h', level: m[1].length };
        // The marker the user typed is the one the list is written with (up to three
        // spaces may come before it).
        else if ((m = /^ {0,3}([-*+]) /.exec(t))) nb = { ...b, type: 'li', kind: 'ul', checked: false, mark: m[1] };
        else if ((m = /^ {0,3}(\d{1,9})([.)]) /.exec(t))) nb = { ...b, type: 'li', kind: 'ol', checked: false, delim: m[2], ...(m[1] !== '1' ? { start: Number(m[1]) } : {}) };
        else if ((m = /^ {0,3}>(?: |(?=[^\s>]))/.exec(t)) && t.length > m[0].length) nb = { ...b, q: b.q + 1 };
      } else if (b.type === 'li' && b.kind === 'ul') {
        if ((m = /^\[([ xX]?)\] /.exec(t))) nb = { ...b, kind: 'task', checked: /x/i.test(m[1]) };
      }
      // The prefix must be new, and the caret must be past it. (">" alone is not yet a
      // quote; the character typed after it makes one.)
      const prior = before || '';
      const quoteNow = nb && nb.q > b.q && prior.length <= m[0].length;
      if (!nb || off < m[0].length || (!changed && prior.startsWith(m[0]) && !quoteNow)) break;
      nb.text = t.slice(m[0].length);
      off -= m[0].length;
      b = nb;
      changed = true;
    }
    if (!changed) return false;
    // A heading is part of the typing that produced it. Any other conversion
    // is a step of its own: undo first gives back the typed marker as text.
    const typed = { i, leaf: 0, off: caret };
    if (b.type !== 'h') {
      this.record('type', false, typed);
      this.preSel = { anchor: typed, focus: typed };
    }
    this.apply(splice(this.doc, i, 1, [b]), { i, leaf: 0, off }, b.type === 'h' ? 'type' : 'edit');
    return true;
  }

  // --- model edits --------------------------------------------------------

  // Returns the document with the selected range removed, and where the
  // caret ends up.
  deleted(sel) {
    const { start: s, end: e } = sel;
    const doc = this.doc;
    if (s.i === e.i) {
      let b = doc[s.i];
      if (s.leaf === e.leaf) {
        const t = leafText(b, s.leaf);
        b = withLeaf(b, s.leaf, t.slice(0, s.off) + t.slice(e.off));
      } else {
        b = withLeaf(b, s.leaf, leafText(b, s.leaf).slice(0, s.off));
        for (let l = s.leaf + 1; l < e.leaf; l++) b = withLeaf(b, l, '');
        b = withLeaf(b, e.leaf, leafText(b, e.leaf).slice(e.off));
      }
      return { doc: splice(doc, s.i, 1, [b]), pos: s };
    }
    const A = doc[s.i];
    const B = doc[e.i];
    let merged;
    if (A.type !== 'table' && B.type !== 'table') {
      merged = [{ ...A, text: A.text.slice(0, s.off) + B.text.slice(e.off) }];
    } else {
      let a = withLeaf(A, s.leaf, leafText(A, s.leaf).slice(0, s.off));
      for (let l = s.leaf + 1; l < leafCount(A); l++) a = withLeaf(a, l, '');
      let z = B;
      for (let l = 0; l < e.leaf; l++) z = withLeaf(z, l, '');
      z = withLeaf(z, e.leaf, leafText(B, e.leaf).slice(e.off));
      merged = [a, z];
    }
    return { doc: splice(doc, s.i, e.i - s.i + 1, merged), pos: s };
  }

  deleteRange(sel) {
    const { doc, pos } = this.deleted(sel);
    this.apply(doc, pos);
  }

  insertText(text, sel = this.sel()) {
    if (!sel) return;
    let { doc } = this;
    let pos = sel.start;
    if (!sel.collapsed) ({ doc, pos } = this.deleted(sel));
    const b = doc[pos.i];
    const cur = leafText(b, pos.leaf);
    const nb = withLeaf(b, pos.leaf, cur.slice(0, pos.off) + text + cur.slice(pos.off));
    // Typing over a selection starts a new undo step.
    if (!sel.collapsed) this.groupClosed = true;
    this.apply(splice(doc, pos.i, 1, [nb]), { ...pos, off: pos.off + text.length }, 'type');
  }

  // Index just past the last block that hangs under list item i.
  subtreeEnd(i, doc = this.doc) {
    const b = doc[i];
    let j = i + 1;
    while (j < doc.length && doc[j].q === b.q && doc[j].indent > b.indent) j++;
    return j;
  }

  enter(sel, replaced = null) {
    let { doc } = this;
    let pos = sel.start;
    if (replaced) doc = splice(doc, pos.i, 1, [replaced]);
    if (!sel.collapsed) ({ doc, pos } = this.deleted(sel));
    const { i } = pos;
    const b = doc[i];

    // In a table Enter goes down one row, with the cell's content selected
    // so typing replaces it; from the last row it leaves the table.
    if (b.type === 'table') {
      const below = pos.leaf + cols(b);
      let anchor;
      let focus;
      if (below >= leafCount(b)) {
        if (i + 1 >= doc.length) doc = [...doc, P()];
        anchor = focus = startOf(doc, i + 1);
      } else {
        anchor = { i, leaf: below, off: 0 };
        focus = { i, leaf: below, off: leafText(b, below).length };
      }
      if (doc === this.doc) {
        this.setSel(anchor, focus);
        this.revealCaret();
      } else this.apply(doc, { anchor, focus });
      return;
    }

    const before = b.text.slice(0, pos.off);
    const after = b.text.slice(pos.off);

    if (b.type === 'html' && after.trim() === '' && /<\/?[a-zA-Z][^>]*>\s*$/.test(before) && !openTagAt(before)) {
      this.apply(splice(doc, i + 1, 0, [P('', b)]), { i: i + 1, leaf: 0, off: 0 });
      return;
    }
    if (RAW.has(b.type)) {
      const indent = b.type === 'code' ? /(?:^|\n)([ \t]*)[^\n]*$/.exec(before)[1] : '';
      const extra = b.type === 'code' && /[{([:]\s*$/.test(before) ? '  ' : '';
      // Between a bracket pair the closer goes to a line of its own below the caret.
      const explode = b.type === 'code' && /[{([]$/.test(before) && { '{': '}', '(': ')', '[': ']' }[before.slice(-1)] === after[0];
      const nb = { ...b, text: `${before}\n${indent}${extra}${explode ? `\n${indent}` : ''}${after}` };
      this.apply(splice(doc, i, 1, [nb]), { i, leaf: 0, off: pos.off + 1 + indent.length + extra.length }, 'type');
      return;
    }

    if (b.type === 'def') {
      // An empty footnote turns into a paragraph; otherwise the definition ends at the
      // caret and what follows it starts a paragraph.
      if (/^\[\^[^\]]*\]:\s*$/.test(b.text)) return this.apply(splice(doc, i, 1, [{ ...P('', b), id: b.id }]), { i, leaf: 0, off: 0 });
      this.apply(splice(doc, i, 1, [{ ...b, text: before.replace(/\s+$/, '') }, P(after.replace(/^\s+/, ''), b)]), { i: i + 1, leaf: 0, off: 0 });
      return;
    }

    if (b.type === 'p' && after === '') {
      const swap = (items, at, leaf = 0) => this.apply(splice(doc, i, 1, items), { i: at, leaf, off: 0 });
      let m;
      if ((m = /^(```+|~~~+)\s*(\S*)\s*$/.exec(before))) {
        if (m[2]) this.lastCodeLang = m[2];
        return swap([{ ...b, type: 'code', lang: m[2] || this.codeLang(this.opts.defaultCodeLang), text: '' }], i);
      }
      if (/^\$\$\s*$/.test(before)) return swap([{ ...b, type: 'math', text: '' }], i);
      const tag = BLOCK_HTML.exec(before.trim());
      if (tag && !b.q && !b.indent) {
        const text = `${before.trim()}\n    \n</${tag[1]}>`;
        return this.apply(splice(doc, i, 1, [{ ...b, type: 'html', text }]), { i, leaf: 0, off: before.trim().length + 5 });
      }
      if (/^\[toc\]$/i.test(before)) return swap([{ ...b, type: 'toc', text: undefined }, P('', b)], i + 1);
      if (before.replace(/—/g, '---').replace(/–/g, '--') === '---' && i === 0 && !b.q && !b.indent) return swap([{ ...b, type: 'meta', text: '' }], i);
      if (/^([-*_])(\s*\1){2,}$/.test(before)) return swap([{ ...b, type: 'hr', text: undefined }, P('', b)], i + 1);
      if (/^\|.*\|.*\|?\s*$/.test(before)) {
        const head = splitRow(before);
        return swap([{ ...b, type: 'table', text: undefined, rows: [head, head.map(() => '')], align: head.map(() => '') }], i, head.length);
      }
    }

    // Enter on an empty block steps out one level. An empty list item turns
    // into a paragraph where it stands: inside the item above it when it was
    // nested, a plain paragraph otherwise. An empty paragraph inside an item
    // starts the next item of that list. An empty quoted paragraph leaves
    // the quote.
    if (b.text === '' && TEXTY.has(b.type) && (b.type === 'li' || b.indent > 0 || b.q > 0)) {
      let nb;
      if (b.type === 'li') nb = { ...P('', b), id: b.id };
      else if (b.indent > 0) {
        let owner = null;
        for (let k = i - 1; k >= 0 && doc[k].q === b.q && doc[k].indent >= b.indent - 1; k--) {
          if (doc[k].type === 'li' && doc[k].indent === b.indent - 1) {
            owner = doc[k];
            break;
          }
        }
        nb = owner ? { id: b.id, q: b.q, indent: b.indent - 1, type: 'li', kind: owner.kind, checked: false, text: '' } : { ...b, indent: b.indent - 1 };
      } else nb = { ...b, q: b.q - 1 };
      this.apply(splice(doc, i, 1, [nb]), { i, leaf: 0, off: 0 });
      return;
    }

    if (b.type === 'h' && pos.off === 0 && b.text) {
      this.apply(splice(doc, i, 0, [P('', b)]), { i: i + 1, leaf: 0, off: 0 });
      return;
    }

    // Enter inside a styled span (bold, code…) closes the style before the
    // break and opens it again after it.
    const [head, tail, reopen] = this.splitInline(i, pos, before, after);
    const first = { ...b, text: head };
    let second;
    // A heading split in the middle gives two headings; Enter at its end
    // starts a paragraph.
    if (b.type === 'h') second = after ? { ...b, id: uid(), text: tail } : P(tail, b);
    else if (b.type === 'li') {
      // A task split at its start leaves an unchecked empty item above; split in the
      // middle both halves keep the state; a new item after the end starts unchecked.
      const keeps = b.kind === 'task' && !!tail;
      second = { ...b, id: uid(), text: tail, checked: keeps ? b.checked : false, start: undefined };
      if (b.kind === 'task' && pos.off === 0 && b.text) first.checked = false;
    }
    else second = { ...b, id: uid(), text: tail };
    this.apply(splice(doc, i, 1, [first, second]), { i: i + 1, leaf: 0, off: reopen }, 'enter');
  }

  // The two halves of a leaf split at `pos`, with every styled span the split
  // point lies in closed at the end of the first half and reopened at the
  // start of the second; also the length of what was reopened.
  splitInline(i, pos, before, after) {
    const leafEl = leavesOf(this.root.children[i] || this.root)[pos.leaf];
    if (!leafEl) return [before, after, 0];
    const closes = [];
    const opens = [];
    for (const [tok, a, z] of tokenSpans(leafEl).sort((x, y) => x[1] - y[1])) {
      if (NO_SPLIT.has(tok.dataset.t)) continue;
      const first = tok.firstElementChild;
      const last = tok.lastElementChild;
      if (!first || first === last || !first.classList.contains('mk') || !last.classList.contains('mk')) continue;
      const open = first.textContent;
      const close = last.textContent;
      if (pos.off <= a + open.length || pos.off >= z - close.length) continue;
      closes.unshift(close);
      opens.push(open);
    }
    const reopen = opens.join('');
    return [before + closes.join(''), reopen + after, reopen.length];
  }

  backspaceAtStart(pos) {
    const { doc } = this;
    const { i } = pos;
    const b = doc[i];
    const here = { i, leaf: 0, off: 0 };
    if (b.type === 'table') return;
    if (RAW.has(b.type)) {
      if (b.text === '' || (b.type === 'code' && !b.text.includes('\n'))) this.apply(splice(doc, i, 1, [{ ...P(b.text, b), id: b.id }]), here);
      return;
    }
    // Peel one layer of structure per press. A list item loses its marker
    // and becomes a paragraph of the item before it (or of its parent, or a
    // plain paragraph when it was the first one). A paragraph inside an item
    // joins the text before it; a quoted paragraph leaves the quote.
    if (b.type === 'li' && b.kind === 'task') return this.apply(splice(doc, i, 1, [{ ...b, kind: 'ul', checked: false }]), here);
    if (b.type === 'li') {
      const prior = doc[i - 1];
      const sibling = prior && prior.q === b.q && ((prior.type === 'li' && prior.indent === b.indent) || prior.indent > b.indent);
      return this.apply(splice(doc, i, 1, [{ ...P(b.text, b), id: b.id, indent: b.indent + (sibling ? 1 : 0) }]), here);
    }
    if (b.type !== 'p') return this.apply(splice(doc, i, 1, [{ ...P(b.text, b), id: b.id }]), here);
    const joinable = i > 0 && TEXTY.has(doc[i - 1].type) && doc[i - 1].q === b.q;
    if (b.indent > 0 && !joinable) return this.apply(splice(doc, i, 1, [{ ...b, indent: b.indent - 1 }]), here);
    if (b.q > 0 && !(b.indent > 0)) return this.apply(splice(doc, i, 1, [{ ...b, q: b.q - 1 }]), here);
    if (i === 0) return;
    const prev = doc[i - 1];
    if (NOLEAF.has(prev.type)) return this.apply(splice(doc, i - 1, 1), { i: i - 1, leaf: 0, off: 0 });
    // After a table or a code block the paragraph's text joins the end of
    // that block: the last cell, or the last line of code.
    if (prev.type === 'table' && b.text) {
      const rows = prev.rows.map((r) => r.slice());
      const r = rows.length - 1;
      const c = cols(prev) - 1;
      const at = rows[r][c].length;
      rows[r][c] += b.text.replace(/\n/g, ' ');
      return this.apply(splice(doc, i - 1, 2, [{ ...prev, rows }]), { i: i - 1, leaf: leafCount(prev) - 1, off: at });
    }
    if (prev.type === 'code' && b.text) {
      return this.apply(splice(doc, i - 1, 2, [{ ...prev, text: prev.text + b.text }]), { i: i - 1, leaf: 0, off: prev.text.length });
    }
    if (prev.type === 'table' || RAW.has(prev.type)) {
      const next = b.text === '' && i < doc.length - 1 ? splice(doc, i, 1) : doc;
      return this.apply(next, endOf(next, i - 1));
    }
    const merged = { ...prev, text: prev.text + b.text };
    this.apply(splice(doc, i - 1, 2, [merged]), { i: i - 1, leaf: 0, off: prev.text.length });
  }

  deleteAtEnd(pos) {
    const { doc } = this;
    const { i } = pos;
    const b = doc[i];
    const next = doc[i + 1];
    if (RAW.has(b.type) && b.text === '') return this.apply(splice(doc, i, 1, [{ ...P('', b), id: b.id }]), { i, leaf: 0, off: 0 });
    if (!next || b.type === 'table' || RAW.has(b.type)) return;
    if (NOLEAF.has(next.type)) return this.apply(splice(doc, i + 1, 1), pos);
    if (next.type === 'table' || RAW.has(next.type)) {
      if (b.text === '') this.apply(splice(doc, i, 1), startOf(splice(doc, i, 1), i));
      return;
    }
    this.apply(splice(doc, i, 2, [{ ...b, text: b.text + next.text }]), pos);
  }

  // --- keyboard -----------------------------------------------------------

  onKeyDown(e) {
    if (this.inComponent(e.target)) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') this.arrowDir = e.key === 'ArrowLeft' ? 'left' : 'right';
    if (e.keyCode === 229 || e.isComposing) {
      // A key the input method took. In WebKit this keydown arrives after
      // the composition events it caused, so it says nothing about where the
      // composition started; it is only a good moment to write the previous
      // composition's text to the model.
      if (!this.composing) this.flushIme();
      return;
    }
    this.flushIme();
    if (this.objectSel != null && this.objectKey(e)) return;
    // Shortcuts are resolved by the command registry; let it try first.
    if (this.hooks.onShortcut?.(e)) return;
    const any = e.metaKey || e.ctrlKey;
    if (e.key === 'Tab') {
      e.preventDefault();
      this.tab(e.shiftKey);
    } else if (e.key === 'Escape') {
      const sel = this.getSel();
      const b = sel && this.doc[sel.focus.i];
      // Escape leaves an island's source and shows its preview again.
      if (b && isIsland(b) && sel.focus.i + 1 < this.doc.length) {
        e.preventDefault();
        this.setSel(startOf(this.doc, sel.focus.i + 1));
      }
    } else if (e.key.startsWith('Arrow') && !e.shiftKey && !any && !e.altKey && this.arrow(e.key)) e.preventDefault();
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && !any && !e.altKey && this.shiftArrow(e.key)) e.preventDefault();
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.shiftKey && !any && !e.altKey && this.shiftAcrossCells(e.key)) e.preventDefault();
  }

  // --- object selection: a rule or table of contents reached with the arrow keys is
  // selected as a whole; Backspace/Delete removes it, Enter adds a paragraph after it,
  // the arrows move on, anything else lets it go.
  selectObject(i) {
    this.clearObject();
    this.objectSel = i;
    this.root.children[i]?.classList.add('object-selected');
    window.getSelection().removeAllRanges();
    this.root.focus({ preventScroll: true });
    this.root.children[i]?.scrollIntoView({ block: 'nearest' });
    return true;
  }

  clearObject() {
    if (this.objectSel == null) return;
    this.root.querySelector(':scope > .object-selected')?.classList.remove('object-selected');
    this.objectSel = null;
  }

  objectKey(e) {
    const i = this.objectSel;
    const done = () => {
      e.preventDefault();
      return true;
    };
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      this.clearObject();
      if (i > 0 && NOLEAF.has(this.doc[i - 1].type)) return done(this.selectObject(i - 1));
      return done(i > 0 ? this.setSel(endOf(this.doc, i - 1)) : this.openGap(0, this.doc[0]));
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      this.clearObject();
      if (NOLEAF.has(this.doc[i + 1]?.type)) return done(this.selectObject(i + 1));
      return done(this.setSel(startOf(this.doc, i + 1)));
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      this.clearObject();
      const doc = normalize(splice(this.doc, i, 1));
      return done(this.apply(doc, e.key === 'Backspace' && i > 0 ? endOf(doc, i - 1) : startOf(doc, Math.min(i, doc.length - 1))));
    }
    if (e.key === 'Enter') {
      this.clearObject();
      return done(this.apply(splice(this.doc, i + 1, 0, [P('', this.doc[i])]), { i: i + 1, leaf: 0, off: 0 }));
    }
    if (e.key === 'Escape') return done(this.clearObject());
    if (!['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) this.clearObject();
    return false;
  }

  // Shift+Left/Right at the edge of a table cell: the selection goes on into the
  // cell before or after it (taking that cell in whole).
  shiftAcrossCells(key) {
    const sel = this.getSel();
    if (!sel) return false;
    const { i, leaf, off } = sel.focus;
    const b = this.doc[i];
    if (b.type !== 'table') return false;
    const right = key === 'ArrowRight';
    const len = leafText(b, leaf).length;
    if (right ? off < len : off > 0) return false;
    const next = leaf + (right ? 1 : -1);
    if (next < 0 || next >= leafCount(b)) return false;
    this.setSel(sel.anchor, { i, leaf: next, off: right ? leafText(b, next).length : 0 });
    return true;
  }

  // Shift+Up/Down at the edge of a block, onto a code, math or HTML block, a rule or a
  // table of contents: the selection takes in that whole block.
  shiftArrow(key) {
    const sel = this.getSel();
    if (!sel) return false;
    const { i } = sel.focus;
    const up = key === 'ArrowUp';
    const n = up ? i - 1 : i + 1;
    const next = this.doc[n];
    if (!next || TEXTY.has(next.type) || next.type === 'table') return false;
    if (!this.onEdgeLine(up ? 'up' : 'down', sel.focus)) return false;
    let k = n;
    while (this.doc[k] && NOLEAF.has(this.doc[k].type)) k += up ? -1 : 1;
    const to = !this.doc[k] ? (up ? startOf(this.doc, 0) : endOf(this.doc, this.doc.length - 1)) : NOLEAF.has(next.type) ? (up ? endOf(this.doc, k) : startOf(this.doc, k)) : up ? startOf(this.doc, n) : endOf(this.doc, n);
    this.setSel(sel.anchor, to);
    return true;
  }

  // Leaves an HTML or math block's source (Finish Editing / Escape): the caret goes to
  // the start of the next block, as Escape does.
  finishRawEdit(i) {
    if (i + 1 < this.doc.length) this.setSel(startOf(this.doc, i + 1));
  }

  tab(shift) {
    const sel = this.getSel();
    if (!sel) return;
    const { i, leaf } = sel.focus;
    const b = this.doc[i];
    if (shift && (b.type === 'li' || ((b.type === 'p' || b.type === 'h') && (b.q > 0 || /^(\t| {1,2})/.test(b.text) || sourceLead(b))))) this.outdent();
    else if (b.type === 'li') {
      const before = this.doc;
      this.indentList(1);
      // An item that cannot go deeper (nothing above to nest under) takes
      // the Tab as a character, like ordinary text does.
      if (!shift && this.doc === before) this.insertText('\t', sel);
    } else if (b.type === 'code') {
      // Tab inside code is a tab character (shown at the code indent width); the indent width is for auto-indent and Shift+Tab.
      // With a selection every touched line is indented (typing over it would delete it).
      if (!shift) {
        if (sel.collapsed) this.insertText('\t', sel);
        else this.indentCodeLines();
      } else if (this.opts.shiftTabIndentCode) this.autoIndentCode(true);
      else this.outdentCode();
    } else if (b.type === 'table') {
      const target = leaf + (shift ? -1 : 1);
      if (target < 0) return;
      let { doc } = this;
      if (target >= leafCount(b)) doc = splice(doc, i, 1, [{ ...b, rows: [...b.rows, Array(cols(b)).fill('')] }]);
      // The cell arrived at has its content selected, ready to be replaced.
      const from = { i, leaf: target, off: 0 };
      const to = { i, leaf: target, off: leafText(doc[i], target).length };
      if (doc === this.doc) this.setSel(from, to);
      else this.apply(doc, { anchor: from, focus: to });
    } else if (!shift && RAW.has(b.type)) this.insertText('  ', sel);
    else if (!shift && TEXTY.has(b.type)) this.insertText('\t', sel);
  }

  // Is the caret on the first / last visual line of its leaf?
  onEdgeLine(dir, pos) {
    const b = this.doc[pos.i];
    const len = leafText(b, pos.leaf).length;
    if (dir === 'up' && pos.off === 0) return true;
    if (dir === 'down' && pos.off === len) return true;
    const leaf = leavesOf(this.root.children[pos.i])[pos.leaf];
    const s = window.getSelection();
    const rect = s.rangeCount && s.getRangeAt(0).getClientRects()[0];
    if (!leaf || !rect) return false;
    const box = leaf.getBoundingClientRect();
    const cs = getComputedStyle(leaf);
    return dir === 'up'
      ? rect.top - box.top - parseFloat(cs.paddingTop) < rect.height * 0.7
      : box.bottom - parseFloat(cs.paddingBottom) - rect.bottom < rect.height * 0.7;
  }

  // The browser cannot move the caret into a table cell (its own editing
  // host) or into an island whose source is hidden, so do those steps here.
  arrow(key) {
    const sel = this.getSel();
    if (!sel || !sel.collapsed) return false;
    const { i, leaf, off } = sel.focus;
    const b = this.doc[i];
    const go = (pos) => {
      this.setSel(pos);
      this.revealCaret();
      return true;
    };
    // A token shown as a symbol (emoji, smart punctuation, inline math) is
    // one step wide: Left or Right at its edge jumps over it.
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && !RAW.has(b.type)) {
      const leafEl = leavesOf(this.root.children[i])[leaf];
      for (const [tok, a, z] of leafEl ? tokenSpans(leafEl) : []) {
        if (!ATOMIC.has(tok.dataset.t)) continue;
        if (key === 'ArrowLeft' && off > a && off <= z) return go({ i, leaf, off: a });
        if (key === 'ArrowRight' && off >= a && off < z) return go({ i, leaf, off: z });
      }
    }
    // Before the first block, or between two blocks that are not text (code, math,
    // HTML, tables, rules), the arrow keys stop in a new empty paragraph.
    if (!TEXTY.has(b.type) && b.type !== 'meta') {
      const total = leafCount(b);
      const n = b.type === 'table' ? cols(b) : 1;
      const len = leafText(b, leaf).length;
      const first = b.type === 'table' ? leaf < n : true;
      const last = b.type === 'table' ? leaf + n >= total : true;
      const atStart = (key === 'ArrowUp' && first && (b.type === 'table' || this.onEdgeLine('up', sel.focus))) || (key === 'ArrowLeft' && leaf === 0 && off === 0);
      const atEnd = (key === 'ArrowDown' && last && (b.type === 'table' || this.onEdgeLine('down', sel.focus))) || (key === 'ArrowRight' && leaf === total - 1 && off === len);
      const prev = this.doc[i - 1];
      const next = this.doc[i + 1];
      if (atStart && (!prev || !TEXTY.has(prev.type))) return this.openGap(i, b);
      if (atEnd && next && !TEXTY.has(next.type)) return this.openGap(i + 1, b);
    }
    if (b.type === 'table') {
      const n = cols(b);
      const len = leafText(b, leaf).length;
      const total = leafCount(b);
      if (key === 'ArrowUp') return go(leaf >= n ? { i, leaf: leaf - n, off: Math.min(off, leafText(b, leaf - n).length) } : i > 0 ? endOf(this.doc, i - 1) : sel.focus);
      if (key === 'ArrowDown') return go(leaf + n < total ? { i, leaf: leaf + n, off: Math.min(off, leafText(b, leaf + n).length) } : startOf(this.doc, i + 1));
      if (key === 'ArrowLeft' && off === 0) return go(leaf > 0 ? { i, leaf: leaf - 1, off: leafText(b, leaf - 1).length } : i > 0 ? endOf(this.doc, i - 1) : sel.focus);
      if (key === 'ArrowRight' && off === len) return go(leaf + 1 < total ? { i, leaf: leaf + 1, off: 0 } : startOf(this.doc, i + 1));
      return false;
    }
    const len = leafText(b, leaf).length;
    if ((key === 'ArrowDown' && NOLEAF.has(this.doc[i + 1]?.type) && (off === len || this.onEdgeLine('down', sel.focus)))
      || (key === 'ArrowUp' && NOLEAF.has(this.doc[i - 1]?.type) && (off === 0 || this.onEdgeLine('up', sel.focus)))) return this.selectObject(key === 'ArrowDown' ? i + 1 : i - 1);
    const pictureOnly = (x) => x && x.type === 'p' && /^!\[[^\]]*\]\([^)]*\)$/.test(x.text.trim());
    const near = key === 'ArrowDown' ? i + 1 : i - 1;
    if ((key === 'ArrowDown' || key === 'ArrowUp') && pictureOnly(this.doc[near]) && this.onEdgeLine(key === 'ArrowDown' ? 'down' : 'up', sel.focus)) {
      const img = this.root.children[near]?.querySelector('img');
      if (img) {
        this.selectImage(img);
        return true;
      }
    }
    const special = (x) => x && (x.type === 'table' || isIsland(x));
    // Step over rules and tables of contents to find the real neighbour.
    let n = i + 1;
    while (n < this.doc.length && NOLEAF.has(this.doc[n].type)) n++;
    let p = i - 1;
    while (p >= 0 && NOLEAF.has(this.doc[p].type)) p--;
    if (special(this.doc[n]) && ((key === 'ArrowRight' && off === len) || (key === 'ArrowDown' && this.onEdgeLine('down', sel.focus)))) return go({ i: n, leaf: 0, off: 0 });
    if (special(this.doc[p]) && ((key === 'ArrowLeft' && off === 0) || (key === 'ArrowUp' && this.onEdgeLine('up', sel.focus)))) return go(endOf(this.doc, p));
    // Leaving an island downwards when the next block is ordinary text is
    // native, but the island must not swallow the key at its last line.
    return false;
  }

  // --- clipboard & drop -----------------------------------------------------

  // A selection inside one token that takes in one of its markers but not
  // the other would copy unbalanced syntax ("**bol"): leave that marker out.
  balanced(i, leaf, from, to) {
    const leafEl = leavesOf(this.root.children[i] || this.root)[leaf];
    if (!leafEl) return [from, to];
    for (const tok of leafEl.querySelectorAll('.tok')) {
      const first = tok.firstElementChild;
      const last = tok.lastElementChild;
      if (!first || first === last || !first.classList.contains('mk') || !last.classList.contains('mk')) continue;
      const r = document.createRange();
      r.setStart(leafEl, 0);
      r.setEndBefore(tok);
      const a = r.toString().length;
      const z = a + tok.textContent.length;
      const open = a + first.textContent.length;
      const close = z - last.textContent.length;
      if (from >= a && from < open && to <= close && to > open) from = open;
      if (to > close && to <= z && from >= open && from < close) to = close;
    }
    return [from, to];
  }

  rangeMarkdown(sel) {
    const { start: s, end: e } = sel;
    if (s.i === e.i) {
      const b = this.doc[s.i];
      if (s.leaf === e.leaf) return leafText(b, s.leaf).slice(...this.balanced(s.i, s.leaf, s.off, e.off));
      const cells = [];
      for (let l = s.leaf; l <= e.leaf; l++) cells.push(leafText(b, l));
      return cells.join('\t');
    }
    const part = this.doc.slice(s.i, e.i + 1);
    if (part[0].type !== 'table' && !NOLEAF.has(part[0].type)) part[0] = { ...part[0], text: part[0].text.slice(s.off) };
    const last = part.length - 1;
    if (part[last].type !== 'table' && !NOLEAF.has(part[last].type)) part[last] = { ...part[last], text: part[last].text.slice(0, e.off) };
    return serialize(part).replace(/\n$/, '');
  }

  // The browser would copy rendered text, losing the hidden markers. Copy the
  // Markdown source of the selection instead, plus rendered HTML for apps
  // that paste rich text.
  onCopy(e, cut) {
    if (this.inComponent(e.target)) return;
    this.flushIme();
    // A rule or table of contents selected as an object copies as its Markdown.
    if (this.objectSel != null) {
      const b = this.doc[this.objectSel];
      e.preventDefault();
      e.clipboardData.setData('text/plain', b.type === 'toc' ? '[toc]' : '---');
      if (cut) {
        const i = this.objectSel;
        this.clearObject();
        const doc = normalize(splice(this.doc, i, 1));
        this.apply(doc, startOf(doc, Math.min(i, doc.length - 1)));
      }
      return;
    }
    // The whole of a math or HTML block selected: its source with its fences.
    const whole = this.getSel();
    if (whole && !whole.collapsed && whole.anchor.i === whole.focus.i) {
      const b = this.doc[whole.focus.i];
      const lo = Math.min(whole.anchor.off, whole.focus.off);
      const hi = Math.max(whole.anchor.off, whole.focus.off);
      if ((b.type === 'math' || b.type === 'html') && lo === 0 && hi === (b.text || '').length && b.text) {
        e.preventDefault();
        e.clipboardData.setData('text/plain', b.type === 'math' ? `$$\n${b.text}\n$$` : b.text);
        if (!cut) return;
      }
      // A selected picture: its address, and the picture itself for other apps.
      const img = b.type !== 'math' && b.type !== 'html' && this.imageAtCaret?.();
      if (img && hi - lo > 0 && leafText(b, whole.focus.leaf).slice(lo, hi).startsWith('![')) {
        e.preventDefault();
        e.clipboardData.setData('text/plain', leafText(b, whole.focus.leaf).slice(lo, hi));
        e.clipboardData.setData('text/html', `<img src="${esc(img.src)}" alt="${esc(img.alt || '')}">`);
        if (!cut) return;
      }
    }
    let sel = this.getSel();
    if (!sel) return;
    let wholeLine = false;
    if (sel.collapsed) {
      // Optionally, copy or cut the line the caret is on.
      if (!this.opts.copyLine || NOLEAF.has(this.doc[sel.focus.i].type)) return;
      const { i, leaf, off } = sel.focus;
      const [s, z] = this.lineBounds(leafText(this.doc[i], leaf), off);
      sel = this.selFrom({ i, leaf, off: s }, { i, leaf, off: z });
      wholeLine = true;
    }
    e.preventDefault();
    const md = this.rangeMarkdown(sel);
    e.clipboardData.setData('text/plain', (this.hooks.toPlain?.(md) ?? md) + (wholeLine ? '\n' : ''));
    this.hooks.onCopied?.(md);
    const html = this.hooks.toHtml?.(md);
    if (html) e.clipboardData.setData('text/html', html);
    if (cut && !this.readOnly) {
      if (wholeLine) this.deleteLine();
      else this.deleteRange(sel);
    }
  }

  onPaste(e) {
    if (this.inComponent(e.target)) return;
    this.flushIme();
    e.preventDefault();
    if (this.readOnly) return;
    const data = e.clipboardData;
    const files = [...(data.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      this.hooks.onImageFiles?.(files, { pasted: true });
      return;
    }
    const html = data.getData('text/html');
    const text = data.getData('text/plain') || '';
    // Rich text from a web page or Word becomes Markdown; text copied from a
    // code editor or from this editor stays as it is.
    if (this.hooks.onPasteText?.(text, html)) return;
    const converted0 = html && !this.pastePlain && this.hooks.fromHtml?.(html, text);
    // Pictures pasted from another document get addresses that work from this one;
    // afterwards the image rules (copy to folder, upload) apply to them.
    const converted = converted0 && this.hooks.transformPaste ? this.hooks.transformPaste(converted0) : converted0;
    if (!converted && this.hooks.transformPaste) {
      const moved = this.hooks.transformPaste(text);
      if (moved !== text) {
        this.pasteText(moved, { fromHtml: false });
        this.hooks.onPasted?.(moved);
        return;
      }
    }
    setTimeout(() => this.hooks.onPasted?.(converted || text), 0);
    this.pasteText(converted || text, { fromHtml: !!converted });
  }

  pasteText(raw, { plain = false, fromHtml = false } = {}) {
    const text = (raw || '').replace(/\r\n?/g, '\n');
    const sel = this.sel();
    if (!text || !sel) return;
    const b0 = this.doc[sel.start.i];
    if (RAW.has(b0.type) || b0.type === 'def') return this.insertText(text, sel);
    if (b0.type === 'table') return this.insertText(text.replace(/\s*\n+\s*/g, ' '), sel);
    if (plain) return this.insertText(text.replace(/\n{2,}/g, '\n'), sel);

    const trimmed = text.replace(/\n+$/, '');
    let { doc } = this;
    let pos = sel.start;
    if (!sel.collapsed) ({ doc, pos } = this.deleted(sel));
    const b = doc[pos.i];
    const head = b.text.slice(0, pos.off);
    const tail = b.text.slice(pos.off);
    // One run of plain text (no blank line in it) dropped in front of
    // existing text stays text, line breaks and all.
    if (!fromHtml && tail && !/\n[ \t]*\n/.test(trimmed)) return this.insertText(trimmed, sel);

    const parsed = parseMarkdown(trimmed);
    if (parsed.length === 1 && parsed[0].type === 'p') return this.insertText(parsed[0].text, sel);

    // The first pasted paragraph continues the text before the caret and
    // the last one runs into the text after it; whatever lies between
    // arrives as blocks of its own.
    let first = null;
    let rest = parsed;
    if (head && (parsed[0].type === 'p' || parsed[0].type === 'h')) {
      const add = !fromHtml && parsed[0].type === 'h' ? trimmed.split(/\n[ \t]*\n/)[0] : parsed[0].text;
      first = { ...b, text: head + add };
      rest = parsed.slice(1);
    }
    // Pasted blocks take on the nesting of the place they land in; list
    // items pasted into a list item become its siblings.
    const sibling = b.type === 'li' && rest[0]?.type === 'li';
    const placed = rest.map((x) => ({ ...x, q: x.q + b.q, indent: x.indent + (b.type === 'li' && !sibling ? b.indent + 1 : b.indent) }));
    let caret = null;
    let tailBlock = null;
    if (tail) {
      const last = placed[placed.length - 1];
      if (last && last.type === 'p' && b.type !== 'li') {
        caret = last.text.length;
        placed[placed.length - 1] = { ...last, text: last.text + tail };
      } else if (!placed.length && first) {
        caret = first.text.length;
        first = { ...first, text: first.text + tail };
      } else tailBlock = { ...b, id: uid(), text: tail };
    }
    const lead = first || (head ? { ...b, text: head } : null);
    const items = [lead, ...placed, tailBlock].filter(Boolean);
    doc = normalize(splice(doc, pos.i, 1, items));
    const at = pos.i + (lead ? 1 : 0) + placed.length - 1;
    return this.apply(doc, caret === null ? endOf(doc, at) : { i: at, leaf: 0, off: caret });
  }

  onDrop(e) {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])];
    const images = files.filter((f) => f.type.startsWith('image/'));
    // Text, HTML or a link dragged in from another app goes in where it is dropped,
    // converted as a paste would be. (A drag within the document is not a move here.)
    const fromOutside = !images.length && !files.length && !this.draggingOwn && !this.readOnly;
    if (!images.length && !fromOutside) return;
    e.stopPropagation();
    this.caretAtPoint(e.clientX, e.clientY);
    if (images.length) return this.hooks.onImageFiles?.(images);
    const data = e.dataTransfer;
    const uri = (data.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    const html = data.getData('text/html');
    const text = data.getData('text/plain') || uri || '';
    if (this.hooks.onPasteText?.(text, html)) return;
    const converted = html && this.hooks.fromHtml?.(html, text);
    this.pasteText(converted || text, { fromHtml: !!converted });
  }

  // Puts the caret at a point of the page (a drop); false when no text is there.
  caretAtPoint(x, y) {
    const r = document.caretRangeFromPoint?.(x, y);
    const pos = r && this.root.contains(r.startContainer) && this.toPos(r.startContainer, r.startOffset);
    if (pos) this.setSel(pos);
    return !!pos;
  }

  // --- mouse --------------------------------------------------------------

  onMouseDown(e) {
    const back = e.target.closest?.('.fn-back');
    if (back) {
      e.preventDefault();
      this.jumpToFootnoteRef(back.dataset.label, Number(back.dataset.index));
      return;
    }
    const tipBtn = e.target.closest?.('.raw-tip-btn');
    if (tipBtn) {
      e.preventDefault();
      const i = this.indexOfEl(tipBtn.closest('.island'));
      if (i < 0) return;
      if (tipBtn.classList.contains('raw-tip-edit')) this.setSel(endOf(this.doc, i));
      else this.finishRawEdit(i);
      return;
    }
    const imgBtn = e.target.closest?.('.img-btn');
    if (imgBtn) {
      // "input image URL" puts the caret where the address goes and stays marked
      // until something is typed; the folder button picks local pictures.
      e.preventDefault();
      if (imgBtn.classList.contains('img-file')) {
        this.hooks.onPickImages?.();
        return;
      }
      const leaf = imgBtn.closest('[data-leaf]');
      const token = imgBtn.closest('.tok');
      const span = leaf && tokenSpans(leaf).find(([el]) => el === token);
      const pos = leaf && this.toPos(leaf, 0);
      if (span && pos) {
        const src = leafText(this.doc[pos.i], pos.leaf).slice(span[1], span[2]);
        this.setSel({ ...pos, off: span[1] + src.indexOf('](') + 2 });
        imgBtn.classList.add('selected');
      }
      return;
    }
    const tool = e.target.closest?.('.table-tools button');
    if (tool) {
      // Keep the caret in its cell while the toolbar is used.
      e.preventDefault();
      this.tableOp(tool.dataset.act);
      return;
    }
    if (this.inComponent(e.target)) return;
    // Cmd+click on a link opens it (on click) without moving the caret first.
    if ((e.metaKey || e.ctrlKey) && e.button === 0 && e.target.closest?.('a[href]')) {
      e.preventDefault();
      return;
    }
    // A click on rendered inline math selects its TeX.
    const mathView = e.button === 0 && !this.readOnly && e.target.closest?.('.math-view');
    if (mathView) {
      const token = mathView.closest('.tok');
      const leaf = token?.closest('[data-leaf]');
      const pos = leaf && this.toPos(leaf, 0);
      const span = leaf && tokenSpans(leaf).find(([el]) => el === token);
      if (pos && span) {
        e.preventDefault();
        const src = leafText(this.doc[pos.i], pos.leaf).slice(span[1], span[2]);
        const open = src.startsWith('$$') ? 2 : src.startsWith('\\(') ? 2 : 1;
        this.setSel({ ...pos, off: span[1] + open }, { ...pos, off: span[2] - open });
        return;
      }
    }
    // The label line of a callout ([!NOTE]) is not text: a click there goes to the body.
    const alertHead = e.button === 0 && !this.readOnly && e.target.closest?.('.b.alert-label');
    if (alertHead) {
      const i = this.indexOfEl(alertHead);
      if (i >= 0 && this.doc[i + 1] && this.doc[i + 1].q >= this.doc[i].q) {
        e.preventDefault();
        this.setSel(startOf(this.doc, i + 1));
        return;
      }
    }
    this.flushIme();
    if (e.button === 0 && e.detail < 2 && e.target === this.root && this.clickBelowEnd(e)) {
      e.preventDefault();
      return;
    }
    // Triple-click selects the clicked block's text only (a table cell; one line in
    // code). WebKit's own paragraph selection runs into the next block, and typing
    // over it would merge the two.
    if (e.detail >= 3 && e.button === 0 && this.selectClickedBlock(e)) {
      e.preventDefault();
      return;
    }
    this.mouseDown = true;
    // The task checkbox is a ::before box in the item's left padding.
    const li = e.target.closest?.('.li[data-kind="task"]');
    if (li && li.parentElement === this.root && !this.readOnly) {
      const left = li.getBoundingClientRect().left + parseFloat(getComputedStyle(li).paddingLeft);
      if (e.clientX < left) {
        e.preventDefault();
        const i = this.indexOfEl(li);
        const b = this.doc[i];
        const sel = this.getSel();
        this.apply(splice(this.doc, i, 1, [{ ...b, checked: !b.checked }]), sel && { anchor: sel.anchor, focus: sel.focus });
      }
    }
  }

  // A click in the empty space under the last block writes there: the caret goes
  // into a trailing empty paragraph, adding one when the last block has text.
  // An added one goes away again if it is left empty (see onSelectionChange).
  clickBelowEnd(e) {
    if (this.readOnly) return false;
    const last = this.root.lastElementChild;
    if (!last || e.clientY <= last.getBoundingClientRect().bottom) return false;
    const n = this.doc.length;
    const b = this.doc[n - 1];
    if ((b.type === 'p' || b.type === 'h') && !b.text) {
      this.setSel(endOf(this.doc, n - 1));
      return true;
    }
    const blank = P();
    this.apply([...this.doc, blank], startOf([...this.doc, blank], n));
    this.tempBlock = blank.id;
    return true;
  }

  reparseBlock(id, sel) {
    if (this.readOnly) return false;
    const i = this.doc.findIndex((x) => x.id === id);
    const b = this.doc[i];
    if (b?.srcHeading) {
      const parsed = parseMarkdown(b.text);
      const one = parsed.length === 1 ? { ...parsed[0], id: b.id, q: b.q, indent: b.indent } : null;
      const nb = one && one.type === 'h' ? one : { ...b, srcHeading: undefined };
      if (one && one.type === 'h') {
        this.doc = splice(this.doc, i, 1, [nb]);
        if (this.history[this.hIndex]) this.history[this.hIndex].doc = this.doc;
        this.render();
        this.setSel(sel.anchor, sel.focus);
        return true;
      }
      delete nb.srcHeading;
      this.doc = splice(this.doc, i, 1, [nb]);
    }
    if (!b || (b.type !== 'p' && b.type !== 'html') || b.indent || !b.text) return false;
    if (b.type === 'p' && !/^[ \t]{0,3}(?:[<`~>#|+*=\-–—[]|\d)/.test(b.text) && !b.text.includes('\n')) return false;
    const parsed = parseMarkdown(b.text);
    if (!parsed.length || parsed.some((x) => x.type === 'meta')) return false;
    if (parsed.length === 1 && parsed[0].type === b.type && parsed[0].text === b.text) return false;
    const blocks = parsed.map((x, k) => ({ ...x, ...(k === 0 ? { id: b.id } : {}), q: (x.q || 0) + (b.q || 0) }));
    const grow = blocks.length - 1;
    const fix = (p) => (p.i > i ? { ...p, i: p.i + grow } : p);
    this.apply(splice(this.doc, i, 1, blocks), { anchor: fix(sel.anchor), focus: fix(sel.focus) }, 'reparse');
    return true;
  }

  // A paragraph made only to hold the caret (clickBelowEnd, arrowing past a code block
  // or table) goes away again once the caret leaves it empty.
  dropTempBlock(sel) {
    const id = this.tempBlock;
    if (!id || this.doc[sel.focus.i]?.id === id) return;
    this.tempBlock = null;
    const i = this.doc.findIndex((x) => x.id === id);
    const b = this.doc[i];
    if (i < 0 || this.doc.length < 2 || b.type !== 'p' || b.text || sel.anchor.i === i) return;
    const fix = (p) => (p.i > i ? { ...p, i: p.i - 1 } : p);
    this.doc = normalize(splice(this.doc, i, 1));
    this.render();
    this.setSel(fix(sel.anchor), fix(sel.focus));
  }

  // Puts the caret in a new empty paragraph at `at` (see dropTempBlock).
  openGap(at, like) {
    const blank = P('', { q: like?.q || 0, indent: 0 });
    this.apply(splice(this.doc, at, 0, [blank]), { i: at, leaf: 0, off: 0 });
    this.tempBlock = blank.id;
    return true;
  }

  // A click beside the text column goes to the block at that height: its start on
  // the left, its end on the right.
  clickInMargin(e) {
    if (this.readOnly) return false;
    const blocks = [...this.root.children];
    const k = blocks.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10;
    });
    if (k < 0) return this.clickBelowEnd(e);
    const left = e.clientX < this.root.getBoundingClientRect().left;
    const i = this.indexOfEl(blocks[k]);
    if (i < 0) return false;
    this.setSel(left ? startOf(this.doc, i) : endOf(this.doc, i));
    return true;
  }

  // Select All inside a code block, math block, HTML block or the front matter takes
  // just that block's text. False when the caret is elsewhere (the whole document is meant).
  selectBlockText() {
    const sel = this.getSel();
    if (!sel || sel.anchor.i !== sel.focus.i) return false;
    const b = this.doc[sel.focus.i];
    if (!['code', 'math', 'html', 'meta'].includes(b.type)) return false;
    const len = leafText(b, 0).length;
    const lo = Math.min(sel.anchor.off, sel.focus.off);
    const hi = Math.max(sel.anchor.off, sel.focus.off);
    if (lo === 0 && hi === len && len) return false;
    this.setSel({ i: sel.focus.i, leaf: 0, off: 0 }, { i: sel.focus.i, leaf: 0, off: len });
    return true;
  }

  selectClickedBlock(e) {
    const leafEl = e.target.closest?.('[data-leaf]');
    if (!leafEl || !this.root.contains(leafEl)) return false;
    const pos = this.toPos(leafEl, 0);
    if (!pos) return false;
    const b = this.doc[pos.i];
    const text = leafText(b, pos.leaf);
    let from = 0;
    let to = text.length;
    if (b.type === 'code') {
      // The line under the pointer, as far as the current caret tells.
      const cur = this.getSel();
      const at = cur && cur.focus.i === pos.i ? cur.focus.off : 0;
      from = text.lastIndexOf('\n', at - 1) + 1;
      const nl = text.indexOf('\n', at);
      to = nl < 0 ? text.length : nl;
    }
    this.setSel({ ...pos, off: from }, { ...pos, off: to });
    return true;
  }

  onClick(e) {
    const tocItem = e.target.closest?.('.toc-item');
    if (tocItem) {
      const i = this.doc.findIndex((b) => b.id === tocItem.dataset.id);
      if (i >= 0) this.focusBlock(i);
      return;
    }
    let a = e.target.closest?.('a[href], a[*|href]');
    // Links drawn inside a diagram never open from the editor.
    if (a && a.closest('.island.diagram, .preview.diagram, .diagram')) {
      e.preventDefault();
      a = null;
    }
    if (a && a.closest('.preview') && !(e.metaKey || e.ctrlKey || this.readOnly)) {
      e.preventDefault();
      this.hooks.onLinkHint?.();
      return;
    }
    if (a && (e.metaKey || e.ctrlKey || this.readOnly)) {
      e.preventDefault();
      // Once ⌘-click has been used, the hint about it is not shown again (as in Typora).
      if (e.metaKey || e.ctrlKey) this.hooks.onLinkModifierUsed?.();
      if (a.dataset.ref != null) return this.openUndefinedRef(a.dataset.ref);
      this.hooks.onOpenLink?.(a.getAttribute('href'));
      return;
    }
    if (a) this.hooks.onLinkHint?.();
    const fn = e.target.closest?.('.fn-view');
    if (fn) {
      const i = this.doc.findIndex((b) => b.type === 'def' && b.text.startsWith(`[^${fn.dataset.label}]:`));
      if (i >= 0 && (e.metaKey || e.ctrlKey)) return this.focusBlock(i);
      if (i < 0 && (e.metaKey || e.ctrlKey)) return this.showFootnoteTip(fn.closest('.tok'));
    }
    // Clicking a rendered preview moves the caret into its source.
    const island = e.target.closest?.('.island > .preview');
    if (island && !this.readOnly && !e.target.closest('a, button, summary, video, audio, iframe, input')) {
      const i = this.indexOfEl(island.parentElement);
      if (i < 0) return;
      // An HTML block of three or more lines: the caret at the end of its next-to-last
      // line (inside the element, before the closing tag); two lines: the start of the last.
      const b = this.doc[i];
      const lines = b.type === 'html' ? b.text.split('\n') : [];
      if (lines.length >= 3) this.setSel({ i, leaf: 0, off: lines.slice(0, -1).join('\n').length });
      else if (lines.length === 2) this.setSel({ i, leaf: 0, off: lines[0].length + 1 });
      else this.setSel(endOf(this.doc, i));
      return;
    }
    if (e.target.tagName === 'IMG' && !this.readOnly) this.selectImage(e.target);
  }

  // Clicking a picture selects its alt text (the caret sits there when it is empty);
  // for an HTML picture it selects the whole tag. Right-clicking does the same first.
  selectImage(img) {
    const token = img.closest('.tok');
    const leaf = token?.closest('[data-leaf]');
    const pos = leaf && this.toPos(leaf, 0);
    const span = leaf && tokenSpans(leaf).find(([el]) => el === token);
    if (pos && span) {
      const src = leafText(this.doc[pos.i], pos.leaf).slice(span[1], span[2]);
      const alt = /^!\[((?:\[[^\]]*\]|[^[\]])*)\]/.exec(src);
      if (alt) this.setSel({ ...pos, off: span[1] + 2 }, { ...pos, off: span[1] + 2 + alt[1].length });
      else this.setSel({ ...pos, off: span[1] }, { ...pos, off: span[2] });
    }
  }

  // --- footnote tooltips ----------------------------------------------------
  // Hovering a footnote reference (with the caret elsewhere) shows its definition; an
  // undefined one shows how to define it, and its example adds an empty definition.
  // The tooltip goes 0.5 s after the pointer leaves the reference and the tooltip.

  footnoteDef(label) {
    const key = `[^${label}]:`.toLowerCase();
    const i = this.doc.findIndex((b) => b.type === 'def' && b.text.toLowerCase().startsWith(key));
    return i >= 0 ? { i, text: this.doc[i].text.slice(key.length).trim() } : null;
  }

  onFootnoteHover(e) {
    const tok = e.target.closest?.('.tok[data-t="fnref"]');
    if (!tok) return;
    clearTimeout(this.fnTipTimer);
    const anchor = getSelection().anchorNode;
    if (anchor && tok.contains(anchor)) return;
    this.showFootnoteTip(tok);
  }

  onFootnoteLeave(e) {
    if (!e.target.closest?.('.tok[data-t="fnref"]')) return;
    this.hideFootnoteTipSoon();
  }

  hideFootnoteTipSoon() {
    clearTimeout(this.fnTipTimer);
    this.fnTipTimer = setTimeout(() => this.fnTip?.remove(), 500);
  }

  showFootnoteTip(tok) {
    const label = tok.querySelector('.fn-view')?.dataset.label;
    if (label == null) return;
    const def = this.footnoteDef(label);
    if (!def && this.readOnly) return;
    this.fnTip?.remove();
    const tip = document.createElement('div');
    tip.className = 'fn-tip';
    tip.contentEditable = 'false';
    if (def) tip.innerHTML = renderInline(def.text);
    else {
      const safe = esc(label);
      tip.classList.add('warn');
      tip.innerHTML = (this.hooks.labels?.undefinedFootnote || 'Need to define the reference footnote <b>{0}</b> with syntax <a>[^{1}]: www.example.com</a>').replace('{0}', safe).replace('{1}', safe);
      tip.querySelector('a')?.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        tip.remove();
        this.addEmptyFootnoteDef(label);
      });
    }
    tip.addEventListener('mouseenter', () => clearTimeout(this.fnTipTimer));
    tip.addEventListener('mouseleave', () => this.hideFootnoteTipSoon());
    document.body.append(tip);
    const r = tok.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 4))}px`;
    tip.style.top = `${r.bottom + 6}px`;
    this.fnTip = tip;
  }

  // Opening a reference link whose definition is missing: say how to define it and add
  // an empty "[label]: " to fill in (Typora does both).
  openUndefinedRef(label) {
    this.hooks.onNotify?.((this.hooks.labels?.undefinedLink || 'Need to define the reference link <b>[{0}]</b> with syntax <b>[{1}]: www.example.com</b>').replace('{0}', esc(label)).replace('{1}', esc(label)));
    if (!this.readOnly) this.addEmptyDef(label, false);
  }

  addEmptyFootnoteDef(label) {
    this.addEmptyDef(label, true);
  }

  // An empty "[^label]: " (or "[label]: ") goes after the last definition of that kind
  // when it is the last block, otherwise at the end of the document; the caret lands in it.
  addEmptyDef(label, footnote) {
    let last = -1;
    this.doc.forEach((b, k) => { if (b.type === 'def' && b.text.startsWith('[^') === footnote) last = k; });
    // Trailing empty paragraphs do not count as content after the definitions.
    const rest = last >= 0 ? this.doc.slice(last + 1) : [];
    const at = last >= 0 && rest.every((b) => b.type === 'p' && !b.text) ? last + 1 : this.doc.length;
    const text = footnote ? `[^${label}]: ` : `[${label}]: `;
    const doc = splice(this.doc, at, 0, [{ id: uid(), q: 0, indent: 0, type: 'def', text }]);
    this.apply(doc, { i: at, leaf: 0, off: text.length });
  }

  // Double-clicking a picture selects its Markdown (the whole token), so it can be
  // cut, copied or retyped.
  onDoubleClick(e) {
    if (e.target.tagName !== 'IMG') return;
    const token = e.target.closest('.tok');
    const leaf = token?.closest('[data-leaf]');
    const pos = leaf && this.toPos(leaf, 0);
    const span = leaf && tokenSpans(leaf).find(([el]) => el === token);
    if (pos && span) {
      e.preventDefault();
      this.setSel({ ...pos, off: span[1] }, { ...pos, off: span[2] });
    } else this.hooks.onImageOpen?.(e.target);
  }

  // The word under the pointer (for the spelling items of the context menu).
  wordAt(x, y) {
    return this.wordRangeAt(x, y)?.word || null;
  }

  // The word under the pointer and where it sits in the document (for spelling fixes).
  wordRangeAt(x, y) {
    const r = document.caretRangeFromPoint?.(x, y);
    const node = r?.startContainer;
    if (!node || node.nodeType !== 3 || !this.root.contains(node)) return null;
    const text = node.data;
    const word = /[\p{L}\p{N}'’]/u;
    let a = r.startOffset;
    let z = a;
    while (a > 0 && word.test(text[a - 1])) a--;
    while (z < text.length && word.test(text[z])) z++;
    const w = text.slice(a, z);
    if (!/\p{L}/u.test(w)) return null;
    return { word: w, from: this.toPos(node, a), to: this.toPos(node, z) };
  }

  // Replace a range (from a spelling suggestion) as one undoable edit.
  replaceRange(from, to, text) {
    if (!from || !to) return;
    this.setSel(from, to);
    const sel = this.getSel();
    if (sel) this.insertText(text, sel);
  }

  // What is under the pointer, for building a context menu.
  contextAt(e) {
    const el = e.target;
    const bel = el.closest?.('[data-id]');
    const i = bel ? this.indexOfEl(bel) : -1;
    return {
      block: i >= 0 ? this.doc[i] : null,
      index: i,
      link: el.closest?.('a[href]')?.getAttribute('href') || null,
      image: el.tagName === 'IMG' ? el : null,
      emoji: el.closest?.('.tok[data-t="emoji"]')?.querySelector('.emoji-view')?.dataset.emoji || null,
      // The inline math under the pointer, and the media element (for "Save … As…").
      inlineMath: el.closest?.('.tok[data-t="math"]')?.querySelector('.math-view')?.dataset.tex ?? null,
      media: el.closest?.('video, audio') || null,
      word: this.wordAt(e.clientX, e.clientY),
      wordRange: this.wordRangeAt(e.clientX, e.clientY),
      inTable: !!el.closest?.('figure.table'),
      hasSelection: !!this.getSel() && !this.getSel().collapsed,
    };
  }

  // --- selection & scrolling ----------------------------------------------

  onSelectionChange() {
    if (this.composing || this.mouseDown) return;
    const sel = this.getSel();
    if (!sel) return;
    this.lastSel = sel;
    if (this.objectSel != null) this.clearObject();
    // "Display source for simple blocks on focus": the heading with the caret is edited
    // as its Markdown line (# marks included); leaving it parses it again.
    if (this.opts.sourceOnFocus && sel.collapsed && !this.readOnly) {
      const hb = this.doc[sel.focus.i];
      if (hb?.type === 'h' && !hb.setext && !hb.text.includes('\n')) {
        const mark = `${'#'.repeat(hb.level)} `;
        const nb = { id: hb.id, q: hb.q, indent: hb.indent, type: 'p', text: mark + hb.text, srcHeading: true };
        this.doc = splice(this.doc, sel.focus.i, 1, [nb]);
        if (this.history[this.hIndex]) this.history[this.hIndex].doc = this.doc;
        this.render();
        this.setSel({ ...sel.focus, off: sel.focus.off + mark.length });
        return;
      }
    }
    if (this.tempBlock) this.dropTempBlock(sel);
    // Leaving a paragraph (or HTML block) whose text reads as other Markdown blocks
    // turns it into them, so the page shows what the saved file will load as.
    const here = this.doc[sel.focus.i]?.id;
    const left = this.leftBlock;
    this.leftBlock = here;
    if (left && left !== here && this.reparseBlock(left, sel)) return;
    this.updateExpand(sel);
    // Opening a token shows its markers; the caret that stood for the
    // token's outer edge has to move there for real.
    if (sel.collapsed) {
      const now = this.getSel();
      if (now && cmp(now.focus, sel.focus) !== 0) this.setSel(sel.focus);
    }
    this.setFocusBlock(sel.focus.i);
    // Leaving the block that was being typed in ends its undo step.
    if (this.history[this.hIndex]?.id !== this.doc[sel.focus.i]?.id) this.groupClosed = true;
    if (this.typewriter && sel.collapsed) this.centerCaret();
    this.hooks.onSelection?.(sel);
  }

  caretRect() {
    const s = window.getSelection();
    if (!s.rangeCount) return null;
    const r = s.getRangeAt(0);
    const rects = r.getClientRects();
    if (rects.length) return rects[rects.length - 1];
    const node = s.focusNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el ? el.getBoundingClientRect() : null;
  }

  revealCaret() {
    const rect = this.caretRect();
    if (!rect) return;
    const view = this.scroller.getBoundingClientRect();
    const margin = 56;
    if (rect.bottom > view.bottom - margin) this.scroller.scrollBy({ top: rect.bottom - view.bottom + margin });
    else if (rect.top < view.top + margin) this.scroller.scrollBy({ top: rect.top - view.top - margin });
  }

  // Typewriter mode: keep the caret line at the vertical centre.
  centerCaret() {
    // Without the centring option, typewriter mode only keeps the caret in view.
    if (!this.opts.typewriterCenter) return this.revealCaret();
    cancelAnimationFrame(this.centerFrame);
    this.centerFrame = requestAnimationFrame(() => {
      const rect = this.caretRect();
      if (!rect) return;
      const view = this.scroller.getBoundingClientRect();
      const delta = rect.top + rect.height / 2 - (view.top + view.height / 2);
      if (Math.abs(delta) > 2) this.scroller.scrollBy({ top: delta, behavior: 'smooth' });
    });
  }
}

installOps(Editor);
