import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

export async function POST(request: NextRequest) {
  let body: { email?: string; type?: 'verify' | 'reset' };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Corps de requête invalide' }, { status: 400 });
  }

  const { email, type } = body;
  if (!email) {
    return NextResponse.json({ message: 'Email requis' }, { status: 400 });
  }

  let backendRes: Response;
  try {
    backendRes = await fetch(`${BACKEND_URL}/auth/resend-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, type }),
    });
  } catch {
    return NextResponse.json(
      { message: "Le serveur backend ne répond pas. Vérifiez qu'il est lancé." },
      { status: 502 },
    );
  }

  const data = await backendRes.json().catch(() => null);

  if (!backendRes.ok) {
    return NextResponse.json(
      { message: data?.message || "Impossible d'envoyer le code" },
      { status: backendRes.status },
    );
  }

  return NextResponse.json(data ?? { message: 'Code envoyé par email' });
}
