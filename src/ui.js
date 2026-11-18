// Small UI building blocks shared by the app: element helper, popup menus,
// modal dialogs, toasts.

import { platform, isNative } from './platform.js';
import { t } from './i18n.js';

export const $ = (s, root = document) => root.querySelector(s);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const KEY_SYMBOL = { cmd: '⌘', ctrl: isMac ? '⌃' : 'Ctrl+', alt: isMac ? '⌥' : 'Alt+', shift: isMac ? '⇧' : 'Shift+', enter: '↩', backspace: '⌫', delete: '⌦', up: '↑', down: '↓', left: '←', right: '→', tab: '⇥', escape: 'Esc', space: '␣' };
// "cmd+shift+s" -> "⇧⌘S"
export function keyLabel(key) {
  if (!key) return '';
  const parts = key.split('+');
  const main = parts.pop();
  const order = ['ctrl', 'alt', 'shift', 'cmd'];
  const mods = order.filter((m) => parts.includes(m)).map((m) => (m === 'cmd' && !isMac ? 'Ctrl+' : KEY_SYMBOL[m]));
  return mods.join('') + (KEY_SYMBOL[main] || (main.length === 1 ? main.toUpperCase() : main.toUpperCase()));
}

// --- popup menus ------------------------------------------------------------
// items: { id?, title, key?, checked?, enabled?, run?, items? } | { separator }

let openMenus = [];
export function closeMenus() {
  for (const m of openMenus) m.remove();
  openMenus = [];
  document.dispatchEvent(new CustomEvent('menusclosed'));
}

function buildMenu(items, onPick, level) {
  const menu = h('div', { class: 'menu', role: 'menu' });
  menu.dataset.level = level;
  for (const item of items) {
    if (item.separator) {
      menu.append(h('hr'));
      continue;
    }
    const sub = item.items && item.items.length;
    const btn = h(
      'button',
      { type: 'button', role: 'menuitem', class: `menu-item${item.checked ? ' checked' : ''}${sub ? ' has-sub' : ''}`, disabled: item.enabled === false },
      h('span', { class: 'menu-title' }, item.title),
      h('kbd', {}, sub ? '›' : keyLabel(item.key)),
    );
    if (sub) {
      const openSub = () => {
        openMenus = openMenus.filter((m) => {
          if (Number(m.dataset.level) > level) {
            m.remove();
            return false;
          }
          return true;
        });
        const child = buildMenu(item.items, onPick, level + 1);
        document.body.append(child);
        openMenus.push(child);
        const r = btn.getBoundingClientRect();
        place(child, r.right - 2, r.top - 5, r.left + 2);
      };
      btn.addEventListener('mouseenter', openSub);
      btn.addEventListener('click', openSub);
    } else {
      btn.addEventListener('mouseenter', () => {
        openMenus = openMenus.filter((m) => {
          if (Number(m.dataset.level) > level) {
            m.remove();
            return false;
          }
          return true;
        });
      });
      btn.addEventListener('click', () => {
        closeMenus();
        onPick(item);
      });
    }
    menu.append(btn);
  }
  return menu;
}

function place(menu, x, y, flipX = null) {
  menu.style.left = '0px';
  menu.style.top = '0px';
  const { width, height } = menu.getBoundingClientRect();
  let left = x;
  if (left + width > innerWidth - 6) left = flipX != null ? Math.max(6, flipX - width) : Math.max(6, innerWidth - width - 6);
  const top = Math.max(6, Math.min(y, innerHeight - height - 6));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

export function showMenu(items, x, y, onPick = (item) => item.run?.()) {
  closeMenus();
  const menu = buildMenu(items, onPick, 0);
  document.body.append(menu);
  openMenus.push(menu);
  place(menu, x, y);
  return menu;
}

document.addEventListener('mousedown', (e) => {
  if (openMenus.length && !e.target.closest('.menu') && !e.target.closest('[data-menu-anchor]')) closeMenus();
}, true);
document.addEventListener('keydown', (e) => {
  if (!openMenus.length) return;
  const menu = openMenus[openMenus.length - 1];
  const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')];
  const cur = items.indexOf(document.activeElement);
  if (e.key === 'Escape') closeMenus();
  else if (e.key === 'ArrowDown') items[(cur + 1) % items.length]?.focus();
  else if (e.key === 'ArrowUp') items[cur < 0 ? items.length - 1 : (cur - 1 + items.length) % items.length]?.focus();
  else if (e.key === 'ArrowRight' && document.activeElement?.classList.contains('has-sub')) {
    document.activeElement.click();
    setTimeout(() => openMenus[openMenus.length - 1]?.querySelector('.menu-item:not(:disabled)')?.focus(), 0);
  }
  else if (e.key === 'ArrowLeft' && openMenus.length > 1) openMenus.pop().remove();
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// A context menu: native where available, in-page otherwise.
export async function contextMenu(items, x, y) {
  if (isNative && platform.popupMenu) {
    const strip = (list) => list.map((it) => (it.separator ? { separator: true } : it.items ? { title: it.title, items: strip(it.items) } : { id: it.id, title: it.title, checked: it.checked, enabled: it.enabled }));
    const flat = new Map();
    const index = (list) => list.forEach((it) => (it.items ? index(it.items) : it.id && flat.set(it.id, it)));
    index(items);
    const id = await platform.popupMenu(strip(items), x, y);
    if (id) flat.get(id)?.run?.();
    return;
  }
  showMenu(items, x, y);
}

// --- dialogs ----------------------------------------------------------------

export function modal({ title, body, buttons = [{ label: t('好'), value: true, primary: true }], wide = false, panel = false, quick = false, onOpen }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      const btns = [...box.querySelectorAll('.dialog-buttons > button')];
      const at = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // A notice with only its OK button is answered, not dismissed.
        if (buttons.length === 1 && buttons[0].primary && !quick) return;
        close(null);
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && at >= 0) {
        e.preventDefault();
        e.stopPropagation();
        btns[(at + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
      } else if (e.key === 'Tab' && btns.length && (at >= 0 || !box.querySelector('input, textarea, select'))) {
        e.preventDefault();
        e.stopPropagation();
        btns[((at < 0 ? -1 : at) + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
      } else if (e.key === 'Enter' && !e.target.matches('textarea, button, select') && !e.isComposing) {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          close(typeof primary.value === 'function' ? primary.value() : primary.value);
        }
      } else if (!overlay.contains(e.target)) e.stopPropagation();
    };
    const footer = h('div', { class: 'dialog-buttons' }, buttons.map((b) => h('button', { type: 'button', class: b.primary ? 'btn primary' : b.danger ? 'btn danger' : 'btn', onclick: () => close(typeof b.value === 'function' ? b.value() : b.value) }, b.label)));
    const box = h('div', { class: `dialog${wide ? ' wide' : ''}${panel ? ' panel' : ''}${quick ? ' quick' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || t('对话框') }, title && h('h2', {}, title), h('div', { class: 'dialog-body' }, body), buttons.length ? footer : null);
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => e.target === overlay && close(null) }, box);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    const first = box.querySelector('input, textarea, select') || box.querySelector('.btn.primary') || box.querySelector('button');
    first?.focus();
    first?.select?.();
    onOpen?.(box, close);
  });
}

// Returns the index of the chosen button, or -1 if dismissed.
export async function ask({ message, detail = '', buttons = [t('好')], style = 'info', primary = 0 }) {
  // Esc should land on the cancel button, wherever it sits.
  const cancel = buttons.indexOf(t('取消'));
  if (isNative && platform.message) return platform.message({ message, detail, buttons, style, ...(cancel >= 0 ? { cancel } : {}), ...(primary ? { default: primary } : {}) });
  const res = await modal({
    title: message,
    body: detail ? h('p', { class: 'dialog-detail' }, detail) : null,
    buttons: [...buttons].reverse().map((label, k) => ({ label, value: buttons.length - 1 - k, primary: buttons.length - 1 - k === primary, danger: style === 'critical' && k === buttons.length - 1 })),
  });
  return res == null ? -1 : res;
}

export async function prompt({ title, label = '', value = '', placeholder = '', ok = t('好') }) {
  const input = h('input', { type: 'text', class: 'field', value, placeholder, 'aria-label': label || title });
  const res = await modal({
    title,
    body: [label && h('label', { class: 'dialog-detail' }, label), input],
    buttons: [{ label: t('取消'), value: null }, { label: ok, value: () => input.value, primary: true }],
  });
  return res == null ? null : String(res);
}

// A small floating panel anchored to an element; closes on outside click,
// Escape, or a second call for the same anchor.
let openPopover = null;
export function popover(anchor, content, { align = 'right', cls = '' } = {}) {
  const wasFor = openPopover?.anchor;
  openPopover?.close();
  if (wasFor === anchor) return null;
  const box = h('div', { class: `popover ${cls}`, role: 'dialog' }, content);
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const { width, height } = box.getBoundingClientRect();
  const left = align === 'right' ? r.right - width : r.left;
  box.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
  box.style.top = `${Math.max(8, r.top - height - 8)}px`;
  const close = () => {
    box.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (openPopover?.box === box) openPopover = null;
  };
  const onDown = (e) => {
    if (!box.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    // Typing in the document puts the popover away.
    else if (!box.contains(e.target) && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) close();
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  openPopover = { anchor, box, close };
  return openPopover;
}

let toastTimer = null;
export function toast(text, ms = 2200) {
  let el = $('#toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  // A message with more than one line, or too long for the bar, shows its first line
  // and a "View More" button that opens the whole text with a Copy button.
  const full = String(text);
  const more = full.includes('\n') || full.length > 120;
  el.replaceChildren(h('span', { class: 'toast-text' }, more ? full.trim().split('\n')[0] : full));
  if (more) {
    const btn = h('button', { type: 'button', class: 'toast-more' }, t('View More'));
    btn.addEventListener('click', async () => {
      el.classList.remove('show');
      const pick = await modal({ title: '', body: h('pre', { class: 'dialog-detail toast-detail' }, full), buttons: [{ label: t('Copy'), value: 'copy' }, { label: t('好'), value: true, primary: true }] });
      if (pick === 'copy') navigator.clipboard?.writeText(full).catch(() => {});
    });
    el.append(btn);
  }
  el.classList.toggle('has-more', more);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), more ? Math.max(ms, 6000) : ms);
}

export const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};
