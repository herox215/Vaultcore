#!/usr/bin/env python3
"""bench-regression.py — #207 guard that fails CI on >10% slowdown.

Compares a fresh benchmark run (as produced by `scripts/run-benchmarks.sh`)
against a committed baseline and exits non-zero when any tracked metric
regresses beyond the configured threshold.

Metric handling:
  - Latency fields (*_ms): regression = new > baseline * (1 + threshold).
  - Throughput fields (files_per_sec): regression = new < baseline * (1 - threshold).
  - Metrics missing from the new run → hard fail (a bench disappeared).
  - Metrics in the new run but not in the baseline → warn but don't fail
    (so adding a bench is not itself a regression).

Usage:
  scripts/bench-regression.py              # compares latest.json vs baseline.json
  scripts/bench-regression.py new.json baseline.json
  BENCH_THRESHOLD=0.15 scripts/bench-regression.py  # 15% instead of 10%
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_NEW = REPO_ROOT / "src-tauri" / "benches" / "latest.json"
DEFAULT_BASELINE = REPO_ROOT / "src-tauri" / "benches" / "baseline.json"

# Per AC #3: >10% slowdown must fail the job.
THRESHOLD = float(os.environ.get("BENCH_THRESHOLD", "0.10"))

# (metric_name, direction) — "lower" means smaller is better (latency),
# "higher" means larger is better (throughput). Driven by the `name` field
# the benches emit, not by file layout.
TRACKED: dict[str, dict[str, str]] = {
    "single_embed":         {"p50_ms": "lower", "p99_ms": "lower"},
    "semantic_search_100k": {"p50_ms": "lower", "p99_ms": "lower"},
    "reindex_throughput":   {"files_per_sec": "higher"},
    "rrf_fuse":             {"p50_ms": "lower", "p99_ms": "lower"},
}


def load(path: Path) -> dict[str, dict]:
    with path.open() as fh:
        doc = json.load(fh)
    return {entry["name"]: entry for entry in doc.get("results", [])}


def compare(new: dict[str, dict], baseline: dict[str, dict]) -> list[str]:
    failures: list[str] = []
    for name, fields in TRACKED.items():
        if name not in new:
            failures.append(f"[MISSING] bench `{name}` did not appear in new run")
            continue
        if name not in baseline:
            print(f"[warn] bench `{name}` has no baseline entry — skipping")
            continue
        for field, direction in fields.items():
            if field not in new[name] or field not in baseline[name]:
                failures.append(
                    f"[MISSING FIELD] `{name}.{field}` absent "
                    f"(new={field in new[name]}, baseline={field in baseline[name]})"
                )
                continue
            n = float(new[name][field])
            b = float(baseline[name][field])
            if direction == "lower":
                budget = b * (1 + THRESHOLD)
                regressed = n > budget
                delta_pct = (n - b) / b * 100.0 if b else 0.0
            else:
                budget = b * (1 - THRESHOLD)
                regressed = n < budget
                delta_pct = (n - b) / b * 100.0 if b else 0.0
            status = "FAIL" if regressed else "ok"
            print(
                f"[{status}] {name}.{field}: baseline={b:.4f} "
                f"new={n:.4f} ({delta_pct:+.1f}%, budget={budget:.4f}, {direction})"
            )
            if regressed:
                failures.append(
                    f"{name}.{field} regressed {delta_pct:+.1f}% "
                    f"(baseline={b:.4f}, new={n:.4f}, threshold={THRESHOLD * 100:.0f}%)"
                )
    return failures


def main() -> int:
    new_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_NEW
    base_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_BASELINE

    if not new_path.exists():
        print(f"error: new results file not found: {new_path}", file=sys.stderr)
        return 2
    if not base_path.exists():
        print(f"error: baseline file not found: {base_path}", file=sys.stderr)
        return 2

    new = load(new_path)
    baseline = load(base_path)

    print(f"[bench-regression] threshold={THRESHOLD * 100:.0f}%")
    print(f"[bench-regression] new={new_path}")
    print(f"[bench-regression] baseline={base_path}")
    print()

    failures = compare(new, baseline)

    print()
    if failures:
        print(f"[bench-regression] {len(failures)} regression(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("[bench-regression] no regressions above threshold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
