# workflow-execute

Run saved workflows.

## Usage
```bash
npx -y ruflo@3.14.2 workflow run [options]
```

`workflow execute` is not a v3 subcommand — the verb is `run`, not `execute`. There is also no `--name`/name-addressing: point `run` at a workflow definition file (`-f`) or a built-in template (`-t`).

## Options
- `-t/--template <name>` - Built-in template (`development`, `research`, `testing`, `security-audit`, `code-review`, `refactoring`, `sparc`, `custom`)
- `-f/--file <path>` - Workflow definition file (YAML/JSON)
- `--task <description>` - Task description
- `-p/--parallel` - Run steps in parallel
- `-m/--max-agents <n>` - Maximum agents
- `--timeout <ms>` - Execution timeout
- `-d/--dry-run` - Preview execution without running it

## Examples
```bash
# Run a workflow from a definition file (old: --name "deploy-api")
npx -y ruflo@3.14.2 workflow run -f ./deploy-api.yaml

# Run a built-in template with a task — there is no --params flag;
# parameters live in the workflow file itself, not on the command line
workflow run -t testing --task "run the test suite for staging"

# Dry run (old: --name "deploy-api" --dry-run)
workflow run -f ./deploy-api.yaml --dry-run
```
