# swarm-strategies

Reference for v3 `swarm init` / `swarm start` `-s/--strategy` accepted values.

`swarm swarm-strategies` was never a valid command in any version — the old v2 "list strategies" concept doesn't exist as a subcommand in v3. `--strategy` is a flag on `swarm init` and `swarm start`; its accepted values are not printed by `--help` (see U3 in the CLI migration plan), but are confirmed here directly against the installed `ruflo@3.14.2` (`@claude-flow/cli`) package source — the `STRATEGIES` array in `swarm.js`:

- `specialized` - Clear roles, no overlap (anti-drift)
- `balanced` - Even distribution of work
- `adaptive` - Dynamic strategy based on task
- `research` - Distributed research and analysis
- `development` - Collaborative code development (default)
- `testing` - Comprehensive test coverage
- `optimization` - Performance optimization
- `maintenance` - Codebase maintenance and refactoring
- `analysis` - Code analysis and documentation

## Usage
```bash
npx -y ruflo@3.14.2 swarm start -o "<objective>" -s <strategy>
```

## Example
```bash
swarm start -o "Refactor the auth module" -s maintenance
```

Any `--strategy` value not in this list should be treated as unverified. Per the CLI migration plan's U3 split rule, do not fall back to a topology value (`hierarchical`/`mesh`) for an unrecognized strategy — omit `--strategy` entirely instead.
