import Darwin
import Foundation

final class DatagramSocket {
    let descriptor: Int32
    private let directory: Int32
    private let name: String
    private let device: dev_t
    private let inode: ino_t
    private var closed = false

    init(path: String) throws {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard path.hasPrefix("/"), path.utf8.count < 104, !path.utf8.contains(0),
              components.count >= 3, components.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              let last = components.last else { throw RendererFailure.socketInvalid }
        // Walk every directory using descriptors: no symlink ancestors, including
        // /tmp (callers on macOS should pass /private/tmp).
        var dir = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard dir >= 0 else { throw RendererFailure.socketInvalid }
        for part in components.dropFirst().dropLast() {
            let next = openat(dir, String(part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            Darwin.close(dir)
            guard next >= 0 else { throw RendererFailure.socketInvalid }
            dir = next
        }
        var info = stat()
        guard fstat(dir, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else {
            Darwin.close(dir)
            throw RendererFailure.socketInvalid
        }
        let name = String(last)
        var existing = stat()
        guard fstatat(dir, name, &existing, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else {
            Darwin.close(dir)
            throw RendererFailure.socketInvalid
        }
        let fd = socket(AF_UNIX, SOCK_DGRAM, 0)
        guard fd >= 0 else { Darwin.close(dir); throw RendererFailure.socketInvalid }
        // This standalone process deliberately anchors its cwd at the verified
        // directory so bind cannot follow a replaced ancestor path.
        guard fchdir(dir) == 0, fcntl(fd, F_SETFL, O_NONBLOCK) == 0,
              fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else {
            Darwin.close(fd); Darwin.close(dir); throw RendererFailure.socketInvalid
        }
        var receiveSize: Int32 = 32_768
        guard setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &receiveSize, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            Darwin.close(fd); Darwin.close(dir); throw RendererFailure.socketInvalid
        }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.copyBytes(from: Array(name.utf8) + [0])
        }
        let oldMask = umask(0o077)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        umask(oldMask)
        guard result == 0 else { Darwin.close(fd); Darwin.close(dir); throw RendererFailure.socketInvalid }
        var created = stat()
        guard fstatat(dir, name, &created, AT_SYMLINK_NOFOLLOW) == 0,
              created.st_mode & S_IFMT == S_IFSOCK, created.st_uid == getuid() else {
            Darwin.close(fd); Darwin.close(dir); throw RendererFailure.socketInvalid
        }
        descriptor = fd
        directory = dir
        self.name = name
        device = created.st_dev
        inode = created.st_ino
        guard fchmodat(dir, name, 0o600, AT_SYMLINK_NOFOLLOW) == 0 else {
            close(); throw RendererFailure.socketInvalid
        }
    }

    func drain(into state: inout RenderState, now: Double) throws {
        try Self.drain(descriptor: descriptor, into: &state, now: now)
    }

    static func drain(descriptor: Int32, into state: inout RenderState, now: Double) throws {
        // Fixed kernel queue, fixed packet buffer and at most 64 packets/tick.
        // Process transitions in order but render only the resulting state.
        var bytes = [UInt8](repeating: 0, count: Cue.maximumBytes + 1)
        for _ in 0..<64 {
            let count = recv(descriptor, &bytes, bytes.count, MSG_DONTWAIT)
            if count < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { return }
                if errno == EINTR { continue }
                throw RendererFailure.socketInvalid
            }
            // Oversized datagrams truncate into the extra byte and are rejected.
            if count <= Cue.maximumBytes { _ = state.ingest(Data(bytes.prefix(count)), now: now) }
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        Darwin.close(descriptor)
        var current = stat()
        if fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
           current.st_dev == device, current.st_ino == inode,
           current.st_mode & S_IFMT == S_IFSOCK {
            _ = unlinkat(directory, name, 0)
        }
        Darwin.close(directory)
    }

    deinit { close() }
}

enum ControlPipe {
    static func validate() throws {
        var info = stat()
        guard fstat(STDIN_FILENO, &info) == 0, info.st_mode & S_IFMT == S_IFIFO else { throw RendererFailure.controlInvalid }
    }

    static func ended() throws -> Bool {
        var event = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0)
        let result = poll(&event, 1, 0)
        if result < 0 { if errno == EINTR { return false }; throw RendererFailure.controlInvalid }
        if event.revents & Int16(POLLERR | POLLNVAL) != 0 { throw RendererFailure.controlInvalid }
        guard result > 0 else { return false }
        var byte: UInt8 = 0
        let count = read(STDIN_FILENO, &byte, 1)
        if count == 0 { return true }
        if count < 0, errno == EINTR { return false }
        // stdin is a lifetime pipe only, never a second command channel.
        throw RendererFailure.controlInvalid
    }
}
