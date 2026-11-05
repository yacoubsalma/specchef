/**
 * Gestion de la session côté serveur (Next.js).
 *
 * Le token JWT et le refresh token sont stockés dans des cookies httpOnly,
 * donc inaccessibles au JavaScript du navigateur (protection XSS).
 * Seules les Route Handlers de Next.js (qui tournent côté serveur) peuvent
 * les lire/écrire.
 */
import { cookies } from 'next/headers';

export const ACCESS_TOKEN_COOKIE = 'anayzer_token';
export const REFRESH_TOKEN_COOKIE = 'anayzer_refresh_token';

const isProd = process.env.NODE_ENV === 'production';

const baseCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax' as const,
  path: '/',
};

export interface SessionTokens {
  token: string;
  refreshToken: string;
}

/** Pose les cookies httpOnly access + refresh après un login/refresh réussi. */
export async function setSessionCookies({ token, refreshToken }: SessionTokens) {
  const store = await cookies();
  // access token : courte durée de vie (alignée sur l'expiration JWT côté backend, 15 min)
  store.set(ACCESS_TOKEN_COOKIE, token, {
    ...baseCookieOptions,
    maxAge: 15 * 60,
  });
  // refresh token : longue durée de vie (7 jours côté backend)
  store.set(REFRESH_TOKEN_COOKIE, refreshToken, {
    ...baseCookieOptions,
    maxAge: 7 * 24 * 60 * 60,
  });
}

/** Met à jour uniquement l'access token (après un refresh). */
export async function setAccessTokenCookie(token: string) {
  const store = await cookies();
  store.set(ACCESS_TOKEN_COOKIE, token, {
    ...baseCookieOptions,
    maxAge: 15 * 60,
  });
}

/** Supprime les cookies de session (logout). */
export async function clearSessionCookies() {
  const store = await cookies();
  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
}

/** Lit les tokens courants depuis les cookies (utilisable dans une Route Handler). */
export async function getSessionTokens(): Promise<Partial<SessionTokens>> {
  const store = await cookies();
  return {
    token: store.get(ACCESS_TOKEN_COOKIE)?.value,
    refreshToken: store.get(REFRESH_TOKEN_COOKIE)?.value,
  };
}
