# The Skeptic

> **Navigation**: [Design Index](../index.md) > [Personas](./index.md) > Skeptic

**Archetype:** The Burned-Before Developer

> *"I've been disappointed by enough 'revolutionary' tools. Prove it."*

---

## Demographics

- 8+ years experience
- Tried 3+ AI coding assistants before
- Values simplicity and reliability over features
- Often influential in team decisions

---

## Goals

| Functional | Emotional |
|------------|-----------|
| Evaluate without commitment | Feel protected from disappointment |
| Verify claims before investing | Confidence in decision-making |
| Understand limitations upfront | Relief from hidden surprises |
| Maintain independence from vendors | Security in self-reliance |

---

## Fears and Anxieties

- Wasting hours on setup that doesn't work
- Vendor lock-in and dependency
- Hidden complexity beneath simple surface
- Recommendation systems pushing popular over relevant
- Breaking existing workflow with new tools

---

## Current Behavior and Workarounds

- Researches extensively before any install
- Prefers tools they can inspect (open source)
- Tests in throwaway environments first
- Maintains skepticism about automation
- Often becomes advocate if convinced

---

## Trust Triggers (What Builds Confidence)

- Transparent failure rates ("78% activation rate")
- Visible escape hatches everywhere
- No account required for full functionality
- Open source with inspectable code
- Gradual commitment path (preview before install)
- Evidence of real usage from recognizable developers
- Honest limitations documentation

---

## Delight Triggers (What Creates Joy)

- Being proven wrong about skepticism
- Finding a tool that under-promises and over-delivers
- Seeing the system admit its own limitations
- Clean experience with no hidden catches

---

## Preferred Entry Points

1. **Standalone CLI** for evaluation without commitment
2. **Web browser** for research before any install
3. **GitHub repository** for code inspection
4. **Public profiles** for social proof

---

## Red Flags That Cause Abandonment

- Marketing language ("AI-powered", "revolutionary")
- Required accounts or sign-ups
- Claims of 90%+ accuracy on anything
- No uninstall documentation visible
- Aggressive recommendation frequency
- Black-box scoring or recommendations

---

## Specific Onboarding Message for Skeptics

```
Welcome. We know you've probably tried tools like this before.

Here's what we're not going to do:
- Force you to create an account
- Install anything without your explicit approval
- Send you marketing emails
- Make your workflow dependent on our servers

Here's what we will do:
- Work entirely locally (you can air-gap this)
- Show you exactly what we recommend and why
- Let you uninstall everything with one command
- Be honest about our 70% recommendation accuracy

Start small: Try `discovery analyze .` to see recommendations
without installing anything. If it's not useful, uninstall with
`npm uninstall -g @claude/discovery`.
```

---

## Design Implications

### For Discovery Features
- Show all scoring criteria transparently
- Provide full recommendation reasoning
- Never hide limitations

### For Search
- Support code-level inspection of skills
- Show actual usage data, not marketing
- Display honest accuracy/success rates

### For Recommendations
- Explain exactly why each was recommended
- Show confidence levels with context
- Never oversell

### For Installation
- Preview exactly what will change
- Provide easy rollback
- One-command uninstall prominently displayed

### For Ongoing Experience
- No aggressive notifications
- Honest reporting of successes and failures
- Respect "stop suggestions" preferences

---

## Quick Card

**Motivation:** "Prove it works"
**Fear:** Wasting time, vendor lock-in
**Entry Point:** Standalone CLI, web research
**Trust Trigger:** Transparency, escape hatches

---

## Related Personas

- [Optimizer](./optimizer.md) - Similar caution, different motivation
- [Creator](./creator.md) - Often becomes strong advocate if convinced

---

*Skeptic Persona - December 26, 2025*
