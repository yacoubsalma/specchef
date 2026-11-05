"use client";

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import { useRouter } from "next/navigation";

const API_BASE = "http://localhost:3000";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "QA" | "BA" | "PO";
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  authFetch: (url: string, options?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  // On mount, restore session from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem("analyzer_auth");
      if (stored) {
        const { token: t, user: u } = JSON.parse(stored);
        if (t && u) { setToken(t); setUser(u); }
      }
    } catch { }
    finally { setIsLoading(false); }
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await fetch(`${API_BASE}/auth/sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || "Identifiants invalides");

    const { token: t, refreshToken, user: u } = data;
    localStorage.setItem("analyzer_auth", JSON.stringify({ token: t, refreshToken, user: u }));
    setToken(t);
    setUser(u);
  }, []);

  const signOut = useCallback(async () => {
    try {
      if (token) {
        await fetch(`${API_BASE}/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch { }
    localStorage.removeItem("analyzer_auth");
    setToken(null);
    setUser(null);
    router.push("/auth/signin");
  }, [token, router]);

  /**
   * Wrapper autour de fetch() qui injecte automatiquement le token Bearer.
   * Gère le refresh si le token est expiré (401).
   */
  const authFetch = useCallback(async (url: string, options: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> ?? {}),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (!headers["Content-Type"] && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    let res = await fetch(url, { ...options, headers });

    // Si 401 → essayer de rafraîchir le token
    if (res.status === 401) {
      try {
        const stored = localStorage.getItem("analyzer_auth");
        if (stored) {
          const { refreshToken } = JSON.parse(stored);
          const refreshRes = await fetch(`${API_BASE}/auth/refresh-token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ refreshToken }),
          });
          if (refreshRes.ok) {
            const refreshData = await refreshRes.json();
            const newToken = refreshData.token;
            const newStored = { ...JSON.parse(stored), token: newToken };
            localStorage.setItem("analyzer_auth", JSON.stringify(newStored));
            setToken(newToken);
            headers["Authorization"] = `Bearer ${newToken}`;
            res = await fetch(url, { ...options, headers });
          } else {
            // Refresh échoué → déconnexion
            localStorage.removeItem("analyzer_auth");
            setToken(null); setUser(null);
            router.push("/auth/signin");
          }
        }
      } catch { }
    }

    return res;
  }, [token, router]);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, signIn, signOut, authFetch }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
