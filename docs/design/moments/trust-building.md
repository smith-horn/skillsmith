# Trust-Building Moments

> **Navigation**: [Design Index](../index.md) > [Moments](./index.md) > Trust-Building

Critical interactions that establish and maintain user confidence in Claude Discovery Hub.

---

## Moment: First Impression

**Trigger:** User encounters Discovery Hub for the first time (README, website, or first run)

### User Expects
- Clear explanation of what this does
- Evidence it's worth trying
- Quick path to value

### How We Exceed Expectations
- Lead with honest capability description, not marketing
- Show real usage numbers and testimonials
- "5 minutes to first value" promise with proof
- Visible limitations alongside capabilities

### Specific Copy

```
Claude Discovery Hub finds skills that match your codebase and workflow.

What it does:
- Scans 46,847 community skills
- Matches against your tech stack
- Recommends based on similar projects
- Installs with one command

What it doesn't do:
- Fix broken skills (we can only recommend working ones)
- Read your code (we analyze stack, not logic)
- Work offline (requires occasional index sync)

Current accuracy: 70% of recommendations are accepted by users.
We're working to improve this.
```

### Success Metric
- Time on README > 30 seconds
- Click to install > 20%

---

## Moment: First Recommendation

**Trigger:** User receives their first skill recommendation

### User Expects
- Something relevant to their work
- Clear explanation of why this was recommended
- Easy way to accept or reject

### How We Exceed Expectations
- Explain the specific signals that led to this recommendation
- Show confidence level honestly
- Provide one-click install AND one-click dismiss
- Show what other similar users chose

### Specific Copy

```
Based on your project, I recommend:

  frontend-design (78/100)
  "Create distinctive, production-grade interfaces"

  Why this recommendation:
  - Your project uses React + TypeScript (direct match)
  - 2,341 similar projects use this skill
  - Author has strong maintenance track record

  Confidence: Medium-High (82%)
  I'm less confident because your project is new and patterns are still emerging.

[Install] [Tell me more] [Not relevant - dismiss]
```

### Success Metric
- Accept rate > 30%
- Dismiss with reason > 20%

---

## Moment: First Failure (CRITICAL)

**Trigger:** Something goes wrong during user's experience

### User Expects
- At minimum, an error message
- At best, help understanding what happened

### How We Exceed Expectations
- Acknowledge the failure immediately and specifically
- Explain what happened in understandable terms
- Offer concrete remediation options
- Collect feedback to prevent recurrence

### Specific Copy (Skill didn't activate)

```
I noticed the frontend-design skill didn't activate for this task.

What happened:
The skill activates when you're creating new interfaces, but your
request was about fixing existing CSS. The match confidence was
only 34%, below the 50% activation threshold.

Options:
1. Rephrase: "Help me design a new layout for..." (will activate)
2. Force: /skill use frontend-design (manual activation)
3. Different skill: test-fixing might help with CSS debugging

Was this explanation helpful? [Yes] [No, I need more help]
```

### Success Metric
- User continues after failure > 70%
- Support ticket < 5%

---

## Moment: Recovery from Failure

**Trigger:** User attempts remediation after failure

### User Expects
- The fix to work
- Not to encounter the same problem

### How We Exceed Expectations
- Confirm the fix worked
- Explain what was different this time
- Prevent recurrence with guidance
- Thank user for patience

### Specific Copy

```
That worked!

The frontend-design skill activated successfully this time.
The difference: your rephrased request matched the skill's
activation pattern for "creating new interfaces."

Quick tip: Skills match against your task description. Using
verbs like "create," "design," or "build" typically activates
creative skills, while "fix," "debug," or "repair" activates
diagnostic skills.

Thanks for working through that with me.
```

### Success Metric
- Same error recurrence < 10%
- User sentiment positive

---

## Trust-Building Design Principles

### 1. Honesty First
- Never hide or minimize failures
- State limitations alongside capabilities
- Use real numbers, not marketing language

### 2. Explain the Why
- Every recommendation includes reasoning
- Every failure includes explanation
- Every recovery includes learning

### 3. Offer Paths Forward
- Never leave user without options
- Multiple recovery paths for every failure
- Always include "get more help" option

### 4. Collect Feedback
- "Was this helpful?" after key moments
- "Tell me more" for dismissed recommendations
- Feedback informs improvement

---

## Failure Response Template

For any trust-critical failure, use this structure:

```
[What happened - one sentence]

[Why it happened - 2-3 sentences, understandable terms]

[Options - numbered list of concrete next steps]

[Feedback collection - optional but encouraged]
```

---

## Related Documents

- [Failure States](../failure-states.md) - Comprehensive failure handling
- [Tone of Voice](../tone-of-voice.md) - How to communicate in failures
- [First Discovery Journey](../journeys/first-discovery.md) - Context for these moments

---

*Trust-Building Moments - December 26, 2025*
