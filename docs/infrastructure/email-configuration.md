# Email Configuration

**Last Updated:** 2026-01-18
**Status:** Production
**Provider:** [Resend](https://resend.com) (Pro Plan)

---

## Overview

Skillsmith uses Resend for all email operations:
- **Outbound**: Contact form notifications, transactional emails
- **Inbound**: Email forwarding from `*@skillsmith.app` to `support@smithhorn.ca`

---

## DNS Configuration (Cloudflare)

### MX Records

| Name | Content | Priority | Purpose |
|------|---------|----------|---------|
| `@` | `inbound-smtp.us-east-1.amazonaws.com` | 10 | Inbound email receiving (Resend via SES) |
| `send` | `feedback-smtp.us-east-1.amazonses.com` | 10 | Outbound bounce handling (Resend/SES) |

> **Note:** Resend uses Amazon SES infrastructure. The MX record was auto-configured via Resend's Cloudflare integration.

### TXT Records

| Name | Content | Purpose |
|------|---------|---------|
| `@` | `v=spf1 include:amazonses.com include:resend.com ~all` | SPF - Authorize senders |
| `resend._domainkey` | `p=MIGfMA0GCSqGSIb3...` | DKIM - Email signing |
| `_dmarc` | `v=DMARC1; p=none; rua=mailto:...@dmarc-reports.cloudflare.net` | DMARC - Reporting |

---

## Resend Configuration

### Domain
- **Domain:** skillsmith.app
- **Region:** us-east-1
- **Capabilities:** Sending ✓, Receiving ✓

### Webhooks

| Endpoint | Events | Purpose |
|----------|--------|---------|
| `https://api.skillsmith.app/functions/v1/email-inbound` | `email.received` | Forward inbound emails |

---

## Supabase Edge Functions

### contact-submit

Handles contact form submissions from the website.

**Endpoint:** `POST /functions/v1/contact-submit`

**Flow:**
1. Validates form input (name, email, topic, message)
2. Stores submission in `contact_submissions` table
3. Sends email notification to `support@smithhorn.ca`

**From Address:** `Skillsmith Contact <contact@skillsmith.app>`

### email-inbound

Receives inbound email webhooks from Resend and forwards to support.

**Endpoint:** `POST /functions/v1/email-inbound`

**Flow:**
1. Receives `email.received` webhook from Resend
2. Extracts email content directly from webhook payload (no separate API fetch needed)
3. Forwards to `support@smithhorn.ca` with original sender as reply-to

**From Address:** `Skillsmith Inbound <inbound@skillsmith.app>`

**Webhook Payload Structure:**
```typescript
interface ResendInboundPayload {
  type: 'email.received'
  created_at: string
  data: {
    id: string           // Unique email ID
    from: string         // Sender address
    to: string[]         // Recipient addresses
    subject: string      // Email subject
    text?: string        // Plain text body
    html?: string        // HTML body
    date: string         // Email date
    thread_id?: string   // Threading ID
    in_reply_to?: string // Reply reference
  }
}
```

> **Important:** Resend sends the full email content in the webhook payload. Earlier versions incorrectly tried to fetch content via API.

---

## Environment Variables

| Variable | Location | Purpose |
|----------|----------|---------|
| `RESEND_API_KEY` | Supabase Secrets, `.env` | API authentication |
| `RESEND_WEBHOOK_SECRET` | Supabase Secrets, `.env` | Webhook signature verification |

Both are secured with Varlock (`@sensitive` annotation in `.env.schema`).

---

## Email Addresses

All `*@skillsmith.app` addresses forward to `support@smithhorn.ca`:

| Address | Use Case |
|---------|----------|
| `contact@skillsmith.app` | Contact form sender |
| `inbound@skillsmith.app` | Forwarded email sender |
| `info@skillsmith.app` | General inquiries |
| `support@skillsmith.app` | Technical support |

---

## Testing

### Test Outbound (Contact Form)
```bash
curl -X POST https://api.skillsmith.app/functions/v1/contact-submit \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","topic":"general","message":"Test message"}'
```

### Test Inbound
Send an email to any `*@skillsmith.app` address. It should be forwarded to `support@smithhorn.ca`.

### Verify DNS
```bash
dig +short MX skillsmith.app
dig +short TXT skillsmith.app | grep spf
dig +short TXT _dmarc.skillsmith.app
dig +short TXT resend._domainkey.skillsmith.app
```

---

## Troubleshooting

### Emails not sending
1. Check `RESEND_API_KEY` is set in Supabase secrets
2. Verify domain is verified in Resend dashboard
3. Check function logs in Supabase dashboard

### Inbound emails not forwarding
1. Verify MX record points to `inbound-smtp.us-east-1.amazonaws.com` (use Google DNS: `dig +short MX skillsmith.app @8.8.8.8`)
2. Check webhook is registered in Resend Dashboard → Webhooks
3. Verify `email.received` event is selected for the webhook
4. Check Resend Dashboard → Emails → Inbound to see if email was received
5. Check function logs in Supabase Dashboard → Functions → email-inbound → Logs

### DMARC Reports
View in Cloudflare Dashboard → skillsmith.app → Email → DMARC Management

---

## Related

- [Resend Dashboard](https://resend.com/overview)
- [Supabase Functions](https://supabase.com/dashboard/project/vrcnzpmndtroqxxoqkzy/functions)
- [Cloudflare DNS](https://dash.cloudflare.com)
- Linear Issue: SMI-1574
