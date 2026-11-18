import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    let selfTest: Bool
    /// `--script file.js`: run a script in the booted page of a hidden window, print its result, exit.
    let scriptPath: String?
    private var scriptRunner: ScriptRunner?
    /// Test modes never put a window on screen or touch the user's stored settings.
    var headless: Bool { selfTest || scriptPath != nil }
    private(set) var controllers: [WindowController] = []
    /// Files named on the command line, opened once the app has launched.
    private(set) var launchPaths: [String]
    private var nextWindowId = 1
    private var appearanceObservation: NSKeyValueObservation?
    /// Quit was asked for while documents had unsaved changes: terminate once every window has closed.
    private(set) var quitPending = false
    private var quitMonitor: Any?
    private(set) var selfTestRunner: SelfTest?
    /// Extra user scripts for every new web view (selftest installs its error capture here).
    var userScripts: [WKUserScript] = []

    override init() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        selfTest = arguments.contains("--selftest")
        if let flag = arguments.firstIndex(of: "--script"), flag + 1 < arguments.count {
            scriptPath = URL(fileURLWithPath: (arguments[flag + 1] as NSString).expandingTildeInPath).standardizedFileURL.path
        } else {
            scriptPath = nil
        }
        launchPaths = Self.filePaths(in: arguments)
        super.init()
    }

    /// Bare arguments are files; `--flags` are ours; `-Key value` pairs are AppKit user-default overrides.
    private static func filePaths(in arguments: [String]) -> [String] {
        var paths: [String] = []
        var skipNext = false
        for argument in arguments {
            if skipNext { skipNext = false; continue }
            if argument == "--script" { skipNext = true; continue } // its value is a script, not a document
            if argument.hasPrefix("--") { continue }
            if argument.hasPrefix("-") { skipNext = true; continue }
            let expanded = (argument as NSString).expandingTildeInPath
            paths.append(URL(fileURLWithPath: expanded).standardizedFileURL.path) // relative to the cwd
        }
        return paths
    }

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // View → Customize Touch Bar… (the editing bars allow extra buttons).
        NSApp.isAutomaticCustomizeTouchBarMenuItemEnabled = true
        MenuManager.shared.installDefaultMenu()
        appearanceObservation = NSApp.observe(\.effectiveAppearance) { [weak self] _, _ in
            DispatchQueue.main.async {
                let dark = NSApp.effectiveAppearance.isDark
                self?.controllers.forEach {
                    $0.keepSystemAppearanceInPage()
                    $0.emit("appearance", ["dark": dark])
                }
            }
        }
        if selfTest {
            let runner = SelfTest(app: self)
            selfTestRunner = runner
            runner.prepare()
        } else if let scriptPath = scriptPath {
            let runner = ScriptRunner(app: self, path: scriptPath)
            scriptRunner = runner
            runner.prepare()
        }
        // Finder's open event (application(_:open:)) is delivered around this point; decide afterwards.
        DispatchQueue.main.async {
            let paths = self.launchPaths
            self.launchPaths = []
            if !paths.isEmpty { self.openFiles(paths) }
            if self.controllers.isEmpty { self.newWindow(openPath: nil) }
            if let runner = self.selfTestRunner {
                runner.start(cliPaths: paths)
            } else if let runner = self.scriptRunner {
                runner.start()
            } else if !NSApp.isHidden {
                // Needed when started as a bare binary from a terminal; respects `open -j` (launch hidden).
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        openFiles(urls.filter { $0.isFileURL }.map { $0.path })
    }

    /// `settings.quitOnLastWindow` in the JSON store (the page's settings object). Off unless the user turned it on.
    var quitOnLastWindow: Bool {
        (Store.shared.get("settings") as? [String: Any])?["quitOnLastWindow"] as? Bool ?? false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !headless && quitOnLastWindow
    }

    /// Dock icon clicked (or the app opened again) while no window is left: bring one back.
    // MARK: - Dock menu

    /// Right-clicking the Dock icon: New File and Open… (the system adds the recent documents).
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        menu.addItem(withTitle: Localized.dock("New File"), action: #selector(dockNewFile), keyEquivalent: "").target = self
        menu.addItem(withTitle: Localized.dock("Open…"), action: #selector(dockOpen), keyEquivalent: "").target = self
        return menu
    }

    @objc func dockNewFile() {
        NSApp.activate(ignoringOtherApps: true)
        newWindow(openPath: nil).show()
    }

    @objc func dockOpen() {
        NSApp.activate(ignoringOtherApps: true)
        let target = controllers.first { $0.window.isKeyWindow } ?? controllers.first ?? newWindow(openPath: nil)
        target.show()
        target.emit("command", ["id": "open"])
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if controllers.isEmpty, !headless { newWindow(openPath: nil) }
        return true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if !quitPending { saveSession() }
        guard controllers.contains(where: { $0.dirty }) else { return .terminateNow }
        // Unsaved work: every page gets to save or veto. The quit is finished in windowDidClose once the last
        // window is gone; if the user goes back to work instead (cancelled a save prompt), it is forgotten.
        quitPending = true
        if quitMonitor == nil, !headless {
            quitMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) { [weak self] event in
                if let window = event.window, window.delegate is WindowController, window.attachedSheet == nil { self?.cancelPendingQuit() }
                return event
            }
        }
        for controller in controllers { controller.requestClose() }
        return .terminateCancel
    }

    /// The files open at quit, front window first, so "Restore last closed files" can bring every window back.
    private func saveSession() {
        let front = NSApp.orderedWindows.compactMap { $0.delegate as? WindowController }
        let rest = controllers.filter { c in !front.contains { $0 === c } }
        var seen = Set<String>()
        let paths = (front + rest).compactMap { $0.currentPath }.filter { seen.insert($0).inserted }
        try? Store.shared.set("session", paths)
    }

    private func cancelPendingQuit() {
        quitPending = false
        if let monitor = quitMonitor { NSEvent.removeMonitor(monitor) }
        quitMonitor = nil
    }

    // MARK: - Windows

    @discardableResult
    func newWindow(openPath: String?, tabOf host: NSWindow? = nil) -> WindowController {
        if quitPending { cancelPendingQuit() }
        let controller = WindowController(id: nextWindowId, openPath: openPath, app: self, userScripts: userScripts)
        nextWindowId += 1
        if let host = host, !headless {
            // "New Tab": join the host window's tab group instead of floating free.
            controller.window.setFrame(host.frame, display: false)
            host.addTabbedWindow(controller.window, ordered: .above)
        } else {
            place(controller.window)
        }
        controllers.append(controller)
        controller.load()
        controller.show()
        return controller
    }

    /// First window: the remembered frame. Later windows: same size, cascaded from the frontmost one.
    private func place(_ window: NSWindow) {
        let reference = (NSApp.keyWindow?.delegate as? WindowController)?.window ?? controllers.last?.window
        if let reference = reference {
            window.setFrame(reference.frame, display: false)
            let next = reference.cascadeTopLeft(from: .zero)
            _ = window.cascadeTopLeft(from: next)
        } else if headless || !window.setFrameUsingName(WindowController.frameName) {
            window.center()
        }
    }

    func windowDidClose(_ controller: WindowController) {
        controllers.removeAll { $0 === controller }
        if quitPending, controllers.isEmpty, !headless {
            cancelPendingQuit()
            // Not from inside the window's close callback.
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    /// Finder open, "Open With", dock drop, command-line arguments.
    func openFiles(_ paths: [String]) {
        for path in paths {
            if controllers.count == 1, let only = controllers.first, only.isPristine {
                // An untouched empty window takes the file instead of leaving a blank window behind.
                only.openFileSent = true
                only.emit("openFile", ["path": path])
                only.show()
            } else if let existing = controllers.first(where: { $0.currentPath == path }) {
                existing.show() // already open: bring its window forward
            } else {
                newWindow(openPath: path)
            }
        }
    }
}


/// The few native strings the Dock menu needs, in the language the page uses.
enum Localized {
    static func dock(_ key: String) -> String {
        let lang = (Store.shared.get("settings") as? [String: Any])?["lang"] as? String ?? ""
        let chinese = lang.hasPrefix("zh") || (lang.isEmpty || lang == "auto") && (Locale.preferredLanguages.first ?? "").hasPrefix("zh")
        guard chinese else { return key }
        return ["New File": "新建文件", "Open…": "打开…"][key] ?? key
    }
}
