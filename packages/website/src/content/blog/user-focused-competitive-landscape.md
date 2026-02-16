---
title: "You Installed a Claude Skill. It Didn't Work. You're Not Alone."
description: "The seven problems every developer hits with Claude Skills, what the data says, and which tools actually solve them"
author: "Skillsmith Team"
date: 2026-02-16
category: "Guides"
tags: ["skills", "security", "registries", "competitive-landscape", "discovery", "trust-tiers"]
featured: true
draft: false
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/user-focused-landscape/01-skill-didnt-work"
---

![You Installed It. It Didn't Work.](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/user-focused-landscape/01-skill-didnt-work)

## The Promise vs. the Reality

Claude Skills were supposed to be simple. Write a SKILL.md file. Drop it in a folder. Claude gains domain expertise. Ship faster.

The reality is messier. A 650-trial controlled study found that default skill descriptions achieve only a 77% activation rate (1). Developers report requesting five skills per session and getting zero to three (2). Formatters break YAML frontmatter silently (4). Claude claims it will use a skill, then wings it without reading the contents (3).

100+ people hit the same problems in Week One (5). 40+ individual failures have been analyzed and distilled into five root-cause categories (6). And that's just activation. The security picture is worse.

This article walks through seven problems that developers actually experience with Claude Skills -- not feature comparisons between registries, but the daily friction that makes the ecosystem harder to use than it should be. For each one, we look at what the data says, which tools address it, and what remains unsolved.

---

## Problem 1: Skills Don't Activate Reliably

**This is the universal entry point. Every developer who has tried skills has experienced it.**

You install a skill. You ask Claude to use it. Claude says it will. Then it doesn't. No error. No warning. It just... doesn't load the skill.

A 650-trial study tested activation rates under controlled conditions (1). Default skill descriptions -- the kind most published skills use -- achieved 77% activation. The only way to reach 100% was to rewrite descriptions with imperative language ("MANDATORY", "CRITICAL") and negative constraints (1). The Cochran-Mantel-Haenszel test confirmed that imperative descriptions were 20x more likely to activate than standard ones (p < 0.0001) (1).

The underlying causes:

- **System prompt overflow**: When installed skill descriptions exceed 15,000 characters combined, skills silently disappear from Claude's context (3). No warning. The workaround is an undocumented environment variable: `SLASH_COMMAND_TOOL_CHAR_BUDGET=30000` (3).
- **Formatter corruption**: Prettier and similar tools rewrite YAML frontmatter to multi-line format, which Claude doesn't recognize as valid skill metadata (4).
- **Model behavior**: Claude Opus 4.5+ sometimes claims it will use a skill, then generates a response without reading the skill contents (3). It guesses instead of reading.

> "The activation of the Claude Skill is extremely unstable. Even after enabling it and explicitly stating it in the prompt."
> -- GitHub Discussion #182117 (2)

Developers have built workarounds: pre-prompt hooks that inject mandatory skill evaluation directives (80-84% success rate on Haiku 4.5, 100% on Sonnet 4.5) (7), environment variable overrides, and imperative SKILL.md language. These are duct tape. The platform doesn't guarantee activation, and no registry tests for it.

**What helps**: Skillsmith's `skill_validate` tool catches the authoring mistakes that cause most activation failures -- malformed frontmatter, missing required fields, description length violations. It doesn't fix the platform's activation model, but it eliminates the self-inflicted errors that account for the majority of failures.

---

![13.4% of the Largest Registry Has Critical Vulnerabilities](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/user-focused-landscape/02-security-crisis)

## Problem 2: You Can't Tell If a Skill Is Safe

This escalated from theoretical to confirmed in February 2026.

Snyk's ToxicSkills audit scanned 3,984 skills from ClawHub, the largest open skill registry (8). The results:

- **534 skills (13.4%)** have critical-level security issues (8)
- **1,467 skills (36.82%)** have at least one flaw (8)
- **76 confirmed malicious payloads** -- credential theft, backdoors, data exfiltration (8)
- **8 remained publicly available** at the time of publication (8)

In a separate analysis, Snyk found that 283 skills (7.1%) expose API keys and PII through the LLM's context window -- passwords, credit card numbers, and API keys passed in plaintext (9).

Between February 1-3, 2026, 341+ malicious skills impersonating crypto trading tools were deployed on ClawHub (10). They installed infostealers targeting macOS and Windows (10).

VirusTotal published a two-part taxonomy of skill-based attack techniques: remote execution, propagation, persistence, exfiltration, and behavioral backdoors (11)(11a). The last category -- "cognitive rootkits" -- is new to AI: the skill injects instructions that prime the agent to view security caution as a bug (11a).

> "91% of malicious skills combine prompt injection with traditional malware -- a convergence that bypasses both AI safety mechanisms and traditional security tools."
> -- Snyk ToxicSkills (8)

The barrier to publish on ClawHub: a SKILL.md file and a one-week-old GitHub account. No code signing. No review. No sandbox (12).

**What the registries do**: Nothing, before indexing. Skills.sh sorts by install count. SkillsMP filters by 2+ GitHub stars (which can be the author's own accounts). SkillHub scores construction quality. None scan for malicious content before a skill enters their search results.

**What helps**: Skillsmith scans every skill across nine threat categories before it appears in search results. Skills that trigger critical patterns -- jailbreak attempts, privilege escalation, data exfiltration, role injection -- are quarantined immediately: removed from search, installation blocked, multi-reviewer approval required before restoration. This is the only pre-index scanning architecture in the ecosystem.

---

![250K+ Skills. 7+ Registries. No Way to Compare.](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/user-focused-landscape/03-fragmented-discovery)

## Problem 3: There Are Too Many Skills and No Way to Find the Right One

You search for "testing skill." You get results from seven different places. None of them tell you which one actually works with your Vitest + React project.

The Claude Skills ecosystem now has thousands of skills spread across 7+ competing registries:

| Registry | Skills | Trust Signal |
|----------|--------|-------------|
| Skills.sh (Vercel) | Thousands | Install count |
| SkillsMP | ~97,000 (claimed) | 2+ GitHub stars |
| Smithery | 7,300+ MCP servers and skills | None |
| SkillHub | 9,500+ | AI quality score |
| ClawHub | 3,984 (scanned by Snyk) (8) | None |
| awesome-claude-skills | Multiple GitHub repos | Curation |
| Claude-Plugins.dev | Growing | None |

No registry talks to another. The same skill appears in multiple places simultaneously -- no deduplication, no version tracking, no cross-registry comparison.

This isn't just inconvenient. The classic choice overload study by Iyengar and Lepper found that when shoppers encountered a display of 24 jam varieties, 60% stopped to browse but only 3% purchased; when the display offered 6 varieties, 40% stopped but 30% purchased (13). Large catalogs attract browsing, not commitment.

The GPT Store is the cautionary tale. OpenAI grew it to 3 million GPTs. Discovery was broken from day one. Spam flooded immediately. Most creators never met the 25-conversation-per-week minimum to qualify for revenue sharing (14). Users abandoned the store. Plugins were discontinued.

**Scale without curation produces a graveyard.**

**What helps**: Skillsmith's `skill_recommend` tool analyzes your installed skills, detects trigger phrase overlap, and suggests skills based on what's missing from your setup -- not just keyword matching. The `analyze` tool reads your project's framework and dependency information to make recommendations specific to your stack. You don't browse thousands of skills. You describe what you need, and the tool matches your context.

---

![When Skills Break Each Other](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/user-focused-landscape/04-skills-break-each-other)

## Problem 4: Skills Break Each Other

This one catches power users. You install multiple skills. They work individually. Together, they fail in unpredictable ways.

A custom slash command named `/skill` conflicts with Claude Code's built-in Skill tool, causing all custom commands to silently fail -- not just the conflicting one, everything (15). Project-level skills with the same name as global skills show both in the picker instead of the project-level one shadowing the global (16). One power user with 24 custom skills found 3 specific skills were consistently not discovered at session start, requiring manual registration (17).

The common thread: **silent failure**. Skills don't throw errors when they conflict. They just stop working. You don't know which combination caused the problem or which skill to remove.

No registry detects conflicts before installation. You discover them after your workflow breaks.

**What helps**: Skillsmith's overlap detection analyzes trigger phrases across installed skills and flags conflicts before they cause silent failures. It's the diagnostic tool you wish you had after your third debugging session trying to figure out why your testing skill stopped working after you installed a linting skill.

---

## Problem 5: Every Trust Signal Gets Gamed

You look at a skill's install count. 50,000 installs. Must be good, right?

Every trust signal in the ecosystem can be manipulated:

| Signal | How It Fails |
|--------|-------------|
| **Download count** | Bots inflate counts to 50K+ (documented in VS Code, npm) (18)(19) |
| **GitHub stars** | 2-star filter = the author's own accounts |
| **Verified badge** | VS Code "verification" requires only DNS ownership, not code review (18) |
| **Age / longevity** | "Sleeper" attacks exploit established reputation over time |
| **Source code link** | Uploaded code may differ from the linked repository |
| **AI quality score** | Measures construction quality, not safety or fit-for-purpose |

The pattern repeats across every developer tool ecosystem. Malicious VS Code extensions quadrupled in 2025, from 27 to 105 (18). Open-source registries (npm, PyPI, Maven Central, NuGet) have seen 704,000+ malicious packages since 2019 (19). Security testing of popular MCP server implementations found 43% had command injection flaws (20).

> "The AI Agent Skills ecosystem is making the same architectural choices that enabled npm typosquatting, PyPI backdoors, and malicious Docker images, but the attack surface is larger and the privilege level is higher."
> -- Doug Seven (21)

Developer trust in AI tools is at an all-time low while usage continues to grow (22). People are using skills out of competitive necessity while harboring increasing skepticism.

**What helps**: Skillsmith replaces single-signal trust with a tiered system. Verified means publisher identity is confirmed through GitHub organization membership. Community means the skill passed security scanning from a known author. Experimental means new with strict thresholds. The same scan finding might pass for a Verified skill but quarantine an Unknown one. Trust is earned through a progression path, and downgrades happen when scans fail.

---

![The Two-Sided Marketplace Problem](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/user-focused-landscape/05-marketplace-problem)

## Problem 6: Publishers Can't Reach Users, Users Can't Find Publishers

Multiple GitHub issues document skills in `~/.claude/skills/` not being auto-discovered by Claude. You publish a skill. It works on your machine. Nobody else can find it unless you post the link on Twitter.

> "You post on GitHub, Reddit, X -- shouting into the void. The agents who need your service have no way to find it."
> -- Smithery Blog (23)

This is the two-sided marketplace problem. Users search registries that don't have the best skills. Authors publish to GitHub where there's no discovery mechanism. One developer built Skill Seekers specifically because automatic conflict detection and discovery didn't exist anywhere (24).

**What helps**: Skillsmith's `skill_publish` tool validates, scans, and indexes a skill in a single operation -- from your editor to the registry without tab-switching. The MCP-native search means users discover skills where they use them: inside Claude Code.

---

![The Honest Tradeoffs](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/user-focused-landscape/06-honest-tradeoffs)

## Problem 7: Choosing Between Similar Skills Is a Coin Flip

You're picking between three testing skills. Two have similar descriptions. One has more stars. You have no idea which one actually works with your Vitest + React + TypeScript project. So you try one, it doesn't activate (see Problem 1), you try another, and after an hour you've installed and uninstalled four skills with nothing to show for it.

SkillHub's AI quality scoring is the closest thing to comparative signals -- it evaluates across 5 dimensions (Practicality, Clarity, Automation, Quality, Impact) and assigns letter grades (25). But it measures construction quality. It doesn't answer: will this skill conflict with my existing setup? Is it the right choice for my specific stack?

**What helps**: Skillsmith's `skill_compare` tool provides side-by-side analysis across quality scores, trust tiers, features, dependencies, and size. When you're deciding between two skills that appear to do the same thing, you get a structured recommendation -- not another star count.

---

## The Honest Tradeoffs

Every tool makes tradeoffs. Here are the ones that matter.

**Catalog size vs. curation.** A curated registry with security scanning will always be smaller than a GitHub aggregator. If you want the largest catalog and are comfortable evaluating safety yourself, SkillsMP is the right tool. If you want every skill scanned before you see it, Skillsmith is.

**Agent breadth vs. depth.** Skills.sh supports 17+ agents -- Claude Code, Codex, Cursor, Gemini, GitHub Copilot, Windsurf, and others. Skillsmith is purpose-built for Claude Code. If you work across multiple AI coding tools, breadth matters. If you're building with Claude Code and want MCP-native tooling, depth matters more.

**Simplicity vs. workflow.** `npx skills add author/skill` is a one-liner. Skillsmith's recommendation pipeline requires an MCP server connection. The one-liner is faster when you know exactly what you want. The pipeline is better when you're not sure what you need.

**Free vs. supported.** Most registries are free with no stated business model. Skillsmith has transparent pricing tiers -- a free Community tier (1,000 API calls/month) and paid tiers for higher volume. The business model is the product, not your data.

---

## Using the Ecosystem Together

These tools are not mutually exclusive. Here's what works:

1. **Learn the format**: Start with Anthropic's Skills Documentation (26) and the engineering blog post (27).

2. **Browse for inspiration**: Use [Skills.sh](https://skills.sh) for trending skills across the ecosystem, or [SkillHub](https://www.skillhub.club) for AI-evaluated quality ratings (25).

3. **Discover and install safely**: Use Skillsmith's MCP server for security-scanned, context-aware recommendations that match your project.

4. **Validate before sharing**: Run `skill_validate` on your skills before publishing to any registry.

5. **Compare alternatives**: When multiple skills look similar, use `skill_compare` for structured analysis.

The ecosystem is young. The registries that survive will be the ones that solve trust, not just discovery. Right now, most are solving discovery. That's table stakes.

---

*Skillsmith is an MCP server for Claude Code skill discovery, security scanning, and management. Get started by adding to your Claude settings:*

```json
{
  "mcpServers": {
    "skillsmith": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"]
    }
  }
}
```

*For the full technical breakdown of the nine-category security scanner, see [Why Skillsmith Quarantines Skills Before You Install Them](/blog/security-quarantine-safe-installation).*

---

## Sources

(1) Seleznov, Ivan. "Why Claude Code Skills Don't Activate and How to Fix It." *Medium*, 2026. https://medium.com/@ivan.seleznov1/why-claude-code-skills-dont-activate-and-how-to-fix-it-86f679409af1

(2) GitHub Community. "Claude Skill Activation Is Extremely Unstable." *GitHub Discussion #182117*, 2026. https://github.com/orgs/community/discussions/182117

(3) Vincent, Jesse. "Claude Code Skills Not Triggering." *blog.fsck.com*, 17 Dec. 2025. https://blog.fsck.com/2025/12/17/claude-code-skills-not-triggering/

(4) Spence, Scott. "Claude Code Skills Not Recognised." *scottspence.com*, 2025. https://scottspence.com/posts/claude-code-skills-not-recognised

(5) Nate. "I Watched 100+ People Hit the Same Claude Skills Problems in Week One -- So I Built 10 Tools to Fix Them." *Nate's Newsletter*, Substack, 23 Oct. 2025. https://natesnewsletter.substack.com/p/i-watched-100-people-hit-the-same

(6) Cash and Cache. "I Analyzed 40+ Claude Skills Failures: Here Are the 5 Fixes That Actually Work." *Cash and Cache*, Substack, 2026. https://cashandcache.substack.com/p/i-analyzed-40-claude-skills-failures

(7) Spence, Scott. "Measuring Claude Code Skill Activation With Sandboxed Evals." *scottspence.com*, 2026. https://scottspence.com/posts/measuring-claude-code-skill-activation-with-sandboxed-evals

(8) Snyk Security Research. "ToxicSkills: Malicious AI Agent Skills in ClawHub." *Snyk Blog*, 5 Feb. 2026. https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/

(9) Snyk Security Research. "280+ Leaky Skills: How OpenClaw and ClawHub Are Exposing API Keys and PII." *Snyk Blog*, 2026. https://snyk.io/blog/openclaw-skills-credential-leaks-research/

(10) The Hacker News. "Researchers Find 341 Malicious ClawHub Skills Impersonating Crypto Trading Tools." *The Hacker News*, Feb. 2026. https://thehackernews.com/2026/02/researchers-find-341-malicious-clawhub.html

(11) VirusTotal. "From Automation to Infection: How Malicious Agent Skills Work, Part I." *VirusTotal Blog*, Feb. 2026. https://blog.virustotal.com/2026/02/from-automation-to-infection-how.html

(11a) VirusTotal. "From Automation to Infection, Part II: Reverse Shells, Semantic Worms, and Cognitive Rootkits." *VirusTotal Blog*, Feb. 2026. https://blog.virustotal.com/2026/02/from-automation-to-infection-part-ii.html

(12) Snyk Security Research. "From SKILL.md to Shell Access in Three Lines of Markdown: Threat Modeling Agent Skills." *Snyk Articles*, 2026. https://snyk.io/articles/skill-md-shell-access/

(13) Iyengar, Sheena S., and Mark R. Lepper. "When Choice Is Demotivating: Can One Desire Too Much of a Good Thing?" *Journal of Personality and Social Psychology*, vol. 79, no. 6, 2000, pp. 995-1006. https://faculty.washington.edu/jdb/345/345%20Articles/Iyengar%20%26%20Lepper%20(2000).pdf

(14) Perez, Sarah. "OpenAI's Chatbot Store Is Filling Up with Spam." *TechCrunch*, 20 Mar. 2024. https://techcrunch.com/2024/03/20/openais-chatbot-store-is-filling-up-with-spam/

(15) GitHub. "A Custom Slash Command Named /skill Conflicts with Built-in Skill Tool." *anthropics/claude-code*, Issue #13586, 2026. https://github.com/anthropics/claude-code/issues/13586

(16) GitHub. "Project-Level Skills with Same Name as Global Skills Show Both in Picker." *anthropics/claude-code*, Issue #25209, 2026. https://github.com/anthropics/claude-code/issues/25209

(17) GitHub. "24 Custom Skills, 3 Silently Unregistered Each Session." *anthropics/claude-code*, Issue #12853, 2026. https://github.com/anthropics/claude-code/issues/12853

(18) Wiz Research. "Supply Chain Risk in VS Code Extension Marketplaces." *Wiz Blog*, 2025. https://www.wiz.io/blog/supply-chain-risk-in-vscode-extension-marketplaces

(19) Sonatype. "10th Annual State of the Software Supply Chain Report." *Sonatype*, 10 Oct. 2024. https://www.sonatype.com/press-releases/sonatypes-10th-annual-state-of-the-software-supply-chain-report

(20) Equixly. "MCP Servers: The New Security Nightmare." *Equixly Blog*, 29 Mar. 2025. https://equixly.com/blog/2025/03/29/mcp-server-new-security-nightmare/

(21) Seven, Doug. "Trust Without Verification." *dougseven.com*, 9 Feb. 2026. https://dougseven.com/2026/02/09/trust-without-verification/

(22) Stack Overflow. "2025 Developer Survey." *Stack Overflow*, 2025. https://survey.stackoverflow.co/2025/

(23) Smithery. "Tool Calls Are the New Clicks." *Smithery Blog*, 10 Jun. 2025. https://smithery.ai/blog/tool-calls-are-the-new-clicks

(24) Karaaslan, Yusuf. "Skill Seekers." *GitHub*, 2026. https://github.com/yusufkaraaslan/Skill_Seekers

(25) SkillHub. "Claude Skills and Agent Skills Marketplace." *skillhub.club*, 2026. https://www.skillhub.club/

(26) Anthropic. "Skills Documentation." *Claude Code Docs*, 2026. https://code.claude.com/docs/en/skills

(27) Anthropic. "Equipping Agents for the Real World with Agent Skills." *Anthropic Engineering Blog*, 2026. https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
