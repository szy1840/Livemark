// Sanity checks for the pure modules: inline rendering must preserve the
// source text exactly, and Markdown must survive a parse/serialize round trip.
import assert from 'node:assert/strict';
import { renderInline, renderDef, parseDef, inlineCtx } from '../src/inline.js';
import { parseMarkdown, serialize, numberLists } from '../src/markdown.js';

const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const strip = (html) => html.replace(/<span class="mk[^"]*">.*?<\/span>/g, '').replace(/<br>$/, '');

inlineCtx.emoji = { smile: '😄', tada: '🎉' };
inlineCtx.refs = new Map([['ref', { label: 'ref', url: 'https://r.example', title: '' }]]);

const inlineCases = [
  'plain text', '**bold** and *em* and ***both***', 'a `code` b ``x ` y`` c', '~~del~~ ==mark==',
  '[link](https://a.b "t") ![img](x.png)', 'see https://example.com/a?b=1, ok', '<https://x.y>',
  '\\*not em\\*', '*a **b** c*', '**a *b* c**', '**a*', '2 * 3 * 4', 'snake_case_name _em_', '****',
  'line one\nline two', '', 'a < b && c > d', '[![a](b)](c)', '**unclosed', 'trailing\n',
  'math $E=mc^2$ here', 'costs $5 and $10', 'H~2~O and x^2^', ':smile: :unknown:', 'note[^1] here',
  '<u>under</u> <kbd>K</kbd> <span style="color:red">r</span>', 'a<br>b', '<!-- c --> x',
  '[t][ref] and [ref] and [nope]', '<img src="a.png" style="zoom:50%" />', '<script>x</script>',
];
for (const src of inlineCases) assert.equal(text(renderInline(src)), src, `inline text preserved: ${JSON.stringify(src)}`);

assert.match(renderInline('**bold**'), /<strong>bold<\/strong>/);
assert.match(renderInline('*a **b** c*'), /<em>a .*<strong>b<\/strong>.* c<\/em>/);
assert.equal(strip(renderInline('**a*')), '*<span class="tok" data-t="em"><em>a</em></span>');
assert.equal(strip(renderInline('2 * 3 * 4')), '2 * 3 * 4');
assert.equal(strip(renderInline('snake_case_name')), 'snake_case_name');
assert.match(renderInline('[x](javascript:alert(1))'), /href="#"/);
assert.match(renderInline('`a<b`'), /<code>a&lt;b<\/code>/);
assert.match(renderInline('$x^2$'), /class="math-view"[^>]*data-tex="x\^2"/);
assert.doesNotMatch(renderInline('costs $5 and $10'), /math-view/);
assert.match(renderInline('H~2~O'), /<sub>2<\/sub>/);
assert.match(renderInline(':smile:'), /data-emoji="😄"/);
assert.doesNotMatch(renderInline(':unknown:'), /emoji-view/);
assert.match(renderInline('x[^1]'), /class="fn-view"[^>]*data-label="1"/);
assert.match(renderInline('<u>a</u>'), /<u>a<\/u>/);
assert.doesNotMatch(renderInline('<script>x</script>'), /<script>/);
// The handler survives only as escaped marker text, never as a real attribute.
assert.match(renderInline('<span onclick="x()">a</span>'), /<span>a<\/span>/);
assert.doesNotMatch(renderInline('<span onclick="x()">a</span>'), /<span onclick/);
assert.match(renderInline('[t][ref]'), /href="https:\/\/r.example"/);
assert.doesNotMatch(renderInline('[nope]'), /<a /);
assert.equal(text(renderDef('[^1]: a **b**')), '[^1]: a **b**');
assert.deepEqual(parseDef('[Id]: <https://x.y> "T"'), { label: 'id', url: 'https://x.y', title: 'T' });

const doc = `---
title: Test
---

# Title

Para one
soft break

- a
  - b
    1. c
    2. d
- [x] done
- [ ] todo

1. one

   second paragraph

   \`\`\`js
   code in item
   \`\`\`
2. two

> quote a
>
> quote b
>
> > nested
>
> - in quote
> - list

> [!NOTE]
> an alert

\`\`\`js
const x = 1;

\`\`\`

$$
a^2 + b^2
$$

| a | b |
| :-- | --: |
| 1 | 2 |

[toc]

<div align="center">
html
</div>

---

end[^n]

[^n]: note
[ref]: https://example.com "T"
`;
const blocks = parseMarkdown(doc);
const shape = blocks.map((b) => `${b.type}${b.q ? `q${b.q}` : ''}${b.indent ? `i${b.indent}` : ''}`);
assert.deepEqual(shape, [
  'meta', 'h', 'p', 'li', 'lii1', 'lii2', 'lii2', 'li', 'li', 'li', 'pi1', 'codei1', 'li',
  'pq1', 'pq1', 'pq2', 'liq1', 'liq1', 'pq1', 'pq1', 'code', 'math', 'table', 'toc', 'html', 'hr', 'p', 'def', 'def',
]);
assert.equal(blocks[2].text, 'Para one\nsoft break');
assert.equal(blocks[11].text, 'code in item');
assert.equal(blocks[20].text, 'const x = 1;\n');
assert.deepEqual(numberLists(blocks).filter(Boolean), [1, 2, 1, 2]);
const once = serialize(blocks);
assert.equal(serialize(parseMarkdown(once)), once, 'serialize is stable');
// The only differences allowed from the source: loose list spacing and the
// two definitions being separated by a blank line.
assert.equal(once.replace(/\n\n/g, '\n'), doc.replace(/\n\n/g, '\n').replace(/\n {3}\n/g, '\n'), 'round trip keeps the document');

const started = parseMarkdown('3. a\n4. b\n');
assert.equal(started[0].start, 3);
assert.equal(serialize(started), '3. a\n4. b\n');

console.log('all checks passed');
