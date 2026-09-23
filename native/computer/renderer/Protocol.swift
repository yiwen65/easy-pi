import Foundation

enum RendererFailure: String, Error {
    case protocolInvalid = "protocol_invalid"
    case socketInvalid = "socket_invalid"
    case controlInvalid = "control_invalid"
    case startupFailed = "startup_failed"
    case emergencyConfigurationInvalid = "emergency_configuration_invalid"
}

enum CueKind: String { case move, down, up, click, hide }

struct Cue {
    static let maximumBytes = 512
    static let coordinateLimit = 1_000_000.0
    let sequence: UInt64
    let targetPID: Int32
    let windowID: UInt32
    let x: Double
    let y: Double
    let kind: CueKind

    // A deliberately flat ASCII JSON dialect: no escaped keys/values, duplicate
    // fields, nested objects, arrays, booleans or null. No untrusted text escapes
    // into logs, AppKit, file operations or command execution.
    static func parse(_ data: Data) throws -> Cue {
        guard !data.isEmpty, data.count <= maximumBytes else { throw RendererFailure.protocolInvalid }
        var parser = FlatJSON(bytes: Array(data))
        let fields = try parser.object()
        guard Set(fields.keys) == ["version", "sequence", "target_pid", "window_id", "x", "y", "kind"],
              fields["version"] == .number("1"),
              case .number(let sequenceText) = fields["sequence"],
              case .number(let pidText) = fields["target_pid"],
              case .number(let windowText) = fields["window_id"],
              case .number(let xText) = fields["x"],
              case .number(let yText) = fields["y"],
              case .string(let kindText) = fields["kind"],
              sequenceText.utf8.allSatisfy({ (48...57).contains($0) }),
              let sequence = UInt64(sequenceText),
              let pid = Int32(pidText), pid > 0,
              let window = UInt32(windowText), window > 0,
              let x = Double(xText), let y = Double(yText),
              x.isFinite, y.isFinite,
              (0...coordinateLimit).contains(x), (0...coordinateLimit).contains(y),
              let kind = CueKind(rawValue: kindText)
        else { throw RendererFailure.protocolInvalid }
        return Cue(sequence: sequence, targetPID: pid, windowID: window, x: x, y: y, kind: kind)
    }
}

private enum JSONAtom: Equatable { case string(String), number(String) }

private struct FlatJSON {
    let bytes: [UInt8]
    var index = 0

    mutating func whitespace() {
        while index < bytes.count, [9, 10, 13, 32].contains(bytes[index]) { index += 1 }
    }

    mutating func take(_ byte: UInt8) throws {
        whitespace()
        guard index < bytes.count, bytes[index] == byte else { throw RendererFailure.protocolInvalid }
        index += 1
    }

    mutating func string() throws -> String {
        try take(34)
        let start = index
        while index < bytes.count, bytes[index] != 34 {
            guard (32...126).contains(bytes[index]), bytes[index] != 92 else { throw RendererFailure.protocolInvalid }
            index += 1
        }
        let result = String(decoding: bytes[start..<index], as: UTF8.self)
        try take(34)
        return result
    }

    mutating func number() throws -> String {
        whitespace()
        let start = index
        if index < bytes.count, bytes[index] == 45 { index += 1 }
        guard index < bytes.count else { throw RendererFailure.protocolInvalid }
        if bytes[index] == 48 {
            index += 1
        } else {
            guard (49...57).contains(bytes[index]) else { throw RendererFailure.protocolInvalid }
            while index < bytes.count, (48...57).contains(bytes[index]) { index += 1 }
        }
        if index < bytes.count, bytes[index] == 46 {
            index += 1
            let fraction = index
            while index < bytes.count, (48...57).contains(bytes[index]) { index += 1 }
            guard index > fraction else { throw RendererFailure.protocolInvalid }
        }
        if index < bytes.count, [69, 101].contains(bytes[index]) {
            index += 1
            if index < bytes.count, [43, 45].contains(bytes[index]) { index += 1 }
            let exponent = index
            while index < bytes.count, (48...57).contains(bytes[index]) { index += 1 }
            guard index > exponent else { throw RendererFailure.protocolInvalid }
        }
        return String(decoding: bytes[start..<index], as: UTF8.self)
    }

    mutating func object() throws -> [String: JSONAtom] {
        try take(123)
        var fields: [String: JSONAtom] = [:]
        while true {
            let key = try string()
            guard fields[key] == nil, fields.count < 7 else { throw RendererFailure.protocolInvalid }
            try take(58)
            whitespace()
            guard index < bytes.count else { throw RendererFailure.protocolInvalid }
            fields[key] = bytes[index] == 34 ? .string(try string()) : .number(try number())
            whitespace()
            if index < bytes.count, bytes[index] == 125 { index += 1; break }
            try take(44)
        }
        whitespace()
        guard index == bytes.count else { throw RendererFailure.protocolInvalid }
        return fields
    }
}

struct RenderState {
    private(set) var lastSequence: UInt64?
    private(set) var cue: Cue?
    private(set) var pressed = false
    private(set) var feedback: CueKind?
    private(set) var feedbackTime = 0.0

    mutating func ingest(_ data: Data, now: Double) -> Bool {
        guard let next = try? Cue.parse(data), next.targetPID != ProcessInfo.processInfo.processIdentifier,
              lastSequence.map({ next.sequence > $0 }) ?? true else { return false }
        if cue?.targetPID != next.targetPID || cue?.windowID != next.windowID {
            pressed = false
            feedback = nil
        }
        lastSequence = next.sequence
        cue = next
        switch next.kind {
        case .down: pressed = true; feedback = .down; feedbackTime = now
        case .up: pressed = false; feedback = .up; feedbackTime = now
        case .click: pressed = false; feedback = .click; feedbackTime = now
        case .hide: pressed = false; feedback = nil
        case .move: break
        }
        return true
    }
}

enum Geometry {
    // WindowServer layers are signed 32-bit levels, not model-provided values.
    static func cursorLevel(_ layer: Int64) -> Int? {
        Int32(exactly: layer).map(Int.init)
    }

    // Quartz global points use primary-display top-left; AppKit uses its
    // bottom-left. Never use NSScreen.main (it follows keyboard focus), total
    // desktop height, screenshot pixels, or a per-display scale multiplier.
    static func appKitRect(_ quartz: CGRect, primaryTop: Double) -> CGRect {
        CGRect(x: quartz.minX, y: primaryTop - quartz.maxY, width: quartz.width, height: quartz.height)
    }

    static func cursorPoint(window: CGRect, x: Double, y: Double, primaryTop: Double) -> CGPoint? {
        guard window.width > 0, window.height > 0, x >= 0, y >= 0,
              x < window.width, y < window.height else { return nil }
        return CGPoint(x: window.minX + x, y: primaryTop - window.minY - y)
    }

    static func clippedFootprint(point: CGPoint, window: CGRect, displays: [CGRect]) -> CGRect? {
        let footprint = CGRect(x: point.x - 24, y: point.y - 40, width: 64, height: 64).intersection(window)
        guard displays.contains(where: { $0.contains(point) }), !footprint.isNull, !footprint.isEmpty else { return nil }
        return footprint
    }
}
