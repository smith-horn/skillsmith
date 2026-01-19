# GitHub App Authentication Flow

**Issue**: SMI-1451
**Status**: Documented
**Last Updated**: January 2026

## Overview

Skillsmith uses a GitHub App for authenticated access to GitHub's API, enabling:
- Higher rate limits (5,000 requests/hour vs 60 for unauthenticated)
- Access to private repositories (when authorized)
- Repository indexing and skill discovery
- Installation-based access control

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub App Flow                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐     ┌──────────────┐     ┌─────────────────────┐  │
│  │  User    │────▶│  Install App │────▶│  Installation Token │  │
│  │  (Org)   │     │  on Repo/Org │     │  (JWT → Token)      │  │
│  └──────────┘     └──────────────┘     └──────────────────────┘  │
│                                                 │                │
│                                                 ▼                │
│                        ┌────────────────────────────────────┐   │
│                        │      Skillsmith Indexer            │   │
│                        │  - Fetch repositories              │   │
│                        │  - Read SKILL.md files            │   │
│                        │  - Index to database              │   │
│                        └────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Authentication Steps

### 1. App Registration

The GitHub App is registered with these permissions:
- **Contents**: Read (to access SKILL.md files)
- **Metadata**: Read (required for all apps)

No webhooks are currently configured.

### 2. JWT Generation

```typescript
import * as jwt from 'jsonwebtoken'

function generateJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000)

  return jwt.sign(
    {
      iat: now - 60,           // Issued 60 seconds ago (clock skew)
      exp: now + (10 * 60),    // Expires in 10 minutes
      iss: appId,              // GitHub App ID
    },
    privateKey,
    { algorithm: 'RS256' }
  )
}
```

### 3. Installation Token Exchange

```typescript
async function getInstallationToken(
  jwt: string,
  installationId: string
): Promise<string> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    }
  )

  const data = await response.json()
  return data.token
}
```

### 4. API Requests

```typescript
async function fetchWithAuth(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
}
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_APP_ID` | GitHub App ID | Yes |
| `GITHUB_APP_PRIVATE_KEY` | RSA private key (PEM format) | Yes |
| `GITHUB_INSTALLATION_ID` | Installation ID for indexing | Yes |

## Rate Limits

| Endpoint Type | Limit | Reset |
|---------------|-------|-------|
| Core API | 5,000/hour | Per installation |
| Search API | 30/minute | Per installation |
| GraphQL | 5,000 points/hour | Per installation |

## Security Considerations

1. **Private Key Storage**: The private key should be stored securely:
   - Use environment variables or secrets management
   - Never commit to version control
   - Rotate periodically

2. **Token Expiration**: Installation tokens expire after 1 hour:
   - Cache tokens with TTL
   - Refresh before expiration
   - Handle 401 errors gracefully

3. **Minimal Permissions**: Only request necessary permissions:
   - Contents:read for SKILL.md access
   - Metadata:read is always required

## Implementation Files

- `packages/core/src/sources/GitHubSourceAdapter.ts` - Main adapter
- `packages/core/src/indexer/GitHubIndexer.ts` - Indexing logic
- `supabase/functions/indexer/index.ts` - Edge function indexer

## See Also

- [GitHub Apps Documentation](https://docs.github.com/en/apps)
- [Indexer Infrastructure](./indexer-infrastructure.md)
- [ADR-014: GitHub App Authentication](../adr/014-github-app-authentication.md)
