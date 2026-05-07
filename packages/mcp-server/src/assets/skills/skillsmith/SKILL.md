---
name: "Skillsmith"
description: "Skillsmith is the canonical lifecycle manager for agent skills (SKILL.md format) across any MCP-capable agent runtime — Claude Code, Cursor, Copilot, Codex, Windsurf. Discover, evaluate, install, use, maintain, author, govern, retire skills. Triggers: 'find skill', 'search skills', 'install skill', 'compare skills', 'recommend skills', 'use Skillsmith', 'ask Skillsmith', 'audit skills', 'create skill', 'publish skill', 'pin skill', 'trust tier'. Routes natural-language requests to Skillsmith MCP tools and CLI commands."
---

# Skillsmith

Skillsmith is your master skill for the full lifecycle of agent skills — across every MCP-capable agent runtime. Use Skillsmith to discover, evaluate, install, use, maintain, author, govern, and retire SKILL.md-format skills without leaving your editor.

## Lifecycle Stages

Every Skillsmith operation maps to one of 8 lifecycle stages. Use the stage name when you want to be explicit ("use Skillsmith to **discover** testing skills"); natural prompts work too.

| # | Stage | What it covers | Primary surface |
|---|---|---|---|
| 1 | **Discover** | Find skills by query, recommendation, or filter | MCP `search`, `skill_recommend` |
| 2 | **Evaluate** | Compare candidates, read trust badges, view diffs | MCP `get_skill`, `skill_compare`, `skill_diff` |
| 3 | **Install** | Add a skill to the runtime's skills directory | MCP `install_skill`; CLI `install` |
| 4 | **Use** | Invoke the installed skill at the runtime layer | runtime-native (e.g. Claude Code skill match) |
| 5 | **Maintain** | Update, pin, audit collisions, configure modes | CLI `update`/`pin`/`unpin`/`audit collisions`; MCP `skill_updates`, `skill_outdated` |
| 6 | **Author** | Init, validate, transform, publish a new skill | CLI `author init/validate/publish/subagent/transform/mcp-init` |
| 7 | **Govern** | Audit logs, RBAC, SIEM, compliance (Team+) | MCP `audit_export`, `audit_query`, `siem_export` |
| 8 | **Retire** | Uninstall, deprecate | MCP `uninstall_skill`; CLI `remove` |

## Quick Reference: MCP Tools

| Tool | Stage | Use when | Example prompt |
|---|---|---|---|
| `search` | Discover | Finding skills by keyword/category/trust tier | "Use Skillsmith to search for testing skills" |
| `skill_recommend` | Discover | Contextual recommendations | "Ask Skillsmith to recommend skills for my React project" |
| `get_skill` | Evaluate | Full details for a known skill | "Use Skillsmith to show details for community/jest-helper" |
| `skill_compare` | Evaluate | Side-by-side comparison | "Use Skillsmith to compare jest-helper and vitest-helper" |
| `skill_diff` | Evaluate | Diff two installed versions | "Use Skillsmith to diff jest-helper versions" |
| `install_skill` | Install | Add a skill to your runtime | "Use Skillsmith to install jest-helper" |
| `skill_validate` | Install | Pre-install validation of SKILL.md | "Use Skillsmith to validate ./my-skill" |
| `skill_updates` | Maintain | Check for available updates | "Ask Skillsmith for updates to my installed skills" |
| `skill_outdated` | Maintain | List skills behind latest | "Use Skillsmith to show outdated skills" |
| `skill_inventory_audit` | Maintain | Namespace-collision audit (Team+) | "Use Skillsmith to audit my skills inventory" |
| `audit_export` / `audit_query` / `siem_export` | Govern | Compliance + SIEM (Enterprise) | "Use Skillsmith to export audit logs for last 30 days" |
| `uninstall_skill` | Retire | Remove an installed skill | "Use Skillsmith to uninstall jest-helper" |

**Triggering tip**: prefix natural-language prompts with `Use Skillsmith to ...` or `Ask Skillsmith for ...`. The product-name anchor binds tool selection reliably across MCP-capable runtimes.

## Routing CLI-only Operations

Some lifecycle operations live in the CLI and have no MCP equivalent (yet). When the user asks for these, surface the exact terminal command:

| Operation | CLI command |
|---|---|
| Pin a skill to a version | `skillsmith pin <skill> <version>` |
| Unpin a skill | `skillsmith unpin <skill>` |
| Update all installed skills | `skillsmith update --all` |
| Audit advisories (Team+) | `skillsmith audit advisories` |
| Audit collisions | `skillsmith audit collisions` |
| Configure audit mode | `skillsmith config set audit_mode <preventative\|power_user\|governance\|off>` |
| Author a new skill | `skillsmith author init <name>` |
| Publish a skill | `skillsmith author publish` |
| Login | `skillsmith login` |

Always show the command verbatim with a one-line note: "Run this in your terminal."

## Cross-Runtime Behavior

Skillsmith's MCP server works in **any MCP-capable agent runtime**:

- **Claude Code** — default runtime. Skills install to `~/.claude/skills/`.
- **Cursor / Copilot / Windsurf** — set `SKILLSMITH_CLIENT=<runtime>` in your MCP server env config to install to the runtime-equivalent path. See [Getting Started](https://skillsmith.app/docs/getting-started).
- **Custom MCP routers** — universal MCP tool calls work; skill-file install paths configurable via `SKILLSMITH_CLIENT`.

## Trust Tiers

Skills are categorized by verification level:

| Tier | Badge | Meaning | When to Trust |
|------|-------|---------|---------------|
| **Verified** | Green checkmark | Official Skillsmith / Anthropic | Always safe |
| **Curated** | Blue badge | Vendor-org publisher, ≥0.80 quality | Generally safe |
| **Community** | Yellow | Security scan + required metadata | Review before install |
| **Experimental** | Orange | Beta / new | Use cautiously |
| **Unknown** | Red warning | No verification | Only if you trust the author |

For criteria detail, see https://skillsmith.app/docs/trust-tiers.

## Pricing & Quotas

| Tier | API calls/month | Price |
|---|---|---|
| **Community** | 1,000 | Free |
| **Individual** | 10,000 | $9.99/mo |
| **Team** | 100,000 | $25/user/mo |
| **Enterprise** | Unlimited | $55/user/mo |

Usage warnings at 80% and 90%. Upgrade at https://skillsmith.app/upgrade.

## Security Model

Skillsmith is the security boundary between untrusted skill sources and your runtime.

**What Skillsmith validates before install**:

- SKILL.md frontmatter and required fields
- Security scan: jailbreak patterns, suspicious URLs, sensitive file access
- Typosquatting check against known skills
- Blocklist of known-malicious skills

**What Skillsmith cannot prevent**:

- Novel attack patterns not in detection database
- Social engineering in legitimate-looking instructions
- Runtime behavior (skills execute with your permissions)

**Recommendation**: review skill content before installation, especially for unverified skills.

## Creating Skills

Skill authoring lives in the CLI:

```
skillsmith author init my-new-skill
skillsmith author validate
skillsmith author publish
```

For an end-to-end walkthrough, see https://skillsmith.app/docs/tutorials/author.

The companion **skill-builder** skill (auto-installed) guides you through frontmatter, progressive disclosure structure, and directory organization.

## Common Workflows

### Discover then install

```
"Use Skillsmith to recommend skills for my Next.js project"
"Use Skillsmith to install community/next-helper"
```

### Evaluate before installing

```
"Use Skillsmith to compare jest-helper and vitest-helper"
"Use Skillsmith to show details for community/vitest-helper"
"Use Skillsmith to install community/vitest-helper"
```

### Maintain installed skills

```
"Ask Skillsmith for updates to my installed skills"
# Then run in terminal:
skillsmith update --all
```

### Audit before sharing your skill folder

```
"Use Skillsmith to audit my skills inventory"
# Or in terminal:
skillsmith audit collisions
```

## License

Skillsmith uses **Elastic License 2.0**:

- Self-host for internal use ✓
- Modify for your own use ✓
- Offer Skillsmith as a managed service to others ✗
- Circumvent license key functionality ✗

## Getting Help

- Docs: https://skillsmith.app/docs
- Tutorials (lifecycle walkthroughs): https://skillsmith.app/docs/tutorials
- CLI: `skillsmith --help`
- Issues: https://github.com/smith-horn/skillsmith/issues
- Email: support@skillsmith.app
