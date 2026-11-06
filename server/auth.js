import { createClient } from '@supabase/supabase-js';

const defaultUrl = 'https://placeholder.supabase.co';

export function getSupabaseServerClient(req) {
  if (process.env.NODE_ENV === 'test' && global.__mockSupabaseClient) {
    return global.__mockSupabaseClient(req);
  }
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || defaultUrl;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
  return createClient(url, key || 'placeholder-anon-key');
}

/**
 * Verify Supabase JWT token server-side and ensure user.id matches ADMIN_USER_ID
 */
export async function verifyAdminUser(req) {
  const rawAdminId = process.env.ADMIN_USER_ID || process.env.VITE_ADMIN_USER_ID || '';
  const cleanAdminId = rawAdminId.trim().toLowerCase();

  if (!cleanAdminId) {
    return { authorized: false, status: 403, error: 'Server authentication unconfigured. Access denied.' };
  }

  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false, status: 401, error: 'Missing or malformed Authorization header.' };
  }

  const token = authHeader.split(' ')[1];
  if (!token || !token.trim()) {
    return { authorized: false, status: 401, error: 'Authentication token missing.' };
  }

  try {
    const supabase = getSupabaseServerClient(req);
    // Fail closed with a bounded wait: a stalled auth service must not hang
    // admin endpoints forever (mirrors the standalone server's 5s race).
    const { data, error } = await Promise.race([
      supabase.auth.getUser(token),
      new Promise((_, reject) => setTimeout(() => reject(new Error('auth-timeout')), 5000))
    ]);

    // The auth service itself failing (timeout / 5xx) is not a bad token:
    // still deny, but say the service is unavailable.
    if (error && (error.isTimeout || error.message === 'Auth timeout' || error.status >= 500)) {
      return { authorized: false, status: 503, error: 'Authentication service unavailable. Fail closed.' };
    }

    if (error || !data || !data.user) {
      return { authorized: false, status: 401, error: 'Invalid or expired token.' };
    }

    const cleanUserId = (data.user.id || '').trim().toLowerCase();
    if (cleanUserId !== cleanAdminId) {
      return { authorized: false, status: 403, error: 'Forbidden: User is not authorized as admin.' };
    }

    return { authorized: true, user: data.user };
  } catch (err) {
    if (err && err.message === 'auth-timeout') {
      return { authorized: false, status: 503, error: 'Authentication service timed out.' };
    }
    return { authorized: false, status: 500, error: 'Authentication check failed.' };
  }
}
