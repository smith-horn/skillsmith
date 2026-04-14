-- SMI-4202 rollback: Re-quarantine skills that would be stale per the
-- pre-Wave-3 3-day threshold. Deterministic and time-based — no dependency
-- on ID lists from the forward migration (064's audit log was capped at
-- 1k, leaving 8,882 unrecoverable via ID replay).
--
-- Use only if the forward migration unquarantined rows that should have
-- stayed quarantined (e.g., bug discovered in finding-filter logic).
-- Does NOT restore per-row security_findings stale entries precisely —
-- any row with last_seen_at older than 3 days is flagged stale again.

UPDATE skills
SET
  quarantined = TRUE,
  quarantine_reason = 'stale',
  security_findings = CASE
    WHEN jsonb_typeof(security_findings) = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(security_findings) f
        WHERE f->>'type' = 'stale'
      )
    THEN security_findings || '[{"type":"stale"}]'::jsonb
    WHEN jsonb_typeof(security_findings) = 'array'
    THEN security_findings
    ELSE '[{"type":"stale"}]'::jsonb
  END
WHERE quarantined = FALSE
  AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '3 days');

INSERT INTO audit_logs (event_type, actor, action, result, metadata)
VALUES (
  'stale_quarantine_cascade_fix',
  'rollback',
  'bulk_requarantine',
  'completed',
  jsonb_build_object(
    'description', 'Rollback of SMI-4202 bulk unquarantine (time-based re-quarantine at 3d threshold)',
    'executed_at', NOW()
  )
);
