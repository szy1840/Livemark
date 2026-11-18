import Cocoa
import WebKit
import PDFKit
import UniformTypeIdentifiers

/// `--selftest`: drives the real window / bridge / scheme handler without showing anything, prints one line per
/// check and exits 0 (all passed) or 1.
final class SelfTest {
    private unowned let app: AppDelegate
    private let tmp = NSTemporaryDirectory() + "livemark-selftest-" + UUID().uuidString.prefix(8).lowercased()
    private var queuedPath: String { tmp + "/queued-open.md" }
    private var failures = 0
    private var finished = false
    private var savedPasteboard: [[(NSPasteboard.PasteboardType, Data)]] = []
    private var activity: NSObjectProtocol?

    init(app: AppDelegate) {
        self.app = app
    }

    /// Before the first window exists: capture page errors from the very first script.
    func prepare() {
        // The web app persists settings and recent files; a test run must not write them into the real store.
        if ProcessInfo.processInfo.environment["LIVEMARK_APP_SUPPORT"] == nil { AppPaths.appSupportOverride = tmp + "/app-support" }
        app.userScripts = [WKUserScript(source: SelfTestScripts.pageHooks, injectionTime: .atDocumentStart, forMainFrameOnly: true)]
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated], reason: "selftest")
        // Hard stop, independent of the main thread.
        DispatchQueue.global().asyncAfter(deadline: .now() + 90) {
            print("FAIL timeout: selftest did not finish within 90s")
            print("SELFTEST FAIL")
            exit(1)
        }
    }

    func start(cliPaths: [String]) {
        print("selftest: web root \(AppPaths.webRoot.path)")
        savedPasteboard = (NSPasteboard.general.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
        if !cliPaths.isEmpty { return checkCommandLineOpen(cliPaths) }
        guard let first = app.controllers.first, app.controllers.count == 1 else {
            report("launch.one-window", false, "expected 1 window, found \(app.controllers.count)")
            return finish()
        }
        report("launch.one-window", true, "openPath = nil")
        // A file opened while the only window is still pristine goes to that window. The page has not run yet,
        // so the event must wait in the queue until app.ready.
        app.openFiles([queuedPath])
        report("open.reuses-pristine-window", app.controllers.count == 1 && !first.isPristine, "windows = \(app.controllers.count)")
        report("open.event-queued-until-ready", first.queuedEventNames == ["openFile"], "queue = \(first.queuedEventNames)")
        whenLoaded(first, "page.load") { self.runSuite(first) }
    }

    // MARK: - Reporting

    func report(_ name: String, _ ok: Bool, _ detail: String = "") {
        if !ok { failures += 1 }
        let line = detail.replacingOccurrences(of: "\n", with: " ")
        print(ok ? (line.isEmpty ? "ok \(name)" : "ok \(name) (\(line))") : "FAIL \(name): \(line)")
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        let items = savedPasteboard.filter { !$0.isEmpty }.map { pairs -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in pairs { item.setData(data, forType: type) }
            return item
        }
        if !items.isEmpty { pasteboard.writeObjects(items) }
        if ProcessInfo.processInfo.environment["LIVEMARK_SELFTEST_KEEP"] != nil {
            print("info kept \(tmp)")
        } else if tmp.contains("livemark-selftest-") {
            try? FileManager.default.removeItem(atPath: tmp) // our own scratch directory
        }
        print(failures == 0 ? "SELFTEST PASS" : "SELFTEST FAIL")
        exit(failures == 0 ? 0 : 1)
    }

    // MARK: - Helpers

    private func whenLoaded(_ controller: WindowController, _ name: String, then: @escaping () -> Void) {
        let proceed = { [weak controller] in
            guard let controller = controller else { return }
            switch controller.loadState {
            case .loading: return
            case .finished:
                controller.onLoadStateChange = nil
                self.report(name, true, controller.webView.url?.absoluteString ?? "")
                then()
            case .failed(let message):
                controller.onLoadStateChange = nil
                self.report(name, false, message)
                self.finish()
            }
        }
        controller.onLoadStateChange = proceed
        proceed()
    }

    private func js(_ controller: WindowController, _ body: String, _ arguments: [String: Any] = [:], then: @escaping (Any?, String?) -> Void) {
        controller.webView.callAsyncJavaScript(body, arguments: arguments, in: nil, in: .page) { result in
            switch result {
            case .success(let value): then(value, nil)
            case .failure(let error): then(nil, "\(error.localizedDescription) \((error as NSError).userInfo["WKJavaScriptExceptionMessage"] ?? "")")
            }
        }
    }

    // MARK: - Steps

    /// `Livemark --selftest /path/a.md …`: one window per file, each told its own openPath.
    private func checkCommandLineOpen(_ paths: [String]) {
        let opened = app.controllers.map { $0.openPath ?? "nil" }
        report("cli.one-window-per-file", opened == paths, "windows: \(opened)")
        var remaining = app.controllers
        func next() {
            guard let controller = remaining.first else { return finish() }
            remaining.removeFirst()
            whenLoaded(controller, "cli.window-\(controller.id).load") {
                self.js(controller, "return await window.webkit.messageHandlers.livemark.postMessage({ cmd: 'app.ready' });") { value, error in
                    let info = value as? [String: Any]
                    self.report("cli.window-\(controller.id).openPath", info?["openPath"] as? String == controller.openPath && controller.openPath != nil,
                                error ?? "app.ready.openPath = \(info?["openPath"] ?? "nil")")
                    next()
                }
            }
        }
        next()
    }

    private func runSuite(_ first: WindowController) {
        js(first, SelfTestScripts.suite, ["tmp": tmp, "queuedPath": queuedPath, "webRoot": AppPaths.webRoot.path, "appSupport": AppPaths.appSupport]) { value, error in
            if !(value is [[String: Any]]) { self.report("js.suite", false, error ?? "unexpected result") }
            self.nativeChecks(first)
        }
    }

    private func nativeChecks(_ first: WindowController) {
        // Classic: a standard title bar above the web view (the system draws the title and the
        // document icon). Unibody (the default, as in Typora): the page runs under a hidden title bar.
        first.window.layoutIfNeeded()
        let mask = first.window.styleMask
        let unibody = first.windowStyle == .unibody
        report("window.chrome", mask.contains(.fullSizeContentView) == unibody
               && first.window.titleVisibility == (unibody ? .hidden : .visible)
               && first.webView.frame == first.container.bounds,
               "\(unibody ? "unibody" : "classic"): content \(first.container.bounds.size), web view \(first.webView.frame.size)")
        report("app.default-app-support", AppPaths.defaultAppSupport == NSHomeDirectory() + "/Library/Application Support/Livemark",
               "\(AppPaths.defaultAppSupport) (this run uses a temporary one)")
        report("scheme.byte-ranges", SchemeHandler.byteRange("bytes=0-4", length: 10) == 0..<5
               && SchemeHandler.byteRange("bytes=6-", length: 10) == 6..<10
               && SchemeHandler.byteRange("bytes=-3", length: 10) == 7..<10
               && SchemeHandler.byteRange("bytes=20-30", length: 10) == nil)
        report("scheme.path-normalization", SchemeHandler.relativePath(insideRoot: "/a/./b/../c.js") == "a/c.js"
               && SchemeHandler.relativePath(insideRoot: "/a/../../etc/passwd") == nil
               && SchemeHandler.relativePath(insideRoot: "/") == "")
        print("info devtools role: \(MenuManager.inspectorAvailable ? "web inspector can be opened" : "unavailable, the item is omitted")")

        // Finder drop: a drag carrying file URLs is consumed and reported in page coordinates (origin top-left).
        let dropped = tmp + "/dropped file.md"
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("dev.livemark.selftest.drag"))
        pasteboard.clearContents()
        pasteboard.writeObjects([URL(fileURLWithPath: dropped) as NSURL])
        let location = first.webView.convert(NSPoint(x: 120, y: first.webView.isFlipped ? 45 : first.webView.bounds.height - 45), to: nil)
        let drag = FakeDrag(pasteboard: pasteboard, location: location, window: first.window)
        let accepted = first.webView.draggingEntered(drag) == .copy && first.webView.prepareForDragOperation(drag) && first.webView.performDragOperation(drag)

        // Folders and TextBundle packages are handed over like files; the page decides what to do with them.
        let mixed = [tmp + "/dropped folder", tmp + "/dropped note.textbundle", tmp + "/dropped too.md"]
        for directory in mixed.prefix(2) { try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true) }
        pasteboard.clearContents()
        pasteboard.writeObjects(mixed.map { URL(fileURLWithPath: $0) as NSURL })
        let acceptedMixed = first.webView.draggingEntered(drag) == .copy && first.webView.performDragOperation(drag)
        pasteboard.releaseGlobally()

        checkInfoPlist()

        // Quit: vetoed while a window is dirty (every page is asked to close), immediate otherwise.
        first.dirty = true
        let vetoed = app.applicationShouldTerminate(NSApp) == .terminateCancel
        first.dirty = false
        let immediate = app.applicationShouldTerminate(NSApp) == .terminateNow

        let read = "return (window.__lmSelftestEvents || []).filter((e) => e.name === 'dropFiles' || e.name === 'closeRequested');"
        js(first, read) { value, _ in
            let events = value as? [[String: Any]] ?? []
            let drops = events.filter { $0["name"] as? String == "dropFiles" }.compactMap { $0["payload"] as? [String: Any] }
            let drop = drops.first { $0["paths"] as? [String] == [dropped] }
            let x = (drop?["x"] as? NSNumber)?.doubleValue ?? -1, y = (drop?["y"] as? NSNumber)?.doubleValue ?? -1
            self.report("event.dropFiles", accepted && drop != nil && abs(x - 120) < 0.5 && abs(y - 45) < 0.5,
                        "paths \(drop?["paths"] ?? "nil"), x \(x), y \(y)")
            self.report("event.dropFiles (folder + .textbundle + file)", acceptedMixed && drops.contains { $0["paths"] as? [String] == mixed },
                        "\(drops.map { ($0["paths"] as? [String] ?? []).map { ($0 as NSString).lastPathComponent } })")
            let asked = events.filter { $0["name"] as? String == "closeRequested" }.count
            self.report("quit.vetoed-while-dirty", vetoed && asked == 1, "closeRequested events: \(asked)")
            self.report("quit.immediate-when-clean", immediate)
            self.secondWindow(first)
        }
    }

    /// The bundle declares the TextBundle package type and opens it. (A bare binary has no Info.plist: skipped.)
    private func checkInfoPlist() {
        guard let info = Bundle.main.infoDictionary, info["CFBundleDocumentTypes"] != nil else {
            print("info Info.plist checks skipped: not running from the app bundle")
            return
        }
        let imported = (info["UTImportedTypeDeclarations"] as? [[String: Any]] ?? []).first { $0["UTTypeIdentifier"] as? String == "org.textbundle.package" }
        let tags = imported?["UTTypeTagSpecification"] as? [String: Any]
        report("Info.plist.textbundle-type", (imported?["UTTypeConformsTo"] as? [String])?.contains("com.apple.package") == true
               && (tags?["public.filename-extension"] as? [String]) == ["textbundle"], "\(imported?["UTTypeConformsTo"] ?? "not declared")")
        let document = (info["CFBundleDocumentTypes"] as? [[String: Any]] ?? []).first { ($0["LSItemContentTypes"] as? [String])?.contains("org.textbundle.package") == true }
        report("Info.plist.textbundle-document", document?["CFBundleTypeRole"] as? String == "Editor" && document?["LSHandlerRank"] as? String == "Alternate"
               && document?["LSTypeIsPackage"] as? Bool == true, "\(document?["CFBundleTypeName"] ?? "not declared")")
        let resolved = WindowController.contentTypes(["textbundle"]).map { $0.identifier }
        print("info content type of .textbundle on this Mac: \(resolved)")
    }

    /// A second file opens a second window with its own bridge context.
    private func secondWindow(_ first: WindowController) {
        let path = tmp + "/second.md"
        app.openFiles([path])
        guard app.controllers.count == 2, let second = app.controllers.last, second !== first else {
            report("open.second-file-new-window", false, "windows = \(app.controllers.count)")
            return pageErrors(first)
        }
        report("open.second-file-new-window", second.openPath == path, "window \(second.id)")

        whenLoaded(second, "window2.load") {
            let setup = "return await window.webkit.messageHandlers.livemark.postMessage({ cmd: 'app.ready' });"
            self.js(second, setup) { value, error in
                let info = value as? [String: Any]
                let windowId = (info?["windowId"] as? NSNumber)?.intValue
                self.report("window2.app.ready", info?["openPath"] as? String == path && windowId == second.id && windowId != first.id,
                            error ?? "openPath \(info?["openPath"] ?? "nil"), windowId \(windowId ?? -1)")

                // Events are per window, and closing is a round trip through the page.
                second.emit("command", ["id": "only-for-window-2"])
                let stillOpen = !second.windowShouldClose(second.window)
                // …except `window.commandAll`, which reaches every window ("Save All").
                var everyWindow: Any?
                second.bridgeCommandForSelfTest("window.commandAll", ["id": "for-every-window"]) { everyWindow = $0 }
                let names = "return (window.__lmSelftestEvents || []).map((e) => e.name + ':' + ((e.payload && e.payload.id) || ''));"
                self.js(second, names) { value, _ in
                    let got = value as? [String] ?? []
                    let relevant = got.filter { $0 == "command:only-for-window-2" || $0 == "closeRequested:" }
                    self.report("window2.events", relevant == ["command:only-for-window-2", "closeRequested:"], "\(got)")
                    self.report("window2.close-is-vetoed-until-page-answers", stillOpen && self.app.controllers.count == 2)
                    self.js(first, names) { value, _ in
                        // Window 1 has exactly one closeRequested of its own, from the quit check above.
                        let names = value as? [String] ?? []
                        let leaked = names.contains { $0.contains("only-for-window-2") } || names.filter { $0 == "closeRequested:" }.count != 1
                        self.report("window1.did-not-get-window2-events", !leaked, leaked ? "\(names)" : "")
                        self.report("window.commandAll (two windows)", (everyWindow as? NSNumber)?.intValue == 2
                                    && names.contains("command:for-every-window") && got.contains("command:for-every-window"), "reply \(everyWindow ?? "nil")")
                        self.js(second, "return await window.webkit.messageHandlers.livemark.postMessage({ cmd: 'window.close', args: { force: true } });") { value, error in
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                                self.report("window2.close-force", value as? Bool == true && self.app.controllers.count == 1 && !second.window.isVisible,
                                            error ?? "windows = \(self.app.controllers.count)")
                                self.closeBeforeReady(first)
                            }
                        }
                    }
                }
            }
        }
    }

    /// A page that never sent app.ready (still loading / crashed) must not be able to hold its window open.
    private func closeBeforeReady(_ first: WindowController) {
        let third = app.newWindow(openPath: nil)
        report("window3.closes-immediately-before-ready", third.windowShouldClose(third.window))
        third.closeNow()
        report("window3.closed", app.controllers.count == 1)

        // A TextBundle is a directory; opening one hands its path to a window exactly like a file's.
        let bundle = tmp + "/opened note.textbundle"
        try? FileManager.default.createDirectory(atPath: bundle, withIntermediateDirectories: true)
        app.openFiles([bundle])
        let fourth = app.controllers.last
        report("open.textbundle-directory", app.controllers.count == 2 && fourth?.openPath == bundle, "openPath \(fourth?.openPath ?? "nil")")
        if let fourth = fourth, fourth !== first { fourth.closeNow() }
        pageErrors(first)
    }

    /// JS errors raised by the web app itself while loading in the shell (reported, not counted as a shell failure).
    private func pageErrors(_ first: WindowController) {
        js(first, "return { errors: window.__lmSelftestErrors || [], secure: window.isSecureContext, emit: window.__lmSelftestPageDefinesEmit };") { value, _ in
            let info = value as? [String: Any]
            let errors = info?["errors"] as? [String] ?? []
            if errors.isEmpty {
                print("ok page.console (no JS errors or failed resources while loading)")
            } else {
                print("WARN page.console: \(errors.count) error(s) from the web app")
                for error in errors { print("  page-error: \(error.replacingOccurrences(of: "\n", with: " | "))") }
            }
            print("info isSecureContext = \(info?["secure"] as? Bool ?? false); the web app defines window.__livemark.emit = \(info?["emit"] as? Bool ?? false)")
            self.finish()
        }
    }
}

/// Just enough of a drag session to call the web view's dragging-destination methods.
private final class FakeDrag: NSObject, NSDraggingInfo {
    let draggingPasteboard: NSPasteboard
    let draggingLocation: NSPoint
    let draggingDestinationWindow: NSWindow?
    init(pasteboard: NSPasteboard, location: NSPoint, window: NSWindow) {
        draggingPasteboard = pasteboard
        draggingLocation = location
        draggingDestinationWindow = window
    }
    var draggingSourceOperationMask: NSDragOperation { .copy }
    var draggedImageLocation: NSPoint { draggingLocation }
    var draggedImage: NSImage? { nil }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
    func enumerateDraggingItems(options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass],
                                searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:], using block: @escaping (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    func resetSpringLoading() {}
}

// MARK: - Selftest-only bridge commands (introspection of native state)

extension WindowController {
    /// Runs a window command as the bridge would, without the page: `completion` gets the reply value (nil on failure).
    func bridgeCommandForSelfTest(_ cmd: String, _ args: [String: Any], completion: @escaping (Any?) -> Void) {
        let reply = Reply { value, _ in completion(value) }
        do {
            if try !run(cmd, Args(cmd: cmd, dict: args), reply) { reply.fail("unknown command") }
        } catch {
            reply.fail(describe(error))
        }
    }

    func runSelfTestCommand(_ cmd: String, _ a: Args, _ reply: Reply) throws -> Bool {
        switch cmd {
        case "selftest.menuDump":
            reply.ok([
                "menus": Self.dump(NSApp.mainMenu),
                "windowsMenu": NSApp.windowsMenu?.title as Any? ?? NSNull(),
                "servicesMenu": NSApp.servicesMenu != nil,
            ] as [String: Any])
        case "selftest.clickMenu":
            guard let item = MenuManager.shared.items(withId: try a.string("id")).first, let action = item.action else {
                throw BridgeError("\(cmd): no such menu item")
            }
            reply.ok(NSApp.sendAction(action, to: item.target, from: item))
        case "selftest.emit":
            emit(try a.string("name"), a.dict["payload"] ?? NSNull())
            reply.ok()
        case "selftest.windowState":
            reply.ok([
                "title": window.title,
                "path": window.representedURL?.path as Any? ?? NSNull(),
                "edited": window.isDocumentEdited,
                "dirty": dirty,
                "onTop": window.level == .floating,
            ] as [String: Any])
        case "selftest.report":
            app?.selfTestRunner?.report(try a.string("name"), try a.bool("ok", default: false), try a.optString("detail") ?? "")
            reply.ok()
        case "selftest.waitIdle":
            // Resolves once this window's page has been quiet on the bridge for 300 ms (5 s at most).
            let deadline = Date().addingTimeInterval(5)
            func poll() {
                if Date().timeIntervalSince(bridge.lastMessage) > 0.3 || Date() > deadline { return reply.ok() }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: poll)
            }
            bridge.lastMessage = Date()
            poll()
        case "selftest.cancelNextPopup":
            cancelNextPopupAfter = try a.number("after") ?? 0.3
            reply.ok()
        case "selftest.pdfInfo":
            guard let document = PDFDocument(url: URL(fileURLWithPath: try a.path("path"))), let page = document.page(at: 0) else {
                throw BridgeError("\(cmd): not a readable PDF")
            }
            let box = page.bounds(for: .mediaBox)
            // Rasterize the first page and count pixels of the test marker's pure green background.
            var green = 0
            let width = Int(box.width), height = Int(box.height)
            if let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                       space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                context.setFillColor(CGColor(gray: 1, alpha: 1))
                context.fill(CGRect(x: 0, y: 0, width: width, height: height))
                page.draw(with: .mediaBox, to: context)
                if let data = context.data {
                    let pixels = data.bindMemory(to: UInt8.self, capacity: width * height * 4)
                    for i in 0..<(width * height) where pixels[i * 4] < 90 && pixels[i * 4 + 1] > 190 && pixels[i * 4 + 2] < 90 { green += 1 }
                }
            }
            let pages = (0..<document.pageCount).compactMap { document.page(at: $0) }
            // Where a piece of text sits: [{ page, x, y }] (centre of the match, PDF points from the bottom-left).
            var found: [[String: Any]] = []
            if let needle = try a.optString("find") {
                for selection in document.findString(needle, withOptions: []) {
                    guard let page = selection.pages.first else { continue }
                    let bounds = selection.bounds(for: page)
                    found.append(["page": document.index(for: page), "x": Double(bounds.midX), "y": Double(bounds.midY)])
                }
            }
            reply.ok(["pages": document.pageCount, "width": Double(box.width), "height": Double(box.height),
                      "text": document.string ?? "", "greenPixels": green,
                      "pageTexts": pages.map { $0.string ?? "" },
                      "links": pages.reduce(0) { $0 + $1.annotations.filter { $0.type == "Link" }.count },
                      "outline": PDFPostProcess.outlineDump(document),
                      "found": found] as [String: Any])

        case "selftest.windowChrome":
            window.layoutIfNeeded()
            let close = window.standardWindowButton(.closeButton), zoom = window.standardWindowButton(.zoomButton)
            var lights: [String: Any] = [:]
            if let close = close, let zoom = zoom {
                let a = close.convert(close.bounds, to: nil), b = zoom.convert(zoom.bounds, to: nil)
                lights = ["left": Double(a.minX), "right": Double(b.maxX), "top": Double(window.frame.height - a.maxY), "bottom": Double(window.frame.height - a.minY)]
            }
            reply.ok([
                "style": windowStyle.rawValue,
                "fullSize": window.styleMask.contains(.fullSizeContentView),
                "transparent": window.titlebarAppearsTransparent,
                "titleHidden": window.titleVisibility == .hidden,
                "magnification": webView.allowsMagnification,
                "frame": [Double(window.frame.width), Double(window.frame.height)],
                "content": [Double(container.bounds.width), Double(container.bounds.height)],
                "webViewFills": webView.frame == container.bounds,
                "trafficLights": lights,
                // Who gets a click 10pt below the top edge, in the middle of the window / on the close button.
                "hitTop": hitDescription(NSPoint(x: window.frame.width / 2, y: window.frame.height - 10)),
                "hitClose": hitDescription(NSPoint(x: 14, y: window.frame.height - 14)),
            ] as [String: Any])

        case "selftest.dragProbe":
            // Would a mouse-down at this page position (CSS px) drag the window?
            guard let x = try a.number("x"), let y = try a.number("y") else { throw BridgeError("\(cmd): x and y are required") }
            probeDragStrip(at: NSPoint(x: x, y: webView.isFlipped ? y : Double(webView.bounds.height) - y)) { reply.ok($0) }

        case "selftest.touchBarDump":
            var dump = touchBarProvider.dump()
            dump["onWebView"] = webView.touchBar === touchBarProvider.touchBar && webView.makeTouchBar() === touchBarProvider.touchBar
            reply.ok(dump)

        case "selftest.touchBarTap":
            reply.ok(touchBarProvider.tap(try a.string("id")))

        case "selftest.quitOnLastWindow":
            reply.ok(app?.quitOnLastWindow ?? false)

        case "selftest.webViewResponds":
            reply.ok((try a.stringArray("selectors") ?? []).map { webView.responds(to: NSSelectorFromString($0)) })

        case "selftest.importImage":
            // What Continuity Camera does: offer an image on a pasteboard to whoever the web view names as requestor.
            let path = try a.path("path")
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let type = NSPasteboard.PasteboardType(UTType(filenameExtension: (path as NSString).pathExtension)?.identifier ?? "public.data")
            guard let receiver = webView.validRequestor(forSendType: nil, returnType: type) as? ImageImportReceiver else { reply.ok(false); break }
            let pasteboard = NSPasteboard(name: NSPasteboard.Name("dev.livemark.selftest.import"))
            pasteboard.clearContents()
            pasteboard.setData(data, forType: type)
            reply.ok(receiver.readSelection(from: pasteboard))
            pasteboard.releaseGlobally()

        case "selftest.openPanelFilter":
            // The decisions of the open panel's delegate, without a panel: [{ enabled, choosable }] per path.
            let extensions = Self.normalized(try a.stringArray("extensions"))
            let guide = BundleAwareOpenPanel(extensions: extensions, types: Self.contentTypes(extensions))
            reply.ok((try a.stringArray("paths") ?? []).map { path -> [String: Any] in
                let url = URL(fileURLWithPath: path)
                let enabled = guide.panel(NSNull(), shouldEnable: url)
                return ["enabled": enabled, "choosable": enabled && (try? guide.panel(NSNull(), validate: url)) != nil]
            })
        default:
            return false
        }
        return true
    }

    /// "webView" when a click at `point` (window coordinates) goes to the page, else the class of the view that takes it.
    private func hitDescription(_ point: NSPoint) -> String {
        guard let hit = window.contentView?.superview?.hitTest(point) else { return "nothing" }
        return hit === webView || hit.isDescendant(of: webView) ? "webView" : String(describing: type(of: hit))
    }

    private static func dump(_ menu: NSMenu?) -> [[String: Any]] {
        (menu?.items ?? []).map { item in
            if item.isSeparatorItem { return ["separator": true] }
            let mask = item.keyEquivalentModifierMask
            let names: [(NSEvent.ModifierFlags, String)] = [(.option, "alt"), (.command, "cmd"), (.control, "ctrl"), (.shift, "shift")]
            var entry: [String: Any] = [
                "title": item.title,
                "key": item.keyEquivalent,
                "mods": item.keyEquivalent.isEmpty ? [String]() : names.filter { mask.contains($0.0) }.map { $0.1 },
                "checked": item.state == .on,
                "action": item.action.map { NSStringFromSelector($0) } as Any? ?? NSNull(),
            ]
            if let command = item as? CommandItem {
                entry["id"] = command.commandId
                entry["enabled"] = command.specEnabled
            }
            if let identifier = item.identifier?.rawValue { entry["identifier"] = identifier }
            if let submenu = item.submenu { entry["items"] = dump(submenu) }
            return entry
        }
    }
}
