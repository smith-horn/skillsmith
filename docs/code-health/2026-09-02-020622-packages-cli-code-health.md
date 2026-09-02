# Code Health Report

Generated: 2026-09-02T02:06:24.690Z

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
| packages/cli | packages/cli/src/templates/skill.md.template.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/cli | packages/cli/src/templates/readme.md.template.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/cli | packages/cli/src/templates/changelog.md.template.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/cli |  | getInstalledSkills | packages/cli/src/commands/recommend.helpers.ts,packages/cli/src/utils/skills-directory.ts |  | name-repeat-detector |

## Looks bad but is fine (28)

### False positives (28)

| workspace | file | category | name | tag | detail |
|---|---|---|---|---|---|
| packages/cli | packages/cli/src/commands/ab-test.ts |  |  | cli-command-factory | named export runAbTest + default export in same file |
| packages/cli | packages/cli/src/commands/analyze.ts |  |  | cli-command-factory | named export createAnalyzeCommand + default export in same file |
| packages/cli | packages/cli/src/commands/audit-collisions.ts |  |  | cli-command-factory | named export createAuditCollisionsSubcommand + default export in same file |
| packages/cli | packages/cli/src/commands/audit-security.ts |  |  | cli-command-factory | named export createAuditSecuritySubcommand + default export in same file |
| packages/cli | packages/cli/src/commands/audit-sources.ts |  |  | cli-command-factory | named export createAuditSourcesSubcommand + default export in same file |
| packages/cli | packages/cli/src/commands/audit.ts |  |  | cli-command-factory | named export createAuditAdvisoriesSubcommand + default export in same file |
| packages/cli | packages/cli/src/commands/config.ts |  |  | cli-command-factory | named export createConfigCommand + default export in same file |
| packages/cli | packages/cli/src/commands/install-skill.ts |  |  | cli-command-factory | named export createInstallSkillCommand + default export in same file |
| packages/cli | packages/cli/src/commands/install.ts |  |  | cli-command-factory | named export createInstallCommand + default export in same file |
| packages/cli | packages/cli/src/commands/merge.ts |  |  | cli-command-factory | named export createMergeCommand + default export in same file |
| packages/cli | packages/cli/src/commands/recommend.ts |  |  | cli-command-factory | named export createRecommendCommand + default export in same file |
| packages/cli | packages/cli/src/commands/registry-install.ts |  |  | cli-command-factory | named export createRegistryInstallCommand + default export in same file |
| packages/cli | packages/cli/src/commands/search.ts |  |  | cli-command-factory | named export createSearchCommand + default export in same file |
| packages/cli | packages/cli/src/commands/sync.ts |  |  | cli-command-factory | named export createSyncCommand + default export in same file |
| packages/cli | packages/cli/src/commands/audit-collisions.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/audit.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/config.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/install.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/install-skill.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/merge.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/recommend.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/search.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/sync.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/ab-test.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/audit-security.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/registry-install.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/analyze.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |
| packages/cli | packages/cli/src/commands/audit-sources.ts | duplicates |  |  | duplicates finding for a file already tagged cli-command-factory above — same convention, not a separate issue |

### Known blind spots (0)

_None._

## Needs runtime verification — insufficient evidence (151)

Not a verdict. Never promoted to Safe-to-delete on missing data. See patterns/README.md Bucket 4.

| workspace | file | category | name | line | reason |
|---|---|---|---|---|---|
| packages/cli | packages/cli/src/utils/license.ts | exports | TIER_FEATURES | 19 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/license.ts | exports | TIER_QUOTAS | 19 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/license.ts | exports | tryLoadEnterpriseValidator | 23 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/license.ts | exports | decodeLicenseKey | 25 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/license.ts | exports | isExpired | 26 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/license.ts | types | QuotaInfo | 18 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/license.ts | types | LicensePayload | 18 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-collisions.ts | exports | collisionsAction | 383 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-collisions.ts | exports | runApplyAll | 415 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-collisions.ts | exports | applyOneSuggestion | 418 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-collisions.ts | exports | default | 425 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-collisions.ts | types | AuditCollisionsOptions | 423 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-collisions.ts | types | ApplyOutcome | 423 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit.ts | exports | advisoriesAction | 185 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit.ts | exports | auditAction | 272 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit.ts | exports | default | 278 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | exports | VALID_CATEGORIES | 21 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | exports | printValidationResult | 32 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | exports | fileExists | 33 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | exports | ensureAgentsDirectory | 34 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | exports | extractTriggerPhrases | 35 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | exports | validateSubagentDefinition | 36 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | types | InitOptions | 20 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | types | SubagentOptions | 24 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | types | TransformOptions | 26 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/index.ts | types | McpInitOptions | 28 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/index.ts | exports | CLAUDE_MD_SNIPPET_TEMPLATE | 12 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/index.ts | types | McpServerTemplateData | 18 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/index.ts | types | McpParameterDefinition | 20 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/config.ts | exports | configGetAction | 256 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/config.ts | exports | configSetAction | 275 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/config.ts | exports | readConfigFile | 304 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/config.ts | exports | default | 305 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/create.ts | exports | createAction | 408 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/init.ts | exports | VALID_CATEGORIES | 35 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/init.action.ts | exports | initAction | 55 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/init.action.ts | exports | validateAction | 94 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/init.action.ts | exports | publishAction | 138 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/install.ts | exports | default | 64 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/install-skill.ts | exports | setupAction | 186 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/license-types.ts | exports | TIER_QUOTAS | 146 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/license-types.ts | types | QuotaInfo | 21 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/manage.ts | exports | listAction | 22 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-server.template.ts | exports | PACKAGE_JSON_TEMPLATE | 72 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-server.template.ts | exports | TSCONFIG_JSON_TEMPLATE | 113 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-server.template.ts | exports | INDEX_TS_TEMPLATE | 137 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-server.template.ts | exports | SERVER_TS_TEMPLATE | 161 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-server.template.ts | exports | TOOLS_INDEX_TS_TEMPLATE | 234 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-server.template.ts | exports | EXAMPLE_TOOL_TS_TEMPLATE | 268 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-server.template.ts | exports | MCP_README_TEMPLATE | 304 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-server.template.ts | exports | MCP_GITIGNORE_TEMPLATE | 356 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-server.template.ts | types | McpParameterDefinition | 49 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/merge.ts | exports | mergeAction | 203 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/merge.ts | exports | default | 231 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/recommend.helpers.ts | exports | normalizeSkillName | 18 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/recommend.helpers.ts | exports | skillsOverlap | 19 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/recommend.helpers.ts | exports | getTrustBadge | 64 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/recommend.ts | exports | recommendAction | 291 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/recommend.ts | types | SkillRecommendation | 27 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/recommend.ts | types | RecommendResponse | 27 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/recommend.ts | types | InstalledSkill | 27 | coverage_state=absent |
| packages/cli | packages/cli/src/config.ts | exports | DEFAULT_SKILLS_DIR | 25 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | exports | PAGE_SIZE | 16 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | exports | TRUST_TIER_COLORS | 18 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | exports | formatSecurityStatus | 19 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | exports | formatSkillRow | 20 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | exports | displayResults | 21 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | exports | displaySkillDetails | 22 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | exports | default | 74 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | types | InteractiveSearchState | 15 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | types | SearchPhase | 15 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search.ts | types | SearchCommandOptions | 15 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/sync.ts | exports | default | 124 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/import-local.ts | exports | importLocalAction | 257 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/ab-test.ts | exports | abTestAction | 239 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/ab-test.ts | exports | default | 272 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.candidates.ts | exports | compareCandidates | 26 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | securityAction | 76 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | validateOptions | 84 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | applyAcceptance | 85 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | applyRevoke | 86 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | printAcceptOutcome | 87 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | printRevokeOutcome | 88 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | printAcceptances | 89 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | compareCandidates | 93 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | orderedCandidates | 94 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | paginate | 95 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | allCandidatesPagination | 96 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | printCandidates | 97 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | exports | default | 101 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | types | AuditSecurityOptions | 79 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | types | AuditSecurityCliSeams | 80 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | types | ValidationCode | 91 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | types | ValidationResult | 91 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | types | MutationOutcome | 91 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.ts | types | Pagination | 99 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/diagnose.ts | exports | diagnoseAction | 232 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/diff.ts | exports | diffAction | 252 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/login.ts | exports | loginAction | 434 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/logout.ts | exports | logoutAction | 78 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/logs.ts | exports | logsAction | 243 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/pin.ts | exports | pinAction | 99 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/pin.ts | exports | unpinAction | 145 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/registry-install.ts | exports | default | 70 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search-formatters.ts | exports | formatSkillRow | 68 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/whoami.ts | exports | whoamiAction | 124 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/analyze.ts | exports | analyzeAction | 212 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/analyze.ts | exports | default | 234 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/info.ts | exports | infoAction | 136 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/import.ts | exports | importAction | 383 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/inventory.ts | exports | runPush | 65 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/inventory.ts | exports | runStatus | 66 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/inventory.ts | exports | runForgetDevice | 67 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/inventory.ts | exports | runPurge | 68 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/inventory.ts | exports | inventoryPushActionImpl | 69 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/inventory.ts | exports | inventoryStatusActionImpl | 70 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/inventory.ts | exports | inventoryForgetDeviceActionImpl | 71 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/inventory.ts | exports | inventoryPurgeActionImpl | 72 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/agent.ts | exports | runInstall | 61 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/agent.ts | exports | runUninstall | 62 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/agent.ts | exports | agentInstallActionImpl | 63 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/agent.ts | exports | agentUninstallActionImpl | 64 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-sources.ts | exports | default | 67 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/subagent.ts | exports | subagentAction | 212 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/transform.ts | exports | transformAction | 171 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/author/mcp-init.ts | exports | mcpInitAction | 230 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/skill.md.template.ts | exports | default | 98 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/readme.md.template.ts | exports | default | 87 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/changelog.md.template.ts | exports | default | 20 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/subagent.md.template.ts | exports | CLAUDE_MD_SNIPPET_TEMPLATE | 59 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/skill-name.ts | exports | VALID_SKILL_NAME_RE | 13 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-template-handlers.ts | exports | escapeQuotes | 14 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/log-records.helpers.ts | exports | LOG_LEVEL_ORDER | 36 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/registry-install.action.ts | exports | isValidPrivateRegistrySkillId | 86 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/registry-install.action.ts | exports | describePrivateRegistryError | 102 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/manage.update.helpers.ts | exports | AUTO_APPLY_RECOVERY_CONFIDENCES | 65 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/manage.update.helpers.ts | exports | recoverConfidentSourceId | 80 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/manage.update.helpers.ts | exports | readClaimedAuthor | 128 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/manage.update.helpers.ts | types | SkillWithVersion | 51 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/skills-directory.ts | types | HarnessSkillEntry | 50 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/manifest.ts | types | SkillManifestEntry | 33 | coverage_state=absent |
| packages/cli | packages/cli/src/utils/require-tier.ts | types | EffectiveTierSource | 73 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/telemetry.helpers.ts | types | HookEntry | 29 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/telemetry.helpers.ts | types | HookMatcher | 34 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/telemetry.helpers.ts | types | ClaudeHooks | 39 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-template-types.ts | types | McpParameterDefinition | 31 | coverage_state=absent |
| packages/cli | packages/cli/src/templates/mcp-template-types.ts | types | VersionKey | 52 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search-types.ts | types | TrustTierColorFn | 14 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/search-types.ts | types | SearchCommandOptions | 39 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/audit-security.mutate.ts | types | ValidationCode | 22 | coverage_state=absent |
| packages/cli | packages/cli/src/commands/manage.update.ts | types | SkillDiff | 35 | coverage_state=absent |

## Suppressed by marker (0)

_None._

## Stale suppression markers (0)

Present in source, no current finding matches — consider removing.

_None._
