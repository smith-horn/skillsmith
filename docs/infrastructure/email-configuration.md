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
| `@` | `inbound-smtp.resend.com` | 10 | Inbound email receiving |
| `send` | `feedback-smtp.us-east-1.amazonses.com` | 10 | Outbound email (Resend/SES) |

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
1. Verifies webhook signature using `RESEND_WEBHOOK_SECRET`
2. Fetches full email content from Resend API
3. Forwards to `support@smithhorn.ca` with original sender as reply-to

**From Address:** `Skillsmith Inbound <inbound@skillsmith.app>`

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
1. Verify MX record points to `inbound-smtp.resend.com`
2. Check webhook is registered in Resend
3. Verify `RESEND_WEBHOOK_SECRET` matches webhook signing secret
4. Check function logs for errors

### DMARC Reports
View in Cloudflare Dashboard → skillsmith.app → Email → DMARC Management

---

## Related

- [Resend Dashboard](https://resend.com/overview)
- [Supabase Functions](https://supabase.com/dashboard/project/vrcnzpmndtroqxxoqkzy/functions)
- [Cloudflare DNS](https://dash.cloudflare.com)
- Linear Issue: SMI-1574
