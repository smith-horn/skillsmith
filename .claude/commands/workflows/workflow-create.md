# workflow-create

Create reusable workflow templates.

## Usage
```bash
npx -y ruflo@3.14.2 workflow template create [options]
```

`workflow create` is not a v3 subcommand — there is no ad hoc "create" step at all. Author the workflow as a YAML/JSON definition file, validate it with `workflow validate -f <file>`, and optionally register it as a reusable template with `workflow template create`.

## Options
- `-n/--name <name>` - Template name
- `-f/--file <path>` - Workflow definition file to register as a template
- `-w/--workflow-id <id>` - Register an existing workflow run as a template (a different shape from "from history" below — it points at one specific past run, not a search)

## Examples
```bash
# Author deploy-api.yaml, then register it as a template
npx -y ruflo@3.14.2 workflow template create -n deploy-api -f ./deploy-api.yaml

# Validate a definition file before registering it
workflow validate -f ./deploy-api.yaml
```

There is no `--from-history` (bulk-create from run history) or `--interactive` (guided creation) in v3 — both examples are dropped. The nearest match for "from history" is `workflow template create -w <workflow-id>`, which registers one specific past workflow run as a template, not a searchable history browse.
