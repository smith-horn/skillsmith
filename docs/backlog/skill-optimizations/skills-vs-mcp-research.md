# Skills with Scripts vs. MCP Servers: A Comparative Analysis

## Research Summary

**Date:** January 10, 2026  
**Author:** Ryan (Smith Horn Group Ltd)  
**Topic:** Evaluating skill-based script execution versus MCP servers for Claude task execution

---

## Executive Summary

This research evaluates two architectural approaches for extending Claude's capabilities to interact with external systems: **Skills with embedded scripts** (CLI/API calls) versus **MCP (Model Context Protocol) servers**. Both approaches can achieve similar functional outcomes, but they differ significantly in token efficiency, reliability, timeout behavior, and architectural implications.

**Key Finding:** Skills with scripts provide superior token efficiency (up to 99% reduction), deterministic execution, and simpler operational overhead. MCP servers excel at dynamic discovery, real-time data access, and standardized enterprise integrations—but introduce significant token overhead (5,000-80,000+ tokens), timeout vulnerabilities, and operational complexity.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Token Efficiency Analysis](#token-efficiency-analysis)
3. [Timeout and Reliability](#timeout-and-reliability)
4. [Consistency and Determinism](#consistency-and-determinism)
5. [Architectural Implications](#architectural-implications)
6. [Decision Framework](#decision-framework)
7. [Hybrid Patterns](#hybrid-patterns)
8. [Conclusions](#conclusions)
9. [Sources](#sources)

---

## Architecture Overview

### Skills with Scripts

Skills are filesystem-based capability packages containing:
- **SKILL.md**: Instructions and metadata (30-50 tokens at startup, full content on invocation)
- **Scripts**: Executable Python, Bash, or JavaScript files that run outside context
- **References**: Documentation files loaded on-demand

**Execution Flow:**
```
User Request 
    → Claude matches skill description 
    → SKILL.md loaded into context 
    → Claude executes script via bash 
    → Script output (only) returns to context
    → Claude continues with result
```

Key characteristic: Scripts execute **outside the context window**. Only the output consumes tokens.

### MCP Servers

MCP provides a standardized protocol for Claude to interact with external services through well-defined tool interfaces.

**Execution Flow:**
```
Startup 
    → All tool definitions loaded into context (upfront cost)
    → User Request 
    → Claude selects tool 
    → JSON-RPC call to MCP server 
    → Server executes operation 
    → Full result returns to context
    → Claude continues with result
```

Key characteristic: Tool definitions are loaded **upfront into context**. Results pass through the context window.

---

## Token Efficiency Analysis

### Skills: Progressive Disclosure Architecture

Skills use a three-tier loading strategy that minimizes context consumption:

| Stage | What Loads | Token Cost |
|-------|------------|------------|
| **Startup** | Name + description only | ~30-50 tokens per skill |
| **Invocation** | Full SKILL.md content | ~500-2,000 tokens |
| **Script Execution** | Output only (code never loads) | Variable (typically minimal) |

From Anthropic's documentation:

> "Scripts in your Skill directory can be executed without loading their contents into context. Claude runs the script and only the output consumes tokens. This is useful for complex validation logic that would be verbose to describe in prose, and data processing that's more reliable as tested code than generated code."

**Token Efficiency Characteristics:**
- Scripts provide **deterministic operations without consuming context**
- Reference files don't consume tokens until actually read
- No practical limit on bundled content that isn't actively used

### MCP: Upfront Loading Architecture

MCP servers load all tool definitions at conversation start:

| Component | Token Cost | Notes |
|-----------|------------|-------|
| **Simple tool** | 50-100 tokens | Basic operations |
| **Complex tool** | 500-1,000 tokens | Enterprise tools with detailed schemas |
| **Typical server** | 5,000-15,000 tokens | 10-20 tools |
| **GitHub MCP** | ~30,000 tokens | Comprehensive API coverage |
| **Multiple servers** | 50,000-134,000+ tokens | Common enterprise setups |

From practitioner measurements:

> "My mcp-omnisearch server alone was consuming 14,214 tokens with its 20 different tools. Each tool had verbose descriptions, multiple parameters, and examples. Multiply that by all my active MCP servers, and you get proper context bloat."

**Real-world example (Scott Spence):**
- All MCP tools enabled: 82,000 tokens (41% of 200K window)
- Single MCP server enabled: 5,700 tokens (2.8% of window)
- Difference: **76,300 tokens** freed by selective loading

### Comparative Token Analysis

| Scenario | Skills Approach | MCP Approach | Difference |
|----------|-----------------|--------------|------------|
| **Startup overhead** | ~200 tokens (5 skills) | ~55,000 tokens (5 servers, 58 tools) | **275x more** for MCP |
| **Single task execution** | ~500-2,000 tokens | ~5,000-15,000 tokens | **3-30x more** for MCP |
| **Result handling** | Script output only | Full API response | Variable |
| **Unused capabilities** | Zero cost | Full cost upfront | Skills win |

From CData's controlled testing (same queries, both methods):

> "Once the LLM explored the dataset and constructed the appropriate request, we added that request to a Claude Skill that sends that request directly through Connect AI's REST API. This led to a significant reduction in token usage."

---

## Timeout and Reliability

### Skills: Local Execution Model

Skills execute scripts through Claude's bash tool in a controlled local environment.

**Timeout Characteristics:**
- Scripts run in Claude's execution environment
- No network dependency for script execution itself
- API calls within scripts use standard HTTP timeouts (configurable)
- No SSE connection management required

**Reliability Factors:**
- **Deterministic**: Same script produces same result
- **No connection state**: Each invocation is independent
- **Testable**: Scripts can be validated outside Claude
- **Recoverable**: Failed scripts return error output, Claude can retry

### MCP: Network-Dependent Model

MCP servers maintain stateful connections, typically via Server-Sent Events (SSE).

**Documented Timeout Issues:**

From GitHub issues on anthropics/claude-code:

> "Claude Code is not respecting MCP timeout settings configured in settings.json, causing HTTP MCP servers to appear 'offline' due to premature SSE stream disconnections using default timeout values instead of configured ones."

> "MCP tool calls over 60s in duration fail due to -32001 timeout in the mcp typescript-sdk. Because there is no good way to predict valid timeouts for many classes of long duration tool calls (think sub-agents) it would be best to utilize the MCP progress reporting mechanism."

> "The SSE control channel should stay open indefinitely so the CLI can send tasks even after long idle periods... CLI logs error and the command fails. Work-around: Restarting claude --mcp-debug restores functionality."

**Common Timeout Patterns:**
- Default timeout: 60 seconds (hard limit in TypeScript SDK)
- SSE disconnection: ~5-10 minutes of idle time
- Connection recovery: Requires full restart
- Progress updates: Don't reset timeout in all clients

**Reliability Factors:**
- **Network-dependent**: Subject to latency, disconnections
- **Stateful connections**: SSE requires keepalive management
- **Configuration complexity**: Timeout settings often ignored
- **Recovery overhead**: Reconnection requires restart

### Comparative Reliability Matrix

| Factor | Skills + Scripts | MCP Servers |
|--------|------------------|-------------|
| **Network dependency** | Only for API calls in script | Always (server connection) |
| **Timeout configuration** | Standard HTTP (in script) | Complex, often broken |
| **Connection state** | Stateless | Stateful (SSE) |
| **Idle handling** | N/A | Disconnects after 5-10 min |
| **Recovery mechanism** | Retry script | Restart Claude session |
| **Long-running tasks** | Script manages internally | 60s hard limit (common) |
| **Testability** | Full (run script directly) | Limited (requires MCP client) |

---

## Consistency and Determinism

### Skills: Deterministic by Design

From Anthropic's engineering documentation:

> "And because code is deterministic, this workflow is consistent and repeatable. Skills can also include code for Claude to execute as tools at its discretion based on the nature of the task."

> "Prefer scripts for deterministic operations: Write validate_form.py rather than asking Claude to generate validation code."

**Consistency Characteristics:**
- Same input → Same output (deterministic)
- Version-controlled scripts
- Testable outside Claude
- No LLM interpretation of tool schemas

**When Scripts Excel:**
- Data transformations
- API calls with specific formats
- Validation logic
- File processing
- Calculations

### MCP: Dynamic but Variable

MCP tool calls depend on:
- Claude's interpretation of tool schemas
- Server implementation quality
- Network conditions
- Schema version consistency

**Consistency Challenges:**

From practitioner experience (Armin Ronacher):

> "MCP servers have no desire to maintain API stability. They are increasingly starting to trim down tool definitions to the bare minimum to preserve tokens... For instance, the Sentry MCP server at one point switched the query syntax entirely to natural language. A great improvement for the agent, but my suggestions for how to use it became a hindrance and I did not discover the issue straight away."

**When MCP Excels:**
- Dynamic data discovery
- Real-time system state
- Multi-system orchestration
- Enterprise integrations with OAuth

### Consistency Comparison

| Factor | Skills + Scripts | MCP Servers |
|--------|------------------|-------------|
| **Execution determinism** | High (code-based) | Variable (LLM interpretation) |
| **Schema stability** | You control it | Server maintainer controls |
| **Version management** | Git-versioned | External dependency |
| **Testing** | Unit testable | Integration testing required |
| **Failure modes** | Predictable (exit codes) | Variable (server-dependent) |

---

## Architectural Implications

### Skills Architecture

**Advantages:**
1. **Simplicity**: Markdown + scripts, no infrastructure
2. **Portability**: Works across Claude products (Claude.ai, API, Claude Code)
3. **Low maintenance**: No servers to operate
4. **Security**: Runs in Claude's sandboxed environment
5. **Cost**: No hosting costs for skill execution

**Limitations:**
1. **No real-time data**: Scripts execute on-demand, not streaming
2. **No dynamic discovery**: Must know capabilities upfront
3. **Local scope**: Scripts run in Claude's environment
4. **Auth complexity**: Must handle tokens in scripts

**Best For:**
- Repeatable workflows
- Document processing
- Data transformations
- Personal/team automation
- Deterministic operations

### MCP Architecture

**Advantages:**
1. **Standardization**: Universal protocol across AI systems
2. **Dynamic discovery**: Claude can explore available tools
3. **Enterprise integrations**: OAuth, SSO, audit trails
4. **Real-time access**: Live data from external systems
5. **Ecosystem**: Thousands of pre-built servers

**Limitations:**
1. **Token overhead**: 5,000-80,000+ tokens before starting
2. **Operational complexity**: Servers to deploy, maintain, monitor
3. **Timeout fragility**: SSE connections drop, hard limits
4. **Security concerns**: Supply chain risk from community servers
5. **Enterprise gaps**: Auth, multi-tenancy, governance immature

From enterprise analysis:

> "Auth isn't built-in: Current authentication and authorization approaches for MCP lack enterprise-grade features like OAuth compliance, SSO integration, and granular permission management. Gaps in production: Performance overhead, multi-tenancy complications, and data governance gaps can quickly snowball if left unchecked."

**Best For:**
- Live enterprise data access
- Multi-system orchestration
- Dynamic tool discovery
- Standardized integrations
- When ecosystem servers exist

---

## Decision Framework

### Use Skills with Scripts When:

| Criterion | Indicators |
|-----------|------------|
| **Task type** | Repeatable, well-defined workflows |
| **Data freshness** | Point-in-time acceptable |
| **Token budget** | Constrained or cost-sensitive |
| **Reliability needs** | High (deterministic execution required) |
| **Maintenance capacity** | Limited ops resources |
| **Integration scope** | Single API or service |
| **Control requirements** | Full control over execution logic |

**Example Use Cases:**
- PDF form filling and extraction
- Excel/spreadsheet manipulation
- Code review with custom standards
- Data transformation pipelines
- API calls with specific formats
- Report generation

### Use MCP Servers When:

| Criterion | Indicators |
|-----------|------------|
| **Task type** | Dynamic discovery, exploration |
| **Data freshness** | Real-time required |
| **Token budget** | Flexible (large context available) |
| **Reliability needs** | Moderate (can handle retries) |
| **Maintenance capacity** | DevOps resources available |
| **Integration scope** | Multiple enterprise systems |
| **Control requirements** | Standardized, auditable access |

**Example Use Cases:**
- CRM data queries (Salesforce, HubSpot)
- Code repository operations (GitHub)
- Project management (Jira, Linear)
- Communication platforms (Slack)
- Database exploration

### Decision Matrix

```
                        Token Sensitive?
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

---

## Hybrid Patterns

### Pattern 1: MCP for Discovery, Skills for Execution

Use MCP to explore and understand a data source, then codify the learned patterns into a skill.

From CData's research:

> "Once the LLM explored the dataset and constructed the appropriate request, we added that request to a Claude Skill that sends that request directly through Connect AI's REST API. This led to a significant reduction in token usage, but this was only possible after the LLM explored the data using Connect AI's MCP server."

**Workflow:**
1. Connect MCP server for initial exploration
2. Claude discovers data schema, available operations
3. Identify repeatable patterns
4. Codify into skill with direct API scripts
5. Disconnect MCP server
6. Use skill for ongoing operations

**Benefits:**
- Best-of-both-worlds token efficiency
- Maintains discoverability for new use cases
- Deterministic execution for known patterns

### Pattern 2: Skills That Call MCP

Create skills that know how to interact with MCP servers efficiently.

```yaml
---
name: mcp-cli-wrapper
description: Interface for MCP servers via CLI. Use for external tool access.
---

# MCP-CLI Access

Use mcp-cli for efficient MCP interaction:

## Commands
| Command | Output |
|---------|--------|
| `mcp-cli` | List servers and tools |
| `mcp-cli <server>` | Show tools with parameters |
| `mcp-cli <server>/<tool> '<json>'` | Execute tool |

## Workflow
1. Discover: `mcp-cli` → see available servers
2. Inspect: `mcp-cli <server>` → see tools  
3. Execute: `mcp-cli <server>/<tool> '<json>'`
```

From mcp-cli documentation:

> "mcp-cli is a lightweight CLI that allows dynamic discovery of MCP, reducing token consumption while making tool interactions more efficient for AI coding agents... That is a 99% reduction in MCP-related token usage for this scenario."

### Pattern 3: Skill-Gated MCP Access

Use skills to provide context and guidance before MCP calls.

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

Then use Salesforce MCP with optimized queries.
```

---

## Conclusions

### Summary of Findings

| Dimension | Skills + Scripts | MCP Servers | Winner |
|-----------|------------------|-------------|--------|
| **Token efficiency** | ~30-2,000 tokens | ~5,000-80,000+ tokens | **Skills** |
| **Startup overhead** | Minimal | Substantial | **Skills** |
| **Timeout reliability** | Robust | Fragile | **Skills** |
| **Determinism** | High | Variable | **Skills** |
| **Real-time data** | Limited | Excellent | **MCP** |
| **Dynamic discovery** | None | Excellent | **MCP** |
| **Enterprise auth** | Manual | Standardized (evolving) | **MCP** |
| **Operational complexity** | Low | High | **Skills** |
| **Ecosystem** | Growing | Extensive | **MCP** |

### Recommendations

**For most repeatable workflows:** Start with Skills + Scripts
- Lower token cost (10-100x savings)
- More reliable execution
- Simpler maintenance
- Deterministic results

**For enterprise data access:** Use MCP with caution
- Budget for token overhead
- Implement timeout handling
- Plan for connection recovery
- Audit third-party servers

**For optimal efficiency:** Hybrid approach
- Use MCP for discovery and exploration
- Codify learned patterns into skills
- Minimize active MCP connections
- Monitor token consumption with `/context`

### Architectural Principle

> "Skills tell Claude how to use tools; MCP provides the tools."

The most efficient architecture separates these concerns:
- **MCP**: Dynamic capability discovery, real-time data access
- **Skills**: Deterministic execution, token-efficient workflows
- **Scripts**: Reliable, testable operations outside context

When the same operation will be performed repeatedly, codifying it as a skill with a script will almost always outperform keeping an MCP server connected.

---

## Sources

Anthropic. "Agent Skills - Claude Code Docs." *Claude Code Documentation*, 2025. https://code.claude.com/docs/en/skills

Anthropic. "Agent Skills Overview." *Claude Developer Platform*, 2025. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

Anthropic. "Code Execution with MCP: Building More Efficient AI Agents." *Anthropic Engineering Blog*, 2025. https://www.anthropic.com/engineering/code-execution-with-mcp

Anthropic. "Connect Claude Code to Tools via MCP." *Claude Docs*, 2025. https://docs.claude.com/en/docs/claude-code/mcp

Anthropic. "Equipping Agents for the Real World with Agent Skills." *Anthropic Engineering Blog*, Oct. 2025. https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

Anthropic. "Skills Explained: How Skills Compares to Prompts, Projects, MCP, and Subagents." *Claude Blog*, 13 Nov. 2025. https://claude.com/blog/skills-explained

CData. "Claude Skills vs MCP: Better Together with Connect AI." *CData Blog*, 11 Nov. 2025. https://www.cdata.com/blog/claude-skills-vs-mcp-better-together-with-connect-ai

Catch Metrics. "A Brief Introduction to MCP Server Performance Optimization." *Catch Metrics Blog*, 2025. https://www.catchmetrics.io/blog/a-brief-introduction-to-mcp-server-performance-optimization

Descope. "5 Enterprise Challenges in Deploying Remote MCP Servers." *Descope Blog*, 2025. https://www.descope.com/blog/post/enterprise-mcp

IntuitionLabs. "Claude Skills vs. MCP: A Technical Comparison for AI Workflows." *IntuitionLabs*, 27 Oct. 2025. https://intuitionlabs.ai/articles/claude-skills-vs-mcp

Kadous, Waleed. "The Evolution of AI Tool Use: MCP Went Sideways." *Medium*, 8 Dec. 2025. https://waleedk.medium.com/the-evolution-of-ai-tool-use-mcp-went-sideways-8ef4b1268126

MCPcat. "Fix MCP Error -32001: Request Timeout - Complete Guide." *MCPcat*, 2025. https://mcpcat.io/guides/fixing-mcp-error-32001-request-timeout/

Posta, Christian. "Enterprise Challenges With MCP Adoption." *ceposta Technology Blog*, 2025. https://blog.christianposta.com/enterprise-challenges-with-mcp-adoption/

Ronacher, Armin. "Skills vs Dynamic MCP Loadouts." *Armin Ronacher's Thoughts and Writings*, Dec. 2025. https://lucumr.pocoo.org/2025/12/13/skills-vs-mcp/

Schmid, Philipp. "Introducing MCP CLI: A Way to Call MCP Servers Efficiently." *philschmid.de*, 8 Jan. 2026. https://www.philschmid.de/mcp-cli

Speakeasy. "Reducing MCP Token Usage by 100x — You Don't Need Code Mode." *Speakeasy Blog*, 18 Nov. 2025. https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2

Spence, Scott. "Optimising MCP Server Context Usage in Claude Code." *Scott Spence*, 30 Sept. 2025. https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code

The New Stack. "15 Best Practices for Building MCP Servers in Production." *The New Stack*, 15 Sept. 2025. https://thenewstack.io/15-best-practices-for-building-mcp-servers-in-production/

ThinhDA. "Building Production-Ready MCP Servers: Taking FastMCP to Enterprise Level." *ThinhDA*, 30 Apr. 2025. https://thinhdanggroup.github.io/mcp-production-ready/

Willison, Simon. "Claude Skills Are Awesome, Maybe a Bigger Deal than MCP." *simonwillison.net*, 16 Oct. 2025. https://simonwillison.net/2025/Oct/16/claude-skills/

Xenoss. "MCP in Enterprise: Real-World Applications and Challenges." *Xenoss Blog*, 15 Sept. 2025. https://xenoss.io/blog/mcp-model-context-protocol-enterprise-use-cases-implementation-challenges

---

## Appendix: Quick Reference

### Token Budget Comparison

```
Skills Approach (5 skills):
├── Startup: ~200 tokens (names + descriptions)
├── Single skill invocation: ~1,500 tokens
├── Script execution: ~100 tokens (output only)
└── Total for task: ~1,800 tokens

MCP Approach (5 servers, ~60 tools):
├── Startup: ~55,000 tokens (all definitions)
├── Tool selection: ~500 tokens
├── Result handling: ~2,000 tokens
└── Total for task: ~57,500 tokens

Difference: 32x more tokens for MCP
```

### Timeout Configuration Reference

**Skills (in script):**
```python
import requests
response = requests.get(url, timeout=30)  # You control it
```

**MCP (environment variables):**
```bash
MCP_TIMEOUT=60000        # Startup timeout (ms)
MCP_TOOL_TIMEOUT=120000  # Tool execution timeout (ms)
# Note: Often ignored by clients
```

### Decision Checklist

Before choosing MCP:
- [ ] Is real-time data required?
- [ ] Will this operation be performed frequently?
- [ ] Can you afford 5,000-15,000+ tokens overhead?
- [ ] Do you have DevOps capacity for server management?
- [ ] Is the MCP server from a trusted source?

If ≥3 answers are "no" → Consider Skills + Scripts instead.
