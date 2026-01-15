# GitHub App Setup Guide for Skillsmith Indexer

This guide walks you through creating and configuring a GitHub App for the Skillsmith skill indexer. GitHub App authentication provides higher rate limits and better security compared to unauthenticated requests or personal access tokens.

## Why Use a GitHub App?

| Authentication Method | Rate Limit | Use Case |
|----------------------|------------|----------|
| Unauthenticated | 60 requests/hour | Development only |
| Personal Access Token (PAT) | 5,000 requests/hour | Simple setups |
| **GitHub App (recommended)** | **5,000 requests/hour** | Production indexing |

GitHub Apps offer advantages over PATs:
- **Fine-grained permissions**: Request only the access you need
- **Automatic token rotation**: Installation tokens expire after 1 hour
- **Audit logging**: Track API usage per installation
- **No user account dependency**: App continues working if user leaves org

## Prerequisites

Before starting, ensure you have:
- [ ] A GitHub account with permission to create Apps
- [ ] Access to the organization where skills will be indexed (if applicable)
- [ ] The Skillsmith project cloned locally
- [ ] Node.js 18+ installed

## Step 1: Create the GitHub App

1. Navigate to **GitHub Settings** > **Developer settings** > **GitHub Apps**
   - Direct link: https://github.com/settings/apps

2. Click **New GitHub App**

3. Fill in the required fields:

   | Field | Value |
   |-------|-------|
   | **GitHub App name** | `skillsmith-indexer` (or your preferred name) |
   | **Homepage URL** | Your project URL or `https://github.com/your-org/skillsmith` |
   | **Webhook** | Uncheck "Active" (not needed for indexing) |

4. Set **Repository permissions**:

   | Permission | Access Level | Purpose |
   |------------|--------------|---------|
   | **Contents** | Read-only | Read skill files from repositories |
   | **Metadata** | Read-only | Access repository metadata (required) |

   > **Note**: These are the minimum permissions needed. Do not grant write access unless required for other features.

5. Under **Where can this GitHub App be installed?**, select:
   - **Only on this account** for personal use
   - **Any account** if others will install the App

6. Click **Create GitHub App**

7. **Record the App ID** displayed on the next page (you'll need this later)

## Step 2: Generate a Private Key

1. On the App settings page, scroll to **Private keys**

2. Click **Generate a private key**

3. A `.pem` file will download automatically

4. **Store this file securely** - it cannot be downloaded again
   - Recommended location: Outside your project directory
   - Example: `~/.config/skillsmith/github-app-key.pem`

5. Set appropriate file permissions:
   ```bash
   chmod 600 ~/.config/skillsmith/github-app-key.pem
   ```

## Step 3: Install the App

1. From the App settings page, click **Install App** in the left sidebar

2. Select the account or organization where you want to install it

3. Choose repository access:
   - **All repositories**: Indexes all current and future repos
   - **Only select repositories**: Choose specific repos to index

4. Click **Install**

## Step 4: Get the Installation ID

After installation, you need the Installation ID. There are three ways to find it:

### Option A: From the URL (Easiest)

After clicking Install, check the URL in your browser:
```
https://github.com/settings/installations/12345678
                                          ^^^^^^^^
                                          This is your Installation ID
```

### Option B: From the API

```bash
# Using the GitHub CLI
gh api /users/{YOUR_USERNAME}/installation | jq '.id'

# Or for an organization
gh api /orgs/{YOUR_ORG}/installation | jq '.id'
```

### Option C: From the GitHub UI

1. Go to **Settings** > **Applications** > **Installed GitHub Apps**
2. Click **Configure** next to your App
3. The Installation ID is in the URL

## Step 5: Configure Environment Variables

Create or update your `.env` file in the Skillsmith project root:

```bash
# GitHub App Authentication (recommended for production)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
...your key content...
-----END RSA PRIVATE KEY-----"
GITHUB_APP_INSTALLATION_ID=12345678

# Optional: Personal Access Token (fallback or development)
# GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

### Key Format Options

The private key can be provided in several formats:

**Multi-line (recommended for `.env` files)**:
```bash
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
-----END RSA PRIVATE KEY-----"
```

**Single line with escaped newlines**:
```bash
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
```

**Base64-encoded (recommended for CI/CD)**:
```bash
# Encode the key
cat github-app-key.pem | base64 -w 0

# Set in environment
GITHUB_APP_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTi...
```

> **Note**: The indexer automatically detects and decodes base64-encoded keys.

## Verification

Test that your configuration works:

```bash
# Run the indexer in dry-run mode
docker exec skillsmith-dev-1 npx tsx packages/core/src/indexer/cli.ts --dry-run

# Or test authentication directly
docker exec skillsmith-dev-1 npx tsx -e "
const { GitHubClientFactory } = require('./packages/core/dist/indexer/github-client-factory.js');
const client = GitHubClientFactory.create();
client.getRateLimit().then(console.log);
"
```

Expected output with App authentication:
```
{
  limit: 5000,
  remaining: 4999,
  reset: 1704067200,
  authenticated: true
}
```

## Troubleshooting

### Issue: "Could not create JWT" or "Private key error"

**Cause**: Malformed private key or incorrect format

**Solution**:
1. Verify the key file is complete (starts with `-----BEGIN` and ends with `-----END`)
2. Check for extra whitespace or line breaks
3. Try base64 encoding the key

### Issue: "401 Unauthorized" or "Bad credentials"

**Cause**: Invalid App ID, expired token, or App not installed

**Solution**:
1. Verify `GITHUB_APP_ID` matches the App settings page
2. Check that the App is installed on the target account/org
3. Regenerate the private key if corrupted

### Issue: "404 Not Found" when accessing repositories

**Cause**: App doesn't have access to the repository

**Solution**:
1. Go to the App installation settings
2. Verify the repository is in the allowed list
3. For org repos, ensure the App is installed on the organization

### Issue: Rate limit exhausted quickly

**Cause**: Falling back to unauthenticated requests

**Solution**:
1. Check logs for authentication warnings
2. Verify all three environment variables are set:
   - `GITHUB_APP_ID`
   - `GITHUB_APP_PRIVATE_KEY`
   - `GITHUB_APP_INSTALLATION_ID`

### Issue: "Installation not found"

**Cause**: Wrong Installation ID or App uninstalled

**Solution**:
1. Re-verify the Installation ID using methods in Step 4
2. Check if the App is still installed on the account/org
3. Reinstall if necessary

### Debug Mode

Enable debug logging to see authentication details:

```bash
DEBUG=skillsmith:github* docker exec skillsmith-dev-1 npx tsx packages/core/src/indexer/cli.ts
```

### Regenerating Credentials

If you need to start fresh:

1. **Regenerate private key**: App settings > Private keys > Generate new key
2. **Update Installation ID**: Uninstall and reinstall the App
3. **Update `.env`**: Replace all three values

## Security Best Practices

1. **Never commit `.env` files** - Add to `.gitignore`
2. **Rotate keys periodically** - Generate new keys quarterly
3. **Use minimal permissions** - Only request what you need
4. **Monitor usage** - Check the App's usage statistics regularly
5. **Use separate Apps** - Create different Apps for dev/staging/production

## Environment Variable Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes (for App auth) | Numeric App ID from settings |
| `GITHUB_APP_PRIVATE_KEY` | Yes (for App auth) | PEM-formatted private key |
| `GITHUB_APP_INSTALLATION_ID` | Yes (for App auth) | Installation ID for target account |
| `GITHUB_TOKEN` | No | PAT fallback (optional) |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | No | Alternative: base64-encoded key |

## Related Documentation

- [Indexer Infrastructure Architecture](../architecture/indexer-infrastructure.md)
- [ADR-018: GitHub App Authentication](../adr/018-github-app-authentication.md) (if exists)
- [GitHub Apps Documentation](https://docs.github.com/en/apps)
- [Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps)

## Next Steps

After completing setup:

1. Run a full index: `docker exec skillsmith-dev-1 npm run index:skills`
2. Verify skills are indexed: Check the database or run search
3. Set up scheduled indexing (see operations runbook)
