#!/usr/bin/env bash
# run-benchmarks.sh — #207 benchmark harness runner.
#
# Runs the `#[ignore]`-gated benches in release mode with the `embeddings`
# feature enabled, parses the `BENCH_JSON {...}` lines they emit on stderr,
# and writes a combined JSON document to the target path (default:
# `src-tauri/benches/latest.json`).
#
# The benches themselves live next to the code they measure:
#   - service.rs            bench_single_embed_p50_p99       → "single_embed"
#   - query.rs              bench_semantic_query_p50_under_5ms → "semantic_search_100k"
#   - reindex.rs            bench_reindex_throughput         → "reindex_throughput"
#   - hybrid.rs             bench_rrf_fuse_p50_p99           → "rrf_fuse"
#
# Usage:
#   scripts/run-benchmarks.sh                         # writes src-tauri/benches/latest.json
#   scripts/run-benchmarks.sh path/to/out.json        # custom output path
#   BENCH_FILTER="single_embed|rrf_fuse" scripts/run-benchmarks.sh  # subset
#
# Env overrides:
#   CARGO           cargo binary (default: cargo)
#   BENCH_FEATURES  feature list (default: embeddings)
#   BENCH_FILTER    test-name regex passed to cargo test (default: bench_)

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_path="${1:-$repo_root/src-tauri/benches/latest.json}"

cargo_bin="${CARGO:-cargo}"
features="${BENCH_FEATURES:-embeddings}"
filter="${BENCH_FILTER:-bench_}"

tmp_out="$(mktemp)"
trap 'rm -f "$tmp_out"' EXIT

echo "[bench] cargo test --release --features $features -- --ignored --nocapture $filter" >&2
(
  cd "$repo_root/src-tauri"
  # stderr carries the BENCH_JSON lines (eprintln!); merge to stdout for capture.
  "$cargo_bin" test --release --features "$features" --tests -- \
    --ignored --nocapture --test-threads=1 "$filter" 2>&1
) | tee "$tmp_out"

# Collect every BENCH_JSON {...} record. cargo test sometimes prepends
# `test ... ok BENCH_JSON {...}` onto the same line when eprintln! is the last
# line a test emits, so we match `BENCH_JSON {...}` anywhere, not just at BOL.
# The grep -o emits one record per line (non-greedy via perl regex).
entries="$(grep -oE 'BENCH_JSON \{[^}]*\}' "$tmp_out" | sed -E 's/^BENCH_JSON //' || true)"

if [ -z "$entries" ]; then
  echo "[bench] no BENCH_JSON lines emitted — did any #[ignore] benches run?" >&2
  exit 2
fi

mkdir -p "$(dirname "$out_path")"

# Build the combined document with jq: wrap the per-bench objects in an array
# under `results`, plus a timestamp + git SHA for provenance.
git_sha="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

printf '%s\n' "$entries" \
  | jq -s --arg sha "$git_sha" --arg ts "$timestamp" \
      '{timestamp: $ts, git_sha: $sha, results: .}' \
  > "$out_path"

echo "[bench] wrote $out_path" >&2
cat "$out_path"
