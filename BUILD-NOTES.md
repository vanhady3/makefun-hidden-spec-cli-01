# hidden-spec-cli-01 — build notes

## Scores
- Practice: **1000/1000** (100 of 100 checks, `node check.ts <kit>/program/generator/practice.json`)
- Strict exact-match-only baseline (tier 0 forced, in /tmp/strict-baseline): **750/1000** (75 of 100)
- Margin over the house-style strict applier: **+250**. The 25 checks the strict variant loses are the
  fuzzy-matching ones (trailing-whitespace, indentation drift, V4A cursor/anchor, CRLF) — exactly the edge
  this entry is built for.

## Score progression
- First full run after writing main.ts: 1000/1000 (no iteration needed on the practice set).
- Two what-if variants (also 1000): (a) strict baseline 750; (b) dropping trailing space-only lines
  from hunk bodies as well as empty lines — practice does not distinguish, kept the literal reading
  (drop only truly empty lines).

## Implementation (main.ts, 954 lines, 32,915 bytes, Node stdlib only)
- Kept the kit starter's sections 1-4, 9, 10 (CLI, output/exit codes, safe paths, format detection,
  JSON edits, atomicity) and its trial hand-over to runner.ts; runner.ts untouched.
- Wrote sections 5-8 from SPEC.md:
  - §5 three-tier matching (exact / trailing-trim / both-trim), tier-2 re-indentation with F/P
    (including the P-empty case, which prepends F — confirmed by v-indent 6b3a9d6e).
  - §6 unified: sections from `diff --git` or `--- `+`+++ `, header parsing (rename from/to, new/deleted
    file mode, diff --git fallback), hunk headers, nearest-occurrence choice with drift offset d,
    empty-O insertion, `\ No newline` final-break rule, create/delete/move/change.
  - §7 SEARCH/REPLACE: path = nearest non-blank non-fence line before SEARCH (else previous block's
    path), marker matching on trailing whitespace only, create-on-empty-old, exactly-once else ambiguous.
  - §8 V4A: Begin/End Patch framing with exact parse line numbers, Add/Delete/Update sections,
    Move to, `@@` anchors, cursor advancing, end-of-file chunks, trailing blank lines dropped.
  - Output: `R old -> new` lines (sorted by new path) replacing the D/A pair when the move's
    end-state conditions hold; chained moves fall back to D + A.
- Extra checks run by hand (all pass): move chains, move-then-change/delete, pure V4A move,
  `--check` with a move, creation/insertion with `\ No newline`, CRLF preservation (verified byte-wise),
  V4A anchor at tier 1, diff --git-only rename, usage-wins-over-no-patch, SR path reuse.
- Trial hand-over smoke-tested against a local HTTP env: 1 check posted, correct exit/stdout/files.
- Perf: 4000-line file, 20 hunks with wrong line numbers: 0.28s (limit 10s per check).

## Known gaps / judgement calls (hidden checks test sentences practice does not show)
- Hunk bodies: trailing *empty* (`''`) lines are dropped; trailing space-only (`' '`) context lines are
  kept — the literal reading of "empty lines". Both variants score 1000 on practice.
- A `*** End of File` with no open chunk, and a body line after a chunk was closed by End of File, are
  `error: parse <its line>`.
- A `--- ` line in a section header not followed by `+++ ` is `error: parse <the line after it>`.
- Creation hunks contribute only their `+` lines, per §6.
- A section with no hunks is still one edit (existence checks apply, no content change).

## Authorship
- main.ts written fresh from SPEC.md in this session with the file-write tool; no reference
  implementation was read (draw.mjs, server.mjs, score.mjs, harness/ never opened).

## Hardening 23 Nov 2026 (resubmission)
- Adversarial probe: 237 SPEC-derived cases, 224 pass, 9 real gaps found (3 root
  causes), all outside the practice set.
- Fix 1 (§10 safety order): a V4A Update now checks its `Move to` path's safety
  before the source-missing check (before, a missing source reported `missing`
  even when the move target was unsafe).
- Fix 2 (§10 safety): a unified creation now safety-checks its resolved old
  path (unless `/dev/null`), and a unified deletion its resolved new path
  (unless `/dev/null`); before, each checked only one path.
- Fix 3 (§2 `exists`): a target path that exists as a directory is now
  `exists`, not an uncaught EISDIR crash — new `Tree.present()` (a file the
  tree holds, or anything on disk including directories). Change, delete or
  move-from on a directory path still correctly report `missing`.
- Re-verified after the fixes: practice 100/100 (1000); adversarial harness
  233/237 pass, 0 failed, 4 observe-only (SPEC-silent cases, unchanged).

## Round-2 adversarial probe 24 Nov 2026 (resubmission 3)
- Probe: 173 NEW SPEC-derived cases (round 1's 237 not repeated), fresh angles: write-phase
  parent/file conflicts, JSON tool-call edges (overlapping str_replace, CRLF conversion,
  insert bounds, array/JSONL faults), V4A cursor/EOF corners, unified `\` and drift edges,
  CRLF/mixed endings, empty-file edges, unicode/sorting, CLI invocation, atomicity.
- Result: 166 pass, 0 failed, 7 observe-only (SPEC-silent, unchanged).
- 1 REAL gap, 1 root cause — write phase (§10): the write loop iterated `tree.now`
  keys in insertion order, so a child was written before its parent file was deleted
  and `mkdirSync` threw (uncaught crash, exit 1, empty stdout, partial writes).
  Cases: create a/b then delete a; V4A move a -> a/b; create a/b/c then delete a/b;
  V4A move a/b -> a/b/c. All four are representable final trees, so §10 implies exit 0.
- Fix (fresh writing, main.ts run() write phase only): deletions first, then creations/
  changes; pre-validate writes whose ancestor stays a file in the final tree and fail
  the run cleanly (exit 1, empty stdout, nothing written) instead of crashing mid-write.
- V4A move-to-self resolved as CORRECT, not a gap: `error: exists f` (§8: the new path
  exists, so the edit fails with `exists`).
- Observe-only, SPEC-silent, unchanged: negative A+d insert clamps to 0; a `\` line as
  the first hunk body line is ignored; a malformed `@@` in a deletion section is
  `error: parse <its line>`; a duplicate `+++` retargets (last wins); an impossible
  final tree (create a/b while a stays a file) fails cleanly with nothing written.
- Re-verified after the fix: practice 100/100 (1000); probe 166/166 pass, 0 failed.
- Probe harness: /tmp/adv-probe2/probe.ts (173 cases, expectations hand-derived from SPEC.md).
