# Skillsmith Security Model

This document provides detailed security information about how Skillsmith protects your Claude Code environment.

## Security Boundaries

```
TRUSTED ZONE
├── Claude model safety guardrails
├── Claude Code runtime
└── OS-level file access controls

SEMI-TRUSTED ZONE (Skillsmith)
├── Skill index (curated)
├── Quality scoring
├── Static analysis
├── Trust tier verification
└── Conflict detection

UNTRUSTED ZONE
├── GitHub repositories
├── Third-party skill authors
└── Community registries
```

## What Skillsmith Scans For

### Critical Severity (Blocks Installation)

**Jailbreak Patterns**
- "ignore previous instructions"
- "developer mode" / "DAN mode"
- "bypass safety" / "bypass security"
- "system: override"
- "act as an AI without restrictions"

**Malicious URLs**
- Non-allowlisted external domains
- Allowlist includes: github.com, githubusercontent.com, anthropic.com, claude.ai

### High Severity (Requires Confirmation)

**Suspicious URLs**
- `file://` protocol (local file access)
- `gopher://`, `dict://`, `ldap://` protocols
- localhost / 127.0.0.x references
- Private IP ranges (10.x.x.x, 192.168.x.x, 172.16-31.x.x)

**Sensitive File Access Patterns**
- `*.env*` files
- `*.pem`, `*.key`, `*.p12` certificates
- `*credentials*`, `*secrets*`, `*password*`
- AWS credentials patterns

**Dangerous Commands**
- `rm -rf`, `format`, `delete`
- `curl`, `wget` to unknown domains
- `eval`, `exec` with dynamic input

### Medium Severity (Warning)

**Obfuscation Detection**
- High entropy content (Shannon entropy > 4.5)
- Possible base64 encoded payloads
- Unusual character sequences

**Permission Keywords**
- References to sudo, root, admin
- System modification commands

## Threat Model

| Threat | Severity | Mitigation | Status |
|--------|----------|------------|--------|
| Malicious SKILL.md | Critical | Pattern scanning, trust tiers | Active |
| Prompt injection | Critical | Pattern detection, entropy analysis | Active |
| Typosquatting | High | Levenshtein distance, char substitution | Active |
| Dependency hijacking | Medium | URL allowlist | Active |
| Author key compromise | Medium | Anomaly detection | Planned |
| Supply chain attack | High | Registry signing | Planned |

## Validation Patterns (Technical Detail)

### SSRF Detection
```
file://, gopher://, dict://, ldap://
localhost, 127.0.0.x
10.x.x.x, 192.168.x.x, 172.16-31.x.x
169.254.x.x (link-local)
```

### Path Traversal Detection
```
../, ..\
..%2f, ..%5c (URL encoded)
%2e%2e (double-encoded)
```

### Typosquatting Detection
- Levenshtein distance ≤ 2 from known skill names
- Character substitution (l/1, o/0, rn/m)
- Homograph attacks (unicode lookalikes)

## Best Practices

### For Skill Users

1. **Always check trust tier** before installing
   - Official/Verified: Generally safe
   - Community: Review skill content first
   - Unverified: Only install if you trust the author personally

2. **Review skill content** for unverified skills
   - Read the SKILL.md body
   - Check for suspicious URLs or commands
   - Look for overly broad permissions

3. **Use `skill_validate`** for manual installations
   - Runs security scan before install
   - Shows warnings and requires confirmation

4. **Report suspicious skills**
   - GitHub: https://github.com/smith-horn/skillsmith/security/advisories
   - Contact form: https://skillsmith.app/contact?topic=security

5. **Keep Skillsmith updated**
   - New security patterns added regularly
   - `npx @skillsmith/mcp-server@latest`

### For Skill Authors

1. **Avoid external URLs** unless necessary
   - Prefer documented APIs (github.com, npm registry)
   - Never reference internal/private URLs

2. **Don't request sensitive file access**
   - Never read .env files
   - Never access credential stores

3. **Be explicit about permissions**
   - Document what files you read/write
   - Document what commands you execute

4. **Submit for verification**
   - Verified skills get more installs
   - Submit request at https://skillsmith.app/contact?topic=verification

## Privacy Considerations

Skillsmith respects your privacy:

**Never sent to backend:**
- Your codebase content
- File paths or names
- Environment variables
- Credentials
- Conversation content

**Sent only with opt-in telemetry:**
- Anonymized search queries
- Skill install/uninstall events
- Error rates (stack traces only)
- Feature usage statistics

## Reporting Security Issues

**For vulnerabilities in Skillsmith itself:**
- Contact form: https://skillsmith.app/contact?topic=security
- GitHub Security Advisories: https://github.com/smith-horn/skillsmith/security/advisories

**For malicious skills:**
- Submit a security report: https://skillsmith.app/contact?topic=security
- Or report via GitHub Issues
- Include skill ID and specific concern
- We investigate and blocklist within 24 hours
