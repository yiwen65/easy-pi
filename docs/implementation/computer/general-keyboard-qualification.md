# General keyboard qualification

Status authority: `docs/tasks/2026-09-18-computer-native-implementation-task.md`, T-046. This is evidence navigation, not whole-goal acceptance.

## Installed application evidence

C383 used the original installed AgentSession and Computer tool against a dedicated TextEdit document. All thirteen original named keys have application-effect evidence:

- Home/End/PageUp/PageDown: independent `AXVisibleCharacterRange` changes.
- Left/Right/Up/Down: exact independent selection offsets.
- Space/Tab/Return/Delete: exact selection offsets and UTF-16 length changes.
- Escape: the task Find field lost focus and the document regained it; subsequent Unicode insertion was saved in the document, not the search field.
- Owned Shift down → Right → Shift up: selection `[0,1]`, followed by unmodified Right collapsing to `[1,0]`.

Final saved bytes exactly matched `a \t🦀ébc\nDEF\nxyz` (literal tab/newlines in the actual file), SHA256 `0e83849fa0f277b4b27470f534f0ad5194b4e957713e0d8df51fb7763c4ba6b7`. The task document closed and TextEdit survived. Sixty-two native terminals and two natural child exits.

The observed input source was `com.apple.inputmethod.SCIM.ITABC`, with ASCII-capable keyboard layout `com.apple.keylayout.ABC`. Unicode text does not depend on mapping each character to a physical key. Key names retain the native macOS virtual-key mapping; non-ABC physical shortcut mappings are not qualified by this run.

C384 used the same installed candidate for an interrupted Shift-plus-drag. The actual pointer-down snapshot contained Shift; after cancellation the target received mouse-up and flags returned to zero. The planned final KeyUp action did not run: owned cleanup released it. The original AgentSession made only the initiating faux request and no continuation request; helper and host closed naturally. Six terminals/two natural exits. `foreground_target_changed` was also reported, so the emergency chord is not asserted to be the sole interruption cause.

Independent seal: `.artifacts/computer/general/keyboard-installed-verification.json`.

Earlier independently sealed real Terminal PTY/command, VSCode and Chrome Unicode/multiline/combining-character/literal-tag tests remain part of T-046, as do native cancellation/revocation/unwind regressions. Failed C-locale shells, stale harness observations and held-input refusals remain preserved; none was treated as permission to replay unknown input.

These runs used faux and software input. They do not establish physical-device coexistence, alternate-layout shortcut support, cross-window drag or final delivery. Those limits remain explicit in subsequent task gates.
