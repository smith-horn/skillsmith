# Wave 4 Governance Review — packages/skillsmith-cli Code Health Audit

**Date:** 2026-09-02
**Reviewer:** governance-specialist (docs-only review)
**Scope:** Wave 4 code-health audit artifacts for `packages/skillsmith-cli`
**Verdict:** PASS

Artifacts reviewed:
- `2026-09-02-030947-skillsmith-cli-scan-repo.md`
- `2026-09-02-030947-skillsmith-cli-scan-repo.json`
- `2026-09-02-031006-packages-skillsmith-cli-code-health.md`
- `2026-09-02-skillsmith-cli-triage.md`

---

## Check Results

### 1. Artifact filename consistency — PASS

- Scan MD / JSON share the `030947` timestamp; both embed `generated_at`/`Generated` of `2026-09-02T03:09:47Z` (JSON: `...:47.386Z`). Consistent.
- Verify report timestamp `031006` matches its `Generated: 2026-09-02T03:10:06.601Z` header, and is ~19s after the scan — plausible sequential ordering.
- Scope strings correct: all files reference `skillsmith-cli` / `packages/skillsmith-cli`. The verify report filename uses the `packages-skillsmith-cli` prefix convention (mode=package), which matches its content scope.
- Triage's Scan-artifacts table paths all resolve to the three sibling files. Consistent.

### 2. Bucket-count reconciliation — PASS

Cross-checked three sources; all agree:
- **JSON**: `candidates: [1 entry]`, `looks_bad_but_fine: []` → 1 candidate, 0 FP tags.
- **Scan MD**: "Candidates: 1, Looks-bad-but-fine tags: 0". Matches.
- **Verify MD**: Consolidation candidate (1), all other buckets 0 (Safe-to-delete 0, Runtime-verification 0, Suppressed 0, Stale 0, Scan failures 0).
- **Triage**: B1=0, B2=1, B4=0, total 1; arithmetic `0+1+0=1` stated explicitly and correct.

The single candidate lands in B2 (Consolidation) in both verify and triage. No drift.

### 3. Bucket-1-absence rationale — PASS

Triage "Why no Bucket 1 items" states: EXPERIMENTAL workspace (`calibrated=false`), no source deletions from Windows, Bucket 1 requires calibration + Mac Docker re-run. This matches:
- JSON `calibrated: false`.
- Scan MD header "(EXPERIMENTAL — uncalibrated)".
- The Wave-plan constraint (no Docker / no calibration on the Windows machine).

Coverage-run status correctly marked "Not attempted — uncalibrated workspace", consistent with no B1 promotion being possible.

### 4. Consolidation accuracy — PASS (with substantive validation)

The one finding — `@skillsmith/cli` unused dependency at `packages/skillsmith-cli/package.json` line 14 — is accurate against the actual file: line 14 is `"@skillsmith/cli": "^0.8.2"` inside `dependencies`. Line/column (14/6) and category (`dependencies`) match the JSON.

**Correctly routed to B2, NOT B1.** I verified the underlying reality: `bin.js` uses this dependency at runtime via `require.resolve('@skillsmith/cli/package.json')` and `require('@skillsmith/cli/package.json')` (lines 15-16). Knip cannot see these dynamic `createRequire` resolutions statically, so it flags the dep as unused. **This is a live false positive for deletion purposes** — removing the dep would break the wrapper. The audit pipeline handled it correctly by refusing to auto-classify it as safe and forcing human runtime-import review. No blocking finding.

### 5. Verify-report structure — PASS

All expected sections present and correctly ordered: SCAN FAILURES (0), Safe to delete (0), Consolidation candidate (1), Looks bad but is fine (False positives 0 / Known blind spots 0), Needs runtime verification (0), Suppressed by marker (0), Stale suppression markers (0). Each empty section carries its explanatory preamble and `_None._`. No malformed/missing sections.

### 6. Stale-marker check — PASS

Triage reports 0 stale suppression markers ("No `audit:code-health-ok` markers"). Verify MD "Stale suppression markers (0)" agrees. Consistent — a thin 4-file wrapper package with no source tree carrying markers is expected.

### 7. Wave-1 overlap note accuracy — PASS

The cross-package callout is accurate and useful. Wave 1 scanned `packages/cli`; this wave scans `packages/skillsmith-cli`, a distinct wrapper package. The note correctly hypothesizes that `@skillsmith/cli` may point to the published artifact of the `cli` package and that the wrapper may re-export/delegate to it. Confirmed against source: `bin.js` header comment states "Convenience wrapper — delegates to @skillsmith/cli" and does exactly that. The suggested Mac-side check (`grep for require('@skillsmith/cli') / from '@skillsmith/cli'`) is the right verification, though note the actual usage is `require.resolve(...)` / `require('@skillsmith/cli/package.json')` — a plain `@skillsmith/cli` grep still catches it. Callout is sound.

---

## Minor Observations (non-blocking, no action required)

- The triage's grep suggestion (line 71) targets `packages/skillsmith-cli/src/`, but this package has no `src/` directory — the runtime use lives in `bin.js` at package root. The broader package-wide grep already suggested on line 50 covers it, so the actual usage will still be found. Not a defect in the artifacts' conclusions.

## Verdict

**PASS.** All seven checks pass. Bucket counts reconcile across JSON, scan MD, verify MD, and triage (1 candidate, B2=1, B1=B4=0). The single finding is accurate to the source and correctly routed to human-review Bucket 2 rather than deletion — independently confirmed as a runtime-live dependency Knip cannot resolve statically. No blocking findings. Safe for the Mac reviewer to proceed to the post-merge runtime check.
