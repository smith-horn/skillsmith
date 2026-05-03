// SMI-4670 H2 — negative-case smoke fixture.
//
// This file is INTENTIONALLY pinned to an ancient stripe release. The Wave 2
// staleness-sweep workflow runs against a `--scan-path` pointed at this
// fixture directory and must surface a high+ severity advisory plus a
// staleness flag. If the workflow returns "no findings" against this fixture,
// the workflow has silently no-op'd and Wave 2's "no Linear issues filed"
// signal is meaningless (per SMI-4454 P-4 — absence of issues can mean either
// healthy OR broken).
//
// This file MUST NOT import or be imported by any prod code. It lives under
// scripts/tests/fixtures/ which is excluded from the prod scan path.
import Stripe from 'https://esm.sh/stripe@10.0.0'

// Ensure the Stripe symbol is referenced so static analyzers don't drop the
// import as "unused" before regex extraction sees it.
export const FIXTURE_STRIPE_VERSION_FOR_NEGATIVE_CASE = 'stripe@10.0.0'
export const FIXTURE_STRIPE_HANDLE = Stripe
