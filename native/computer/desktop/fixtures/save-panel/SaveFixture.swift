import AppKit
import Foundation

final class SyntheticEditor: NSTextView {
    override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
        if CommandLine.arguments.count > 2 && NSStringFromSelector(selector) == "setAccessibilityValue:" { return false }
        return super.isAccessibilitySelectorAllowed(selector)
    }
    override func selectAll(_ sender: Any?) {
        if CommandLine.arguments.last == "broken-synthetic" { return }
        super.selectAll(sender)
    }
}
final class Document: NSObject {
    let body = "# easy-pi 保存回归\n\n| Level | Name | Responsibility |\n| 0 | fixture | test only |\n"
    let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 640, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let editor = SyntheticEditor(frame: NSRect(x: 20, y: 20, width: 600, height: 300))
    let panel = NSSavePanel()
    var saved: URL?
    func emit(_ event: String, _ extra: [String:Any] = [:]) {
        var row=extra; row["event"]=event
        print(String(data: try! JSONSerialization.data(withJSONObject: row,options:[.sortedKeys]),encoding:.utf8)!)
        fflush(stdout)
    }
    func start() {
        window.animationBehavior = .none
        window.title="easy-pi-owned-save-document"
        editor.string=body; editor.setAccessibilityIdentifier("reopened-body")
        window.contentView?.addSubview(editor)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps:true)
        if CommandLine.arguments.count > 2 {
            window.makeFirstResponder(editor)
            editor.setSelectedRange(NSRange(location:(body as NSString).length,length:0))
            DispatchQueue.main.asyncAfter(deadline:.now()+0.3) { self.emit("ready",["pid":ProcessInfo.processInfo.processIdentifier,"body":self.body]) }; return
        }
        panel.title="easy-pi-owned-save-panel"
        panel.nameFieldStringValue="old-name.md"
        panel.directoryURL=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
        panel.beginSheetModal(for:window) { [self] response in
            if response == .OK,let url=panel.url {
                do {
                    // Test fixture writes only a newly chosen file; no overwrite.
                    guard url.deletingLastPathComponent().standardizedFileURL == panel.directoryURL?.standardizedFileURL else {
                        emit("failure", ["error": "fixture directory changed"]); return
                    }
                    try Data(body.utf8).write(to:url,options:.withoutOverwriting)
                    saved=url; editor.string="Closed after save; use File > Reopen Saved"
                    emit("saved",["name":url.lastPathComponent,"path":url.path])
                } catch { emit("failure",["error":String(describing:error)]) }
            } else { emit("cancelled") }
        }
        emit("ready",["pid":ProcessInfo.processInfo.processIdentifier])
    }
    @objc func reopen(_ sender: Any?) {
        guard let saved else {emit("failure",["error":"no saved document"]);return}
        do {editor.string=try String(contentsOf:saved,encoding:.utf8);emit("reopened",["body":editor.string])}
        catch {emit("failure",["error":String(describing:error)])}
    }
}
let app=NSApplication.shared
app.setActivationPolicy(.regular)
let document=Document()
let menu=NSMenu()
let file=NSMenuItem(title:"File",action:nil,keyEquivalent:"")
let fileMenu=NSMenu(title:"File")
let reopen=NSMenuItem(title:"Reopen Saved",action:#selector(Document.reopen(_:)),keyEquivalent:"o")
reopen.target=document;fileMenu.addItem(reopen);file.submenu=fileMenu;menu.addItem(file)
let edit=NSMenuItem(title:"Edit",action:nil,keyEquivalent:"")
let editMenu=NSMenu(title:"Edit")
editMenu.addItem(withTitle:"Select All",action:#selector(NSText.selectAll(_:)),keyEquivalent:"a")
edit.submenu=editMenu;menu.addItem(edit);app.mainMenu=menu
document.start()
DispatchQueue.global().async {
    while let line=readLine() {
        DispatchQueue.main.async {
            if line=="quit" {document.panel.cancel(nil);app.terminate(nil)}
            else if line=="state" {
                document.emit("state",[
                "name":document.panel.nameFieldStringValue,"body":document.editor.string,
                "active":app.isActive,
                "frontPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
                "keyWindow":app.keyWindow?.windowNumber ?? -1,
                "panelWindow":document.panel.windowNumber,
                "documentWindow":document.window.windowNumber,
                "pid":ProcessInfo.processInfo.processIdentifier
            ])}
        }
    }
    DispatchQueue.main.async {document.panel.cancel(nil);app.terminate(nil)}
}
app.run()
