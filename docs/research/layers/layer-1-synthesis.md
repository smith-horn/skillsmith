# Layer 1: Customer Mental Models Synthesis

**Research Sources:** Reddit/HN Research, Social Media Research, Blog Content Research, Substack Newsletter Research
**Synthesis Date:** December 26, 2025
**Framework:** Teresa Torres Continuous Discovery - Layer 1

---

## Executive Summary

Layer 1 research across 4 comprehensive studies (150+ sources) reveals a clear picture of how Claude Code users describe their problems in their own words. The dominant mental model is that of a **"junior developer with amnesia"** - powerful but requiring constant supervision and re-teaching.

### Core Customer Problem Statement (In Their Words)

> "I keep explaining the same things over and over. Every session starts from zero. My expertise isn't persistent."

---

## Top 5 Mental Model Themes

### 1. The Black Box Problem (Opacity)
Users perceive Claude Code's extensibility system as hidden and opaque.

**Representative Quotes:**
- "Due to Claude Code's CLI-based nature, a lot of stuff is hidden and you need to find it."
- "99% of Claude 4 Users Don't Know This Feature Exists"
- "I didn't know you could mention files using the @ character. It took me 3-4 days."

**Prevalence:** Very High (mentioned across all 4 research documents)

### 2. Configuration Fatigue (Complexity Tax)
Setup complexity creates barriers to adoption and ongoing frustration.

**Representative Quotes:**
- "MCP is the worst documented technology I have ever encountered."
- "Setup complexity is fairly high with first-time configuration potentially taking an hour."
- "Search for MCP servers... read through documentation... install... manually add... This is incredibly time-consuming."

**Prevalence:** Very High

### 3. The Context Amnesia Problem (Memory Loss)
Every session starts fresh, requiring re-teaching of context, conventions, and constraints.

**Representative Quotes:**
- "Every morning, you essentially onboard a new team member from scratch."
- "AI can't retain learning between sessions unless you spend the time manually giving it 'memories.'"
- "By the time Claude understands your context, you've burned 30 minutes just setting the stage."

**Prevalence:** Very High

### 4. Token Anxiety (Resource Scarcity)
Fear of context window consumption creates decision paralysis and workflow constraints.

**Representative Quotes:**
- "I found my MCP tools were consuming 66,000+ tokens of context before even starting."
- "A five-server MCP setup with 58 tools can consume approximately 55K tokens before the conversation even starts."
- "The '--continue' flag can significantly increase token usage, apparently using three to ten times more tokens."

**Prevalence:** High

### 5. Activation Uncertainty (Reliability Gap)
Lack of confidence that skills will trigger when needed.

**Representative Quotes:**
- "Claude Code is not very good at 'remembering' its skills. I often do something like 'using your Image Manipulation skill...' to manually invoke them."
- "'Simple instruction' approach gives 20% success. Forced eval hook gives 84% success."
- "Claude just wouldn't use the skills automatically."

**Prevalence:** High

---

## Customer Journey Pattern

Research reveals a consistent 4-phase emotional journey:

| Phase | Duration | Emotional State | Trigger |
|-------|----------|-----------------|---------|
| **Initial Attraction** | Days 1-3 | Curious, skeptical | Coming from other tools |
| **Frustration Valley** | Days 3-7 | Frustrated, confused | Repeated failures, context loss |
| **Breakthrough Moment** | Week 2-3 | Excited, empowered | Discovery of CLAUDE.md/Skills |
| **Transformed Workflow** | Month 1+ | Dependent, confident | "Can't code without this" |

**Key Insight:** The breakthrough consistently occurs when users discover and properly configure their first CLAUDE.md file or Skill.

---

## User Language Patterns

### Self-Blame Vocabulary
Users consistently frame discovery failures as personal shortcomings:
- "I didn't know..."
- "It took me [X days] to learn..."
- "I finally figured out..."

**Implication:** Users internalize blame rather than attributing it to poor UX. Opportunity for proactive disclosure.

### Temporal Frustration Markers
Users frequently quantify wasted time:
- "I spent 4 days..."
- "potentially taking an hour..."
- "took me forever..."

**Implication:** Time-to-capability is a critical metric.

### Metaphors Users Employ
- **"USB ports for your AI"** - MCPs as connectivity
- **"Burning through"** - Token consumption as waste
- **"Black box"** - Opacity metaphor
- **"Junior developer with amnesia"** - Capability + limitation mental model

---

## Expert vs. Novice Perspective Gap

| Dimension | Novice Mental Model | Expert Mental Model |
|-----------|---------------------|---------------------|
| **What Claude Is** | "AI that writes code for me" | "Intelligent collaborator that embodies my team's expertise" |
| **Primary Interaction** | One-off prompts and requests | Structured Skills and documented conventions |
| **Problem Framing** | "Generate this code" | "Follow our documented process to achieve this outcome" |
| **Error Response** | "Claude got it wrong" | "My instructions weren't clear enough" |
| **Success Metric** | "Did it produce code?" | "Did it follow our standards and produce maintainable output?" |

**Key Insight:** The transition from novice to expert mindset is the critical adoption hurdle.

---

## Jobs-to-be-Done Analysis

### Primary Jobs (High Frequency)

| Job | User Expression | Success Criteria |
|-----|-----------------|------------------|
| **Accelerate routine coding** | "Handle boilerplate so I can focus on architecture" | Reduced time on repetitive tasks |
| **Reduce context-switching friction** | "Stay in flow without searching docs" | Seamless workflow integration |
| **Explore unfamiliar territory** | "Try frameworks I don't know well" | Lower barrier to experimentation |
| **Eliminate procrastination barriers** | "Get past the anxiety of starting" | Faster first line of code |

### Jobs Users Want But Claude Fails

| Desired Job | Current Failure Mode |
|-------------|---------------------|
| **Remember across sessions** | "Every conversation starts fresh" |
| **Learn from corrections** | "Makes the same mistakes repeatedly" |
| **Maintain context in long sessions** | "Gets lost in the middle of large context" |
| **Provide honest feedback** | "Yes-man behavior prevents critical analysis" |

---

## Pain Point Severity Ranking

### Critical Severity (Causing Cancellations)
1. **Quality Degradation Over Time** - Perception of model "dumbing down"
2. **Usage Limits vs. Cost** - $200/month MAX plan still hits limits
3. **Context Window Exhaustion** - No visibility into usage until too late

### High Severity (Major Workflow Disruption)
4. **"Yes-Man" Behavior** - Agrees with suboptimal decisions
5. **Hallucination & False Completion** - Claims tasks complete when they aren't
6. **Customization Fragility** - Skills/commands disappear on context switch

### Medium Severity (Recurring Annoyances)
7. **Session Memory Loss** - No persistence between conversations
8. **MCP Complexity** - Stateful architecture vs. web conventions
9. **Response Time Variability** - 5+ minute waits for basic edits

---

## The "70% Problem" Framework

A critical insight from Substack research (Addy Osmani):

> "Non-engineers using AI coding tools can rapidly reach 70% completion, but struggle dramatically with the final 30%. This creates a frustrating pattern of diminishing returns where fixes generate new problems in a whack-a-mole cycle."

**Implications for Discovery Hub:**
- Skills that help bridge the 30% gap are highest value
- Context engineering skills address root cause
- Verification/review skills critical for trust

---

## Workarounds as Signals

Users have developed workarounds that reveal unmet needs:

| Workaround | What It Signals |
|------------|-----------------|
| **Community curation** (awesome-* repos) | Need for centralized discovery |
| **Explicit skill invocation** | Need for reliable activation |
| **McPick CLI toggle** | Need for token management |
| **Meta-MCP servers** | Need for efficient context |
| **Forced eval hooks** | Need for activation confidence |

---

## Implications for Claude Discovery Hub

### Design Principles from Layer 1 Research

1. **Shift From "Discoverable" to "Introduced"**
   - Don't wait for users to find skills
   - Proactively surface capabilities at moment of need

2. **Reframe Token Overhead as "Capability Budget"**
   - Frame as investment with clear ROI indicators
   - Show what skills cost vs. what they save

3. **Replace Configuration with Guided Setup**
   - Interactive wizard > JSON editing
   - Explain each choice and its impact

4. **Add Activation Confidence Indicators**
   - Show when skills will trigger
   - Make the invisible visible

5. **Create Single Discovery Surface**
   - One searchable, browsable interface
   - Consolidate fragmented ecosystem

### Success Metrics Derived from Layer 1

| Metric | Target | Rationale |
|--------|--------|-----------|
| Time to first skill discovery | < 5 minutes | Address "black box" problem |
| Skill activation success rate | > 80% | Address reliability gap |
| Token overhead visibility | 100% transparent | Address token anxiety |
| Configuration steps required | < 3 | Address complexity tax |
| Session context preservation | > 90% | Address amnesia problem |

---

## Key Quotes Collection (Top 25)

1. "Due to Claude Code's CLI-based nature, a lot of stuff is hidden"
2. "MCP is the worst documented technology I have ever encountered"
3. "Every morning, you essentially onboard a new team member from scratch"
4. "66,000+ tokens of context before even starting a conversation"
5. "Claude Code is not very good at 'remembering' its skills"
6. "Claude changed my life. I rebuilt an entire app in just a few hours"
7. "On a good day, I'll ship a week's worth of product in under a day"
8. "Claude is trained to be a 'yes-man' instead of an expert"
9. "When I switched contexts, everything disappeared"
10. "First attempt will be 95% garbage; second attempts still have 50% failure rate"
11. "It's like having a senior developer sitting next to me"
12. "Skills aren't a novelty -- they're a different way of working with AI"
13. "Claude is like an extremely confident junior dev with extreme amnesia"
14. "The learning curve is worth climbing"
15. "90% of Claude Code is written by Claude Code itself"
16. "Two engineers can now create the tech debt of fifty"
17. "Claude Code doesn't just suggest code - it executes entire workflows"
18. "Non-engineers can reach 70% completion rapidly with AI"
19. "I moved from 'This is cool' to 'I can't code without this'"
20. "The developers who thrive won't be those who write the best prompts. They'll be those who build the best contexts."
21. "Skills teach Claude how to perform tasks in a repeatable way"
22. "I expect we'll see a Cambrian explosion in Skills"
23. "Nobody's going to make much money off it because they're expensive to run, and everybody has the same product" - Gary Marcus (contrarian)
24. "No juniors today means no seniors tomorrow"
25. "Treat the LLM as a powerful pair programmer that requires clear direction"

---

*Synthesis compiled from 4 Layer 1 research documents, December 26, 2025*
