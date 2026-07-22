# hive-mind-init

Initialize the Hive Mind collective intelligence system.

## Usage
```bash
npx -y ruflo@3.14.2 hive-mind init [options]
```

## Options
- `-t, --topology <type>` - Hive topology (default: `hierarchical-mesh`)
- `-c, --consensus <type>` - Consensus strategy (default: `byzantine`) — note `-c` is consensus here, not config
- `-m, --max-agents <n>` - Maximum agents (default: `15`)
- `-p, --persist` - Enable persistent state (default: `true`)
- `--memory-backend <type>` - Memory backend: `agentdb`, `sqlite`, `hybrid` (default: `hybrid`)

`--force` and `--config <file>` from earlier versions do not exist in v3 — there is no forced-reinit flag and no separate config-file flag (`-c` is claimed by `--consensus`).

## Examples
```bash
npx -y ruflo@3.14.2 hive-mind init
npx -y ruflo@3.14.2 hive-mind init -t hierarchical-mesh -m 20
```
