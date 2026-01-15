# Phase 4: Trigger System Architecture

**Status**: In Progress
**Epic**: SMI-XXX (Phase 4 Product Strategy)
**Author**: MCP Specialist
**Date**: 2025-12-31

## Overview

The Trigger System enables proactive skill suggestions based on user context, file patterns, commands, and project structure. It integrates with the existing CodebaseAnalyzer and recommendation engine to surface relevant skills at the right moment.

## Goals

1. **Context-Aware Suggestions**: Detect when users would benefit from a skill
2. **Non-Intrusive**: Suggest at most once per 5 minutes (rate-limited)
3. **High Relevance**: Score contexts to avoid noise
4. **Seamless Activation**: Enable one-click and zero-config skill installation

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Client (Claude)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ MCP Protocol
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    skill_suggest Tool                        │
│  - Rate limiting (max 1/5min)                               │
│  - Context scoring                                          │
│  - Skill recommendation                                     │
└─────────────────────────────────────────────────────────────┘
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│   TriggerDetector        │  │   ContextScorer          │
│  - File pattern triggers │  │  - Relevance scoring     │
│  - Command triggers      │  │  - Confidence calculation│
│  - Error triggers        │  │  - Threshold filtering   │
│  - Project triggers      │  └──────────────────────────┘
└──────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────┐
│                   CodebaseAnalyzer                            │
│  - Framework detection                                        │
│  - Dependency analysis                                        │
│  - File structure analysis                                    │
└──────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────┐
│                   SkillMatcher                                │
│  - Semantic similarity                                        │
│  - Quality scoring                                            │
│  - Overlap detection                                          │
└──────────────────────────────────────────────────────────────┘
```

## Trigger Types

### 1. File Pattern Triggers

Detect skill relevance based on file extensions and patterns.

**Examples:**
- `*.test.ts` → Suggest testing skills (Jest, Vitest)
- `docker-compose.yml` → Suggest Docker skills
- `.github/workflows/*.yml` → Suggest CI/CD skills

**Implementation:**
```typescript
interface FilePatternTrigger {
  pattern: string | RegExp;
  skillCategories: string[];
  confidence: number; // 0-1
}

const FILE_TRIGGERS: FilePatternTrigger[] = [
  {
    pattern: /\.test\.(ts|js|tsx|jsx)$/,
    skillCategories: ['testing', 'jest', 'vitest'],
    confidence: 0.9
  },
  {
    pattern: /docker-compose\.ya?ml$/,
    skillCategories: ['docker', 'devops'],
    confidence: 0.95
  }
];
```

### 2. Command Triggers

Detect skill relevance based on terminal commands or user actions.

**Examples:**
- User types "write tests" → Suggest testing skills
- User runs `git commit` → Suggest commit message skills
- User runs `npm test` → Suggest test-related skills

**Implementation:**
```typescript
interface CommandTrigger {
  command: string | RegExp;
  skillCategories: string[];
  confidence: number;
}

const COMMAND_TRIGGERS: CommandTrigger[] = [
  {
    command: /git\s+commit/,
    skillCategories: ['commit', 'git'],
    confidence: 0.85
  },
  {
    command: /npm\s+(test|run\s+test)/,
    skillCategories: ['testing', 'jest', 'vitest'],
    confidence: 0.8
  }
];
```

### 3. Error Triggers

Detect skill relevance based on error messages or stack traces.

**Examples:**
- ESLint error → Suggest eslint-config skill
- Docker build failure → Suggest docker-compose skill
- Test failure → Suggest testing helper skills

**Implementation:**
```typescript
interface ErrorTrigger {
  errorPattern: RegExp;
  skillCategories: string[];
  confidence: number;
}

const ERROR_TRIGGERS: ErrorTrigger[] = [
  {
    errorPattern: /ESLint.*error/i,
    skillCategories: ['linting', 'eslint'],
    confidence: 0.9
  },
  {
    errorPattern: /docker.*failed/i,
    skillCategories: ['docker', 'devops'],
    confidence: 0.85
  }
];
```

### 4. Project Structure Triggers

Detect skill relevance based on overall project structure.

**Examples:**
- React project detected → Suggest React component skills
- Monorepo structure → Suggest workspace management skills
- Prisma schema present → Suggest Prisma helper skills

**Implementation:**
```typescript
interface ProjectTrigger {
  detector: (context: CodebaseContext) => boolean;
  skillCategories: string[];
  confidence: number;
}

const PROJECT_TRIGGERS: ProjectTrigger[] = [
  {
    detector: (ctx) => ctx.frameworks.some(f => f.name === 'React'),
    skillCategories: ['react', 'frontend', 'components'],
    confidence: 0.95
  },
  {
    detector: (ctx) => ctx.dependencies.some(d => d.name === '@prisma/client'),
    skillCategories: ['prisma', 'database', 'orm'],
    confidence: 0.9
  }
];
```

## Context Scoring Algorithm

The ContextScorer evaluates trigger relevance using multiple signals:

```typescript
interface ContextScore {
  score: number;        // 0-1 overall relevance
  confidence: number;   // 0-1 confidence in suggestion
  triggers: string[];   // Which triggers fired
  reason: string;       // Human-readable explanation
}

function scoreContext(
  triggers: Trigger[],
  codebaseContext: CodebaseContext,
  recentCommands: string[]
): ContextScore {
  let totalScore = 0;
  let weights = 0;
  const firedTriggers: string[] = [];

  // File pattern scoring (weight: 0.4)
  const fileScore = evaluateFileTriggers(triggers, codebaseContext);
  if (fileScore > 0) {
    totalScore += fileScore * 0.4;
    weights += 0.4;
    firedTriggers.push('file-pattern');
  }

  // Command scoring (weight: 0.3)
  const commandScore = evaluateCommandTriggers(triggers, recentCommands);
  if (commandScore > 0) {
    totalScore += commandScore * 0.3;
    weights += 0.3;
    firedTriggers.push('command');
  }

  // Project structure scoring (weight: 0.3)
  const projectScore = evaluateProjectTriggers(triggers, codebaseContext);
  if (projectScore > 0) {
    totalScore += projectScore * 0.3;
    weights += 0.3;
    firedTriggers.push('project-structure');
  }

  const finalScore = weights > 0 ? totalScore / weights : 0;
  const confidence = calculateConfidence(firedTriggers.length, weights);

  return {
    score: finalScore,
    confidence,
    triggers: firedTriggers,
    reason: generateReason(firedTriggers, codebaseContext)
  };
}
```

### Thresholds

| Score Range | Action | Rationale |
|-------------|--------|-----------|
| 0.0 - 0.4   | No suggestion | Low relevance, would be noise |
| 0.4 - 0.6   | Suggest if no recent suggestions | Medium relevance |
| 0.6 - 1.0   | Always suggest (rate-limited) | High relevance |

## MCP Tool: skill_suggest

### Schema

```typescript
{
  name: 'skill_suggest',
  description: 'Proactively suggest relevant skills based on current context',
  inputSchema: {
    type: 'object',
    properties: {
      // Context inputs
      current_file: {
        type: 'string',
        description: 'Current file path being edited'
      },
      recent_commands: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recent terminal commands (last 5)'
      },
      project_path: {
        type: 'string',
        description: 'Root path of the project'
      },
      error_message: {
        type: 'string',
        description: 'Recent error message if any'
      },

      // Filters
      installed_skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Currently installed skill IDs'
      },
      limit: {
        type: 'number',
        default: 3,
        description: 'Maximum suggestions to return'
      }
    },
    required: ['project_path']
  }
}
```

### Rate Limiting

Use existing RateLimiter with strict preset:

```typescript
const suggestionLimiter = createRateLimiterFromPreset('STRICT', storage);
// STRICT = 10 requests per minute = ~1 per 6 seconds

// Per session rate limiting
const sessionKey = `session:${sessionId}`;
const result = await suggestionLimiter.checkLimit(sessionKey);

if (!result.allowed) {
  return {
    suggestions: [],
    rate_limited: true,
    retry_after_ms: result.retryAfterMs
  };
}
```

### Response Format

```typescript
interface SkillSuggestion {
  skill_id: string;
  name: string;
  reason: string;
  confidence: number;
  trigger_types: string[];
  quick_install_url?: string; // For one-click activation
}

interface SuggestResponse {
  suggestions: SkillSuggestion[];
  context_score: number;
  rate_limited: boolean;
  next_suggestion_at?: string; // ISO timestamp
  triggers_fired: string[];
}
```

## Integration with CodebaseAnalyzer

The TriggerDetector uses CodebaseAnalyzer to understand project structure:

```typescript
class TriggerDetector {
  constructor(
    private analyzer: CodebaseAnalyzer,
    private matcher: SkillMatcher
  ) {}

  async detectTriggers(
    projectPath: string,
    currentFile?: string,
    recentCommands: string[] = [],
    errorMessage?: string
  ): Promise<DetectedTrigger[]> {
    // Analyze codebase
    const context = await this.analyzer.analyze(projectPath, {
      maxFiles: 500,
      includeDevDeps: true
    });

    const triggers: DetectedTrigger[] = [];

    // File pattern triggers
    if (currentFile) {
      triggers.push(...this.detectFilePatternTriggers(currentFile));
    }

    // Command triggers
    if (recentCommands.length > 0) {
      triggers.push(...this.detectCommandTriggers(recentCommands));
    }

    // Error triggers
    if (errorMessage) {
      triggers.push(...this.detectErrorTriggers(errorMessage));
    }

    // Project structure triggers
    triggers.push(...this.detectProjectTriggers(context));

    return this.deduplicateAndRank(triggers);
  }
}
```

## One-Click Skill Activation

### Flow

1. **Pre-validation**: Validate skill before suggesting
2. **Prefetch**: Download skill metadata in background
3. **Hot-reload**: Activate without restarting Claude
4. **Undo**: Provide rollback if activation fails

```typescript
interface ActivationOptions {
  skill_id: string;
  validate_first: boolean;  // default: true
  hot_reload: boolean;      // default: true
  auto_configure: boolean;  // default: false (zero-config)
}

interface ActivationResult {
  success: boolean;
  skill_id: string;
  activation_time_ms: number;
  requires_restart: boolean;
  undo_token?: string;  // For rollback
  error?: string;
}
```

### Implementation Strategy

```typescript
class ActivationManager {
  async activateSkill(options: ActivationOptions): Promise<ActivationResult> {
    const startTime = performance.now();

    // 1. Pre-validation
    if (options.validate_first) {
      const validation = await this.validator.validate(options.skill_id);
      if (!validation.valid) {
        return {
          success: false,
          skill_id: options.skill_id,
          activation_time_ms: 0,
          requires_restart: false,
          error: validation.errors.join(', ')
        };
      }
    }

    // 2. Prefetch (if not cached)
    await this.prefetchSkill(options.skill_id);

    // 3. Install to ~/.claude/skills/
    const installPath = await this.installer.install(options.skill_id);

    // 4. Hot-reload (if supported)
    let requiresRestart = true;
    if (options.hot_reload) {
      const reloaded = await this.hotReload(installPath);
      requiresRestart = !reloaded;
    }

    // 5. Create undo token
    const undoToken = await this.createUndoSnapshot(options.skill_id);

    const endTime = performance.now();

    return {
      success: true,
      skill_id: options.skill_id,
      activation_time_ms: Math.round(endTime - startTime),
      requires_restart: requiresRestart,
      undo_token: undoToken
    };
  }
}
```

## Zero-Config Skill Activation

### Concept

Some skills require configuration (API keys, preferences). Zero-config activation defers configuration until first use.

### Skill Schema Extension

```yaml
# In SKILL.md frontmatter
config_required: true
config_defer: true  # NEW: Allow deferred configuration
config_defaults:    # NEW: Safe defaults
  api_endpoint: "https://api.example.com"
  timeout_ms: 5000
  retry_attempts: 3
```

### Activation Flow

```typescript
class ZeroConfigActivator {
  async activate(skillId: string): Promise<ActivationResult> {
    const skill = await this.repository.getSkill(skillId);

    if (!skill.config_required) {
      // No config needed, activate immediately
      return this.manager.activateSkill({ skill_id: skillId });
    }

    if (skill.config_defer) {
      // Install with defaults, prompt for config on first use
      return this.activateWithDefaults(skill);
    }

    // Config required upfront
    return {
      success: false,
      skill_id: skillId,
      activation_time_ms: 0,
      requires_restart: false,
      error: 'Configuration required. Run skill_configure first.'
    };
  }

  private async activateWithDefaults(skill: Skill): Promise<ActivationResult> {
    // Inject default values
    const configPath = path.join(
      homedir(),
      '.claude',
      'skills',
      skill.id,
      'config.json'
    );

    await fs.writeFile(
      configPath,
      JSON.stringify(skill.config_defaults, null, 2)
    );

    // Activate with defaults
    return this.manager.activateSkill({
      skill_id: skill.id,
      auto_configure: true
    });
  }
}
```

### Configuration Deferral System

When a skill is activated with defaults, show a notification on first use:

```typescript
// In skill activation handler
if (skill.activated_with_defaults && !skill.user_configured) {
  return {
    message: 'Using default configuration. Run /configure-skill to customize.',
    action_required: false,
    configure_url: `claude://skills/configure/${skill.id}`
  };
}
```

## Event Flow Diagram

```
User Context Change
      │
      ▼
┌─────────────────┐
│ Trigger         │
│ Detection       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Rate Limit      │◄──── Max 1 per 5 min
│ Check           │
└────────┬────────┘
         │ allowed
         ▼
┌─────────────────┐
│ Context         │
│ Scoring         │
└────────┬────────┘
         │
         ▼
  Score >= 0.6?
         │
    yes  │  no
         │  └──► No suggestion
         ▼
┌─────────────────┐
│ Skill           │
│ Recommendation  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ MCP             │
│ Notification    │
└────────┬────────┘
         │
         ▼
    User Action
         │
    ┌────┴────┐
    │         │
    ▼         ▼
 Accept    Dismiss
    │         │
    ▼         └──► Update preferences
One-Click
Activation
```

## Database Schema Changes

Add triggers and activation tracking tables:

```sql
-- Track trigger patterns and confidence
CREATE TABLE IF NOT EXISTS trigger_patterns (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('file', 'command', 'error', 'project')),
  pattern TEXT NOT NULL,
  skill_categories TEXT NOT NULL, -- JSON array
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Track suggestion history for rate limiting
CREATE TABLE IF NOT EXISTS suggestion_history (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  suggested_skills TEXT NOT NULL, -- JSON array
  context_score REAL NOT NULL,
  triggers_fired TEXT NOT NULL, -- JSON array
  user_action TEXT CHECK(user_action IN ('accepted', 'dismissed', 'ignored')),
  suggested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suggestion_session ON suggestion_history(session_id);
CREATE INDEX IF NOT EXISTS idx_suggestion_time ON suggestion_history(suggested_at);

-- Track skill activations for analytics
CREATE TABLE IF NOT EXISTS skill_activations (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  activation_type TEXT NOT NULL CHECK(activation_type IN ('manual', 'suggested', 'zero-config')),
  success INTEGER NOT NULL,
  activation_time_ms INTEGER,
  requires_restart INTEGER,
  activated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activation_skill ON skill_activations(skill_id);
CREATE INDEX IF NOT EXISTS idx_activation_time ON skill_activations(activated_at);
```

## Performance Considerations

### Caching Strategy

1. **CodebaseAnalyzer cache**: Cache analysis results for 5 minutes
2. **Trigger pattern cache**: Load trigger patterns once at startup
3. **Skill metadata cache**: Prefetch top 20 skills on server start
4. **Rate limit state**: In-memory with TTL cleanup

### Optimization

- Lazy load CodebaseAnalyzer only when project_path provided
- Debounce rapid file changes (analyze once per 30 seconds)
- Batch skill metadata fetches
- Use SQLite prepared statements for suggestion history

## Security Considerations

1. **Rate limiting**: Prevent suggestion spam
2. **Path validation**: Ensure project_path is within allowed directories
3. **Command sanitization**: Strip sensitive data from command logs
4. **Error message filtering**: Remove secrets from error triggers
5. **Activation validation**: Verify skill source before activation

## Testing Strategy

### Unit Tests

- TriggerDetector pattern matching
- ContextScorer algorithm correctness
- Rate limiter enforcement
- ActivationManager error handling

### Integration Tests

- End-to-end skill_suggest flow
- CodebaseAnalyzer integration
- Database persistence
- MCP protocol compliance

### Performance Tests

- Trigger detection latency (<100ms)
- Context scoring latency (<50ms)
- Activation time (<2 seconds)

## Rollout Plan

### Phase 1: Foundation (Week 1)
- [x] Architecture document
- [ ] TriggerDetector implementation
- [ ] ContextScorer implementation
- [ ] Unit tests

### Phase 2: MCP Integration (Week 2)
- [ ] skill_suggest tool implementation
- [ ] Rate limiting integration
- [ ] Database schema migration
- [ ] Integration tests

### Phase 3: Activation (Week 3)
- [ ] ActivationManager implementation
- [ ] One-click activation flow
- [ ] Undo/rollback system
- [ ] E2E tests

### Phase 4: Zero-Config (Week 4)
- [ ] ZeroConfigActivator implementation
- [ ] Default value injection
- [ ] Configuration deferral system
- [ ] User acceptance testing

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Suggestion relevance | >80% accept/ignore ratio | suggestion_history.user_action |
| Activation success rate | >95% | skill_activations.success |
| Avg activation time | <2 seconds | skill_activations.activation_time_ms |
| False positive rate | <10% dismissed | suggestion_history.user_action |
| Rate limit compliance | 100% | Rate limiter metrics |

## Future Enhancements

1. **Learning loop**: Adapt trigger confidence based on user feedback
2. **Skill bundles**: Suggest related skills as a package
3. **Cross-session learning**: Share trigger patterns across users (privacy-safe)
4. **A/B testing**: Experiment with different scoring algorithms
5. **Voice triggers**: "Hey Claude, what skills would help here?"

## References

- [ADR-010: Codebase Analysis Scope](../adr/010-codebase-analysis-scope.md)
- [SMI-602: Semantic Matching](https://linear.app/skillsmith/issue/SMI-602)
- [SMI-604: Overlap Detection](https://linear.app/skillsmith/issue/SMI-604)
- [Phase 2c Performance](../retros/phase-2c-performance-polish.md)
