import Cocoa

// Line-buffer stdout so `--selftest` output is visible when piped.
setvbuf(stdout, nil, _IOLBF, 0)
// A child (pandoc) that exits early must not kill us when we write to its stdin.
signal(SIGPIPE, SIG_IGN)
// AppKit would otherwise treat bare command-line arguments as files to open; we parse argv ourselves.
// The page owns the menus: keep AppKit from adding its own Dictation / Emoji items to a menu titled "Edit".
UserDefaults.standard.register(defaults: [
    "NSTreatUnknownArgumentsAsOpen": "NO",
    "NSDisabledDictationMenuItem": true,
    "NSDisabledCharacterPaletteMenuItem": true,
])
NSWindow.allowsAutomaticWindowTabbing = true

let application = NSApplication.shared
let appDelegate = AppDelegate()
application.delegate = appDelegate
application.setActivationPolicy(appDelegate.headless ? .accessory : .regular)
application.run()
