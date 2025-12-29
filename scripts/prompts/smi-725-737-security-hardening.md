# SMI-725 to SMI-737: Security Hardening Swarm

Execute this prompt in a separate terminal session to run the security hardening issues as a coordinated swarm.

## Quick Start

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith

# Run as a development swarm with parallel execution
npx claude-flow@alpha swarm "Execute SMI-725 through SMI-737 security hardening issues for Skillsmith" \
  --strategy development \
  --mode hierarchical \
  --max-agents 8 \
  --parallel \
  --monitor
```

## Alternative: Claude Code Direct Execution

Copy and paste this prompt into a new Claude Code session:

---

## Swarm Execution Prompt

You are executing a security hardening swarm for the Skillsmith project. Complete all 13 issues (SMI-725 through SMI-737) using parallel agent execution.

### Project Context

- **Repository**: `/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith`
- **Project**: Skillsmith Phase 2b: Recommendations
- **Documentation**:
  - Security standards: `docs/security/index.md`
  - Engineering standards: `docs/architecture/standards.md`
  - Schema: `packages/core/src/db/schema.ts`

### Issues to Execute

#### Group 1: CI/CD & DevOps (SMI-725, SMI-727)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-725 | Add security scanning to CI pipeline | P1 |
| SMI-727 | Add pre-push formatting check hook | P3 |

**Agent**: DevOps Specialist
**Files**: `.github/workflows/ci.yml`, `.husky/pre-push`

#### Group 2: Security Implementation (SMI-726, SMI-729, SMI-731, SMI-732, SMI-733)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-726 | Standardize adapter input validation patterns | P2 |
| SMI-729 | Add IPv6 SSRF protection | P2 |
| SMI-731 | Add Content-Security-Policy headers | P3 |
| SMI-732 | Add input sanitization library | P2 |
| SMI-733 | Add structured audit logging | P2 |

**Agent**: Security Specialist
**Files**:
- `packages/core/src/utils/validation.ts` (new)
- `packages/core/src/utils/sanitize.ts` (new)
- `packages/core/src/sources/RawUrlSourceAdapter.ts`
- `packages/core/src/db/schema.ts`

#### Group 3: DX & Utilities (SMI-728, SMI-730)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-728 | Consolidate logger usage across codebase | P3 |
| SMI-730 | Consolidate rate limiting with shared utility | P3 |

**Agent**: Code Analyzer / Refactoring Specialist
**Files**:
- `packages/core/src/utils/logger.ts`
- `packages/core/src/utils/rateLimiter.ts` (new)
- `packages/core/src/sources/BaseSourceAdapter.ts`

#### Group 4: Documentation (SMI-734, SMI-735, SMI-736, SMI-737)

| Issue | Title | Priority |
|-------|-------|----------|
| SMI-734 | Create security standards source of truth | P1 | ✅ DONE |
| SMI-735 | Create security review checklist template | P1 | ✅ DONE |
| SMI-736 | Update code review standards with schema reference | P2 | ✅ DONE |
| SMI-737 | Create ADR-007 for rate limiting consolidation | P3 |

**Agent**: Documentation Specialist
**Files**: `docs/adr/007-rate-limiting-consolidation.md`

**Note**: SMI-734, SMI-735, SMI-736 are already complete. Only SMI-737 remains.

### Execution Instructions

1. **Initialize swarm with hierarchical topology**:
```
Use mcp__claude-flow__swarm_init with topology: "hierarchical", maxAgents: 8, strategy: "specialized"
```

2. **Spawn specialized agents in parallel**:
```
Spawn these agents concurrently using Claude Code's Task tool:

Task("DevOps Agent", "Execute SMI-725 and SMI-727: Add security scanning to CI and pre-push formatting hook", "cicd-engineer")

Task("Security Agent 1", "Execute SMI-726: Create shared validation utility in packages/core/src/utils/validation.ts with validateUrl() and validatePath() functions. Migrate LocalFilesystemAdapter and RawUrlSourceAdapter to use it.", "security-manager")

Task("Security Agent 2", "Execute SMI-729: Add IPv6 SSRF protection to RawUrlSourceAdapter.ts. Block fc00::/7, fe80::/10, ::1, ::ffff:x.x.x.x ranges.", "security-manager")

Task("Security Agent 3", "Execute SMI-731, SMI-732: Add CSP headers and input sanitization. Evaluate validator.js, create sanitize.ts utility.", "security-manager")

Task("Security Agent 4", "Execute SMI-733: Implement audit_logs table in schema.ts. Create AuditLogger utility. Add logging to source adapters.", "security-manager")

Task("Refactoring Agent", "Execute SMI-728, SMI-730: Consolidate logger and rate limiter. Audit console calls, create rateLimiter.ts with token bucket strategy.", "code-analyzer")

Task("Docs Agent", "Execute SMI-737: Create ADR-007 for rate limiting consolidation in docs/adr/007-rate-limiting-consolidation.md", "api-docs")
```

3. **Coordinate via memory**:
```
Store shared context in memory:
- memory_usage action: "store", key: "swarm/security-hardening/context"
- Include: schema patterns, validation patterns, existing security code locations
```

4. **Run tests after each implementation**:
```bash
docker exec skillsmith-dev-1 npm run typecheck
docker exec skillsmith-dev-1 npm test
```

5. **Mark issues as Done in Linear when complete**:
```bash
npm run linear:done SMI-XXX
```

### Acceptance Criteria

#### SMI-725: Security Scanning CI
- [ ] npm audit runs in CI with --audit-level=high
- [ ] Blocks merge on high/critical vulnerabilities
- [ ] Report uploaded as artifact

#### SMI-726: Validation Utility
- [ ] `packages/core/src/utils/validation.ts` created
- [ ] `validateUrl()` with SSRF checks
- [ ] `validatePath()` with traversal checks
- [ ] Adapters migrated to use shared utility
- [ ] Tests added

#### SMI-727: Pre-push Hook
- [ ] `.husky/pre-push` created
- [ ] Runs `prettier --check .`
- [ ] Blocks push on formatting errors

#### SMI-728: Logger Consolidation
- [ ] All console.log/warn/error replaced with createLogger()
- [ ] Logger utility has all methods (info, debug, warn, error)
- [ ] Tests verify logger behavior

#### SMI-729: IPv6 SSRF
- [ ] Block fc00::/7 (unique local)
- [ ] Block fe80::/10 (link-local)
- [ ] Block ::1 (localhost)
- [ ] Block ::ffff:x.x.x.x (IPv4-mapped)
- [ ] Tests for IPv6 validation

#### SMI-730: Rate Limiter Utility
- [ ] `packages/core/src/utils/rateLimiter.ts` created
- [ ] Token bucket strategy implemented
- [ ] Sliding window strategy implemented
- [ ] BaseSourceAdapter migrated
- [ ] ADR-007 documents decision

#### SMI-731: CSP Headers
- [ ] CSP headers added to MCP responses
- [ ] Inline scripts blocked
- [ ] Documentation updated

#### SMI-732: Sanitization Library
- [ ] validator.js or similar added to dependencies
- [ ] `packages/core/src/utils/sanitize.ts` created
- [ ] Existing validation migrated

#### SMI-733: Audit Logging
- [ ] `audit_logs` table added to schema.ts
- [ ] Migration created
- [ ] AuditLogger utility created
- [ ] Source adapters log fetch/access events

#### SMI-737: ADR-007
- [ ] `docs/adr/007-rate-limiting-consolidation.md` created
- [ ] Documents current state
- [ ] Documents decision and rationale
- [ ] `docs/adr/index.md` updated

### Hooks for Coordination

Each agent should run these hooks:

```bash
# Before starting work
npx claude-flow@alpha hooks pre-task --description "Starting SMI-XXX"

# After completing a file
npx claude-flow@alpha hooks post-edit --file "path/to/file.ts" --memory-key "swarm/security/SMI-XXX"

# After completing issue
npx claude-flow@alpha hooks post-task --task-id "SMI-XXX"
npx claude-flow@alpha hooks notify --message "Completed SMI-XXX: [title]"
```

### Dependencies

Execute in this order due to dependencies:

```
Phase 1 (Parallel):
├── SMI-726 (Validation utility - needed by others)
├── SMI-728 (Logger consolidation)
└── SMI-737 (ADR-007 - docs only)

Phase 2 (Parallel, after Phase 1):
├── SMI-729 (IPv6 SSRF - uses validation utility)
├── SMI-730 (Rate limiter - needs logger)
├── SMI-732 (Sanitization library)
└── SMI-725 (CI security scanning)

Phase 3 (Parallel, after Phase 2):
├── SMI-731 (CSP headers)
├── SMI-733 (Audit logging - needs schema ready)
└── SMI-727 (Pre-push hook)
```

### Final Verification

After all issues complete:

```bash
# Full test suite
docker exec skillsmith-dev-1 npm test

# Type check
docker exec skillsmith-dev-1 npm run typecheck

# Lint
docker exec skillsmith-dev-1 npm run lint

# Standards audit
docker exec skillsmith-dev-1 npm run audit:standards

# Commit all changes
git add -A
git commit -m "feat(security): implement security hardening (SMI-725 to SMI-737)

Security improvements:
- SMI-725: Security scanning in CI
- SMI-726: Shared validation utility
- SMI-727: Pre-push formatting hook
- SMI-728: Logger consolidation
- SMI-729: IPv6 SSRF protection
- SMI-730: Rate limiter utility
- SMI-731: CSP headers
- SMI-732: Input sanitization library
- SMI-733: Audit logging

Documentation:
- SMI-737: ADR-007 rate limiting

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push origin main
```

---

## One-Line Swarm Command

For quick execution with all context:

```bash
cd /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith && \
npx claude-flow@alpha swarm \
  "Execute Skillsmith security hardening: SMI-725 (CI security), SMI-726 (validation utility), SMI-727 (pre-push hook), SMI-728 (logger), SMI-729 (IPv6 SSRF), SMI-730 (rate limiter), SMI-731 (CSP), SMI-732 (sanitization), SMI-733 (audit logs), SMI-737 (ADR). Skip SMI-734/735/736 (done). Reference docs/security/index.md for patterns. Run tests after each change. Mark Linear issues done on completion." \
  --strategy development \
  --mode hierarchical \
  --max-agents 8 \
  --parallel \
  --monitor \
  --output json
```
