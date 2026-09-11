# Terminal image-path paste repair

## Outcome

Fixed easy-pi's default CustomEditor so an explicit standalone PNG/JPEG path received through bracketed paste becomes an actual numbered image attachment, not plain text. Source and local installed build verified. Existing Agent/Host processes were not restarted or sent input. No model requests, paid tokens, photo-library access, or TestFlight deployment.

## Cause and scope

AgentPort now sends an absolute path after uploading through the current SSH connection. Codex recognizes image paths, but that behavior cannot be assumed for easy-pi: its previous CustomEditor handled only the clipboard hotkey; the base Editor treated bracketed-paste payloads as text. Existing `insertAttachmentAtCursor("Image", ImageContent)` and submit logic already supported real image markers/payloads.

The repair is in easy-pi, not an AgentPort protocol special case. The base Editor exposes its existing complete-paste method to subclasses; no duplicate terminal framing/parser is introduced. CustomEditor recognizes a standalone absolute or home-relative PNG/JPEG path (optionally quoted), reads it asynchronously, validates its byte signature and dimensions, and uses the existing attachment registry. Numbering, deletion, undo and payload submission remain native. Bash-mode pastes and non-path prose remain text. Missing, invalid, oversized or unreadable images fall back to normal text.

Regular-file reads are bounded to 20 MiB and refuse special files. Input arriving during image loading is queued to preserve order; a 3-second deadline restores ordinary paste behavior. Replacing the draft invalidates a late result. This adds no automatic Enter. Native Agent image payload encoding is unchanged; image bytes are not transported through AgentPort's JS/SFTP bridge as Base64.

## Evidence

- Red: new `custom-editor-image-path.test.ts` had 2 failing tests showing absolute PNG paths instead of `[Image #1]` (3 neighboring tests passed).
- Green: 9 image-path tests plus the existing history-keybinding test passed (10 total): actual payload, no implicit submit, split paste, queued explicit Enter, delete/undo, bash mode, invalid image, missing path, draft replacement and ordinary multiline text.
- Existing `packages/tui/test/editor.test.ts`: 190/190 passed.
- Full `npm run check`: passed, no formatting fixes and no unrelated file changes detected by pre/post hashes.
- User explicitly authorized local build and isolated acceptance. `npm --prefix packages/tui run build` and `npm --prefix packages/coding-agent run build` passed. The installed `pi` symlink points at this workspace's compiled CLI.
- Actual compiled CLI launched in task-only PTY with isolated HOME/config, extensions disabled, offline and no session persistence. Pasted a generated valid PNG path and observed `[Image #1]` in terminal output. No Enter was sent. Only this task process was terminated afterward.
- Temporary runtime evidence: fixture output under `easy-pi-image-pty-dcxryz09/terminal.ansi` in the OS temporary directory. Ad-hoc helper scripts removed after verification; durable replay is covered by the editor tests. Generic editor test output: `/tmp/easy-pi-image-editor-tests.log`.
- AgentPort debug GUI reopened only through `scripts/restart-debug-app.py --skip-build`. PID 8517 exact debug bundle executable verified; window 2367 screenshot `/tmp/easy-pi-image-fix-desktop.png` inspected and nonblank. Hosts/Agents were not stopped.

## Activation and limitations

New local easy-pi processes load the rebuilt code. Already-running Agents retain their loaded implementation and were deliberately not restarted. Other remote hosts need the corresponding easy-pi update. This is compiled-CLI/PTY acceptance, not a fresh physical iPhone PhotosPicker-to-Agent end-to-end test. Full malformed-image decoding and every custom editor implementation are not claimed. Existing clipboard-image support is unchanged.

Shared-worktree unrelated changes were preserved and excluded from this commit. The requested build uses the current working tree (including other sessions' work), not an isolated release artifact; no release or distribution was performed.
