// The sidebar: outline, file tree, article list and search across files,
// plus the Quick Open palette.
//
// Layout: a centred title at the top names the current view; the buttons
// that switch views sit beside it and only show while the pointer is over
// the sidebar. In the file views a footer carries "new file", the folder
// name and the list/tree switch.

import { h, contextMenu, modal, prompt, ask, toast, debounce } from './ui.js';
import { platform, path, isMarkdownName, isBundle, isNative } from './platform.js';
import { settings, set as setPref, onSettings } from './prefs.js';
import { esc, headingHtml } from './inline.js';
import { hydrate } from './rich.js';
import { t } from './i18n.js';

// Drops leading, trailing and doubled separators.
const tidy = (items) => {
  const out = [];
  for (const it of items) if (!it.separator || (out.length && !out[out.length - 1].separator)) out.push(it);
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
};

// The article list reads at most this many files.
const MAX_LIST = 3000;

const TITLES = { outline: 'Outline', tree: 'Files', list: 'Articles', search: 'Search' };
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const SORTS = {
  name: (a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0),
  natural: byName,
  date: (a, b) => (a.mtime || 0) - (b.mtime || 0),
  created: (a, b) => (a.created || a.mtime || 0) - (b.created || b.mtime || 0),
};
const SORT_MENU = [
  ['natural-asc', 'Sort Naturally (Ascending)'], ['natural-desc', 'Sort Naturally (Descending)'],
  ['name-asc', 'Sort by Name (Ascending)'], ['name-desc', 'Sort by Name (Descending)'],
  ['date-asc', 'Sort by Modification Date (Ascending)'], ['date-desc', 'Sort by Modification Date (Descending)'],
  ['created-asc', 'Sort by Creation Date (Ascending)'], ['created-desc', 'Sort by Creation Date (Descending)'],
];
// The tree and the article list each keep their own order.
const sortKey = (tab) => (tab === 'tree' ? 'treeSort' : 'listSort');
function sorter(tab) {
  const [field, dir] = String(settings[sortKey(tab)] || 'natural-asc').split('-');
  const cmp = SORTS[field] || SORTS.natural;
  return dir === 'desc' ? (a, b) => cmp(b, a) : cmp;
}

// Glob -> RegExp, as file filter patterns read them: "**/" any folders, "**"
// anything, "*" and "?" within one path part, [abc] / [!abc] classes.
const globCache = new Map();
function globRe(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; src += '(?:.*/)?'; } else src += '.*';
      } else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else if (c === '[') {
      let j = i + 1;
      let cls = '[';
      if (glob[j] === '!' || glob[j] === '^') { cls += '^'; j++; }
      while (j < glob.length && glob[j] !== ']') {
        if (glob[j] === '\\') { cls += `\\${glob[j + 1] || ''}`; j += 2; } else { cls += glob[j].replace(/[.^$+(){}=|]/, '\\$&'); j++; }
      }
      src += `${cls}]`;
      i = j;
    } else src += '.^$+(){}=!|\\'.includes(c) ? `\\${c}` : c;
  }
  const re = new RegExp(`^${src}$`);
  globCache.set(glob, re);
  return re;
}
// A file counts as supported when it is Markdown or text, or has no extension.
const supportedFile = (name) => !path.extname(name) || isMarkdownName(name);
// Whether a file shows in the tree or the library under the File Tree / Library settings.
export function fileVisible(name, rel, view) {
  const mode = view === 'tree' ? settings.treeFilter : settings.libraryFilter;
  if (mode === 'all') return true;
  if (mode !== 'custom') return supportedFile(name);
  let include = supportedFile(name);
  let exclude = false;
  for (let p of settings[view === 'tree' ? 'treePatterns' : 'libraryPatterns'] || []) {
    p = String(p || '').trim();
    const neg = p[0] === '!';
    if (neg) p = p.slice(1).trim();
    if (!p) continue;
    if (globRe(p).test(p.includes('/') ? rel : name)) {
      if (neg) exclude = true;
      else include = true;
    }
  }
  return include && !exclude;
}

const svg = (d, { fill = false, size = 14 } = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<path d="${d}" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"'}/>`;
  return el;
};
const ICON = {
  folder: () => svg('M1.5 3.5a1 1 0 0 1 1-1h3.6l1.5 1.7h5.9a1 1 0 0 1 1 1v7.3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z', { fill: true }),
  file: () => svg('M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 5.5h2'),
  // A document that is a folder (TextBundle): a page with a fold-over and a clip.
  bundle: () => svg('M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 8h5M5.5 10.5h3M10.5 9v4.5h-2V9'),
  files: () => svg('M2 3.5h12M2 8h12M2 12.5h12'),
  outline: () => svg('M2 3.5h3M7 3.5h7M4 8h3M9 8h5M4 12.5h3M9 12.5h5'),
  search: () => svg('M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6 14 14'),
  plus: () => svg('M8 3v10M3 8h10'),
  tree: () => svg('M3 2.5v9h4M3 6h4M9 6h4.5M9 11.5h4.5'),
  list: () => svg('M2 3h12v4H2zM2 9h12v4H2z'),
  chevron: () => svg('M5.5 3.5 10 8l-4.5 4.5'),
  unpin: () => svg('M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v4h-9v-9h4'),
  more: () => svg('M8 2.4a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 0 0 0-2.2zM8 6.9a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 0 0 0-2.2zM8 11.4a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 0 0 0-2.2z', { fill: true }),
};

// "2 minutes ago", as file lists show it.
// When a file was changed, as people say it: "Just now", "Today 14:05", "Yesterday",
// a weekday within the week, the date otherwise.
function ago(ms) {
  if (!ms) return '';
  const now = new Date();
  const d = new Date(ms);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (now - d < 60000 && days === 0) return t('just now');
  if (days === 0) return t('Today {0}', time);
  if (days === 1) return t('Yesterday {0}', time);
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

// A failed file operation: Typora's alert with the reason underneath.
const failed = (title, err) => ask({ message: title, detail: String(err?.message || err || ''), buttons: [t('OK')], style: 'warning' });

export class Sidebar {
  constructor({ host, app }) {
    this.app = app;
    this.root = null;
    this.tab = 'outline';
    this.filesTab = 'tree';
    this.open = new Set(); // expanded folders
    this.cache = new Map(); // folder path -> entries
    this.filter = '';
    this.headings = [];
    this.opened = new Set(); // ids of the headings whose children are shown
    this.seeded = false;

    this.switchBtn = h('button', { type: 'button', class: 'side-btn', onclick: () => this.app.showSidebar(this.tab === 'outline' ? this.filesTab : 'outline') });
    this.title = h('span', { class: 'side-title' });
    this.searchBtn = h('button', { type: 'button', class: 'side-btn', title: t('Search'), 'aria-label': t('Search'), onclick: () => (this.tab === 'outline' ? this.toggleOutlineFilter() : this.app.showSidebar(this.tab === 'search' ? this.filesTab : 'search')) }, ICON.search());
    this.body = h('div', { class: 'side-body', tabindex: '-1' });
    this.installDropTarget(this.body);
    this.installKeys();
    this.footer = h('div', { class: 'side-footer' });
    const head = h('div', { class: 'side-head' }, this.switchBtn, this.title, this.searchBtn);
    host.append(head, this.body, this.footer);
    // Dragging a file over the header or the footer scrolls the list that way.
    for (const [bar, step] of [[head, -14], [this.footer, 14]]) {
      bar.addEventListener('dragover', (ev) => {
        if (!this.dragging) return;
        ev.preventDefault();
        this.body.scrollTop += step;
      });
    }
    // Drag the right edge to resize, between 160px and the window width less 220px;
    // letting go within 100px of the left edge closes the sidebar. The width is kept.
    const grip = h('div', { class: 'side-resizer', 'aria-hidden': 'true' });
    host.append(grip);
    const apply = (w) => (w ? document.documentElement.style.setProperty('--sidebar-w', `${w}px`) : document.documentElement.style.removeProperty('--sidebar-w'));
    apply(settings.sidebarWidth);
    onSettings((patch) => patch && 'sidebarWidth' in patch && apply(settings.sidebarWidth));
    grip.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const left = host.getBoundingClientRect().left;
      grip.classList.add('dragging');
      document.body.classList.add('resizing-sidebar');
      const width = (x) => Math.min(Math.max(160, x - left), window.innerWidth - 220);
      const move = (e) => apply(e.clientX - left < 100 ? settings.sidebarWidth : width(e.clientX));
      const up = (e) => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        grip.classList.remove('dragging');
        document.body.classList.remove('resizing-sidebar');
        if (e.clientX - left < 100) {
          apply(settings.sidebarWidth);
          setPref({ sidebar: false });
        } else setPref({ sidebarWidth: Math.round(width(e.clientX)) });
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    this.setTab('outline');
    onSettings((patch) => {
      if (patch && 'outlineCollapsible' in patch && this.tab === 'outline') this.renderOutline();
    });
  }

  setTab(tab) {
    this.tab = tab;
    if (tab === 'tree' || tab === 'list') this.filesTab = tab;
    this.title.textContent = t(TITLES[tab]);
    const toFiles = tab === 'outline';
    this.switchBtn.replaceChildren(toFiles ? ICON.files() : ICON.outline());
    // Typora's hint names the view the button switches to.
    this.switchBtn.title = t(toFiles ? (this.filesTab === 'tree' ? 'Switch to File Tree view' : 'Switch to File List view') : 'Switch to Outline view');
    this.switchBtn.setAttribute('aria-label', this.switchBtn.title);
    this.render();
  }

  async setRoot(root) {
    this.root = root;
    this.cache.clear();
    this.open = new Set(root ? [root] : []);
    this.files = null;
    // Files added, renamed or removed by other apps show up without a manual refresh.
    platform.watchFolder(root).catch(() => {});
    await this.render();
  }

  // The folder's entries for one panel ('tree' or 'library'): folders first.
  async entries(dir, force = false, view = 'tree') {
    if (force || !this.cache.has(dir)) {
      const all = await platform.list(dir, isNative && settings.showHidden ? { hidden: true } : {});
      const keep = all
        // A TextBundle is a folder on disk and a document to the user.
        .map((e) => (e.isDir && isBundle(e.name) ? { ...e, isDir: false, isBundle: true } : e))
        .filter((e) => e.name !== '.DS_Store');
      const cmp = sorter('list');
      keep.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : cmp(a, b)));
      this.cache.set(dir, keep);
    }
    const rel = (e) => path.relative(this.root || dir, e.path).replace(/\\/g, '/');
    // Each panel sorts by its own order; the tree puts folders first unless
    // "Group By Folder" is off in its sort menu.
    const cmp = sorter(view === 'tree' ? 'tree' : 'list');
    const group = view !== 'tree' || settings.treeGroup !== false;
    return this.cache.get(dir).filter((e) => e.isDir || fileVisible(e.name, rel(e), view))
      .sort((a, b) => (group && a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : cmp(a, b)));
  }

  // Documents open in the editor; anything else goes to its own app.
  openEntry(e, ev = null) {
    // ⌘-click: in a window of its own (any file; a folder opens there as the sidebar's root).
    if (ev?.metaKey && isNative) return platform.newWindow(e.path);
    if (isMarkdownName(e.name)) return this.app.openPath(e.path);
    // Anything else is previewed in the window (with a way to open it elsewhere).
    return isNative ? this.app.previewFile(e.path) : this.app.openPath(e.path);
  }

  // Every Markdown file under the root, breadth first, capped.
  async allFiles(force = false) {
    if (this.files && !force) return this.files;
    const out = [];
    const queue = [this.root];
    while (queue.length && out.length < MAX_LIST) {
      const dir = queue.shift();
      let items = [];
      try {
        items = await this.entries(dir, force, 'library');
      } catch {
        continue;
      }
      for (const e of items) {
        if (e.isDir) {
          if (!/^(node_modules|\.git)$/.test(e.name)) queue.push(e.path);
        } else out.push(e);
      }
    }
    this.files = out;
    return out;
  }

  async refresh() {
    this.cache.clear();
    this.files = null;
    await this.render();
  }

  async render() {
    const token = (this.token = (this.token || 0) + 1);
    this.footer.textContent = '';
    if (this.tab === 'outline') {
      // The outline can leave the sidebar for a floating panel (Typora's "Unpin Outline Panel").
      this.footer.append(
        h('button', { type: 'button', class: 'side-btn', title: t('Unpin Outline Panel'), 'aria-label': t('Unpin Outline Panel'), onclick: () => this.app.unpinOutline() }, ICON.unpin()),
        h('span', { class: 'side-root' }, t('Outline')),
      );
      return this.renderOutline();
    }
    if (!this.root) {
      // With no folder, the footer's label is the way to open one (as in Typora).
      this.footer.append(h('button', { type: 'button', class: 'side-root', onclick: () => this.app.openFolder() }, t('Open Folder…')));
      this.body.replaceChildren(h('div', { class: 'side-empty' }, h('p', {}, t('No Folder is Opened.')), h('button', { type: 'button', class: 'btn', onclick: () => this.app.openFolder() }, t('Open Folder…'))));
      return null;
    }
    const toList = this.filesTab === 'tree';
    this.footer.append(
      h('button', { type: 'button', class: 'side-btn', title: t('New File'), 'aria-label': t('New File'), onclick: () => this.newFile(this.root) }, ICON.plus()),
      h('button', { type: 'button', class: 'side-root', title: this.root, onclick: (e) => this.moreMenu(e) }, path.basename(this.root)),
      h('button', { type: 'button', class: 'side-btn', title: t('More'), 'aria-label': t('More'), onclick: (e) => this.moreMenu(e) }, ICON.more()),
      h('button', { type: 'button', class: 'side-btn', title: t('Switch File List/Tree View'), 'aria-label': t('Switch File List/Tree View'), onclick: () => this.app.showSidebar(toList ? 'list' : 'tree') }, toList ? ICON.list() : ICON.tree()),
    );
    if (this.tab === 'tree') {
      const tree = h('div', { class: 'tree', role: 'tree' });
      tree.addEventListener('contextmenu', (ev) => this.treeBlankMenu(ev));
      tree.append(h('div', { class: 'tree-row tree-root', title: this.root, dataset: { path: this.root, drop: this.root }, onclick: (e) => this.moreMenu(e), oncontextmenu: (ev) => {
        ev.preventDefault();
        this.fileMenu({ path: this.root, name: path.basename(this.root), isDir: true }, ev.clientX, ev.clientY);
      } }, h('span', { class: 'tree-icon' }, ICON.folder()), h('span', { class: 'tree-name' }, path.basename(this.root))));
      await this.fillTree(tree, this.root, 0);
      if (token === this.token) {
        this.body.replaceChildren(tree);
        this.body.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
        this.showCursor();
      }
    } else if (this.tab === 'list') await this.renderList(token);
    else if (this.tab === 'search') this.renderSearch();
    return null;
  }

  // --- outline --------------------------------------------------------------

  // A new document starts with its outline folded.
  resetOutline() {
    this.opened = new Set();
    this.seeded = false;
  }

  setOutline(headings, activeIndex) {
    this.headings = headings;
    this.active = activeIndex;
    // The outline starts folded to its top level; a lone top-level heading
    // starts open, since otherwise there would be a single line to look at.
    if (!this.seeded && headings.length) {
      this.seeded = true;
      const tops = headings.filter((hd, k) => !this.parentOf(k));
      if (tops.length === 1) this.opened.add(tops[0].id);
    }
    if (this.tab === 'outline') this.renderOutline();
  }

  setActive(activeIndex) {
    if (this.active === activeIndex) return;
    this.active = activeIndex;
    this.onActive?.();
    if (this.tab !== 'outline') return;
    const shown = this.shownFor(activeIndex);
    for (const a of this.body.querySelectorAll('.outline-item')) a.classList.toggle('active', Number(a.dataset.i) === shown);
    this.body.querySelector('.outline-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  get foldable() {
    return settings.outlineCollapsible;
  }

  // The heading above k that k is nested under.
  parentOf(k) {
    for (let j = k - 1; j >= 0; j--) if (this.headings[j].level < this.headings[k].level) return this.headings[j];
    return null;
  }

  hasChildren(k) {
    const next = this.headings[k + 1];
    return !!next && next.level > this.headings[k].level;
  }

  // The outline row that stands for a heading: the heading itself, or the
  // folded ancestor it is hidden under.
  shownFor(blockIndex) {
    const k = this.headings.findIndex((hd) => hd.i === blockIndex);
    if (k < 0 || !this.foldable) return blockIndex;
    const chain = [];
    for (let j = k; j >= 0; ) {
      chain.unshift(j);
      const up = this.parentOf(j);
      j = up ? this.headings.indexOf(up) : -1;
    }
    for (const j of chain) if (j !== k && !this.opened.has(this.headings[j].id)) return this.headings[j].i;
    return blockIndex;
  }

  foldAll(open) {
    this.opened = new Set(open ? this.headings.map((hd) => hd.id) : []);
    this.renderOutline();
  }

  // The same list is also shown as a popover over the document.
  // onJump: the floating panel's own jump; rerender: how a fold redraws the list there.
  outlineNodes(onJump = null, rerender = null) {
    const items = [];
    const popover = !!onJump;
    const foldable = this.foldable && (!popover || !!rerender);
    const redraw = () => (rerender ? rerender() : this.renderOutline());
    const shown = foldable ? this.shownFor(this.active) : this.active;
    let hideBelow = null;
    this.headings.forEach((hd, k) => {
      if (hideBelow !== null && hd.level > hideBelow) return;
      hideBelow = null;
      const parent = this.hasChildren(k);
      const closed = foldable && parent && !this.opened.has(hd.id);
      if (closed) hideBelow = hd.level;
      const jump = () => {
        if (popover) return onJump(hd.i);
        // Going to a heading also unfolds it.
        if (parent && foldable && !this.opened.has(hd.id)) {
          this.opened.add(hd.id);
          redraw();
        }
        return this.app.jumpToHeading(hd.i);
      };
      items.push(h('a', { class: `outline-item l${hd.level}${hd.i === shown ? ' active' : ''}`, dataset: { i: hd.i }, onclick: jump },
        parent ? h('span', { class: `twist${closed ? '' : ' open'}`, onclick: (e) => {
          e.stopPropagation();
          if (closed) this.opened.add(hd.id);
          else this.opened.delete(hd.id);
          redraw();
        } }, ICON.chevron()) : h('span', { class: 'twist none' }),
        outlineText(hd.text)));
    });
    return items;
  }

  outlineMenu(ev) {
    ev.preventDefault();
    contextMenu([
      { id: 'highlight', title: t('Highlight Current Header'), enabled: this.active >= 0, run: () => this.highlightCurrent() },
      { separator: true },
      { id: 'filter', title: t('Filter'), checked: this.outlineFilter != null, run: () => this.toggleOutlineFilter() },
      { separator: true },
      { id: 'expandAll', title: t('Expand All'), enabled: this.foldable, run: () => this.foldAll(true) },
      { id: 'collapseAll', title: t('Collapse All'), enabled: this.foldable, run: () => this.foldAll(false) },
      { separator: true },
      { id: 'foldable', title: t('Collapsible Outline'), checked: this.foldable, run: () => setPref({ outlineCollapsible: true }) },
      { id: 'flat', title: t('Flat Outline'), checked: !this.foldable, run: () => setPref({ outlineCollapsible: false }) },
    ], ev.clientX, ev.clientY);
  }

  renderOutline() {
    const box = this.outlineFilter != null ? this.outlineFilterBox() : null;
    if (!this.headings.length) {
      this.body.replaceChildren(...[box, h('div', { class: 'side-empty', oncontextmenu: (ev) => this.outlineMenu(ev) }, t('Outline is Empty.'))].filter(Boolean));
      return;
    }
    const q = (this.outlineFilter || '').trim();
    const nav = h('nav', { class: `outline${q ? ' filtering' : ''}`, 'aria-label': t('Outline'), oncontextmenu: (ev) => this.outlineMenu(ev) }, q ? this.filteredOutline(q) : this.outlineNodes());
    this.body.replaceChildren(...[box, nav].filter(Boolean));
  }

  // Outline → Filter: a box over the outline; headings that do not contain the
  // text are hidden (whatever is folded), the matching part is bold.
  toggleOutlineFilter(show = this.outlineFilter == null) {
    this.outlineFilter = show ? '' : null;
    this.renderOutline();
    if (show) this.body.querySelector('.outline-filter')?.focus();
  }

  outlineFilterBox() {
    const input = h('input', { type: 'search', class: 'field file-filter outline-filter', placeholder: t('Filter'), 'aria-label': t('Filter'), value: this.outlineFilter, spellcheck: false });
    const pick = (step) => {
      const rows = [...this.body.querySelectorAll('.outline-item')];
      if (!rows.length) return;
      const at = rows.findIndex((r) => r.classList.contains('select'));
      rows.forEach((r) => r.classList.remove('select'));
      rows[(at + step + rows.length) % rows.length].classList.add('select');
      this.body.querySelector('.outline-item.select')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', debounce(() => {
      this.outlineFilter = input.value;
      const nav = this.body.querySelector('nav.outline');
      const q = input.value.trim();
      if (nav) {
        nav.classList.toggle('filtering', !!q);
        nav.replaceChildren(...(q ? this.filteredOutline(q) : this.outlineNodes()));
      }
    }, 80));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        pick(ev.key === 'ArrowDown' ? 1 : -1);
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        (this.body.querySelector('.outline-item.select') || this.body.querySelector('.outline-item'))?.click();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.toggleOutlineFilter(false);
      }
    });
    return input;
  }

  filteredOutline(q) {
    const needle = q.toLowerCase();
    const items = [];
    for (const hd of this.headings) {
      const text = hd.text || '';
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      items.push(h('a', { class: `outline-item l${hd.level}${hd.i === this.active ? ' active' : ''}`, dataset: { i: hd.i }, onclick: () => this.app.jumpToHeading(hd.i) },
        h('span', { class: 'twist none' }),
        h('span', { class: 'outline-text' }, text.slice(0, at), h('b', { class: 'outline-hit' }, text.slice(at, at + q.length)), text.slice(at + q.length))));
    }
    return items;
  }

  // Outline → Highlight Current Header: the heading at the top of the view is
  // unfolded to, scrolled to and blinks for a moment.
  highlightCurrent() {
    const k = this.headings.findIndex((hd) => hd.i === this.active);
    if (k < 0) return;
    for (let up = this.parentOf(k); up; up = this.parentOf(this.headings.indexOf(up))) this.opened.add(up.id);
    this.renderOutline();
    const row = [...this.body.querySelectorAll('.outline-item')].find((n) => Number(n.dataset.i) === this.active);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.add('blink');
    setTimeout(() => row.classList.remove('blink'), 2000);
  }

  // --- file tree ------------------------------------------------------------

  async fillTree(host, dir, depth) {
    let items = [];
    try {
      items = await this.entries(dir);
    } catch (err) {
      host.append(h('div', { class: 'side-empty' }, err.message));
      return;
    }
    const current = this.app.currentPath();
    // A folder with nothing to show in it has no arrow.
    const empty = new Set();
    await Promise.all(items.filter((e) => e.isDir && !e.isBundle).map(async (e) => {
      if (!(await this.entries(e.path).catch(() => [])).length) empty.add(e.path);
    }));
    for (const e of items) {
      const home = this.app.homeDir?.() || '';
      const tip = home && e.path.startsWith(`${home}/`) ? `~${e.path.slice(home.length)}` : e.path;
      const editable = e.isDir || e.isBundle || isMarkdownName(e.name);
      const row = h('div', { class: `tree-row${e.path === current ? ' active' : ''}${editable ? '' : ' not-editable'}`, role: 'treeitem', style: `padding-left:${22 + depth * 16}px`, title: tip, dataset: { path: e.path, drop: e.isDir && !e.isBundle ? e.path : dir },
        onmousedown: (ev) => this.dragFrom(e, ev),
        onclick: async (ev) => {
          if (!e.isDir || (ev.metaKey && isNative)) return this.openEntry(e, ev);
          if (this.open.has(e.path)) this.open.delete(e.path);
          else this.open.add(e.path);
          return this.render();
        },
        oncontextmenu: (ev) => {
          ev.preventDefault();
          this.fileMenu(e, ev.clientX, ev.clientY);
        } },
        h('span', { class: `twist${e.isDir && !empty.has(e.path) ? (this.open.has(e.path) ? ' open' : '') : ' none'}` }, e.isDir && !empty.has(e.path) ? ICON.chevron() : null),
        h('span', { class: 'tree-icon' }, e.isBundle ? ICON.bundle() : e.isDir ? ICON.folder() : ICON.file()),
        h('span', { class: 'tree-name' }, e.name));
      row._entry = e;
      row._depth = depth;
      host.append(row);
      if (e.isDir && this.open.has(e.path)) await this.fillTree(host, e.path, depth + 1);
    }
    if (!items.length && depth === 0) host.append(h('div', { class: 'side-empty' }, t('No Files Available')));
  }

  // --- dragging files ---------------------------------------------------------

  // Pressing on a row and moving the mouse drags the file: out to Finder or
  // another app (a copy), or onto a folder in the tree (a move).
  dragFrom(e, ev) {
    if (ev.button !== 0 || !platform.startFileDrag || ev.target.closest('input')) return;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    const move = (m) => {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
      stop();
      this.dragging = e.path;
      platform.startFileDrag(e.path).then((ok) => {
        if (!ok) this.dragEnded();
      }, () => this.dragEnded());
    };
    const stop = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', stop, true);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', stop, true);
  }

  dragEnded() {
    this.dragging = null;
    clearTimeout(this.dragOpenTimer);
    this.body?.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  }

  // The folder a drop at this element goes into: a folder row is itself, a
  // file row its folder, empty tree space the root; null outside the tree.
  dropFolderAt(el) {
    if (!this.root || !el || !this.body?.contains(el)) return null;
    // The Articles view stands for the whole folder.
    if (this.tab === 'list') return this.body.querySelector('.file-list, .file-card') ? this.root : null;
    if (!this.body.querySelector('.tree')) return null;
    const row = el.closest('.tree-row');
    return row ? row.dataset.drop : this.root;
  }

  // Drag-over feedback on the tree; a closed folder opens after a moment.
  installDropTarget(tree) {
    const rowFor = (dir) => [...tree.querySelectorAll('.tree-row')].find((n) => n.dataset.path === dir);
    tree.addEventListener('dragover', (ev) => {
      if (!this.dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      const dir = this.dropFolderAt(ev.target);
      const row = rowFor(dir);
      if (row?.classList.contains('drop-target')) return;
      tree.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      row?.classList.add('drop-target');
      clearTimeout(this.dragOpenTimer);
      if (dir && dir !== this.root && !this.open.has(dir)) {
        this.dragOpenTimer = setTimeout(() => {
          if (!this.dragging) return;
          this.open.add(dir);
          this.render();
        }, 1000);
      }
    });
    tree.addEventListener('drop', (ev) => {
      if (!this.dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      const from = this.dragging;
      const dir = this.dropFolderAt(ev.target);
      this.dragEnded();
      if (dir) this.moveInto([from], dir);
    });
  }

  // Moves files and folders into `dir`, asking first (unless told not to) and
  // again when something of that name is already there.
  async moveInto(paths, dir) {
    let every = null; // "Apply to All": the answer to the name clash, for the rest of the files
    for (const from of paths) {
      if (from === dir || dir.startsWith(`${from}/`)) continue;
      if (path.dirname(from) === dir) {
        this.flash(from);
        continue;
      }
      let name = path.basename(from);
      if (!settings.dismissed?.noWarningForMoveFile) {
        const message = t('Are you sure you want to move %@?').replace('%@', name);
        const res = platform.messageWithCheckbox
          ? await platform.messageWithCheckbox({ message, buttons: [t('OK'), t('Cancel')], cancel: 1, style: 'warning', checkbox: t('Do not show this again') }).catch(() => null)
          : { index: await ask({ message, buttons: [t('OK'), t('Cancel')], style: 'warning' }), checked: false };
        if (!res || res.index !== 0) return;
        if (res.checked) setPref({ dismissed: { ...settings.dismissed, noWarningForMoveFile: true } });
      }
      let to = path.join(dir, name);
      try {
        if ((await platform.stat(to)).exists) {
          let pick = every;
          if (pick == null) {
            const buttons = [t('Keep Both'), t('Replace'), t('Cancel')];
            const message = t('File/directory already exists at target path.');
            if (paths.length > 1 && platform.messageWithCheckbox) {
              const res = await platform.messageWithCheckbox({ message: `${message}\n${name}`, buttons, cancel: 2, default: 1, style: 'warning', checkbox: t('Apply to All') }).catch(() => null);
              pick = res ? res.index : 2;
              if (res?.checked) every = pick;
            } else pick = await ask({ message, buttons, style: 'warning', primary: 1 });
          }
          if (pick === 2 || pick < 0) continue;
          if (pick === 0) {
            // "name (copy).md", "name (copy) (copy).md", … until it is free.
            while ((await platform.stat(to)).exists) {
              const dot = name.indexOf('.', 1);
              name = dot < 0 ? `${name} (copy)` : `${name.slice(0, dot)} (copy)${name.slice(dot)}`;
              to = path.join(dir, name);
            }
          } else {
            await platform.trash(to);
            await this.app.pathRemoved(to);
          }
        }
        await platform.rename(from, to);
        await this.app.pathMoved(from, to);
        this.pushUndo(t('Move'), async () => {
          await platform.rename(to, from);
          await this.app.pathMoved(to, from);
        });
        this.open.add(dir);
        await this.refresh();
        this.flash(to);
      } catch (err) {
        failed(t('Operation Failed'), err);
      }
    }
  }

  // Briefly marks a row, so a moved file can be found again.
  // Blinks a row that was just created, renamed or moved (for 2 s, across re-renders).
  flash(p) {
    this.flashing = { path: p, until: Date.now() + 2000 };
    this.applyFlash(true);
  }

  applyFlash(scroll = false) {
    const f = this.flashing;
    if (!f) return;
    const row = [...(this.body?.querySelectorAll('.tree-row, .file-card') || [])].find((n) => n.dataset.path === f.path);
    const left = f.until - Date.now();
    if (!row || left <= 0) {
      if (left <= 0) this.flashing = null;
      return;
    }
    if (scroll) row.scrollIntoView({ block: 'nearest' });
    row.classList.add('flash');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      row.classList.remove('flash');
      this.flashing = null;
    }, left);
  }

  // The menu on a file, a folder, the root, empty tree space (e = null) or a
  // search result (where = 'search'), with Typora's items for each.
  fileMenu(e, x, y, where = this.tab) {
    const root = !!e && e.path === this.root;
    const file = !!e && !e.isDir;
    const folder = !!e && e.isDir && !root;
    const search = where === 'search';
    const dir = !e ? this.root : e.isDir ? e.path : path.dirname(e.path);
    const sep = { separator: true };
    const viewItems = [
      { id: 'search', title: t('Search'), checked: this.tab === 'search', run: () => this.app.showSidebar(this.tab === 'search' ? this.filesTab : 'search') },
    ];
    const items = !e ? [
      this.undoItem(),
      this.undoOp ? sep : null,
      { id: 'newFile', title: t('New File'), run: () => this.newFile(dir) },
      { id: 'newDir', title: t('New Folder'), run: () => this.newFolder(dir) },
    ] : [
      !search && this.undoItem(),
      !search && this.undoOp ? sep : null,
      file && { id: 'open', title: t('Open'), run: () => this.openEntry(e) },
      isNative && (file ? isMarkdownName(e.name) : !search) && { id: 'openWin', title: t('Open in New Window'), run: () => platform.newWindow(e.path) },
      sep,
      !search && { id: 'newFile', title: t('New File'), run: () => this.newFile(dir) },
      !search && where === 'tree' && { id: 'newDir', title: t('New Folder'), run: () => this.newFolder(dir) },
      !search && sep,
      ...viewItems,
      sep,
      !search && { id: 'listView', title: t('Articles (List View)'), checked: this.filesTab === 'list', run: () => this.app.showSidebar('list') },
      !search && { id: 'treeView', title: t('File Tree (Tree View)'), checked: this.filesTab === 'tree', run: () => this.app.showSidebar('tree') },
      !search && sep,
      !search && !root && { id: 'rename', title: t('Rename'), run: () => this.rename(e) },
      !search && file && { id: 'dup', title: t('Duplicate'), run: () => this.duplicate(e) },
      !search && !root && sep,
      !search && !root && { id: 'trash', title: t('Delete'), run: () => this.remove(e) },
      sep,
      { id: 'copyPath', title: t('Copy File Path'), run: () => platform.clipboardWrite({ text: e.path }).then(() => toast(t('Copied'))) },
      isNative && e && { id: 'showInfo', title: t('Properties'), run: () => platform.showInfo(e.path).catch(() => {}) },
      isNative && { id: 'reveal', title: t('Open File Location'), run: () => platform.reveal(e.path) },
      search && sep,
      search && { id: 'expandAll', title: t('Expand All'), run: () => this.foldSearch(true) },
      search && { id: 'collapseAll', title: t('Collapse All'), run: () => this.foldSearch(false) },
      // Livemark's own additions, after Typora's items.
      !search && isNative && (file || folder) && sep,
      !search && isNative && file && { id: 'quickLook', title: t('Quick Look'), run: () => platform.quickLook(e.path) },
      !search && isNative && folder && { id: 'pin', title: t(settings.pinned.includes(e.path) ? 'Unpin' : 'Pin'), run: () => this.togglePin(e.path) },
    ];
    contextMenu(tidy(items.filter(Boolean)), x, y);
  }

  // Search results: fold every file's matches, or show them all again.
  foldSearch(open) {
    this.searchResults?.querySelectorAll('.search-group').forEach((g) => g.classList.toggle('collapsed', !open));
  }

  // The menu on empty space of the search results.
  searchMenu(ev) {
    ev.preventDefault();
    contextMenu([
      { id: 'search', title: t('Search'), checked: true, run: () => this.app.showSidebar(this.filesTab) },
      { separator: true },
      { id: 'expandAll', title: t('Expand All'), run: () => this.foldSearch(true) },
      { id: 'collapseAll', title: t('Collapse All'), run: () => this.foldSearch(false) },
    ], ev.clientX, ev.clientY);
  }

  // The menu on empty space of the file tree: new file or folder in the root.
  treeBlankMenu(ev) {
    if (ev.target.closest('.tree-row') || !this.root) return;
    ev.preventDefault();
    this.fileMenu(null, ev.clientX, ev.clientY);
  }

  moreMenu(ev) {
    const r = ev.currentTarget.getBoundingClientRect();
    const recent = (settings.recentFolders || []).filter((p) => p !== this.root && !settings.pinned.includes(p)).slice(0, Math.max(0, 6 - settings.pinned.length));
    contextMenu([
      { id: 'newFile', title: t('New File'), run: () => this.newFile(this.root) },
      { id: 'newDir', title: t('New Folder'), run: () => this.newFolder(this.root) },
      { id: 'search', title: t('Search'), checked: this.tab === 'search', run: () => this.app.showSidebar(this.tab === 'search' ? this.filesTab : 'search') },
      { separator: true },
      { title: t('Sort'), items: [
        ...SORT_MENU.map(([id, title]) => ({ id: `sort-${id}`, title: t(title), checked: settings[sortKey(this.tab)] === id, run: () => setPref({ [sortKey(this.tab)]: id }) })),
        { separator: true },
        this.tab === 'list'
          ? { id: 'group', title: t('Group By Folder'), checked: !!settings.listGroup, run: () => setPref({ listGroup: !settings.listGroup }) }
          : { id: 'treeGroup', title: t('Group By Folder'), checked: settings.treeGroup !== false, run: () => setPref({ treeGroup: settings.treeGroup === false }) },
      ] },
      { separator: true },
      isNative && { id: 'pin', title: t(settings.pinned.includes(this.root) ? 'Unpin' : 'Pin'), run: () => this.togglePin(this.root) },
      ...settings.pinned.filter((p) => p !== this.root).map((p, k) => ({ id: `pinned-${k}`, title: `${path.basename(p)}/`, checked: true, run: () => this.app.openFolder(p) })),
      // Recent folders after the pinned ones (six at most, as in Typora's folder menu).
      ...recent.map((p, k) => ({ id: `recentdir-${k}`, title: `${path.basename(p)}/`, run: () => this.app.openFolder(p) })),
      (settings.pinned.length || recent.length) && isNative && { title: t('Pin'), items: [...settings.pinned.filter((p) => p !== this.root), ...recent].map((p, k) => ({ id: `pintoggle-${k}`, title: `${path.basename(p)}/`, checked: settings.pinned.includes(p), run: () => this.togglePin(p) })) },
      recent.length && { title: t('Remove from List'), items: recent.map((p, k) => ({ id: `forget-${k}`, title: `${path.basename(p)}/`, run: () => setPref({ recentFolders: settings.recentFolders.filter((x) => x !== p) }) })) },
      { separator: true },
      { id: 'refresh', title: t('Refresh Folder'), run: () => this.refresh() },
      isNative && { id: 'reveal', title: t('Reveal in Finder'), run: () => platform.reveal(this.root) },
      { id: 'change', title: t('Open Folder…'), run: () => this.app.openFolder() },
    ].filter(Boolean), r.left, r.bottom + 4);
  }

  togglePin(dir) {
    setPref({ pinned: settings.pinned.includes(dir) ? settings.pinned.filter((p) => p !== dir) : [...settings.pinned, dir] });
  }

  // Make sure a file's row is visible in the tree.
  async reveal(file) {
    if (!this.root || !file.startsWith(`${this.root}/`)) return false;
    let dir = path.dirname(file);
    while (dir.length >= this.root.length) {
      this.open.add(dir);
      dir = path.dirname(dir);
    }
    await this.render();
    this.body.querySelector('.active')?.scrollIntoView({ block: 'center' });
    return true;
  }

  async uniqueName(dir, base, ext) {
    for (let n = 0; n < 500; n++) {
      const name = `${base}${n ? ` ${n + 1}` : ''}${ext}`;
      if (!(await platform.stat(path.join(dir, name))).exists) return name;
    }
    return `${base}-${Date.now()}${ext}`;
  }

  // New File / New Folder: made at once as "Untitled" (numbered when taken), then
  // named in place. The new file opens only when the window holds an empty Untitled.
  async newFile(dir) {
    const ext = `.${settings.defaultExt === 'textbundle' ? 'md' : settings.defaultExt}`;
    try {
      const file = path.join(dir, await this.uniqueName(dir, t('Untitled'), ext));
      await platform.writeText(file, '');
      this.open.add(dir);
      await this.refresh();
      const named = await this.renameInPlace({ path: file, name: path.basename(file), isDir: false });
      this.pushUndo(t('New File'), async () => this.trashQuietly(named));
      if (this.app.isDiscardable?.()) await this.app.openPath(named);
    } catch (err) {
      failed(t('Failed to create file.'), err);
    }
    return null;
  }

  async newFolder(dir) {
    try {
      const folder = path.join(dir, await this.uniqueName(dir, t('Untitled Folder'), ''));
      await platform.mkdir(folder);
      this.open.add(dir);
      await this.refresh();
      const named = await this.renameInPlace({ path: folder, name: path.basename(folder), isDir: true });
      this.pushUndo(t('New Folder'), async () => this.trashQuietly(named));
    } catch (err) {
      failed(t('Failed to create folder'), err);
    }
    return null;
  }

  // Starts renaming a row that was just made; returns the final path (or the old one).
  async renameInPlace(e) {
    if (!this.body.querySelector(`[data-path="${CSS.escape(e.path)}"]`)) return e.path;
    const to = await this.rename(e, { quiet: true });
    return to || e.path;
  }

  async trashQuietly(p) {
    await platform.trash(p).catch(() => {});
    await this.app.pathRemoved(p);
    await this.refresh();
  }

  // --- undo for file operations -------------------------------------------------
  // The last rename, move, new file, duplicate or delete made here can be taken back
  // (from the sidebar's menus, or Cmd+Z while the file view has focus).
  pushUndo(label, undo) {
    this.undoOp = { label, undo };
  }

  async undoFileOp() {
    const op = this.undoOp;
    if (!op) return;
    this.undoOp = null;
    try {
      await op.undo();
      await this.refresh();
    } catch (err) {
      failed(t('Operation Failed'), err);
    }
  }

  undoItem() {
    return this.undoOp ? { id: 'undoFileOp', title: t('Undo {0}', this.undoOp.label), run: () => this.undoFileOp() } : null;
  }

  // Rename happens in place: the name turns into a field with the part before
  // the extension selected. Return renames, Escape cancels, clicking away asks.
  // --- keyboard ---------------------------------------------------------------
  // The file view takes the arrow keys once it has focus, and right after a click
  // in it ("armed"): Up/Down/Home/End move, Right/Left open and close folders,
  // Enter opens, F2 renames, Esc goes back to the document.

  installKeys() {
    const KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', 'F2']);
    this.body.addEventListener('click', (ev) => {
      const row = ev.target.closest('.tree-row[data-path]:not(.tree-root), .file-card[data-path]');
      if (!row) return;
      this.cursor = row.dataset.path;
      this.armed = true;
      this.showCursor();
    });
    this.body.addEventListener('keydown', (ev) => {
      if (ev.key === 'z' && ev.metaKey && !ev.shiftKey && this.undoOp && !ev.target.closest?.('input')) {
        ev.preventDefault();
        ev.stopPropagation();
        return this.undoFileOp();
      }
      return this.onKey(ev);
    });
    // Armed: the click opened a document and moved focus there, but the next
    // navigation key still belongs to the file view.
    document.addEventListener('keydown', (ev) => {
      if (!this.armed || this.body.contains(document.activeElement)) return;
      if (!KEYS.has(ev.key) || ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey || ev.isComposing || ev.key === 'Enter') {
        this.armed = false;
        return;
      }
      this.body.focus({ preventScroll: true });
      this.onKey(ev);
    }, true);
    document.addEventListener('mousedown', (ev) => {
      if (!this.body.contains(ev.target)) this.armed = false;
    }, true);
  }

  rows() {
    return [...this.body.querySelectorAll('.tree-row[data-path]:not(.tree-root), .file-card[data-path]')];
  }

  showCursor() {
    this.applyFlash();
    let hit = null;
    for (const row of this.rows()) {
      const on = !!this.cursor && row.dataset.path === this.cursor;
      row.classList.toggle('kb-cursor', on);
      if (on) hit = row;
    }
    return hit;
  }

  onKey(ev) {
    if (this.tab !== 'tree' && this.tab !== 'list') return;
    if (ev.target.closest?.('input, textarea')) return;
    if (ev.key === 'Escape') {
      this.armed = false;
      this.app.focusDocument?.();
      return ev.preventDefault();
    }
    const rows = this.rows();
    if (!rows.length) return;
    let k = rows.findIndex((r) => r.dataset.path === this.cursor);
    if (k < 0) k = Math.max(0, rows.findIndex((r) => r.classList.contains('active')));
    const row = rows[k];
    const e = row._entry;
    const go = (n) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, n))];
      this.cursor = next.dataset.path;
      this.showCursor()?.scrollIntoView({ block: 'nearest' });
    };
    const isFolder = e && e.isDir && !e.isBundle;
    switch (ev.key) {
      case 'ArrowDown': go(this.cursor ? k + 1 : k); break;
      case 'ArrowUp': go(this.cursor ? k - 1 : k); break;
      case 'Home': go(0); break;
      case 'End': go(rows.length - 1); break;
      case 'ArrowRight':
        if (isFolder && !this.open.has(e.path)) {
          this.open.add(e.path);
          this.render();
        } else if (isFolder) go(k + 1);
        break;
      case 'ArrowLeft':
        if (isFolder && this.open.has(e.path)) {
          this.open.delete(e.path);
          this.render();
        } else {
          const parent = path.dirname(row.dataset.path);
          const up = rows.findIndex((r) => r.dataset.path === parent);
          if (up >= 0) go(up);
        }
        break;
      case 'Enter':
        if (!e) break;
        if (isFolder) {
          if (this.open.has(e.path)) this.open.delete(e.path);
          else this.open.add(e.path);
          this.render();
        } else this.openEntry(e, ev);
        break;
      case 'F2':
        if (e) this.rename(e);
        break;
      default:
        return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  }

  async rename(e, { quiet = false } = {}) {
    const row = [...(this.body?.querySelectorAll('.tree-row, .file-card') || [])].find((n) => n.dataset.path === e.path);
    const label = row?.querySelector('.tree-name, .file-title');
    const typed = label ? await this.editName(label, e) : await prompt({ title: t('Rename'), value: e.name, ok: t('Rename') });
    // A name is one path component: slashes are dropped.
    const name = typed && typed.replace(/[/\\]/g, '').trim();
    if (!name || name === e.name) {
      if (label) await this.render();
      return null;
    }
    const to = path.join(path.dirname(e.path), name);
    // A TextBundle cannot become a plain Markdown file (or the other way) by renaming.
    const kind = (p) => (/\.textbundle$/i.test(p) ? 'TextBundle file' : /\.textpack$/i.test(p) ? 'TextPack file' : 'Markdown file');
    if (kind(e.path) !== kind(to)) {
      await this.render();
      return failed(t('Failed to rename file'), t('Cannot rename from $1 to $2, please use "File" → "Move To…" from menubar instead.').replace('$1', t(kind(e.path))).replace('$2', t(kind(to))));
    }
    try {
      if ((await platform.stat(to)).exists) {
        await this.render();
        return failed(t('Failed to rename file'), t('File/directory already exists at target path.'));
      }
      await platform.rename(e.path, to);
      await this.app.pathMoved(e.path, to);
      if (!quiet) this.pushUndo(t('Rename'), async () => {
        await platform.rename(to, e.path);
        await this.app.pathMoved(to, e.path);
      });
      await this.refresh();
      this.flash(to);
      return to;
    } catch (err) {
      await this.render();
      failed(t('Failed to rename file'), err);
    }
    return null;
  }

  editName(label, e) {
    return new Promise((resolve) => {
      const input = h('input', { type: 'text', class: 'rename-field', value: e.name, spellcheck: false, 'aria-label': t('Rename') });
      label.replaceChildren(input);
      input.focus();
      const dot = e.isDir ? -1 : e.name.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : e.name.length);
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      ['mousedown', 'click', 'dblclick', 'contextmenu'].forEach((type) => input.addEventListener(type, (ev) => ev.stopPropagation()));
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.isComposing) return;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          finish(input.value.trim());
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          finish(null);
        }
      });
      input.addEventListener('blur', async () => {
        if (done) return;
        const value = input.value.trim();
        if (!value || value === e.name) return finish(null);
        const pick = await ask({ message: t('Rename to "{0}" ?', value), buttons: [t('OK'), t('Cancel')] });
        finish(pick === 0 ? value : null);
      });
    });
  }

  async duplicate(e) {
    try {
      const name = await this.uniqueName(path.dirname(e.path), `${path.stem(e.name)} ${t('copy')}`, path.extname(e.name));
      const copy = path.join(path.dirname(e.path), name);
      await platform.copy(e.path, copy);
      await this.refresh();
      const named = await this.renameInPlace({ path: copy, name, isDir: false });
      this.pushUndo(t('Duplicate'), async () => this.trashQuietly(named));
      // The copy opens when the window holds an empty Untitled or the original itself.
      const openHere = this.app.isDiscardable?.() || this.app.currentPath() === e.path;
      if (openHere && isMarkdownName(named)) {
        if (this.app.isDirty?.()) {
          const pick = await ask({ message: t('Current document contains unsaved changes. Do you want to switch to newly duplicated file?'), buttons: [t('OK'), t('Cancel')] });
          if (pick !== 0) return;
        }
        await this.app.openPath(named);
      }
    } catch (err) {
      failed(t('Operation Failed'), err);
    }
  }

  async remove(e) {
    const pick = await ask({
      message: t('Are you sure you want to delete %@?').replace('%@', e.name),
      detail: isNative ? t('You can restore from the Trash.') : t('Deleting in the browser cannot be undone.'),
      buttons: [isNative ? t('Move to Trash') : t('Delete'), t('Cancel')],
      style: isNative ? 'warning' : 'critical',
    });
    if (pick !== 0) return;
    // In Articles view, deleting the open file opens the one after it.
    const cards = this.tab === 'list' ? [...this.body.querySelectorAll('.file-card[data-path]')].map((c) => c.dataset.path) : [];
    const wasOpen = this.app.currentPath() === e.path;
    const next = cards[cards.indexOf(e.path) + 1] || cards[cards.indexOf(e.path) - 1] || null;
    try {
      const res = await platform.trash(e.path);
      const landed = res && typeof res === 'object' ? res.trashed : null;
      if (landed) this.pushUndo(t('Delete'), async () => {
        await platform.rename(landed, e.path);
      });
    } catch (err) {
      // The Trash refused it (a network volume, say): offer to delete it for good.
      const again = await ask({ message: t('Operation Failed'), detail: String(err.message || err), buttons: [t('Delete Permanently'), t('Cancel')], style: 'critical' });
      if (again !== 0 || !platform.removePermanently) return;
      try {
        await platform.removePermanently(e.path);
      } catch (err2) {
        return failed(t('Operation Failed'), err2);
      }
    }
    await this.app.pathRemoved(e.path);
    await this.refresh();
    if (wasOpen && next && next !== e.path) await this.app.openAfterDelete?.(next);
  }

  // --- article list ---------------------------------------------------------

  async renderList(token) {
    this.body.replaceChildren(h('div', { class: 'side-empty' }, t('Loading…')));
    const all = [...(await this.allFiles())];
    if (token !== this.token) return;
    const q = this.filter.trim().toLowerCase();
    const files = q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
    const cmp = sorter('list');
    // Grouped: folders in name order, each folder's files in the chosen order.
    const folderOf = (e) => path.dirname(e.path);
    files.sort((a, b) => (settings.listGroup && folderOf(a) !== folderOf(b) ? folderOf(a).localeCompare(folderOf(b), undefined, { numeric: true }) : cmp(a, b)));
    const filterBox = h('input', { type: 'search', class: 'field file-filter', placeholder: t('Search by file name'), 'aria-label': t('Search by file name'), value: this.filter, spellcheck: false });
    filterBox.addEventListener('input', debounce(async () => {
      this.filter = filterBox.value;
      await this.renderList((this.token = (this.token || 0) + 1));
      const box = this.body.querySelector('.file-filter');
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    }, 200));
    if (!files.length) {
      this.body.replaceChildren(...(all.length ? [filterBox] : []), h('div', { class: 'side-empty' }, t(all.length ? 'No Results' : 'No Files Available')));
      return;
    }
    const current = this.app.currentPath();
    let lastFolder = null;
    const list = h('div', { class: 'file-list' }, files.flatMap((e) => {
      const head = settings.listGroup && folderOf(e) !== lastFolder ? h('div', { class: 'file-group', title: folderOf(e) }, path.relative(this.root, folderOf(e)) === '.' ? path.basename(this.root) : path.relative(this.root, folderOf(e))) : null;
      lastFolder = folderOf(e);
      return [head, this.fileCard(e, current)].filter(Boolean);
    }));
    // The list stops at a few thousand files: say so, and point at the tree.
    const tooMany = all.length >= MAX_LIST && h('div', { class: 'side-notice' }, t('Selected folders contains too many files.'), ' ',
      h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); this.app.showSidebar('tree'); } }, t('Switch to File Tree view')), ' ', t('for better performance.'));
    this.body.replaceChildren(...[tooMany, filterBox, list].filter(Boolean));
    this.showCursor();
    // Fill in previews only for the rows that scroll into view.
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const file = en.target._entry.isBundle ? path.join(en.target._entry.path, 'text.md') : en.target._entry.path;
        if (!isMarkdownName(en.target._entry.name)) continue;
        platform.readText(file).then(({ text: whole }) => {
          let text = whole;
          // A title in the front matter leads the preview.
          const meta = /^---\n([\s\S]*?)\n---\n/.exec(text);
          const title = (meta && /^title:\s*(.+)$/m.exec(meta[1])) || /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text.replace(/^---[\s\S]*?\n---\n/, ''));
          if (title && !meta?.[1]?.match(/^title:/m)) {
            // The heading is the title: it is not repeated in the preview lines.
            text = text.replace(title[0], '');
          }
          const lines = text.replace(/^---[\s\S]*?\n---\n/, '').split('\n').map((l) => l.replace(/^[#>\s]+|[*`_~=[\]()!|]/g, '').trim()).filter(Boolean);
          if (title) lines.unshift(title[1].replace(/^["']|["']$/g, ''));
          en.target._snippet.replaceChildren(...lines.slice(0, 2).map((l) => h('div', {}, l.slice(0, 80))));
        }, () => {});
      }
    }, { root: this.body });
    for (const row of list.querySelectorAll('.file-card')) io.observe(row);
  }

  fileCard(e, current) {
    const snippet = h('div', { class: 'file-snippet' });
    const row = h('div', { class: `file-card${e.path === current ? ' active' : ''}`, dataset: { path: e.path }, onclick: (ev) => this.openEntry(e, ev), oncontextmenu: (ev) => {
      ev.preventDefault();
      this.fileMenu(e, ev.clientX, ev.clientY);
    } },
      h('div', { class: 'file-meta' }, h('span', {}, path.basename(path.dirname(e.path))), h('span', {}, ago(e.mtime))),
      h('div', { class: 'file-title' }, path.stem(e.name), h('span', { class: 'file-ext' }, path.extname(e.name))),
      snippet);
    row._entry = e;
    row._snippet = snippet;
    return row;
  }

  // --- search across files --------------------------------------------------

  renderSearch() {
    if (!this.searchBox) {
      this.searchInput = h('input', { type: 'search', class: 'field', placeholder: t('Find in Files'), 'aria-label': t('Find in Files'), spellcheck: false });
      // Case / whole word / regex, remembered like Typora's sidebar search options.
      const opt = (key, label, title) => {
        const b = h('button', { type: 'button', class: 'find-opt', title: t(title), 'aria-label': t(title), 'aria-pressed': String(!!settings.sideSearchOpts?.[key]), onclick: () => {
          const next = { ...settings.sideSearchOpts, [key]: !settings.sideSearchOpts?.[key] };
          setPref({ sideSearchOpts: next });
          b.setAttribute('aria-pressed', String(next[key]));
          this.runSearch();
        } }, label);
        return b;
      };
      this.searchResults = h('div', { class: 'search-results', oncontextmenu: (ev) => this.searchMenu(ev) });
      this.searchBox = h('div', { class: 'search-pane' }, h('div', { class: 'search-bar' }, this.searchInput, opt('caseSensitive', 'Aa', 'Case Sensitive'), opt('wholeWord', 'W', 'Whole Word'), opt('regex', '(.*)', 'Regular Expression')), this.searchResults);
      this.searchInput.addEventListener('input', debounce(() => this.runSearch(), 250));
      // Esc goes back to the files; Up/Down walk the results; Enter opens the chosen one.
      this.searchInput.addEventListener('keydown', (ev) => {
        if (ev.isComposing) return;
        const hits = [...this.searchResults.querySelectorAll('.search-hit, .search-file')].filter((x) => x.offsetParent);
        let k = hits.findIndex((x) => x.classList.contains('picked'));
        if (ev.key === 'Escape') {
          ev.preventDefault();
          this.app.showSidebar(this.filesTab);
          this.app.focusDocument?.();
        } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          ev.preventDefault();
          hits[k]?.classList.remove('picked');
          k = ev.key === 'ArrowDown' ? Math.min(hits.length - 1, k + 1) : Math.max(0, k - 1);
          hits[k]?.classList.add('picked');
          hits[k]?.scrollIntoView({ block: 'nearest' });
        } else if (ev.key === 'Enter') {
          ev.preventDefault();
          (hits[k] || hits[0])?.click();
          // The search box keeps the focus, ready for the next result.
          setTimeout(() => this.searchInput.focus(), 0);
        }
      });
    }
    this.body.replaceChildren(this.searchBox);
    // A short selection in the document is what is looked for.
    const seed = this.app.selectedText?.() || '';
    if (seed && !seed.includes('\n') && seed.length < 100 && seed !== this.searchInput.value) {
      this.searchInput.value = seed;
      this.runSearch();
    }
    this.searchInput.focus();
    this.searchInput.select();
  }

  async runSearch() {
    const q = this.searchInput.value;
    const token = (this.searchToken = (this.searchToken || 0) + 1);
    if (!q.trim()) {
      this.searchResults.textContent = '';
      return;
    }
    const o = settings.sideSearchOpts || {};
    const cs = !!o.caseSensitive;
    let re;
    try {
      const src = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(o.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])` : src, `u${cs ? '' : 'i'}`);
    } catch {
      this.searchResults.replaceChildren(h('div', { class: 'side-empty' }, t('No result found.')));
      return;
    }
    this.searchResults.replaceChildren(h('div', { class: 'side-empty' }, t('Searching…')));
    const files = await this.allFiles();
    const groups = [];
    let total = 0;
    for (const f of files) {
      if (token !== this.searchToken) return;
      let text;
      try {
        ({ text } = await platform.readText(f.path));
      } catch {
        continue;
      }
      const hits = [];
      const lines = text.split('\n');
      for (let n = 0; n < lines.length && hits.length < 21; n++) {
        const m = re.exec(lines[n]);
        if (m && m[0]) hits.push({ line: n, col: m.index, len: m[0].length, text: lines[n] });
      }
      // A plain query also finds files by name.
      const byName = !o.regex && (cs ? f.name : f.name.toLowerCase()).includes(cs ? q.trim() : q.trim().toLowerCase());
      if (hits.length || byName) {
        groups.push({ f, hits, byName });
        total += hits.length;
      }
      if (total > 800) break;
    }
    if (token !== this.searchToken) return;
    if (!groups.length) {
      this.searchResults.replaceChildren(h('div', { class: 'side-empty' }, t('No result found.')));
      return;
    }
    // "a / b /" for the file's folder inside the open folder.
    const relDir = (p) => {
      const d = path.relative(this.root || '/', path.dirname(p));
      return d && d !== '.' ? ` ${d.split('/').join(' / ')} /` : '';
    };
    const mark = (text, col, len) => {
      const from = Math.max(0, col - 24);
      const el = h('span', {});
      el.innerHTML = `${from ? '…' : ''}${esc(text.slice(from, col))}<mark>${esc(text.slice(col, col + len))}</mark>${esc(text.slice(col + len, col + len + 60))}`;
      return el;
    };
    this.searchResults.replaceChildren(
      h('div', { class: 'search-summary' }, t('{0} results in {1} files', total, groups.length)),
      ...groups.map(({ f, hits }) => h('div', { class: 'search-group', oncontextmenu: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.fileMenu({ path: f.path, name: f.name, isDir: false }, ev.clientX, ev.clientY, 'search');
      } },
        h('div', { class: 'search-file', title: f.path, dataset: { path: f.path }, onclick: (ev) => (ev.metaKey && isNative ? platform.newWindow(f.path) : this.app.openPath(f.path)) },
          h('span', { class: 'twist open', onclick: (ev) => {
            ev.stopPropagation();
            ev.currentTarget.closest('.search-group').classList.toggle('collapsed');
          } }, ICON.chevron()),
          h('span', { class: 'tree-icon' }, ICON.file()),
          h('span', { class: 'search-name' }, f.name, h('span', { class: 'search-dir' }, relDir(f.path))),
          h('span', { class: 'search-n' }, hits.length > 20 ? '20+' : String(hits.length))),
        // More than six hits: the rest behind "Show more".
        ...hits.slice(0, 20).map((hit, k) => h('div', { class: `search-hit${k >= 6 ? ' more' : ''}`, onclick: (ev) => (ev.metaKey && isNative ? platform.newWindow(f.path) : this.app.openPath(f.path, { find: q, caseSensitive: cs, wholeWord: !!o.wholeWord, regex: !!o.regex, line: hit.line })) }, mark(hit.text, hit.col, hit.len))),
        hits.length > 6 ? h('div', { class: 'search-more', onclick: (ev) => ev.currentTarget.closest('.search-group').classList.add('expanded') }, t('Show {0} More', Math.min(hits.length, 20) - 6)) : null)),
    );
    this.markCurrent();
  }

  // Marks the open document in the file view and brings it into sight: its folders
  // in the tree are opened and the row scrolled to.
  markCurrent() {
    const current = this.app.currentPath();
    let hit = null;
    for (const el of this.body.querySelectorAll('[data-path]')) {
      const on = el.dataset.path === current;
      el.classList.toggle('active', on);
      if (on) hit = el;
    }
    if (!current || !this.root || !current.startsWith(`${this.root}/`)) return;
    if (hit) return hit.scrollIntoView({ block: 'nearest' });
    if (this.tab !== 'tree') return;
    let grew = false;
    for (let dir = path.dirname(current); dir.length > this.root.length; dir = path.dirname(dir)) {
      if (!this.open.has(dir)) grew = this.open.add(dir) && true;
    }
    if (grew) this.render().then(() => this.body.querySelector('.active')?.scrollIntoView({ block: 'nearest' }));
  }
}

// A heading in the outline: formatted as in the document, without the markers.
function outlineText(text) {
  const el = h('span', { class: 'outline-text' });
  el.innerHTML = text ? headingHtml(text) : ' ';
  hydrate(el);
  return el;
}

// --- Quick Open -------------------------------------------------------------

// Subsequence match with a bonus for consecutive and word-start hits.
function score(query, text) {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  let at = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    const found = s.indexOf(ch, at);
    if (found < 0) return -1;
    streak = found === at ? streak + 1 : 0;
    total += 1 + streak * 2 + (found === 0 || /[\s/_.-]/.test(s[found - 1]) ? 3 : 0);
    at = found + 1;
  }
  return total - s.length * 0.01;
}

// Case and accents do not count when matching ("é" finds "e"). Folding keeps the length
// of text without combining marks, so match positions carry over to the original.
const foldText = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const queryTerms = (q) =>
  foldText(q)
    .replace(/[()'"%\\/?]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => new RegExp(w.split('*').map((x) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*')));
// The name with the query's words marked.
function highlight(name, q) {
  const terms = q ? queryTerms(q) : [];
  const folded = name.normalize('NFC').length === foldText(name).length ? foldText(name) : null;
  if (!terms.length || !folded) return [name];
  const marks = new Array(name.length).fill(false);
  for (const re of terms) {
    const m = re.exec(folded);
    if (m) for (let k = m.index; k < m.index + m[0].length; k++) marks[k] = true;
  }
  const out = [];
  let k = 0;
  while (k < name.length) {
    const on = marks[k];
    let j = k;
    while (j < name.length && marks[j] === on) j++;
    out.push(on ? h('mark', { class: 'quick-hit' }, name.slice(k, j)) : name.slice(k, j));
    k = j;
  }
  return out;
}

// File → Open Quickly: Typora's three groups — pinned and recent folders, recent files,
// and files in the open folder ("File Results", with a Searching / Gathering more results
// row until the folder has been read). Arrow keys or Ctrl+P / Ctrl+N move; Enter opens.
let lastQuickQuery = '';
let quickOpenClose = null;
export async function quickOpen({ sidebar, recent, folders = [], onPick, onPickFolder }) {
  // Asked for again while it is up: it closes (the shortcut toggles it).
  if (quickOpenClose) return quickOpenClose(null);
  const input = h('input', { type: 'text', class: 'field quick-input', placeholder: t('Search by file name'), 'aria-label': t('Open Quickly'), spellcheck: false, value: lastQuickQuery });
  const list = h('div', { class: 'quick-list', role: 'listbox' });
  const folderItems = folders.map((p) => ({ path: p, name: path.basename(p), dir: true }));
  const recentItems = recent.map((p) => ({ path: p, name: path.basename(p) }));
  let found = [];
  let searching = !!sidebar.root;
  let shown = [];
  let active = 0;
  let done = null;
  const pick = (k) => {
    const it = shown[k];
    if (it) done(it);
  };
  // Every word of the query must appear (in any order) in the name or the path; * is a
  // wildcard and accents are ignored. A single word may also match loosely (in order).
  const filter = (items, q) => {
    if (!q) return items;
    const terms = queryTerms(q);
    const scored = [];
    for (const it of items) {
      const name = foldText(it.name);
      const where = foldText(sidebar.root && it.path.startsWith(`${sidebar.root}/`) ? it.path.slice(sidebar.root.length + 1) : it.path);
      let total = 0;
      for (const re of terms) {
        const m = re.exec(name);
        if (m) total += 10 + (m.index === 0 || /[\s_.-]/.test(name[m.index - 1]) ? 5 : 0);
        else if (re.test(where)) total += 4;
        else {
          total = -1;
          break;
        }
      }
      if (total >= 0) scored.push({ it, s: 1000 + total - name.length * 0.01 });
      else if (terms.length === 1) {
        const loose = score(q, it.name);
        if (loose >= 0) scored.push({ it, s: loose });
      }
    }
    return scored.sort((x, y) => y.s - x.s).map((x) => x.it);
  };
  const shortDir = (p) => {
    const dir = path.dirname(p);
    if (sidebar.root && (dir === sidebar.root || dir.startsWith(`${sidebar.root}/`))) return path.basename(sidebar.root) + dir.slice(sidebar.root.length);
    const home = (sidebar.app?.homeDir?.() || '').replace(/\/$/, '');
    return home && dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
  };
  const draw = () => {
    const q = input.value.trim();
    const seen = new Set(recentItems.map((x) => x.path));
    const groups = [
      ['Pinned and Recent Locations', filter(folderItems, q).slice(0, 10)],
      ['Recent Files', filter(recentItems, q).slice(0, 20)],
      ['File Results', filter(found.filter((x) => !seen.has(x.path)), q).slice(0, 60)],
    ];
    shown = groups.flatMap(([, items]) => items);
    active = Math.min(active, Math.max(0, shown.length - 1));
    let k = 0;
    const blocks = groups.map(([title, items], g) => {
      const rows = items.map((it) => {
        const n = k++;
        return h('div', { class: `quick-item${n === active ? ' active' : ''}${it.dir ? ' quick-dir' : ''}`, role: 'option', onclick: () => pick(n) }, h('span', { class: 'quick-name' }, ...highlight(it.dir ? `${it.name}/` : it.name, q)), h('span', { class: 'quick-path', title: path.dirname(it.path) }, shortDir(it.path)));
      });
      const info = g === 2 && searching ? [h('div', { class: 'quick-info' }, t(found.length ? 'Gathering more results' : 'Searching'))] : [];
      return rows.length || info.length ? h('div', { class: 'quick-group' }, h('div', { class: 'quick-group-title' }, t(title)), ...rows, ...info) : null;
    }).filter(Boolean);
    list.replaceChildren(...(blocks.length ? blocks : [h('div', { class: 'side-empty' }, t(q ? 'No Results' : 'No Recent Files'))]));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  let typing = 0;
  input.addEventListener('input', () => {
    active = 0;
    clearTimeout(typing);
    typing = setTimeout(draw, found.length > 2000 ? 100 : 0);
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const up = e.key === 'ArrowUp' || (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'p');
    const down = e.key === 'ArrowDown' || (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n');
    if (down) active = Math.min(shown.length - 1, active + 1);
    else if (up) active = Math.max(0, active - 1);
    else if (e.key === 'Tab') { /* Typora keeps Tab in the box */ }
    else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      pick(active);
      return;
    } else return;
    e.preventDefault();
    draw();
  });
  draw();
  if (sidebar.root) {
    sidebar.allFiles().then((files) => {
      found = files.map((f) => ({ path: f.path, name: f.name }));
      searching = false;
      draw();
    }, () => {
      searching = false;
      draw();
    });
  }
  input.addEventListener('input', () => {
    lastQuickQuery = input.value;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'o' && e.metaKey && e.shiftKey) {
      e.preventDefault();
      done?.(null);
    }
  });
  // Clicking elsewhere (or another window) closes it.
  input.addEventListener('blur', () => setTimeout(() => {
    if (done && !list.contains(document.activeElement) && document.activeElement !== input) done(null);
  }, 200));
  const picked = await modal({ title: '', body: [input, list], buttons: [], quick: true, onOpen: (_box, close) => {
    done = close;
    quickOpenClose = close;
    // The last query comes back selected, so typing replaces it.
    setTimeout(() => input.select(), 0);
  } });
  quickOpenClose = null;
  done = null;
  if (picked) (picked.dir ? onPickFolder : onPick)(picked.path);
}
