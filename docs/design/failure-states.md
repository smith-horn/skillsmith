# Failure State Design

> **Navigation**: [Design Index](./index.md) | Failure States

Comprehensive failure handling design for Claude Discovery Hub. Every error is an opportunity to build trust through graceful recovery.

---

## Design Philosophy

**Failure Is a Feature:** Errors handled gracefully build more trust than errors avoided. The system's response to failure defines its character.

### Core Principles
- Every error explains what happened
- Every error offers a path forward
- Every error collects feedback for improvement
- Silent failures are treated as bugs

---

## Failure: Search Returns Nothing Useful

### Detection Mechanism
- 0 results returned
- Results have low relevance scores (< 30%)
- User immediately searches again with different terms

### User Message

```
I couldn't find skills exactly matching "kubernetes deployment optimization."

Here's what I tried:
- Searched 46,847 skills
- Checked related terms: kubernetes, k8s, deployment, cloud
- Found 3 partial matches

Partial matches:
1. devops-automation - Includes Kubernetes basics (72% match)
2. cloud-infrastructure - AWS/GCP deployments (58% match)

Suggestions:
- Try broader terms: "kubernetes" or "deployment"
- Browse the DevOps category: /discover browse devops
- This skill doesn't exist yet. Want to request it? /discover request

Was this search helpful? [Yes] [No, I needed something else]
```

### Recovery Options
1. View partial matches with context
2. Browse related category
3. Request new skill
4. Refine search with suggestions

### Prevention for Next Time
- Log search terms for search improvement
- Add synonyms based on failed searches
- Surface "most searched but not found" to skill creators

---

## Failure: Recommendation Doesn't Match Needs

### Detection Mechanism
- User dismisses recommendation
- User selects "not relevant" option
- User installs then immediately uninstalls

### User Message

```
I'll remember that frontend-design isn't what you needed.

To improve future recommendations, can you tell me more?

[Wrong tech stack] [Wrong use case] [Already have something similar] [Other]

In the meantime, here are 3 alternative skills for React projects:

1. component-testing - Focus on testing, not design
2. performance-optimization - Speed rather than UI
3. accessibility-patterns - Accessibility focus

[Browse React skills] [Search for something specific]
```

### Recovery Options
1. Quick feedback for algorithm improvement
2. Alternative recommendations
3. Browse or search escape routes

### Prevention for Next Time
- Adjust recommendation weights based on feedback
- Add negative preferences to user profile
- Improve matching for similar future queries

---

## Failure: Skill Doesn't Activate After Install

### Detection Mechanism
- Skill installed but not invoked within expected window
- User query matches skill but skill not activated
- User explicitly reports non-activation

### User Message

```
I noticed you might have expected the frontend-design skill to help
with this task, but it didn't activate.

Here's why that might have happened:
- Skill activation depends on task description matching
- Your request was about "fixing CSS layout"
- The skill activates for "creating new interfaces"

Options:
1. Rephrase your request: "Help me design a new layout for..."
2. Force activation: /skill use frontend-design
3. This seems like a bug. Report it? /discover report

Technical details (for curious minds):
- Skill description: "Create distinctive, production-grade interfaces"
- Your context: Bug fix, not creation
- Match confidence: 34% (threshold: 50%)
```

### Recovery Options
1. Guidance on rephrasing for activation
2. Manual force activation
3. Bug report for unexpected behavior

### Prevention for Next Time
- Educate on activation mechanics
- Consider lowering threshold for installed skills
- Improve skill description matching

---

## Failure: Installation Fails

### Detection Mechanism
- Install command returns error
- Post-install verification fails
- Skill file exists but is malformed

### User Message

```
Installation Verification

I ran the install command, but I want to verify it worked.

Checking...

[!] Warning: frontend-design may not be properly installed.

What I found:
- Marketplace was added successfully
- Skill download completed
- Skill file exists but may be malformed

Diagnostic:
- Expected file: ~/.claude/skills/frontend-design/SKILL.md
- Actual state: File exists, but missing required 'description' field

Auto-repair options:
1. [Fix automatically] - I'll repair the SKILL.md structure
2. [Reinstall] - Fresh install from source
3. [Skip for now] - Continue, but skill may not activate

Need help? /discover diagnose frontend-design
```

### Recovery Options
1. Automatic repair
2. Clean reinstall
3. Skip with warning
4. Detailed diagnosis

### Prevention for Next Time
- Pre-install validation
- Atomic install with rollback
- Author notification of malformed skills

---

## Failure: Skill Causes Unexpected Behavior

### Detection Mechanism
- User reports issue after skill activation
- Claude output quality degradation detected
- User immediately disables skill

### User Message

```
Something Unexpected Happened

I noticed the output from systematic-debugging might not be what
you expected. A few things that could have gone wrong:

Possibilities:
1. Skill version mismatch (you have v1.2, latest is v1.5)
2. Skill conflicts with another installed skill
3. Skill not designed for this use case

Immediate actions:
- [Undo last action] - Revert the changes Claude just made
- [Disable skill] - Temporarily turn off systematic-debugging
- [Report issue] - Let the author know (opens GitHub issue)

Prevention for next time:
- This skill was last tested with Claude Code v2.0.10
- You're running v2.0.12 - may have compatibility issues
- Consider: /discover check-compatibility before updates

Your trust matters: /discover feedback (30 second survey)
```

### Recovery Options
1. Immediate undo
2. Skill disable
3. Report to author
4. Compatibility check tool

### Prevention for Next Time
- Compatibility warnings before install
- Conflict detection with existing skills
- Version requirements enforcement

---

## Failure: User Regrets Installation

### Detection Mechanism
- User searches for uninstall
- User disables skill shortly after install
- User provides negative feedback

### User Message

```
Removing frontend-design

Done. The skill has been completely removed.

What we cleaned up:
- Skill files removed from ~/.claude/skills/
- Skill reference removed from CLAUDE.md
- No residual configuration left

If you'd like to share why it didn't work out:
[Didn't do what I expected] [Caused problems] [Found something better] [Just trying things]

Want to find something else for UI design?
[Browse alternatives] [Search] [I'm all set]
```

### Recovery Options
1. Clean uninstall confirmation
2. Optional feedback
3. Alternative suggestions
4. Clean exit

### Prevention for Next Time
- Better expectation setting pre-install
- Trial mode before full install
- Clearer skill capability descriptions

---

## Failure: Service Unavailable

### Detection Mechanism
- API call times out
- Server returns error
- Network connectivity issues

### User Message

```
I couldn't reach the skill index. This might be temporary.

Options:
- /discover retry - Try again
- /discover offline - Use cached index (3 days old)
- /discover status - Check service health

Technical details:
- Last successful sync: 3 days ago
- Cache contains: 45,892 skills
- Missing since then: approximately 156 new skills

The cached index is usually good enough for most searches.
New skill discoveries may be delayed until connection restores.
```

### Recovery Options
1. Retry immediately
2. Use cached data
3. Check service status
4. Continue with limitation

---

## Quick Reference: Failure Recovery

| Failure | First Response | Recovery Options |
|---------|----------------|------------------|
| No search results | Show effort, partial matches | Broaden terms, browse category, request skill |
| Bad recommendation | Acknowledge, ask for feedback | Alternatives, feedback form, refine preferences |
| Activation failure | Explain mechanism, show threshold | Rephrase, force activate, report bug |
| Install failure | Diagnose, show specific issue | Auto-repair, reinstall, skip |
| Unexpected behavior | Acknowledge, list possibilities | Undo, disable, report |
| User regret | Clean uninstall confirmation | Feedback, alternatives, clean exit |
| Service unavailable | Explain, offer cached option | Retry, offline mode, status check |

---

## Failure Message Template

For any failure, use this structure:

```
[What happened - clear, one sentence]

[Why it happened - 2-3 sentences, understandable terms]

[Options - numbered list of concrete next steps]

[Optional: Technical details for curious users]

[Feedback collection - "Was this helpful?"]
```

---

## Related Documents

- [Trust-Building Moments](./moments/trust-building.md) - Failure as trust opportunity
- [Tone of Voice](./tone-of-voice.md) - How to communicate failures
- [Accessibility](./accessibility.md) - Accessible error presentation

---

*Failure State Design - December 26, 2025*
