const { parseMarkdown, serialize } = await import(process.argv[2] + '/src/markdown.js');
const RT = ['* star one\n* star two\n\n+ plus one\n+ plus two\n\n1) paren one\n2) paren two\n\n5. five\n6. six\n', 'Setext One\n==========\n\nSetext Two\n----------\n\n### atx three ###\n', 'a\n\n***\n\nb\n\n___\n\nc\n', '~~~python\nx = 1\n~~~\n\n````\n```\n````\n\n    indented code\n', '_em_ __strong__ *em2* **strong2** ***both***\n', '| a | b |\n|:--|--:|\n| 1 | 2 |\n', '- [x] done\n- [ ] todo\n\n* [ ] star task\n', '> quote\ncontinued lazily\n\n>no space\n', 'line one  \nline two\\\nline three<br>four\n', '1. a\n1. b\n1. c\n\n-   wide marker\n-   second\n', 'text[^1]\n\n[^1]: note\n\n[ref]: http://a.b "T"\n', 'Term\n\n<div align="center">\n  <b>x</b>\n</div>\n\n$$\nx^2\n$$\n', '- a\n\n- b\n\n- c\n', '- a\n    - four space child\n- b\n\t- tab child\n', '---\ntitle: T\n---\n\n# H\n\n\n\npara after three blank lines\n', '> [!NOTE]\n> body\n\n> - q item\n>   more\n', '1. one\n   ```js\n   code in item\n   ```\n2. two\n\n   para in item\n'];
let bad = 0;
for (const md of RT) {
  const doc = parseMarkdown(md);
  const same = serialize(doc) === md;
  // edit only the last text block; everything before it must stay as it was
  const k = doc.map((b) => typeof b.text === 'string').lastIndexOf(true);
  const edited = doc.map((b, n) => (n === k ? { ...b, text: `${b.text}X` } : b));
  const out = serialize(edited);
  const head = md.split('\n').slice(0, -3).join('\n');
  const keeps = out.startsWith(head);
  // re-parse of the edited output gives the same structure
  const shape = (d) => d.map((b) => `${b.type}${b.q}${b.indent}${b.kind || ''}:${(b.text ?? '').replace(/X$/, '')}`).join('|');
  const stable = shape(parseMarkdown(out)) === shape(doc);
  if (!same || !keeps || !stable) { bad++; console.log(JSON.stringify(md), '\n  same', same, 'keeps', keeps, 'stable', stable, '\n  ->', JSON.stringify(serialize(doc)), '\n  edit->', JSON.stringify(out)); }
}
// new and edited items keep the list's own style
const d = parseMarkdown('* a\n* b\n\n1) x\n2) y\n');
const split = [d[0], { ...d[0], id: 'n1', text: 'new' }, d[1], d[2], { ...d[3], id: 'n2', text: 'new2' }, d[3]];
console.log(JSON.stringify(serialize(split)));
// a moved block is written as it was, with a fresh separator
const m = parseMarkdown('para one\n\n* item\n\n> quote\n');
console.log(JSON.stringify(serialize([m[2], m[0], m[1]])));
console.log(bad ? `${bad} FAILED` : 'round trips ok');
