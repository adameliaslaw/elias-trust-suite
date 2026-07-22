# Contributing — working conventions

This repo is remediated in **phases**, each run in a fresh session (see
[docs/HOMEWORK.md](docs/HOMEWORK.md)). To let that progress land without a human waiting up, the
repo uses an **auto-merge convention**. Read this before opening a PR.

## Auto-merge convention

Every phase / critical-fix PR **enables squash auto-merge** on itself. GitHub then merges it into
`main` automatically **once the required `test` check passes** — no manual merge, no waiting on the
owner. The session opens its PR, enables auto-merge, and ends; the merge happens when CI goes green.

How a session enables it (via the GitHub MCP tool, right after opening the PR):

- `enable_pr_auto_merge` with `mergeMethod: SQUASH`.
- This **fails gracefully** (no-op) if the repo prerequisites below aren't set — it never
  force-merges.

### One-time owner setup (only the repo owner can do this — not scriptable here)

Auto-merge does nothing until these two settings exist. Flip them once:

1. **Allow auto-merge** — Settings → General → Pull Requests → check *"Allow auto-merge"*.
2. **Branch protection on `main`** — Settings → Branches → Add rule for `main`:
   - Require status checks to pass → select **`test`** (the CI job in `.github/workflows/ci.yml`).
   - Require branches to be up to date before merging.
   - (Recommended) Require linear history; squash-only merges; auto-delete head branches.

Without #2 there is no required check for auto-merge to wait on, so a PR would either not
auto-merge or merge with nothing gating it. The `test` check is the gate.

## Safety rules (why "green" is not a blank check here)

The current CI runs unit/smoke tests that **do not exercise the critical paths** documented in
[docs/EVALUATION.md](docs/EVALUATION.md) (PDF import, reconciliation model, audit completeness,
Matterproof billing). Overnight auto-merge therefore means *merge-on-green*, not *merge-on-correct*.
To keep that safe:

- **Test-first for criticals.** Add a test that reproduces the defect **before** the fix (Phase 1,
  #20). A critical is not "done" until a test would fail without the fix.
- **Never weaken the signal to go green.** Do not delete, skip, or loosen a test to pass CI. The
  flaky billable audit test is fixed as the very first Phase 1 item precisely so green means green.
- **If CI can't cover the risk, don't auto-merge it.** For a change whose correctness the test suite
  can't verify (schema/data migrations, security, money-at-rest, anything touching trust funds),
  **leave auto-merge off** (or open as draft) and request human review instead. Use judgment: the
  convention is for the mechanical, well-tested majority — not a licence to land unverifiable
  changes unwatched.
- **One PR per phase (or per critical if large).** Reference the issue (`Fixes #NN`). Ready for
  review, not draft (unless deliberately held for review per the rule above).
- **Fail-safe direction only.** A flaky/failed check must *block* the merge; nothing in this
  convention bypasses a red check.

## Everything else

Branch/commit/test conventions and the end-of-session ritual live in
[docs/HOMEWORK.md](docs/HOMEWORK.md). Money goes through `@elias/money`; compliance events through
`@elias/audit`. Don't regress the "already good" list in
[docs/CONSOLIDATION_PLAN.md](docs/CONSOLIDATION_PLAN.md).
