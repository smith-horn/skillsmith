# Skillsmith Auth Email Templates

Version-controlled source for Supabase Auth email templates (SMI-2758).

**Apply in**: Supabase Dashboard → Authentication → Email Templates
**From name**: Skillsmith
**From address**: `noreply@skillsmith.app` (configure via Resend SMTP in Auth → SMTP Settings)

> **Storage decision**: This file is unencrypted (`.claude/development/`). Template content
> is branding/layout HTML only — no credentials, tokens, or security-sensitive detail.
> Move to `.claude/plans/` if that ever changes.

---

## Design Tokens

| Token | Value | Usage |
|-------|-------|-------|
| Background | `#0d0d0f` | Email outer background |
| Card | `#1a1a1f` | Content card background |
| Border | `#2a2a2f` | Card and divider borders |
| Inset | `#121214` | Security notice backgrounds |
| Coral (CTA) | `#e07a5f` | Button, accent text, logo nodes |
| Text primary | `#fafafa` | Headings, strong content |
| Text secondary | `#9ca3af` | Body copy |
| Text muted | `#6b7280` | Footnotes, expiry notes |
| Text disabled | `#4b5563` | Footer links |
| Font | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` | All text (Satoshi not available in email clients) |

**Logo**: Inline SVG — 4 coral nodes (`#E07A5F`) connected by a white S-curve
(`stroke-opacity: 0.3`), plus "skillsmith" in 26px/700 weight. No remote image dependency.

**Dark mode caveat**: Outlook 2019 and older will override `#0d0d0f` backgrounds with
white. All other modern clients (Gmail, Apple Mail, Outlook 365, iOS Mail) render correctly.

---

## Supabase Variables Reference

| Variable | Description |
|----------|-------------|
| `{{ .ConfirmationURL }}` | Full confirmation/reset/magic-link URL (no longer used — replaced by branded URL below) |
| `{{ .TokenHash }}` | Raw token hash for use in branded URL query param |
| `{{ .NewEmail }}` | New email address (email-change template only) |

**Branded URL pattern** (SMI-2762): All 5 templates now use:
```
https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=<type>
```
The `/auth/confirm` Astro page calls `supabase.auth.verifyOtp({ token_hash, type })` and redirects to the appropriate destination per flow type.

---

## Shared Logo Block

Used at the top of every template:

```html
<table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
  <tr>
    <td style="vertical-align:middle;padding-right:10px;line-height:1;">
      <svg width="24" height="40" viewBox="0 0 16 36" xmlns="http://www.w3.org/2000/svg">
        <path d="M 8 2 Q -2 6, -2 12 Q -2 18, 8 20 Q 8 26, -2 30"
              stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.3" fill="none"/>
        <circle cx="8" cy="2" r="3.5" fill="#E07A5F"/>
        <circle cx="-2" cy="12" r="3.5" fill="#E07A5F"/>
        <circle cx="8" cy="20" r="3.5" fill="#E07A5F"/>
        <circle cx="-2" cy="30" r="3.5" fill="#E07A5F"/>
      </svg>
    </td>
    <td style="vertical-align:middle;line-height:1;">
      <span style="font-size:26px;font-weight:700;color:#fafafa;
                   letter-spacing:-0.02em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        skillsmith
      </span>
    </td>
  </tr>
</table>
```

---

## Template 1 — Confirm Signup

**Supabase location**: Auth → Email Templates → Confirm signup
**Subject**: `Confirm your Skillsmith account`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm your Skillsmith account</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0d0f;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#0d0d0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <tr>
    <td align="center" style="padding:40px 20px;">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <!-- Logo -->
        <tr>
          <td align="center" style="padding-bottom:32px;">
            <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr>
                <td style="vertical-align:middle;padding-right:10px;line-height:1;">
                  <svg width="24" height="40" viewBox="0 0 16 36" xmlns="http://www.w3.org/2000/svg">
                    <path d="M 8 2 Q -2 6, -2 12 Q -2 18, 8 20 Q 8 26, -2 30"
                          stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.3" fill="none"/>
                    <circle cx="8" cy="2" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="12" r="3.5" fill="#E07A5F"/>
                    <circle cx="8" cy="20" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="30" r="3.5" fill="#E07A5F"/>
                  </svg>
                </td>
                <td style="vertical-align:middle;line-height:1;">
                  <span style="font-size:26px;font-weight:700;color:#fafafa;
                               letter-spacing:-0.02em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                    skillsmith
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Card -->
        <tr>
          <td style="background-color:#1a1a1f;border:1px solid #2a2a2f;border-radius:12px;padding:40px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom:16px;">
                  <h1 style="margin:0;font-size:24px;font-weight:700;color:#fafafa;line-height:1.3;">
                    Confirm your email address
                  </h1>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:12px;">
                  <p style="margin:0;font-size:16px;color:#9ca3af;line-height:1.6;">
                    Thanks for signing up for Skillsmith — the agent skills platform for AI-assisted development.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:32px;">
                  <p style="margin:0;font-size:16px;color:#9ca3af;line-height:1.6;">
                    Click the button below to verify your email address and activate your account.
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <a href="https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=signup"
                     style="display:inline-block;background-color:#e07a5f;color:#ffffff;
                            font-size:16px;font-weight:600;text-decoration:none;
                            padding:14px 32px;border-radius:8px;line-height:1;">
                    Verify email address
                  </a>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:24px;">
                  <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;text-align:center;">
                    This link expires in 24 hours. If you didn't create a Skillsmith account, you can safely ignore this email.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #2a2a2f;padding-top:24px;">
                  <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
                    Having trouble with the button? Copy and paste this link into your browser:
                  </p>
                  <p style="margin:8px 0 0;font-size:12px;color:#e07a5f;word-break:break-all;
                             font-family:'JetBrains Mono',Menlo,monospace;">
                    https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=signup
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding-top:24px;">
            <p style="margin:0;font-size:12px;color:#4b5563;line-height:1.6;">
              Skillsmith &middot; <a href="https://www.skillsmith.app" style="color:#6b7280;text-decoration:none;">skillsmith.app</a>
              &middot; <a href="https://www.skillsmith.app/privacy" style="color:#6b7280;text-decoration:none;">Privacy</a>
              &middot; <a href="https://www.skillsmith.app/terms" style="color:#6b7280;text-decoration:none;">Terms</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
```

---

## Template 2 — Magic Link

**Supabase location**: Auth → Email Templates → Magic Link
**Subject**: `Your Skillsmith sign-in link`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Skillsmith sign-in link</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0d0f;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#0d0d0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <tr>
    <td align="center" style="padding:40px 20px;">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <!-- Logo -->
        <tr>
          <td align="center" style="padding-bottom:32px;">
            <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr>
                <td style="vertical-align:middle;padding-right:10px;line-height:1;">
                  <svg width="24" height="40" viewBox="0 0 16 36" xmlns="http://www.w3.org/2000/svg">
                    <path d="M 8 2 Q -2 6, -2 12 Q -2 18, 8 20 Q 8 26, -2 30"
                          stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.3" fill="none"/>
                    <circle cx="8" cy="2" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="12" r="3.5" fill="#E07A5F"/>
                    <circle cx="8" cy="20" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="30" r="3.5" fill="#E07A5F"/>
                  </svg>
                </td>
                <td style="vertical-align:middle;line-height:1;">
                  <span style="font-size:26px;font-weight:700;color:#fafafa;
                               letter-spacing:-0.02em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                    skillsmith
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Card -->
        <tr>
          <td style="background-color:#1a1a1f;border:1px solid #2a2a2f;border-radius:12px;padding:40px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom:16px;">
                  <h1 style="margin:0;font-size:24px;font-weight:700;color:#fafafa;line-height:1.3;">
                    Your sign-in link
                  </h1>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:32px;">
                  <p style="margin:0;font-size:16px;color:#9ca3af;line-height:1.6;">
                    You requested a passwordless sign-in link for Skillsmith. Click the button below to sign in — no password needed.
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <a href="https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink"
                     style="display:inline-block;background-color:#e07a5f;color:#ffffff;
                            font-size:16px;font-weight:600;text-decoration:none;
                            padding:14px 32px;border-radius:8px;line-height:1;">
                    Sign in to Skillsmith
                  </a>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:24px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#121214;border:1px solid #2a2a2f;border-radius:8px;padding:16px;">
                        <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">
                          &#128274; This link expires in <strong style="color:#9ca3af;">10 minutes</strong> and can only be used once. If you didn't request this, you can safely ignore it — your account is not at risk.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #2a2a2f;padding-top:24px;">
                  <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
                    Having trouble with the button? Copy and paste this link into your browser:
                  </p>
                  <p style="margin:8px 0 0;font-size:12px;color:#e07a5f;word-break:break-all;
                             font-family:'JetBrains Mono',Menlo,monospace;">
                    https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding-top:24px;">
            <p style="margin:0;font-size:12px;color:#4b5563;line-height:1.6;">
              Skillsmith &middot; <a href="https://www.skillsmith.app" style="color:#6b7280;text-decoration:none;">skillsmith.app</a>
              &middot; <a href="https://www.skillsmith.app/privacy" style="color:#6b7280;text-decoration:none;">Privacy</a>
              &middot; <a href="https://www.skillsmith.app/terms" style="color:#6b7280;text-decoration:none;">Terms</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
```

---

## Template 3 — Password Reset

**Supabase location**: Auth → Email Templates → Reset password
**Subject**: `Reset your Skillsmith password`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your Skillsmith password</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0d0f;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#0d0d0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <tr>
    <td align="center" style="padding:40px 20px;">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <!-- Logo -->
        <tr>
          <td align="center" style="padding-bottom:32px;">
            <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr>
                <td style="vertical-align:middle;padding-right:10px;line-height:1;">
                  <svg width="24" height="40" viewBox="0 0 16 36" xmlns="http://www.w3.org/2000/svg">
                    <path d="M 8 2 Q -2 6, -2 12 Q -2 18, 8 20 Q 8 26, -2 30"
                          stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.3" fill="none"/>
                    <circle cx="8" cy="2" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="12" r="3.5" fill="#E07A5F"/>
                    <circle cx="8" cy="20" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="30" r="3.5" fill="#E07A5F"/>
                  </svg>
                </td>
                <td style="vertical-align:middle;line-height:1;">
                  <span style="font-size:26px;font-weight:700;color:#fafafa;
                               letter-spacing:-0.02em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                    skillsmith
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Card -->
        <tr>
          <td style="background-color:#1a1a1f;border:1px solid #2a2a2f;border-radius:12px;padding:40px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom:16px;">
                  <h1 style="margin:0;font-size:24px;font-weight:700;color:#fafafa;line-height:1.3;">
                    Reset your password
                  </h1>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:32px;">
                  <p style="margin:0;font-size:16px;color:#9ca3af;line-height:1.6;">
                    We received a request to reset the password for your Skillsmith account. Click the button below to choose a new password.
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <a href="https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=recovery"
                     style="display:inline-block;background-color:#e07a5f;color:#ffffff;
                            font-size:16px;font-weight:600;text-decoration:none;
                            padding:14px 32px;border-radius:8px;line-height:1;">
                    Reset password
                  </a>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:24px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#121214;border:1px solid #2a2a2f;border-radius:8px;padding:16px;">
                        <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;">
                          &#128274; This link expires in <strong style="color:#9ca3af;">1 hour</strong>. If you didn't request a password reset, your account is secure — no action needed.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #2a2a2f;padding-top:24px;">
                  <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
                    Having trouble with the button? Copy and paste this link into your browser:
                  </p>
                  <p style="margin:8px 0 0;font-size:12px;color:#e07a5f;word-break:break-all;
                             font-family:'JetBrains Mono',Menlo,monospace;">
                    https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=recovery
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding-top:24px;">
            <p style="margin:0;font-size:12px;color:#4b5563;line-height:1.6;">
              Skillsmith &middot; <a href="https://www.skillsmith.app" style="color:#6b7280;text-decoration:none;">skillsmith.app</a>
              &middot; <a href="https://www.skillsmith.app/privacy" style="color:#6b7280;text-decoration:none;">Privacy</a>
              &middot; <a href="https://www.skillsmith.app/terms" style="color:#6b7280;text-decoration:none;">Terms</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
```

---

## Template 4 — Email Change

**Supabase location**: Auth → Email Templates → Change email address
**Subject**: `Confirm your new Skillsmith email address`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm your new Skillsmith email address</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0d0f;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#0d0d0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <tr>
    <td align="center" style="padding:40px 20px;">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <!-- Logo -->
        <tr>
          <td align="center" style="padding-bottom:32px;">
            <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr>
                <td style="vertical-align:middle;padding-right:10px;line-height:1;">
                  <svg width="24" height="40" viewBox="0 0 16 36" xmlns="http://www.w3.org/2000/svg">
                    <path d="M 8 2 Q -2 6, -2 12 Q -2 18, 8 20 Q 8 26, -2 30"
                          stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.3" fill="none"/>
                    <circle cx="8" cy="2" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="12" r="3.5" fill="#E07A5F"/>
                    <circle cx="8" cy="20" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="30" r="3.5" fill="#E07A5F"/>
                  </svg>
                </td>
                <td style="vertical-align:middle;line-height:1;">
                  <span style="font-size:26px;font-weight:700;color:#fafafa;
                               letter-spacing:-0.02em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                    skillsmith
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Card -->
        <tr>
          <td style="background-color:#1a1a1f;border:1px solid #2a2a2f;border-radius:12px;padding:40px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom:16px;">
                  <h1 style="margin:0;font-size:24px;font-weight:700;color:#fafafa;line-height:1.3;">
                    Confirm your new email address
                  </h1>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:24px;">
                  <p style="margin:0;font-size:16px;color:#9ca3af;line-height:1.6;">
                    You requested an email address change on your Skillsmith account. Click below to confirm your new address.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:32px;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="background-color:#121214;border:1px solid #2a2a2f;border-left:3px solid #e07a5f;border-radius:0 8px 8px 0;padding:16px;">
                        <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">
                          New email address
                        </p>
                        <p style="margin:0;font-size:16px;color:#fafafa;font-weight:600;
                                   font-family:'JetBrains Mono',Menlo,monospace;">
                          {{ .NewEmail }}
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <a href="https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=email_change"
                     style="display:inline-block;background-color:#e07a5f;color:#ffffff;
                            font-size:16px;font-weight:600;text-decoration:none;
                            padding:14px 32px;border-radius:8px;line-height:1;">
                    Confirm new email
                  </a>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:24px;">
                  <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;text-align:center;">
                    This link expires in 24 hours. If you didn't request this change, please <a href="https://www.skillsmith.app/contact" style="color:#e07a5f;text-decoration:none;">contact support</a> immediately.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #2a2a2f;padding-top:24px;">
                  <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
                    Having trouble with the button? Copy and paste this link into your browser:
                  </p>
                  <p style="margin:8px 0 0;font-size:12px;color:#e07a5f;word-break:break-all;
                             font-family:'JetBrains Mono',Menlo,monospace;">
                    https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=email_change
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding-top:24px;">
            <p style="margin:0;font-size:12px;color:#4b5563;line-height:1.6;">
              Skillsmith &middot; <a href="https://www.skillsmith.app" style="color:#6b7280;text-decoration:none;">skillsmith.app</a>
              &middot; <a href="https://www.skillsmith.app/privacy" style="color:#6b7280;text-decoration:none;">Privacy</a>
              &middot; <a href="https://www.skillsmith.app/terms" style="color:#6b7280;text-decoration:none;">Terms</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
```

---

## Template 5 — Invite User

**Supabase location**: Auth → Email Templates → Invite user
**Subject**: `You've been invited to Skillsmith`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You've been invited to Skillsmith</title>
</head>
<body style="margin:0;padding:0;background-color:#0d0d0f;">
<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#0d0d0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <tr>
    <td align="center" style="padding:40px 20px;">
      <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <!-- Logo -->
        <tr>
          <td align="center" style="padding-bottom:32px;">
            <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
              <tr>
                <td style="vertical-align:middle;padding-right:10px;line-height:1;">
                  <svg width="24" height="40" viewBox="0 0 16 36" xmlns="http://www.w3.org/2000/svg">
                    <path d="M 8 2 Q -2 6, -2 12 Q -2 18, 8 20 Q 8 26, -2 30"
                          stroke="#ffffff" stroke-width="1.2" stroke-opacity="0.3" fill="none"/>
                    <circle cx="8" cy="2" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="12" r="3.5" fill="#E07A5F"/>
                    <circle cx="8" cy="20" r="3.5" fill="#E07A5F"/>
                    <circle cx="-2" cy="30" r="3.5" fill="#E07A5F"/>
                  </svg>
                </td>
                <td style="vertical-align:middle;line-height:1;">
                  <span style="font-size:26px;font-weight:700;color:#fafafa;
                               letter-spacing:-0.02em;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
                    skillsmith
                  </span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Card -->
        <tr>
          <td style="background-color:#1a1a1f;border:1px solid #2a2a2f;border-radius:12px;padding:40px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom:16px;">
                  <h1 style="margin:0;font-size:24px;font-weight:700;color:#fafafa;line-height:1.3;">
                    You've been invited
                  </h1>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:12px;">
                  <p style="margin:0;font-size:16px;color:#9ca3af;line-height:1.6;">
                    You've been invited to join Skillsmith — the agent skills platform for AI-assisted development.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:32px;">
                  <p style="margin:0;font-size:16px;color:#9ca3af;line-height:1.6;">
                    Click the button below to accept your invitation and set up your account.
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:32px;">
                  <a href="https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=invite"
                     style="display:inline-block;background-color:#e07a5f;color:#ffffff;
                            font-size:16px;font-weight:600;text-decoration:none;
                            padding:14px 32px;border-radius:8px;line-height:1;">
                    Accept invitation
                  </a>
                </td>
              </tr>
              <tr>
                <td style="padding-bottom:24px;">
                  <p style="margin:0;font-size:14px;color:#6b7280;line-height:1.6;text-align:center;">
                    This invitation expires in 24 hours. If you weren't expecting this, you can safely ignore it.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #2a2a2f;padding-top:24px;">
                  <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
                    Having trouble with the button? Copy and paste this link into your browser:
                  </p>
                  <p style="margin:8px 0 0;font-size:12px;color:#e07a5f;word-break:break-all;
                             font-family:'JetBrains Mono',Menlo,monospace;">
                    https://www.skillsmith.app/auth/confirm?token_hash={{ .TokenHash }}&type=invite
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding-top:24px;">
            <p style="margin:0;font-size:12px;color:#4b5563;line-height:1.6;">
              Skillsmith &middot; <a href="https://www.skillsmith.app" style="color:#6b7280;text-decoration:none;">skillsmith.app</a>
              &middot; <a href="https://www.skillsmith.app/privacy" style="color:#6b7280;text-decoration:none;">Privacy</a>
              &middot; <a href="https://www.skillsmith.app/terms" style="color:#6b7280;text-decoration:none;">Terms</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>
```

---

## Application Checklist

- [ ] Configure Resend SMTP in Supabase: Auth → SMTP Settings → `smtp.resend.com`, port 465, from `noreply@skillsmith.app`
- [ ] Paste Template 1 into Auth → Email Templates → Confirm signup; set subject
- [ ] Paste Template 2 into Auth → Email Templates → Magic Link; set subject
- [ ] Paste Template 3 into Auth → Email Templates → Reset password; set subject
- [ ] Paste Template 4 into Auth → Email Templates → Change email address; set subject
- [ ] Paste Template 5 into Auth → Email Templates → Invite user; set subject
- [ ] Send a test email from each template type to a personal inbox to verify rendering
- [ ] Check From name reads "Skillsmith" in inbox
- [ ] Check From address reads `noreply@skillsmith.app`
