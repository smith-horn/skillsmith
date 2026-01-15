# Skill Security Guide

> **This guide helps you understand how Skillsmith keeps you safe** when discovering and installing skills for Claude Code. Learn about trust tiers, security scanning, and how to make informed decisions.

---

## Anthropic Official Skills

**Skills from Anthropic receive the highest level of trust.** These are skills published under the `anthropic/*` namespace and are fully reviewed by Anthropic's team before being made available.

```
┌─────────────────────────────────────────────────────────────┐
│  Skill: anthropic/test-helper                               │
│  ┌──────────────┐                                           │
│  │   OFFICIAL   │  ← Green badge                            │
│  └──────────────┘                                           │
│  Published by Anthropic. Fully reviewed and verified.       │
└─────────────────────────────────────────────────────────────┘
```

### Why Anthropic Skills Are Trusted

| Factor | Description |
|--------|-------------|
| **Publisher** | Developed by Anthropic, the creators of Claude |
| **Review** | Undergoes security review by Anthropic's team |
| **Namespace** | Always prefixed with `anthropic/` |
| **Badge** | Displays green "OFFICIAL" badge in search results |
| **Installation** | Can be installed without additional prompts |

**When searching for skills, look for the green OFFICIAL badge first.** These skills are the safest choice for extending Claude Code's capabilities.

---

## Understanding Trust Tiers

Skillsmith classifies every skill into one of four trust tiers. When you search for skills, each result displays its trust tier as a colored badge.

### Trust Tier Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     TRUST HIERARCHY                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   OFFICIAL    ★★★★★   Anthropic skills, fully reviewed      │
│   ───────────────────────────────────────────────────────── │
│   VERIFIED    ★★★★☆   Verified publisher, security scanned  │
│   ───────────────────────────────────────────────────────── │
│   COMMUNITY   ★★★☆☆   Basic scan passed, has documentation  │
│   ───────────────────────────────────────────────────────── │
│   UNVERIFIED  ★☆☆☆☆   No verification, review carefully     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Detailed Tier Descriptions

#### Official (Green Badge)

Skills published by Anthropic under the `anthropic/*` namespace.

- **Trust Level**: Highest
- **Review**: Manual security review by Anthropic
- **User Experience**: Installs without additional prompts
- **Example**: `anthropic/test-helper`, `anthropic/commit`

#### Verified (Blue Badge)

Skills from verified publishers that have passed automated security scanning.

- **Trust Level**: High
- **Requirements**: Verified publisher identity, 10+ GitHub stars, 30+ days old, security scan passed
- **User Experience**: Brief confirmation before install
- **Example**: `obra/debugging`, `verified-publisher/tool-name`

#### Community (Yellow Badge)

Skills that pass basic automated scanning and have proper documentation.

- **Trust Level**: Moderate
- **Requirements**: Security scan passed, has LICENSE, README, and SKILL.md
- **User Experience**: Consent dialog explaining risks
- **Example**: `community/helper-utils`

#### Unverified (Red Badge)

Skills with no verification. These require explicit opt-in.

- **Trust Level**: Low
- **Requirements**: None
- **User Experience**: Strong warning, explicit acknowledgment required
- **Example**: `unknown/random-tool`

---

## Security Risks of Third-Party Skills

Skills extend Claude Code's capabilities, but third-party skills can pose security risks. Understanding these risks helps you make informed decisions.

### Prompt Injection

**What it is**: A malicious skill could contain instructions that attempt to hijack Claude's behavior, making it ignore your requests or perform unintended actions.

**How Skillsmith protects you**: Our security scanner detects common jailbreak patterns like "ignore previous instructions" or "developer mode" attempts.

### Data Exfiltration

**What it is**: A skill could attempt to send your code, files, or sensitive information to external servers.

**How Skillsmith protects you**: We scan for suspicious patterns like `fetch()` calls with query parameters, `FormData` uploads, webhook URLs, and Base64 encoding of data.

### Privilege Escalation

**What it is**: A skill could attempt to gain elevated system access through commands like `sudo`, `chmod 777`, or modifications to `/etc/sudoers`.

**How Skillsmith protects you**: We detect privilege escalation patterns and flag skills that contain such commands.

### Supply Chain Attacks

**What it is**: Attackers may publish skills with names similar to popular legitimate skills (typosquatting) to trick users into installing malicious versions.

**How Skillsmith protects you**: We detect typosquatting using Levenshtein distance analysis, character substitution detection, and visual confusable checking (like `l` vs `1`, `O` vs `0`).

---

## How Skillsmith Protects You

Skillsmith implements multiple layers of security to help you install skills safely.

### Automatic Security Scanning

Every skill is scanned before you can install it. The scanner checks for:

| Category | What We Detect | Severity |
|----------|----------------|----------|
| **Jailbreak Patterns** | "Ignore instructions", DAN mode, bypass attempts | Critical |
| **Social Engineering** | "Pretend to be", "roleplay as", persona hijacking | High |
| **Prompt Leaking** | Attempts to extract system prompts | High |
| **Data Exfiltration** | External data sending, webhook URLs | High |
| **Privilege Escalation** | sudo abuse, permission changes | High |
| **Suspicious Code** | eval(), exec(), command execution | Medium |
| **Sensitive Paths** | References to .env, SSH keys, credentials | Medium |
| **External URLs** | Non-allowlisted domain references | Low |

### Risk Scoring

Each skill receives a risk score from 0 to 100:

- **0-19**: Low risk - No concerning patterns detected
- **20-39**: Moderate risk - Some patterns flagged, review recommended
- **40-59**: High risk - Significant concerns, proceed with caution
- **60-100**: Critical risk - Installation blocked or quarantined

### Domain Allowlist

Skills can only reference URLs from approved domains:

- `github.com`, `raw.githubusercontent.com`
- `anthropic.com`, `claude.ai`
- `npmjs.com`, `pypi.org`
- `docs.python.org`, `developer.mozilla.org`
- `stackoverflow.com`

References to other domains are flagged for review.

### Quality Scoring

Beyond security, each skill receives a quality score (0-100) based on:

| Dimension | Weight | Factors |
|-----------|--------|---------|
| **Popularity** | 30 points | GitHub stars, forks, watchers |
| **Activity** | 25 points | Recent updates, issue health, contributors |
| **Documentation** | 25 points | README quality, SKILL.md presence, description |
| **Trust** | 20 points | License, verified owner, relevant topics |

Higher scores indicate more established, better-maintained skills.

### Quarantine System

Skills that fail security scanning or have high risk scores are automatically quarantined. Quarantined skills cannot be installed until the issues are resolved.

---

## Making Safe Choices

Follow this workflow when evaluating skills:

### Before Installing

1. **Check the trust tier badge**
   - Green (Official) = Safe choice
   - Blue (Verified) = Trustworthy
   - Yellow (Community) = Review carefully
   - Red (Unverified) = High caution required

2. **Review the quality score**
   - 80+ = Well-established skill
   - 60-79 = Good quality
   - 40-59 = Basic quality
   - Below 40 = Consider alternatives

3. **Read the SKILL.md**
   - Understand what the skill does
   - Check for clear documentation
   - Look for usage examples

4. **Consider the author**
   - Is the publisher known?
   - Do they have other skills?
   - What's their reputation?

5. **Check activity metrics**
   - When was it last updated?
   - Are issues being addressed?
   - How many contributors?

### Warning Signs

Be cautious if you see:

- Unverified trust tier with no documentation
- Very recent creation date with no history
- Name similar to a popular skill (possible typosquatting)
- Vague or missing description
- No license specified
- Security warnings during installation

---

## Managing Installed Skills

### View Installed Skills

Your installed skills are located at `~/.claude/skills/`. You can see what's installed using:

```
"What skills do I have installed?"
→ Uses Skillsmith to list your installed skills
```

### Uninstall a Skill

To remove a skill you no longer want:

```
"Uninstall the helper-utils skill"
→ Removes the skill from ~/.claude/skills/
```

### Report a Concern

If you find a skill that seems malicious or problematic:

1. Uninstall the skill immediately
2. Report the issue to the Skillsmith repository
3. Provide the skill ID and description of the concern

---

## Additional Resources

For more technical details:

- [Security Standards](./index.md) - Technical security implementation details
- [Trust Tier System](../technical/security/trust-tiers.md) - In-depth trust tier documentation
- [Threat Model](../technical/security/threat-model.md) - Detailed threat analysis
- [Code Review Checklist](./checklists/code-review.md) - Security review guidelines for developers

---

## Summary

| Action | Recommendation |
|--------|----------------|
| **Safest choice** | Install Anthropic Official skills (green badge) |
| **Good choice** | Install Verified skills (blue badge) after brief review |
| **Proceed carefully** | Community skills (yellow badge) - read documentation first |
| **High caution** | Unverified skills (red badge) - only if absolutely necessary |

**Remember**: Skillsmith scans skills automatically, but the final decision is yours. When in doubt, choose skills with higher trust tiers and quality scores, or stick with Anthropic Official skills.

---

*For questions or concerns about skill security, please open an issue on the [Skillsmith repository](https://github.com/Smith-Horn-Group/skillsmith).*
