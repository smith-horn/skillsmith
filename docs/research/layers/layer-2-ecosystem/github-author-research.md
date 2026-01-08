# Layer 2: Ecosystem View - GitHub Skill Author Research

## Executive Summary

This research examines the perspectives of Claude skill and MCP server authors - the critical supply-side actors in the Claude skills ecosystem. Through analysis of GitHub repositories, blog posts, social media, and community discussions, we identified clear patterns in author motivations, frustrations, and needs.

### Key Findings

1. **Author Motivation**: Skill authors are primarily motivated by solving their own productivity problems, then sharing solutions with the community. The promise of "10x productivity" and eliminating repetitive prompt-crafting drives creation.

2. **Distribution Challenge**: The #1 pain point for authors is **discoverability**. There is no centralized, authoritative marketplace. Skills are scattered across GitHub repositories, making it hard for users to find quality skills.

3. **Maintenance Burden**: Authors face ongoing challenges with:
   - Breaking changes in Claude Code versions
   - YAML formatting quirks breaking skill recognition
   - Limited documentation on edge cases
   - Context window management when skills grow complex

4. **Ecosystem Maturity**: The ecosystem is rapidly maturing with 20,000+ stars on the official Anthropic skills repo and "tens of thousands of community-created skills" according to Anthropic's Mahesh Murag.

5. **Open Standard Adoption**: The open standard for Agent Skills (agentskills.io) is driving cross-platform adoption. Microsoft, Cursor, Goose, Amp, and OpenCode have already adopted the standard.

---

## Author Journey Map

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           SKILL AUTHOR JOURNEY                                       │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  TRIGGER                    BUILD                     PUBLISH                        │
│  ────────                   ─────                     ───────                        │
│  - Repetitive prompting     - Create SKILL.md         - Push to GitHub               │
│  - Workflow friction        - Add YAML frontmatter    - Submit to awesome-* list     │
│  - See community examples   - Test with Claude        - Share on Twitter/X           │
│  - Frustration with AI      - Debug activation        - Write blog post              │
│    inconsistency            - Add reference files     - Wait for discovery           │
│                                                                                      │
│  Pain Level: Medium         Pain Level: HIGH          Pain Level: HIGH               │
│  (motivation building)      (technical hurdles)       (visibility challenges)        │
│                                                                                      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  FEEDBACK                   MAINTAIN                  ABANDON/THRIVE                 │
│  ────────                   ────────                  ──────────────                 │
│  - GitHub issues/stars      - Fix breaking changes    - Abandon: No users,           │
│  - Direct user messages     - Update for new Claude     burnout, breaking changes    │
│  - Twitter mentions         - Add requested features  - Thrive: Community adoption,  │
│  - Silence (most common)    - Documentation upkeep      partner integration,         │
│                             - Version compatibility     marketplace listing          │
│                                                                                      │
│  Pain Level: Variable       Pain Level: MEDIUM-HIGH   Pain Level: Variable           │
│  (often silence)            (ongoing investment)      (depends on support)           │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Journey Stage Analysis

#### Stage 1: Trigger (Why Authors Start)
- **Primary trigger**: "If you find yourself typing the same prompt repeatedly across multiple conversations, it's time to create a Skill." (Anthropic docs)
- **Productivity promise**: Authors believe skills can turn "3-week projects into 3-day sprints"
- **Community inspiration**: Seeing awesome-claude-skills repositories with 10,000+ stars

#### Stage 2: Build (Creation Challenges)
- **Surprisingly simple to start**: "Skills are simple to create - just a folder with a SKILL.md file"
- **Debugging is hard**: "Claude generated files with the wrong naming convention. The skill.md wasn't in the right folder."
- **YAML pitfalls**: Prettier formatting breaks skills; multi-line descriptions cause parsing failures

#### Stage 3: Publish (Distribution Problems)
- **No central marketplace**: Multiple competing "awesome" lists, fragmented discovery
- **GitHub-centric**: Almost all distribution happens through GitHub
- **Visibility lottery**: Most skills never get discovered beyond the author

#### Stage 4: Feedback (User Communication)
- **Silence is common**: Many authors report no feedback at all
- **GitHub stars as validation**: "Starring the repository helps others discover these utilities and motivates continued development"
- **Issue-driven improvement**: Active skills improve through GitHub issues

#### Stage 5: Maintain (Ongoing Investment)
- **Version breaking changes**: "Character budget limit" changed in Claude Code 2.0.70
- **SDK vs CLI differences**: Skills work differently depending on invocation method
- **Documentation lag**: Anthropic documentation often trails reality

#### Stage 6: Abandon/Thrive (Outcomes)
- **Abandon triggers**: No users, breaking changes, burnout, lack of feedback
- **Thrive indicators**: Partner integration, marketplace listing, community adoption

---

## Verbatim Quotes from Authors

### Quote 1: Jesse Vincent (Superpowers Author)
> "The first time [Skills] really popped up on my radar was a few weeks ago when Anthropic rolled out improved Office document creation... Skills are what give your agents Superpowers."
>
> Source: [blog.fsck.com](https://blog.fsck.com/2025/10/09/superpowers/)

### Quote 2: Simon Willison (Skill Researcher/Author)
> "I inadvertently preempted their announcement of this feature when I reverse engineered and wrote about it last Friday... Skills are conceptually extremely simple: a skill is a Markdown file telling the model how to do something, optionally accompanied by extra documents and pre-written scripts."
>
> "I expect a Cambrian explosion in Skills which will make this year's MCP rush look pedestrian by comparison."
>
> Source: [simonwillison.net](https://simonwillison.net/2025/Oct/16/claude-skills/)

### Quote 3: Nityesh (Twitter/X)
> "I'm SO impressed by Claude Skills. They are the best way to package custom instructions (and code) for the agent to access. I prefer this to Claude Code's subagents because of the way it handles context."
>
> Source: [X/Twitter @nityeshaga](https://x.com/nityeshaga/status/1980635966776684613)

### Quote 4: Corey Ganim (Twitter/X)
> "'Skills' are the highest leverage AI breakthrough of the year. Vast majority of my time is being spent building Claude skills, both for personal use and to package for resale. Imagine how powerful your biz becomes when you perform a top-tier audit then prescribe your own."
>
> Source: [X/Twitter @GanimCorey](https://x.com/GanimCorey/status/2003548496482173128)

### Quote 5: Alireza Rezvani (Skill Factory Author)
> "Research from METR drops an uncomfortable fact: developers using AI tools often complete tasks slower than those working without AI — while consistently rating their own productivity higher. This isn't a rounding error. It's a perceptual gap large enough to drive a truck through."
>
> "I've spent over twenty years building production systems, from early web applications to modern distributed architectures. I've watched this movie before. When AJAX revolutionized web development, early adopters spent months building XMLHttpRequest wrappers before realizing they needed frameworks."
>
> Source: [alirezarezvani.medium.com](https://alirezarezvani.medium.com/the-claude-skills-factory-how-you-can-generate-production-ready-ai-tools-in-15-minutes-eb0b86087f31)

### Quote 6: Scott Spence (Skill Debugging Author)
> "The CLI was outputting perfectly valid skills, but I discovered the issue was with how Prettier formatted the YAML frontmatter. It used multi line descriptions because that's valid YAML. But Claude Code wasn't having any of it."
>
> "Use single line description so as not to break the YAML with a `# prettier-ignore` comment."
>
> Source: [scottspence.com](https://scottspence.com/posts/claude-code-skills-not-recognised)

### Quote 7: Sionic AI Team (ML Skills Users)
> "The skills that get referenced most aren't the ones documenting clean successes—they're the ones documenting failures. 'I tried X and it broke because Y' turns out to be the most useful sentence in the whole system. Success stories tell you one path that worked, while failure stories tell you which paths to skip entirely."
>
> Source: [Hugging Face Blog](https://huggingface.co/blog/sionic-ai/claude-code-skills-training)

### Quote 8: Anthropic - Mahesh Murag (Product Manager)
> "The community response has exceeded expectations... Our skills repository already crossed 20k stars on GitHub, with tens of thousands of community-created and shared skills."
>
> Source: [VentureBeat](https://venturebeat.com/technology/anthropic-launches-enterprise-agent-skills-and-opens-the-standard)

### Quote 9: Community Skills Troubleshooter (GitHub Issue)
> "Even when executing each agent, the activation of Claude Skills is very unstable. For example, even if explicitly instructed to use at least five Claude Skills, it actually only loads around 0 to 3."
>
> Source: [GitHub Discussion #182117](https://github.com/orgs/community/discussions/182117)

### Quote 10: Full-Stack Developer (MCP Server Author)
> "Building these MCP servers fundamentally changed how I work, consolidating what used to require switching between 10 different tools into a single conversation with Claude."
>
> Source: [Medium - Qasimali](https://medium.com/@qasimali7566675/supercharge-your-development-workflow-with-mcp-servers-a-complete-guide-for-full-stack-developers-e056a376ccbb)

### Quote 11: DevOps Engineer (MCP Server Author)
> "I'm by no means an experienced expert when it comes to MCP Servers... I initially thought they couldn't possibly bring that much value, but found that initial assumption was wrong."
>
> "There's hesitation about using Claude to make changes to a Production Kubernetes Cluster, though it could be helpful for debugging purposes. Since LLMs are 'non-deterministic' and don't create the same output from the same prompt, it's unclear how to make using an MCP Server to change a Kubernetes Cluster repeatable."
>
> Source: [Medium - Mark Southworth](https://medium.com/@mark.southworth98/why-i-finally-tried-mcp-servers-and-what-happened-next-00f6198a4c98)

### Quote 12: Jannis (First-Time Skill Builder)
> "I jumped into building a custom skill for Claude and trimmed a task I used to spend hours on down to minutes."
>
> Source: [Medium - PowerUpSkills](https://medium.com/@PowerUpSkills/i-built-a-claude-skill-in-under-30-minutes-and-it-immediately-elevated-my-workflow-084a10d95338)

### Quote 13: Enterprise MCP Maintainer Perspective
> "While forking an existing MCP server has benefits like decreased dev burden and faster time-to-market, these 'augmented' MCP servers often result in unanticipated maintenance that offsets the initial advantages."
>
> Source: [Descope Blog](https://www.descope.com/blog/post/enterprise-mcp)

### Quote 14: Pawel Huryn (Twitter/X)
> "Most vibe coders don't know this: You can radically reduce errors, cut credits, enable an agent to learn, and make vibe engineering a breeze. Just give your agent a memory. I'm really impressed by Claude Skills. But those need to be managed by humans."
>
> Source: [X/Twitter @PawelHuryn](https://x.com/PawelHuryn/status/1984938252726329602)

---

## Pain Point Analysis

### Critical Pain Points (Severity: HIGH)

| Pain Point | Description | Impact | Frequency |
|------------|-------------|--------|-----------|
| **Discoverability** | No central marketplace; scattered across GitHub repos | Authors can't reach users; users can't find skills | Universal |
| **Skill Activation Instability** | Skills don't reliably activate when relevant | User frustration; debugging burden | Very Common |
| **YAML/Formatting Sensitivity** | Prettier, multi-line descriptions break recognition | Skills fail silently | Common |
| **Context Window Management** | Skills consume context; 15,000 char limit by default | Complex skills unusable | Common |

### Moderate Pain Points (Severity: MEDIUM)

| Pain Point | Description | Impact | Frequency |
|------------|-------------|--------|-----------|
| **Breaking Version Changes** | Claude Code updates break existing skills | Maintenance burden | Regular |
| **SDK vs CLI Differences** | Skills work in CLI but not SDK (or vice versa) | Deployment confusion | Occasional |
| **Documentation Lag** | Official docs trail actual behavior | Learning curve steepened | Ongoing |
| **Feedback Void** | Authors rarely hear from users | Motivation erosion | Very Common |

### Operational Pain Points (Severity: MEDIUM)

| Pain Point | Description | Impact | Frequency |
|------------|-------------|--------|-----------|
| **Token Efficiency** | All MCP servers load at session start | Context waste | Universal |
| **Security Governance** | Credentials scattered; no central audit | Enterprise adoption friction | Enterprise-only |
| **Cross-Platform Testing** | Skills must work on Claude Code, Codex, etc. | Testing overhead | Growing |

---

## Incentive and Motivation Analysis

### Primary Motivations

#### 1. Personal Productivity (Strongest)
- **Quote**: "I jumped into building a custom skill for Claude and trimmed a task I used to spend hours on down to minutes."
- **Pattern**: Most skill authors start by solving their own problems
- **Sustainability**: High - direct, tangible benefit

#### 2. Community Recognition (Strong)
- **Evidence**: 20,000+ stars on Anthropic's skills repo
- **Metric**: GitHub stars = primary validation currency
- **Pattern**: Authors explicitly cite stars as motivation

#### 3. Commercial Opportunity (Emerging)
- **Quote**: "Skills... both for personal use and to package for resale"
- **Evidence**: SkillsMP marketplace, enterprise adoption
- **Trend**: Monetization paths are opening up

#### 4. Thought Leadership (Moderate)
- **Examples**: Jesse Vincent, Simon Willison, Alireza Rezvani
- **Pattern**: Blog posts, Twitter threads, conference talks
- **Benefit**: Career advancement, consulting opportunities

### Anti-Patterns (What Causes Abandonment)

1. **Silence from Users**: No stars, no issues, no feedback
2. **Breaking Changes**: Claude updates that require rework
3. **Complexity Explosion**: Skills that become too complex to maintain
4. **MCP Server Fatigue**: OAuth, security, and ongoing maintenance burden

---

## Author Wishlist for Tooling

Based on community discussions and identified pain points, skill authors need:

### 1. Centralized Discovery Platform
- **Need**: "Finding the right agent skill among thousands of GitHub repositories can be overwhelming"
- **Partial Solution**: SkillsMP.com (community effort)
- **Ideal**: Official Anthropic-backed marketplace with quality indicators

### 2. Better Debugging Tools
- **Need**: Skills fail silently; activation is unpredictable
- **Quoted Problem**: "The /skills command shows 'No skills found' even though skills are loaded and working"
- **Ideal**: Verbose logging, activation traces, test frameworks

### 3. YAML Validation/Linting
- **Need**: Prettier and formatting tools break skill recognition
- **Solution**: Pre-commit hooks, dedicated linter
- **Ideal**: Built-in validation in Claude Code

### 4. Version Compatibility Layer
- **Need**: Skills break across Claude Code versions
- **Ideal**: Semantic versioning for skills, deprecation warnings

### 5. Feedback Mechanisms
- **Need**: Authors rarely know if their skills are used
- **Ideal**: Usage analytics, ratings, reviews (like npm stats)

### 6. Cross-Platform Testing
- **Need**: Skills should work on Claude Code, Codex CLI, Cursor, etc.
- **Evidence**: "Skills can work across models" - Simon Willison
- **Ideal**: Test harness that validates across platforms

### 7. Token Efficiency Management
- **Need**: "All configured MCP servers load their complete tool schemas into the context at session initialization, consuming tokens regardless of actual usage"
- **Feature Requests**: Dynamic loading, lazy initialization

### 8. Enterprise Security Tools
- **Need**: "Credentials scattered across multiple configuration files"
- **Ideal**: Centralized secrets management, audit logs

---

## Source URLs

### Official Sources
- [Anthropic Skills Repository](https://github.com/anthropics/skills)
- [Anthropic Introducing Agent Skills](https://www.anthropic.com/news/skills)
- [Claude Skills Documentation](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/best-practices)
- [Agent Skills Specification](https://agentskills.io)

### Community Repositories
- [travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills)
- [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)
- [obra/superpowers](https://github.com/obra/superpowers)
- [alirezarezvani/claude-code-skill-factory](https://github.com/alirezarezvani/claude-code-skill-factory)
- [alirezarezvani/claude-code-tresor](https://github.com/alirezarezvani/claude-code-tresor)
- [mhattingpete/claude-skills-marketplace](https://github.com/mhattingpete/claude-skills-marketplace)

### Author Blog Posts
- [Jesse Vincent - Superpowers](https://blog.fsck.com/2025/10/09/superpowers/)
- [Simon Willison - Claude Skills are awesome](https://simonwillison.net/2025/Oct/16/claude-skills/)
- [Alireza Rezvani - Claude Skills Factory](https://alirezarezvani.medium.com/the-claude-skills-factory-how-you-can-generate-production-ready-ai-tools-in-15-minutes-eb0b86087f31)
- [Scott Spence - Skills Not Recognised Fix](https://scottspence.com/posts/claude-code-skills-not-recognised)
- [Sionic AI - 1000+ ML Experiments](https://huggingface.co/blog/sionic-ai/claude-code-skills-training)

### Twitter/X Discussions
- [@nityeshaga on Skills](https://x.com/nityeshaga/status/1980635966776684613)
- [@GanimCorey on Skills](https://x.com/GanimCorey/status/2003548496482173128)
- [@rileybrown_ai on Skills](https://x.com/rileybrown_ai/status/1978871809765445884)
- [@PawelHuryn on Skills](https://x.com/PawelHuryn/status/1984938252726329602)
- [@DataChaz on awesome-claude-skills](https://x.com/DataChaz/status/2003378266061832348)

### Hacker News Discussions
- [Claude Skills are awesome, maybe a bigger deal than MCP](https://news.ycombinator.com/item?id=45619537)
- [Claude Skills Discussion](https://news.ycombinator.com/item?id=45607117)

### GitHub Issues (Pain Points)
- [Skills Not Recognised Issue](https://github.com/anthropics/claude-code/issues/9716)
- [User skills not auto-discovered](https://github.com/anthropics/claude-code/issues/11266)
- [MCP Server Marketplace Request](https://github.com/IBM/mcp-context-forge/issues/295)
- [Dynamic MCP Server Loading](https://github.com/anthropics/claude-code/issues/14879)
- [Token Management with MCP Servers](https://github.com/anthropics/claude-code/issues/7172)

### Marketplace and Discovery
- [SkillsMP - Skills Marketplace](https://skillsmp.com)
- [Awesome Claude Visual Directory](https://awesomeclaude.ai/awesome-claude-skills)
- [PulseMCP - MCP Server Directory](https://www.pulsemcp.com/servers)

### Enterprise and Security
- [5 Enterprise Challenges in Deploying Remote MCP Servers](https://www.descope.com/blog/post/enterprise-mcp)
- [MCP Spec Update: Authorization](https://www.scalekit.com/blog/authorization-server-mcp)
- [GitHub: Why we open sourced our MCP server](https://github.blog/open-source/maintainers/why-we-open-sourced-our-mcp-server-and-what-it-means-for-you/)

### Media Coverage
- [VentureBeat - Agent Skills Open Standard](https://venturebeat.com/technology/anthropic-launches-enterprise-agent-skills-and-opens-the-standard)
- [SiliconANGLE - Agent Skills Open Standard](https://siliconangle.com/2025/12/18/anthropic-makes-agent-skills-open-standard/)
- [The Decoder - Skills Launch](https://the-decoder.com/anthropic-launches-skills-so-claude-can-automatically-pick-prompts-for-specialized-tasks/)
- [O'Reilly - What MCP and Skills Teach Us](https://www.oreilly.com/radar/what-mcp-and-claude-skills-teach-us-about-open-source-for-ai/)

---

## Appendix: Ecosystem Statistics

| Metric | Value | Source |
|--------|-------|--------|
| Anthropic skills repo stars | 20,000+ | Mahesh Murag (Anthropic) |
| Community-created skills | "Tens of thousands" | Mahesh Murag (Anthropic) |
| MCP servers in directory | 7,470+ | PulseMCP |
| ComposioHQ awesome-skills forks | 1,200+ | GitHub |
| Partner companies at launch | 8+ (Atlassian, Figma, Canva, Stripe, Notion, Zapier, Vercel, Cloudflare) | Anthropic |
| Cross-platform adopters | 5+ (Microsoft, Cursor, Goose, Amp, OpenCode) | VentureBeat |

---

*Research conducted: December 26, 2025*
*Layer 2: Ecosystem View - Claude Discovery Hub*
