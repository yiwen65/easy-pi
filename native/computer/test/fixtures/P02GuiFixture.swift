import AppKit
import Darwin
import Foundation

// A directly spawned, local-only test target/control surface. It does not host the
// SDK's AppKit facilities or establish the parent process's TCC responsibility.
private enum ProtocolLimits {
    static let inputBytes = 1024
    static let outputBytes = 512
    static let pendingOutputs = 32
    static let maxJSONInteger: UInt64 = 9_007_199_254_740_991

    static func isToken(_ value: String) -> Bool {
        let bytes = value.utf8
        return (1...64).contains(bytes.count) && bytes.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) ||
                (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }
}

private enum FixtureState: String, Codable, Sendable {
    case idle, armed, busy, stopping, unknown, done
}

private enum CommandName: String, Decodable {
    case state, checkpoint, quit
    case stopTest = "stop-test"
}

private struct Command: Decodable {
    let nonce: String
    let id: String
    let command: CommandName
    let state: FixtureState?

    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    private enum Fields: String, CodingKey { case nonce, id, command, state }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Fields.self)
        nonce = try values.decode(String.self, forKey: .nonce)
        id = try values.decode(String.self, forKey: .id)
        command = try values.decode(CommandName.self, forKey: .command)
        if command == .state {
            state = try values.decode(FixtureState.self, forKey: .state)
        } else {
            state = nil
        }
        let keys = try decoder.container(keyedBy: Key.self).allKeys.map(\.stringValue)
        let expected: Set<String> = command == .state
            ? ["nonce", "id", "command", "state"] : ["nonce", "id", "command"]
        guard Set(keys) == expected, ProtocolLimits.isToken(nonce), ProtocolLimits.isToken(id) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Invalid command fields"))
        }
    }
}

private struct Event: Encodable {
    let event: String
    let nonce: String
    let pid: Int32
    let windowId: String
    let seq: UInt64
    let counter: UInt64
    let state: FixtureState
    let visible: Bool
    let onActiveSpace: Bool
    let mainThread: Bool
    let id: String?
    let reason: String?
}

// Only the pending count/failure flag are shared; the lock never covers I/O.
// A dedicated serial writer handles pipe/socket partial writes off the UI thread.
// At most 32 complete, <=512-byte JSONL records can be queued or in flight.
private final class BoundedOutput: @unchecked Sendable {
    private let queue = DispatchQueue(label: "p02.fixture.stdout")
    private let lock = NSLock()
    private var pending = 0
    private var failed = false

    func enqueue(_ data: Data, completion: @escaping @Sendable (Bool) -> Void) -> Bool {
        lock.lock()
        guard !failed, pending < ProtocolLimits.pendingOutputs, data.count <= ProtocolLimits.outputBytes else {
            lock.unlock()
            return false
        }
        pending += 1
        lock.unlock()
        queue.async { [self] in
            lock.lock()
            var succeeded = !failed
            lock.unlock()
            if succeeded {
                succeeded = data.withUnsafeBytes { bytes in
                    guard let base = bytes.baseAddress else { return false }
                    var offset = 0
                    while offset < bytes.count {
                        let count = Darwin.write(STDOUT_FILENO, base.advanced(by: offset), bytes.count - offset)
                        if count < 0 && errno == EINTR { continue }
                        guard count > 0 else { return false }
                        offset += count
                    }
                    return true
                }
            }
            lock.lock()
            pending -= 1
            failed = failed || !succeeded
            lock.unlock()
            completion(succeeded)
        }
        return true
    }
}

private enum InputMessage: Sendable {
    case line(Data), tooLong, truncated, readFailed, eof
}

private enum InputPump {
    static func run(deliver: @Sendable (InputMessage) -> Void) {
        var buffer = [UInt8](repeating: 0, count: 256)
        var line = Data()
        var discarding = false
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else {
                if count < 0 { deliver(.readFailed) }
                else if !line.isEmpty { deliver(.truncated) }
                deliver(.eof)
                return
            }
            for byte in buffer.prefix(count) {
                if byte == 10 {
                    if !discarding {
                        if line.last == 13 { line.removeLast() }
                        deliver(.line(line))
                    }
                    line.removeAll(keepingCapacity: true)
                    discarding = false
                } else if !discarding {
                    if line.count == ProtocolLimits.inputBytes {
                        line.removeAll(keepingCapacity: true)
                        discarding = true
                        deliver(.tooLong)
                    } else {
                        line.append(byte)
                    }
                }
            }
        }
    }
}

@MainActor
private final class StopButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
private final class FixtureController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let nonce: String
    private let pid = ProcessInfo.processInfo.processIdentifier
    private let output = BoundedOutput()
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 560, height: 320),
        styleMask: [.titled, .closable], backing: .buffered, defer: false
    )
    private let stateLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let counterLabel = NSTextField(labelWithString: "counter=0")
    private var incrementButton: NSButton!
    private var stopButton: StopButton!
    private var windowId = "0"
    private var seq: UInt64 = 0
    private var counter: UInt64 = 0
    private var state: FixtureState = .idle
    private var stopLatched = false
    private var closing = false
    private var outputFailed = false
    private var failureReason: String?

    init(nonce: String) {
        self.nonce = nonce
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "P02 GUI Fixture \(nonce)"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.animationBehavior = .none
        // Visible above ordinary windows, without making this app/key window active.
        window.level = .floating
        let content = window.contentView!
        let marker = NSTextField(labelWithString: "P02_FIXTURE_V1 — LOCAL NATIVE TEST")
        marker.frame = NSRect(x: 24, y: 280, width: 512, height: 20)
        marker.font = .systemFont(ofSize: 13, weight: .semibold)
        stateLabel.frame = NSRect(x: 24, y: 237, width: 512, height: 34)
        stateLabel.font = .systemFont(ofSize: 25, weight: .bold)
        detailLabel.frame = NSRect(x: 24, y: 178, width: 512, height: 52)
        detailLabel.font = .systemFont(ofSize: 14)
        counterLabel.frame = NSRect(x: 24, y: 131, width: 512, height: 32)
        counterLabel.font = .monospacedSystemFont(ofSize: 24, weight: .medium)
        incrementButton = NSButton(title: "P02 Increment", target: self, action: #selector(increment(_:)))
        incrementButton.frame = NSRect(x: 24, y: 77, width: 220, height: 38)
        incrementButton.bezelStyle = .rounded
        incrementButton.setAccessibilityIdentifier("p02-increment")
        incrementButton.setAccessibilityLabel("P02 Increment")
        stopButton = StopButton(title: "Stop", target: self, action: #selector(userStop(_:)))
        stopButton.frame = NSRect(x: 348, y: 71, width: 188, height: 50)
        stopButton.bezelStyle = .rounded
        stopButton.font = .systemFont(ofSize: 20, weight: .bold)
        stopButton.setAccessibilityIdentifier("p02-stop")
        let warning = NSTextField(wrappingLabelWithString:
            "Stop/close only requests cancellation. SDK settlement does NOT prove OS terminality; native effects may still arrive.")
        warning.frame = NSRect(x: 24, y: 16, width: 512, height: 44)
        warning.font = .systemFont(ofSize: 12)
        let views: [NSView] = [marker, stateLabel, detailLabel, counterLabel, incrementButton, stopButton, warning]
        for view in views { content.addSubview(view) }
        window.center()
        render()
        window.orderFront(nil)
        window.displayIfNeeded()
        let ownNumber = window.windowNumber
        if ownNumber > 0 && window.isVisible && window.isOnActiveSpace {
            windowId = String(ownNumber)
            emit("ready")
        } else {
            reject("window-not-ready")
        }
        // Synchronous main-queue delivery bounds command backlog to one record.
        // Blocking stdin/stdout work never occupies the AppKit main thread.
        DispatchQueue(label: "p02.fixture.stdin").async { [self] in
            InputPump.run { message in
                DispatchQueue.main.sync { self.receive(message) }
            }
        }
    }

    private func render() {
        stateLabel.stringValue = "STATE: \(state.rawValue.uppercased())"
        switch state {
        case .idle: detailLabel.stringValue = "Idle. The parent has not announced native work."
        case .armed: detailLabel.stringValue = "Armed. Parent may dispatch. Stop requests cancellation/no new work."
        case .busy: detailLabel.stringValue = "Busy. Native work may be in flight. Stop requests cancellation."
        case .stopping: detailLabel.stringValue = "Stopping. Parent must stop new dispatch; late effects remain counted."
        case .unknown: detailLabel.stringValue = "Unknown. Native completion is not proven. Do not resume."
        case .done: detailLabel.stringValue = "Done, as reported by the parent. OS terminality is not proven."
        }
        if let failureReason { detailLabel.stringValue = "Protocol failure: \(failureReason). Native work may persist." }
        stateLabel.textColor = (state == .stopping || state == .unknown) ? .systemRed : .labelColor
        counterLabel.stringValue = "counter=\(counter)"
        // Never disable increment: late AXPress delivery must remain observable,
        // including after Stop and parent-reported unknown/done states.
        stopButton?.isEnabled = !closing
        window.contentView?.needsDisplay = true
        window.displayIfNeeded()
    }

    @objc private func increment(_ sender: NSButton) {
        // This callback is the effect oracle, not an admission gate. Count every
        // delivered press for this fixture's lifetime, even after the Stop latch.
        guard counter < ProtocolLimits.maxJSONInteger else { reject("counter-overflow"); return }
        counter += 1
        render()
        emit("effect")
    }

    @objc private func userStop(_ sender: NSButton) { requestStop() }

    private func requestStop() {
        guard !closing else { return }
        stopLatched = true
        state = .stopping
        render()
        emit("stop")
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if closing { return true }
        requestStop()
        return false // User close is a stop request; only parent quit/EOF closes.
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if closing { return .terminateNow }
        requestStop()
        return .terminateCancel
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func receive(_ message: InputMessage) {
        guard !closing else { return }
        switch message {
        case .tooLong: reject("input-too-long")
        case .truncated: reject("truncated-input")
        case .readFailed: reject("stdin-read-failed")
        case .eof: closeFixture(id: nil)
        case .line(let data):
            guard let command = try? JSONDecoder().decode(Command.self, from: data), command.nonce == nonce else {
                reject("invalid-command")
                return
            }
            switch command.command {
            case .state:
                guard let next = command.state else { reject("missing-state", id: command.id); return }
                if stopLatched && (next == .idle || next == .armed || next == .busy) {
                    reject("state-after-stop", id: command.id)
                    return
                }
                state = next
                if next == .stopping { stopLatched = true }
                render()
                emit("ack", id: command.id)
            case .checkpoint:
                render()
                emit("ack", id: command.id)
            case .stopTest:
                requestStop()
                emit("ack", id: command.id)
            case .quit:
                closeFixture(id: command.id)
            }
        }
    }

    private func reject(_ reason: String, id: String? = nil) {
        failureReason = reason
        requestStop()
        emit("error", id: id, reason: reason)
    }

    private func closeFixture(id: String?) {
        closing = true
        stopLatched = true
        render()
        window.close()
        // Keep the last reported state: closing the fixture proves nothing about
        // native completion. Retain the originally reported own window ID.
        emit("closed", id: id, terminateAfterWrite: true)
    }

    private func failedOutput() {
        outputFailed = true
        stopLatched = true
        state = .stopping
        failureReason = "stdout-unavailable"
        render()
    }

    private func emit(_ name: String, id: String? = nil, reason: String? = nil, terminateAfterWrite: Bool = false) {
        guard !outputFailed, seq < ProtocolLimits.maxJSONInteger else {
            failedOutput()
            if terminateAfterWrite { NSApplication.shared.terminate(nil) }
            return
        }
        seq += 1
        let event = Event(event: name, nonce: nonce, pid: pid, windowId: windowId,
            seq: seq, counter: counter, state: state,
            visible: window.isVisible, onActiveSpace: window.isOnActiveSpace, mainThread: Thread.isMainThread,
            id: id, reason: reason)
        guard var data = try? JSONEncoder().encode(event) else {
            failedOutput()
            if terminateAfterWrite { NSApplication.shared.terminate(nil) }
            return
        }
        data.append(10)
        let queued = output.enqueue(data) { [self] succeeded in
            if !succeeded || terminateAfterWrite {
                DispatchQueue.main.async {
                    if !succeeded { self.failedOutput() }
                    if terminateAfterWrite { NSApplication.shared.terminate(nil) }
                }
            }
        }
        if !queued {
            failedOutput()
            if terminateAfterWrite { NSApplication.shared.terminate(nil) }
        }
    }
}

@main
private enum P02GuiFixture {
    @MainActor static func main() {
        // Opt in before any AppKit object is created, including NSApplication.
        guard ProcessInfo.processInfo.environment["ALLOW_GUI_TESTS"] == "true" else { Darwin.exit(78) }
        guard CommandLine.arguments.count == 2, ProtocolLimits.isToken(CommandLine.arguments[1]) else {
            Darwin.exit(64)
        }
        // A disconnected parent must not kill the fixture in a SIGPIPE handler
        // before its visible stop state can be latched.
        Darwin.signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        guard app.setActivationPolicy(.accessory) else { Darwin.exit(78) }
        let controller = FixtureController(nonce: CommandLine.arguments[1])
        app.delegate = controller
        withExtendedLifetime(controller) { app.run() }
    }
}
