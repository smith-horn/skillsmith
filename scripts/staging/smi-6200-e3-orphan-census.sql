-- Z0. Orphan census for the SMI-6200 governance surface.
-- Run: ./scripts/pooler-psql.sh -f - < scripts/staging/smi-6200-e3-orphan-census.sql
-- (pooler-psql.sh docker-execs; pipe on stdin, do not pass -f <hostpath>.)
\pset format aligned
\echo '=== Z0 orphan census ==='

-- 1. Permission grants whose team no longer has SSO configured at all.
--    These are NOT wrong on their own (grants are independent of SSO) -- the finding is a
--    grant that was CREATED to shape an SSO-provisioned cohort and now applies to a cohort
--    that no longer exists. Cross-reference the count with #2.
SELECT 'grants_on_teams_without_sso_settings' AS metric, count(*) AS n
  FROM team_permission_grants g
 WHERE NOT EXISTS (SELECT 1 FROM team_sso_settings s WHERE s.team_id = g.team_id);

-- 2. Permission grants for a (team, role) pair that currently has ZERO members.
--    A grant nobody holds is inert today and silently re-arms the moment someone is
--    assigned that role. This is the concrete shape of Round 2 finding #21.
SELECT 'grants_for_roles_with_no_members' AS metric, count(*) AS n
  FROM team_permission_grants g
 WHERE NOT EXISTS (
   SELECT 1 FROM team_members tm WHERE tm.team_id = g.team_id AND tm.role = g.role);

-- 3. Grants whose creating user is gone (created_by is ON DELETE SET NULL).
SELECT 'grants_with_null_created_by' AS metric, count(*) AS n
  FROM team_permission_grants WHERE created_by IS NULL;

-- 4. team_members still tagged provisioned_via='sso' on a team with no SSO settings row.
--    The inline freshness gate reads a NULL reverify_days and fails closed => these users
--    hold a membership row that can never grant anything and that the sweep's behaviour
--    against a missing settings row does not define. Permanently-denied zombies.
SELECT 'sso_members_without_sso_settings' AS metric, count(*) AS n
  FROM team_members tm
 WHERE tm.provisioned_via = 'sso'
   AND NOT EXISTS (SELECT 1 FROM team_sso_settings s WHERE s.team_id = tm.team_id);

-- 5. team_members tagged 'sso' on a team the expiry sweep will not touch, because
--    sso_expiry_eligible() is false (settings inactive, or the domain lost DNS
--    verification). This is the DESIGNED safety valve -- but has_team_permission()'s
--    freshness gate has no matching pause, so these members are simultaneously
--    permission-denied and unexpirable. Poison P-8. Expect 0 in steady state; a
--    persistent non-zero value is a team stuck in that state.
SELECT 'sso_members_frozen_by_expiry_pause' AS metric, count(*) AS n
  FROM team_members tm
 WHERE tm.provisioned_via = 'sso'
   AND tm.role <> 'owner'
   AND EXISTS (SELECT 1 FROM team_sso_settings s WHERE s.team_id = tm.team_id)
   AND NOT sso_expiry_eligible(tm.team_id);

-- 6. SSO-provisioned members with a NULL sso_verified_at (treated as expired, never
--    refreshable without a login that maps a role).
SELECT 'sso_members_null_verified_at' AS metric, count(*) AS n
  FROM team_members WHERE provisioned_via = 'sso' AND sso_verified_at IS NULL;

-- 7. SSO-provisioned members already past their team's reverify window that the daily
--    04:25 UTC sweep has not removed, EXCLUDING the deliberately-paused population from
--    #5. A non-zero, non-decreasing value here means the sweep is not running or is
--    silently no-op'ing. Uses the same two helpers the sweep itself uses, so this query
--    and the sweep cannot disagree about what "stale" means.
SELECT 'sso_members_stale_but_not_swept' AS metric, count(*) AS n
  FROM team_members tm
 WHERE tm.provisioned_via = 'sso' AND tm.role <> 'owner'
   AND sso_expiry_eligible(tm.team_id)
   AND (tm.sso_verified_at IS NULL
        OR tm.sso_verified_at < now() - make_interval(days => sso_reverify_days(tm.team_id)));

-- 8. Revoked license keys tagged as SWEEP-revoked whose owner is once again an active,
--    genuinely FRESH member -- i.e. a reissue that should have happened and did not.
--    Freshness is reproduced from the shipped predicate (per-team sso_reverify_days,
--    normally 7 days), NOT a hardcoded 1 day: a hardcoded window silently misses every
--    member between day 1 and their real deadline. Tier-scoped to match
--    record_sso_login()'s own reissue branch, which only touches team/enterprise keys.
SELECT 'sso_revoked_keys_for_active_members' AS metric, count(*) AS n
  FROM license_keys k
 WHERE k.status = 'revoked'
   AND k.tier IN ('team', 'enterprise')
   AND k.metadata->>'revoked_by' = 'sso_expiry'
   AND EXISTS (
     SELECT 1 FROM team_members tm
      WHERE tm.user_id = k.user_id
        AND tm.provisioned_via = 'sso'
        AND (tm.role = 'owner'                      -- owner is exempt from the freshness gate
             OR (tm.sso_verified_at IS NOT NULL
                 AND tm.sso_verified_at
                     >= now() - make_interval(days => sso_reverify_days(tm.team_id)))));

-- 9. Revoked license keys carrying NO revoked_by marker at all, belonging to an active
--    member -- the permanently-unreissuable cohort (poison P-2). Deliberately EXCLUDES
--    'sso_account_link'-marked keys, which are a separate, also-unreissuable cohort
--    counted at #9b: link_sso_account() sets that marker explicitly, so treating them as
--    "unmarked" would both overcount here and hide the distinction the reissue contract
--    actually turns on. Not automatically a defect (a deliberate admin revocation looks
--    identical) -- treat a RISE across an SSO lifecycle as the signal, not the absolute.
SELECT 'revoked_keys_no_marker_active_member' AS metric, count(*) AS n
  FROM license_keys k
 WHERE k.status = 'revoked'
   AND (k.metadata->>'revoked_by') IS NULL
   AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.user_id = k.user_id);

-- 9b. Keys revoked by an identity link, whose original owner is still an active member
--     somewhere. Expected and correct after a link (the entitlement moved to the SSO
--     identity) -- reported so the three revocation cohorts are separable in the census
--     rather than collapsed into "revoked".
SELECT 'link_revoked_keys' AS metric, count(*) AS n
  FROM license_keys
 WHERE status = 'revoked' AND metadata->>'revoked_by' = 'sso_account_link';

-- 10. Non-revoked license keys whose expires_at is in the past (bound at last login and
--     never refreshed) -- a key that is "active" and useless.
SELECT 'active_keys_past_expiry' AS metric, count(*) AS n
  FROM license_keys
 WHERE status <> 'revoked' AND expires_at IS NOT NULL AND expires_at < now();

-- 10b. SSO-provisioned members holding an ACTIVE key OUTSIDE ('team','enterprise').
--      record_sso_login()'s refresh/reissue and expire_stale_sso_members()'s revoke are
--      both tier-scoped, so a key here is entirely outside the SSO deprovisioning story:
--      it survives expiry and IdP removal indefinitely. Correct for a genuine personal
--      Individual subscription; a finding if the SSO fallback path issues keys at that tier.
SELECT 'sso_members_with_out_of_scope_active_key' AS metric, count(*) AS n
  FROM license_keys k
  JOIN team_members tm ON tm.user_id = k.user_id AND tm.provisioned_via = 'sso'
 WHERE k.status <> 'revoked' AND k.tier NOT IN ('team', 'enterprise');

-- 11. sso_account_links rows whose SSO or legacy user no longer exists.
SELECT 'link_rows_with_missing_user' AS metric, count(*) AS n
  FROM sso_account_links l
 WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = l.sso_user_id)
    OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = l.legacy_user_id);

-- 12. sso_account_links rows never linked, whose consent window has lapsed, that nobody
--     GCs. These stay queryable to both parties' read RPCs forever.
SELECT 'link_rows_consent_expired_unlinked' AS metric, count(*) AS n
  FROM sso_account_links
 WHERE linked_at IS NULL
   AND consent_expires_at IS NOT NULL AND consent_expires_at < now();

-- 12b. Completed links whose 7-day manual-reversal window has already closed. Not a
--      defect -- this is the population for whom the product's stated "email support
--      within 7 days and we'll reverse it by hand" promise no longer applies at all.
--      Report the number; it is the size of the irreversible cohort.
SELECT 'links_past_reversible_window' AS metric, count(*) AS n
  FROM sso_account_links
 WHERE linked_at IS NOT NULL
   AND reversible_until IS NOT NULL AND reversible_until < now();

-- 12c. Completed links still inside the reversal window that were never notified --
--      the recipient does not know the link happened and the clock is running.
SELECT 'links_reversible_but_unnotified' AS metric, count(*) AS n
  FROM sso_account_links
 WHERE linked_at IS NOT NULL AND notified_at IS NULL
   AND reversible_until IS NOT NULL AND reversible_until >= now();

-- 13. sso_account_links rows pointing at a team that no longer exists.
--     (team_id is NOT NULL with an ON DELETE CASCADE FK, so a non-zero count here means
--     the FK is gone -- a structural finding, not a data one.)
SELECT 'link_rows_orphan_team' AS metric, count(*) AS n
  FROM sso_account_links l
 WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = l.team_id);

-- 14. team_sso_domains rows whose team has no settings row (claim without config).
SELECT 'domains_without_settings' AS metric, count(*) AS n
  FROM team_sso_domains d
 WHERE NOT EXISTS (SELECT 1 FROM team_sso_settings s WHERE s.team_id = d.team_id);

-- 14b. THE ONE THAT MATTERS MOST (Z3): a VERIFIED domain claim whose team no longer has
--      any SSO configuration. Because team_sso_domains FKs to teams -- not to
--      team_sso_settings -- and team-sso-manage exposes no domain-release action, a
--      verified claim survives SSO removal and keeps occupying the partial unique index
--      team_sso_domains_verified_domain_key, permanently blocking every other tenant from
--      claiming that domain, with no product surface able to free it.
SELECT 'verified_domains_with_no_sso_config' AS metric, count(*) AS n
  FROM team_sso_domains d
 WHERE d.verified_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM team_sso_settings s WHERE s.team_id = d.team_id);

-- 15. Unverified domain claims older than the stated 7-day expiry sweep.
SELECT 'unverified_domain_claims_over_7d' AS metric, count(*) AS n
  FROM team_sso_domains
 WHERE verified_at IS NULL AND created_at < now() - interval '7 days';

-- 16. team_sso_settings rows with status='active' but a NULL provider id. The CHECK
--     should make this impossible; a non-zero count means the constraint is missing.
SELECT 'active_settings_null_provider' AS metric, count(*) AS n
  FROM team_sso_settings WHERE status = 'active' AND supabase_provider_id IS NULL;

-- 17. Duplicate PENDING purge-schedule rows for one user IN ONE TEAM (poison P-5).
--     Keyed by (user_id, departed_team_id) -- a user legitimately departing two different
--     teams has two rows and is NOT a zombie, which a bare user_id grouping would
--     miscount. Restricted to pending rows (purged_at IS NULL AND cancelled_reason IS
--     NULL), since a completed and a subsequent pending row are also legitimate.
SELECT 'user_team_pairs_with_multiple_pending_purge_rows' AS metric, count(*) AS n
  FROM (SELECT user_id, departed_team_id
          FROM team_member_inventory_purge_schedule
         WHERE purged_at IS NULL AND cancelled_reason IS NULL
         GROUP BY user_id, departed_team_id HAVING count(*) > 1) q;

-- 18. Shadow accounts: a non-SSO auth.users row sharing an SSO user's email
--     (the SMI-6206 IdP bypass -- the standing regression check).
SELECT 'shadow_account_email_pairs' AS metric, count(*) AS n
  FROM (SELECT lower(email) AS e FROM auth.users WHERE email IS NOT NULL
         GROUP BY lower(email)
        HAVING count(*) FILTER (WHERE is_sso_user) > 0
           AND count(*) FILTER (WHERE NOT is_sso_user) > 0) q;
