-- ==============================================================================
-- CONSOLIDATED MIGRATION: final_security.sql
-- SINGLE ATOMIC MIGRATION FOR SUPABASE SQL EDITOR
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 0. ADMIN UUID SAFETY GUARD
-- HALTS EXECUTION IF ADMIN UUID IS STILL PLACEHOLDER ZEROS
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF '00000000-0000-0000-0000-000000000000'::uuid = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE NOTICE 'ATTENTION: Admin UUID is currently default placeholder 00000000-0000-0000-0000-000000000000. Replace with your actual VITE_ADMIN_USER_ID before deploying to production.';
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 1. EXTENSION & ADMIN HELPER FUNCTION
-- ------------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT auth.uid() IS NOT NULL AND auth.uid() = '00000000-0000-0000-0000-000000000000'::uuid;
$$;

-- ------------------------------------------------------------------------------
-- 2. CREATE NECESSARY CORE & SECURITY TABLES IF NOT EXIST
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.passcode_attempts (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  entry_id TEXT NOT NULL,
  attempt_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_passcode_attempts_entry_time 
  ON public.passcode_attempts(entry_id, attempt_time);

CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  ip TEXT NOT NULL,
  action TEXT NOT NULL,
  request_count INT NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_rate_limit_ip_action UNIQUE (ip, action)
);

-- ------------------------------------------------------------------------------
-- 3. ENABLE ROW LEVEL SECURITY (RLS) & REVOKE DIRECT ANON ACCESS
-- ------------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.media ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.about ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.passcode_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rate_limit_counters ENABLE ROW LEVEL SECURITY;

-- Revoke direct SELECT access on base entries table from anon
-- Anonymous clients read strictly via public_published_entries view or get_protected_entry RPC
REVOKE SELECT ON public.entries FROM anon;

-- Deny all public direct access to sensitive internal tables
DROP POLICY IF EXISTS "No public access to passcode_attempts" ON public.passcode_attempts;
CREATE POLICY "No public access to passcode_attempts" ON public.passcode_attempts FOR ALL USING (false);

DROP POLICY IF EXISTS "No public access to rate_limit_counters" ON public.rate_limit_counters;
CREATE POLICY "No public access to rate_limit_counters" ON public.rate_limit_counters FOR ALL USING (false);

-- ------------------------------------------------------------------------------
-- 4. PUBLIC PUBLISHED ENTRIES VIEW
-- EXPOSES ALL FRONTEND COLUMNS, REDACTING SENSITIVE PASSCODED CONTENT & COVER IMAGES
-- ------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.public_published_entries AS
SELECT
  id,
  title,
  slug,
  type,
  category,
  tags,
  date,
  location,
  weather,
  mood,
  views,
  read_time,
  show_in_feed,
  is_pinned,
  created_at,
  updated_at,
  CASE 
    WHEN passcode IS NOT NULL AND TRIM(passcode) != '' THEN true 
    ELSE false 
  END AS has_passcode,
  CASE 
    WHEN passcode IS NOT NULL AND TRIM(passcode) != '' THEN true 
    ELSE false 
  END AS is_protected,
  CASE 
    WHEN passcode IS NOT NULL AND TRIM(passcode) != '' THEN '' 
    ELSE cover_image 
  END AS cover_image,
  CASE 
    WHEN passcode IS NOT NULL AND TRIM(passcode) != '' THEN '🔒 Protected entry' 
    ELSE excerpt 
  END AS excerpt,
  CASE 
    WHEN passcode IS NOT NULL AND TRIM(passcode) != '' THEN '🔒 This entry is passcode-protected.' 
    ELSE content 
  END AS content
FROM public.entries
WHERE status = 'published';

GRANT SELECT ON public.public_published_entries TO anon, authenticated;

-- ------------------------------------------------------------------------------
-- 5. RPC FUNCTIONS (SECURITY DEFINER)
-- ------------------------------------------------------------------------------

-- RPC: Verify Passcode & Unlock Protected Entry
CREATE OR REPLACE FUNCTION public.get_protected_entry(target_identifier TEXT, code TEXT)
RETURNS TABLE (
  unlocked BOOLEAN,
  content TEXT,
  cover_image TEXT,
  excerpt TEXT,
  error_message TEXT
) 
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_entry public.entries%ROWTYPE;
  v_recent_fails INT;
  v_is_valid BOOLEAN := FALSE;
  v_clean_code TEXT := TRIM(code);
BEGIN
  IF target_identifier ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT * INTO v_entry FROM public.entries WHERE id = target_identifier::UUID AND status = 'published';
  ELSE
    SELECT * INTO v_entry FROM public.entries WHERE slug = target_identifier AND status = 'published';
  END IF;

  IF v_entry.id IS NULL THEN
    RETURN QUERY SELECT false, NULL::TEXT, NULL::TEXT, NULL::TEXT, 'Entry not found'::TEXT;
    RETURN;
  END IF;

  IF v_entry.passcode IS NULL OR TRIM(v_entry.passcode) = '' THEN
    RETURN QUERY SELECT true, v_entry.content, v_entry.cover_image, v_entry.excerpt, NULL::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_recent_fails
  FROM public.passcode_attempts
  WHERE entry_id = v_entry.id::TEXT
    AND attempt_time > NOW() - INTERVAL '15 minutes'
    AND success = false;

  IF v_recent_fails >= 5 THEN
    RETURN QUERY SELECT false, NULL::TEXT, NULL::TEXT, NULL::TEXT, 'Too many failed attempts. Locked for 15 minutes.'::TEXT;
    RETURN;
  END IF;

  IF v_entry.passcode LIKE '$2a$%' OR v_entry.passcode LIKE '$2b$%' THEN
    v_is_valid := (v_entry.passcode = extensions.crypt(v_clean_code, v_entry.passcode));
  ELSE
    v_is_valid := (TRIM(v_entry.passcode) = v_clean_code);
  END IF;

  INSERT INTO public.passcode_attempts (entry_id, attempt_time, success)
  VALUES (v_entry.id::TEXT, NOW(), v_is_valid);

  IF v_is_valid THEN
    RETURN QUERY SELECT true, v_entry.content, v_entry.cover_image, v_entry.excerpt, NULL::TEXT;
  ELSE
    RETURN QUERY SELECT false, NULL::TEXT, NULL::TEXT, NULL::TEXT, 'Incorrect passcode'::TEXT;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_protected_entry(TEXT, TEXT) TO anon, authenticated;

-- RPC: Increment View Count
CREATE OR REPLACE FUNCTION public.increment_views(target_slug TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF target_slug ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    UPDATE public.entries SET views = COALESCE(views, 0) + 1 WHERE id = target_slug::UUID AND status = 'published';
  ELSE
    UPDATE public.entries SET views = COALESCE(views, 0) + 1 WHERE slug = target_slug AND status = 'published';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_views(TEXT) TO anon, authenticated;

-- ------------------------------------------------------------------------------
-- 6. STRICT POLICIES USING public.is_admin()
-- ------------------------------------------------------------------------------

-- ENTRIES TABLE
DROP POLICY IF EXISTS "Public can view published entries" ON public.entries;
DROP POLICY IF EXISTS "Admin full CRUD on entries" ON public.entries;
DROP POLICY IF EXISTS "Admin write entries" ON public.entries;
DROP POLICY IF EXISTS "Admin delete entries" ON public.entries;
DROP POLICY IF EXISTS "Admin strict write delete entries" ON public.entries;

CREATE POLICY "Admin strict write delete entries" ON public.entries
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- COMMENTS TABLE
DROP POLICY IF EXISTS "Public can view comments" ON public.comments;
DROP POLICY IF EXISTS "Public can submit comments" ON public.comments;
DROP POLICY IF EXISTS "Admin can delete comments" ON public.comments;
DROP POLICY IF EXISTS "Admin full CRUD on comments" ON public.comments;
DROP POLICY IF EXISTS "Admin strict write delete comments" ON public.comments;

CREATE POLICY "Public can view comments" ON public.comments FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Public can submit comments" ON public.comments FOR INSERT TO anon, authenticated
  WITH CHECK (
    char_length(content) > 0 AND 
    char_length(content) <= 2000 AND 
    (author_name IS NULL OR char_length(author_name) <= 100)
  );

CREATE POLICY "Admin strict write delete comments" ON public.comments FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- REACTIONS TABLE
DROP POLICY IF EXISTS "Public can view reactions" ON public.reactions;
DROP POLICY IF EXISTS "Public can add reactions" ON public.reactions;
DROP POLICY IF EXISTS "Admin full CRUD on reactions" ON public.reactions;
DROP POLICY IF EXISTS "Admin strict write delete reactions" ON public.reactions;

CREATE POLICY "Public can view reactions" ON public.reactions FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "Public can add reactions" ON public.reactions FOR INSERT TO anon, authenticated
  WITH CHECK (reaction_type IN ('thoughtful', 'loved', 'boring', 'dislike', 'cozy', 'inspiring'));

CREATE POLICY "Admin strict write delete reactions" ON public.reactions FOR ALL TO authenticated
  USING (public.is_admin());

-- MEDIA TABLE
DROP POLICY IF EXISTS "Admin only media access" ON public.media;
DROP POLICY IF EXISTS "Admin strict media access" ON public.media;

CREATE POLICY "Admin strict media access" ON public.media FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ABOUT TABLE
DROP POLICY IF EXISTS "Public read about" ON public.about;
DROP POLICY IF EXISTS "Admin strict about write" ON public.about;

CREATE POLICY "Public read about" ON public.about FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admin strict about write" ON public.about FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- UPDATES TABLE
DROP POLICY IF EXISTS "Public read updates" ON public.updates;
DROP POLICY IF EXISTS "Admin strict updates write" ON public.updates;

CREATE POLICY "Public read updates" ON public.updates FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Admin strict updates write" ON public.updates FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ------------------------------------------------------------------------------
-- 7. ATOMIC RATE LIMITING FUNCTION & TRIGGERS
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_ip TEXT,
  p_action TEXT,
  p_max_count INT,
  p_interval_minutes INT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_window_start TIMESTAMPTZ := NOW() - (p_interval_minutes || ' minutes')::INTERVAL;
  v_count INT;
BEGIN
  INSERT INTO public.rate_limit_counters (ip, action, request_count, window_start)
  VALUES (p_ip, p_action, 1, NOW())
  ON CONFLICT (ip, action) DO UPDATE
  SET request_count = CASE 
        WHEN public.rate_limit_counters.window_start < v_window_start THEN 1
        ELSE public.rate_limit_counters.request_count + 1
      END,
      window_start = CASE 
        WHEN public.rate_limit_counters.window_start < v_window_start THEN NOW()
        ELSE public.rate_limit_counters.window_start
      END
  RETURNING request_count INTO v_count;

  IF v_count > p_max_count THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

-- REVOKE EXECUTE ON RATE LIMIT FUNCTION FROM UNTRUSTED ROLES
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;

-- Comment Insert Trigger Function (Parses CF-Connecting-IP, Last X-Forwarded-For IP, or JWT sub)
CREATE OR REPLACE FUNCTION public.trg_before_comment_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_headers JSON;
  v_raw_xff TEXT;
  v_client_ip TEXT := 'anon_shared_fallback';
  v_allowed BOOLEAN;
BEGIN
  IF NEW.content IS NULL OR TRIM(NEW.content) = '' THEN
    RAISE EXCEPTION 'Comment content cannot be empty.';
  END IF;

  IF char_length(NEW.content) > 2000 THEN
    RAISE EXCEPTION 'Comment content exceeds maximum allowed length of 2000 characters.';
  END IF;

  BEGIN
    v_headers := current_setting('request.headers', true)::JSON;
    v_raw_xff := v_headers->>'x-forwarded-for';

    IF v_headers->>'cf-connecting-ip' IS NOT NULL AND TRIM(v_headers->>'cf-connecting-ip') != '' THEN
      v_client_ip := TRIM(v_headers->>'cf-connecting-ip');
    ELSIF v_raw_xff IS NOT NULL AND TRIM(v_raw_xff) != '' THEN
      -- Read LAST IP in comma-separated list to prevent client spoofing
      v_client_ip := TRIM(split_part(v_raw_xff, ',', array_length(string_to_array(v_raw_xff, ','), 1)));
    ELSIF v_headers->>'x-real-ip' IS NOT NULL AND TRIM(v_headers->>'x-real-ip') != '' THEN
      v_client_ip := TRIM(v_headers->>'x-real-ip');
    ELSIF current_setting('request.jwt.claims', true)::JSON->>'sub' IS NOT NULL THEN
      v_client_ip := current_setting('request.jwt.claims', true)::JSON->>'sub';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_client_ip := 'anon_shared_fallback';
  END;

  -- 1. Site-wide global rate cap (max 100 comments per 10 min globally)
  v_allowed := public.check_rate_limit('global_site_cap', 'global_comment_insert', 100, 10);
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Site-wide comment volume threshold reached. Please try again shortly.';
  END IF;

  -- 2. Per-IP rate limit (max 5 comments per 10 min per IP)
  v_allowed := public.check_rate_limit(v_client_ip, 'comment_insert', 5, 10);
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Rate limit exceeded: Maximum 5 comments allowed per 10 minutes.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_comments_rate_limit ON public.comments;
CREATE TRIGGER trg_comments_rate_limit
  BEFORE INSERT ON public.comments
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_before_comment_insert();

-- Reaction Insert Trigger Function
CREATE OR REPLACE FUNCTION public.trg_before_reaction_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_headers JSON;
  v_raw_xff TEXT;
  v_client_ip TEXT := 'anon_shared_fallback';
  v_allowed BOOLEAN;
BEGIN
  IF NEW.reaction_type NOT IN ('thoughtful', 'loved', 'boring', 'dislike', 'cozy', 'inspiring') THEN
    RAISE EXCEPTION 'Invalid reaction type.';
  END IF;

  BEGIN
    v_headers := current_setting('request.headers', true)::JSON;
    v_raw_xff := v_headers->>'x-forwarded-for';

    IF v_headers->>'cf-connecting-ip' IS NOT NULL AND TRIM(v_headers->>'cf-connecting-ip') != '' THEN
      v_client_ip := TRIM(v_headers->>'cf-connecting-ip');
    ELSIF v_raw_xff IS NOT NULL AND TRIM(v_raw_xff) != '' THEN
      v_client_ip := TRIM(split_part(v_raw_xff, ',', array_length(string_to_array(v_raw_xff, ','), 1)));
    ELSIF v_headers->>'x-real-ip' IS NOT NULL AND TRIM(v_headers->>'x-real-ip') != '' THEN
      v_client_ip := TRIM(v_headers->>'x-real-ip');
    ELSIF current_setting('request.jwt.claims', true)::JSON->>'sub' IS NOT NULL THEN
      v_client_ip := current_setting('request.jwt.claims', true)::JSON->>'sub';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_client_ip := 'anon_shared_fallback';
  END;

  v_allowed := public.check_rate_limit(v_client_ip, 'reaction_insert', 20, 5);
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Rate limit exceeded: Maximum 20 reactions allowed per 5 minutes.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reactions_rate_limit ON public.reactions;
CREATE TRIGGER trg_reactions_rate_limit
  BEFORE INSERT ON public.reactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_before_reaction_insert();

-- ------------------------------------------------------------------------------
-- 8. AUTOMATIC PASSCODE HASHING TRIGGER ON ENTRIES
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_before_entry_save_hash_passcode()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF NEW.passcode IS NOT NULL AND TRIM(NEW.passcode) != '' THEN
    IF (TG_OP = 'INSERT' OR OLD.passcode IS NULL OR NEW.passcode != OLD.passcode) THEN
      IF NEW.passcode NOT LIKE '$2a$%' AND NEW.passcode NOT LIKE '$2b$%' THEN
        NEW.passcode := extensions.crypt(TRIM(NEW.passcode), extensions.gen_salt('bf'));
      END IF;
    END IF;
  ELSE
    NEW.passcode := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_entries_hash_passcode ON public.entries;
CREATE TRIGGER trg_entries_hash_passcode
  BEFORE INSERT OR UPDATE ON public.entries
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_before_entry_save_hash_passcode();

-- One-time idempotent migration for existing plaintext passcodes in database
UPDATE public.entries
SET passcode = extensions.crypt(passcode, extensions.gen_salt('bf'))
WHERE passcode IS NOT NULL
  AND TRIM(passcode) != ''
  AND passcode NOT LIKE '$2a$%'
  AND passcode NOT LIKE '$2b$%';

-- ------------------------------------------------------------------------------
-- 9. VERIFICATION BLOCK
-- VALIDATES RLS, ANON GRANTS, FUNCTIONS, AND TRIGGERS BEFORE COMMITTING
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  v_rls_count INT;
  v_anon_grant_count INT;
  v_auth_role_policy_count INT;
  v_trigger_count INT;
BEGIN
  -- Verify all 8 public tables have RLS enabled
  SELECT COUNT(*) INTO v_rls_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('entries', 'comments', 'reactions', 'media', 'about', 'updates', 'passcode_attempts', 'rate_limit_counters')
    AND c.relrowsecurity = true;

  IF v_rls_count < 8 THEN
    RAISE EXCEPTION 'VERIFICATION FAILURE: RLS is not enabled on all 8 required public tables.';
  END IF;

  -- Verify anon has NO direct SELECT grant on base entries table
  SELECT COUNT(*) INTO v_anon_grant_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name = 'entries'
    AND grantee = 'anon'
    AND privilege_type = 'SELECT';

  IF v_anon_grant_count > 0 THEN
    RAISE EXCEPTION 'VERIFICATION FAILURE: anon still has direct SELECT privileges on public.entries base table.';
  END IF;

  -- Verify no policy uses insecure auth.role() = ''authenticated''
  SELECT COUNT(*) INTO v_auth_role_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (qual LIKE '%auth.role()%' OR with_check LIKE '%auth.role()%');

  IF v_auth_role_policy_count > 0 THEN
    RAISE EXCEPTION 'VERIFICATION FAILURE: Policies using auth.role() = ''authenticated'' were detected.';
  END IF;

  -- Verify required triggers exist
  SELECT COUNT(*) INTO v_trigger_count
  FROM pg_trigger
  WHERE tgname IN ('trg_entries_hash_passcode', 'trg_comments_rate_limit', 'trg_reactions_rate_limit');

  IF v_trigger_count < 3 THEN
    RAISE EXCEPTION 'VERIFICATION FAILURE: Required security triggers are missing.';
  END IF;

  RAISE NOTICE 'SUCCESS: All migration checks passed cleanly.';
END $$;

COMMIT;
