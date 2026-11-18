# More Topics

- [Quick Start](../welcome.md)
- [Markdown Reference](markdown-reference.md)
- [Shortcut Keys](shortcuts.md)
- [Use Images in Livemark](images.md)
- [Install and Use Pandoc](pandoc.md)
- [Custom Themes](custom-themes.md)
- [Change Log](changelog.md)
- [Credits](credits.md)
- [Privacy Policy](privacy.md)

## Things worth knowing

**Custom shortcuts.** **Settings → General → Open Advanced Settings** opens `conf.user.json`. Add entries to `keyBinding`, by menu title or command id, then reopen the window:

```json
{
  "keyBinding": {
    "Code Fences": "ctrl+shift+k",
    "Always on Top": "ctrl+cmd+t"
  }
}
```

**Front matter.** `title`, `author`, `header`, `footer` and `theme` in the YAML front matter are used when exporting, if **Settings → Export → Read and overwrite export settings from YAML front matters** is on.

**Versions.** Every save keeps a copy. **File → Revert To → Browse All Versions…** shows them.

**TextBundle.** Choose `.textbundle` when saving to keep a document and its pictures together in one package.
