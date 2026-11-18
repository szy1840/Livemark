import Cocoa
import Carbon
import WebKit
import Quartz
import UniformTypeIdentifiers

// MARK: - Commands

extension WindowController {
    /// Window chrome, Quick Look, Touch Bar and spelling. Returns false if `cmd` is not one of them.
    func runSystemCommand(_ cmd: String, _ a: Args, _ reply: Reply) throws -> Bool {
        switch cmd {
        case "text.lookUp":
            // The system dictionary panel for a word or phrase, at the point clicked (CSS px).
            let text = try a.string("text")
            let x = try a.number("x") ?? 0
            let y = try a.number("y") ?? 0
            reply.ok()
            guard !headless else { break }
            let point = NSPoint(x: x, y: webView.isFlipped ? y : Double(webView.bounds.height) - y)
            webView.showDefinition(for: NSAttributedString(string: text), at: point)

        case "fs.showInfo":
            // Finder's Get Info window for a file (the Finder service, as the Services menu runs it).
            let path = try a.path("path")
            guard FileManager.default.fileExists(atPath: path) else { throw BridgeError("\(cmd): \"\(path)\" does not exist") }
            let board = NSPasteboard(name: NSPasteboard.Name("livemark.showInfo"))
            board.clearContents()
            board.writeObjects([URL(fileURLWithPath: path) as NSURL])
            reply.ok(headless ? false : NSPerformService("Finder/Show Info", board))

        case "app.noteRecent":
            // The system's list of recent documents (Dock menu, Apple menu > Recent Items).
            let path = try a.path("path")
            reply.ok()
            if !headless { NSDocumentController.shared.noteNewRecentDocumentURL(URL(fileURLWithPath: path)) }

        case "fs.watch":
            FolderWatcher.watch(try a.optPath("path"), for: self)
            reply.ok()

        case "fs.watchFile":
            FolderWatcher.watch(try a.optPath("path"), for: self, file: true)
            reply.ok()

        case "file.quickLook":
            let path = try a.path("path")
            guard FileManager.default.fileExists(atPath: path) else { throw BridgeError("\(cmd): \"\(path)\" does not exist") }
            reply.ok()
            guard !headless, let panel = QLPreviewPanel.shared() else { break }
            window.quickLook.urls = [URL(fileURLWithPath: path)]
            if panel.isVisible {
                panel.updateController()
                panel.reloadData()
            } else {
                panel.makeKeyAndOrderFront(nil)
            }

        case "window.setStyle":
            guard let style = WindowStyle(rawValue: try a.string("style")) else {
                throw BridgeError("\(cmd): \"style\" must be \"classic\" or \"unibody\"")
            }
            setWindowStyle(style)
            reply.ok()

        case "window.setChrome":
            // The window follows the theme: its background (seen while resizing and behind a transparent
            // title bar), dark or light controls, and the title kept clear of a showing sidebar.
            if let rgb = a.dict["background"] as? [NSNumber], rgb.count >= 3 {
                let c = rgb.map { CGFloat($0.doubleValue) }
                window.backgroundColor = NSColor(srgbRed: c[0] / 255, green: c[1] / 255, blue: c[2] / 255, alpha: 1)
            } else {
                window.backgroundColor = Self.backgroundColor
            }
            if let dark = a.dict["dark"] as? Bool {
                window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            } else {
                window.appearance = nil
            }
            keepSystemAppearanceInPage()
            setTitleInset((a.dict["titleInset"] as? NSNumber).map { CGFloat($0.doubleValue) })
            reply.ok()

        case "system.keyboardLayout":
            // The current keyboard layout's name (the editor treats ' as a letter on a Ukrainian layout).
            // Its name and its id (com.apple.keylayout.German…): the id is the same in every UI language.
            guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
                  let raw = TISGetInputSourceProperty(source, kTISPropertyLocalizedName) else { reply.ok(""); break }
            let name = Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String
            let id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID).map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
            reply.ok(id.isEmpty ? name : "\(name) \(id)")

        case "window.setMagnification":
            guard a.has("on") else { throw BridgeError("\(cmd): \"on\" must be a boolean") }
            let on = try a.bool("on", default: false)
            webView.allowsMagnification = on
            if !on, webView.magnification != 1 { webView.magnification = 1 } // do not leave the page stuck zoomed in
            reply.ok()

        case "window.commandAll":
            // The same event a menu item sends, to every open window ("Save All").
            let id = try a.string("id")
            let all = app?.controllers ?? [self]
            for controller in all { controller.emit("command", ["id": id]) }
            reply.ok(all.count)

        case "touchbar.set":
            guard let mode = TouchBarMode(rawValue: try a.string("mode")) else {
                throw BridgeError("\(cmd): \"mode\" must be one of \(TouchBarMode.allCases.map { $0.rawValue }.joined(separator: ", "))")
            }
            setTouchBarMode(mode)
            // What is lit (inline styles at the caret, find options), stepper values and button titles.
            touchBarProvider.setState(a.dict["state"] as? [String: Any] ?? [:])
            reply.ok()

        case "spell.info":
            let checker = NSSpellChecker.shared
            let locale = Locale.current
            let languages = checker.availableLanguages.map { id -> [String: Any] in
                ["id": id, "name": locale.localizedString(forIdentifier: id) ?? id]
            }
            reply.ok(["languages": languages, "current": checker.language(), "auto": checker.automaticallyIdentifiesLanguages] as [String: Any])

        case "spell.setLanguage":
            let language = try a.string("language")
            let checker = NSSpellChecker.shared
            if language == "auto" {
                checker.automaticallyIdentifiesLanguages = true
            } else {
                // setLanguage(_:) also takes near misses ("en" for "en_US"); the page passes ids from spell.info.
                guard checker.availableLanguages.contains(language) else { throw BridgeError("\(cmd): no spelling dictionary for \"\(language)\"") }
                checker.automaticallyIdentifiesLanguages = false
                guard checker.setLanguage(language) else { throw BridgeError("\(cmd): \"\(language)\" could not be selected") }
            }
            reply.ok()

        case "spell.check":
            // Is the word unknown to the checker, and is it one the user taught it?
            let word = try a.string("word")
            let checker = NSSpellChecker.shared
            // One word is too short for automatic language detection, which then flags
            // nothing: check it in the checker's current language.
            let language = checker.language()
            var count = 0
            let miss = checker.checkSpelling(of: word, startingAt: 0, language: language, wrap: false, inSpellDocumentWithTag: 0, wordCount: &count)
            // The checker's corrections, as the system's own context menu lists them.
            let guesses = miss.location == NSNotFound ? [] : (checker.guesses(forWordRange: NSRange(location: 0, length: (word as NSString).length), in: word, language: language, inSpellDocumentWithTag: 0) ?? [])
            reply.ok(["misspelled": miss.location != NSNotFound, "learned": checker.hasLearnedWord(word), "guesses": Array(guesses.prefix(8))] as [String: Any])

        case "spell.learn":
            NSSpellChecker.shared.learnWord(try a.string("word"))
            reply.ok()

        case "spell.unlearn":
            NSSpellChecker.shared.unlearnWord(try a.string("word"))
            reply.ok()

        case "image.scale":
            // Pixels per point of the picture's first representation: 2 for a Retina screenshot.
            // 1 when the file cannot be read.
            let src = try a.string("url")
            DispatchQueue.global(qos: .userInitiated).async {
                var scale = 1.0
                let url = src.hasPrefix("/") ? URL(fileURLWithPath: src) : URL(string: src)
                if let url, let image = NSImage(contentsOf: url), let rep = image.representations.first, rep.pixelsWide > 0, image.size.width > 0 {
                    scale = Double(rep.pixelsWide) / Double(image.size.width)
                }
                reply.ok(scale)
            }

        case "system.quotes":
            // The quote characters chosen in System Settings → Keyboard → Text.
            let quotes = (UserDefaults.standard.array(forKey: "NSUserQuotesArray") as? [String]) ?? ["\u{201C}", "\u{201D}", "\u{2018}", "\u{2019}"]
            reply.ok(quotes)

        default:
            return false
        }
        return true
    }

    func setTouchBarMode(_ mode: TouchBarMode) {
        guard mode != touchBarProvider.mode else { return }
        // The system watches the responder's `touchBar` property.
        webView.willChangeValue(forKey: "touchBar")
        touchBarProvider.mode = mode
        webView.didChangeValue(forKey: "touchBar")
    }
}

// MARK: - Quick Look

/// Data source of the shared Quick Look panel while a document window controls it.
final class QuickLookSource: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    var urls: [URL] = []

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        urls.count
    }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        urls.indices.contains(index) ? urls[index] as NSURL : nil
    }
}

// MARK: - Open panel that can pick TextBundles

/// Delegate of an open panel whose extension list includes "textbundle". Files are filtered by extension / content
/// type as usual; directories can be browsed, and only those named `*.textbundle` can be chosen.
final class BundleAwareOpenPanel: NSObject, NSOpenSavePanelDelegate {
    static let bundleExtension = "textbundle"

    /// Narrowed by the "File Format" pop-up, when the panel has one.
    var extensions: Set<String>
    var types: [UTType]
    /// File → Open… also opens folders (as the sidebar's root), so "Open" on a folder chooses it.
    private let foldersToo: Bool

    init(extensions: [String], types: [UTType], foldersToo: Bool = false) {
        self.extensions = Set(extensions)
        self.types = types
        self.foldersToo = foldersToo
    }

    static func isBundle(_ url: URL) -> Bool {
        url.pathExtension.lowercased() == bundleExtension
    }

    private static func isDirectory(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
    }

    func panel(_ sender: Any, shouldEnable url: URL) -> Bool {
        if Self.isDirectory(url) { return true } // a bundle, or a folder to look into
        if extensions.contains(url.pathExtension.lowercased()) { return true }
        guard let type = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType else { return false }
        return types.contains { type.conforms(to: $0) }
    }

    /// The panel may choose directories so that bundles can be picked. "Open" on any other folder just goes into it.
    func panel(_ sender: Any, validate url: URL) throws {
        guard !foldersToo, Self.isDirectory(url), !Self.isBundle(url) else { return }
        if let panel = sender as? NSOpenPanel, panel.directoryURL?.standardizedFileURL != url.standardizedFileURL {
            DispatchQueue.main.async { panel.directoryURL = url }
        }
        throw CocoaError(.userCancelled) // keeps the panel open without an alert
    }
}

// MARK: - Continuity Camera

/// Takes the picture that "Import from iPhone or iPad" returns, stores it under `appSupport/imports/` and hands
/// it to the page like a dropped file.
final class ImageImportReceiver: NSObject, NSServicesMenuRequestor {
    weak var controller: WindowController?

    private static let jpeg = NSPasteboard.PasteboardType("public.jpeg")

    /// Raster image types only, so that a document scan arrives as pictures and not as a PDF.
    static func accepts(_ type: NSPasteboard.PasteboardType) -> Bool {
        guard let uti = UTType(type.rawValue) else { return false }
        return uti.conforms(to: .image) && !uti.conforms(to: .pdf)
    }

    static var directory: String { AppPaths.appSupport + "/imports" }

    func readSelection(from pboard: NSPasteboard) -> Bool {
        var images: [(data: Data, ext: String)] = (pboard.pasteboardItems ?? []).compactMap { Self.image(in: $0) }
        if images.isEmpty, let image = NSImage(pasteboard: pboard), let png = Self.png(from: image) {
            images = [(png, "png")] // whatever else AppKit can turn into a picture
        }
        var paths: [String] = []
        for image in images {
            if let path = try? Self.store(image.data, ext: image.ext) { paths.append(path) }
        }
        guard !paths.isEmpty else { return false }
        controller?.emit("dropFiles", ["paths": paths])
        return true
    }

    /// JPEG and PNG are kept as they are; any other image format is converted to PNG.
    private static func image(in item: NSPasteboardItem) -> (data: Data, ext: String)? {
        if let data = item.data(forType: jpeg) { return (data, "jpg") }
        if let data = item.data(forType: .png) { return (data, "png") }
        for type in item.types where accepts(type) {
            if let data = item.data(forType: type), let image = NSImage(data: data), let png = png(from: image) { return (png, "png") }
        }
        return nil
    }

    private static func png(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        return bitmap.representation(using: .png, properties: [:])
    }

    private static func store(_ data: Data, ext: String) throws -> String {
        let fm = FileManager.default
        try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let stem = "import-" + formatter.string(from: Date())
        var path = "\(directory)/\(stem).\(ext)"
        var n = 2
        while fm.fileExists(atPath: path) {
            path = "\(directory)/\(stem)-\(n).\(ext)"
            n += 1
        }
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        return path
    }
}

/// "File Format: [All Supported Formats ▾]" under an open panel: narrows the files that can be picked.
final class FormatAccessory: NSObject {
    private weak var panel: NSOpenPanel?
    private let guide: BundleAwareOpenPanel?
    private let all: [String]
    private let formats: [(name: String, extensions: [String])]

    init(panel: NSOpenPanel, guide: BundleAwareOpenPanel?, all: [String], formats: [(name: String, extensions: [String])], labels: [String: String]) {
        self.panel = panel
        self.guide = guide
        self.all = all
        self.formats = formats
        super.init()
        let label = NSTextField(labelWithString: labels["label"] ?? "File Format:")
        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.addItem(withTitle: labels["all"] ?? "All Supported Formats")
        popup.menu?.addItem(.separator())
        for format in formats { popup.addItem(withTitle: format.name) }
        popup.target = self
        popup.action = #selector(changed(_:))
        let row = NSStackView(views: [label, popup])
        row.orientation = .horizontal
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        panel.accessoryView = row
        panel.isAccessoryViewDisclosed = true
    }

    @objc private func changed(_ sender: NSPopUpButton) {
        let index = sender.indexOfSelectedItem - 2 // after "All" and the separator
        let picked = formats.indices.contains(index) ? formats[index].extensions : all
        let types = WindowController.contentTypes(picked)
        if let guide = guide {
            guide.extensions = Set(picked)
            guide.types = types
            panel?.validateVisibleColumns()
        } else {
            panel?.allowedContentTypes = types
        }
    }
}

/// "File Format: [Markdown ▾]" under a save panel: the format sets the file name's extension.
final class SaveFormatAccessory: NSObject {
    private weak var panel: NSSavePanel?
    private let formats: [(name: String, ext: String)]

    init(panel: NSSavePanel, formats: [(name: String, ext: String)], label: String) {
        self.panel = panel
        self.formats = formats
        super.init()
        let text = NSTextField(labelWithString: label)
        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        for format in formats { popup.addItem(withTitle: format.name) }
        let current = (panel.nameFieldStringValue as NSString).pathExtension.lowercased()
        if let k = formats.firstIndex(where: { $0.ext == current }) { popup.selectItem(at: k) }
        popup.target = self
        popup.action = #selector(changed(_:))
        let row = NSStackView(views: [text, popup])
        row.orientation = .horizontal
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        panel.accessoryView = row
    }

    @objc private func changed(_ sender: NSPopUpButton) {
        guard let panel = panel, formats.indices.contains(sender.indexOfSelectedItem) else { return }
        let ext = formats[sender.indexOfSelectedItem].ext
        let stem = ((panel.nameFieldStringValue as NSString).deletingPathExtension as NSString).lastPathComponent
        panel.allowedContentTypes = WindowController.contentTypes([ext])
        panel.nameFieldStringValue = "\(stem).\(ext)"
    }
}
