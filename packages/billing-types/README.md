# @skillsmith/billing-types

Types-only contract shared between [`@skillsmith/mcp-server`](https://www.npmjs.com/package/@skillsmith/mcp-server) and `@smith-horn/enterprise`. Introduced in SMI-5044 to break a workspace cycle: the standalone Stripe webhook HTTP endpoint in mcp-server needs the handler's structural shape, but the canonical runtime class lives in the enterprise package, which transitively depends on mcp-server. By depending on this types-only package instead, both consumers stay decoupled.

No runtime code. Exports:

- `StripeWebhookHandler` — the structural interface implemented by `@smith-horn/enterprise/billing`'s canonical class.
- `StripeWebhookResult` — the return shape of `handleWebhook()`.

License: Elastic-2.0.
