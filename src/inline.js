// Inline Markdown -> HTML.
//
// The one rule everything else relies on: the textContent of the generated
// HTML is exactly the Markdown source. Syntax markers are never dropped, they
// are wrapped in <span class="mk"> and hidden with CSS until the caret enters
// the surrounding token. That is what makes "render while you type" cheap:
// the DOM is the source text, with styling on top.
//
// Things that render as something other than their source (math, emoji,
// footnote numbers) are drawn by elements that hold no text nodes of their
// own: an empty span whose content comes from an attribute or a shadow root.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export const esc = (s) => s.replace(/[&<>]/g, (c) => ESC[c]);
export const attr = (s) => esc(String(s)).replace(/"/g, '&quot;');
const mk = (s) => `<span class="mk">${esc(s)}</span>`;
const tok = (type, inner, extra = '') => `<span class="tok" data-t="${type}"${extra}>${inner}</span>`;
// Code and links are left out of spell checking unless asked for.
const spellAttr = () => (inlineCtx.spellcheckCode ? '' : ' spellcheck="false"');

// Rendering context, set by the editor: link reference definitions, how to
// resolve image paths, the emoji table and feature switches.
const ENTITY = /&#?[a-z0-9]+;/iy;
const LEGACY_MATH = /\\\((.+?)\\\)|\\\[(.+?)\\\]/y;
let entityBox = null;
function decodeEntity(text) {
  if (typeof document === 'undefined') return null;
  entityBox ||= document.createElement('textarea');
  entityBox.innerHTML = text;
  return entityBox.value;
}

export const inlineCtx = {
  refs: new Map(),
  resolveSrc: (u) => u,
  emoji: null,
  math: true,
  mathLegacy: false,
  spellcheckCode: false,
  quotes: null,
  subSup: true,
  highlight: true,
  emojiOn: true,
  // Labels of the buttons shown in an image whose address is still empty.
  imageButtons: { url: 'input image URL', file: 'Select image from local file' },
  refHints: { image: 'Please define image reference by \n[{0}]: http://example.png' },
};

const PUNCT = /[!-/:-@[-`{-~]/;
const isWs = (c) => c === undefined || /\s/.test(c);
const isAlnum = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

export function safeUrl(u) {
  const t = String(u).trim().replace(/^<|>$/g, '');
  return /^(javascript|vbscript|data(?!:image\/))/i.test(t) ? '#' : t;
}

export const normRef = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// s[i] is a backtick. Returns the run length and where the closing run starts.
function codeSpan(s, i) {
  let n = 1;
  while (s[i + n] === '`') n++;
  let j = i + n;
  while (j < s.length) {
    if (s[j] !== '`') { j++; continue; }
    let m = 1;
    while (s[j + m] === '`') m++;
    if (m === n) return { n, close: j };
    j += m;
  }
  return { n, close: -1 };
}

const skipCode = (s, j) => {
  const cs = codeSpan(s, j);
  return cs.close < 0 ? j + cs.n : cs.close + cs.n;
};

// s[i] is "[". Finds the matching "]".
function bracketEnd(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') { j = skipCode(s, j) - 1; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return j;
  }
  return -1;
}

// s[i] is "[". Matches [text](dest), [text][ref], [text][] and [ref].
function matchLink(s, i) {
  const j = bracketEnd(s, i);
  if (j < 0) return null;
  const text = s.slice(i + 1, j);
  if (s[j + 1] === '(') {
    let k = j + 2;
    let pd = 1;
    for (; k < s.length; k++) {
      const c = s[k];
      if (c === '\\') { k++; continue; }
      if (c === '\n') return null;
      if (c === '(') pd++;
      else if (c === ')' && --pd === 0) break;
    }
    if (k >= s.length) return null;
    const dest = s.slice(j + 2, k);
    const m = /^\s*(<[^>]*>|\S*)(?:\s+["'(](.*)["')])?\s*$/.exec(dest);
    return { text, url: m ? m[1] : dest.trim(), title: (m && m[2]) || '', open: '[', close: `](${dest})`, end: k + 1 };
  }
  // The shortcut form [ref] needs a matching definition, otherwise it is just text.
  // The full form [text][ref] is a link either way, as in Typora; an undefined one is
  // marked so it can say how to define it.
  let label = text;
  let end = j + 1;
  let close = ']';
  if (s[j + 1] === '[') {
    const k = s.indexOf(']', j + 2);
    if (k < 0) return null;
    if (k > j + 2) label = s.slice(j + 2, k);
    close = s.slice(j, k + 1);
    end = k + 1;
  }
  const ref = inlineCtx.refs.get(normRef(label));
  if (!label.trim()) return null;
  if (!ref) return close !== ']' ? { text, url: '', title: '', open: '[', close, end, isRef: true, undefinedRef: label } : null;
  return { text, url: ref.url, title: ref.title || '', open: '[', close, end, isRef: true };
}

// Finds the closing run for an emphasis opener of `d` delimiter chars.
function findEmphClose(s, from, c, d) {
  let j = from;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') { j = skipCode(s, j); continue; }
    if (ch !== c) { j++; continue; }
    let run = 1;
    while (s[j + run] === c) run++;
    const leftOk = j > from && !isWs(s[j - 1]);
    const rightOk = c !== '_' || !isAlnum(s[j + run]);
    if (leftOk && rightOk) {
      if (d === 3 && run >= 3) return j;
      if (d === 2 && (run === 2 || run > 3)) return j;
      if (d === 2 && run === 3) return j + 1;
      if (d === 1 && run === 1) return j;
      if (d === 1 && run === 3) return j + 2;
    }
    j += run;
  }
  return -1;
}

function findPairClose(s, from, delim, { noSpace = false } = {}) {
  let j = from;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '`') { j = skipCode(s, j); continue; }
    if (noSpace && isWs(s[j])) return -1;
    if (s.startsWith(delim, j) && j > from && !isWs(s[j - 1])) return j;
    j++;
  }
  return -1;
}

const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/y;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>]+/y;
const EMOJI = /:([a-z0-9_+-]+):/y;
// name@example.com in running text (a known top-level domain, so "a@b" stays text).
const BARE_MAIL = /[A-Za-z0-9][\w.+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|org|net|edu|gov|io|co|me|info|biz|dev|app|ai|cn|uk|de|jp|fr|ru|us|ca|au|in|it|nl|es|se|ch|kr|br|tw|hk)\b/y;
const FOOTREF = /\[\^([^\]\s]+)\]/y;
const COMMENT = /<!--[\s\S]*?-->/y;
const TAG_OPEN = /<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const PAIRS = { '~~': 'del', '==': 'mark' };

// Inline HTML that is safe to render live. Anything else stays as text.
const INLINE_TAGS = new Set(['u', 'kbd', 'sub', 'sup', 'mark', 'small', 'big', 'ins', 'del', 's', 'b', 'i', 'em', 'strong', 'span', 'font', 'abbr', 'cite', 'q', 'var', 'samp', 'code', 'a', 'ruby', 'rt', 'rp']);
const VOID_TAGS = new Set(['br', 'img']);
const SAFE_ATTRS = new Set(['style', 'title', 'href', 'src', 'alt', 'width', 'height', 'color', 'size', 'face', 'align', 'name', 'id', 'target', 'lang', 'dir']);

export function safeStyle(v) {
  return /url\s*\(|expression|@import|behavior|position\s*:|javascript:/i.test(v) ? '' : v;
}

function safeAttrs(tag, raw) {
  let out = '';
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    if (!SAFE_ATTRS.has(name)) continue;
    let v = m[2] ?? m[3] ?? m[4] ?? '';
    if (name === 'href') v = safeUrl(v);
    else if (name === 'src') v = inlineCtx.resolveSrc(safeUrl(v));
    else if (name === 'style') v = safeStyle(v);
    out += ` ${name}="${attr(v)}"`;
  }
  return out;
}

function matchHtml(s, i) {
  TAG_OPEN.lastIndex = i;
  const m = TAG_OPEN.exec(s);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const openEnd = TAG_OPEN.lastIndex;
  if (VOID_TAGS.has(tag)) {
    const html = tag === 'br' ? '<br>' : `<img${safeAttrs(tag, m[2])} draggable="false">`;
    return { html: tok(tag === 'img' ? 'image' : 'br', mk(m[0]) + html), end: openEnd };
  }
  if (!INLINE_TAGS.has(tag) || m[3]) return null;
  // Find the matching close tag, allowing the same tag to nest.
  const re = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let c;
  while ((c = re.exec(s))) {
    depth += c[1] ? -1 : 1;
    if (depth === 0) break;
  }
  if (!c) return null;
  const inner = parse(s.slice(openEnd, c.index));
  return { html: tok('html', `${mk(m[0])}<${tag}${safeAttrs(tag, m[2])}>${inner}</${tag}>${mk(c[0])}`), end: c.index + c[0].length };
}

// Inline math: $x$. The opener must not be followed by a space, the closer
// must not be preceded by one or followed by a digit, so prices stay text.
function matchMath(s, i) {
  if (inlineCtx.mathLegacy) {
    // Compatible mode: everything up to the last unescaped $ in the text is math.
    for (let j = s.length - 1; j > i + 1; j--) if (s[j] === '$' && s[j - 1] !== '\\') return j;
    return null;
  }
  if (isWs(s[i + 1]) || s[i + 1] === '$') return null;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '\n' && s[j + 1] === '\n') return null;
    if (s[j] === '$') {
      if (isWs(s[j - 1]) || /\d/.test(s[j + 1] || '')) return null;
      return j;
    }
  }
  return null;
}

function parse(s) {
  let out = '';
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) { out += esc(buf); buf = ''; }
  };
  const emit = (html, end) => {
    flush();
    out += html;
    i = end;
  };

  while (i < s.length) {
    const c = s[i];

    // A hard line break (two or more spaces before a line break): the spaces stay as
    // text, followed by a faint "↓" mark drawn by CSS on an empty, non-editable span.
    if (c === ' ' && s[i + 1] === ' ' && (i === 0 || s[i - 1] !== ' ')) {
      const m = /^ {2,}(?=\n)/.exec(s.slice(i));
      if (m) {
        emit(tok('linebreak', `${m[0]}<span class="lb-mark" contenteditable="false"></span>`), i + m[0].length);
        continue;
      }
    }

    // Legacy inline math, \(…\) and \[…\], is read whether or not $…$ math is on,
    // unless "LaTeX Math Delimiter \( \) \[ \]" is turned off in Settings.
    if (c === '\\' && inlineCtx.legacyMathDelims !== false && (s[i + 1] === '(' || s[i + 1] === '[')) {
      LEGACY_MATH.lastIndex = i;
      const m = LEGACY_MATH.exec(s);
      if (m) {
        const tex = m[1] ?? m[2];
        const close = s[i + 1] === '(' ? '\\)' : '\\]';
        emit(tok('math', `${mk(s.slice(i, i + 2))}<span class="mk math-src">${esc(tex)}</span>${mk(close)}<span class="math-view" contenteditable="false" data-tex="${attr(tex)}"></span>`), i + m[0].length);
        continue;
      }
    }

    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      emit(tok('escape', mk('\\') + esc(s[i + 1])), i + 2);
      continue;
    }

    if (c === '`') {
      const cs = codeSpan(s, i);
      if (cs.close >= 0) {
        const ticks = '`'.repeat(cs.n);
        emit(tok('code', `${mk(ticks)}<code>${esc(s.slice(i + cs.n, cs.close))}</code>${mk(ticks)}`, spellAttr()), cs.close + cs.n);
      } else {
        buf += s.slice(i, i + cs.n);
        i += cs.n;
      }
      continue;
    }

    if (c === '$' && inlineCtx.math && s[i + 1] === '$' && !inlineCtx.mathLegacy) {
      // $$…$$ inside a line is one inline formula (shown in display style); "$$"
      // alone is an empty one, shown with a placeholder.
      const close = s.indexOf('$$', i + 2);
      if (close > i + 2 && !s.slice(i + 2, close).includes('\n\n')) {
        const tex = s.slice(i + 2, close);
        emit(tok('math', `${mk('$$')}<span class="mk math-src">${esc(tex)}</span>${mk('$$')}<span class="math-view" contenteditable="false" data-display="1" data-tex="${attr(tex)}"></span>`), close + 2);
        continue;
      }
      if (close < 0 && s[i + 2] !== '$' && !(i === 0 && s.length === 2)) {
        emit(tok('math', `${mk('$$')}<span class="math-view math-empty" contenteditable="false" data-tex=""></span>`), i + 2);
        continue;
      }
    }
    if (c === '$' && inlineCtx.math) {
      const close = matchMath(s, i);
      if (close) {
        const tex = s.slice(i + 1, close);
        emit(tok('math', `${mk('$')}<span class="mk math-src">${esc(tex)}</span>${mk('$')}<span class="math-view" contenteditable="false" data-tex="${attr(tex)}"></span>`), close + 1);
        continue;
      }
    }

    if (c === '!' && s[i + 1] === '[') {
      const m = matchLink(s, i + 1);
      if (m?.undefinedRef != null) {
        // An image reference with no definition shows its source and, while the caret is
        // in it, how to define it.
        const hint = inlineCtx.refHints.image.replace('{0}', m.undefinedRef);
        emit(tok('image', mk(s.slice(i, m.end)), ` data-noref="" data-hint="${attr(hint)}"`), m.end);
        continue;
      }
      if (m) {
        const src = s.slice(i, m.end);
        const img = `<img src="${attr(inlineCtx.resolveSrc(safeUrl(m.url)))}" alt="${attr(m.text)}" title="${attr(m.title)}" draggable="false">`;
        // An image with no address yet offers two buttons where the address goes:
        // type one, or pick a local file. They hold no text, so the source is unchanged.
        const open = src.indexOf('](') + 2;
        if (!m.url && !m.title && src.slice(open) === ')') {
          const b = inlineCtx.imageButtons;
          emit(tok('image', `${mk(src.slice(0, open))}<span class="img-src-btns" contenteditable="false"><span class="img-btn img-url" data-label="${attr(b.url)}"></span><span class="img-btn img-file" title="${attr(b.file)}"></span></span>${mk(')')}${img}`), m.end);
        } else emit(tok('image', `${mk(src)}${img}`), m.end);
        continue;
      }
    }

    if (c === '[') {
      FOOTREF.lastIndex = i;
      const f = FOOTREF.exec(s);
      if (f) {
        emit(tok('fnref', `${mk(f[0])}<sup class="fn-view" contenteditable="false" data-label="${attr(f[1])}"></sup>`), FOOTREF.lastIndex);
        continue;
      }
      const m = matchLink(s, i);
      if (m) {
        const ref = m.undefinedRef != null ? ` data-ref="${attr(m.undefinedRef)}"` : '';
        emit(tok('link', `${mk(m.open)}<a href="${attr(m.undefinedRef != null ? '#' : safeUrl(m.url))}"${ref} title="${attr(m.title)}">${parse(m.text)}</a>${mk(m.close)}`, spellAttr()), m.end);
        continue;
      }
    }

    if (c === '<') {
      COMMENT.lastIndex = i;
      const cm = COMMENT.exec(s);
      if (cm) {
        emit(tok('comment', `<span class="cmt">${esc(cm[0])}</span>`), COMMENT.lastIndex);
        continue;
      }
      AUTOLINK.lastIndex = i;
      const m = AUTOLINK.exec(s);
      if (m) {
        const href = /^[\w.+-]+@/.test(m[1]) ? `mailto:${m[1]}` : m[1];
        emit(tok('url', `${mk('<')}<a href="${attr(safeUrl(href))}">${esc(m[1])}</a>${mk('>')}`, spellAttr()), AUTOLINK.lastIndex);
        continue;
      }
      const h = matchHtml(s, i);
      if (h) {
        emit(h.html, h.end);
        continue;
      }
    }

    if (inlineCtx.autoLinks !== false && /[A-Za-z0-9]/.test(c) && !/[\w.+-]/.test(s[i - 1] || '')) {
      BARE_MAIL.lastIndex = i;
      const m = BARE_MAIL.exec(s);
      if (m) {
        emit(tok('url', `<a href="${attr(safeUrl(`mailto:${m[0]}`))}">${esc(m[0])}</a>`, spellAttr()), i + m[0].length);
        continue;
      }
    }
    if ((c === 'h' || c === 'w') && inlineCtx.autoLinks !== false && !isAlnum(s[i - 1])) {
      BARE_URL.lastIndex = i;
      const m = BARE_URL.exec(s);
      if (m && m[0].length > 8) {
        const url = m[0].replace(/[.,;:!?)'"\]。，；：！？）】」]+$/, '');
        emit(tok('url', `<a href="${attr(safeUrl(url.startsWith('www.') ? `https://${url}` : url))}">${esc(url)}</a>`, spellAttr()), i + url.length);
        continue;
      }
    }

    // An HTML entity (&copy;, &#169;) shows its character until the caret enters it.
    if (c === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(s);
      const ch = m && decodeEntity(m[0]);
      if (ch && ch !== m[0]) {
        emit(tok('entity', `${mk(m[0])}<span class="emoji-view" contenteditable="false" data-emoji="${attr(ch)}"></span>`), i + m[0].length);
        continue;
      }
    }

    // Smart punctuation "on rendering": the source keeps its ASCII and only
    // the display changes, the same way an emoji shortcode is shown.
    if (inlineCtx.smartRender && (c === '"' || c === "'") && inlineCtx.smartQuotes) {
      const opening = i === 0 || /[\s([{“‘—–-]/.test(s[i - 1]);
      const q = inlineCtx.quotes || ['“', '”', '‘', '’'];
      const shown = c === '"' ? (opening ? q[0] : q[1]) : opening ? q[2] : q[3];
      emit(tok('smart', `${mk(c)}<span class="emoji-view" contenteditable="false" data-emoji="${shown}"></span>`), i + 1);
      continue;
    }
    if (inlineCtx.smartRender && inlineCtx.smartDashes && c === '.' && s.startsWith('...', i) && s[i - 1] !== '.' && s[i + 3] !== '.') {
      emit(tok('smart', `${mk('...')}<span class="emoji-view" contenteditable="false" data-emoji="…"></span>`), i + 3);
      continue;
    }
    if (inlineCtx.smartRender && c === '-' && inlineCtx.smartDashes && s[i + 1] === '-' && s[i - 1] !== '-') {
      const n = s[i + 2] !== '-' ? 2 : s[i + 3] !== '-' ? 3 : 0;
      if (n) {
        emit(tok('smart', `${mk('-'.repeat(n))}<span class="emoji-view" contenteditable="false" data-emoji="${n === 3 ? '—' : '–'}"></span>`), i + n);
        continue;
      }
    }

    if (c === ':' && inlineCtx.emojiOn && inlineCtx.emoji) {
      EMOJI.lastIndex = i;
      const m = EMOJI.exec(s);
      const ch = m && inlineCtx.emoji[m[1]];
      if (ch) {
        emit(tok('emoji', `${mk(m[0])}<span class="emoji-view" contenteditable="false" data-emoji="${attr(ch)}"></span>`), EMOJI.lastIndex);
        continue;
      }
    }

    if (c === '*' || c === '_') {
      let n = 1;
      while (s[i + n] === c) n++;
      const d = Math.min(n, 3);
      const canOpen = n <= 3 && !isWs(s[i + n]) && (c !== '_' || !isAlnum(s[i - 1]));
      const close = canOpen ? findEmphClose(s, i + d, c, d) : -1;
      if (close >= 0) {
        const marks = c.repeat(d);
        const inner = parse(s.slice(i + d, close));
        const body = d === 1 ? `<em>${inner}</em>` : d === 2 ? `<strong>${inner}</strong>` : `<strong><em>${inner}</em></strong>`;
        emit(tok(d === 1 ? 'em' : 'strong', mk(marks) + body + mk(marks)), close + d);
        continue;
      }
    }

    const two = s.substr(i, 2);
    if (PAIRS[two] && !isWs(s[i + 2]) && (two !== '==' || inlineCtx.highlight)) {
      const close = findPairClose(s, i + 2, two);
      if (close >= 0) {
        const tag = PAIRS[two];
        emit(tok(tag, `${mk(two)}<${tag}>${parse(s.slice(i + 2, close))}</${tag}>${mk(two)}`), close + 2);
        continue;
      }
    }

    // ~sub~ and ^sup^: single delimiters, no whitespace inside.
    if ((c === '~' ? inlineCtx.sub ?? inlineCtx.subSup : c === '^' && (inlineCtx.sup ?? inlineCtx.subSup)) && s[i + 1] !== c && s[i - 1] !== c && !isWs(s[i + 1])) {
      const close = findPairClose(s, i + 1, c, { noSpace: true });
      if (close >= 0 && s[close + 1] !== c) {
        const tag = c === '~' ? 'sub' : 'sup';
        emit(tok(tag, `${mk(c)}<${tag}>${parse(s.slice(i + 1, close))}</${tag}>${mk(c)}`), close + 1);
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// A trailing <br> keeps an empty block (or a block ending in a newline) tall
// enough to hold the caret. <br> has no textContent, so offsets are unaffected.
export function renderInline(src) {
  return parse(src) + (src === '' || src.endsWith('\n') ? '<br>' : '');
}

// Link reference and footnote definitions: "[id]: url" / "[^id]: text".
const DEF_PARTS = /^(\[\^?[^\]]+\]:)(\s*)([\s\S]*)$/;
export function renderDef(src) {
  const m = DEF_PARTS.exec(src);
  if (!m) return renderInline(src);
  const isNote = m[1].startsWith('[^');
  const url = !isNote && /^(<[^>]*>|\S+)/.exec(m[3])?.[1].replace(/^<|>$/g, '');
  const body = isNote ? parse(m[3]) : url ? `<a class="def-url" href="${attr(safeUrl(url))}">${esc(m[3])}</a>` : `<span class="def-url">${esc(m[3])}</span>`;
  return `<span class="def-label">${esc(m[1])}</span>${esc(m[2])}${body}${src.endsWith('\n') ? '<br>' : ''}`;
}

// Parses "[id]: <url> "title"" into { label, url, title }.
export function parseDef(src) {
  const m = /^\[([^\]^][^\]]*)\]:\s*(<[^>]*>|\S+)(?:\s+["'(](.*)["')])?\s*$/.exec(src.trim());
  return m ? { label: normRef(m[1]), url: m[2].replace(/^<|>$/g, ''), title: m[3] || '' } : null;
}

// Rendered HTML with every editing artefact removed: used for export and for
// "Copy as HTML".
export function cleanInlineHtml(src) {
  const t = document.createElement('template');
  t.innerHTML = parse(src);
  for (const el of t.content.querySelectorAll('.mk')) el.remove();
  for (const el of t.content.querySelectorAll('.emoji-view')) el.replaceWith(el.dataset.emoji);
  for (const el of t.content.querySelectorAll('.fn-view')) {
    const a = document.createElement('a');
    a.href = `#fn-${el.dataset.label}`;
    a.textContent = `[${el.dataset.label}]`;
    el.replaceChildren(a);
    el.removeAttribute('contenteditable');
  }
  for (const el of t.content.querySelectorAll('.tok, .cmt')) {
    if (el.classList.contains('cmt')) el.remove();
    else if (el.dataset.t !== 'math') el.replaceWith(...el.childNodes);
  }
  for (const el of t.content.querySelectorAll('.lb-mark')) el.remove();
  for (const el of t.content.querySelectorAll('[draggable]')) el.removeAttribute('draggable');
  // A single newline is a line break when "preserve single line break" is
  // on, and ordinary whitespace otherwise.
  return inlineCtx.preserveBreaks === false ? t.innerHTML : t.innerHTML.replace(/\n/g, '<br>\n');
}

// A heading's text for a table of contents or the outline: its inline formatting
// (bold, code, math…) without the Markdown markers; links show as their text.
export function headingHtml(src) {
  const t = document.createElement('template');
  t.innerHTML = cleanInlineHtml(src).replace(/<br>\n?/g, ' ');
  for (const a of t.content.querySelectorAll('a')) a.replaceWith(...a.childNodes);
  return t.innerHTML;
}
