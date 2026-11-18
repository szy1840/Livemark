// The editor toolbar (View → Toolbar): a small floating bar centred at the bottom
// of the writing area. It holds a block-style picker, the four common inline
// styles, image, quote, a list picker and a "More Actions" menu. When the window
// is too narrow the buttons fold into the More menu one by one. Every action runs
// a command from the shared command tree, so the bar stays in step with the menus.

import { h } from './ui.js';
import { t } from './i18n.js';
import { settings } from './prefs.js';

const svg = (body) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  strong: svg('<path d="M5 3h3.6a2.4 2.4 0 0 1 0 4.8H5zM5 7.8h4.2a2.6 2.6 0 0 1 0 5.2H5z" stroke-width="1.7"/>'),
  em: svg('<path d="M7 3h5M4 13h5M9.5 3 6.5 13"/>'),
  code: svg('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
  link: svg('<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>'),
  image: svg('<path d="M2.5 3.5h11v9h-11zM2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5"/><circle cx="10.5" cy="6" r="1" fill="currentColor" stroke="none"/>'),
  quote: svg('<path d="M3 4v8M6.5 5.5h7M6.5 8h7M6.5 10.5h4.5"/>'),
  ul: svg('<path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5"/><circle cx="3" cy="4.5" r=".9" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="3" cy="11.5" r=".9" fill="currentColor" stroke="none"/>'),
  ol: svg('<path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7M2.4 3.6l.9-.5v3M2.3 10h1.4L2.3 12.4h1.5"/>'),
  task: svg('<path d="M2.5 3.5h4v4h-4zM3.6 5.5l.9.9 1.4-1.7M9 5.5h4.5M2.5 9.5h4v4h-4zM9 11.5h4.5"/>'),
  more: svg('<circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none"/>'),
  copy: svg('<path d="M5.5 5.5h7v8h-7zM3.5 10.5v-8h7"/>'),
  paste: svg('<path d="M5 3H3.5v10.5h9V3H11M6 2h4v2H6z"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9"/>'),
  caret: '<svg viewBox="0 0 6 6" width="6" height="6" aria-hidden="true"><path d="M0 1.5h6L3 5z" fill="currentColor"/></svg>',
  check: svg('<path d="M3.5 8.3 6.5 11l6-6.5" stroke-width="1.6"/>'),
  sub: '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M2.5 1v6L6 4z" fill="currentColor"/></svg>',
  close: svg('<circle cx="8" cy="8" r="6" fill="currentColor" stroke="none" opacity=".55"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="var(--bg, #fff)" stroke-width="1.5"/>'),
};

// The buttons that fold into the More menu, first to last, as the bar runs out of room.
const COLLAPSE_ORDER = ['list', 'quote', 'image', 'link', 'code', 'em', 'strong'];
const BLOCK_NAMES = { p: 'Paragraph', li: 'Paragraph', code: 'Code Fences', math: 'Math Block', table: 'Table', hr: 'Horizontal Line', html: 'HTML Block', meta: 'YAML Front Matter', toc: 'Table of Contents' };

export function createToolbar({ host, commands, editor, app }) {
  const run = (id) => commands.run(id);
  const key = (id) => commands.keyOf(id) || '';

  // --- what the caret is in ---------------------------------------------------
  const inlineAtCaret = () => {
    const s = window.getSelection();
    const out = new Set();
    let n = s && s.rangeCount ? s.focusNode : null;
    for (let el = n && (n.nodeType === 1 ? n : n.parentElement); el && el !== editor.root; el = el.parentElement) {
      const k = el.classList?.contains('tok') && el.dataset.t;
      if (k) out.add(k === 'url' ? 'link' : k);
    }
    return out;
  };
  const blockAtCaret = () => {
    const cur = app.sourceMode() ? null : editor.currentBlock();
    const b = cur?.b;
    if (!b) return { name: 'Paragraph', style: 'paragraph', quote: false, list: null };
    // The list the caret sits in (the nearest item), and the outermost one.
    let list = null, outer = null;
    const inList = b.type === 'li' || b.indent > 0;
    if (inList) {
      if (b.type === 'li') list = outer = b.kind;
      if (b.type !== 'li' || b.indent > 0) {
        for (let i = cur.i - 1; i >= 0; i--) {
          const p = editor.doc[i];
          if (p.type === 'li') {
            list ??= p.kind;
            outer = p.kind;
            if (!p.indent) break;
          } else if (!p.indent) break;
        }
      }
    }
    const quote = (b.q || 0) > 0;
    // Typora names the outermost container: any quote, else the outermost list,
    // else the block itself.
    const LIST_NAMES = { ol: 'Ordered List', ul: 'Unordered List', task: 'Task List' };
    if (quote) return { name: 'Quote', style: 'blockquote', quote, list };
    if (outer) return { name: LIST_NAMES[outer], style: outer, quote, list };
    const style = b.type === 'h' ? `h${b.level}` : b.type === 'p' ? 'paragraph' : b.type;
    const name = b.type === 'h' ? `Heading ${b.level}` : b.type === 'def' ? (/^\s*\[\^/.test(b.text) ? 'Footnotes' : 'Link Reference') : BLOCK_NAMES[b.type] || 'Paragraph';
    return { name, style, quote, list };
  };

  // --- the bar -----------------------------------------------------------------
  const btn = (action, tip, inner, extra = '') => {
    const b = h('button', { type: 'button', class: `etb-btn ${extra}`.trim(), 'data-action': action, 'data-tip': tip, 'aria-label': tip });
    b.innerHTML = inner;
    return b;
  };
  const divider = () => h('div', { class: 'etb-divider' });
  const label = h('span', { class: 'etb-select-label' });
  const blockBtn = btn('block-style', t('Block Styles'), ICONS.caret, 'etb-select');
  blockBtn.prepend(label);
  const buttons = {
    strong: btn('strong', `**${t('Strong')}**`, ICONS.strong),
    em: btn('em', `*${t('Emphasis')}*`, ICONS.em),
    code: btn('code', `\`${t('Code')}\``, ICONS.code),
    link: btn('link', `[${t('Hyperlink')}]()`, ICONS.link),
    image: btn('image', `![${t('Image')}]()`, ICONS.image),
    quote: btn('quote', `> ${t('Quote')}`, ICONS.quote),
    list: btn('list', t('List Styles / Remove Block'), ICONS.ul + ICONS.caret, 'etb-select'),
    more: btn('more', t('More Actions'), ICONS.more),
  };
  const inner = h('div', { class: 'etb-inner' }, blockBtn, divider(), buttons.strong, buttons.em, buttons.code, buttons.link, divider(),
    buttons.image, buttons.quote, buttons.list, divider(), buttons.more);
  const hintText = h('span', { class: 'etb-hint-text' });
  hintText.innerHTML = escHtml(t('Toolbar hidden, reopen from {0}')).replace('{0}', `<b>${escHtml(t('View'))} → ${escHtml(t('Toolbar'))}</b>`);
  const hintClose = btn('hint-close', t('Close'), ICONS.close, 'etb-hint-close');
  const hint = h('div', { class: 'etb-hint' }, hintText, hintClose);
  host.className = 'editor-toolbar';
  host.setAttribute('contenteditable', 'false');
  host.replaceChildren(inner, hint);
  const tooltip = h('div', { class: 'etb-tooltip' });
  document.body.append(tooltip);

  // --- menus -------------------------------------------------------------------
  let menu = null, subMenu = null, subFor = null, menuType = null;
  const closeSub = () => { subMenu?.remove(); subMenu = null; subFor = null; };
  const closeMenus = () => { closeSub(); menu?.remove(); menu = null; menuType = null; };

  const blockItems = () => {
    const cur = blockAtCaret();
    const item = (style, title, cmd) => ({ cmd, title: t(title), key: key(cmd), active: cur.style === style, heading: /^h\d$/.test(style) });
    const items = [1, 2, 3, 4, 5, 6].map((n) => item(`h${n}`, `Heading ${n}`, `h${n}`));
    items.push({ divider: true }, item('paragraph', 'Paragraph', 'paragraph'), { divider: true },
      { cmd: 'tableInsert', title: t('Table'), active: cur.style === 'table' },
      { cmd: 'codeFences', title: t('Code Fences'), active: cur.style === 'code' },
      { cmd: 'mathBlock', title: t('Math Block'), active: cur.style === 'math' });
    if (settings.alerts) {
      items.push({ title: t('Alert'), submenu: [['note', 'Note Block'], ['tip', 'Tip Block'], ['important', 'Important Block'], ['warning', 'Warning Block'], ['caution', 'Caution Block']].map(([k, title]) => ({ cmd: `alert-${k}`, title: t(title) })) });
    }
    items.push({ cmd: 'hr', title: t('Horizontal Line'), active: cur.style === 'hr' });
    return items;
  };
  const listItems = () => {
    const { list } = blockAtCaret();
    return [
      { cmd: 'ol', title: t('Ordered List'), icon: ICONS.ol, active: list === 'ol' },
      { cmd: 'ul', title: t('Unordered List'), icon: ICONS.ul, active: list === 'ul' },
      { cmd: 'task', title: t('Task List'), icon: ICONS.task, active: list === 'task' },
    ];
  };
  const FOLD = {
    strong: { cmd: 'strong', title: 'Strong', icon: ICONS.strong },
    em: { cmd: 'em', title: 'Emphasis', icon: ICONS.em },
    code: { cmd: 'code', title: 'Code', icon: ICONS.code },
    link: { cmd: 'link', title: 'Hyperlink', icon: ICONS.link },
    image: { cmd: 'imageInsertLocal', title: 'Image', icon: ICONS.image },
    quote: { cmd: 'quote', title: 'Quote', icon: ICONS.quote },
  };
  const moreItems = () => {
    const inl = inlineAtCaret();
    const blk = blockAtCaret();
    const active = { strong: inl.has('strong'), em: inl.has('em'), code: inl.has('code'), link: inl.has('link'), quote: blk.quote, list: !!blk.list };
    const folded = Object.keys(buttons).filter((k) => buttons[k].classList.contains('is-collapsed'))
      .map((k) => (k === 'list' ? { title: t('List'), icon: ICONS.ul, active: active.list, submenu: listItems() } : { ...FOLD[k], title: t(FOLD[k].title), active: !!active[k] }));
    const items = [
      { cmd: 'source', title: t('Source Code Mode'), active: app.sourceMode() },
      { divider: true },
      { cmd: 'paraBefore', title: t('Insert Paragraph Before') },
      { cmd: 'paraAfter', title: t('Insert Paragraph After') },
      { divider: true },
      { run: () => app.copyAs('rich'), title: t('Copy'), icon: ICONS.copy },
      { run: () => app.pasteFromClipboard(), title: t('Paste'), icon: ICONS.paste },
      { title: `${t('Copy / Paste As')}…`, submenu: [
        { cmd: 'copyMarkdown', title: t('Copy as Markdown') },
        { cmd: 'copyHtml', title: t('Copy as HTML Code') },
        { cmd: 'copyPlain', title: t('Copy as Plain Text') },
        { divider: true },
        { cmd: 'pastePlain', title: t('Paste as Plain Text') },
      ] },
      { cmd: 'clearFormat', title: t('Clear Format') },
      { divider: true },
      { cmd: 'deleteBlock', title: t('Delete Block'), icon: ICONS.trash },
      { divider: true },
      { run: enterHintMode, title: t('Hide Toolbar') },
    ];
    return folded.length ? [...folded, { divider: true }, ...items] : items;
  };

  const buildMenu = (items, isSub) => {
    const m = h('div', { class: `etb-menu${isSub ? ' etb-submenu' : ''}`, contenteditable: 'false' });
    for (const it of items) {
      if (it.divider) { m.append(h('div', { class: 'etb-menu-divider' })); continue; }
      const row = h('div', { class: `etb-menu-item${it.active ? ' active' : ''}${it.submenu ? ' has-sub' : ''}` });
      const icon = h('span', { class: 'etb-mi-icon' });
      icon.innerHTML = it.active ? ICONS.check : it.icon || '';
      const extra = h('span', { class: 'etb-mi-extra' });
      if (it.submenu) extra.innerHTML = ICONS.sub;
      else extra.textContent = it.key || '';
      row.append(icon, h('span', { class: 'etb-mi-label' }, it.title), extra);
      row._item = it;
      m.append(row);
    }
    m.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const row = e.target.closest('.etb-menu-item');
      if (!row || row.parentNode !== m) return;
      const it = row._item;
      if (it.submenu) return openSub(it.submenu, row);
      // Picking the heading the caret is already in turns it back into a paragraph;
      // picking any other active block style does nothing.
      const cmd = menuType === 'block-style' && it.active ? (it.heading ? 'paragraph' : null) : it.cmd;
      closeAfterMouseUp();
      if (it.run) it.run();
      else if (cmd) run(cmd);
      update();
    });
    m.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.etb-menu-item');
      if (!row || row.parentNode !== m) return;
      if (row._item.submenu) openSub(row._item.submenu, row);
      else if (!isSub) closeSub();
    });
    return m;
  };
  // Close on the mouse-up that ends the click, so the release does not land in the text.
  const closeAfterMouseUp = () => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener('mouseup', fin, true);
      setTimeout(closeMenus, 0);
    };
    document.addEventListener('mouseup', fin, true);
    const timer = setTimeout(fin, 300);
  };
  const openMenu = (type, anchor) => {
    if (menuType === type) return closeMenus();
    closeMenus();
    const items = type === 'block-style' ? blockItems() : type === 'list' ? listItems() : moreItems();
    menu = buildMenu(items, false);
    menuType = type;
    document.body.append(menu);
    // Above the button, or below it when there is no room.
    const r = anchor.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8));
    let y = r.top - menu.offsetHeight - 8;
    if (y < 8) y = r.bottom + 8;
    menu.style.left = `${Math.round(x)}px`;
    menu.style.top = `${Math.round(y)}px`;
  };
  const openSub = (items, row) => {
    if (subMenu && subFor === row) return;
    closeSub();
    subMenu = buildMenu(items, true);
    subFor = row;
    document.body.append(subMenu);
    const r = row.getBoundingClientRect();
    let x = r.right - 2;
    if (x + subMenu.offsetWidth > window.innerWidth - 8) x = r.left - subMenu.offsetWidth + 2;
    const y = Math.max(8, Math.min(r.top - 4, window.innerHeight - subMenu.offsetHeight - 8));
    subMenu.style.left = `${Math.round(Math.max(8, x))}px`;
    subMenu.style.top = `${Math.round(y)}px`;
  };
  document.addEventListener('mousedown', (e) => {
    if (menu && !e.target.closest?.('.editor-toolbar, .etb-menu')) closeMenus();
  });

  // --- buttons -----------------------------------------------------------------
  const ACTION = { strong: 'strong', em: 'em', code: 'code', link: 'link', image: 'imageInsertLocal', quote: 'quote' };
  let suppressedTip = null;
  inner.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.etb-btn');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    clearTipTimers();
    hideTip();
    tipActive = false;
    suppressedTip = b;
    const a = b.dataset.action;
    if (a === 'block-style' || a === 'list' || a === 'more') return openMenu(a, b);
    closeMenus();
    run(ACTION[a]);
    update();
  });
  hintClose.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    app.setSetting({ toolbar: false });
  });

  // Tooltips appear after a long hover; once one is up, the next button shows its
  // own at once until the pointer has been off the bar for a moment.
  let tipTimer = null, coolTimer = null, tipActive = false;
  const clearTipTimers = () => { clearTimeout(tipTimer); clearTimeout(coolTimer); tipTimer = coolTimer = null; };
  const hideTip = () => { tooltip.style.display = 'none'; };
  const showTip = (b) => {
    if (menu || !b.dataset.tip) return;
    tooltip.textContent = b.dataset.tip;
    tooltip.style.display = 'block';
    const r = b.getBoundingClientRect(), tr = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.round(r.left + (r.width - tr.width) / 2)}px`;
    tooltip.style.top = `${Math.round(r.top - tr.height - 10)}px`;
  };
  inner.addEventListener('mouseover', (e) => {
    const b = e.target.closest('.etb-btn');
    if (!b || b.contains(e.relatedTarget) || menu || b === suppressedTip) return;
    clearTipTimers();
    if (tipActive) showTip(b);
    else tipTimer = setTimeout(() => { tipTimer = null; tipActive = true; showTip(b); }, 1500);
  });
  inner.addEventListener('mouseout', (e) => {
    const b = e.target.closest('.etb-btn');
    if (!b || b.contains(e.relatedTarget)) return;
    clearTipTimers();
    hideTip();
    if (b === suppressedTip) suppressedTip = null;
    coolTimer = setTimeout(() => { coolTimer = null; tipActive = false; }, 600);
  });

  // --- state, layout -----------------------------------------------------------
  const scroller = editor.scroller;
  const visible = () => host.style.display !== 'none';
  function update() {
    if (!visible()) return;
    const inl = inlineAtCaret();
    const blk = blockAtCaret();
    buttons.strong.classList.toggle('active', inl.has('strong'));
    buttons.em.classList.toggle('active', inl.has('em'));
    buttons.code.classList.toggle('active', inl.has('code'));
    buttons.link.classList.toggle('active', inl.has('link'));
    buttons.quote.classList.toggle('active', blk.quote);
    buttons.list.classList.toggle('active', !!blk.list);
    const name = t(blk.name);
    if (label.textContent !== name) {
      // While the mouse is held (a selection being dragged) the label waits; when it
      // changes the bar slides to its new place instead of jumping.
      if (mouseHeld) {
        pendingLabel = true;
        return;
      }
      label.textContent = name;
      host.classList.add('is-reflowing');
      clearTimeout(reflowTimer);
      reflowTimer = setTimeout(() => host.classList.remove('is-reflowing'), 260);
      position();
    }
  }
  let mouseHeld = false;
  let pendingLabel = false;
  let reflowTimer = 0;
  document.addEventListener('mousedown', () => (mouseHeld = true), true);
  document.addEventListener('mouseup', () => {
    mouseHeld = false;
    if (pendingLabel) {
      pendingLabel = false;
      update();
    }
  }, true);
  window.addEventListener('blur', () => (mouseHeld = false));
  // Hide a divider unless a visible button stands on both sides of it.
  const cleanDividers = () => {
    let before = false;
    const kids = [...inner.children];
    kids.forEach((el, i) => {
      if (el.classList.contains('etb-divider')) {
        const after = before && kids.slice(i + 1).some((x) => x.classList.contains('etb-btn') && !x.classList.contains('is-collapsed'));
        el.classList.toggle('is-collapsed', !after);
        if (after) before = false;
      } else if (!el.classList.contains('is-collapsed')) before = true;
    });
  };
  function position() {
    if (!visible()) return;
    const r = scroller.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (!host.classList.contains('hint-mode')) {
      const room = Math.max(0, r.width - 24);
      const fold = COLLAPSE_ORDER.map((k) => buttons[k]);
      fold.forEach((b) => b.classList.remove('is-collapsed'));
      cleanDividers();
      for (const b of fold) {
        if (host.offsetWidth <= room) break;
        b.classList.add('is-collapsed');
        cleanDividers();
      }
    }
    host.style.left = `${Math.round(r.left + (r.width - host.offsetWidth) / 2)}px`;
    host.style.top = `${Math.round(r.bottom - 14 - host.offsetHeight)}px`;
  }
  function enterHintMode() {
    closeMenus();
    clearTipTimers();
    hideTip();
    host.classList.add('hint-mode');
    position();
  }
  function setVisible(on) {
    host.classList.remove('hint-mode');
    host.style.display = on ? '' : 'none';
    hideTip();
    if (on) { position(); update(); } else closeMenus();
  }

  document.addEventListener('selectionchange', update);
  window.addEventListener('resize', () => { closeMenus(); position(); });
  scroller.addEventListener('scroll', closeMenus);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => position()).observe(scroller);
  return { setVisible, update, position };
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
