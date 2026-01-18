-- Contact form submissions table
-- Stores messages from the website contact form

CREATE TABLE IF NOT EXISTS contact_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  topic TEXT NOT NULL CHECK (topic IN ('general', 'support', 'sales', 'enterprise', 'partnership', 'feedback', 'bug', 'other')),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'replied', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for listing submissions by status and date
CREATE INDEX IF NOT EXISTS idx_contact_submissions_status_created
  ON contact_submissions(status, created_at DESC);

-- Index for email lookups (finding all submissions from same person)
CREATE INDEX IF NOT EXISTS idx_contact_submissions_email
  ON contact_submissions(email);

-- Enable RLS
ALTER TABLE contact_submissions ENABLE ROW LEVEL SECURITY;

-- Only service role can access contact submissions (admin only)
-- No public access policy - only accessible via service role key

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_contact_submissions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contact_submissions_updated_at
  BEFORE UPDATE ON contact_submissions
  FOR EACH ROW
  EXECUTE FUNCTION update_contact_submissions_updated_at();

COMMENT ON TABLE contact_submissions IS 'Contact form submissions from the website';
COMMENT ON COLUMN contact_submissions.status IS 'Submission status: new, read, replied, archived';
COMMENT ON COLUMN contact_submissions.topic IS 'Contact topic/category selected by user';
