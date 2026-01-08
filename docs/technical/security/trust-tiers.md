# Trust Tier System

> **Navigation**: [Security Index](./index.md) | [Technical Index](../index.md) | [Threat Model](./threat-model.md)

---

## Trust Tier Definitions

```typescript
enum TrustTier {
  OFFICIAL = 'official',       // Anthropic-published, full review
  VERIFIED = 'verified',       // Publisher identity verified, automated scan
  COMMUNITY = 'community',     // Basic scan passed, user consent required
  UNVERIFIED = 'unverified',   // No verification, explicit opt-in required
}
```

---

## Tier Requirements

### Official

Skills published by Anthropic with full security review.

```typescript
interface OfficialRequirements {
  publisher: 'anthropic/*';
  manual_review: true;
  scan_passed: true;
  signing: 'anthropic_key';
}
```

| Requirement | Description |
|-------------|-------------|
| Publisher | Must be `anthropic/*` namespace |
| Manual review | Security team review required |
| Scan passed | All automated scans pass |
| Signing | Signed with Anthropic's key |

**User Experience:** Installed without additional prompts.

---

### Verified

Skills from verified publishers with automated security scanning.

```typescript
interface VerifiedRequirements {
  publisher_verification: true;  // GitHub org membership or similar
  scan_passed: true;
  stars_minimum: 10;
  age_minimum_days: 30;
}
```

| Requirement | Description |
|-------------|-------------|
| Publisher verification | GitHub org membership verified |
| Scan passed | All automated scans pass |
| Minimum stars | At least 10 GitHub stars |
| Minimum age | Published at least 30 days ago |

**User Experience:** Brief confirmation prompt before install.

---

### Community

Skills that pass basic automated scanning.

```typescript
interface CommunityRequirements {
  scan_passed: true;
  basic_metadata: true;         // License, README, SKILL.md present
}
```

| Requirement | Description |
|-------------|-------------|
| Scan passed | Basic automated scans pass |
| Basic metadata | Has license, README, SKILL.md |

**User Experience:** Consent dialog explaining risk level.

---

### Unverified

Skills with no verification - requires explicit opt-in.

```typescript
interface UnverifiedRequirements {
  // No requirements, but flagged in UI
}
```

| Requirement | Description |
|-------------|-------------|
| None | No automated checks |

**User Experience:** Strong warning, explicit opt-in required.

---

## Trust Tier Display

```
┌─────────────────────────────────────────────────────────────┐
│  Skill: anthropic/test-fixing                               │
│  ┌──────────────┐                                           │
│  │   OFFICIAL   │ <- Green badge, checkmark                 │
│  └──────────────┘                                           │
│  Published by Anthropic. Fully reviewed and verified.       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Skill: obra/superpowers/debugging                          │
│  ┌──────────────┐                                           │
│  │   VERIFIED   │ <- Blue badge, checkmark                  │
│  └──────────────┘                                           │
│  Verified publisher. Automated security scan passed.        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Skill: community/helper-utils                              │
│  ┌──────────────┐                                           │
│  │  COMMUNITY   │ <- Yellow badge                           │
│  └──────────────┘                                           │
│  Community skill. Basic scan passed. Review before install. │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Skill: unknown/random-tool                                 │
│  ┌──────────────┐                                           │
│  │  UNVERIFIED  │ <- Red badge, warning icon                │
│  └──────────────┘                                           │
│  ⚠️ Unverified skill. Not scanned. Install at your own risk.│
└─────────────────────────────────────────────────────────────┘
```

---

## Tier Progression

Skills can progress through trust tiers:

```
UNVERIFIED -> COMMUNITY -> VERIFIED -> OFFICIAL
     |            |            |
     |  Pass scan |  Verify    |  Anthropic
     |  + metadata|  publisher |  review
     |            |  + history |
     v            v            v
  Basic       Quality      Full
  listing     featured     trust
```

### Upgrade Requirements

| From | To | Requirements |
|------|-----|-------------|
| Unverified | Community | Pass security scan, add metadata |
| Community | Verified | Verify publisher, 10+ stars, 30+ days |
| Verified | Official | Anthropic adoption only |

### Downgrade Triggers

| Trigger | Action |
|---------|--------|
| Failed security scan | Downgrade to Unverified |
| Blocklist addition | Remove from index |
| Publisher violation | Downgrade all publisher skills |

---

## Implementation

```typescript
function computeTrustTier(skill: Skill): TrustTier {
  // Official: Anthropic namespace
  if (skill.id.startsWith('anthropic/')) {
    return TrustTier.OFFICIAL;
  }

  // Verified: publisher + scan + history
  if (
    skill.publisher_verified &&
    skill.scan_passed &&
    skill.stars >= 10 &&
    daysSince(skill.created_at) >= 30
  ) {
    return TrustTier.VERIFIED;
  }

  // Community: scan passed + basic metadata
  if (
    skill.scan_passed &&
    skill.has_license &&
    skill.has_readme &&
    skill.has_skillmd
  ) {
    return TrustTier.COMMUNITY;
  }

  // Default: Unverified
  return TrustTier.UNVERIFIED;
}
```

---

## Related Documentation

- [Threat Model](./threat-model.md) - Security threats
- [Static Analysis](./static-analysis.md) - Security scanning
- [Scoring Algorithm](../scoring/algorithm.md) - Quality scoring

---

*Next: [Conflict Detection](./conflict-detection.md)*
