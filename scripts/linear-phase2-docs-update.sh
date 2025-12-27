#!/bin/bash
# Add Phase 2 documentation update to Linear

echo "=== Adding Phase 2 Documentation Update ==="

PHASE2_PROJECT="fe22ca22-b538-4454-bcb0-6d770efbddd0"

UPDATE_BODY='## Phase 2 Documentation Complete

**Date**: 2025-12-27

### New Architecture Documents

1. **ADR-003: Claude-flow Integration**
   - Documented decision to use claude-flow for technical risk mitigation
   - Covers memory persistence, neural patterns, swarm coordination
   - Alternatives considered and rationale

2. **Phase 2 Implementation Plan**
   - Technical risk mitigations mapped to Linear issues
   - Architecture diagrams and data flow
   - Three implementation phases (Foundation, Optimization, Scale)
   - Success metrics and targets

### Linear Issue Mapping
| Issue | Risk Mitigation |
|-------|-----------------|
| SMI-627 | Neural patterns + memory caching |
| SMI-628 | Swarm coordination + rate limiting |
| SMI-629 | Neural prediction |
| SMI-630 | Memory TTL |
| SMI-632 | Bottleneck analysis |

### Ready for Development
Phase 2 foundation work can begin with SMI-627 and SMI-628.'

# Escape for JSON
ESCAPED_BODY=$(echo "$UPDATE_BODY" | jq -Rs .)

curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d "{\"query\": \"mutation { projectUpdateCreate(input: { projectId: \\\"$PHASE2_PROJECT\\\", body: $ESCAPED_BODY }) { success } }\"}" | \
  jq -r 'if .data.projectUpdateCreate.success then "Project update: Success" else "Project update: Failed" end'

echo ""
echo "Done!"
