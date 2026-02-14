-- Early Access Signups Table
-- SMI-XXXX: Email capture for beta landing page
--
-- Captures email signups from homepage forms with source tracking,
-- UTM parameters, and status lifecycle management.

CREATE TABLE IF NOT EXISTS early_access_signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL CHECK (char_length(email) <= 320),
  source TEXT NOT NULL DEFAULT 'homepage_hero'
    CHECK (source IN ('homepage_hero', 'homepage_cta', 'api', 'other')),
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'invited', 'converted')),
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique on lowercase email for duplicate handling
CREATE UNIQUE INDEX idx_early_access_email_unique ON early_access_signups(LOWER(email));

-- Index for status queries (e.g., finding pending signups to invite)
CREATE INDEX idx_early_access_status ON early_access_signups(status);

-- Index for analytics queries by source
CREATE INDEX idx_early_access_source ON early_access_signups(source);

-- Index for date-based queries
CREATE INDEX idx_early_access_created_at ON early_access_signups(created_at DESC);

-- Enable RLS (admin only via service role)
ALTER TABLE early_access_signups ENABLE ROW LEVEL SECURITY;

-- No RLS policies = service role only access (secure by default)
-- Admin dashboard will use service role key to query signups

COMMENT ON TABLE early_access_signups IS 'Email signups for early access / beta waitlist';
COMMENT ON COLUMN early_access_signups.source IS 'Where the signup originated: homepage_hero, homepage_cta, api, other';
COMMENT ON COLUMN early_access_signups.status IS 'Lifecycle: pending -> verified -> invited -> converted';
