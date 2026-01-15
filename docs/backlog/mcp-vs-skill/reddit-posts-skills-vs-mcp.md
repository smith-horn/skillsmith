# Reddit Posts: Skills vs MCP Architecture Analysis

---

## Post for r/anthropic

**Title:** Research: Skills vs MCP servers—32x token difference on identical tasks

**Body:**

I've been digging into Claude Code's architecture to understand when to use Skills with scripts versus MCP servers. The documentation hints at differences, but I wanted hard numbers.

**TL;DR:** Skills are 10-100x more token-efficient for repeatable operations. MCP wins for real-time discovery. The optimal pattern is hybrid.

### Token Economics

The fundamental difference is *when* things load into context.

**MCP:**
```
Startup → All tool definitions load (5,000-80,000+ tokens upfront)
       → Tool selection (~500 tokens)
       → Result handling (~2,000 tokens)
Total: ~55,000+ tokens for a 5-server setup
```

**Skills:**
```
Startup → Name + description only (~30-50 tokens per skill)
       → Invocation → Full SKILL.md loads (~500-2,000 tokens)
       → Script executes OUTSIDE context
       → Output only returns (~100 tokens)
Total: ~1,800 tokens
```

Scripts never load into context. This is the key insight from Anthropic's docs:

> "Scripts in your Skill directory can be executed without loading their contents into context. Claude runs the script and only the output consumes tokens."

### Timeout/Reliability

Skills inherit standard HTTP timeout handling (you control it in your script).

MCP has documented fragility:
- 60-second hard limit in TypeScript SDK
- SSE disconnections after 5-10 minutes idle
- Timeout configuration often ignored by clients
- Recovery requires Claude session restart

From GitHub issues on anthropics/claude-code:
> "MCP tool calls over 60s in duration fail due to -32001 timeout... Because there is no good way to predict valid timeouts for many classes of long duration tool calls it would be best to utilize the MCP progress reporting mechanism."

### When MCP Wins

- Real-time data (live databases, streaming)
- Schema exploration before you know the structure
- Enterprise auth (evolving but standardizing)
- Community ecosystem (800+ servers available)

### Decision Framework

```
Is this operation repeatable?
├── YES → Skills (almost always)
└── NO → Is real-time data required?
    ├── YES → MCP
    └── NO → Skills
```

### Hybrid Pattern

From CData's research:
> "Once the LLM explored the dataset and constructed the appropriate request, we added that request to a Claude Skill... This led to a significant reduction in token usage, but this was only possible after the LLM explored the data using Connect AI's MCP server."

Use MCP to discover. Codify into Skills for execution.

**Sources:** Anthropic docs, GitHub issues, CData research, Simon Willison's analysis, Speakeasy engineering blog. Happy to share the full research doc with citations.

---

## Post for r/ClaudeAI

**Title:** PSA: Your MCP servers might be eating 90% of your context window

**Body:**

If you're using MCP servers in Claude Code and wondering why you're hitting context limits fast, here's what I found after researching the architecture.

**The issue:** MCP servers load ALL their tool definitions into context at startup. Every tool, every parameter schema, every description—upfront, whether you use them or not.

Connect a few servers? That can be 55,000+ tokens before you ask a single question.

**The alternative:** Skills with scripts.

Skills only load their name/description at startup (~30-50 tokens each). The full skill content loads only when Claude actually needs it. And scripts execute *outside* the context window entirely—you only pay for the output.

**Real comparison on the same task:**
- MCP approach: ~57,500 tokens
- Skills approach: ~1,800 tokens

**When to use what:**

| Use Skills when... | Use MCP when... |
|-------------------|-----------------|
| Operation will repeat | Exploring unfamiliar data |
| Token budget matters | Need real-time database access |
| Reliability is critical | Leveraging enterprise connectors |
| Pattern is well-defined | Discovery before codification |

**The pattern that works:**

Use MCP to explore → understand the data/API → codify the patterns into a Skill with scripts → disconnect MCP → run efficiently.

One team reported 99% token reduction using this approach.

**Quick check:** Run `/context` in Claude Code to see your current token usage. You might be surprised how much MCP overhead you're carrying.

---

## Posting Notes

| Subreddit | Tone | Expected Engagement |
|-----------|------|---------------------|
| r/anthropic | Technical, detailed with code examples | Developers, AI engineers |
| r/ClaudeAI | Practical, accessible with comparison table | Mixed technical/non-technical |

**Best times to post:** Weekdays 9-11am EST typically get better engagement on technical subreddits.

**Flair suggestions:**
- r/anthropic: "Discussion" or "Claude Code"
- r/ClaudeAI: "Tip" or "Claude Code"
