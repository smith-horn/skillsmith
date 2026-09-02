# Code Health Report

Generated: 2026-09-02T03:26:20.892Z

## SCAN FAILURES (0)

A Knip pass failed or returned malformed/incomplete data for these workspaces. Every candidate from a listed workspace is force-routed to Needs runtime verification below, regardless of coverage or calibration status, and is NOT eligible for Safe-to-delete or Consolidation-candidate until re-scanned successfully. This is never absorbed as "no findings" -- see patterns/README.md Decision Log.

_None._

## Safe to delete (0)

Never auto-applied. Zero static references + zero coverage on the exact flagged range — not a deletion guarantee, do a final project-wide grep before deleting. See patterns/README.md Bucket 1.

_None._

## Consolidation candidate (4)

Human judgment only, never auto-merged. See patterns/README.md Bucket 2.

| workspace | file | name | files | note | source |
|---|---|---|---|---|---|
| packages/vscode-extension | packages/vscode-extension/package.json | @types/mocha |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/vscode-extension | packages/vscode-extension/package.json | @vscode/test-electron |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/vscode-extension | packages/vscode-extension/package.json | @wdio/local-runner |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/vscode-extension | packages/vscode-extension/package.json | @wdio/spec-reporter |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |

## Looks bad but is fine (0)

### False positives (0)

_None._

### Known blind spots (0)

_None._

## Needs runtime verification — insufficient evidence (26)

Not a verdict. Never promoted to Safe-to-delete on missing data. See patterns/README.md Bucket 4.

| workspace | file | category | name | line | reason |
|---|---|---|---|---|---|
| packages/vscode-extension | packages/vscode-extension/src/mcp/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/sidebar/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/package.json | binaries | vscode-test |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/tsconfig.e2e.json | unlisted | @wdio/globals |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/utils/createSkill.helpers.ts | exports | buildCliEnv | 46 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/commands/compareCommand.ts | exports | runComparison | 161 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/services/Telemetry.ts | exports | isTelemetryEnabled | 74 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/services/SkillService.ts | exports | applyMockFilters | 184 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/intellisense/index.ts | exports | DIAGNOSTIC_CODES | 7 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/services/installUtils.ts | exports | generateSkillMd | 96 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/views/skill-panel-html.ts | exports | getContentHtml | 17 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/services/localSkillReader.ts | exports | resolveSkillsRoot | 49 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/intellisense/SkillDiagnosticsProvider.ts | exports | DIAGNOSTIC_CODES | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/utils/skillNameValidation.ts | exports | VALID_SKILL_NAME_RE | 8 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/views/SkillDetailPanel.ts | types | ScoreBreakdown | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/mcp/connectFailureUx.ts | types | ConfigWriter | 19 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/sidebar/categories.ts | types | ApiCategory | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/mcp/types.ts | types | McpSearchFilters | 23 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/mcp/types.ts | types | McpScoreBreakdown | 46 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/mcp/types.ts | types | McpSecurityFinding | 97 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/mcp/types.ts | types | McpSecurityReport | 106 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/mcp/types.ts | types | McpRecommendation | 136 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/mcp/types.ts | types | McpToolCall | 401 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/mcp/types.ts | types | McpToolResultContent | 409 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/mcp/types.ts | types | McpToolResult | 417 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/vscode-extension | packages/vscode-extension/src/sidebar/SkillTreeItem.ts | types | TrustTier | 19 | workspace is EXPERIMENTAL (uncalibrated) |

## Suppressed by marker (0)

_None._

## Stale suppression markers (0)

Present in source, no current finding matches — consider removing.

_None._
