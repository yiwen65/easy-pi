# @earendil-works/pi-server

Experimental. This package is under active development and may change or be removed without notice. Its APIs and behavior are not yet stable.

Server package for pi.

## Session server core

The package exports the `PiServer` session server.

```ts
import type { PiServerService } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";

const service: PiServerService = {
  async listSessions() {
    return storage.listSessions();
  },
  async listModels() {
    return modelRegistry.listModels();
  },
  async createSession(options) {
    return storage.createAndOpen(options);
  },
  async openSession(sessionId) {
    return storage.open(sessionId);
  },
};

const server = createUnixServer(service, {
  path: "/tmp/pi/server.sock",
});
await server.start();
```

`PiServer` composes transport listeners through the `PiServerListener` interface. Each listener must complete any transport-specific authentication and authorization before passing a connection to `PiServer`. For example, a WebSocket listener can validate credentials during the HTTP upgrade, while the Unix listener relies on socket filesystem permissions. The Unix submodule exports the `createUnixListener()` building block and `createUnixServer()` preset, keeping the common case concise without coupling the primary server to Unix sockets. The listener uses length-prefixed CBOR messages from `@earendil-works/pi-protocol`.

This package does not provide a standalone CLI or coding-agent service. Applications supply the `PiServerService` implementation.

`PiServerService.listSessions()` returns protocol `SessionMetadata`, not acquired runtime state. Services should map the durable fields their storage supports and may omit `updatedAt`, `parentSessionId`, `sessionName`, and `cwd`. `PiServer` refreshes available metadata from live snapshots without requiring stored sessions to fabricate phase, model, thinking-level, attachment, or lock values.

## Runtime ownership and shutdown

If a live session runtime's `dispose()` fails, the session manager retains that runtime and prevents reuse or replacement until cleanup succeeds. The reference coding-agent harness service likewise retains writer ownership when a physical tool has not settled. Retry cleanup after the retained work settles; failure is not permission to acquire a second writer or replay the operation.

`PiServer.close()` seals admission immediately. Concurrent calls join the current cleanup attempt; listener cleanup settles before an attempt reports failure. A failed close can be explicitly retried, but admission stays sealed throughout. A successful close remains idempotent and does not restart the server. Unix shutdown lets already-admitted writes drain before final bytes, subject to its graceful-close deadline, while rejecting new sends.

## Transport testing

Custom transports can use `@earendil-works/pi-server/testing` for deterministic protocol conformance tests. It exports `createTestServer()`, `TestServerService`, `ProtocolTestClient`, and the transport-neutral `WireChannel` contract. `connectUnixTestClient()` is provided for Unix transport tests.

## `pi-ai` protocol bridge

`@earendil-works/pi-ai` domain objects and `@earendil-works/pi-protocol` wire DTOs remain independent. This package owns their boundary and exports `toProtocolModelMetadata()`, `toProtocolAssistantMessage()`, `toProtocolUserMessage()`, and `toProtocolToolResultMessage()`.

The adapters reject invalid tool inputs, identifiers, timestamps, and mismatched tool results; `toProtocolToolResultMessage()` requires the original `ToolCall` so it can verify the association and convert its arguments itself. Diagnostic details are explicitly sanitized. Closed `pi-ai` unions are mapped exhaustively, and compile-time field manifests enumerate current `pi-ai` properties so additions require an explicit review. The protocol mirrors `pi-ai` vocabulary such as `toolCall` and `toolUse` where the semantics are identical. Protocol schemas enforce consistent lifecycle states, and tests encode adapter output through the runtime schemas so incompatible changes fail in the bridging package.
