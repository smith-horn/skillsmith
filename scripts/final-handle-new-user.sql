-- Final handle_new_user function with GitHub metadata support
-- The key fix: SET search_path = public

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  provider TEXT;
  github_username_val TEXT;
  github_id_val TEXT;
  full_name_val TEXT;
  avatar_url_val TEXT;
BEGIN
  provider := COALESCE(NEW.raw_app_meta_data->>'provider', 'email');

  IF provider = 'github' THEN
    github_username_val := COALESCE(
      NEW.raw_user_meta_data->>'user_name',
      NEW.raw_user_meta_data->>'preferred_username'
    );
    github_id_val := NEW.raw_user_meta_data->>'provider_id';
    full_name_val := COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      github_username_val,
      ''
    );
    avatar_url_val := NEW.raw_user_meta_data->>'avatar_url';
  ELSE
    github_username_val := NULL;
    github_id_val := NULL;
    full_name_val := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
    avatar_url_val := NEW.raw_user_meta_data->>'avatar_url';
  END IF;

  INSERT INTO public.profiles (
    id, email, full_name, avatar_url,
    github_username, github_id, auth_provider,
    tier, role, email_verified, email_verified_at
  )
  VALUES (
    NEW.id, NEW.email, full_name_val, avatar_url_val,
    github_username_val, github_id_val, provider,
    'community', 'user',
    CASE WHEN provider = 'github' THEN TRUE ELSE FALSE END,
    CASE WHEN provider = 'github' THEN NOW() ELSE NULL END
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update existing profile with GitHub info
UPDATE public.profiles SET
  github_username = 'wrsmith108',
  github_id = '62075823',
  auth_provider = 'github',
  avatar_url = 'https://avatars.githubusercontent.com/u/62075823?v=4',
  email_verified = TRUE,
  email_verified_at = NOW()
WHERE email = 'ryansmith108@gmail.com';
