# Third-party notices

Livemark's own code is under the BSD Zero Clause License (0BSD, see `LICENSE`). The files in
`vendor/` come from the projects below and keep their own licences; each
licence file sits next to the files it covers.

| Component | Version | Licence | Licence file |
| :-- | :-- | :-- | :-- |
| KaTeX (incl. mhchem extension) | 0.16.47 | MIT | `vendor/katex/LICENSE` |
| Mermaid | 11.17.2 | MIT | `vendor/mermaid/LICENSE` |
| highlight.js | 11.12.0 | BSD-3-Clause | `vendor/hljs/LICENSE` |
| node-emoji (emoji table) | 1.11.0 | MIT | `vendor/emoji.LICENSE` |
| Prettier (standalone build and plugins) | — | MIT | `vendor/prettier/LICENSE` |
| Open Sans, PT Serif, Merriweather, Lato, Vollkorn (via Fontsource) | 5.3.0 | SIL Open Font License 1.1 | `vendor/fonts/*-OFL.txt` |

`node scripts/vendor.mjs` regenerates `vendor/` from `node_modules/`,
licence files included.
