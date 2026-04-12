# Deferred Items — Phase 05 Polish

## Out-of-scope pre-existing clippy warnings (discovered during Plan 00)

These warnings existed before Plan 00 execution and are in files not modified by this plan.
They should be addressed in a dedicated cleanup task.

### src/commands/vault.rs
- `unnecessary_map_or`: Multiple `.map_or(false, ...)` calls should use `.is_some_and()`
- `io_other_error`: Multiple `std::io::Error::new(ErrorKind::Other, ...)` should use `std::io::Error::other()`

### src/commands/tree.rs (pre-existing, not introduced by Plan 00)
- Line 48: `io_other_error` — `std::io::Error::new(ErrorKind::Other, "internal state lock poisoned")`
- Line 104: `unnecessary_map_or` — `.map_or(false, |ext| ext.eq_ignore_ascii_case("md"))`

### src/watcher.rs
- `io_other_error`: Multiple occurrences
- `unnecessary_map_or`: Line 304

### src/indexer/tantivy_index.rs
- `io_other_error`: Line 96

### src/indexer/mod.rs
- `io_other_error`: Multiple occurrences
- `collapsible_if`: Line 113
- `unnecessary_map_or`: Line 443

### src/lib.rs
- `derivable_impls`: Line 25 — `WriteIgnoreList` Default impl can be derived

