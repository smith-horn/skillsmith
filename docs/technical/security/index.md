# Security Architecture Index

> **Navigation**: [Technical Index](../index.md) | [Overview](../overview.md) | [Components](../components/index.md)
>
> **Research Reference**: [Security Research](../../research/skill-conflicts-security.md#part-2-security-deep-dive)

---

> **For Claude Agents**: This section covers security architecture, threat model, and controls.
> Use this index to find specific security documentation.

## Security Navigation

| Topic | Document | Purpose |
|-------|----------|---------|
| Threat Model | [threat-model.md](./threat-model.md) | Threats, severity, mitigation status |
| Trust Tiers | [trust-tiers.md](./trust-tiers.md) | Trust tier system, requirements |
| Conflict Detection | [conflict-detection.md](./conflict-detection.md) | Skill conflict resolution |
| Static Analysis | [static-analysis.md](./static-analysis.md) | Security scanning pipeline |

## Security Summary

### Trust Boundaries

```
+----------------------------------------------------------------+
|  TRUSTED ZONE (Anthropic Platform)                             |
|  - Claude model safety                                         |
|  - Claude Code runtime                                         |
+----------------------------------------------------------------+
        |
        | Skills loaded into Claude context
        |
+----------------------------------------------------------------+
|  SEMI-TRUSTED ZONE (Discovery Hub)                             |
|  - Skill index (we control)                                    |
|  - Quality scoring (we compute)                                |
|  - Static analysis (we run)                                    |
+----------------------------------------------------------------+
        |
        | Skill metadata and content
        |
+----------------------------------------------------------------+
|  UNTRUSTED ZONE (External Sources)                             |
|  - GitHub repositories                                         |
|  - Third-party skill authors                                   |
|  - Community skill registries                                  |
+----------------------------------------------------------------+
```

### Key Security Controls

| Control | Status | Documentation |
|---------|--------|---------------|
| Trust tier system | Implemented | [trust-tiers.md](./trust-tiers.md) |
| Typosquatting detection | Implemented | [static-analysis.md](./static-analysis.md) |
| Blocklist integration | Implemented | [static-analysis.md](./static-analysis.md) |
| Static analysis pipeline | Partial | [static-analysis.md](./static-analysis.md) |
| Conflict detection | Implemented | [conflict-detection.md](./conflict-detection.md) |

### Platform Limitations

Features requiring Anthropic platform changes (not available):

| Security Feature | Why Platform-Level |
|-----------------|-------------------|
| Runtime sandboxing | Skills execute in Claude's process |
| Permission model | No capability restrictions exist |
| Network isolation | Claude controls network access |
| File access restrictions | Claude has user's file access |

> **Recommendation:** Document these limitations clearly to users. Advocate to Anthropic for platform-level security improvements.

## Related Documentation

- [Security Research](../../research/skill-conflicts-security.md) - Detailed security research
- [Activation Failure RCA](../../research/skill-activation-failure-rca.md) - Activation issues research
- [API Error Handling](../api/error-handling.md) - Security error codes

---

*Next: [Threat Model](./threat-model.md)*
