# Trust Tiers

Skillsmith uses a four-tier trust system to help you evaluate skill safety before installation.

## Tier Overview

| Tier | Badge | Auto-Install | Review Required |
|------|-------|--------------|-----------------|
| **Official** | Green checkmark | Yes | No |
| **Verified** | Blue checkmark | Yes | No |
| **Community** | Yellow circle | No | Recommended |
| **Unverified** | Red warning | No | Required |

## Official Tier

**What it means**: Published by Anthropic or trusted partners. Undergoes full security review.

**Requirements**:
- Published under `anthropic/` namespace
- Full code review by Anthropic security team
- Cryptographic signing (planned)
- Automatic updates deployed

**Examples**: `anthropic/varlock`, `anthropic/commit`, `anthropic/governance`

**When to install**: Always safe. These skills are maintained by Anthropic.

## Verified Tier

**What it means**: Publisher identity verified, skill meets quality and age requirements.

**Requirements**:
- Publisher identity verified via GitHub OAuth
- Automated security scan passed with no critical/high findings
- Minimum 10 GitHub stars
- Published for at least 30 days
- Has valid license file
- Complete README and SKILL.md

**Verification Process**:
1. Publisher submits verification request
2. Automated scan runs
3. Identity verification via GitHub
4. Manual review for edge cases
5. Verified badge granted (renewable annually)

**When to install**: Generally safe. Publisher is accountable for the skill.

## Community Tier

**What it means**: Passed basic security scan and has required metadata.

**Requirements**:
- Security scan passed (no critical findings)
- Valid SKILL.md with proper frontmatter
- Has LICENSE file
- Has README.md
- No blocklist matches

**What Community tier does NOT guarantee**:
- Publisher identity
- Code quality
- Ongoing maintenance
- No subtle security issues

**When to install**: Review skill content first. Check the author's GitHub profile and other projects.

## Unverified Tier

**What it means**: No verification performed. Could be newly published, failed scan, or intentionally unverified.

**Why a skill might be Unverified**:
- Just published (hasn't been scanned yet)
- Failed security scan
- Missing required files (LICENSE, README)
- Author hasn't submitted for verification
- Quarantined for suspicious activity

**When to install**: Only if you personally know and trust the author, or you've manually reviewed all code.

**Warning**: Unverified skills require explicit confirmation:
```
This skill is unverified. Are you sure you want to install? (y/N)
```

## Tier Transitions

### Upgrading from Community to Verified
1. Ensure skill meets all Verified requirements
2. Submit verification request at skillsmith.app/verify
3. Complete identity verification
4. Wait for review (typically 2-5 business days)

### Downgrades
Skills can be downgraded if:
- Security scan fails on update
- Publisher verification expires
- Reports of malicious behavior
- Author requests removal

## Filtering by Trust Tier

Use the `trust_tier` filter in searches:

```
"Find verified testing skills"
→ search(query="testing", trust_tier="verified")

"Show only official skills"
→ search(query="*", trust_tier="official")
```

## Trust Tier API

The `get_skill` tool returns trust information:

```json
{
  "id": "community/jest-helper",
  "trustTier": "verified",
  "publisherVerified": true,
  "scanPassed": true,
  "scanDate": "2026-01-10",
  "stars": 47,
  "publishedDays": 89
}
```

## Recommendations by Use Case

| Scenario | Recommended Minimum Tier |
|----------|-------------------------|
| Production code | Verified or Official |
| Personal projects | Community or higher |
| Experimentation | Any (with review) |
| Enterprise/regulated | Official only |

## Questions?

- How do I get verified? See skillsmith.app/verify
- Report a suspicious skill: security@skillsmith.app
- Request tier review: support@skillsmith.app
