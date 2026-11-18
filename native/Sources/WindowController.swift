import Cocoa
import WebKit
import Quartz

/// Remembers the last mouse-down so the page can start a window drag from its own title bar.
final class LivemarkWindow: NSWindow {
    private(set) var lastMouseDown: NSEvent?
    /// Called once AppKit has dispatched a left mouse-down (the "unibody" drag strip listens here).
    var afterLeftMouseDown: ((NSEvent) -> Void)?
    /// What the Quick Look panel shows while this window controls it.
    let quickLook = QuickLookSource()

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown { lastMouseDown = event }
        super.sendEvent(event)
        if event.type == .leftMouseDown { afterLeftMouseDown?(event) }
    }

    // The Quick Look panel looks along the responder chain for someone to drive it.
    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool {
        !quickLook.urls.isEmpty
    }

    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = quickLook
        panel.delegate = quickLook
    }

    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = nil
        panel.delegate = nil
    }
}

/// The source of a file dragged out of the sidebar: other apps get a copy (Finder never moves the file away);
/// inside the app the page decides.
final class FileDragSource: NSObject, NSDraggingSource {
    var onEnd: (() -> Void)?

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .withinApplication ? [.copy, .move, .generic] : .copy
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        onEnd?()
        onEnd = nil
    }
}

/// WKWebView that hands Finder file drops to the page and leaves every other drag to WebKit.
final class LivemarkWebView: WKWebView {
    var onDropFiles: (([String], NSPoint) -> Void)?
    /// Receives pictures from Continuity Camera ("Import from iPhone or iPad").
    var importReceiver: ImageImportReceiver?
    /// The window's Touch Bar for the current mode.
    var touchBarSource: (() -> NSTouchBar?)?
    /// Edit > Select All: the page picks the scope (a code block, the front matter, a field or the document).
    var onSelectAll: (() -> Void)?

    @objc override func selectAll(_ sender: Any?) {
        if let handler = onSelectAll { handler() } else { super.selectAll(sender) }
    }

    // MARK: Touch Bar

    // WebKit installs a Touch Bar of its own whenever the editing state changes; the page chooses ours instead.
    override var touchBar: NSTouchBar? {
        get { touchBarSource?() ?? super.touchBar }
        set { super.touchBar = newValue }
    }

    override func makeTouchBar() -> NSTouchBar? {
        touchBarSource?() ?? super.makeTouchBar()
    }

    // MARK: Continuity Camera

    /// A service that only returns an image (nothing is sent to it) is the Continuity Camera import; everything
    /// else stays with WebKit.
    override func validRequestor(forSendType sendType: NSPasteboard.PasteboardType?, returnType: NSPasteboard.PasteboardType?) -> Any? {
        if (sendType?.rawValue ?? "").isEmpty, let returnType = returnType, let receiver = importReceiver,
           ImageImportReceiver.accepts(returnType) {
            return receiver
        }
        return super.validRequestor(forSendType: sendType, returnType: returnType)
    }

    // MARK: File drops

    /// The file being dragged out of the sidebar, while that drag lasts.
    private var fileDrag: FileDragSource?

    /// Starts a system drag of the file at `path` from the current mouse position (sidebar → Finder, other apps,
    /// or a folder in the sidebar). Inside this page the drop is left to the page; `onEnd` runs when it finishes.
    func startFileDrag(_ path: String, onEnd: @escaping () -> Void) -> Bool {
        guard let window = window, FileManager.default.fileExists(atPath: path) else { return false }
        let inWindow = window.mouseLocationOutsideOfEventStream
        guard let event = NSEvent.mouseEvent(with: .leftMouseDragged, location: inWindow, modifierFlags: [],
                                             timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                             context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { return false }
        let icon = NSWorkspace.shared.icon(forFile: path)
        icon.size = NSSize(width: 32, height: 32)
        let item = NSDraggingItem(pasteboardWriter: URL(fileURLWithPath: path) as NSURL)
        let at = convert(inWindow, from: nil)
        item.setDraggingFrame(NSRect(x: at.x - 16, y: at.y - 16, width: 32, height: 32), contents: icon)
        let source = FileDragSource()
        source.onEnd = { [weak self] in
            self?.fileDrag = nil
            onEnd()
        }
        fileDrag = source
        beginDraggingSession(with: [item], event: event, source: source)
        return true
    }

    /// Paths of the dragged files, or nil when this is not a file drag from outside the page.
    private func droppedFiles(_ info: NSDraggingInfo) -> [String]? {
        if let source = info.draggingSource as? NSView, source === self || source.isDescendant(of: self) { return nil }
        // A file dragged out of this page's sidebar: the page handles where it lands.
        if let source = info.draggingSource as? FileDragSource, source === fileDrag { return nil }
        let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.isEmpty ? nil : urls.map { $0.path }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFiles(sender) != nil ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFiles(sender) != nil ? .copy : super.draggingUpdated(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        if let sender = sender, droppedFiles(sender) != nil { return }
        super.draggingExited(sender)
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        droppedFiles(sender) != nil ? true : super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let paths = droppedFiles(sender) else { return super.performDragOperation(sender) }
        var point = convert(sender.draggingLocation, from: nil)
        if !isFlipped { point.y = bounds.height - point.y }
        onDropFiles?(paths, point)
        return true
    }

    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        if let sender = sender, droppedFiles(sender) != nil { return }
        super.concludeDragOperation(sender)
    }

    /// WebKit's own context menu (shown when the page does not handle `contextmenu`) keeps Inspect Element
    /// but loses the browser navigation items: reloading would throw away the open document.
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        let browserOnly: Set<String> = ["WKMenuItemIdentifierReload", "WKMenuItemIdentifierGoBack", "WKMenuItemIdentifierGoForward"]
        for item in menu.items where browserOnly.contains(item.identifier?.rawValue ?? "") { menu.removeItem(item) }
    }
}

/// One document window: an NSWindow, its WKWebView and its bridge state.
final class WindowController: NSObject, NSWindowDelegate {
    static let frameName = "LivemarkDocumentWindow"
    static let entryURL = "\(SchemeHandler.scheme)://\(SchemeHandler.appHost)/index.html"

    /// Matches the page background (light / dark) so there is no white flash while loading.
    static let backgroundColor = NSColor(name: nil) { appearance in
        appearance.isDark ? NSColor(srgbRed: 0x1F / 255.0, green: 0x22 / 255.0, blue: 0x27 / 255.0, alpha: 1) : .white
    }

    enum LoadState: Equatable {
        case loading, finished, failed(String)
    }

    let id: Int
    let openPath: String?
    let window: LivemarkWindow
    let webView: LivemarkWebView
    let container: NSView
    /// Selftest windows are never put on screen.
    let headless: Bool
    private(set) weak var app: AppDelegate?
    let bridge = Bridge()

    /// True once the page sent `app.ready`; events are queued until then.
    private(set) var ready = false
    private var pendingEvents: [(name: String, payload: Any)] = []
    private var forceClose = false
    private(set) var closed = false
    private var tracksFrame = false

    // Document state reported by the page through `window.setTitle`.
    var dirty = false
    var currentPath: String?
    var openFileSent = false

    // Menu state of this window (the menu bar shows the main window's spec).
    var menuSpec: [Any]?
    var menuOverrides: [String: [String: Any]] = [:]

    // Window chrome chosen by the page (`window.setStyle`, `touchbar.set`).
    var windowStyle = WindowStyle.classic
    var layoutObservation: NSKeyValueObservation?
    /// Mouse-down already answered with a window drag / title-bar double click (the page and the shell may both ask).
    var handledTitlebarEvent = -1
    private(set) lazy var touchBarProvider = TouchBarProvider(controller: self)
    let importReceiver = ImageImportReceiver()

    // Export state.
    var exporting = false
    var printJobs = Set<PrintJob>()
    var downloads: [ObjectIdentifier: DownloadTarget] = [:]

    // Selftest hooks.
    private(set) var loadState = LoadState.loading
    var onLoadStateChange: (() -> Void)?
    var cancelNextPopupAfter: TimeInterval?

    /// A window nobody has typed in or opened a file into: it may be reused for the next opened file.
    var isPristine: Bool { openPath == nil && currentPath == nil && !dirty && !openFileSent }

    init(id: Int, openPath: String?, app: AppDelegate, userScripts: [WKUserScript] = []) {
        self.id = id
        self.openPath = openPath
        self.currentPath = openPath
        self.app = app
        self.headless = app.headless

        let rect = NSRect(x: 0, y: 0, width: 1100, height: 760)
        window = LivemarkWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable], // a standard title bar, as document apps have
            backing: .buffered,
            defer: true)

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(SchemeHandler(webRoot: AppPaths.webRoot), forURLScheme: SchemeHandler.scheme)
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled") // Inspect Element
        if #available(macOS 13.3, *) { configuration.preferences.shouldPrintBackgrounds = true }
        if app.headless { configuration.websiteDataStore = .nonPersistent() } // leave the user's localStorage alone
        for script in userScripts { configuration.userContentController.addUserScript(script) }
        if Log.enabled {
            configuration.userContentController.addUserScript(WKUserScript(source: Log.pageErrorHook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: Bridge.name)

        container = NSView(frame: rect)
        webView = LivemarkWebView(frame: rect, configuration: configuration)
        super.init()
        bridge.controller = self

        window.title = AppPaths.appName
        window.titleVisibility = .visible
        window.minSize = NSSize(width: 480, height: 360)
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        // Windows open on their own; "New Tab" joins one explicitly, and the user can merge windows.
        window.tabbingMode = .automatic
        window.tabbingIdentifier = "dev.livemark.document"
        window.collectionBehavior = [.fullScreenPrimary]
        window.backgroundColor = Self.backgroundColor
        window.delegate = self
        window.contentView = container

        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false
        webView.underPageBackgroundColor = Self.backgroundColor
        if webView.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
            // Let the window color show until the page paints.
            webView.setValue(false, forKey: "drawsBackground")
        }
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.onDropFiles = { [weak self] paths, point in
            self?.emit("dropFiles", ["paths": paths, "x": point.x, "y": point.y])
        }
        container.addSubview(webView)
        window.initialFirstResponder = webView

        importReceiver.controller = self
        webView.importReceiver = importReceiver
        webView.touchBarSource = { [weak self] in self?.touchBarProvider.touchBar }
        webView.onSelectAll = { [weak self] in
            guard let self = self, self.ready else { return }
            self.emit("selectAll")
        }
        window.afterLeftMouseDown = { [weak self] event in self?.titlebarStripMouseDown(event) }
        // The title bar and the tab bar lie over a full-size content view: follow them.
        layoutObservation = window.observe(\.contentLayoutRect) { [weak self] _, _ in
            DispatchQueue.main.async { self?.layoutWebView() }
        }
        // Start in the style the user chose, so the window does not change shape once the page has loaded.
        if (Store.shared.get("settings") as? [String: Any])?["windowStyle"] as? String == WindowStyle.unibody.rawValue {
            setWindowStyle(.unibody)
        }
        Log.debug("window \(id) created, openPath = \(openPath ?? "nil"), web root = \(AppPaths.webRoot.path)")
    }

    func load() {
        guard let url = URL(string: Self.entryURL) else { return }
        webView.load(URLRequest(url: url))
    }

    func show() {
        guard !headless else { return }
        window.makeKeyAndOrderFront(nil)
        tracksFrame = true // from here on, moves and resizes are the user's
    }

    // MARK: - Events (native -> JS)

    func emit(_ name: String, _ payload: Any = [String: Any]()) {
        guard !closed else { return }
        Log.debug("window \(id): event \(name)\(ready ? "" : " (queued until app.ready)")")
        if ready { send(name, payload) } else { pendingEvents.append((name, payload)) }
    }

    private func send(_ name: String, _ payload: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: [name, payload]),
              let json = String(data: data, encoding: .utf8) else { return }
        // JSON is a valid JS expression once the two line separators are escaped.
        let literal = json
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        let script = "(function(a){var l=window.__livemark;if(l&&typeof l.emit==='function')l.emit(a[0],a[1]);})(\(literal));"
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    var queuedEventNames: [String] { pendingEvents.map { $0.name } }

    /// Called when the page sends `app.ready`: flush everything that happened while it was loading.
    func markReady() {
        ready = true
        let queued = pendingEvents
        pendingEvents = []
        for event in queued { send(event.name, event.payload) }
    }

    func pageWentAway() {
        ready = false
    }

    func setLoadState(_ state: LoadState) {
        loadState = state
        onLoadStateChange?()
    }

    // MARK: - Closing

    /// Asks the page to close (it answers with `window.close {force:true}`); closes right away if the page is not up.
    func requestClose() {
        if ready { emit("closeRequested") } else { closeNow() }
    }

    func closeNow() {
        forceClose = true
        window.close()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if forceClose || !ready { return true }
        emit("closeRequested")
        return false
    }

    func windowWillClose(_ notification: Notification) {
        guard !closed else { return }
        closed = true
        FolderWatcher.stop(window: id)
        TrafficLights.stop(window: id)
        Log.debug("window \(id) closed")
        saveFrame()
        layoutObservation = nil
        window.afterLeftMouseDown = nil
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        MenuManager.shared.ownerClosed(self)
        app?.windowDidClose(self)
    }

    // MARK: - Window events

    func windowDidBecomeKey(_ notification: Notification) { emit("focus") }
    func windowDidResignKey(_ notification: Notification) { emit("blur") }
    func windowDidEnterFullScreen(_ notification: Notification) {
        applyWindowStyle()
        emit("fullscreen", ["on": true])
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        applyWindowStyle()
        emit("fullscreen", ["on": false])
    }

    func windowDidBecomeMain(_ notification: Notification) {
        // The menu bar is shared: show this window's menu while it is the main window.
        if let spec = menuSpec, MenuManager.shared.owner !== self {
            try? MenuManager.shared.install(spec: spec, overrides: menuOverrides, owner: self)
        }
    }

    func windowDidMove(_ notification: Notification) { saveFrame() }
    func windowDidEndLiveResize(_ notification: Notification) { saveFrame() }

    private func saveFrame() {
        guard tracksFrame, !window.styleMask.contains(.fullScreen) else { return }
        window.saveFrame(usingName: Self.frameName)
    }
}
