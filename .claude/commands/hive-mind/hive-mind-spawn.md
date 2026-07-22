# hive-mind-spawn

Spawn worker agents into the Hive Mind, optionally launching Claude Code with a queen-led coordination objective.

## Usage
```bash
npx -y ruflo@3.14.2 hive-mind spawn [options]
```

There is no positional objective in v3 — pass it via `-o/--objective` (used together with `--claude`).

## Options
- `-n, --count <n>` - Number of workers to spawn (default: `1`)
- `-r, --role <role>` - Worker role: `worker`, `specialist`, `scout` (default: `worker`)
- `-t, --type <type>` - Agent type (default: `worker`)
- `-p, --prefix <prefix>` - Prefix for worker IDs (default: `hive-worker`)
- `--claude` - Launch Claude Code with a hive-mind coordination prompt
- `-o, --objective <text>` - Objective for the hive mind (used with `--claude`)
- `--dangerously-skip-permissions` - Skip permission prompts in Claude Code (default: `true`)
- `--no-auto-permissions` - Disable automatic permission skipping (default: `false`)

`--queen-type` no longer exists — v3 spawn has no queen-type concept. `--max-workers` moved to `hive-mind init -m/--max-agents`; `--consensus` moved to `hive-mind init -c/--consensus` (both are set once at `init` time, not per-spawn).

## Examples
```bash
npx -y ruflo@3.14.2 hive-mind spawn --claude -o "Build API"
npx -y ruflo@3.14.2 hive-mind spawn -n 3 -r specialist
npx -y ruflo@3.14.2 hive-mind spawn --claude -o "Build service"
```
