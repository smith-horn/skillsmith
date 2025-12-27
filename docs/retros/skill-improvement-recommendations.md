# Skill Improvement Recommendations

**Based on**: Skillsmith Phase 0 Session (December 27, 2025)
**Skills Reviewed**: Linear, Docker, Governance

---

## Executive Summary

This session revealed gaps in skill documentation that caused friction during first-time project setup. The primary issues were:

1. **Docker skill assumes Alpine works** - but native modules require glibc
2. **Governance skill commands don't use Docker** - contradicts Docker-first mandate
3. **Skills lack cross-references** - users must mentally integrate multiple skills
4. **No "Lessons Learned" pattern** - knowledge isn't captured for future projects

---

## Skill Analysis

### Linear Skill (1,032 lines)

**Strengths**:
- Comprehensive Quick Start with setup verification script
- MCP reliability matrix documents known issues upfront
- Helper scripts for unreliable MCP operations
- "Codebase Verification Before Work" section (excellent pattern)
- Project updates, milestones, resource links patterns

**Gaps Identified**:

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| No retro pattern | Ad-hoc retrospectives | Add "Phase Retrospective Workflow" section |
| No forward reference pattern | Issues lack context links | Add "Forward References" section for linking ADRs/retros |
| No phase completion workflow | Manual status updates | Add "Phase Completion Checklist" |

**Suggested Addition**:

```markdown
## Phase Retrospective Workflow

After completing a phase:

1. Create retro document: `docs/retros/phase-N-name.md`
2. Update Linear issues with retro link
3. Create forward reference issues for Phase N+1
4. Add project update with lessons learned

### Forward References

When creating issues, link to context:

- [ADR-XXX](docs/adr/XXX.md) - Why this approach
- [Phase N Retro](docs/retros/phase-N.md) - Lessons learned
- [Standards §X.X](docs/architecture/standards.md) - Governing policy
```

---

### Docker Skill (306 lines)

**Strengths**:
- Clear enforcement rules upfront (BLOCKED COMMANDS)
- Pre-flight check requirement
- Architecture diagram
- Troubleshooting section

**Critical Gaps**:

| Gap | Impact This Session | Recommendation |
|-----|---------------------|----------------|
| Uses Alpine in template | `ERR_DLOPEN_FAILED` for onnxruntime | **Change default to node:20-slim** |
| No glibc vs musl warning | 2 hours debugging native modules | Add "Native Module Compatibility" section |
| No rebuild after Dockerfile change | Stale images with wrong libc | Add "Image Rebuild Workflow" |

**Suggested Additions**:

```markdown
## Native Module Compatibility (CRITICAL)

### glibc vs musl

Many Node.js native modules require **glibc** (GNU C Library). Alpine Linux uses **musl** which is incompatible.

**Problematic Modules**:
| Module | Issue on Alpine |
|--------|-----------------|
| `better-sqlite3` | May fail with `ERR_DLOPEN_FAILED` |
| `onnxruntime-node` | Requires `ld-linux-aarch64.so.1` (glibc only) |
| `sharp` | Needs glibc for image processing |
| `bcrypt` | Native bindings fail |

**Solution**: Use Debian-based images:

```dockerfile
# ❌ AVOID for projects with native modules
FROM node:20-alpine

# ✅ USE for native module compatibility
FROM node:20-slim
```

### When to Use Alpine vs Slim

| Project Type | Recommended Base | Reason |
|--------------|------------------|--------|
| Pure JS/TS (no native modules) | `node:20-alpine` | Smaller image |
| SQLite, ML, image processing | `node:20-slim` | glibc required |
| Unknown dependencies | `node:20-slim` | Safe default |

### Detecting Native Module Issues

If you see these errors, switch to `-slim`:

```
Error: Error loading shared library ld-linux-aarch64.so.1
ERR_DLOPEN_FAILED
cannot open shared object file
```
```

**Update Template**:

```yaml
# docker-compose.yml - UPDATED DEFAULT
services:
  dev:
    build:
      context: .
      dockerfile: Dockerfile
    # ... rest unchanged

# Dockerfile - UPDATED DEFAULT
FROM node:20-slim  # Changed from alpine for native module compatibility

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*
```

---

### Governance Skill (292 lines)

**Strengths**:
- Two-document model (CLAUDE.md + standards.md)
- Quick start with setup verification
- Anti-patterns vs correct patterns
- Replication instructions for new projects

**Gaps Identified**:

| Gap | Impact | Recommendation |
|-----|--------|----------------|
| Commands don't use Docker | Contradicts Docker-first mandate | Prefix all commands with `docker exec` |
| No Docker skill cross-reference | Users don't know to check Docker skill | Add "Prerequisites" section |
| No ADR index maintenance | ADRs get lost | Add ADR index update step |
| No retro template | Inconsistent retrospectives | Add retro template |

**Suggested Updates**:

```markdown
## Prerequisites

Before using this skill, ensure:

1. **Docker skill is active** - All commands run in Docker
2. **Container is running** - `docker ps | grep <project>`
3. **Dependencies installed** - `docker exec <container> npm install`

> See [Docker Skill](~/.claude/skills/docker/SKILL.md) for container setup.

## Common Operations (Docker-First)

```bash
# Check standards compliance (IN DOCKER)
docker exec <container> npm run audit:standards

# Typecheck before commit (IN DOCKER)
docker exec <container> npm run typecheck
docker exec <container> npm run lint
docker exec <container> npm test

# Run governance check
docker exec <container> node .claude/skills/governance/scripts/governance-check.mjs
```

## Retro Template

Create `docs/retros/phase-N-name.md`:

```markdown
# Phase N Retrospective: [Name]

**Date**: YYYY-MM-DD
**Status**: Completed

## Summary
[1-2 sentences]

## What Was Accomplished
| Deliverable | Status | Notes |

## Issues Encountered & Resolutions
### 1. [Issue Name] (SMI-XXX)
**Issue**: [Description]
**Root Cause**: [Why it happened]
**Resolution**: [How it was fixed]
**Documentation**: [ADR-XXX if applicable]

## Lessons Learned
1. [Lesson 1]
2. [Lesson 2]

## Forward References
| Issue | Description | Documentation |
```
```

---

## Cross-Skill Integration

### Recommended Skill Loading Order

For new projects:

1. **Docker** (first) - Establishes execution environment
2. **Governance** (second) - Sets standards and processes
3. **Linear** (third) - Project management integration

### Cross-Reference Matrix

| When Using | Should Reference | For |
|------------|------------------|-----|
| Governance | Docker | Command execution prefixes |
| Governance | Linear | Issue linking in commits |
| Docker | Governance | Standards for Dockerfile |
| Linear | Governance | ADR/retro linking |
| Linear | Docker | CI/CD environment requirements |

### Suggested Skill Header Update

Add to each skill's frontmatter or Quick Start:

```markdown
## Related Skills

| Skill | Relationship |
|-------|--------------|
| [Docker](~/.claude/skills/docker/SKILL.md) | Execute all commands in container |
| [Governance](~/.claude/skills/governance/SKILL.md) | Standards enforcement |
| [Linear](~/.claude/skills/linear/SKILL.md) | Issue tracking |
```

---

## New Pattern: Lessons Learned Section

Add to each skill:

```markdown
## Lessons Learned (Living Document)

This section captures learnings from real project usage. Add new lessons as they're discovered.

### [Date] - [Project Name]
**Context**: [What was being done]
**Issue**: [What went wrong]
**Learning**: [What to do differently]
**Documentation**: [ADR/Retro link if applicable]
```

This creates institutional memory that improves over time.

---

## Implementation Priority

### P0 - Critical (Before Next Project)

1. **Docker Skill**: Change default template from Alpine to Slim
2. **Docker Skill**: Add "Native Module Compatibility" section
3. **Governance Skill**: Add Docker command prefixes

### P1 - Important (Next Sprint)

4. **All Skills**: Add cross-references section
5. **Governance Skill**: Add retro template
6. **Linear Skill**: Add phase completion workflow

### P2 - Nice to Have (Backlog)

7. **All Skills**: Add "Lessons Learned" section
8. **Create**: Skill integration guide
9. **Create**: New project bootstrap script that validates all skills

---

## Appendix: This Session's Learnings Applied

| Learning | Applied To |
|----------|------------|
| Alpine → Slim for glibc | Docker skill template |
| Commands need Docker prefix | Governance skill |
| Retros need forward references | Linear skill |
| ADRs capture decisions | All skills should reference ADR process |
| Cross-skill dependencies exist | Need explicit cross-references |

---

*Generated from Skillsmith Phase 0 retrospective session*
