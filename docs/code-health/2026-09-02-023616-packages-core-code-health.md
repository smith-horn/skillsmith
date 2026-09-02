# Code Health Report

Generated: 2026-09-02T02:36:18.879Z

## SCAN FAILURES (0)

A Knip pass failed or returned malformed/incomplete data for these workspaces. Every candidate from a listed workspace is force-routed to Needs runtime verification below, regardless of coverage or calibration status, and is NOT eligible for Safe-to-delete or Consolidation-candidate until re-scanned successfully. This is never absorbed as "no findings" -- see patterns/README.md Decision Log.

_None._

## Safe to delete (0)

Never auto-applied. Zero static references + zero coverage on the exact flagged range — not a deletion guarantee, do a final project-wide grep before deleting. See patterns/README.md Bucket 1.

_None._

## Consolidation candidate (44)

Human judgment only, never auto-merged. See patterns/README.md Bucket 2.

| workspace | file | name | files | note | source |
|---|---|---|---|---|---|
| packages/core | packages/core/package.json | @opentelemetry/instrumentation-http |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/core | packages/core/package.json | @opentelemetry/instrumentation-runtime-node |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/core | packages/core/package.json | @opentelemetry/instrumentation-undici |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/core | packages/core/package.json | @opentelemetry/resources |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/core | packages/core/package.json | @opentelemetry/sdk-node |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/core | packages/core/package.json | @opentelemetry/sdk-trace-base |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/core | packages/core/package.json | @opentelemetry/semantic-conventions |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/core | packages/core/package.json | tree-sitter-wasms |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |
| packages/core | packages/core/src/security/SkillSandbox.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/services/TransformationService.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/activation/ActivationManager.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/repositories/IndexerRepository.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/search/hybrid.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/webhooks/WebhookHandler.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/webhooks/WebhookQueue.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/api/client.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/api/cache.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/services/TaskRunner.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/triggers/ContextScorer.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/triggers/TriggerDetector.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/analysis/CodebaseAnalyzer.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/cache/lru.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/cache/sqlite.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/install/agent-pack-installer.entry.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/matching/SkillMatcher.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/matching/OverlapDetector.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/activation/ZeroConfigActivator.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/embeddings/index.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/db/createDatabase.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/security/scanner/regex-utils.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/tests/fixtures/api-responses/index.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core | packages/core/src/indexer/SkillParser.ts |  |  | Knip duplicate-export finding; no per-line coverage signal available — human review, never auto-classified as safe |  |
| packages/core |  | fetchData | packages/core/src/analysis/adapters/__tests__/typescript.test.ts,packages/core/src/analysis/__tests__/incremental.test.ts,packages/core/src/analysis/__tests__/performance.test.ts |  | name-repeat-detector |
| packages/core |  | validatePath | packages/core/src/analytics/metrics-exporter.ts,packages/core/src/validation/path-validators.ts |  | name-repeat-detector |
| packages/core |  | helper | packages/core/src/analysis/__tests__/performance.test.ts |  | name-repeat-detector |
| packages/core |  | formatBytes | packages/core/src/benchmarks/formatters.ts,packages/core/src/benchmarks/memory/utils.ts |  | name-repeat-detector |
| packages/core |  | fetchWithRetry | packages/core/src/scripts/github-import/github-client.ts,packages/core/src/utils/retry.ts |  | name-repeat-detector |
| packages/core |  | estimateMemoryUsage | packages/core/src/analysis/file-streamer.ts,packages/core/src/embeddings/hnsw-store.helpers.ts |  | name-repeat-detector |
| packages/core |  | dynamicImport | packages/core/src/telemetry/metric-helpers.ts,packages/core/src/telemetry/tracer-imports.ts |  | name-repeat-detector |
| packages/core |  | detectTools | packages/core/src/services/SkillAnalyzer.helpers.ts,packages/core/src/services/SubagentGenerator.helpers.ts |  | name-repeat-detector |
| packages/core |  | createLogger | packages/core/src/logging/logger.ts,packages/core/src/utils/logger.ts |  | name-repeat-detector |
| packages/core |  | createDatabaseAsync | packages/core/src/db/createDatabase.ts,packages/core/src/db/schema.ts |  | name-repeat-detector |
| packages/core |  | cosineSimilarity | packages/core/src/embeddings/embedding-utils.ts,packages/core/src/learning/PatternStore.helpers.ts |  | name-repeat-detector |

## Looks bad but is fine (0)

### False positives (0)

_None._

### Known blind spots (0)

_None._

## Needs runtime verification — insufficient evidence (531)

Not a verdict. Never promoted to Safe-to-delete on missing data. See patterns/README.md Bucket 4.

| workspace | file | category | name | line | reason |
|---|---|---|---|---|---|
| packages/core | packages/core/src/scripts/ingest-lenny-skills.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scripts/merge-skills.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scripts/merge-types.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scripts/merge-utils.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scripts/review-categories.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scripts/review-lenny-skills.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scripts/sync-to-supabase.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/utils/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/db/drivers/index.ts | files |  |  | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/config/index.ts | unlisted | @isaacs/keytar | 127 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/config/token-credentials.ts | unlisted | @isaacs/keytar | 74 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/SkillSandbox.ts | exports | default | 427 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/SkillSandbox.ts | unlisted | @e2b/code-interpreter | 105 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/agent-pack/agent-pack.test.ts | unlisted | smol-toml | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/tree-sitter/manager.ts | exports | TreeSitterManager | 79 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/tree-sitter/manager.ts | types | TreeSitterManagerOptions | 60 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/tree-sitter/manager.ts | unlisted | tree-sitter | 144 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/tree-sitter/manager.ts | unlisted | tree-sitter-typescript | 239 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/tree-sitter/manager.ts | unlisted | tree-sitter-python | 245 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/tree-sitter/manager.ts | unlisted | tree-sitter-go | 250 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/tree-sitter/manager.ts | unlisted | tree-sitter-rust | 255 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/tree-sitter/manager.ts | unlisted | tree-sitter-java | 260 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | formatBytes | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | hasRegressions | 33 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | getRegressedBenchmarks | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | getImprovedBenchmarks | 35 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | DEFAULT_CONFIG | 39 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | formatBytesUtil | 42 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | hasRegressionsUtil | 45 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | MemoryProfiler | 49 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | defaultMemoryProfiler | 50 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | percentile | 98 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | mean | 99 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | sampleStddev | 100 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | exports | calculateLatencyStats | 101 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | types | DetailedMemoryStats | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | types | MemoryRegressionInfo | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | types | MemorySnapshot | 51 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | types | ProfilerMemoryStats | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | types | MemoryBaseline | 53 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | types | LeakDetectionResult | 54 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | types | MemoryRegressionResult | 55 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/index.ts | types | LatencyStats | 102 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SearchService.ts | exports | escapeFtsToken | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SearchService.ts | exports | buildFtsQuery | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SearchService.ts | exports | buildHighlights | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SearchService.ts | types | FTSRow | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SearchService.ts | types | BooleanSearchTerms | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SearchService.ts | types | SearchCacheOptions | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | exports | EventBatcher | 41 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | exports | createEventBatcher | 42 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | EventBatcherOptions | 43 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | BatchFlushFn | 44 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | OpenApiSearchResult | 83 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | RecommendedSkill | 84 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | SearchResponseMeta | 88 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | RecommendResponseMeta | 92 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | TelemetryMetadata | 99 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | TelemetryResponse | 101 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | OpenApiErrorResponse | 103 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/index.ts | types | OpenApiResponse | 109 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizeHtml | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizeFileName | 35 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizePath | 36 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizeUrl | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizeText | 38 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | isValidStripeId | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizeStripeCustomerId | 41 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizeStripeSubscriptionId | 42 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizeStripePriceId | 43 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizeStripeInvoiceId | 44 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | sanitizeStripeEventId | 45 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | AuditLogger | 58 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | detectRiskTrend | 85 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | SkillSandbox | 89 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | SandboxUnavailableError | 89 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | exports | withSandbox | 89 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | SecurityFindingType | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | RiskScoreBreakdown | 19 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | EvidenceType | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | AuditLogEntry | 60 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | AuditEventType | 61 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | AuditActor | 62 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | AuditResult | 63 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | AuditQueryFilter | 64 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | AuditStats | 65 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | RiskTrendResult | 86 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | SandboxOptions | 90 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | ExecutionResult | 90 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | SandboxFile | 90 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/index.ts | types | SandboxStatus | 90 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | createRawUrlAdapter | 65 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | GitLabSourceAdapter | 87 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | createGitLabAdapter | 88 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | SKILL_FILE_PATHS | 111 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | decodeBase64Content | 112 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | isRateLimitStatus | 113 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | isServerError | 114 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | isNotFoundStatus | 115 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | handleApiError | 116 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | assertResponseOk | 117 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | parseRateLimitHeaders | 118 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | extractDefaultBranch | 119 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | buildPaginationParams | 120 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | exports | parseJsonResponse | 121 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | types | ExtendedSourceConfig | 57 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | types | SkillUrlEntry | 66 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | types | GitLabAdapterConfig | 89 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/index.ts | types | NormalizedRepository | 122 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/embeddings/hnsw-search.ts | exports | __resetCachedHnswCtorForTests | 473 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/embeddings/hnsw-search.ts | types | HnswMeta | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/embeddings/hnsw-search.ts | types | HnswCachePaths | 66 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/TransformationService.ts | exports | default | 433 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | getErrorCondition | 47 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | estimateTokens | 48 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | calculateCost | 49 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | calculateCompatibilityScore | 50 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | selectProvider | 56 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | selectRoundRobin | 57 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | selectLeastLoaded | 58 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | selectByLatency | 59 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | selectByCost | 60 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | getFallbackProvider | 61 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | aggregateMetrics | 65 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | exports | runCompatibilityTest | 65 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | types | CircuitState | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/testing/MultiLLMProvider.ts | types | CircuitBreakerMetrics | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/patterns.ts | exports | EVIDENCE_TYPE_BY_PATTERN | 135 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | analyzeMarkdownContext | 78 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | isDocumentationContext | 79 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | isWithinInlineCode | 80 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | calculateRiskScore | 81 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | extractUrls | 82 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | scanSsrfPatterns | 84 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | toMinimalRefs | 85 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | toSARIF | 85 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | toGitHubAnnotations | 85 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.ts | exports | toSummary | 85 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/activation/ActivationManager.ts | exports | default | 408 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analytics/schema.ts | exports | ANALYTICS_SCHEMA | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/BenchmarkRunner.ts | exports | formatBytes | 51 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/BenchmarkRunner.ts | exports | hasRegressions | 54 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/BenchmarkRunner.ts | exports | getRegressedBenchmarks | 55 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/BenchmarkRunner.ts | exports | getImprovedBenchmarks | 56 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/BenchmarkRunner.ts | types | DetailedMemoryStats | 44 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/BenchmarkRunner.ts | types | MemoryRegressionInfo | 45 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/CacheManager.ts | exports | getTTLTierName | 478 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/CacheManager.ts | exports | POPULARITY_THRESHOLDS | 478 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | default | 16 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | SUPPORTED_EXTENSIONS | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | DEFAULT_EXCLUDE_DIRS | 22 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | LANGUAGE_EXTENSIONS | 23 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | parseFile | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | extractImport | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | extractExport | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | extractFunction | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | detectFrameworks | 44 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | hasFramework | 45 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | getPrimaryFramework | 46 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | FRAMEWORK_RULES | 47 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | LanguageRouter | 53 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | AdapterFactory | 56 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | LanguageDetector | 60 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | detectLanguage | 61 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | ParseCache | 66 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | ResultAggregator | 70 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | AnalysisMetrics | 78 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | getAnalysisMetrics | 79 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | initializeAnalysisMetrics | 80 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | timeParseAsync | 81 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | timeParseSync | 82 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | TreeSitterManager | 89 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | LanguageAdapter | 98 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | TypeScriptAdapter | 101 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | PythonAdapter | 102 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | GoAdapter | 104 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | parseGoMod | 105 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | RustAdapter | 111 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | parseCargoToml | 112 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | JavaAdapter | 118 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | parsePomXml | 119 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | parseBuildGradle | 120 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | ParserWorkerPool | 130 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | MemoryMonitor | 138 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | streamFiles | 146 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | batchReadFiles | 147 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | readFilesAsMap | 148 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | filterByExtension | 149 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | getFileExtension | 150 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | estimateMemoryUsage | 151 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | calculateEdit | 161 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | indexToPosition | 162 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | positionToIndex | 163 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | findMinimalEdit | 164 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | batchEdits | 165 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | isInsertion | 166 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | isDeletion | 167 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | isReplacement | 168 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | editSizeDelta | 169 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | TreeCache | 177 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | exports | IncrementalParser | 185 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | SupportedLanguage | 25 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | ExportKind | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | FrameworkRule | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | ParseResult | 35 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | CacheStats | 36 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | LanguageRouterOptions | 53 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | LanguageDetectionResult | 62 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | ParseCacheOptions | 66 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | AggregatorInput | 71 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | AggregatorMetadata | 72 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | AggregatorOptions | 73 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | AnalysisMetricsConfig | 83 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | AnalysisMetricsSnapshot | 84 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | TreeSitterManagerOptions | 90 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | TreeSitterParser | 91 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | TreeSitterTree | 92 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | TreeSitterNode | 93 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | TreeSitterLanguage | 94 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | LanguageInfo | 98 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | GoModInfo | 106 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | GoExportInfo | 107 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | GoFunctionInfo | 108 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | RustExportInfo | 113 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | RustFunctionInfo | 114 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | CargoDependency | 115 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | JavaExportInfo | 121 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | JavaFunctionInfo | 122 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | MavenDependency | 123 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | ParseTask | 131 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | WorkerResult | 132 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | WorkerPoolOptions | 133 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | MemoryStats | 139 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | CleanupResult | 140 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | MemoryMonitorOptions | 141 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | FileContent | 152 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | StreamOptions | 153 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | BatchReadOptions | 154 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | Point | 170 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | FileEdit | 171 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | EditDiff | 172 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | CachedTree | 178 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | TreeCacheStats | 179 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | TreeCacheOptions | 180 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | IncrementalParseResult | 186 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | IncrementalParserOptions | 187 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/index.ts | types | IncrementalParserStats | 188 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/repositories/IndexerRepository.ts | exports | default | 448 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/search/hybrid.ts | exports | default | 429 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/matching/index.ts | exports | DefaultSkillMatcher | 11 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/matching/index.ts | exports | DefaultOverlapDetector | 14 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scoring/index.ts | exports | computeQualityScore | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scoring/index.ts | types | QualityScoreInput | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/RawUrlSourceAdapter.ts | exports | createRawUrlAdapter | 355 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | SessionHealthMonitor | 72 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | getHealthMonitor | 73 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | initializeHealthMonitor | 74 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | shutdownHealthMonitor | 75 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | TypedEventEmitter | 83 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | MAX_RECOVERY_ATTEMPTS | 89 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | DEFAULT_HEALTH_CONFIG | 90 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | calculateHealth | 95 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | determineHealthStatus | 96 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | hasStatusChanged | 97 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | isAlertableStatus | 98 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | recordSessionCount | 103 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | recordRecoverySuccess | 104 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | exports | recordHealthStatusError | 105 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | types | SessionHealth | 76 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | types | SessionHealthStatus | 77 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | types | HealthMonitorConfig | 78 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | types | SessionHealthEvents | 79 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | types | SessionHealthState | 87 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/index.ts | types | RequiredHealthMonitorConfig | 88 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/PartitionStrategy.ts | exports | DEFAULT_PARTITION_RANGES | 41 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/validation/index.ts | exports | validateIPv6 | 19 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/validation/index.ts | exports | getIpRangeName | 19 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/WebhookHandler.ts | exports | default | 479 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/WebhookQueue.ts | exports | default | 414 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/client.ts | exports | checkApiHealth | 50 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/client.ts | exports | StatsResponseSchema | 57 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/client.ts | exports | default | 495 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/cache.ts | exports | default | 330 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/client.events.ts | exports | createBatchFlushFn | 36 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | exports | createApiResponseSchema | 80 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | exports | TelemetryEventSchema | 109 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | exports | PlatformStatsSchema | 172 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | types | TelemetryEventPayload | 150 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | types | TelemetryEventBatch | 151 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | types | TelemetryBatchResponse | 152 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | types | ValidatedApiSearchResult | 190 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | types | ValidatedSearchResponse | 195 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | types | ValidatedSingleSkillResponse | 200 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | types | ValidatedTelemetryResponse | 205 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | types | ValidatedPlatformStats | 210 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/schemas.ts | types | ValidatedStatsResponse | 215 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/quarantine/QuarantineService.ts | exports | handleMaliciousApproval | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/quarantine/QuarantineService.ts | exports | buildMultiApprovalStatus | 41 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/quarantine/QuarantineService.ts | exports | MALICIOUS_APPROVAL_COUNT | 44 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/quarantine/QuarantineService.ts | exports | MULTI_APPROVAL_TIMEOUT_MS | 45 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.evidence.ts | exports | EVIDENCE_SEVERITY_TABLE | 63 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/types.ts | exports | LANGUAGE_EXTENSIONS | 38 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/types.ts | types | ExportKind | 70 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/config/owned-lock.claim.ts | exports | parseClaim | 66 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/config/owned-lock.claim.ts | exports | isAutoReclaimDisabled | 126 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/config/owned-lock.claim.ts | exports | releaseOwned | 312 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/worker-pool.ts | exports | isMainThread | 302 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/worker-pool.ts | exports | parentPort | 302 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/worker-pool.ts | exports | workerData | 302 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/file-streamer.ts | exports | readFilesAsMap | 262 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/file-streamer.ts | exports | getFileExtension | 320 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/file-streamer.ts | exports | estimateMemoryUsage | 362 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/agent-pack/index.ts | exports | INTRO_PARAGRAPHS | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillAnalyzer.ts | exports | TOOL_PATTERNS | 50 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillAnalyzer.ts | exports | THRESHOLDS | 51 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillAnalyzer.ts | exports | escapeRegex | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillAnalyzer.ts | exports | getConfidenceLevel | 53 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillAnalyzer.ts | exports | default | 391 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillAnalyzer.ts | types | ParsedSection | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillAnalyzer.ts | types | ConfidenceLevel | 22 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.ts | exports | DEFAULT_EXTRACT_KEYWORDS | 41 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.ts | exports | sanitizeFilename | 41 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.ts | exports | default | 171 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.ts | types | SkillMetadata | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SubagentGenerator.helpers.ts | exports | TOOL_PATTERNS | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SubagentGenerator.helpers.ts | exports | BASE_TOOLS | 72 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SubagentGenerator.ts | exports | default | 299 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/TaskRunner.process.ts | exports | sleep | 70 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/TaskRunner.ts | exports | gracefulShutdown | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/TaskRunner.ts | exports | killProcess | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/TaskRunner.ts | exports | sleep | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/TaskRunner.ts | exports | default | 438 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/triggers/ContextScorer.ts | exports | default | 377 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/triggers/TriggerDetector.ts | exports | default | 214 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/CodebaseAnalyzer.ts | exports | default | 239 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/CodebaseAnalyzer.ts | types | ImportInfo | 29 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/CodebaseAnalyzer.ts | types | ExportInfo | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/CodebaseAnalyzer.ts | types | FunctionInfo | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/CodebaseAnalyzer.ts | types | FrameworkInfo | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/parsers.ts | exports | extractImport | 162 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/parsers.ts | exports | extractExport | 205 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/parsers.ts | exports | extractFunction | 242 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scripts/skill-scanner/scanner.ts | exports | scanSkill | 101 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/formatters.ts | exports | formatBytes | 17 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/comparator.ts | exports | hasRegressions | 70 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/comparator.ts | exports | getRegressedBenchmarks | 80 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/comparator.ts | exports | getImprovedBenchmarks | 92 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SearchService.helpers.ts | exports | buildHighlights | 101 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | exports | PartitionStrategy | 29 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | exports | createDefaultStrategy | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | exports | createCustomStrategy | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | exports | DEFAULT_PARTITION_RANGES | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | exports | SwarmIndexer | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | exports | createSwarmIndexer | 41 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | exports | createClaudeFlowSwarmIndexer | 42 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | GitHubRepository | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | Partition | 33 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | PartitionOptions | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | PartitionStats | 35 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | SwarmIndexerOptions | 43 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | SwarmIndexResult | 44 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | SwarmProgress | 45 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | WorkerState | 46 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | WorkerStatus | 47 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/index.ts | types | RateLimitInfo | 48 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/index.ts | exports | WebhookDeadLetterRepository | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/index.ts | types | DeliveryStats | 36 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/index.ts | types | DeadLetterRow | 53 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/index.ts | types | InsertDeadLetterInput | 54 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/index.ts | types | SupabaseLikeClient | 55 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/db/quarantine-schema.ts | exports | QUARANTINE_SCHEMA_SQL | 65 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/lru.ts | exports | default | 148 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/sqlite.ts | exports | default | 226 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/rate-limiter/index.ts | exports | MAX_UNIQUE_KEYS | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/rate-limiter/index.ts | exports | METRICS_TTL_MS | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/rate-limiter/index.ts | types | TokenBucket | 13 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/rate-limiter/index.ts | types | QueuedRequest | 14 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/install/agent-pack-installer.entry.ts | exports | CURSOR_MCP_COMMAND_PLACEHOLDER | 81 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/install/agent-pack-installer.entry.ts | exports | resolveSkillsmithMcpBinPath | 122 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/learning/ReasoningBankIntegration.helpers.ts | exports | extractActionFromPattern | 83 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/learning/PatternStore.queries.ts | exports | getContextEmbeddings | 256 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/framework-detector.ts | exports | hasFramework | 160 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/framework-detector.ts | exports | getPrimaryFramework | 176 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/java-parsers.ts | exports | addDependency | 154 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/java-parsers.ts | types | MavenDependency | 13 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analytics/constants.ts | exports | SUGGESTION_COOLDOWN_MS | 12 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analytics/constants.ts | exports | MAX_SUGGESTIONS_PER_DAY | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/LocalFilesystemAdapter.scan.ts | exports | SKILL_FILE_NAMES | 25 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/memory/index.ts | exports | defaultMemoryProfiler | 12 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/matching/SkillMatcher.ts | exports | default | 291 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/matching/OverlapDetector.ts | exports | default | 316 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/health-checks.ts | exports | isAlertableStatus | 79 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/SessionManager.ts | exports | storeMemoryEntry | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/SessionManager.ts | exports | retrieveMemoryEntry | 35 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/SessionManager.ts | exports | deleteMemoryEntry | 36 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/SessionManager.ts | exports | runPreTaskHook | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/SessionManager.ts | exports | runPostTaskHook | 38 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/validation/url-validators.ts | exports | getIpRangeName | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/validation/url-validators.ts | exports | validateIPv6 | 42 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/webhook-schemas.ts | exports | GitUserSchema | 20 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/webhook-schemas.ts | exports | RepositoryOwnerSchema | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/webhook-schemas.ts | exports | WebhookRepositorySchema | 44 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/webhook-schemas.ts | exports | PushCommitSchema | 59 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/webhook-schemas.ts | exports | WebhookSenderSchema | 86 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/webhook-schemas.ts | exports | WebhookHookConfigSchema | 109 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/webhook-schemas.ts | exports | WebhookHookSchema | 120 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/WebhookQueue.utils.ts | exports | comparePriority | 23 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/webhooks/WebhookQueue.utils.ts | exports | calculatePriorityScore | 36 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/embeddings/hnsw-store.helpers.ts | exports | computeCosineSimilarity | 85 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/embeddings/hnsw-store.helpers.ts | exports | distanceToSimilarity | 112 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/quarantine/QuarantineService.multiapproval.ts | exports | MALICIOUS_APPROVAL_COUNT | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/quarantine/QuarantineService.multiapproval.ts | exports | MULTI_APPROVAL_TIMEOUT_MS | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/db/quarantine-approvals-schema.ts | exports | QUARANTINE_APPROVALS_SCHEMA_SQL | 25 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/db/quarantine-approvals-schema.ts | exports | hasQuarantineApprovalsTable | 70 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/skill-installation.content.ts | exports | validateContentKeys | 119 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sync/access-token.ts | exports | TOKEN_REFRESH_SKEW_MS | 23 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/worker-utils.ts | exports | EXTENSION_TO_LANGUAGE | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillAnalyzer.helpers.ts | exports | TOOL_PATTERNS | 13 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillAnalyzer.helpers.ts | exports | escapeRegex | 100 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.helpers.ts | exports | DEFAULT_EXTRACT_KEYWORDS | 22 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.helpers.ts | exports | sanitizeFilename | 177 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.helpers.ts | exports | generateSubSkillFilename | 192 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.helpers.ts | exports | formatSubSkillContent | 200 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.helpers.ts | exports | generateSubSkillNavigation | 244 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SkillDecomposer.helpers.ts | exports | generateAttribution | 259 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/tree-sitter/queries/python.ts | exports | PYTHON_COMBINED_QUERY | 87 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/activation/ZeroConfigActivator.ts | exports | default | 360 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.fetch-correlation.ts | exports | escapeRegExp | 53 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.fetch-correlation.ts | exports | normalizeCorrelationPath | 77 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.fetch-correlation.ts | exports | implicitDownloadDestination | 133 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/security/scanner/SecurityScanner.fetch-correlation.ts | types | NormalizedCorrelationPath | 64 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/memory/MemoryProfiler.ts | exports | defaultMemoryProfiler | 397 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scripts/validation/types.ts | exports | TrustTierSchema | 142 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/scripts/validation/types.ts | exports | ValidatedSkillSchema | 144 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/db/schema.ts | types | Migration | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/types/skill.ts | types | SkillSource | 56 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/types/skill.ts | types | Source | 188 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/types/skill.ts | types | Category | 197 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/db/database-interface.ts | types | DatabaseFactory | 158 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/utils/logger.ts | types | LogEntry | 89 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/index.ts | types | L2CacheOptions | 11 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/index.ts | types | CacheEntry | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/index.ts | types | L1Config | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/index.ts | types | L2Config | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/index.ts | types | TieredCacheConfig | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/index.ts | types | TieredCacheStats | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/index.ts | types | SearchOptions | 33 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/index.ts | types | RefreshCallback | 33 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/index.ts | types | CacheManagerConfig | 33 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/config/owned-lock.types.ts | types | V1Claim | 39 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/config/owned-lock.types.ts | types | LegacyClaim | 47 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/config/owned-lock.types.ts | types | UnparseableClaim | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/config/owned-lock.types.ts | types | AbsentClaim | 56 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/learning/ReasoningBankIntegration.ts | types | SimilarPattern | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/learning/ReasoningBankIntegration.ts | types | PatternSearchOptions | 25 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/learning/PatternStore.ts | types | PatternRow | 26 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/skill-config-schema.ts | types | SkillConfig | 38 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/telemetry/tracer.ts | types | Span | 16 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/telemetry/tracer.ts | types | OTelApi | 19 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/telemetry/tracer.ts | types | OTelNodeSDK | 20 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/telemetry/tracer.ts | types | OTelResourceFromAttributes | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/telemetry/metrics.ts | types | MetricType | 13 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/go.ts | types | GoExportInfo | 17 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/go.ts | types | GoFunctionInfo | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/rust.ts | types | CargoDependency | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/rust.ts | types | RustExportInfo | 20 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/rust.ts | types | RustFunctionInfo | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/java.ts | types | MavenDependency | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/java.ts | types | JavaExportInfo | 23 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/java.ts | types | JavaFunctionInfo | 37 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analytics/AnalyticsRepository.ts | types | UsageEventRow | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analytics/AnalyticsRepository.ts | types | ExperimentRow | 29 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analytics/AnalyticsRepository.ts | types | ExperimentAssignmentRow | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analytics/AnalyticsRepository.ts | types | ExperimentOutcomeRow | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analytics/AnalyticsRepository.ts | types | ROIMetricsRow | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/session/SessionHealthMonitor.ts | types | SessionHealthStatus | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/sources/shared.ts | types | NormalizedRepository | 188 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/SwarmIndexer.ts | types | WorkerStatus | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/indexer/SwarmIndexer.ts | types | RateLimitInfo | 89 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/db/migration.ts | types | SkillRow | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/types.ts | types | TelemetryMetadata | 280 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/types.ts | types | TelemetryResponse | 310 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/api/types.ts | types | ApiResponse | 378 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/repositories/quarantine/index.ts | types | ApprovalRow | 12 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/repositories/quarantine/index.ts | types | ApprovalEntry | 12 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/repositories/quarantine/index.ts | types | RecordApprovalInput | 12 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | ExpertId | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | ExpertType | 19 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | ExpertState | 20 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | ExpertCapability | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | ExpertDefinition | 22 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | ExpertStatus | 23 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | WeightProfile | 25 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | RoutingScores | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | RoutingAlternative | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | ToolResponse | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | HistogramBuckets | 31 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | SONAMetrics | 32 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | LoadBalanceStrategy | 33 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | SONARouterConfig | 34 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/index.ts | types | SONAFeatureFlag | 35 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/repositories/quarantine/ApprovalRepository.ts | types | ApprovalRow | 21 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/adapters/base.ts | types | LanguageInfo | 28 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/benchmarks/types.ts | types | MemoryRegressionInfo | 99 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SearchService.types.ts | types | BooleanSearchTerms | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/services/SearchService.types.ts | types | SearchCacheOptions | 52 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/TieredCache.ts | types | L1Config | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/cache/TieredCache.ts | types | L2Config | 30 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/telemetry/tracer-types.ts | types | OTelSpan | 10 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/telemetry/tracer-types.ts | types | OTelTracer | 18 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/telemetry/tracer-types.ts | types | OTelSpanOptions | 22 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/telemetry/metric-types.ts | types | MetricType | 9 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/pipeline/DailyIndexPipeline.ts | types | PipelineSummary | 24 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/db/migration-types.ts | types | SkillRow | 93 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/SONARouter.ts | types | V3RoutingResult | 42 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/SONARouter.ts | types | V3RoutingSuggestion | 44 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/types.ts | types | ExpertType | 12 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/types.ts | types | ExpertCapability | 16 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/types.ts | types | RoutingAlternative | 27 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/types.ts | types | HistogramBuckets | 43 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/types.ts | types | LoadBalanceStrategy | 105 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/types.ts | types | SONAFeatureFlag | 186 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/analysis/worker-types.ts | types | WorkerPoolStats | 55 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/pipeline/pipeline-types.ts | types | PipelineSummary | 120 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/SONARouter.helpers.ts | types | V3RoutingResult | 15 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/SONARouter.helpers.ts | types | V3RoutingSuggestion | 40 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/expert-types.ts | types | ExpertType | 25 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/expert-types.ts | types | ExpertCapability | 96 | workspace is EXPERIMENTAL (uncalibrated) |
| packages/core | packages/core/src/routing/request-types.ts | types | RoutingAlternative | 65 | workspace is EXPERIMENTAL (uncalibrated) |

## Suppressed by marker (0)

_None._

## Stale suppression markers (0)

Present in source, no current finding matches — consider removing.

_None._
