import { NextRequest, NextResponse } from 'next/server';
import { setSessionCookies } from '@/lib/session';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Corps de requête invalide' }, { status: 400 });
  }

  const { email, password } = body;
  if (!email || !password) {
    return NextResponse.json({ message: 'Email et mot de passe requis' }, { status: 400 });
  }

  let backendRes: Response;
  try {
    backendRes = await fetch(`${BACKEND_URL}/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return NextResponse.json(
      { message: 'Le serveur backend ne répond pas. Vérifiez qu\'il est lancé.' },
      { status: 502 },
    );
  }

  const data = await backendRes.json().catch(() => null);

  if (!backendRes.ok) {
    return NextResponse.json(
      { message: data?.message || 'Identifiants invalides' },
      { status: backendRes.status },
    );
  }

  if (!data?.token || !data?.refreshToken) {
    return NextResponse.json({ message: 'Réponse backend invalide' }, { status: 502 });
  }

  await setSessionCookies({ token: data.token, refreshToken: data.refreshToken });

  // On ne renvoie jamais les tokens bruts au client : seulement les infos user.
  return NextResponse.json({ user: data.user });
}
