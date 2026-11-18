# Custom Themes

A theme is a CSS file. Livemark loads every `.css` file in its themes folder when it starts and lists them in the **Themes** menu.

## Where themes live

Choose **Themes → Open Theme Folder**. The folder is `~/Library/Application Support/Livemark/themes/`.

- `base.user.css` always applies, whichever theme is selected. Use it for small adjustments you want everywhere.
- Any other file becomes a theme named after the file: `ocean.css` appears as **ocean**.

## Writing a theme

Scope the rules to the file's name and set the variables you want to change:

```css
:root[data-theme="ocean"] {
  --bg: #f4f8fb;
  --text: #1d2b36;
  --muted: #5f7482;
  --border: #d5e0e8;
  --accent: #0b7285;
  --font-body: Georgia, "Songti SC", serif;
  --line-height: 1.8;
}
[data-theme="ocean"] .write h1 { text-align: center; }
```

The folder contains `my-theme.css` as a starting point. Reopen Livemark after adding or renaming a file.

## Variables

| Variable | What it sets |
| :-- | :-- |
| `--bg`, `--text` | Page background and body text |
| `--muted`, `--faint` | Secondary text and Markdown markers |
| `--border`, `--rule` | Table borders and horizontal rules |
| `--soft`, `--code-bg`, `--fence-bg` | Backgrounds of quotes, inline code and code fences |
| `--accent` | Links |
| `--font-body`, `--font-heading`, `--font-mono` | Typefaces |
| `--line-height`, `--content-width` | Line spacing and the width of the text column |

## Quick adjustments

**Settings → Appearance → Custom CSS** takes CSS that applies on top of the selected theme, without creating a file.

A different theme for export can be chosen in **Settings → Export**.
