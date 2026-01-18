# ADR-020: Phase 4 Security Hardening (AIDefence, Trust-Tier, E2B Sandbox)

**Status**: Accepted
**Date**: 2026-01-17
**Deciders**: Skillsmith Team
**Issues**: SMI-1532, SMI-1533, SMI-1534

## Context

As part of the Claude-Flow V3 Migration, Phase 4 focused on security hardening to protect against sophisticated AI prompt injection attacks. The existing SecurityScanner (ADR-008) provided foundational security patterns, but lacked:

1. **AI-Specific Attack Detection**: No patterns for prompt injection, jailbreak attempts, or conversation boundary manipulation
2. **Trust-Based Scanning**: Same scanning intensity regardless of skill source (verified vs experimental)
3. **Sandboxed Execution**: No isolation for testing untrusted skills before installation
4. **Concurrent Install Protection**: Race conditions possible during manifest updates

## Decision

### Decision 1: CVE-Hardened AI Defence Patterns (SMI-1532)

**What**: Add 16 specialized patterns to detect AI prompt injection attacks.

**Why**: Skills contain natural language that could manipulate Claude's behavior through:
- Role injection (`system:`, `assistant:`, `user:`)
- Hidden instruction brackets (`[[ignore previous instructions]]`)
- HTML/XML comment injection (`<!-- system: ignore -->`)
- Unicode homograph attacks (Cyrillic characters that look like Latin)
- Base64-encoded payloads
- CRLF injection for prompt boundary manipulation

**How**: Implemented in `AI_DEFENCE_PATTERNS` array with two-pass scanning:
1. **Full-content pass**: Multi-line patterns (CRLF, delimiter injection)
2. **Line-by-line pass**: Single-line patterns with documentation context awareness

**Performance**: Sub-10ms scan time verified via benchmarks (100 scans < 500ms).

```typescript
export const AI_DEFENCE_PATTERNS = [
  /(?:^|\s)(?:system|assistant|user)\s*:\s*(?:\n|$)/i,  // Role injection
  /\[\[\s*[^\]]{1,200}\s*\]\]/,                          // Hidden brackets
  /<!--[\s\S]{0,100}?(?:ignore|override|bypass)[\s\S]{0,100}?-->/i,
  // ... 13 more patterns
]
```

### Decision 2: Trust-Tier Sensitive Scanning (SMI-1533)

**What**: Apply different security thresholds based on skill trust tier.

**Why**: Verified skills from Anthropic should have minimal friction, while unknown skills need maximum scrutiny.

**How**: Four-tier configuration:

| Tier | Risk Threshold | Max Size | Use Case |
|------|---------------|----------|----------|
| `verified` | 70 | 2MB | Anthropic-verified skills |
| `community` | 40 | 1MB | Community-reviewed skills |
| `experimental` | 25 | 500KB | New/beta skills |
| `unknown` | 20 | 250KB | Direct GitHub installs |

**Additional Security**:
- URL hostname validation (only `github.com` allowed)
- File locking for manifest operations (prevents race conditions)
- Atomic writes via temp file + rename
- PKI verification stub for future 'verified' tier authentication

### Decision 3: E2B Sandbox Execution (SMI-1534)

**What**: Create isolated execution environment for testing untrusted skills.

**Why**: Skills may contain executable code (test files, examples) that should not run on the host system.

**How**: `SkillSandbox` class wrapping E2B (e2b.dev):
- Dynamic import for optional dependency (graceful degradation)
- Native `import()` instead of `new Function()` for CSP compliance
- Network isolation with runtime verification
- 30-second timeout with proper cleanup
- Debug logging for cleanup errors (not silent swallowing)

```typescript
const sandbox = new SkillSandbox({ allowNetwork: false, timeout: 30000 })
try {
  await sandbox.create()
  await sandbox.copySkill(skillContent)
  const result = await sandbox.execute('node test.js')
} finally {
  await sandbox.destroy()
}
```

## Consequences

### Positive
- Blocks sophisticated prompt injection attacks before skill installation
- Trust-tier system balances security with usability
- Sandboxed execution enables safe testing of untrusted code
- Race conditions eliminated via file locking
- Sub-10ms performance maintains responsive install experience

### Negative
- 16 new regex patterns increase scan complexity
- E2B dependency is optional (features degraded without it)
- 'verified' tier lacks cryptographic signature verification (future work)
- Network isolation verification adds ~2s to sandbox creation

### Neutral
- Documentation context detection reduces false positives but may miss legitimate attacks in code blocks
- JSON structure injection pattern refined to reduce false positives on legitimate config files

## Alternatives Considered

### Alternative 1: External AI Safety Service
- Pros: Continuously updated patterns, ML-based detection
- Cons: Network latency, cost, availability dependency
- Why rejected: Local scanning preferred for offline operation and sub-10ms requirement

### Alternative 2: Container-based Sandbox (Docker)
- Pros: More widely available than E2B
- Cons: Requires Docker daemon, slower startup, complex networking
- Why rejected: E2B provides simpler API and faster cold start

### Alternative 3: Same Scanning for All Tiers
- Pros: Simpler implementation
- Cons: Either too strict for verified skills or too lenient for unknown
- Why rejected: Trust-based approach provides better UX while maintaining security

## References

- [OWASP LLM Top 10: LLM01 Prompt Injection](https://owasp.org/www-project-llm-top-10/)
- [ADR-008: Security Hardening Phase 2d](008-security-hardening-phase.md)
- [E2B Sandbox Documentation](https://e2b.dev/docs)
- [GitHub Security Advisory: GHSA-8qq5-rm4j-mr97](https://github.com/advisories/GHSA-8qq5-rm4j-mr97)

## Files Modified

| File | Changes |
|------|---------|
| `packages/core/src/security/SkillSandbox.ts` | New - E2B sandbox wrapper |
| `packages/core/src/security/scanner/patterns.ts` | +66 lines - AI_DEFENCE_PATTERNS |
| `packages/core/src/security/scanner/SecurityScanner.ts` | +143 lines - scanAIDefenceVulnerabilities |
| `packages/core/src/security/scanner/types.ts` | +2 lines - 'ai_defence' type |
| `packages/core/src/security/scanner/weights.ts` | +1 line - ai_defence weight (1.9) |
| `packages/mcp-server/src/tools/install.ts` | +235 lines - Trust-tier, locking, URL validation |
