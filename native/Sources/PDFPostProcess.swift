import Cocoa
import PDFKit

/// What `export.pdf` adds to the PDF WebKit printed: a header / footer line on every page, and bookmarks.
enum PDFPostProcess {
    struct Stamp {
        var header: String?
        var footer: String?
        var top: CGFloat, right: CGFloat, bottom: CGFloat, left: CGFloat
        var isEmpty: Bool { header == nil && footer == nil }
    }

    struct Heading {
        let level: Int
        let text: String
    }

    /// Rewrites the PDF at `path` in place. Returns the number of bookmarks that were placed.
    @discardableResult
    static func run(path: String, stamp: Stamp, outline: [Heading], attributes: [PDFDocumentAttribute: Any] = [:]) throws -> Int {
        let url = URL(fileURLWithPath: path)
        // Read into memory: the file is replaced below.
        guard let document = PDFDocument(data: try Data(contentsOf: url)) else { throw BridgeError("the printed PDF could not be read back") }

        var painter: StampPainter?
        if !stamp.isEmpty {
            // PDFKit asks its delegate which class its pages are (before it creates the first one), and draws
            // through that class when it writes the document: text stays text, links stay links, and the stamp
            // becomes part of each page.
            painter = StampPainter(stamp: stamp)
            document.delegate = painter
            painter?.total = document.pageCount
        }
        // Headings are looked up in the pages as printed: the stamp is only drawn when the file is written, so a
        // header that repeats the document title cannot be mistaken for the heading itself.
        linkInternalAnchors(in: document)
        if !attributes.isEmpty {
            var info = document.documentAttributes ?? [:]
            for (key, value) in attributes { info[key] = value }
            document.documentAttributes = info
        }
        let places = outline.isEmpty ? [] : locate(outline, in: document)
        if !places.isEmpty { document.outlineRoot = buildOutline(places, in: document) }

        let scratch = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString.prefix(8)).tmp")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let written = withExtendedLifetime(painter) { document.write(to: scratch) }
        guard written else { throw BridgeError("the PDF could not be rewritten") }
        _ = try FileManager.default.replaceItemAt(url, withItemAt: scratch)
        return places.count
    }

    // MARK: - Internal links

    /// The page prints in-document links (#heading, [TOC] entries, footnote references and their back links) as
    /// `livemark-pdf:from-N`, and a small mark at each destination as `livemark-pdf:to-N`. The marks become page
    /// destinations; the links jump there instead of pointing at a URL.
    static let internalScheme = "livemark-pdf:"

    @discardableResult
    static func linkInternalAnchors(in document: PDFDocument) -> Int {
        var targets: [String: PDFDestination] = [:]
        var sources: [(PDFAnnotation, String)] = []
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            for annotation in page.annotations {
                guard let url = (annotation.action as? PDFActionURL)?.url?.absoluteString ?? annotation.url?.absoluteString,
                      url.hasPrefix(internalScheme) else { continue }
                let key = String(url.dropFirst(internalScheme.count))
                if key.hasPrefix("to-") {
                    let id = String(key.dropFirst(3))
                    if targets[id] == nil {
                        // A little above the mark, so the line is not cut off at the top of the view.
                        let b = annotation.bounds
                        targets[id] = PDFDestination(page: page, at: NSPoint(x: b.minX, y: min(page.bounds(for: .mediaBox).maxY, b.maxY + 12)))
                    }
                    page.removeAnnotation(annotation)
                } else if key.hasPrefix("from-") {
                    sources.append((annotation, String(key.dropFirst(5))))
                }
            }
        }
        var linked = 0
        for (annotation, id) in sources {
            if let destination = targets[id] {
                annotation.url = nil
                annotation.action = PDFActionGoTo(destination: destination)
                linked += 1
            } else {
                annotation.page?.removeAnnotation(annotation)
            }
        }
        return linked
    }

    // MARK: - Header / footer

    static let stampFont = NSFont.systemFont(ofSize: 9)
    static let stampColor = NSColor(calibratedWhite: 0.45, alpha: 1)

    final class StampPainter: NSObject, PDFDocumentDelegate {
        let stamp: Stamp
        var total = 0

        init(stamp: Stamp) {
            self.stamp = stamp
        }

        func classForPage() -> AnyClass { StampedPage.self }

        /// Centred between the side margins, in the middle of the top / bottom margin.
        func draw(page number: Int, bounds: CGRect, in context: CGContext) {
            let width = bounds.width - stamp.left - stamp.right
            guard width > 20 else { return }
            let lines: [(String?, CGFloat, CGFloat)] = [
                (stamp.header, stamp.top, bounds.maxY - stamp.top / 2),
                (stamp.footer, stamp.bottom, bounds.minY + stamp.bottom / 2),
            ]
            for (template, margin, middle) in lines {
                guard let template = template, margin >= PDFPostProcess.stampFont.pointSize + 2 else { continue } // no room: leave it out
                let text = template
                    .replacingOccurrences(of: "${pageNo}", with: String(number))
                    .replacingOccurrences(of: "${totalPages}", with: String(total))
                    .components(separatedBy: .newlines).joined(separator: " ")
                guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                let attributes: [NSAttributedString.Key: Any] = [.font: PDFPostProcess.stampFont, .foregroundColor: PDFPostProcess.stampColor]
                var line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
                if CTLineGetTypographicBounds(line, nil, nil, nil) > Double(width) {
                    let ellipsis = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: attributes))
                    line = CTLineCreateTruncatedLine(line, Double(width), .end, ellipsis) ?? line
                }
                var ascent: CGFloat = 0, descent: CGFloat = 0
                let lineWidth = CGFloat(CTLineGetTypographicBounds(line, &ascent, &descent, nil))
                context.saveGState()
                context.textMatrix = .identity
                context.textPosition = CGPoint(x: bounds.minX + stamp.left + (width - lineWidth) / 2, y: middle - (ascent - descent) / 2)
                CTLineDraw(line, context)
                context.restoreGState()
            }
        }
    }

    final class StampedPage: PDFPage {
        override func draw(with box: PDFDisplayBox, to context: CGContext) {
            super.draw(with: box, to: context)
            guard let document = document, let painter = document.delegate as? StampPainter else { return }
            painter.draw(page: document.index(for: self) + 1, bounds: bounds(for: box), in: context)
        }
    }

    // MARK: - Outline

    private struct Place {
        let heading: Heading
        let page: Int
        /// Top of the heading in page space, nil when its position on the page is unknown.
        let top: CGFloat?
    }

    /// The text of one page with white space removed and compatibility forms folded (PDF text extraction breaks
    /// lines and returns presentation forms for some glyphs), with a way back to offsets in `PDFPage.string`.
    private struct PageText {
        var units: [unichar] = []
        var source: [Int] = []          // offset in the page string of each unit
        var lineStarts = Set<Int>()     // unit offsets at which a line of the page begins
        var lineEnds = Set<Int>()       // unit offsets at which a line of the page ends

        init(_ string: String) {
            var offset = 0
            var atLineStart = true
            for character in string {
                let length = character.utf16.count
                defer { offset += length }
                if character.isNewline {
                    lineEnds.insert(units.count)
                    atLineStart = true
                    continue
                }
                if character.isWhitespace { continue }
                if atLineStart {
                    lineStarts.insert(units.count)
                    atLineStart = false
                }
                // Lower-cased: a theme may print headings in capitals.
                for unit in String(character).precomposedStringWithCompatibilityMapping.lowercased().utf16 {
                    units.append(unit)
                    source.append(offset)
                }
            }
            lineEnds.insert(units.count)
        }

        /// Offsets of `needle` at or after `start`, in order.
        func occurrences(of needle: [unichar], from start: Int) -> [Int] {
            guard !needle.isEmpty, units.count >= needle.count, start <= units.count - needle.count else { return [] }
            var found: [Int] = []
            let first = needle[0]
            var index = start
            let last = units.count - needle.count
            while index <= last {
                if units[index] == first, units[index..<(index + needle.count)].elementsEqual(needle) {
                    found.append(index)
                    index += needle.count
                } else {
                    index += 1
                }
            }
            return found
        }
    }

    private static func fold(_ text: String) -> [unichar] {
        Array(String(text.filter { !$0.isWhitespace && !$0.isNewline }).precomposedStringWithCompatibilityMapping.lowercased().utf16)
    }

    /// Finds the headings in reading order: each one is searched for after the previous one. A heading normally
    /// sits on lines of its own, so such a match wins over the same words inside a paragraph (or a table of contents
    /// entry followed by a page number). Headings that are not found are left out.
    private static func locate(_ outline: [Heading], in document: PDFDocument) -> [Place] {
        var texts: [Int: PageText] = [:]
        func text(_ page: Int) -> PageText {
            if let cached = texts[page] { return cached }
            let made = PageText(document.page(at: page)?.string ?? "")
            texts[page] = made
            return made
        }

        var places: [Place] = []
        var cursor = (page: 0, offset: 0)
        for heading in outline {
            let needle = fold(heading.text)
            guard !needle.isEmpty else { continue }
            var best: (score: Int, page: Int, offset: Int)?
            search: for page in cursor.page..<document.pageCount {
                let content = text(page)
                for offset in content.occurrences(of: needle, from: page == cursor.page ? cursor.offset : 0) {
                    let score = (content.lineStarts.contains(offset) ? 1 : 0) + (content.lineEnds.contains(offset + needle.count) ? 1 : 0)
                    if best == nil || score > best!.score { best = (score, page, offset) }
                    if score == 2 { break search }
                }
            }
            guard let hit = best else { continue }
            cursor = (hit.page, hit.offset + needle.count)

            var top: CGFloat?
            let content = text(hit.page)
            if let page = document.page(at: hit.page), let last = content.source.indices.contains(hit.offset + needle.count - 1) ? content.source[hit.offset + needle.count - 1] : nil {
                let start = content.source[hit.offset]
                let end = min(last + 1, (page.string as NSString?)?.length ?? last + 1)
                if end > start, let selection = page.selection(for: NSRange(location: start, length: end - start)) {
                    let bounds = selection.bounds(for: page)
                    if !bounds.isEmpty { top = bounds.maxY }
                }
            }
            places.append(Place(heading: heading, page: hit.page, top: top))
        }
        return places
    }

    /// Bookmarks nested by heading level: a heading belongs to the nearest earlier heading of a lower level.
    private static func buildOutline(_ places: [Place], in document: PDFDocument) -> PDFOutline {
        let root = PDFOutline()
        var stack: [(level: Int, item: PDFOutline)] = []
        for place in places {
            guard let page = document.page(at: place.page) else { continue }
            let box = page.bounds(for: .cropBox)
            let item = PDFOutline()
            item.label = place.heading.text
            let y = min((place.top ?? box.maxY) + 8, box.maxY) // a little air above the heading
            item.destination = PDFDestination(page: page, at: NSPoint(x: box.minX, y: y))
            while let last = stack.last, last.level >= place.heading.level { stack.removeLast() }
            let parent = stack.last?.item ?? root
            parent.insertChild(item, at: parent.numberOfChildren)
            if parent !== root { parent.isOpen = place.heading.level <= 3 } // deeper levels start collapsed
            stack.append((place.heading.level, item))
        }
        return root
    }

    // MARK: - Selftest

    /// `[{ level (depth in the tree), label, page (0-based), y }]` in document order.
    static func outlineDump(_ document: PDFDocument) -> [[String: Any]] {
        var rows: [[String: Any]] = []
        func walk(_ item: PDFOutline, depth: Int) {
            for index in 0..<item.numberOfChildren {
                guard let child = item.child(at: index) else { continue }
                let page = child.destination?.page
                rows.append([
                    "depth": depth,
                    "label": child.label ?? "",
                    "page": page.map { document.index(for: $0) } ?? -1,
                    "y": Double(child.destination?.point.y ?? -1),
                ])
                walk(child, depth: depth + 1)
            }
        }
        if let root = document.outlineRoot { walk(root, depth: 1) }
        return rows
    }
}
