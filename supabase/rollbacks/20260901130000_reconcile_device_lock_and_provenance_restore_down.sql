-- Rollback for 20260901130000_reconcile_device_lock_and_provenance_restore.sql
-- SMI-6345 (Wave 1 Step 2) / SMI-6353
--
-- Restores reconcile_device_inventory() to its pre-SMI-6345 body, verbatim from
-- 20260707000003_reconcile_device_inventory_team_carveout.sql:106-249. Safe to apply
-- via `supabase db execute --file`. No schema objects are created or dropped -- this is
-- a single CREATE OR REPLACE plus the grant triple.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING: THIS RE-OPENS TWO SEPARATE DEFECTS
-- ============================================================================
--
-- 1. THE PROTOCOL LOCK DISAPPEARS. ADR-144 §9 makes a row lock on the device's
--    user_devices row the SHARED serialization point for every writer of
--    device_skills. The restored body takes no explicit lock at all. It still holds
--    one incidentally -- its `INSERT INTO user_devices ... ON CONFLICT DO UPDATE`
--    upsert locks that row before the device_skills statements -- but incidentally is
--    exactly the problem: nothing documents it as a serialization point, nothing stops
--    a later edit from reordering or conditionalizing the upsert, and a writer that
--    touches only device_skills (the Wave 3 classification procedure, any future
--    parity or repair job) participates in it not at all. Rolling back therefore
--    breaks the protocol for every OTHER writer, not just this one.
--
-- 2. THE OWNERSHIP READ GOES BACK TO SELECT-THEN-ACT. The restored body reads
--
--        SELECT d.user_id INTO v_owner FROM user_devices d WHERE d.device_id = ...;
--
--    with no row lock, and only afterwards acts on that value. Under READ COMMITTED
--    each statement takes its own snapshot, so the ownership decision is made on a
--    value another transaction can change before the writes run -- the same TOCTOU
--    shape SMI-6321 fixed one table over (20260901120000, profiles.tier).
--
-- 3. author / license / repository ARE SILENTLY DISCARDED AGAIN (SMI-6353). The
--    restored body omits all three from jsonb_to_recordset's column declaration, the
--    DISTINCT ON projection, the INSERT column list, the SELECT list and the ON
--    CONFLICT SET clause. Nothing errors: jsonb_to_recordset simply does not project a
--    field it was not asked for. The wire keeps sending the values, every push keeps
--    throwing them away, and get_user_inventory keeps serving NULL -- degrading
--    skill_state from 'source-identified' to 'local' for exactly the rows SMI-5442
--    added those columns to differentiate. This is the regression that already shipped
--    once, undetected, for two months.
--
-- Also NOT restored by this file, and worth knowing before you run it: the payload-size
-- bound moves back BELOW the ownership guard, so an oversized cross-user push again
-- raises 'device_owned_by_another_user' (42501) rather than 'too_many_skills' (54000),
-- and again reaches the device row before being rejected.
--
-- If the reason for rolling back is lock CONTENTION rather than correctness, prefer
-- applying 20260901120000_purge_departed_inventory_toctou_lock.sql first (it bounds the
-- nightly departure-purge sweep's user_devices DELETE with LIMIT 200 + a lock_timeout,
-- which is the only unbounded competing holder of this lock) over removing the lock.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION reconcile_device_inventory(
  p_device JSONB,
  p_skills JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_consent   BOOLEAN;
  v_device_id UUID;
  v_owner     UUID;
  v_present   INT := 0;
  v_absent    INT := 0;
BEGIN
  -- Auth: the gateway already verified the JWT (verify_jwt = true), but defend
  -- in depth in case the function is ever invoked without a forwarded header.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000';
  END IF;

  -- Consent gate (ADR-124), with the SMI-5575/ADR-126 Team/Enterprise
  -- mandatory-sync carve-out delegated to resolve_inventory_sync_consent().
  v_consent := resolve_inventory_sync_consent(v_uid);

  IF v_consent IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('ok', true, 'applied', false, 'reason', 'consent_disabled');
  END IF;

  -- Input shape (defense in depth -- the RPC is GRANTed to `authenticated`, so a
  -- direct PostgREST caller can hand-craft the body; do not trust the edge fn to
  -- have validated it).
  IF p_device IS NULL OR jsonb_typeof(p_device) <> 'object' THEN
    RAISE EXCEPTION 'device_required' USING ERRCODE = '22023';
  END IF;
  IF p_skills IS NOT NULL AND jsonb_typeof(p_skills) <> 'array' THEN
    RAISE EXCEPTION 'skills_must_be_array' USING ERRCODE = '22023';
  END IF;

  -- Device identity (client-generated UUID, ADR-125 Spike S2).
  v_device_id := NULLIF(p_device->>'device_id', '')::UUID;
  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'device_id_required' USING ERRCODE = '22023';
  END IF;

  -- Ownership guard -- fail closed on a cross-user device_id.
  SELECT d.user_id INTO v_owner FROM user_devices d WHERE d.device_id = v_device_id;
  IF v_owner IS NOT NULL AND v_owner <> v_uid THEN
    RAISE EXCEPTION 'device_owned_by_another_user' USING ERRCODE = '42501';
  END IF;

  -- Payload size bound (defense in depth; the edge fn caps too).
  IF COALESCE(jsonb_array_length(p_skills), 0) > 5000 THEN
    RAISE EXCEPTION 'too_many_skills' USING ERRCODE = '54000';
  END IF;

  -- Upsert the device row (owner = caller). COALESCE preserves a previously set
  -- field when the client omits it on a later push.
  INSERT INTO user_devices AS d (
    device_id, user_id, label, hostname_display, hostname_hash,
    platform, arch, cli_version, last_seen_at
  ) VALUES (
    v_device_id, v_uid,
    NULLIF(p_device->>'label', ''),
    NULLIF(p_device->>'hostname_display', ''),
    NULLIF(p_device->>'hostname_hash', ''),
    NULLIF(p_device->>'platform', ''),
    NULLIF(p_device->>'arch', ''),
    NULLIF(p_device->>'cli_version', ''),
    now()
  )
  ON CONFLICT (device_id) DO UPDATE SET
    label            = COALESCE(EXCLUDED.label, d.label),
    hostname_display = COALESCE(EXCLUDED.hostname_display, d.hostname_display),
    hostname_hash    = COALESCE(EXCLUDED.hostname_hash, d.hostname_hash),
    platform         = COALESCE(EXCLUDED.platform, d.platform),
    arch             = COALESCE(EXCLUDED.arch, d.arch),
    cli_version      = COALESCE(EXCLUDED.cli_version, d.cli_version),
    last_seen_at     = now()
  WHERE d.user_id = v_uid;

  -- Set-reconciliation step 1: mark everything currently recorded as absent.
  UPDATE device_skills ds
  SET present = false
  WHERE ds.device_id = v_device_id AND ds.user_id = v_uid;

  -- Step 2: re-assert the pushed set as present. ON CONFLICT collapses the race
  -- between concurrent pushes (PK = device_id,harness,skill_id) and keeps
  -- last_seen_at monotonic.
  INSERT INTO device_skills AS ds (
    user_id, device_id, harness, skill_id, version, source, content_hash,
    pinned_version, update_policy, present, last_seen_at
  )
  SELECT
    v_uid, v_device_id,
    x.harness, x.skill_id, x.version, x.source, x.content_hash,
    x.pinned_version, x.update_policy, true, now()
  FROM (
    SELECT DISTINCT ON (r.harness, r.skill_id)
      r.harness, r.skill_id, r.version, r.source, r.content_hash,
      r.pinned_version, r.update_policy
    FROM jsonb_to_recordset(COALESCE(p_skills, '[]'::jsonb)) AS r(
      harness        TEXT,
      skill_id       TEXT,
      version        TEXT,
      source         TEXT,
      content_hash   TEXT,
      pinned_version TEXT,
      update_policy  TEXT
    )
    ORDER BY r.harness, r.skill_id
  ) AS x
  ON CONFLICT (device_id, harness, skill_id) DO UPDATE SET
    user_id        = v_uid,
    version        = EXCLUDED.version,
    source         = EXCLUDED.source,
    content_hash   = EXCLUDED.content_hash,
    pinned_version = EXCLUDED.pinned_version,
    update_policy  = EXCLUDED.update_policy,
    present        = true,
    last_seen_at   = GREATEST(ds.last_seen_at, EXCLUDED.last_seen_at);

  GET DIAGNOSTICS v_present = ROW_COUNT;

  SELECT count(*) INTO v_absent
  FROM device_skills ds
  WHERE ds.device_id = v_device_id AND ds.user_id = v_uid AND ds.present = false;

  RETURN jsonb_build_object(
    'ok', true,
    'applied', true,
    'device_id', v_device_id,
    'skills_present', v_present,
    'skills_absent', v_absent
  );
END;
$$;

REVOKE ALL ON FUNCTION reconcile_device_inventory(JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcile_device_inventory(JSONB, JSONB) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION reconcile_device_inventory(JSONB, JSONB) FROM anon;

COMMENT ON FUNCTION reconcile_device_inventory(JSONB, JSONB) IS
  'Atomic per-device inventory reconciliation for the inventory-upload edge fn (ADR-125). '
  'Consent-gated via resolve_inventory_sync_consent() (ADR-124, with the Team/Enterprise '
  'mandatory-sync carve-out from ADR-126, SMI-5575). auth.uid()-scoped; marks vanished skills '
  'present=false. Returns {ok,applied,device_id,skills_present,skills_absent}. '
  'ROLLED BACK to the pre-SMI-6345 body: no explicit per-device lock (ADR-144 §9 protocol '
  'broken for every other writer) and author/license/repository silently discarded (SMI-6353).';

COMMIT;
