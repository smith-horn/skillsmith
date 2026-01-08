# Accessibility Considerations

> **Navigation**: [Design Index](./index.md) | Accessibility

Inclusive design requirements for Claude Discovery Hub. Every user should be able to access full functionality.

---

## Screen Reader Compatibility

### Terminal Output Requirements
- All information conveyed through structured text, not ASCII art
- Progress indicators use percentage text, not visual bars
- Color is never the only way to convey information
- Tables use clear column headers and row labels

### Score Display (Accessible)

```
Skill: frontend-design
Quality Score: 78 out of 100
Tier: Trusted (scores 70-89)
Breakdown:
  - Quality: 24/30 points
  - Popularity: 25/35 points
  - Maintenance: 29/35 points
```

### Score Display (Avoid)

```
frontend-design [████████░░] 78  # Visual bar, not accessible
```

### Progress Indication (Accessible)

```
Installing frontend-design...
Progress: 45% complete
Step 2 of 4: Downloading skill files
```

### Progress Indication (Avoid)

```
Installing... [=====>    ]  # Visual bar, not accessible
```

---

## Cognitive Load Reduction

### For Users with Attention Difficulties
- Maximum 3 choices per decision point
- Clear default/recommended option highlighted
- No timed interactions
- State preserved across sessions
- Progress saved automatically

### Information Hierarchy

1. **What should I do?** (recommendation)
2. **Why?** (brief explanation)
3. **How?** (action command)
4. **More details** (available but not forced)

### Example: Accessible Recommendation

```
Recommendation: frontend-design

1. What: Install this skill for UI design help
2. Why: Matches your React + TypeScript stack
3. How: /discover install frontend-design
4. Details: /discover info frontend-design

[Install] [More info] [Skip]
```

---

## Time-Constrained User Accommodations

### For Users Who Can't Complete Long Sessions
- All exercises save progress automatically
- No penalties for pausing or resuming
- "Continue where I left off" as default
- Estimated time clearly shown before starting
- Break-friendly checkpoints in long exercises

### Exercise Time Communication

```
Exercise: Custom Skill Creation
Estimated time: 25 minutes
This exercise has 4 checkpoints. You can stop and resume at any checkpoint.

[Start] [Save for later]
```

### Session Recovery

```
Welcome back!

You have an exercise in progress:
  "Custom Skill Creation"
  Progress: 2 of 4 checkpoints complete
  Last activity: 2 days ago

[Continue] [Start over] [Abandon]
```

---

## Color-Independent Information Design

All information must be accessible without color:

| Information | Color Indicator | Non-Color Indicator |
|-------------|-----------------|---------------------|
| Skill quality tier | Green/Yellow/Red | "Certified"/"Trusted"/"Community" |
| Install status | Green checkmark | [Installed] / [Not installed] |
| Error state | Red text | "ERROR:" prefix |
| Warning state | Yellow text | "Warning:" prefix |
| Success state | Green text | "Done:" prefix |

### Example: Status Without Color

```
Skill Status Report

frontend-design
  Status: [Installed]
  Quality: Trusted (78/100)
  Last used: Today

test-fixing
  Status: [Not installed]
  Quality: Certified (92/100)

systematic-debugging
  Status: [Installed]
  Quality: Warning - Compatibility issue detected
```

---

## Motor Accessibility

### For Users with Motor Difficulties
- All commands executable with keyboard only
- No rapid successive key presses required
- Tab navigation through options
- Command history for re-execution
- Aliases for frequently used commands

### Command Aliases

```
/dr = /discover recommend
/ds = /discover search
/di = /discover install
/du = /discover uninstall
/dl = /discover list
```

### Command History

```
/discover history

Recent commands:
  1. /discover search api mocking
  2. /discover install api-mocking-patterns
  3. /discover recommend

Re-run: /discover history 1
```

---

## Language and Reading Level

### For Users with Reading Difficulties
- Plain language preferred over jargon
- Short sentences (under 20 words)
- Active voice
- Define technical terms on first use

### Jargon Translation

| Technical Term | Plain Language Alternative |
|----------------|---------------------------|
| "Activate" | "Start using" |
| "Deploy" | "Install" |
| "Configure" | "Set up" |
| "Parse" | "Read" |
| "Execute" | "Run" |

### Example: Plain Language

**Before:**
```
The skill failed to activate due to insufficient context
matching against the activation threshold parameters.
```

**After:**
```
The skill didn't start. Your request didn't match what
the skill is designed for.

Try rephrasing your request, or use a different skill.
```

---

## Accessible Output Formats

### For Screen Readers and Assistive Technology

All outputs should be available in these formats:
- Plain text (default)
- JSON (for programmatic access)
- Markdown (for documentation tools)

### Format Selection

```
/discover recommend --format=json
/discover recommend --format=text
/discover recommend --format=markdown
```

---

## Assistive Technology Testing Checklist

Before releasing any feature:

- [ ] Screen reader navigation (VoiceOver, NVDA)
- [ ] Keyboard-only operation
- [ ] High contrast mode compatibility
- [ ] Reduced motion respect
- [ ] Color blindness simulation
- [ ] Cognitive load assessment (3 choices max)
- [ ] Time constraint testing (pause/resume)

---

## Error Messages for Accessibility

### Requirements
- Error type clearly stated first
- Cause explained in plain language
- Recovery options listed clearly
- No reliance on color for error indication

### Example: Accessible Error

```
ERROR: Installation failed

What happened:
  The skill file could not be downloaded.

Why:
  Network connection timed out after 30 seconds.

What to do:
  1. Check your internet connection
  2. Try again: /discover install frontend-design
  3. Report issue: /discover report

Need help? /discover support
```

---

## Preferences and Customization

### Accessibility Settings

```
/discover config accessibility

Available settings:
  verbose       Show detailed explanations (default: off)
  aliases       Enable command shortcuts (default: on)
  format        Default output format (text/json/markdown)
  confirm       Require confirmation for installs (default: on)
  notifications Frequency of proactive suggestions (high/low/off)

Set: /discover config set verbose on
```

---

## Related Documents

- [Tone of Voice](./tone-of-voice.md) - Plain language guidelines
- [Failure States](./failure-states.md) - Accessible error design
- [Entry Points](./entry-points.md) - Accessibility per surface

---

*Accessibility Considerations - December 26, 2025*
