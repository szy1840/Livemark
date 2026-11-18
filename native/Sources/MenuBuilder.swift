import Cocoa
import WebKit

/// A menu item that reports its `id` to the page when chosen.
final class CommandItem: NSMenuItem {
    var commandId = ""
    var specEnabled = true
}

// MARK: - Key equivalents

enum KeyEquivalent {
    private static let named: [String: Int] = [
        "enter": 0x0D, "return": 0x0D, "tab": 0x09, "backspace": 0x08, "delete": 0x7F,
        "escape": 0x1B, "esc": 0x1B, "space": 0x20, "plus": 0x2B,
        "up": NSUpArrowFunctionKey, "down": NSDownArrowFunctionKey,
        "left": NSLeftArrowFunctionKey, "right": NSRightArrowFunctionKey,
        "home": NSHomeFunctionKey, "end": NSEndFunctionKey,
        "pageup": NSPageUpFunctionKey, "pagedown": NSPageDownFunctionKey,
    ]

    /// Parses `cmd+shift+s`, `ctrl+\``, `f8`, `cmd+up`, … into an AppKit key equivalent.
    static func parse(_ spec: String) throws -> (key: String, modifiers: NSEvent.ModifierFlags) {
        var tokens = spec.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        if spec == "+" || spec.hasSuffix("++") {
            // The key itself is "+": "cmd++" splits into ["cmd", "", ""].
            tokens = Array(tokens.dropLast(2)) + ["+"]
        }
        guard let last = tokens.last, !last.isEmpty else { throw BridgeError("invalid key \"\(spec)\"") }

        var modifiers: NSEvent.ModifierFlags = []
        for token in tokens.dropLast() {
            switch token.lowercased() {
            case "cmd", "command", "meta": modifiers.insert(.command)
            case "shift": modifiers.insert(.shift)
            case "alt", "option", "opt": modifiers.insert(.option)
            case "ctrl", "control": modifiers.insert(.control)
            default: throw BridgeError("invalid key \"\(spec)\": unknown modifier \"\(token)\"")
            }
        }

        let name = last.lowercased()
        if let code = named[name], let scalar = Unicode.Scalar(code) {
            return (String(Character(scalar)), modifiers)
        }
        if name.hasPrefix("f"), let n = Int(name.dropFirst()), (1...24).contains(n),
           let scalar = Unicode.Scalar(NSF1FunctionKey + n - 1) {
            return (String(Character(scalar)), modifiers)
        }
        guard name.count == 1 else { throw BridgeError("invalid key \"\(spec)\": unknown key \"\(last)\"") }
        return (name, modifiers)
    }
}

// MARK: - Builder

/// Turns MenuSpec / MenuItemSpec JSON into NSMenu objects.
final class MenuBuilder {
    private struct Role {
        let title: String
        let action: Selector
        let key: String?
    }

    private static let roles: [String: Role] = {
        let app = AppPaths.appName
        return [
            "about": Role(title: "About \(app)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), key: nil),
            "quit": Role(title: "Quit \(app)", action: #selector(NSApplication.terminate(_:)), key: "cmd+q"),
            "hide": Role(title: "Hide \(app)", action: #selector(NSApplication.hide(_:)), key: "cmd+h"),
            "hideOthers": Role(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), key: "cmd+alt+h"),
            "showAll": Role(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), key: nil),
            "minimize": Role(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), key: "cmd+m"),
            "zoom": Role(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), key: nil),
            "bringAllToFront": Role(title: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), key: nil),
            "toggleFullScreen": Role(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), key: "ctrl+cmd+f"),
            "close": Role(title: "Close Window", action: #selector(NSWindow.performClose(_:)), key: "cmd+w"),
            "showTabBar": Role(title: "Show Tab Bar", action: #selector(NSWindow.toggleTabBar(_:)), key: nil),
            "showAllTabs": Role(title: "Show All Tabs", action: #selector(NSWindow.toggleTabOverview(_:)), key: "cmd+shift+\\"),
            "mergeAllWindows": Role(title: "Merge All Windows", action: #selector(NSWindow.mergeAllWindows(_:)), key: nil),
            "selectPreviousTab": Role(title: "Show Previous Tab", action: #selector(NSWindow.selectPreviousTab(_:)), key: "ctrl+shift+tab"),
            "selectNextTab": Role(title: "Show Next Tab", action: #selector(NSWindow.selectNextTab(_:)), key: "ctrl+tab"),
            "moveTabToNewWindow": Role(title: "Move Tab to New Window", action: #selector(NSWindow.moveTabToNewWindow(_:)), key: nil),
            "undo": Role(title: "Undo", action: Selector(("undo:")), key: "cmd+z"),
            "redo": Role(title: "Redo", action: Selector(("redo:")), key: "cmd+shift+z"),
            "cut": Role(title: "Cut", action: #selector(NSText.cut(_:)), key: "cmd+x"),
            "copy": Role(title: "Copy", action: #selector(NSText.copy(_:)), key: "cmd+c"),
            "paste": Role(title: "Paste", action: #selector(NSText.paste(_:)), key: "cmd+v"),
            "pasteAndMatchStyle": Role(title: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), key: "cmd+alt+shift+v"),
            "selectAll": Role(title: "Select All", action: #selector(NSText.selectAll(_:)), key: "cmd+a"),
            "delete": Role(title: "Delete", action: #selector(NSText.delete(_:)), key: nil),
            "startSpeaking": Role(title: "Start Speaking", action: #selector(NSTextView.startSpeaking(_:)), key: nil),
            "stopSpeaking": Role(title: "Stop Speaking", action: #selector(NSTextView.stopSpeaking(_:)), key: nil),
            "emojiPicker": Role(title: "Emoji & Symbols", action: #selector(NSApplication.orderFrontCharacterPalette(_:)), key: "ctrl+cmd+space"),
            "startDictation": Role(title: "Start Dictation…", action: Selector(("startDictation:")), key: nil),
            // Spelling and substitutions: WKWebView implements and validates these itself (check marks included).
            "showSpelling": Role(title: "Show Spelling and Grammar", action: #selector(NSTextView.showGuessPanel(_:)), key: "cmd+:"),
            "checkSpelling": Role(title: "Check Document Now", action: #selector(NSText.checkSpelling(_:)), key: "cmd+;"),
            "toggleGrammar": Role(title: "Check Grammar With Spelling", action: #selector(NSTextView.toggleGrammarChecking(_:)), key: nil),
            "toggleSpellCorrection": Role(title: "Correct Spelling Automatically", action: #selector(NSTextView.toggleAutomaticSpellingCorrection(_:)), key: nil),
            "toggleTextReplacement": Role(title: "Text Replacement", action: #selector(NSTextView.toggleAutomaticTextReplacement(_:)), key: nil),
            "showSubstitutions": Role(title: "Show Substitutions", action: #selector(NSTextView.orderFrontSubstitutionsPanel(_:)), key: nil),
        ]
    }()

    private let commandTarget: AnyObject
    private let commandAction: Selector
    private(set) var itemsById: [String: [CommandItem]] = [:]
    private(set) var windowsMenu: NSMenu?
    private(set) var servicesMenu: NSMenu?
    private(set) var helpMenu: NSMenu?

    init(commandTarget: AnyObject, commandAction: Selector) {
        self.commandTarget = commandTarget
        self.commandAction = commandAction
    }

    /// Builds the whole menu bar. The first spec becomes the application menu.
    func mainMenu(_ specs: [Any]) throws -> NSMenu {
        let bar = NSMenu(title: "Main Menu")
        for (index, raw) in specs.enumerated() {
            guard let spec = raw as? [String: Any], let items = spec["items"] as? [Any] else {
                throw BridgeError("menus[\(index)] must be { title, items }")
            }
            let title = index == 0 ? AppPaths.appName : (spec["title"] as? String ?? "")
            let menu = try self.menu(items, title: title)
            if spec["role"] as? String == "help" { helpMenu = menu }
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = menu
            bar.addItem(holder)
        }
        return bar
    }

    func menu(_ specs: [Any], title: String = "") throws -> NSMenu {
        let menu = NSMenu(title: title)
        for raw in specs {
            guard let spec = raw as? [String: Any] else { throw BridgeError("menu item must be an object") }
            if let item = try self.item(spec, in: menu) { menu.addItem(item) }
        }
        return menu
    }

    private func item(_ spec: [String: Any], in menu: NSMenu) throws -> NSMenuItem? {
        if spec["separator"] as? Bool == true { return .separator() }
        let title = spec["title"] as? String

        if let role = spec["role"] as? String {
            return try roleItem(role, spec: spec, title: title, in: menu)
        }
        if let children = spec["items"] as? [Any] {
            let item = NSMenuItem(title: title ?? "", action: nil, keyEquivalent: "")
            item.submenu = try self.menu(children, title: title ?? "")
            return item
        }
        guard let id = spec["id"] as? String, !id.isEmpty else {
            throw BridgeError("menu item \"\(title ?? "?")\" needs one of: separator, items, id, role")
        }
        let item = CommandItem(title: title ?? id, action: commandAction, keyEquivalent: "")
        item.target = commandTarget
        item.commandId = id
        item.specEnabled = spec["enabled"] as? Bool ?? true
        item.state = spec["checked"] as? Bool == true ? .on : .off
        try applyKey(spec["key"] as? String, to: item)
        itemsById[id, default: []].append(item)
        return item
    }

    private func roleItem(_ role: String, spec: [String: Any], title: String?, in menu: NSMenu) throws -> NSMenuItem? {
        let key = spec["key"] as? String
        switch role {
        case "services":
            let item = NSMenuItem(title: title ?? "Services", action: nil, keyEquivalent: "")
            let submenu = NSMenu(title: item.title)
            item.submenu = submenu
            servicesMenu = submenu
            return item
        case "windowList":
            windowsMenu = menu // AppKit appends the open windows itself
            return nil
        case "importFromDevice":
            // Continuity Camera. In the menu bar AppKit recognises the identifier, replaces the title with its own
            // (system-localised) one and attaches a submenu of the nearby devices; it must not be handed a submenu
            // of ours. The pictures arrive through the services requestor on the web view (see ImageImportReceiver).
            let item = NSMenuItem(title: title ?? "Import from iPhone or iPad", action: nil, keyEquivalent: "")
            item.identifier = NSMenuItem.importFromDeviceIdentifier
            return item
        case "devtools":
            guard MenuManager.inspectorAvailable else { return nil }
            let item = NSMenuItem(title: title ?? "Toggle Developer Tools", action: #selector(MenuManager.openDevTools(_:)), keyEquivalent: "")
            item.target = MenuManager.shared
            try applyKey(key ?? "cmd+alt+i", to: item)
            return item
        default:
            guard let known = Self.roles[role] else { throw BridgeError("unknown menu role \"\(role)\"") }
            // Nil target: the action travels the responder chain, so it works in the web view and in native fields.
            let item = NSMenuItem(title: title ?? known.title, action: known.action, keyEquivalent: "")
            try applyKey(key ?? known.key, to: item)
            return item
        }
    }

    private func applyKey(_ key: String?, to item: NSMenuItem) throws {
        guard let key = key, !key.isEmpty else { return }
        let parsed = try KeyEquivalent.parse(key)
        item.keyEquivalent = parsed.key
        item.keyEquivalentModifierMask = parsed.modifiers
    }
}

// MARK: - Manager

/// Owns the installed main menu. The menu bar is app-wide, so it always shows the spec of one window (its owner).
final class MenuManager: NSObject, NSMenuItemValidation {
    static let shared = MenuManager()

    static let inspectorAvailable = WKWebView.instancesRespond(to: NSSelectorFromString("_inspector"))

    private(set) weak var owner: WindowController?
    private var itemsById: [String: [CommandItem]] = [:]
    private var popupChoice: String?
    private(set) var activePopup: NSMenu?

    private static let defaultSpec: [Any] = [
        ["title": "Livemark", "items": [
            ["role": "about"], ["separator": true], ["role": "services"], ["separator": true],
            ["role": "hide"], ["role": "hideOthers"], ["role": "showAll"], ["separator": true], ["role": "quit"],
        ]],
        ["title": "Edit", "items": [
            ["role": "undo"], ["role": "redo"], ["separator": true],
            ["role": "cut"], ["role": "copy"], ["role": "paste"], ["role": "selectAll"],
        ]],
        ["title": "Window", "items": [
            ["role": "minimize"], ["role": "zoom"], ["role": "close"], ["separator": true],
            ["role": "bringAllToFront"], ["role": "windowList"],
        ]],
    ]

    /// The minimal menu shown until a page calls `menu.set`.
    func installDefaultMenu() {
        try? install(spec: Self.defaultSpec, overrides: [:], owner: nil)
    }

    func install(spec: [Any], overrides: [String: [String: Any]], owner: WindowController?) throws {
        let builder = MenuBuilder(commandTarget: self, commandAction: #selector(menuCommand(_:)))
        let menu = try builder.mainMenu(spec)
        itemsById = builder.itemsById
        for (id, state) in overrides { apply(state, to: id) }
        NSApp.mainMenu = menu
        Self.refreshImportItems(in: menu)
        NSApp.windowsMenu = builder.windowsMenu
        NSApp.servicesMenu = builder.servicesMenu
        NSApp.helpMenu = builder.helpMenu
        self.owner = owner
    }

    /// AppKit turns a Continuity Camera item into its device submenu once it is in the menu bar, but leaves a
    /// placeholder title until that submenu is first updated. Do that now instead of when the user gets there.
    private static func refreshImportItems(in menu: NSMenu) {
        for item in menu.items {
            guard let submenu = item.submenu else { continue }
            if item.identifier == NSMenuItem.importFromDeviceIdentifier { submenu.update() } else { refreshImportItems(in: submenu) }
        }
    }

    /// Cheap state change of installed items: `{ checked?, enabled?, title? }`.
    func apply(_ state: [String: Any], to id: String) {
        for item in itemsById[id] ?? [] {
            if let checked = state["checked"] as? Bool { item.state = checked ? .on : .off }
            if let enabled = state["enabled"] as? Bool { item.specEnabled = enabled }
            if let title = state["title"] as? String { item.title = title }
        }
    }

    func items(withId id: String) -> [CommandItem] { itemsById[id] ?? [] }

    func ownerClosed(_ controller: WindowController) {
        if owner === controller { owner = nil }
    }

    /// The window a menu command is meant for: the main window, else whoever installed the menu.
    private func targetController() -> WindowController? {
        if let main = NSApp.mainWindow?.delegate as? WindowController { return main }
        if let key = NSApp.keyWindow?.delegate as? WindowController { return key }
        return owner
    }

    @objc func menuCommand(_ sender: Any?) {
        guard let item = sender as? CommandItem else { return }
        if let controller = targetController() {
            controller.emit("command", ["id": item.commandId])
        } else if let app = NSApp.delegate as? AppDelegate, app.controllers.isEmpty, !app.headless {
            // Every window is closed (the app stays open unless settings.quitOnLastWindow): there is no page to run
            // the command, so any page command simply brings a window back.
            app.newWindow(openPath: nil)
        }
    }

    @objc func popupCommand(_ sender: Any?) {
        popupChoice = (sender as? CommandItem)?.commandId
    }

    @objc func openDevTools(_ sender: Any?) {
        // WKWebView has no public API to open the inspector; fall back to doing nothing.
        guard let webView = targetController()?.webView else { return }
        let getter = NSSelectorFromString("_inspector"), show = NSSelectorFromString("show")
        guard webView.responds(to: getter),
              let inspector = webView.perform(getter)?.takeUnretainedValue() as? NSObject,
              inspector.responds(to: show) else { return }
        _ = inspector.perform(show)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let item = menuItem as? CommandItem else { return true }
        if item.action == #selector(popupCommand(_:)) { return item.specEnabled }
        if targetController() != nil { return item.specEnabled }
        return (NSApp.delegate as? AppDelegate)?.controllers.isEmpty == true // no windows: see menuCommand
    }

    /// Shows a context menu at `point` (view coordinates). `completion` gets the chosen id, or nil if dismissed.
    func popup(_ specs: [Any], in view: NSView, at point: NSPoint, completion: @escaping (String?) -> Void) throws {
        let builder = MenuBuilder(commandTarget: self, commandAction: #selector(popupCommand(_:)))
        let menu = try builder.menu(specs)
        popupChoice = nil
        activePopup = menu
        // popUp blocks in a tracking loop until the menu closes. Start it from a run-loop turn of its own, and not
        // from a main-queue block: the main dispatch queue is serial and would stay stalled for as long as the menu is open.
        RunLoop.main.perform(inModes: [.common]) {
            menu.popUp(positioning: nil, at: point, in: view)
            // The chosen item's action may be delivered just after popUp returns.
            DispatchQueue.main.async {
                self.activePopup = nil
                completion(self.popupChoice)
            }
        }
    }
}
