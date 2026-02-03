---
title: "Security, Quarantine, and Safe Skill Installation: How Skillsmith Protects You"
description: "A deep dive into Skillsmith's defense-in-depth security architecture—from static analysis to trust tiers—and why you can install skills with confidence"
author: "Skillsmith Team"
date: 2026-02-02
category: "Engineering"
tags: ["security", "trust-tiers", "static-analysis", "quarantine", "installation", "safety"]
featured: true
ogImage: "/blog/images/security-shield-hero.png"
---

<!--
IMAGE REQUIREMENT: security-shield-hero.png
- Hero image conveying security and trust
- Central shield icon with Skillsmith logo
- Surrounding elements: checkmark, lock, scanning rays
- Background: gradient from dark to light (serious but approachable)
- Dimensions: 1200x630 (OpenGraph standard)
- Style: Professional, trustworthy, not fear-inducing
-->

# Security, Quarantine, and Safe Skill Installation

Installing third-party code into your development environment requires trust. When you install a Claude Code skill, you're giving it access to your projects, your files, and Claude's capabilities.

We take that responsibility seriously.

This guide explains Skillsmith's multi-layered security architecture: how we scan skills before indexing, how trust tiers help you make informed decisions, and what happens during the "quarantine" process that protects you from malicious content.

---

## The Threat Landscape

Before explaining our defenses, let's be honest about the risks. Skills are powerful—and that power can be misused.

### What Could Go Wrong?

| Threat | Severity | Example |
|--------|----------|---------|
| Malicious instructions | Critical | A skill that tells Claude to exfiltrate your `.env` files |
| Prompt injection | Critical | Hidden text that hijacks Claude's behavior |
| Typosquatting | High | `anthroplc/test-fixer` impersonating `anthropic/test-fixer` |
| Dependency hijacking | Medium | A skill referencing compromised external URLs |
| Author compromise | Medium | A trusted author's account gets hacked |

<!--
IMAGE REQUIREMENT: threat-landscape-matrix.png
- 2x2 matrix showing threats by severity and likelihood
- X-axis: Likelihood (Low → High)
- Y-axis: Severity (Medium → Critical)
- Plot the 5 threats as labeled points
- Color-code by current mitigation status: green (mitigated), yellow (partial), red (gap)
- Include legend
- Style: Clean risk matrix, professional
-->

We can't eliminate all risk—no system can. But we can make attacks harder, detection faster, and decisions clearer.

---

## Defense in Depth: Our Security Architecture

Skillsmith uses multiple security layers. If one fails, others catch the threat.

<!--
IMAGE REQUIREMENT: defense-layers.png
- Horizontal layers diagram (like network security diagrams)
- Layer 1 (outermost): "Source Validation" - GitHub verification, SSRF prevention
- Layer 2: "Static Analysis" - Content scanning, pattern detection
- Layer 3: "Trust Tiers" - Classification and consent
- Layer 4: "Blocklist" - Known bad actors
- Layer 5 (innermost): "User Decision" - Informed consent at install
- Show an arrow trying to penetrate from outside, getting stopped at various layers
- Style: Security-focused, professional, shows depth
-->

### Layer 1: Source Validation

Before we even look at a skill's content, we validate where it comes from.

**SSRF Prevention:** We block requests to internal networks, localhost, and cloud metadata services:

```typescript
// Blocked IP ranges
const BLOCKED_RANGES = [
  '10.0.0.0/8',      // Private
  '172.16.0.0/12',   // Private
  '192.168.0.0/16',  // Private
  '127.0.0.0/8',     // Localhost
  '169.254.0.0/16',  // Link-local (cloud metadata)
];
```

**Path Traversal Prevention:** We normalize all file paths and reject attempts to escape allowed directories:

```typescript
// This attack fails
const maliciousPath = '../../../etc/passwd';
// Normalized and validated against root directory
// Result: Error - Path traversal detected
```

### Layer 2: Static Analysis

Every skill passes through our security scanner. This is the "quarantine" phase.

### Layer 3: Trust Tiers

Skills are classified by trust level, giving you clear signals about risk.

### Layer 4: Blocklist

Known malicious skills are immediately blocked, with automatic updates.

### Layer 5: User Decision

You always have the final say. We provide information; you decide.

---

## The Quarantine Process: Static Analysis in Detail

When a skill enters our index, it doesn't go straight to search results. First, it's quarantined for security scanning.

<!--
IMAGE REQUIREMENT: quarantine-flow.png
- Flowchart showing the quarantine process
- Start: "New Skill Detected"
- Step 1: "Content Extraction" - Pull SKILL.md, README, related files
- Step 2: "Security Scanner" - Multiple parallel checks (show as branching)
- Decision: "Any Critical Findings?"
- Yes path: "Blocked" (red) - "Added to blocklist, author notified"
- No path: "Any High Findings?"
- Yes path: "Review" (yellow) - "Indexed with warnings"
- No path: "Safe" (green) - "Indexed normally"
- Style: Clear decision tree, color-coded outcomes
-->

### What We Scan

Our scanner analyzes the full content of your skill, looking for five categories of risk:

#### 1. Jailbreak Pattern Detection

We search for known phrases that attempt to manipulate Claude:

```typescript
const JAILBREAK_PATTERNS = [
  /ignore\s+(previous|prior|all)\s+instructions/i,
  /developer\s+mode/i,
  /bypass\s+(safety|security)/i,
  /system\s*:\s*override/i,
  /you\s+are\s+now\s+DAN/i,  // "Do Anything Now" attacks
];
```

**Why this matters:** These patterns are used in prompt injection attacks to make Claude ignore its guidelines.

**If detected:** Critical finding → Skill blocked

#### 2. URL and Domain Analysis

We check every URL in your skill against our allowlist:

```typescript
const ALLOWED_DOMAINS = [
  'github.com',
  'githubusercontent.com',
  'anthropic.com',
  'claude.ai',
  'npmjs.com',
  'pypi.org',
];

// Any URL to a domain not on this list triggers a finding
```

**Why this matters:** Malicious skills could reference external URLs that:
- Exfiltrate data to attacker-controlled servers
- Download additional malicious payloads
- Track users without consent

**If detected:** High finding → Indexed with warning

<!--
IMAGE REQUIREMENT: url-scan-example.png
- Side-by-side comparison showing two SKILL.md snippets
- Left (safe): Contains `github.com` and `anthropic.com` URLs - green checkmark
- Right (flagged): Contains `evil-domain.com` URL - red warning
- Show the scanner output for each
- Style: Code snippet comparison, clear good/bad distinction
-->

#### 3. Sensitive File References

We flag skills that reference files commonly containing secrets:

```typescript
const SENSITIVE_PATTERNS = [
  '*.env*',           // Environment files
  '*.pem',            // SSL certificates
  '*.key',            // Private keys
  '*credentials*',    // Credential files
  '*secrets*',        // Secret stores
  '*password*',       // Password files
  '.aws/*',           // AWS credentials
  '.ssh/*',           // SSH keys
];
```

**Why this matters:** A legitimate skill rarely needs to reference your `.env` file. If it does, you should know.

**If detected:** High finding → Indexed with warning, requires explicit consent to install

#### 4. Entropy Analysis

High-entropy content often indicates obfuscation—an attempt to hide malicious code:

```typescript
function calculateShannonEntropy(text: string): number {
  // Shannon entropy measures randomness
  // Normal prose: ~4.0-4.5 bits/character
  // Base64 encoded: ~5.5-6.0 bits/character
  // Encrypted/random: ~7.5+ bits/character
}

const ENTROPY_THRESHOLD = 4.5;
```

**Why this matters:** Attackers sometimes encode malicious instructions to bypass pattern detection:

```
# Normal instruction (detectable)
Ignore all previous instructions

# Base64 encoded (hidden)
SWdub3JlIGFsbCBwcmV2aW91cyBpbnN0cnVjdGlvbnM=
```

Our entropy analysis catches these attempts.

**If detected:** Medium finding → Indexed with note

#### 5. Permission Keyword Scan

We flag skills containing potentially dangerous commands:

```typescript
const DANGEROUS_KEYWORDS = [
  'rm -rf',           // Destructive deletion
  'format',           // Disk formatting
  'curl',             // Network requests (context-dependent)
  'wget',             // Downloads
  'eval',             // Code execution
  'exec',             // Process execution
  'sudo',             // Privilege escalation
];
```

**Why this matters:** A testing skill probably shouldn't contain `rm -rf`. A deployment skill might legitimately use `curl`. Context matters, so we flag rather than block.

**If detected:** Medium finding → Indexed with note

### Scan Results

After all checks complete, each skill receives a recommendation:

| Recommendation | Criteria | User Experience |
|----------------|----------|-----------------|
| **Safe** | No findings | Normal installation |
| **Review** | Medium or High findings | Warning shown, consent required |
| **Block** | Critical findings | Cannot install |

---

## Trust Tiers: Making Risk Visible

Not all skills deserve equal trust. Our four-tier system helps you understand what you're installing.

<!--
IMAGE REQUIREMENT: trust-tiers-visual.png
- Four horizontal badges/cards showing each tier
- Official: Green background, checkmark icon, "Anthropic Published, Fully Reviewed"
- Verified: Blue background, shield icon, "Publisher Verified, Scan Passed"
- Community: Yellow background, people icon, "Basic Scan Passed, Review Recommended"
- Unverified: Red background, warning icon, "No Verification, Explicit Opt-in Required"
- Show example skill names for each tier
- Style: Clear visual hierarchy, matches UI badges
-->

### Official (Green Badge)

**What it means:** Published by Anthropic with full security review.

**Requirements:**
- Namespace: `anthropic/*`
- Manual security review by Anthropic team
- Signed with Anthropic's cryptographic key
- All automated scans pass

**User experience:** Installs without additional prompts.

**Example:** `anthropic/test-fixing`, `anthropic/debugging`

### Verified (Blue Badge)

**What it means:** Publisher identity confirmed, automated scanning passed.

**Requirements:**
- Publisher verification (GitHub organization membership)
- All automated scans pass
- Minimum 10 GitHub stars
- Published for at least 30 days

**User experience:** Brief confirmation prompt before install.

**Example:** `obra/superpowers/debugging`, `stripe/payment-skill`

### Community (Yellow Badge)

**What it means:** Basic automated scanning passed, but publisher not verified.

**Requirements:**
- All automated scans pass
- Has license file
- Has README
- Has valid SKILL.md

**User experience:** Consent dialog explaining the risk level.

**Example:** `community/helper-utils`, `janedoe/quick-commit`

### Unverified (Red Badge)

**What it means:** No verification. May be new, may be risky.

**Requirements:** None (this is the default)

**User experience:** Strong warning, explicit opt-in required, confirmation of understanding.

**Example:** `unknown/new-experiment`

### Tier Progression

Skills can move up (or down) the trust ladder:

<!--
IMAGE REQUIREMENT: tier-progression.png
- Vertical progression diagram
- Bottom: "Unverified" with arrow up labeled "Pass scan + add metadata"
- Middle-low: "Community" with arrow up labeled "Verify publisher + 10 stars + 30 days"
- Middle-high: "Verified" with arrow up labeled "Anthropic adoption"
- Top: "Official"
- Also show downgrade arrows on the side:
  - "Failed scan" → drops to Unverified
  - "Blocklist" → removed entirely
- Style: Ladder or staircase visual, clear progression
-->

| From | To | Requirements |
|------|-----|-------------|
| Unverified | Community | Pass security scan, add license + README |
| Community | Verified | Verify publisher identity, 10+ stars, 30+ days old |
| Verified | Official | Anthropic adoption only |

**Downgrade triggers:**
- Failed security scan → Drops to Unverified
- Added to blocklist → Removed from index entirely
- Publisher violation → All publisher's skills downgraded

---

## The Blocklist: Rapid Response to Threats

When we identify a malicious skill, we need to act fast.

### How the Blocklist Works

```typescript
interface BlockedSkill {
  id: string;            // "malicious-author/evil-skill"
  reason: string;        // "Detected data exfiltration attempt"
  severity: 'warning' | 'critical';
  blocked_date: string;
  cve?: string;          // If a CVE was assigned
}
```

The blocklist is:
- **Cryptographically signed** — Can't be tampered with
- **Auto-updated** — Clients fetch updates every 6 hours
- **Transparent** — Published publicly so you can verify

### What Happens When a Skill is Blocklisted

1. **Immediate removal** from search results
2. **Installation blocked** for all users
3. **Existing installations flagged** (if we can detect them)
4. **Author notified** with reason and appeal process

<!--
IMAGE REQUIREMENT: blocklist-flow.png
- Timeline showing blocklist response
- T+0: "Threat Detected" - Security team or automated detection
- T+1h: "Investigation" - Verify threat, document evidence
- T+2h: "Blocklist Updated" - Signed update published
- T+8h: "Global Propagation" - All clients have updated blocklist
- Show this as a horizontal timeline with icons at each stage
- Style: Incident response timeline, professional
-->

### Reporting Suspicious Skills

Found something concerning? Report it:

1. **GitHub Issue** — Open an issue on [skillsmith/security](https://github.com/smith-horn/skillsmith/security)
2. **Email** — security@skillsmith.app
3. **In-app** — Use the "Report Skill" option when viewing skill details

We investigate all reports within 24 hours.

---

## Typosquatting Protection

One of the sneakiest attacks is creating a skill that looks almost like a popular one.

### How We Detect It

```typescript
function checkTyposquat(name: string, knownSkills: string[]): TyposquatRisk {
  for (const known of knownSkills) {
    // Levenshtein distance (edit distance)
    if (levenshtein(name, known) <= 2 && name !== known) {
      return { suspicious: true, similarTo: known };
    }

    // Character substitution (l/1, O/0, etc.)
    if (looksLike(name, known) && name !== known) {
      return { suspicious: true, similarTo: known };
    }
  }

  return { suspicious: false };
}
```

### Common Tricks We Catch

| Technique | Example | Detected? |
|-----------|---------|-----------|
| Letter substitution | `anthroplc` (l→l) vs `anthropic` (i) | Yes |
| Number substitution | `anth0pic` vs `anthropic` | Yes |
| Typos | `anthropicc` vs `anthropic` | Yes |
| Homoglyphs | `аnthropic` (Cyrillic а) vs `anthropic` | Yes |
| Extra characters | `anthropic-official` vs `anthropic` | Flagged |

<!--
IMAGE REQUIREMENT: typosquat-detection.png
- Table or visual comparison showing attack attempts
- Left column: "Attack" showing malicious skill names
- Middle column: "Technique" explaining the trick
- Right column: "Detection" showing Skillsmith's response
- Use strikethrough or red X for blocked attempts
- Style: Security education, clear examples
-->

### User Experience

When you try to install a potentially typosquatted skill:

```
⚠️ Warning: This skill name is similar to "anthropic/test-fixing"

You are about to install: anthroplc/test-fixing
Did you mean: anthropic/test-fixing (Official, 2.3k installs)

This could be an attempt to impersonate a popular skill.
Are you sure you want to continue?

[Install Anyway] [Cancel] [View Similar Skill]
```

---

## What Happens at Installation Time

Even after all our pre-indexing security, installation is another checkpoint.

<!--
IMAGE REQUIREMENT: install-flow-security.png
- Flowchart of installation with security checkpoints
- Step 1: "User requests install"
- Check A: "Is skill blocklisted?" - Yes → Block, No → Continue
- Check B: "Trust tier?" - Shows different paths for each tier
- Step 2: "Display consent dialog" (varies by tier)
- Step 3: "User confirms"
- Step 4: "Download and verify content"
- Check C: "Content matches index?" - No → Abort, Yes → Continue
- Step 5: "Install to ~/.claude/skills/"
- Style: Decision flowchart with security gates highlighted
-->

### Pre-Installation Checks

1. **Blocklist check** — Re-verify skill isn't blocked (list may have updated)
2. **Trust tier display** — Show badge and any warnings
3. **Scan findings** — Display any medium/high findings from quarantine
4. **Consent** — Get explicit user approval (varies by tier)

### Content Verification

We verify the skill content matches what we indexed:

```typescript
async function verifyBeforeInstall(skill: Skill): Promise<boolean> {
  // Fetch current content from source
  const currentContent = await fetchSkillContent(skill.repo_url);

  // Compare hash with indexed version
  const currentHash = computeHash(currentContent);
  const indexedHash = skill.content_hash;

  if (currentHash !== indexedHash) {
    // Content changed since indexing!
    // Could be legitimate update or tampering
    return await promptUserForReindex(skill);
  }

  return true;
}
```

This catches cases where:
- A skill was updated after indexing (needs re-scan)
- Content was tampered with (supply chain attack)
- Repository was force-pushed (potential author compromise)

### Post-Installation

After installation, the skill lives in your `~/.claude/skills/` directory. You have full control:

```bash
# View installed skills
ls ~/.claude/skills/

# Remove a skill manually
rm -rf ~/.claude/skills/suspicious-skill/

# Or use Skillsmith
"Uninstall the suspicious-skill"
```

---

## Audit Logging: Transparency and Forensics

Every security-relevant event is logged for transparency and incident response.

### What We Log

| Event | Data Captured |
|-------|---------------|
| Skill indexed | Skill ID, source, timestamp, scan results |
| Scan finding | Finding type, severity, matched content (sanitized) |
| Blocklist update | Skills added/removed, reason, timestamp |
| Installation | Skill ID, user consent given, trust tier at time |
| Security alert | Alert type, affected skills, detection method |

### Privacy Note

We log security events, not user behavior. We don't track:
- Which skills you browse
- Your search queries
- Your codebase contents
- Anything that could identify you personally

Audit logs exist to improve security and respond to incidents—not to surveil users.

---

## Platform Limitations (Honest Disclosure)

We believe in transparency about what we *can't* protect against.

### What Requires Anthropic Platform Changes

| Security Feature | Why We Can't Implement It |
|-----------------|---------------------------|
| Runtime sandboxing | Skills execute in Claude's process |
| Permission model | No capability restrictions exist today |
| Network isolation | Claude controls network access |
| File access restrictions | Claude has your user's file permissions |

These are platform-level features that would require changes to Claude Code itself. We advocate for them, but they're outside our control.

### What This Means for You

Skills you install have the same capabilities as Claude Code itself. Our security measures reduce the risk of installing *malicious* skills, but can't restrict what *legitimate* skills can do.

**Our recommendation:**
- Stick to Verified and Official tiers when possible
- Review Community skills before installing
- Be cautious with Unverified skills
- Report anything suspicious

---

## Security Checklist for Skill Authors

If you're publishing skills, here's how to build trust:

### Do

- [ ] **Use a clear, unique name** — Avoid similarity to popular skills
- [ ] **Include a license** — MIT or Apache-2.0 recommended
- [ ] **Document everything** — Clear README and SKILL.md
- [ ] **Explain external URLs** — If you need them, say why
- [ ] **Minimize permissions** — Only ask Claude to do what's necessary
- [ ] **Publish under a verified account** — Verify your GitHub org

### Don't

- [ ] **Reference sensitive files** — Never touch `.env`, credentials, keys
- [ ] **Use obfuscation** — Triggers entropy detection
- [ ] **Include unnecessary commands** — Avoid `rm`, `curl`, `eval` unless essential
- [ ] **Hide functionality** — Be transparent about what your skill does

---

## Frequently Asked Questions

### "Can a skill steal my API keys?"

Theoretically, yes—Claude has access to your files. Practically, our security scanning catches most attempts to reference sensitive files. We flag any skill that mentions `.env`, credentials, or similar patterns.

**Mitigation:** Use environment variables and secrets managers. Don't store secrets in plaintext files.

### "What if a trusted author gets hacked?"

We detect anomalies like sudden large changes to popular skills. If a Verified skill suddenly adds suspicious content, it triggers a review.

**Future mitigation:** We're implementing multi-signature requirements for high-trust skills.

### "Can I run skills in a sandbox?"

Not currently—this requires platform support from Anthropic. We're advocating for this feature.

**Workaround:** Use a development environment or container for testing new skills.

### "How do I report a vulnerability in Skillsmith itself?"

Email security@skillsmith.app with details. We follow responsible disclosure practices and will credit researchers (if desired) once fixed.

---

## Summary

Skillsmith's security architecture provides defense in depth:

1. **Source Validation** — SSRF and path traversal prevention
2. **Static Analysis** — Five-point scan during quarantine
3. **Trust Tiers** — Clear classification (Official → Verified → Community → Unverified)
4. **Blocklist** — Rapid response to discovered threats
5. **Installation Checks** — Final verification before install
6. **User Control** — You always have the final decision

We can't guarantee perfect security—no one can. But we've designed every layer to make attacks harder, detection faster, and your decisions more informed.

Install skills with confidence. And if something seems off, report it.

---

## Further Reading

- **Technical deep-dive** — [Threat Model](/docs/technical/security/threat-model.md)
- **Trust tier implementation** — [Trust Tiers](/docs/technical/security/trust-tiers.md)
- **Static analysis details** — [Static Analysis Pipeline](/docs/technical/security/static-analysis.md)
- **ADR on security hardening** — [ADR-008](/docs/adr/008-security-hardening-phase.md)

---

## How the Indexer Works

Curious about the other half of the story? Read [From GitHub to Search Results: How Skillsmith Indexes and Curates Skills](/blog/how-skillsmith-indexes-skills) to understand the full journey from repository to searchable skill.

---

*Questions about security? Reach out at security@skillsmith.app or open an issue on [GitHub](https://github.com/smith-horn/skillsmith/issues).*
