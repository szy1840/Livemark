// Markdown text <-> flat block list.
//
// The document is a flat array of blocks, never a tree. Nesting is carried
// by two numbers on every block:
//   q       how many blockquote levels the block sits in
//   indent  how many list levels deep it is. For a list item this is its own
//           level; for any other block, indent > 0 means "content of the
//           list item above it".
// That keeps every editing operation (split, merge, indent, quote) an array
// splice, while still round-tripping nested quotes, nested lists and list
// items holding several paragraphs or code blocks.
//
// Block types:
//   p, h{level}, li{kind,checked,start?}, code{lang}, math, html, def, meta
//   (all with `text`), table{rows,align}, hr, toc.

let seq = 0;
export const uid = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
// A math block opens with $$ (optionally followed by an attribute such as {#eq1} or
// {(1.1)}) or with the LaTeX \[ form; the closing line matches the opening one.
const MATH_OPEN = /^ {0,3}(?:\$\$\s*(\{[^{}]*\})?|\\\[)\s*$/;
const MATH_CLOSE_DOLLAR = /^ {0,3}\$\$\s*(\{[^{}]*\})?\s*$/;
const MATH_CLOSE_BRACKET = /^ {0,3}\\\]\s*$/;
const MATH_LINE = /^ {0,3}\$\$(.+)\$\$\s*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( +|\t|$)(.*)$/;
const TASK = /^\[([ xX])\](?:\s+(.*)|$)/;
const TOC = /^ {0,3}\[toc\]\s*$/i;
const DEF = /^ {0,3}\[\^?[^\]\s][^\]]*\]:\s*\S/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
// The tags that open an HTML block, as Typora lists them; every other tag (inline ones,
// closing tags, comments, <br>, <source>, …) stays inside a paragraph.
const HTML_OPEN = /^ {0,3}<(!DOCTYPE|div|p|h[1-6]|table|figure|details|left|right|center|footer|header|nav|ol|ul|article|address|dl|applet|map|aside|audio|bdo|blockquote|form|select|dialog|picture|embed|object|iframe|main|pre|section|svg|textarea|video|template|head|canvas|base|datalist|meta|script|style|noscript|title|menu|hr)(?:\/|>|\s|$)/i;
// How deep a line leaves the nesting of one tag name: opening tags count up, closing
// tags down, self-closed ones not at all (the pattern is Typora's, prefix matches included).
const TAG_REG = new Map();
function tagDepth(tag, line, depth) {
  let re = TAG_REG.get(tag);
  if (!re) {
    re = new RegExp(`(?:<${tag}(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\u0000-\\u0020]+|'[^']*'|"[^"]*"))?)*\\s*(\\/?)>?|<(\\/)${tag}\\s*[>])`, 'i');
    TAG_REG.set(tag, re);
  }
  let rest = line;
  let m;
  while ((m = re.exec(rest))) {
    rest = rest.slice(m.index + m[0].length);
    if (m[2]) depth--;
    else if (!m[1]) depth++;
  }
  return depth;
}
export const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

// Dialect switches, set from the Markdown page of the settings.
export const mdOptions = { strict: true, headingStyle: 'atx', ulMarker: '-', olMarker: '.', olStyle: 'increment', alerts: true, remapPunct: false, indent: 2, prettyIndent: false };
// Outside strict mode "#Heading" counts as a heading too.
const LOOSE_HEADING = /^ {0,3}(#{1,6})(?!#)\s*(\S.*?)?(\s+#+)?\s*$/;
export const isAlert = (text) => mdOptions.alerts && ALERT.test(text);
// Full-width punctuation typed with a CJK input method, read as the ASCII
// markers it stands for.
const remap = (line) => line
  .replace(/^(\s*)([》＞]+)[ \u3000]?/, (_, sp, q) => sp + '> '.repeat(q.length))
  .replace(/^(\s*)(＃{1,6})[ \u3000]+/, (_, sp, h) => `${sp}${'#'.repeat(h.length)} `)
  .replace(/^(\s*)[－＊＋][ \u3000]+/, '$1- ')
  .replace(/^(\s*)([０-９\d]+)[．。][ \u3000]+/, (_, sp, n) => `${sp}${n.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))}. `)
  .replace(/(\]\([^)\s]+\s+)[‘’“”]([^)]*?)[‘’“”]\)/g, '$1"$2")');

const lead = (l) => /^[ \t]*/.exec(l)[0].replace(/\t/g, '    ').length;
const startsBlock = (l) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l) || MATH_OPEN.test(l);

export function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

// Where each parsed block came from: block object -> { lines, start, end }
// (a range of the original source lines), later also `seq` and `ord`. Blocks
// are immutable, so any edit makes a new object that is not in this map:
// only blocks nobody touched can be written back exactly as they were.
const SRC = new WeakMap();
const hardBreak = (l) => / {2,}$/.test(l || '');

// `map[k]` is the original line number of lines[k]; `base` is the column at
// which this container's content starts (after any quote prefix).
function blocks(lines, q, indent, out, map, ctx, base) {
  let para = null;
  // Last line of the most recent HTML block, and where each one began (for merging).
  let htmlEnd = -2;
  const SRC_START = new Map();
  const mark = (blk, a, z) => {
    SRC.set(blk, { lines: ctx.orig, start: map[a], end: map[Math.max(a, Math.min(z, lines.length - 1))] });
    return blk;
  };
  const push = (b) => {
    para = null;
    const blk = { id: uid(), q, indent, ...b };
    out.push(blk);
    return blk;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const i0 = i;
    let m;

    if ((m = FENCE.exec(line))) {
      const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}\\s*$`);
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      mark(push({ type: 'code', lang: m[2].trim(), text: body.join('\n'), ...(m[1] === '```' ? {} : { fence: m[1] }) }), i0, i);
      continue;
    }

    if ((m = MATH_LINE.exec(line))) {
      mark(push({ type: 'math', text: m[1].trim() }), i0, i0);
      continue;
    }
    if ((m = MATH_OPEN.exec(line))) {
      const legacy = /^ {0,3}\\\[/.test(line);
      const close = legacy ? MATH_CLOSE_BRACKET : MATH_CLOSE_DOLLAR;
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      const after = !legacy && i < lines.length ? MATH_CLOSE_DOLLAR.exec(lines[i])?.[1] : null;
      mark(push({ type: 'math', text: body.join('\n'), ...(legacy ? { legacy: true } : {}), ...(m[1] ? { tagBefore: m[1] } : {}), ...(after ? { tagAfter: after } : {}) }), i0, i);
      continue;
    }

    if (!line.trim()) {
      para = null;
      continue;
    }

    if ((m = (mdOptions.strict ? HEADING : LOOSE_HEADING).exec(line))) {
      mark(push({ type: 'h', level: m[1].length, text: m[2] || '', closing: m[3] || '' }), i0, i0);
      continue;
    }

    if (para && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      para.type = 'h';
      para.level = line.trim()[0] === '=' ? 1 : 2;
      para.text = para.text.replace(/ *\n/g, ' ');
      para.setext = line.trim();
      SRC.get(para).end = map[i];
      para = null;
      continue;
    }

    if (RULE.test(line)) {
      mark(push({ type: 'hr', ...(line.trim() === '---' ? {} : { raw: line.trim() }) }), i0, i0);
      continue;
    }

    if (TOC.test(line)) {
      mark(push({ type: 'toc', raw: line.trim() }), i0, i0);
      continue;
    }

    if (DEF.test(line)) {
      let text = line.trim();
      while (i + 1 < lines.length && lines[i + 1].trim() && lead(lines[i + 1]) >= 2 && !DEF.test(lines[i + 1])) text += `\n${lines[++i].trim()}`;
      mark(push({ type: 'def', text }), i0, i);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
      if (head.length === align.length) {
        const rows = [head];
        for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
          const cells = splitRow(lines[i]).slice(0, head.length);
          while (cells.length < head.length) cells.push('');
          rows.push(cells);
        }
        i--;
        // A table written without padding ("| --- | --- |") is kept that way.
        const plain = `| ${align.map((x) => ({ left: ':--', right: '--:', center: ':-:' })[x] || '---').join(' | ')} |`;
        // Written without the outer pipes ("a | b"): kept that way when rewritten.
        const bare = !/^\s*\|/.test(line) && !/\|\s*$/.test(line);
        mark(push({ type: 'table', rows, align, ...(lines[i0 + 1].trim() === plain ? { compact: true } : {}), ...(bare ? { bare: true } : {}) }), i0, i);
        continue;
      }
    }

    // An HTML block runs until its opening tag is closed again (that line included) or
    // up to a blank line. One that starts right under another HTML block joins it.
    if ((m = HTML_OPEN.exec(line))) {
      const tag = m[1].replace('!', '\\!');
      const body = [line];
      let depth = tagDepth(tag, line, 0);
      while (depth > 0 && i + 1 < lines.length && lines[i + 1].trim()) {
        body.push(lines[++i]);
        depth = tagDepth(tag, lines[i], depth);
      }
      const prev = out[out.length - 1];
      if (prev && prev.type === 'html' && prev.q === q && prev.indent === indent && htmlEnd === i0 - 1) {
        prev.text += `\n${body.join('\n')}`;
        mark(prev, SRC_START.get(prev), i);
        para = null;
      } else {
        const blk = mark(push({ type: 'html', text: body.join('\n') }), i0, i);
        SRC_START.set(blk, i0);
      }
      htmlEnd = i;
      continue;
    }

    if ((m = QUOTE.exec(line))) {
      const inner = [];
      const innerMap = [];
      for (; i < lines.length; i++) {
        if ((m = QUOTE.exec(lines[i]))) inner.push(m[1]);
        // Lazy continuation: a plain line right after a quoted paragraph.
        else if (lines[i].trim() && inner[inner.length - 1].trim() && !startsBlock(lines[i])) inner.push(lines[i].trim());
        else break;
        innerMap.push(map[i]);
      }
      i--;
      para = null;
      let rest = inner;
      let restMap = innerMap;
      if (isAlert(inner[0])) {
        const label = { id: uid(), q: q + 1, indent, type: 'p', text: inner[0].trim() };
        SRC.set(label, { lines: ctx.orig, start: innerMap[0], end: innerMap[0] });
        out.push(label);
        rest = inner.slice(1);
        restMap = innerMap.slice(1);
      }
      blocks(rest, q + 1, indent, out, restMap, ctx, base);
      continue;
    }

    if ((m = ITEM.exec(line))) {
      const markerIndent = m[1].length;
      const marker = m[2];
      let gap = m[3].replace(/\t/g, '    ').length;
      if (gap > 4 || m[4] === '') gap = 1;
      const W = markerIndent + marker.length + gap;
      const belongs = (l) => lead(l) >= W || (lead(l) > markerIndent && lead(l) >= 2 && ITEM.test(l.trimStart()));
      const strip = (l) => l.replace(/\t/g, '    ').slice(Math.min(lead(l), W));
      const content = [m[4]];
      const contentMap = [map[i]];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) {
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k < lines.length && belongs(lines[k])) content.push('');
          else break;
        } else if (belongs(l)) content.push(strip(l));
        else if (content[content.length - 1].trim() && !startsBlock(l)) content.push(l.trim());
        else break;
        contentMap.push(map[j]);
      }
      i = j - 1;

      let kind = /\d/.test(marker) ? 'ol' : 'ul';
      let checked = false;
      const t = kind === 'ul' && TASK.exec(content[0]);
      if (t) {
        kind = 'task';
        checked = t[1] !== ' ';
        content[0] = t[2] || '';
      }
      const kids = [];
      blocks(content, q, indent + 1, kids, contentMap, ctx, base + W);
      // How the item was written: its bullet or number style, the width of
      // marker plus spacing, and the column it starts in. An item split or
      // edited later keeps writing itself the same way.
      const li = { id: uid(), q, indent, type: 'li', kind, checked, text: '', mw: marker.length + gap, lw: base + markerIndent, lwAt: indent };
      if (kind === 'ol') {
        li.n0 = parseInt(marker, 10);
        li.delim = marker.slice(-1);
        li.num = marker.slice(0, -1);
      } else li.mark = marker;
      // A blank line between two items of one list makes it a loose list.
      const before = out[out.length - 1];
      if (i0 > 0 && !lines[i0 - 1].trim() && before && before.q === q && ((before.type === 'li' && before.indent === indent) || before.indent > indent)) li.loose = true;
      let range = { lines: ctx.orig, start: map[i0], end: map[i0] };
      if (kids[0]?.type === 'p') {
        range = SRC.get(kids[0]) || range;
        li.text = kids.shift().text;
      }
      SRC.set(li, range);
      out.push(li, ...kids);
      para = null;
      continue;
    }

    // Two spaces before a line break are a hard break and stay in the text.
    if (para) {
      para.text += `${hardBreak(lines[i - 1]) ? '  ' : ''}\n${line.trim()}`;
      SRC.get(para).end = map[i];
    } else para = mark(push({ type: 'p', text: line.trim() }), i0, i0);
  }
}

export function parseMarkdown(src) {
  let lines = src.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split('\n');
  if (mdOptions.remapPunct) {
    let fenced = false;
    lines = lines.map((l) => {
      if (FENCE.test(l) || MATH_OPEN.test(l) || (fenced && MATH_CLOSE_BRACKET.test(l))) fenced = !fenced;
      return fenced ? l : remap(l);
    });
  }
  const out = [];
  const ctx = { orig: src.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n') };
  let start = 0;
  if (/^---\s*$/.test(lines[0])) {
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) {
      const meta = { id: uid(), q: 0, indent: 0, type: 'meta', text: lines.slice(1, end).join('\n') };
      SRC.set(meta, { lines: ctx.orig, start: 0, end });
      out.push(meta);
      start = end + 1;
    }
  }
  const body = lines.slice(start);
  blocks(body, 0, 0, out, body.map((_, k) => k + start), ctx, 0);

  // Keep the source number only where a numbered list starts somewhere
  // other than 1; every other number is derived.
  let counters = [];
  let ctxQ = -1;
  for (const b of out) {
    if (b.q !== ctxQ) {
      counters = [];
      ctxQ = b.q;
    }
    if (b.type !== 'li') {
      counters.length = Math.min(counters.length, b.indent);
      continue;
    }
    counters.length = b.indent + 1;
    if (b.kind === 'ol') {
      if (!counters[b.indent] && b.n0 > 1) b.start = b.n0;
      counters[b.indent] = 1;
    } else counters[b.indent] = 0;
    delete b.n0;
  }
  // Position in the document and, for numbered items, the number they had:
  // serialize() uses both to tell whether a block's surroundings changed.
  const nums = numberLists(out);
  out.forEach((b, k) => {
    const from = SRC.get(b);
    if (from) Object.assign(from, { seq: k, ord: nums[k] });
    // The number as written ("1." for every item, say) is reused for as
    // long as the item keeps its place in the list.
    if (b.type === 'li' && b.kind === 'ol') b.numAt = nums[k];
  });
  return out.length ? out : [{ id: uid(), q: 0, indent: 0, type: 'p', text: '' }];
}

// The spaces or tab a parsed block's first source line starts with ('' when none, or
// when the block was not parsed from text).
export function sourceLead(b) {
  const r = SRC.get(b);
  return (r && /^[ \t]*/.exec(r.lines[r.start] || '')[0]) || '';
}

// Ordered-list numbers are derived, never stored (apart from `start`).
// For each block parsed from `src`, the first and last source line (0-based):
// how a position in the rendered document maps to the Markdown text and back.
export function sourceRanges(src) {
  return parseMarkdown(src).map((b) => {
    const r = SRC.get(b);
    return r ? { start: r.start, end: r.end } : null;
  });
}

export function numberLists(list) {
  let counters = [];
  let ctxQ = -1;
  return list.map((b) => {
    if (b.q !== ctxQ) {
      counters = [];
      ctxQ = b.q;
    }
    if (b.type !== 'li') {
      counters.length = Math.min(counters.length, b.indent || 0);
      return 0;
    }
    counters.length = b.indent + 1;
    if (b.kind === 'ol') counters[b.indent] = counters[b.indent] ? counters[b.indent] + 1 : b.start || 1;
    else counters[b.indent] = 0;
    return counters[b.indent];
  });
}

// The first number of the list each ordered item belongs to.
function listStarts(list) {
  let starts = [];
  let ctxQ = -1;
  return list.map((b) => {
    if (b.q !== ctxQ) {
      starts = [];
      ctxQ = b.q;
    }
    if (b.type !== 'li') {
      starts.length = Math.min(starts.length, b.indent || 0);
      return 0;
    }
    const cont = starts.length > b.indent && starts[b.indent] !== undefined;
    starts.length = b.indent + 1;
    if (b.kind === 'ol') starts[b.indent] = cont && starts[b.indent] ? starts[b.indent] : b.start || 1;
    else starts[b.indent] = 0;
    return starts[b.indent];
  });
}

// Display width: wide (CJK, fullwidth) characters count twice.
const textWidth = (text) => [...text].reduce((w, c) => w + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u.test(c) ? 2 : 1), 0);

const escCell = (c) => c.replace(/\n/g, ' ').replace(/\|/g, '\\|');

function bodyLines(b) {
  switch (b.type) {
    case 'h': {
      const text = b.text.replace(/\n/g, ' ');
      // Heading styles: atx "# h", setext "h / ===", atx with suffix "# h #",
      // and setext whose underline is as wide as the text.
      const setext = mdOptions.headingStyle === 'setext' || mdOptions.headingStyle === 'setext-wide';
      if ((setext && b.closing === undefined && !(b.indent > 0) || b.setext) && b.level <= 2 && text.trim()) {
        const mark = b.level === 1 ? '=' : '-';
        if (typeof b.setext === 'string' && b.setext[0] === mark) return [text, b.setext];
        return [text, mdOptions.headingStyle === 'setext-wide' ? mark.repeat(Math.max(1, textWidth(text))) : mark.repeat(3)];
      }
      const suffix = b.closing ?? (mdOptions.headingStyle === 'atx-closed' ? ` ${'#'.repeat(b.level)}` : '');
      return [`${'#'.repeat(b.level)} ${text}${suffix}`];
    }
    case 'hr':
      return [b.raw || '---'];
    case 'toc':
      return [b.raw || '[TOC]'];
    case 'code': {
      let fence = b.fence || '```';
      while (b.text.includes(fence)) fence += fence[0];
      // An empty block is just its two fence lines.
      return [`${fence}${b.lang || ''}`, ...(b.text ? b.text.split('\n') : []), fence];
    }
    case 'math':
      if (b.legacy) return ['\\[', ...b.text.split('\n'), '\\]'];
      return [b.tagBefore ? `$$ ${b.tagBefore}` : '$$', ...b.text.split('\n'), b.tagAfter ? `$$ ${b.tagAfter}` : '$$'];
    case 'meta':
      // A "---" line inside would end the front matter early on the next load.
      return ['---', ...b.text.replace(/^---/gm, '\u200b---').split('\n'), '---'];
    case 'table': {
      // Display width: CJK and other wide characters take two columns.
      const wide = (t) => [...t].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
      const cells = b.rows.map((r) => r.map(escCell));
      // A table that is written out (new, or edited) has its columns lined
      // up in the source, cells padded on the side their alignment leaves free.
      if (b.compact) {
        const marks = b.rows[0].map((_, c) => ({ left: ':--', right: '--:', center: ':-:' })[b.align?.[c]] || '---');
        return [cells[0], marks, ...cells.slice(1)].map((r) => `| ${r.join(' | ')} |`);
      }
      const widths = b.rows[0].map((_, c) => Math.min(60, Math.max(4, ...cells.map((r) => wide(r[c])))));
      const fit = (t, c) => {
        const room = Math.max(0, widths[c] - wide(t));
        const side = b.align?.[c];
        if (side === 'right') return ' '.repeat(room) + t;
        if (side === 'center') return ' '.repeat(Math.floor(room / 2)) + t + ' '.repeat(Math.ceil(room / 2));
        return t + ' '.repeat(room);
      };
      const row = (r) => (b.bare ? r.map(fit).join(' | ').replace(/\s+$/, '') : `| ${r.map(fit).join(' | ')} |`);
      const sep = b.rows[0].map((_, c) => {
        const w = widths[c];
        return ({ left: `:${'-'.repeat(w - 1)}`, right: `${'-'.repeat(w - 1)}:`, center: `:${'-'.repeat(w - 2)}:` })[b.align?.[c]] || '-'.repeat(w);
      });
      return [row(cells[0]), b.bare ? sep.join(' | ') : `| ${sep.join(' | ')} |`, ...cells.slice(1).map(row)];
    }
    default:
      return b.text.split('\n');
  }
}

export function serialize(list) {
  const nums = numberLists(list);
  const starts = listStarts(list);
  const lines = [];
  // cols[d]: the column where the content of the list item at depth d starts.
  let cols = [];
  let kids = []; // the column where a child of the item at depth d starts
  let wq = -1;
  let last = null; // source record of the previous block, when it was written verbatim

  list.forEach((b, k) => {
    const prev = list[k - 1];
    const q = b.q || 0;
    const indent = b.indent || 0;
    if (q !== wq) {
      cols = [];
      kids = [];
      wq = q;
    }
    const inherited = indent > 0 ? kids[indent - 1] ?? cols[indent - 1] ?? indent * 2 : 0;
    let pad = inherited;
    let body;
    if (b.type === 'li') {
      // "1. 1. 1." style: every new item repeats the list's first number.
      const number = b.num && b.numAt === nums[k] ? b.num : mdOptions.olStyle === 'same' ? starts[k] : nums[k];
      const marker = b.kind === 'ol' ? `${number}${b.delim || mdOptions.olMarker}` : b.mark || mdOptions.ulMarker;
      // With pretty indentation a new marker is padded to the indent size; items read from a file keep their width.
      const width = Math.max(marker.length + 1, b.mw || 0, b.mw || !mdOptions.prettyIndent || mdOptions.indent <= 0 ? 0 : mdOptions.indent);
      if (b.lwAt === indent && typeof b.lw === 'number' && (indent === 0 ? b.lw <= 3 : b.lw >= (cols[indent - 1] ?? 0))) pad = b.lw;
      cols.length = indent;
      cols[indent] = pad + width;
      // Children of a new item are indented by the indent size (at least to the content column).
      kids.length = indent;
      // Auto (0): the content column; a number: that many columns; Tab (-1): one tab per level (written below).
      kids[indent] = b.mw || mdOptions.prettyIndent || !mdOptions.indent ? pad + width : mdOptions.indent < 0 ? pad + 4 : Math.max(pad + mdOptions.indent, pad + marker.length + 1);
      const first = `${marker}${' '.repeat(width - marker.length)}${b.kind === 'task' ? `[${b.checked ? 'x' : ' '}] ` : ''}`;
      const cont = ' '.repeat(width);
      body = b.text.split('\n').map((l, n) => (n ? cont + l : first + l));
    } else {
      cols.length = Math.min(cols.length, indent);
      kids.length = Math.min(kids.length, indent);
      body = bodyLines(b);
    }

    // The separator a freshly written block gets: a blank line, except
    // between the items of a tight list and after a callout label.
    const separate = () => {
      if (!prev) return;
      const pq = prev.q || 0;
      const sameQ = pq === q;
      const sameList = indent !== prev.indent || ((b.kind === 'ol') === (prev.kind === 'ol') && (b.mark || '') === (prev.mark || '') && (b.delim || '') === (prev.delim || ''));
      // Items stay tight, also after a paragraph that belongs to the item above.
      const tightList = sameQ && b.type === 'li' && (prev.type === 'li' || (prev.type === 'p' && (prev.indent || 0) > 0)) && sameList && !b.loose;
      const afterAlert = sameQ && q > 0 && prev.type === 'p' && isAlert(prev.text);
      // A callout label always opens a blockquote of its own.
      const startsAlert = q > 0 && b.type === 'p' && isAlert(b.text);
      // A blank line inside a list item carries the item's indentation.
      if (!tightList && !afterAlert) lines.push('> '.repeat(Math.min(pq, startsAlert ? q - 1 : q)).trimEnd() + (sameQ && indent > 0 ? ' '.repeat(pad) : ''));
    };

    // An untouched block goes back exactly as it was read; when the block
    // before it is untouched too, so does everything between them.
    const from = SRC.get(b);
    if (from && typeof from.seq === 'number' && !(b.type === 'li' && b.kind === 'ol' && from.ord !== nums[k])) {
      if (last && last.lines === from.lines && last.seq + 1 === from.seq && from.start > last.end) {
        for (let n = last.end + 1; n <= from.end; n++) lines.push(from.lines[n]);
      } else {
        separate();
        for (let n = from.start; n <= from.end; n++) lines.push(from.lines[n]);
      }
      last = from;
      return;
    }
    last = null;

    separate();
    const prefix = '> '.repeat(q) + (mdOptions.indent < 0 && pad % 4 === 0 ? '\t'.repeat(pad / 4) : ' '.repeat(pad));
    for (const l of body) lines.push(l === '' ? (indent > 0 ? `${'> '.repeat(q)}${' '.repeat(pad)}` : prefix.trimEnd()) : prefix + l);
  });

  // The empty paragraph the editor keeps below a trailing table or code
  // block is a place for the caret, not content: no blank lines at the end.
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

// Plain text of a block, for word counts, search and the outline.
export function blockText(b) {
  if (b.type === 'table') return b.rows.flat().join(' ');
  return b.text || '';
}

// A heading's anchor: its text without Markdown syntax, lower-cased; dashes spelled
// out (— is ---, – is --), every space or hyphen kept as one hyphen (runs are not
// merged), other punctuation and + = dropped. Letters, digits, emoji and _ stay.
export function slugify(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|~~|==|[*`~\\])/g, '')
    .trim()
    .toLowerCase()
    .replace(/—/g, '---')
    .replace(/–/g, '--')
    .replace(/[\s-]/gu, '-')
    .replace(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}\u200d\ufe0f_-]/gu, '');
}

// The anchor of every heading in a block list: a repeated one gets -1, -2, … as on GitHub.
export function headingIds(list) {
  const ids = new Map();
  const used = new Map();
  for (const b of list) {
    if (b.type !== 'h') continue;
    const base = slugify(b.text);
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    ids.set(b, n ? `${base}-${n}` : base);
  }
  return ids;
}

// Which heading an "#anchor" link means: the anchor as written, or its slug; "x-N" also
// finds the N-th repeat of heading x. Returns the index into `list`, or -1.
export function findAnchor(list, name) {
  const ids = headingIds(list);
  const want = slugify(name);
  const entries = [...ids];
  let hit = entries.find(([, id]) => id === name) || entries.find(([, id]) => id === want) || entries.find(([b]) => slugify(b.text) === want);
  if (!hit) {
    const m = /^(.*)-(\d+)$/.exec(want);
    if (m) hit = entries.filter(([b]) => slugify(b.text) === m[1])[Number(m[2])];
  }
  return hit ? list.indexOf(hit[0]) : -1;
}
