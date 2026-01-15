# Reddit Posts: Skill Builder Introduction

---

## Post for r/anthropic

**Title:** I built a skill-builder that auto-generates isolated subagents—cuts token usage by 40-90%

**Body:**

Been digging into Claude Code's architecture and found something most people miss: skills run in your main context by default. Every intermediate output, every working step—it all piles up in the same 200K token window.

The docs confirm subagents have isolated context, but skills don't automatically run there. You have to explicitly configure it.

So I built a skill-builder that handles this automatically. When you create a skill, it generates:

1. The SKILL.md file
2. A companion subagent (`.claude/agents/[skill]-specialist.md`) with the `skills:` field configured
3. CLAUDE.md snippets for delegation triggers

The subagent runs the skill in isolation and returns only a structured summary to the orchestrator. Verbose outputs stay contained.

**Measured results from the research:**
- 37% reduction on typical tasks
- 97% reduction on multi-step research (10 parallel workers went from 50K tokens to 1.5K)

**Technical details:**
- Subagents need explicit `skills:` field—they don't inherit from parent
- Built-in agents (Explore, Plan, general-purpose) can't access custom skills
- Only custom agents in `.claude/agents/` with the field set will load skills

Happy to share the skill-builder if there's interest. Also open to feedback on the approach—curious if others have found different patterns that work.

---

## Post for r/ClaudeAI

**Title:** PSA: Your Claude Code skills are probably wasting tokens. Here's the fix.

**Body:**

Quick finding that might save you money and improve output quality:

**The problem:** When Claude Code invokes a skill, it runs in your main conversation context. All the intermediate outputs accumulate there. On complex tasks, this eats 5-50K tokens of working memory that you'll never reference again.

**Why it matters:** Context pollution degrades model performance. You're paying for tokens that actively make your results worse.

**The fix:** Run skills in dedicated subagents. Each subagent gets its own context window. When it finishes, only the summary comes back to your main conversation.

**The catch:** This doesn't happen automatically. You need to:
1. Create a custom subagent in `.claude/agents/`
2. Add a `skills:` field listing which skills it should load
3. Configure your CLAUDE.md to delegate appropriately

I got tired of doing this manually, so I built a skill-builder that generates the skill + companion subagent + integration snippets together.

**Results I've seen:**
- Simple tasks: 37% token reduction
- Multi-step workflows: 90%+ reduction
- Longer productive sessions before hitting context limits

If you're hitting context limits or noticing degraded output quality on longer sessions, this pattern is worth trying.

Drop a comment if you want the skill-builder or have questions about the setup.

---

## Posting Notes

| Subreddit | Tone | Expected Engagement |
|-----------|------|---------------------|
| r/anthropic | Technical, detailed | Developers, power users |
| r/ClaudeAI | Practical, accessible | Mixed technical/non-technical |

**Best times to post:** Weekdays 9-11am EST typically get better engagement on technical subreddits.

**Flair suggestions:**
- r/anthropic: "Discussion" or "Claude Code"
- r/ClaudeAI: "Tip" or "Claude Code"
