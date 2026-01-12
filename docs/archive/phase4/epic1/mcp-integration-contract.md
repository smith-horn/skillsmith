# MCP Integration Contract - Learning Loop

**Epic**: Epic 1 - Contextual Recommendations
**Owner**: Data Scientist
**Integration Partner**: MCP Specialist
**Status**: Design Complete - Awaiting MCP Implementation
**Created**: 2025-12-31

## Overview

This document defines the integration contract between the **Recommendation Learning Loop** (Data Scientist) and the **MCP Skill Suggestion Protocol** (MCP Specialist).

The Learning Loop requires specific events and callbacks from the MCP layer to collect user interaction signals.

## Dependencies

The Learning Loop **REQUIRES** the following MCP Specialist implementations:

1. **Design Trigger System Architecture** (CRITICAL priority)
2. **Implement MCP Skill Suggestion Protocol** (CRITICAL priority)
3. **Implement One-Click Skill Activation** (HIGH priority)

## Required Events from MCP Layer

### Event 1: Skill Suggested

**When**: MCP server suggests a skill to the user (via trigger system)

**Event Data**:
```typescript
interface SkillSuggestedEvent {
  event: 'skill:suggested'
  data: {
    skill_id: string
    suggestion_id: string  // Unique ID for tracking
    context: {
      installed_skills: string[]
      project_context?: string
      trigger_type: 'file_pattern' | 'command' | 'error' | 'project_structure'
      trigger_detail: string
    }
    recommendation_score: number  // [0-1]
    trust_tier: 'verified' | 'community' | 'standard' | 'unverified'
    category: string
    timestamp: number
  }
}
```

**Learning Loop Action**: Store suggestion context for later signal correlation

---

### Event 2: Skill Accepted

**When**: User accepts the suggestion and skill is installed

**Event Data**:
```typescript
interface SkillAcceptedEvent {
  event: 'skill:accepted'
  data: {
    skill_id: string
    suggestion_id: string  // Links back to suggestion
    install_success: boolean
    time_to_decision_ms: number  // Time between suggestion and accept
    suggestion_count: number  // How many times this skill was suggested
    timestamp: number
  }
}
```

**Learning Loop Action**:
```typescript
await signalCollector.recordAccept(skillId, {
  installed_skills: originalContext.installed_skills,
  project_context: originalContext.project_context,
  original_score: originalContext.recommendation_score,
  trust_tier: originalContext.trust_tier,
  category: originalContext.category,
}, {
  time_to_action: time_to_decision_ms,
  suggestion_count: suggestion_count,
})
```

---

### Event 3: Skill Dismissed

**When**: User explicitly dismisses the suggestion

**Event Data**:
```typescript
interface SkillDismissedEvent {
  event: 'skill:dismissed'
  data: {
    skill_id: string
    suggestion_id: string
    reason?: 'not_relevant' | 'duplicate' | 'trust_issue' | 'too_complex' | 'other'
    time_to_decision_ms: number
    timestamp: number
  }
}
```

**Learning Loop Action**:
```typescript
await signalCollector.recordDismiss(skillId,
  originalContext,
  reason
)
```

---

### Event 4: Skill Used

**When**: Installed skill is actively used by the user

**Event Data**:
```typescript
interface SkillUsedEvent {
  event: 'skill:used'
  data: {
    skill_id: string
    usage_context: 'command' | 'trigger' | 'api' | 'unknown'
    timestamp: number
  }
}
```

**Learning Loop Action**:
```typescript
// Aggregate usage events to daily/weekly
const usageFrequency = await usageTracker.getFrequency(skillId)
await signalCollector.recordUsage(skillId, usageFrequency)
```

---

### Event 5: Skill Uninstalled

**When**: User removes a previously installed skill

**Event Data**:
```typescript
interface SkillUninstalledEvent {
  event: 'skill:uninstalled'
  data: {
    skill_id: string
    days_since_install: number
    total_uses: number
    timestamp: number
  }
}
```

**Learning Loop Action**:
```typescript
if (total_uses === 0 && days_since_install >= 30) {
  await signalCollector.recordAbandonment(skillId, days_since_install)
} else {
  await signalCollector.recordUninstall(skillId, days_since_install)
}
```

---

## Event Bus Integration

### Option A: MCP Server Event Emitter

```typescript
// In MCP Server
import { EventEmitter } from 'events'

export class SkillSuggestionService extends EventEmitter {
  async suggestSkill(skillId: string, context: TriggerContext) {
    // Show suggestion to user
    const suggestionId = await this.displaySuggestion(skillId, context)

    // Emit event for learning loop
    this.emit('skill:suggested', {
      skill_id: skillId,
      suggestion_id: suggestionId,
      context: context,
      // ... rest of data
    })
  }

  async handleAccept(suggestionId: string) {
    const suggestion = this.getSuggestion(suggestionId)

    // Install skill
    const success = await this.installSkill(suggestion.skill_id)

    // Emit event
    this.emit('skill:accepted', {
      skill_id: suggestion.skill_id,
      suggestion_id: suggestionId,
      install_success: success,
      // ... rest of data
    })
  }
}
```

### Option B: Direct Service Call

```typescript
// In MCP Server
import { SignalCollector } from '@skillsmith/core/learning'

export class SkillSuggestionService {
  private signalCollector: SignalCollector

  async handleAccept(suggestionId: string) {
    const suggestion = this.getSuggestion(suggestionId)
    const success = await this.installSkill(suggestion.skill_id)

    if (success) {
      // Direct call to learning loop
      await this.signalCollector.recordAccept(
        suggestion.skill_id,
        suggestion.context,
        { time_to_action: Date.now() - suggestion.suggested_at }
      )
    }
  }
}
```

**Recommendation**: Use **Option A** (Event Emitter) for better decoupling and testability.

---

## Usage Tracking Integration

The Learning Loop needs to know when installed skills are actually used.

### Required from Backend Specialist / Usage Tracker

```typescript
/**
 * Usage tracker service (to be implemented by Backend Specialist)
 */
export interface IUsageTracker {
  /**
   * Get skills used today
   */
  getSkillsUsedToday(): Promise<string[]>

  /**
   * Get usage frequency for a skill
   */
  getFrequency(skillId: string): Promise<'daily' | 'weekly' | 'never'>

  /**
   * Get total uses for a skill
   */
  getTotalUses(skillId: string): Promise<number>

  /**
   * Get days since installation
   */
  getDaysSinceInstall(skillId: string): Promise<number>
}
```

### Background Job Integration

The Learning Loop will run a daily cron job to collect usage signals:

```typescript
// Run daily at midnight
async function collectDailyUsageSignals() {
  const usageTracker = new UsageTracker()
  const signalCollector = new SignalCollector(dbPath)

  const usedToday = await usageTracker.getSkillsUsedToday()

  for (const skillId of usedToday) {
    const frequency = await usageTracker.getFrequency(skillId)
    await signalCollector.recordUsage(skillId, frequency)
  }

  // Check for abandoned skills (installed 30+ days ago, never used)
  const installedSkills = await getInstalledSkills()
  for (const skillId of installedSkills) {
    const daysSinceInstall = await usageTracker.getDaysSinceInstall(skillId)
    const totalUses = await usageTracker.getTotalUses(skillId)

    if (daysSinceInstall >= 30 && totalUses === 0) {
      await signalCollector.recordAbandonment(skillId, daysSinceInstall)
    }
  }
}
```

---

## Personalization Feedback Loop

Once signals are collected, the Learning Loop provides **personalized scores** back to the recommendation system.

### Integration with `skill_recommend` Tool

**Before Learning Loop**:
```typescript
// packages/mcp-server/src/tools/recommend.ts
export async function executeRecommend(input: RecommendInput) {
  // ... semantic matching ...
  const results = await matcher.findSimilarSkills(query, candidates, limit)
  return formatResponse(results)  // Returns base scores
}
```

**After Learning Loop** (Personalization Applied):
```typescript
// packages/mcp-server/src/tools/recommend.ts
import { PersonalizationEngine } from '@skillsmith/core/learning'

export async function executeRecommend(input: RecommendInput) {
  // ... semantic matching ...
  const baseResults = await matcher.findSimilarSkills(query, candidates, limit)

  // Apply personalization
  const personalizationEngine = new PersonalizationEngine(learner, profileStore)
  const shouldPersonalize = await personalizationEngine.shouldPersonalize()

  if (shouldPersonalize) {
    const personalizedResults = await personalizationEngine.personalizeRecommendations(
      baseResults.map(r => ({
        skill_id: r.skill.id,
        base_score: r.similarityScore,
        skill_data: {
          category: r.skill.category,
          trustTier: r.skill.trustTier,
          keywords: r.skill.keywords,
        }
      }))
    )

    return formatPersonalizedResponse(personalizedResults)
  }

  return formatResponse(baseResults)  // Fallback to base scores
}
```

---

## Data Flow Diagram

```
┌─────────────────┐
│  MCP Server     │
│  (Specialist)   │
└────────┬────────┘
         │
         │ Events:
         │ - skill:suggested
         │ - skill:accepted
         │ - skill:dismissed
         │ - skill:used
         │ - skill:uninstalled
         │
         v
┌─────────────────────┐
│  SignalCollector    │
│  (Learning Loop)    │
└────────┬────────────┘
         │
         │ Stores in
         v
┌─────────────────────┐
│  SQLite Database    │
│  (signal_events)    │
└────────┬────────────┘
         │
         │ Reads for
         v
┌─────────────────────┐
│  PreferenceLearner  │
│  (Learning Loop)    │
└────────┬────────────┘
         │
         │ Updates
         v
┌─────────────────────┐
│  UserProfile        │
│  (Learned Weights)  │
└────────┬────────────┘
         │
         │ Used by
         v
┌──────────────────────┐
│ PersonalizationEngine│
│ (Learning Loop)      │
└────────┬─────────────┘
         │
         │ Boosts/penalizes
         v
┌─────────────────────┐
│  skill_recommend    │
│  (MCP Tool)         │
└─────────────────────┘
```

---

## Testing Requirements

### Unit Tests (Learning Loop)

- Signal collection writes to database correctly
- Preference learning updates weights accurately
- Personalization scoring applies weights correctly
- Privacy manager purges old data

### Integration Tests (with MCP Layer)

1. **Happy Path**: Suggest → Accept → Use → Boost Score
2. **Negative Path**: Suggest → Dismiss → Penalize Score
3. **Abandonment Path**: Accept → Never Use → Penalize Score
4. **Uninstall Path**: Accept → Use → Uninstall → Strong Penalty

### Example Integration Test

```typescript
describe('Learning Loop Integration', () => {
  it('should boost category after accept and usage', async () => {
    // 1. MCP suggests a testing skill
    mcp.emit('skill:suggested', {
      skill_id: 'community/jest-helper',
      context: { installed_skills: [], original_score: 0.7 },
      category: 'testing',
      // ...
    })

    // 2. User accepts
    mcp.emit('skill:accepted', {
      skill_id: 'community/jest-helper',
      // ...
    })

    // 3. User uses it daily
    mcp.emit('skill:used', {
      skill_id: 'community/jest-helper',
      // ...
    })

    // 4. Check profile weights
    const profile = await profileStore.getProfile()
    expect(profile.category_weights['testing']).toBeGreaterThan(0.5)

    // 5. Next recommendation should boost testing skills
    const results = await executeRecommend({
      installed_skills: ['community/jest-helper'],
      limit: 5
    })

    const testingSkills = results.recommendations.filter(r =>
      r.skill_data.category === 'testing'
    )
    expect(testingSkills[0].personalized_score).toBeGreaterThan(
      testingSkills[0].base_score
    )
  })
})
```

---

## Migration Path

### Phase 1: MCP Events Ready (Week 1-2)
- MCP Specialist implements event emitter
- Learning Loop implements signal collector (passive listening)
- No personalization yet, just data collection

### Phase 2: Learning Active (Week 3)
- Preference learner processes signals
- Profile weights updated
- Still no personalization applied to recommendations

### Phase 3: Personalization Live (Week 4)
- PersonalizationEngine integrated into `skill_recommend`
- A/B testing framework enabled
- Monitor impact on accept rate and utilization

---

## Open Questions for MCP Specialist

1. **Suggestion ID Format**: What format for `suggestion_id`? UUID? Timestamp-based?
2. **Rate Limiting**: Should Learning Loop respect the "max 1 suggestion per 5 min" limit?
3. **Suggestion Context Storage**: Should MCP layer cache suggestion context or pass it in accept/dismiss events?
4. **Usage Events**: Should usage be tracked per-invocation or aggregated daily?
5. **Error Handling**: What happens if Learning Loop fails to record signal? Silent fail or notify user?

---

## Contact

**Data Scientist**: Available for integration support
**Status**: Awaiting MCP Specialist completion of:
  - Trigger System Architecture
  - Skill Suggestion Protocol
  - One-Click Activation

Once these are complete, integration can proceed immediately with this contract as the specification.
