import AppKit
import WebKit

// A disposable application: stdin is readiness/readback/quit only, never an action shortcut.
func emit(_ row: [String: Any]) {
    print(String(data: try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
    fflush(stdout)
}
final class Canvas: NSView {
    var clicks = 0
    var scrolls = 0
    var drags = 0
    var releases = 0
    var last = NSPoint.zero
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill(); bounds.fill()
        NSColor.systemBlue.setFill(); NSRect(x: 30, y: 30, width: 180, height: 100).fill()
        ("Owned canvas: click, scroll, drag" as NSString).draw(at: NSPoint(x: 30, y: 170), withAttributes: [.foregroundColor: NSColor.black])
    }
    override func mouseDown(with event: NSEvent) { clicks += 1; last = convert(event.locationInWindow, from: nil) }
    override func mouseDragged(with event: NSEvent) {
        drags += 1; last = convert(event.locationInWindow, from: nil)
        if drags == 1 { emit(["event": "drag-started"]) }
    }
    override func mouseUp(with event: NSEvent) {
        releases += 1; last = convert(event.locationInWindow, from: nil)
        emit(["event": "pointer-released", "count": releases])
    }
    override func scrollWheel(with event: NSEvent) { if event.scrollingDeltaX != 0 || event.scrollingDeltaY != 0 { scrolls += 1 } }
}
final class Fixture: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let mode = CommandLine.arguments[1]
    let window = NSWindow(contentRect: NSRect(x: 160, y: 180, width: 640, height: 420), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let second = NSWindow(contentRect: NSRect(x: 300, y: 250, width: 520, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let editor = NSTextView(frame: NSRect(x: 20, y: 20, width: 600, height: 360))
    let other = NSTextView(frame: NSRect(x: 20, y: 20, width: 480, height: 260))
    let canvas = Canvas(frame: NSRect(x: 0, y: 0, width: 640, height: 420))
    var web: WKWebView?
    var submitted = ""
    func start() {
        window.title = "easy-pi-owned-general-main"
        second.title = "easy-pi-owned-general-second"
        window.animationBehavior = .none; second.animationBehavior = .none
        editor.string = "original"; editor.setAccessibilityIdentifier("general-editor")
        other.string = "untouched"; other.setAccessibilityIdentifier("other-editor")
        if mode == "web-form" {
            let config = WKWebViewConfiguration()
            config.userContentController.add(self, name: "oracle")
            let view = WKWebView(frame: window.contentView!.bounds, configuration: config)
            web = view; view.navigationDelegate = self; window.contentView?.addSubview(view)
            view.loadHTMLString("""
            <!doctype html><meta charset="utf-8"><title>Owned local form</title>
            <style>body{font:24px system-ui;margin:40px}input,button{font:inherit;display:block;margin:20px 0}</style>
            <form onsubmit="event.preventDefault();webkit.messageHandlers.oracle.postMessage(document.getElementById('name').value);document.getElementById('result').textContent='Submitted'">
            <label>Name<input id="name" aria-label="Owned name" autofocus></label><button type="submit">Submit</button></form><p id="result"></p>
            """, baseURL: nil)
        } else if mode.hasPrefix("pointer-") {
            window.contentView?.addSubview(canvas)
        } else {
            window.contentView?.addSubview(editor)
            second.contentView?.addSubview(other)
            if mode == "window-switch" { second.orderFront(nil) }
        }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        if web == nil {
            window.makeFirstResponder(mode.hasPrefix("pointer-") ? canvas : editor)
            DispatchQueue.main.async { emit(["event": "ready"]) }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { emit(["event": "ready"]) }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        submitted = message.body as? String ?? ""
    }
    func state(_ id: String) {
        var row: [String: Any] = ["event": "state", "id": id, "body": editor.string, "other": other.string,
            "clicks": canvas.clicks, "scrolls": canvas.scrolls, "drags": canvas.drags, "releases": canvas.releases,
            "lastX": canvas.last.x, "lastY": canvas.last.y, "submitted": submitted,
            "active": NSApp.isActive, "keyWindow": NSApp.keyWindow?.title ?? ""]
        if let web {
            // Read-only oracle; input and submission must come through the Computer tool.
            web.evaluateJavaScript("document.getElementById('name').value") { value, error in
                row["webValue"] = value as? String ?? ""; row["webError"] = error.map(String.init(describing:)) ?? ""
                emit(row)
            }
        } else { emit(row) }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixture = Fixture()
let menu = NSMenu()
let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
let submenu = NSMenu(title: "Edit")
submenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
edit.submenu = submenu; menu.addItem(edit); app.mainMenu = menu
fixture.start()
DispatchQueue.global().async {
    while let line = readLine() {
        DispatchQueue.main.async {
            if line == "quit" { app.terminate(nil) }
            else if line.hasPrefix("state ") { fixture.state(String(line.dropFirst(6))) }
        }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
