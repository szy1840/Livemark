import Cocoa
import UniformTypeIdentifiers

/// An error whose message is handed to the page as the promise rejection reason.
struct BridgeError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

func describe(_ error: Error) -> String {
    if let e = error as? BridgeError { return e.message }
    return (error as NSError).localizedDescription
}

// MARK: - Paths

enum AppPaths {
    static let home = NSHomeDirectory()

    static let documents: String =
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.path ?? home + "/Documents"

    static let defaultAppSupport: String = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.path
            ?? home + "/Library/Application Support"
        return base + "/Livemark"
    }()

    /// Set before first use to keep a run away from the user's real settings (selftest does this).
    static var appSupportOverride: String?

    /// `~/Library/Application Support/Livemark` (or `LIVEMARK_APP_SUPPORT`), created on first use.
    static let appSupport: String = {
        var dir = defaultAppSupport
        if let override = appSupportOverride ?? ProcessInfo.processInfo.environment["LIVEMARK_APP_SUPPORT"], override.hasPrefix("/") {
            dir = override
        }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }()

    /// `LIVEMARK_WEB_ROOT` (absolute directory) for development, else `Contents/Resources/web`.
    static let webRoot: URL = {
        if let override = ProcessInfo.processInfo.environment["LIVEMARK_WEB_ROOT"], override.hasPrefix("/") {
            return URL(fileURLWithPath: override, isDirectory: true).standardizedFileURL
        }
        let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: Bundle.main.bundlePath)
        return resources.appendingPathComponent("web", isDirectory: true).standardizedFileURL
    }()

    static let version: String =
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"

    static let appName: String =
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? "Livemark"

    /// First existing pandoc binary: well-known locations, then PATH.
    static let pandoc: String? = {
        // Scripted checks of the "Pandoc is needed" dialogs run as if it were not installed.
        if ProcessInfo.processInfo.environment["LIVEMARK_NO_PANDOC"] != nil { return nil }
        var candidates = ["/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc", "/usr/bin/pandoc"]
        for dir in (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":") where dir.hasPrefix("/") {
            candidates.append(dir + "/pandoc")
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }()
}

// MARK: - Command arguments

/// Validating accessor for the `args` object of a bridge message.
struct Args {
    let cmd: String
    let dict: [String: Any]

    private func fail(_ key: String, _ expected: String) -> BridgeError {
        BridgeError("\(cmd): \"\(key)\" must be \(expected)")
    }

    func has(_ key: String) -> Bool {
        guard let value = dict[key] else { return false }
        return !(value is NSNull)
    }

    func string(_ key: String) throws -> String {
        guard let value = dict[key] as? String else { throw fail(key, "a string") }
        return value
    }

    func optString(_ key: String) throws -> String? {
        has(key) ? try string(key) : nil
    }

    func bool(_ key: String, default fallback: Bool) throws -> Bool {
        guard has(key) else { return fallback }
        guard let value = dict[key] as? Bool else { throw fail(key, "a boolean") }
        return value
    }

    func number(_ key: String) throws -> Double? {
        guard has(key) else { return nil }
        guard let value = dict[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else {
            throw fail(key, "a finite number")
        }
        return value.doubleValue
    }

    func stringArray(_ key: String) throws -> [String]? {
        guard has(key) else { return nil }
        guard let value = dict[key] as? [String] else { throw fail(key, "an array of strings") }
        return value
    }

    /// An absolute filesystem path (a leading `~` is expanded).
    func path(_ key: String) throws -> String {
        let raw = try string(key)
        let expanded = (raw as NSString).expandingTildeInPath
        guard expanded.hasPrefix("/"), !expanded.contains("\0") else { throw fail(key, "an absolute path") }
        return expanded
    }

    func optPath(_ key: String) throws -> String? {
        has(key) ? try path(key) : nil
    }

    func object(_ key: String) throws -> [String: Any]? {
        guard has(key) else { return nil }
        guard let value = dict[key] as? [String: Any] else { throw fail(key, "an object") }
        return value
    }
}

// MARK: - Reply

/// Wraps the WebKit reply handler: answers exactly once, always on the main thread.
final class Reply {
    private var handler: ((Any?, String?) -> Void)?
    private let lock = NSLock()

    init(_ handler: @escaping (Any?, String?) -> Void) { self.handler = handler }

    private func take() -> ((Any?, String?) -> Void)? {
        lock.lock(); defer { lock.unlock() }
        let h = handler
        handler = nil
        return h
    }

    private func deliver(_ value: Any?, _ error: String?) {
        guard let h = take() else { return }
        if Thread.isMainThread { h(value, error) } else { DispatchQueue.main.async { h(value, error) } }
    }

    func ok(_ value: Any = true) { deliver(value, nil) }
    func fail(_ message: String) { deliver(nil, message) }

    deinit {
        // WebKit raises if a reply handler is dropped without being called.
        if let h = handler { DispatchQueue.main.async { h(nil, "internal error: command produced no reply") } }
    }
}

// MARK: - MIME types

enum Mime {
    private static let table: [String: String] = [
        "html": "text/html", "htm": "text/html", "xhtml": "application/xhtml+xml",
        "js": "text/javascript", "mjs": "text/javascript", "cjs": "text/javascript",
        "css": "text/css", "json": "application/json", "map": "application/json",
        "md": "text/markdown", "markdown": "text/markdown", "mdown": "text/markdown",
        "txt": "text/plain", "csv": "text/csv", "xml": "application/xml", "yaml": "text/yaml", "yml": "text/yaml",
        "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
        "webp": "image/webp", "avif": "image/avif", "bmp": "image/bmp", "ico": "image/x-icon",
        "tif": "image/tiff", "tiff": "image/tiff", "heic": "image/heic",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf", "eot": "application/vnd.ms-fontobject",
        "wasm": "application/wasm", "pdf": "application/pdf",
        "mp4": "video/mp4", "m4v": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
        "mp3": "audio/mpeg", "m4a": "audio/mp4", "wav": "audio/wav", "ogg": "audio/ogg", "flac": "audio/flac",
    ]

    static func type(forPath path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        if let known = table[ext] { return known }
        if !ext.isEmpty, let type = UTType(filenameExtension: ext)?.preferredMIMEType { return type }
        return "application/octet-stream"
    }

    /// Value for a `Content-Type` header (text formats are served as UTF-8).
    static func contentType(forPath path: String) -> String {
        let type = self.type(forPath: path)
        let textual = type.hasPrefix("text/") || ["application/json", "application/xml", "image/svg+xml"].contains(type)
        return textual ? type + "; charset=utf-8" : type
    }
}

// MARK: - Debug log

/// `LIVEMARK_DEBUG=1` prints window lifecycle, events, failed bridge calls and page JS errors to stderr.
enum Log {
    static let enabled = ProcessInfo.processInfo.environment["LIVEMARK_DEBUG"] != nil

    static func debug(_ message: @autoclosure () -> String) {
        guard enabled else { return }
        FileHandle.standardError.write(Data("[livemark] \(message())\n".utf8))
    }

    /// Forwards uncaught page errors and console.error to the `debug.log` bridge command.
    static let pageErrorHook = """
        (function () {
          const send = (message) => { try { window.webkit.messageHandlers.livemark.postMessage({ cmd: 'debug.log', args: { message: String(message) } }).catch(() => {}); } catch (e) {} };
          window.addEventListener('error', (e) => send(e.message ? e.message + ' (' + (e.filename || '?') + ':' + (e.lineno || 0) + ')' : 'resource failed to load: ' + ((e.target && (e.target.src || e.target.href)) || 'unknown')), true);
          window.addEventListener('unhandledrejection', (e) => send('unhandled rejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));
          const original = console.error;
          console.error = function (...args) { send('console.error: ' + args.map(String).join(' ')); return original.apply(console, args); };
        })();
        """
}

// MARK: - Misc

extension NSAppearance {
    var isDark: Bool { bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }
}

func modificationTimeMs(_ attributes: [FileAttributeKey: Any]) -> Double {
    guard let date = attributes[.modificationDate] as? Date else { return 0 }
    return (date.timeIntervalSince1970 * 1000).rounded()
}

func creationTimeMs(_ attributes: [FileAttributeKey: Any]) -> Double {
    guard let date = attributes[.creationDate] as? Date else { return 0 }
    return (date.timeIntervalSince1970 * 1000).rounded()
}
