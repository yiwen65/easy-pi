#!/usr/bin/env python3
"""No-GUI process tests. All temporary inputs stay in the supplied output root."""
import json
import errno
import os
from pathlib import Path
import select
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest


def read_ready(process):
    readable, _, _ = select.select([process.stdout], [], [], 5)
    if not readable:
        raise AssertionError("ready timeout")
    line = process.stdout.readline()
    if not line:
        raise AssertionError("exited before ready: " + process.stderr.read().decode())
    return json.loads(line)


if len(sys.argv) > 1 and sys.argv[1] == "--parent":
    child = subprocess.Popen([sys.argv[2], "--headless"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    read_ready(child)
    print(child.pid, flush=True)
    sys.stdin.buffer.read(1)
    # Simulates abrupt native-parent death; no child signal or cleanup request.
    os._exit(0)


BINARY = str(Path(sys.argv[1]).resolve())
OUTPUT = str(Path(sys.argv[2]).resolve())
sys.argv = [sys.argv[0]]

# Preserve a clear distinction between executable pipe/protocol tests and
# named-socket tests denied by an execution sandbox. Never skip other failures.
with tempfile.TemporaryDirectory(prefix="rp-", dir=OUTPUT) as probe_directory:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as probe:
            probe.bind(probe_directory + "/s")
        BIND_ALLOWED = True
    except PermissionError as error:
        if error.errno != errno.EPERM:
            raise
        BIND_ALLOWED = False
        print("named AF_UNIX bind: EPERM; named-socket qualification blocked", flush=True)


class RendererTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="rt-", dir=OUTPUT)
        self.path = Path(self.directory.name) / "s"
        self.processes = []

    def tearDown(self):
        for process in self.processes:
            if process.stdin and not process.stdin.closed:
                process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                # Failure-only containment of a test-owned, headless process.
                process.kill()
                process.wait(timeout=5)
            for stream in [process.stdout, process.stderr]:
                if stream:
                    stream.close()
        self.directory.cleanup()

    def launch(self, path=None):
        process = subprocess.Popen([BINARY, "--headless", "--socket", str(path or self.path)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(process)
        return process

    def launch_control(self):
        process = subprocess.Popen([BINARY, "--headless"], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(process)
        return process

    def ready(self, process):
        self.assertEqual(read_ready(process), {"ready": True, "version": 3, "window_id": 0, "emergency_stop": False})

    def finish(self, process, code=0):
        process.stdin.close()
        self.assertEqual(process.wait(timeout=5), code)
        self.assertEqual(process.stdout.read(), b"")
        if code == 0:
            self.assertEqual(process.stderr.read(), b"")

    def test_pure_protocol_geometry_and_sequence(self):
        result = subprocess.run([BINARY, "--self-test"], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertIn(b"checks passed (no GUI)", result.stdout)
        print(result.stdout.decode().strip(), flush=True)

    @unittest.skipUnless(BIND_ALLOWED, "sandbox denies named AF_UNIX bind (EPERM)")
    def test_ready_permissions_eof_preserves_directory(self):
        process = self.launch()
        self.ready(process)
        info = self.path.lstat()
        self.assertTrue(stat.S_ISSOCK(info.st_mode))
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_uid, os.getuid())
        self.assertEqual(stat.S_IMODE(self.path.parent.stat().st_mode), 0o700)
        marker = self.path.parent / "keep"
        marker.write_text("owned by test parent")
        self.finish(process)
        self.assertFalse(self.path.exists())
        self.assertEqual(marker.read_text(), "owned by test parent")

    def test_existing_file_is_never_removed(self):
        self.path.write_text("keep")
        process = self.launch()
        self.finish(process, 1)
        self.assertEqual(self.path.read_text(), "keep")
        self.assertEqual(process.stderr.read(), b"socket_invalid\n")

    @unittest.skipUnless(BIND_ALLOWED, "sandbox denies named AF_UNIX bind (EPERM)")
    def test_existing_socket_is_never_removed(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as existing:
            existing.bind(str(self.path))
            inode = self.path.lstat().st_ino
            process = self.launch()
            self.finish(process, 1)
            self.assertEqual(self.path.lstat().st_ino, inode)

    def test_existing_symlink_is_never_followed(self):
        destination = self.path.parent / "keep"
        destination.write_text("unchanged")
        self.path.symlink_to(destination)
        process = self.launch()
        self.finish(process, 1)
        self.assertTrue(self.path.is_symlink())
        self.assertEqual(destination.read_text(), "unchanged")

    def test_directory_symlink_rejected(self):
        real = self.path.parent / "real"
        real.mkdir(mode=0o700)
        link = self.path.parent / "link"
        link.symlink_to(real, target_is_directory=True)
        process = self.launch(link / "s")
        self.finish(process, 1)
        self.assertEqual(list(real.iterdir()), [])

    def test_directory_permissions_rejected(self):
        os.chmod(self.path.parent, 0o755)
        process = self.launch()
        self.finish(process, 1)
        self.assertFalse(self.path.exists())

    def test_relative_dot_and_long_paths_rejected(self):
        for path in ["relative/s", str(self.path.parent) + "/../s", "/" + "x" * 110]:
            process = self.launch(path)
            self.finish(process, 1)
            self.assertEqual(process.stderr.read(), b"socket_invalid\n")

    @unittest.skipUnless(BIND_ALLOWED, "sandbox denies named AF_UNIX bind (EPERM)")
    def test_replacement_not_removed_on_eof(self):
        process = self.launch()
        self.ready(process)
        moved = self.path.parent / "original"
        self.path.rename(moved)
        self.path.write_text("replacement")
        self.finish(process)
        self.assertEqual(self.path.read_text(), "replacement")
        self.assertTrue(stat.S_ISSOCK(moved.lstat().st_mode))

    @unittest.skipUnless(BIND_ALLOWED, "sandbox denies named AF_UNIX bind (EPERM)")
    def test_no_reflection_and_bounded_nonblocking_flood(self):
        process = self.launch()
        self.ready(process)
        cue = {"version": 1, "sequence": 1, "target_pid": 42, "window_id": 17,
               "x": 12, "y": 20, "kind": "click"}
        sent = 0
        dropped = 0
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sender:
            sender.setblocking(False)  # Native parent must use the same contract.
            for index in range(10000):
                cue["sequence"] = index
                # One byte over the protocol limit reaches the helper even on
                # macOS sockets whose default per-datagram limit is below 4 KiB.
                body = [b"secret-reflection", b"x" * 513, json.dumps(cue).encode()][index % 3]
                try:
                    sender.sendto(body, str(self.path))
                    sent += 1
                except OSError as error:
                    # Darwin can report a full datagram receive queue as
                    # ENOBUFS instead of EAGAIN; both are nonblocking drops.
                    if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK, errno.ENOBUFS):
                        raise
                    dropped += 1
        self.assertGreater(sent, 0)
        self.assertGreater(dropped, 0)
        self.assertIsNone(process.poll())
        self.finish(process)
        self.assertFalse(self.path.exists())
        print(f"nonblocking flood: sent={sent} dropped={dropped}; EOF exit=0", flush=True)

    def test_control_is_not_a_text_command_channel(self):
        process = self.launch_control()
        self.ready(process)
        process.stdin.write(b"secret-script")
        process.stdin.flush()
        self.assertEqual(process.wait(timeout=5), 1)
        self.assertEqual(process.stderr.read(), b"control_invalid\n")
        self.assertEqual(process.stdout.read(), b"")
        self.assertFalse(self.path.exists())

    def test_immediate_eof_closes_without_orphan(self):
        process = self.launch_control()
        process.stdin.close()
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertFalse(self.path.exists())
        self.assertEqual(process.stderr.read(), b"")

    def test_regular_file_stdin_rejected(self):
        result = subprocess.run([BINARY, "--headless", "--socket", str(self.path)],
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"control_invalid\n")
        self.assertFalse(self.path.exists())

    def test_parent_death_causes_pipe_eof(self):
        parent = subprocess.Popen([sys.executable, __file__, "--parent", BINARY, str(self.path)],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.processes.append(parent)
        readable, _, _ = select.select([parent.stdout], [], [], 5)
        self.assertTrue(readable)
        line = parent.stdout.readline()
        self.assertTrue(line, parent.stderr.read().decode() if parent.poll() is not None else "parent startup failed")
        pid = int(line)
        parent.stdin.close()
        self.assertEqual(parent.wait(timeout=5), 0)
        deadline = time.monotonic() + 5
        alive = True
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                alive = False
                break
            time.sleep(0.02)
        self.assertFalse(alive, "headless helper survived parent pipe EOF")
        self.assertFalse(self.path.exists())

    def test_ready_control_eof(self):
        process = self.launch_control()
        self.ready(process)
        self.finish(process)

    def test_trusted_chord_arguments_remain_headless_and_reject_invalid_values(self):
        for arguments, expected in [
            (["--emergency-keycode", "53", "--emergency-modifiers", "786432"], 0),
            (["--emergency-keycode", "0", "--emergency-modifiers", "1179648"], 0),
            (["--emergency-keycode", "secret-script", "--emergency-modifiers", "786432"], 1),
            (["--emergency-keycode", "55", "--emergency-modifiers", "786432"], 1),
            (["--emergency-keycode", "53", "--emergency-modifiers", "0"], 1),
            (["--emergency-keycode", "53", "--emergency-modifiers", "8388608"], 1),
            (["--emergency-keycode", "53"], 1),
        ]:
            process = subprocess.Popen([BINARY, "--headless", *arguments],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.processes.append(process)
            if expected == 0:
                self.ready(process)  # always zero window and emergency_stop:false
            self.finish(process, expected)
            if expected != 0:
                self.assertEqual(process.stderr.read(), b"emergency_configuration_invalid\n")

    def test_closed_stdout_is_an_orderly_failure(self):
        read_end, write_end = os.pipe()
        os.close(read_end)
        try:
            process = subprocess.Popen([BINARY, "--headless"], stdin=subprocess.PIPE,
                                       stdout=write_end, stderr=subprocess.PIPE)
        finally:
            os.close(write_end)
        self.processes.append(process)
        self.assertEqual(process.wait(timeout=5), 1)
        self.assertEqual(process.stderr.read(), b"renderer_failed\n")


unittest.main(verbosity=2)
