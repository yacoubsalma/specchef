import { NextResponse } from 'next/server';
import { clearSessionCookies, getSessionTokens } from '@/lib/session';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

export async function POST() {
  const { token } = await getSessionTokens();

  if (token) {
    try {
      await fetch(`${BACKEND_URL}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Si le backend est down, on supprime quand même les cookies locaux.
    }
  }

  await clearSessionCookies();
  return NextResponse.json({ message: 'Déconnecté' });
}
