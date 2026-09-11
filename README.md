# easy-pi

> A native AI coding agent for the terminal.

[![CI](https://github.com/yiwen65/easy-pi/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yiwen65/easy-pi/actions/workflows/ci.yml)

`easy-pi` is a Pi-compatible coding agent focused on one practical loop:
**describe a change, inspect the repository, make the edit, and verify the result**.
It runs in your terminal, keeps sessions on disk, supports multiple model providers,
and can delegate bounded work to native subagents.

## Start here

The npm beta is planned as `easy-pi@0.1.0-beta.1`. Until it is published, run from a
local checkout:

```bash
git clone https://github.com/yiwen65/easy-pi.git
cd easy-pi
npm install --ignore-scripts
npm run build:offline
node packages/coding-agent/dist/cli.js
```

Once the beta is available:

```bash
npm install -g easy-pi@beta
epi
```

For a quick non-interactive check:

```bash
epi -p "List the files in this project and summarize its entry points"
```

## Why easy-pi

### A complete terminal loop

The built-in tools cover the ordinary coding path: read files, search a tree, edit
content, write new files, and run shell commands. Interactive and print modes use
the same session runtime.

### Native delegation

Subagents are part of the runtime rather than an afterthought. Work can be delegated
with bounded admission, structured result validation, delivery cleanup, and isolated
workspace handling. Global model and thinking-effort defaults for spawned agents are
independent from the caller's current settings.

### Sessions that preserve context

Sessions are persisted locally and can be continued, resumed, or forked. Supported
Codex preserve/fork flows carry cache affinity when appropriate while keeping child
request IDs, histories, and cancellation state independent.

### Pi-compatible extension surface

The fork keeps the existing provider and extension names to avoid breaking the Pi
ecosystem. For example:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

The published product name is `easy-pi`, and its command is `epi`; the internal
runtime package names remain compatible by design.

## Runtime shape

```text
                 ┌─────────────────────┐
                 │      epi CLI         │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │    Agent session    │
                 └──────┬─────────┬────┘
                        │         │
              ┌─────────▼───┐ ┌───▼─────────────┐
              │ tools       │ │ model provider  │
              │ read/bash/  │ │ multi-provider  │
              │ edit/write  │ └─────────────────┘
              └─────────────┘
                        │
                 ┌──────▼─────────────┐
                 │ native subagents   │
                 │ bounded + isolated │
                 └────────────────────┘
```

The npm package bundles the fork's internal runtime packages. An installed `easy-pi`
therefore does not silently resolve a modified runtime from the workspace or fall
back to an unrelated upstream runtime version.

## Configuration and safety

User data defaults to `~/.epi/agent`, separate from Pi's `.pi` directory. Provider
authentication, settings, prompts, skills, themes, and session history stay local.

`epi` is **not a sandbox**. It runs with the permissions of the user who starts it.
Use a container or an OS-level isolation boundary when a task needs stronger
filesystem, process, network, or credential restrictions. See
[`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md).

Do not commit `.env`, authentication files, `~/.epi` data, or real-provider evidence.

## Development

```bash
npm install --ignore-scripts
npm run build:offline
npm run check
./test.sh
```

Build and inspect the standalone npm artifact outside the repository:

```bash
npm run build:offline
npm run pack:easy-pi /tmp/easy-pi-pack
npm install --prefix /tmp/easy-pi-install --ignore-scripts \
  /tmp/easy-pi-pack/easy-pi-0.1.0-beta.1.tgz
/tmp/easy-pi-install/node_modules/.bin/epi --version
```

The release workflow is tag-gated and publishes only `easy-pi` with a matching
`easy-pi-v*` tag. Ordinary pushes to `main` do not publish packages.

## Repository map

| Area | Purpose |
| --- | --- |
| [`packages/coding-agent`](packages/coding-agent) | CLI, interactive UI, sessions, tools, and extension API |
| [`packages/ai`](packages/ai) | Multi-provider model API and Codex transport |
| [`packages/agent`](packages/agent) | Agent runtime, state, and streaming |
| [`packages/subagent`](packages/subagent) | Native delegation and collaboration runtime |
| [`packages/tui`](packages/tui) | Terminal UI primitives |
| [`scripts/pack-easy-pi.mjs`](scripts/pack-easy-pi.mjs) | Standalone npm package staging |

## License

MIT — see [LICENSE](LICENSE).
