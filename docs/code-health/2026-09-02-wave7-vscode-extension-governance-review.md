# Wave 7 Governance Review — packages/vscode-extension Code Health Audit

**Date:** 2026-09-02
**Reviewer:** governance-specialist (docs-only review)
**Scope:** Wave 7 code-health audit artifacts for `packages/vscode-extension`
**Verdict:** **PASS (post-fix)**

**Post-review update:** W1/W2 (missing applyMockFilters + generateSkillMd from B4 tables, same-file-export FP misclassification) were fixed immediately in the triage doc. Both entries added with correct same-file-export FP classification. Governance re-verdict: PASS.

---

**Original verdict:** PASS_WITH_WARNINGS (before fix)

---

## Artifacts reviewed

| File | Role |
|------|------|
| `2026-09-02-032603-vscode-extension-scan-repo.md` | Scan summary |
| `2026-09-02-032603-vscode-extension-scan-repo.json` | Scan raw candidates (30) |
| `2026-09-02-032620-packages-vscode-extension-code-health.md` | Verify report (B2=4, B4=26) |
| `2026-09-02-vscode-extension-triage.md` | Triage / bucket partition |

Package source (`packages/vscode-extension/`) cross-referenced for FP-claim validation.

---

## Check results

### 1. Artifact filename consistency — PASS
Scan pair timestamped `032603`; verify report `032620`. Chronologically ordered (verify runs 17s after scan). The triage's "Scan artifacts" table (lines 11-13) references all three by exact filename with no drift.

### 2. Bucket-count reconciliation — PASS
- JSON: `candidates: 30` (counted 30 objects), `looks_bad_but_fine: []` (0).
- Scan MD: "Candidates: 30, Looks-bad-but-fine tags: 0".
- Verify MD: Consolidation (4) + Needs-runtime-verification (26) = 30. Safe-to-delete 0, Scan-failures 0, Suppressed 0, Stale 0.
- Triage: B1 0 + B2 4 + B4 26 = 30, arithmetic asserted inline (line 25).

All four artifacts reconcile to 30. ✓

**Category note:** the wave summary lists "devDependencies:4", and the JSON labels those 4 rows `category: devDependencies`. The verify report re-labels them "Consolidation candidate / unused dependency". Same 4 entries, consistent. Export count = 10 in JSON (buildCliEnv, runComparison, isTelemetryEnabled, applyMockFilters, DIAGNOSTIC_CODES×2, generateSkillMd, getContentHtml, resolveSkillsRoot, VALID_SKILL_NAME_RE) ✓ matches "exports:10".

### 3. Bucket-1-absence rationale — PASS
Workspace is `calibrated: false` (JSON) / "EXPERIMENTAL — uncalibrated" (scan+verify). Verify report Safe-to-delete section is correctly empty; triage states "Bucket 1 requires calibration + Mac Docker re-run" and "Source deletions not performed from Windows." Rationale is correct and consistent with the EXPERIMENTAL-workspace policy (no promotion to Safe-to-delete on uncalibrated data).

### 4. B2 consolidation accuracy — PASS
The 4 B2 entries in the triage (lines 62-65) match the verify report Consolidation table (lines 23-26) exactly, name-for-name:
`@types/mocha`, `@vscode/test-electron`, `@wdio/local-runner`, `@wdio/spec-reporter`. No additions, no omissions, no renames. ✓

### 5. Verify-report structure — PASS
All expected sections present and in canonical order: Scan Failures (0), Safe to delete (0), Consolidation candidate (4), Looks bad but is fine → False positives (0) / Known blind spots (0), Needs runtime verification (26), Suppressed by marker (0), Stale suppression markers (0). Bucket-README references intact.

### 6. Stale-marker check — PASS
Verify report "Stale suppression markers (0)" and triage "Stale suppression markers: 0 found." Consistent.

### 7. Extension FP context — PASS (plausible & source-confirmed), with one accuracy warning (see below)
The triage's two FP classes were validated against actual package source:

- **Test-infra devDeps (B2):** `.vscode-test.mjs` line 1 imports `@vscode/test-electron` directly, and its `mocha:{ ui, timeout }` config block plus the `files:` test glob exercise `@types/mocha` and the `vscode-test` binary outside Knip's import graph. The triage's "highly likely to be in use" call is **correct** — these are genuine FPs.
- **Contribution-point exports:** `package.json` has a populated `contributes.commands` section (verified), so the triage's rationale that command handlers / webview providers are activated by VS Code at runtime and invisible to Knip is structurally sound for this package.

The extension-FP narrative is plausible and evidence-backed, not hand-waving.

---

## Warnings (non-blocking, but should be corrected before Mac review acts on this triage)

### W1 — Triage B4 enumeration is incomplete (24 of 26 listed) — MAJOR
The triage's B4 breakdown tables (lines 77-104) enumerate only **24** of the 26 B4 candidates. Two are missing entirely — not listed in any table, and confirmed absent via full-document search:

| Missing candidate | File:line | Category |
|---|---|---|
| `applyMockFilters` | `src/services/SkillService.ts:184` | exports |
| `generateSkillMd` | `src/services/installUtils.ts:96` | exports |

The bucket **count** (26) is stated correctly everywhere; only the per-item FP analysis drops these two. A Mac reviewer working the triage tables item-by-item would silently skip both.

### W2 — The two omitted items are a *different* FP class than the triage's narrative — MAJOR
Source inspection shows both omitted exports are **used within their own file**:
- `installUtils.ts:81` calls `generateSkillMd` (defined :96).
- `SkillService.ts:94` calls `applyMockFilters` (defined :184).

These are "exported but consumed only in the same module" cases (the `export` keyword is redundant), **not** contribution-point / extension-API-surface FPs. The triage's summarizing claim — "A large fraction of B4 candidates are likely false positives specific to the VS Code extension pattern" and "All 26 B4 candidates should be treated as potentially false positives [via] contribution-point registration" — overgeneralizes: at least these 2 are ordinary same-file-export findings whose correct resolution is likely "drop the `export` keyword," not "confirm contribution-point usage." This is the more actionable class and it's the one the triage omitted.

**Recommended correction (for Mac wave owner, before deletion decisions):** add both items to the B4 table with the accurate FP reason ("exported symbol referenced only within its own module — candidate for de-exporting, not a runtime FP"), and soften the blanket "all 26 are contribution-point FPs" framing.

### W3 — `DIAGNOSTIC_CODES` name-repeat correctly flagged (informational, no action)
Both artifacts correctly surface the `DIAGNOSTIC_CODES` duplication across `intellisense/index.ts:7` and `intellisense/SkillDiagnosticsProvider.ts:37`. The triage's barrel-re-export hypothesis (lines 106-110) is a reasonable read and already carries a Mac follow-up checkbox. No correction needed.

---

## Zero-deferral note
These are docs-only findings in a wave-artifact set for an **uncalibrated (EXPERIMENTAL) workspace where no source is being deleted from this machine**. W1/W2 are accuracy defects in the triage's advisory tables, not code defects and not deletion actions. They are recorded here in full (not deferred) and the concrete correction is specified above for the Mac wave owner who owns the calibrated re-run and any edits to this branch's triage doc. No source or config change is in scope for this Windows docs-only review.

---

## Verdict

**PASS_WITH_WARNINGS** — All six mechanical checks (filenames, counts, bucket reconciliation, B1 rationale, B2 accuracy, verify structure, stale markers) pass cleanly; the extension-FP context is source-validated and plausible. Two accuracy warnings (W1/W2): the triage enumerates 24 of 26 B4 items and its blanket "all contribution-point FP" framing misclassifies the 2 it omits, which are same-file-export findings. Correct the triage tables before the Mac calibration pass consumes them.
