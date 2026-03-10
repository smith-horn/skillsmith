---
title: "Dependency Intelligence: How Skillsmith Infers What Your Skills Need"
description: "Skills reference MCP servers, models, and other skills — but until now, users had no way to know what a skill actually needs. Skillsmith's new dependency intelligence layer combines author declarations, static analysis, and behavioral data to surface dependencies before they become failures."
author: "Ryan Smith"
date: 2026-03-10
updated: 2026-03-10
category: "Engineering"
tags: ["dependency-intelligence", "mcp-server", "skill-dependencies", "claude-code", "wave-planner", "agentic-engineering", "mcp-tools"]
featured: true
draft: false
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/dependency-intelligence/01-hero"
---

<!-- IMAGE: 01-hero
  A wide-format hero graphic with a dark gradient background (deep navy to charcoal).
  Center composition: three stylized signal streams (one gold for "declared", one cyan for
  "inferred static", one magenta for "co-install behavioral") converging into a single
  diamond-shaped node labeled "Dependency Intelligence". Below the node, a clean table-style
  readout showing skill names with green checkmarks and amber warning icons. The Skillsmith
  logo mark sits subtly in the bottom-right corner. Style: flat/geometric, consistent with
  the existing Skillsmith blog aesthetic. Dimensions: 1200x630.
-->
![Dependency Intelligence: Three signals, one dependency graph](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/dependency-intelligence/01-hero)

A governance skill calls `mcp__linear__save_issue` in its agent prompt. A user installs it. Linear isn't configured. The skill fails with no explanation.

This was the status quo. Skills referenced MCP servers, models, and other skills throughout their content — but that information was invisible at install time. The user had no way to know what a skill actually *needed* until it broke.

Dependency Intelligence is our fix. Three signal sources — author declarations, static content analysis, and behavioral co-install data — merge into a single dependency graph that surfaces what every skill requires, before it becomes a failure.

---

## Key Takeaways

- **Three-source intelligence** combines author-declared dependencies, inferred MCP references from skill content, and behavioral co-install patterns into a unified dependency view
- **Seven tools now surface dependency data** — `install_skill`, `get_skill`, `skill_validate`, `skill_outdated`, `skill_diff`, `skill_compare`, and `skill_audit` each contribute a piece of the dependency picture
- **Authors get actionable feedback** — `skill_validate` warns about inferred MCP servers not declared in frontmatter, deprecated `composes` fields, and missing dependency blocks before publish
- **No auto-resolution by design** — Skillsmith surfaces intelligence for user awareness; hard dependencies block installs with clear messages, soft dependencies produce advisory warnings
- **Available now at Community tier** — `skill_outdated` and `skill_validate` require no license; `skill_diff` is Individual tier; `skill_audit` is Team tier

---

## The Problem: Silent Failures

Skills are markdown files with embedded instructions. Those instructions frequently reference external dependencies — MCP servers (`mcp__linear__save_issue`), other skills (`composes: [wave-planner]`), models with specific capabilities, or CLI tools that need to be installed.

Before Dependency Intelligence, none of this was surfaced programmatically:

| Failure mode | User experience |
|-------------|-----------------|
| Skill calls `mcp__linear__*` tools | Silent MCP errors, no explanation |
| Skill assumes `git-crypt` is installed | Cryptic shell errors mid-execution |
| Skill requires Opus-class model | Degraded output, no warning |
| Skill depends on another skill | Missing behavior, no trace |

The old `composes` field in SKILL.md frontmatter was a flat string array — no type information, no versioning, no distinction between "this will break without it" and "this works better with it." It was metadata without meaning.

---

## Three Signal Sources

<!-- IMAGE: 02-three-signals
  A horizontal three-column diagram on a dark background. Each column represents a signal
  source with a distinct color:
  - Left column (gold): "Author Declaration" — icon of a pen writing YAML, showing the
    dependencies block in SKILL.md frontmatter. Label: "confidence: 1.0"
  - Center column (cyan): "Static Analysis" — icon of a magnifying glass scanning code,
    with regex pattern `mcp__server__tool` highlighted. Two sub-labels: "prose: 0.9" and
    "code block: 0.5"
  - Right column (magenta): "Co-Install Behavioral" — icon of overlapping circles
    (Venn diagram style) showing skills frequently installed together. Label:
    "confidence: min(1.0, count/20)"
  All three columns flow downward via arrows into a single row labeled "DependencyMerger"
  that outputs a unified dependency table. Style: clean, geometric, matching blog aesthetic.
  Dimensions: 1200x675.
-->
![Three signal sources converge into one dependency graph](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/dependency-intelligence/02-three-signals)

Dependency Intelligence doesn't rely on a single source of truth. It triangulates from three independent signals, each with calibrated confidence scores.

### Signal 1: Author Declaration (confidence: 1.0)

Authors declare dependencies directly in SKILL.md frontmatter using a structured `dependencies` block. This replaces the deprecated `composes` field with typed, versioned relationships:

```yaml
dependencies:
  skills:
    - name: linear
      version: "*"
      type: hard
      reason: "Issue creation via Linear MCP"
  platform:
    mcp_servers:
      - name: linear
        required: true
  models:
    minimum: sonnet
    capabilities: ["tool_use"]
  environment:
    tools:
      - name: git-crypt
        required: false
        check: "git-crypt --version"
```

Declared dependencies always have confidence 1.0 — the author explicitly stated the requirement. Hard skill dependencies block installation with a clear message. Soft dependencies produce advisory warnings. This is real metadata, not a flat list.

### Signal 2: Static MCP Reference Analysis (confidence: 0.5–0.9)

The `McpReferenceExtractor` scans skill content for `mcp__server__tool` patterns using regex:

```
mcp__([a-z][a-z0-9-]*)__([a-z][a-z0-9_]*)
```

Every match extracts the server name and tool name. The extractor then assigns confidence based on *where* the reference appears:

- **Prose** (outside code blocks): **0.9** — the skill is describing what it does, high likelihood it actually calls this tool
- **Code block** (inside fenced blocks): **0.5** — could be an example, a template, or documentation rather than a live reference

This distinction matters. A skill that *explains* how to use Linear (`mcp__linear__save_issue` in a code example) is different from a skill that *calls* Linear directly. Both get tracked, but at different confidence levels. Input is capped at 100KB to prevent ReDoS.

### Signal 3: Behavioral Co-Install Data (confidence: 0.0–1.0)

The `CoInstallRepository` tracks which skills are frequently installed together. When 15 out of 20 governance users also install the Linear skill, that behavioral signal carries weight — even if neither skill explicitly declares the other as a dependency.

Confidence ramps linearly: `min(1.0, install_count / 20)`. A single co-install registers at 0.05; twenty co-installs reach full confidence. This prevents noisy early data from generating spurious recommendations while letting strong patterns surface over time.

### How They Merge

The `DependencyMerger` combines all three sources with a clear priority: **declared dependencies always win.** If an author declares `linear` as a required MCP server and the static analyzer also detects `mcp__linear__*` references, the declared version is kept and the inferred duplicate is dropped.

| Source | Confidence | Trumps |
|--------|-----------|--------|
| Author declaration | 1.0 | Everything |
| Static analysis (prose) | 0.9 | Co-install |
| Static analysis (code block) | 0.5 | Nothing |
| Co-install behavioral | 0.0–1.0 (ramp) | Nothing |

The merged output writes to a `skill_dependencies` table in SQLite — one row per dependency, with type, target, version constraint, source, confidence, and JSON metadata. A unique index on `(skill_id, dep_type, dep_target, dep_source)` prevents duplicates while enabling reverse lookups: "show me every skill that depends on the Linear MCP server."

---

## The `dependencies` Block: What Authors Declare

The new frontmatter schema supports five dependency categories with explicit type discriminators:

```yaml
dependencies:
  skills:           # skill-to-skill relationships
    - name: "author/skill-name"
      version: "^1.0.0"        # semver range
      type: hard | soft | peer  # hard blocks install, soft warns, peer suggests
      reason: "Why this is needed"

  platform:         # MCP and CLI requirements
    cli: ">=1.0.0"             # Claude Code CLI version
    mcp_servers:
      - name: linear
        package: "@anthropic/linear-mcp"
        required: true | false

  models:           # model requirements
    minimum: sonnet            # minimum model tier
    recommended: opus
    capabilities: ["tool_use", "vision"]
    context_window: 100000

  environment:      # tools, OS, runtime
    tools:
      - name: docker
        required: true
        check: "docker --version"
    os: ["darwin", "linux"]
    node: ">=20.0.0"

  conflicts:        # known incompatibilities
    - name: "author/conflicting-skill"
      reason: "Overlapping key bindings"
```

This schema maps to eleven database `dep_type` values: `skill_hard`, `skill_soft`, `skill_peer`, `mcp_server`, `model_minimum`, `model_capability`, `env_tool`, `env_os`, `env_node`, `cli_version`, and `conflict`. Each type drives different behavior — hard skill deps block, conflicts warn, environment deps surface check commands.

---

## The Toolkit: Seven Tools, Two Audiences

<!-- IMAGE: 03-toolkit-overview
  A horizontal flow diagram on dark background showing the skill lifecycle from left to
  right: "Author" → "Publish" → "Registry" → "Install" → "Maintain". Along this flow,
  seven tool badges are positioned at their relevant lifecycle stages:
  - Author stage: skill_validate (cyan badge), skill_diff (blue badge)
  - Registry stage: skill_compare (purple badge), skill_audit (amber badge)
  - Install stage: install_skill (green badge), get_skill (teal badge)
  - Maintain stage: skill_outdated (magenta badge)
  Each badge has a one-line description beneath it. A dotted line labeled "dependency
  intelligence" runs underneath all seven tools, connecting them. Two persona icons
  sit at the edges: "Author" (left, with a pen icon) and "User" (right, with a terminal
  icon). Style: clean, geometric, matching Skillsmith blog aesthetic. Dimensions: 1200x500.
-->
![Seven tools surface dependency intelligence across the skill lifecycle](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/dependency-intelligence/03-toolkit-overview)

Dependency intelligence isn't a single tool — it's a layer that runs through the entire skill lifecycle. Seven MCP tools now participate, each surfacing the right information at the right moment.

### For Authors: Catch Issues Before Publish

**`skill_validate`** is the first line of defense. Run it against any SKILL.md and it will flag:

- **Deprecated `composes` field** — suggests migration to `dependencies.skills` with explicit `type: hard/soft/peer`
- **Inferred MCP servers not declared** — if your skill body references `mcp__linear__save_issue` outside code blocks but you haven't declared `linear` in `dependencies.platform.mcp_servers`, you'll see: *"Inferred MCP dependency: 'linear' (referenced in skill body). Consider declaring in dependencies.platform.mcp_servers."*
- **Malformed dependency blocks** — structural issues in the frontmatter YAML

These are warnings, not blockers. Authors can publish without addressing them. But the signal is clear: declare your dependencies and your users will have a better experience.

**`skill_diff`** compares two versions of an installed skill section-by-section, with risk scoring based on the nature of each change. When the Dependencies section changes between versions, it surfaces in the diff — giving authors (and reviewers) visibility into how a skill's requirements evolve across releases.

### For Users: Understand Before You Install

**`get_skill`** returns the full dependency table for any skill in the registry — declared and inferred, with confidence scores and source labels. Before you install a skill, you can see exactly what it expects: which MCP servers it references, which skills it depends on, what model capabilities it assumes.

**`skill_compare`** puts two to five skills side by side and includes dependency counts in the comparison. If you're choosing between two similar skills, the one with fewer external dependencies may be the simpler choice — or the one with more declared dependencies may be the more honest one. The comparison surfaces both.

**`install_skill`** now returns dependency intelligence in the install response:

- **`dep_inferred_servers`** — MCP servers detected in the skill content (e.g., `["linear", "github"]`)
- **`dep_declared`** — the full author-declared `dependencies` block
- **`dep_warnings`** — alerts when referenced MCP servers may not be configured

The user doesn't need to read through the skill's markdown to understand its requirements. The information is right there in the response.

### For Maintenance: Stay Current

<!-- IMAGE: 04-skill-outdated-screenshot
  A screenshot of the skill_outdated tool being invoked in Claude Code's terminal UI.
  The screenshot shows the MCP tool permission prompt with:
  - Header: "skillsmith - skill_outdated(include_deps: true) (MCP)"
  - Description text explaining the tool checks installed skills for updates and
    dependency satisfaction
  - Permission options: "Yes", "Yes, and don't ask again", "No"
  Dark terminal theme with monospace font, showing the native Claude Code tool approval UX.
  This is an actual product screenshot, not a mockup.
  Dimensions: original resolution, cropped to focus on the permission dialog.
-->
![The skill_outdated tool permission prompt in Claude Code](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/dependency-intelligence/04-skill-outdated-screenshot)

**`skill_outdated`** is a pull-based health check — the dependency equivalent of `npm outdated`. It reads the local skill manifest, hashes each installed SKILL.md, compares against the latest registry state, and checks dependency satisfaction:

```json
{
  "skills": [
    {
      "id": "smith-horn/governance",
      "installed_hash": "a1b2c3d4",
      "latest_hash": "e5f6g7h8",
      "status": "outdated",
      "semver": "1.4.1",
      "dependencies": {
        "total": 2,
        "satisfied": ["mcp_server:linear"],
        "missing": []
      }
    }
  ],
  "summary": {
    "total_installed": 8,
    "outdated": 1,
    "up_to_date": 6,
    "unknown": 1,
    "missing_deps": 0
  }
}
```

Skill-type dependencies (`skill_hard`, `skill_soft`, `skill_peer`) are verified against locally installed skill IDs — if the dependency is installed, it's satisfied; if not, it's missing. MCP server and environment dependencies are marked satisfied on a best-effort basis since Skillsmith can't verify runtime configuration.

**`skill_audit`** (Team tier) complements dependency intelligence with security advisory checks. It doesn't track dependencies directly, but when a skill version has a known vulnerability, the audit flags it — and the dependency graph tells you which other skills are affected downstream.

### Tier Availability

| Tool | Tier | License Required |
|------|------|-----------------|
| `skill_validate` | Community | No |
| `skill_outdated` | Community | No |
| `install_skill` (dep intel) | Community | No |
| `get_skill` (dep intel) | Community | No |
| `skill_compare` (dep counts) | Community | No |
| `skill_diff` | Individual | Yes |
| `skill_audit` | Team | Yes |

---

## Design Decisions: Why We Didn't Build a Resolver

The most common question: *why not auto-install missing dependencies?*

Three reasons.

**Control.** Skills are markdown files that get loaded into an AI agent's system prompt. Auto-installing a dependency means silently adding instructions to the agent's context. Users should know what's being added and why. Advisory warnings preserve user agency in a way that automatic resolution does not.

**Trust boundaries.** A skill declaring a hard dependency on another skill is a trust assertion — "I need this to function." Auto-resolving that assertion would mean one skill author can trigger installs of another author's code. Even with trust-tier verification, this crosses a boundary we're not comfortable crossing automatically.

**Scope.** Skillsmith is an intelligence layer, not a package manager. npm, pip, and cargo have decades of resolver engineering behind them — dependency hell, version conflicts, diamond dependencies, platform-specific overrides. We'd rather surface good information and let users make decisions than build a resolver that makes wrong decisions silently.

The rule: **hard declared dependencies block installs with clear messages. Everything else is advisory.** Users always see the full picture; they're never surprised by what was installed or why something failed.

---

## What's Next

Dependency Intelligence is the data layer. The next sprint builds policy and automation surfaces on top:

- **CycloneDX AI-BOM export** — dependency graph exported as a standard software bill of materials, useful for compliance audits and organizational governance
- **`dependency_policy` configuration** — Team and Enterprise tiers will support strict/advisory/ignore policies, letting organizations enforce dependency standards across their skill portfolio
- **GitHub Action PR comments** — when a PR modifies SKILL.md in ways that change the dependency graph, automated comments will surface the diff for review

The foundation is in place: three signal sources, calibrated confidence, a schema that supports eleven dependency types, and seven tools that surface the right information at every stage of the skill lifecycle. Every skill installed from this point forward gets a dependency profile — declared, inferred, or both.

---

*Dependency Intelligence is available now for all Skillsmith users. Run `skill_outdated` with `include_deps: true` to check your installed skills, or `skill_validate` on any SKILL.md to see what we infer. For skill authors: add a `dependencies` block to your SKILL.md frontmatter — [your users will thank you](https://www.skillsmith.app/docs).*
