# issue-triage

Intelligent issue classification and triage.

## Usage

`github issue-triage` is not a CLI verb in v3 — `github` survives only as 5 MCP tools. The nearest is `mcp__ruflo__github_issue_track`, which is differently named and shaped than the old CLI verb; don't assume a 1:1 flag mapping. CLI escape hatch:

```bash
npx -y ruflo@3.14.2 mcp exec -t github_issue_track -p '{"repo":"owner/repo"}'
```

## Options

Param schemas aren't exposed by `mcp tools --format json` — verify the exact param keys at call time. There's no tool-level equivalent for the old `--auto-label`/`--assign` flags: applying labels and assigning issues to team members is agent behavior layered on top of the tool's classification output (e.g. driving `gh issue edit <n> --add-label ... --add-assignee ...`), not a parameter the tool itself exposes.

- `repo` (`owner/repo`) - Target repository

## Examples

```bash
# Triage issues via the CLI escape hatch
npx -y ruflo@3.14.2 mcp exec -t github_issue_track -p '{"repo":"myorg/myrepo"}'
```

Labeling and assignment are then agent-driven follow-up actions (e.g. `gh issue edit`), not `github_issue_track` parameters.
