# easy-pi

A native AI coding agent for the terminal.

`easy-pi` keeps Pi's extension and provider APIs familiar while shipping the fork's runtime changes in one installable package. It gives you a focused terminal workflow with file tools, multiple LLM providers, persistent sessions, and native subagent collaboration.

```bash
npm install -g easy-pi@beta
epi
```

> The first public release is currently beta: `0.1.0-beta.1`.

## What it does

- **Terminal-first coding** — read, search, edit, write, and run commands from one interactive session.
- **Multi-provider models** — switch providers and models without changing the workflow.
- **Persistent sessions** — continue, resume, fork, and inspect work across invocations.
- **Native subagents** — delegate bounded work with admission control, structured results, cleanup, and isolated workspaces.
- **Model and effort defaults** — configure independent defaults for spawned subagents.
- **Codex cache affinity** — preserve cache lineage for supported native preserve/fork flows while keeping child request identities independent.
- **Extensible runtime** — use Pi-compatible extensions, custom providers, themes, skills, and SDK entry points.

## Quick start

```bash
# Install the beta release
npm install -g easy-pi@beta

# Start interactive mode
epi

# Print mode
epi -p "List the files in this project and summarize the entry points"

# See available options
epi --help
```

Authentication and model configuration are managed locally by the agent. The default user data directory is `~/.epi/agent`; it is separate from Pi's `.pi` data directory.

## How the runtime is organized

```text
prompt
  │
  ▼
 epi CLI ──► agent session ──► provider/model
    │              │
    │              ├── persistent session history
    │              └── native subagent collaboration
    │
    └── built-in read / bash / edit / write tools
```

The npm package bundles the fork's internal runtime packages rather than resolving them from the workspace or silently selecting an upstream runtime version. Internal package names remain compatible with the existing Pi extension ecosystem.

## Pi compatibility

The fork intentionally preserves the existing Pi extension surface and provider package names where possible. Existing extensions should continue to use imports such as:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

The CLI command is `epi`; the published package is `easy-pi`. Pi-compatible extensions and provider implementations should still be tested against the exact easy-pi beta before production use.

## Development

```bash
npm install --ignore-scripts
npm run build:offline
npm run check
./test.sh
```

Build a standalone npm tarball and install it outside the repository:

```bash
npm run build:offline
npm run pack:easy-pi /tmp/easy-pi-pack
npm install -g /tmp/easy-pi-pack/easy-pi-0.1.0-beta.1.tgz
```

The release workflow is tag-gated. It does not publish from ordinary pushes to `main`.

## Security and permissions

`epi` runs with the permissions of the user who starts it. It is not a sandbox. Use a container or another OS-level isolation boundary when a task needs stronger filesystem, process, network, or credential restrictions.

Do not commit `.env`, authentication files, `~/.epi` data, or session evidence. See [`packages/coding-agent/docs/containerization.md`](packages/coding-agent/docs/containerization.md) for isolation patterns.

## License

MIT. See [LICENSE](LICENSE).
