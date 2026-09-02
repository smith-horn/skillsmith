# Wave 7 Triage — packages/vscode-extension

**Date:** 2026-09-02
**Branch:** cleanup/code-health-wave-7-vscode-extension
**Machine:** Windows 11, wrsmith108

## Scan artifacts

| File | Path |
|------|------|
| Scan JSON | `docs/code-health/2026-09-02-032603-vscode-extension-scan-repo.json` |
| Scan MD | `docs/code-health/2026-09-02-032603-vscode-extension-scan-repo.md` |
| Verify MD | `docs/code-health/2026-09-02-032620-packages-vscode-extension-code-health.md` |

## Triage results

Candidate partition (30 total):

| Bucket | Count | Action |
|--------|-------|--------|
| B1 Safe-to-delete | 0 | EXPERIMENTAL workspace — no source deletions |
| B2 Consolidation candidate | 4 | Human review (check VS Code test runner config first) |
| B4 Needs-runtime-verification | 26 | EXPERIMENTAL + extension API surface false positives likely |

**Total candidates:** 30 (B1 0 + B2 4 + B4 26 = 30) ✓
**FP tags:** 0 (none from scan; but VS Code extension false-positive class is documented below)

## Why no Bucket 1 items

EXPERIMENTAL workspace (`calibrated=false`). Source deletions not performed from Windows.
Bucket 1 requires calibration + Mac Docker re-run.

## Coverage run status

Not attempted — uncalibrated workspace.

## Extension-specific false positive context (wave plan directive)

**Wave plan note:** "VS Code extension patterns differ from Node packages; more false positives likely
(extension API surface not visible to Knip)."

VS Code extensions have two categories of symbols invisible to Knip's static analysis:

1. **Contribution-point registrations**: Commands, views, webview providers, and diagnostic codes
   registered in `package.json`'s `contributes` section are activated by VS Code at runtime —
   Knip does not cross-reference `package.json` contributes against TypeScript exports. Any export
   used only via VS Code's activation/contribution system will appear as "unused."

2. **Test infrastructure**: VS Code extensions use `@vscode/test-electron`, `@wdio/*`, and `@types/mocha`
   through `.vscode-test.mjs` / WDIO config files outside the standard TypeScript import graph.
   These appear as unused devDependencies to Knip.

All 26 B4 candidates should be treated as potentially false positives until Mac Docker coverage
data confirms actual unused status. The 4 B2 dep findings warrant the same caution.

## Consolidation candidates (B2)

All 4 are devDependencies likely used by VS Code test infrastructure:

| Package | File | Likely use | Priority |
|---------|------|-----------|----------|
| `@types/mocha` | package.json | Mocha type declarations for VS Code test runner | MEDIUM — check `.vscode-test.*` config |
| `@vscode/test-electron` | package.json | VS Code extension test runner framework | MEDIUM — check test scripts in package.json |
| `@wdio/local-runner` | package.json | WebdriverIO local runner for e2e tests | MEDIUM — check `wdio.conf.*` |
| `@wdio/spec-reporter` | package.json | WebdriverIO spec reporter | MEDIUM — check `wdio.conf.*` |

**Recommendation for Mac:** Before any removal, run `cat packages/vscode-extension/wdio.conf.*`
and `cat packages/vscode-extension/.vscode-test.mjs` to confirm usage. These test tools
are highly likely to be in use.

## Needs-runtime-verification candidates (B4)

26 candidates, all flagged as EXPERIMENTAL. Extension-specific false-positive analysis:

### High false-positive likelihood (extension API surface)

| Name | File | Category | Extension FP reason |
|------|------|----------|---------------------|
| `DIAGNOSTIC_CODES` | `intellisense/index.ts` | exports | Likely registered via VS Code contribution point |
| `DIAGNOSTIC_CODES` | `intellisense/SkillDiagnosticsProvider.ts` | exports | **Also a name-repeat** — same constant in both provider and index |
| `buildCliEnv` | `utils/createSkill.helpers.ts` | exports | Helper — may be used only via VS Code command activation |
| `runComparison` | `commands/compareCommand.ts` | exports | Command handler registered via contribution points |
| `isTelemetryEnabled` | `services/Telemetry.ts` | exports | May be used only via VS Code activation event |
| `applyMockFilters` | `services/SkillService.ts` | exports | **Same-file-export FP** — governance review confirmed used within the file (line 94); export may be removable via de-export (not deletion) |
| `generateSkillMd` | `services/installUtils.ts` | exports | **Same-file-export FP** — governance review confirmed used within the file (line 81); export may be removable via de-export (not deletion) |
| `getContentHtml` | `views/skill-panel-html.ts` | exports | Webview HTML builder — registered via VS Code WebviewPanel |
| `resolveSkillsRoot` | `services/localSkillReader.ts` | exports | May be only called from registered command handlers |
| `VALID_SKILL_NAME_RE` | `utils/skillNameValidation.ts` | exports | Validation regex — may be used only via contribution registration |
| Index barrels | `mcp/index.ts`, `sidebar/index.ts` | files | VS Code sidebar/mcp registration may not appear as static imports |
| `vscode-test` | package.json | binaries | Test runner binary — used via npm scripts, not imports |
| `@wdio/globals` | tsconfig.e2e.json | unlisted | WDIO globals — unlisted in monorepo context, used in e2e tests |

### Extension type exports (moderate FP likelihood)

All 12 `types` candidates in B4 are VS Code extension types likely used at runtime or
via the extension API surface — Knip cannot see usage patterns through VS Code's
`window.registerWebviewViewProvider`, `workspace.registerTextDocumentContentProvider`, etc.

| Name | File | Note |
|------|------|------|
| `ScoreBreakdown` | `views/SkillDetailPanel.ts` | Used in WebviewPanel message passing |
| `ConfigWriter` | `mcp/connectFailureUx.ts` | MCP connection failure UI type |
| `ApiCategory` | `sidebar/categories.ts` | Sidebar tree view category type |
| `McpSearchFilters`, `McpScoreBreakdown`, `McpSecurityFinding`, `McpSecurityReport`, `McpRecommendation`, `McpToolCall`, `McpToolResultContent`, `McpToolResult` | `mcp/types.ts` | MCP protocol types — used via VS Code message passing |
| `TrustTier` | `sidebar/SkillTreeItem.ts` | Sidebar tree item tier type |

### Name-repeat finding

`DIAGNOSTIC_CODES` appears in both `intellisense/index.ts` (line 7) and
`intellisense/SkillDiagnosticsProvider.ts` (line 37). If the provider defines the codes
and the index re-exports them, this is barrel-export duplication — worth Mac review
to confirm one is authoritative.

## Stale suppression markers

0 found.

## Wave objective and success criteria

This wave establishes a baseline scan of `packages/vscode-extension`. 30 candidates: 4 in B2
(test devDeps) and 26 in B4 (extension API surface + types). The wave plan explicitly notes
higher false-positive likelihood for VS Code extensions due to contribution-point registration
being invisible to Knip. All 30 candidates are held for Mac review.

**Key insight:** A large fraction of B4 candidates are likely false positives specific to the VS Code
extension pattern — commands and types registered via `package.json` contribution points rather than
static imports. Mac calibration should account for this by checking `contributes.commands` entries
before marking any export as safe-to-delete.

## Post-merge obligations (Mac)

- [ ] Create/update SMI issue; comment with squash SHA
- [ ] Post project update using PR Business Summary
- [ ] Update `docs/code-health/index.md` with wave-7 row
- [ ] Check `packages/vscode-extension/wdio.conf.*` — confirm @wdio/* dep usage
- [ ] Check `packages/vscode-extension/.vscode-test.mjs` — confirm @vscode/test-electron usage
- [ ] Audit `DIAGNOSTIC_CODES` — one location should be authoritative; the other may be a barrel re-export
- [ ] Cross-reference B4 exports against `package.json` `contributes` section before any deletion
