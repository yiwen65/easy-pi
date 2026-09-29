import AppKit
func emit(_ row: [String: Any]) {
    print(String(data: try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
    fflush(stdout)
}
final class Backdrop: NSView {
    var changed = false
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill(); bounds.fill()
        (changed ? NSColor.red : NSColor.blue).setFill()
        NSRect(x: 550, y: 350, width: 40, height: 40).fill()
    }
}
final class Fixture: NSObject {
    let mode = CommandLine.arguments[1]
    let window = NSWindow(contentRect: NSRect(x: 160, y: 180, width: 640, height: 420), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let backdrop = Backdrop(frame: NSRect(x: 0, y: 0, width: 640, height: 420))
    var button: NSButton!
    var existingCover: NSButton?
    var clicks = 0
    var covered = 0
    func makeButton() -> NSButton {
        let b = NSButton(frame: NSRect(x: 80, y: 150, width: 320, height: 130))
        b.title = "Owned target"; b.bezelStyle = .regularSquare
        b.setAccessibilityIdentifier("owned-target")
        b.target = self; b.action = #selector(clicked)
        return b
    }
    @objc func clicked() { clicks += 1 }
    @objc func intercepted() { covered += 1 }
    func start() {
        window.title = "easy-pi-owned-region-guard"
        window.animationBehavior = .none
        window.contentView = backdrop
        button = makeButton(); backdrop.addSubview(button)
        if mode == "reorder-cover" {
            let cover = makeButton()
            cover.setAccessibilityIdentifier("owned-existing-cover")
            cover.action = #selector(intercepted)
            backdrop.addSubview(cover, positioned: .below, relativeTo: button)
            existingCover = cover
        }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { emit(["event": "ready"]) }
    }
    func mutate() {
        if mode == "distant" { backdrop.changed = true; backdrop.needsDisplay = true }
        else if mode == "reorder-cover", let cover = existingCover {
            backdrop.addSubview(cover, positioned: .above, relativeTo: button)
        } else if mode == "replace" {
            button.removeFromSuperview(); button = makeButton(); backdrop.addSubview(button)
        } else if mode == "move" { button.setFrameOrigin(NSPoint(x: 300, y: 30)) }
        else if mode == "cover" || mode == "transparent-cover" {
            let cover = makeButton()
            cover.title = mode == "cover" ? "Blocked" : "Owned target"
            cover.setAccessibilityIdentifier("owned-cover")
            cover.isTransparent = mode == "transparent-cover"
            cover.action = #selector(intercepted)
            backdrop.addSubview(cover, positioned: .above, relativeTo: button)
        }
        window.displayIfNeeded()
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150)) {
            emit(["event": "mutated"])
        }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = Fixture(); fixture.start()
DispatchQueue.global().async {
    while let line = readLine() {
        DispatchQueue.main.async {
            if line == "mutate" { fixture.mutate() }
            else if line == "state" { emit(["event": "state", "clicks": fixture.clicks, "covered": fixture.covered]) }
            else if line == "quit" { app.terminate(nil) }
        }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
