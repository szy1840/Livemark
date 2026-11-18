import Foundation
import WebKit

/// Serves `livemark://app/<path>` from the web root and `livemark://fs/<absolute path>` from disk (read-only).
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "livemark"
    static let appHost = "app"
    static let fsHost = "fs"

    private struct Response {
        var status: Int
        var headers: [String: String]
        var body: Data

        static func error(_ status: Int, _ message: String) -> Response {
            Response(status: status, headers: ["Content-Type": "text/plain; charset=utf-8"], body: Data(message.utf8))
        }
    }

    private let webRoot: URL
    private let queue = DispatchQueue(label: "dev.livemark.scheme", qos: .userInitiated, attributes: .concurrent)
    /// Tasks WebKit has started and not stopped. Main thread only.
    private var active = Set<ObjectIdentifier>()

    init(webRoot: URL) {
        self.webRoot = webRoot
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        active.insert(id)
        let request = task.request
        queue.async {
            let response = self.respond(to: request)
            DispatchQueue.main.async {
                // Touching a task after WebKit stopped it raises an exception.
                guard self.active.remove(id) != nil else { return }
                var headers = response.headers
                headers["Content-Length"] = String(response.body.count)
                headers["Cache-Control"] = "no-store"
                headers["Access-Control-Allow-Origin"] = "*"
                guard let url = request.url,
                      let http = HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1", headerFields: headers) else {
                    task.didFailWithError(URLError(.badURL))
                    return
                }
                task.didReceive(http)
                if request.httpMethod?.uppercased() != "HEAD" { task.didReceive(response.body) }
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.remove(ObjectIdentifier(task))
    }

    // MARK: - Resolution

    private func respond(to request: URLRequest) -> Response {
        let method = (request.httpMethod ?? "GET").uppercased()
        guard method == "GET" || method == "HEAD" else { return .error(405, "method not allowed") }
        guard let url = request.url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let path = components.percentEncodedPath.removingPercentEncoding,
              !path.contains("\0") else {
            return .error(400, "bad request")
        }

        let file: URL
        switch (url.host ?? "").lowercased() {
        case Self.appHost:
            guard let relative = Self.relativePath(insideRoot: path) else { return .error(403, "path escapes the web root") }
            var target = relative.isEmpty ? webRoot : webRoot.appendingPathComponent(relative)
            if Self.isDirectory(target) { target = target.appendingPathComponent("index.html") }
            file = target
        case Self.fsHost:
            // Accept both livemark://fs/%2FUsers%2Fme%2Fa.png and livemark://fs/Users/me/a.png.
            var absolute = path
            while absolute.hasPrefix("//") { absolute.removeFirst() }
            guard absolute.hasPrefix("/") else { return .error(400, "expected an absolute path") }
            file = URL(fileURLWithPath: absolute)
        default:
            return .error(404, "unknown host")
        }

        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue else {
            return .error(404, "not found")
        }
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            return .error(404, "unreadable")
        }

        var headers = ["Content-Type": Mime.contentType(forPath: file.path), "Accept-Ranges": "bytes"]
        if let header = request.value(forHTTPHeaderField: "Range") {
            // Media elements ask for byte ranges.
            guard let range = Self.byteRange(header, length: data.count) else {
                return Response(status: 416, headers: ["Content-Range": "bytes */\(data.count)"], body: Data())
            }
            headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(data.count)"
            return Response(status: 206, headers: headers, body: data.subdata(in: range))
        }
        return Response(status: 200, headers: headers, body: data)
    }

    /// Normalizes a URL path lexically. Returns nil as soon as `..` would leave the root.
    static func relativePath(insideRoot path: String) -> String? {
        var parts: [Substring] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." {
                if parts.isEmpty { return nil }
                parts.removeLast()
            } else {
                parts.append(part)
            }
        }
        return parts.joined(separator: "/")
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) && isDir.boolValue
    }

    /// Parses a single `bytes=a-b` / `bytes=a-` / `bytes=-n` range.
    static func byteRange(_ header: String, length: Int) -> Range<Int>? {
        let value = header.trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix("bytes="), length > 0, !value.contains(",") else { return nil }
        let bounds = value.dropFirst("bytes=".count).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard bounds.count == 2 else { return nil }
        if bounds[0].isEmpty {
            guard let suffix = Int(bounds[1]), suffix > 0 else { return nil }
            return max(0, length - suffix)..<length
        }
        guard let start = Int(bounds[0]), start >= 0, start < length else { return nil }
        if bounds[1].isEmpty { return start..<length }
        guard let end = Int(bounds[1]), end >= start else { return nil }
        return start..<min(end + 1, length)
    }
}
