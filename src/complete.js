// Autocomplete in the text: emoji shortcodes (":sm" offers ":smile:", or a keyword
// such as ":happy") and code languages after a typed fence ("```py" offers python…).
// Esc opens the list when it is not showing yet.

import { inlineCtx } from './inline.js';
import { leafText, withLeaf, splice } from './editor.js';
import { h } from './ui.js';

const EMOJI = /(?:^|[\s(（])(:([a-z0-9_+-]*))$/;
const FENCE = /^(```+|~~~+)([\w+#.-]*)$/;
const RAW = new Set(['code', 'math', 'html', 'meta', 'hr', 'toc']);
const PAGE = 5;

// Everyday words for some emoji, in addition to their shortcodes.
const KEYWORDS = {
  happy: ['smile', 'grin', 'smiley', 'blush', 'joy'],
  sad: ['cry', 'sob', 'disappointed', 'pensive', 'frowning'],
  love: ['heart', 'heart_eyes', 'kissing_heart', 'two_hearts', 'sparkling_heart'],
  laugh: ['joy', 'laughing', 'rofl', 'grin'],
  angry: ['angry', 'rage', 'triumph'],
  ok: ['ok_hand', '+1', 'white_check_mark', 'heavy_check_mark'],
  yes: ['+1', 'white_check_mark', 'heavy_check_mark'],
  no: ['-1', 'x', 'no_entry_sign'],
  good: ['+1', 'ok_hand', 'star'],
  bad: ['-1', 'poop', 'x'],
  done: ['white_check_mark', 'heavy_check_mark', 'checkered_flag'],
  warning: ['warning', 'rotating_light', 'exclamation'],
  idea: ['bulb', 'thinking'],
  fire: ['fire', 'boom'],
  party: ['tada', 'confetti_ball', 'balloon'],
  celebrate: ['tada', 'confetti_ball', 'champagne'],
  question: ['question', 'grey_question', 'thinking'],
  time: ['clock3', 'hourglass', 'alarm_clock', 'stopwatch'],
  money: ['moneybag', 'dollar', 'money_with_wings'],
  work: ['computer', 'briefcase', 'hammer_and_wrench'],
  food: ['pizza', 'hamburger', 'sushi', 'apple'],
  coffee: ['coffee', 'tea'],
  weather: ['sunny', 'cloud', 'umbrella', 'snowflake'],
  sun: ['sunny', 'sun_with_face'],
  rain: ['umbrella', 'cloud_with_rain'],
  cat: ['cat', 'cat2', 'smiley_cat'],
  dog: ['dog', 'dog2'],
  bug: ['bug', 'beetle'],
  rocket: ['rocket'],
  ship: ['rocket', 'ship'],
  mail: ['email', 'envelope', 'incoming_envelope'],
  phone: ['iphone', 'telephone_receiver', 'phone'],
  book: ['book', 'books', 'notebook'],
  write: ['pencil2', 'memo', 'writing_hand'],
  note: ['memo', 'spiral_notepad', 'pencil'],
  lock: ['lock', 'closed_lock_with_key', 'key'],
  star: ['star', 'star2', 'stars'],
  music: ['musical_note', 'notes', 'headphones'],
  thanks: ['pray', 'raised_hands'],
  wave: ['wave', 'ocean'],
  think: ['thinking'],
};

export function installEmojiComplete(editor, isOn, { languages = () => [] } = {}) {
  const box = h('div', { class: 'complete', role: 'listbox', hidden: true });
  document.body.append(box);
  let items = [];
  let active = 0;
  let ctx = null;

  const close = () => {
    box.hidden = true;
    ctx = null;
  };

  const paint = () => {
    box.replaceChildren(...items.map((it, k) => h('div', { class: `complete-item${k === active ? ' active' : ''}`, role: 'option', 'aria-selected': k === active, onmousedown: (e) => {
      e.preventDefault();
      pick(k);
    } }, ...(ctx.kind === 'emoji' ? [h('span', { class: 'complete-emoji' }, inlineCtx.emoji[it]), `:${it}:`] : [it]))));
    box.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  function pick(k) {
    const name = items[k];
    if (!ctx || name == null) return close();
    const { i, leaf, from, to, kind, fence } = ctx;
    const b = editor.doc[i];
    const text = leafText(b, leaf);
    const insert = kind === 'emoji' ? `:${name}:` : `${fence}${name}`;
    editor.apply(splice(editor.doc, i, 1, [withLeaf(b, leaf, text.slice(0, from) + insert + text.slice(to))]), { i, leaf, off: from + insert.length });
    return close();
  }

  function emojiMatches(q) {
    const names = Object.keys(inlineCtx.emoji).sort();
    const heads = names.filter((n) => n.startsWith(q));
    const words = q ? names.filter((n) => !n.startsWith(q) && (n.includes(`_${q}`) || n.includes(`-${q}`))) : [];
    const keyed = (KEYWORDS[q] || []).filter((n) => inlineCtx.emoji[n]);
    return [...new Set([...(names.includes(q) ? [q] : []), ...keyed, ...heads.filter((n) => n !== q), ...words])].slice(0, 200);
  }

  function update(force = false) {
    if (editor.composing || editor.readOnly) return close();
    const sel = editor.getSel();
    if (!sel || !sel.collapsed) return close();
    const { i, leaf, off } = sel.focus;
    const b = editor.doc[i];
    if (!b || RAW.has(b.type)) return close();
    const before = leafText(b, leaf).slice(0, off);
    let m;
    let found = null;
    if (b.type === 'p' && (m = FENCE.exec(before)) && leafText(b, leaf).length === off && (force || m[2])) {
      const q = m[2].toLowerCase();
      const list = languages().filter((l) => l.toLowerCase().startsWith(q));
      found = { kind: 'fence', fence: m[1], list, from: 0 };
    } else if (inlineCtx.emoji && (isOn() || force) && (m = EMOJI.exec(before)) && (force || m[2].length >= 2)) {
      found = { kind: 'emoji', list: emojiMatches(m[2]), from: off - m[1].length };
    }
    if (!found || !found.list.length) return close();
    if (!force && found.list.length === 1 && (found.kind === 'emoji' ? found.list[0] === m[2] : found.list[0].toLowerCase() === m[2].toLowerCase())) return close();
    items = found.list;
    ctx = { i, leaf, from: found.from, to: off, kind: found.kind, fence: found.fence };
    active = 0;
    paint();
    const rect = editor.caretRect();
    if (!rect) return close();
    box.hidden = false;
    const top = rect.bottom + 6;
    box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8))}px`;
    box.style.top = `${top + box.offsetHeight > window.innerHeight - 8 ? rect.top - box.offsetHeight - 6 : top}px`;
    return null;
  }

  // The third backtick (or tilde) of a fence typed into an empty paragraph fills in
  // the default code language, selected so typing replaces it.
  function defaultLang() {
    const sel = editor.getSel();
    if (!sel || !sel.collapsed) return false;
    const b = editor.doc[sel.focus.i];
    if (!b || b.type !== 'p' || !/^(```|~~~)$/.test(b.text) || sel.focus.off !== 3) return false;
    const lang = editor.codeLang?.(editor.opts.defaultCodeLang) || '';
    if (!lang) return false;
    const { i } = sel.focus;
    editor.apply(splice(editor.doc, i, 1, [{ ...b, text: b.text + lang }]), { anchor: { i, leaf: 0, off: 3 }, focus: { i, leaf: 0, off: 3 + lang.length } });
    return true;
  }

  editor.root.addEventListener('input', (e) => setTimeout(() => {
    if (e.data && /^[`~]$/.test(e.data) && defaultLang()) return;
    update();
  }, 0));
  editor.root.addEventListener('blur', close);
  editor.scroller.addEventListener('scroll', close, { passive: true });
  document.addEventListener('selectionchange', () => {
    // Moving the caret away from what is being completed dismisses the list.
    if (!ctx) return;
    const sel = editor.getSel();
    if (!sel || !sel.collapsed || sel.focus.i !== ctx.i || sel.focus.leaf !== ctx.leaf || sel.focus.off < ctx.from + 1) close();
  });
  // Ahead of the editor's own key handling while the list is open.
  editor.root.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (box.hidden) {
      // Esc asks for the list now (even for one letter, or none after a fence).
      if (e.key === 'Escape' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Right after an opening $ (inline math on), Esc closes the formula: $|$.
        const sel = editor.getSel();
        const b = sel?.collapsed && editor.doc[sel.focus.i];
        if (inlineCtx.math && b && !RAW.has(b.type)) {
          const text = leafText(b, sel.focus.leaf);
          const off = sel.focus.off;
          const opening = text[off - 1] === '$' && text[off - 2] !== '$' && text[off - 2] !== '\\' && text[off] !== '$';
          if (opening && (text.slice(0, off).match(/\$/g) || []).length % 2 === 1) {
            editor.apply(splice(editor.doc, sel.focus.i, 1, [withLeaf(b, sel.focus.leaf, `${text.slice(0, off)}$${text.slice(off)}`)]), sel.focus);
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
        }
        update(true);
        if (!box.hidden) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
      return;
    }
    const nav = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];
    if (e.shiftKey && nav.includes(e.key)) return close();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    else if (e.key === 'PageDown') active = Math.min(items.length - 1, active + PAGE);
    else if (e.key === 'PageUp') active = Math.max(0, active - PAGE);
    else if (e.key === 'Home') active = 0;
    else if (e.key === 'End') active = items.length - 1;
    else if (e.key === 'Enter') {
      if (active < 0) return close();
      pick(active);
    } else if (e.key === 'Escape') close();
    else return;
    if (!box.hidden) paint();
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  // Enter arrives as a beforeinput too; it must not also split the paragraph.
  editor.root.addEventListener('beforeinput', (e) => {
    if (!box.hidden && (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  return { close, isOpen: () => !box.hidden, open: () => update(true) };
}
