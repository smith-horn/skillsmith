# Recommendation Learning Loop

**Epic 1 - Sub-issue 5**: Build Recommendation Learning Loop
**Owner**: Data Scientist
**Status**: Design Complete - Ready for Implementation
**Dependencies**: MCP Trigger System, Skill Suggestion Protocol, One-Click Activation

## Overview

The Recommendation Learning Loop enables Skillsmith to learn from user interactions and improve recommendation quality over time through privacy-preserving, local-only preference learning.

## Features

- **Signal Collection**: Capture accept, dismiss, and usage events
- **Adaptive Learning**: Adjust recommendation weights based on user feedback
- **Privacy-First**: All data stored locally, no external transmission
- **Transparent**: Explainable scoring with full user visibility
- **Ephemeral**: Time-decay for evolving preferences

## Architecture

```
SignalCollector → SQLite → PreferenceLearner → UserProfile → PersonalizationEngine → Enhanced Recommendations
```

### Core Components

| Component | Purpose | File |
|-----------|---------|------|
| `SignalCollector` | Record user interactions | `SignalCollector.ts` (TBD) |
| `PreferenceLearner` | Learn from signals | `PreferenceLearner.ts` (TBD) |
| `PersonalizationEngine` | Apply learned weights | `PersonalizationEngine.ts` (TBD) |
| `PrivacyManager` | Data lifecycle | `PrivacyManager.ts` (TBD) |

## Signal Types

| Signal | Weight | Trigger |
|--------|--------|---------|
| **ACCEPT** | +0.5 | User installs recommended skill |
| **DISMISS** | -0.3 | User explicitly rejects recommendation |
| **USAGE_DAILY** | +1.0 | Skill used daily |
| **USAGE_WEEKLY** | +0.3 | Skill used weekly |
| **ABANDONED** | -0.7 | Installed 30+ days, never used |
| **UNINSTALL** | -1.0 | User removes skill |

## Data Storage

**Location**: `~/.skillsmith/learning.db` (SQLite)

**Tables**:
- `signal_events` - User interaction events
- `user_profile` - Learned preference weights
- `aggregate_stats` - Anonymized statistics

**Privacy Guarantees**:
- Local-only storage
- No external transmission
- Full export/wipe capability
- 90-day retention (configurable)

## Usage Example

```typescript
import { SignalCollector, PreferenceLearner, PersonalizationEngine } from '@skillsmith/core/learning'

// 1. Record user accepting a recommendation
const collector = new SignalCollector(dbPath)
await collector.recordAccept('anthropic/commit', {
  installed_skills: ['anthropic/review-pr'],
  original_score: 0.85,
  category: 'git',
})

// 2. Learn from signals
const learner = new PreferenceLearner(config)
const profile = await learner.updateProfile(currentProfile, signal)

// 3. Apply personalization to recommendations
const engine = new PersonalizationEngine(learner, profileStore)
const personalized = await engine.personalizeRecommendations(baseResults)

console.log(personalized[0].personalized_score) // 0.92 (boosted from 0.85)
```

## Integration with MCP Layer

The Learning Loop listens to events from the MCP Skill Suggestion Protocol:

```typescript
// MCP Server emits events
mcp.on('skill:suggested', async (event) => {
  // Store suggestion context
})

mcp.on('skill:accepted', async (event) => {
  await collector.recordAccept(event.skill_id, event.context)
})

mcp.on('skill:dismissed', async (event) => {
  await collector.recordDismiss(event.skill_id, event.context, event.reason)
})

mcp.on('skill:used', async (event) => {
  await collector.recordUsage(event.skill_id, 'daily')
})
```

See [MCP Integration Contract](../../../docs/phase4/epic1/mcp-integration-contract.md) for full details.

## Learning Algorithm

### Weight Update Formula

```
new_weight = old_weight + (learning_rate * signal_weight)
```

**Clipping**: Weights bounded to [-2.0, 2.0]
**Decay**: Old weights multiplied by 0.95 per month

### Personalized Scoring

```
personalized_score = base_score
  + (category_weight * 0.2)
  + (trust_tier_weight * 0.1)
  + (keyword_boost * 0.3)
  - (anti_penalty * 1.0)
```

Clamped to [0, 1]

## Cold Start Strategy

For users with < 5 signals, use popularity-weighted defaults:

```typescript
{
  category_weights: {
    'testing': 0.3,
    'git': 0.3,
    'devops': 0.2,
  },
  trust_tier_weights: {
    'verified': 0.2,
    'community': 0.0,
    'standard': -0.1,
  }
}
```

## Implementation Plan

### Phase 1: Core Infrastructure (1 week)
- [ ] SQLite schema migration
- [ ] SignalCollector implementation
- [ ] UserPreferenceProfile storage
- [ ] Unit tests

### Phase 2: Learning Algorithm (1 week)
- [ ] PreferenceLearner with weight updates
- [ ] Personalized scoring in recommend.ts
- [ ] Cold start strategy
- [ ] Integration tests

### Phase 3: Privacy & Integration (1 week)
- [ ] PrivacyManager implementation
- [ ] Export/wipe functionality
- [ ] MCP event listener integration
- [ ] Usage tracking integration

### Phase 4: Validation & Tuning (1 week)
- [ ] A/B testing framework
- [ ] Recommendation quality metrics
- [ ] Performance optimization
- [ ] Documentation

## Success Metrics

- **Relevance**: 30% improvement in accept rate after 10 signals
- **Utilization**: 70% of accepted skills used within 7 days
- **Dismiss Rate**: 20% reduction after 20 signals
- **Performance**: < 50ms personalization overhead
- **Privacy**: Zero external data transmission

## Dependencies

**Blocking** (from MCP Specialist):
1. Trigger System Architecture (CRITICAL)
2. Skill Suggestion Protocol (CRITICAL)
3. One-Click Activation (HIGH)

**Nice-to-Have** (from Backend Specialist):
1. Usage Tracker service
2. Skill installation event hooks

## Documentation

- **Design**: [recommendation-learning-loop-design.md](../../../docs/phase4/epic1/recommendation-learning-loop-design.md)
- **MCP Contract**: [mcp-integration-contract.md](../../../docs/phase4/epic1/mcp-integration-contract.md)
- **Types**: [types.ts](./types.ts)
- **Interfaces**: [interfaces.ts](./interfaces.ts)
- **Schema**: [schema.sql](./schema.sql)

## Testing

```bash
# Run learning loop tests (once implemented)
npm test -- learning

# Test with real database
npm run test:integration -- learning

# Privacy verification
npm run test:privacy
```

## Privacy & Security

**Data Classification**: User Preference Data (LOCAL ONLY)

**Retention**: 90 days (configurable)

**Export**: Full GDPR-style export available via:
```typescript
const privacy = new PrivacyManager(dbPath)
const data = await privacy.exportUserData()
```

**Wipe**: Complete data deletion via:
```typescript
await privacy.wipeAllData()
```

## Future Enhancements

- **Federated Learning**: Aggregate anonymous insights across users
- **Multi-Model Support**: Different learning algorithms (collaborative filtering, etc.)
- **A/B Testing**: Built-in experimentation framework
- **Explainability**: UI showing why skills were recommended

## License

Same as Skillsmith project.

## Contact

Data Scientist - Epic 1, Sub-issue 5
Status: Ready for implementation once dependencies complete
