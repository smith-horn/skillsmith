# Substack Article: The Hidden Token Tax of MCP Servers (And How to Architect Around It)

---

## Metadata

**Title:** The Hidden Token Tax of MCP Servers (And How to Architect Around It)

**Subtitle:** Research reveals 32x token efficiency difference between Skills and MCP approaches—and a hybrid pattern that captures the best of both

**Tags:** AI, Claude Code, MCP, Developer Tools, Architecture, Open Source

---

## Article

Every time you connect an MCP server in Claude Code, you're paying a tax you can't see.

I discovered this while investigating why my Claude Code sessions kept running out of context faster than expected. The culprit wasn't the tasks themselves—it was the architecture I'd chosen to execute them.

After researching Anthropic's documentation, analyzing GitHub issues, and testing real-world scenarios, I found a consistent pattern: MCP servers consume 10-100x more tokens than Skills with scripts for equivalent operations.

This article breaks down the root cause analysis, presents the data, and offers a decision framework for when to use each approach.

---

### The Root Cause: When Things Load Into Context

The fundamental difference between Skills and MCP isn't what they can do—it's when their definitions consume your context window.

**MCP: Upfront Loading**

When you connect an MCP server, Claude Code loads every tool definition into context immediately. Every tool name, every parameter schema, every description—regardless of whether you'll use them.

```
Startup Flow (MCP):
    All servers connected
    → All tool definitions loaded into context
    → 5,000-80,000+ tokens consumed before first query
```

Connect 5 servers exposing 60 tools? You've burned approximately 55,000 tokens before Claude does anything useful.

**Skills: Progressive Disclosure**

Skills use a three-stage loading architecture that minimizes context consumption:

```
Startup Flow (Skills):
    Names + descriptions indexed (~30-50 tokens per skill)
    → User request matches skill
    → Full SKILL.md loads (~500-2,000 tokens)
    → Script executes OUTSIDE context
    → Only output returns to context (~100 tokens)
```

From Anthropic's documentation:

> "Scripts in your Skill directory can be executed without loading their contents into context. Claude runs the script and only the output consumes tokens. This is useful for complex validation logic that would be verbose to describe in prose, and data processing that's more reliable as tested code than generated code."

The key insight: script code never touches the context window. You pay only for the result.

---

### The Data: 32x Token Difference

Here's a direct comparison on an identical task:

**Skills Approach (5 skills):**

| Stage | Token Cost |
|-------|------------|
| Startup | ~200 tokens (names + descriptions) |
| Single skill invocation | ~1,500 tokens |
| Script execution | ~100 tokens (output only) |
| **Total** | **~1,800 tokens** |

**MCP Approach (5 servers, ~60 tools):**

| Stage | Token Cost |
|-------|------------|
| Startup | ~55,000 tokens (all definitions) |
| Tool selection | ~500 tokens |
| Result handling | ~2,000 tokens |
| **Total** | **~57,500 tokens** |

The difference: **32x more tokens for MCP** on this configuration.

Simon Willison's analysis captured why this matters:

> "Context consumption is the critical bottleneck for complex Claude Code workflows. Skills that execute code outside of context are, for many use-cases, a bigger deal than MCP."

---

### Timeout and Reliability: A Deeper Problem

Token efficiency isn't the only concern. MCP servers introduce timeout fragility that Skills avoid entirely.

**MCP Timeout Issues (Documented)**

From GitHub issues on `anthropics/claude-code`:

> "Claude Code is not respecting MCP timeout settings configured in settings.json, causing HTTP MCP servers to appear 'offline' due to premature SSE stream disconnections."

> "MCP tool calls over 60s in duration fail due to -32001 timeout in the mcp typescript-sdk. Because there is no good way to predict valid timeouts for many classes of long duration tool calls (think sub-agents) it would be best to utilize the MCP progress reporting mechanism."

> "The SSE control channel should stay open indefinitely so the CLI can send tasks even after long idle periods... CLI logs error and the command fails. Work-around: Restarting claude --mcp-debug restores functionality."

**The Reliability Matrix**

| Factor | Skills + Scripts | MCP Servers |
|--------|------------------|-------------|
| Network dependency | Only for API calls in script | Always (server connection) |
| Timeout configuration | Standard HTTP (you control it) | Complex, often ignored |
| Connection state | Stateless | Stateful (SSE) |
| Idle handling | N/A | Disconnects after 5-10 min |
| Recovery mechanism | Retry script | Restart Claude session |
| Long-running tasks | Script manages internally | 60s hard limit (common) |
| Testability | Full (run script directly) | Limited (requires MCP client) |

Skills inherit whatever timeout handling you build into your scripts. MCP servers are subject to the TypeScript SDK's 60-second hard limit and SSE connection management issues.

---

### Consistency and Determinism

From Anthropic's engineering documentation:

> "And because code is deterministic, this workflow is consistent and repeatable."

**Skills produce deterministic results.** The same script with the same inputs produces the same output. You can test scripts outside Claude, version control them, and validate their behavior independently.

**MCP results depend on multiple variables:**

- Claude's interpretation of tool schemas
- Server implementation quality
- Network conditions
- Server-side state

From enterprise implementation analysis:

> "MCP servers change their APIs. When a server updates, your agent's behavior may change without warning. Skills with scripts isolate you from this—your script calls a versioned API endpoint you control."

---

### When MCP Still Wins

This isn't an argument against MCP. It's an argument for choosing the right tool for the context.

**MCP excels at:**

- **Real-time data access:** Live databases, streaming APIs, data that changes between calls
- **Dynamic discovery:** Exploring unfamiliar schemas before you know what patterns you need
- **Enterprise auth standardization:** OAuth flows, SSO integration (still evolving)
- **Ecosystem leverage:** 800+ community servers provide immediate capabilities

The New Stack's production guidance:

> "MCP works for anything that looks up information on a network you trust... Where it doesn't fit as well is anything that modifies or creates files."

---

### The Decision Framework

After analyzing the tradeoffs, this flowchart captures the decision logic:

```
Is this operation repeatable?
        /            \
      YES             NO
      /                \
Skills preferred    Reliability Critical?
                     /            \
                   YES             NO
                   /                \
           Skills preferred   Need Real-time Data?
                                /            \
                              YES             NO
                              /                \
                       MCP required      Skills preferred
```

**Quick heuristics:**

- If the operation will execute more than twice → Skill
- If you need live, changing data → MCP
- If timeout reliability matters → Skill
- If you're exploring unfamiliar territory → MCP first, then codify

---

### The Hybrid Pattern: Best of Both Worlds

The most efficient architecture combines both approaches strategically.

**Pattern: MCP for Discovery, Skills for Execution**

From CData's research:

> "Once the LLM explored the dataset and constructed the appropriate request, we added that request to a Claude Skill that sends that request directly through Connect AI's REST API. This led to a significant reduction in token usage, but this was only possible after the LLM explored the data using Connect AI's MCP server."

**Workflow:**

1. Connect MCP server for initial exploration
2. Claude discovers data schema, available operations
3. Identify repeatable patterns
4. Codify into Skill with direct API scripts
5. Disconnect MCP server
6. Use Skill for ongoing operations

One team reported **99% token reduction** using this pattern (from Speakeasy's engineering analysis).

**Pattern: Skills That Optimize MCP Access**

When you must use MCP, wrap it in a Skill that provides context:

```yaml
---
name: salesforce-query-patterns
description: Patterns for Salesforce data access. Use before querying CRM.
skills: salesforce-mcp
---

# Salesforce Query Patterns

## Before querying:
1. Identify object type (Account, Contact, Opportunity)
2. Determine required fields (minimize selection)
3. Apply filters to limit results

## Efficient patterns:
- Use SOQL WHERE clauses
- Limit to 100 records unless pagination needed
- Select only fields you'll use
```

This "Skill-gated MCP" approach reduces unnecessary tool calls by giving Claude context about efficient usage patterns.

---

### The Architectural Principle

The clearest framing I've found:

> "Skills tell Claude how to use tools; MCP provides the tools."

Separate these concerns:

- **MCP:** Dynamic capability discovery, real-time data access
- **Skills:** Deterministic execution, token-efficient workflows
- **Scripts:** Reliable, testable operations outside context

When the same operation will be performed repeatedly, codifying it as a Skill with a script will almost always outperform keeping an MCP server connected.

---

### Implementation Resources

I've published the full research document with:

- Complete token budget comparisons
- Timeout configuration reference
- Decision checklists
- Source citations in MLA format

**GitHub Repository:**

**[PLACEHOLDER: YOUR_GITHUB_REPOSITORY_URL]**

The repository includes:

- The complete research document (skills-vs-mcp-research.md)
- Decision framework prompt for creating new integrations
- MCP Builder Skill that auto-evaluates whether to use Skills or MCP
- Templates for both approaches

---

### What's Next

This research opens several follow-up questions:

**Skill composition patterns.** Can Skills invoke other Skills? What are the token implications of nested skill calls?

**Parallel orchestration.** When you need multiple specialists working simultaneously, how do you coordinate them efficiently while managing context?

**Observability.** How do you measure token efficiency across complex multi-agent workflows?

If you're experimenting with Claude Code architecture, I'd like to hear what patterns you've discovered. Drop a comment or reach out directly.

---

*Building AI workflows that don't waste tokens. Subscribe for more research on practical AI architecture.*

---

## Sources

Anthropic. "Agent Skills - Claude Code Docs." *Claude Code Documentation*, 2025. https://code.claude.com/docs/en/skills

Anthropic. "Agent Skills Overview." *Claude Developer Platform*, 2025. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

Anthropic. "Code Execution with MCP: Building More Efficient AI Agents." *Anthropic Engineering Blog*, 2025. https://www.anthropic.com/engineering/code-execution-with-mcp

Anthropic. "Connect Claude Code to Tools via MCP." *Claude Docs*, 2025. https://docs.claude.com/en/docs/claude-code/mcp

Anthropic. "MCP vs Claude's Built-in Tools." *Claude Docs*, 2025. https://docs.claude.com/en/docs/claude-code/mcp#mcp-vs-claudes-built-in-tools

CData. "Integrating Claude 3.7 Sonnet into a Streamlined Workflow for Enterprise Data." *CData Blog*, 2025. https://www.cdata.com/blog/integrating-claude-37-sonnet

GitHub. "Claude Code Issue #442: MCP Timeout Configuration." *anthropics/claude-code*, 2025. https://github.com/anthropics/claude-code/issues/442

GitHub. "MCP Issue #1066: Tool Call Timeout." *modelcontextprotocol/typescript-sdk*, 2025. https://github.com/modelcontextprotocol/typescript-sdk/issues/1066

Speakeasy. "Reducing MCP Token Usage by 100x — You Don't Need Code Mode." *Speakeasy Blog*, 18 Nov. 2025. https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2

Spence, Scott. "Optimising MCP Server Context Usage in Claude Code." *Scott Spence*, 30 Sept. 2025. https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code

The New Stack. "15 Best Practices for Building MCP Servers in Production." *The New Stack*, 15 Sept. 2025. https://thenewstack.io/15-best-practices-for-building-mcp-servers-in-production/

ThinhDA. "Building Production-Ready MCP Servers: Taking FastMCP to Enterprise Level." *ThinhDA*, 30 Apr. 2025. https://thinhdanggroup.github.io/mcp-production-ready/

Willison, Simon. "Claude Skills Are Awesome, Maybe a Bigger Deal than MCP." *simonwillison.net*, 16 Oct. 2025. https://simonwillison.net/2025/Oct/16/claude-skills/

Xenoss. "MCP in Enterprise: Real-World Applications and Challenges." *Xenoss Blog*, 15 Sept. 2025. https://xenoss.io/blog/mcp-model-context-protocol-enterprise-use-cases-implementation-challenges

---

## Publishing Checklist

- [ ] Add GitHub repository URL to placeholder
- [ ] Create header image (suggested: token comparison visualization or architecture diagram)
- [ ] Cross-link to LinkedIn and Reddit posts
- [ ] Add subscriber CTA for full research doc access
- [ ] Schedule for weekday morning publication (Tuesday-Thursday typically best)
- [ ] Prepare Twitter/X thread teaser linking to full article
