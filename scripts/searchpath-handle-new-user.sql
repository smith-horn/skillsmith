-- First clean up test user
DELETE FROM profiles WHERE email = 'ryansmith108@gmail.com';
DELETE FROM auth.users WHERE email = 'ryansmith108@gmail.com';

-- Create function with explicit search_path
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, tier, role, email_verified)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''), 'community', 'user', FALSE);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
