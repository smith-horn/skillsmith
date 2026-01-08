# Skillsmith Product-Fit Matrix

**Purpose:** Product sense check before user testing to validate feature-value alignment
**Date:** December 30, 2024
**Framework:** Behavioral blockers × User archetypes × Full vision features

---

## Executive Summary

This matrix maps Skillsmith's full feature vision against the 5 behavioral blockers identified in Layer 3 research, segmented by 3 user archetypes. The goal is to identify:
1. **Strong fits** - Features that directly address user pain
2. **Gaps** - User pain with no feature coverage
3. **Testing priorities** - What to validate in user testing
4. **Feature priorities** - Where to invest next

### Key Finding

**The product has strong technical foundation but weak behavioral intervention coverage.** Most features address *what* users can do, but few address *why* they don't do it. The behavioral blockers require design-level interventions, not just functionality.

---

## User Archetypes

| Archetype | Personas | Core Motivation | Primary Fear | Key Quote |
|-----------|----------|-----------------|--------------|-----------|
| **Discovery-Focused** | Explorer + Overwhelmed | "What's possible?" / "Just tell me" | Missing something / Wrong choice | "I don't know what I don't know" |
| **Efficiency-Focused** | Optimizer + Skeptic | "Save me time" / "Prove it works" | Adding complexity / Wasting time | "Would I trust AI? Absolutely not" |
| **Contribution-Focused** | Creator + Standardizer | "Recognition" / "Team consistency" | Obscurity / Being blamed | "Distribution is my #1 problem" |

---

## Behavioral Blockers (Research-Validated)

| # | Blocker | Severity | Evidence |
|---|---------|----------|----------|
| B1 | **Cognitive Load & Context-Switching** | Critical | 23 min lost per interruption, 50%+ time verifying AI |
| B2 | **Status Quo Bias & Inertia** | High | 95% never change defaults, loss aversion 2x |
| B3 | **Tool Fatigue & Overwhelm** | High | 33+ app switches/day, 45% feel overwhelmed |
| B4 | **Identity & Craft Protection** | High | 48% uncomfortable admitting AI use |
| B5 | **Trust Deficit & Quality Inconsistency** | Critical | Only 43% trust AI accuracy |

---

## Feature Inventory (Full Vision)

### Shipped Features
| ID | Feature | Status |
|----|---------|--------|
| F1 | Search skills (MCP/CLI) | ✅ Shipped |
| F2 | Get skill details | ✅ Shipped |
| F3 | Install/Uninstall skills | ✅ Shipped |
| F4 | Validate skill structure | ✅ Shipped |
| F5 | Compare skills side-by-side | ✅ Shipped |

### Committed Roadmap
| ID | Feature | Status |
|----|---------|--------|
| F6 | Quality score breakdown (SMI-823) | 📋 Planned |
| F7 | Security visibility pre-install (SMI-825) | 📋 Planned |
| F8 | Slash commands /skillsmith (SMI-824) | 📋 Planned |

### Full Vision
| ID | Feature | Status |
|----|---------|--------|
| F9 | Contextual recommendations | 🔮 Vision |
| F10 | VS Code extension | 🔮 Vision (partial) |
| F11 | Skill attribution ("Using: X") | 🔮 Vision |
| F12 | Progress tracking | 🔮 Vision |
| F13 | Social proof ("2,341 projects use this") | 🔮 Vision |
| F14 | Team/org skill libraries | 🔮 Vision |
| F15 | Author analytics dashboard | 🔮 Vision |
| F16 | One-click quick wins | 🔮 Vision |

---

## Product-Fit Heat Map

### Legend
- 🟢 **Strong Fit** - Feature directly addresses blocker for this archetype
- 🟡 **Partial Fit** - Feature helps but doesn't fully address blocker
- 🔴 **Gap** - User pain exists, no feature coverage
- ⚪ **N/A** - Blocker not relevant to this archetype

---

### Discovery-Focused Archetype

*"I want to find the right skills without getting overwhelmed or making wrong choices"*

| Feature | B1: Cognitive Load | B2: Status Quo | B3: Tool Fatigue | B4: Identity | B5: Trust Deficit |
|---------|-------------------|----------------|------------------|--------------|-------------------|
| **F1: Search** | 🟡 Requires intent | 🔴 Must seek out | 🟡 One more tool | ⚪ | 🟡 Results unranked |
| **F2: Get Details** | 🟡 Extra step | 🔴 Must seek out | 🟡 More reading | ⚪ | 🟡 Info but no proof |
| **F3: Install** | 🟢 One command | 🟡 Reversible helps | 🟢 Simple action | ⚪ | 🟡 Leap of faith |
| **F4: Validate** | 🟡 Extra step | ⚪ | 🟡 More work | ⚪ | 🟢 Reduces risk |
| **F5: Compare** | 🟢 Decision support | 🟡 Reduces paralysis | 🟢 Consolidates info | ⚪ | 🟢 Informed choice |
| **F6: Quality Breakdown** | 🟢 Explains score | 🟡 Evidence helps | 🟢 Quick scan | ⚪ | 🟢 Transparent |
| **F7: Security Visibility** | 🟢 Pre-install info | 🟡 Reduces risk | 🟢 Clear signal | ⚪ | 🟢 Trust enabler |
| **F8: Slash Commands** | 🟢 No context switch | 🟢 Stays in flow | 🟢 Familiar pattern | ⚪ | 🟡 |
| **F9: Contextual Recs** | 🟢 Zero effort | 🟢 Comes to you | 🟢 Curated | ⚪ | 🟡 If accurate |
| **F10: VS Code Ext** | 🟢 In-editor | 🟢 No new tool | 🟢 Integrated | ⚪ | 🟡 |
| **F11: Attribution** | 🟢 Awareness | 🟢 Makes visible | 🟡 | ⚪ | 🟢 Builds trust |
| **F12: Progress Track** | 🟡 | 🟢 Shows value | 🟡 | ⚪ | 🟢 Evidence |
| **F13: Social Proof** | 🟢 Quick signal | 🟢 Others do it | 🟢 Reduces research | ⚪ | 🟢 Validation |
| **F14: Team Libraries** | 🟡 | 🟢 Pre-vetted | 🟢 Curated | ⚪ | 🟢 Team trust |
| **F15: Author Analytics** | ⚪ | ⚪ | ⚪ | ⚪ | 🟡 |
| **F16: Quick Wins** | 🟢 Fast value | 🟢 Low commitment | 🟢 Immediate | ⚪ | 🟢 Proves value |

**Discovery-Focused Gap Analysis:**
- 🔴 **Critical Gap:** No passive discovery - all features require user to seek out
- 🔴 **Critical Gap:** No "just tell me what to use" single recommendation
- 🟡 **Partial:** Trust signals exist but require user to look for them

---

### Efficiency-Focused Archetype

*"I want proven time savings with minimal overhead and easy escape hatches"*

| Feature | B1: Cognitive Load | B2: Status Quo | B3: Tool Fatigue | B4: Identity | B5: Trust Deficit |
|---------|-------------------|----------------|------------------|--------------|-------------------|
| **F1: Search** | 🔴 Interrupts flow | 🔴 Extra effort | 🔴 Another tool | 🟡 | 🟡 |
| **F2: Get Details** | 🔴 More reading | 🔴 Extra effort | 🔴 More steps | 🟡 | 🟡 No benchmarks |
| **F3: Install** | 🟢 Fast | 🟡 Reversible | 🟢 Simple | 🟡 | 🟡 Unproven |
| **F4: Validate** | 🔴 Extra work | ⚪ | 🔴 More tasks | 🟢 Control | 🟢 Verification |
| **F5: Compare** | 🟡 Useful once | 🟡 | 🟡 | 🟢 Informed | 🟢 Data-driven |
| **F6: Quality Breakdown** | 🟢 Quick scan | 🟡 | 🟢 Efficient | 🟢 Transparent | 🟢 Metrics |
| **F7: Security Visibility** | 🟢 Prevents waste | 🟡 | 🟢 Upfront | 🟢 Professional | 🟢 Risk aware |
| **F8: Slash Commands** | 🟢 No switching | 🟢 Keyboard flow | 🟢 Familiar | 🟢 Expert feel | 🟡 |
| **F9: Contextual Recs** | 🟢 Zero overhead | 🟢 Passive | 🟢 No searching | 🟡 AI suggesting | 🟡 If accurate |
| **F10: VS Code Ext** | 🟢 In-editor | 🟢 Existing tool | 🟢 Integrated | 🟢 Professional | 🟡 |
| **F11: Attribution** | 🟡 | 🟢 Shows ROI | 🟡 | 🟢 Credit | 🟢 Visible |
| **F12: Progress Track** | 🟡 Overhead | 🟢 Quantified | 🟡 | 🟢 Evidence | 🟢 Proof |
| **F13: Social Proof** | 🟢 Quick filter | 🟢 Herd signal | 🟢 Shortcut | 🟡 | 🟢 Validation |
| **F14: Team Libraries** | 🟡 | 🟢 Pre-approved | 🟢 Less choice | 🟢 Team norm | 🟢 Vetted |
| **F15: Author Analytics** | ⚪ | ⚪ | ⚪ | ⚪ | 🟡 |
| **F16: Quick Wins** | 🟢 Immediate | 🟢 Low risk | 🟢 Fast | 🟡 | 🟢 Proof first |

**Efficiency-Focused Gap Analysis:**
- 🔴 **Critical Gap:** No performance benchmarks ("this skill saves X min/day")
- 🔴 **Critical Gap:** No before/after proof for skeptics
- 🔴 **Critical Gap:** Current shipped features all require active effort
- 🟡 **Partial:** Uninstall exists but no "try for 5 min, auto-remove if unused"

---

### Contribution-Focused Archetype

*"I want recognition for my skills / consistent tools across my team"*

| Feature | B1: Cognitive Load | B2: Status Quo | B3: Tool Fatigue | B4: Identity | B5: Trust Deficit |
|---------|-------------------|----------------|------------------|--------------|-------------------|
| **F1: Search** | 🟡 | 🟡 | 🟡 | 🟢 Findable | 🟡 |
| **F2: Get Details** | 🟡 | 🟡 | 🟡 | 🟢 Attribution | 🟡 |
| **F3: Install** | 🟢 | 🟢 Team adoption | 🟢 | 🟢 | 🟡 |
| **F4: Validate** | 🟢 Quality check | 🟡 | 🟡 | 🟢 Standards | 🟢 Governance |
| **F5: Compare** | 🟢 Team decisions | 🟡 | 🟡 | 🟢 Fair eval | 🟢 Objective |
| **F6: Quality Breakdown** | 🟢 Criteria known | 🟡 | 🟢 | 🟢 Fair scoring | 🟢 Transparent |
| **F7: Security Visibility** | 🟢 | 🟡 | 🟢 | 🟢 Professional | 🟢 Team safety |
| **F8: Slash Commands** | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 |
| **F9: Contextual Recs** | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 |
| **F10: VS Code Ext** | 🟡 | 🟢 Team tool | 🟡 | 🟢 | 🟡 |
| **F11: Attribution** | 🟢 Visible credit | 🟢 | 🟡 | 🟢 Recognition | 🟢 |
| **F12: Progress Track** | 🟢 Team metrics | 🟢 | 🟡 | 🟢 Impact | 🟢 Evidence |
| **F13: Social Proof** | 🟢 | 🟢 | 🟢 | 🟢 Adoption | 🟢 |
| **F14: Team Libraries** | 🟢 Governance | 🟢 Standardize | 🟢 Curated | 🟢 Control | 🟢 Vetted |
| **F15: Author Analytics** | 🟢 Insights | 🟢 | 🟡 | 🟢 Recognition | 🟢 Feedback |
| **F16: Quick Wins** | 🟡 | 🟢 Easy adoption | 🟢 | 🟢 | 🟢 |

**Contribution-Focused Gap Analysis:**
- 🔴 **Critical Gap:** No author dashboard or usage analytics
- 🔴 **Critical Gap:** No team admin or governance features
- 🔴 **Critical Gap:** No skill publishing/distribution workflow
- 🟡 **Partial:** Quality score exists but breakdown (SMI-823) not shipped

---

## Consolidated Gap Analysis

### Critical Gaps (No Coverage)

| Gap | Affected Archetypes | Behavioral Blocker | Severity |
|-----|---------------------|-------------------|----------|
| **Passive Discovery** | Discovery, Efficiency | B1, B2, B3 | 🔴 Critical |
| **Performance Benchmarks** | Efficiency | B5 | 🔴 Critical |
| **Single "Just Use This" Rec** | Discovery | B3 | 🔴 Critical |
| **Author Analytics** | Contribution | B4 | 🔴 Critical |
| **Team Governance** | Contribution | B2, B5 | 🔴 Critical |
| **Before/After Proof** | Efficiency | B2, B5 | 🔴 Critical |

### Partial Coverage (Needs Strengthening)

| Area | Current State | Gap |
|------|--------------|-----|
| **Trust Signals** | Quality score + security scan | No usage data, no benchmarks |
| **Discoverability** | Search exists | Requires intent, no ambient |
| **Onboarding** | Install docs | No guided quick wins |
| **Social Proof** | Trust tier exists | No "X projects use this" |

---

## Testing Priorities

Based on the matrix, user testing should validate:

### Priority 1: Critical Assumptions (Test First)

| Assumption | Test Method | Success Criteria |
|------------|-------------|------------------|
| Users will actively search for skills | Task: "Find a testing skill" | Time < 2 min, success > 80% |
| Quality score is trusted | Survey after viewing | Trust rating > 3.5/5 |
| Security visibility prevents install failures | Compare w/ vs w/o | Blocked installs ↓ 50% |
| Compare feature aids decision | A/B: with vs without | Decision time ↓ 30% |

### Priority 2: Behavioral Hypotheses

| Hypothesis | Test Method | Success Criteria |
|------------|-------------|------------------|
| Slash commands reduce friction | Task: search via /skillsmith vs CLI | Preference > 70% |
| Contextual recs increase discovery | Prototype test | Engagement > 40% |
| Social proof increases install rate | A/B: with vs without | Install ↑ 25% |

### Priority 3: Archetype Validation

| Archetype | Screening Question | Key Task |
|-----------|-------------------|----------|
| Discovery | "Do you explore new tools often?" | Open-ended discovery |
| Efficiency | "Do you prioritize speed over features?" | Time-pressure task |
| Contribution | "Have you created dev tools?" | Author journey test |

---

## Feature Prioritization Insights

### Highest Impact (Address Multiple Blockers, Multiple Archetypes)

| Feature | Blockers Addressed | Archetypes | Priority |
|---------|-------------------|------------|----------|
| **F9: Contextual Recs** | B1, B2, B3 | All 3 | 🔴 P0 |
| **F11: Attribution** | B2, B4, B5 | All 3 | 🔴 P0 |
| **F13: Social Proof** | B2, B3, B5 | All 3 | 🔴 P0 |
| **F8: Slash Commands** | B1, B2, B3 | Discovery, Efficiency | 🟠 P1 |
| **F7: Security Visibility** | B1, B5 | All 3 | 🟠 P1 |

### Medium Impact (Single Archetype, Strong Fit)

| Feature | Primary Archetype | Blockers | Priority |
|---------|------------------|----------|----------|
| **F16: Quick Wins** | Efficiency | B2, B5 | 🟠 P1 |
| **F6: Quality Breakdown** | All | B5 | 🟡 P2 |
| **F14: Team Libraries** | Contribution | B2, B5 | 🟡 P2 |

### Lower Impact (Nice to Have)

| Feature | Notes | Priority |
|---------|-------|----------|
| **F12: Progress Track** | Retention, not acquisition | 🟢 P3 |
| **F15: Author Analytics** | Niche audience | 🟢 P3 |
| **F10: VS Code Ext** | Subset of users | 🟢 P3 |

---

## Strategic Recommendations

### 1. The Passive Discovery Imperative

**Current state:** All discovery requires active user effort
**Research finding:** 95% never change defaults; discovery must come to users
**Recommendation:** Prioritize F9 (Contextual Recs) and F11 (Attribution) before any other vision features

### 2. Trust Before Features

**Current state:** Quality score is a number without explanation
**Research finding:** Only 43% trust AI accuracy
**Recommendation:** Ship SMI-823 (Quality Breakdown) and SMI-825 (Security Visibility) before expanding feature set

### 3. The Efficiency-Focused Are Hardest to Convert

**Current state:** No proof of value, no benchmarks
**Research finding:** Skeptics need evidence, not promises
**Recommendation:** Add performance benchmarks or testimonial data before targeting this segment

### 4. Contribution-Focused Are Underserved

**Current state:** No author features beyond validate
**Research finding:** "Distribution is my #1 problem" - creators
**Recommendation:** Author analytics (F15) and publishing workflow needed for this segment

---

## Appendix: Research Sources

- Cross-Layer Insights Summary
- Layer 3 Behavioral Synthesis
- First Discovery Journey
- Trust-Building Moments
- Personas Index
- 150+ sources across Reddit, HN, Twitter, Substack, academic research

---

*Product-Fit Matrix - December 30, 2024*
