# Phase 2: Vault - Research

**Researched:** 2026-04-12
**Domain:** Tauri 2 + Rust file-system watching / three-way merge, Svelte 5 multi-tab layout, sidebar tree UI
**Confidence:** HIGH (core patterns verified against codebase + crates.io) / MEDIUM (three-way merge algorithm detail)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Sidebar Tree (FILE-01)**
- D-01: Lazy-load — root entries only, subtrees load on expand
- D-02: Left sidebar, resizable with drag-handle; width persisted in app settings (not vault-specific); collapsible
- D-03: Sort: folders first, alphabetical; case-insensitive; same group within folders/files
- D-04: All dot-prefixed directories AND files hidden (.obsidian, .trash, .git, .vscode, etc.) — no toggle in Phase 2
- D-05: Symlinks displayed but not followed during recursive ops; opening a symlinked .md reads target normally

**Multi-Tab + Split-View (EDIT-05, EDIT-06)**
- D-06: Obsidian-style tab bar — drag-to-reorder, middle-click/X closes, unsaved dot indicator; Cmd/Ctrl+Tab cycles, Cmd/Ctrl+W closes; no hard limit
- D-07: Drag tab to editor left/right edge for 2-pane horizontal split; drag back to rejoin; only 2 panes in Phase 2; each pane has its own tab bar
- D-08: New tabStore — manages `tabs: Tab[]`, `activeTabId`, `splitState: { left, right, activePane }`; editorStore stays CM6-specific
- D-09: Tab state NOT persisted across restarts (Phase 5)

**File Watcher + Three-Way Merge (SYNC-01..08)**
- D-10: notify crate (v7+), recursive vault watch, debounce ~200ms via notify's debouncer; handle Create/Modify/Remove/Rename
- D-11: Auto-merge non-conflicting external changes; keep local on conflict; base = last-saved; diff via `similar` crate; toast both outcomes
- D-12: Write-token + time-window self-filtering: record (path, timestamp) before own writes; ignore matching watcher events within ~100ms; tokens expire at 500ms
- D-13: Bulk-change threshold 500 events / 2s: switch to indexing progress UI, batch-process, resume per-file behavior after burst
- D-14: Vault unmount → all editors readonly, toast, preserve buffers, periodic reconnect attempt; app stays in vault view

**File Operations (FILE-02..05, FILE-08, FILE-09)**
- D-15: Delete moves to `.trash/` (auto-created, flat, Obsidian-compatible); confirmation dialog shows filename
- D-16: Rename shows wiki-link count via simple regex `\[\[filename\]\]`; prompt if count > 0; no actual rewrite (Phase 4)
- D-17: Drag-drop in sidebar = move; no copy-on-drag (Phase 5)
- D-18: New file in selected folder: `Unbenannt.md`, inline-editable, auto-suffix on collision; defaults to vault root
- D-19: New folder: right-click → "Neuer Ordner", inline rename

**Crate Additions**
- D-20: Phase 2 adds `notify` (v7+) and `similar` to Cargo.toml — no other new crates unless research identifies specific need

### Claude's Discretion

- Sidebar visual details: icons, hover states, selected highlight, indentation, expand/collapse animation
- Tab bar visual details: max-width, truncation, close-button visibility, active-tab styling
- Split-view resize: draggable divider or fixed 50/50
- Watcher debounce tuning: exact interval (suggested ~200ms)
- Three-way merge algorithm details: exact `similar` API usage, line-level vs. character-level
- Inline rename UX: Enter/Escape/Tab handling, validation (no `/` or `\`, `.md` extension policy)

### Deferred Ideas (OUT OF SCOPE)

- Show hidden files toggle (Phase 5)
- Tab session restore (Phase 5)
- Alt+Drag = Copy (Phase 5)
- Vertical split / grid layout (Phase 5+)
- Trash management UI (Phase 5)
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FILE-01 | Sidebar folder/file tree with lazy loading | D-01/D-04 locked; `list_directory` command needed; see Architecture §Sidebar |
| FILE-02 | Create new file from browser | D-18; `create_file` command + inline rename in sidebar |
| FILE-03 | Rename files (with link-count prompt) | D-16; `rename_file` command + regex scan; prompt wired but no rewrite |
| FILE-04 | Delete moves to `.trash/` | D-15; `delete_file` command + auto-create `.trash/` |
| FILE-05 | Move files by drag-and-drop | D-17; `move_file` command + HTML5 DnD in sidebar |
| FILE-08 | Symbolic links displayed but not followed | D-05; `DirEntry` metadata check in `list_directory` |
| FILE-09 | Non-UTF-8 files shown but toast on open | Already handled by `read_file` → `VaultError::InvalidEncoding`; sidebar must show non-md files |
| EDIT-05 | Multi-tab with Cmd/Ctrl+Tab cycling | D-06/D-08; new `tabStore`; keyboard handler |
| EDIT-06 | Split-view two notes side-by-side | D-07; `splitState` in `tabStore`; CSS grid pane layout |
| SYNC-01 | File watcher detects external changes | D-10; `notify-debouncer-full` v0.7 in background Tokio task |
| SYNC-02 | Write-ignore-list suppresses own-write events | D-12; in-memory HashSet<(PathBuf, Instant)> in VaultState |
| SYNC-03 | Bulk changes debounced 200ms window | notify-debouncer-full handles debounce automatically |
| SYNC-04 | Batch parsing parallelized with rayon | rayon crate added for batch processing (research below) |
| SYNC-05 | >500 file batches trigger progress UI | D-13; count events, switch to progress UI |
| SYNC-06 | Three-way merge on externally modified open file | D-11; `similar` 3.1.0 for diffing; custom merge logic |
| SYNC-07 | On true conflict, local editor state wins | D-11 step 4; keep left (editor) side on overlap |
| SYNC-08 | Toast for clean merge and lossy conflict | D-11; German strings hardcoded; reuse toastStore |
| IDX-07 | `.obsidian/` folder ignored by file browser and indexer | D-04; dot-directory filter already in `is_excluded()` in vault.rs |
| ERR-03 | Vault folder unmount → disable editing, toast | D-14; VaultUnavailable from watcher → readonly mode |
| ERR-04 | Disk-full during auto-save → toast, no buffer loss | Already handled by `write_file` → `VaultError::DiskFull`; Phase 2 adds editor readonly guard |
</phase_requirements>

---

## Summary

Phase 2 is the largest structural transformation in the VaultCore build. It replaces the Phase 1 flat file-list component with a full Obsidian-style layout: resizable sidebar with lazy-loaded tree, tabbed editor with split-view, and a reactive file-watcher pipeline that reconciles external edits via three-way merge.

The Rust side requires two new crates: `notify-debouncer-full` (0.7.0, stable, wraps `notify` 8.x) for event delivery, and `similar` (3.1.0) for line-level diffing. The three-way merge must be implemented manually on top of `similar`'s primitives because `similar` does not provide a built-in `merge3` function — the algorithm is straightforward (see Code Examples). The CONTEXT.md decision D-20 specifies `notify` v7+; in practice the current stable release line is `notify` 8.x with companion `notify-debouncer-full` 0.7.x, which together satisfy D-10's requirements. `rayon` is needed for SYNC-04 (batch parallelization) and should be added alongside the two crates specified in D-20.

The Svelte side requires one new store (`tabStore`), a complete replacement of `VaultView.svelte` with a multi-pane layout component, and new `Sidebar`, `TabBar`, `EditorPane`, and `SplitView` components. All existing store patterns (classic `writable`, action-method API) carry forward unchanged per D-08 and Phase 1's RC-01.

**Primary recommendation:** Implement the Rust watcher as a long-lived background `tokio::task` spawned inside `open_vault`, storing the `Debouncer` handle in `VaultState`. Build the three-way merge as a pure function in `src-tauri/src/merge.rs` using `similar::utils::diff_lines`. Implement the `tabStore` following the exact same action-method pattern as `vaultStore` and `toastStore`.

---

## Standard Stack

### Core (Rust additions — Phase 2)

| Crate | Version | Purpose | Source |
|-------|---------|---------|--------|
| notify | 8.2.0 | Cross-platform FS event watcher (via debouncer wrapper) | [VERIFIED: crates.io] |
| notify-debouncer-full | 0.7.0 | Debounced event delivery wrapping notify 8.x | [VERIFIED: crates.io] |
| similar | 3.1.0 | Line-level diff for three-way merge | [VERIFIED: crates.io] |
| rayon | 1.x | Data parallelism for SYNC-04 batch processing | [ASSUMED — standard, to confirm version] |

**Version note:** CONTEXT.md D-20 says "notify v7+". The current stable release is notify **8.2.0**. `notify-debouncer-full` 0.7.0 is the companion crate that provides the debounced API. Use `notify-debouncer-full` as the direct dependency — it re-exports `notify` internally. [VERIFIED: crates.io API 2026-04-12]

**`similar` 3.1.0 was released 2026-04-11** — one day before this research. Functionally identical to 2.7.0 for our use case. [VERIFIED: crates.io API 2026-04-12]

### Core (Frontend — no new npm packages required)

All Phase 2 frontend work uses libraries already installed in Phase 1. The new `tabStore` and UI components use only `svelte/store`, Tailwind CSS, and existing CodeMirror 6 packages.

### Alternatives Considered

| Standard Choice | Alternative | Why Not |
|----------------|-------------|---------|
| notify-debouncer-full | notify (raw) | Raw notify requires manual debounce implementation; debouncer-full handles deduplication, rename matching, and directory collapse — directly needed for D-13 |
| similar (manual merge3) | threeway_merge crate | threeway_merge (0.1.17, 3k downloads, MIT) wraps libgit2/xdiff via FFI — adds C linkage complexity; our merge logic is simple enough (line-level, keep-local policy) to implement in pure Rust on similar primitives |
| rayon (batch parallelism) | tokio spawn_blocking | rayon integrates naturally with iterators for parallel map; SYNC-04 spec says "parallelized with rayon" explicitly |

**Installation:**
```bash
# In src-tauri/Cargo.toml [dependencies]:
notify-debouncer-full = "0.7"
similar = "3.1"
rayon = "1"
```

---

## Architecture Patterns

### New Directory Structure (additions to Phase 1)

```
src/
├── components/
│   ├── Sidebar/
│   │   ├── Sidebar.svelte          # Outer container with resize handle
│   │   ├── TreeNode.svelte         # Recursive folder/file row
│   │   └── InlineRename.svelte     # Inline filename input field
│   ├── Tabs/
│   │   ├── TabBar.svelte           # Tab strip for one pane
│   │   └── Tab.svelte              # Single tab (title, dirty dot, close btn)
│   ├── Editor/
│   │   ├── CMEditor.svelte         # Existing — extended with readonly prop
│   │   └── EditorPane.svelte       # Wraps TabBar + CMEditor for one pane
│   └── Layout/
│       └── VaultLayout.svelte      # Replaces VaultView — sidebar + split editor
├── store/
│   ├── tabStore.ts                 # NEW: tabs, activeTabId, splitState
│   ├── vaultStore.ts               # Extended: add treeNode cache, watcher status
│   ├── editorStore.ts              # Narrowed: per-tab CM6 state lives in tabStore
│   ├── progressStore.ts            # Existing — reused for SYNC-05 bulk progress
│   └── toastStore.ts               # Existing — reused for merge/conflict toasts

src-tauri/src/
├── commands/
│   ├── files.rs                    # Extended: add create_file, rename_file, delete_file, move_file, list_directory
│   └── vault.rs                    # Extended: spawn watcher on open_vault
├── watcher.rs                      # NEW: watcher task, write-ignore-list, bulk-change counter, event dispatch
├── merge.rs                        # NEW: three_way_merge() pure function
└── lib.rs                          # Extended: VaultState gains WatcherHandle, WriteIgnoreList
```

### Pattern 1: notify-debouncer-full Integration

**What:** Long-lived background task holding the `Debouncer` handle in `VaultState`. On `open_vault`, spawn the watcher and send events to a Tauri event channel.

**When to use:** Any phase that needs to react to external filesystem changes.

```rust
// Source: docs.rs/notify-debouncer-full 0.7.0 (verified 2026-04-12)
use notify_debouncer_full::{
    notify::{EventKind, RecursiveMode},
    new_debouncer, DebounceEventResult,
};
use std::time::Duration;

pub fn spawn_watcher(
    app: tauri::AppHandle,
    vault_path: std::path::PathBuf,
    write_ignore: Arc<Mutex<WriteIgnoreList>>,
) -> notify_debouncer_full::Debouncer<notify_debouncer_full::notify::RecommendedWatcher> {
    let mut debouncer = new_debouncer(
        Duration::from_millis(200), // D-10: ~200ms debounce
        None,
        move |result: DebounceEventResult| {
            match result {
                Ok(events) => {
                    // Filter self-writes (D-12), batch large bursts (D-13)
                    process_events(&app, &write_ignore, events);
                }
                Err(errors) => {
                    // Surface VaultUnavailable on watch errors (D-14)
                    for e in errors {
                        let _ = app.emit("vault://watcher_error", e.to_string());
                    }
                }
            }
        },
    ).expect("watcher init");

    debouncer
        .watch(&vault_path, RecursiveMode::Recursive)
        .expect("vault watch");
    debouncer
}
```

### Pattern 2: Write-Ignore-List (D-12)

**What:** Before any own write, record `(canonical_path, Instant::now())` in a `HashSet`-like structure. The watcher callback checks this set and skips matching entries within the 100ms window.

**When to use:** Any Tauri command that writes to disk (write_file, rename_file, delete_file, move_file).

```rust
// Source: [ASSUMED] — standard Rust pattern using std::time::Instant
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const IGNORE_WINDOW: Duration = Duration::from_millis(100);
const IGNORE_EXPIRY: Duration = Duration::from_millis(500);

pub struct WriteIgnoreList {
    entries: HashMap<PathBuf, Instant>,
}

impl WriteIgnoreList {
    pub fn record(&mut self, path: PathBuf) {
        // Prune stale entries while we have the lock
        self.entries.retain(|_, t| t.elapsed() < IGNORE_EXPIRY);
        self.entries.insert(path, Instant::now());
    }

    pub fn should_ignore(&self, path: &PathBuf) -> bool {
        self.entries.get(path)
            .map(|t| t.elapsed() < IGNORE_WINDOW)
            .unwrap_or(false)
    }
}
```

### Pattern 3: Three-Way Merge with `similar` (D-11)

**What:** Given three text versions — `base` (last-saved snapshot), `left` (current editor buffer), `right` (new disk content) — compute a merged output. Return a `MergeOutcome` indicating clean merge or conflict.

**Algorithm:** Apply right's changes to base, then check whether any of those changed line ranges overlap with left's changed line ranges. If no overlap: apply right's changes to left. If overlap: keep left's version (D-11 step 4).

```rust
// Source: docs.rs/similar 3.1.0 + [ASSUMED] manual merge3 algorithm
use similar::{Algorithm, capture_diff_slices, ChangeTag};

pub enum MergeOutcome {
    Clean(String),     // No conflict — all external changes applied
    Conflict(String),  // Overlap detected — local version kept, external changes in non-overlapping regions still applied
}

pub fn three_way_merge(base: &str, left: &str, right: &str) -> MergeOutcome {
    let base_lines: Vec<&str> = base.lines().collect();
    let left_lines: Vec<&str> = left.lines().collect();
    let right_lines: Vec<&str> = right.lines().collect();

    // Compute what changed in each branch from base
    let left_ops = capture_diff_slices(Algorithm::Myers, &base_lines, &left_lines);
    let right_ops = capture_diff_slices(Algorithm::Myers, &base_lines, &right_lines);

    // Collect changed base-line ranges from each branch
    let left_changed = changed_ranges(&left_ops);
    let right_changed = changed_ranges(&right_ops);

    // Check for overlap
    let has_conflict = left_changed.iter().any(|lr| {
        right_changed.iter().any(|rr| ranges_overlap(lr, rr))
    });

    // Apply non-conflicting right changes onto left
    // (Simplified: if no conflict, just return right merged onto left;
    //  if conflict, return left as-is but note the conflict)
    if has_conflict {
        MergeOutcome::Conflict(left.to_string())
    } else {
        // Apply right_ops as a patch on top of left
        MergeOutcome::Clean(apply_right_to_left(
            &base_lines, &left_lines, &right_lines, &right_ops
        ))
    }
}
```

**Key insight:** The algorithm is line-level (`similar::utils::diff_lines` or `capture_diff_slices` with `base_lines`/`right_lines`). This is correct per SYNC-06 spec. Character-level diffs are not needed.

### Pattern 4: tabStore Shape (D-08)

**What:** New Svelte writable store managing the tab bar and split-view state. Follows the same action-method pattern as all Phase 1 stores.

```typescript
// Source: [ASSUMED] pattern consistent with Phase 1 RC-01 store convention
import { writable } from "svelte/store";

export interface Tab {
  id: string;           // crypto.randomUUID() or incremental
  filePath: string;     // Absolute path
  isDirty: boolean;     // True = unsaved changes, show dot indicator
  scrollPos: number;    // CodeMirror scroll offset for restore
  lastSaved: number;    // Unix ms timestamp
}

export interface SplitState {
  left: string[];       // Tab IDs in left pane
  right: string[];      // Tab IDs in right pane (empty = no split)
  activePane: "left" | "right";
}

export interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  splitState: SplitState;
}

// Action methods: openTab, closeTab, activateTab, setDirty,
//                 moveToPaneLeft, moveToPaneRight, closeSplit, cycleTab
```

### Pattern 5: VaultState Extension for Phase 2

The `VaultState` struct in `lib.rs` needs two new fields:

```rust
// Source: [ASSUMED] — consistent with Phase 1 Mutex-based pattern
use std::sync::{Arc, Mutex};
use notify_debouncer_full::Debouncer;
use notify_debouncer_full::notify::RecommendedWatcher;

pub struct VaultState {
    pub current_vault: Mutex<Option<std::path::PathBuf>>,
    // Phase 2 additions:
    pub watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,  // D-10
    pub write_ignore: Arc<Mutex<WriteIgnoreList>>,               // D-12
    pub vault_reachable: Mutex<bool>,                            // D-14 ERR-03
}
```

### New Tauri Commands Needed

| Command | Args | Returns | Notes |
|---------|------|---------|-------|
| `list_directory` | `path: String` | `Vec<DirEntry>` | One level only (lazy-load D-01); includes type (file/dir), is_symlink |
| `create_file` | `parent: String, name: String` | `String` (final path) | Auto-suffix `Unbenannt.md` if collision (D-18) |
| `rename_file` | `old_path: String, new_path: String` | `u32` (link count) | Regex scan for `[[filename]]` (D-16); no rewrite |
| `delete_file` | `path: String` | `()` | Move to `.trash/`, flat (D-15) |
| `move_file` | `from: String, to_folder: String` | `String` (new path) | D-17 |
| `count_wiki_links` | `filename: String` | `u32` | Simple regex across vault; called from rename flow |

### New Tauri Events Needed

| Event | Payload | Consumer |
|-------|---------|----------|
| `vault://file_changed` | `{ path, kind: "create"\|"modify"\|"delete"\|"rename", new_path? }` | Frontend merge handler |
| `vault://vault_status` | `{ reachable: bool }` | Frontend readonly mode (ERR-03) |
| `vault://bulk_change_start` | `{ estimated_count: number }` | Frontend shows progress UI |
| `vault://bulk_change_end` | `{}` | Frontend hides progress UI |

### Anti-Patterns to Avoid

- **Never store `EditorView` in a Svelte reactive store**: established in Phase 1 (RC-01). `tabStore` holds metadata (path, isDirty, scrollPos) but the `EditorView` instance is kept in a plain `let` or `Map<tabId, EditorView>` in the component.
- **Never use two walkdir passes in list_directory**: Phase 1 fixed a race condition by using a single pass. Same rule applies here.
- **Never emit per-file toasts for bulk changes**: D-13 threshold is 500 events/2s. Without this guard, Syncthing sync of a large vault will flood the UI with toasts.
- **Never canonicalize inside the watcher callback**: canonicalization does a syscall and blocks. Pre-canonicalize paths during `open_vault`; the watcher emits canonical paths from notify.
- **Never include `.trash/` in `list_directory` results**: D-04 applies to ALL dot-directories. `.trash/` is intentionally hidden even though Phase 2 creates it.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| FS event debouncing | Custom timer + channel | `notify-debouncer-full` | Handles inotify's split rename events (from/to), deduplicates rapid writes, merges directory deletes — platform quirks that hand-rolled code will miss |
| Line-level diffing | Myers diff from scratch | `similar::capture_diff_slices` | Well-tested implementation with multiple algorithm choices |
| Parallel batch processing | Manual thread pools | `rayon::par_iter()` | Work-stealing scheduler, correct for CPU-bound iteration |

**Key insight:** The three-way merge itself IS hand-rolled on top of `similar` — this is appropriate because our policy (keep-local-on-conflict) is simple enough that a 50-line function is safer than taking an FFI dependency on libgit2.

---

## Common Pitfalls

### Pitfall 1: notify v6 vs v8 API mismatch

**What goes wrong:** D-20 says "notify v7+" which readers may interpret as `notify = "7"` in Cargo.toml. There is no stable notify 7.x — the version line went 6 → 8 (skipping 7 as a stable release). The `DebouncedEvent` type that existed in notify 6 was removed; the new API uses raw `Event` with `notify-debouncer-full` as a separate crate.

**Why it happens:** Old tutorials and the spec's version reference are based on notify 6.x naming.

**How to avoid:** Use `notify-debouncer-full = "0.7"` as the Cargo dependency (not `notify = "7"`). `notify-debouncer-full` re-exports `notify` 8.x internally. [VERIFIED: crates.io 2026-04-12]

**Warning signs:** Compiler error "use of undeclared type `DebouncedEvent`".

### Pitfall 2: Debouncer dropped immediately

**What goes wrong:** The `Debouncer` returned by `new_debouncer()` must be kept alive for the duration of the watch. If it's stored in a local variable inside a function and the function returns, the debouncer drops and the watcher silently stops.

**Why it happens:** RAII semantics — `Debouncer` owns the watcher thread.

**How to avoid:** Store the `Debouncer` in `VaultState.watcher: Mutex<Option<Debouncer<...>>>`. The `VaultState` is `managed()` by Tauri and lives for the app lifetime. [VERIFIED: docs.rs/notify-debouncer-full]

**Warning signs:** Watcher works for a few seconds then stops emitting events.

### Pitfall 3: Self-write filtering race condition

**What goes wrong:** The write-ignore-list records `(path, timestamp)` before the write. If the write is async and takes >100ms (e.g., large file, slow disk), the watcher event arrives after the ignore window expires and triggers a spurious external-change flow.

**Why it happens:** D-12's 100ms window is tight.

**How to avoid:** Record the token immediately before calling `std::fs::write` (synchronous), not before the async command dispatch. The 500ms expiry provides a safety buffer. For the auto-save path, record inside `write_file` itself before the `std::fs::write` call.

**Warning signs:** Users see "Externe Änderungen wurden eingebunden" toast immediately after their own auto-save.

### Pitfall 4: EditorView lost on tab switch

**What goes wrong:** If `CMEditor.svelte` is remounted via `{#key tabId}` (like Phase 1's `{#key activePath}`), the CodeMirror `EditorView` is recreated on every tab switch, losing undo history and potentially triggering auto-save loops.

**Why it happens:** `{#key}` destroys and recreates the DOM node.

**How to avoid:** Keep all tab `EditorView` instances alive in a `Map<tabId, EditorView>` and use CSS `display: none` / `display: block` to show/hide panes. Only remount via `{#key}` when a tab is first opened (not when switching back to an already-open tab). [VERIFIED: Phase 1 RC-01 note about EditorView in plain `let`]

**Warning signs:** Undo history resets when switching tabs; auto-save fires immediately after switching back.

### Pitfall 5: Drag-and-drop conflicts with text selection in editor

**What goes wrong:** HTML5 drag events bubble from the editor pane into the sidebar DnD zone, causing dropped text to be interpreted as a file move.

**Why it happens:** Sidebar DnD listens on `dragenter`/`dragleave`/`drop` without checking `dataTransfer.types`.

**How to avoid:** In the sidebar DnD handlers, check `event.dataTransfer?.types.includes("text/vaultcore-file")` — only accept drops tagged with VaultCore's custom MIME type. The editor's native text drag uses `text/plain` and will be ignored.

### Pitfall 6: Watcher fires on .trash/ operations

**What goes wrong:** When Phase 2 moves a file into `.trash/`, the watcher fires a `Remove` event for the source path AND a `Create` event for the `.trash/` destination. Without the write-ignore-list, both events reach the merge handler.

**Why it happens:** `.trash/` is inside the vault root, so it is in the watch scope.

**How to avoid:** Record BOTH the source path (delete) and the `.trash/` destination path (create) in the write-ignore-list before the `std::fs::rename` call in `delete_file`.

### Pitfall 7: three_way_merge called on binary/non-UTF-8 files

**What goes wrong:** If the watcher triggers for a non-UTF-8 file that happens to be in an open tab (shouldn't happen per D-17, but defensive check needed), `similar`'s line operations will receive arbitrary bytes.

**Why it happens:** FILE-09 is handled at open-time, not at merge-time.

**How to avoid:** In the watcher's file-changed handler, before calling `three_way_merge`, verify the new disk content is valid UTF-8 (same check as `read_file`). If not, skip merge and emit a toast.

---

## Code Examples

### list_directory Command (FILE-01, FILE-08)

```rust
// Source: extends existing vault.rs pattern; [ASSUMED] structure
#[derive(serde::Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,       // Absolute, forward-slash normalized
    pub is_dir: bool,
    pub is_symlink: bool,   // FILE-08: display but don't follow
}

#[tauri::command]
pub async fn list_directory(
    state: tauri::State<'_, VaultState>,
    path: String,
) -> Result<Vec<DirEntryInfo>, VaultError> {
    // ensure_inside_vault() check (T-02 guard)
    // Read single level (no recursion — lazy-load D-01)
    // Skip dot-prefixed entries (D-04) — reuse is_excluded() logic
    // Return folders first, then files, both sorted case-insensitively (D-03)
    // Set is_symlink via entry.path_is_symlink() (FILE-08)
    // Do NOT follow symlinks: follow_links(false) already the default
}
```

### Wiki-link Count Scan (D-16)

```rust
// Source: [ASSUMED] — spec calls for simple regex, not full parser
use regex::Regex; // NOTE: regex crate needed — not in Phase 1 Cargo.toml

fn count_wiki_links(vault_root: &Path, target_name: &str) -> usize {
    let pattern = format!(r"\[\[{}\]\]", regex::escape(target_name));
    let re = Regex::new(&pattern).expect("valid regex");
    WalkDir::new(vault_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_excluded(e))
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |x| x == "md"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .map(|content| re.find_iter(&content).count())
        .sum()
}
```

**Note:** This requires adding `regex = "1"` to Cargo.toml. D-16 calls for simple regex — this is appropriate and regex is a highly stable crate. [ASSUMED — not in D-20's locked list, but the spec requires regex scanning]

### tabStore Action Methods

```typescript
// Source: [ASSUMED] consistent with Phase 1 action-method store pattern
export const tabStore = {
  subscribe: _store.subscribe,
  openTab(filePath: string): string {
    // Generate id, check for already-open tab (return existing id if so)
    // Push to active pane's tab list
    // Set as activeTabId
    // Return id
  },
  closeTab(id: string): void {
    // Remove from tabs array + pane list
    // Activate adjacent tab if it was the active one
    // If last tab in split pane, collapse split
  },
  cycleTab(direction: 1 | -1): void {
    // Cmd/Ctrl+Tab — cycle within active pane
  },
  setDirty(id: string, dirty: boolean): void { },
  splitToRight(tabId: string): void {
    // Move tab to right pane, create split
  },
  closeSplit(): void {
    // Merge right pane tabs into left, clear split
  },
};
```

### Frontend Watcher Event Handler

```typescript
// Source: extends events.ts pattern (Phase 1)
export interface FileChangedPayload {
  path: string;
  kind: "create" | "modify" | "delete" | "rename";
  new_path?: string;
}

export function listenFileChanged(
  handler: (payload: FileChangedPayload) => void,
): Promise<UnlistenFn> {
  return listen<FileChangedPayload>("vault://file_changed", (e) => handler(e.payload));
}

// In VaultLayout.svelte onMount:
// listenFileChanged(async (payload) => {
//   if (payload.kind === "modify") {
//     const tab = tabStore.findByPath(payload.path);
//     if (tab) await handleExternalModify(tab, payload.path);
//   }
// });
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| notify 6.x `DebouncedEvent` type | notify 8.x raw `Event` + `notify-debouncer-full` companion crate | notify 7.0 (breaking) | Must use `notify-debouncer-full`, not raw notify |
| `{#key activePath}` remounting CMEditor | Map of live EditorView instances, CSS show/hide | Phase 2 requirement | Preserves undo history across tab switches |
| Single-file `editorStore` | Multi-tab `tabStore` + narrowed `editorStore` | Phase 2 | `editorStore` now tracks per-active-tab CM6 state only |

**Deprecated / outdated:**
- `VaultView.svelte` flat file-list: **replaced entirely** by `VaultLayout.svelte` + `Sidebar` + `TabBar` + `EditorPane` components (per CONTEXT.md code context)
- `vaultStore.fileList: string[]`: needs to become tree-cache structure or be removed; tree data comes from lazy `list_directory` calls per folder expand

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `regex` crate needed for wiki-link count scan (D-16) | Code Examples / Commands | If D-20's locked crate list is exhaustive and regex is excluded, need alternative (e.g., `memchr` + hand-rolled `[[` scanner) |
| A2 | `rayon` needed for SYNC-04 batch parallelization | Standard Stack | If planner defers SYNC-04 to Phase 3 (search phase), rayon can be deferred too |
| A3 | `EditorView` instances stored in a `Map<tabId, EditorView>` in the component (not the store) | Architecture Patterns | If CM6 API changed re: multi-instance handling, research needed |
| A4 | `notify-debouncer-full` satisfies D-10's "notify v7+" requirement | Standard Stack | If user strictly requires `notify` 7.x (which doesn't exist as stable), clarification needed |
| A5 | VaultState watcher field type: `Mutex<Option<Debouncer<RecommendedWatcher>>>` | Architecture | Debouncer generic param may differ — check notify-debouncer-full docs at implementation time |

---

## Open Questions

1. **regex crate for wiki-link counting**
   - What we know: D-16 requires a simple regex scan `\[\[filename\]\]`; D-20's locked crate list doesn't include `regex`
   - What's unclear: Is D-20 an exhaustive list or a minimum list?
   - Recommendation: Treat D-20 as a minimum. Add `regex = "1"` — it is stable, has zero FFI, and is the idiomatic Rust choice. Flag in the plan for human acknowledgment.

2. **VaultState thread safety: Debouncer + Send**
   - What we know: `Debouncer<RecommendedWatcher>` may not be `Send`; `Mutex<Option<Debouncer<...>>>` wrapping should handle this
   - What's unclear: Exact Send/Sync bounds — notify 8.x documentation doesn't explicitly state this
   - Recommendation: Confirm at compile time in Wave 1. If not Send, store the watcher in a separate `Arc<Mutex<>>` thread_local or use a oneshot channel to drop it.

3. **Sidebar width persistence**
   - What we know: D-02 says "persisted in app settings, not vault-specific"
   - What's unclear: "App settings" means Tauri's app-data directory JSON — no settings store exists yet in Phase 1
   - Recommendation: In Phase 2, persist sidebar width in a new `settings.json` alongside `recent-vaults.json` in app-data dir. Create a minimal `settings.rs` command.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Rust toolchain | All Rust crates | ✓ | 1.77.2 (from Cargo.toml rust-version) | — |
| notify-debouncer-full | SYNC-01..05 | ✓ (to be added) | 0.7.0 on crates.io | — |
| similar | SYNC-06..07 | ✓ (to be added) | 3.1.0 on crates.io | — |
| rayon | SYNC-04 | ✓ (to be added) | 1.x on crates.io | — |
| Svelte writable stores | tabStore | ✓ | svelte 5.55.1 (installed) | — |
| HTML5 DnD API | FILE-05 drag-drop | ✓ | Browser API (Tauri WebView) | — |

**Missing dependencies with no fallback:** None — all dependencies are crates.io packages installable via Cargo.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Frontend framework | Vitest 4.1.4 + @testing-library/svelte 5.3.1 |
| Rust framework | cargo test (built-in) |
| Frontend config file | `vitest.config.ts` (exists) |
| Quick frontend run | `pnpm test` |
| Full suite | `pnpm test && cargo test --manifest-path src-tauri/Cargo.toml` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FILE-01 | list_directory returns sorted tree entries, hides dot-dirs | unit (Rust) | `cargo test list_directory` | ❌ Wave 0 |
| FILE-02 | create_file creates Unbenannt.md with auto-suffix | unit (Rust) | `cargo test create_file` | ❌ Wave 0 |
| FILE-03 | rename_file returns wiki-link count; no actual rename if count > 0 | unit (Rust) | `cargo test rename_file` | ❌ Wave 0 |
| FILE-04 | delete_file moves to .trash/ not permanent delete | unit (Rust) | `cargo test delete_file` | ❌ Wave 0 |
| FILE-05 | move_file moves file, updates path | unit (Rust) | `cargo test move_file` | ❌ Wave 0 |
| FILE-08 | list_directory marks symlinks, does not follow them | unit (Rust) | `cargo test list_directory_symlink` | ❌ Wave 0 |
| FILE-09 | Opening non-UTF-8 file shows toast (frontend) | component (Svelte) | `pnpm test -- --grep "non-UTF-8"` | ❌ Wave 0 |
| EDIT-05 | tabStore openTab, closeTab, cycleTab | unit (TS) | `pnpm test -- tabStore` | ❌ Wave 0 |
| EDIT-06 | tabStore splitToRight, closeSplit | unit (TS) | `pnpm test -- tabStore` | ❌ Wave 0 |
| SYNC-02 | WriteIgnoreList: records and expires entries | unit (Rust) | `cargo test write_ignore` | ❌ Wave 0 |
| SYNC-06/07 | three_way_merge: clean merge and conflict cases | unit (Rust) | `cargo test three_way_merge` | ❌ Wave 0 |
| IDX-07 | list_directory excludes .obsidian/ | unit (Rust) | `cargo test list_directory` (same as FILE-01) | ❌ Wave 0 |
| ERR-03 | Watcher error → vault_reachable = false → readonly toast | integration | manual | N/A |
| ERR-04 | DiskFull on write_file → toast, buffer preserved | unit (Rust) | `cargo test disk_full` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test && cargo test --manifest-path src-tauri/Cargo.toml`
- **Per wave merge:** Same (full suite is fast — unit tests only)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `src-tauri/src/tests/files_crud.rs` — covers FILE-01..05, FILE-08, IDX-07
- [ ] `src-tauri/src/tests/merge.rs` — covers SYNC-06, SYNC-07
- [ ] `src-tauri/src/tests/write_ignore.rs` — covers SYNC-02
- [ ] `tests/tabStore.test.ts` — covers EDIT-05, EDIT-06
- [ ] Framework already installed — no new framework install needed

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | yes | vault-scope guard (T-02) already in `ensure_inside_vault()` — must be applied to all new commands: create_file, rename_file, delete_file, move_file, list_directory |
| V5 Input Validation | yes | File/folder names validated: no `\0`, no path separators in name component; `.md` extension policy for new files |
| V6 Cryptography | no | — |

### Known Threat Patterns for Phase 2 Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via rename/move args | Tampering | `ensure_inside_vault()` canonicalize + starts_with check (already exists — must extend to all new commands) |
| Symlink escape: open symlinked file → reads outside vault | Info Disclosure | `list_directory` marks symlinks; `read_file` canonicalize check catches escape; `follow_links(false)` on walkdir |
| `.trash/` pollution: rename `../../../../etc/passwd` to `.trash/passwd` | Tampering | `ensure_inside_vault()` on destination path in `delete_file` |
| Watcher event injection (crafted filenames with `../`) | Tampering | All watcher-triggered file reads go through `read_file` which canonicalizes — safe |
| Toast flooding via external bulk changes | DoS (UI) | D-13 bulk-change threshold enforced in watcher callback |

---

## Project Constraints (from CLAUDE.md)

Directives from `./CLAUDE.md` that constrain all Phase 2 work:

- **Tech stack locked:** Tauri 2 + Rust backend, TypeScript + CodeMirror 6, `notify` for FS watching, Zustand-replaced-by-Svelte-stores, Tailwind for styling — no deviations
- **Performance guardrails (non-blocking but must not regress):** open note < 100ms, keystroke latency < 16ms, RAM idle < 100MB — Phase 2 UI additions (sidebar, tabs) must not break these
- **Zero network calls:** All Phase 2 Rust code must continue to make zero outbound network calls. Watcher is purely local IPC.
- **Zero telemetry:** No tracking code in watcher, merge, or file CRUD commands
- **Obsidian vault compatibility:** `.obsidian/` hidden (D-04/IDX-07); `.trash/` flat Obsidian convention (D-15); no corruption of vault-native files
- **Crash recovery:** Auto-save cadence unchanged at 2s; editor buffers must survive vault unmount (D-14/ERR-03) in memory
- **GSD workflow:** All file edits must go through a GSD execution phase — no ad-hoc edits outside planning artifacts

---

## Sources

### Primary (HIGH confidence)

- [VERIFIED: crates.io API 2026-04-12] — notify 8.2.0, notify-debouncer-full 0.7.0, similar 3.1.0 versions and publish dates confirmed
- [VERIFIED: docs.rs/notify-debouncer-full 0.7.0] — `new_debouncer()` signature, `DebouncedEvent` fields, debounce behavior
- [VERIFIED: docs.rs/similar 3.1.0] — confirmed NO built-in merge3/three-way merge; only diff primitives available
- [VERIFIED: codebase] — Phase 1 store patterns (commands.ts, events.ts, vaultStore.ts, toastStore.ts, progressStore.ts, lib.rs, error.rs, files.rs, vault.rs) all read directly

### Secondary (MEDIUM confidence)

- [CITED: docs.rs/notify/8.0.0/notify/event/enum.EventKind.html] — EventKind variants (Access, Create, Modify, Remove, Other)
- [CITED: threeway_merge 0.1.17 on crates.io] — alternative three-way merge crate noted but not recommended (FFI complexity vs. benefit)

### Tertiary (LOW confidence)

- [ASSUMED] — three_way_merge algorithm implementation using similar primitives (verified that similar has the needed diff ops; merge algorithm itself is derived logic)
- [ASSUMED] — rayon version and batch parallelism approach (standard Rust pattern; not verified against spec section beyond "rayon" mention in SYNC-04)

---

## Metadata

**Confidence breakdown:**
- Standard stack (crates): HIGH — versions confirmed against crates.io registry 2026-04-12
- Architecture patterns: HIGH — based on verified Phase 1 codebase + notify-debouncer-full docs
- Three-way merge algorithm: MEDIUM — similar confirmed to lack merge3; algorithm is standard but implementation is hand-rolled
- Pitfalls: HIGH — most derived from actual Phase 1 decisions and known notify/CM6 gotchas

**Research date:** 2026-04-12
**Valid until:** 2026-05-12 (stable crates; Svelte/Tauri fast-moving but Phase 2 uses no new frontend packages)
