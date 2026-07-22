# swarm-analysis

Run a swarm oriented around code analysis.

`swarm swarm-analysis` was never valid syntax in any version (doubled verb — this file was auto-generated filler), and `analysis` is not a subcommand — it is a **strategy value** for `swarm start`.

## Usage
```bash
npx -y ruflo@3.14.2 swarm start -o "<objective>" -s analysis
```

`analysis` is a verified `--strategy` value — confirmed directly against the installed `ruflo@3.14.2` (`@claude-flow/cli`) package source (`STRATEGIES` array in `swarm.js`), not assumed as a topology fallback (per the CLI migration plan's U3 split rule, an unverified `--strategy` value should never fall back to a topology value like `hierarchical`/`mesh`). It deploys an analysis-oriented agent plan (analyst lead + code analyst + security analyst).

## Example
```bash
swarm start -o "Audit the auth module for security issues" -s analysis
```
