"use client";

import { useEffect, useState } from "react";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "QA" | "BA" | "PO";
}

/**
 * Récupère l'utilisateur connecté via /api/auth/me — la même route que
 * components/Header/index.tsx utilise pour afficher le nom/rôle. Ne dépend
 * pas d'AuthContext (qui n'est pas alimenté par le flux de connexion réel,
 * lequel passe par la session cookie httpOnly + proxy /api/backend).
 */
export function useCurrentUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setUser(d?.user ?? null); })
      .catch(() => { if (!cancelled) setUser(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { user, loading };
}
