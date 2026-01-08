# ADR-0003: Behavioral Instrumentation Strategy

**Status:** Accepted
**Date:** 2025-12-26
**Deciders:** CEO, Senior Architect, Product Team

## Context

Research (150+ sources) identified that the Claude Discovery Hub problem is fundamentally behavioral, not technical. To validate the POC and enable social proof features, we need to collect behavioral data while respecting user privacy.

Key findings from research:
- 63% of technology decisions are peer-influenced
- Users operate at 20% of tool potential
- 11-week adoption journey requires sustained engagement
- Behavioral funnel (Awareness → Trial → Adoption) is critical

## Decision

Implement **opt-out telemetry with clear value proposition**. Users can disable telemetry, but it is enabled by default with transparent explanation of benefits.

### What We Collect

| Category | Data Points | Purpose |
|----------|-------------|---------|
| **Discovery Funnel** | Skills viewed, searched, installed | Awareness → Trial → Adoption tracking |
| **Activation Events** | Skill activations observed | Skill attribution visibility |
| **Session Metrics** | Session length, return frequency | Adoption journey tracking |
| **Aggregate Stats** | Stack detection results (anonymized) | Social proof ("developers like you") |

### What We Don't Collect

- Code content
- Prompt content
- Personal identifiers beyond installation ID
- File paths or project names
- Any data after opt-out

### Implementation

```javascript
// Telemetry is enabled by default
// settings.json
{
  "telemetry": {
    "enabled": true,  // User can set to false
    "anonymousId": "uuid-v4",
    "lastSyncedAt": "2025-12-26T00:00:00Z"
  }
}
```

### Value Proposition Messaging

When user first runs Discovery Hub:
```
Discovery Hub collects anonymous usage data to:
• Show you what skills developers with similar stacks use
• Improve recommendation accuracy
• Help skill authors understand adoption

Your code and prompts are never collected.
Disable anytime: /discover config telemetry off
```

## Consequences

### Positive
- Enables social proof features ("12 developers with React use this skill")
- Provides behavioral funnel data for POC validation
- Helps improve recommendation algorithm
- Aligns with CEO decision for opt-out model

### Negative
- Some privacy-conscious users will opt out
- Must maintain telemetry infrastructure
- Regulatory compliance considerations (GDPR, etc.)
- Risk of perception as "spyware" if not communicated well

### Neutral
- Need server-side aggregation for social proof
- Must honor opt-out immediately (no delayed sync)
- Telemetry adds ~2KB per session to network usage

## Alternatives Considered

### Alternative 1: Opt-In Only
- Maximum privacy respect
- Minimal data collection
- **Rejected:** Would severely limit social proof features; CEO decided against

### Alternative 2: No Telemetry
- Complete privacy
- No behavioral data
- **Rejected:** Cannot validate POC behavioral hypotheses; cannot enable social proof

### Alternative 3: Server-Side Analytics Only
- Track only web browser interactions
- No terminal telemetry
- **Rejected:** Misses core product usage; terminal is primary interface

## References

- [CEO Decision: Opt-out with value](../prd-v3.md#e-ceo-decisions-applied)
- [Layer 3 Research: 63% peer influence](../research/layers/layer-3-synthesis.md)
- [Fogg Behavior Model](../design/overview.md#behavioral-design-framework)
