-- ==============================================================================
-- Lock comments & reactions on passcode-protected posts at the database level
-- ==============================================================================
-- Before: the API required the passcode to comment on / react to a locked post,
-- but the table policies let anyone (anon key, which ships in the browser)
-- read every comment and insert comments/reactions for ANY post_id directly,
-- so the passcode could be bypassed.
--
-- After:
--   * comments on locked posts are hidden from the public (admin still sees all)
--   * the public cannot insert comments/reactions on locked posts directly
--   * three SECURITY DEFINER functions (a wrong passcode returns no rows /
--     false rather than an error, so failed tries are still counted) let a reader who knows the passcode read
--     comments, add a comment and add a reaction (the API calls these; they
--     verify the passcode through get_protected_entry, so the same 5-tries /
--     15-minutes lockout applies)
--   * reaction counts stay publicly readable (no text, nothing sensitive)
--
-- Safe to run more than once. The API keeps working before AND after this is
-- applied (it falls back to the old path while these functions don't exist).
-- Run it in the Supabase SQL editor.
-- ==============================================================================

-- 1. Helper: is this post locked? (post_id compared as text so it works whether
--    the column is uuid or text)
CREATE OR REPLACE FUNCTION public.entry_is_protected(p_post_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.entries e
    WHERE e.id::TEXT = p_post_id
      AND e.passcode IS NOT NULL
      AND TRIM(e.passcode) <> ''
  );
$$;

GRANT EXECUTE ON FUNCTION public.entry_is_protected(TEXT) TO anon, authenticated;

-- 2. Comments: public read/insert only for posts that are NOT locked
DROP POLICY IF EXISTS "Public can view comments" ON public.comments;
CREATE POLICY "Public can view comments" ON public.comments FOR SELECT TO anon, authenticated
  USING (NOT public.entry_is_protected(post_id::TEXT) OR public.is_admin());

DROP POLICY IF EXISTS "Public can submit comments" ON public.comments;
CREATE POLICY "Public can submit comments" ON public.comments FOR INSERT TO anon, authenticated
  WITH CHECK (
    char_length(content) > 0 AND
    char_length(content) <= 2000 AND
    (author_name IS NULL OR char_length(author_name) <= 100) AND
    NOT public.entry_is_protected(post_id::TEXT)
  );

-- 3. Reactions: public insert only for posts that are NOT locked
--    (types match the site's buttons; cozy/inspiring kept for old rows)
DROP POLICY IF EXISTS "Public can add reactions" ON public.reactions;
CREATE POLICY "Public can add reactions" ON public.reactions FOR INSERT TO anon, authenticated
  WITH CHECK (
    reaction_type IN ('thoughtful', 'loved', 'boring', 'dislike', 'cozy', 'inspiring') AND
    NOT public.entry_is_protected(post_id::TEXT)
  );

-- 4. Passcode-checked access for readers who unlocked a post
CREATE OR REPLACE FUNCTION public.protected_entry_id(target_identifier TEXT, code TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unlocked BOOLEAN;
  v_id TEXT;
BEGIN
  SELECT g.unlocked INTO v_unlocked FROM public.get_protected_entry(target_identifier, code) g LIMIT 1;
  -- A wrong passcode returns NULL instead of raising: an exception would roll
  -- back the failed-attempt row get_protected_entry just wrote, and the
  -- 5-tries lockout would never trigger through these functions.
  IF NOT COALESCE(v_unlocked, FALSE) THEN
    RETURN NULL;
  END IF;
  SELECT e.id::TEXT INTO v_id FROM public.entries e
  WHERE (e.id::TEXT = target_identifier OR e.slug = target_identifier) AND e.status = 'published'
  LIMIT 1;
  RETURN v_id;
END;
$$;
-- Internal helper only: callable by the functions below, not by the public.
REVOKE ALL ON FUNCTION public.protected_entry_id(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_protected_comments(target_identifier TEXT, code TEXT)
RETURNS SETOF public.comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id TEXT := public.protected_entry_id(target_identifier, code);
BEGIN
  IF v_id IS NULL THEN RETURN; END IF;  -- wrong passcode: no rows
  RETURN QUERY SELECT * FROM public.comments c WHERE c.post_id::TEXT = v_id ORDER BY c.created_at ASC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_protected_comments(TEXT, TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.add_protected_comment(target_identifier TEXT, code TEXT, p_author_name TEXT, p_content TEXT)
RETURNS SETOF public.comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id TEXT := public.protected_entry_id(target_identifier, code);
BEGIN
  IF v_id IS NULL THEN RETURN; END IF;  -- wrong passcode: nothing inserted, no row returned
  IF p_content IS NULL OR char_length(TRIM(p_content)) = 0 OR char_length(p_content) > 2000 THEN
    RAISE EXCEPTION 'Comment must be 1-2000 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_author_name IS NOT NULL AND char_length(p_author_name) > 100 THEN
    RAISE EXCEPTION 'Author name must be 100 characters or fewer.' USING ERRCODE = '22023';
  END IF;
  -- The comments rate-limit trigger still runs on this insert.
  -- Selecting e.id keeps the post id in its own column type (uuid or text).
  RETURN QUERY
    INSERT INTO public.comments (post_id, author_name, content)
    SELECT e.id, p_author_name, p_content FROM public.entries e WHERE e.id::TEXT = v_id
    RETURNING *;
END;
$$;
GRANT EXECUTE ON FUNCTION public.add_protected_comment(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- Returns true when the reaction was saved, false for a wrong passcode.
DROP FUNCTION IF EXISTS public.add_protected_reaction(TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.add_protected_reaction(target_identifier TEXT, code TEXT, p_reaction_type TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id TEXT := public.protected_entry_id(target_identifier, code);
BEGIN
  IF v_id IS NULL THEN RETURN FALSE; END IF;  -- wrong passcode
  IF p_reaction_type NOT IN ('thoughtful', 'loved', 'boring', 'dislike', 'cozy', 'inspiring') THEN
    RAISE EXCEPTION 'Invalid reaction type.' USING ERRCODE = '22023';
  END IF;
  -- The reactions rate-limit trigger still runs on this insert.
  INSERT INTO public.reactions (post_id, reaction_type)
    SELECT e.id, p_reaction_type FROM public.entries e WHERE e.id::TEXT = v_id;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION public.add_protected_reaction(TEXT, TEXT, TEXT) TO anon, authenticated;
