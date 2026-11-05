'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

const API_BASE = '/api/backend';

export default function AccountPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<{ email?: string; name?: string; role?: string } | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => {
        if (r.status === 401) { router.push('/auth/signin?next=/account'); return null; }
        return r.ok ? r.json() : null;
      })
      .then(d => setCurrentUser(d?.user ?? null))
      .finally(() => setAuthChecked(true));
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (newPassword !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/users/me/change-password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message || 'Échec du changement de mot de passe');
        setSaving(false);
        return;
      }
      setSuccess(data?.message || 'Mot de passe modifié avec succès');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch {
      setError('Impossible de contacter le serveur.');
    } finally {
      setSaving(false);
    }
  };

  if (!authChecked) {
    return <div className="min-h-screen bg-white dark:bg-black" />;
  }

  return (
    <div className="min-h-screen bg-white dark:bg-black">
      <section className="pt-35 pb-20 md:pt-40">
        <div className="mx-auto max-w-c-1016 px-4 md:px-8 2xl:px-0">
          <div className="mb-4 inline-block rounded-full bg-zumthor dark:border dark:border-strokedark dark:bg-blacksection px-4.5 py-1.5">
            <span className="text-sectiontitle font-medium text-black dark:text-white">MON COMPTE</span>
          </div>
          <h1 className="text-3xl font-bold text-black dark:text-white xl:text-sectiontitle3 mb-3">
            {currentUser?.name || currentUser?.email}
          </h1>
          <p className="text-waterloo dark:text-manatee mb-10">
            {currentUser?.email}
            {currentUser?.role && <span> · Rôle : {currentUser.role}</span>}
          </p>

          <div className="max-w-md rounded-2xl border border-stroke dark:border-strokedark p-7">
            <h2 className="text-lg font-bold text-black dark:text-white mb-5">Changer mon mot de passe</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <input
                type="password" placeholder="Mot de passe actuel" required
                value={currentPassword} onChange={e => setCurrentPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none"
              />
              <input
                type="password" placeholder="Nouveau mot de passe" required minLength={8} maxLength={32}
                value={newPassword} onChange={e => setNewPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none"
              />
              <input
                type="password" placeholder="Confirmer le nouveau mot de passe" required minLength={8} maxLength={32}
                value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none"
              />

              {error && (
                <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-3.5 py-2.5 text-xs text-red-600 dark:text-red-400">{error}</div>
              )}
              {success && (
                <div className="rounded-lg border border-meta/30 bg-meta/5 px-3.5 py-2.5 text-xs text-meta">{success}</div>
              )}

              <button
                type="submit" disabled={saving}
                className="w-full px-5 py-2.5 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho disabled:opacity-60 transition-all"
              >
                {saving ? 'Enregistrement...' : 'Mettre à jour le mot de passe'}
              </button>
            </form>
          </div>
        </div>
      </section>
    </div>
  );
}
