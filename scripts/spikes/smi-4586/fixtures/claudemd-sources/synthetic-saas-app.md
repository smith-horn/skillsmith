# CLAUDE.md - SaaS Application

Synthetic CLAUDE.md modeled on common SaaS app dotfile patterns. **SYNTHETIC** —
provenance recorded in MANIFEST.json.

## Tech stack

- Next.js 14 App Router
- Postgres + Drizzle ORM
- Stripe billing
- Vercel deployment

## Skills available

- billing-flows — Use when implementing or debugging Stripe checkout, webhooks, or invoicing.
- auth-flows — Use when wiring up sign-in, sign-up, password reset, or OAuth.
- email-templates — Use when adding or modifying transactional emails.

## Trigger phrases

These phrases route to specific skill invocations:

* "review my checkout flow" — invokes billing-flows
* "add OAuth provider" — invokes auth-flows
* "create a welcome email" — invokes email-templates
* "build the dashboard widget" — generic; route via task router
* "deploy preview" — runs the Vercel preview deploy workflow
* "test the webhook locally" — starts ngrok + Stripe CLI

## Use when

- Use when the user asks to add a new pricing tier — start with billing-flows.
- Use when the user reports a 401 from a webhook — start with auth-flows.
- Use when the user wants to A/B-test an email subject line — start with email-templates.

## Conventions

- Server components by default; mark client components explicitly with "use client".
- All database access goes through Drizzle — never raw SQL in route handlers.
- Stripe events handled via the `/api/webhooks/stripe` route only.
