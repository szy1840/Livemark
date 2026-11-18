import Cocoa

/// `touchbar.set`: which set of controls the Touch Bar shows. The page switches it as the caret moves.
/// `text`/`list` for ordinary blocks (list: inside a list), `raw` for a math or HTML block being edited,
/// `def` for a footnote or link-reference definition, `selectable` for blocks that are picked as a whole
/// (table of contents, front matter, horizontal line), `source` in source code mode, `dialog` while a
/// dialog in the page is up, `insertTable` while the Insert Table dialog is up.
enum TouchBarMode: String, CaseIterable {
    case text, list, table, code, raw, def, selectable, find, source, dialog, insertTable, image, none
}

/// One Touch Bar control. Tapping it sends the event `command {id}` to the page, exactly like a menu item.
private struct TouchControl {
    let id: String
    /// SF Symbol names, most specific first; the first one this macOS has is used.
    let symbols: [String]
    /// Accessibility label, and the visible text when there is no symbol (or `showsLabel`).
    let label: String
    var showsLabel = false

    init(_ id: String, _ label: String, symbols: [String] = [], showsLabel: Bool = false) {
        self.id = id
        self.label = label
        self.symbols = symbols
        self.showsLabel = showsLabel
    }

    var image: NSImage? {
        for name in symbols {
            if let image = NSImage(systemSymbolName: name, accessibilityDescription: label) { return image }
        }
        return nil
    }
}

private enum TouchItem {
    case button(TouchControl)
    /// A button that shows whether its setting is on (`state.on` lists the ids that are).
    case toggle(TouchControl)
    /// `stateful`: segments light up for the styles at the caret (`state.on`).
    case segments(name: String, [TouchControl], stateful: Bool)
    /// A button that swaps the bar for `controls` (with a close button). `keepsOpen`: stays up after a tap.
    case popover(name: String, face: TouchControl, [TouchControl], keepsOpen: Bool)
    /// A number with − and + (`state.values[id]`); a change sends `touchValue {id, value}`.
    case stepper(TouchControl, min: Double, max: Double)
    /// Typing suggestions for the word at the caret (`state.context`: the text before it);
    /// picking one sends `touchCandidate {text}`.
    case candidates
    case space

    var name: String {
        switch self {
        case .button(let control), .toggle(let control), .stepper(let control, _, _): return control.id
        case .segments(let name, _, _), .popover(let name, _, _, _): return name
        case .candidates: return "candidates"
        case .space: return "space"
        }
    }

    var commands: [String] {
        switch self {
        case .button(let control), .toggle(let control), .stepper(let control, _, _): return [control.id]
        case .segments(_, let controls, _), .popover(_, _, let controls, _): return controls.map { $0.id }
        case .space, .candidates: return []
        }
    }
}

private final class TouchButton: NSButton {
    var commandId = ""
    weak var popover: NSPopoverTouchBarItem?
}

private final class TouchSegments: NSSegmentedControl {
    var commandIds: [String] = []
    /// Which segments were lit before a tap, to tell which one the tap changed.
    var lit: [Bool] = []
}

/// "−  Rows 3  +": a number the page shows in a dialog, stepped from the Touch Bar.
private final class TouchStepper: NSSegmentedControl {
    var commandId = ""
    var name = ""
    var minValue = 1.0
    var maxValue = 100.0
    var value = 1.0 {
        didSet { setLabel("\(name) \(Int(value))", forSegment: 1) }
    }
}

/// Builds the Touch Bar of one document window for the current mode.
final class TouchBarProvider: NSObject, NSTouchBarDelegate {
    private static let prefix = "dev.livemark.touchbar."

    private weak var controller: WindowController?
    private var cached: NSTouchBar?
    /// Buttons inside popovers, by item identifier, and the popover items themselves.
    private var popoverControls: [NSTouchBarItem.Identifier: (control: TouchControl, parent: NSTouchBarItem.Identifier, keepsOpen: Bool)] = [:]
    private var popovers: [NSTouchBarItem.Identifier: NSPopoverTouchBarItem] = [:]

    var mode = TouchBarMode.text {
        didSet { if mode != oldValue { cached = nil; built = [:] } }
    }

    init(controller: WindowController) {
        self.controller = controller
    }

    // Shared pieces of the editing bars.
    private static let paragraphPopover = TouchItem.popover(name: "paragraph", face: TouchControl("", "Paragraph", symbols: ["textformat.size"]), [
        TouchControl("h1", "H1"), TouchControl("h2", "H2"), TouchControl("h3", "H3"),
        TouchControl("h4", "H4"), TouchControl("h5", "H5"), TouchControl("h6", "H6"),
        TouchControl("paragraph", "Paragraph", symbols: ["paragraphsign"]),
    ], keepsOpen: false)
    private static let inlineSegments = TouchItem.segments(name: "inline", [
        TouchControl("strong", "Bold", symbols: ["bold"]),
        TouchControl("em", "Italic", symbols: ["italic"]),
        TouchControl("link", "Link", symbols: ["link"]),
        TouchControl("imageInsert", "Image", symbols: ["photo"]),
    ], stateful: true)
    private static let listPopover = TouchItem.popover(name: "lists", face: TouchControl("", "List", symbols: ["list.bullet"]), [
        TouchControl("ul", "Bulleted List", symbols: ["list.bullet"]),
        TouchControl("ol", "Numbered List", symbols: ["list.number"]),
        TouchControl("task", "Task List", symbols: ["checklist", "checkmark.square"]),
        TouchControl("quote", "Quote", symbols: ["text.quote"]),
    ], keepsOpen: false)

    private static func layout(_ mode: TouchBarMode) -> [TouchItem] {
        switch mode {
        case .text:
            return [paragraphPopover, .space, inlineSegments, listPopover, .button(TouchControl("tableInsert", "Table", symbols: ["tablecells"])), .candidates]
        case .list:
            return [
                paragraphPopover,
                .segments(name: "indent", [
                    TouchControl("outdent", "Outdent", symbols: ["decrease.indent"]),
                    TouchControl("indent", "Indent", symbols: ["increase.indent"]),
                ], stateful: false),
                .space, inlineSegments, listPopover, .candidates,
            ]
        case .image:
            return [
                .button(TouchControl("imageAlt", "Alt Text", symbols: ["text.below.photo"], showsLabel: true)),
                .button(TouchControl("imageSrc", "Address", symbols: ["link"], showsLabel: true)),
                .space,
                .button(TouchControl("imageDelete", "Delete Image", symbols: ["trash"])),
                .space, inlineSegments,
            ]
        case .table:
            return [
                .button(TouchControl("table-rowBelow", "Row", symbols: ["plus"], showsLabel: true)),
                .button(TouchControl("table-colAfter", "Column", symbols: ["plus"], showsLabel: true)),
                .button(TouchControl("table-rowDelete", "Row", symbols: ["minus"], showsLabel: true)),
                .button(TouchControl("table-colDelete", "Column", symbols: ["minus"], showsLabel: true)),
                .popover(name: "move", face: TouchControl("", "Move", symbols: ["arrow.up.and.down.and.arrow.left.and.right"]), [
                    TouchControl("table-rowUp", "Row Up", symbols: ["arrow.up"], showsLabel: true),
                    TouchControl("table-rowDown", "Row Down", symbols: ["arrow.down"], showsLabel: true),
                    TouchControl("table-colLeft", "Column Left", symbols: ["arrow.left"], showsLabel: true),
                    TouchControl("table-colRight", "Column Right", symbols: ["arrow.right"], showsLabel: true),
                ], keepsOpen: true),
                .button(TouchControl("table-tableDelete", "Delete Table", symbols: ["trash"])),
                .space, inlineSegments,
            ]
        case .code:
            return [
                .button(TouchControl("codeLang", "Language", showsLabel: true)),
                .button(TouchControl("codeJump", "Jump", symbols: ["arrow.up.and.down.text.horizontal", "arrow.up.arrow.down"])),
                .button(TouchControl("codeCopy", "Copy", symbols: ["doc.on.doc"], showsLabel: true)),
                .button(TouchControl("codeIndent", "Indent", symbols: ["increase.indent"], showsLabel: true)),
                .space,
                .button(TouchControl("paraAfter", "Insert Paragraph After", symbols: ["text.append", "plus"])),
            ]
        case .raw:
            return [
                .button(TouchControl("rawDone", "Done", symbols: ["checkmark"], showsLabel: true)),
                .space,
                .button(TouchControl("deleteBlock", "Delete", symbols: ["trash"])),
            ]
        case .def:
            return [
                .button(TouchControl("defJump", "Content", symbols: ["arrow.uturn.backward"], showsLabel: true)),
                .space, inlineSegments,
            ]
        case .selectable:
            return [
                .button(TouchControl("paraAfter", "Insert Paragraph After", symbols: ["text.append", "plus"], showsLabel: true)),
                .space,
                .button(TouchControl("deleteBlock", "Delete", symbols: ["trash"])),
            ]
        case .find:
            return [
                .segments(name: "go", [
                    TouchControl("findPrev", "Previous", symbols: ["chevron.up"]),
                    TouchControl("findNext", "Next", symbols: ["chevron.down"]),
                ], stateful: false),
                .toggle(TouchControl("findCase", "Case Sensitive", symbols: ["textformat"], showsLabel: false)),
                .toggle(TouchControl("findWord", "Whole Word", symbols: ["textformat.abc.dottedunderline", "w.square"])),
                .space,
                .toggle(TouchControl("findReplaceMode", "Replace", showsLabel: true)),
                .button(TouchControl("replaceNext", "Replace Next")),
            ]
        case .source:
            return [.space, .button(TouchControl("source", "Exit Source Code Mode", symbols: ["chevron.left.forwardslash.chevron.right"], showsLabel: true))]
        case .dialog:
            return [.space, .button(TouchControl("dialogCancel", "Cancel")), .button(TouchControl("dialogOK", "OK"))]
        case .insertTable:
            return [
                .stepper(TouchControl("tableRows", "Rows"), min: 1, max: 100),
                .stepper(TouchControl("tableCols", "Columns"), min: 1, max: 20),
                .space,
                .button(TouchControl("dialogCancel", "Cancel")), .button(TouchControl("dialogOK", "OK")),
            ]
        case .none:
            return []
        }
    }

    /// Extra controls a person can add with View → Customize Touch Bar…
    private static let extras: [TouchControl] = [
        TouchControl("source", "Toggle Source Code Mode", symbols: ["chevron.left.forwardslash.chevron.right"]),
        TouchControl("sidebar", "Toggle Sidebar", symbols: ["sidebar.left"]),
        TouchControl("newTab", "New Tab", symbols: ["plus.square.on.square"]),
    ]

    private static func customizable(_ mode: TouchBarMode) -> Bool {
        [.text, .list, .table, .code, .def, .selectable].contains(mode)
    }

    /// Lit controls, stepper values and changed titles, from the page (`touchbar.set` `state`).
    private var on: Set<String> = []
    private var values: [String: Double] = [:]
    private var titles: [String: String] = [:]
    private var built: [String: AnyObject] = [:]
    private var context: String?
    private weak var candidateItem: NSCandidateListTouchBarItem<NSString>?
    private var candidateRequest = 0

    /// Spelling and completion suggestions for the word being typed.
    private func requestCandidates() {
        guard let item = candidateItem else { return }
        guard let text = context, !text.isEmpty, let last = text.last, !last.isWhitespace else {
            item.setCandidates([], forSelectedRange: NSRange(location: 0, length: 0), in: nil)
            return
        }
        let range = NSRange(location: (text as NSString).length, length: 0)
        candidateRequest = NSSpellChecker.shared.requestCandidates(forSelectedRange: range, in: text, types: NSTextCheckingAllSystemTypes, options: nil, inSpellDocumentWithTag: 0) { [weak self, weak item] sequence, results in
            DispatchQueue.main.async {
                guard let self = self, let item = item, sequence == self.candidateRequest else { return }
                let words = results.compactMap { r -> NSString? in
                    if let replacement = r.replacementString, !replacement.isEmpty { return replacement as NSString }
                    return nil
                }
                item.setCandidates(words, forSelectedRange: range, in: text)
            }
        }
    }

    func setState(_ state: [String: Any]) {
        on = Set(state["on"] as? [String] ?? [])
        values = (state["values"] as? [String: Any] ?? [:]).compactMapValues { ($0 as? NSNumber)?.doubleValue }
        titles = state["titles"] as? [String: String] ?? [:]
        context = state["context"] as? String
        applyState()
        requestCandidates()
    }

    private func applyState() {
        for (id, object) in built {
            if let segments = object as? TouchSegments, segments.trackingMode == .selectAny {
                segments.lit = segments.commandIds.map { on.contains($0) }
                for (index, lit) in segments.lit.enumerated() { segments.setSelected(lit, forSegment: index) }
            } else if let button = object as? TouchButton {
                if let title = titles[id] { button.title = title }
                if button.bezelColor != nil || on.contains(id) || button.state == .on {
                    button.bezelColor = on.contains(id) ? .controlAccentColor : nil
                    button.state = on.contains(id) ? .on : .off
                }
            } else if let stepper = object as? TouchStepper, let value = values[id] {
                stepper.value = value
            }
        }
    }

    private func identifier(_ name: String) -> NSTouchBarItem.Identifier {
        NSTouchBarItem.Identifier(Self.prefix + mode.rawValue + "." + name)
    }

    private func identifier(of item: TouchItem) -> NSTouchBarItem.Identifier {
        if case .space = item { return .flexibleSpace }
        return identifier(item.name)
    }

    /// The bar for the current mode (built once per mode change).
    var touchBar: NSTouchBar {
        if let cached = cached { return cached }
        popoverControls = [:]
        popovers = [:]
        built = [:]
        let bar = NSTouchBar()
        bar.delegate = self
        let defaults = Self.layout(mode).map { identifier(of: $0) }
        bar.defaultItemIdentifiers = defaults
        if Self.customizable(mode) {
            // View → Customize Touch Bar…: the editing bars can take the view buttons too.
            bar.customizationIdentifier = NSTouchBar.CustomizationIdentifier(Self.prefix + mode.rawValue)
            bar.customizationAllowedItemIdentifiers = defaults + Self.extras.map { identifier("extra." + $0.id) }
        }
        cached = bar
        return bar
    }

    // MARK: - Items

    func touchBar(_ touchBar: NSTouchBar, makeItemForIdentifier identifier: NSTouchBarItem.Identifier) -> NSTouchBarItem? {
        if let inner = popoverControls[identifier] {
            let item = NSCustomTouchBarItem(identifier: identifier)
            let button = makeButton(inner.control)
            if !inner.keepsOpen { button.popover = popovers[inner.parent] }
            item.view = button
            return item
        }
        if let extra = Self.extras.first(where: { self.identifier("extra." + $0.id) == identifier }) {
            let item = NSCustomTouchBarItem(identifier: identifier)
            item.view = makeButton(extra)
            item.customizationLabel = extra.label
            return item
        }
        guard let spec = Self.layout(mode).first(where: { self.identifier(of: $0) == identifier }) else { return nil }
        switch spec {
        case .space:
            return nil
        case .candidates:
            let item = NSCandidateListTouchBarItem<NSString>(identifier: identifier)
            item.delegate = self
            item.customizationLabel = "Suggestions"
            candidateItem = item
            DispatchQueue.main.async { [weak self] in self?.requestCandidates() }
            return item
        case .button(let control), .toggle(let control):
            let item = NSCustomTouchBarItem(identifier: identifier)
            let button = makeButton(control)
            if case .toggle = spec { button.setButtonType(.pushOnPushOff) }
            item.view = button
            item.customizationLabel = control.label
            built[control.id] = button
            applyState()
            return item

        case .stepper(let control, let min, let max):
            let stepper = TouchStepper(frame: .zero)
            stepper.segmentStyle = .separated
            stepper.trackingMode = .momentary
            stepper.segmentCount = 3
            stepper.setLabel("−", forSegment: 0)
            stepper.setLabel("+", forSegment: 2)
            stepper.setEnabled(false, forSegment: 1)
            stepper.commandId = control.id
            stepper.name = control.label
            stepper.minValue = min
            stepper.maxValue = max
            stepper.value = min
            stepper.target = self
            stepper.action = #selector(stepperChanged(_:))
            let item = NSCustomTouchBarItem(identifier: identifier)
            item.view = stepper
            item.customizationLabel = control.label
            built[control.id] = stepper
            applyState()
            return item

        case .segments(_, let controls, let stateful):
            let segments = TouchSegments(frame: .zero)
            segments.segmentStyle = .separated
            segments.trackingMode = stateful ? .selectAny : .momentary
            segments.segmentCount = controls.count
            for (index, control) in controls.enumerated() {
                if let image = control.image { segments.setImage(image, forSegment: index) } else { segments.setLabel(control.label, forSegment: index) }
                segments.setWidth(control.image == nil ? 0 : 44, forSegment: index)
                segments.setToolTip(control.label, forSegment: index)
            }
            segments.commandIds = controls.map { $0.id }
            segments.lit = controls.map { _ in false }
            segments.target = self
            segments.action = #selector(segmentTapped(_:))
            let item = NSCustomTouchBarItem(identifier: identifier)
            item.view = segments
            built[spec.name] = segments
            applyState()
            return item

        case .popover(let name, let face, let controls, let keepsOpen):
            let item = NSPopoverTouchBarItem(identifier: identifier)
            item.customizationLabel = face.label
            if let image = face.image { item.collapsedRepresentationImage = image } else { item.collapsedRepresentationLabel = face.label }
            item.showsCloseButton = true
            popovers[identifier] = item
            let inner = NSTouchBar()
            inner.delegate = self
            inner.defaultItemIdentifiers = controls.map { control in
                let id = self.identifier(name + "." + control.id)
                popoverControls[id] = (control, identifier, keepsOpen)
                return id
            }
            item.popoverTouchBar = inner
            return item
        }
    }

    private func makeButton(_ control: TouchControl) -> TouchButton {
        let button = TouchButton(title: control.label, target: self, action: #selector(buttonTapped(_:)))
        if let image = control.image {
            button.image = image
            if control.showsLabel {
                button.imagePosition = .imageLeading
            } else {
                button.title = ""
                button.imagePosition = .imageOnly
            }
        }
        button.bezelStyle = .rounded
        button.commandId = control.id
        button.setAccessibilityLabel(control.label)
        return button
    }

    @objc private func buttonTapped(_ sender: TouchButton) {
        send(sender.commandId)
        sender.popover?.dismissPopover(nil)
    }

    @objc private func segmentTapped(_ sender: TouchSegments) {
        var index = sender.selectedSegment
        if sender.trackingMode == .selectAny {
            // The tapped segment is the one whose lit state flipped; the page relights them all.
            index = sender.commandIds.indices.first { sender.isSelected(forSegment: $0) != sender.lit[$0] } ?? -1
            for (i, lit) in sender.lit.enumerated() { sender.setSelected(lit, forSegment: i) }
        }
        guard sender.commandIds.indices.contains(index) else { return }
        send(sender.commandIds[index])
    }

    @objc private func stepperChanged(_ sender: TouchStepper) {
        let step = sender.selectedSegment == 0 ? -1.0 : sender.selectedSegment == 2 ? 1.0 : 0
        sender.value = min(sender.maxValue, max(sender.minValue, sender.value + step))
        values[sender.commandId] = sender.value
        controller?.emit("touchValue", ["id": sender.commandId, "value": sender.value])
    }

    private func send(_ id: String) {
        controller?.emit("command", ["id": id])
    }

    // MARK: - Selftest (works on Macs without a Touch Bar: the items are built all the same)

    /// `{ mode, items: [{ identifier, kind, commands, built }], commands }`
    func dump() -> [String: Any] {
        let bar = touchBar
        let specs = Self.layout(mode)
        let items = specs.map { spec -> [String: Any] in
            let id = identifier(of: spec)
            let kind: String
            switch spec {
            case .button: kind = "button"
            case .toggle: kind = "toggle"
            case .segments: kind = "segments"
            case .popover: kind = "popover"
            case .stepper: kind = "stepper"
            case .candidates: kind = "candidates"
            case .space: kind = "space"
            }
            return ["identifier": id.rawValue, "kind": kind, "commands": spec.commands, "built": Self.commands(of: bar.item(forIdentifier: id))]
        }
        // What is lit, and stepper values, as built.
        var lit: [String] = []
        var stepped: [String: Double] = [:]
        var named: [String: String] = [:]
        for (id, object) in built {
            if let segments = object as? TouchSegments {
                for (i, cid) in segments.commandIds.enumerated() where segments.isSelected(forSegment: i) && segments.trackingMode == .selectAny { lit.append(cid) }
            } else if let button = object as? TouchButton {
                if button.state == .on { lit.append(id) }
                named[id] = button.title
            } else if let stepper = object as? TouchStepper { stepped[id] = stepper.value }
        }
        return [
            "mode": mode.rawValue,
            "identifiers": bar.defaultItemIdentifiers.map { $0.rawValue },
            "items": items,
            "commands": specs.flatMap { $0.commands },
            "lit": lit.sorted(),
            "values": stepped,
            "titles": named,
            "customizable": bar.customizationIdentifier != nil,
            "extras": (bar.customizationAllowedItemIdentifiers.filter { $0.rawValue.contains(".extra.") }).map { $0.rawValue },
        ]
    }

    /// Command ids found on the real control(s) of a built item.
    private static func commands(of item: NSTouchBarItem?) -> [String] {
        if let popover = item as? NSPopoverTouchBarItem {
            let inner = popover.popoverTouchBar
            return inner.defaultItemIdentifiers.flatMap { commands(of: inner.item(forIdentifier: $0)) }
        }
        if let button = item?.view as? TouchButton { return [button.commandId] }
        if let segments = item?.view as? TouchSegments { return segments.commandIds }
        if let stepper = item?.view as? TouchStepper { return [stepper.commandId] }
        return []
    }

    /// Triggers the control that carries `id` the way a tap would. False if the current mode has no such control.
    func tap(_ id: String) -> Bool {
        let bar = touchBar
        func tap(in bar: NSTouchBar) -> Bool {
            for identifier in bar.defaultItemIdentifiers {
                guard let item = bar.item(forIdentifier: identifier) else { continue }
                if let popover = item as? NSPopoverTouchBarItem {
                    if tap(in: popover.popoverTouchBar) { return true }
                } else if let button = item.view as? TouchButton, button.commandId == id {
                    return NSApp.sendAction(#selector(buttonTapped(_:)), to: self, from: button)
                } else if let segments = item.view as? TouchSegments, let index = segments.commandIds.firstIndex(of: id) {
                    if segments.trackingMode == .selectAny {
                        // A finger on a lit segment unlights it, and the other way round.
                        segments.setSelected(!segments.isSelected(forSegment: index), forSegment: index)
                        return NSApp.sendAction(#selector(segmentTapped(_:)), to: self, from: segments)
                    }
                    // A momentary control only has a selected segment while a finger is on it.
                    segments.trackingMode = .selectOne
                    segments.selectedSegment = index
                    defer {
                        segments.setSelected(false, forSegment: index)
                        segments.trackingMode = .momentary
                    }
                    return NSApp.sendAction(#selector(segmentTapped(_:)), to: self, from: segments)
                } else if let stepper = item.view as? TouchStepper, stepper.commandId == id {
                    // A tap on "+".
                    stepper.trackingMode = .selectOne
                    stepper.selectedSegment = 2
                    defer {
                        stepper.setSelected(false, forSegment: 2)
                        stepper.trackingMode = .momentary
                    }
                    return NSApp.sendAction(#selector(stepperChanged(_:)), to: self, from: stepper)
                }
            }
            return false
        }
        return tap(in: bar)
    }
}


extension TouchBarProvider: NSCandidateListTouchBarItemDelegate {
    func candidateListTouchBarItem(_ anItem: NSCandidateListTouchBarItem<AnyObject>, endSelectingCandidateAt index: Int) {
        guard index != NSNotFound, anItem.candidates.indices.contains(index), let text = anItem.candidates[index] as? String, !text.isEmpty else { return }
        controller?.emit("touchCandidate", ["text": text])
    }
}
