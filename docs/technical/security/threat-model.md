# Threat Model

> **Navigation**: [Security Index](./index.md) | [Technical Index](../index.md)
>
> **Research Reference**: [Security Research](../../research/skill-conflicts-security.md#part-2-security-deep-dive)

---

## Threat Summary

| Threat | Severity | Likelihood | Mitigation Status |
|--------|----------|------------|-------------------|
| Malicious SKILL.md instructions | Critical | Medium | Partial (scanning) |
| Prompt injection via skills | Critical | Medium | Limited (pattern detection) |
| Skill impersonation (typosquatting) | High | Medium | Implemented |
| Dependency hijacking | Medium | Low | Partial (pinning advice) |
| Author key compromise | Medium | Low | Future (signing) |

---

## Threat Details

### 1. Malicious SKILL.md Instructions

**Severity:** Critical
**Likelihood:** Medium

**Description:** A skill author could embed malicious instructions in SKILL.md that cause Claude to:
- Exfiltrate sensitive data from the user's codebase
- Execute destructive commands
- Modify files in unexpected ways
- Bypass security controls

**Current Mitigations:**
- Static analysis for known jailbreak patterns
- Trust tier system to flag unverified skills
- Blocklist for known malicious skills

**Gaps:**
- Cannot detect novel attack patterns
- No runtime monitoring
- No capability restrictions

---

### 2. Prompt Injection via Skills

**Severity:** Critical
**Likelihood:** Medium

**Description:** Crafted skill content could manipulate Claude's behavior beyond the skill's stated purpose through prompt injection techniques.

**Attack Vectors:**
- Hidden instructions in skill descriptions
- Encoded content that decodes to malicious instructions
- Adversarial prompts disguised as legitimate content

**Current Mitigations:**
- Pattern detection for known injection attempts
- Entropy analysis for obfuscation detection
- Content length limits

**Gaps:**
- Emerging attack techniques may bypass detection
- No sandboxing at runtime

---

### 3. Skill Impersonation (Typosquatting)

**Severity:** High
**Likelihood:** Medium

**Description:** Malicious actors could create skills with names similar to popular skills to trick users into installing them.

**Examples:**
- `anthropic/test-fixing` vs `anthroplc/test-fixing` (l vs 1)
- `react-helper` vs `react-helpper` (typo)

**Current Mitigations:**
- Levenshtein distance detection
- Character substitution detection (l/1, O/0)
- Warning before installation

**Effectiveness:** High - this threat is well-addressed

---

### 4. Dependency Hijacking

**Severity:** Medium
**Likelihood:** Low

**Description:** Skills may have external dependencies that could be compromised.

**Attack Vectors:**
- Compromised npm/pip packages referenced by skill
- Malicious URLs in skill content
- Supply chain attacks on skill dependencies

**Current Mitigations:**
- URL allowlist for external domains
- Advice to pin dependency versions
- Warning on external resource references

**Gaps:**
- No automated dependency scanning
- No lockfile validation

---

### 5. Author Key Compromise

**Severity:** Medium
**Likelihood:** Low

**Description:** If a trusted author's GitHub account is compromised, their skills could be replaced with malicious versions.

**Current Mitigations:**
- Trust tier requires history and verification
- Anomaly detection for rapid changes
- Users can blocklist specific skills

**Future Mitigations:**
- Sigstore or GPG signing (Phase 3)
- Multi-key requirements for official skills

---

## Threat Matrix

| Threat | Detection | Prevention | Response |
|--------|-----------|------------|----------|
| Malicious instructions | Pattern scan, entropy | Trust tiers, consent | Blocklist, alert |
| Prompt injection | Pattern scan | Length limits | Report mechanism |
| Typosquatting | Similarity check | Warning UI | Auto-flag |
| Dependency hijacking | URL check | Allowlist | Version pinning |
| Key compromise | Activity anomaly | Multi-sig (future) | Rapid blocklist |

---

## Attack Surface

```
┌─────────────────────────────────────────────────────────────┐
│                    Attack Surface Map                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  External Sources                                           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                       │
│  │ GitHub  │ │ Plugins │ │ SkillsMP│  <-- Untrusted        │
│  └────┬────┘ └────┬────┘ └────┬────┘                       │
│       │           │           │                             │
│       └───────────┼───────────┘                             │
│                   │                                         │
│                   ▼                                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Discovery Hub                           │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐               │   │
│  │  │ Scanner │ │ Index   │ │ Install │               │   │
│  │  └────┬────┘ └────┬────┘ └────┬────┘               │   │
│  │       │           │           │                     │   │
│  │       └───────────┼───────────┘                     │   │
│  └───────────────────┼─────────────────────────────────┘   │
│                      │                                      │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Claude Code Runtime                     │   │
│  │  Skills loaded into context                          │   │
│  │  Execute with user permissions                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                      │                                      │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              User's System                           │   │
│  │  Files, credentials, network access                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Related Documentation

- [Trust Tiers](./trust-tiers.md) - Trust classification system
- [Static Analysis](./static-analysis.md) - Security scanning
- [Security Research](../../research/skill-conflicts-security.md) - Detailed research

---

*Next: [Trust Tiers](./trust-tiers.md)*
