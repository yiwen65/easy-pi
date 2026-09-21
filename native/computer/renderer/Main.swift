import AppKit
import Darwin
import Foundation

@main
enum Main {
    @MainActor static func main() {
        // A closed parent stdout must not bypass owned-socket cleanup via SIGPIPE.
        signal(SIGPIPE, SIG_IGN)
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            if arguments == ["--self-test"] { try selfTest(); return }
            let headless = arguments.first == "--headless" || arguments.first == "--validate"
            var startup = headless ? Array(arguments.dropFirst()) : arguments
            var chord = try EmergencyChord()
            if startup.first == "--emergency-keycode" {
                guard startup.count >= 4, startup[2] == "--emergency-modifiers" else { throw RendererFailure.emergencyConfigurationInvalid }
                chord = try EmergencyChord(keyCode: startup[1], modifiers: startup[3])
                startup = Array(startup.dropFirst(4))
            }
            guard (headless && startup.isEmpty) || (startup.count == 2 && startup[0] == "--socket") else { throw RendererFailure.startupFailed }
            try ControlPipe.validate()
            let socket = startup.isEmpty ? nil : try DatagramSocket(path: startup[1])
            defer { socket?.close() }
            if headless {
                // Real transport + lifecycle, without touching NSApplication,
                // NSScreen, CGWindowList or allocating any window.
                var state = RenderState()
                if try ControlPipe.ended() { return }
                try FileHandle.standardOutput.write(contentsOf: Data("{\"ready\":true,\"version\":3,\"window_id\":0,\"emergency_stop\":false}\n".utf8))
                while true {
                    if try ControlPipe.ended() { break }
                    try socket?.drain(into: &state, now: ProcessInfo.processInfo.systemUptime)
                    var event = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0)
                    _ = poll(&event, 1, 16)
                }
            } else {
                guard let socket else { throw RendererFailure.startupFailed }
                let app = NSApplication.shared
                // Prohibited policy explicitly forbids windows. Accessory permits
                // the nonactivating panel without a Dock icon or menu bar;
                // never call activate or makeKeyAndOrderFront.
                guard app.setActivationPolicy(.accessory) else { throw RendererFailure.startupFailed }
                let renderer = Renderer(socket: socket, chord: chord)
                app.delegate = renderer
                app.run()
                withExtendedLifetime(renderer) {}
            }
        } catch {
            // Fixed error code only: never reflect datagrams, paths or Foundation
            // error descriptions into the parent's machine-readable channel.
            let code = (error as? RendererFailure)?.rawValue ?? "renderer_failed"
            try? FileHandle.standardError.write(contentsOf: Data("\(code)\n".utf8))
            exit(1)
        }
    }
}
