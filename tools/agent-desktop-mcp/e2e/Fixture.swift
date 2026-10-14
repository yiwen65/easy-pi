import AppKit

final class Fixture: NSObject, NSApplicationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 240), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let input = NSTextField(frame: NSRect(x: 30, y: 150, width: 420, height: 30))
    let status = NSTextField(labelWithString: "Clicks: 0")
    let shortcutStatus = NSTextField(labelWithString: "Shortcut: 0")
    var clicks = 0
    var shortcuts = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Easy Pi Desktop E2E"
        window.isReleasedWhenClosed = false
        input.setAccessibilityLabel("E2E Input")
        input.setAccessibilityIdentifier("e2e-input")
        input.placeholderString = "Only temporary test text"
        let button = NSButton(title: "Increment", target: self, action: #selector(increment))
        button.frame = NSRect(x: 30, y: 100, width: 130, height: 32)
        button.setAccessibilityIdentifier("e2e-increment")
        status.frame = NSRect(x: 200, y: 105, width: 230, height: 24)
        shortcutStatus.frame = NSRect(x: 30, y: 50, width: 400, height: 24)
        for view in [input, button, status, shortcutStatus] { window.contentView?.addSubview(view) }
        let menu = NSMenu()
        let root = NSMenuItem(title: "Test", action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: "Test")
        let item = NSMenuItem(title: "Verify Shortcut", action: #selector(shortcut), keyEquivalent: "e")
        item.keyEquivalentModifierMask = [.command, .shift]
        item.target = self
        submenu.addItem(item)
        root.submenu = submenu
        menu.addItem(root)
        NSApp.mainMenu = menu
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(input)
        NSApp.activate(ignoringOtherApps: true)
        print("READY")
        fflush(stdout)
    }
    @objc func increment() {
        clicks += 1
        status.stringValue = "Clicks: \(clicks)"
    }
    @objc func shortcut() {
        shortcuts += 1
        shortcutStatus.stringValue = "Shortcut: \(shortcuts)"
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = Fixture()
app.delegate = fixture
app.run()
