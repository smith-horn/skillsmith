# Quota System

Skillsmith uses a usage-based quota system to ensure fair access and sustainable service.

## Tier Limits

| Tier | API Calls/Month | Price | Best For |
|------|-----------------|-------|----------|
| **Community** | 1,000 | Free | Individual hobbyists |
| **Individual** | 10,000 | $9.99/mo | Active developers |
| **Team** | 100,000 | $25/user/mo | Development teams |
| **Enterprise** | Unlimited | $55/user/mo | Large organizations |

## What Counts as an API Call

Each of these operations counts as 1 API call:
- `search` - Searching for skills
- `get_skill` - Getting skill details
- `install_skill` - Installing a skill
- `uninstall_skill` - Removing a skill
- `skill_recommend` - Getting recommendations
- `skill_validate` - Validating a skill
- `skill_compare` - Comparing skills
- `skill_suggest` - Getting suggestions

**Free operations** (don't count):
- Viewing already-installed skills
- Reading local skill files
- Using installed skills

## Quota Warnings

Skillsmith provides progressive warnings as you approach your limit:

| Usage | Level | What Happens |
|-------|-------|--------------|
| 80% | Info | Warning in tool response |
| 90% | Warning | Warning + optional email |
| 100% | Error | Operations blocked |

### Example Warning at 80%

```json
{
  "results": [...],
  "_meta": {
    "quota": {
      "remaining": 200,
      "limit": 1000,
      "resetAt": "2026-02-01T00:00:00Z",
      "warning": "80% of monthly quota used (200 remaining)"
    }
  }
}
```

### At 100% (Blocked)

```json
{
  "error": "QUOTA_EXCEEDED",
  "message": "Monthly quota exceeded. Upgrade at skillsmith.app/upgrade",
  "resetAt": "2026-02-01T00:00:00Z"
}
```

## Checking Your Quota

Ask Claude:
```
"What's my Skillsmith quota?"
"How many API calls do I have left?"
```

Or check programmatically via the quota metadata in any response.

## Quota Resets

Quotas reset on the **first of each month** at 00:00 UTC.

Example:
- January 15: 800/1000 used
- February 1: 0/1000 used (reset)

Unused quota does not roll over.

## Upgrading Your Tier

### From Community to Individual ($9.99/mo)
- 10x more API calls (10,000/month)
- Priority support
- Basic analytics dashboard

```
Upgrade at: https://skillsmith.app/upgrade?from=community&to=individual
```

### From Individual to Team ($25/user/mo)
- 10x more API calls (100,000/month)
- Team workspaces
- Private skills
- Usage analytics

```
Upgrade at: https://skillsmith.app/upgrade?from=individual&to=team
```

### From Team to Enterprise ($55/user/mo)
- Unlimited API calls
- SSO (SAML 2.0)
- Role-based access control (RBAC)
- Audit logging
- SIEM integration
- Dedicated support

```
Contact: sales@skillsmith.app
```

## Optimizing Quota Usage

### Do
- Cache search results when browsing
- Use `get_skill` only for skills you're considering
- Batch installations when possible

### Don't
- Run repeated searches for the same query
- Call `skill_validate` multiple times on the same skill
- Use `search` with overly broad queries

### Efficient Patterns

Instead of:
```
search("testing")  # 1 call
search("testing jest")  # 2 calls
search("testing vitest")  # 3 calls
```

Do:
```
search("testing", limit=20)  # 1 call, get more results
```

## Enterprise Considerations

### Shared Quota (Team/Enterprise)
- Quota is shared across all team members
- Individual usage tracking available in dashboard
- Admins can set per-user soft limits

### Overage Protection
- Hard block at 100% by default
- Enterprise can enable overage billing
- Overage rate: $0.001 per additional call

### Audit Trail
Enterprise tier includes full audit logging:
- Who made each call
- What skill was accessed
- Timestamp and result

## FAQ

**Q: What happens if I hit my limit mid-project?**
A: You can upgrade immediately. New quota applies instantly.

**Q: Can I pre-pay for higher limits?**
A: Contact sales@skillsmith.app for custom plans.

**Q: Do local operations use quota?**
A: No. Only Skillsmith API calls (search, install, etc.) use quota.

**Q: Can I see my historical usage?**
A: Individual+ tiers have a usage dashboard at skillsmith.app/usage.

## Support

- Billing questions: billing@skillsmith.app
- Quota issues: support@skillsmith.app
- Enterprise sales: sales@skillsmith.app
