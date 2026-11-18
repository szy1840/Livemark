import Cocoa
import WebKit

/// Where a `<a download>` / blob download ends up once it has been fetched to a temporary file.
struct DownloadTarget {
    let temp: URL
    let destination: URL
}

func openExternally(_ url: URL) {
    guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
    NSWorkspace.shared.open(url)
}

// MARK: - Navigation policy

extension WindowController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let scheme = (url.scheme ?? "").lowercased()

        if action.shouldPerformDownload { return decisionHandler(.download) }

        guard let target = action.targetFrame else {
            // target=_blank / window.open: there are no secondary web windows, use the browser.
            openExternally(url)
            return decisionHandler(.cancel)
        }
        if target.isMainFrame {
            if scheme == SchemeHandler.scheme, url.host?.lowercased() == SchemeHandler.appHost {
                return decisionHandler(.allow)
            }
            openExternally(url) // no-op for anything but http(s) / mailto
            return decisionHandler(.cancel)
        }
        // Sub-frames (embedded iframes in a document) may load web content, never file: or custom schemes.
        let allowed = ["http", "https", "about", "data", "blob", SchemeHandler.scheme].contains(scheme)
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        pageWentAway() // a (re)loaded page must send app.ready again
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        setLoadState(.finished)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        setLoadState(.failed(error.localizedDescription))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        setLoadState(.failed(error.localizedDescription))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page is gone: the window must be closable without its consent. Bring the app back up.
        pageWentAway()
        webView.reload()
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
}

// MARK: - Downloads (`<a download>` / blob URLs)

extension WindowController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard !headless else { return completionHandler(nil) }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self = self, result == .OK, let destination = panel.url else { return completionHandler(nil) }
            // WKDownload refuses to overwrite, so fetch to a temporary file and swap it in afterwards.
            let temp = FileManager.default.temporaryDirectory.appendingPathComponent("livemark-download-" + UUID().uuidString)
            self.downloads[ObjectIdentifier(download)] = DownloadTarget(temp: temp, destination: destination)
            completionHandler(temp)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let target = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        do {
            try Data(contentsOf: target.temp).write(to: target.destination, options: .atomic)
        } catch {
            presentAlert(message: "The file could not be saved.", detail: error.localizedDescription, buttons: ["OK"], style: .warning) { _ in }
        }
        try? FileManager.default.removeItem(at: target.temp)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
    }
}

// MARK: - UI delegate

extension WindowController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openExternally(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        presentAlert(message: message, detail: nil, buttons: ["OK"], style: .informational) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        presentAlert(message: message, detail: nil, buttons: ["OK", "Cancel"], style: .informational) { completionHandler($0 == 0) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        presentAlert(message: prompt, detail: nil, buttons: ["OK", "Cancel"], style: .informational, accessory: field) {
            completionHandler($0 == 0 ? field.stringValue : nil)
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard !headless else { return completionHandler(nil) }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    /// NSAlert as a sheet on this window. `completion` receives the index of the clicked button (the first is the default).
    func presentAlert(message: String, detail: String?, buttons: [String], style: NSAlert.Style, cancelIndex: Int? = nil,
                      defaultIndex: Int? = nil, accessory: NSView? = nil, suppression: String? = nil, checked: ((Bool) -> Void)? = nil, completion: @escaping (Int) -> Void) {
        // Headless runs answer with the last button, or the one LIVEMARK_ALERT_ANSWER names (for scripted checks).
        guard !headless else {
            let pick = ProcessInfo.processInfo.environment["LIVEMARK_ALERT_ANSWER"].flatMap { Int($0) }
            return completion(min(max(0, pick ?? buttons.count - 1), max(0, buttons.count - 1)))
        }
        let alert = NSAlert()
        // An optional "Do not show this again" box; its state is reported before the button.
        if let suppression {
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = suppression
        }
        alert.messageText = message
        alert.informativeText = detail ?? ""
        alert.alertStyle = style
        alert.accessoryView = accessory
        for (index, title) in buttons.enumerated() {
            let button = alert.addButton(withTitle: title)
            if index == cancelIndex { button.keyEquivalent = "\u{1B}" }
        }
        // Return can go to another button than the first ("Replace" in Keep Both / Replace / Cancel).
        if let defaultIndex, defaultIndex > 0, defaultIndex < alert.buttons.count {
            alert.buttons[0].keyEquivalent = ""
            alert.buttons[defaultIndex].keyEquivalent = "\r"
        }
        alert.beginSheetModal(for: window) { response in
            checked?(alert.suppressionButton?.state == .on)
            completion(response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue)
        }
    }
}
