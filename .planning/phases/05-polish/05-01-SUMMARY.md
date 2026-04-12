---
phase: 05-polish
plan: 01
subsystem: backend/ipc
tags: [rust, typescript, tags, tantivy, tauri, ipc, regex, serde_yml, tdd]

# Dependency graph
requires:
  - phase: 05-polish/05-00
    provides: serde_yml 0.0.12 in Cargo.toml (YAML frontmatter parsing)
  - phase: 04-links
    provides: IndexCoordinator + Arc<Mutex<LinkGraph>> pattern (architectural template)

provides:
  - TagIndex Rust module with extract_inline_tags + extract_yaml_tags (TAG-01, TAG-02)
  - TagIndex integrated into IndexCoordinator with cold-start population (TAG-03)
  - IndexCmd::UpdateTags + RemoveTags variants + run_queue_consumer match arms
  - dispatch_tag_index_cmd watcher function (incremental updates on create/modify/delete)
  - list_tags + get_tag_occurrences Tauri commands registered in invoke_handler
  - TagUsage + TagOccurrence TypeScript interfaces mirroring Rust structs (camelCase)
  - listTags() + getTagOccurrences() IPC wrappers in src/ipc/commands.ts

affects:
  - 05-07 (tag panel UI — consumes listTags() and getTagOccurrences() IPC)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "OnceLock<Regex> for compiled inline-tag regex (mirrors link_graph.rs pattern)"
    - "Fast-path content.contains('#') before regex scan (mirrors link_graph.rs)"
    - "Per-file deduplication: same tag in one file counts once (by_file HashMap)"
    - "Drop-before-lock pattern in Tauri commands: release coord_guard before ti.lock()"
    - "pub(crate) dispatch fn in watcher.rs for unit-test access (mirrors is_hidden_path)"
    - "serde rename_all=camelCase on TagUsage + TagOccurrence for frontend camelCase"

key-files:
  created:
    - src-tauri/src/indexer/tag_index.rs
    - src-tauri/src/commands/tags.rs
    - src-tauri/src/tests/tag_index.rs
    - src/types/tags.ts
  modified:
    - src-tauri/src/indexer/mod.rs (tag_index module + IndexCmd variants + IndexCoordinator field + cold-start)
    - src-tauri/src/commands/mod.rs (pub mod tags)
    - src-tauri/src/lib.rs (invoke_handler registration)
    - src-tauri/src/watcher.rs (dispatch_tag_index_cmd + process_events call)
    - src-tauri/src/tests/mod.rs (pub mod tag_index)
    - src/ipc/commands.ts (TagUsage/TagOccurrence import + listTags + getTagOccurrences)

key-decisions:
  - "TagIndex per-file deduplication: by_file HashMap<String, Vec<String>> stores which tags a file has, enabling O(tags_per_file) removal without full scan"
  - "DebouncedEvent construction in tests uses Event { kind, paths, attrs } + DebouncedEvent::new() — struct fields differ from what plan docs implied (Deref wraps Event)"
  - "map_or(false, ...) replaced with is_some_and() in dispatch functions; std::io::Error::other() used instead of Error::new(ErrorKind::Other, ...) per clippy --lib -D warnings"

requirements-completed: [TAG-01, TAG-02, TAG-03]

# Metrics
duration: 12min
completed: 2026-04-12
---

# Phase 5 Plan 01: TagIndex Rust Backend + IPC Summary

**Complete Rust tag-indexing pipeline: TagIndex with inline #tag + YAML frontmatter extraction, IndexCoordinator integration, watcher dispatch, Tauri IPC commands, TypeScript types, and IPC wrappers — 15 tests green**

## Performance

- **Duration:** 12 min
- **Started:** 2026-04-12T20:45:23Z
- **Completed:** 2026-04-12T20:57:23Z
- **Tasks:** 2
- **Files modified/created:** 10

## Accomplishments

- `tag_index.rs` created as full architectural clone of `link_graph.rs`: OnceLock regex, `extract_inline_tags` (letter-leading, case-fold, dedup), `extract_yaml_tags` (serde_yml list/scalar/absent), `TagIndex::update_file/remove_file/list_tags/get_occurrences`
- `TagUsage` and `TagOccurrence` structs with `serde rename_all=camelCase` for clean IPC serialization
- `IndexCoordinator` extended with `tag_index: Arc<Mutex<TagIndex>>`, `tag_index()` getter, and cold-start population loop in `index_vault`
- `IndexCmd::UpdateTags` and `IndexCmd::RemoveTags` variants added with matching arms in `run_queue_consumer`
- `dispatch_tag_index_cmd` added to `watcher.rs` (pub(crate)), called alongside `dispatch_link_graph_cmd` in `process_events`
- `commands/tags.rs` provides `list_tags` and `get_tag_occurrences` Tauri commands; both registered in `lib.rs` invoke_handler
- `src/types/tags.ts` exports `TagUsage` and `TagOccurrence` with camelCase fields mirroring Rust
- `listTags()` and `getTagOccurrences()` IPC wrappers added to `src/ipc/commands.ts` following established `normalizeError(e)` pattern
- 15 unit tests: 11 covering extraction + TagIndex operations, 4 covering watcher dispatch + serde shape

## Task Commits

Each task committed atomically:

1. **Task 1: TagIndex + IndexCoordinator wiring** — `413a8a0` (feat)
2. **Task 2: Watcher + commands + TS types + IPC** — `f6c87bc` (feat)

## Files Created/Modified

- `src-tauri/src/indexer/tag_index.rs` (created) — TagIndex struct, extract functions, TagUsage/TagOccurrence structs
- `src-tauri/src/indexer/mod.rs` — pub mod tag_index, use TagIndex, UpdateTags/RemoveTags variants, IndexCoordinator field + getter, cold-start loop, run_queue_consumer match arms
- `src-tauri/src/tests/tag_index.rs` (created) — 15 unit tests
- `src-tauri/src/tests/mod.rs` — pub mod tag_index
- `src-tauri/src/commands/tags.rs` (created) — list_tags + get_tag_occurrences Tauri commands
- `src-tauri/src/commands/mod.rs` — pub mod tags
- `src-tauri/src/lib.rs` — invoke_handler registration for both commands
- `src-tauri/src/watcher.rs` — dispatch_tag_index_cmd function + call in process_events
- `src/types/tags.ts` (created) — TagUsage + TagOccurrence TS interfaces
- `src/ipc/commands.ts` — import + listTags() + getTagOccurrences() wrappers

## Decisions Made

- **Per-file deduplication via by_file map:** `TagIndex` stores `by_file: HashMap<String, Vec<String>>` to enable O(tags_per_file) removal and guarantees one-count-per-file semantics regardless of how many times a tag appears inline.
- **DebouncedEvent construction in tests:** The `DebouncedEvent` struct in `notify-debouncer-full` wraps an inner `notify::Event` via `Deref`. Tests construct it as `DebouncedEvent::new(Event { kind, paths, attrs: Default::default() }, Instant::now())`.
- **Clippy compliance:** `map_or(false, ...)` → `is_some_and()`, `std::io::Error::new(ErrorKind::Other, msg)` → `std::io::Error::other(msg)` in new code; pre-existing violations in lib.rs/watcher.rs left intact (out-of-scope per deviation rules).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed DebouncedEvent test construction**
- **Found during:** Task 2 — first test compile
- **Issue:** Plan template for `make_debounced_event` used `DebouncedEvent { kind, paths, attr: None }` struct literal, but the actual crate struct has `event: Event` and `time: Instant` fields (with `Deref` to `Event` for field access). Direct struct literal failed.
- **Fix:** Replaced with `DebouncedEvent::new(Event { kind, paths, attrs: Default::default() }, Instant::now())`
- **Files modified:** `src-tauri/src/tests/tag_index.rs`
- **Commit:** f6c87bc

**2. [Rule 1 - Bug] Fixed three clippy::unnecessary_map_or + io_other_error warnings in new code**
- **Found during:** Task 2 — clippy check of new files
- **Issue:** `new_path.extension().map_or(false, |ext| ...)` flagged as `unnecessary_map_or`; `std::io::Error::new(ErrorKind::Other, msg)` flagged as `io_other_error` in tags.rs
- **Fix:** `map_or(false, ...)` → `is_some_and(...)` in both watcher dispatch functions; `io::Error::new(ErrorKind::Other, ...)` → `io::Error::other(...)` in tags.rs
- **Files modified:** `src-tauri/src/watcher.rs`, `src-tauri/src/commands/tags.rs`
- **Commit:** f6c87bc (same commit — caught before committing Task 2)

---

**Total deviations:** 2 auto-fixed (Rule 1 bugs — incorrect API usage in tests, clippy in new code)
**Impact on plan:** No scope change. Both fixes are correctness improvements and were resolved before committing.

## Known Stubs

None — this plan delivers the data layer only; no UI components with placeholder data.

## Threat Flags

No new threat surface beyond what is documented in the plan's threat model. All `mitigate` dispositions are implemented:
- T-05-01-01 (serde_yml DoS): `from_str` returns `Err` on malformed YAML → `[]` (Tests 8, 9)
- T-05-01-02 (regex ReDoS): DFA-based regex crate, linear-time guaranteed
- T-05-01-04 (watcher channel full): `try_send` drops — same as link_graph.rs

## Self-Check

---

## Self-Check: PASSED

Files exist:
- src-tauri/src/indexer/tag_index.rs: FOUND
- src-tauri/src/commands/tags.rs: FOUND
- src-tauri/src/tests/tag_index.rs: FOUND
- src/types/tags.ts: FOUND

Commits exist:
- 413a8a0: FOUND (Task 1)
- f6c87bc: FOUND (Task 2)

Tests: 15 passed, 0 failed
cargo check: exit 0
tsc --noEmit: no new errors (pre-existing tabStore errors unchanged)
