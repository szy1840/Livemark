const { editor: ed } = window.livemark;
const root = document.querySelector('#write');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const fire = (type, init = {}) => root.dispatchEvent(type.startsWith('composition') ? new CompositionEvent(type, { bubbles: true, ...init }) : new InputEvent(type, { bubbles: true, cancelable: true, ...init }));
const key229 = () => root.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, keyCode: 229, which: 229, key: 'Process' }));
const state = () => ({ md: ed.getMarkdown().trimEnd(), dom: [...root.children].map((e) => e.textContent).join(' | '), sel: ed.getSel() && `${ed.getSel().focus.i}:${ed.getSel().focus.off}`, kids: root.childNodes.length, blocks: ed.doc.length });

// A: empty paragraph, events in Chrome order, browser leaves "<text><br>"
ed.setMarkdown(''); ed.focus();
key229(); fire('compositionstart');
let p = root.children[0]; p.insertBefore(document.createTextNode('ni'), p.firstChild);
fire('input', { inputType: 'insertCompositionText', data: 'ni', isComposing: true });
p.firstChild.data = '你';
fire('compositionend', { data: '你' });
await wait(20); out.A = state();

// B: WebKit order (beforeinput first), and the commit wrecks the structure:
// the paragraph is removed and the text lands directly in the root.
ed.setMarkdown('# 标题\n\nx'); ed.setSel({ i: 1, leaf: 0, off: 1 });
key229(); fire('beforeinput', { inputType: 'insertCompositionText', data: 'h' }); fire('compositionstart');
p = root.children[1]; p.textContent = 'xhao';
fire('input', { inputType: 'insertCompositionText', data: 'hao' });
fire('beforeinput', { inputType: 'deleteCompositionText' }); p.remove(); fire('input', { inputType: 'deleteCompositionText' });
fire('beforeinput', { inputType: 'insertFromComposition', data: '好' }); root.appendChild(document.createTextNode('好')); fire('input', { inputType: 'insertFromComposition', data: '好' });
fire('compositionend', { data: '好' });
await wait(20); out.B = state();

// C: in the middle of formatted text
ed.setMarkdown('ab**c**d'); ed.setSel({ i: 0, leaf: 0, off: 2 });
key229(); fire('compositionstart'); fire('compositionend', { data: '中文' });
await wait(20); out.C = state();

// D: two compositions back to back, the second starting before the first is flushed
ed.setMarkdown('x'); ed.setSel({ i: 0, leaf: 0, off: 1 });
key229(); fire('compositionstart'); fire('compositionend', { data: '一' });
key229(); fire('compositionstart'); fire('compositionend', { data: '二' });
await wait(20); out.D = state();

// E: composing "# " style prefixes still converts the block; cancelled composition leaves text alone
ed.setMarkdown('keep'); ed.setSel({ i: 0, leaf: 0, off: 4 });
key229(); fire('compositionstart'); root.children[0].textContent = 'keepxyz'; fire('compositionend', { data: '' });
await wait(20); out.E_cancel = state();

// F: selection inside one block is replaced by the composed text
ed.setMarkdown('hello world'); ed.setSel({ i: 0, leaf: 0, off: 6 }, { i: 0, leaf: 0, off: 11 });
key229(); fire('compositionstart'); fire('compositionend', { data: '世界' });
await wait(20); out.F = state();

// G: table cell and code block
ed.setMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet a;\n```'); ed.setSel({ i: 0, leaf: 3, off: 1 });
key229(); fire('compositionstart'); fire('compositionend', { data: '格' });
await wait(20); ed.setSel({ i: 1, leaf: 0, off: 6 }); key229(); fire('compositionstart'); fire('compositionend', { data: ' // 注释' });
await wait(20); out.G = state();

// undo still works after composed input
ed.undo(); out.undo = ed.getMarkdown().includes('注释');
return out;
