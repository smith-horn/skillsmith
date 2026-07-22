# code-review

Automated code review with swarm intelligence.

## Usage

`github code-review` is not a CLI verb in v3, and the MCP tool it used to call (`github_code_review`) has been removed with no direct successor. There is no single command that reproduces this file's old behavior — achieve it by combining two separate v3 surfaces:

- `mcp__ruflo__github_pr_manage` for the PR-level operations (fetching/managing the pull request itself)
- the v3 `analyze` family for review intelligence: `mcp__ruflo__analyze_diff`, plus `mcp__ruflo__analyze_diff-risk` (risk scoring) and `mcp__ruflo__analyze_diff-reviewers` (reviewer suggestions)

CLI escape hatch for each tool:

```bash
npx -y ruflo@3.14.2 mcp exec -t github_pr_manage -p '{"repo":"owner/repo","prNumber":456}'
npx -y ruflo@3.14.2 mcp exec -t analyze_diff -p '{"repo":"owner/repo","prNumber":456}'
npx -y ruflo@3.14.2 mcp exec -t analyze_diff-risk -p '{"repo":"owner/repo","prNumber":456}'
npx -y ruflo@3.14.2 mcp exec -t analyze_diff-reviewers -p '{"repo":"owner/repo","prNumber":456}'
```

## Options

Param schemas aren't exposed by `mcp tools --format json` — verify the exact param keys at call time. The old `--focus`/`--suggest-fixes` flags have no tool-level equivalent; focusing on a review area (security, performance, style) and suggesting fixes are agent behaviors layered on top of `analyze_diff`'s output, not parameters any of these tools accept.

- `repo` (`owner/repo`) - Repository containing the pull request
- `prNumber` - Pull request to review

## Examples

```bash
# PR data
npx -y ruflo@3.14.2 mcp exec -t github_pr_manage -p '{"repo":"myorg/myrepo","prNumber":456}'

# Diff analysis: risk score + reviewer suggestions
npx -y ruflo@3.14.2 mcp exec -t analyze_diff -p '{"repo":"myorg/myrepo","prNumber":456}'
npx -y ruflo@3.14.2 mcp exec -t analyze_diff-risk -p '{"repo":"myorg/myrepo","prNumber":456}'
npx -y ruflo@3.14.2 mcp exec -t analyze_diff-reviewers -p '{"repo":"myorg/myrepo","prNumber":456}'
```

A focused review (e.g. "security only") or fix suggestions are agent-driven synthesis of the diff-analysis output, not additional tool flags.
