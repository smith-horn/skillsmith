# npm Publishing Setup

This document describes how to configure npm publishing for Skillsmith packages.

## Overview

| Package | Registry | Access | License |
|---------|----------|--------|---------|
| `@skillsmith/core` | npmjs.org | Public | Apache-2.0 |
| `@skillsmith/mcp-server` | npmjs.org | Public | Apache-2.0 |
| `@skillsmith/cli` | npmjs.org | Public | Apache-2.0 |
| `@skillsmith/enterprise` | npm.pkg.github.com | Restricted | Proprietary |

## Prerequisites

### 1. Create npm Organization

1. Go to https://www.npmjs.com/org/create
2. Create organization: `skillsmith`
3. Add team members with appropriate roles

### 2. Generate npm Access Token

1. Log in to npmjs.com
2. Go to Access Tokens → Generate New Token
3. Select "Automation" type (for CI/CD)
4. Copy the token securely

### 3. Configure GitHub Secrets

Add the following secrets to the repository:

| Secret | Description |
|--------|-------------|
| `NPM_TOKEN` | npm automation token for publishing |

Go to: Repository → Settings → Secrets and variables → Actions → New repository secret

### 4. GitHub Packages (for Enterprise)

The `@skillsmith/enterprise` package is published to GitHub Packages:

- Registry: `https://npm.pkg.github.com`
- Authentication: Uses `GITHUB_TOKEN` (automatic in Actions)
- Access: Restricted (requires authentication)

## Publishing Workflow

### Automatic (Recommended)

Publishing is triggered automatically when a GitHub Release is created:

1. Create a new release in GitHub
2. Tag format: `v0.1.0`, `v1.0.0`, etc.
3. The `publish.yml` workflow runs automatically
4. All packages are published in dependency order

### Dry Run (Testing)

To test the workflow without publishing:

1. Go to Actions → Publish Packages
2. Click "Run workflow"
3. Set `dry_run` to `false` to actually publish (default is `true`)
4. Click "Run workflow"

This allows testing the workflow without creating a release.

### Manual

To publish manually:

```bash
# Ensure you're logged in
npm login

# Build all packages
npm run build

# Publish individual packages
npm publish -w @skillsmith/core --access public
npm publish -w @skillsmith/mcp-server --access public
npm publish -w @skillsmith/cli --access public

# For enterprise (requires GitHub Packages auth)
npm publish -w @skillsmith/enterprise
```

## Version Management

### Updating Versions

Before publishing a new version:

```bash
# Update version in all packages
npm version patch -w @skillsmith/core
npm version patch -w @skillsmith/mcp-server
npm version patch -w @skillsmith/cli
npm version patch -w @skillsmith/enterprise
```

### Version Synchronization

All packages should use the same version number for consistency:

```bash
# Check current versions
npm run build
cat packages/*/package.json | grep '"version"'
```

## Troubleshooting

### "You must be logged in to publish"

```bash
npm login
# Enter username, password, and OTP
```

### "403 Forbidden - Package name too similar"

The `@skillsmith` scope must be created and owned by your npm account.

### "EPERM: operation not permitted"

Ensure the `prepublishOnly` script completes successfully:

```bash
npm run build -w @skillsmith/core
npm test -w @skillsmith/core
```

## Security Considerations

1. **Never commit npm tokens** - Use GitHub Secrets
2. **Use automation tokens** - Not your personal token
3. **Review before publish** - Check `npm pack` output
4. **Monitor for vulnerabilities** - `npm audit` runs in CI

## Related Documentation

- [ADR-013: Open-Core Licensing Model](../adr/013-open-core-licensing.md)
- [Go-to-Market Analysis](../strategy/go-to-market-analysis.md)
- [Enterprise Package](../../packages/enterprise/README.md)
