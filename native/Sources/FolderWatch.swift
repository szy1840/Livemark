import Foundation
import CoreServices

/// Watches the folder shown in a window's sidebar and tells the page what changed.
/// One watcher per window; events are coalesced by FSEvents (`latency`) and sent
/// as `folderChanged {root, paths}`.
final class FolderWatcher {
    private static var watchers: [String: FolderWatcher] = [:]

    /// `file`: watch just that document (through its folder) and send `fileChanged {path}` instead.
    static func watch(_ root: String?, for controller: WindowController, file: Bool = false) {
        let key = "\(controller.id):\(file ? "file" : "folder")"
        watchers[key]?.stop()
        watchers[key] = nil
        guard let root = root else { return }
        let watcher = FolderWatcher(root: file ? (root as NSString).deletingLastPathComponent : root, file: file ? root : nil, controller: controller)
        if watcher.start() { watchers[key] = watcher }
    }

    static func stop(window id: Int) {
        for key in watchers.keys where key.hasPrefix("\(id):") {
            watchers[key]?.stop()
            watchers[key] = nil
        }
    }

    let root: String
    let file: String?
    private weak var controller: WindowController?
    private var stream: FSEventStreamRef?

    private init(root: String, file: String?, controller: WindowController) {
        self.root = root
        self.file = file
        self.controller = controller
    }

    private func start() -> Bool {
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info = info else { return }
            let watcher = Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue()
            let list = unsafeBitCast(paths, to: NSArray.self) as? [String] ?? []
            watcher.changed(Array(list.prefix(count)))
        }
        let flags = UInt32(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagWatchRoot)
        guard let stream = FSEventStreamCreate(nil, callback, &context, [root] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.3, flags) else { return false }
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
        guard FSEventStreamStart(stream) else {
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            return false
        }
        self.stream = stream
        return true
    }

    private func changed(_ paths: [String]) {
        if let file = file {
            let target = (file as NSString).resolvingSymlinksInPath
            if paths.contains(where: { $0 == file || ($0 as NSString).resolvingSymlinksInPath == target }) {
                controller?.emit("fileChanged", ["path": file, "exists": FileManager.default.fileExists(atPath: file)])
            }
            return
        }
        // Editors' and the system's scratch files say nothing about the folder.
        let shown = paths.filter { p in
            let name = (p as NSString).lastPathComponent
            return !(name == ".DS_Store" || name.hasPrefix("~$") || name.hasPrefix(".~") || name.hasSuffix(".swp") || name.hasSuffix("~"))
        }
        guard !shown.isEmpty else { return }
        controller?.emit("folderChanged", ["root": root, "paths": shown, "rootGone": !FileManager.default.fileExists(atPath: root)])
    }

    private func stop() {
        guard let stream = stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }
}
