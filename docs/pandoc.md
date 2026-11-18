# Install and Use Pandoc

Livemark uses [Pandoc](https://pandoc.org) to import other document formats and to export Word, OpenOffice, RTF, Epub, LaTeX, MediaWiki, reStructuredText, Textile and OPML. PDF, HTML and image export do not need it.

## Install

With Homebrew:

```bash
brew install pandoc
```

Or download the installer from <https://pandoc.org/installing.html>. Reopen Livemark afterwards; **Livemark → About Livemark** says whether pandoc was found.

## If pandoc is not found

Set its location in **Settings → Export → Pandoc Path**, for example `/opt/homebrew/bin/pandoc`.

## Options

In **Settings → Export → Pandoc**:

- **Line Wrap** chooses how long lines are wrapped in text formats.
- **Use only ASCII characters in output** escapes everything else.
- **Extra Arguments** are added to every pandoc command.

## Your own formats

**Settings → Export → More Formats** adds entries to **File → Export**. Each has a name, the extension of the file it writes, and a command. The command runs in the document's folder with these placeholders:

| Placeholder | Value |
| :-- | :-- |
| `${currentPath}` | The Markdown file |
| `${outputPath}` | The file to write |
| `${outputDir}` | Its folder |
| `${filename}` | The document's name without extension |

Example, a slide deck:

```bash
pandoc ${currentPath} -t revealjs -s -o ${outputPath}
```
