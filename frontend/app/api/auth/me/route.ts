import { NextResponse } from 'next/server';
import { getSessionTokens, setAccessTokenCookie, clearSessionCookies } from '@/lib/session';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

async function tryRefresh(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/auth/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.token ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const { token, refreshToken } = await getSessionTokens();

  if (!token && !refreshToken) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  let activeToken = token;

  let res = activeToken
    ? await fetch(`${BACKEND_URL}/users/me`, {
        headers: { Authorization: `Bearer ${activeToken}` },
      }).catch(() => null)
    : null;

  if ((!res || res.status === 401) && refreshToken) {
    const newToken = await tryRefresh(refreshToken);
    if (newToken) {
      await setAccessTokenCookie(newToken);
      activeToken = newToken;
      res = await fetch(`${BACKEND_URL}/users/me`, {
        headers: { Authorization: `Bearer ${newToken}` },
      }).catch(() => null);
    }
  }

  if (!res || !res.ok) {
    await clearSessionCookies();
    return NextResponse.json({ user: null }, { status: 401 });
  }

  const user = await res.json().catch(() => null);
  return NextResponse.json({ user });
}
