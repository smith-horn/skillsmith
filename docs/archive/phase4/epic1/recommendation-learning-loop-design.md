# Recommendation Learning Loop - Architecture Design

**Epic**: Epic 1 - Contextual Recommendations - Skills Find Users
**Owner**: Data Scientist
**Status**: Design Complete - Awaiting Dependencies
**Dependencies**: Trigger System Architecture, MCP Skill Suggestion Protocol, One-Click Activation
**Created**: 2025-12-31

## Executive Summary

The Recommendation Learning Loop enables Skillsmith to learn from user interactions (accept/dismiss/usage) and improve recommendation quality over time. This system implements privacy-preserving, per-user preference learning with transparent weight adjustment algorithms.

### Key Features

- **Signal Collection**: Capture accept, dismiss, and usage events
- **Privacy-First**: Local-only storage, no external data transmission
- **Adaptive Learning**: Adjust recommendation weights based on user feedback
- **Transparent**: Explainable scoring with user visibility
- **Ephemeral**: Optional time-decay for evolving preferences

## System Architecture

### 1. Signal Collection System

#### 1.1 Signal Types

```typescript
/**
 * User interaction signals for recommendation learning
 */
export enum SignalType {
  /** User accepted and installed recommended skill */
  ACCEPT = 'accept',
  /** User explicitly dismissed recommendation */
  DISMISS = 'dismiss',
  /** User actively uses installed skill (daily usage) */
  USAGE_DAILY = 'usage_daily',
  /** User rarely uses installed skill (weekly usage) */
  USAGE_WEEKLY = 'usage_weekly',
  /** Skill installed but never used (30+ days) */
  ABANDONED = 'abandoned',
  /** User uninstalled previously accepted skill */
  UNINSTALL = 'uninstall',
}

/**
 * Signal strength for learning algorithm
 */
export const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  [SignalType.ACCEPT]: 0.5,           // Moderate positive signal
  [SignalType.DISMISS]: -0.3,         // Moderate negative signal
  [SignalType.USAGE_DAILY]: 1.0,      // Strong positive signal
  [SignalType.USAGE_WEEKLY]: 0.3,     // Weak positive signal
  [SignalType.ABANDONED]: -0.7,       // Strong negative signal
  [SignalType.UNINSTALL]: -1.0,       // Very strong negative signal
}
```

#### 1.2 Signal Event Schema

```typescript
/**
 * Individual signal event stored in local database
 */
export interface SignalEvent {
  /** Unique event ID */
  id: string
  /** Signal type */
  type: SignalType
  /** Skill that was recommended/interacted with */
  skill_id: string
  /** Unix timestamp of event */
  timestamp: number
  /** Recommendation context when skill was suggested */
  context: {
    /** Skills installed at recommendation time */
    installed_skills: string[]
    /** Project context used for recommendation */
    project_context?: string
    /** Similarity score at recommendation time */
    original_score: number
  }
  /** Optional metadata */
  metadata?: {
    /** Time between recommendation and action (ms) */
    time_to_action?: number
    /** Number of times skill was suggested before action */
    suggestion_count?: number
  }
}
```

#### 1.3 Signal Collection API

```typescript
/**
 * Service for collecting user interaction signals
 */
export class SignalCollector {
  /**
   * Record user accepting a recommendation
   */
  async recordAccept(
    skillId: string,
    context: RecommendationContext,
    metadata?: SignalMetadata
  ): Promise<void>

  /**
   * Record user dismissing a recommendation
   */
  async recordDismiss(
    skillId: string,
    context: RecommendationContext,
    reason?: DismissReason
  ): Promise<void>

  /**
   * Record skill usage event (called by usage tracker)
   */
  async recordUsage(
    skillId: string,
    frequency: 'daily' | 'weekly'
  ): Promise<void>

  /**
   * Batch query signals for analysis
   */
  async getSignals(
    filter: SignalFilter,
    limit?: number
  ): Promise<SignalEvent[]>
}
```

### 2. Per-User Preference Model

#### 2.1 User Profile Schema

```typescript
/**
 * User-specific preference profile (local storage only)
 */
export interface UserPreferenceProfile {
  /** Profile version for migrations */
  version: number
  /** Last updated timestamp */
  last_updated: number
  /** Total signals collected */
  signal_count: number

  /** Category preferences learned from signals */
  category_weights: Record<SkillCategory, number>

  /** Trust tier preferences */
  trust_tier_weights: Record<TrustTier, number>

  /** Keyword/tag preferences */
  keyword_weights: Record<string, number>

  /** Anti-preferences (things user consistently dismisses) */
  negative_patterns: {
    keywords: string[]
    categories: SkillCategory[]
    skill_ids: string[]  // Specific skills user doesn't want
  }

  /** Usage pattern insights */
  usage_patterns: {
    /** Average time from install to first use */
    avg_time_to_first_use_ms: number
    /** Percentage of accepted skills actually used */
    utilization_rate: number
    /** Most used skill categories */
    top_categories: SkillCategory[]
  }
}
```

#### 2.2 Preference Learning Algorithm

```typescript
/**
 * Learns user preferences from signal events
 */
export class PreferenceLearner {
  /**
   * Update user profile based on new signal
   */
  async updateProfile(
    profile: UserPreferenceProfile,
    signal: SignalEvent
  ): Promise<UserPreferenceProfile>

  /**
   * Calculate category weight adjustment
   */
  private adjustCategoryWeight(
    currentWeight: number,
    signalType: SignalType,
    learningRate: number
  ): number

  /**
   * Extract keywords from skill for pattern learning
   */
  private extractKeywords(skill: SkillData): string[]

  /**
   * Decay old weights over time (optional)
   */
  async decayWeights(
    profile: UserPreferenceProfile,
    decayFactor: number
  ): Promise<UserPreferenceProfile>
}
```

#### 2.3 Learning Rate Configuration

```typescript
/**
 * Learning hyperparameters (tunable)
 */
export interface LearningConfig {
  /** Base learning rate for weight updates (default: 0.1) */
  learning_rate: number

  /** Time decay factor for old signals (default: 0.95/month) */
  decay_factor: number

  /** Minimum signals before personalization kicks in */
  min_signals_threshold: number

  /** Weight clipping bounds */
  weight_bounds: {
    min: number  // default: -2.0
    max: number  // default: 2.0
  }
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  learning_rate: 0.1,
  decay_factor: 0.95,
  min_signals_threshold: 5,
  weight_bounds: { min: -2.0, max: 2.0 },
}
```

### 3. Privacy-Preserving Storage Architecture

#### 3.1 Local-Only Storage

All user data stored locally in SQLite database, never transmitted externally.

**Database Schema**:

```sql
-- Signal events table
CREATE TABLE signal_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  context_json TEXT NOT NULL,
  metadata_json TEXT,
  INDEX idx_skill_id (skill_id),
  INDEX idx_timestamp (timestamp),
  INDEX idx_type (type)
);

-- User preference profile (singleton table)
CREATE TABLE user_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Only one row allowed
  version INTEGER NOT NULL,
  last_updated INTEGER NOT NULL,
  profile_json TEXT NOT NULL
);

-- Aggregated statistics (for analytics, no PII)
CREATE TABLE aggregate_stats (
  date TEXT PRIMARY KEY,  -- YYYY-MM-DD
  total_signals INTEGER,
  accept_count INTEGER,
  dismiss_count INTEGER,
  usage_count INTEGER,
  stats_json TEXT
);
```

#### 3.2 Data Lifecycle Management

```typescript
/**
 * Manages data retention and privacy
 */
export class PrivacyManager {
  /**
   * Purge signals older than retention period
   * Default: 90 days
   */
  async purgeOldSignals(retentionDays: number): Promise<number>

  /**
   * Export user data (GDPR-style)
   */
  async exportUserData(): Promise<UserDataExport>

  /**
   * Complete data wipe (user request)
   */
  async wipeAllData(): Promise<void>

  /**
   * Anonymize signals for aggregate analysis
   */
  async anonymizeForAnalytics(): Promise<AggregateStats>
}
```

#### 3.3 Privacy Guarantees

1. **Local-Only**: All data stored in `~/.skillsmith/learning.db`
2. **No Telemetry**: Zero external data transmission
3. **User Control**: Full export and wipe capabilities
4. **Anonymization**: Optional aggregate stats have no PII
5. **Transparency**: Schema and algorithms publicly documented

### 4. Recommendation Weight Adjustment Algorithm

#### 4.1 Personalized Scoring Formula

**Base Recommendation Score** (from existing system):
```
base_score = (similarity_score × 0.7) + (quality_score × 0.3)
```

**Personalized Adjustment** (with learning):
```typescript
/**
 * Calculate personalized recommendation score
 */
function calculatePersonalizedScore(
  skill: SkillData,
  baseScore: number,
  profile: UserPreferenceProfile
): number {
  // Category boost/penalty
  const categoryWeight = profile.category_weights[skill.category] ?? 0
  const categoryBoost = categoryWeight * 0.2  // Max ±0.4 adjustment

  // Trust tier boost/penalty
  const trustWeight = profile.trust_tier_weights[skill.trustTier] ?? 0
  const trustBoost = trustWeight * 0.1  // Max ±0.2 adjustment

  // Keyword matching boost
  const keywordBoost = calculateKeywordBoost(skill, profile)  // Max +0.3

  // Anti-pattern penalty
  const antiPenalty = calculateAntiPenalty(skill, profile)  // Max -1.0

  // Final score (clamped to [0, 1])
  const personalizedScore = Math.max(0, Math.min(1,
    baseScore + categoryBoost + trustBoost + keywordBoost + antiPenalty
  ))

  return personalizedScore
}
```

#### 4.2 Weight Update Rules

**Accept Signal**:
```typescript
// Boost category weight
category_weights[skill.category] += learning_rate * 0.5

// Boost trust tier
trust_tier_weights[skill.trustTier] += learning_rate * 0.3

// Learn positive keywords
for (const keyword of skill.keywords) {
  keyword_weights[keyword] += learning_rate * 0.2
}
```

**Dismiss Signal**:
```typescript
// Penalize category slightly
category_weights[skill.category] -= learning_rate * 0.3

// Add to negative patterns if dismissed multiple times
if (dismissCount[skill.id] >= 2) {
  negative_patterns.skill_ids.push(skill.id)
  negative_patterns.keywords.push(...skill.triggerPhrases)
}
```

**Usage Signal** (Daily):
```typescript
// Strong boost to category
category_weights[skill.category] += learning_rate * 1.0

// Learn keywords very positively
for (const keyword of skill.keywords) {
  keyword_weights[keyword] += learning_rate * 0.5
}

// Update usage patterns
usage_patterns.top_categories.push(skill.category)
```

**Abandoned Signal**:
```typescript
// Strong penalty to category
category_weights[skill.category] -= learning_rate * 0.7

// Reduce trust in this trust tier
trust_tier_weights[skill.trustTier] -= learning_rate * 0.3

// Mark for potential filtering
negative_patterns.skill_ids.push(skill.id)
```

#### 4.3 Cold Start Strategy

For users with < 5 signals, use **popularity-weighted defaults**:

```typescript
/**
 * Default weights before personalization
 */
const COLD_START_WEIGHTS = {
  category_weights: {
    'testing': 0.3,        // Testing skills popular
    'git': 0.3,            // Git skills popular
    'documentation': 0.1,  // Docs less popular
    // etc.
  },
  trust_tier_weights: {
    'verified': 0.2,       // Slight preference for verified
    'community': 0.0,
    'standard': -0.1,
    'unverified': -0.3,
  },
}
```

### 5. Integration Points

#### 5.1 MCP Tool Integration

**Modified `skill_recommend` tool**:

```typescript
/**
 * Enhanced recommendation with personalization
 */
export async function executeRecommend(
  input: RecommendInput,
  context?: ToolContext
): Promise<RecommendResponse> {
  // ... existing code ...

  // Load user preference profile
  const profile = await preferenceStore.getUserProfile()

  // Apply personalized scoring
  const personalizedResults = matchResults.map(result => {
    const personalizedScore = calculatePersonalizedScore(
      result.skill,
      result.similarityScore,
      profile
    )

    return {
      ...result,
      personalizedScore,
      personalizationApplied: profile.signal_count >= 5,
    }
  })

  // Re-sort by personalized score
  personalizedResults.sort((a, b) =>
    b.personalizedScore - a.personalizedScore
  )

  // Return top N
  return formatResponse(personalizedResults)
}
```

#### 5.2 Signal Collection Hooks

**Accept Signal** (from MCP Specialist's one-click activation):
```typescript
// In skill activation handler
await signalCollector.recordAccept(skillId, {
  installed_skills: currentlyInstalled,
  project_context: detectedContext,
  original_score: recommendation.similarity_score,
})
```

**Dismiss Signal** (from MCP Specialist's suggestion protocol):
```typescript
// In dismiss handler
await signalCollector.recordDismiss(skillId, context, dismissReason)
```

**Usage Signal** (from existing usage tracker):
```typescript
// Daily background job
const usedToday = await usageTracker.getSkillsUsedToday()
for (const skillId of usedToday) {
  await signalCollector.recordUsage(skillId, 'daily')
}
```

#### 5.3 Dependency Requirements

**From MCP Specialist**:

1. **Trigger System**: Event hooks for skill suggestion moments
2. **Suggestion Protocol**: Accept/dismiss action callbacks
3. **One-Click Activation**: Post-install success/failure callback
4. **Usage Tracker**: Daily/weekly usage event stream

**Data Contract**:
```typescript
/**
 * Events emitted by MCP Specialist components
 */
export interface MCPEvents {
  'skill:suggested': {
    skill_id: string
    context: RecommendationContext
    score: number
  }

  'skill:accepted': {
    skill_id: string
    context: RecommendationContext
    install_success: boolean
  }

  'skill:dismissed': {
    skill_id: string
    context: RecommendationContext
    reason?: string
  }

  'skill:used': {
    skill_id: string
    timestamp: number
  }
}
```

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1)

1. Create SQLite schema for signal storage
2. Implement `SignalCollector` service
3. Implement `UserPreferenceProfile` storage
4. Add database migrations

### Phase 2: Learning Algorithm (Week 2)

1. Implement `PreferenceLearner` with weight update logic
2. Implement personalized scoring in `recommend.ts`
3. Add cold start strategy
4. Write comprehensive unit tests

### Phase 3: Privacy & Integration (Week 3)

1. Implement `PrivacyManager` with data lifecycle
2. Add export/wipe functionality
3. Integrate with MCP Specialist's event system
4. Add usage tracking integration

### Phase 4: Validation & Tuning (Week 4)

1. A/B testing framework for learning rate tuning
2. Recommendation quality metrics
3. User feedback collection
4. Performance optimization

## Success Metrics

1. **Recommendation Relevance**: 30% improvement in accept rate after 10 signals
2. **Utilization Rate**: 70% of accepted skills used within 7 days
3. **Dismiss Rate**: 20% reduction in dismissals after 20 signals
4. **Performance**: < 50ms personalization overhead
5. **Privacy**: Zero external data transmission (verified by audit)

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Cold start problem | Use popularity-weighted defaults |
| Overfitting to recent signals | Implement time decay |
| Privacy concerns | Local-only storage + full transparency |
| Performance overhead | Caching + lazy updates |
| Sparse signal data | Graceful fallback to base scoring |

## Open Questions

1. Should we implement federated learning for aggregate insights?
2. What's the optimal retention period for signals? (Recommend: 90 days)
3. Should learning be opt-in or opt-out? (Recommend: opt-out with transparency)
4. How to handle skill version updates in signal tracking?

## References

- Epic 1 Sub-issue: "Build Recommendation Learning Loop"
- Related: `packages/mcp-server/src/tools/recommend.ts`
- Related: `packages/core/src/matching/SkillMatcher.ts`
- Dependency: MCP Specialist's Trigger System Architecture
- Dependency: MCP Specialist's Skill Suggestion Protocol
