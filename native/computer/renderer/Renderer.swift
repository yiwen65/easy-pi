import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Darwin
import Foundation

@MainActor
final class CursorPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class CursorView: NSView {
    var tip = CGPoint.zero
    var pressed = false
    var feedback: CueKind?
    var feedbackAge = 1.0
    var displayClips: [CGRect] = []

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()
        context.addRects(displayClips)
        context.clip()
        if pressed || feedbackAge < 0.35 {
            let progress = min(1, max(0, feedbackAge / 0.35))
            let radius = pressed ? 10.0 : 8 + 12 * progress
            let ring = NSBezierPath(ovalIn: CGRect(x: tip.x - radius, y: tip.y - radius, width: radius * 2, height: radius * 2))
            let color: NSColor = pressed ? .systemOrange : feedback == .up ? .systemGreen : .systemCyan
            color.withAlphaComponent(pressed ? 0.95 : 1 - progress).setStroke()
            ring.lineWidth = 3
            ring.stroke()
        }
        let arrow = NSBezierPath()
        arrow.move(to: tip)
        for offset in [CGPoint(x: 0, y: -25), CGPoint(x: 6, y: -19), CGPoint(x: 11, y: -29),
                       CGPoint(x: 16, y: -26), CGPoint(x: 11, y: -16), CGPoint(x: 21, y: -16)] {
            arrow.line(to: CGPoint(x: tip.x + offset.x, y: tip.y + offset.y))
        }
        arrow.close()
        (pressed ? NSColor.systemOrange : NSColor.systemCyan).setFill()
        arrow.fill()
        NSColor.black.setStroke()
        arrow.lineWidth = 2.5
        arrow.lineJoinStyle = .round
        arrow.stroke()
        context.restoreGState()
    }
}

@MainActor
final class Renderer: NSObject, NSApplicationDelegate {
    private let socket: DatagramSocket
    private let panel: CursorPanel
    private let cursor: CursorView
    private var timer: Timer?
    private var state = RenderState()
    private let chord: EmergencyChord
    private var emergency = EmergencyObservation()
    private var emergencyMonitor: Any?
    private var heartbeat: MainLoopHeartbeat?

    init(socket: DatagramSocket, chord: EmergencyChord) {
        self.socket = socket
        self.chord = chord
        panel = CursorPanel(contentRect: CGRect(x: 0, y: 0, width: 64, height: 64),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        cursor = CursorView(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.acceptsMouseMovedEvents = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isFloatingPanel = false
        panel.level = .normal
        panel.sharingType = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isReleasedWhenClosed = false
        panel.contentView = cursor
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Non-deferred panel allocation gives a real window number without
        // ordering or activating it. No ready receipt before both resources exist.
        guard panel.windowNumber > 0, !NSScreen.screens.isEmpty else { finish(code: 1); return }
        do {
            if try ControlPipe.ended() { finish(code: 0); return }
            // Only the real GUI branch reaches this code. No permission prompt,
            // event tap, local monitor, input injection or suppression facility.
            guard AXIsProcessTrusted(), !IsSecureEventInputEnabled() else { finish(code: 1); return }
            emergencyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
                MainActor.assumeIsolated {
                    self?.observeEmergency(event)
                }
            }
            guard emergencyMonitor != nil else { finish(code: 1); return }
            try FileHandle.standardOutput.write(contentsOf: Data("{\"ready\":true,\"version\":3,\"window_id\":\(panel.windowNumber),\"emergency_stop\":true}\n".utf8))
            heartbeat = MainLoopHeartbeat(readyAt: ProcessInfo.processInfo.systemUptime)
        } catch { finish(code: 1); return }
        let timer = Timer(timeInterval: 1.0 / 60.0, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func observeEmergency(_ event: NSEvent) {
        // Global monitor handler returns Void: physical input is always forwarded
        // by AppKit. Never install a handler that can return nil/swallow events.
        guard emergency.observe(chord: chord, keyCode: event.keyCode,
                                flags: UInt64(event.modifierFlags.rawValue), repeatKey: event.isARepeat) else { return }
        panel.orderOut(nil)
        do { try FileHandle.standardOutput.write(contentsOf: EmergencyObservation.message) }
        catch { finish(code: 1) }
        // Keep lifetime ownership until native EOF; this signal is not a process
        // exit receipt and the helper never executes input or releases devices.
    }

    @objc private func tick() {
        do {
            // Lifecycle takes priority even while the datagram socket is flooded.
            if try ControlPipe.ended() { finish(code: 0); return }
            // A secure-input owner can disable observation without killing this
            // process. Refuse continued readiness; never alter secure-input mode.
            guard AXIsProcessTrusted(), !IsSecureEventInputEnabled() else { finish(code: 1); return }
            let now = ProcessInfo.processInfo.systemUptime
            try socket.drain(into: &state, now: now)
            render(now: now)
            // Progress includes trust checks, bounded socket drain and rendering.
            // A stopped or blocked AppKit loop cannot manufacture a heartbeat.
            if !emergency.stopped, heartbeat?.due(now: ProcessInfo.processInfo.systemUptime) == true {
                try FileHandle.standardOutput.write(contentsOf: MainLoopHeartbeat.message)
            }
        } catch { finish(code: 1) }
    }

    private func render(now: Double) {
        guard !emergency.stopped else { panel.orderOut(nil); return }
        guard let cue = state.cue, cue.kind != .hide,
              cue.targetPID != getpid(), cue.windowID != UInt32(panel.windowNumber),
              let primary = NSScreen.screens.first,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let targetIndex = windows.firstIndex(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == cue.windowID }),
              let pid = windows[targetIndex][kCGWindowOwnerPID as String] as? NSNumber, pid.int32Value == cue.targetPID,
              let layer = windows[targetIndex][kCGWindowLayer as String] as? NSNumber, layer.intValue == 0,
              let alpha = windows[targetIndex][kCGWindowAlpha as String] as? NSNumber, alpha.doubleValue > 0,
              let dictionary = windows[targetIndex][kCGWindowBounds as String] as? [String: Double],
              let bounds = CGRect(dictionaryRepresentation: dictionary as CFDictionary),
              bounds.width.isFinite, bounds.height.isFinite, bounds.minX.isFinite, bounds.minY.isFinite,
              bounds.width <= Cue.coordinateLimit, bounds.height <= Cue.coordinateLimit,
              let point = Geometry.cursorPoint(window: bounds, x: cue.x, y: cue.y, primaryTop: primary.frame.maxY),
              let footprint = Geometry.clippedFootprint(point: point,
                  window: Geometry.appKitRect(bounds, primaryTop: primary.frame.maxY), displays: NSScreen.screens.map(\.frame))
        else { panel.orderOut(nil); return }

        // Relative ordering is primary protection; also hide the entire glyph if
        // any higher window bounds overlap it. This conservative policy avoids
        // punching through foreground windows even if cross-process order fails.
        // Unknown occluder metadata fails closed. No titles or window contents.
        for other in windows.prefix(targetIndex) {
            if (other[kCGWindowNumber as String] as? NSNumber)?.intValue == panel.windowNumber { continue }
            if let opacity = other[kCGWindowAlpha as String] as? NSNumber, opacity.doubleValue == 0 { continue }
            guard let otherDictionary = other[kCGWindowBounds as String] as? [String: Double],
                  let otherBounds = CGRect(dictionaryRepresentation: otherDictionary as CFDictionary) else { panel.orderOut(nil); return }
            if Geometry.appKitRect(otherBounds, primaryTop: primary.frame.maxY).intersects(footprint) { panel.orderOut(nil); return }
        }
        panel.setFrame(footprint, display: false)
        cursor.tip = CGPoint(x: point.x - footprint.minX, y: point.y - footprint.minY)
        cursor.pressed = state.pressed
        cursor.feedback = state.feedback
        cursor.feedbackAge = now - state.feedbackTime
        cursor.displayClips = NSScreen.screens.map { screen in
            screen.frame.intersection(footprint).offsetBy(dx: -footprint.minX, dy: -footprint.minY)
        }.filter { !$0.isNull && !$0.isEmpty }
        cursor.needsDisplay = true
        panel.order(.above, relativeTo: Int(cue.windowID))
    }

    private func finish(code: Int32) {
        if let emergencyMonitor { NSEvent.removeMonitor(emergencyMonitor) }
        emergencyMonitor = nil
        timer?.invalidate()
        timer = nil
        panel.orderOut(nil)
        panel.close()
        socket.close()
        // Resources are closed before AppKit's normal termination. No synthetic
        // wake-up event is needed and no process-wide input API is used.
        if code != 0 {
            try? FileHandle.standardError.write(contentsOf: Data("renderer_failed\n".utf8))
            Darwin.exit(code)
        }
        NSApplication.shared.terminate(nil)
    }
}
