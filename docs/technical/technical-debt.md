# Technical Debt Tracking

> **Navigation**: [Technical Index](./index.md) | [Overview](./overview.md)

Based on VP Engineering review.

---

## Current Technical Debt

| Debt Item | Priority | Estimated Effort | Impact if Unaddressed |
|-----------|----------|------------------|----------------------|
| No abstraction layer for Claude Code | High | 2 weeks | Breaking changes require full refactor |
| Hardcoded quality weights | Medium | 3 days | Cannot tune based on feedback |
| No structured error handling | High | 1 week | Poor debugging, silent failures |
| No observability infrastructure | High | 1 week | Blind to production issues |
| Monolithic MCP servers | Low | 2 weeks | Code duplication, maintenance burden |

---

## Mitigation Plans

### Abstraction Layer for Claude Code

**Priority:** High
**Estimated Effort:** 2 weeks

```typescript
// Proposed abstraction
interface ClaudeCodeAdapter {
  // Skill discovery
  listInstalledSkills(): Promise<InstalledSkill[]>;
  getSkillContent(path: string): Promise<string>;

  // Skill management
  installSkill(source: string, target: string): Promise<void>;
  uninstallSkill(path: string): Promise<void>;

  // Configuration
  getSettings(): Promise<ClaudeSettings>;
  updateSettings(updates: Partial<ClaudeSettings>): Promise<void>;

  // Hooks
  addHook(hook: Hook): Promise<void>;
  removeHook(hookId: string): Promise<void>;
}

// Implementation can change without affecting consumers
class ClaudeCodeAdapterV1 implements ClaudeCodeAdapter {
  // Current implementation
}

class ClaudeCodeAdapterV2 implements ClaudeCodeAdapter {
  // Future implementation when Claude Code changes
}
```

**Benefits:**
- Isolate Claude Code dependencies
- Easy to adapt when Claude Code changes
- Enables mocking for testing

---

### Configurable Quality Weights

**Priority:** Medium
**Estimated Effort:** 3 days

```typescript
// Store weights in configuration
interface QualityConfig {
  version: string;
  weights: ScoringWeights;
  tier_thresholds: TierThresholds;
}

// Load from file, allow override
const config = loadConfig('~/.claude-discovery/config/scoring.yaml');
```

**Example config file:**

```yaml
version: "1.0"
weights:
  quality: 0.30
  popularity: 0.35
  maintenance: 0.35
  quality_components:
    readme_score: 0.25
    skillmd_score: 0.30
    has_license: 0.20
    has_tests: 0.15
    has_examples: 0.10

tier_thresholds:
  gold: 0.8
  silver: 0.6
  bronze: 0.4
```

**Benefits:**
- Tune weights based on user feedback
- A/B testing of scoring algorithms
- Per-user customization possible

---

### Structured Error Handling

**Priority:** High
**Estimated Effort:** 1 week

```typescript
// Custom error classes
class DiscoveryError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, any>,
    public recovery?: string[]
  ) {
    super(message);
  }
}

class SkillNotFoundError extends DiscoveryError {
  constructor(skillId: string) {
    super(
      'SKILL_NOT_FOUND',
      `Skill '${skillId}' not found`,
      { skill_id: skillId },
      ['Check skill ID spelling', 'Search for skill by name']
    );
  }
}

// Centralized error handler
function handleError(error: Error, context: ErrorContext): ErrorResponse {
  if (error instanceof DiscoveryError) {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        recovery_suggestions: error.recovery,
      },
    };
  }

  // Unknown error - log and return generic
  logger.error('Unexpected error', { error, context });
  return {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  };
}
```

**Benefits:**
- Consistent error format
- Better debugging information
- User-friendly recovery suggestions

---

### Observability Infrastructure

**Priority:** High
**Estimated Effort:** 1 week

See [Observability](./observability.md) for full implementation.

**Components:**
- Structured logging
- Metrics collection (Prometheus format)
- Error aggregation
- Health checks
- Debug mode

**Benefits:**
- Visibility into production issues
- Performance monitoring
- Proactive alerting

---

## Debt Payment Schedule

| Phase | Debt Items to Address |
|-------|----------------------|
| Phase 1 | Error handling patterns, basic logging |
| Phase 2 | Abstraction layer, configurable weights |
| Phase 3 | Full observability |
| Phase 4+ | Refactor MCP servers if needed |

---

## Debt Prevention Practices

### Code Review Checklist

- [ ] Error handling uses standard patterns
- [ ] Configuration uses abstraction layer
- [ ] Logging follows structured format
- [ ] Tests cover edge cases
- [ ] No hardcoded values for tunable parameters

### Technical Debt Reviews

- Monthly review of debt backlog
- Track debt:feature ratio
- Allocate 20% of sprint to debt reduction

---

## Metrics

Track debt over time:

```typescript
interface DebtMetrics {
  total_items: number;
  by_priority: Record<'high' | 'medium' | 'low', number>;
  estimated_effort_days: number;
  addressed_this_quarter: number;
  added_this_quarter: number;
}
```

---

## Related Documentation

- [Decisions](./decisions.md) - Decision rationale
- [Open Questions](./open-questions.md) - Unresolved items
- [Testing](./testing.md) - Test coverage for debt mitigation

---

*Back to: [Technical Index](./index.md)*
