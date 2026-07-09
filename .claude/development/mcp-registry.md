# MCP Registry Publishing Guide

**Linear Issue**: [SMI-2158](https://linear.app/smith-horn-group/issue/SMI-2158/register-skillsmith-on-mcp-registry-and-claude-connector-directory)
**Last Updated**: February 1, 2026

> This page covers the **official MCP registry** only. Skillsmith is also listed on a second, independently-mechanized channel — see [Docker MCP Registry](#docker-mcp-registry) below.

## Overview

Skillsmith is published to the official MCP Registry, enabling discovery by:

- Claude CoWork connector search
- MCP Registry API consumers
- Third-party aggregators (Glama, Smithery, mcp.so)

## Registry Details

| Field | Value |
|-------|-------|
| Registry URL | <https://registry.modelcontextprotocol.io/> |
| Server Name | `io.github.smith-horn/skillsmith` |
| npm Package | `@skillsmith/mcp-server` |
| Transport | stdio |
| Node.js | >= 22.0.0 |

## Files

### server.json

Location: `packages/mcp-server/server.json`

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.smith-horn/skillsmith",
  "title": "Skillsmith",
  "description": "MCP server for Claude Code skill discovery, installation, and management.",
  "websiteUrl": "https://skillsmith.app",
  "repository": {
    "url": "https://github.com/smith-horn/skillsmith",
    "source": "github"
  },
  "version": "X.Y.Z",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "@skillsmith/mcp-server",
      "version": "X.Y.Z",
      "transport": { "type": "stdio" },
      "runtime": { "type": "node", "minVersion": "22.0.0" }
    }
  ]
}
```

### package.json

The `mcpName` field in `packages/mcp-server/package.json` links the npm package to the registry entry:

```json
{
  "name": "@skillsmith/mcp-server",
  "version": "X.Y.Z",
  "mcpName": "io.github.smith-horn/skillsmith"
}
```

## Publishing Workflow

### Automatic (CI)

The `publish.yml` workflow automatically publishes to MCP Registry after successful npm publish:

1. npm publish succeeds for `@skillsmith/mcp-server`
2. CI downloads `mcp-publisher` CLI (pinned to `v1.7.3`; SMI-4537 tracks drift)
3. CI authenticates via GitHub Actions OIDC (`mcp-publisher login github-oidc`); no static secret needed
4. CI publishes to registry

**Failure isolation (SMI-4534)**: Registry login + publish steps are marked `continue-on-error: true`; npm publish remains the binding artifact. A loud-fail step files a GitHub issue automatically when the registry path fails.

### Manual

```bash
# 1. Install mcp-publisher
brew install mcp-publisher
# Or: curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/').tar.gz" | tar xz

# 2. Authenticate with GitHub
mcp-publisher login github
# Follow device flow at https://github.com/login/device

# 3. Publish
cd packages/mcp-server
mcp-publisher publish

# 4. Verify
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=skillsmith" | jq '.servers[0].server'
```

## Version Bumping

When releasing a new version, update **THREE** locations:

1. `packages/mcp-server/package.json` → `version`
2. `packages/mcp-server/server.json` → `version`
3. `packages/mcp-server/server.json` → `packages[0].version`

### Release Checklist

Before publishing, verify all of the following:

- [ ] Version bumped in all three locations above
- [ ] `SECURITY.md` supported versions table reflects current minor versions
- [ ] Root `CHANGELOG.md` and `packages/mcp-server/CHANGELOG.md` updated with changes
- [ ] All CI checks pass (`npm run preflight`)
- [ ] Enterprise `@skillsmith/core` dependency is current (not stale)

Example script:

```bash
VERSION="0.3.15"
cd packages/mcp-server

# Update package.json
npm version $VERSION --no-git-tag-version

# Update server.json (using jq)
jq ".version = \"$VERSION\" | .packages[0].version = \"$VERSION\"" server.json > tmp.json && mv tmp.json server.json
```

## CI Setup

### Required Permissions (SMI-4534)

CI auth uses GitHub Actions OIDC — no static secret. The `publish-mcp-server` job in `publish.yml` declares:

```yaml
permissions:
  contents: read
  id-token: write
```

`id-token: write` is scoped to this single job (least privilege). The `mcp-publisher login github-oidc` step exchanges the OIDC token for a registry JWT at runtime.

**Pre-2026-04-28**: A static `MCP_REGISTRY_TOKEN` secret was used. mcp-publisher v1.6.0 (2026-04-15) moved token storage to `~/.config/mcp-publisher/` and broke env-var auth. SMI-4534 migrated to OIDC.

### GitHub Organization Membership

The `mcp-publisher` CLI uses GitHub namespace verification. To publish under `io.github.smith-horn/*`:

1. Be a member of the `smith-horn` GitHub organization
2. Make membership **public** (not private)
3. Verify at: <https://github.com/orgs/smith-horn/people>

## Troubleshooting

### "You do not have permission to publish this server"

- Ensure GitHub org membership is **public**
- Verify `mcpName` starts with `io.github.<your-org>/`

### "Registry validation failed for package"

- Ensure npm package has `mcpName` field in package.json
- Publish to npm **before** publishing to registry

### CI registry publish failed (loud-fail issue auto-filed)

- Check the `Annotate registry publish failure` step output in the failed run
- Manual recovery from a maintainer machine: `mcp-publisher login github` + `cd packages/mcp-server && mcp-publisher publish`
- If recurring, check whether the pinned `mcp-publisher` version (in `publish.yml`) needs a bump (SMI-4537)

### Token files

The CLI stores tokens in:

- `~/.mcpregistry_github_token` - GitHub OAuth token
- `~/.mcpregistry_registry_token` - Registry JWT

These are gitignored (`.mcpregistry_*`).

## Verification

### Check Registry Listing

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=skillsmith" | jq '.'
```

### Expected Response

```json
{
  "servers": [{
    "server": {
      "name": "io.github.smith-horn/skillsmith",
      "title": "Skillsmith",
      "version": "0.3.14",
      ...
    },
    "_meta": {
      "io.modelcontextprotocol.registry/official": {
        "status": "active",
        "isLatest": true
      }
    }
  }]
}
```

## References

- [MCP Registry Documentation](https://github.com/modelcontextprotocol/registry)
- [MCP Registry Quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
- [server.json Schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
- [Claude Connector Directory](https://claude.com/connectors)

---

## Docker MCP Registry

**Linear Issue**: SMI-5609 · **Plan**: `docs/internal/implementation/docker-mcp-registry-publish.md`

Docker maintains a second, separately-curated MCP registry — `github.com/docker/mcp-registry` — that feeds Docker Hub's `mcp/` namespace and Docker Desktop's MCP Toolkit UI. This is an independent distribution channel from the official `registry.modelcontextprotocol.io` registry documented above: different repo, different maintainers, different submission and build mechanism.

### Registry Details

| Field | Value |
|-------|-------|
| Registry repo | <https://github.com/docker/mcp-registry> |
| Docker Hub image | `mcp/skillsmith` |
| Entry files | `servers/skillsmith/server.yaml` + `servers/skillsmith/tools.json`, in a **fork of `docker/mcp-registry`** — not this repository |
| Build context (`source.directory`) | `packages/mcp-server` |
| Dockerfile | `packages/mcp-server/Dockerfile` |

### The `source.directory` monorepo mechanism

For a monorepo submission, Docker's registry builds the image using `server.yaml`'s `source.directory` field as **both** the Dockerfile location and the entire build context — the build has no access to anything outside that directory: no repo root, no sibling packages, no root `package-lock.json` or `.npmrc`. Skillsmith's entry sets `directory: packages/mcp-server`, so `packages/mcp-server/Dockerfile` is written to be fully self-sufficient from that directory alone. It resolves `@skillsmith/core` as a real published npm dependency (not a workspace link), so a plain `npm install` works with zero workspace context.

### License compatibility (resolved)

Skillsmith is licensed under Elastic License 2.0 (ELv2) — source-available, not OSI-approved (ADR-119). Docker's `CONTRIBUTING.md` states in prose: *"Make sure the license of your MCP Server allows people to consume it (MIT or Apache 2 are great, GPL is not)."* Taken literally, this could read as excluding ELv2. It's more restrictive than Docker's actual automated gate.

`internal/licenses/check.go` in `docker/mcp-registry` only rejects a GitHub-detected SPDX license key prefixed `gpl`, `agpl`, or `npl`:

```go
func IsValid(license *github.License) bool {
    if license != nil && (strings.HasPrefix(license.GetKey(), "gpl") || strings.HasPrefix(license.GetKey(), "agpl") || strings.HasPrefix(license.GetKey(), "npl")) {
        return false
    }
    return true
}
```

`gh api repos/smith-horn/skillsmith --jq '.license'` returns `{"key":"other","name":"Other","spdx_id":"NOASSERTION"}`. This isn't a defect in our `LICENSE` file — it's the canonical, unmodified Elastic License 2.0 text — GitHub's `licensee`/`choosealicense.com` catalog simply has no entry for Elastic-2.0 at all, even for the canonical text, so *any* ELv2 repo resolves to `"other"`. `"other"` never matches the `gpl`/`agpl`/`npl` prefixes, so **the automated gate passes cleanly and reliably, not just as a one-time result**. A discretionary human "Docker team review" step still sits on top of the automated gate (residual risk: small). See the plan doc for the reputational-risk contingency and registry precedent (`elasticsearch`, `grafana`, `cockroachdb` are all listed despite non-permissive core licenses, via a separately-licensed MCP wrapper repo in most of those cases).

### Nightly automated bump-PRs

Once a submission is merged, Docker runs an automated nightly GitHub Action that opens commit-bump PRs against `docker/mcp-registry` to keep the pinned `source.commit` current (per Docker's `docs/configuration.md`: *"Once an initial revision is accepted into the registry, an automated nightly GitHub Action will drive PRs to perform updates"*). There is no fixed-cadence maintenance obligation — review opportunistically when GitHub notifies of a new bump PR. Ownership: the SMI-5609 assignee, or its Wave 2 follow-up issue's assignee once Wave 1 (in-repo, closed on merge) and Wave 2 (external submission, unbounded timeline) are split into separate Linear issues per this repo's convention of not letting external/unbounded-timeline follow-up work block an in-repo issue from closing.

### Accepted risk — no lockfile in the Docker build context

`packages/mcp-server/Dockerfile`'s build context has no `package-lock.json` — neither `packages/core/` nor `packages/mcp-server/` has its own lockfile; only the repo root does, which is out of scope for this build context. Both manual rebuilds and Docker's nightly bump-PR automation therefore resolve dependencies fresh (`npm install`, not `npm ci`) on every build. This is a deliberate accepted risk, not a gap to fix — revisit only if it causes a real break.

### Accepted risk — semver drift between npm-published and Docker-published server

**Verified live, not just theoretical (Wave 1 Step 5 local validation)**: building the image from current `main` HEAD's `dist/` while installing `@skillsmith/core` from the public npm registry (`0.10.0`) crashes the server at startup — `packages/mcp-server/src/index.ts`'s static import graph reaches `DEFAULT_RISK_THRESHOLD` from `@skillsmith/core`, which the published `0.10.0` tarball doesn't export (confirmed by downloading and grepping it directly; the export exists in local `packages/core/src/index.ts` but postdates the last publish, and `packages/core/CHANGELOG.md`'s `[Unreleased]` section is empty despite that — a version-bump gap upstream of this doc). **Not currently affecting real users**: the published `@skillsmith/mcp-server@0.7.0` tarball predates this export and doesn't reference it. It only bites the specific combination this Dockerfile uses (fresh HEAD `dist/` + npm-installed `core`) — confirmed by patch-testing with a correct local `core/dist` overlaid into the built image, after which `initialize`, the no-auth trial path, and the volume-mount write-through all worked correctly.

**Concrete rule for pinning `source.commit`** (Wave 2 Step 1): never pin to "current `main` tip" by default. Pin only to a commit at or before the last `@skillsmith/mcp-server` npm publish (so the built `dist/` only references already-published `@skillsmith/core` exports), or wait for `@skillsmith/core` to publish a version containing whatever HEAD-ahead exports exist before pinning past that point. This is a scheduling constraint on which commit to submit, not a code fix — follow the normal publish cadence (`publishing-guide.md`), don't force an out-of-cycle release for this.

### Three parallel self-descriptions

The Docker listing's `about.description` (in `server.yaml`), the npm `package.json` description, and the official-registry `server.json` description (documented above) are three separate, surface-appropriate pitches maintained independently — not one shared string kept in sync across all three. This is intentional; a future editor should not assume divergence between them is drift to fix.

### Naming across registries

The same server has three different identifiers across the three channels — expected, not a bug:

| Channel | Identifier |
|---------|-----------|
| npm | `@skillsmith/mcp-server` |
| Official MCP registry | `io.github.smith-horn/skillsmith` |
| Docker MCP registry | `mcp/skillsmith` |

No action needed — noted here only so a future support conversation isn't confused by the divergence.

### References

- [docker/mcp-registry](https://github.com/docker/mcp-registry)
- [Configuration docs (`docs/configuration.md`)](https://github.com/docker/mcp-registry/blob/main/docs/configuration.md)
- [Contributing guide](https://github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md)
- `docs/internal/implementation/docker-mcp-registry-publish.md` — full investigation, including the reputational-risk contingency owner and the license-check verification trail
