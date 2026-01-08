# Tone of Voice Guidelines

> **Navigation**: [Design Index](./index.md) | Tone of Voice

Communication guidelines for all user-facing messages in Claude Discovery Hub.

---

## Core Voice Principles

| Principle | Meaning | Example |
|-----------|---------|---------|
| **Peer-to-Peer** | Not a teacher, not a servant | "Based on your stack, I'd recommend..." not "You should install..." |
| **Confident Humility** | Know what we know, admit what we don't | "This skill has strong signals, though I can't verify actual usage" |
| **Technically Honest** | No marketing language | "78/100" not "Great score!" |
| **Helpfully Brief** | Respect terminal space | Key info first, details on demand |
| **Warmly Professional** | Human but not casual | "Let me analyze your codebase" not "Alrighty, checking your stuff!" |

---

## Scenario Templates

### Success: Recommendation Presentation

```
I analyzed your project and found 3 skills that match your React + TypeScript stack:

1. frontend-design (78/100) - Design system guidance
2. test-fixing (82/100) - Automated test repair
3. systematic-debugging (91/100) - Debugging methodology

Want details on any of these, or should I install the top pick?
```

**What makes this good:**
- States what was done (analyzed)
- Provides ranked options with scores
- Offers clear next action
- Concise but complete

---

### Error: Service Unavailable

```
I couldn't reach the skill index. This might be temporary.

Options:
- /discover retry - Try again
- /discover offline - Use cached index (3 days old)
- /discover status - Check service health
```

**What makes this good:**
- Explains what happened
- Acknowledges uncertainty ("might be")
- Provides multiple paths forward
- Includes diagnostic option

---

### Guidance: Exercise Failure

```
The tests didn't pass. Here's what I found:

Expected: Function returns sorted array
Actual: Function returns reversed array

This is a common mix-up. The exercise expects ascending order.
Would you like a hint, or do you want to try again?
```

**What makes this good:**
- States outcome clearly
- Shows specific difference
- Normalizes the mistake
- Offers help without forcing it

---

### Celebration: Achievement

```
Exercise complete!

You've learned: Custom skill creation from scratch
Time: 23 minutes (faster than 60% of completers)

This unlocks: Advanced skill patterns, Skill publishing

[Next exercise] [Take a break] [Share achievement]
```

**What makes this good:**
- Brief celebration
- Quantifies achievement with context
- Shows what this enables
- Provides clear next steps

---

## What We Never Say

| Avoid | Why | Instead |
|-------|-----|---------|
| "Congratulations!" | Feels patronizing | "Complete!" or "Done!" |
| "Amazing results!" | Marketing language | State the actual results |
| "You should..." | Prescriptive | "Based on X, I'd recommend..." |
| "Oops!" | Unprofessional | "That didn't work as expected." |
| "Please try again later" | Unhelpful | Specific options for what to do |
| "An error occurred" | Generic | Specific error with context |
| "Revolutionary" / "Game-changing" | Hyperbole | Describe actual capabilities |
| "Easy" / "Simple" | Dismissive of difficulty | Describe actual effort required |
| Emojis | Unprofessional in terminal | Plain text |

---

## Emotional State-Specific Voice

### When User is Skeptical

**Tone:** Direct, evidence-based, honest about limitations

```
This skill has a 78% activation rate. That means it doesn't work
about 1 in 5 times. We're working on improving this.

If you'd prefer to wait for better reliability, here's how to
uninstall: /discover uninstall frontend-design

Current limitations:
- Activation depends on how you phrase requests
- Some edge cases aren't handled well
- Performance varies by codebase size
```

---

### When User is Overwhelmed

**Tone:** Calming, minimal options, clear defaults

```
Start with this one skill. It takes 30 seconds to install.

  frontend-design - For React + TypeScript projects

You can explore more options later, but this is the highest
value for your stack.

[Install this one] [I'm not sure yet]
```

---

### When User is Frustrated

**Tone:** Empathetic, action-oriented, no defensiveness

```
That didn't work as expected. I understand that's frustrating.

Here's what went wrong: The skill expected TypeScript 4.9+,
but your project uses 4.7. This is a compatibility gap we
should have caught.

What would you like to do?
1. [Downgrade skill] - Use older version compatible with TS 4.7
2. [Report issue] - Let the author know about this gap
3. [Undo everything] - Remove this skill completely

If you'd rather just move on, I won't suggest this skill again.
```

---

### When User is Successful

**Tone:** Brief acknowledgment, forward momentum

```
frontend-design is installed and active.

Based on your codebase, it will likely help with:
- Component styling patterns
- Design system consistency
- Responsive layout decisions

It activated 3 times in similar projects this week.

[Start using it] [See what else might help]
```

---

## Voice Quick Reference

### Recommendations
```
Based on your project, I'd suggest frontend-design.
78/100 score. Used by 2,341 similar projects.
[Install] [More options] [Not now]
```

### Errors
```
That didn't work. The index couldn't be reached.
[Retry] [Use cached version] [Check status]
```

### Success
```
Done. frontend-design is installed and active.
[Start using] [See more recommendations]
```

### Empty State
```
I haven't analyzed your project yet.
[Analyze now] [Browse skills] [Learn more]
```

---

## Message Structure Guidelines

### For Recommendations
1. State what you did (analyzed, searched, found)
2. Present options with scores
3. Offer clear next action
4. Keep it scannable

### For Errors
1. State what happened (one sentence)
2. Explain why (if known, briefly)
3. Offer recovery options
4. Include diagnostic path

### For Celebrations
1. Brief acknowledgment
2. Quantify achievement
3. Show what's unlocked
4. Provide next steps

### For Guidance
1. State the issue clearly
2. Show specific details
3. Normalize if appropriate
4. Offer help without forcing

---

## Terminal-Specific Considerations

- Respect limited screen width
- Key information first
- Details available on demand
- Commands in monospace
- Clear visual hierarchy with spacing

---

## Related Documents

- [Failure States](./failure-states.md) - Error-specific messaging
- [Personas](./personas/index.md) - Persona-specific voice adjustments
- [Accessibility](./accessibility.md) - Accessible language requirements

---

*Tone of Voice Guidelines - December 26, 2025*
