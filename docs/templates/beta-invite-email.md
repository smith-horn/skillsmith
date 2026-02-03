# Beta Invite Email Template

Resend HTML email template for notifying early access waitlist users that Skillsmith beta is live.

## First Used

- **Date**: February 2, 2026
- **Recipients**: 18 early access signups
- **Delivery**: 18/18 delivered via Resend API
- **Status field updated**: `pending` → `invited` in `early_access_signups` table

## Sending Configuration

| Field | Value |
|-------|-------|
| From | `Skillsmith <noreply@skillsmith.app>` |
| Reply-To | `support@skillsmith.app` |
| Subject | `Skillsmith Beta is Live — You're In` |
| Format | HTML + plain text (dual format for deliverability) |

## Code Location

- **Template**: `supabase/functions/_shared/beta-invite-email.ts`
- **Functions**: `generateBetaInviteHtml()`, `generateBetaInviteText()`, `sendBetaInvite()`

## Key Points (Editable)

Update these before each send:

1. **14,000+ skills indexed** — the curated catalog of Claude Code skills, screened for your security
2. **Refactored WASM MCP server** — rebuilt for faster startup, lower memory, and broader platform compatibility
3. **Skill Optimizer (CLI)** — cut token usage and improve execution speed with automatic skill decomposition

## Get Started Steps

1. Sign up at [skillsmith.app](https://skillsmith.app) with GitHub
2. Add MCP server: `npx -y @skillsmith/mcp-server`
3. Ask Claude: "Search for testing skills" or "Recommend skills for my project"
4. Try the optimizer: `npx @skillsmith/cli author transform <your-skill>`

## Brand Styling

Matches the early-access confirmation email (`early-access-signup/index.ts`):

| Element | Value |
|---------|-------|
| Font | System font stack (`-apple-system, BlinkMacSystemFont, ...`) |
| Max width | 600px |
| Text color | `#3F3F46` (body), `#0D0D0F` (headers) |
| Link color | `#E07A5F` (warm coral) |
| Footer color | `#A1A1AA` |
| Code background | `#F4F4F5` |

## Sending via Script

```bash
source .env
# Send to a single recipient
curl -X POST "https://api.resend.com/emails" \
  -H "Authorization: Bearer ${RESEND_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Skillsmith <noreply@skillsmith.app>",
    "to": ["user@example.com"],
    "reply_to": "support@skillsmith.app",
    "subject": "Skillsmith Beta is Live — You'\''re In",
    "html": "<html>...</html>",
    "text": "Plain text version..."
  }'
```

## Sending via Code

```typescript
import { sendBetaInvite } from '../_shared/beta-invite-email.ts'

const result = await sendBetaInvite('user@example.com', Deno.env.get('RESEND_API_KEY')!)
```

## Rate Limiting

Resend enforces rate limits. When sending to multiple recipients:

- Use 2-second spacing between sends to avoid HTTP 429
- Retry failed sends after a brief pause
- Verify delivery status via Resend API: `GET https://api.resend.com/emails?limit=20`

## Database Status Flow

```text
early_access_signups.status: pending → invited → converted
```

After sending, update status to `invited`:

```bash
source .env
curl -X PATCH "${SUPABASE_URL}/rest/v1/early_access_signups?status=eq.pending&email=not.like.*example.com*" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"status": "invited"}'
```
