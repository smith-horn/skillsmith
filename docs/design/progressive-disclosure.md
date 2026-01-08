# Progressive Disclosure Strategy

> **Navigation**: [Design Index](./index.md) | Progressive Disclosure

Feature revelation strategy that grows with user expertise. New users see simple choices; power reveals itself to those who seek it.

---

## Design Principle

**Reveal Complexity Gradually:** The interface grows with user expertise.

- First-run shows 3 options maximum
- Advanced features hidden behind explicit "show more" actions
- Complexity unlocked through demonstrated competence
- Settings have sensible defaults that work for 80% of users

---

## Experience Levels

| Level | User Profile | Commands Visible | Trigger for Next Level |
|-------|--------------|------------------|------------------------|
| New | First-time user | 3 commands | Completes first recommendation cycle |
| Growing | Has installed 1+ skills | 7 commands | 5+ installed skills OR 3+ searches |
| Power | Active regular user | 12 commands | Configures settings OR completes exercises |
| Expert | Advanced customizer | All commands | Explicit request OR creator role |

---

## New User Experience (Minimal)

**Goal:** Get to first value in under 5 minutes without overwhelm

### Visible Commands

```
/discover recommend     # What skills should I install?
/discover install       # Install a skill
/discover help         # What else can I do?
```

### Hidden Until Needed
- Search with advanced filters
- Comparison tools
- Team features
- Learning paths
- Configuration options

### Trigger for Revealing More
- User explicitly asks for more options
- User completes first recommendation cycle
- User invokes `/discover help`

### Help Output (New User)

```
Discovery Hub - Getting Started

You have 3 commands available:

  /discover recommend   See skills that match your project
  /discover install     Install a recommended skill
  /discover help        Show this help

That's it for now. Complete your first install to unlock more.

Want to skip ahead? /discover help --all
```

---

## Growing User Experience (More Options)

**Goal:** Enable exploration without overwhelming casual users

### Visible Commands (adds to minimal)

```
/discover search <query>      # Find specific skills
/discover browse <category>   # Browse by category
/discover compare <s1> <s2>   # Compare two skills
/discover list               # What do I have installed?
/discover uninstall <skill>  # Remove a skill
```

### Hidden Until Needed
- Advanced search filters
- Learning paths
- Team features
- Analytics
- Configuration

### Trigger for Revealing More
- User has 5+ installed skills
- User searches 3+ times in a session
- User explicitly asks for advanced features

### Help Output (Growing User)

```
Discovery Hub - Core Commands

Discovery:
  /discover recommend         Get personalized recommendations
  /discover search <query>    Find skills by keyword
  /discover browse <cat>      Browse by category

Management:
  /discover install <skill>   Install a skill
  /discover uninstall <skill> Remove a skill
  /discover list              See installed skills
  /discover compare <s1> <s2> Compare two skills

More commands available. Use /discover help --advanced
```

---

## Power User Experience (Full Control)

**Goal:** Enable complete control for users who want it

### Visible Commands (adds to growing)

```
/discover search --author:<name> --min-score:80
/discover analyze --deep        # Full codebase analysis
/discover export-report         # Shareable report
/discover learn                 # Learning paths
/discover stats                # Usage analytics
/discover config               # Configuration
```

### Hidden Until Needed
- Team registry features
- Publishing workflow
- API access
- Automation hooks

### Trigger for Revealing More
- User configures settings
- User completes learning exercises
- User explicitly asks for team/publishing features

### Help Output (Power User)

```
Discovery Hub - Full Command Reference

Discovery:
  /discover recommend              Personalized recommendations
  /discover search <query>         Find skills (supports filters)
    --author:<name>                Filter by author
    --min-score:<n>                Minimum quality score
    --category:<cat>               Filter by category
  /discover browse <category>      Browse by category
  /discover analyze [--deep]       Codebase analysis

Management:
  /discover install <skill>        Install a skill
  /discover uninstall <skill>      Remove a skill
  /discover list                   See installed skills
  /discover compare <s1> <s2>      Compare skills

Insights:
  /discover stats                  Usage analytics
  /discover export-report          Generate shareable report

Learning:
  /discover learn                  Start learning path
  /discover exercises              Available exercises

Configuration:
  /discover config                 View/edit settings
  /discover config set <k> <v>     Set configuration value

Use /discover help --expert for team and publishing commands
```

---

## Expert User Experience (Customization)

**Goal:** Enable complete system customization for power users

### Visible Commands (adds to power)

```
/discover publish              # Publish a skill
/discover team                # Team registry
/discover api-key             # API access
/discover webhook             # Automation hooks
/discover index --custom      # Custom skill indices
```

### Access Requirements
- Demonstrated platform familiarity (usage threshold)
- Explicit request for advanced features
- Team or creator role acknowledgment

### Help Output (Expert User)

```
Discovery Hub - Expert Commands

[Previous commands plus...]

Team Management:
  /discover team create <name>     Create team registry
  /discover team add <skill>       Add skill to team registry
  /discover team invite <user>     Invite team member
  /discover team compliance        View team compliance

Publishing:
  /discover publish <skill>        Publish skill to registry
  /discover author-dashboard       View author analytics
  /discover update <skill>         Update published skill

Integration:
  /discover api-key               Generate API key
  /discover webhook add <url>     Add webhook for events
  /discover index --custom <url>  Use custom skill index

Use /discover help <command> for detailed command help
```

---

## Disclosure by Entry Point

### Terminal
Progressive disclosure through command availability and help output.

### Web Browser
- Default view: Categories, featured skills, simple search
- Advanced: Filters, comparison, detailed analytics
- Expert: Author dashboard, publishing tools

### VS Code Extension
- Default view: Recommendations panel, one-click install
- Advanced: Search, browse, comparison
- Expert: Team settings, publishing preview

---

## Unlock Indicators

When a user qualifies for new commands, show briefly:

```
New commands unlocked!

You've installed 5 skills. Here's what's new:

  /discover stats      - See your usage analytics
  /discover learn      - Start a learning path
  /discover config     - Customize settings

Use /discover help to see all available commands.
```

---

## "Skip Ahead" Mechanism

For users who want full access immediately:

```
/discover help --all          # Show all commands regardless of level
/discover config set level expert  # Unlock all features
```

This respects user autonomy while maintaining simple defaults for those who prefer them.

---

## Related Documents

- [Personas](./personas/index.md) - Different disclosure needs by persona
- [Entry Points](./entry-points.md) - Disclosure per surface
- [Tone of Voice](./tone-of-voice.md) - How to communicate new features

---

*Progressive Disclosure Strategy - December 26, 2025*
