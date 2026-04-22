#!/usr/bin/env python3
"""Validate Minerva JSON findings against a unified diff and build a GitHub
pull-request review payload. Findings that point at a file:line outside the
diff hunks are dropped from the inline set and listed in the review body
instead, so the reviewer always sees them even if the inline location is bad.

Inputs (paths, read):
  sys.argv[1]  unified diff (same bytes that were sent to the model)
  sys.argv[2]  model JSON output {verdict, findings:[{path,line,side,severity,body}]}
Env:
  COMMIT_ID    PR head SHA (required by the reviews API for inline comments)
Output (path, written):
  sys.argv[3]  JSON payload for POST /repos/:owner/:repo/pulls/:num/reviews
"""
from __future__ import annotations

import json
import os
import re
import sys


HUNK_RE = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def parse_diff_lines(diff: str) -> dict[str, dict[str, set[int]]]:
    """Return {path: {"RIGHT": {lines}, "LEFT": {lines}}} for every file in the diff."""
    files: dict[str, dict[str, set[int]]] = {}
    cur_path: str | None = None
    new_ln = old_ln = 0
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            cur_path = None
            continue
        if line.startswith("+++ "):
            p = line[4:].strip()
            if p.startswith("b/"):
                p = p[2:]
            cur_path = None if p == "/dev/null" else p
            if cur_path is not None:
                files.setdefault(cur_path, {"RIGHT": set(), "LEFT": set()})
            continue
        if cur_path is None:
            continue
        m = HUNK_RE.match(line)
        if m:
            old_ln = int(m.group(1))
            new_ln = int(m.group(2))
            continue
        if line.startswith("+") and not line.startswith("+++"):
            files[cur_path]["RIGHT"].add(new_ln)
            new_ln += 1
        elif line.startswith("-") and not line.startswith("---"):
            files[cur_path]["LEFT"].add(old_ln)
            old_ln += 1
        elif line.startswith(" "):
            files[cur_path]["RIGHT"].add(new_ln)
            files[cur_path]["LEFT"].add(old_ln)
            new_ln += 1
            old_ln += 1
    return files


def main() -> int:
    diff_path, review_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    with open(diff_path, "r", encoding="utf-8", errors="replace") as f:
        diff = f.read()
    with open(review_path, "r", encoding="utf-8") as f:
        review = json.load(f)

    valid = parse_diff_lines(diff)
    verdict = (review.get("verdict") or "").strip() or "No verdict provided."
    findings = review.get("findings") or []

    inline: list[dict] = []
    rejected: list[dict] = []
    for fi in findings:
        path = fi.get("path") or ""
        side = (fi.get("side") or "RIGHT").upper()
        if side not in ("LEFT", "RIGHT"):
            side = "RIGHT"
        try:
            line = int(fi.get("line"))
        except (TypeError, ValueError):
            rejected.append(fi)
            continue
        body = (fi.get("body") or "").strip()
        sev = (fi.get("severity") or "").strip()
        if not path or not body:
            rejected.append(fi)
            continue
        sides = valid.get(path)
        if not sides or line not in sides.get(side, set()):
            rejected.append(fi)
            continue
        prefix = f"**[{sev}]** " if sev else ""
        inline.append({"path": path, "line": line, "side": side, "body": prefix + body})

    body_parts = ["### Minerva Review (GLM 5.1)", "", verdict]
    if rejected:
        body_parts += [
            "",
            "<details><summary>Findings without a valid diff location (could not be placed inline)</summary>",
            "",
        ]
        for fi in rejected:
            p = fi.get("path", "?")
            ln = fi.get("line", "?")
            sev = fi.get("severity", "")
            b = (fi.get("body") or "").strip()
            tag = f"[{sev}] " if sev else ""
            body_parts.append(f"- `{p}:{ln}` — {tag}{b}")
        body_parts += ["", "</details>"]
    if not inline and not rejected:
        body_parts += ["", "_No issues flagged._"]

    payload = {
        "commit_id": os.environ["COMMIT_ID"],
        "body": "\n".join(body_parts),
        "event": "COMMENT",
        "comments": inline,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    print(f"inline={len(inline)} rejected={len(rejected)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
