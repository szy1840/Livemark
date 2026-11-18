import Cocoa
import WebKit

/// `--script file.js`: boots the app in a hidden window, then runs the file as the body of an async function in
/// the page, prints the value it returns as JSON and exits (0 on success, 1 on a thrown error or timeout).
/// This is how the web app is checked end to end inside the real shell without anyone at the screen.
final class ScriptRunner {
    private unowned let app: AppDelegate
    private let path: String
    private var activity: NSObjectProtocol?

    init(app: AppDelegate, path: String) {
        self.app = app
        self.path = path
    }

    func prepare() {
        // Like the selftest: never write test paths into the user's real settings.
        if ProcessInfo.processInfo.environment["LIVEMARK_APP_SUPPORT"] == nil {
            AppPaths.appSupportOverride = NSTemporaryDirectory() + "livemark-script-" + UUID().uuidString.prefix(8).lowercased()
        }
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated], reason: "script")
        DispatchQueue.global().asyncAfter(deadline: .now() + 180) {
            print("SCRIPT ERROR: timed out after 180s")
            exit(1)
        }
    }

    func start() {
        guard let source = try? String(contentsOfFile: path, encoding: .utf8) else {
            print("SCRIPT ERROR: cannot read \(path)")
            exit(1)
        }
        waitUntilReady { controller in
            controller.webView.callAsyncJavaScript(source, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    if JSONSerialization.isValidJSONObject(value),
                       let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) {
                        print(String(data: data, encoding: .utf8) ?? "")
                    } else {
                        print("\(value)")
                    }
                    exit(0)
                case .failure(let error):
                    let message = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] ?? error.localizedDescription
                    print("SCRIPT ERROR: \(message)")
                    exit(1)
                }
            }
        }
    }

    /// The page is ready once it has sent `app.ready`; give its own start-up a moment to settle after that.
    private func waitUntilReady(_ then: @escaping (WindowController) -> Void) {
        guard let controller = app.controllers.first else {
            print("SCRIPT ERROR: no window")
            exit(1)
        }
        if controller.ready {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { then(controller) }
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitUntilReady(then) }
        }
    }
}
