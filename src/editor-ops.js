// Editor commands: everything a menu item or shortcut can ask the editor to
// do. Each one reads the selection, builds a new block array and hands it to
// Editor#apply, so undo, rendering and change notification come for free.

import { TEXTY, P, mk, cols, leafCount, leafText, withLeaf, leavesOf, sameLeaf, startOf, endOf, splice, normalize, tokenSpans } from './editor.js';
import { renderInline } from './inline.js';
import { serialize, uid, isAlert, sourceLead, parseMarkdown } from './markdown.js';

const RAW = new Set(['code', 'math', 'html', 'meta']);
const NOLEAF = new Set(['hr', 'toc']);

// A Markdown image as the <img> tag Typora writes for it: src, then alt and title only
// when set, with the browser's attribute escaping except for "&". Built in an inert
// document so nothing is fetched.
let inert = null;
function imageTag({ src, alt, title }) {
  inert ||= document.implementation.createHTMLDocument('');
  const el = inert.createElement('img');
  el.setAttribute('src', src);
  if (alt) el.setAttribute('alt', alt);
  if (title) el.setAttribute('title', title);
  return el.outerHTML.replace(/<\/img>$/, '').replace(/\s*>$/, ' />').replace(/&amp;/g, '&');
}

// Markdown source -> the text a reader would see.
export function plainOf(src) {
  const t = document.createElement('template');
  t.innerHTML = renderInline(src);
  // Inline math reads as its TeX source.
  for (const el of t.content.querySelectorAll('.math-view')) el.replaceWith(el.dataset.tex || '');
  for (const el of t.content.querySelectorAll('.mk')) el.remove();
  for (const el of t.content.querySelectorAll('.emoji-view')) el.replaceWith(el.dataset.emoji);
  return t.content.textContent;
}

const ops = {
  // --- helpers ------------------------------------------------------------

  // Block index range covered by the selection.
  blockRange(sel = this.sel()) {
    return sel ? [sel.start.i, sel.end.i] : null;
  },

  keep(sel) {
    return sel && { anchor: sel.anchor, focus: sel.focus };
  },

  // --- inline formatting --------------------------------------------------

  // Wrap or unwrap the selection with an inline marker such as ** or `.
  // A selection over several blocks: `each(text, s, e, k)` rewrites the selected part of
  // each prose block's text and returns [text, newStart, newEnd]; one undo step.
  acrossBlocks(sel, each) {
    let doc = this.doc;
    const { start, end } = sel;
    let a = null;
    let z = null;
    for (let k = start.i; k <= end.i; k++) {
      const b = doc[k];
      if (!TEXTY.has(b.type)) continue;
      const t = b.text;
      const s = k === start.i ? start.off : 0;
      const e = k === end.i ? end.off : t.length;
      if (e <= s) continue;
      const [text, na, nz] = each(t, s, e, k);
      doc = splice(doc, k, 1, [{ ...b, text }]);
      if (!a) a = { i: k, leaf: 0, off: na };
      z = { i: k, leaf: 0, off: nz };
    }
    if (!a) return;
    this.apply(doc, { anchor: a, focus: z });
  },

  toggleInline(open, close = open) {
    const sel = this.sel();
    if (sel && !sameLeaf(sel.start, sel.end)) {
      // Each block gets the style on its selected text (spaces at the edges stay
      // outside the markers); when all of them already have it, it comes off.
      const L = open.length;
      const R = close.length;
      const trimmed = (t, s, e) => {
        while (s < e && /\s/.test(t[s])) s++;
        while (e > s && /\s/.test(t[e - 1])) e--;
        return [s, e];
      };
      const has = (t, s, e) => (e - s >= L + R && t.slice(s, s + L) === open && t.slice(e - R, e) === close) || (s >= L && t.slice(s - L, s) === open && t.slice(e, e + R) === close);
      let all = true;
      for (let k = sel.start.i; k <= sel.end.i; k++) {
        const b = this.doc[k];
        if (!TEXTY.has(b.type)) continue;
        const [s, e] = trimmed(b.text, k === sel.start.i ? sel.start.off : 0, k === sel.end.i ? sel.end.off : b.text.length);
        if (e > s && !has(b.text, s, e)) all = false;
      }
      return this.acrossBlocks(sel, (t, s0, e0) => {
        const [s, e] = trimmed(t, s0, e0);
        if (e <= s) return [t, s0, e0];
        if (all) {
          if (t.slice(s, s + L) === open && t.slice(e - R, e) === close) return [t.slice(0, s) + t.slice(s + L, e - R) + t.slice(e), s, e - L - R];
          return [t.slice(0, s - L) + t.slice(s, e) + t.slice(e + R), s - L, e - L];
        }
        if (has(t, s, e)) return [t, s, e];
        // The new selection takes in the markers, so the same command takes them off again.
        return [t.slice(0, s) + open + t.slice(s, e) + close + t.slice(e), s, e + L + R];
      });
    }
    if (!sel) return;
    const { i, leaf } = sel.start;
    const b = this.doc[i];
    if (RAW.has(b.type) || NOLEAF.has(b.type)) return;
    const t = leafText(b, leaf);
    let s = sel.start.off;
    let e = sel.end.off;
    const caret = sel.collapsed ? s : null;
    // With no selection, act on the styled span the caret is in when it uses these
    // markers (so the style comes off), otherwise on the word at the caret, as Typora does.
    if (s === e) {
      const scope = this.scopeBounds(i, leaf, s);
      if (scope && t.slice(scope[0], scope[0] + open.length) === open && t.slice(scope[1] - close.length, scope[1]) === close && scope[1] - scope[0] >= open.length + close.length) {
        [s, e] = scope;
      } else {
        const [ws, we] = this.wordBounds(t, s);
        if (we > ws && /[\p{L}\p{N}_]/u.test(t.slice(ws, we))) [s, e] = [ws, we];
      }
    }
    const L = open.length;
    const R = close.length;
    // A lone * next to the selection may belong to a ** pair: leave it alone.
    const lone = open !== '*' || ((t.slice(s - 2, s) !== '**' || t.slice(s - 3, s) === '***') && (t.slice(e, e + 2) !== '**' || t.slice(e, e + 3) === '***'));
    let text;
    let a;
    let z;
    if (lone && s >= L && t.slice(s - L, s) === open && t.slice(e, e + R) === close) {
      text = t.slice(0, s - L) + t.slice(s, e) + t.slice(e + R);
      a = s - L;
      z = e - L;
    } else if (e - s >= L + R && t.slice(s, s + L) === open && t.slice(e - R, e) === close) {
      text = t.slice(0, s) + t.slice(s + L, e - R) + t.slice(e);
      a = s;
      z = e - L - R;
    } else {
      text = t.slice(0, s) + open + t.slice(s, e) + close + t.slice(e);
      a = s + L;
      z = e + L;
    }
    // From a bare caret the caret stays a caret, moved along with the text around it.
    if (caret !== null) {
      const unwrapped = text.length < t.length;
      let c = caret;
      if (!unwrapped) c = caret + L;
      else if (a === s - L) c = caret - L; // markers sat outside the word
      else c = caret <= s + L ? s : caret >= e - R ? e - L - R : caret - L;
      return this.apply(splice(this.doc, i, 1, [withLeaf(b, leaf, text)]), { i, leaf, off: c });
    }
    this.apply(splice(this.doc, i, 1, [withLeaf(b, leaf, text)]), { anchor: { i, leaf, off: a }, focus: { i, leaf, off: z } });
  },

  // Replace the selection in the current leaf and put the caret at an
  // offset relative to the inserted text.
  replaceInLeaf(insert, caretFrom = insert.length, caretTo = caretFrom) {
    const sel = this.sel();
    if (!sel || !sameLeaf(sel.start, sel.end)) return false;
    const { i, leaf } = sel.start;
    const b = this.doc[i];
    if (NOLEAF.has(b.type)) return false;
    const t = leafText(b, leaf);
    const text = t.slice(0, sel.start.off) + insert + t.slice(sel.end.off);
    const at = sel.start.off;
    this.apply(splice(this.doc, i, 1, [withLeaf(b, leaf, text)]), { anchor: { i, leaf, off: at + caretFrom }, focus: { i, leaf, off: at + caretTo } });
    return true;
  },

  selectedText() {
    const sel = this.sel();
    return sel && !sel.collapsed ? this.rangeMarkdown(sel) : '';
  },

  insertLink(url = '') {
    // No selection: the word at the caret becomes the label (Typora's Hyperlink command).
    let fromWord = false;
    const cur = this.sel();
    if (cur && cur.collapsed && !this.opts.refLinks) {
      const b = this.doc[cur.focus.i];
      if (!RAW.has(b.type) && !NOLEAF.has(b.type)) {
        const t = leafText(b, cur.focus.leaf);
        const [ws, we] = this.wordBounds(t, cur.focus.off);
        if (we > ws && /[\p{L}\p{N}_]/u.test(t.slice(ws, we))) {
          this.setSel({ ...cur.focus, off: ws }, { ...cur.focus, off: we });
          fromWord = true;
        }
      }
    }
    const label = this.selectedText().replace(/\n/g, ' ');
    // A selected URL becomes the destination rather than the label.
    if (!url && /^(https?:\/\/|www\.)\S+$/.test(label)) return this.replaceInLeaf(`[](${label})`, 1);
    if (this.opts.refLinks) return this.insertLinkRef(url);
    const text = `[${label}](${url})`;
    if (url || !label) return this.replaceInLeaf(text, label ? text.length : 1);
    // The label stays selected; a word taken from the caret leaves the caret after it.
    return fromWord ? this.replaceInLeaf(text, label.length + 1) : this.replaceInLeaf(text, 1, label.length + 1);
  },

  insertImage(src = '', alt = '') {
    const label = alt || this.selectedText().replace(/\n/g, ' ');
    // Format → Image → Insert Image: "![]()" with the caret in the brackets.
    if (!src) return this.replaceInLeaf(`![${label}]()`, 2 + label.length);
    return this.insertImageText(`![${label}](${src})`, true);
  },

  // Put an image's Markdown (or <img> tag) at the caret. A finished picture
  // is set off from the text before it by a space and shows collapsed.
  insertImageText(text, done = true) {
    const sel = this.sel();
    // With the caret in a picture, a new address replaces its own (its alt text is kept
    // and selected).
    const here = sel?.collapsed && this.imageAtCaret?.();
    const src = /^!\[[^\]]*\]\(([^)]*)\)$/.exec(text)?.[1] ?? /^<img\b[^>]*\ssrc="([^"]*)"/.exec(text)?.[1];
    if (here && src != null && !here.isHtml) {
      this.replaceImage(here, `![${here.alt}](${src})`);
      this.selectImagePart?.('alt');
      return true;
    }
    const lead = done && sel && sel.start.off > 0 && !/\s$/.test(leafText(this.doc[sel.start.i], sel.start.leaf).slice(0, sel.start.off)) ? ' ' : '';
    const full = lead + text;
    if (!this.replaceInLeaf(full, done ? full.length : full.length - 1)) return false;
    // The caret rests on the picture it just inserted, so its source shows next to it.
    if (done) {
      const now = this.sel();
      if (now) this.updateExpand(now);
    }
    return true;
  },

  // Strip inline Markdown from the selection (or the whole block).
  clearFormat() {
    const sel = this.sel();
    if (sel && !sameLeaf(sel.start, sel.end)) {
      return this.acrossBlocks(sel, (t, s, e, k) => {
        const el = leavesOf(this.root.children[k])[0];
        for (const [, a, z] of el ? tokenSpans(el) : []) {
          if (a < e && z > s) {
            s = Math.min(s, a);
            e = Math.max(e, z);
          }
        }
        const plain = plainOf(t.slice(s, e));
        return [t.slice(0, s) + plain + t.slice(e), s, s + plain.length];
      });
    }
    if (!sel) return;
    const { i, leaf } = sel.start;
    const b = this.doc[i];
    if (RAW.has(b.type) || NOLEAF.has(b.type)) return;
    const t = leafText(b, leaf);
    let [s, e] = sel.collapsed ? [0, t.length] : [sel.start.off, sel.end.off];
    // Grow the range to whole styled spans, so selecting the word inside
    // **bold** clears the markers around it too.
    const el = leavesOf(this.root.children[i])[leaf];
    for (const [, a, z] of el ? tokenSpans(el) : []) {
      if (a < e && z > s) {
        s = Math.min(s, a);
        e = Math.max(e, z);
      }
    }
    const plain = plainOf(t.slice(s, e));
    this.apply(splice(this.doc, i, 1, [withLeaf(b, leaf, t.slice(0, s) + plain + t.slice(e))]), { anchor: { i, leaf, off: s }, focus: { i, leaf, off: s + plain.length } });
  },

  // --- block types --------------------------------------------------------

  // Change every prose block the selection touches.
  retype(make) {
    const sel = this.sel();
    if (!sel) return;
    const [from, to] = this.blockRange(sel);
    let changed = false;
    const doc = this.doc.map((b, k) => {
      if (k < from || k > to || !TEXTY.has(b.type)) return b;
      const nb = make(b);
      if (!nb) return b;
      changed = true;
      return { id: b.id, q: b.q, indent: b.indent, text: b.text, ...nb };
    });
    if (changed) this.apply(doc, this.keep(sel));
  },

  setHeading(level) {
    // A paragraph with line breaks: only the caret's line becomes the heading; the
    // lines before and after stay paragraphs.
    const sel = this.sel();
    const b = sel && sel.anchor.i === sel.focus.i && this.doc[sel.focus.i];
    if (b && b.type === 'p' && level > 0 && b.text.includes('\n')) {
      const { i, off } = sel.focus;
      const s = b.text.lastIndexOf('\n', off - 1) + 1;
      let e = b.text.indexOf('\n', off);
      if (e < 0) e = b.text.length;
      const head = b.text.slice(0, Math.max(0, s - 1));
      const tail = b.text.slice(e + 1);
      const items = [...(head ? [{ ...b, id: uid(), text: head }] : []), { id: b.id, q: b.q, indent: b.indent, type: 'h', level, text: b.text.slice(s, e) }, ...(tail ? [{ ...b, id: uid(), text: tail }] : [])];
      const at = i + (head ? 1 : 0);
      return this.apply(splice(this.doc, i, 1, items), { i: at, leaf: 0, off: off - s });
    }
    this.retype((x) => {
      if (level === 0 || (x.type === 'h' && x.level === level)) return { type: 'p' };
      // A heading written with an underline keeps that style between levels 1 and 2.
      const setext = x.type === 'h' && typeof x.setext === 'string' && level <= 2 ? (level === 1 ? '=' : '-').repeat(x.setext.length) : undefined;
      return { type: 'h', level, ...(setext ? { setext } : {}) };
    });
  },

  // Typora counts "increase" as towards H1.
  changeHeading(delta) {
    this.retype((b) => {
      const cur = b.type === 'h' ? b.level : 7;
      const next = cur - delta;
      if (next < 1) return null;
      return next > 6 ? { type: 'p' } : { type: 'h', level: next };
    });
  },

  toggleQuote() {
    const sel = this.sel();
    if (!sel) return;
    let [from, to] = this.blockRange(sel);
    const on = this.doc[from].q > 0;
    // Taking the quote off takes it off the whole quote, not just the caret's paragraph.
    if (on) {
      while (from > 0 && this.doc[from - 1].q > 0) from--;
      while (to < this.doc.length - 1 && this.doc[to + 1].q > 0) to++;
    }
    this.apply(this.doc.map((b, k) => (k >= from && k <= to ? { ...b, q: Math.max(0, b.q + (on ? -1 : 1)) } : b)), this.keep(sel));
  },

  // Wrap the selected blocks in a "> [!NOTE]" style callout.
  setAlert(kind) {
    const sel = this.sel();
    if (!sel) return;
    const [from, to] = this.blockRange(sel);
    const first = this.doc[from];
    const label = `[!${kind.toUpperCase()}]`;
    // Inside a callout: switch its kind, or take the label off when it is the same kind.
    let k = from;
    while (k > 0 && this.doc[k].q > 0 && !(this.doc[k].type === 'p' && isAlert(this.doc[k].text))) k--;
    const head0 = this.doc[k];
    if (head0 && head0.q > 0 && head0.type === 'p' && isAlert(head0.text) && this.doc.slice(k, from + 1).every((b) => b.q >= head0.q)) {
      const same = new RegExp(`^\\s*\\[!${kind}\\]`, 'i').test(head0.text);
      const text = same ? head0.text.replace(/\s*\[![a-z]+\]\s*/i, '') : head0.text.replace(/\[![a-z]+\]/i, label);
      if (!text && this.doc[k + 1]?.q >= head0.q) return this.apply(splice(this.doc, k, 1, []), this.keep(sel));
      return this.apply(splice(this.doc, k, 1, [{ ...head0, text }]), this.keep(sel));
    }
    // On text: the selected blocks go inside a new callout, under its label.
    const blocks = this.doc.slice(from, to + 1);
    if (!(from === to && first.type === 'p' && !first.text) && blocks.every((b) => b.type !== 'meta')) {
      const head = mk('p', { text: label }, { q: (first.q || 0) + 1, indent: first.indent });
      const moved = blocks.map((b) => ({ ...b, q: (b.q || 0) + 1 }));
      const down = (p) => ({ ...p, i: p.i + 1 });
      return this.apply(splice(this.doc, from, to - from + 1, [head, ...moved]), { anchor: down(sel.anchor), focus: down(sel.focus) });
    }
    // On an empty paragraph: a new callout there, the caret in its empty first line.
    const q = (first.q || 0) + 1;
    return this.insertSplit([mk('p', { text: label }, { q, indent: first.indent }), mk('p', { text: '' }, { q, indent: first.indent })].map((b) => ({ ...b, _q: q })), { caret: 1 });
  },

  toggleList(kind) {
    const sel = this.sel();
    const cur = sel && this.doc[sel.start.i];
    // Caret in a list item (selection within it): the whole list changes, as in
    // Typora: to the other kind, or back to paragraphs when it already is this kind.
    if (cur && cur.type === 'li' && sel.start.i === sel.end.i) {
      const { q, indent } = cur;
      const inList = (b) => b.q === q && (b.indent > indent || (b.type === 'li' && b.indent === indent));
      let from = sel.start.i;
      while (from > 0 && inList(this.doc[from - 1])) from--;
      let to = sel.start.i;
      while (to < this.doc.length - 1 && inList(this.doc[to + 1])) to++;
      const items = [];
      for (let k = from; k <= to; k++) if (this.doc[k].type === 'li' && this.doc[k].indent === indent) items.push(k);
      const off = items.every((k) => this.doc[k].kind === kind);
      const doc = this.doc.map((b, k) => (!items.includes(k) ? b : off ? { id: b.id, q: b.q, indent: b.indent, text: b.text, type: 'p' } : { ...b, kind, checked: kind === 'task' ? !!b.checked : false }));
      return this.apply(doc, this.keep(sel));
    }
    // A paragraph with line breaks becomes one item per line.
    if (sel) {
      const [from, to] = this.blockRange(sel);
      const range = this.doc.slice(from, to + 1);
      if (range.some((b) => b.type === 'p' && b.text.includes('\n'))) {
        const out = [];
        const where = new Map();
        range.forEach((b, k) => {
          const i = from + k;
          if (b.type === 'p' && b.text.includes('\n')) {
            let at = 0;
            b.text.split('\n').forEach((line, n) => {
              where.set(`${i}:${n}`, { i: from + out.length, start: at, len: line.length });
              out.push({ ...(n === 0 ? { id: b.id } : { id: uid() }), q: b.q, indent: b.indent, type: 'li', kind, checked: false, text: line });
              at += line.length + 1;
            });
            where.set(i, b.text);
          } else {
            where.set(`${i}:0`, { i: from + out.length, start: 0, len: Infinity });
            out.push(TEXTY.has(b.type) ? { ...b, type: 'li', kind, checked: false } : b);
          }
        });
        const map = (p) => {
          const text = where.get(p.i);
          if (typeof text !== 'string') return p.i >= from && p.i <= to ? { ...p, i: where.get(`${p.i}:0`).i } : p.i > to ? { ...p, i: p.i + out.length - range.length } : p;
          const line = text.slice(0, p.off).split('\n').length - 1;
          const w = where.get(`${p.i}:${line}`);
          return { i: w.i, leaf: 0, off: p.off - w.start };
        };
        return this.apply(splice(this.doc, from, range.length, out), { anchor: map(sel.anchor), focus: map(sel.focus) });
      }
    }
    this.retype((b) => (b.type === 'li' && b.kind === kind ? { type: 'p' } : { type: 'li', kind, checked: false }));
  },

  // state: true / false / undefined (toggle)
  setTask(state) {
    const sel = this.sel();
    if (!sel) return;
    const [from, to] = this.blockRange(sel);
    // Toggling sets every task in the selection to the opposite of the caret's item.
    const here = this.doc[sel.focus.i];
    const target = state ?? !(here?.type === 'li' && here.kind === 'task' ? here.checked : this.doc.slice(from, to + 1).find((b) => b.type === 'li' && b.kind === 'task')?.checked);
    this.apply(this.doc.map((b, k) => (k >= from && k <= to && b.type === 'li' && b.kind === 'task' ? { ...b, checked: target } : b)), this.keep(sel));
  },

  // Indent or outdent list items, taking their nested content along.
  indentList(delta) {
    const sel = this.sel();
    if (!sel) return;
    const [from, to] = this.blockRange(sel);
    let doc = this.doc;
    let changed = false;
    for (let i = from; i <= to; i++) {
      const b = doc[i];
      if (b.type !== 'li') continue;
      const prev = doc[i - 1];
      const max = prev && prev.q === b.q ? (prev.type === 'li' ? prev.indent : prev.indent - 1) + 1 : 0;
      const target = Math.max(0, Math.min(max, b.indent + delta));
      if (target === b.indent) continue;
      const end = this.subtreeEnd(i, doc);
      const d = target - b.indent;
      doc = doc.map((x, k) => (k >= i && k < end ? { ...x, indent: x.indent + d } : x));
      changed = true;
      i = Math.max(i, Math.min(end - 1, to));
    }
    if (changed) this.apply(doc, this.keep(sel));
  },

  // Shift+Tab / Outdent: a nested item moves out a level; a top-level item leaves
  // the list as a paragraph (splitting the list there); a quoted paragraph leaves
  // one level of quote; an indented paragraph loses its leading tab or spaces.
  outdent() {
    const sel = this.sel();
    if (!sel) return;
    const [from, to] = this.blockRange(sel);
    const first = this.doc[from];
    if (first.type === 'li' && first.indent > 0) return this.indentList(-1);
    let doc = this.doc;
    let changed = false;
    const shift = { anchor: { ...sel.anchor }, focus: { ...sel.focus } };
    for (let i = from; i <= to; i++) {
      const b = doc[i];
      if (b.type === 'li' && b.indent === 0) {
        doc = splice(doc, i, 1, [{ ...P(b.text, b), id: b.id, indent: 0 }]);
        changed = true;
      } else if ((b.type === 'p' || b.type === 'h') && b.q > 0 && !(b.type === 'p' && b.indent > 0)) {
        doc = splice(doc, i, 1, [{ ...b, q: b.q - 1 }]);
        changed = true;
      } else if (b.type === 'p' && !b.q) {
        // The parser keeps up to three leading spaces in the source only.
        const lead = /^(\t| {1,2})/.exec(b.text)?.[0] ?? (sourceLead(b) ? '' : null);
        if (lead == null) continue;
        doc = splice(doc, i, 1, [{ ...b, text: b.text.slice(lead.length) }]);
        for (const end of ['anchor', 'focus']) if (shift[end].i === i) shift[end].off = Math.max(0, shift[end].off - lead.length);
        changed = true;
      }
    }
    if (changed) this.apply(doc, shift);
  },

  // --- inserting blocks ---------------------------------------------------

  // Insert a block after the current one (or in place of an empty paragraph).
  insertBlockAfter(block, leaf = 0, extra = []) {
    const sel = this.sel();
    const i = sel ? sel.end.i : this.doc.length - 1;
    const cur = this.doc[i];
    const replace = cur.type === 'p' && cur.text === '';
    const at = replace ? i : i + 1;
    const placed = [{ ...block, q: cur.q, indent: cur.indent }, ...extra.map((x) => ({ ...x, q: cur.q, indent: cur.indent }))];
    this.apply(splice(this.doc, at, replace ? 1 : 0, placed), { i: NOLEAF.has(block.type) ? at + 1 : at, leaf, off: 0 });
  },

  insertCode(lang = '') {
    lang = this.codeLang ? this.codeLang(lang) : lang;
    const cur = this.currentBlock();
    // In a code block the command turns it back into text; in a math block it makes
    // the formula a code block.
    if (cur && this.sel().collapsed && cur.b.type === 'code') return this.unwrapRaw(cur.i);
    if (cur && this.sel().collapsed && cur.b.type === 'math') return this.apply(splice(this.doc, cur.i, 1, [{ ...mk('code', { lang: '', text: cur.b.text }, cur.b), id: cur.b.id }]), { i: cur.i, leaf: 0, off: 0 });
    const text = this.selectedText();
    return this.insertSplit([mk('code', { lang, text: text || '' })], { off: (text || '').length });
  },

  insertMath() {
    const sel = this.sel();
    const cur = this.currentBlock();
    if (cur && sel.collapsed && cur.b.type === 'math') return this.unwrapRaw(cur.i);
    if (cur && sel.collapsed && cur.b.type === 'code') return this.apply(splice(this.doc, cur.i, 1, [{ ...mk('math', { text: cur.b.text }, cur.b), id: cur.b.id }]), { i: cur.i, leaf: 0, off: 0 });
    // A selection becomes the formula (its Markdown source).
    // The block goes where the caret is, splitting the paragraph; a selection is
    // taken out and becomes the formula (its Markdown source).
    const text = sel && !sel.collapsed ? this.selectedText() : '';
    return this.insertSplit([mk('math', { text })], { off: text.length });
  },

  // A code or math block back to text: its lines become Markdown again.
  unwrapRaw(i) {
    const b = this.doc[i];
    const blocks = parseMarkdown(b.text || '').map((x, k) => ({ ...x, ...(k === 0 ? { id: b.id } : {}), q: (x.q || 0) + (b.q || 0) }));
    const items = blocks.length ? blocks : [{ ...P('', b), id: b.id }];
    this.apply(splice(this.doc, i, 1, items), startOf(splice(this.doc, i, 1, items), i));
  },

  insertHtml() {
    this.insertBlockAfter(mk('html', { text: '<div>\n\n</div>' }));
  },

  insertTable(nCols = 3, nRows = 2) {
    const row = () => Array(nCols).fill('');
    this.insertBlockAfter(mk('table', { rows: [row(), ...Array.from({ length: nRows }, row)], align: row() }));
  },

  // Insert block(s) the way Typora's Paragraph menu does: a paragraph or heading is
  // split at the caret and the new blocks go between the halves; an empty half is
  // dropped (the second one only when a paragraph follows it). Other blocks get the
  // new ones after them. The caret goes to `caret` (index into `blocks`, or 'next').
  insertSplit(blocks, { caret = 0, leaf = 0, off = 0 } = {}) {
    const sel = this.sel();
    if (!sel) return;
    let { doc } = this;
    let pos = sel.start;
    if (!sel.collapsed) ({ doc, pos } = this.deleted(sel));
    const cur = doc[pos.i];
    const like = ({ _q, ...x }) => ({ ...x, q: _q ?? cur.q, indent: cur.indent });
    let parts;
    let at;
    let n = 1;
    if (cur.type === 'p' || cur.type === 'h') {
      const t = cur.text;
      const prev = { ...cur, text: t.slice(0, pos.off) };
      const next = { ...P(t.slice(pos.off), cur), ...(cur.type === 'h' && t.slice(pos.off) ? { type: 'h', level: cur.level } : {}) };
      const after = doc[pos.i + 1];
      const keepNext = next.text !== '' || !(after && after.type === 'p');
      parts = [...(prev.text !== '' ? [prev] : []), ...blocks.map(like), ...(keepNext ? [next] : [])];
      at = pos.i;
      n = 1;
      const first = pos.i + (prev.text !== '' ? 1 : 0);
      const target = caret === 'next' ? first + blocks.length : first + caret;
      return this.apply(splice(doc, at, n, parts), { i: target, leaf, off });
    }
    at = cur.type === 'li' ? this.subtreeEnd(pos.i, doc) : pos.i + 1;
    const target = caret === 'next' ? at + blocks.length : at + caret;
    return this.apply(splice(doc, at, 0, blocks.map(like)), { i: Math.min(target, doc.length + blocks.length - 1), leaf, off });
  },

  insertHr() {
    this.insertSplit([mk('hr', { raw: '------' })], { caret: 'next' });
  },

  insertToc() {
    this.insertSplit([mk('toc', { raw: '[TOC]' })], { caret: 'next' });
  },

  // Paragraph → Footnotes / Link Reference: an empty definition block at the caret.
  insertFootnoteDef() {
    this.insertSplit([mk('def', { text: '[^]: ' })], { off: 2 });
  },
  insertLinkRefDef() {
    // A selection becomes the reference name (or the address when it looks like a path).
    const picked = this.selectedText().trim().split('\n')[0] || '';
    const text = /[\/\\]/.test(picked) ? `[]: ${picked.slice(0, 160)}` : `[${(picked.split(/\s/)[0] || picked).slice(0, 20)}]: `;
    this.insertSplit([mk('def', { text })], { off: 1 });
  },

  // YAML front matter always lives at the very top.
  insertMeta() {
    if (this.doc[0].type === 'meta') return this.setSel(endOf(this.doc, 0));
    return this.apply([mk('meta', { text: '' }), ...this.doc], { i: 0, leaf: 0, off: 0 });
  },

  insertParagraph(before) {
    const sel = this.sel();
    if (!sel) return;
    const i = before ? sel.start.i : sel.end.i;
    const at = before ? i : this.doc[i].type === 'li' ? this.subtreeEnd(i) : i + 1;
    this.apply(splice(this.doc, at, 0, [P('', this.doc[i])]), { i: at, leaf: 0, off: 0 });
  },

  // Adds "[^n]" at the caret and a matching definition at the end.
  insertFootnote() {
    const sel = this.sel();
    if (!sel || !sameLeaf(sel.start, sel.end)) return;
    const used = new Set();
    for (const b of this.doc) for (const m of (b.text || '').matchAll(/\[\^([^\]\s]+)\]/g)) used.add(m[1]);
    let n = 1;
    while (used.has(String(n))) n++;
    const { i, leaf } = sel.start;
    const b = this.doc[i];
    if (RAW.has(b.type) || NOLEAF.has(b.type)) return;
    const t = leafText(b, leaf);
    const marked = withLeaf(b, leaf, `${t.slice(0, sel.end.off)}[^${n}]${t.slice(sel.end.off)}`);
    this.placeDef(splice(this.doc, i, 1, [marked]), i, `[^${n}]: `);
  },

  // Where a new footnote or link definition goes: the end of the document,
  // of the current section, or right after the current top-level block.
  placeDef(doc, i, text) {
    const where = this.opts.defLocation || 'doc';
    let at = doc.length;
    if (where === 'block') {
      at = i + 1;
      while (at < doc.length && (doc[at].q || doc[at].indent)) at++;
    } else if (where === 'section') {
      at = i + 1;
      while (at < doc.length && doc[at].type !== 'h') at++;
    }
    // Definitions already sitting there stay together, the new one last.
    while (at < doc.length && doc[at].type === 'def') at++;
    const last = doc[doc.length - 1];
    const trail = at === doc.length && last.type === 'p' && last.text === '' && doc.length - 1 !== i ? 1 : 0;
    const next = splice(doc, at - trail, trail, [mk('def', { text })]);
    this.apply(next, endOf(normalize(next), at - trail));
  },

  // Turns the selection into "[text][id]" and adds "[id]: " at the end.
  insertLinkRef(url = '') {
    const sel = this.sel();
    if (!sel || !sameLeaf(sel.start, sel.end)) return;
    const { i, leaf } = sel.start;
    const b = this.doc[i];
    if (RAW.has(b.type) || NOLEAF.has(b.type)) return;
    const t = leafText(b, leaf);
    const label = t.slice(sel.start.off, sel.end.off) || 'link';
    let n = 1;
    const ids = new Set(this.doc.filter((x) => x.type === 'def').map((x) => /^\[([^\]]+)\]/.exec(x.text)?.[1]));
    while (ids.has(`ref${n}`)) n++;
    const marked = withLeaf(b, leaf, `${t.slice(0, sel.start.off)}[${label}][ref${n}]${t.slice(sel.end.off)}`);
    this.placeDef(splice(this.doc, i, 1, [marked]), i, `[ref${n}]: ${url}`);
  },

  // --- tables -------------------------------------------------------------

  currentCell() {
    const sel = this.sel();
    if (!sel) return null;
    const { i, leaf } = sel.focus;
    const b = this.doc[i];
    if (b?.type !== 'table') return null;
    const n = cols(b);
    return { i, b, n, r: Math.floor(leaf / n), c: leaf % n, leaf };
  },

  tableOp(act) {
    const cell = this.currentCell();
    if (!cell) return;
    const { i, b, n, r, c } = cell;
    const blank = () => Array(n).fill('');
    // Moving a row or column keeps the caret where it was in its cell (as Typora does);
    // other changes put it at the start of the target cell.
    const at = this.sel()?.focus.off || 0;
    const set = (rows, align, rr, cc, keepOff = false) => {
      const nb = { ...b, rows, align: align || b.align };
      const width = rows[0].length;
      const leaf = Math.max(0, Math.min(rr, rows.length - 1)) * width + Math.max(0, Math.min(cc, width - 1));
      this.apply(splice(this.doc, i, 1, [nb]), { i, leaf, off: keepOff ? Math.min(at, (rows[Math.min(rr, rows.length - 1)][cc] || '').length) : 0 });
    };
    const swap = (arr, a, z) => {
      const out = arr.slice();
      [out[a], out[z]] = [out[z], out[a]];
      return out;
    };
    const align = (v) => set(b.rows, b.align.map((x, k) => (k === c ? (x === v ? '' : v) : x)), r, c);
    switch (act) {
      case 'rowAbove':
        // Above the header: the new row is the header and the old one becomes the first body row.
        return set([...b.rows.slice(0, r), blank(), ...b.rows.slice(r)], null, r, c);
      case 'rowBelow':
        return set([...b.rows.slice(0, r + 1), blank(), ...b.rows.slice(r + 1)], null, r + 1, c);
      case 'rowDelete':
        // Any row goes while another is left (the next row becomes the header); a table
        // down to its header keeps it.
        if (b.rows.length <= 1) return this.tableOp('tableDelete');
        return set(b.rows.filter((_, k) => k !== r), null, Math.min(r, b.rows.length - 2), c);
      case 'rowUp':
        return r > 0 ? set(swap(b.rows, r, r - 1), null, r - 1, c, true) : null;
      case 'rowDown':
        return r < b.rows.length - 1 ? set(swap(b.rows, r, r + 1), null, r + 1, c, true) : null;
      case 'colBefore':
      case 'colAfter': {
        const at = act === 'colBefore' ? c : c + 1;
        return set(b.rows.map((row) => [...row.slice(0, at), '', ...row.slice(at)]), [...b.align.slice(0, at), '', ...b.align.slice(at)], r, at);
      }
      case 'colDelete':
        // The only column stays (Delete Table removes the table).
        if (n <= 1) return null;
        return set(b.rows.map((row) => row.filter((_, k) => k !== c)), b.align.filter((_, k) => k !== c), r, c);
      case 'colLeft':
        return c > 0 ? set(b.rows.map((row) => swap(row, c, c - 1)), swap(b.align, c, c - 1), r, c - 1, true) : null;
      case 'colRight':
        return c < n - 1 ? set(b.rows.map((row) => swap(row, c, c + 1)), swap(b.align, c, c + 1), r, c + 1, true) : null;
      case 'alignLeft':
        return align('left');
      case 'alignCenter':
        return align('center');
      case 'alignRight':
        return align('right');
      case 'resize':
        return this.hooks.onResizeTable?.();
      case 'tableDelete': {
        const doc = normalize(splice(this.doc, i, 1));
        return this.apply(doc, startOf(doc, Math.min(i, doc.length - 1)));
      }
      default:
        return null;
    }
  },

  tableMarkdown() {
    const cell = this.currentCell();
    return cell ? serialize([{ ...cell.b, q: 0, indent: 0 }]).trimEnd() : '';
  },

  resizeTable(nCols, nRows) {
    const cell = this.currentCell();
    if (!cell) return;
    const { i, b } = cell;
    const rows = Array.from({ length: nRows + 1 }, (_, r) => Array.from({ length: nCols }, (_x, c) => b.rows[r]?.[c] ?? ''));
    const align = Array.from({ length: nCols }, (_, c) => b.align[c] || '');
    this.apply(splice(this.doc, i, 1, [{ ...b, rows, align }]), { i, leaf: 0, off: 0 });
  },

  // Cmd+Enter: a new row in a table, otherwise a new paragraph below.
  modEnter() {
    if (this.currentCell()) return this.tableOp('rowBelow');
    return this.insertParagraph(false);
  },

  // --- whole-block operations ---------------------------------------------

  deleteBlock() {
    const sel = this.sel();
    if (!sel) return;
    const [from, to] = this.blockRange(sel);
    const doc = normalize(splice(this.doc, from, to - from + 1));
    this.apply(doc, startOf(doc, Math.min(from, doc.length - 1)));
  },

  moveBlock(dir) {
    const sel = this.sel();
    if (!sel) return;
    if (this.currentCell()) return this.tableOp(dir < 0 ? 'rowUp' : 'rowDown');
    let [from, to] = this.blockRange(sel);
    // Inside a code block the lines move, not the block.
    if (from === to && this.doc[from].type === 'code') return this.moveCodeLines(dir, sel);
    const { doc } = this;
    // A list item moves with its nested items, past its sibling (and that sibling's
    // nested items). Without a sibling that way, its parent item moves instead.
    let end = to + 1;
    let other = null;
    if (doc[from].type === 'li') {
      for (;;) {
        const b = doc[from];
        end = Math.max(end, this.subtreeEnd(from, doc));
        if (dir < 0) {
          let j = from - 1;
          while (j >= 0 && doc[j].q === b.q && doc[j].indent > b.indent) j--;
          if (j >= 0 && doc[j].type === 'li' && doc[j].q === b.q && doc[j].indent === b.indent) {
            other = [j, from];
            break;
          }
        } else if (doc[end]?.type === 'li' && doc[end].q === b.q && doc[end].indent === b.indent) {
          other = [end, this.subtreeEnd(end, doc)];
          break;
        }
        // No sibling: climb to the parent item, if there is one.
        let p = from - 1;
        while (p >= 0 && !(doc[p].type === 'li' && doc[p].q === b.q && doc[p].indent < b.indent)) {
          if (doc[p].q !== b.q || (doc[p].type !== 'li' && doc[p].indent < b.indent)) p = 0;
          p--;
        }
        if (b.indent === 0 || p < 0) break;
        from = p;
      }
    }
    if (!other) {
      const target = dir < 0 ? from - 1 : end;
      if (target < 0 || target >= doc.length) return;
      other = [target, target + 1];
    }
    const moving = doc.slice(from, end);
    const between = doc.slice(other[0], other[1]);
    const next = dir < 0
      ? [...doc.slice(0, other[0]), ...moving, ...between, ...doc.slice(end)]
      : [...doc.slice(0, from), ...between, ...moving, ...doc.slice(other[1])];
    const delta = dir < 0 ? other[0] - from : between.length;
    const shift = (p) => (p.i >= from && p.i < end ? { ...p, i: p.i + delta } : p);
    this.apply(next, { anchor: shift(sel.anchor), focus: shift(sel.focus) });
  },

  // Alt+Up / Alt+Down in a code block: the lines the selection touches swap with the
  // line above or below, and the selection moves with them.
  moveCodeLines(dir, sel) {
    const { i } = sel.focus;
    const b = this.doc[i];
    const text = b.text;
    const lo = Math.min(sel.anchor.off, sel.focus.off);
    const hi = Math.max(sel.anchor.off, sel.focus.off);
    const start = text.lastIndexOf('\n', lo - 1) + 1;
    let stop = text.indexOf('\n', hi > lo && text[hi - 1] === '\n' ? hi - 1 : hi);
    if (stop < 0) stop = text.length;
    const block = text.slice(start, stop);
    let out;
    let moved;
    if (dir < 0) {
      if (start === 0) return;
      const prevStart = text.lastIndexOf('\n', start - 2) + 1;
      const prev = text.slice(prevStart, start - 1);
      out = text.slice(0, prevStart) + block + '\n' + prev + text.slice(stop);
      moved = -(prev.length + 1);
    } else {
      if (stop >= text.length) return;
      let nextStop = text.indexOf('\n', stop + 1);
      if (nextStop < 0) nextStop = text.length;
      const nxt = text.slice(stop + 1, nextStop);
      out = text.slice(0, start) + nxt + '\n' + block + text.slice(nextStop);
      moved = nxt.length + 1;
    }
    const at = (p) => ({ ...p, off: p.off + moved });
    this.apply(splice(this.doc, i, 1, [{ ...b, text: out }]), { anchor: at(sel.anchor), focus: at(sel.focus) });
  },

  duplicateBlock() {
    const sel = this.sel();
    if (!sel) return;
    const [from, to] = this.blockRange(sel);
    const copy = this.doc.slice(from, to + 1).map((b) => ({ ...b, id: uid() }));
    this.apply(splice(this.doc, to + 1, 0, copy), endOf(splice(this.doc, to + 1, 0, copy), to + copy.length));
  },

  // --- selection helpers --------------------------------------------------

  // [start, end) of the line (bounded by newlines) around an offset.
  lineBounds(text, off) {
    const s = text.lastIndexOf('\n', off - 1) + 1;
    const e = text.indexOf('\n', off);
    return [s, e < 0 ? text.length : e];
  },

  wordBounds(text, off) {
    const word = (c) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
    // An apostrophe between letters (don't) or a dot between letters or digits (e.g, 3.14)
    // belongs to the word.
    const inner = (k) => /['’.]/.test(text[k] || '') && word(text[k - 1]) && word(text[k + 1]);
    const cls = (c, k) => (c === undefined ? 0 : word(c) || inner(k) ? 1 : /\s/.test(c) ? 2 : 3);
    const kind = cls(text[off], off) === 1 || cls(text[off - 1], off - 1) !== 1 ? cls(text[off], off) : 1;
    let s = off;
    let e = off;
    if (kind === 0 || cls(text[off], off) !== kind) {
      // Caret sits just after a word.
      while (s > 0 && cls(text[s - 1], s - 1) === 1) s--;
      return [s, e];
    }
    while (s > 0 && cls(text[s - 1], s - 1) === kind) s--;
    while (e < text.length && cls(text[e], e) === kind) e++;
    return [s, e];
  },

  // The sentence around an offset in prose: up to and including its end mark
  // (. ! ? 。 ！ ？ …) and closing quotes; a line break also ends one.
  // withSpace: the spaces after it too (for deleting).
  sentenceBounds(text, off, withSpace = false) {
    const re = /[^.!?。！？…\n]*(?:[.!?。！？…]+["'”’)\]]*|\n|$)\s*/gu;
    let m;
    while ((m = re.exec(text))) {
      const s = m.index;
      let e = s + m[0].length;
      if (off >= s && (off < e || e >= text.length)) {
        if (!withSpace) while (e > s && /\s/.test(text[e - 1])) e--;
        return [s, e];
      }
      if (!m[0]) break;
    }
    return [off, off];
  },

  selectIn(fn) {
    const sel = this.sel();
    if (!sel) return;
    const { i, leaf, off } = sel.focus;
    const b = this.doc[i];
    if (NOLEAF.has(b.type)) return;
    const [s, e] = fn(leafText(b, leaf), off, i, leaf);
    this.setSel({ i, leaf, off: s }, { i, leaf, off: e });
  },

  selectWord() {
    // A link address, emoji or escape is selected whole.
    this.selectIn((t, off, i, leaf) => {
      const el = leavesOf(this.root.children[i])[leaf];
      const tok = el && tokenSpans(el).find(([tk, a, z]) => ['url', 'emoji', 'escape', 'entity'].includes(tk.dataset.t) && a <= off && z >= off && z > a);
      return tok ? [tok[1], tok[2]] : this.wordBounds(t, off);
    });
  },

  // Select Line / Sentence: the sentence in prose, the line in code, the row in a table.
  selectLine() {
    const sel = this.sel();
    if (!sel) return;
    const { i, leaf } = sel.focus;
    const b = this.doc[i];
    if (b.type === 'table') {
      const n = cols(b);
      const r0 = Math.floor(leaf / n) * n;
      return this.setSel({ i, leaf: r0, off: 0 }, { i, leaf: r0 + n - 1, off: leafText(b, r0 + n - 1).length });
    }
    this.selectIn((t, off) => (RAW.has(b.type) ? this.lineBounds(t, off) : this.sentenceBounds(t, off)));
  },

  // The innermost styled span (bold, link, code…) around the caret.
  scopeBounds(i, leaf, off) {
    const el = leavesOf(this.root.children[i])[leaf];
    const spans = el ? tokenSpans(el).filter(([, a, z]) => a <= off && z >= off) : [];
    if (!spans.length) return null;
    const [, a, z] = spans.reduce((best, cur) => (cur[2] - cur[1] < best[2] - best[1] ? cur : best));
    return [a, z];
  },

  selectScope() {
    this.selectIn((t, off, i, leaf) => this.scopeBounds(i, leaf, off) || this.wordBounds(t, off));
  },

  selectBlock() {
    const sel = this.sel();
    if (!sel) return;
    const [from, to] = this.blockRange(sel);
    this.setSel(startOf(this.doc, from), endOf(this.doc, to));
  },

  selectAll() {
    this.setSel(startOf(this.doc, 0), endOf(this.doc, this.doc.length - 1));
  },

  deleteIn(fn) {
    const sel = this.sel();
    if (!sel) return;
    if (!sel.collapsed) return this.deleteRange(sel);
    const { i, leaf, off } = sel.focus;
    const b = this.doc[i];
    if (NOLEAF.has(b.type)) return;
    const t = leafText(b, leaf);
    const [s, e] = fn(t, off, i, leaf);
    if (s === e) return;
    this.apply(splice(this.doc, i, 1, [withLeaf(b, leaf, t.slice(0, s) + t.slice(e))]), { i, leaf, off: s });
  },

  deleteWord() {
    this.deleteIn((t, off) => this.wordBounds(t, off));
  },

  // Delete Line / Sentence removes what Select Line / Sentence selects; the line break stays.
  // Delete Line / Sentence: the sentence in prose, the whole line (with its line
  // break) in code, the row in a table, the block itself when it is empty.
  deleteLine() {
    const sel = this.sel();
    if (!sel) return;
    const { i } = sel.focus;
    const b = this.doc[i];
    if (sel.collapsed && b.type === 'table') return this.tableOp('rowDelete');
    if (sel.collapsed && TEXTY.has(b.type) && b.text === '' && this.doc.length > 1) {
      const doc = normalize(splice(this.doc, i, 1));
      return this.apply(doc, startOf(doc, Math.min(i, doc.length - 1)));
    }
    this.deleteIn((t, off) => {
      if (!RAW.has(b.type)) return this.sentenceBounds(t, off, true);
      let [s, e] = this.lineBounds(t, off);
      if (e < t.length) e++;
      else if (s > 0) s--;
      return [s, e];
    });
  },

  deleteScope() {
    this.deleteIn((t, off, i, leaf) => this.scopeBounds(i, leaf, off) || this.wordBounds(t, off));
  },

  jump(where) {
    const sel = this.sel();
    if (where === 'top') {
      this.setSel(startOf(this.doc, 0));
      this.scroller.scrollTo({ top: 0 });
    } else if (where === 'bottom') {
      this.setSel(endOf(this.doc, this.doc.length - 1));
      this.scroller.scrollTo({ top: this.scroller.scrollHeight });
    } else if (where === 'selection' && sel) {
      this.setSel(sel.anchor, sel.focus);
      // The caret's line comes to rest 20px below the top of the view.
      const range = window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null;
      const box = (range && range.getClientRects()[0]) || this.root.children[sel.focus.i]?.getBoundingClientRect();
      if (box) this.scroller.scrollTo({ top: this.scroller.scrollTop + box.top - this.scroller.getBoundingClientRect().top - 20, behavior: 'smooth' });
    } else if (sel && (where === 'lineStart' || where === 'lineEnd')) {
      // Code and front matter: the line. A table: the row's first or last cell.
      // Prose: the start or end of the whole block.
      const { i, leaf, off } = sel.focus;
      const b = this.doc[i];
      const start = where === 'lineStart';
      if (b.type === 'table') {
        const n = cols(b);
        const cell = Math.floor(leaf / n) * n + (start ? 0 : n - 1);
        return this.setSel({ i, leaf: cell, off: start ? 0 : leafText(b, cell).length });
      }
      const t = leafText(b, leaf);
      const [s, e] = RAW.has(b.type) ? this.lineBounds(t, off) : [0, t.length];
      this.setSel({ i, leaf, off: start ? s : e });
    }
  },

  // --- code & images ------------------------------------------------------

  // The caret on a picture: select its alt text, or its address.
  selectImagePart(part) {
    const sel = this.sel();
    if (!sel) return;
    const { i, leaf, off } = sel.focus;
    const el = leavesOf(this.root.children[i])[leaf];
    const span = el && tokenSpans(el).find(([tk, a, z]) => tk.dataset.t === 'image' && a <= off && z >= off);
    if (!span) return;
    const src = leafText(this.doc[i], leaf).slice(span[1], span[2]);
    const m = /^!\[((?:\[[^\]]*\]|[^[\]])*)\]\(\s*<?([^)\s>]*)/.exec(src);
    if (!m) return;
    const altAt = span[1] + 2;
    const srcAt = span[1] + src.indexOf('](') + 2 + (src[src.indexOf('](') + 2] === '<' ? 1 : 0);
    if (part === 'alt') this.setSel({ i, leaf, off: altAt }, { i, leaf, off: altAt + m[1].length });
    else this.setSel({ i, leaf, off: srcAt }, { i, leaf, off: srcAt + m[2].length });
  },

  currentBlock() {
    const sel = this.sel();
    return sel ? { i: sel.focus.i, b: this.doc[sel.focus.i] } : null;
  },

  // The caret's block and the inline styles around it (for menu checkmarks).
  caretState() {
    const sel = this.sel();
    if (!sel) return null;
    const b = this.doc[sel.focus.i];
    const styles = new Set();
    const node = window.getSelection().focusNode;
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    const TAGS = { strong: 'strong', b: 'strong', em: 'em', i: 'em', u: 'underline', del: 'strike', s: 'strike', mark: 'highlight', sup: 'sup', sub: 'sub', code: 'code' };
    while (el && el !== this.root && this.root.contains(el) && !el.classList?.contains('b')) {
      if (el.classList?.contains('tok')) styles.add({ math: 'inlineMath', del: 'strike', mark: 'highlight', url: 'link' }[el.dataset.t] || el.dataset.t);
      const tag = TAGS[el.tagName?.toLowerCase()];
      if (tag) styles.add(tag);
      el = el.parentElement;
    }
    return { b, styles, collapsed: sel.collapsed };
  },

  // Re-indent a code block (or only its selected lines) by bracket depth.
  autoIndentCode(selectedOnly = false) {
    const cur = this.currentBlock();
    if (!cur || cur.b.type !== 'code') return;
    const sel = this.sel();
    const text = cur.b.text;
    let from = 0;
    let to = Infinity;
    if (selectedOnly && sel && sel.start.i === cur.i && sel.end.i === cur.i) {
      from = text.slice(0, sel.start.off).split('\n').length - 1;
      to = text.slice(0, sel.end.off).split('\n').length - 1;
    }
    const unit = this.opts.codeIndent ? ' '.repeat(this.opts.codeIndent) : '\t';
    let depth = 0;
    const out = text.split('\n').map((line, n) => {
      const t = line.trim();
      if (/^[}\])]/.test(t)) depth = Math.max(0, depth - 1);
      const res = t ? unit.repeat(depth) + t : '';
      const opens = (t.match(/[{[(]/g) || []).length;
      const closes = (t.match(/[}\])]/g) || []).length - (/^[}\])]/.test(t) ? 1 : 0);
      depth = Math.max(0, depth + opens - closes);
      return n >= from && n <= to ? res : line;
    }).join('\n');
    if (out !== text) this.apply(splice(this.doc, cur.i, 1, [{ ...cur.b, text: out }]), endOf(splice(this.doc, cur.i, 1, [{ ...cur.b, text: out }]), cur.i));
  },

  // Shift+Tab in a code block: take one level of indentation off the
  // selected lines.
  // Tab with a selection in code: every line the selection touches gains one
  // indent step (the code indent width in spaces, or a tab for "preserve tabs").
  indentCodeLines() {
    const cur = this.currentBlock();
    const sel = this.sel();
    if (!cur || cur.b.type !== 'code' || !sel) return;
    const text = cur.b.text;
    const unit = this.opts.codeIndent ? ' '.repeat(this.opts.codeIndent) : '\t';
    const a = sel.start.i === cur.i ? sel.start.off : 0;
    const z = sel.end.i === cur.i ? sel.end.off : text.length;
    const first = text.lastIndexOf('\n', a - 1) + 1;
    // A selection that ends at the very start of a line leaves that line alone.
    const last = z > a && text[z - 1] === '\n' ? z - 1 : z;
    let pos = 0;
    let na = a;
    let nz = z;
    const out = text.split('\n').map((line) => {
      const start = pos;
      pos += line.length + 1;
      if (start < first || start > last) return line;
      if (start < a) na += unit.length;
      if (start < z) nz += unit.length;
      return unit + line;
    }).join('\n');
    this.apply(splice(this.doc, cur.i, 1, [{ ...cur.b, text: out }]), { anchor: { i: cur.i, leaf: 0, off: na }, focus: { i: cur.i, leaf: 0, off: nz } });
  },

  outdentCode() {
    const cur = this.currentBlock();
    const sel = this.sel();
    if (!cur || cur.b.type !== 'code' || !sel) return;
    const text = cur.b.text;
    const width = this.opts.codeIndent || 4;
    const a = sel.start.i === cur.i ? sel.start.off : 0;
    const z = sel.end.i === cur.i ? sel.end.off : text.length;
    const first = text.lastIndexOf('\n', a - 1) + 1;
    const lead = new RegExp(`^(\\t| {1,${width}})`);
    let pos = 0;
    let na = a;
    let nz = z;
    const out = text.split('\n').map((line) => {
      const start = pos;
      pos += line.length + 1;
      if (start < first || start > z) return line;
      const m = lead.exec(line);
      if (!m) return line;
      const cut = m[0].length;
      if (start < a) na -= Math.min(cut, a - start);
      if (start < z) nz -= Math.min(cut, z - start);
      return line.slice(cut);
    }).join('\n');
    if (out === text) return;
    this.apply(splice(this.doc, cur.i, 1, [{ ...cur.b, text: out }]), { anchor: { i: cur.i, leaf: 0, off: na }, focus: { i: cur.i, leaf: 0, off: nz } });
  },

  // Upper case, lower case or capitalised words for the selection (or the
  // word under the caret).
  transformCase(kind) {
    const sel = this.sel();
    if (!sel || !sameLeaf(sel.start, sel.end)) return;
    const { i, leaf } = sel.start;
    const b = this.doc[i];
    if (NOLEAF.has(b.type)) return;
    const t = leafText(b, leaf);
    let [s, e] = [sel.start.off, sel.end.off];
    if (s === e) [s, e] = this.wordBounds(t, s);
    const part = t.slice(s, e);
    const out = kind === 'upper' ? part.toUpperCase() : kind === 'lower' ? part.toLowerCase() : part.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, pre, ch) => pre + ch.toUpperCase());
    if (out === part) return;
    this.apply(splice(this.doc, i, 1, [withLeaf(b, leaf, t.slice(0, s) + out + t.slice(e))]), { anchor: { i, leaf, off: s }, focus: { i, leaf, off: s + out.length } });
  },

  // The image token under the caret: { i, leaf, from, to, src, alt, html }.
  // The image token at the caret, or the one that holds `imgEl` (a right-clicked picture).
  imageAtCaret(imgEl = null) {
    let i, leaf, el, hit;
    if (imgEl) {
      const tok = imgEl.closest('.tok');
      el = tok?.closest('[data-leaf]');
      const bel = el?.closest('[data-id]');
      if (!bel) return null;
      i = this.indexOfEl(bel);
      leaf = leavesOf(bel).indexOf(el);
      hit = tokenSpans(el).find(([t]) => t === tok);
    } else {
      const sel = this.sel();
      if (!sel) return null;
      ({ i, leaf } = sel.focus);
      const { off } = sel.focus;
      el = this.root.children[i] && leavesOf(this.root.children[i])[leaf];
      if (!el) return null;
      hit = tokenSpans(el).find(([t, a, z]) => t.dataset.t === 'image' && a <= off && z >= off);
    }
    if (!hit) return null;
    const text = leafText(this.doc[i], leaf).slice(hit[1], hit[2]);
    const md = /^!\[([^\]]*)\]\((\S*?)(?:\s+(["'(])(.*)["')])?\)$/.exec(text);
    const tag = /src\s*=\s*["']?([^"'\s>]+)/i.exec(text);
    return {
      i, leaf, from: hit[1], to: hit[2], text, el: hit[0],
      src: md ? md[2] : tag ? tag[1] : '',
      alt: md ? md[1] : /alt\s*=\s*["']([^"']*)/i.exec(text)?.[1] || '',
      title: md ? md[4] || '' : /title\s*=\s*["']([^"']*)/i.exec(text)?.[1] || '',
      isHtml: !md,
    };
  },

  replaceImage(img, text) {
    const b = this.doc[img.i];
    const t = leafText(b, img.leaf);
    this.apply(splice(this.doc, img.i, 1, [withLeaf(b, img.leaf, t.slice(0, img.from) + text + t.slice(img.to))]), { i: img.i, leaf: img.leaf, off: img.from + text.length });
  },

  // Zoom is kept as a `zoom` declaration in the picture's <img> tag, as Typora writes it:
  // a Markdown image is rewritten as a tag first; an existing style attribute is
  // re-serialised by the browser ("zoom: 33%;"), a missing one gets `style="zoom:50%;"`.
  // 100% removes the declaration and leaves the tag a tag; on a Markdown image it does
  // nothing. Only a picture that has loaded can be zoomed. The new tag ends up selected.
  zoomImage(factor, imgEl = null) {
    const img = this.imageAtCaret(imgEl);
    const pic = img?.el?.querySelector('img');
    if (!img || !pic || !pic.complete || !pic.naturalWidth) return false;
    const raw = String(factor).trim();
    const value = raw === '100%' ? '' : raw;
    if (!value && !img.isHtml) return false;
    let text = img.isHtml ? img.text : imageTag(img);
    let styled = false;
    text = text.replace(/(style\s*=\s*)(['"])(.*?)\2/, (all, lead, quote, css) => {
      styled = true;
      const probe = document.createElement('img');
      probe.setAttribute('style', css || '');
      probe.style.zoom = value;
      const out = probe.getAttribute('style');
      return out ? lead + JSON.stringify(out) : '';
    });
    if (!styled) text = text.replace(/(\s*\/?>)/, ` style="zoom:${value};" $1`).replace(/\s+\/>$/, ' />');
    const b = this.doc[img.i];
    const t = leafText(b, img.leaf);
    this.apply(splice(this.doc, img.i, 1, [withLeaf(b, img.leaf, t.slice(0, img.from) + text + t.slice(img.to))]),
      { anchor: { i: img.i, leaf: img.leaf, off: img.from }, focus: { i: img.i, leaf: img.leaf, off: img.from + text.length } });
    return true;
  },

  switchImageSyntax(imgEl = null) {
    const img = this.imageAtCaret(imgEl);
    if (!img) return;
    this.replaceImage(img, img.isHtml ? `![${img.alt}](${img.src})` : imageTag(img));
  },

  setImageSyntax(html, imgEl = null) {
    const img = this.imageAtCaret(imgEl);
    if (img && img.isHtml !== html) this.switchImageSyntax(imgEl);
  },

  // Replaces the text of a raw block (code, say), or just a range of it.
  setBlockText(i, text, from = 0, to = null) {
    const b = this.doc[i];
    if (!b || !('text' in b)) return;
    const end = to ?? b.text.length;
    const next = b.text.slice(0, from) + text + b.text.slice(end);
    this.apply(splice(this.doc, i, 1, [{ ...b, text: next }]), { i, leaf: 0, off: from + text.length });
  },

  deleteImage(imgEl = null) {
    const img = this.imageAtCaret(imgEl);
    if (img) this.replaceImage(img, '');
  },

  // --- find & replace -----------------------------------------------------

  // Matches are found in the Markdown source of each leaf.
  findAll(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
    if (!query) return [];
    let re;
    try {
      const src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])` : src, `gu${caseSensitive ? '' : 'i'}`);
    } catch {
      return [];
    }
    const out = [];
    this.doc.forEach((b, i) => {
      for (let leaf = 0; leaf < leafCount(b); leaf++) {
        const t = leafText(b, leaf);
        re.lastIndex = 0;
        for (let m = re.exec(t); m; m = re.exec(t)) {
          if (m[0] === '') {
            re.lastIndex++;
            continue;
          }
          out.push({ i, leaf, from: m.index, to: m.index + m[0].length, groups: [...m] });
          if (out.length > 5000) return;
        }
      }
    });
    return out;
  },

  selectMatch(m) {
    this.setSel({ i: m.i, leaf: m.leaf, off: m.from }, { i: m.i, leaf: m.leaf, off: m.to });
    const rect = this.caretRect();
    const view = this.scroller.getBoundingClientRect();
    if (rect && (rect.top < view.top + 90 || rect.bottom > view.bottom - 60)) {
      this.scroller.scrollBy({ top: rect.top - view.top - view.height / 3 });
    }
  },

  // DOM ranges for a list of matches, for painting highlights.
  matchRanges(matches) {
    const out = [];
    for (const m of matches) {
      const bel = this.root.children[m.i];
      if (!bel || bel.offsetParent === null) continue;
      const a = this.toDom({ i: m.i, leaf: m.leaf, off: m.from });
      const z = this.toDom({ i: m.i, leaf: m.leaf, off: m.to });
      try {
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(z.node, z.offset);
        out.push(r);
      } catch {
        /* a stale match; the next search refresh drops it */
      }
    }
    return out;
  },

  expandReplacement(m, replacement, regex) {
    return regex ? replacement.replace(/\$(\d)/g, (_, n) => m.groups[Number(n)] ?? '') : replacement;
  },

  replaceMatch(m, replacement, regex = false) {
    const b = this.doc[m.i];
    const t = leafText(b, m.leaf);
    const text = this.expandReplacement(m, replacement, regex);
    this.apply(splice(this.doc, m.i, 1, [withLeaf(b, m.leaf, t.slice(0, m.from) + text + t.slice(m.to))]), { i: m.i, leaf: m.leaf, off: m.from + text.length });
  },

  replaceAll(matches, replacement, regex = false) {
    if (!matches.length) return 0;
    const doc = this.doc.slice();
    // Back to front, so earlier offsets in the same leaf stay valid.
    for (const m of [...matches].reverse()) {
      const b = doc[m.i];
      const t = leafText(b, m.leaf);
      doc[m.i] = withLeaf(b, m.leaf, t.slice(0, m.from) + this.expandReplacement(m, replacement, regex) + t.slice(m.to));
    }
    this.apply(doc, this.keep(this.sel()) && startOf(doc, matches[0].i));
    return matches.length;
  },
};

export function installOps(Editor) {
  Object.assign(Editor.prototype, ops);
}
