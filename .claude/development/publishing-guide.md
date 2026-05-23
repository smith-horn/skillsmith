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

## CI Workflow (the only supported publish path)

```bash
git push
gh workflow run publish.yml -f dry_run=false
gh run watch <run-id> --exit-status              # Monitor progress
```

npmjs.org publishes (`@skillsmith/{core,mcp-server,cli}`) authenticate via npm trusted-publisher OIDC (SMI-4539 landed; SMI-4540 retired the token fallback on 2026-05-19 after the granular token was revoked). Trusted-publisher entries on npmjs.com for each package point at `smith-horn/skillsmith` + `publish.yml`; if OIDC fails for any reason the publish job fails loudly with no fallback. `@smith-horn/enterprise` publishes to GitHub Packages via `GITHUB_TOKEN` (npm trusted-publishing is npmjs.org-only). Publishes in dependency order (core → mcp-server, cli, enterprise) with validation, smoke tests, and MCP Registry publish.

If CI fails, fix CI. Do not reach for a local publish — see [`publish-ci-recovery.md`](../../docs/internal/runbooks/publish-ci-recovery.md) for triage.

### Pre-publish checklist

1. Build in Docker: `docker exec skillsmith-dev-1 npm run build`
2. Run preflight: `docker exec skillsmith-dev-1 npm run preflight`
3. Verify dependency versions are committed and pushed
4. Trigger CI: `gh workflow run publish.yml -f dry_run=false`
5. Watch the run: `gh run watch <run-id> --exit-status`
6. Post-publish (CI smoke-tests automatically; manual fallback): `npx tsx scripts/smoke-test-published.ts @skillsmith/<pkg> <version>`

If CI fails, do NOT reach for a local publish. Fix the underlying issue. Genuine break-glass: see [Break-Glass](#break-glass) below (requires `SKILLSMITH_PUBLISH_OVERRIDE=SMI-NNNN <rationale>` and a Linear retro within 24h). For workspace-resolution version-pin pitfalls and the `packaging-test.yml` registry-resolution caveat, see [Critical Rules](#critical-rules) below.

## Local Publish — Forbidden (SMI-4533)

The previous "local fallback" recipe (`source .env && npm publish`) is **gone**. Every publishable package's `prepublishOnly` chains `node ../../scripts/lib/forbid-local-publish.mjs` before build/test, and the script refuses unless invoked from a canonical-repo GitHub Actions runner.

Why: every "we couldn't get CI to publish so we did it locally" commit in the changelog mapped to a regression that CI's guards would have caught. Closing this loophole forces the only path that carries our published-version history.

`npm publish --ignore-scripts` skips `prepublishOnly`. The binding gate is npm trusted-publisher OIDC (SMI-4540 — OIDC-only, no token fallback). The host-side `prepublishOnly` guard plus npmjs.com 2FA on the publisher account remain the residual layers.

## Break-Glass

For genuine emergencies (registry-level outage, multi-hour CI breakage during an active prod incident), the `prepublishOnly` guard accepts an override:

```bash
export SKILLSMITH_PUBLISH_OVERRIDE="SMI-NNNN <rationale, ≥20 chars total>"
# Example:
export SKILLSMITH_PUBLISH_OVERRIDE="SMI-4499 emergency hotfix for prod incident; CI down 30+ min"

npm publish -w packages/<pkg> --access public
```

### Format requirements

- MUST start with `SMI-` followed by digits (the Linear issue tracking the override).
- MUST include a free-form rationale separated from the issue ref by whitespace.
- Total length MUST be ≥ 20 characters. Shorter values are refused with `format invalid`.

`OVERRIDE=1` does not work and never will. The format is intentionally awkward to write — every override should be deliberate.

### Audit trail

Every accepted override appends a tab-separated row to `~/.skillsmith-publish-overrides.log`:

```text
2026-04-29T16:42:00.000Z<TAB>SMI-4499 emergency hotfix for prod incident; CI down 30+ min<TAB>local
```

SMI-4538 tracks the eventual write-through to Supabase `audit_logs` (one place to review, alert on, and grep).

### Process

1. **File the SMI issue first.** Document why CI is unusable, what the operator tried, and the expected impact of publishing without the CI guard chain. Tag with `incident` and the affected package.
2. **Run the publish with the override set.** The audit log line lands in `~/.skillsmith-publish-overrides.log` automatically.
3. **Open a Linear retro within 24h.** Title: `Retro: SMI-NNNN local-publish override`. Owner: the operator who ran the publish. Sections: what failed, what was published, what guard the operator skipped, what the post-publish smoke confirmed, and the action item to make this not happen again.
4. **Update CI.** The retro's first concrete output is a CI fix or a runbook update — never just an incident note.

If the override gets used twice in the same calendar quarter without a permanent CI fix landing in between, escalate; the recovery runbook is no longer load-bearing.

## Publish Order

Dependencies before consumers:

1. `@skillsmith/core`
2. `@skillsmith/mcp-server` and `@skillsmith/cli` (both depend on core)
3. `@smith-horn/enterprise` (private, GitHub Packages)

## New-package onboarding

Adding a brand-new package to the publish pipeline is a multi-step setup, and **the npmjs.com registration MUST come first**. SMI-4540 made all npm publishes OIDC-only (the granular token was revoked 2026-05-19), and **OIDC trusted-publishing cannot bootstrap a package that does not already exist on npm** — the very first publish of a never-seen package dies with an opaque `E404`. SMI-5122 added a `pre-publish-check` fail-fast (`scripts/check-npm-bootstrap.mjs`) that catches this with an actionable message before the expensive Docker build, but the only real fix is to register the package by hand first.

1. **Register the package + enable trusted-publisher OIDC on npmjs.com BEFORE adding it to the pipeline.** On npmjs.com: create/claim the package name, then Settings → Trusted Publisher → add repo `smith-horn/skillsmith`, workflow `publish.yml`. (GitHub Packages targets like `@smith-horn/enterprise` publish via `GITHUB_TOKEN` and *can* bootstrap a new package, so this step is npmjs.org-scoped — i.e. `@skillsmith/*`.)
2. Add the package name to `PUBLISHABLE_PACKAGES_JSON` in `.github/workflows/publish.yml`.
3. Add the package to `PACKAGE_SPECS` in `scripts/lib/version-utils.ts`.
4. Run `npm run audit:standards` (Check 48 asserts the publish-job gates exist for any workspace-sibling deps the new package declares — see SMI-5123).
5. Update the release tests (`scripts/tests/prepare-release.test.ts`, smoke-test required arrays) and add an `[Unreleased]` `CHANGELOG.md` entry so the doc-drift gate passes.

If the bootstrap fail-fast trips in CI, it means step 1 was skipped — register the package on npmjs.com, then re-run. Cross-ref: SMI-4540 (OIDC-only publishes), SMI-5122 (bootstrap fail-fast).

## Critical Rules

**Never** publish a consumer before its dependency. **Never** publish with an exact-pinned workspace dep (use `^` prefix). Workspace resolution masks version-pin errors locally — only fresh `npm install` from the registry reveals mismatches. See [retro: mcp-server@0.4.5](../../docs/internal/retros/2026-03-19-mcp-server-0.4.5-hotfix.md).

**Verify dependency floors when adding cross-package imports.** If `mcp-server` starts importing a new export from `core`, bump the dep floor in `mcp-server/package.json` to the core version that introduced that export. The workspace resolves the latest local version, masking floor mismatches — only fresh `npm install` from the registry catches this. See [SMI-3668](https://linear.app/smith-horn-group/issue/SMI-3668).

**Note**: `packaging-test.yml` (weekly CI) installs from local tarballs, not the npm registry. It does NOT catch version-pin-against-unpublished-npm scenarios. The post-publish smoke test (`scripts/smoke-test-published.ts`) is the only check that exercises actual npm resolution.

## Local Fallback (Deprecated SMI-4533)

**Deprecated (SMI-4533)**: local fallback is forbidden. CI is the only publish path. If CI fails, fix CI; for genuine emergencies see [`docs/internal/runbooks/publish-ci-recovery.md`](../../docs/internal/runbooks/publish-ci-recovery.md) and the `SKILLSMITH_PUBLISH_OVERRIDE` break-glass in [#break-glass](#break-glass).
