# User Testing Findings - Charles (January 20, 2025)

## Session Context
- **Tester**: Charles (technical user, no frameworks in repo, small surface area codebase)
- **Date**: January 20, 2025
- **Focus**: First-time user onboarding and skill recommendation quality

---

## Issues Identified

### Issue 1: Node Version Conflict (Global vs Local)
**Priority**: High
**Type**: Onboarding/DX

**Problem**: User had conflicting global and local Node versions. Updating one didn't update the other, causing skillsmith to fail with version mismatch errors (requires Node 22).

**User Quote**: "I have no money as like a hard credit version somewhere... I don't know why I have node as like a hard credit version somewhere"

**Impact**: Blocked installation entirely until resolved manually.

**Recommendation**:
- Add Node version detection to CLI with helpful error messaging
- Suggest using `nvm` or provide commands to diagnose version conflicts
- Consider documenting common version conflict scenarios

---

### Issue 2: npm Permission Denied Errors
**Priority**: Medium
**Type**: Onboarding/DX

**Problem**: Inconsistent npm permission errors - sometimes requires `sudo`, sometimes doesn't. Unclear what triggers the difference.

**User Quote**: "Sometimes an npm just works. Sometimes you got a pseudo npm like, it's not clear what the trigger is"

**Recommendation**:
- Document common permission scenarios in getting started guide
- Consider adding permission check to CLI with remediation suggestions

---

### Issue 3: Local vs Global Skills Directory Search
**Priority**: High
**Type**: Bug

**Problem**: Skillsmith checked the global home directory for skills (`~/.claude/skills/`) but did not check the local project directory (`.claude/skills/`). User had a valid skill in their project but skillsmith reported "no skills installed."

**Steps to Reproduce**:
1. Have a skill in project directory at `.claude/skills/skill-name/SKILL.md`
2. Have no skills in global `~/.claude/skills/`
3. Run skillsmith list command
4. Result: Reports no skills found

**Expected**: Should search both global and local skill directories.

**User Quote**: "I checked the wrong location. The home directory, Global skills, but the skill is in... project directory"

---

### Issue 4: Recommendations Irrelevant for Low-Surface-Area Repos
**Priority**: High
**Type**: Feature/Algorithm

**Problem**: For repos with minimal dependencies/frameworks, recommendations defaulted to generic skills or entire skill collections rather than useful development-focused skills.

**Context**:
- Repo had 76 files, zero frameworks detected
- Returned 5 recommendations, but they were generic (e.g., "closet-dev" - entire collection of cloud skills)

**What User Actually Needed**:
- Code review skills
- Development best practices
- Skills that make Claude a better development partner
- Skills that prevent "horrible code hangups"

**User Quote**: "The area for my writing... is like code reviews... I'm a very technical [person]. I need to prevent myself from getting into these horrible code hangups. Like, what are some best practices for helping?"

**Recommendation**:
- Add "persona" or "role" based recommendations (e.g., solo developer, code quality focus)
- When no frameworks detected, recommend universal development skills (code review, testing, documentation)
- Consider asking clarifying questions about user needs when repo surface area is small

---

### Issue 5: Skill Recommendation Granularity
**Priority**: Medium
**Type**: UX/Algorithm

**Problem**: One recommendation returned an entire repository of skills rather than specific individual skills.

**User Quote**: "It's given me the entire repo for... closet-dev. So I think this isn't quite right."

**Recommendation**:
- Ensure recommendations are for individual skills, not skill collections/repos
- If a collection is relevant, surface the specific skills within it that match

---

## Golden Data Set Insight

Charles provided valuable framing for building evaluation data:

> "My data set is like if I think about the kinds of skills that would be most helpful to me. It is things that make Claude a better development partner for me as a technical person."

**Key Persona Identified**: Technical developer working on small/simple codebases who needs:
1. Code review assistance
2. Best practices enforcement
3. Development partnership skills
4. Quality gates and checks

This represents a gap in current recommendations which over-index on framework-specific skills.

---

## Recommended Linear Issues

| Title | Priority | Labels |
|-------|----------|--------|
| CLI: Add Node version detection with helpful error messages | High | `dx`, `cli`, `onboarding` |
| Bug: Search both global and local skill directories | High | `bug`, `cli` |
| Feature: Role-based skill recommendations for low-surface-area repos | High | `feature`, `recommendations` |
| Fix: Ensure recommendations return individual skills, not collections | Medium | `bug`, `recommendations` |
| Docs: Add npm permission troubleshooting guide | Low | `docs`, `onboarding` |

---

## Testing Framework Insights (Bonus)

Charles also provided valuable input on evaluation methodology:

1. **Gold Data**: User-validated skill recommendations for specific repos
2. **Silver Data**: Existing repos with human-configured skills (e.g., linters, Claude.md files)
3. **LLM-as-Judge**: Use Langfuse for classification evals and prompt engineering
4. **Performance Testing**: Compare semantic embedding recommendations against naive LLM recommendations

Consider implementing evaluation pipeline with these data tiers.
