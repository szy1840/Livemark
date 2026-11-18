/// JavaScript run inside the page by `--selftest` (see SelfTest.swift).
enum SelfTestScripts {
    /// Injected at document start in selftest mode: records page errors, and records native -> JS events in place of
    /// the web app (which may or may not define `window.__livemark` yet), so the app does not react to test events.
    static let pageHooks = #"""
        (function () {
          const errors = (window.__lmSelftestErrors = []);
          window.addEventListener('error', (e) => {
            if (e.message) errors.push(`${e.message} (${e.filename || '?'}:${e.lineno || 0})`);
            else errors.push('resource failed to load: ' + ((e.target && (e.target.src || e.target.href)) || 'unknown'));
          }, true);
          window.addEventListener('unhandledrejection', (e) => {
            errors.push('unhandled rejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
          });
          const original = console.error;
          console.error = function (...args) {
            errors.push('console.error: ' + args.map((a) => (a && a.stack) || String(a)).join(' '));
            return original.apply(console, args);
          };

          const events = (window.__lmSelftestEvents = []);
          const waiters = (window.__lmSelftestWaiters = []);
          const recorder = { emit(name, payload) { events.push({ name, payload }); waiters.splice(0).forEach((w) => w()); } };
          window.__lmSelftestPageDefinesEmit = false;
          Object.defineProperty(window, '__livemark', {
            get: () => recorder,
            set(value) { window.__lmSelftestPageDefinesEmit = !!(value && typeof value.emit === 'function'); },
          });
        })();
        """#

    /// Body of an async function run in the page. Arguments: `tmp`, `queuedPath`, `webRoot`, `appSupport`. Returns [{ name, ok, detail }].
    static let suite = #"""
        const out = [];
        const B = (cmd, args) => window.webkit.messageHandlers.livemark.postMessage({ cmd, args: args || {} });
        const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
          ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x);
        const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
        const eq = (got, want, what) => assert(canon(got) === canon(want), `${what || 'value'}: got ${canon(got)}, want ${canon(want)}`);
        const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);
        const rejects = async (p, what) => {
          try { await p; } catch (e) { return String((e && e.message) || e); }
          throw new Error(`${what} should have been rejected`);
        };
        const check = async (name, fn) => {
          let row;
          try {
            const detail = await timeout(Promise.resolve().then(fn), 30000, name);
            row = { name, ok: true, detail: detail == null ? '' : String(detail) };
          } catch (e) {
            row = { name, ok: false, detail: String((e && e.message) || e) };
          }
          out.push(row);
          await B('selftest.report', row); // printed as it happens, so a hang shows where it stopped
        };
        const loadImage = (src, cors) => new Promise((resolve, reject) => {
          const img = new Image();
          if (cors) img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('image failed to load: ' + src));
          img.src = src;
        });

        // Native -> JS events land in the recorder installed at document start (see pageHooks).
        const events = window.__lmSelftestEvents, waiters = window.__lmSelftestWaiters;
        const waitEvent = (name, pred) => timeout(new Promise((resolve) => {
          const look = () => {
            const hit = events.find((e) => e.name === name && (!pred || pred(e.payload)));
            if (hit) resolve(hit.payload); else waiters.push(look);
          };
          look();
        }), 8000, `event "${name}"`);

        // The web app talks to the bridge too while it starts up (app.ready, menu.set, window.setTitle, …).
        // Let that settle so its calls do not interleave with the checks below.
        await B('selftest.waitIdle');

        await check('bridge.available', () => {
          assert(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.livemark, 'window.webkit.messageHandlers.livemark is missing');
          eq(location.href, 'livemark://app/index.html', 'location');
        });

        let info = {};
        await check('app.ready', async () => {
          info = await B('app.ready');
          eq(info.openPath, null, 'openPath');
          for (const k of ['home', 'appSupport', 'documents', 'version']) assert(typeof info[k] === 'string' && info[k].length > 0, `${k} must be a string`);
          eq(info.appSupport, appSupport, 'appSupport'); // selftest runs on a temporary one, see SelfTest.prepare
          assert(info.pandoc === null || typeof info.pandoc === 'string', 'pandoc');
          assert(typeof info.windowId === 'number', 'windowId');
          const st = await B('fs.stat', { path: info.appSupport });
          assert(st.exists && st.isDir, 'appSupport was not created');
          return `version ${info.version}, windowId ${info.windowId}, pandoc ${info.pandoc}`;
        });

        await check('event.openFile (queued before app.ready)', async () => {
          eq(await waitEvent('openFile'), { path: queuedPath }, 'payload');
        });

        await check('bridge.rejects-bad-calls', async () => {
          const unknown = await rejects(B('nope.nothing'), 'unknown command');
          await rejects(B('fs.readText', {}), 'missing path');
          await rejects(B('fs.readText', { path: 42 }), 'numeric path');
          await rejects(B('fs.readText', { path: 'relative/file.md' }), 'relative path');
          const missing = await rejects(B('fs.readText', { path: tmp + '/does-not-exist.md' }), 'missing file');
          await rejects(window.webkit.messageHandlers.livemark.postMessage('just a string'), 'malformed message');
          await rejects(window.webkit.messageHandlers.livemark.postMessage({ cmd: 'fs.stat', args: 'x' }), 'non-object args');
          await rejects(B('shell.openExternal', { url: 'file:///etc/hosts' }), 'file: URL in shell.openExternal');
          await rejects(B('fs.writeBase64', { path: tmp + '/x.bin', base64: '***' }), 'invalid base64');
          return `${unknown} / ${missing}`;
        });

        const text = 'Hello Livemark — 中文测试 🚀 éè\n第二行 "quotes" \\ backslash\n';
        const dir = tmp + '/深/nested dir';
        const file = dir + '/笔记 note.md';
        let written = {};

        await check('fs.mkdir', async () => {
          eq(await B('fs.mkdir', { path: dir }), true);
          const st = await B('fs.stat', { path: dir });
          assert(st.exists && st.isDir, 'directory not created');
          eq(await B('fs.mkdir', { path: dir }), true, 'mkdir of an existing directory');
        });

        await check('fs.writeText', async () => {
          written = await B('fs.writeText', { path: file, text });
          assert(typeof written.mtime === 'number' && written.mtime > 1.6e12, 'mtime should be in ms: ' + written.mtime);
          const deep = await B('fs.writeText', { path: tmp + '/auto/created/parents.txt', text: 'x' });
          assert(deep.mtime > 0, 'parents not created');
        });

        await check('fs.readText (中文 + emoji round trip)', async () => {
          const r = await B('fs.readText', { path: file });
          eq(r.text, text, 'text');
          eq(r.mtime, written.mtime, 'mtime');
        });

        await check('fs.readText (lossy decoding of invalid UTF-8)', async () => {
          const p = tmp + '/invalid-utf8.txt';
          await B('fs.writeBase64', { path: p, base64: btoa('abc\xC3\x28def\xFF') });
          const r = await B('fs.readText', { path: p });
          assert(r.text.startsWith('abc') && r.text.includes('def') && r.text.includes('�'), JSON.stringify(r.text));
        });

        await check('fs.list', async () => {
          await B('fs.writeText', { path: tmp + '/.hidden', text: 'h' });
          await B('fs.writeText', { path: tmp + '/b.md', text: 'bb' });
          const items = await B('fs.list', { path: tmp });
          const names = items.map((i) => i.name);
          assert(!names.includes('.hidden'), 'dotfile was listed');
          assert(!names.includes('parents.txt'), 'listing must not be recursive');
          for (const n of ['b.md', 'auto', '深', 'invalid-utf8.txt']) assert(names.includes(n), `${n} missing from ${names}`);
          const b = items.find((i) => i.name === 'b.md');
          eq([b.path, b.isDir, b.size], [tmp + '/b.md', false, 2], 'b.md');
          assert(b.mtime > 1.6e12, 'mtime');
          for (const i of items) assert(typeof i.created === 'number' && i.created > 1.6e12 && i.created <= Date.now() + 1000, `created of ${i.name}: ${i.created}`);
          assert(b.created <= b.mtime + 1000, `b.md was created (${b.created}) after it was modified (${b.mtime})`);
          eq(items.find((i) => i.name === 'auto').isDir, true, 'auto.isDir');
          const all = await B('fs.list', { path: tmp, hidden: true });
          eq(all.map((i) => i.name).filter((n) => !names.includes(n)), ['.hidden'], 'hidden: true adds exactly the dot-files');
          eq((await B('fs.list', { path: tmp, hidden: false })).length, items.length, 'hidden: false is the default');
          await rejects(B('fs.list', { path: tmp + '/nope' }), 'listing a missing directory');
          await rejects(B('fs.list', { path: tmp, hidden: 'yes' }), 'non-boolean hidden');
          return names.join(', ') + ' (+ .hidden with hidden: true)';
        });

        await check('fs.stat', async () => {
          const st = await B('fs.stat', { path: file });
          eq([st.exists, st.isDir, st.size, st.mtime], [true, false, new TextEncoder().encode(text).length, written.mtime], 'file');
          assert(st.created > 1.6e12 && st.created <= st.mtime + 1000, `created ${st.created} vs mtime ${st.mtime}`);
          eq(await B('fs.stat', { path: tmp + '/nope' }), { exists: false, isDir: false, mtime: 0, created: 0, size: 0 }, 'missing');
          return `created ${new Date(st.created).toISOString()}`;
        });

        await check('fs.rename', async () => {
          const to = tmp + '/moved/renamed.md';
          eq(await B('fs.rename', { from: tmp + '/b.md', to }), true);
          eq((await B('fs.stat', { path: tmp + '/b.md' })).exists, false, 'source still exists');
          eq((await B('fs.readText', { path: to })).text, 'bb', 'content');
          await rejects(B('fs.rename', { from: to, to: file }), 'rename onto an existing file');
          eq(await B('fs.rename', { from: to, to: tmp + '/moved/RENAMED.md' }), true, 'case-only rename');
          eq((await B('fs.list', { path: tmp + '/moved' })).map((i) => i.name), ['RENAMED.md'], 'case-only rename');
        });

        await check('fs.copy', async () => {
          const to = tmp + '/copies/copy.md';
          eq(await B('fs.copy', { from: file, to }), true);
          eq((await B('fs.readText', { path: to })).text, text, 'copy');
          eq((await B('fs.stat', { path: file })).exists, true, 'source');
          await rejects(B('fs.copy', { from: file, to }), 'copy onto an existing file');
        });

        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const pngPath = tmp + '/img/pixel one.png';
        await check('fs.writeBase64 + fs.readBase64', async () => {
          const w = await B('fs.writeBase64', { path: pngPath, base64: png });
          assert(w.mtime > 0, 'mtime');
          eq(await B('fs.readBase64', { path: pngPath }), { base64: png, mime: 'image/png' });
        });
        await check('image.scale', async () => {
          eq(await B('image.scale', { url: pngPath }), 1, 'a 72 dpi picture has one pixel per point');
          eq(await B('image.scale', { url: tmp + '/img/missing.png' }), 1, 'an unreadable picture counts as 1');
        });

        await check('fs.trash', async () => {
          const p = tmp + '/livemark-selftest-trash-me.txt';
          await B('fs.writeText', { path: p, text: 'Created by Livemark --selftest. Safe to delete.' });
          const res = await B('fs.trash', { path: p });
          eq(typeof res.trashed, 'string', 'where it went in the Trash');
          eq((await B('fs.stat', { path: p })).exists, false, 'file is still there');
          await rejects(B('fs.trash', { path: p }), 'trashing a missing file');
        });

        await check('store.set + store.get', async () => {
          const key = '__selftest__';
          const value = { n: 1.5, s: '中文 ✓', list: [1, 'two', null, true], nested: { ok: true } };
          eq(await B('store.set', { key, value }), true);
          eq(await B('store.get', { key }), value, 'round trip');
          const disk = JSON.parse((await B('fs.readText', { path: info.appSupport + '/store.json' })).text);
          eq(disk[key], value, 'store.json on disk');
          await B('store.set', { key, value: 'plain string' });
          eq(await B('store.get', { key }), 'plain string', 'scalar value');
          await B('store.set', { key, value: null });
          eq(await B('store.get', { key }), null, 'cleared key');
          eq(await B('store.get', { key: '__selftest_missing__' }), null, 'missing key');
        });

        await check('clipboard.write + clipboard.read', async () => {
          const before = await B('clipboard.read');
          assert(Array.isArray(before.filePaths), 'filePaths must be an array');
          try {
            const t = 'Livemark selftest 剪贴板 ' + Date.now();
            eq(await B('clipboard.write', { text: t, html: '<p><b>Livemark</b> selftest</p>' }), true);
            const now = await B('clipboard.read');
            eq(now.text, t, 'text');
            assert(typeof now.html === 'string' && now.html.includes('<b>Livemark</b>'), 'html: ' + now.html);
            eq([now.imagePngBase64, now.filePaths], [null, []], 'image / files');
            await rejects(B('clipboard.write', {}), 'empty clipboard.write');
          } finally {
            if (typeof before.text === 'string') await B('clipboard.write', { text: before.text });
          }
        });

        const spec = [
          { title: 'ignored', items: [
            { role: 'about' }, { separator: true }, { id: 'app.settings', title: 'Settings…', key: 'cmd+,' }, { separator: true },
            { role: 'services' }, { separator: true }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'showAll' },
            { separator: true }, { role: 'quit' },
          ] },
          { title: 'File', items: [
            { id: 'file.new', title: 'New', key: 'cmd+n' }, { id: 'file.save', title: 'Save', key: 'cmd+s' },
            { id: 'file.saveAs', title: 'Save As…', key: 'cmd+shift+s' },
            { title: 'Export', items: [{ id: 'export.pdf', title: 'PDF' }, { id: 'export.html', title: 'HTML', enabled: false }] },
            { separator: true }, { role: 'importFromDevice' }, { role: 'close', title: 'Close' },
          ] },
          { title: 'Edit', items: [
            { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
            { separator: true }, { title: 'Speech', items: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }, { role: 'emojiPicker' },
            { title: 'Spelling and Grammar', items: [
              { role: 'showSpelling' }, { role: 'checkSpelling' }, { separator: true },
              { role: 'toggleGrammar', title: 'Grammar Too' }, { role: 'toggleSpellCorrection', key: 'cmd+alt+k' },
            ] },
            { title: 'Substitutions', items: [{ role: 'showSubstitutions' }, { role: 'toggleTextReplacement', key: '' }] },
          ] },
          { title: 'View', items: [
            { id: 'view.source', title: 'Source Code Mode', key: 'cmd+/', checked: true }, { id: 'view.focus', title: 'Focus Mode', key: 'f8' },
            { id: 'view.top', title: 'Jump to Top', key: 'cmd+up' }, { id: 'view.copy', title: 'Copy as Markdown', key: 'cmd+alt+c' },
            { id: 'view.term', title: 'Toggle Sidebar', key: 'ctrl+`' }, { id: 'view.zoomIn', title: 'Zoom In', key: 'cmd+=' },
            { id: 'view.enter', title: 'Line Below', key: 'cmd+enter' },
            { separator: true }, { role: 'toggleFullScreen' }, { role: 'devtools' },
          ] },
          { title: 'Window', items: [{ role: 'minimize' }, { role: 'zoom' }, { separator: true }, { role: 'bringAllToFront' }, { role: 'windowList' }] },
        ];
        const flat = (items, acc = []) => { for (const i of items) { acc.push(i); if (i.items) flat(i.items, acc); } return acc; };
        const dumpMenu = async () => {
          const d = await B('selftest.menuDump');
          const all = flat(d.menus);
          return { d, all, byId: (id) => all.find((i) => i.id === id) || {}, byAction: (a) => all.find((i) => i.action === a) };
        };

        await check('menu.set', async () => {
          eq(await B('menu.set', { menus: spec }), true);
          const { d, all, byId, byAction } = await dumpMenu();
          eq(d.menus.map((m) => m.title), ['Livemark', 'File', 'Edit', 'View', 'Window'], 'menu titles (the first is always the app name)');
          eq([byId('file.saveAs').key, byId('file.saveAs').mods], ['s', ['cmd', 'shift']], 'cmd+shift+s');
          eq([byId('view.copy').key, byId('view.copy').mods], ['c', ['alt', 'cmd']], 'cmd+alt+c');
          eq([byId('view.term').key, byId('view.term').mods], ['`', ['ctrl']], 'ctrl+`');
          eq([byId('view.focus').key, byId('view.focus').mods], ['', []], 'f8');
          eq([byId('view.top').key, byId('view.top').mods], ['', ['cmd']], 'cmd+up');
          eq([byId('view.enter').key, byId('view.zoomIn').key, byId('app.settings').key], ['\r', '=', ','], 'enter / = / ,');
          eq([byId('view.source').checked, byId('file.save').checked], [true, false], 'checked');
          eq([byId('export.html').enabled, byId('export.pdf').enabled], [false, true], 'enabled');
          eq(all.find((i) => i.title === 'Export').items.map((i) => i.id), ['export.pdf', 'export.html'], 'submenu');
          for (const action of ['orderFrontStandardAboutPanel:', 'terminate:', 'hide:', 'hideOtherApplications:', 'unhideAllApplications:',
            'performClose:', 'cut:', 'copy:', 'paste:', 'pasteAsPlainText:', 'delete:', 'selectAll:', 'startSpeaking:', 'stopSpeaking:',
            'orderFrontCharacterPalette:', 'toggleFullScreen:', 'performMiniaturize:', 'performZoom:', 'arrangeInFront:']) {
            assert(byAction(action), `no menu item is wired to ${action}`);
          }
          eq([byAction('terminate:').key, byAction('terminate:').mods], ['q', ['cmd']], 'default key of the quit role');
          eq(byAction('performClose:').title, 'Close', 'role title override');
          eq([d.windowsMenu, d.servicesMenu], ['Window', true], 'windowList / services');
          await rejects(B('menu.set', { menus: [{ title: 'X', items: [{ role: 'no-such-role' }] }] }), 'unknown role');
          await rejects(B('menu.set', { menus: [{ title: 'X', items: [{ id: 'a', title: 'A', key: 'cmd+nope' }] }] }), 'unknown key');
          eq((await dumpMenu()).d.menus.length, 5, 'a rejected spec must leave the menu untouched');
          return `${all.length} items`;
        });

        await check('menu roles (spelling, substitutions, Continuity Camera)', async () => {
          const { all, byAction } = await dumpMenu();
          const roles = {
            'showGuessPanel:': 'Show Spelling and Grammar', 'checkSpelling:': 'Check Document Now', 'toggleGrammarChecking:': 'Grammar Too',
            'toggleAutomaticSpellingCorrection:': 'Correct Spelling Automatically', 'toggleAutomaticTextReplacement:': 'Text Replacement',
            'orderFrontSubstitutionsPanel:': 'Show Substitutions',
          };
          for (const [action, title] of Object.entries(roles)) {
            assert(byAction(action), `no menu item is wired to ${action}`);
            eq(byAction(action).title, title, `title of ${action}`);
          }
          // Nil-targeted: the web view (first responder) is the one that handles and validates them.
          eq(await B('selftest.webViewResponds', { selectors: Object.keys(roles) }), Object.keys(roles).map(() => true), 'WKWebView implements the actions');
          eq([byAction('showGuessPanel:').key, byAction('showGuessPanel:').mods], [':', ['cmd']], 'default key of showSpelling');
          eq([byAction('checkSpelling:').key, byAction('checkSpelling:').mods], [';', ['cmd']], 'default key of checkSpelling');
          eq([byAction('toggleAutomaticSpellingCorrection:').key, byAction('toggleAutomaticSpellingCorrection:').mods], ['k', ['alt', 'cmd']], 'key override');
          eq(byAction('toggleAutomaticTextReplacement:').key, '', 'an empty key means no shortcut');
          const camera = all.find((i) => i.identifier === 'NSMenuItemImportFromDeviceIdentifier');
          assert(camera, 'no Continuity Camera item');
          assert(Array.isArray(camera.items), 'AppKit did not give the Continuity Camera item its submenu');
          assert(camera.title && !camera.title.startsWith('<<'), 'the Continuity Camera item still has its placeholder title: ' + camera.title);
          return `Continuity Camera item "${camera.title}", ${camera.items.filter((i) => i.action === 'importFromDevice:').length} device actions right now`;
        });

        await check('Continuity Camera import -> dropFiles', async () => {
          eq(await B('selftest.importImage', { path: pngPath }), true, 'a PNG offered to the web view');
          const got = await waitEvent('dropFiles', (p) => p.paths && p.paths.length === 1 && p.paths[0].startsWith(info.appSupport + '/imports/'));
          assert(/\/import-\d{8}-\d{6}(-\d+)?\.png$/.test(got.paths[0]), 'unexpected name ' + got.paths[0]);
          eq((await B('fs.readBase64', { path: got.paths[0] })).base64, png, 'the picture is stored unchanged');
          eq(await B('selftest.importImage', { path: file }), false, 'a text file is not an import');
          return got.paths[0].slice(info.appSupport.length);
        });

        await check('menu.update', async () => {
          eq(await B('menu.update', { items: [
            { id: 'view.source', checked: false }, { id: 'view.focus', checked: true },
            { id: 'file.save', enabled: false, title: 'Save Now' }, { id: 'not.in.the.menu', checked: true },
          ] }), true);
          const { byId } = await dumpMenu();
          eq([byId('view.source').checked, byId('view.focus').checked], [false, true], 'checked');
          eq([byId('file.save').enabled, byId('file.save').title], [false, 'Save Now'], 'enabled / title');
        });

        await check('event.command (menu item -> page)', async () => {
          eq(await B('selftest.clickMenu', { id: 'file.saveAs' }), true);
          eq(await waitEvent('command', (p) => p.id === 'file.saveAs'), { id: 'file.saveAs' });
        });

        await check('event payload encoding', async () => {
          const payload = { id: 'tricky "quotes" \\ </script>    中文 🚀', list: [1, null, true] };
          await B('selftest.emit', { name: 'command', payload });
          eq(await waitEvent('command', (p) => Array.isArray(p.list)), payload);
        });

        await check('menu.popup', async () => {
          await B('selftest.cancelNextPopup', { after: 0.4 });
          const r = await B('menu.popup', { x: 40, y: 60, items: [
            { id: 'ctx.a', title: 'Alpha' }, { separator: true },
            { title: 'More', items: [{ id: 'ctx.b', title: 'Beta', checked: true }] }, { role: 'copy' },
          ] });
          eq(r, { id: null }, 'dismissed menu');
          await rejects(B('menu.popup', { items: [] }), 'empty popup');
        });

        await check('window.setTitle', async () => {
          eq(await B('window.setTitle', { title: '笔记 note.md — Livemark', path: file, dirty: true }), true);
          eq(await B('selftest.windowState'), { title: '笔记 note.md — Livemark', path: file, edited: true, dirty: true, onTop: false });
          await B('window.setTitle', { title: 'Still dirty' });
          eq(await B('selftest.windowState'), { title: 'Still dirty', path: file, edited: true, dirty: true, onTop: false }, 'omitted path/dirty stay unchanged');
          await B('window.setTitle', { title: 'Untitled', path: null, dirty: false });
          eq(await B('selftest.windowState'), { title: 'Untitled', path: null, edited: false, dirty: false, onTop: false });
          await rejects(B('window.setTitle', {}), 'missing title');
        });

        await check('window.setAlwaysOnTop', async () => {
          eq(await B('window.setAlwaysOnTop', { on: true }), true);
          eq((await B('selftest.windowState')).onTop, true);
          await B('window.setAlwaysOnTop', { on: false });
          eq((await B('selftest.windowState')).onTop, false);
        });

        await check('window.commandAll', async () => {
          eq(await B('window.commandAll', { id: 'file.saveAll.item' }), 1, 'number of windows');
          eq(await waitEvent('command', (p) => p.id === 'file.saveAll.item'), { id: 'file.saveAll.item' });
          await rejects(B('window.commandAll', {}), 'missing id');
        });

        await check('window.setMagnification', async () => {
          eq(await B('window.setMagnification', { on: true }), true);
          eq((await B('selftest.windowChrome')).magnification, true);
          eq(await B('window.setMagnification', { on: false }), true);
          eq((await B('selftest.windowChrome')).magnification, false);
          await rejects(B('window.setMagnification', {}), 'missing on');
        });

        await check('window.setStyle', async () => {
          const initial = (await B('selftest.windowChrome')).style;
          eq(await B('window.setStyle', { style: 'classic' }), true);
          const classic = await B('selftest.windowChrome');
          eq([classic.style, classic.fullSize, classic.transparent, classic.titleHidden, classic.webViewFills], ['classic', false, false, false, true], 'classic');
          assert(classic.content[1] < classic.frame[1], 'classic: the title bar is outside the content view');

          // The top 38pt of the page drag the window, except where the page has something to click or type in.
          const band = document.createElement('div');
          let unibody, lights;
          band.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:80px;z-index:2147483647;cursor:default;background:#888';
          band.innerHTML = '<button style="position:absolute;left:0;top:0;width:100px;height:38px">b</button>'
            + '<span contenteditable style="position:absolute;left:100px;top:0;width:100px;height:38px">e</span>'
            + '<div data-no-drag style="position:absolute;left:200px;top:0;width:100px;height:38px">n</div>'
            + '<div style="position:absolute;left:300px;top:0;width:100px;height:38px;cursor:pointer">p</div>';
          document.documentElement.appendChild(band);
          try {
            eq(await B('window.setStyle', { style: 'unibody' }), true);
            unibody = await B('selftest.windowChrome');
            eq([unibody.style, unibody.fullSize, unibody.transparent, unibody.titleHidden, unibody.webViewFills], ['unibody', true, true, true, true], 'unibody');
            eq([unibody.frame, unibody.content], [classic.frame, classic.frame], 'unibody: same window frame, the page fills all of it');
            lights = unibody.trafficLights;
            assert(lights.left >= 0 && lights.top >= 0 && lights.bottom <= 38 && lights.right < 120, 'traffic lights are not inside the 38pt band: ' + JSON.stringify(lights));
            const probe = (x, y) => B('selftest.dragProbe', { x, y });
            eq([await probe(600, 10), await probe(600, 37)], [true, true], 'empty chrome in the band');
            eq([await probe(50, 10), await probe(150, 10), await probe(250, 10), await probe(350, 10)], [false, false, false, false], 'button / editable / data-no-drag / cursor:pointer');
            eq(await probe(600, 39), false, 'below the band');
            eq(await B('window.setStyle', { style: 'classic' }), true);
            eq(await probe(600, 10), false, 'classic has no drag band');
          } finally {
            band.remove();
            await B('window.setStyle', { style: 'classic' });
          }
          const back = await B('selftest.windowChrome');
          eq([back.style, back.fullSize, back.transparent, back.titleHidden, back.frame, back.content], ['classic', false, false, false, classic.frame, classic.content], 'back to classic');
          await rejects(B('window.setStyle', { style: 'glass' }), 'unknown style');
          if (initial !== 'classic') await B('window.setStyle', { style: initial });
          return `content ${classic.content.join('x')} -> ${unibody.content.join('x')}, traffic lights x ${lights.left}…${lights.right}, y ${lights.top}…${lights.bottom}; hit classic ${classic.hitTop}/${classic.hitClose}, unibody ${unibody.hitTop}/${unibody.hitClose}`;
        });

        await check('touchbar.set', async () => {
          const inline = ['strong', 'em', 'link', 'imageInsert'];
          const para = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'paragraph'];
          const lists = ['ul', 'ol', 'task', 'quote'];
          const want = {
            text: [...para, ...inline, ...lists, 'tableInsert'],
            list: [...para, 'outdent', 'indent', ...inline, ...lists],
            table: ['table-rowBelow', 'table-colAfter', 'table-rowDelete', 'table-colDelete', 'table-rowUp', 'table-rowDown', 'table-colLeft', 'table-colRight', 'table-tableDelete', ...inline],
            code: ['codeLang', 'codeJump', 'codeCopy', 'codeIndent', 'paraAfter'],
            image: ['imageAlt', 'imageSrc', 'imageDelete', ...inline],
            raw: ['rawDone', 'deleteBlock'],
            def: ['defJump', ...inline],
            selectable: ['paraAfter', 'deleteBlock'],
            find: ['findPrev', 'findNext', 'findCase', 'findWord', 'findReplaceMode', 'replaceNext'],
            source: ['source'],
            dialog: ['dialogCancel', 'dialogOK'],
            insertTable: ['tableRows', 'tableCols', 'dialogCancel', 'dialogOK'],
            none: [],
          };
          const kinds = { text: ['popover', 'space', 'segments', 'popover', 'button', 'candidates'], insertTable: ['stepper', 'stepper', 'space', 'button', 'button'], find: ['segments', 'toggle', 'toggle', 'space', 'toggle', 'button'] };
          const initial = (await B('selftest.touchBarDump')).mode;
          for (const [mode, ids] of Object.entries(want)) {
            eq(await B('touchbar.set', { mode }), true);
            const d = await B('selftest.touchBarDump');
            eq([d.mode, d.commands], [mode, ids], `commands of "${mode}"`);
            eq(d.items.flatMap((i) => i.built), ids, `controls actually built for "${mode}"`);
            eq(d.identifiers, d.items.map((i) => i.identifier), `item identifiers of "${mode}"`);
            assert(d.identifiers.every((i) => i.startsWith(`dev.livemark.touchbar.${mode}.`) || i === 'NSTouchBarItemIdentifierFlexibleSpace'), 'identifier prefix');
            if (kinds[mode]) eq(d.items.map((i) => i.kind), kinds[mode], `layout of "${mode}"`);
            eq(d.customizable, ['text', 'list', 'table', 'code', 'def', 'selectable'].includes(mode), `customizable "${mode}"`);
            if (d.customizable) eq(d.extras.length, 3, 'source / sidebar / new tab can be added');
            eq(d.onWebView, true, 'the web view (first responder) hands out this bar');
          }
          // The styles at the caret light up; find options show as on.
          await B('touchbar.set', { mode: 'text', state: { on: ['strong', 'link'] } });
          eq((await B('selftest.touchBarDump')).lit, ['link', 'strong'], 'lit inline styles');
          await B('touchbar.set', { mode: 'find', state: { on: ['findCase'] } });
          eq((await B('selftest.touchBarDump')).lit, ['findCase'], 'lit find option');
          await B('touchbar.set', { mode: 'def', state: { titles: { defJump: 'Link' } } });
          eq((await B('selftest.touchBarDump')).titles.defJump, 'Link', 'definition button title');
          await B('touchbar.set', { mode: 'insertTable', state: { values: { tableRows: 3, tableCols: 4 } } });
          eq((await B('selftest.touchBarDump')).values, { tableRows: 3, tableCols: 4 }, 'stepper values');
          eq(await B('selftest.touchBarTap', { id: 'tableRows' }), true, 'step rows');
          eq(await waitEvent('touchValue', (p) => p.id === 'tableRows'), { id: 'tableRows', value: 4 });
          // A tap is the same event as a menu item click: button, segment, and a button inside a popover.
          for (const [mode, id] of [['table', 'table-colAfter'], ['text', 'em'], ['text', 'h3'], ['table', 'table-colLeft'], ['source', 'source'], ['dialog', 'dialogOK']]) {
            await B('touchbar.set', { mode });
            eq(await B('selftest.touchBarTap', { id }), true, `tap ${id}`);
            eq(await waitEvent('command', (p) => p.id === id), { id });
          }
          eq(await B('selftest.touchBarTap', { id: 'strong' }), false, 'a control of another mode cannot be tapped');
          await rejects(B('touchbar.set', { mode: 'emoji' }), 'unknown mode');
          await B('touchbar.set', { mode: initial });
          return Object.entries(want).map(([mode, ids]) => `${mode} ${ids.length}`).join(', ');
        });

        await check('spell.info + spell.setLanguage', async () => {
          const s = await B('spell.info');
          assert(Array.isArray(s.languages) && s.languages.length > 0, 'no spelling languages');
          for (const l of s.languages) assert(typeof l.id === 'string' && l.id && typeof l.name === 'string' && l.name, 'language entry ' + JSON.stringify(l));
          assert(typeof s.current === 'string' && typeof s.auto === 'boolean', 'current / auto');
          // Select what is selected already: exercises the command and leaves the user's choice alone.
          if (s.auto || s.languages.some((l) => l.id === s.current)) {
            eq(await B('spell.setLanguage', { language: s.auto ? 'auto' : s.current }), true);
            const again = await B('spell.info');
            eq([again.auto, again.current], [s.auto, s.current], 'unchanged');
          }
          await rejects(B('spell.setLanguage', { language: 'xx_NOPE' }), 'unknown language');
          await rejects(B('spell.setLanguage', {}), 'missing language');
          const en = s.languages.find((l) => l.id.startsWith('en')) || s.languages[0];
          return `${s.languages.length} languages, e.g. ${en.id} = "${en.name}"; current ${s.current}, auto ${s.auto}`;
        });

        await check('settings.quitOnLastWindow', async () => {
          const before = await B('store.get', { key: 'settings' });
          const base = before && typeof before === 'object' ? before : {};
          try {
            await B('store.set', { key: 'settings', value: Object.assign({}, base, { quitOnLastWindow: undefined }) });
            eq(await B('selftest.quitOnLastWindow'), false, 'default');
            await B('store.set', { key: 'settings', value: Object.assign({}, base, { quitOnLastWindow: true }) });
            eq(await B('selftest.quitOnLastWindow'), true, 'settings.quitOnLastWindow = true');
            await B('store.set', { key: 'settings', value: Object.assign({}, base, { quitOnLastWindow: false }) });
            eq(await B('selftest.quitOnLastWindow'), false, 'settings.quitOnLastWindow = false');
          } finally {
            await B('store.set', { key: 'settings', value: before });
          }
        });

        await check('dialogs: TextBundle', async () => {
          const pick = tmp + '/pick';
          await B('fs.mkdir', { path: pick + '/note.textbundle' });
          await B('fs.mkdir', { path: pick + '/Plain Folder' });
          await B('fs.writeText', { path: pick + '/a.md', text: 'a' });
          await B('fs.writeText', { path: pick + '/NOTES.MARKDOWN', text: 'a' });
          await B('fs.copy', { from: pngPath, to: pick + '/b.png' });
          const paths = ['note.textbundle', 'Plain Folder', 'a.md', 'NOTES.MARKDOWN', 'b.png'].map((n) => pick + '/' + n);
          eq(await B('selftest.openPanelFilter', { extensions: ['md', 'markdown', 'textbundle'], paths }), [
            { enabled: true, choosable: true },   // the bundle can be chosen, package or plain directory
            { enabled: true, choosable: false },  // other folders can only be entered
            { enabled: true, choosable: true },
            { enabled: true, choosable: true },
            { enabled: false, choosable: false },
          ], 'what the open panel lets the user pick');
          // Panels never open in a headless run: these only prove the arguments are accepted.
          eq(await B('dialog.openFile', { extensions: ['md', 'textbundle'], multiple: true, directory: pick }), [], 'openFile');
          eq(await B('dialog.save', { extensions: ['textbundle'], suggestedName: 'Note' }), null, 'save');
          await rejects(B('dialog.openFile', { multiple: 'yes' }), 'non-boolean multiple');
        });

        await check('file.quickLook + net.download (arguments only)', async () => {
          eq(await B('file.quickLook', { path: pngPath }), true, 'quickLook (no panel in a headless run)');
          await rejects(B('file.quickLook', { path: tmp + '/nope.png' }), 'quickLook of a missing file');
          for (const url of ['file:///etc/hosts', 'ftp://example.com/a.png', 'livemark://fs/etc/hosts', 'not a url', 'https:///nohost']) {
            await rejects(B('net.download', { url, path: tmp + '/dl/x.bin' }), 'net.download ' + url);
          }
          await rejects(B('net.download', { url: 'https://example.com/a.png' }), 'net.download without a path');
          eq((await B('fs.stat', { path: tmp + '/dl/x.bin' })).exists, false, 'nothing was written');
        });

        await check('scheme app: index.html', async () => {
          const r = await fetch('livemark://app/index.html');
          eq(r.status, 200, 'status');
          const type = r.headers.get('content-type') || '';
          assert(type.startsWith('text/html'), 'content-type ' + type);
          eq(r.headers.get('cache-control'), 'no-store', 'cache-control');
          const body = await r.text();
          assert(body.toLowerCase().includes('<!doctype html'), 'not the index page');
          const root = await fetch('livemark://app/');
          eq([root.status, await root.text() === body], [200, true], 'livemark://app/ serves index.html');
          return type;
        });

        await check('scheme app: content types + 404', async () => {
          const seen = [], absent = [];
          for (const el of document.querySelectorAll('script[src], link[rel=stylesheet][href]')) {
            const url = el.src || el.href;
            if (!url.startsWith('livemark://app/')) continue;
            const rel = decodeURIComponent(new URL(url).pathname);
            const onDisk = (await B('fs.stat', { path: webRoot + rel })).exists;
            const r = await fetch(url);
            eq(r.status, onDisk ? 200 : 404, url);
            if (!onDisk) { absent.push(rel); continue; } // referenced by the page but not in the web root (not a shell problem)
            const type = r.headers.get('content-type') || '';
            assert(type.startsWith(el.tagName === 'SCRIPT' ? 'text/javascript' : 'text/css'), `${url}: ${type}`);
            seen.push(rel.slice(1) + ' ' + type.split(';')[0]);
          }
          for (const [rel, want] of [['/welcome.md', 'text/markdown'], ['/package.json', 'application/json']]) {
            if (!(await B('fs.stat', { path: webRoot + rel })).exists) continue;
            const type = (await fetch('livemark://app' + rel)).headers.get('content-type') || '';
            assert(type.startsWith(want), `${rel}: ${type}`);
            seen.push(rel.slice(1) + ' ' + type.split(';')[0]);
          }
          eq((await fetch('livemark://app/definitely/not/here.js')).status, 404, 'missing file');
          return seen.join(', ') + (absent.length ? `; referenced by the page but missing on disk (404): ${absent.join(', ')}` : '');
        });

        await check('scheme fs: local files', async () => {
          const r = await fetch('livemark://fs/' + encodeURIComponent(file));
          eq([r.status, await r.text()], [200, text], 'percent-encoded path');
          assert((r.headers.get('content-type') || '').startsWith('text/markdown'), 'content-type ' + r.headers.get('content-type'));
          eq((await fetch('livemark://fs' + encodeURI(file))).status, 200, 'path with plain slashes');
          eq((await fetch('livemark://fs/' + encodeURIComponent(tmp + '/missing.png'))).status, 404, 'missing file');
          eq((await fetch('livemark://fs/' + encodeURIComponent(tmp))).status, 404, 'directory');
          const img = await loadImage('livemark://fs/' + encodeURIComponent(pngPath));
          eq([img.naturalWidth, img.naturalHeight], [1, 1], '<img> from livemark://fs');
        });

        await check('scheme app: path traversal is rejected', async () => {
          eq((await fetch('livemark://fs/etc/hosts')).status, 200, 'probe target must exist');
          const up = (n, sep) => Array(n).fill('..').join(sep);
          const probes = [
            'livemark://app/' + up(12, '%2f') + '%2fetc%2fhosts',
            'livemark://app/' + up(12, '%2F') + '%2Fetc%2Fhosts',
            'livemark://app/styles/' + up(13, '%2f') + '%2fetc%2fhosts',
            'livemark://app/' + up(12, '/') + '/etc/hosts',
            'livemark://app/' + Array(12).fill('%2e%2e').join('/') + '/etc/hosts',
            'livemark://app/..%2f..%2fInfo.plist',
            'livemark://app/%2e%2e%2f%2e%2e%2fInfo.plist',
            'livemark://app//etc/hosts',
          ];
          const statuses = [];
          for (const url of probes) {
            let status;
            try {
              const r = await fetch(url);
              status = r.status;
              assert(!r.ok, `${url} was served (${r.status})`);
            } catch (e) {
              if (/was served/.test(e.message)) throw e;
              status = 'blocked';
            }
            statuses.push(status);
          }
          return 'statuses ' + statuses.join(' ');
        });

        await check('pandoc.run', async () => {
          if (!info.pandoc) return 'skipped: pandoc is not installed';
          const v = await B('pandoc.run', { args: ['--version'] });
          eq(v.code, 0, 'exit code');
          assert(v.stdout.startsWith('pandoc'), v.stdout.slice(0, 60));
          const html = await B('pandoc.run', { args: ['-f', 'markdown', '-t', 'html'], stdin: '# 标题 Title\n\nBody *text*.\n', cwd: tmp });
          eq(html.code, 0, 'conversion exit code');
          assert(html.stdout.includes('<h1') && html.stdout.includes('标题') && html.stdout.includes('<em>text</em>'), html.stdout);
          const bad = await B('pandoc.run', { args: ['--no-such-option'] });
          assert(bad.code !== 0 && bad.stderr.length > 0, 'an invalid option should exit non-zero with stderr');
          await rejects(B('pandoc.run', { args: 'not-an-array' }), 'non-array args');
          return v.stdout.split('\n')[0];
        });

        // The page content is not ours, so print a marker of our own: text, a background, and @media print/screen rules.
        const pdfCheck = async (path, args, wantW, wantH) => {
          const marker = document.createElement('div');
          marker.id = 'lm-selftest-pdf';
          marker.textContent = 'LIVEMARK-PDF-MARKER 中文';
          marker.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483647;width:480px;height:120px;white-space:nowrap;background:#00ff00;color:#000;font:14px sans-serif';
          const style = document.createElement('style');
          style.textContent = '@media print { #lm-selftest-pdf::after { content: " PRINT-MEDIA"; } } @media screen { #lm-selftest-pdf::after { content: " SCREEN-MEDIA"; } }';
          document.documentElement.append(style, marker);
          try {
            eq(await B('export.pdf', Object.assign({ path }, args)), true);
          } finally {
            marker.remove();
            style.remove();
          }
          const st = await B('fs.stat', { path });
          assert(st.exists && st.size > 0, 'PDF missing or empty');
          const head = atob((await B('fs.readBase64', { path })).base64.slice(0, 8));
          assert(head.startsWith('%PDF'), 'not a PDF: ' + head);
          const pdf = await B('selftest.pdfInfo', { path });
          assert(pdf.pages >= 1, 'no pages');
          assert(Math.abs(pdf.width - wantW) < 2 && Math.abs(pdf.height - wantH) < 2, `page is ${pdf.width}x${pdf.height}pt, want ${wantW}x${wantH}`);
          // PDF text extraction returns compatibility forms for some CJK glyphs and breaks lines: normalize both away.
          const pdfText = pdf.text.normalize('NFKC').replace(/\s+/g, '');
          assert(pdfText.includes('LIVEMARK-PDF-MARKER中文'), 'marker text is not in the PDF: ' + JSON.stringify(pdf.text.slice(0, 200)));
          assert(pdfText.includes('PRINT-MEDIA') && !pdfText.includes('SCREEN-MEDIA'), '@media print was not applied: ' + JSON.stringify(pdf.text.slice(0, 200)));
          assert(pdf.greenPixels > 1000, `CSS backgrounds were not printed (${pdf.greenPixels} marker pixels)`);
          return `${st.size} bytes, ${pdf.pages} page(s), ${pdf.width}x${pdf.height}pt, @media print applied, backgrounds printed`;
        };
        await check('export.pdf (A4)', () => pdfCheck(tmp + '/out/a4.pdf', { paper: 'A4' }, 595, 842));
        await check('export.pdf (Letter landscape, margin 54)', () => pdfCheck(tmp + '/out/letter.pdf', { paper: 'Letter', landscape: true, margin: 54 }, 792, 612));
        await check('export.pdf (A3, A5, Legal, Tabloid, custom size)', async () => {
          const sizes = { A3: [842, 1191], A5: [420, 595], Legal: [612, 1008], Tabloid: [792, 1224] };
          const seen = [];
          for (const [paper, [w, h]] of [...Object.entries(sizes), [{ width: 500, height: 333 }, [500, 333]]]) {
            const path = tmp + '/out/paper-' + seen.length + '.pdf';
            eq(await B('export.pdf', { path, paper, margins: { top: 20, left: 20 } }), true);
            const pdf = await B('selftest.pdfInfo', { path });
            assert(Math.abs(pdf.width - w) < 2 && Math.abs(pdf.height - h) < 2, `${JSON.stringify(paper)}: page is ${pdf.width}x${pdf.height}pt, want ${w}x${h}`);
            seen.push(`${pdf.width}x${pdf.height}`);
          }
          return seen.join(', ');
        });

        await check('export.pdf (margins, header/footer, outline)', async () => {
          // A document of our own with forced page breaks; everything else on the page is hidden for printing.
          const doc = document.createElement('div');
          doc.id = 'lm-selftest-doc';
          doc.innerHTML = '<h1>Alpha Chapter</h1><p>Opening words with a <a href="https://example.com/livemark">link</a>.</p>'
            + '<h2 style="break-before:page">Beta Section 标题</h2><p>This paragraph mentions Gamma Chapter before it starts.</p>'
            + '<h1 style="break-before:page">Gamma Chapter</h1><p>Closing words.</p><h3>Delta Detail</h3><p>The end.</p>';
          const style = document.createElement('style');
          style.textContent = '@media print { html, body { height: auto !important; overflow: visible !important; display: block !important; position: static !important; }'
            + ' body > *:not(#lm-selftest-doc) { display: none !important; } #lm-selftest-doc { display: block !important; font: 12px sans-serif; color: #000; } }'
            + ' @media screen { #lm-selftest-doc { display: none; } }';
          document.head.appendChild(style);
          document.body.appendChild(doc);
          const path = tmp + '/out/decorated.pdf';
          const margins = { top: 60, right: 30, bottom: 50, left: 40 };
          const outline = [
            { level: 1, text: 'Alpha Chapter' }, { level: 2, text: 'Beta  Section\n标题' }, { level: 2, text: 'Not In The Document' },
            { level: 1, text: 'Gamma Chapter' }, { level: 3, text: 'Delta Detail' },
          ];
          try {
            eq(await B('export.pdf', { path, paper: 'A5', margin: 10, margins, header: 'LM-HEAD ${pageNo}/${totalPages}', footer: 'LM-FOOT ${pageNo} of ${totalPages}', outline }), true);
          } finally {
            doc.remove();
            style.remove();
          }
          const pdf = await B('selftest.pdfInfo', { path, find: 'LM-HEAD' });
          const feet = (await B('selftest.pdfInfo', { path, find: 'LM-FOOT' })).found;
          assert(Math.abs(pdf.width - 420) < 2 && Math.abs(pdf.height - 595) < 2, `page is ${pdf.width}x${pdf.height}pt, want 420x595`);
          const flat = pdf.pageTexts.map((t) => t.normalize('NFKC').replace(/\s+/g, ''));
          assert(pdf.pages >= 3, `expected the forced page breaks to give 3 pages, got ${pdf.pages}`);
          flat.forEach((t, i) => {
            assert(t.includes(`LM-HEAD${i + 1}/${pdf.pages}`), `page ${i + 1} has no header: ${JSON.stringify(pdf.pageTexts[i].slice(0, 120))}`);
            assert(t.includes(`LM-FOOT${i + 1}of${pdf.pages}`), `page ${i + 1} has no footer`);
          });
          // Centred between the side margins, in the middle of the top / bottom margin.
          eq([pdf.found.length, feet.length], [pdf.pages, pdf.pages], 'one header and one footer per page');
          for (const hit of pdf.found) assert(Math.abs(hit.y - (595 - margins.top / 2)) < 5, 'header position ' + JSON.stringify(hit));
          for (const hit of feet) assert(Math.abs(hit.y - margins.bottom / 2) < 5, 'footer position ' + JSON.stringify(hit));
          const centre = margins.left + (420 - margins.left - margins.right) / 2;
          for (const line of [`LM-HEAD 2/${pdf.pages}`, `LM-FOOT 2 of ${pdf.pages}`]) {
            const whole = (await B('selftest.pdfInfo', { path, find: line })).found;
            assert(whole.length === 1 && whole[0].page === 1 && Math.abs(whole[0].x - centre) < 3, `"${line}" is not centred at x ${centre}: ${JSON.stringify(whole)}`);
          }
          // The margins themselves: the first line of body text starts below the top margin and right of the left one.
          const body = (await B('selftest.pdfInfo', { path, find: 'Opening words' })).found[0];
          assert(body && body.page === 0 && body.y < 595 - margins.top && body.y > 595 - margins.top - 120 && body.x > margins.left, 'body text position ' + JSON.stringify(body));
          // Bookmarks: nested by level, each on the page of its heading (not where a paragraph mentions it); the missing one is skipped.
          eq(pdf.outline.map((o) => [o.depth, o.label, o.page]), [[1, 'Alpha Chapter', 0], [2, 'Beta Section 标题', 1], [1, 'Gamma Chapter', 2], [2, 'Delta Detail', 2]], 'outline');
          const ys = pdf.outline.map((o) => o.y);
          assert(ys.every((y) => y > 0 && y <= 595) && ys[3] < ys[2], 'bookmark positions ' + ys);
          assert(pdf.links >= 1, 'the link annotation was lost');
          assert(flat[0].includes('AlphaChapter') && flat[2].includes('Closingwords'), 'page text is still text');
          return `${pdf.pages} pages, header at y ${Math.round(pdf.found[0].y)}, footer at y ${Math.round(feet[0].y)}, ${pdf.outline.length} bookmarks, ${pdf.links} link(s)`;
        });

        await check('export.pdf (bad args)', async () => {
          await rejects(B('export.pdf', { path: tmp + '/out/x.pdf', paper: 'B5' }), 'unknown paper');
          await rejects(B('export.pdf', { path: tmp + '/out/x.pdf', paper: { width: 10, height: 500 } }), 'tiny custom paper');
          await rejects(B('export.pdf', { path: tmp + '/out/x.pdf', paper: 42 }), 'numeric paper');
          await rejects(B('export.pdf', { path: tmp + '/out/x.pdf', paper: 'A5', margins: { left: 300, right: 300 } }), 'margins wider than the page');
          await rejects(B('export.pdf', { path: tmp + '/out/x.pdf', margins: 20 }), 'non-object margins');
          await rejects(B('export.pdf', { path: tmp + '/out/x.pdf', outline: 'h1' }), 'non-array outline');
          await rejects(B('export.pdf', { path: tmp + '/out/x.pdf', outline: [{ level: 'one', text: 'x' }] }), 'bad outline entry');
          await rejects(B('export.pdf', { path: tmp + '/out/x.pdf', header: 7 }), 'non-string header');
          await rejects(B('export.pdf', {}), 'missing path');
          eq((await B('fs.stat', { path: tmp + '/out/x.pdf' })).exists, false, 'nothing was written');
        });

        await check('export.image', async () => {
          const path = tmp + '/out/document.png';
          const W = 640, H = 4500; // taller than one snapshot band, so stitching is exercised
          const before = [window.innerWidth, window.innerHeight];
          const strip = (css) => {
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;left:0;width:100%;height:40px;z-index:2147483647;' + css;
            document.documentElement.appendChild(el);
            return el;
          };
          const marks = [strip('top:0;background:#ff0000'), strip('bottom:0;background:#0000ff')];
          try {
            eq(await B('export.image', { path, width: W, height: H }), true);
          } finally {
            marks.forEach((el) => el.remove());
          }
          const st = await B('fs.stat', { path });
          assert(st.exists && st.size > 0, 'PNG missing or empty');
          const img = await loadImage('livemark://fs/' + encodeURIComponent(path), true);
          const k = img.naturalWidth / W;
          assert([1, 2, 3].includes(k), `unexpected pixel width ${img.naturalWidth}`);
          eq(img.naturalHeight, H * k, 'pixel height');
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
          const top = px(20 * k, 20 * k), bottom = px(20 * k, img.naturalHeight - 20 * k), middle = px(20 * k, Math.round(img.naturalHeight / 2));
          assert(top[0] > 200 && top[2] < 80, 'top of the image should be the red marker, got ' + top);
          assert(bottom[2] > 200 && bottom[0] < 80, 'bottom of the image should be the blue marker, got ' + bottom);
          eq(middle[3], 255, 'image must be opaque');
          for (let i = 0; i < 40 && (window.innerWidth !== before[0] || window.innerHeight !== before[1]); i++) await new Promise((r) => setTimeout(r, 50));
          eq([window.innerWidth, window.innerHeight], before, 'web view size restored');
          await rejects(B('export.image', { path, width: 0, height: 10 }), 'zero width');
          return `${img.naturalWidth}x${img.naturalHeight}px (${k}x), ${st.size} bytes`;
        });

        await check('export.image (jpeg)', async () => {
          const W = 400, H = 300;
          const mark = document.createElement('div');
          mark.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;background:linear-gradient(90deg,#ff0000,#0000ff)';
          document.documentElement.appendChild(mark);
          const sizes = {};
          try {
            for (const [name, args] of Object.entries({ high: { format: 'jpeg', quality: 1 }, low: { format: 'jpeg', quality: 0.1 }, plain: { format: 'jpeg' }, png: { format: 'png' } })) {
              const path = `${tmp}/out/shot-${name}.${args.format === 'png' ? 'png' : 'jpg'}`;
              eq(await B('export.image', Object.assign({ path, width: W, height: H, scale: 1 }, args)), true);
              const head = atob((await B('fs.readBase64', { path })).base64.slice(0, 8));
              const isJpeg = head.charCodeAt(0) === 0xFF && head.charCodeAt(1) === 0xD8;
              eq(isJpeg, args.format === 'jpeg', `${name}: file signature`);
              const img = await loadImage('livemark://fs/' + encodeURIComponent(path), true);
              eq([img.naturalWidth, img.naturalHeight], [W, H], `${name}: pixel size`);
              sizes[name] = (await B('fs.stat', { path })).size;
              if (name === 'low') {
                const canvas = document.createElement('canvas');
                canvas.width = W; canvas.height = H;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const left = ctx.getImageData(5, 150, 1, 1).data, right = ctx.getImageData(W - 5, 150, 1, 1).data;
                assert(left[0] > 180 && left[2] < 90 && right[2] > 180 && right[0] < 90, `colours are off: ${Array.from(left)} / ${Array.from(right)}`);
              }
            }
          } finally {
            mark.remove();
          }
          assert(sizes.low < sizes.plain && sizes.plain < sizes.high, `quality does not change the file size: ${JSON.stringify(sizes)}`);
          await rejects(B('export.image', { path: tmp + '/out/x.gif', width: W, height: H, format: 'gif' }), 'unknown format');
          await rejects(B('export.image', { path: tmp + '/out/x.jpg', width: W, height: H, format: 'jpeg', quality: 2 }), 'quality out of range');
          return `quality 0.1 / default / 1: ${sizes.low} / ${sizes.plain} / ${sizes.high} bytes (png ${sizes.png})`;
        });

        return out;
        """#
}
