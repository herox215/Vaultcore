# Benchmarks

Reproducible, regression-gated benchmarks for the perf-critical paths in
VaultCore's semantic search stack. Covers issue [#207](https://github.com/herox215/vaultcore/issues/207).

## What's measured

The `#[ignore]`-gated benches live next to the code they exercise and each
emits a single `BENCH_JSON {...}` line so the harness can collect them
without a coupled Criterion or custom bench crate.

| Name                   | Source                                      | What it measures                                                                   |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `single_embed`         | `src/embeddings/service.rs`                 | End-to-end text → 384-d vector latency through `EmbeddingService::embed`.         |
| `semantic_search_100k` | `src/embeddings/query.rs`                   | Embed + HNSW query against a 100 000-vector index, k=10 ef_search=64.             |
| `reindex_throughput`   | `src/embeddings/reindex.rs`                 | Files-per-second through the full reindex pipeline (reader → chunker → embed → sink). |
| `rrf_fuse`             | `src/embeddings/hybrid.rs`                  | Pure-math RRF fusion cost at hybrid-search's top_n=200 per leg.                   |

The spec targets they defend are in `CLAUDE.md` — keep this table in sync if
that file moves.

## How to run

```bash
# Full suite. ~2 min on reference hardware (single_embed is ~5 s; 100k index
# build is the slow part at ~90 s; reindex is 12 s; rrf_fuse is negligible).
scripts/run-benchmarks.sh

# Write to a custom path (default: src-tauri/benches/latest.json):
scripts/run-benchmarks.sh /tmp/my-run.json

# Subset via regex filter:
BENCH_FILTER="single_embed|rrf_fuse" scripts/run-benchmarks.sh

# Bigger reindex (2000 files, ~2 min) — linear-extrapolates to 100k:
LARGE_REINDEX_BENCH=1 scripts/run-benchmarks.sh
```

The script shells out to `cargo test --release --features embeddings --
--ignored --nocapture --test-threads=1` with a `bench_` test-name filter. The
`--test-threads=1` is load-bearing: the embed bench and the 100k-query bench
both load the MiniLM model and compete for the ORT global thread pool
(capped at intra=2/inter=1 per #197).

## Regression gate (>10 %)

```bash
# After run-benchmarks.sh has produced latest.json:
scripts/bench-regression.py

# Custom threshold (0.15 = 15 %):
BENCH_THRESHOLD=0.15 scripts/bench-regression.py

# Explicit paths:
scripts/bench-regression.py my-run.json my-baseline.json
```

Exits `1` with a per-metric FAIL line when any tracked field regresses more
than `BENCH_THRESHOLD` against `src-tauri/benches/baseline.json`. Direction
is inferred per field: latencies (`*_ms`) are "lower is better", throughput
(`files_per_sec`) is "higher is better".

A missing metric in the new run is a hard fail (bench disappeared). A new
metric without a baseline entry is a warn-only (adding a bench is not a
regression).

## Baseline

`src-tauri/benches/baseline.json` holds reference numbers captured on:

- CPU: 13th Gen Intel Core i7-13700H (20 cores)
- RAM: 32 GiB
- OS: Linux 6.19.9-1-cachyos (x86_64)
- Git SHA: c6ae94a (post-#205)

Values are rounded with a small noise margin — p99 in particular varies run
to run by up to 2× on shared hardware, so the committed baseline sits above
the median observed run.

### Updating the baseline

Pick the lowest-noise run you can (no compiles in parallel, no browser open,
AC plugged in on laptops), then:

```bash
scripts/run-benchmarks.sh src-tauri/benches/baseline.json
# edit the JSON: add the hardware block, round p99 upward ~20 % to absorb noise,
# round throughput downward ~10 %.
```

Commit baseline changes in a dedicated PR with the reference-hardware specs
in the commit message. Never update the baseline in the same PR as a perf
change — reviewers need to see the delta against the prior line in the diff.

## CI integration

Currently not wired into CI (no `.github/workflows/*` in this repo yet).
Recommended shape when added:

- `workflow_dispatch` + scheduled nightly, **not** blocking per-PR CI — the
  full run costs ~2 min on cold-cache hosted runners and variance makes
  per-PR gating brittle.
- Upload `latest.json` as an artifact, diff against `baseline.json` via
  `bench-regression.py`, fail the job on non-zero exit.
- For per-PR perf signal, run only the fast benches (`single_embed`,
  `rrf_fuse`) with a relaxed 25 % threshold and record the numbers in the
  PR body.
