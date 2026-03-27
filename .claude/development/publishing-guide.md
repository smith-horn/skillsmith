# Publishing Guide

Reference for publishing Skillsmith packages to npm and the MCP Registry.

## Release Preparation

Version bump + changelog + commit:

```bash
docker exec skillsmith-dev-1 npx tsx scripts/prepare-release.ts --all=patch   # bump all
docker exec skillsmith-dev-1 npx tsx scripts/prepare-release.ts --core=minor --cli=patch  # selective
docker exec skillsmith-dev-1 npx tsx scripts/prepare-release.ts --dry-run --all=patch  # preview
```

The script updates all 6 version locations (package.json, VERSION constants, server.json), generates changelog entries, and creates a commit. See `docs/internal/implementation/release-automation.md` for details.

## CI Workflow (Preferred)

```bash
git push
gh workflow run publish.yml -f dry_run=false
gh run watch <run-id> --exit-status              # Monitor progress
```

Uses `SKILLSMITH_NPM_TOKEN` secret. Publishes in dependency order (core → mcp-server, cli, enterprise) with validation, smoke tests, and MCP Registry publish. Always try this first.

**Known limitation**: The Validate job builds ALL packages. If an unrelated package (e.g., enterprise) has a build failure, the entire workflow fails. Use the local fallback to publish just the package you need.

## Local Fallback

When CI fails due to unrelated build issues, publish manually using the `SKILLSMITH_NPM_TOKEN` from `.env`.

### Token Setup (One-Time)

1. Create a **Granular Access Token** at npmjs.com → Access Tokens
2. Scope: `@skillsmith` organization, read and write
3. **Enable "Bypass two-factor authentication"** — npm passkey auth does not support OTP via CLI
4. Save as `SKILLSMITH_NPM_TOKEN` in `.env` (secured via Varlock, annotated in `.env.schema`)

### Publish Command

**Must run from the repo root** — npm ignores `.npmrc` in workspace package directories.

```bash
# 1. Inject token into ~/.npmrc (zsh: use printf, not echo — // is interpreted as a path)
source .env
printf '%s\n' "//registry.npmjs.org/:_authToken=$SKILLSMITH_NPM_TOKEN" >> ~/.npmrc

# 2. Publish specific package
npm publish --ignore-scripts -w packages/<pkg>

# 3. Clean up token immediately
sed -i '' '/registry.npmjs.org/d' ~/.npmrc
```

### Gotchas

| Issue | Cause | Fix |
|-------|-------|-----|
| `EOTP` (OTP required) | Token doesn't have bypass 2FA, or npm is using cached login session | `npm logout` first, verify token has bypass enabled on npmjs.com |
| `ENEEDAUTH` | `.npmrc` in wrong location | Must be `~/.npmrc`, not `packages/<pkg>/.npmrc` (workspaces ignore package-level `.npmrc`) |
| `zsh: no such file or directory: //registry...` | zsh interprets `//` as path | Use `printf '%s\n' "//..."` instead of `echo "//..."` |
| `E404 Not Found` on PUT | Not authenticated to `@skillsmith` scope | Check `npm whoami` and token scope |

### Script Fallback

`./scripts/publish-packages.sh` — publishes in dependency order with pre-publish tarball verification. Requires the same token setup above.

## Publish Order

Dependencies before consumers:

1. `@skillsmith/core`
2. `@skillsmith/mcp-server` and `@skillsmith/cli` (both depend on core)

## Pre-Publish Checklist (Manual Publishes Only)

Only needed if the CI workflow fails:

1. Build in Docker: `docker exec skillsmith-dev-1 npm run build`
2. Run preflight: `docker exec skillsmith-dev-1 npm run preflight`
3. Verify dependency versions are committed and pushed
4. Check dependency is published:

   ```bash
   VERSION=$(node -e "console.log(require('./packages/core/package.json').version)")
   npm view @skillsmith/core@$VERSION version   # must return the version
   ```

5. If dependency not published: publish it first with `./scripts/publish-packages.sh core`
6. Run `npm pack --dry-run` in the package dir to inspect tarball contents
7. Publish using the command above (Local Fallback section)
8. Post-publish: `npx tsx scripts/smoke-test-published.ts @skillsmith/<pkg> <version>`

## Critical Rules

**Never** publish a consumer before its dependency. **Never** publish with an exact-pinned workspace dep (use `^` prefix). Workspace resolution masks version-pin errors locally — only fresh `npm install` from the registry reveals mismatches. See [retro: mcp-server@0.4.5](../docs/internal/retros/2026-03-19-mcp-server-0.4.5-hotfix.md).

**Verify dependency floors when adding cross-package imports.** If `mcp-server` starts importing a new export from `core`, bump the dep floor in `mcp-server/package.json` to the core version that introduced that export. The workspace resolves the latest local version, masking floor mismatches — only fresh `npm install` from the registry catches this. See [SMI-3668](https://linear.app/smith-horn-group/issue/SMI-3668).

**Note**: `packaging-test.yml` (weekly CI) installs from local tarballs, not the npm registry. It does NOT catch version-pin-against-unpublished-npm scenarios. The post-publish smoke test (`scripts/smoke-test-published.ts`) is the only check that exercises actual npm resolution.
