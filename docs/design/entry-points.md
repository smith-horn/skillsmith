# Entry Points Design

> **Navigation**: [Design Index](./index.md) | Entry Points

Multi-surface strategy for Claude Discovery Hub. Each entry point serves different user needs and personas.

---

## Entry Point Overview

| Entry Point | Phase | Primary Persona | Core Value |
|-------------|-------|-----------------|------------|
| [Terminal](#terminal-primary) | Phase 1 | Optimizer, Skeptic | Full control and speed |
| [Web Browser](#web-browser-discovery-surface) | Phase 2 | Explorer, Overwhelmed | Visual browsing and research |
| [VS Code Extension](#vs-code-extension-workflow-integration) | Phase 2 | Optimizer, Overwhelmed | Context-aware, zero switching |
| [Standalone CLI](#standalone-cli-skeptic-friendly) | Phase 2 | Skeptic | Evaluate without commitment |
| [Public Profiles](#public-profiles-social-proof) | Phase 3 | Creator, Explorer | Reputation and social discovery |

---

## Terminal (Primary)

**User Need Served:** Power users who want full control and speed

### Persona Fit

| Persona | Fit Level | Reason |
|---------|-----------|--------|
| Explorer | High | Search and browse commands |
| Optimizer | High | Targeted, efficient |
| Standardizer | Medium | Needs exportable outputs |
| Creator | Medium | Publishing workflow |
| Skeptic | High | Full transparency, inspectable |
| Overwhelmed | Low | Can be intimidating |

### Minimum Viable Design

```
/discover search <query>     # Find skills by keyword
/discover recommend          # Get recommendations for current project
/discover install <skill>    # Install a skill
/discover list              # List installed skills
/discover uninstall <skill> # Remove a skill
```

### Connection to Core Experience
- All other entry points eventually generate terminal commands
- Terminal is the "truth" layer where operations actually happen
- Other surfaces provide discovery and preview; terminal provides action

---

## Web Browser (Discovery Surface)

**User Need Served:** Visual browsing, comparison, and research before commitment

### Persona Fit

| Persona | Fit Level | Reason |
|---------|-----------|--------|
| Explorer | High | Visual browsing, serendipity |
| Optimizer | Medium | Comparison views |
| Standardizer | High | Shareable reports |
| Creator | High | Public profiles, badges |
| Skeptic | High | Research before install |
| Overwhelmed | High | Visual organization |

### Minimum Viable Design
- Static site with skill browser
- Category-based navigation
- Search with preview
- Skill comparison (side-by-side)
- "Copy install command" button
- No login required

### Key Pages

1. **Home:** Featured skills, categories, search
2. **Browse:** Category navigation, filtering
3. **Skill detail:** Full info, reviews, install command
4. **Compare:** Side-by-side skill comparison
5. **Profile:** Author pages with skill portfolios (Phase 3)

### Connection to Core Experience
- "Install" generates terminal command to copy
- Optional: Deep link that opens Claude Code with command
- No authentication required; read-only surface

---

## VS Code Extension (Workflow Integration)

**User Need Served:** Context-aware discovery without leaving IDE

### Persona Fit

| Persona | Fit Level | Reason |
|---------|-----------|--------|
| Explorer | Medium | Less serendipity than web |
| Optimizer | High | Context-aware, zero switching |
| Standardizer | Medium | Individual-focused |
| Creator | Low | Not publishing surface |
| Skeptic | Medium | Trusted marketplace |
| Overwhelmed | High | Visual, guided |

### Minimum Viable Design
- Sidebar panel with skill browser
- Context-aware recommendations based on open file
- One-click install (triggers terminal command)
- "What's this skill doing?" tooltip

### Connection to Core Experience
- Install actions trigger terminal commands
- Recommendations based on codebase analysis
- Skill status synced from local installation

---

## Standalone CLI (Skeptic-Friendly)

**User Need Served:** Evaluate and explore without installing into Claude Code

### Persona Fit

| Persona | Fit Level | Reason |
|---------|-----------|--------|
| Explorer | Medium | Less integrated |
| Optimizer | High | Clean, targeted |
| Standardizer | Low | Not team-oriented |
| Creator | Low | Not publishing surface |
| Skeptic | High | Isolated, controllable |
| Overwhelmed | Low | Additional tool to learn |

### Minimum Viable Design

```
discovery search <query>     # Search skills
discovery analyze .          # Analyze current directory
discovery preview <skill>    # View skill details
discovery install <skill>    # Install to Claude Code
discovery uninstall <skill>  # Remove from Claude Code
```

### Connection to Core Experience
- Install commands write to Claude Code configuration
- Can function completely independently for search/analyze
- Bridge for users who want to evaluate before committing

---

## Public Profiles (Social Proof)

**User Need Served:** Reputation building, social discovery, trust via association

### Persona Fit

| Persona | Fit Level | Reason |
|---------|-----------|--------|
| Explorer | High | Follow respected developers |
| Optimizer | Low | Not efficiency-focused |
| Standardizer | Medium | Team reference stacks |
| Creator | High | Reputation building |
| Skeptic | High | Trust through association |
| Overwhelmed | Medium | Curated recommendations |

### Minimum Viable Design
- URL: discoveries.dev/@username
- Skills installed with usage frequency
- Custom "recommended stack" curation
- "Clone this setup" functionality
- Embeddable badges for GitHub profiles

### Connection to Core Experience
- "Clone setup" generates terminal commands
- Public data sourced from opt-in telemetry
- Author profiles link to their published skills

---

## Entry Points Priority Matrix

| Entry Point | Phase | Effort | Impact | Primary Persona |
|-------------|-------|--------|--------|-----------------|
| Terminal | Phase 1 | Core | High | Optimizer, Skeptic |
| Web skill browser | Phase 2 | Medium | High | Explorer, Skeptic, Overwhelmed |
| VS Code extension | Phase 2 | Medium | Very High | Optimizer, Overwhelmed |
| Standalone CLI | Phase 2 | Medium | High | Skeptic |
| Public profiles | Phase 3 | Low | High | Creator, Explorer |
| Embeddable badges | Phase 3 | Low | Medium | Creator |

---

## Cross-Entry Point Consistency

### Command Mapping

| Action | Terminal | CLI | VS Code | Web |
|--------|----------|-----|---------|-----|
| Search | /discover search | discovery search | Search panel | Search bar |
| Analyze | /discover recommend | discovery analyze | Auto on open | Upload project |
| Preview | /discover info | discovery preview | Hover tooltip | Skill page |
| Install | /discover install | discovery install | One-click button | Copy command |
| Uninstall | /discover uninstall | discovery uninstall | Context menu | N/A |

### State Synchronization
- All entry points read from same local state
- Terminal is source of truth
- Other surfaces provide views and shortcuts

---

## Related Documents

- [Personas](./personas/index.md) - Persona preferences by entry point
- [Progressive Disclosure](./progressive-disclosure.md) - Feature availability by entry point
- [Accessibility](./accessibility.md) - Accessibility per entry point

---

*Entry Points Design - December 26, 2025*
