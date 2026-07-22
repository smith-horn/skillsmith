# repo-analyze

Deep analysis of GitHub repository with AI insights.

## Usage

`github repo-analyze` is not a CLI verb in v3 — `github` survives only as 5 MCP tools. This one maps 1:1 to `mcp__ruflo__github_repo_analyze`. Call it directly from Claude Code, or via the CLI escape hatch:

```bash
npx -y ruflo@3.14.2 mcp exec -t github_repo_analyze -p '{"repo":"owner/repo"}'
```

## Options

Param schemas aren't exposed by `mcp tools --format json` — verify the exact param keys at call time rather than assuming the shape below. The old `--deep`/`--include` flags have no confirmed v3 equivalent and are dropped rather than carried forward unverified.

- `repo` (`owner/repo`) - Repository to analyze

## Examples

```bash
# Basic analysis via the CLI escape hatch
npx -y ruflo@3.14.2 mcp exec -t github_repo_analyze -p '{"repo":"myorg/myrepo"}'
```

Or call the tool directly from Claude Code: `mcp__ruflo__github_repo_analyze`.
