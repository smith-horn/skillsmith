# MCP Registry Publishing Guide

**Linear Issue**: [SMI-2158](https://linear.app/smith-horn-group/issue/SMI-2158/register-skillsmith-on-mcp-registry-and-claude-connector-directory)
**Last Updated**: February 1, 2026

## Overview

Skillsmith is published to the official MCP Registry, enabling discovery by:
- Claude CoWork connector search
- MCP Registry API consumers
- Third-party aggregators (Glama, Smithery, mcp.so)

## Registry Details

| Field | Value |
|-------|-------|
| Registry URL | https://registry.modelcontextprotocol.io/ |
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
2. CI downloads `mcp-publisher` CLI
3. CI publishes to registry using `MCP_REGISTRY_TOKEN` secret

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

### Required Secrets

| Secret | Description | How to Generate |
|--------|-------------|-----------------|
| `MCP_REGISTRY_TOKEN` | JWT token for registry auth | See below |

### Generating MCP_REGISTRY_TOKEN

```bash
# 1. Login (generates tokens locally)
mcp-publisher login github

# 2. Copy the registry token
cat ~/.mcpregistry_registry_token

# 3. Add to GitHub Secrets
# Settings → Secrets and variables → Actions → New repository secret
# Name: MCP_REGISTRY_TOKEN
# Value: <paste token>
```

**Note**: Tokens expire. If CI fails with 401, regenerate the token.

### GitHub Organization Membership

The `mcp-publisher` CLI uses GitHub namespace verification. To publish under `io.github.smith-horn/*`:

1. Be a member of the `smith-horn` GitHub organization
2. Make membership **public** (not private)
3. Verify at: https://github.com/orgs/smith-horn/people

## Troubleshooting

### "You do not have permission to publish this server"

- Ensure GitHub org membership is **public**
- Verify `mcpName` starts with `io.github.<your-org>/`

### "Registry validation failed for package"

- Ensure npm package has `mcpName` field in package.json
- Publish to npm **before** publishing to registry

### "Invalid or expired Registry JWT token"

- Re-run `mcp-publisher login github`
- Update `MCP_REGISTRY_TOKEN` secret in GitHub

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
