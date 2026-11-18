# Livemark — native macOS shell

A small Cocoa app (Swift + AppKit + WKWebView) that hosts the web editor and gives it files, menus, dialogs and
export through a JS ↔ native bridge. No Xcode project, no SwiftPM, no third-party code.

## Build and run

```sh
native/build.sh            # -> dist/Livemark.app (compile, Info.plist, web app, icon, ad-hoc signature)
native/build.sh --test     # build, then run the selftest

open dist/Livemark.app
open -a dist/Livemark.app notes.md                              # like Finder "Open With"
dist/Livemark.app/Contents/MacOS/Livemark notes.md other.md     # one window per file
dist/Livemark.app/Contents/MacOS/Livemark --selftest            # headless end-to-end check, exit code 0 / 1
```

The build copies everything in the project root into `Contents/Resources/web/`, except `node_modules`, `native`,
`dist`, `test`, `.git` and `*.log`. Requires the Xcode command line tools (`swiftc`), macOS 12+.

Environment variables:

| Variable | Effect |
| --- | --- |
| `LIVEMARK_WEB_ROOT=/abs/dir` | Serve the web app from this directory instead of the bundle (edit, then reload; no rebuild). |
| `LIVEMARK_APP_SUPPORT=/abs/dir` | Use this directory instead of `~/Library/Application Support/Livemark` (settings store). |
| `LIVEMARK_DEBUG=1` | Log window lifecycle, events, failed bridge calls and page JS errors to stderr. |
| `LIVEMARK_SELFTEST_KEEP=1` | Keep the selftest's temp directory (exported PDF / PNG) and print its path. |

## Sources

| File | Role |
| --- | --- |
| `main.swift`, `AppDelegate.swift` | Launch, window list, opening files, quit flow |
| `WindowController.swift` | Window + web view, events to the page, close flow, file drops |
| `WebDelegates.swift` | Navigation policy, external links, JS alert/confirm/prompt, `<input type=file>`, downloads |
| `Bridge.swift` | Message handler and the commands that need the window / main thread |
| `FileCommands.swift` | `fs.*`, `store.*`, `pandoc.run` (background queue) |
| `SchemeHandler.swift` | `livemark://app/…` and `livemark://fs/…` |
| `MenuBuilder.swift` | MenuSpec → NSMenu, key parsing, roles, context menus |
| `Export.swift` | PDF, print, PNG / JPEG |
| `PDFPostProcess.swift` | Header / footer and bookmarks added to an exported PDF (PDFKit) |
| `WindowStyle.swift` | `window.setStyle` (classic / unibody) and the unibody drag band |
| `TouchBar.swift` | `touchbar.set`: the Touch Bar of each mode |
| `SystemCommands.swift` | Quick Look, spelling language, magnification, TextBundle-aware open panel, Continuity Camera import |
| `SelfTest.swift`, `SelfTestScripts.swift` | `--selftest` |
| `Tools/make-icon.swift` | Draws the app icon (used by `build.sh`) |

## URLs

- `livemark://app/<path>` — files from the web root; `livemark://app/` is `index.html`. Paths that leave the root get 403.
- `livemark://fs/<absolute path>` — any local file, read-only (`'livemark://fs/' + encodeURIComponent(path)`;
  plain slashes work too). 404 if missing. Supports `Range` requests.

Both send `Cache-Control: no-store` and `Access-Control-Allow-Origin: *`. The page is a secure context.
Only `livemark://app/…` may be loaded in the main frame; `http(s)` / `mailto` links and `window.open` go to the
default browser; iframes may load `http(s)`.

## Bridge: JS → native

```js
const result = await window.webkit.messageHandlers.livemark.postMessage({ cmd: 'fs.readText', args: { path } });
```

The promise rejects with an `Error` whose message starts with the command name. Paths must be absolute (`~` is
expanded). Only the app page's main frame can use the bridge.

| Command | Args | Result |
| --- | --- | --- |
| `app.ready` | – | `{ openPath, home, appSupport, documents, pandoc, version, windowId, dark, fullscreen }`. Events start flowing after this call. |
| `dialog.openFile` | `extensions?, multiple?, directory?` | `string[]` (empty if cancelled). With `"textbundle"` among the extensions, `*.textbundle` folders can be chosen like files (other folders are only browsed) |
| `dialog.openFolder` | `directory?` | `string \| null` |
| `dialog.save` | `suggestedName?, directory?, extensions?` | `string \| null` — `"textbundle"` works too; the page creates the folder |
| `dialog.message` | `message, detail?, buttons?, style?, cancel?` | `{ index }` — sheet; first button is the default; `cancel` = index of the button Esc triggers |
| `fs.readText` | `path` | `{ text, mtime }` — UTF-8, UTF-16 with BOM, else lossy |
| `fs.writeText` | `path, text` | `{ mtime }` — atomic, creates parent directories |
| `fs.writeBase64` | `path, base64` | `{ mtime }` |
| `fs.readBase64` | `path` | `{ base64, mime }` |
| `fs.list` | `path, hidden?` | `[{ name, path, isDir, mtime, created, size }]` — not recursive, sorted by name; dotfiles only with `hidden: true`; times in ms |
| `fs.stat` | `path` | `{ exists, isDir, mtime, created, size }` (all zero / false if missing) |
| `fs.mkdir` | `path` | `true` |
| `fs.rename` | `from, to` | `true` — also moves; fails if `to` exists |
| `fs.copy` | `from, to` | `true` — fails if `to` exists |
| `fs.trash` | `path` | `true` — moves to the Trash |
| `fs.reveal` | `path` | `true` |
| `file.quickLook` | `path` | `true` — shows the file in the Quick Look panel |
| `net.download` | `url, path` | `{ ok: true, mime, size }` — http / https only, 30 s timeout, creates parent directories, replaces `path`; rejects on any failure (including HTTP status ≥ 300 after redirects) |
| `shell.openExternal` | `url` | `true` — http, https, mailto only |
| `shell.openPath` | `path` | `true` |
| `clipboard.write` | `text?, html?` | `true` |
| `clipboard.read` | – | `{ text, html, imagePngBase64, filePaths }` |
| `store.get` | `key` | value or `null` |
| `store.set` | `key, value` | `true` — `appSupport/store.json`, shared by all windows; `null` removes the key |
| `window.setTitle` | `title, path?, dirty?` | `true` — omitted `path` / `dirty` keep their value; `path: null` clears it |
| `window.new` | `path?` | `true` |
| `window.close` | `force?` | `true` — without `force` the page gets `closeRequested` |
| `window.startDrag` | – | `true`, or `false` if the mouse button is no longer down |
| `window.titlebarDoubleClick` | – | `true` — zoom / minimize / nothing, per System Settings |
| `window.setAlwaysOnTop` | `on` | `true` |
| `window.toggleFullScreen` | – | `true` |
| `window.setStyle` | `style` | `true` — `"classic"` (standard title bar) or `"unibody"` (see below) |
| `window.setMagnification` | `on` | `true` — pinch-to-zoom of the page |
| `window.commandAll` | `id` | number of windows — every window's page gets `command { id }` |
| `touchbar.set` | `mode` | `true` — `"text"` (default), `"table"`, `"code"`, `"find"`, `"none"` |
| `spell.info` | – | `{ languages: [{ id, name }], current, auto }` |
| `spell.setLanguage` | `language` | `true` — an `id` from `spell.info`, or `"auto"` |
| `menu.set` | `menus: MenuSpec[]` | `true` — replaces the menu bar; an invalid spec is rejected and changes nothing |
| `menu.update` | `items: [{ id, checked?, enabled?, title? }]` | `true` |
| `menu.popup` | `items: MenuItemSpec[], x?, y?` | `{ id }` (`null` if dismissed); CSS px from the top-left, default = mouse position |
| `export.pdf` | `path, paper?, landscape?, margin?, margins?, header?, footer?, outline?` | `true` — see below |
| `export.print` | `paper?, landscape?, margin?, margins?` | `true` if printed, `false` if the panel was cancelled |
| `export.image` | `path, width, height, scale?, format?, quality?` | `true` — `format` `"png"` (default) or `"jpeg"`, `quality` 0…1 for JPEG (default 0.9); `scale` defaults to the display scale (2 on Retina) |
| `pandoc.run` | `args, stdin?, cwd?` | `{ code, stdout, stderr }` — only runs the detected pandoc, 120 s timeout |

### PDF export

- `paper`: `"A3"`, `"A4"`, `"A5"`, `"Letter"`, `"Legal"`, `"Tabloid"` or `{ width, height }` in points (72…14400). Default:
  the system's default paper. `landscape: true` turns a named paper on its side; a custom size is used as given.
- `margin`: points for all four sides (default 36). `margins: { top, right, bottom, left }` overrides it side by side.
- `header` / `footer`: one line each, drawn in a small grey system font in the middle of the top / bottom margin,
  centred between the side margins, on every page. `${pageNo}` and `${totalPages}` are filled in here; left out when the
  margin is under 11 pt.
- `outline: [{ level: 1…6, text }]`: PDF bookmarks, nested by level. Each heading is looked up in the printed text
  after the previous one (a line of its own wins over the same words inside a paragraph); headings that are not found
  are skipped.

Header, footer and bookmarks are added to the finished file with PDFKit; text stays selectable and links stay links.
They do not apply to `export.print`.

### Window style

`window.setStyle { style: "unibody" }` gives the page the whole window: full-size content view, transparent title bar,
no title text, the traffic lights (at their standard place: x 7…61 pt, y 6…22 pt from the top-left corner) over the
page. The top 38 pt of the page then act as the title bar: a mouse-down there on empty chrome drags the window and a
double click zooms / minimizes per System Settings. "Empty" means the element under the pointer is not (inside) a link,
form control, `contenteditable`, `[role=button|tab|menuitem|link|slider|checkbox|switch]`, `[draggable=true]` or
`[data-no-drag]`, and its cursor is not `pointer` / `text`. While the native tab bar shows, the page starts below it. The
window frame stays put when the style changes, and a new window starts in the style stored at `settings.windowStyle`.

### Touch Bar

Every control emits `command { id }`. `text`: `strong em underline code link` · Paragraph ▸ `h1`…`h6 paragraph` ·
`ul ol task` · `quote` · `imageInsert` · `tableInsert`. `table`: `table-rowBelow table-colAfter table-rowDelete
table-colDelete` · Move ▸ `table-rowUp table-rowDown table-colLeft table-colRight` · `table-tableDelete`.
`code`: `codeCopy codeIndent`. `find`: `findPrev findNext replaceNext`. `none`: empty.

### Menus

`MenuSpec = { title, items, role? }` — the first is the application menu (its title is always the app name);
`role: "help"` marks the Help menu.

`MenuItemSpec` is one of

- `{ separator: true }`
- `{ title, items }` — submenu
- `{ id, title, key?, checked?, enabled? }` — emits `command { id }`
- `{ role, title?, key? }` — native behavior through the responder chain. Roles: `about quit hide hideOthers showAll
  services minimize zoom bringAllToFront toggleFullScreen close undo redo cut copy paste pasteAndMatchStyle selectAll
  delete startSpeaking stopSpeaking emojiPicker windowList devtools showTabBar showAllTabs mergeAllWindows
  moveTabToNewWindow showSpelling checkSpelling toggleGrammar toggleSpellCorrection toggleTextReplacement
  showSubstitutions importFromDevice`. Roles come with the standard title and shortcut (`showSpelling` is `cmd+:`,
  `checkSpelling` is `cmd+;`); pass `title` / `key` to override, `key: ""` for no shortcut. The spelling and substitution
  roles are handled and validated (check marks) by the web view. `importFromDevice` is the Continuity Camera submenu
  ("Import from iPhone or iPad"; macOS sets its title): the picture is saved to `appSupport/imports/` and arrives as
  `dropFiles { paths }`.

`key`: `cmd`, `shift`, `alt`, `ctrl` joined with `+`, then one key — a character, or `enter tab backspace delete
escape space up down left right home end pageup pagedown f1`…`f12`. Examples: `cmd+shift+s`, `ctrl+\``, `f8`.

The menu bar is shared by all windows: it shows the spec of the main window and switches when another window
becomes main. A `keydown` reaches the page before the menu sees it — do not `preventDefault()` shortcuts the menu
should handle.

## Bridge: native → JS

Native calls `window.__livemark.emit(name, payload)`.

| Event | Payload | When |
| --- | --- | --- |
| `command` | `{ id }` | A menu item with an id was chosen, a Touch Bar control was tapped, or a window called `window.commandAll` |
| `openFile` | `{ path }` | A file was opened into this (pristine) window |
| `dropFiles` | `{ paths, x?, y? }` | Files, folders or `.textbundle` packages were dropped from Finder (`x`, `y` in CSS px), or a picture was imported from an iPhone / iPad (no `x`, `y`) |
| `closeRequested` | `{}` | Red button, Cmd+W, `window.close` without force, or quit with unsaved windows. Answer with `window.close { force: true }` |
| `focus` / `blur` | `{}` | The window became / resigned key |
| `fullscreen` | `{ on }` | Entered / left full screen |
| `appearance` | `{ dark }` | System appearance changed |

## Windows and lifecycle

- Opening a file (Finder, "Open With", Dock, command line) creates a window with that `openPath`. Exceptions: the only
  window, if untouched (no path, not dirty), receives `openFile` instead; a file that is already open brings its window forward.
- Closing asks the page (`closeRequested`); a page that has not sent `app.ready` (loading or crashed) cannot hold a window open.
- Quit: immediate if no window is dirty; otherwise cancelled, every window gets `closeRequested`, and the app
  quits when the last window closes (unless the user went back to work in a window first).
- Closing the last window quits only if `settings.quitOnLastWindow` in the store is `true`. Otherwise the app stays in
  the Dock: clicking its icon, or choosing any page command from the menu bar, opens a new window.
- `.textbundle` packages are a document type of the app (`org.textbundle.package`): opening one passes the path of the
  bundle directory like a file's.

## Selftest

`--selftest` loads the real web app in an off-screen window and exercises the bridge, both URL schemes, menus,
events, multi-window routing, the close / quit flows and PDF / PNG export against a temp directory. It prints
`ok <name>` / `FAIL <name>: <reason>` per check, then `SELFTEST PASS` or `SELFTEST FAIL` (exit code 0 / 1), and stops
itself after 90 s. JS errors raised by the web app while loading are listed as `WARN page.console` and do not fail the
run. It runs on a temporary app-support directory and a non-persistent web data store, so the web app's settings
are not touched. It briefly uses the clipboard (restored afterwards) and leaves one small file in the Trash (`fs.trash` check).
With file arguments (`--selftest a.md b.md`) it checks command-line opening instead.
