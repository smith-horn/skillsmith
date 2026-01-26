-- Debug version of handle_new_user function
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS debug_logs (
  id SERIAL PRIMARY KEY,
  message TEXT,
  data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO debug_logs (message, data)
  VALUES ('Starting handle_new_user',
    jsonb_build_object('id', NEW.id, 'email', NEW.email, 'provider', NEW.raw_app_meta_data->>'provider'));

  INSERT INTO profiles (id, email, full_name, tier, role, email_verified)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''), 'community', 'user', FALSE);

  INSERT INTO debug_logs (message, data)
  VALUES ('Profile created successfully', jsonb_build_object('id', NEW.id));

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO debug_logs (message, data)
  VALUES ('ERROR in handle_new_user',
    jsonb_build_object('error', SQLERRM, 'state', SQLSTATE, 'id', NEW.id));
  RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
