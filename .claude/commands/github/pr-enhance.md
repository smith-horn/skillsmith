# pr-enhance

AI-powered pull request enhancements.

## Usage

`github pr-enhance` is not a CLI verb in v3 — `github` survives only as 5 MCP tools. PR operations partially map to `mcp__ruflo__github_pr_manage`, but "enhancement" (adding tests, improving docs, a security review) is agent-driven work performed on top of that tool's PR data, not a flag the tool exposes. CLI escape hatch:

```bash
npx -y ruflo@3.14.2 mcp exec -t github_pr_manage -p '{"repo":"owner/repo","prNumber":123}'
```

## Options

Param schemas aren't exposed by `mcp tools --format json` — verify the exact param keys at call time. The old `--add-tests`/`--improve-docs`/`--check-security` flags have no tool-level equivalent: each is agent behavior (reading the PR diff via `github_pr_manage`, then writing tests/docs/security fixes as ordinary edits), not a parameter.

- `repo` (`owner/repo`) - Repository containing the pull request
- `prNumber` - Pull request number

## Examples

```bash
# Fetch/manage PR data via the CLI escape hatch
npx -y ruflo@3.14.2 mcp exec -t github_pr_manage -p '{"repo":"myorg/myrepo","prNumber":123}'
```

The agent then performs the enhancement itself — adding tests, improving docs, or a security review — as ordinary file edits, not further tool flags.
