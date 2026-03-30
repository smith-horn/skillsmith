# VS Code Extension Publishing Guide

Reference for publishing the Skillsmith VS Code extension to the Marketplace.

## Overview

| Field | Value |
|-------|-------|
| Package name | `skillsmith-vscode` (unscoped — vsce rejects `@skillsmith/`) |
| Publisher | `Skillsmith` (ID: `skillsmith`) |
| Marketplace | [marketplace.visualstudio.com/items?itemName=skillsmith.skillsmith-vscode](https://marketplace.visualstudio.com/items?itemName=skillsmith.skillsmith-vscode) |
| Manage | [marketplace.visualstudio.com/manage/.../hub](https://marketplace.visualstudio.com/manage/publishers/skillsmith/extensions/skillsmith-vscode/hub) |
| VSIX size | ~149 KB (esbuild bundles everything, `--no-dependencies`) |
| Docker | Not required (ADR-113) |
| License | Elastic License 2.0 |

## CI Workflow (Preferred)

```bash
gh workflow run publish-vscode.yml -f dry_run=false                          # Stable
gh workflow run publish-vscode.yml -f dry_run=false -f pre_release=true      # Pre-release
gh run watch <run-id> --exit-status                                          # Monitor
```

- Triggers on `vscode-extension-v*` release tags or manual `workflow_dispatch`
- Validates: build, typecheck, test, `package:check`
- Version guard prevents duplicate publishes
- Cross-referenced in `publish.yml` (npm packages)

## Local Publish (Fallback)

```bash
cd packages/vscode-extension
npm run build                                                                # esbuild bundle
npx @vscode/vsce package --no-dependencies                                   # Creates .vsix
node scripts/validate-vsix.mjs skillsmith-vscode-X.Y.Z.vsix                  # Validate
varlock run -- sh -c 'npx @vscode/vsce publish --no-dependencies --pat "$VSCE_SKILLSMITH"'
```

**Never** use `npx vsce login` — it caches the PAT on disk. Always use Varlock.

## Version Bumping

1. Update `packages/vscode-extension/package.json` version field
2. Add entry to `packages/vscode-extension/CHANGELOG.md` (Keep a Changelog format)
3. Commit: `chore(vscode-extension): bump to X.Y.Z`

TODO: Integrate into `prepare-release.ts` with `--vscode=<bump>` flag (SMI-3702).

## Pre-Publish Checklist

- [ ] Version bumped in `package.json`
- [ ] `CHANGELOG.md` updated with new version entry
- [ ] `npm run package:check` passes (from extension dir)
- [ ] VSIX < 5 MB, no `src/` or `__tests__/` files
- [ ] Commit pushed to main

## PAT Rotation

| Location | Secret Name | Purpose |
|----------|-------------|---------|
| `.env` | `VSCE_SKILLSMITH` | Local publish (Varlock-protected) |
| GitHub Actions | `VSCE_PAT` | CI publish |

- **Expiry**: 90 days
- **Generate at**: dev.azure.com > User Settings > Personal Access Tokens > Marketplace > Publish
- **Rotation runbook**: `docs/internal/runbooks/vsce-pat-rotation.md`

## Key Differences from npm Publishing

| | npm packages | VS Code extension |
|--|---|---|
| Tool | `npm publish` | `@vscode/vsce publish` |
| Docker | Required (ADR-002) | Not required (ADR-113) |
| Dependencies | Ships `node_modules` | `--no-dependencies` (esbuild bundles) |
| Name | Scoped (`@skillsmith/core`) | Unscoped (`skillsmith-vscode`) |
| Registry | npmjs.com | marketplace.visualstudio.com |
| Auth | `SKILLSMITH_NPM_TOKEN` | `VSCE_SKILLSMITH` / `VSCE_PAT` |
| Smoke test | `scripts/smoke-test-published.ts` | `code --install-extension` |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Invalid extension name" | vsce rejects scoped names — use `skillsmith-vscode` not `@skillsmith/vscode-extension` |
| "@types/vscode greater than engines.vscode" | Align `engines.vscode` with `@types/vscode` version |
| VSIX includes entire monorepo (600+ MB) | Use allowlist `.vscodeignore` (`**` then `!` includes) + `--no-dependencies` |
| "Can't install release version" | Published as pre-release only — `code --install-extension X --pre-release` or publish stable |
| "already exists" | Bump version before republishing |
| 404 on Marketplace URL | First publish takes 10-30 min to propagate. `vsce show` hits API directly |
