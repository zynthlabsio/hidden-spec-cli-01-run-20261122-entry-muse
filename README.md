# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zynthlabsio/hidden-spec-cli-01-run-20261122-entry-muse/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zynthlabsio/hidden-spec-cli-01-run-20261122-entry-muse/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats: a unified
diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
`mend` reads each format as `SPEC.md` says, and every file is changed or nothing is.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the tree); absent or `-` reads standard input.
- `--format=NAME` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, detected per SPEC.md section 4).
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only); otherwise matching falls back through trailing-whitespace and
  indentation tiers (SPEC.md section 5), with unified hunks choosing the occurrence nearest their stated line numbers.

Exit codes: 0 on success (one `A`/`D`/`M`/`R` line per changed path, then `ok: <n> files`), 1 when any edit failed
(one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`; nothing is written), 2 for usage,
missing-patch, format and parse errors (a single `error: ...` line).

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone, implementing SPEC.md in full.
- `runner.ts`: the kit's trial runner (kept as-is); `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts`: runs the public practice set on your own machine:

      node check.ts <practice.json>

- `SPEC.md`: the specification this entry implements.
- `LICENSE`: MIT.
