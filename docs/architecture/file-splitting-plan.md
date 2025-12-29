# File Splitting Plan - SMI-717

## Overview

This document analyzes 8 files exceeding the 500-line limit per standards.md and provides a splitting plan for each. Files are prioritized by a combination of lines over limit and splitting complexity.

**Analysis Date**: December 28, 2025
**Standard Reference**: docs/architecture/standards.md (500 line maximum)

## Summary

| Priority | File | Lines | Over Limit | Complexity | Recommendation |
|----------|------|-------|------------|------------|----------------|
| 1 | BenchmarkRunner.ts | 697 | +197 | Low | Extract types, formatters, comparators |
| 2 | scanner.ts | 685 | +185 | Low | Extract patterns, types, risk calculator |
| 3 | SkillDetailPanel.ts | 610 | +110 | Medium | Extract HTML templates, styles |
| 4 | MemoryProfiler.ts | 595 | +95 | Low | Extract types |
| 5 | WebhookQueue.ts | 555 | +55 | Low | Extract types |
| 6 | SessionManager.ts | 545 | +45 | Low | Extract executor, types |
| 7 | webhook-endpoint.ts | 511 | +11 | Low | Extract rate limiter utilities |
| 8 | WebhookPayload.ts | 501 | +1 | Low | Extract Zod schemas |

---

## Priority 1: BenchmarkRunner.ts (697 lines)

**Location**: `packages/core/src/benchmarks/BenchmarkRunner.ts`
**Lines Over**: 197

### Current Structure Analysis

```
Lines 1-23:    Imports and documentation
Lines 27-168:  Type definitions (14 interfaces/types)
Lines 170-178: DEFAULT_CONFIG constant
Lines 183-537: BenchmarkRunner class
Lines 542-607: formatReportAsJson, formatReportAsText functions
Lines 612-619: formatBytes helper
Lines 624-668: compareReports function
Lines 673-696: ComparisonResult, MetricComparison interfaces
```

### Splitting Recommendation

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `types.ts` | All interfaces: BenchmarkConfig, BenchmarkResult, MemoryStats, BenchmarkStats, DetailedMemoryStats, MemoryRegressionInfo, BenchmarkReport, EnvironmentInfo, BenchmarkFn, BenchmarkDefinition, ComparisonResult, MetricComparison | ~170 |
| `formatters.ts` | formatReportAsJson, formatReportAsText, formatBytes | ~80 |
| `comparator.ts` | compareReports function | ~50 |
| `BenchmarkRunner.ts` | BenchmarkRunner class only (imports from above) | ~380 |

### Implementation Notes

1. Types have no dependencies - straightforward extraction
2. formatBytes is used by formatReportAsText - keep together or export separately
3. compareReports depends on BenchmarkReport, ComparisonResult types
4. BenchmarkRunner imports MemoryProfiler - no circular dependency risk

---

## Priority 2: scanner.ts (685 lines)

**Location**: `packages/core/src/security/scanner.ts`
**Lines Over**: 185

### Current Structure Analysis

```
Lines 1-9:     Documentation
Lines 10-76:   Type definitions (7 types/interfaces)
Lines 79-92:   DEFAULT_ALLOWED_DOMAINS
Lines 95-108:  SENSITIVE_PATH_PATTERNS
Lines 111-124: JAILBREAK_PATTERNS
Lines 127-139: SUSPICIOUS_PATTERNS
Lines 142-155: SOCIAL_ENGINEERING_PATTERNS
Lines 158-173: PROMPT_LEAKING_PATTERNS
Lines 176-197: DATA_EXFILTRATION_PATTERNS
Lines 200-225: PRIVILEGE_ESCALATION_PATTERNS
Lines 230-249: SEVERITY_WEIGHTS, CATEGORY_WEIGHTS
Lines 251-682: SecurityScanner class
```

### Splitting Recommendation

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `types.ts` | SecurityFindingType, SecuritySeverity, SecurityFinding, RiskScoreBreakdown, ScanReport, ScannerOptions | ~70 |
| `patterns.ts` | All pattern constants (SENSITIVE_PATH_PATTERNS, JAILBREAK_PATTERNS, etc.) + DEFAULT_ALLOWED_DOMAINS | ~170 |
| `weights.ts` | SEVERITY_WEIGHTS, CATEGORY_WEIGHTS | ~25 |
| `scanner.ts` | SecurityScanner class (imports from above) | ~430 |

### Alternative: Single Extraction

If three files seem excessive, combine into:

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `scanner-config.ts` | All types, patterns, and weights | ~265 |
| `scanner.ts` | SecurityScanner class only | ~430 |

### Implementation Notes

1. Patterns are pure constants with no dependencies
2. Types reference each other (e.g., ScanReport uses SecurityFinding)
3. calculateRiskScore method uses SEVERITY_WEIGHTS and CATEGORY_WEIGHTS - will need imports

---

## Priority 3: SkillDetailPanel.ts (610 lines)

**Location**: `packages/vscode-extension/src/views/SkillDetailPanel.ts`
**Lines Over**: 110

### Current Structure Analysis

```
Lines 1-8:     Imports
Lines 13-37:   ScoreBreakdown, ExtendedSkillData interfaces
Lines 39-124:  Class setup, createOrShow, constructor, dispose
Lines 128-189: Data loading methods
Lines 195-237: _getLoadingHtml method (loading spinner HTML)
Lines 239-257: _update, _isValidUrl, _getNonce methods
Lines 280-582: _getHtmlForWebview method (large HTML template)
Lines 584-608: _getTrustBadgeColor, _getTrustBadgeText methods
```

### Key Finding

The `_getHtmlForWebview()` method spans **302 lines** (lines 280-582), containing:
- CSS styles (~130 lines)
- HTML template (~120 lines)
- JavaScript for message handling (~25 lines)

### Splitting Recommendation

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `types.ts` | ScoreBreakdown, ExtendedSkillData | ~30 |
| `templates/styles.ts` | CSS string constant for webview | ~130 |
| `templates/skillDetail.ts` | HTML template generation function | ~150 |
| `templates/loading.ts` | Loading HTML template | ~45 |
| `SkillDetailPanel.ts` | Core class logic (imports templates) | ~260 |

### Alternative: Simpler Split

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `skillDetailTemplates.ts` | All HTML/CSS templates as functions | ~320 |
| `SkillDetailPanel.ts` | Core class logic | ~290 |

### Implementation Notes

1. VS Code webview HTML must be self-contained (no external CSS/JS files)
2. Template functions need skill data as parameters
3. Nonce for CSP must be passed to template functions
4. Consider using template literals in separate file for maintainability

---

## Priority 4: MemoryProfiler.ts (595 lines)

**Location**: `packages/core/src/benchmarks/MemoryProfiler.ts`
**Lines Over**: 95

### Current Structure Analysis

```
Lines 1-12:    Documentation and imports
Lines 17-36:   MemorySnapshot interface
Lines 40-58:   MemoryStats interface
Lines 62-74:   MemoryBaseline interface
Lines 78-92:   LeakDetectionResult interface
Lines 96-112:  MemoryRegressionResult interface
Lines 117-123: TrackingEntry interface (private)
Lines 146-589: MemoryProfiler class
Lines 594:     defaultMemoryProfiler export
```

### Splitting Recommendation

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `memoryTypes.ts` | MemorySnapshot, MemoryStats, MemoryBaseline, LeakDetectionResult, MemoryRegressionResult | ~100 |
| `MemoryProfiler.ts` | TrackingEntry (private), MemoryProfiler class | ~495 |

### Implementation Notes

1. Types are already exported and used by BenchmarkRunner
2. TrackingEntry is private to the class - keep in main file
3. After BenchmarkRunner is split, update its imports
4. Still 495 lines - close to limit but acceptable

---

## Priority 5: WebhookQueue.ts (555 lines)

**Location**: `packages/core/src/webhooks/WebhookQueue.ts`
**Lines Over**: 55

### Current Structure Analysis

```
Lines 1-11:    Documentation
Lines 14-19:   QueueItemType, QueuePriority types
Lines 24-79:   WebhookQueueItem interface
Lines 84-104:  QueueProcessResult interface
Lines 109-134: QueueStats interface
Lines 139-179: WebhookQueueOptions interface
Lines 184-188: PRIORITY_VALUES constant
Lines 193-553: WebhookQueue class
```

### Splitting Recommendation

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `queueTypes.ts` | QueueItemType, QueuePriority, WebhookQueueItem, QueueProcessResult, QueueStats, WebhookQueueOptions, PRIORITY_VALUES | ~180 |
| `WebhookQueue.ts` | WebhookQueue class only | ~380 |

### Implementation Notes

1. PRIORITY_VALUES could stay with class (used internally) or move to types
2. Types are referenced across webhook modules
3. Minimal refactoring needed

---

## Priority 6: SessionManager.ts (545 lines)

**Location**: `packages/core/src/session/SessionManager.ts`
**Lines Over**: 45

### Current Structure Analysis

```
Lines 1-11:    Documentation and imports
Lines 16-20:   MEMORY_KEYS constant
Lines 26-29:   validateMemoryKey function
Lines 34-49:   sanitizeSessionData function
Lines 54-68:   SessionOptions, MemoryResult interfaces
Lines 73-88:   CommandExecutor interface
Lines 94-149:  DefaultCommandExecutor class
Lines 164-543: SessionManager class
```

### Splitting Recommendation

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `types.ts` | SessionOptions, MemoryResult, CommandExecutor | ~40 |
| `DefaultCommandExecutor.ts` | DefaultCommandExecutor class | ~60 |
| `SessionManager.ts` | MEMORY_KEYS, validators, SessionManager class | ~450 |

### Alternative: Minimal Split

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `CommandExecutor.ts` | CommandExecutor interface + DefaultCommandExecutor class | ~100 |
| `SessionManager.ts` | Everything else | ~445 |

### Implementation Notes

1. DefaultCommandExecutor is a concrete implementation used by default
2. CommandExecutor interface enables test mocking
3. MEMORY_KEYS is private to session management - keep in main file

---

## Priority 7: webhook-endpoint.ts (511 lines)

**Location**: `packages/mcp-server/src/webhooks/webhook-endpoint.ts`
**Lines Over**: 11

### Current Structure Analysis

```
Lines 1-28:    Documentation and imports
Lines 32-49:   WebhookServerConfig interface
Lines 54-88:   WebhookServerOptions interface
Lines 93-103:  ServerStartOptions interface
Lines 108-113: RateLimiterState interface
Lines 120-184: Rate limiter functions (createRateLimiter, destroyRateLimiter, isRateLimited, getClientIp)
Lines 231-260: readBody, sendJson helper functions
Lines 265-280: WebhookServer interface
Lines 285-423: createWebhookServer function
Lines 428-457: startWebhookServer, stopWebhookServer functions
Lines 462-510: main function
```

### Splitting Recommendation

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `rateLimiter.ts` | RateLimiterState, createRateLimiter, destroyRateLimiter, isRateLimited, getClientIp | ~100 |
| `webhook-endpoint.ts` | Everything else | ~410 |

### Implementation Notes

1. Rate limiter is a cohesive unit with clear boundaries
2. getClientIp depends on WebhookServerConfig - interface should move or be imported
3. Only 11 lines over - lowest priority refactor

---

## Priority 8: WebhookPayload.ts (501 lines)

**Location**: `packages/core/src/webhooks/WebhookPayload.ts`
**Lines Over**: 1

### Current Structure Analysis

```
Lines 1-13:    Documentation and imports
Lines 18-195:  Type definitions (numerous interfaces)
Lines 200-259: SkillFileChange interface + helper types
Lines 254-335: isSkillFile, extractSkillChanges functions
Lines 340-468: Zod schemas (GitUserSchema, etc.)
Lines 473-500: parseWebhookPayload function
```

### Splitting Recommendation

Since only 1 line over, consider:

| New File | Contents | Est. Lines |
|----------|----------|------------|
| `payloadSchemas.ts` | All Zod schemas | ~130 |
| `WebhookPayload.ts` | Types, interfaces, utility functions | ~370 |

### Alternative: No Split

At 501 lines, this file is barely over the limit. Consider:
1. Minor refactoring to reduce by 2 lines (combine blank lines, etc.)
2. Accept 501 lines as within tolerance
3. Split only if other webhook changes are needed

### Implementation Notes

1. Zod schemas mirror TypeScript interfaces - natural split point
2. parseWebhookPayload uses schemas - keep together or import
3. Types are heavily interdependent - keep together

---

## Implementation Order

Recommended execution order based on impact and complexity:

### Phase 1: High Impact, Low Complexity
1. **scanner.ts** - Extract patterns to `scanner-config.ts`
2. **BenchmarkRunner.ts** - Extract types to `benchmarks/types.ts`

### Phase 2: Medium Impact
3. **MemoryProfiler.ts** - Extract types (coordinate with BenchmarkRunner)
4. **WebhookQueue.ts** - Extract types to `queueTypes.ts`
5. **SessionManager.ts** - Extract CommandExecutor

### Phase 3: VS Code Extension
6. **SkillDetailPanel.ts** - Extract HTML templates (more complex due to self-contained requirement)

### Phase 4: Low Priority
7. **webhook-endpoint.ts** - Extract rate limiter (only 11 lines over)
8. **WebhookPayload.ts** - Consider Zod schema extraction or minor refactor (only 1 line over)

---

## Testing Strategy

For each split:

1. **Before splitting**: Run full test suite to establish baseline
2. **After splitting**:
   - Verify all imports resolve correctly
   - Run typecheck: `docker exec skillsmith-dev-1 npm run typecheck`
   - Run tests: `docker exec skillsmith-dev-1 npm test`
   - Run lint: `docker exec skillsmith-dev-1 npm run lint`
3. **Update imports**: Search codebase for existing imports and update

---

## Estimated Effort

| File | Effort | Notes |
|------|--------|-------|
| BenchmarkRunner.ts | 1 hour | Straightforward type extraction |
| scanner.ts | 1 hour | Pattern extraction, update imports |
| SkillDetailPanel.ts | 2 hours | Template refactoring, testing webview |
| MemoryProfiler.ts | 30 min | Simple type extraction |
| WebhookQueue.ts | 30 min | Simple type extraction |
| SessionManager.ts | 45 min | Class extraction |
| webhook-endpoint.ts | 30 min | Utility extraction |
| WebhookPayload.ts | 15 min | Minimal change needed |

**Total Estimated Effort**: ~7 hours

---

## Notes

1. All new files should follow existing naming conventions (PascalCase for classes, camelCase for utilities)
2. Update barrel exports (`index.ts`) in each package after splitting
3. Consider creating ADR for this refactoring decision
4. Run `npm run audit:standards` after completion to verify compliance
