---
phase: 01-skeleton
verified: 2026-04-11T18:00:00Z
status: human_needed
score: 5/5
overrides_applied: 0
human_verification:
  - test: "Launch app with `pnpm tauri dev`, confirm Welcome screen renders with Open vault button and empty recent list"
    expected: "Centered card with VaultCore heading, tagline, Open vault CTA, divider, RECENT VAULTS label, empty state text"
    why_human: "Requires running Tauri dev build and visual inspection of rendered UI"
  - test: "Click Open vault, pick a folder with .md files via native dialog, confirm Welcome transitions to VaultView"
    expected: "Native OS folder picker opens; on selection, progress overlay shows file count, then vault view with file list and vault path in header"
    why_human: "Requires native OS dialog interaction and runtime Tauri IPC"
  - test: "Relaunch app, confirm auto-load reopens the vault and recent list shows the entry"
    expected: "App auto-loads last vault without showing Welcome; on reset, recent list shows the previously opened vault path"
    why_human: "Requires full app restart cycle to verify persistence"
  - test: "Click a .md file, confirm CM6 renders with Markdown highlighting (H1/H2/H3 at 26/22/18px, bold, italic, code)"
    expected: "Editor mounts with styled headings, bold/italic rendering, inline code background, GFM support"
    why_human: "Visual verification of CM6 rendering, font sizes, highlight styles"
  - test: "Type in editor, wait 2s, check file on disk; also test Cmd/Ctrl+B/I/K"
    expected: "File on disk reflects edits after ~2s idle; B wraps **bold**, I wraps *italic*, K inserts [text](url)"
    why_human: "Requires runtime keystroke testing and disk verification"
  - test: "Point recent vault at a nonexistent path, launch app, confirm Welcome + error toast"
    expected: "App shows Welcome screen (not crash); toast appears with VaultUnavailable message"
    why_human: "Requires manual recent-vaults.json manipulation and app restart"
---

# Phase 1: Skeleton Verification Report

**Phase Goal:** User can launch VaultCore, open a Markdown vault via native folder dialog, and edit a single `.md` file with auto-save -- the entire foundation needed for every later phase.
**Verified:** 2026-04-11T18:00:00Z
**Status:** human_needed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User launches `tauri dev` and sees a Welcome screen with "Open vault" button and recent-vaults list | VERIFIED | `App.svelte` renders `WelcomeScreen` when `$vaultStore.status !== "ready"` (line 94-102). `WelcomeScreen.svelte` has centered card layout with "Open vault" button (data-testid="open-vault-button"), recent vault list via `RecentVaultRow`, and empty state. `ProgressBar` and `ToastContainer` mounted globally. |
| 2 | User picks a folder through native OS dialog, Welcome transitions to vault view; path appears in recent list on next launch and auto-loads | VERIFIED | `handlePickVault()` in App.svelte calls `pickVaultFolder()` (native dialog via `@tauri-apps/plugin-dialog`), then `loadVault()` which calls `openVault` IPC. `open_vault` in vault.rs canonicalizes path, grants FsExt scope, persists to recent-vaults.json (FIFO-10 dedupe), performs two-pass walk, returns `VaultInfo` with `file_list`. `vaultStore.setReady()` transitions status to "ready", switching render to `VaultView`. `onMount` in App.svelte calls `getRecentVaults()` then auto-loads `recent[0]`. |
| 3 | User opens a `.md` file and CM6 renders with Markdown syntax highlighting and inline live-preview, keystrokes at 60 fps | VERIFIED | `VaultView.svelte` renders file list from `$vaultStore.fileList`, click triggers `openFile()` -> `readFile` IPC -> `editorStore.openFile()` -> `CMEditor.svelte` mounts via `{#key $editorStore.activePath}`. `extensions.ts` builds RC-02 explicit list: `markdown({ extensions: [GFM] })`, `syntaxHighlighting(markdownHighlightStyle)` with H1=26px, H2=22px, H3=18px. No basicSetup/lineNumbers/foldGutter. `EditorView` stored in plain `let` (RC-01). |
| 4 | User edits file, waits ~2s, change on disk without save; Cmd/Ctrl+B/I/K wrap selections | VERIFIED | `autoSave.ts` implements 2000ms debounce on `EditorView.updateListener.of` filtering `docChanged`. `CMEditor.svelte` accepts `onSave` callback prop. `VaultView.svelte` wires `onSaveSync` -> `handleSave()` -> `writeFile` IPC. `keymap.ts` exports `vaultKeymap` with `Mod-b` (bold **), `Mod-i` (italic *), `Mod-k` (link []()). `wrapSelection` supports toggle-off. |
| 5 | If last-opened vault path unreachable, app returns to Welcome + toast with VaultError variant | VERIFIED | `App.svelte` `onMount` catches errors from `loadVault()`. `loadVault()` catch block calls `vaultStore.setError()` (keeps status !== "ready" so Welcome renders) and `toastStore.push({ variant: "error" })`. Rust `open_vault` returns `VaultError::VaultUnavailable` for nonexistent paths. `VaultError` TS interface mirrors Rust `{kind, message, data}` shape. `vaultErrorCopy` maps `VaultUnavailable` to user-facing text. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/error.rs` | Full VaultError enum with 8 variants + manual Serialize | VERIFIED | 8 variants (FileNotFound, PermissionDenied, DiskFull, IndexCorrupt, VaultUnavailable, MergeConflict, InvalidEncoding, Io), `{kind, message, data}` serialization, 75 lines |
| `src-tauri/src/commands/vault.rs` | open_vault, get_recent_vaults, get_vault_stats | VERIFIED | 3 commands registered, canonicalization, FsExt scope, recent JSON persistence, two-pass walk with progress events, file_list return, 309 lines |
| `src-tauri/src/commands/files.rs` | read_file (UTF-8 guard), write_file (vault-scope guard) | VERIFIED | `ensure_inside_vault` helper, `String::from_utf8` -> `InvalidEncoding`, parent canonicalization for writes, SHA-256 hash return, 109 lines |
| `src-tauri/src/lib.rs` | Command registration + VaultState | VERIFIED | `generate_handler!` with all 5 commands, `VaultState` with `Mutex<Option<PathBuf>>`, plugins registered |
| `src-tauri/src/hash.rs` | SHA-256 content hashing | VERIFIED | `hash_bytes` function + 3 unit tests |
| `src/App.svelte` | Routing + auto-load flow | VERIFIED | Conditional render Welcome/VaultView, onMount auto-load, progress listener, VAULT-05 fallback, 106 lines |
| `src/components/Editor/extensions.ts` | RC-02 explicit CM6 extension list | VERIFIED | 13 explicit extensions, no basicSetup, no lineNumbers, no foldGutter, RC-02 decision comment |
| `src/components/Editor/CMEditor.svelte` | EditorView in plain let (RC-01) | VERIFIED | `let view: EditorView | null = null` with explicit comment, onMount/onDestroy lifecycle |
| `src/components/Editor/keymap.ts` | wrapSelection + vaultKeymap (B/I/K) | VERIFIED | `wrapSelection` with toggle-off via `changeByRange`, `wrapLink` for Mod-k, 79 lines |
| `src/components/Editor/autoSave.ts` | 2s debounce on docChanged | VERIFIED | `AUTO_SAVE_DEBOUNCE_MS = 2000`, `EditorView.updateListener.of`, `clearTimeout`/`setTimeout` pattern |
| `src/components/Editor/theme.ts` | CM6 theme with CSS variables | VERIFIED | `markdownHighlightStyle` with H1=26px, H2=22px, H3=18px, CSS variable refs throughout |
| `src/components/Welcome/WelcomeScreen.svelte` | UI-SPEC Welcome card | VERIFIED | Centered card, heading, tagline, CTA button, divider, recent list, empty state |
| `src/components/Welcome/VaultView.svelte` | Flat file list + editor pane | VERIFIED | Grid layout (200-280px + 1fr), FileListRow iteration, CMEditor mount via {#key}, onSave -> writeFile wiring |
| `src/components/Welcome/FileListRow.svelte` | Click-to-open row | VERIFIED | Button with active highlight, onClick -> onOpen callback |
| `src/components/Toast/Toast.svelte` | error/conflict/clean-merge variants | VERIFIED | 3 variants with icons and border colors via CSS variables |
| `src/components/Toast/ToastContainer.svelte` | Stacked toast renderer | VERIFIED | Fixed position, iterates $toastStore |
| `src/components/Progress/ProgressBar.svelte` | UI-SPEC progress card | VERIFIED | Overlay with counter, progress bar, current file display |
| `src/ipc/commands.ts` | Typed invoke wrappers | VERIFIED | 5 commands + pickVaultFolder, normalizeError, sole `invoke` importer |
| `src/ipc/events.ts` | listenIndexProgress wrapper | VERIFIED | Typed `IndexProgressPayload`, listen wrapper returning `UnlistenFn` |
| `src/store/vaultStore.ts` | Classic writable with actions | VERIFIED | `writable` store, setOpening/setIndexing/setReady/setError/reset actions |
| `src/store/editorStore.ts` | Editor state store | VERIFIED | activePath/content/lastSavedHash, openFile/setContent/setLastSavedHash/close |
| `src/store/toastStore.ts` | Toast queue with cap-at-3, 5s dismiss | VERIFIED | `MAX_TOASTS = 3`, `AUTO_DISMISS_MS = 5000`, dismiss/push/subscribe |
| `src/store/progressStore.ts` | Progress state store | VERIFIED | active/current/total/currentFile, start/update/finish/reset |
| `src/types/errors.ts` | VaultError TS interface | VERIFIED | 8 VaultErrorKind variants, isVaultError guard, vaultErrorCopy map |
| `src/types/vault.ts` | VaultInfo/VaultStats/RecentVault | VERIFIED | Matches Rust serialized shapes |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| App.svelte | vaultStore | `$vaultStore` subscription | WIRED | Conditional render on `$vaultStore.status === "ready"` (line 94) |
| ipc/commands.ts | @tauri-apps/api/core | invoke | WIRED | All 5 commands use `invoke<T>()` with types |
| WelcomeScreen | ipc/commands.ts::openVault | click handler | WIRED | `onPickVault` prop -> App.svelte `handlePickVault()` -> `pickVaultFolder()` + `loadVault()` -> `openVault()` |
| App.svelte onMount | getRecentVaults + openVault | auto-load flow | WIRED | Lines 68-87: fetch recent, if last exists call loadVault() |
| vault.rs::open_vault | FsExt::allow_directory | runtime scope | WIRED | `app.fs_scope().allow_directory(&canonical, true)` at line 151 |
| files.rs::read_file | VaultError::InvalidEncoding | from_utf8 error | WIRED | `String::from_utf8(bytes).map_err(... InvalidEncoding ...)` at line 63 |
| lib.rs | commands::{vault,files} | generate_handler! | WIRED | All 5 commands in handler macro at lines 25-30 |
| vault.rs::open_vault | Emitter::emit | progress events | WIRED | `app.emit(PROGRESS_EVENT, ...)` at line 177 |
| events.ts::listenIndexProgress | progressStore.update | event callback | WIRED | App.svelte line 70-72 subscribes and calls progressStore.update |
| VaultView.svelte | CMEditor.svelte | {#key $editorStore.activePath} | WIRED | Dynamic mount at line 77-79 |
| CMEditor.svelte onSave | writeFile | VaultView wiring | WIRED | VaultView passes `onSaveSync` -> `handleSave()` -> `writeFile(activePath, text)` |
| CMEditor.svelte | extensions.ts | buildExtensions(onSave) | WIRED | onMount creates EditorState with `buildExtensions(onSave)` |
| autoSave.ts | EditorView.updateListener | extension factory | WIRED | `EditorView.updateListener.of(...)` filtering docChanged |
| keymap.ts | EditorSelection | changeByRange | WIRED | `state.changeByRange(range => ...)` in wrapSelection |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| WelcomeScreen.svelte | recent (prop) | App.svelte -> getRecentVaults IPC -> Rust recent-vaults.json | Yes (JSON file read) | FLOWING |
| VaultView.svelte | $vaultStore.fileList | App.svelte loadVault -> openVault IPC -> Rust walkdir | Yes (real directory walk) | FLOWING |
| CMEditor.svelte | content (prop) | VaultView openFile -> readFile IPC -> Rust fs::read | Yes (real file read) | FLOWING |
| ProgressBar.svelte | $progressStore | App.svelte listenIndexProgress -> vault.rs emit events | Yes (real walk events) | FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED (requires running Tauri dev server with native windowing -- cannot test without `pnpm tauri dev` and a real vault on disk)

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-----------|-------------|--------|----------|
| VAULT-01 | 00, 01, 02 | Open vault via native OS folder picker | SATISFIED | `pickVaultFolder()` uses `@tauri-apps/plugin-dialog` `open({ directory: true })` |
| VAULT-02 | 00, 01, 02 | Recent-vaults persisted as JSON in app-data | SATISFIED | `push_recent_vault_to` writes `recent-vaults.json` with FIFO-10 dedupe |
| VAULT-03 | 02 | Auto-load last vault on startup | SATISFIED | App.svelte onMount fetches recent[0] and calls loadVault() |
| VAULT-04 | 00, 02 | Welcome screen with Open vault button + recent list | SATISFIED | WelcomeScreen.svelte with CTA button, recent list, empty state |
| VAULT-05 | 01, 02 | Unreachable vault -> Welcome + no crash | SATISFIED | loadVault catch -> vaultStore.setError + toast; open_vault returns VaultUnavailable |
| VAULT-06 | 01, 04 | VaultInfo/VaultStats commands | SATISFIED | get_vault_stats returns path + file_count; open_vault returns VaultInfo |
| IDX-02 | 04 | Progress bar with filename + counter during indexing | SATISFIED | Two-pass walk with throttled events, ProgressBar renders counter + filename |
| EDIT-01 | 03 | CM6 renders Markdown with syntax highlighting | SATISFIED | `markdown({ extensions: [GFM] })` + `syntaxHighlighting(markdownHighlightStyle)` |
| EDIT-02 | 03 | Inline live-preview (bold/italic/headings/code/lists) | SATISFIED | HighlightStyle with heading sizes, bold/italic/monospace styling, GFM |
| EDIT-04 | 03 | Cmd/Ctrl+B/I/K shortcuts | SATISFIED | vaultKeymap with Mod-b (bold), Mod-i (italic), Mod-k (link), toggle-off |
| EDIT-09 | 03 | Auto-save 2s debounce | SATISFIED | autoSaveExtension with 2000ms debounce on docChanged |
| UI-04 | 02 | Toast supports error/conflict/clean-merge, auto-dismiss 5s | SATISFIED | 3 variants in Toast.svelte, AUTO_DISMISS_MS=5000, MAX_TOASTS=3, manual dismiss |
| ERR-01 | 00, 01 | VaultError enum with all spec Section 5 variants | SATISFIED | 8 variants in error.rs matching spec; {kind,message,data} serialization |

No orphaned requirements found -- all 13 requirement IDs from the phase are covered.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| src-tauri/src/error.rs | 4 | Comment mentions "Placeholder" | Info | Historical comment about Wave 0 replacement -- not an active placeholder |

No blockers, no warnings. Clean codebase.

### Human Verification Required

### 1. Full Launch and Welcome Screen

**Test:** Run `pnpm tauri dev`, confirm the app opens to the Welcome screen with the exact UI-SPEC layout.
**Expected:** Centered card with "VaultCore" heading, tagline, blue "Open vault" button, divider, "RECENT VAULTS" label, and "No recent vaults" empty state on first launch.
**Why human:** Requires running the Tauri dev build and visual inspection of rendered components in a native window.

### 2. Native Folder Dialog + Vault Open Flow

**Test:** Click "Open vault", pick a folder containing `.md` files, observe the transition.
**Expected:** Native OS file dialog opens; after selection, progress overlay shows file count filling up, then vault view appears with file list in left sidebar and "No file selected" in the editor pane.
**Why human:** Requires native OS dialog interaction, real filesystem access, and runtime Tauri IPC.

### 3. Auto-Load + Recent Vaults Persistence

**Test:** Close and relaunch the app after opening a vault.
**Expected:** App auto-loads the last vault without showing Welcome screen; recent-vaults list contains the previously opened entry.
**Why human:** Requires full app restart cycle and persistence verification across sessions.

### 4. CM6 Editor Rendering + Keystroke Feel

**Test:** Click a `.md` file with headings, bold, italic, code, and lists. Verify visual rendering and keystroke responsiveness.
**Expected:** H1/H2/H3 render at distinct sizes (26/22/18px), bold/italic styled, inline code has background, GFM tables work. Typing feels instant (60fps).
**Why human:** Visual rendering verification and subjective performance feel cannot be tested programmatically.

### 5. Auto-Save to Disk

**Test:** Edit a file in the editor, wait 2 seconds, check the file on disk (e.g., `cat` the file in a terminal).
**Expected:** File on disk reflects the edits without any manual save action.
**Why human:** Requires coordinated timing between editor input and disk verification.

### 6. Keyboard Shortcuts (B/I/K)

**Test:** Select text, press Cmd/Ctrl+B, Cmd/Ctrl+I, Cmd/Ctrl+K.
**Expected:** B wraps with `**...**` and toggles off; I wraps with `*...*` and toggles off; K inserts `[text](url)` with cursor in URL position.
**Why human:** Requires runtime keystroke testing in the CM6 editor within the Tauri window.

### 7. Unreachable Vault Fallback (VAULT-05)

**Test:** Edit `recent-vaults.json` in app-data to point to a nonexistent path, then launch the app.
**Expected:** App shows Welcome screen (not blank screen or crash); an error toast appears with "Vault unavailable" message.
**Why human:** Requires manual file manipulation and app restart to trigger the error path.

### Gaps Summary

No programmatic gaps found. All 5 ROADMAP success criteria are structurally verified through code inspection: the artifacts exist, are substantive (not stubs), are wired end-to-end, and data flows from real sources (filesystem walks, file reads, JSON persistence) through the full stack.

The phase requires human verification because the success criteria are inherently user-observable behaviors ("User launches...", "User picks...", "User opens...") that cannot be confirmed without running the Tauri application in a native window with real filesystem interaction.

---

_Verified: 2026-04-11T18:00:00Z_
_Verifier: Claude (gsd-verifier)_
