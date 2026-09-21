import AppKit
import Foundation

/// Trusted launch configuration only. Rust resolves key names using its real
/// Events mapping; the helper accepts only supported physical key positions.
struct EmergencyChord {
    let keyCode: UInt16
    let modifiers: UInt64
    static let modifierMask: UInt64 = 0x1E0000 // shift, control, option, command
    static let comparisonMask: UInt64 = modifierMask | 0x800000 // reject extra fn

    init(keyCode: String = "53", modifiers: String = "786432") throws {
        let decimal: (String) -> Bool = { text in
            !text.isEmpty && text.utf8.count <= 10 && text.utf8.allSatisfy { (48...57).contains($0) }
        }
        guard decimal(keyCode), decimal(modifiers),
              let key = UInt16(keyCode), let flags = UInt64(modifiers),
              Self.supportedKey(key), flags != 0, flags & ~Self.modifierMask == 0
        else { throw RendererFailure.emergencyConfigurationInvalid }
        self.keyCode = key
        self.modifiers = flags
    }

    static func supportedKey(_ code: UInt16) -> Bool {
        (0...9).contains(code) || (11...51).contains(code) || code == 53 ||
            [96, 97, 98, 99, 100, 101, 103, 109, 111, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126].contains(code)
    }

    func matches(keyCode: UInt16, flags: UInt64, repeatKey: Bool) -> Bool {
        !repeatKey && keyCode == self.keyCode && flags & Self.comparisonMask == modifiers
    }
}

struct EmergencyObservation {
    private(set) var stopped = false

    mutating func observe(chord: EmergencyChord, keyCode: UInt16, flags: UInt64, repeatKey: Bool) -> Bool {
        guard !stopped, chord.matches(keyCode: keyCode, flags: flags, repeatKey: repeatKey) else { return false }
        stopped = true
        return true
    }

    static let message = Data("{\"event\":\"emergency_stop\",\"version\":3}\n".utf8)
}

/// Called only after a completed AppKit main-loop tick, never by a worker.
struct MainLoopHeartbeat {
    private var last: Double
    static let message = Data("{\"event\":\"heartbeat\",\"version\":3}\n".utf8)

    init(readyAt: Double) { last = readyAt }

    mutating func due(now: Double) -> Bool {
        guard now - last >= 0.25 else { return false }
        last = now // no catch-up queue after a delayed tick
        return true
    }
}
