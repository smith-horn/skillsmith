# github swarm

Create a specialized swarm for GitHub repository management.

## Usage

There is no GitHub-specialized swarm CLI verb or MCP tool in v3. `github swarm` doesn't exist as a command, and the MCP tool this file used to reference (`github_swarm`) isn't in the v3 registry — `github` survives only as 5 MCP tools (`github_repo_analyze`, `github_pr_manage`, `github_issue_track`, `github_workflow`, `github_metrics`), none of which is a swarm orchestrator. There is no 1:1 mapping from the old `--repository`/`--agents`/`--focus`/`--auto-pr`/`--issue-labels`/`--code-review` options onto anything in v3.

A similar outcome — a swarm scoped to GitHub repository work — is achieved by composing two separate, generic v3 surfaces instead of one purpose-built command:

- **`ruflo swarm`** (the generic swarm CLI/MCP surface — `swarm init`, `mcp__ruflo__agent_spawn`, `swarm status`, etc.) to stand up and coordinate the agents
- **the `github_*` MCP tools** for the agents to actually act on the repository

### Composing the equivalent

1. Initialize a generic swarm (CLI: `npx -y ruflo@3.14.2 swarm init`; MCP: `mcp__ruflo__swarm_init`), choosing a topology and agent count that fit the work.
2. Spawn agents for the roles you need (`mcp__ruflo__agent_spawn`), each briefed to call the appropriate `github_*` tool — e.g. an agent using `mcp__ruflo__github_issue_track` for triage, another using `mcp__ruflo__github_pr_manage` for PR review, another using `mcp__ruflo__github_repo_analyze` for a repository health check.
3. Coordinate and monitor with the generic swarm surface (`npx -y ruflo@3.14.2 swarm status`; MCP `mcp__ruflo__swarm_status`) rather than a GitHub-specific monitor.

There is no single "full-featured triage swarm" one-liner as before, and no `-r`/`-a`/`-f` flag set to carry forward — the equivalent is this generic-swarm-plus-`github_*`-tools composition, tuned per task rather than driven by dedicated GitHub-swarm flags.

## Agent Types

### Issue Triager

- Analyzes and categorizes issues
- Suggests labels and priorities
- Identifies duplicates and related issues

### PR Reviewer

- Reviews code changes
- Suggests improvements
- Checks for best practices

### Documentation Agent

- Updates README files
- Creates API documentation
- Maintains changelog

### Test Agent

- Identifies missing tests
- Suggests test cases
- Validates test coverage

### Security Agent

- Scans for vulnerabilities
- Reviews dependencies
- Suggests security improvements

## Workflows

### Issue Triage Workflow

1. Scan all open issues
2. Categorize by type and priority
3. Apply appropriate labels
4. Suggest assignees
5. Link related issues

### PR Enhancement Workflow

1. Analyze PR changes
2. Suggest missing tests
3. Improve documentation
4. Format code consistently
5. Add helpful comments

### Repository Health Check

1. Analyze code quality metrics
2. Review dependency status
3. Check test coverage
4. Assess documentation completeness
5. Generate health report

## Integration with Claude Code

There is no single `github_swarm` tool call that replaces the whole workflow. Instead, spawn agents via `mcp__ruflo__agent_spawn` and have each one call the specific `github_*` MCP tool it needs, for example:

```javascript
mcp__ruflo__github_repo_analyze({ repo: "owner/repo" })
```

Coordinate the resulting agents with the generic swarm surface (`mcp__ruflo__swarm_init` / `mcp__ruflo__swarm_status`), not a GitHub-specific one.

## See Also

- [repo-analyze.md](repo-analyze.md) - Deep repository analysis (`mcp__ruflo__github_repo_analyze`)
- [pr-enhance.md](pr-enhance.md) - Enhance pull requests (`mcp__ruflo__github_pr_manage`)
- [issue-triage.md](issue-triage.md) - Intelligent issue management (`mcp__ruflo__github_issue_track`)
- [code-review.md](code-review.md) - Automated reviews (`mcp__ruflo__github_pr_manage` + `mcp__ruflo__analyze_diff`)
