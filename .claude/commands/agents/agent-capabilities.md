# agent-capabilities

Matrix of agent capabilities and their specializations.

## Capability Matrix

| Agent Type | Primary Skills | Best For |
|------------|---------------|----------|
| coder | Implementation, debugging | Feature development |
| researcher | Analysis, synthesis | Requirements gathering |
| tester | Testing, validation | Quality assurance |
| architect | Design, planning | System architecture |

## Querying Capabilities

`agents capabilities` does not exist in v3 — there is no `capabilities` subcommand. Use `agent list` (optionally filtered by `--type`) to enumerate agents, and `agent status <id>` to inspect a specific instance; this file's capability matrix above remains the reference for what each type is best suited for.

```bash
# List all agent types
npx -y ruflo@3.14.2 agent list

# Filter by type
agent list --type coder

# Inspect a specific agent instance
agent status <id>
```
