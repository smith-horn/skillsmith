# model-update

## Status: no direct equivalent

Ruflo's v3 CLI has no `model-update` (or `model-save`) subcommand — there is no incremental-update or post-update validation mode for an existing model.

The nearest available path is to re-train the target model via `neural train`, which runs a full training pass rather than an incremental one:

```bash
npx -y ruflo@3.14.2 neural train -m <id> --data <file-or-json>
```

`neural train` does not accept `--incremental` or `--validate` — neither flag exists in v3. To check the outcome of a training run, use `neural status`.

See [neural-train](./neural-train.md) for the full `neural train` reference.
