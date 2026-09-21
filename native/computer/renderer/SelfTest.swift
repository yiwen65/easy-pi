import Darwin
import Foundation

func selfTest() throws {
    let valid = "{\"version\":1,\"sequence\":0,\"target_pid\":42,\"window_id\":17,\"x\":12.5,\"y\":20,\"kind\":\"move\"}"
    var checks = 0
    func expect(_ condition: Bool) throws {
        guard condition else { throw RendererFailure.protocolInvalid }
        checks += 1
    }
    let cue = try Cue.parse(Data(valid.utf8))
    try expect(cue.sequence == 0 && cue.x == 12.5 && cue.targetPID == 42)
    for kind in ["move", "down", "up", "click", "hide"] {
        try expect((try? Cue.parse(Data(valid.replacingOccurrences(of: "move", with: kind).utf8)))?.kind.rawValue == kind)
    }
    let invalid = ["", "{", "[]", valid + "x", valid + valid,
        valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":2"),
        valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"label\":\"secret\""),
        valid.replacingOccurrences(of: "\"version\":1", with: "\"version\":1,\"version\":1"),
        valid.replacingOccurrences(of: "\"version\"", with: "\"ver\\u0073ion\""),
        valid.replacingOccurrences(of: "move", with: "reflect"),
        valid.replacingOccurrences(of: "\"move\"", with: "{\"script\":\"secret\"}"),
        valid.replacingOccurrences(of: "\"target_pid\":42", with: "\"target_pid\":0"),
        valid.replacingOccurrences(of: "\"target_pid\":42", with: "\"target_pid\":2147483648"),
        valid.replacingOccurrences(of: "\"window_id\":17", with: "\"window_id\":0"),
        valid.replacingOccurrences(of: "\"window_id\":17", with: "\"window_id\":4294967296"),
        valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":18446744073709551616"),
        valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":-1"),
        valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":-0"),
        valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":1.0"),
        valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":1e0"),
        String(repeating: " ", count: Cue.maximumBytes + 1) + valid]
    for input in invalid { try expect((try? Cue.parse(Data(input.utf8))) == nil) }
    let exactLimit = valid + String(repeating: " ", count: Cue.maximumBytes - valid.utf8.count)
    try expect((try? Cue.parse(Data(exactLimit.utf8))) != nil)
    try expect((try? Cue.parse(Data((exactLimit + " ").utf8))) == nil)
    for number in ["NaN", "Infinity", "-Infinity", "1e9999", "-1", "1000000.1", "01", "+1", ".1", "1.", "1e", "null", "true", "\"12\""] {
        for field in ["\"x\":12.5", "\"y\":20"] {
            let key = field.hasPrefix("\"x") ? "\"x\":" : "\"y\":"
            try expect((try? Cue.parse(Data(valid.replacingOccurrences(of: field, with: key + number).utf8))) == nil)
        }
    }
    let maximum = valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":18446744073709551615")
        .replacingOccurrences(of: "\"window_id\":17", with: "\"window_id\":4294967295")
        .replacingOccurrences(of: "12.5", with: "1000000")
    try expect(try Cue.parse(Data(maximum.utf8)).sequence == UInt64.max)
    var state = RenderState()
    try expect(state.ingest(Data(valid.utf8), now: 1))
    try expect(!state.ingest(Data(valid.utf8), now: 2))
    let second = valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":2")
    try expect(state.ingest(Data(second.replacingOccurrences(of: "move", with: "down").utf8), now: 2))
    try expect(state.pressed)
    try expect(!state.ingest(Data(second.replacingOccurrences(of: "move", with: "up").utf8), now: 3))
    try expect(state.pressed)
    try expect(!state.ingest(Data(valid.utf8), now: 4))
    let third = valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":3")
    try expect(state.ingest(Data(third.utf8), now: 4) && state.pressed)
    let fourth = valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":4").replacingOccurrences(of: "move", with: "up")
    try expect(state.ingest(Data(fourth.utf8), now: 5) && !state.pressed && state.feedback == .up)
    try expect(state.ingest(Data(maximum.utf8), now: 6))
    try expect(!state.ingest(Data(valid.utf8), now: 7))
    var transitions = RenderState()
    for (index, kind) in ["down", "move", "up", "click", "move", "hide"].enumerated() {
        let input = valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":\(index)")
            .replacingOccurrences(of: "move", with: kind)
        try expect(transitions.ingest(Data(input.utf8), now: Double(index)))
        try expect(transitions.pressed == (index < 2))
    }
    try expect(transitions.feedback == nil && transitions.cue?.kind == .hide)
    var targetSwitch = RenderState()
    try expect(targetSwitch.ingest(Data(valid.replacingOccurrences(of: "move", with: "down").utf8), now: 1))
    let switched = second.replacingOccurrences(of: "\"window_id\":17", with: "\"window_id\":18")
    try expect(targetSwitch.ingest(Data(switched.utf8), now: 2) && !targetSwitch.pressed && targetSwitch.feedback == nil)
    let selfTarget = third.replacingOccurrences(of: "\"target_pid\":42", with: "\"target_pid\":\(ProcessInfo.processInfo.processIdentifier)")
    try expect(!targetSwitch.ingest(Data(selfTarget.utf8), now: 3) && targetSwitch.lastSequence == 2)

    // Primary is 1440x900 points. Left display has negative X; upper display
    // has negative Quartz Y. These are independent hand-computed expectations.
    let left = CGRect(x: -1800, y: 100, width: 700, height: 500)
    try expect(Geometry.appKitRect(left, primaryTop: 900) == CGRect(x: -1800, y: 300, width: 700, height: 500))
    try expect(Geometry.cursorPoint(window: left, x: 40, y: 60, primaryTop: 900) == CGPoint(x: -1760, y: 740))
    let above = CGRect(x: 300, y: -1000, width: 800, height: 600)
    try expect(Geometry.cursorPoint(window: above, x: 20, y: 30, primaryTop: 900) == CGPoint(x: 320, y: 1870))
    try expect(Geometry.appKitRect(above, primaryTop: 900) == CGRect(x: 300, y: 1300, width: 800, height: 600))
    let moved = left.offsetBy(dx: 150, dy: -200)
    try expect(Geometry.cursorPoint(window: moved, x: 40, y: 60, primaryTop: 900) == CGPoint(x: -1610, y: 940))
    try expect(Geometry.cursorPoint(window: left, x: 700, y: 0, primaryTop: 900) == nil)
    try expect(Geometry.cursorPoint(window: left, x: .infinity, y: 0, primaryTop: 900) == nil)
    try expect(Geometry.cursorPoint(window: left, x: 0, y: .nan, primaryTop: 900) == nil)
    let target = CGRect(x: 0, y: 0, width: 500, height: 500)
    try expect(Geometry.clippedFootprint(point: CGPoint(x: 2, y: 2), window: target, displays: [target]) == CGRect(x: 0, y: 0, width: 42, height: 26))
    try expect(Geometry.clippedFootprint(point: CGPoint(x: 2, y: 2), window: target, displays: [above]) == nil)
    // socketpair exercises the production datagram drain without a filesystem
    // bind (which some execution sandboxes prohibit). It is local IPC only.
    var descriptors: [Int32] = [-1, -1]
    guard socketpair(AF_UNIX, SOCK_DGRAM, 0, &descriptors) == 0 else { throw RendererFailure.socketInvalid }
    defer { Darwin.close(descriptors[0]); Darwin.close(descriptors[1]) }
    try expect(fcntl(descriptors[0], F_SETFL, O_NONBLOCK) == 0)
    try expect(fcntl(descriptors[1], F_SETFL, O_NONBLOCK) == 0)
    var received = RenderState()
    try DatagramSocket.drain(descriptor: descriptors[0], into: &received, now: 0)
    try expect(received.cue == nil)
    let oversizedValid = maximum + String(repeating: " ", count: Cue.maximumBytes + 1 - maximum.utf8.count)
    for body in [Data(valid.utf8), Data(oversizedValid.utf8), Data(second.utf8), Data(valid.utf8)] {
        let sent = body.withUnsafeBytes { send(descriptors[1], $0.baseAddress, $0.count, MSG_DONTWAIT) }
        try expect(sent == body.count)
        try DatagramSocket.drain(descriptor: descriptors[0], into: &received, now: 1)
    }
    try expect(received.lastSequence == 2)
    // Queue enough datagrams to prove a drain yields after its fixed budget,
    // then proves latest accepted state replaces earlier moves on the next tick.
    var queueSize: Int32 = 262_144
    try expect(setsockopt(descriptors[0], SOL_SOCKET, SO_RCVBUF, &queueSize, socklen_t(MemoryLayout<Int32>.size)) == 0)
    try expect(setsockopt(descriptors[1], SOL_SOCKET, SO_SNDBUF, &queueSize, socklen_t(MemoryLayout<Int32>.size)) == 0)
    for index in 3...82 {
        let body = Data(valid.replacingOccurrences(of: "\"sequence\":0", with: "\"sequence\":\(index)").utf8)
        let sent = body.withUnsafeBytes { send(descriptors[1], $0.baseAddress, $0.count, MSG_DONTWAIT) }
        try expect(sent == body.count)
    }
    try DatagramSocket.drain(descriptor: descriptors[0], into: &received, now: 2)
    try expect(received.lastSequence == 66)
    try DatagramSocket.drain(descriptor: descriptors[0], into: &received, now: 3)
    try expect(received.lastSequence == 82)
    let emergency = try EmergencyChord()
    try expect(emergency.keyCode == 53 && emergency.modifiers == 786432)
    try expect(emergency.matches(keyCode: 53, flags: 786432, repeatKey: false))
    // Caps lock, numeric-pad and device-specific low flags do not change a chord.
    try expect(emergency.matches(keyCode: 53, flags: 786432 | 0x210003, repeatKey: false))
    for extra: UInt64 in [0x20000, 0x100000, 0x800000] {
        try expect(!emergency.matches(keyCode: 53, flags: 786432 | extra, repeatKey: false))
    }
    try expect(!emergency.matches(keyCode: 53, flags: 786432, repeatKey: true))
    try expect(!emergency.matches(keyCode: 52, flags: 786432, repeatKey: false))
    for key in ["", "-1", "+53", "53.0", "65536", "10", "52", "55", "63", "128", "99999999999"] {
        try expect((try? EmergencyChord(keyCode: key)) == nil)
    }
    for flags in ["", "0", "-1", "1", "8388608", "786432x", "99999999999"] {
        try expect((try? EmergencyChord(modifiers: flags)) == nil)
    }
    let custom = try EmergencyChord(keyCode: "0", modifiers: "1179648")
    try expect(custom.matches(keyCode: 0, flags: 1179648, repeatKey: false))
    var observer = EmergencyObservation()
    try expect(!observer.observe(chord: emergency, keyCode: 53, flags: 786432, repeatKey: true))
    try expect(observer.observe(chord: emergency, keyCode: 53, flags: 786432, repeatKey: false))
    try expect(!observer.observe(chord: emergency, keyCode: 53, flags: 786432, repeatKey: false))
    try expect(observer.stopped)
    try expect(EmergencyObservation.message == Data("{\"event\":\"emergency_stop\",\"version\":3}\n".utf8))
    var heartbeat = MainLoopHeartbeat(readyAt: 10)
    try expect(!heartbeat.due(now: 10))
    try expect(!heartbeat.due(now: 10.249))
    try expect(heartbeat.due(now: 10.25))
    try expect(!heartbeat.due(now: 10.25))
    try expect(heartbeat.due(now: 20))
    try expect(!heartbeat.due(now: 20))
    try expect(heartbeat.due(now: 20.25))
    try expect(MainLoopHeartbeat.message == Data("{\"event\":\"heartbeat\",\"version\":3}\n".utf8))
    print("self-test: \(checks) checks passed (no GUI)")
}
