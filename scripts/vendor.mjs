// Copies the browser builds of the third-party libraries out of node_modules
// into vendor/, so the app runs with no bundler and no network.
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nm = (p) => `${root}node_modules/${p}`;
const out = (p) => `${root}vendor/${p}`;

await rm(out(''), { recursive: true, force: true });
await mkdir(out('katex/fonts'), { recursive: true });
await mkdir(out('hljs/languages'), { recursive: true });
await mkdir(out('mermaid'), { recursive: true });

await cp(nm('katex/dist/katex.min.js'), out('katex/katex.min.js'));
await cp(nm('katex/dist/katex.min.css'), out('katex/katex.min.css'));
await cp(nm('katex/dist/contrib/mhchem.min.js'), out('katex/mhchem.min.js'));
for (const f of await readdir(nm('katex/dist/fonts'))) {
  if (f.endsWith('.woff2')) await cp(nm(`katex/dist/fonts/${f}`), out(`katex/fonts/${f}`));
}
await cp(nm('@highlightjs/cdn-assets/highlight.min.js'), out('hljs/highlight.min.js'));
for (const f of await readdir(nm('@highlightjs/cdn-assets/languages'))) {
  if (f.endsWith('.min.js')) await cp(nm(`@highlightjs/cdn-assets/languages/${f}`), out(`hljs/languages/${f}`));
}
await cp(nm('mermaid/dist/mermaid.min.js'), out('mermaid/mermaid.min.js'));
await cp(nm('node-emoji/lib/emoji.json'), out('emoji.json'));
// Theme fonts (all open-source, from Fontsource): latin and latin-ext only.
const FONTS = [
  ['open-sans', 'Open Sans', [400, 700], true],
  ['pt-serif', 'PT Serif', [400, 700], true],
  ['merriweather', 'Merriweather', [300, 400, 700], true],
  ['lato', 'Lato', [400, 700, 900], false],
  ['vollkorn', 'Vollkorn', [400, 700], true],
];
await mkdir(out('fonts'), { recursive: true });
let css = '';
for (const [pkg, family, weights, italics] of FONTS) {
  for (const weight of weights) {
    for (const style of italics ? ['normal', 'italic'] : ['normal']) {
      for (const subset of ['latin', 'latin-ext']) {
        const file = `${pkg}-${subset}-${weight}-${style}.woff2`;
        try {
          await cp(nm(`@fontsource/${pkg}/files/${file}`), out(`fonts/${file}`));
        } catch {
          continue;
        }
        const range = subset === 'latin'
          ? 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
          : 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
        css += `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;src:url(./${file}) format("woff2");unicode-range:${range}}\n`;
      }
    }
  }
}
// Each library's licence travels with its files.
await cp(nm('katex/LICENSE'), out('katex/LICENSE'));
await cp(nm('@highlightjs/cdn-assets/LICENSE'), out('hljs/LICENSE'));
await cp(nm('mermaid/LICENSE'), out('mermaid/LICENSE'));
await cp(nm('node-emoji/LICENSE'), out('emoji.LICENSE'));
for (const [pkg] of FONTS) await cp(nm(`@fontsource/${pkg}/LICENSE`), out(`fonts/${pkg}-OFL.txt`));
const { writeFile } = await import('node:fs/promises');
await writeFile(out('fonts/fonts.css'), css);
console.log('vendor/ ready');
