import Foundation

/// Commands that only touch the filesystem / child processes. They run off the main thread.
enum FileCommands {
    /// Validates `args` now and returns the work to run on a background queue, or nil for an unknown command.
    static func make(_ cmd: String, _ a: Args) throws -> (() throws -> Any)? {
        switch cmd {
        case "fs.readText":
            let path = try a.path("path")
            let encoding = try a.optString("encoding")
            return { try readText(path, encoding: encoding) }
        case "fs.writeText":
            let path = try a.path("path"), text = try a.string("text")
            return { try write(Data(text.utf8), to: path) }
        case "fs.writeBase64":
            let path = try a.path("path")
            let base64 = try a.string("base64").components(separatedBy: .whitespacesAndNewlines).joined()
            guard let data = Data(base64Encoded: base64) else {
                throw BridgeError("\(cmd): \"base64\" is not valid base64")
            }
            return { try write(data, to: path) }
        case "fs.readBase64":
            let path = try a.path("path")
            return {
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                return ["base64": data.base64EncodedString(), "mime": Mime.type(forPath: path)]
            }
        case "fs.list":
            let path = try a.path("path")
            let hidden = try a.bool("hidden", default: false)
            return { try list(path, hidden: hidden) }
        case "fs.stat":
            let path = try a.path("path")
            return { stat(path) }
        case "fs.mkdir":
            let path = try a.path("path")
            return {
                try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
                return true
            }
        case "fs.rename":
            let from = try a.path("from"), to = try a.path("to")
            return { try rename(from, to) }
        case "fs.copy":
            let from = try a.path("from"), to = try a.path("to")
            return {
                try createParent(of: to)
                try FileManager.default.copyItem(atPath: from, toPath: to)
                return true
            }
        case "fs.versions":
            // The versions macOS keeps of a file (saved by any app that uses document versions).
            let path = try a.path("path")
            return {
                let url = URL(fileURLWithPath: path)
                let versions = NSFileVersion.otherVersionsOfItem(at: url) ?? []
                return versions.compactMap { v -> [String: Any]? in
                    guard let date = v.modificationDate, let text = try? String(contentsOf: v.url, encoding: .utf8) else { return nil }
                    return ["t": date.timeIntervalSince1970 * 1000, "text": text, "by": v.localizedNameOfSavingComputer ?? ""]
                }
            }
        case "fs.trash":
            let path = try a.path("path")
            return {
                // Never a hard delete: the item goes to the user's Trash. Where it landed is
                // returned, so the page can put it back (undo).
                var landed: NSURL?
                try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: &landed)
                return ["trashed": (landed?.path as Any?) ?? NSNull()] as [String: Any]
            }
        case "fs.removePermanently":
            // Only after the user chose "Delete Permanently" when moving to the Trash failed.
            let path = try a.path("path")
            return {
                try FileManager.default.removeItem(at: URL(fileURLWithPath: path))
                return true
            }
        case "store.get":
            let key = try a.string("key")
            return { Store.shared.get(key) }
        case "store.keys":
            let prefix = try a.optString("prefix") ?? ""
            return { Store.shared.keys(prefix: prefix) }
        case "store.set":
            let key = try a.string("key")
            let value = a.dict["value"] ?? NSNull()
            guard JSONSerialization.isValidJSONObject([value]) else {
                throw BridgeError("\(cmd): \"value\" must be JSON-serializable")
            }
            return {
                try Store.shared.set(key, value)
                return true
            }
        case "uploader.run":
            // A command line the user typed into Settings (image uploader, custom export, after-export command);
            // any file paths are appended as quoted arguments.
            let command = try a.string("command")
            let files = try a.stringArray("files") ?? []
            guard !command.trimmingCharacters(in: .whitespaces).isEmpty else { throw BridgeError("\(cmd): no command is configured") }
            let quoted = files.map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }.joined(separator: " ")
            return { try runPandoc("/bin/zsh", args: ["-lc", files.isEmpty ? command : command + " " + quoted], stdin: nil, cwd: nil) }

        case "archive.unpack":
            // A TextPack is a zip of a TextBundle: unpacked with ditto into a folder of its own.
            let archive = try a.path("path"), to = try a.path("to")
            guard FileManager.default.fileExists(atPath: archive) else { throw BridgeError("\(cmd): \"\(archive)\" does not exist") }
            return {
                try? FileManager.default.removeItem(atPath: to)
                try FileManager.default.createDirectory(atPath: to, withIntermediateDirectories: true)
                let result = try runPandoc("/usr/bin/ditto", args: ["-x", "-k", archive, to], stdin: nil, cwd: nil)
                if let r = result as? [String: Any], (r["code"] as? Int ?? 0) != 0 { throw BridgeError("\(cmd): \(r["stderr"] as? String ?? "ditto failed")") }
                return true
            }

        case "archive.pack":
            let folder = try a.path("path"), to = try a.path("to")
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: folder, isDirectory: &isDir), isDir.boolValue else { throw BridgeError("\(cmd): \"\(folder)\" is not a folder") }
            return {
                let scratch = to + ".part"
                try? FileManager.default.removeItem(atPath: scratch)
                let result = try runPandoc("/usr/bin/ditto", args: ["-c", "-k", "--keepParent", folder, scratch], stdin: nil, cwd: nil)
                if let r = result as? [String: Any], (r["code"] as? Int ?? 0) != 0 { throw BridgeError("\(cmd): \(r["stderr"] as? String ?? "ditto failed")") }
                _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: to), withItemAt: URL(fileURLWithPath: scratch))
                return true
            }

        case "net.download":
            let raw = try a.string("url"), path = try a.path("path")
            guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
                  !(url.host ?? "").isEmpty else {
                throw BridgeError("\(cmd): only http and https URLs can be downloaded")
            }
            return { try download(url, to: path) }

        case "pandoc.cancel":
            // Stops the Pandoc runs in progress (an import the user gave up on).
            return {
                running.lock.lock()
                let list = running.processes
                running.lock.unlock()
                for process in list where process.isRunning { process.terminate() }
                return list.count
            }
        case "pandoc.run":
            guard let args = try a.stringArray("args") else { throw BridgeError("\(cmd): \"args\" must be an array of strings") }
            let stdin = try a.optString("stdin"), cwd = try a.optPath("cwd")
            guard let binary = AppPaths.pandoc else { throw BridgeError("\(cmd): pandoc was not found on this Mac") }
            return { try runPandoc(binary, args: args, stdin: stdin, cwd: cwd) }
        default:
            return nil
        }
    }

    // MARK: - Files

    private static func createParent(of path: String) throws {
        let parent = (path as NSString).deletingLastPathComponent
        if !parent.isEmpty {
            try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
        }
    }

    private static func mtime(_ path: String) -> Double {
        modificationTimeMs((try? FileManager.default.attributesOfItem(atPath: path)) ?? [:])
    }

    /// `encoding` is an IANA charset name ("gb18030", "shift_jis"…); nil or "auto" detects UTF-8 / UTF-16.
    private static func readText(_ path: String, encoding: String? = nil) throws -> Any {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let text: String
        if let name = encoding, name != "auto" {
            let cf = CFStringConvertIANACharSetNameToEncoding(name as CFString)
            guard cf != kCFStringEncodingInvalidId else { throw BridgeError("fs.readText: unknown encoding \"\(name)\"") }
            let ns = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(cf))
            guard let decoded = String(data: data, encoding: ns) else { throw BridgeError("fs.readText: the file is not valid \(name)") }
            text = decoded
        } else if let utf8 = String(data: data, encoding: .utf8) {
            text = utf8
        } else if data.count >= 2, [[0xFF, 0xFE], [0xFE, 0xFF]].contains(Array(data.prefix(2))),
                  let utf16 = String(data: data, encoding: .utf16) {
            text = utf16
        } else {
            text = String(decoding: data, as: UTF8.self) // lossy: invalid bytes become U+FFFD
        }
        return ["text": text, "mtime": mtime(path)]
    }

    /// Atomic write that follows symlinks and keeps the existing file's permissions.
    private static func write(_ data: Data, to path: String) throws -> Any {
        let fm = FileManager.default
        try createParent(of: path)
        let target = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        let permissions = (try? fm.attributesOfItem(atPath: target.path))?[.posixPermissions]
        try data.write(to: target, options: .atomic)
        if let permissions = permissions {
            try? fm.setAttributes([.posixPermissions: permissions], ofItemAtPath: target.path)
        }
        return ["mtime": mtime(target.path)]
    }

    private static func list(_ path: String, hidden: Bool) throws -> Any {
        let fm = FileManager.default
        let names = try fm.contentsOfDirectory(atPath: path)
            .filter { hidden || !$0.hasPrefix(".") }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        return names.map { name -> [String: Any] in
            let full = (path as NSString).appendingPathComponent(name)
            var isDir: ObjCBool = false
            _ = fm.fileExists(atPath: full, isDirectory: &isDir) // follows symlinks
            let attributes = (try? fm.attributesOfItem(atPath: full)) ?? [:]
            return [
                "name": name,
                "path": full,
                "isDir": isDir.boolValue,
                "mtime": modificationTimeMs(attributes),
                "created": creationTimeMs(attributes),
                "size": (attributes[.size] as? NSNumber)?.doubleValue ?? 0,
            ]
        }
    }

    private static func stat(_ path: String) -> Any {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir) else {
            return ["exists": false, "isDir": false, "mtime": 0, "created": 0, "size": 0]
        }
        let attributes = (try? fm.attributesOfItem(atPath: path)) ?? [:]
        return [
            "exists": true,
            "isDir": isDir.boolValue,
            "mtime": modificationTimeMs(attributes),
            "created": creationTimeMs(attributes),
            "size": (attributes[.size] as? NSNumber)?.doubleValue ?? 0,
            // Finder's Locked box, or no permission to write: the document opens read-only.
            "locked": (attributes[.immutable] as? NSNumber)?.boolValue ?? false,
            "writable": fm.isWritableFile(atPath: path),
            "executable": !isDir.boolValue && fm.isExecutableFile(atPath: path),
        ]
    }

    private static func rename(_ from: String, _ to: String) throws -> Any {
        let fm = FileManager.default
        guard fm.fileExists(atPath: from) else { throw BridgeError("fs.rename: \"\(from)\" does not exist") }
        try createParent(of: to)
        if from != to, from.lowercased() == to.lowercased(), isSameFile(from, to) {
            // Case-only rename on a case-insensitive volume: moveItem would report "already exists".
            guard Darwin.rename(from, to) == 0 else {
                throw BridgeError("fs.rename: \(String(cString: strerror(errno)))")
            }
            return true
        }
        guard !fm.fileExists(atPath: to) else { throw BridgeError("fs.rename: \"\(to)\" already exists") }
        try fm.moveItem(atPath: from, toPath: to)
        return true
    }

    private static func isSameFile(_ a: String, _ b: String) -> Bool {
        var sa = Darwin.stat(), sb = Darwin.stat()
        guard lstat(a, &sa) == 0, lstat(b, &sb) == 0 else { return false }
        return sa.st_ino == sb.st_ino && sa.st_dev == sb.st_dev
    }

    // MARK: - Downloads

    private static let downloadTimeout: TimeInterval = 30

    private static let downloadSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral // no cookies or cache left behind
        configuration.timeoutIntervalForRequest = downloadTimeout
        configuration.timeoutIntervalForResource = downloadTimeout
        return URLSession(configuration: configuration)
    }()

    private final class DownloadOutcome {
        var value: [String: Any]?
        var error: String?
    }

    /// Fetches `url` into `path` (replacing an existing file). Blocks the calling background queue until done.
    private static func download(_ url: URL, to path: String) throws -> Any {
        let outcome = DownloadOutcome()
        let done = DispatchSemaphore(value: 0)
        let task = downloadSession.downloadTask(with: url) { temp, response, error in
            defer { done.signal() }
            if let error = error {
                let timedOut = (error as NSError).domain == NSURLErrorDomain && (error as NSError).code == NSURLErrorTimedOut
                outcome.error = timedOut ? "timed out after \(Int(downloadTimeout))s" : describe(error)
                return
            }
            guard let temp = temp, let http = response as? HTTPURLResponse else {
                outcome.error = "the server sent no usable response"
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                outcome.error = "the server answered \(http.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: http.statusCode))"
                return
            }
            // The temporary file disappears when this handler returns: move it into place now.
            do {
                let fm = FileManager.default
                try createParent(of: path)
                let target = URL(fileURLWithPath: path)
                if fm.fileExists(atPath: path) {
                    _ = try fm.replaceItemAt(target, withItemAt: temp)
                } else {
                    try fm.moveItem(at: temp, to: target)
                }
                try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path) // the temporary file was private
                let size = ((try? fm.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.doubleValue ?? 0
                outcome.value = ["ok": true, "mime": (http.mimeType ?? Mime.type(forPath: path)).lowercased(), "size": size]
            } catch {
                outcome.error = describe(error)
            }
        }
        task.resume()
        done.wait()
        if let value = outcome.value { return value }
        throw BridgeError("net.download: \(outcome.error ?? "the download failed")")
    }

    // MARK: - pandoc

    private static let pandocTimeout: TimeInterval = 120
    private static let running = RunningProcesses()
    final class RunningProcesses {
        let lock = NSLock()
        var processes: [Process] = []
    }

    private static func runPandoc(_ binary: String, args: [String], stdin: String?, cwd: String?) throws -> Any {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = args
        if let cwd = cwd {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir), isDir.boolValue else {
                throw BridgeError("pandoc.run: \"cwd\" is not a directory")
            }
            process.currentDirectoryURL = URL(fileURLWithPath: cwd, isDirectory: true)
        }
        // GUI apps get a bare PATH; pandoc needs to find its helpers (LaTeX engines, filters).
        var environment = ProcessInfo.processInfo.environment
        let base = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:" + base
        process.environment = environment

        let outPipe = Pipe(), errPipe = Pipe()
        var inPipe: Pipe?
        process.standardOutput = outPipe
        process.standardError = errPipe
        if stdin != nil {
            let pipe = Pipe()
            inPipe = pipe
            process.standardInput = pipe
        } else {
            process.standardInput = FileHandle.nullDevice
        }
        try process.run()
        running.lock.lock()
        running.processes.append(process)
        running.lock.unlock()
        defer {
            running.lock.lock()
            running.processes.removeAll { $0 === process }
            running.lock.unlock()
        }

        let io = DispatchQueue(label: "dev.livemark.pandoc.io", attributes: .concurrent)
        let group = DispatchGroup()
        var out = Data(), err = Data()
        io.async(group: group) { out = outPipe.fileHandleForReading.readDataToEndOfFile() }
        io.async(group: group) { err = errPipe.fileHandleForReading.readDataToEndOfFile() }
        if let pipe = inPipe, let text = stdin {
            io.async {
                try? pipe.fileHandleForWriting.write(contentsOf: Data(text.utf8))
                try? pipe.fileHandleForWriting.close()
            }
        }

        if group.wait(timeout: .now() + pandocTimeout) == .timedOut {
            process.terminate()
            if group.wait(timeout: .now() + 2) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                _ = group.wait(timeout: .now() + 2)
            }
            throw BridgeError("pandoc.run: timed out after \(Int(pandocTimeout))s")
        }
        process.waitUntilExit()
        return [
            "code": Int(process.terminationStatus),
            "stdout": String(decoding: out, as: UTF8.self),
            "stderr": String(decoding: err, as: UTF8.self),
        ]
    }
}

// MARK: - Store

/// `appSupport/store.json`: one JSON object shared by every window, rewritten atomically on each set.
final class Store {
    static let shared = Store()

    private let queue = DispatchQueue(label: "dev.livemark.store")
    private let url = URL(fileURLWithPath: AppPaths.appSupport).appendingPathComponent("store.json")
    private var values: [String: Any] = [:]

    private init() {
        if let data = try? Data(contentsOf: url),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            values = object
        }
    }

    func get(_ key: String) -> Any {
        queue.sync { values[key] ?? NSNull() }
    }

    /// Keys that start with `prefix` (e.g. every per-document draft).
    func keys(prefix: String) -> [String] {
        queue.sync { values.keys.filter { $0.hasPrefix(prefix) }.sorted() }
    }

    func set(_ key: String, _ value: Any) throws {
        try queue.sync {
            if value is NSNull { values.removeValue(forKey: key) } else { values[key] = value }
            let data = try JSONSerialization.data(withJSONObject: values, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: url, options: .atomic)
        }
    }
}
