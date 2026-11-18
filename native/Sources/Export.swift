import Cocoa
import PDFKit
import WebKit

/// Receives the completion callback of a sheet-less NSPrintOperation.
final class PrintJob: NSObject {
    var completion: ((Bool) -> Void)?

    @objc func printOperationDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        finish(success)
    }

    func finish(_ success: Bool) {
        let handler = completion
        completion = nil
        handler?(success)
    }
}

extension WindowController {
    /// Portrait sizes in points.
    private static let paperSizes: [String: NSSize] = [
        "a3": NSSize(width: 842, height: 1191),
        "a4": NSSize(width: 595, height: 842),
        "a5": NSSize(width: 420, height: 595),
        "letter": NSSize(width: 612, height: 792),
        "legal": NSSize(width: 612, height: 1008),
        "tabloid": NSSize(width: 792, height: 1224),
    ]

    /// `paper`: a name, or `{ width, height }` in points.
    private static func paperSize(_ a: Args) throws -> NSSize? {
        guard a.has("paper") else { return nil }
        let expected = "\(a.cmd): \"paper\" must be \"A3\", \"A4\", \"A5\", \"Letter\", \"Legal\", \"Tabloid\" or { width, height } in points"
        if let name = a.dict["paper"] as? String {
            guard let size = paperSizes[name.lowercased()] else { throw BridgeError(expected) }
            return size
        }
        guard let custom = a.dict["paper"] as? [String: Any] else { throw BridgeError(expected) }
        let size = Args(cmd: a.cmd, dict: custom)
        guard let width = try size.number("width"), let height = try size.number("height"),
              (72...14_400).contains(width), (72...14_400).contains(height) else {
            throw BridgeError("\(a.cmd): a custom \"paper\" needs \"width\" and \"height\" between 72 and 14400 points")
        }
        return NSSize(width: width, height: height)
    }

    /// `outline`: `[{ level: 1…6, text }]`.
    private static func outline(_ a: Args) throws -> [PDFPostProcess.Heading] {
        guard a.has("outline") else { return [] }
        guard let rows = a.dict["outline"] as? [[String: Any]] else { throw BridgeError("\(a.cmd): \"outline\" must be an array of { level, text }") }
        return try rows.compactMap { row -> PDFPostProcess.Heading? in
            let entry = Args(cmd: a.cmd, dict: row)
            guard let level = try entry.number("level"), let text = try entry.optString("text") else {
                throw BridgeError("\(a.cmd): every \"outline\" entry needs a number \"level\" and a string \"text\"")
            }
            let label = text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
            return label.isEmpty ? nil : PDFPostProcess.Heading(level: min(max(Int(level), 1), 6), text: label)
        }
    }

    // MARK: - PDF / print

    /// `export.pdf` (straight to a file, no panels) and `export.print` (system print panel).
    func exportPDF(_ a: Args, showPanel: Bool, _ reply: Reply) throws {
        let cmd = a.cmd
        let info = (NSPrintInfo.shared.copy() as? NSPrintInfo) ?? NSPrintInfo()
        // The sheet as asked for: named papers are upright, `landscape` turns it on its side, a custom size is taken
        // as given. NSPrintInfo wants the upright size plus an orientation.
        info.orientation = .portrait
        var paper = try Self.paperSize(a) ?? info.paperSize
        if try a.bool("landscape", default: false), paper.width < paper.height { paper = NSSize(width: paper.height, height: paper.width) }
        info.paperSize = NSSize(width: min(paper.width, paper.height), height: max(paper.width, paper.height))
        info.orientation = paper.width > paper.height ? .landscape : .portrait

        // `margin` for all four sides; `margins: { top, right, bottom, left }` overrides it side by side.
        let margin = try a.number("margin") ?? 45
        guard margin >= 0, margin * 2 < Double(min(paper.width, paper.height)) else {
            throw BridgeError("\(cmd): \"margin\" is out of range")
        }
        var top = margin, right = margin, bottom = margin, left = margin
        if let sides = try a.object("margins") {
            let side = Args(cmd: cmd, dict: sides)
            top = try side.number("top") ?? margin
            right = try side.number("right") ?? margin
            bottom = try side.number("bottom") ?? margin
            left = try side.number("left") ?? margin
            guard min(top, right, bottom, left) >= 0, left + right < Double(paper.width) - 20, top + bottom < Double(paper.height) - 20 else {
                throw BridgeError("\(cmd): \"margins\" is out of range")
            }
        }
        info.topMargin = top
        info.bottomMargin = bottom
        info.leftMargin = left
        info.rightMargin = right
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.scalingFactor = 1

        // Header, footer and bookmarks are added to the finished file (not available in the print panel).
        var finish: (() throws -> Void)?
        if !showPanel {
            let path = try a.path("path")
            try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            info.jobDisposition = .save
            info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL.rawValue] = URL(fileURLWithPath: path)

            let text: (String) throws -> String? = { key in
                guard let value = try a.optString(key), !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                return value
            }
            let stamp = PDFPostProcess.Stamp(header: try text("header"), footer: try text("footer"),
                                             top: CGFloat(top), right: CGFloat(right), bottom: CGFloat(bottom), left: CGFloat(left))
            let outline = try Self.outline(a)
            let internalLinks = a.has("internalLinks") ? try a.bool("internalLinks", default: false) : false
            var attributes: [PDFDocumentAttribute: Any] = [:]
            if let info = a.dict["info"] as? [String: Any] {
                if let v = info["title"] as? String, !v.isEmpty { attributes[.titleAttribute] = v }
                if let v = info["author"] as? String, !v.isEmpty { attributes[.authorAttribute] = v }
                if let v = info["subject"] as? String, !v.isEmpty { attributes[.subjectAttribute] = v }
                if let v = info["creator"] as? String, !v.isEmpty { attributes[.creatorAttribute] = v }
                if let v = info["keywords"] as? String, !v.isEmpty { attributes[.keywordsAttribute] = v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }
            }
            if !stamp.isEmpty || !outline.isEmpty || internalLinks || !attributes.isEmpty {
                finish = { try PDFPostProcess.run(path: path, stamp: stamp, outline: outline, attributes: attributes) }
            }
        }

        let operation = webView.printOperation(with: info)
        operation.showsPrintPanel = showPanel
        operation.showsProgressPanel = showPanel
        // The print panel's own option: each top-level heading on a new page (the page
        // lays itself out again, and the preview follows).
        if showPanel, !headless {
            let accessory = SplitPagesAccessory(on: try a.bool("splitPages", default: false), label: try a.optString("splitLabel") ?? "Start each top-level heading on a new page") { [weak self] on in
                self?.emit("printSplit", ["on": on])
            }
            operation.printPanel.addAccessoryController(accessory)
            operation.printPanel.options.insert(.showsPreview)
        }
        // WebKit's printing view starts with an empty frame and produces nothing unless it is given one.
        operation.view?.frame = NSRect(origin: .zero, size: paper)

        let job = PrintJob()
        printJobs.insert(job)
        job.completion = { [weak self, weak job] success in
            if let job = job { self?.printJobs.remove(job) }
            if showPanel {
                reply.ok(success) // false: the user cancelled the print panel
            } else if !success {
                reply.fail("\(cmd): the PDF could not be written")
            } else if let finish = finish {
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        try finish()
                        reply.ok()
                    } catch {
                        reply.fail("\(cmd): the PDF was written, but without header, footer and bookmarks: \(describe(error))")
                    }
                }
            } else {
                reply.ok()
            }
        }
        if !showPanel {
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak job] in job?.finish(false) }
        }
        operation.runModal(for: window, delegate: job,
                           didRun: #selector(PrintJob.printOperationDidRun(_:success:contextInfo:)), contextInfo: nil)
    }

    // MARK: - PNG / JPEG

    private static let tileHeight: CGFloat = 4096
    private static let maxPixels = 120_000_000.0

    /// Snapshot of the whole document: the web view is temporarily laid out at width x height CSS px.
    func exportImage(_ a: Args, _ reply: Reply) throws {
        let cmd = a.cmd
        let path = try a.path("path")
        guard let width = try a.number("width"), let height = try a.number("height"),
              (1...16_384).contains(width), (1...400_000).contains(height) else {
            throw BridgeError("\(cmd): \"width\" (1…16384) and \"height\" (1…400000) are required numbers")
        }
        guard !exporting else { throw BridgeError("\(cmd): another export is in progress") }
        let format = (try a.optString("format") ?? "png").lowercased()
        guard ["png", "jpeg", "jpg"].contains(format) else { throw BridgeError("\(cmd): \"format\" must be \"png\" or \"jpeg\"") }
        let jpeg = format != "png"
        let quality = try a.number("quality") ?? 0.9
        guard (0...1).contains(quality) else { throw BridgeError("\(cmd): \"quality\" must be between 0 and 1") }

        let size = NSSize(width: width.rounded(), height: height.rounded())
        let backing = Double(max(window.backingScaleFactor, 1))
        var scale = try a.number("scale") ?? backing
        guard (0.25...4).contains(scale) else { throw BridgeError("\(cmd): \"scale\" must be between 0.25 and 4") }
        let area = Double(size.width * size.height)
        if area * scale * scale > Self.maxPixels { scale = (Self.maxPixels / area).squareRoot() } // keep huge documents in memory bounds
        guard scale >= 0.25 else { throw BridgeError("\(cmd): the document is too large to render as one image") }

        let pixelWidth = Int((Double(size.width) * scale).rounded()), pixelHeight = Int((Double(size.height) * scale).rounded())
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(data: nil, width: pixelWidth, height: pixelHeight, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw BridgeError("\(cmd): could not allocate a \(pixelWidth)x\(pixelHeight) bitmap")
        }
        // The web view is transparent where the page paints nothing: put the window color underneath.
        var background = NSColor.white.cgColor
        window.effectiveAppearance.performAsCurrentDrawingAppearance { background = Self.backgroundColor.cgColor }
        context.setFillColor(background)
        context.fill(CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight))
        context.interpolationQuality = .high

        exporting = true
        webView.autoresizingMask = []
        webView.frame = NSRect(x: 0, y: container.bounds.height - size.height, width: size.width, height: size.height)

        let finish: (String?) -> Void = { [weak self] error in
            if let self = self {
                self.exporting = false
                self.webView.frame = self.webViewFrame
                self.webView.autoresizingMask = [.width, .height]
            }
            if let error = error { reply.fail("\(cmd): \(error)") } else { reply.ok() }
        }

        func write() {
            DispatchQueue.global(qos: .userInitiated).async {
                var error: String?
                do {
                    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
                    let type = (jpeg ? "public.jpeg" : "public.png") as CFString
                    guard let image = context.makeImage(),
                          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, type, 1, nil) else {
                        throw BridgeError("could not create the image file")
                    }
                    // The bitmap is opaque (the page background is painted first), so JPEG loses nothing but detail.
                    let options = jpeg ? [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary : nil
                    CGImageDestinationAddImage(destination, image, options)
                    if !CGImageDestinationFinalize(destination) { throw BridgeError("could not write the image file") }
                } catch let failure {
                    error = describe(failure)
                }
                DispatchQueue.main.async { finish(error) }
            }
        }

        // WebKit snapshots are limited in size, so capture the page in horizontal bands and stitch them.
        func capture(from y: CGFloat) {
            guard y < size.height else { return write() }
            let band = min(Self.tileHeight, size.height - y)
            let configuration = WKSnapshotConfiguration()
            configuration.rect = CGRect(x: 0, y: y, width: size.width, height: band)
            configuration.snapshotWidth = NSNumber(value: Double(size.width) * scale / backing)
            configuration.afterScreenUpdates = true
            webView.takeSnapshot(with: configuration) { image, error in
                guard let cgImage = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                    return finish(error?.localizedDescription ?? "the snapshot failed")
                }
                let top = Double(size.height - y - band) * scale // CoreGraphics counts from the bottom
                context.draw(cgImage, in: CGRect(x: 0, y: top, width: Double(size.width) * scale, height: Double(band) * scale))
                capture(from: y + band)
            }
        }

        // Wait until the page has been laid out at the new size and had a chance to paint.
        let settle = """
            const start = Date.now();
            while ((window.innerWidth !== w || window.innerHeight !== h) && Date.now() - start < 3000) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            await Promise.race([
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
              new Promise((resolve) => setTimeout(resolve, 300)),
            ]);
            """
        webView.callAsyncJavaScript(settle, arguments: ["w": Double(size.width), "h": Double(size.height)], in: nil, in: .defaultClient) { _ in
            capture(from: 0)
        }
    }
}


/// The print panel's "start each top-level heading on a new page" box.
final class SplitPagesAccessory: NSViewController, NSPrintPanelAccessorizing {
    @objc dynamic var splitPages: Bool {
        didSet { changed(splitPages) }
    }
    private let label: String
    private let changed: (Bool) -> Void

    init(on: Bool, label: String, changed: @escaping (Bool) -> Void) {
        splitPages = on
        self.label = label
        self.changed = changed
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        let box = NSButton(checkboxWithTitle: label, target: self, action: #selector(toggled(_:)))
        box.state = splitPages ? .on : .off
        let row = NSStackView(views: [box])
        row.edgeInsets = NSEdgeInsets(top: 8, left: 20, bottom: 8, right: 20)
        view = row
    }

    @objc private func toggled(_ sender: NSButton) {
        willChangeValue(forKey: "splitPages")
        splitPages = sender.state == .on
        didChangeValue(forKey: "splitPages")
    }

    func localizedSummaryItems() -> [[NSPrintPanel.AccessorySummaryKey: String]] {
        [[.itemName: label, .itemDescription: splitPages ? "On" : "Off"]]
    }

    func keyPathsForValuesAffectingPreview() -> Set<String> {
        ["splitPages"]
    }
}
