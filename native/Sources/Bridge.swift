import Cocoa
import WebKit
import UniformTypeIdentifiers

/// The voice behind Edit → Speech, shared by all windows.
private let sharedSpeech = NSSpeechSynthesizer()

/// Receives `window.webkit.messageHandlers.livemark.postMessage({ cmd, args })` and answers the returned promise.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "livemark"

    weak var controller: WindowController?
    /// When the page last called the bridge (selftest waits for the web app's start-up traffic to settle).
    var lastMessage = Date()
    private let ioQueue = DispatchQueue(label: "dev.livemark.io", qos: .userInitiated, attributes: .concurrent)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let controller = controller else { return replyHandler(nil, "the window is closing") }
        lastMessage = Date()
        let windowId = controller.id
        let reply = Reply { value, error in
            if let error = error { Log.debug("window \(windowId): \((message.body as? [String: Any])?["cmd"] as? String ?? "?") failed: \(error)") }
            replyHandler(value, error)
        }

        // Message handlers are visible to every frame; only the app page itself may use the bridge.
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == SchemeHandler.scheme, origin.host == SchemeHandler.appHost else {
            return reply.fail("the bridge is only available to the app page")
        }
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            return reply.fail("expected a message of the form { cmd: string, args?: object }")
        }
        let rawArgs = body["args"] ?? NSNull()
        guard rawArgs is NSNull || rawArgs is [String: Any] else { return reply.fail("\(cmd): \"args\" must be an object") }
        let args = Args(cmd: cmd, dict: rawArgs as? [String: Any] ?? [:])

        do {
            if let work = try FileCommands.make(cmd, args) {
                ioQueue.async {
                    do { reply.ok(try work()) } catch { reply.fail(Self.message(cmd, error)) }
                }
            } else if try !controller.run(cmd, args, reply) {
                reply.fail("unknown command \"\(cmd)\"")
            }
        } catch {
            reply.fail(Self.message(cmd, error))
        }
    }

    private static func message(_ cmd: String, _ error: Error) -> String {
        let text = describe(error)
        return text.hasPrefix(cmd) ? text : "\(cmd): \(text)"
    }
}

// MARK: - Commands that need the main thread / the window

extension WindowController {
    /// Runs a UI command. Returns false if `cmd` is unknown. Throws for invalid arguments.
    func run(_ cmd: String, _ a: Args, _ reply: Reply) throws -> Bool {
        switch cmd {
        case "app.ready":
            reply.ok([
                "openPath": openPath as Any? ?? NSNull(),
                "home": AppPaths.home,
                "appSupport": AppPaths.appSupport,
                "documents": AppPaths.documents,
                "pandoc": AppPaths.pandoc as Any? ?? NSNull(),
                "version": AppPaths.version,
                "windowId": id,
                "dark": NSApp.effectiveAppearance.isDark,
                "fullscreen": window.styleMask.contains(.fullScreen),
            ] as [String: Any])
            markReady()

        case "debug.log" where Log.enabled:
            let message = try a.string("message")
            Log.debug("window \(id) page: \(message)")
            reply.ok()

        // MARK: dialogs
        case "dialog.openFile":
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = try a.bool("multiple", default: false)
            let extensions = Self.normalized(try a.stringArray("extensions"))
            let guide: BundleAwareOpenPanel?
            let folders = try a.bool("folders", default: false)
            if extensions.contains(BundleAwareOpenPanel.bundleExtension) || folders {
                // A TextBundle is a folder. Where no app has registered it as a package it is a plain directory, so
                // the panel may choose directories and a delegate narrows that down to `*.textbundle`.
                guide = BundleAwareOpenPanel(extensions: extensions, types: Self.contentTypes(extensions), foldersToo: folders)
                panel.delegate = guide
                panel.canChooseDirectories = true
                panel.treatsFilePackagesAsDirectories = false
            } else {
                guide = nil
                panel.allowedContentTypes = Self.contentTypes(extensions)
            }
            if let directory = try a.optPath("directory") { panel.directoryURL = URL(fileURLWithPath: directory, isDirectory: true) }
            // Optional "File Format" pop-up: [[name, [extensions]], …] plus its two labels.
            var accessory: FormatAccessory?
            if let raw = a.dict["formats"] as? [[Any]], !raw.isEmpty {
                let formats = raw.compactMap { pair -> (name: String, extensions: [String])? in
                    guard pair.count == 2, let name = pair[0] as? String, let exts = pair[1] as? [String] else { return nil }
                    return (name, Self.normalized(exts))
                }
                accessory = FormatAccessory(panel: panel, guide: guide, all: extensions, formats: formats, labels: a.dict["formatLabels"] as? [String: String] ?? [:])
            }
            present(panel) { chosen in
                _ = guide // the panel does not retain its delegate
                _ = accessory
                reply.ok(chosen ? panel.urls.map { $0.path } : [String]())
            }

        case "dialog.openFolder":
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            if let directory = try a.optPath("directory") { panel.directoryURL = URL(fileURLWithPath: directory, isDirectory: true) }
            present(panel) { reply.ok($0 ? (panel.url?.path as Any? ?? NSNull()) : NSNull()) }

        case "dialog.save":
            let panel = NSSavePanel()
            panel.canCreateDirectories = true
            panel.isExtensionHidden = false
            if let name = try a.optString("suggestedName") { panel.nameFieldStringValue = name }
            if let directory = try a.optPath("directory") { panel.directoryURL = URL(fileURLWithPath: directory, isDirectory: true) }
            panel.allowedContentTypes = Self.contentTypes(Self.normalized(try a.stringArray("extensions")))
            panel.allowsOtherFileTypes = true
            // "File Format:" under the panel: picking one sets the name's extension.
            var accessory: SaveFormatAccessory?
            if let formats = a.dict["formats"] as? [[String: Any]], !formats.isEmpty {
                let list = formats.compactMap { f -> (name: String, ext: String)? in
                    guard let name = f["name"] as? String, let ext = f["ext"] as? String else { return nil }
                    return (name, ext)
                }
                accessory = SaveFormatAccessory(panel: panel, formats: list, label: try a.optString("formatLabel") ?? "File Format:")
            }
            present(panel) { ok in
                withExtendedLifetime(accessory) { reply.ok(ok ? (panel.url?.path as Any? ?? NSNull()) : NSNull()) }
            }

        case "dialog.message":
            let message = try a.string("message")
            let buttons = try a.stringArray("buttons") ?? []
            let style: NSAlert.Style
            switch try a.optString("style") ?? "info" {
            case "info": style = .informational
            case "warning": style = .warning
            case "critical": style = .critical
            default: throw BridgeError("\(cmd): \"style\" must be \"info\", \"warning\" or \"critical\"")
            }
            let cancel = try a.number("cancel").map { Int($0) }
            var suppressed = false
            presentAlert(message: message, detail: try a.optString("detail"), buttons: buttons.isEmpty ? ["OK"] : buttons,
                         style: style, cancelIndex: cancel, defaultIndex: try a.number("default").map { Int($0) }, suppression: try a.optString("checkbox"), checked: { suppressed = $0 }) {
                reply.ok(["index": $0, "checked": suppressed])
            }

        // MARK: shell
        case "fs.reveal":
            let path = try a.path("path")
            guard FileManager.default.fileExists(atPath: path) else { throw BridgeError("\(cmd): \"\(path)\" does not exist") }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            reply.ok()

        case "shell.quickLook":
            // Quick Look of a file the editor will not render (it is too large).
            let path = try a.path("path")
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage")
            task.arguments = ["-p", path]
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
            try task.run()
            reply.ok()

        case "shell.openExternal":
            let raw = try a.string("url")
            guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else {
                throw BridgeError("\(cmd): only http, https and mailto URLs can be opened")
            }
            guard NSWorkspace.shared.open(url) else { throw BridgeError("\(cmd): no application could open the URL") }
            reply.ok()

        case "shell.openURL":
            // A link with another app's scheme (zotero:, obsidian:, ftp:…); never file: or script URLs.
            let raw = try a.string("url")
            guard let url = URL(string: raw) ?? URL(string: raw.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""),
                  let scheme = url.scheme?.lowercased(), !["file", "javascript", "vbscript", "data"].contains(scheme) else {
                throw BridgeError("\(cmd): this URL cannot be opened")
            }
            guard NSWorkspace.shared.urlForApplication(toOpen: url) != nil, NSWorkspace.shared.open(url) else {
                throw BridgeError("\(cmd): no application can open \(scheme): links")
            }
            reply.ok()

        case "shell.openPath":
            let path = try a.path("path")
            guard FileManager.default.fileExists(atPath: path) else { throw BridgeError("\(cmd): \"\(path)\" does not exist") }
            guard NSWorkspace.shared.open(URL(fileURLWithPath: path)) else { throw BridgeError("\(cmd): no application could open the file") }
            reply.ok()

        case "shell.applicationsForFile":
            // The file preview's "Open in …" button and its list of other apps.
            let path = try a.path("path")
            let url = URL(fileURLWithPath: path)
            let workspace = NSWorkspace.shared
            func describe(_ app: URL) -> [String: Any] {
                let icon = workspace.icon(forFile: app.path)
                icon.size = NSSize(width: 16, height: 16)
                var png = ""
                if let tiff = icon.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let data = rep.representation(using: .png, properties: [:]) {
                    png = "data:image/png;base64," + data.base64EncodedString()
                }
                let name = FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: "")
                return ["name": name, "url": app.path, "icon": png]
            }
            let defaultApp = workspace.urlForApplication(toOpen: url)
            var seen = Set<String>()
            let apps = workspace.urlsForApplications(toOpen: url).filter { seen.insert($0.path).inserted }.prefix(20).map(describe)
            reply.ok(["defaultApp": defaultApp.map(describe) as Any? ?? NSNull(), "apps": Array(apps)] as [String: Any])

        case "shell.openWithApplication":
            let path = try a.path("path"), app = try a.path("app")
            guard FileManager.default.fileExists(atPath: path) else { throw BridgeError("\(cmd): \"\(path)\" does not exist") }
            let config = NSWorkspace.OpenConfiguration()
            NSWorkspace.shared.open([URL(fileURLWithPath: path)], withApplicationAt: URL(fileURLWithPath: app), configuration: config) { _, error in
                DispatchQueue.main.async { if let error = error { reply.fail(error.localizedDescription) } else { reply.ok() } }
            }

        // MARK: clipboard
        case "clipboard.write":
            let text = try a.optString("text"), html = try a.optString("html")
            guard text != nil || html != nil else { throw BridgeError("\(cmd): pass \"text\" and/or \"html\"") }
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            if let html = html {
                pasteboard.setString(html, forType: .html)
                // Apps that prefer a Web Archive (Mail, TextEdit, Pages) get one too.
                let resource: [String: Any] = ["WebResourceData": Data(html.utf8), "WebResourceMIMEType": "text/html", "WebResourceTextEncodingName": "UTF-8", "WebResourceURL": "about:blank", "WebResourceFrameName": ""]
                if let archive = try? PropertyListSerialization.data(fromPropertyList: ["WebMainResource": resource], format: .binary, options: 0) {
                    pasteboard.setData(archive, forType: NSPasteboard.PasteboardType("com.apple.webarchive"))
                }
            }
            if let text = text { pasteboard.setString(text, forType: .string) }
            reply.ok()

        case "clipboard.writeImage":
            // "Copy Image Content": the picture itself, so it can be pasted into other apps.
            let path = try a.path("path")
            guard let image = NSImage(contentsOfFile: path) else { throw BridgeError("\(cmd): not an image: \(path)") }
            let board = NSPasteboard.general
            board.clearContents()
            reply.ok(board.writeObjects([image]))

        case "clipboard.writeSnapshot":
            // "Copy as Image": a bitmap of one rectangle of the page (math, a diagram).
            guard let x = try a.number("x"), let y = try a.number("y"), let width = try a.number("width"), let height = try a.number("height") else { throw BridgeError("\(cmd): \"x\", \"y\", \"width\" and \"height\" are required") }
            guard width >= 1, height >= 1, width <= 16_384, height <= 16_384 else { throw BridgeError("\(cmd): the rectangle is out of range") }
            let configuration = WKSnapshotConfiguration()
            configuration.rect = CGRect(x: x, y: y, width: width, height: height)
            configuration.snapshotWidth = NSNumber(value: width * 2) // crisp on any screen
            // With "path" the bitmap is saved there as a PNG ("Save Math As…") instead.
            let target = try a.optPath("path")
            webView.takeSnapshot(with: configuration) { image, error in
                guard let image = image else { return reply.fail("\(cmd): \(error?.localizedDescription ?? "the snapshot failed")") }
                if let target {
                    let jpeg = ["jpg", "jpeg"].contains((target as NSString).pathExtension.lowercased())
                    guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                          let data = rep.representation(using: jpeg ? .jpeg : .png, properties: jpeg ? [.compressionFactor: 0.92] : [:]) else {
                        return reply.fail("\(cmd): the image could not be encoded")
                    }
                    do { try data.write(to: URL(fileURLWithPath: target)); reply.ok(true) } catch { reply.fail("\(cmd): \(error.localizedDescription)") }
                    return
                }
                let board = NSPasteboard.general
                board.clearContents()
                reply.ok(board.writeObjects([image]))
            }

        case "clipboard.read":
            reply.ok(Self.readClipboard())

        // MARK: window
        case "window.setTitle":
            window.title = try a.string("title")
            if a.dict["path"] != nil { // present: a string sets the document, null clears it
                let path = try a.optPath("path")
                currentPath = path
                window.representedURL = path.map { URL(fileURLWithPath: $0) }
            }
            if a.has("dirty") {
                dirty = try a.bool("dirty", default: false)
                window.isDocumentEdited = dirty
            }
            reply.ok()

        case "window.focus":
            reply.ok()
            if !headless { window.makeKeyAndOrderFront(nil) }

        case "window.new":
            let path = try a.optPath("path")
            reply.ok()
            // A document is open in one window only: one that has it already comes forward.
            if let path = path, focusWindow(showing: path, besides: nil) { break }
            app?.newWindow(openPath: path)

        case "window.newTab":
            let path = try a.optPath("path")
            reply.ok()
            if let path = path, focusWindow(showing: path, besides: nil) { break }
            app?.newWindow(openPath: path, tabOf: window)

        case "window.focusPath":
            // Another window already showing this document comes forward instead of a second copy.
            reply.ok(["found": focusWindow(showing: try a.path("path"), besides: self)])

        case "window.closeAll":
            reply.ok()
            DispatchQueue.main.async { [weak self] in
                // Every page gets to save or veto, exactly as with the red button.
                self?.app?.controllers.forEach { $0.requestClose() }
            }

        case "share.show":
            // The system share sheet for the document (or a piece of text).
            var items: [Any] = []
            if let path = try a.optPath("path") { items.append(URL(fileURLWithPath: path)) }
            if let text = a.dict["text"] as? String, !text.isEmpty { items.append(text) }
            guard !items.isEmpty, let view = window.contentView else { reply.ok(false); break }
            reply.ok()
            let picker = NSSharingServicePicker(items: items)
            picker.show(relativeTo: NSRect(x: view.bounds.midX, y: view.bounds.maxY - 1, width: 1, height: 1), of: view, preferredEdge: .minY)

        case "export.pageSetup":
            reply.ok()
            NSApp.runPageLayout(nil)

        case "window.close":
            let force = try a.bool("force", default: false)
            reply.ok()
            // Let the reply reach the page before the web view goes away.
            DispatchQueue.main.async { [weak self] in
                if force { self?.closeNow() } else { self?.requestClose() }
            }

        case "window.startDrag":
            // The message arrives after the mouse-down that triggered it; drag only while the button is still held.
            // (In the unibody style the shell may already be dragging for this very mouse-down.)
            guard NSEvent.pressedMouseButtons & 1 == 1, let event = window.lastMouseDown, claimTitlebarEvent(event) else { reply.ok(false); break }
            reply.ok()
            window.performDrag(with: event)

        case "fs.startDrag":
            // Sidebar → Finder (or a folder in the sidebar): a system drag of the file, only while the button is held.
            let path = try a.string("path")
            guard NSEvent.pressedMouseButtons & 1 == 1 else { reply.ok(false); break }
            let started = webView.startFileDrag(path) { [weak self] in self?.emit("fileDragEnded") }
            reply.ok(started)

        case "window.titlebarDoubleClick":
            // Not twice for one double click, should the unibody drag strip have answered it already.
            if let event = window.lastMouseDown, event.clickCount >= 2, !claimTitlebarEvent(event) { reply.ok(); break }
            performTitlebarDoubleClick()
            reply.ok()

        case "window.setAlwaysOnTop":
            guard a.has("on") else { throw BridgeError("\(cmd): \"on\" must be a boolean") }
            window.level = try a.bool("on", default: false) ? .floating : .normal
            reply.ok()

        case "speech.start":
            // Edit → Speech → Start Speaking: one app-wide voice, as Typora does.
            let text = try a.string("text")
            sharedSpeech.stopSpeaking()
            if !text.isEmpty { sharedSpeech.startSpeaking(text) }
            reply.ok()

        case "speech.stop":
            sharedSpeech.stopSpeaking()
            reply.ok()

        case "window.setZoom":
            // Settings → Appearance → Zoom and View → Zoom: scales the whole page, like a browser zoom.
            guard let zoom = try a.number("zoom"), zoom >= 0.25, zoom <= 5 else { throw BridgeError("\(cmd): \"zoom\" must be a number from 0.25 to 5") }
            webView.pageZoom = CGFloat(zoom)
            reply.ok()

        case "window.toggleFullScreen":
            window.toggleFullScreen(nil)
            reply.ok()

        // MARK: menus
        case "menu.set":
            guard let menus = a.dict["menus"] as? [Any], !menus.isEmpty else { throw BridgeError("\(cmd): \"menus\" must be a non-empty array") }
            let manager = MenuManager.shared
            if manager.owner == nil || manager.owner === self || window.isMainWindow {
                try manager.install(spec: menus, overrides: [:], owner: self)
            } else {
                // Another window owns the menu bar; validate now, install when this window becomes main.
                _ = try MenuBuilder(commandTarget: manager, commandAction: #selector(MenuManager.menuCommand(_:))).mainMenu(menus)
            }
            menuSpec = menus
            menuOverrides = [:]
            reply.ok()

        case "menu.update":
            guard let items = a.dict["items"] as? [[String: Any]] else { throw BridgeError("\(cmd): \"items\" must be an array of objects") }
            for item in items {
                guard let id = item["id"] as? String else { throw BridgeError("\(cmd): every item needs a string \"id\"") }
                menuOverrides[id, default: [:]].merge(item) { _, new in new }
                if MenuManager.shared.owner === self { MenuManager.shared.apply(item, to: id) }
            }
            reply.ok()

        case "menu.popup":
            guard let items = a.dict["items"] as? [Any], !items.isEmpty else { throw BridgeError("\(cmd): \"items\" must be a non-empty array") }
            var point: NSPoint
            if let x = try a.number("x"), let y = try a.number("y") {
                // CSS px from the top-left corner of the page.
                point = NSPoint(x: x, y: webView.isFlipped ? y : Double(webView.bounds.height) - y)
            } else {
                point = webView.convert(window.mouseLocationOutsideOfEventStream, from: nil)
            }
            if let delay = cancelNextPopupAfter { // selftest only
                cancelNextPopupAfter = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MenuManager.shared.activePopup?.cancelTrackingWithoutAnimation() }
            }
            try MenuManager.shared.popup(items, in: webView, at: point) { reply.ok(["id": $0 as Any? ?? NSNull()]) }

        // MARK: export
        case "export.pdf":
            try exportPDF(a, showPanel: false, reply)
        case "export.print":
            try exportPDF(a, showPanel: true, reply)
        case "export.image":
            try exportImage(a, reply)
        case "export.snapshot":
            // A PNG of one area of the page (CSS pixels of the visible page), e.g. a rendered diagram.
            let path = try a.path("path")
            guard let x = try a.number("x"), let y = try a.number("y"), let w = try a.number("width"), let h = try a.number("height"), w >= 1, h >= 1 else {
                throw BridgeError("\(cmd): x, y, width and height are required")
            }
            let config = WKSnapshotConfiguration()
            config.rect = CGRect(x: x, y: y, width: w, height: h)
            config.afterScreenUpdates = !headless // a window that is never shown never paints again
            webView.takeSnapshot(with: config) { image, error in
                guard let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) else {
                    return reply.fail("\(cmd): \(error?.localizedDescription ?? "the snapshot failed")")
                }
                do {
                    try png.write(to: URL(fileURLWithPath: path))
                    reply.ok()
                } catch {
                    reply.fail("\(cmd): \(error.localizedDescription)")
                }
            }

        default:
            if try runSystemCommand(cmd, a, reply) { return true }
            if app?.selfTest == true { return try runSelfTestCommand(cmd, a, reply) }
            return false
        }
        return true
    }

    private func present(_ panel: NSSavePanel, completion: @escaping (Bool) -> Void) {
        guard !headless else { return completion(false) }
        panel.beginSheetModal(for: window) { completion($0 == .OK) }
    }

    /// Lower-case extensions without dots.
    static func normalized(_ extensions: [String]?) -> [String] {
        (extensions ?? []).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ". ")).lowercased() }.filter { !$0.isEmpty }
    }

    /// The content type of each extension. An extension that is declared as a package type ("textbundle", see
    /// Info.plist) resolves to that declaration rather than to a made-up data type.
    static func contentTypes(_ extensions: [String]) -> [UTType] {
        extensions.compactMap { ext -> UTType? in
            let plain = UTType(filenameExtension: ext)
            if let plain = plain, !plain.isDynamic { return plain }
            if let package = UTType(filenameExtension: ext, conformingTo: .package), !package.isDynamic { return package }
            return plain
        }
    }

    private static func readClipboard() -> [String: Any] {
        let pasteboard = NSPasteboard.general
        var png = pasteboard.data(forType: .png)
        if png == nil, let tiff = pasteboard.data(forType: .tiff), let bitmap = NSBitmapImageRep(data: tiff) {
            png = bitmap.representation(using: .png, properties: [:])
        }
        let files = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return [
            "text": pasteboard.string(forType: .string) as Any? ?? NSNull(),
            "html": pasteboard.string(forType: .html) as Any? ?? NSNull(),
            "imagePngBase64": png?.base64EncodedString() as Any? ?? NSNull(),
            "filePaths": files.map { $0.path },
            // A link copied from a browser's address bar carries the page's title.
            "url": pasteboard.string(forType: NSPasteboard.PasteboardType("public.url")) as Any? ?? NSNull(),
            "urlTitle": pasteboard.string(forType: NSPasteboard.PasteboardType("public.url-name")) as Any? ?? NSNull(),
        ]
    }
}


extension WindowController {
    /// Brings forward the window (other than `besides`) whose document is `path`. False when there is none.
    func focusWindow(showing path: String, besides: WindowController?) -> Bool {
        let want = (path as NSString).standardizingPath
        guard let other = app?.controllers.first(where: { c in
            c !== besides && !c.closed && c.currentPath.map { ($0 as NSString).standardizingPath == want } == true
        }) else { return false }
        if !headless { other.window.makeKeyAndOrderFront(nil) }
        return true
    }
}
