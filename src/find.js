// Find and replace. Works on the live editor (matching the Markdown source
// of each block) and, in source code mode, on the plain textarea.

import { h, debounce } from './ui.js';
import { t } from './i18n.js';

// Typora stops counting at this many matches.
const MAX_HITS = 5000;

const canHighlight = typeof Highlight !== 'undefined' && !!CSS.highlights;

export class Finder {
  // `opts` / `onOpts`: the Aa / whole word / regex toggles as last left; they are
  // remembered across windows and launches, as in Typora.
  constructor({ editor, host, source, scroller, isSourceMode, opts = {}, onOpts = () => {} }) {
    Object.assign(this, { editor, source, scroller, isSourceMode, onOpts });
    this.matches = [];
    this.index = -1;
    this.opts = { caseSensitive: false, wholeWord: false, regex: false, ...opts };

    const toggle = (key, label, title) => {
      const btn = h('button', { type: 'button', class: 'find-opt', title: t(title), 'aria-label': t(title), 'aria-pressed': String(!!this.opts[key]), onclick: () => {
        this.opts[key] = !this.opts[key];
        btn.setAttribute('aria-pressed', this.opts[key]);
        this.onOpts({ ...this.opts });
        this.refresh(true);
      } }, label);
      return btn;
    };
    this.input = h('input', { type: 'text', placeholder: t('search text'), 'aria-label': t('Find'), spellcheck: false });
    this.replaceInput = h('input', { type: 'text', class: 'find-field', placeholder: t('replace with'), 'aria-label': t('Replace'), spellcheck: false });
    this.count = h('span', { class: 'find-count', 'aria-live': 'polite' });
    this.caseBtn = toggle('caseSensitive', 'Aa', 'Case Sensitive');
    this.modeBtn = h('button', { type: 'button', class: 'find-mode', 'aria-expanded': 'false', onclick: () => {
      this.setReplace(this.replaceRow.hidden);
      (this.replaceRow.hidden ? this.input : this.replaceInput).focus();
    } }, t('Replace'), h('span', { class: 'find-caret' }, '▾'));
    this.replaceLead = h('span', { class: 'find-lead' });
    this.mainLead = h('span', { class: 'find-lead' }, this.modeBtn);
    this.replaceRow = h('div', { class: 'find-row', hidden: true },
      this.replaceLead,
      this.replaceInput,
      h('button', { type: 'button', class: 'find-text', onclick: () => this.replaceEvery() }, t('All')),
      h('button', { type: 'button', class: 'find-text', onclick: () => this.replaceOne() }, t('Replace')),
    );
    // A bar across the whole window: the search field with its three option
    // toggles inside, then previous / next / close; replace on a second row.
    this.el = h('div', { id: 'find', class: 'find', hidden: true, role: 'search' },
      h('div', { class: 'find-row' },
        this.mainLead,
        h('div', { class: 'find-field find-main' }, this.input, this.count, this.caseBtn, (this.wordBtn = toggle('wholeWord', 'W', 'Whole Word')), toggle('regex', '(.*)', 'Regular Expression')),
        h('button', { type: 'button', class: 'find-opt', title: t('Find Previous'), 'aria-label': t('Find Previous'), onclick: () => this.step(-1) }, '⌃'),
        h('button', { type: 'button', class: 'find-opt', title: t('Find Next'), 'aria-label': t('Find Next'), onclick: () => this.step(1) }, '⌄'),
        h('span', { class: 'find-gap' }),
        h('button', { type: 'button', class: 'find-opt', title: t('Close'), 'aria-label': t('Close'), onclick: () => this.close() }, '✕'),
      ),
      this.replaceRow,
    );
    this.msg = h('div', { class: 'find-row find-msg', hidden: true, role: 'status' });
    this.el.append(this.msg);
    host.append(this.el);

    const search = debounce(() => this.refresh(true), 80);
    this.input.addEventListener('input', (e) => {
      if (!e.isComposing) search();
    });
    this.input.addEventListener('compositionend', () => setTimeout(() => this.refresh(true), 100));
    // Tab: on to the replace field when it shows (Shift+Tab back); otherwise a tab character.
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (!this.replaceRow.hidden && !e.shiftKey) this.replaceInput.focus();
      else if (!e.shiftKey) {
        this.input.setRangeText('\t', this.input.selectionStart, this.input.selectionEnd, 'end');
        search();
      }
    });
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        this.input.focus();
      }
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.target === this.replaceInput) this.replaceOne();
        else this.step(e.shiftKey ? -1 : 1);
      }
      e.stopPropagation();
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  setReplace(on) {
    this.replaceRow.hidden = !on;
    // The Replace switch sits beside the row it controls.
    (on ? this.replaceLead : this.mainLead).append(this.modeBtn);
    this.modeBtn.setAttribute('aria-expanded', on);
    this.modeBtn.lastChild.textContent = on ? '▴' : '▾';
  }

  open({ replace = false, seed = '', reseed = false } = {}) {
    const wasOpen = !this.el.hidden;
    this.el.hidden = false;
    this.setReplace(replace);
    // Already open: the field is focused and selected; what it holds stays (unless a
    // jump from elsewhere brings its own query).
    if ((!wasOpen || reseed) && seed && !seed.includes('\n')) this.input.value = seed;
    this.input.focus();
    this.input.select();
    if (!wasOpen || reseed) this.refresh(true);
  }

  // keepCaret: the user went back to the document (a click there): the caret stays
  // where that put it instead of on the current match.
  close({ keepCaret = false } = {}) {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.clearHighlights();
    const m = this.matches[this.index];
    this.matches = [];
    this.index = -1;
    if (keepCaret) return;
    if (this.isSourceMode()) this.source.focus();
    else if (m) this.editor.selectMatch(m);
    else this.editor.setSel(this.editor.sel()?.focus || { i: 0, leaf: 0, off: 0 });
  }

  // --- matching -------------------------------------------------------------

  sourceMatches(query) {
    let re;
    try {
      const src = this.opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(this.opts.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])` : src, `gu${this.opts.caseSensitive ? '' : 'i'}`);
    } catch {
      return [];
    }
    const out = [];
    const text = this.source.value;
    for (let m = re.exec(text); m && out.length <= MAX_HITS; m = re.exec(text)) {
      if (m[0] === '') re.lastIndex++;
      else out.push({ from: m.index, to: m.index + m[0].length, groups: [...m] });
    }
    return out;
  }

  // Recompute matches. `jump` moves to the first match at or after the caret.
  // A search typed a moment ago may still be waiting for its timer: run it
  // before stepping or replacing, so those act on the current text.
  settle() {
    if (this.input.value !== this.lastQuery) this.refresh(true);
  }

  refresh(jump = false) {
    if (this.el.hidden) return;
    const query = this.input.value;
    this.lastQuery = query;
    const inSource = this.isSourceMode();
    this.matches = !query ? [] : inSource ? this.sourceMatches(query) : this.editor.findAll(query, this.opts);
    if (jump) {
      this.index = -1;
      if (this.matches.length) {
        if (inSource) {
          const at = this.source.selectionStart;
          this.index = Math.max(0, this.matches.findIndex((m) => m.from >= at));
        } else {
          const pos = this.editor.sel()?.start;
          this.index = pos ? this.matches.findIndex((m) => m.i > pos.i || (m.i === pos.i && (m.leaf > pos.leaf || (m.leaf === pos.leaf && m.to > pos.off)))) : 0;
          if (this.index < 0) this.index = 0;
        }
      }
    } else if (this.index >= this.matches.length) this.index = this.matches.length - 1;
    this.paint();
  }

  paint() {
    const n = this.matches.length;
    // More than Typora's 5000 hits shows "5000+" ("Too many matches").
    if (this.input.value && n > MAX_HITS) {
      this.count.replaceChildren(h('span', { class: 'error-message', title: t('Too many matches') }, `${MAX_HITS}+`));
    } else this.count.textContent = this.input.value ? (n ? `${this.index + 1} / ${n}` : t('No Results')) : '';
    this.el.classList.toggle('no-match', !!this.input.value && !n);
    this.clearHighlights();
    if (this.isSourceMode()) return this.onSourceMarks?.(this.input.value ? this.matches.slice(0, MAX_HITS) : [], this.index);
    if (!canHighlight || !n) return;
    CSS.highlights.set('find', new Highlight(...this.editor.matchRanges(this.matches)));
    const cur = this.matches[this.index];
    if (cur) CSS.highlights.set('find-current', new Highlight(...this.editor.matchRanges([cur])));
  }

  clearHighlights() {
    this.onSourceMarks?.([], -1);
    if (!canHighlight) return;
    CSS.highlights.delete('find');
    CSS.highlights.delete('find-current');
  }

  reveal() {
    const m = this.matches[this.index];
    if (!m) return;
    if (this.isSourceMode()) {
      this.source.setSelectionRange(m.from, m.to);
      const before = this.source.value.slice(0, m.from).split('\n').length;
      const total = this.source.value.split('\n').length;
      this.scroller.scrollTop = Math.max(0, (before / total) * this.source.scrollHeight - this.scroller.clientHeight / 3);
    } else {
      const active = document.activeElement;
      this.editor.selectMatch(m);
      // Keep typing in the find box.
      if (this.el.contains(active)) active.focus({ preventScroll: true });
    }
    this.paint();
  }

  step(dir) {
    if (this.el.hidden) {
      this.open({ seed: this.seedText?.() || '' });
      if (!this.matches.length) return null;
    }
    this.settle();
    if (!this.matches.length) return this.refresh(true);
    this.index = (this.index + dir + this.matches.length) % this.matches.length;
    return this.reveal();
  }

  // --- replacing ------------------------------------------------------------

  expand(m) {
    const r = this.replaceInput.value;
    return this.opts.regex ? r.replace(/\$(\d)/g, (_, k) => m.groups[Number(k)] ?? '') : r;
  }

  replaceOne() {
    this.settle();
    const m = this.matches[this.index];
    if (!m) return;
    if (this.isSourceMode()) {
      this.replacing = true;
      this.source.setRangeText(this.expand(m), m.from, m.to, 'end');
      this.source.dispatchEvent(new Event('input'));
      this.replacing = false;
    } else this.editor.replaceMatch(m, this.replaceInput.value, this.opts.regex);
    const at = this.index;
    this.refresh();
    if (this.matches.length) {
      // On to the match that followed the replaced one, wrapping to the first.
      this.index = at < this.matches.length ? at : 0;
      this.paint();
      this.reveal();
    }
    this.replaceInput.focus();
  }

  replaceEvery() {
    this.settle();
    if (!this.matches.length) return;
    const replaced = this.matches.length;
    if (this.isSourceMode()) {
      let text = this.source.value;
      for (const m of [...this.matches].reverse()) text = text.slice(0, m.from) + this.expand(m) + text.slice(m.to);
      this.replacing = true;
      this.source.value = text;
      this.source.dispatchEvent(new Event('input'));
      this.replacing = false;
    } else this.editor.replaceAll(this.matches, this.replaceInput.value, this.opts.regex);
    this.refresh(true);
    this.replaceInput.focus();
    this.showMessage(`Replaced ${replaced} occurrence(s)`);
  }

  // A line under the replace field after Replace All, with Undo; it goes after 5 s.
  showMessage(text) {
    clearTimeout(this.msgTimer);
    const undo = h('button', { type: 'button', class: 'find-text', onclick: () => {
      this.msg.hidden = true;
      if (this.isSourceMode()) {
        this.replacing = true;
        this.source.focus();
        document.execCommand('undo');
        this.replacing = false;
      } else this.editor.undo();
      this.refresh(true);
    } }, t('Undo'));
    const close = h('button', { type: 'button', class: 'find-opt', title: t('Close'), 'aria-label': t('Close'), onclick: () => (this.msg.hidden = true) }, '✕');
    this.msg.replaceChildren(h('span', { class: 'find-msg-text' }, text), undo, close);
    this.msg.hidden = false;
    this.msgTimer = setTimeout(() => (this.msg.hidden = true), 5000);
  }
}
