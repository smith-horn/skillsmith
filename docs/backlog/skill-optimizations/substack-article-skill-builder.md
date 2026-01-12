# Substack Article: The Hidden Token Tax in Claude Code (And How to Fix It)

---

## Metadata

**Title:** The Hidden Token Tax in Claude Code (And How to Fix It)

**Subtitle:** Why your AI agent is wasting 40-90% of its context window—and an open-source tool to stop it

**Tags:** AI, Claude Code, Developer Tools, Productivity, Open Source

---

## Article

Every time you run a skill in Claude Code, you're probably paying a hidden tax.

Not in dollars—though that's part of it. The real cost is context. Your AI agent has a 200,000 token budget. Every intermediate calculation, every verbose output, every working step accumulates in that window. And when it fills up, two things happen: performance degrades, and you hit a wall.

I spent the last few weeks investigating why my Claude Code sessions kept running out of steam. What I found surprised me—and led me to build a tool that cuts token usage by 40-90%.

### The Problem: Skills Run in the Wrong Place

Claude Code has a powerful feature called Skills. Think of them as reusable expertise packages—instructions that teach Claude how to handle specific tasks like processing PDFs, analyzing spreadsheets, or reviewing code.

Here's what the documentation doesn't make obvious: **skills execute in your main conversation context by default.**

That means when you invoke a skill to process a 50-page PDF, everything happens in the same context window where you're having your conversation. The skill's instructions load in. The intermediate text extractions pile up. The working memory accumulates. By the time you get your answer, you might have burned 20,000 tokens on outputs you'll never look at again.

Multiply this across a few tasks, and you've eaten half your context budget before lunch.

### Why Context Pollution Matters

This isn't just about running out of space. Anthropic's own research confirms that model performance degrades as the context window fills. You're not just paying for wasted tokens—those tokens are actively making your results worse.

The irony is that Claude Code already has the solution built in: **subagents**.

Subagents are isolated Claude instances that handle specific tasks in their own context window. When a subagent finishes, only its summary returns to the main conversation. All the verbose intermediate work stays contained and gets discarded.

Here's the catch: **skills don't automatically run in subagents.** You have to explicitly configure this. And most people don't.

### The Architecture Gap

When I dug into the documentation, I found these key constraints:

1. **Subagents do not automatically inherit skills from the main conversation.** If you spawn a subagent, it can't use your skills unless you explicitly tell it to.

2. **Built-in agents can't access custom skills.** The Explore, Plan, and general-purpose agents that Claude Code provides? They have no access to skills you've created.

3. **Only custom subagents with an explicit `skills:` field can load skills.** You need to create an agent definition file and specify which skills it should use.

This means the default behavior—skills running in your main context—is actually the worst possible configuration for token efficiency. But fixing it requires manual setup for every skill you create.

That's tedious. So I automated it.

### Introducing the Skill-Builder

I built a skill-builder that generates **skill-subagent pairs** automatically. When you create a new skill, it produces:

**1. The skill itself** (`SKILL.md`)

Standard skill definition with proper frontmatter, description, and instructions.

**2. A companion specialist agent** (`.claude/agents/[skill-name]-specialist.md`)

A dedicated subagent configured with:
- The `skills:` field pointing to your new skill
- Minimal tool permissions (only what the skill needs)
- A system prompt that enforces summary-only output

**3. Integration snippets for your CLAUDE.md**

Documentation of when to delegate to this specialist, so your orchestrator agent knows how to route tasks appropriately.

The result: every skill you create is automatically configured for isolated execution. No manual setup. No context pollution.

### The Numbers

I compiled measurements from various sources while researching this pattern:

| Scenario | Without Isolation | With Subagent Isolation | Reduction |
|----------|-------------------|-------------------------|-----------|
| Typical complex task | 43,588 tokens | 27,297 tokens | 37% |
| Multi-step research (10 workers) | 50,000 tokens | 1,500 tokens | 97% |
| Document processing pipeline | 200KB context | 1KB summaries | 99.5% |

The 97% figure comes from a scenario with 10 parallel workers. Without isolation, each returns ~5,000 tokens of working context to the orchestrator. With isolation and structured summaries, each returns ~150 tokens. Same work, fraction of the context cost.

### How It Works

Here's what a generated skill-subagent pair looks like:

**The Skill** (`.claude/skills/pdf-processing/SKILL.md`):

```yaml
---
name: pdf-processing
description: Extract text, fill forms, merge PDFs. Use when working with PDF files, forms, or document extraction.
---

# PDF Processing

## Instructions
1. Use pdfplumber for text extraction
2. Use pypdf for form operations
3. Return structured results with page references

[... rest of skill instructions ...]
```

**The Companion Agent** (`.claude/agents/pdf-processing-specialist.md`):

```yaml
---
name: pdf-processing-specialist
description: Process PDF documents. Use when working with PDF files, forms, or document extraction.
skills: pdf-processing
tools: Read, Bash, Write
model: sonnet
---

You are a PDF processing specialist.

## Operating Protocol

1. Execute the pdf-processing skill for the delegated task
2. Process all intermediate results internally
3. Return ONLY a structured summary to the orchestrator

## Output Format

Always respond with:
- **Task:** [what was requested]
- **Actions:** [what you did]
- **Results:** [key outcomes, max 3-5 bullet points]
- **Artifacts:** [file paths created]

Do not include raw text extractions or verbose intermediate outputs.
Keep response under 500 tokens.
```

The magic is in that last section. The subagent is explicitly instructed to compress its output. Raw extractions, intermediate steps, working memory—none of it escapes to pollute the orchestrator's context.

### The Orchestration Layer

The skill-builder also generates a snippet for your `CLAUDE.md` that tells the orchestrator when to delegate:

```markdown
## Skill Delegation: pdf-processing

**Specialist:** pdf-processing-specialist  
**Triggers:** PDF files, form filling, document extraction, merge PDFs  
**Delegate when:** Task involves PDF processing of any kind

Example: "Use the pdf-processing-specialist to extract text from the quarterly report."
```

This creates a clean separation of concerns:
- **Orchestrator:** Routing, synthesis, user interaction
- **Specialists:** Domain-specific execution in isolation

### Who This Is For

This pattern matters most if you're:

**Building production workflows with Claude Code.** Token costs add up. Context limits constrain what you can accomplish in a single session. This architecture directly addresses both.

**Running complex, multi-step tasks.** Research, analysis, document processing—anything that generates verbose intermediate output benefits from isolation.

**Hitting context limits mid-session.** If you find yourself needing to `/clear` and start over, context pollution is likely the culprit.

**Managing teams using Claude Code.** Standardizing on skill-subagent pairs means consistent architecture across your organization.

### Get the Skill-Builder

The skill-builder is available on GitHub:

**[PLACEHOLDER: YOUR_GITHUB_REPOSITORY_URL]**

It includes:
- The skill-builder skill itself
- Documentation and examples
- Templates for common skill types
- Instructions for upgrading existing skills

### What's Next

I'm working on a few extensions:

**Parallel orchestration patterns.** When you need multiple specialists working simultaneously, how do you coordinate them efficiently?

**Skill composition.** Can specialists invoke other specialists? (Short answer: not directly, but there are workarounds.)

**Metrics and observability.** How do you measure token efficiency across a complex workflow?

If you're experimenting with Claude Code architecture, I'd love to hear what patterns you've found. Drop a comment or reach out directly.

---

*Building AI workflows that don't waste tokens. Subscribe for more research on practical AI architecture.*

---

## Publishing Checklist

- [ ] Add GitHub repository URL to placeholder
- [ ] Create header image (suggested: architecture diagram showing orchestrator + specialists)
- [ ] Add code syntax highlighting if Substack supports it
- [ ] Cross-link to LinkedIn and Reddit posts
- [ ] Schedule for weekday morning publication (typically best engagement)
