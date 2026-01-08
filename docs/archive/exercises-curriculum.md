# Claude Code Exercises & Test Repositories
## Curriculum Design Document

**Version:** 1.0  
**Date:** December 24, 2025  
**Author:** Smith Horn Group Ltd  
**Status:** Curriculum Draft  
**Related:** claude-discovery-hub-v2-architecture.md

---

## Design Philosophy

### Core Principle

> **These exercises train humans to work effectively with Claude Code—not benchmark AI performance.**

The goal is building "muscle memory" for human-AI collaboration patterns. Each exercise should feel like a kata: repeatable, focused, and designed for incremental mastery.

### Learning Objectives Hierarchy

```
Level 1: Mechanics
├── How to invoke Claude Code
├── How to provide context
└── How to interpret outputs

Level 2: Patterns
├── When to use which mode (plan, think, auto)
├── How to structure effective prompts
└── How to manage context windows

Level 3: Extension
├── Creating skills, plugins, commands
├── Building automation with hooks
└── Developing MCP servers

Level 4: Orchestration
├── Multi-agent workflows
├── Parallel execution patterns
└── CI/CD integration
```

---

## Category Taxonomy

### 10 Exercise Categories

| # | Category | Focus | Count | Difficulty Range |
|---|----------|-------|-------|------------------|
| 1 | Fundamentals | Basic interaction, prompting, modes | 8 | Beginner |
| 2 | Configuration | CLAUDE.md, settings, permissions | 6 | Beginner-Intermediate |
| 3 | Context Engineering | Memory, files, context management | 8 | Intermediate |
| 4 | Skill Development | Creating custom skills | 10 | Intermediate-Advanced |
| 5 | Plugin Development | Building full plugins | 8 | Advanced |
| 6 | Commands & Agents | Slash commands, subagents | 8 | Intermediate-Advanced |
| 7 | Hooks & Automation | Event-driven automation | 6 | Advanced |
| 8 | MCP Development | Building MCP servers | 6 | Advanced-Expert |
| 9 | Workflow Patterns | Parallel work, worktrees, swarm | 6 | Advanced-Expert |
| 10 | Real-World Scenarios | Bug fixing, features, refactoring | 12 | Mixed |

**Total: 78 exercises**

---

## Category 1: Fundamentals

*Focus: Basic Claude Code interaction patterns*

### F-01: Hello Claude Code
**Difficulty:** Beginner  
**Time:** 15 min  
**Objective:** Complete first successful interaction

**Setup:**
- Empty project directory
- No configuration files

**Tasks:**
1. Start Claude Code in the directory
2. Ask Claude to explain what it sees
3. Create a simple file through conversation
4. Verify the file was created correctly

**Validation:**
- File exists with expected content
- User can articulate what happened

**Artifact:** `hello.txt` with custom content

---

### F-02: Mode Mastery
**Difficulty:** Beginner  
**Time:** 20 min  
**Objective:** Understand and use different thinking modes

**Setup:**
- Simple Python project with 3 files
- One obvious bug to fix

**Tasks:**
1. Use default mode to explore the codebase
2. Use `/think` mode to reason about the bug
3. Use `/plan` mode to create a fix strategy
4. Execute the fix

**Validation:**
- Bug is fixed
- User can explain when to use each mode

**Artifact:** Fixed code + written reflection on modes

---

### F-03: Context Window Awareness
**Difficulty:** Beginner  
**Time:** 25 min  
**Objective:** Understand context limits and management

**Setup:**
- Large codebase (50+ files)
- Task requiring information from multiple files

**Tasks:**
1. Attempt to load too many files
2. Observe context window warning
3. Use selective file loading
4. Complete task with managed context

**Validation:**
- Task completed without context overflow
- User can explain context management

**Artifact:** Completed task + context strategy notes

---

### F-04: Permission Modes
**Difficulty:** Beginner  
**Time:** 20 min  
**Objective:** Understand and configure permission levels

**Setup:**
- Project with sensitive and non-sensitive files
- Tasks requiring different permission levels

**Tasks:**
1. Start in default (ask) mode
2. Try auto-accept for safe operations
3. Observe permission prompts for risky operations
4. Configure appropriate permission settings

**Validation:**
- Permissions configured correctly
- User can explain permission model

**Artifact:** `.claude/settings.json` with custom permissions

---

### F-05: File Mentions
**Difficulty:** Beginner  
**Time:** 15 min  
**Objective:** Master file mention syntax

**Setup:**
- Project with nested file structure
- Task requiring multiple file references

**Tasks:**
1. Use `@file` to reference single file
2. Use `@folder/` to reference directory
3. Use glob patterns for multiple files
4. Combine mentions in single prompt

**Validation:**
- All file mentions work correctly
- User can write complex mention patterns

**Artifact:** Cheatsheet of mention patterns used

---

### F-06: Slash Command Discovery
**Difficulty:** Beginner  
**Time:** 15 min  
**Objective:** Discover and use built-in commands

**Setup:**
- Any project

**Tasks:**
1. Type `/` and explore available commands
2. Use `/help` to understand a command
3. Use `/clear` to reset context
4. Use `/cost` to check token usage
5. Use `/model` to check/change model

**Validation:**
- User can list 10+ slash commands
- User can explain 5 command purposes

**Artifact:** Personal slash command reference doc

---

### F-07: Keyboard Navigation
**Difficulty:** Beginner  
**Time:** 15 min  
**Objective:** Master keyboard shortcuts

**Setup:**
- Active Claude Code session

**Tasks:**
1. Use Escape to interrupt
2. Use Tab for completions
3. Use Up/Down for history
4. Use Shift+Tab for mode switching
5. Master multi-line input

**Validation:**
- User demonstrates 5+ shortcuts
- Workflow speed improves measurably

**Artifact:** Personal keyboard shortcut notes

---

### F-08: Rewind and Recovery
**Difficulty:** Beginner  
**Time:** 20 min  
**Objective:** Use rewind to undo mistakes

**Setup:**
- Project with version control
- Task that will go wrong

**Tasks:**
1. Make Claude do something incorrect
2. Use `/rewind` to explore history
3. Rewind to before the mistake
4. Take alternative path
5. Compare outcomes

**Validation:**
- Successfully recovered from mistake
- User can explain rewind mechanics

**Artifact:** Before/after comparison notes

---

## Category 2: Configuration

*Focus: CLAUDE.md and project setup*

### C-01: First CLAUDE.md
**Difficulty:** Beginner  
**Time:** 20 min  
**Objective:** Create effective project documentation

**Setup:**
- Existing small project without CLAUDE.md
- Project has specific conventions

**Tasks:**
1. Analyze project structure
2. Create CLAUDE.md with:
   - Project overview
   - Key commands
   - File structure
   - Coding conventions
3. Test that Claude uses the context

**Validation:**
- Claude references CLAUDE.md in responses
- Context improves Claude's accuracy

**Artifact:** Working CLAUDE.md file

---

### C-02: Hierarchical CLAUDE.md
**Difficulty:** Intermediate  
**Time:** 25 min  
**Objective:** Use nested CLAUDE.md files

**Setup:**
- Monorepo with multiple packages
- Different conventions per package

**Tasks:**
1. Create root CLAUDE.md
2. Create package-specific CLAUDE.md files
3. Verify inheritance works correctly
4. Test override behavior

**Validation:**
- Nested files load correctly
- Overrides work as expected

**Artifact:** Hierarchical CLAUDE.md structure

---

### C-03: Settings Configuration
**Difficulty:** Intermediate  
**Time:** 20 min  
**Objective:** Configure project-level settings

**Setup:**
- Project needing custom settings
- Specific permission requirements

**Tasks:**
1. Create `.claude/settings.json`
2. Configure permissions
3. Set up command aliases
4. Configure MCP servers
5. Test all settings work

**Validation:**
- Settings load on startup
- All configurations function

**Artifact:** Complete settings.json file

---

### C-04: Team Sharing
**Difficulty:** Intermediate  
**Time:** 25 min  
**Objective:** Configure for team use

**Setup:**
- Shared project repository
- Multiple developers

**Tasks:**
1. Create shareable CLAUDE.md
2. Set up `.claude/` directory structure
3. Configure what to gitignore
4. Document for team onboarding

**Validation:**
- Configuration works for new clone
- Team can use without modification

**Artifact:** Team-ready configuration + README

---

### C-05: Personal vs Project Config
**Difficulty:** Intermediate  
**Time:** 20 min  
**Objective:** Understand config hierarchy

**Setup:**
- Personal preferences
- Project requirements that differ

**Tasks:**
1. Configure `~/.claude/` for personal defaults
2. Override in project `.claude/`
3. Test precedence rules
4. Document which wins

**Validation:**
- Correct config loads per context
- User can explain hierarchy

**Artifact:** Configuration hierarchy diagram

---

### C-06: Memory Configuration
**Difficulty:** Intermediate  
**Time:** 25 min  
**Objective:** Set up project memory

**Setup:**
- Project with information to remember
- Cross-session requirements

**Tasks:**
1. Use `/memory` to view current state
2. Add project-specific memories
3. Test persistence across sessions
4. Configure what to forget

**Validation:**
- Memory persists correctly
- User can manage memory effectively

**Artifact:** Memory management strategy doc

---

## Category 3: Context Engineering

*Focus: Managing context effectively*

### CE-01: Selective Loading
**Difficulty:** Intermediate  
**Time:** 25 min  
**Objective:** Load only relevant context

**Setup:**
- Large codebase (100+ files)
- Specific task requiring few files

**Tasks:**
1. Identify minimum required files
2. Use precise file mentions
3. Complete task with minimal context
4. Measure token usage

**Validation:**
- Task completed with <25% of codebase loaded
- Token usage tracked

**Artifact:** Context loading strategy doc

---

### CE-02: Progressive Disclosure
**Difficulty:** Intermediate  
**Time:** 30 min  
**Objective:** Load context incrementally

**Setup:**
- Complex multi-file task
- Dependencies between files

**Tasks:**
1. Start with high-level context
2. Dive deeper as needed
3. Track what was loaded when
4. Optimize loading sequence

**Validation:**
- Task completed efficiently
- Loading sequence documented

**Artifact:** Progressive loading playbook

---

### CE-03: Context Summarization
**Difficulty:** Intermediate  
**Time:** 25 min  
**Objective:** Create and use context summaries

**Setup:**
- Large file that exceeds context
- Need to reference throughout session

**Tasks:**
1. Ask Claude to summarize key points
2. Save summary to scratchpad
3. Reference summary instead of full file
4. Complete task using summary

**Validation:**
- Task completed without full file load
- Summary was sufficient

**Artifact:** Summary creation template

---

### CE-04: Multi-File Coordination
**Difficulty:** Intermediate  
**Time:** 30 min  
**Objective:** Manage context across many files

**Setup:**
- Feature requiring changes to 5+ files
- Files have interdependencies

**Tasks:**
1. Map file relationships
2. Plan loading sequence
3. Execute changes in order
4. Verify consistency across files

**Validation:**
- All files changed correctly
- No context overflow

**Artifact:** Multi-file coordination checklist

---

### CE-05: Image and Document Context
**Difficulty:** Intermediate  
**Time:** 25 min  
**Objective:** Use visual context effectively

**Setup:**
- Design mockup image
- Task to implement from mockup

**Tasks:**
1. Load image into context
2. Ask Claude to describe the design
3. Implement based on image
4. Compare result to mockup

**Validation:**
- Implementation matches mockup
- Image context used effectively

**Artifact:** Visual context workflow doc

---

### CE-06: URL and Web Context
**Difficulty:** Intermediate  
**Time:** 25 min  
**Objective:** Pull external context

**Setup:**
- Task requiring documentation reference
- External API to integrate

**Tasks:**
1. Use `/web` to fetch documentation
2. Extract relevant portions
3. Use fetched context in task
4. Handle outdated information

**Validation:**
- External docs integrated
- Task completed correctly

**Artifact:** Web context strategy doc

---

### CE-07: Conversation Branching
**Difficulty:** Advanced  
**Time:** 30 min  
**Objective:** Explore multiple approaches

**Setup:**
- Problem with multiple solutions
- Need to compare approaches

**Tasks:**
1. Reach decision point
2. Use rewind to create branch
3. Explore alternative approach
4. Compare both branches
5. Choose best outcome

**Validation:**
- Both approaches explored
- Comparison documented

**Artifact:** Decision tree documentation

---

### CE-08: Context Checkpointing
**Difficulty:** Advanced  
**Time:** 30 min  
**Objective:** Save and restore context states

**Setup:**
- Long-running complex task
- Risk of losing progress

**Tasks:**
1. Establish checkpoint strategy
2. Create context summary at key points
3. Simulate session loss
4. Restore from checkpoint
5. Continue successfully

**Validation:**
- Recovery worked smoothly
- No significant rework needed

**Artifact:** Checkpointing playbook

---

## Category 4: Skill Development

*Focus: Creating custom skills*

### SK-01: Anatomy of a Skill
**Difficulty:** Intermediate  
**Time:** 30 min  
**Objective:** Understand skill structure

**Setup:**
- Sample skill to analyze
- No prior skill knowledge

**Tasks:**
1. Read existing skill SKILL.md
2. Identify frontmatter fields
3. Map instruction sections
4. Understand when skill activates

**Validation:**
- Can explain all parts of a skill
- Can predict activation triggers

**Artifact:** Skill anatomy diagram

---

### SK-02: Hello Skill
**Difficulty:** Intermediate  
**Time:** 30 min  
**Objective:** Create first working skill

**Setup:**
- Empty skill directory
- Simple use case (greeting customization)

**Tasks:**
1. Create SKILL.md with frontmatter
2. Write clear description
3. Add instructions
4. Install skill locally
5. Test activation

**Validation:**
- Skill activates when expected
- Instructions followed correctly

**Artifact:** Working simple skill

---

### SK-03: Skill with Examples
**Difficulty:** Intermediate  
**Time:** 35 min  
**Objective:** Add examples to guide behavior

**Setup:**
- Skill that needs specific output format
- Inconsistent behavior without examples

**Tasks:**
1. Start with basic skill
2. Add input/output examples
3. Include edge cases
4. Test consistency improvement

**Validation:**
- Output format now consistent
- Examples referenced by Claude

**Artifact:** Example-rich skill

---

### SK-04: Skill with Scripts
**Difficulty:** Advanced  
**Time:** 45 min  
**Objective:** Include executable code in skill

**Setup:**
- Task requiring computation
- Pure instructions insufficient

**Tasks:**
1. Create skill with scripts/ directory
2. Write Python helper script
3. Reference script from SKILL.md
4. Test script execution

**Validation:**
- Script runs correctly
- Skill uses script output

**Artifact:** Skill with working script

---

### SK-05: Skill with Resources
**Difficulty:** Advanced  
**Time:** 40 min  
**Objective:** Bundle resources with skill

**Setup:**
- Skill needing templates or data
- Resources should load on demand

**Tasks:**
1. Create resources/ directory
2. Add template files
3. Reference resources from instructions
4. Verify lazy loading works

**Validation:**
- Resources load when needed
- Skill functions correctly

**Artifact:** Resource-bundled skill

---

### SK-06: Technology-Specific Skill
**Difficulty:** Advanced  
**Time:** 50 min  
**Objective:** Create skill for specific framework

**Setup:**
- Framework you use frequently
- Repetitive patterns to encode

**Tasks:**
1. Identify common patterns
2. Document best practices
3. Create comprehensive skill
4. Test across multiple projects

**Validation:**
- Skill improves framework work
- Patterns correctly applied

**Artifact:** Framework-specific skill

---

### SK-07: Workflow Skill
**Difficulty:** Advanced  
**Time:** 45 min  
**Objective:** Encode multi-step workflow

**Setup:**
- Complex workflow (e.g., PR review)
- Multiple steps with decision points

**Tasks:**
1. Map workflow steps
2. Create skill with phases
3. Include decision criteria
4. Test end-to-end workflow

**Validation:**
- Workflow completes correctly
- All steps executed in order

**Artifact:** Workflow skill

---

### SK-08: Composable Skills
**Difficulty:** Advanced  
**Time:** 50 min  
**Objective:** Create skills that work together

**Setup:**
- Two related capabilities
- Should activate together

**Tasks:**
1. Create first skill
2. Create complementary skill
3. Design activation conditions
4. Test combination behavior

**Validation:**
- Skills compose correctly
- No conflicts or confusion

**Artifact:** Skill composition pattern doc

---

### SK-09: Skill Testing
**Difficulty:** Advanced  
**Time:** 40 min  
**Objective:** Validate skill behavior

**Setup:**
- Skill to test
- Expected behaviors to verify

**Tasks:**
1. Create test prompts
2. Document expected outputs
3. Run systematic tests
4. Fix issues found
5. Create regression suite

**Validation:**
- All tests pass
- Regression suite documented

**Artifact:** Skill test suite

---

### SK-10: Skill Publishing
**Difficulty:** Advanced  
**Time:** 35 min  
**Objective:** Share skill with others

**Setup:**
- Completed skill
- GitHub account

**Tasks:**
1. Create repository
2. Add marketplace.json
3. Write documentation
4. Tag for discoverability
5. Submit to community list

**Validation:**
- Skill installable by others
- Documentation complete

**Artifact:** Published skill repo

---

## Category 5: Plugin Development

*Focus: Building full plugins with multiple components*

### PL-01: Plugin Structure
**Difficulty:** Advanced  
**Time:** 40 min  
**Objective:** Understand plugin architecture

**Setup:**
- Sample plugin to analyze
- Multiple component types

**Tasks:**
1. Examine plugin.json
2. Map directory structure
3. Identify all component types
4. Understand loading behavior

**Validation:**
- Can explain plugin structure
- Can predict component behavior

**Artifact:** Plugin architecture diagram

---

### PL-02: Command Plugin
**Difficulty:** Advanced  
**Time:** 45 min  
**Objective:** Create plugin with commands

**Setup:**
- Use case needing slash commands
- Related commands as a set

**Tasks:**
1. Create plugin scaffold
2. Add commands/ directory
3. Write multiple commands
4. Configure in plugin.json
5. Test all commands

**Validation:**
- Commands appear in / menu
- All commands function

**Artifact:** Working command plugin

---

### PL-03: Agent Plugin
**Difficulty:** Advanced  
**Time:** 50 min  
**Objective:** Create plugin with subagents

**Setup:**
- Complex task needing specialization
- Different expertise areas

**Tasks:**
1. Design agent responsibilities
2. Create agent definitions
3. Configure tool permissions
4. Test agent delegation

**Validation:**
- Agents activate correctly
- Permissions respected

**Artifact:** Multi-agent plugin

---

### PL-04: Skill Plugin
**Difficulty:** Advanced  
**Time:** 45 min  
**Objective:** Bundle skills into plugin

**Setup:**
- Related skills to package
- Distribution requirement

**Tasks:**
1. Organize skills in plugin
2. Configure marketplace.json
3. Set up dependencies
4. Test installation flow

**Validation:**
- All skills install together
- Dependencies resolved

**Artifact:** Skill bundle plugin

---

### PL-05: Hook Plugin
**Difficulty:** Advanced  
**Time:** 50 min  
**Objective:** Create event-driven plugin

**Setup:**
- Automation requirements
- Specific trigger events

**Tasks:**
1. Identify trigger events
2. Create hook handlers
3. Configure in plugin.json
4. Test event firing

**Validation:**
- Hooks trigger correctly
- Automation works

**Artifact:** Hook-based plugin

---

### PL-06: MCP Plugin
**Difficulty:** Expert  
**Time:** 60 min  
**Objective:** Plugin with MCP integration

**Setup:**
- External service to integrate
- API access available

**Tasks:**
1. Create MCP server
2. Bundle in plugin
3. Configure .mcp.json
4. Test tool exposure

**Validation:**
- MCP tools available
- Integration works

**Artifact:** MCP-integrated plugin

---

### PL-07: Full Plugin
**Difficulty:** Expert  
**Time:** 90 min  
**Objective:** Plugin with all component types

**Setup:**
- Complex use case
- Needs commands, agents, skills, hooks

**Tasks:**
1. Design all components
2. Implement each type
3. Ensure they work together
4. Document thoroughly

**Validation:**
- All components function
- Integration is seamless

**Artifact:** Comprehensive plugin

---

### PL-08: Plugin Marketplace
**Difficulty:** Expert  
**Time:** 60 min  
**Objective:** Create your own marketplace

**Setup:**
- Multiple plugins to distribute
- Team/community audience

**Tasks:**
1. Create marketplace repo
2. Write marketplace.json
3. Add multiple plugins
4. Document installation

**Validation:**
- Marketplace installable
- All plugins accessible

**Artifact:** Working marketplace

---

## Category 6: Commands & Agents

*Focus: Custom commands and subagents*

### CA-01: Simple Command
**Difficulty:** Intermediate  
**Time:** 25 min  
**Objective:** Create basic slash command

**Setup:**
- Repetitive task to automate
- Single-action requirement

**Tasks:**
1. Create commands/ directory
2. Write command markdown
3. Install locally
4. Test invocation

**Validation:**
- Command appears in menu
- Executes correctly

**Artifact:** Working slash command

---

### CA-02: Parameterized Command
**Difficulty:** Intermediate  
**Time:** 30 min  
**Objective:** Command with arguments

**Setup:**
- Task needing user input
- Variable parameters

**Tasks:**
1. Use $ARGUMENTS in command
2. Handle parameter parsing
3. Provide usage examples
4. Test with various inputs

**Validation:**
- Arguments passed correctly
- Edge cases handled

**Artifact:** Parameterized command

---

### CA-03: Multi-Step Command
**Difficulty:** Intermediate  
**Time:** 35 min  
**Objective:** Command with workflow

**Setup:**
- Complex multi-step task
- Clear sequence required

**Tasks:**
1. Write step-by-step instructions
2. Include decision points
3. Add verification steps
4. Test full workflow

**Validation:**
- All steps execute in order
- Workflow completes correctly

**Artifact:** Workflow command

---

### CA-04: First Subagent
**Difficulty:** Advanced  
**Time:** 40 min  
**Objective:** Create specialized agent

**Setup:**
- Task requiring focus
- Specific expertise needed

**Tasks:**
1. Create agents/ directory
2. Define agent role
3. Set tool permissions
4. Configure context
5. Test delegation

**Validation:**
- Agent activates when called
- Stays in role

**Artifact:** Working subagent

---

### CA-05: Agent with Tools
**Difficulty:** Advanced  
**Time:** 45 min  
**Objective:** Configure agent tool access

**Setup:**
- Agent needing limited tools
- Security considerations

**Tasks:**
1. Define tool allowlist
2. Set file access limits
3. Configure network access
4. Test permission boundaries

**Validation:**
- Agent respects limits
- Can't exceed permissions

**Artifact:** Secure agent configuration

---

### CA-06: Agent Orchestration
**Difficulty:** Advanced  
**Time:** 50 min  
**Objective:** Multiple agents working together

**Setup:**
- Complex task with subtasks
- Different expertise needed

**Tasks:**
1. Design agent team
2. Create each agent
3. Define handoff patterns
4. Test coordination

**Validation:**
- Agents coordinate correctly
- Task completed together

**Artifact:** Agent orchestration pattern

---

### CA-07: Review Agent
**Difficulty:** Advanced  
**Time:** 45 min  
**Objective:** Create code review agent

**Setup:**
- Codebase to review
- Review criteria defined

**Tasks:**
1. Create reviewer agent
2. Define review checklist
3. Configure output format
4. Test on sample code

**Validation:**
- Reviews are thorough
- Format is consistent

**Artifact:** Code review agent

---

### CA-08: Testing Agent
**Difficulty:** Advanced  
**Time:** 45 min  
**Objective:** Create test-writing agent

**Setup:**
- Code needing tests
- Testing framework chosen

**Tasks:**
1. Create tester agent
2. Define testing patterns
3. Configure test generation
4. Test output quality

**Validation:**
- Tests are valid
- Coverage improves

**Artifact:** Test generation agent

---

## Category 7: Hooks & Automation

*Focus: Event-driven automation*

### H-01: First Hook
**Difficulty:** Advanced  
**Time:** 35 min  
**Objective:** Create simple event hook

**Setup:**
- Action to automate
- Clear trigger event

**Tasks:**
1. Identify trigger (PreToolUse, PostToolUse, etc.)
2. Create hook in settings
3. Write handler script
4. Test event firing

**Validation:**
- Hook fires on event
- Handler executes correctly

**Artifact:** Working hook configuration

---

### H-02: File Save Hook
**Difficulty:** Advanced  
**Time:** 40 min  
**Objective:** Auto-format on save

**Setup:**
- Project needing formatting
- Formatter configured

**Tasks:**
1. Create PostToolUse hook
2. Match Edit/Write tools
3. Run formatter on files
4. Handle errors gracefully

**Validation:**
- Files formatted automatically
- No broken saves

**Artifact:** Auto-format hook

---

### H-03: Commit Hook
**Difficulty:** Advanced  
**Time:** 45 min  
**Objective:** Validate before commit

**Setup:**
- Project with tests
- Pre-commit requirements

**Tasks:**
1. Create hook for git operations
2. Run tests before commit
3. Block if tests fail
4. Provide clear feedback

**Validation:**
- Bad commits blocked
- Good commits proceed

**Artifact:** Pre-commit validation hook

---

### H-04: Session Start Hook
**Difficulty:** Advanced  
**Time:** 40 min  
**Objective:** Initialize session context

**Setup:**
- Project needing context setup
- Information to inject

**Tasks:**
1. Create SessionStart hook
2. Gather relevant context
3. Inject into session
4. Verify context available

**Validation:**
- Context loads on start
- Session begins informed

**Artifact:** Session initialization hook

---

### H-05: Notification Hook
**Difficulty:** Advanced  
**Time:** 35 min  
**Objective:** Custom notifications

**Setup:**
- Long-running tasks
- Need for alerts

**Tasks:**
1. Create Notification hook
2. Integrate with alert system
3. Configure trigger conditions
4. Test notifications

**Validation:**
- Notifications arrive correctly
- Not too noisy

**Artifact:** Notification system hook

---

### H-06: Hook Chain
**Difficulty:** Expert  
**Time:** 50 min  
**Objective:** Multiple hooks working together

**Setup:**
- Complex automation needs
- Multiple trigger points

**Tasks:**
1. Design hook sequence
2. Implement each hook
3. Handle dependencies
4. Test full chain

**Validation:**
- All hooks fire correctly
- Chain completes end-to-end

**Artifact:** Hook chain documentation

---

## Category 8: MCP Development

*Focus: Building MCP servers*

### MCP-01: MCP Basics
**Difficulty:** Advanced  
**Time:** 40 min  
**Objective:** Understand MCP architecture

**Setup:**
- Sample MCP server
- Claude Code with MCP enabled

**Tasks:**
1. Examine MCP server code
2. Identify protocol elements
3. Trace tool exposure
4. Understand lifecycle

**Validation:**
- Can explain MCP architecture
- Can identify tool definitions

**Artifact:** MCP architecture notes

---

### MCP-02: Hello MCP
**Difficulty:** Advanced  
**Time:** 50 min  
**Objective:** Create first MCP server

**Setup:**
- Simple capability to expose
- TypeScript or Python environment

**Tasks:**
1. Scaffold MCP server
2. Define simple tool
3. Implement handler
4. Connect to Claude Code
5. Test tool invocation

**Validation:**
- Tool appears in Claude
- Invocation works

**Artifact:** Working minimal MCP server

---

### MCP-03: MCP with State
**Difficulty:** Advanced  
**Time:** 55 min  
**Objective:** Stateful MCP server

**Setup:**
- Tool needing persistent state
- Session or file-based storage

**Tasks:**
1. Add state management
2. Handle state persistence
3. Manage concurrency
4. Test state consistency

**Validation:**
- State persists correctly
- No race conditions

**Artifact:** Stateful MCP server

---

### MCP-04: External API MCP
**Difficulty:** Expert  
**Time:** 60 min  
**Objective:** Wrap external API as MCP

**Setup:**
- External API to integrate
- API credentials

**Tasks:**
1. Design tool surface
2. Implement API calls
3. Handle authentication
4. Manage errors

**Validation:**
- API accessible through MCP
- Errors handled gracefully

**Artifact:** API wrapper MCP server

---

### MCP-05: Database MCP
**Difficulty:** Expert  
**Time:** 60 min  
**Objective:** Database access through MCP

**Setup:**
- Database to query
- Read-only requirements

**Tasks:**
1. Connect to database
2. Expose query tools
3. Implement safety checks
4. Handle large results

**Validation:**
- Queries work correctly
- Safety measures enforced

**Artifact:** Database MCP server

---

### MCP-06: Full MCP Suite
**Difficulty:** Expert  
**Time:** 90 min  
**Objective:** Complete MCP with multiple tools

**Setup:**
- Complex capability set
- Multiple related tools

**Tasks:**
1. Design tool suite
2. Implement all tools
3. Add documentation
4. Create installation guide

**Validation:**
- All tools function
- Documentation complete

**Artifact:** Production-ready MCP server

---

## Category 9: Workflow Patterns

*Focus: Advanced usage patterns*

### W-01: Parallel Sessions
**Difficulty:** Advanced  
**Time:** 40 min  
**Objective:** Run multiple Claude instances

**Setup:**
- Multi-part task
- Independent subtasks

**Tasks:**
1. Open multiple terminals
2. Start Claude in each
3. Assign different tasks
4. Coordinate results

**Validation:**
- All tasks complete
- Results combined correctly

**Artifact:** Parallel workflow documentation

---

### W-02: Git Worktrees
**Difficulty:** Advanced  
**Time:** 50 min  
**Objective:** Use worktrees for parallel work

**Setup:**
- Repository with branches
- Multiple features to develop

**Tasks:**
1. Create git worktrees
2. Run Claude in each
3. Develop features in parallel
4. Merge results

**Validation:**
- Features developed independently
- Clean merge

**Artifact:** Worktree workflow guide

---

### W-03: Claude-to-Claude
**Difficulty:** Expert  
**Time:** 55 min  
**Objective:** Claude instances communicating

**Setup:**
- Task needing review/iteration
- Writer and reviewer pattern

**Tasks:**
1. Set up two Claude sessions
2. Create shared scratchpad
3. Writer produces, reviewer reviews
4. Iterate to completion

**Validation:**
- Iteration improves output
- Communication works

**Artifact:** Claude-to-Claude pattern doc

---

### W-04: Headless Automation
**Difficulty:** Expert  
**Time:** 50 min  
**Objective:** Run Claude without interaction

**Setup:**
- Repeatable task
- Script/CI environment

**Tasks:**
1. Use `-p` flag for headless
2. Handle `--output-format`
3. Parse structured output
4. Integrate in script

**Validation:**
- Automation works reliably
- Output parsed correctly

**Artifact:** Headless automation script

---

### W-05: GitHub Actions Integration
**Difficulty:** Expert  
**Time:** 60 min  
**Objective:** Claude in CI/CD pipeline

**Setup:**
- GitHub repository
- Automation requirements

**Tasks:**
1. Create GitHub Action workflow
2. Configure Claude action
3. Set up triggers
4. Handle outputs

**Validation:**
- Action runs on trigger
- Results posted to PR

**Artifact:** Working GitHub Action

---

### W-06: Swarm Patterns
**Difficulty:** Expert  
**Time:** 60 min  
**Objective:** Orchestrate multiple agents

**Setup:**
- Large-scale task
- Parallelizable subtasks

**Tasks:**
1. Design swarm architecture
2. Create orchestrator
3. Implement workers
4. Aggregate results

**Validation:**
- Swarm completes task
- Results correctly aggregated

**Artifact:** Swarm pattern implementation

---

## Category 10: Real-World Scenarios

*Focus: Practical applications*

### RW-01: Bug Hunt (React)
**Difficulty:** Beginner-Intermediate  
**Time:** 30 min  
**Tech:** React, TypeScript

**Setup:**
- React application with 3 bugs
- Test suite that fails

**Tasks:**
1. Identify failing tests
2. Use Claude to debug
3. Fix all bugs
4. All tests pass

**Validation:**
- All tests pass
- Bugs correctly fixed

---

### RW-02: Bug Hunt (Python API)
**Difficulty:** Beginner-Intermediate  
**Time:** 30 min  
**Tech:** Python, FastAPI

**Setup:**
- FastAPI service with bugs
- Failing integration tests

**Tasks:**
1. Run tests, see failures
2. Debug with Claude
3. Fix API issues
4. Tests pass

**Validation:**
- All tests pass
- API functions correctly

---

### RW-03: Feature Addition (Node.js)
**Difficulty:** Intermediate  
**Time:** 45 min  
**Tech:** Node.js, Express

**Setup:**
- Express API
- New endpoint requirement

**Tasks:**
1. Understand existing patterns
2. Plan new endpoint
3. Implement with Claude
4. Add tests

**Validation:**
- New endpoint works
- Tests cover functionality

---

### RW-04: Feature Addition (Django)
**Difficulty:** Intermediate  
**Time:** 45 min  
**Tech:** Python, Django

**Setup:**
- Django application
- New model and view needed

**Tasks:**
1. Understand Django patterns
2. Create model
3. Add view and template
4. Test functionality

**Validation:**
- Feature works end-to-end
- Follows Django conventions

---

### RW-05: Refactoring (Legacy Code)
**Difficulty:** Intermediate-Advanced  
**Time:** 50 min  
**Tech:** Any

**Setup:**
- Messy legacy code
- Refactoring requirements

**Tasks:**
1. Analyze code smells
2. Plan refactoring
3. Refactor incrementally
4. Verify behavior unchanged

**Validation:**
- Tests still pass
- Code improved measurably

---

### RW-06: Test Coverage
**Difficulty:** Intermediate  
**Time:** 40 min  
**Tech:** Any

**Setup:**
- Code with low coverage
- Coverage report available

**Tasks:**
1. Analyze coverage gaps
2. Write missing tests
3. Achieve target coverage
4. Tests are meaningful

**Validation:**
- Coverage target met
- Tests are quality

---

### RW-07: Documentation
**Difficulty:** Intermediate  
**Time:** 35 min  
**Tech:** Any

**Setup:**
- Undocumented codebase
- Need README and API docs

**Tasks:**
1. Analyze codebase
2. Generate README
3. Document API endpoints
4. Add inline comments

**Validation:**
- Docs are accurate
- New dev could onboard

---

### RW-08: Security Audit
**Difficulty:** Advanced  
**Time:** 50 min  
**Tech:** Any

**Setup:**
- Application with vulnerabilities
- Security checklist

**Tasks:**
1. Scan for vulnerabilities
2. Prioritize by severity
3. Fix critical issues
4. Document findings

**Validation:**
- Critical issues fixed
- Audit report complete

---

### RW-09: Performance Optimization
**Difficulty:** Advanced  
**Time:** 50 min  
**Tech:** Any

**Setup:**
- Slow application
- Performance targets

**Tasks:**
1. Profile performance
2. Identify bottlenecks
3. Optimize hot paths
4. Verify improvement

**Validation:**
- Performance improved
- Targets met

---

### RW-10: Database Migration
**Difficulty:** Advanced  
**Time:** 55 min  
**Tech:** SQL/ORM

**Setup:**
- Schema change required
- Data migration needed

**Tasks:**
1. Plan migration
2. Create migration scripts
3. Test on sample data
4. Verify data integrity

**Validation:**
- Migration works
- No data loss

---

### RW-11: API Integration
**Difficulty:** Advanced  
**Time:** 50 min  
**Tech:** Any

**Setup:**
- External API to integrate
- SDK or raw HTTP

**Tasks:**
1. Understand API docs
2. Implement integration
3. Handle errors
4. Add tests/mocks

**Validation:**
- Integration works
- Errors handled gracefully

---

### RW-12: Full Feature (End-to-End)
**Difficulty:** Advanced  
**Time:** 90 min  
**Tech:** Full stack

**Setup:**
- Feature specification
- Existing codebase

**Tasks:**
1. Plan implementation
2. Backend changes
3. Frontend changes
4. Tests and docs

**Validation:**
- Feature complete
- All tests pass

---

## Test Repository Specifications

### Repository Structure Pattern

Each test repository follows this structure:

```
exercise-name/
├── README.md              # Exercise instructions
├── SOLUTION.md            # Reference solution (hidden initially)
├── .validation/           # Validation scripts
│   ├── check.sh           # Main validation script
│   ├── tests/             # Test files
│   └── expected/          # Expected outputs
├── src/                   # Starting code
├── docs/                  # Any needed docs
└── .claude/               # Pre-configured settings (if needed)
```

### Validation Approach

1. **Automated tests:** Unit/integration tests that must pass
2. **Output comparison:** Expected vs actual file comparison
3. **Lint/format checks:** Code quality requirements
4. **Manual checkpoints:** Self-verification prompts

### Difficulty Calibration

| Level | Time | Files Changed | Concepts | Prerequisites |
|-------|------|---------------|----------|---------------|
| Beginner | 15-25 min | 1-2 | 1-2 | None |
| Intermediate | 25-40 min | 2-5 | 2-3 | Fundamentals |
| Advanced | 40-60 min | 3-8 | 3-5 | Intermediate |
| Expert | 60-90 min | 5-15 | 5+ | Advanced |

---

## Repository Count by Technology

### Frontend
| Tech | Repos | Difficulty Range |
|------|-------|------------------|
| React + TypeScript | 5 | Beginner-Advanced |
| Vue.js | 2 | Intermediate |
| Next.js | 3 | Intermediate-Advanced |
| Vanilla JS | 2 | Beginner |

### Backend
| Tech | Repos | Difficulty Range |
|------|-------|------------------|
| Python (FastAPI) | 4 | Beginner-Advanced |
| Python (Django) | 3 | Intermediate-Advanced |
| Node.js (Express) | 4 | Beginner-Advanced |
| Go | 2 | Advanced |

### Full Stack
| Tech | Repos | Difficulty Range |
|------|-------|------------------|
| Next.js + Prisma | 2 | Advanced |
| Django + React | 2 | Advanced |
| MERN Stack | 2 | Intermediate-Advanced |

### Extension Development
| Type | Repos | Difficulty Range |
|------|-------|------------------|
| Skill creation | 5 | Intermediate-Advanced |
| Plugin development | 3 | Advanced-Expert |
| MCP server | 3 | Advanced-Expert |

**Total: ~40 test repositories**

---

## Rollout Plan

### Phase 1: Core Exercises (8 weeks)
- Fundamentals (8 exercises)
- Configuration (6 exercises)
- 3 test repositories

### Phase 2: Intermediate (8 weeks)
- Context Engineering (8 exercises)
- Skill Development (10 exercises)
- Commands & Agents (8 exercises)
- 10 test repositories

### Phase 3: Advanced (8 weeks)
- Plugin Development (8 exercises)
- Hooks & Automation (6 exercises)
- MCP Development (6 exercises)
- Workflow Patterns (6 exercises)
- 15 test repositories

### Phase 4: Real-World (8 weeks)
- Real-World Scenarios (12 exercises)
- 12 test repositories
- Community contributions enabled

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Exercises completed per user | 12+ |
| Average completion rate | 75%+ |
| Time accuracy (actual vs estimate) | ±20% |
| User satisfaction rating | 4.2+/5 |
| Repeat usage (same exercise) | 15%+ |
| Community exercise submissions | 20/month |

---

## Sources

Thomas, Dave. "CodeKata." *CodeKata.com*, 2003, http://codekata.com/.

Princeton NLP. "SWE-bench: Can Language Models Resolve Real-world Github Issues?" *GitHub*, 2024, https://github.com/SWE-bench/SWE-bench.

Amazon Science. "SWE-PolyBench: A Multi-language Benchmark for Repository Level Evaluation of Coding Agents." *GitHub*, 2025, https://github.com/amazon-science/SWE-PolyBench.

Gamontal. "Awesome Katas." *GitHub*, 2023, https://github.com/gamontal/awesome-katas.

Coding Dojo. "Kata." *CodingDojo.org*, 2024, https://codingdojo.org/kata/.

Codewars. "Achieve Mastery Through Coding Practice." 2024, https://www.codewars.com/.

Hyett, Alex. "Code Katas: Can They Make You A Better Developer?" *AlexHyett.com*, 2023, https://www.alexhyett.com/code-katas-better-developer/.
