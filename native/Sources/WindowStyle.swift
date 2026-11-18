import Cocoa
import WebKit

/// `window.setStyle`: "classic" is a standard title bar above the page; "unibody" lets the page run to the top
/// edge of the window, with the traffic lights floating over it.
enum WindowStyle: String {
    case classic, unibody
}

extension WindowController {
    /// Height of the band at the top of the page that moves the window in the unibody style.
    static let dragStripHeight: CGFloat = 38

    func setWindowStyle(_ style: WindowStyle) {
        windowStyle = style
        applyWindowStyle()
    }

    /// Idempotent; also called after full-screen transitions.
    func applyWindowStyle() {
        let unibody = windowStyle == .unibody
        if window.styleMask.contains(.fullSizeContentView) != unibody {
            // AppKit keeps the content size across a style change, which would move the window's edges: the window
            // stays where it is and the page gains (or gives back) the height of the title bar.
            let frame = window.frame, fullScreen = window.styleMask.contains(.fullScreen)
            let responder = window.firstResponder
            if unibody { window.styleMask.insert(.fullSizeContentView) } else { window.styleMask.remove(.fullSizeContentView) }
            if !fullScreen, window.frame != frame { window.setFrame(frame, display: true) }
            if let responder = responder, window.firstResponder !== responder { window.makeFirstResponder(responder) }
        }
        if window.titlebarAppearsTransparent != unibody { window.titlebarAppearsTransparent = unibody }
        let visibility: NSWindow.TitleVisibility = unibody ? .hidden : .visible
        if window.titleVisibility != visibility { window.titleVisibility = visibility }
        TrafficLights.follow(self, autoHide: unibody && !headless)
        layoutWebView()
    }

    /// Where the web view belongs inside the content view. Unibody: everything, under the transparent title bar,
    /// unless the native tab bar is showing, which would otherwise cover the top of the page.
    var webViewFrame: NSRect {
        var frame = container.bounds
        if windowStyle == .unibody, window.tabGroup?.isTabBarVisible == true {
            let clear = container.convert(window.contentLayoutRect, from: nil)
            let visible = frame.intersection(clear)
            if !visible.isEmpty { frame = visible }
        }
        return frame
    }

    func layoutWebView() {
        guard !exporting else { return } // an image export has the web view at document size; it re-lays out when done
        let frame = webViewFrame
        if webView.frame != frame { webView.frame = frame }
    }

    // MARK: - Title-bar behaviour of the page

    /// A mouse-down may be turned into a window drag or a title-bar double click only once, whoever asks first
    /// (the shell's own drag strip, or the page through `window.startDrag` / `window.titlebarDoubleClick`).
    func claimTitlebarEvent(_ event: NSEvent?) -> Bool {
        guard let event = event else { return true }
        if event.eventNumber == handledTitlebarEvent { return false }
        handledTitlebarEvent = event.eventNumber
        return true
    }

    /// What a double click on a title bar does, per System Settings > Desktop & Dock.
    func performTitlebarDoubleClick() {
        let defaults = UserDefaults.standard
        let action = defaults.string(forKey: "AppleActionOnDoubleClick")
            ?? (defaults.bool(forKey: "AppleMiniaturizeOnDoubleClick") ? "Minimize" : "Maximize")
        switch action {
        case "Minimize": window.performMiniaturize(nil)
        case "None": break
        default: window.performZoom(nil)
        }
    }

    /// True when the point (CSS px from the top-left corner of the page) is empty page chrome: nothing there that
    /// takes clicks or text. Elements can opt out with `data-no-drag`.
    static let dragProbe = """
        (function (x, y) {
          var vv = window.visualViewport;
          if (vv && vv.scale && vv.scale !== 1) { x = x / vv.scale + vv.offsetLeft; y = y / vv.scale + vv.offsetTop; }
          var el = document.elementFromPoint(x, y);
          if (!el || el === document.documentElement || el === document.body) return true;
          if (el.isContentEditable) return false;
          if (el.closest('[data-no-drag],a[href],button,input,select,textarea,label,summary,option,video,audio,iframe,embed,object,[role="button"],[role="tab"],[role="menuitem"],[role="link"],[role="slider"],[role="checkbox"],[role="switch"],[draggable="true"]')) return false;
          var cursor = getComputedStyle(el).cursor;
          return cursor !== 'pointer' && cursor !== 'text' && !/resize$/.test(cursor);
        })
        """

    /// Asks the page whether `point` (web view coordinates) lies in the drag strip on empty chrome.
    func probeDragStrip(at point: NSPoint, completion: @escaping (Bool) -> Void) {
        let fromTop = webView.isFlipped ? point.y : webView.bounds.height - point.y
        guard windowStyle == .unibody, webView.bounds.contains(point), fromTop >= 0, fromTop < Self.dragStripHeight else {
            return completion(false)
        }
        let zoom = max(webView.pageZoom, 0.01)
        let script = "\(Self.dragProbe)(\(Double(point.x / zoom)), \(Double(fromTop / zoom)))"
        webView.evaluateJavaScript(script) { value, _ in completion(value as? Bool ?? false) }
    }

    /// Unibody: the top of the page stands in for the title bar it covers. Runs after AppKit dispatched the event,
    /// so controls of the page (and the traffic lights) have had their click.
    func titlebarStripMouseDown(_ event: NSEvent) {
        guard windowStyle == .unibody, !window.styleMask.contains(.fullScreen), window.attachedSheet == nil, window.isVisible else { return }
        // Only when the web view itself was hit: the system's own title bar views move the window themselves.
        guard let hit = window.contentView?.superview?.hitTest(event.locationInWindow),
              hit === webView || hit.isDescendant(of: webView) else { return }
        probeDragStrip(at: webView.convert(event.locationInWindow, from: nil)) { [weak self] draggable in
            guard let self = self, draggable, self.window.lastMouseDown === event else { return }
            if event.clickCount == 2 {
                if self.claimTitlebarEvent(event) { self.performTitlebarDoubleClick() }
            } else if event.clickCount == 1, NSEvent.pressedMouseButtons & 1 == 1, self.claimTitlebarEvent(event) {
                self.window.performDrag(with: event)
            }
        }
    }

    /// Keeps the window title clear of the sidebar: an empty accessory on the left of the title bar as wide as
    /// the sidebar (nil: none). The unibody style has no visible title, so it is skipped there.
    func setTitleInset(_ width: CGFloat?) {
        let existing = window.titlebarAccessoryViewControllers.firstIndex { $0.identifier?.rawValue == "dev.livemark.titleInset" }
        let wanted = windowStyle == .unibody || window.styleMask.contains(.fullScreen) ? nil : width.map { max(0, $0 - 70) }
        if let index = existing {
            if let w = wanted, w > 0 {
                window.titlebarAccessoryViewControllers[index].view.frame.size.width = w
                return
            }
            window.removeTitlebarAccessoryViewController(at: index)
        }
        guard let w = wanted, w > 0 else { return }
        let accessory = NSTitlebarAccessoryViewController()
        accessory.identifier = NSUserInterfaceItemIdentifier("dev.livemark.titleInset")
        accessory.layoutAttribute = .left
        accessory.view = NSView(frame: NSRect(x: 0, y: 0, width: w, height: 1))
        window.addTitlebarAccessoryViewController(accessory)
    }

    /// The window takes the theme's light or dark look, but the page keeps seeing the system's
    /// (`prefers-color-scheme`), or "follow the system" themes would follow the window instead.
    func keepSystemAppearanceInPage() {
        webView.appearance = window.appearance == nil ? nil : NSAppearance(named: NSApp.effectiveAppearance.isDark ? .darkAqua : .aqua)
    }
}


/// Unibody windows: the close / minimise / zoom buttons show while the pointer is near the
/// top of the window (or in full screen) and fade away two seconds after it leaves.
final class TrafficLights {
    private static var byWindow: [Int: TrafficLights] = [:]
    private weak var controller: WindowController?
    private var monitor: Any?
    private var hideTimer: Timer?

    static func follow(_ controller: WindowController, autoHide: Bool) {
        if !autoHide {
            byWindow[controller.id]?.stop()
            byWindow[controller.id] = nil
            return
        }
        guard byWindow[controller.id] == nil else { return }
        let lights = TrafficLights(controller)
        byWindow[controller.id] = lights
    }

    static func stop(window id: Int) {
        byWindow[id]?.stop()
        byWindow[id] = nil
    }

    private init(_ controller: WindowController) {
        self.controller = controller
        controller.window.acceptsMouseMovedEvents = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .mouseExited]) { [weak self] event in
            self?.moved(event)
            return event
        }
        scheduleHide()
    }

    private func moved(_ event: NSEvent) {
        guard let window = controller?.window, event.window === window else { return }
        let fromTop = window.frame.height - event.locationInWindow.y
        if window.styleMask.contains(.fullScreen) || (event.type == .mouseMoved && fromTop <= 30 && fromTop >= 0) {
            setVisible(true)
            hideTimer?.invalidate()
            hideTimer = nil
        } else if hideTimer == nil {
            scheduleHide()
        }
    }

    private func scheduleHide() {
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
            guard let self = self, let window = self.controller?.window, !window.styleMask.contains(.fullScreen) else { return }
            self.hideTimer = nil
            self.setVisible(false)
        }
    }

    private func setVisible(_ on: Bool) {
        guard let window = controller?.window else { return }
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            guard let button = window.standardWindowButton(kind), button.isHidden == on else { continue }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.2
                button.animator().alphaValue = on ? 1 : 0
            } completionHandler: {
                button.isHidden = !on
            }
            if on { button.isHidden = false }
        }
    }

    private func stop() {
        if let monitor = monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        hideTimer?.invalidate()
        setVisible(true)
    }
}
