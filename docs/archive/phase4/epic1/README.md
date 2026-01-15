# Epic 1: Contextual Recommendations - Skills Find Users

**Initiative**: Phase 4 - Product Strategy
**Epic Owner**: Product Manager
**Status**: IN PROGRESS
**Last Updated**: 2025-12-31

## Overview

Enable Skillsmith to proactively suggest relevant skills to users based on context detection, with a learning feedback loop that improves recommendations over time.

## Sub-Issues

| # | Title | Owner | Priority | Status | Files |
|---|-------|-------|----------|--------|-------|
| 1 | Design Trigger System Architecture | MCP Specialist | CRITICAL | **NOT STARTED** | - |
| 2 | Implement MCP Skill Suggestion Protocol | MCP Specialist | CRITICAL | **NOT STARTED** | - |
| 3 | Design Non-Intrusive Surfacing UX | Behavioral Designer | HIGH | **NOT STARTED** | - |
| 4 | Implement One-Click Skill Activation | MCP Specialist | HIGH | **NOT STARTED** | - |
| 5 | **Build Recommendation Learning Loop** | **Data Scientist** | MEDIUM | **DESIGN COMPLETE ✅** | See below |

## Deliverables - Recommendation Learning Loop

### Design Documents

| Document | Purpose | Location |
|----------|---------|----------|
| **Architecture Design** | Complete system architecture (31 pages) | [recommendation-learning-loop-design.md](./recommendation-learning-loop-design.md) |
| **MCP Integration Contract** | Event schemas and integration protocol | [mcp-integration-contract.md](./mcp-integration-contract.md) |
| **Coordination Status** | Team status and blocking dependencies | [COORDINATION_STATUS.md](./COORDINATION_STATUS.md) |

### Code Deliverables

| File | Purpose | Location |
|------|---------|----------|
| **TypeScript Types** | Signal types, preferences, configs | `/packages/core/src/learning/types.ts` |
| **Service Interfaces** | SignalCollector, PreferenceLearner, etc. | `/packages/core/src/learning/interfaces.ts` |
| **Database Schema** | SQLite schema with migrations | `/packages/core/src/learning/schema.sql` |
| **README** | Implementation guide | `/packages/core/src/learning/README.md` |

## System Architecture Summary

```
User Interaction → SignalCollector → SQLite → PreferenceLearner → UserProfile → PersonalizationEngine → Enhanced Recommendations
```

### Core Components

1. **Signal Collection System**
   - 6 signal types (ACCEPT, DISMISS, USAGE_DAILY, USAGE_WEEKLY, ABANDONED, UNINSTALL)
   - Event-driven architecture
   - Integration with MCP skill suggestion protocol

2. **Per-User Preference Model**
   - Category weights: [-2.0, 2.0]
   - Trust tier preferences
   - Keyword/tag learning
   - Anti-pattern tracking

3. **Privacy-Preserving Storage**
   - Local-only SQLite (`~/.skillsmith/learning.db`)
   - 90-day retention policy
   - GDPR-compliant export/wipe
   - Zero external data transmission

4. **Weight Adjustment Algorithm**
   - Learning rate: 0.1
   - Time decay: 0.95/month
   - Personalized scoring formula
   - Cold start strategy for new users

## Dependencies

The Data Scientist **CANNOT IMPLEMENT** until MCP Specialist completes:

### Critical Blockers (from MCP Specialist)

1. ❌ **Design Trigger System Architecture** (Sub-issue 1)
   - Needed for: Context detection and trigger events
   - Status: Not started

2. ❌ **Implement MCP Skill Suggestion Protocol** (Sub-issue 2)
   - Needed for: `skill:suggested`, `skill:accepted`, `skill:dismissed` events
   - Status: Not started
   - Blocked by: Sub-issue 1

3. ❌ **Implement One-Click Skill Activation** (Sub-issue 4)
   - Needed for: Post-install callbacks
   - Status: Not started
   - Blocked by: Sub-issue 2

## Integration Points

### Required Events from MCP Layer

```typescript
// MCP Server must emit these events
mcp.emit('skill:suggested', { skill_id, context, score, ... })
mcp.emit('skill:accepted', { skill_id, install_success, ... })
mcp.emit('skill:dismissed', { skill_id, reason, ... })
mcp.emit('skill:used', { skill_id, timestamp, ... })
mcp.emit('skill:uninstalled', { skill_id, days_since_install, ... })
```

See [MCP Integration Contract](./mcp-integration-contract.md) for full event schemas.

### Enhanced Recommendation Flow

**Before Learning Loop**:
```
User → skill_recommend → Semantic Matching → Results
```

**After Learning Loop**:
```
User → skill_recommend → Semantic Matching → Personalization → Results
                              ↓                      ↑
                         Base Scores          Learned Weights
```

## Implementation Timeline

**Once MCP dependencies complete**:

| Week | Phase | Deliverables |
|------|-------|--------------|
| 1 | Core Infrastructure | SignalCollector, database, unit tests |
| 2 | Learning Algorithm | PreferenceLearner, personalized scoring, integration tests |
| 3 | Privacy & Integration | PrivacyManager, MCP event listeners, usage tracking |
| 4 | Validation & Tuning | A/B testing, metrics, performance optimization |

**Total**: 4 weeks post-dependency completion

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Recommendation Relevance** | 30% improvement in accept rate | After 10 signals collected |
| **Utilization Rate** | 70% of accepted skills used | Within 7 days of install |
| **Dismiss Rate Reduction** | 20% fewer dismissals | After 20 signals collected |
| **Personalization Performance** | < 50ms overhead | Per recommendation request |
| **Privacy Compliance** | Zero external transmission | Verified by audit |

## Risk Mitigation

| Risk | Impact | Mitigation | Status |
|------|--------|------------|--------|
| MCP dependencies delayed | High | Design complete, ready for rapid implementation | ✅ Mitigated |
| Event schema mismatch | Medium | Clear contract documented, review with MCP Specialist | 📋 Documented |
| Privacy concerns | Low | Local-only storage, full transparency, GDPR-compliant | ✅ Designed |
| Performance overhead | Low | Designed for < 50ms latency, caching strategy | ✅ Designed |
| Cold start problem | Medium | Popularity-weighted defaults for new users | ✅ Designed |

## Testing Strategy

### Unit Tests
- Signal collection accuracy
- Preference weight updates
- Personalized scoring calculations
- Privacy manager operations

### Integration Tests
1. **Happy Path**: Suggest → Accept → Use → Boost Score
2. **Negative Path**: Suggest → Dismiss → Penalize Score
3. **Abandonment Path**: Accept → Never Use → Penalize Score
4. **Uninstall Path**: Accept → Use → Uninstall → Strong Penalty

### A/B Testing
- Control group: Base semantic matching only
- Test group: Personalized recommendations
- Measure: Accept rate, utilization rate, dismiss rate

## Future Enhancements

1. **Federated Learning**: Aggregate anonymous insights across users
2. **Multi-Model Support**: Collaborative filtering, neural networks
3. **Explainability UI**: Show users why skills were recommended
4. **Cross-Device Sync**: Sync preferences across machines (opt-in)

## Communication

**Data Scientist Status**: Design complete, ready for implementation

**Blocked On**: MCP Specialist sub-issues 1, 2, 4

**Available For**:
- Integration design review
- Event schema clarification
- Database schema questions
- Learning algorithm tuning
- Privacy/security review

**Coordination**:
- Status: [COORDINATION_STATUS.md](./COORDINATION_STATUS.md)
- Memory: `phase4/coordination/*`, `phase4/data-science/*`
- Hooks: Pre-task, post-task, notify

## Files Changed

All files created in this deliverable:

### Documentation
- `/docs/phase4/epic1/recommendation-learning-loop-design.md` (31 pages)
- `/docs/phase4/epic1/mcp-integration-contract.md` (18 pages)
- `/docs/phase4/epic1/COORDINATION_STATUS.md` (Status tracking)
- `/docs/phase4/epic1/README.md` (This file)

### Code
- `/packages/core/src/learning/types.ts` (300+ lines, TypeScript types)
- `/packages/core/src/learning/interfaces.ts` (350+ lines, service interfaces)
- `/packages/core/src/learning/schema.sql` (250+ lines, database schema)
- `/packages/core/src/learning/README.md` (Implementation guide)

**Total**: 8 files, ~1200 lines of documentation and specifications

## Next Steps

### For MCP Specialist (Priority)
1. ✅ Review [MCP Integration Contract](./mcp-integration-contract.md)
2. ✅ Start Sub-issue 1: Design Trigger System Architecture
3. ✅ Coordinate event schemas if changes needed
4. ✅ Implement event emitter in MCP server

### For Data Scientist (When Unblocked)
1. Implement `SignalCollector` service
2. Implement `PreferenceLearner` algorithm
3. Integrate with MCP event bus
4. Add personalization to `skill_recommend` tool
5. A/B testing framework
6. Performance tuning

### For Backend Specialist (Nice-to-Have)
1. Implement `IUsageTracker` interface
2. Daily background job for usage signal collection
3. Skill installation event hooks

## License

Same as Skillsmith project.

---

**Last Updated**: 2025-12-31
**Data Scientist**: Design phase complete ✅
**Status**: Awaiting MCP Specialist dependencies
