// Conversions in and out of the block model:
//   - blocks -> clean HTML (export, "Copy as HTML", rich-text copy)
//   - pasted HTML -> Markdown

import { cleanInlineHtml, esc, attr } from './inline.js';
import { highlight, sanitizeHtml, langName, DIAGRAM_LANGS } from './rich.js';
import { parseMarkdown, slugify, headingIds, ALERT, isAlert } from './markdown.js';

// --- blocks -> HTML ---------------------------------------------------------

const OWN_MARK = '<meta name="generator" content="livemark">';

// Set from the settings: math goes into copied and exported HTML as LaTeX source instead of rendered.
export const convertOptions = { mathAsTex: false };

function inlineHtml(src, opts) {
  let html = cleanInlineHtml(src).replace(/ title=""/g, '');
  // Footnote references are numbered by first use, each with an id the note links back to.
  if (opts.fn && html.includes('fn-view')) {
    const t = document.createElement('template');
    t.innerHTML = html;
    for (const el of t.content.querySelectorAll('sup.fn-view')) {
      const label = el.dataset.label;
      const n = opts.fn.num.get(label);
      if (!n) continue;
      const k = (opts.fn.seen.get(label) || 0) + 1;
      opts.fn.seen.set(label, k);
      const sup = document.createElement('sup');
      sup.className = 'footnote-ref';
      sup.id = `fnref-${label}${k > 1 ? `-${k}` : ''}`;
      const a = document.createElement('a');
      a.href = `#fn-${label}`;
      a.textContent = String(n);
      sup.append(a);
      el.replaceWith(sup);
    }
    html = t.innerHTML;
  }
  if (html.includes('math-view')) {
    const t = document.createElement('template');
    t.innerHTML = html;
    for (const el of t.content.querySelectorAll('.math-view')) {
      const span = document.createElement('span');
      span.className = 'math-inline';
      span.innerHTML = mathHtml(el.dataset.tex, false, opts);
      el.closest('.tok').replaceWith(span);
    }
    html = t.innerHTML;
  }
  return html;
}

function mathHtml(tex, display, opts) {
  if (opts.mathAsTex || convertOptions.mathAsTex) return display ? `$$\n${esc(tex)}\n$$` : `$${esc(tex)}$`;
  if (!window.katex) return esc(tex);
  try {
    // MathML needs no stylesheet, so exported files stand on their own. The
    // in-app print path keeps the HTML output, which matches the editor.
    return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: false, output: opts.mathml ? 'mathml' : 'html' });
  } catch {
    return esc(tex);
  }
}

function blockHtml(b, opts) {
  switch (b.type) {
    case 'h':
      return `<h${b.level} id="${attr(opts.ids?.get(b) ?? slugify(b.text))}">${inlineHtml(b.text, opts)}</h${b.level}>`;
    case 'hr':
      return '<hr>';
    case 'code': {
      const name = langName(b.lang);
      if (DIAGRAM_LANGS.has(name)) {
        const svg = opts.preview?.(b);
        if (svg) return `<div class="diagram">${svg}</div>`;
      }
      const body = highlight(b.text, b.lang).replace(/<br>$/, '');
      const braced = /^\s*\{([^}]*)\}\s*$/.exec(b.lang || '');
      if (braced) {
        const id = /(?:^|\s)#([\w:-]+)/.exec(braced[1])?.[1];
        const classes = [...braced[1].matchAll(/(?:^|\s)\.([\w+#-]+)/g)].map((m) => m[1]);
        const pairs = [...braced[1].matchAll(/([\w-]+)=("[^"]*"|'[^']*'|\S+)/g)].map((m) => ` ${m[1]}="${attr(m[2].replace(/^["']|["']$/g, ''))}"`).join('');
        return `<pre${id ? ` id="${attr(id)}"` : ''}${classes.length ? ` class="${attr(classes.join(' '))}"` : ''}${pairs}><code${name ? ` class="language-${attr(name)}"` : ''}>${body}</code></pre>`;
      }
      return `<pre><code${name ? ` class="language-${attr(name)}"` : ''}>${body}</code></pre>`;
    }
    case 'math':
      return `<div class="math-block">${mathHtml(b.text, true, opts)}</div>`;
    case 'html':
      return sanitizeHtml(b.text);
    case 'table': {
      const cell = (tag, text, c) => `<${tag}${b.align?.[c] ? ` style="text-align:${b.align[c]}"` : ''}>${inlineHtml(text, opts)}</${tag}>`;
      const head = `<thead><tr>${b.rows[0].map((t, c) => cell('th', t, c)).join('')}</tr></thead>`;
      const body = b.rows.slice(1).map((r) => `<tr>${r.map((t, c) => cell('td', t, c)).join('')}</tr>`).join('\n');
      return `<table>\n${head}\n<tbody>\n${body}\n</tbody>\n</table>`;
    }
    case 'toc':
      return `<nav class="toc">${opts.headings.map((h) => `<a class="toc-item l${h.level}" href="#${attr(opts.ids?.get(h) ?? slugify(h.text))}">${inlineHtml(h.text, opts)}</a>`).join('\n')}</nav>`;
    case 'meta':
    case 'def':
      return '';
    default:
      return `<p>${inlineHtml(b.text, opts)}</p>`;
  }
}

// Rebuilds nesting from the flat list: quote depth first, then list levels.
function build(list, from, to, q, indent, opts) {
  const out = [];
  let i = from;
  while (i < to) {
    const b = list[i];
    if (b.q > q) {
      let j = i;
      while (j < to && list[j].q > q) j++;
      const alert = b.type === 'p' && isAlert(b.text) ? ALERT.exec(b.text)[1].toLowerCase() : null;
      const start = alert ? i + 1 : i;
      const label = alert ? `<p class="alert-title">${alert[0].toUpperCase()}${alert.slice(1)}</p>\n` : '';
      out.push(`<blockquote${alert ? ` class="alert alert-${alert}"` : ''}>\n${label}${build(list, start, j, q + 1, indent, opts)}\n</blockquote>`);
      i = j;
      continue;
    }
    if (b.type === 'li' && b.indent === indent) {
      const ordered = b.kind === 'ol';
      const items = [];
      let j = i;
      while (j < to && list[j].q === q && ((list[j].type === 'li' && list[j].indent === indent && (list[j].kind === 'ol') === ordered) || list[j].indent > indent)) {
        const li = list[j];
        let k = j + 1;
        // What belongs to an item is indented under it; a quote that merely
        // follows the list is not part of its last item.
        while (k < to && list[k].q >= q && list[k].indent > indent) k++;
        const box = li.kind === 'task' ? `<input type="checkbox" disabled${li.checked ? ' checked' : ''}> ` : '';
        const kids = k > j + 1 ? `\n${build(list, j + 1, k, q, indent + 1, opts)}\n` : '';
        items.push(`<li${li.kind === 'task' ? ' class="task"' : ''}>${box}${inlineHtml(li.text, opts)}${kids}</li>`);
        j = k;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}${ordered && b.start ? ` start="${b.start}"` : ''}>\n${items.join('\n')}\n</${tag}>`);
      i = j;
      continue;
    }
    out.push(blockHtml(b, opts));
    i++;
  }
  return out.filter(Boolean).join('\n');
}

// The notes that are referenced, in the order of their first reference, each with a
// way back to every place that cites it.
function footnotes(list, opts) {
  const defs = new Map();
  for (const b of list) {
    const m = b.type === 'def' && /^\[\^([^\]]+)\]:\s*([\s\S]*)$/.exec(b.text);
    if (m && !defs.has(m[1])) defs.set(m[1], m[2]);
  }
  const used = [...opts.fn.num.keys()].filter((label) => defs.has(label));
  if (!used.length) return '';
  const items = used.map((label) => {
    const refs = opts.fn.seen.get(label) || 1;
    const back = Array.from({ length: refs }, (_, k) => ` <a href="#fnref-${attr(label)}${k ? `-${k + 1}` : ''}" class="footnote-back" aria-label="Back to reference">↩</a>`).join('');
    return `<li id="fn-${attr(label)}">${inlineHtml(defs.get(label), { ...opts, fn: null })}${back}</li>`;
  });
  return `\n<hr>\n<ol class="footnotes">\n${items.join('\n')}\n</ol>`;
}

// Footnote numbers by first reference in the document (definitions do not count).
function footnoteNumbers(list) {
  const num = new Map();
  const defined = new Set(list.filter((b) => b.type === 'def' && b.text.startsWith('[^')).map((b) => /^\[\^([^\]]+)\]/.exec(b.text)?.[1]));
  const scan = (text) => {
    for (const m of String(text || '').replace(/`[^`]*`/g, '').matchAll(/\[\^([^\]\s]+)\](?!:)/g)) if (defined.has(m[1]) && !num.has(m[1])) num.set(m[1], num.size + 1);
  };
  for (const b of list) {
    if (b.type === 'def' || b.type === 'code' || b.type === 'math' || b.type === 'html' || b.type === 'meta') continue;
    if (b.type === 'table') b.rows.flat().forEach(scan);
    else scan(b.text);
  }
  return num;
}

export function blocksToHtml(list, opts = {}) {
  const o = { mathml: true, headings: list.filter((b) => b.type === 'h'), ids: headingIds(list), ...opts, fn: { num: footnoteNumbers(list), seen: new Map() } };
  return build(list, 0, list.length, 0, 0, o) + footnotes(list, o);
}

export const markdownToHtml = (md, opts) => blocksToHtml(parseMarkdown(md), opts);

// HTML put on the clipboard next to the Markdown source.
export const clipboardHtml = (md) => OWN_MARK + markdownToHtml(md);

// The exported page's outline: the heading being read is marked as the page scrolls, and
// a heading's sub-headings fold away under it (click its marker).
const OUTLINE_SCRIPT = `<script>
(function () {
  var items = [].slice.call(document.querySelectorAll('.export-outline-item'));
  var heads = items.map(function (a) { return document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))); });
  items.forEach(function (a, k) {
    var lv = +a.dataset.level, next = items[k + 1];
    if (!next || +next.dataset.level <= lv) return;
    var t = document.createElement('span'); t.className = 'export-outline-twist'; t.textContent = '▾';
    t.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var shut = t.textContent === '▾'; t.textContent = shut ? '▸' : '▾';
      for (var j = k + 1; j < items.length && +items[j].dataset.level > lv; j++) items[j].style.display = shut ? 'none' : '';
    });
    a.prepend(t);
  });
  function spy() {
    var at = -1;
    heads.forEach(function (h, k) { if (h && h.getBoundingClientRect().top < 80) at = k; });
    items.forEach(function (a, k) { a.classList.toggle('active', k === at); });
  }
  addEventListener('scroll', spy, { passive: true }); addEventListener('resize', spy); spy();
})();
</script>`;

export function standaloneHtml(list, { title = '', css = '', theme = '', dark = false, preview, head = '', bodyEnd = '', author = '', outline = false } = {}) {
  const body = blocksToHtml(list, { preview });
  // HTML export with "Include Outline Sidebar": the headings as links in a fixed left column.
  const heads = outline ? list.filter((b) => b.type === 'h') : [];
  const ids = headingIds(list);
  const side = heads.length ? `<aside class="export-outline"><nav>\n${heads.map((b) => `<a class="export-outline-item l${b.level}" data-level="${b.level}" href="#${attr(ids.get(b))}">${esc(b.text.replace(/[*_`~=]/g, ''))}</a>`).join('\n')}\n</nav></aside>\n${OUTLINE_SCRIPT}\n` : '';
  const sideCss = side ? '.export-outline{position:fixed;top:0;left:0;bottom:0;width:260px;overflow:auto;padding:24px 12px;box-sizing:border-box;border-right:1px solid rgba(128,128,128,.25);font:14px/1.6 -apple-system,sans-serif;background:var(--bg,#fff);} .export-outline a{display:block;color:inherit;text-decoration:none;padding:2px 0;opacity:.85;} .export-outline a.active{opacity:1;font-weight:600} .export-outline-twist{display:inline-block;width:1em;margin-left:-1em;cursor:pointer;opacity:.6} .export-outline .l2{padding-left:1em}.export-outline .l3{padding-left:2em}.export-outline .l4{padding-left:3em}.export-outline .l5{padding-left:4em}.export-outline .l6{padding-left:5em} body{padding-left:260px;}' : '';
  const style = css || side ? `<style>\n${css}\n${css ? 'body{margin:0;background:var(--bg);} .write{min-height:0;padding-bottom:60px;}' : ''}${sideCss}\n</style>\n` : '';
  const cls = css ? ' class="write"' : '';
  return `<!doctype html>\n<html lang="zh-CN"${css ? ` data-theme="${attr(theme)}" data-dark="${dark ? 1 : 0}"` : ''}>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(title)}</title>\n${author ? `<meta name="author" content="${attr(author)}">\n` : ''}${style}${head ? `${head}\n` : ''}</head>\n<body>\n${side}<div${cls}>\n${body}\n</div>\n${bodyEnd ? `${bodyEnd}\n` : ''}</body>\n</html>\n`;
}

// --- pasted HTML -> Markdown ------------------------------------------------

const SEMANTIC = /<(h[1-6]|ul|ol|li|table|a\s|strong|b>|em>|i>|blockquote|img|p[\s>]|del|code|pre|dl|video|audio|iframe|details)|class="[^"]*katex/i;
const MEDIA_TAGS = new Set(['VIDEO', 'AUDIO', 'IFRAME', 'DETAILS']);
// TeX kept by KaTeX next to what it drew.
const katexTex = (el) => el.querySelector('annotation[encoding="application/x-tex"]')?.textContent.trim() ?? null;

// Decide whether pasted HTML carries structure worth converting. Text copied
// from a code editor arrives as styled <div>/<span> soup and is better taken
// as plain text; so is anything copied from this editor.
export function htmlToMarkdown(html, plain) {
  if (!html || html.includes('name="generator" content="livemark"')) return null;
  // Firefox (and Windows apps) can put a "Version:… StartHTML:…" header before the HTML.
  html = html.replace(/^Version:[\s\S]*?(?=<)/, '');
  // Apple Notes writes headings as big bold text: Title (17px+) and Heading (14px).
  const notes = /<meta name="Generator" content="Cocoa HTML Writer">/i.test(html);
  if (!SEMANTIC.test(html) && !notes) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Relative links and pictures are made absolute against the page they came from.
  const base = doc.querySelector('base[href]')?.getAttribute('href');
  if (base && /^https?:\/\//i.test(base)) {
    for (const el of doc.querySelectorAll('a[href], img[src]')) {
      const key = el.tagName === 'A' ? 'href' : 'src';
      const v = el.getAttribute(key);
      if (v && !/^([a-z][\w+.-]*:|#|\/\/)/i.test(v)) {
        try {
          el.setAttribute(key, new URL(v, base).href);
        } catch {
          /* left as it was */
        }
      }
    }
  }
  if (notes) {
    for (const p of [...doc.querySelectorAll('p, div')]) {
      const style = [...p.querySelectorAll('span, b')].map((x) => x.getAttribute('style') || '').join(';') + (p.getAttribute('style') || '');
      const size = Number(/font[^;]*?(\d+(?:\.\d+)?)px/.exec(style)?.[1] || /font-size:\s*(\d+(?:\.\d+)?)px/.exec(style)?.[1] || 0);
      const bold = p.querySelector('b, strong') || /font-weight:\s*(bold|[6-9]00)|font:\s*bold/.test(style);
      const level = bold && size >= 17 ? 1 : bold && size >= 14 ? 2 : 0;
      if (level && p.textContent.trim()) {
        const hEl = doc.createElement(`h${level}`);
        hEl.textContent = p.textContent.trim();
        p.replaceWith(hEl);
      }
    }
  }
  for (const el of doc.querySelectorAll('script, style, meta, link, head, title, noscript, template')) el.remove();
  const md = blockMd(doc.body, { list: null, depth: 0 }).replace(/\n{3,}/g, '\n\n').trim();
  return md || plain || null;
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'DETAILS']);
const escMd = (t) => t.replace(/([\\`*_[\]])/g, '\\$1').replace(/^(\s*)([#>+-])(\s)/, '$1\\$2$3');

function wrap(mark, inner, close = mark) {
  if (!inner.trim()) return inner;
  const lead = /^\s*/.exec(inner)[0];
  const trail = /\s*$/.exec(inner)[0];
  return `${lead}${mark}${inner.trim()}${close}${trail}`;
}

function inlineMd(node) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) {
      out += escMd(c.nodeValue.replace(/\s+/g, ' '));
      continue;
    }
    if (c.nodeType !== 1) continue;
    const tag = c.tagName;
    const inner = () => inlineMd(c);
    const style = c.getAttribute('style') || '';
    if (c.classList?.contains('katex') && katexTex(c) != null) {
      out += `$${katexTex(c)}$`;
      continue;
    }
    if (tag === 'BR') out += '\n';
    else if (tag === 'STRONG' || tag === 'B') out += /font-weight:\s*(normal|400)/.test(style) ? inner() : wrap('**', inner());
    else if (tag === 'EM' || tag === 'I') out += wrap('*', inner());
    else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') out += wrap('~~', inner());
    else if (tag === 'MARK') out += wrap('==', inner());
    else if (tag === 'U') out += wrap('<u>', inner(), '</u>');
    else if (tag === 'SUB') out += wrap('~', inner());
    else if (tag === 'SUP') out += wrap('^', inner());
    else if (tag === 'KBD') out += wrap('<kbd>', inner(), '</kbd>');
    else if (tag === 'CODE' || tag === 'TT' || tag === 'SAMP') {
      const t = c.textContent;
      const ticks = t.includes('`') ? '``' : '`';
      out += t ? `${ticks}${t}${ticks}` : '';
    } else if (tag === 'A') {
      const href = c.getAttribute('href') || '';
      const text = inner().trim();
      if (!href || href.startsWith('javascript:')) out += text;
      else out += text === href ? `<${href}>` : `[${text || href}](${href})`;
    } else if (tag === 'IMG') {
      const src = c.getAttribute('src') || '';
      if (src && !src.startsWith('data:image/gif;base64,R0lGODlhAQABA')) out += `![${(c.getAttribute('alt') || '').replace(/[[\]]/g, '')}](${src})`;
    } else if (tag === 'INPUT' && c.type === 'checkbox') out += c.checked ? '[x] ' : '[ ] ';
    else if (tag === 'SPAN' || tag === 'FONT') {
      let t = inner();
      if (/font-weight:\s*(bold|[6-9]00)/.test(style)) t = wrap('**', t);
      if (/font-style:\s*italic/.test(style)) t = wrap('*', t);
      if (/text-decoration[^;]*line-through/.test(style)) t = wrap('~~', t);
      out += t;
    } else if (BLOCK_TAGS.has(tag)) out += ` ${blockMd(c, { list: null, depth: 0 }).trim()} `;
    else out += inner();
  }
  return out;
}

const hasBlockChild = (el) => [...el.children].some((c) => BLOCK_TAGS.has(c.tagName));

function tableMd(table) {
  const trs = [...table.querySelectorAll('tr')];
  const rows = trs.map((tr) => [...tr.children].map((td) => inlineMd(td).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()));
  if (!rows.length) return '';
  const n = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: n }, (_, c) => r[c] || '').join(' | ')} |`;
  // Column alignment from the header cells (style text-align or the align attribute).
  const heads = [...trs[0].children];
  const rule = Array.from({ length: n }, (_, c) => {
    const cell = heads[c];
    const a = (cell && (/text-align:\s*(left|center|right)/i.exec(cell.getAttribute('style') || '')?.[1] || cell.getAttribute('align') || '')).toLowerCase();
    return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
  });
  return [line(rows[0]), `| ${rule.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

// A list; a list that sits directly in another (not inside an item) belongs to the item before it.
function listMd(c) {
  let n = Number(c.getAttribute('start')) || 1;
  const items = [];
  for (const li of c.children) {
    if ((li.tagName === 'UL' || li.tagName === 'OL') && items.length) {
      const last = items[items.length - 1];
      const pad = ' '.repeat(last.marker.length + 1);
      last.body += `\n${listMd(li).split('\n').map((l) => (l ? pad + l : l)).join('\n')}`;
      continue;
    }
    if (li.tagName !== 'LI') continue;
    const marker = c.tagName === 'OL' ? `${n++}.` : '-';
    const body = (hasBlockChild(li) ? blockMd(li, { list: null, depth: 0 }) : inlineMd(li)).trim();
    const pad = ' '.repeat(marker.length + 1);
    items.push({ marker, body: body.split('\n').map((l, k) => (k && l ? pad + l : l)).join('\n') });
  }
  return items.map((x) => `${x.marker} ${x.body}`).join('\n');
}

function blockMd(node, ctx) {
  const parts = [];
  let run = '';
  const flushRun = () => {
    const t = run.replace(/[ \t]+\n/g, '\n').trim();
    if (t) parts.push(t);
    run = '';
  };
  for (const c of node.childNodes) {
    if (c.nodeType === 3) {
      run += escMd(c.nodeValue.replace(/\s+/g, ' '));
      continue;
    }
    if (c.nodeType !== 1) continue;
    const tag = c.tagName;
    const style = c.getAttribute('style') || '';
    if (c.classList.contains('katex-display') && katexTex(c) != null) {
      flushRun();
      parts.push(`$$\n${katexTex(c)}\n$$`);
      continue;
    }
    // Video, audio, embeds and disclosure boxes stay as HTML.
    if (MEDIA_TAGS.has(tag)) {
      flushRun();
      parts.push(c.outerHTML);
      continue;
    }
    // Markdown shown as monospace pre-wrapped text (a code editor, a forum preview) is Markdown already.
    if (tag === 'DIV' && /white-space:\s*pre/i.test(style) && /monospace|menlo|monaco|consolas|courier/i.test(style)) {
      flushRun();
      parts.push(c.textContent);
      continue;
    }
    if (!BLOCK_TAGS.has(tag)) {
      const holder = document.createElement('span');
      holder.appendChild(c.cloneNode(true));
      run += inlineMd(holder);
      continue;
    }
    flushRun();
    if (/^H[1-6]$/.test(tag)) parts.push(`${'#'.repeat(Number(tag[1]))} ${inlineMd(c).replace(/\n/g, ' ').trim()}`);
    else if (tag === 'HR') parts.push('---');
    else if (tag === 'PRE') {
      const code = c.querySelector('code');
      const lang = c.getAttribute('lang') || code?.getAttribute('lang') || c.dataset.lang || /(?:language|lang)-([\w+#-]+)/.exec(`${c.className} ${code?.className || ''}`)?.[1] || '';
      const text = (code || c).textContent.replace(/\n$/, '');
      const fence = text.includes('```') ? '````' : '```';
      parts.push(`${fence}${lang}\n${text}\n${fence}`);
    } else if (tag === 'BLOCKQUOTE') parts.push(blockMd(c, ctx).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    else if (tag === 'UL' || tag === 'OL') parts.push(listMd(c));
    else if (tag === 'DL') {
      // A definition list as a list: each term an item, its definitions under it.
      const items = [];
      for (const x of c.children) {
        if (x.tagName === 'DT') items.push(`- ${inlineMd(x).replace(/\n/g, ' ').trim()}`);
        else if (x.tagName === 'DD') {
          const body = (hasBlockChild(x) ? blockMd(x, ctx) : inlineMd(x)).trim();
          if (!items.length) items.push('-');
          items[items.length - 1] += `\n\n${body.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n')}`;
        }
      }
      parts.push(items.join('\n\n'));
    } else if (tag === 'TABLE') parts.push(tableMd(c));
    else if (tag === 'LI') parts.push(`- ${inlineMd(c).trim()}`);
    else if (hasBlockChild(c)) parts.push(blockMd(c, ctx));
    else {
      const t = inlineMd(c).replace(/[ \t]+\n/g, '\n').trim();
      if (t) parts.push(t);
    }
  }
  flushRun();
  return parts.join('\n\n');
}
