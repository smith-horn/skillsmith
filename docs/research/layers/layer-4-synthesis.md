# Layer 4 Synthesis: Status Quo Attempts

**Research Synthesis Date:** December 26, 2025
**Framework:** Teresa Torres Layer 4 - "What status quo attempts have been made?"
**Total Sources Analyzed:** 60+ across 2 research documents

---

## Executive Summary

Layer 4 research examined existing solutions, workarounds, and abandoned patterns to understand what has been tried and why it failed. The core finding:

> **Every major approach to skill/tool discovery has been attempted—and each has failed for predictable, structural reasons that a well-designed Discovery Hub can address.**

The failures are not due to lack of effort or poor execution, but to architectural choices that don't scale or don't align with user behavior.

---

## Research Documents

| Document | Sources | Focus |
|----------|---------|-------|
| [existing-solutions-research.md](./layer-4-status-quo/existing-solutions-research.md) | 35+ | What exists, why it partially works, why it fails |
| [abandoned-patterns-research.md](./layer-4-status-quo/abandoned-patterns-research.md) | 25+ | What was tried and abandoned, lessons learned |

---

## Key Finding 1: The Curation Paradox

### What Happens
- Small-scale curation works well (<100 items)
- Scale creates maintainer burnout
- Quality degrades as quantity grows
- Eventually, curation becomes discovery problem itself

### Evidence
> "Large lists become less useful and maintainers lose interest in keeping the list active and updated."

> "Some contributors have reported waiting almost a year to get their projects added to popular awesome lists."

### Scale Numbers
| Platform | Items | Status |
|----------|-------|--------|
| MCP.so | 17,247 servers | Overwhelming |
| Awesome lists | Hundreds each | Backlogged |
| CLAUDE.md patterns | Thousands | Fragmented |

### Strategic Implication
**Automated quality signals must replace human curation as primary discovery mechanism.** Human curation can complement but cannot be the foundation.

---

## Key Finding 2: The Fragmentation Trap

### What Happens
- Multiple solutions emerge for same problem
- Each addresses slightly different use case
- No incentive for consolidation
- Users face "registry fatigue"

### Evidence
> "17+ MCP registries and directories" exist in 2025

> "MCP Marketplace remains a proposed or emerging idea... As of September 2025, there is no official, MCP-governed marketplace."

### Current Landscape
| Category | Number of Solutions | Status |
|----------|---------------------|--------|
| MCP registries | 17+ | Fragmented |
| Awesome lists for Claude | 3+ | Overlapping |
| Custom instruction formats | 4+ | Tool-specific |
| Skill-sharing methods | 5+ | Siloed |

### Strategic Implication
**Discovery Hub should become THE source for Claude skills** before attempting cross-tool federation. Consolidation within ecosystem first.

---

## Key Finding 3: The Security Trust Deficit

### What Happens
- Past security incidents erode trust
- Speed-over-quality culture persists
- Extension ecosystems become attack vectors
- Users develop blanket skepticism

### Evidence
| Incident | Impact | Lesson |
|----------|--------|--------|
| Amazon Q (2024) | File deletion, EC2 shutdown | Implicit trust dangerous |
| npm Shai-Hulud (2025) | 25K repos in 72 hours | Supply chain vulnerable |
| AI-generated code | 48% has vulnerabilities | Quality signals missing |

> "16 of 18 CTOs reported 'production disasters directly caused by AI-generated code'"

### Strategic Implication
**Trust tiers with verification must be visible in discovery.** Quality and security signals are not optional features—they are core discovery infrastructure.

---

## Key Finding 4: The Team-to-Ecosystem Gap

### What Happens
- Internal team sharing patterns work well
- Cross-organization sharing fails
- No mechanism for quality propagation
- Knowledge stays siloed

### Evidence
**What Works (Team Level):**
> "When you finish an experiment session in Claude Code, you type one command. Claude reads through what you did, extracts the important parts and writes it up as a 'skill.' That skill goes into a shared registry."

**What Fails (Ecosystem Level):**
- No cross-team discovery
- No quality signals for external skills
- No trust establishment for unknown authors

### Strategic Implication
**Bridge the team→ecosystem gap.** Enable the patterns that work within teams to scale across the ecosystem with added quality signals.

---

## Key Finding 5: The Description Quality Bottleneck

### What Happens
- Discovery depends on skill descriptions
- Authors write vague descriptions
- No feedback loop for improvement
- False negatives frustrate users

### Evidence
> "A common symptom is when you ask a relevant question but Claude doesn't use your Skill. The fix: Check if the description is specific enough."

> "Writing good descriptions takes practice. The first few skills people create tend to be too broad."

### Learning Curve
| Author Stage | Description Quality | Discovery Rate |
|--------------|---------------------|----------------|
| First skill | Too broad | Low |
| 3-5 skills | Learning | Moderate |
| 10+ skills | Specific | High |

### Strategic Implication
**Discovery must use multiple signals beyond descriptions.** Usage data, quality metrics, peer ratings, and structural analysis should complement author descriptions.

---

## Key Finding 6: The Context Exhaustion Reality

### What Happens
- Loading all skill info exhausts tokens
- Users hit practical limits
- Workarounds consume mental energy
- Progressive disclosure is mandatory

### Evidence
> "Developers using o3-mini in early 2025 repeatedly hit a practical wall around 6,400 - 8,000 tokens when prompts required complex reasoning."

> "Skills employ a progressive disclosure architecture for efficiency: Metadata loading (~100 tokens), Full instructions (<5k tokens) when relevant."

### Progressive Disclosure Pattern
| Stage | Token Cost | When Loaded |
|-------|------------|-------------|
| Metadata | ~100 | Always |
| Description | ~500 | On relevance match |
| Full instructions | <5,000 | On invocation |
| Resources | Variable | On demand |

### Strategic Implication
**Discovery must be context-efficient.** Skill index and recommendations must minimize token overhead while maximizing relevance.

---

## Anti-Patterns to Avoid

Based on Layer 4 research, Discovery Hub must avoid:

### Architecture Anti-Patterns
| Anti-Pattern | Why It Fails | Alternative |
|--------------|--------------|-------------|
| Human curation at scale | Burnout, backlog | Automated scoring |
| Single discovery interface | User diversity | Persona-specific paths |
| Description-only matching | Quality variance | Multi-signal scoring |
| Unlimited context loading | Token exhaustion | Progressive disclosure |

### Trust Anti-Patterns
| Anti-Pattern | Why It Fails | Alternative |
|--------------|--------------|-------------|
| Implicit trust | Security incidents | Explicit trust tiers |
| Speed over quality | Trust erosion | Quality-embedded discovery |
| Post-install verification | Too late | Pre-discovery verification |

### Ecosystem Anti-Patterns
| Anti-Pattern | Why It Fails | Alternative |
|--------------|--------------|-------------|
| Cross-tool standards first | Vendor competition | Single ecosystem excellence |
| Build-and-wait | Distribution gap | Active matching |
| Pure self-organization | Fragmentation | Structured + community |

---

## What Working Solutions Share

Analysis of partial successes reveals common traits:

### 1. Progressive Disclosure
Working solutions load minimal context first, expand on demand.

### 2. Team-Level Scope
Solutions that work stay within organizational boundaries.

### 3. Feedback Loops
Successful patterns have mechanisms to improve over time.

### 4. Clear Ownership
Working solutions have active maintainers with defined scope.

### 5. Quality Signals
Partial successes include some form of quality indication.

---

## Strategic Recommendations

Based on Layer 4 synthesis:

### Priority 1: Automated Quality Scoring
Replace human curation bottleneck with algorithmic scoring.

### Priority 2: Progressive Discovery
Metadata first, expand on relevance, load on invocation.

### Priority 3: Trust Tiers
Visible verification badges with meaningful thresholds.

### Priority 4: Multi-Signal Matching
Combine descriptions with usage, quality, and maintenance data.

### Priority 5: Claude Ecosystem First
Build excellence for Claude before attempting cross-tool.

### Priority 6: Bidirectional Matching
Help users find skills AND help authors understand needs.

---

## Connection to Other Layers

### From Layer 1 (Mental Models)
Users frame problem as "not knowing enough" → **Discovery must make capabilities visible without requiring action**

### From Layer 2 (Ecosystem)
Distribution is #1 author pain → **Discovery solves author problem, not just user problem**

### From Layer 3 (Behavioral)
95% keep defaults, 23min context switch → **Discovery must be ambient and efficient**

### To Layer 5 (Technology)
Status quo failures reveal → **Technical capabilities that must exist**

### To Layer 6 (Feasible Influence)
What's been tried informs → **What we can realistically change**

---

## Key Statistics

| Metric | Value | Implication |
|--------|-------|-------------|
| MCP registries | 17+ | Consolidation opportunity |
| Awesome list PR wait | ~1 year | Curation doesn't scale |
| AI code vulnerabilities | 48% | Trust signals essential |
| Token practical limit | ~8,000 | Progressive disclosure mandatory |
| Default keeping rate | 95% | Ambient discovery required |
| CTO disaster reports | 16/18 | Quality must be visible |

---

## Top Quotes

1. "Large lists become less useful and maintainers lose interest"
2. "No official, MCP-governed marketplace exists as of September 2025"
3. "48% of AI-generated code contains potential security vulnerabilities"
4. "Developers were 19% slower with AI but believed they were 24% faster"
5. "Writing good descriptions takes practice"

---

## Next Steps: Layers 5-6

Layer 4 findings inform:

**Layer 5 Questions:**
- Which technical capabilities can address the curation paradox?
- How can progressive disclosure be implemented efficiently?
- What infrastructure enables trust tier verification?

**Layer 6 Questions:**
- Can we influence the fragmentation landscape?
- What partnerships would enable ecosystem consolidation?
- Which anti-patterns are we capable of avoiding?

---

*Layer 4 synthesis completed December 26, 2025 for Claude Discovery Hub*
