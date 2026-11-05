'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useJira } from '@/app/context/JiraContext';
import JiraSettingsModal from '@/app/components/JiraSettingsModal';

const API_BASE = '/api/backend';
const RESEND_COOLDOWN_S = 60;

interface CurrentUser {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
  isEmailVerified?: boolean;
  isActive?: boolean;
  created_at?: string;
  passwordChangedAt?: string;
  theme?: 'light' | 'dark';
}

type Step = 'form' | 'otp';

const PASSWORD_CHECKS = [
  { label: 'Minimum 8 caractères', test: (v: string) => v.length >= 8 },
  { label: '1 majuscule', test: (v: string) => /[A-Z]/.test(v) },
  { label: '1 minuscule', test: (v: string) => /[a-z]/.test(v) },
  { label: '1 chiffre ou caractère spécial', test: (v: string) => /\d|[^A-Za-z0-9]/.test(v) },
];

const ROLE_STYLES: Record<string, string> = {
  ADMIN: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400',
  BA: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400',
  QA: 'bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400',
  PO: 'bg-cyan-50 text-cyan-600 dark:bg-cyan-500/10 dark:text-cyan-400',
};

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M20 6L9 17L4 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 6h18v12H3V6Zm0 0 9 7 9-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="4.5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 9.5h18M8 3v3M16 3v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 3l8 3.5v5c0 5-3.5 8-8 9.5-4.5-1.5-8-4.5-8-9.5v-5L12 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="10.5" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 10.5V7a4 4 0 1 1 8 0v3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 12h6M10.5 17.5H7a5.5 5.5 0 0 1 0-11h3.5M13.5 6.5H17a5.5 5.5 0 0 1 0 11h-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 3 2 20h20L12 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function initials(nameOrEmail?: string): string {
  if (!nameOrEmail) return '?';
  const parts = nameOrEmail.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return nameOrEmail.slice(0, 2).toUpperCase();
}

export default function AccountPage() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { status: jiraStatus, statusLoaded: jiraStatusLoaded, refreshStatus: refreshJiraStatus } = useJira();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [showJiraSettings, setShowJiraSettings] = useState(false);

  // Nom — édition en libre-service
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // Zone danger — demande de suppression du compte
  const [dangerConfirming, setDangerConfirming] = useState(false);
  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerError, setDangerError] = useState<string | null>(null);
  const [dangerDone, setDangerDone] = useState<string | null>(null);

  const [passwordSectionOpen, setPasswordSectionOpen] = useState(false);
  const [step, setStep] = useState<Step>('form');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');

  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const otpInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => {
        if (r.status === 401) { router.push('/auth/signin?next=/account'); return null; }
        return r.ok ? r.json() : null;
      })
      .then(d => setCurrentUser(d?.user ?? null))
      .finally(() => setAuthChecked(true));
  }, [router]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (passwordSectionOpen && step === 'otp') otpInputRef.current?.focus();
  }, [passwordSectionOpen, step]);

  useEffect(() => {
    if (!jiraStatusLoaded) refreshJiraStatus();
  }, [jiraStatusLoaded, refreshJiraStatus]);

  // Applique le thème enregistré sur le profil, une fois, au chargement du compte.
  useEffect(() => {
    if (currentUser?.theme && currentUser.theme !== theme) setTheme(currentUser.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.theme]);

  const startEditName = () => {
    setNameDraft(currentUser?.name || '');
    setNameError(null);
    setEditingName(true);
  };

  const cancelEditName = () => {
    setEditingName(false);
    setNameError(null);
  };

  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) { setNameError('Le nom ne peut pas être vide'); return; }
    if (trimmed === currentUser?.name) { setEditingName(false); return; }

    setSavingName(true);
    setNameError(null);
    try {
      const res = await fetch(`${API_BASE}/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setNameError(data?.message || 'Échec de la mise à jour du nom');
        return;
      }
      setCurrentUser(u => (u ? { ...u, name: data?.name ?? trimmed } : u));
      setEditingName(false);
    } catch {
      setNameError('Impossible de contacter le serveur.');
    } finally {
      setSavingName(false);
    }
  };

  const handleThemeChange = async (next: 'light' | 'dark') => {
    setTheme(next);
    setCurrentUser(u => (u ? { ...u, theme: next } : u));
    try {
      await fetch(`${API_BASE}/users/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
    } catch {
      // Le thème reste appliqué localement même si l'enregistrement échoue.
    }
  };

  const requestDeletion = async () => {
    setDangerBusy(true);
    setDangerError(null);
    try {
      const res = await fetch(`${API_BASE}/users/me/request-deletion`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setDangerError(data?.message || 'Échec de la demande de suppression'); return; }
      setDangerDone('Demande envoyée. Un administrateur va la traiter.');
      setDangerConfirming(false);
    } catch {
      setDangerError('Impossible de contacter le serveur.');
    } finally {
      setDangerBusy(false);
    }
  };

  const passwordChecksPassed = PASSWORD_CHECKS.every(c => c.test(newPassword));
  const passwordsMatch = confirmPassword.length > 0 && newPassword === confirmPassword;
  const isSameAsCurrent = currentPassword.length > 0 && newPassword.length > 0 && newPassword === currentPassword;

  const canRequestOtp =
    currentPassword.length > 0 &&
    passwordChecksPassed &&
    passwordsMatch &&
    !isSameAsCurrent;

  const resetFlow = () => {
    setStep('form');
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setOtpCode('');
    setCooldown(0); setError(null); setSuccess(null);
  };

  const closePasswordSection = () => {
    resetFlow();
    setPasswordSectionOpen(false);
  };

  // Étape 1 : vérifie le mot de passe actuel côté backend et envoie le
  // code OTP par email si tout est valide.
  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!canRequestOtp) {
      if (isSameAsCurrent) setError("Le nouveau mot de passe doit être différent de l'actuel");
      else if (!passwordsMatch) setError('Les mots de passe ne correspondent pas');
      else setError('Le nouveau mot de passe ne respecte pas les critères ci-dessus');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/users/me/change-password/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message || 'Échec de la vérification du mot de passe actuel');
        return;
      }
      setSuccess('Code envoyé par email. Vérifiez votre boîte de réception.');
      setStep('otp');
      setCooldown(RESEND_COOLDOWN_S);
    } catch {
      setError('Impossible de contacter le serveur.');
    } finally {
      setSaving(false);
    }
  };

  // Étape 2 : confirme le changement avec le code OTP reçu par email.
  const handleConfirmChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/users/me/change-password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword, otpCode }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message || 'Échec du changement de mot de passe');
        return;
      }
      setSuccess(data?.message || 'Mot de passe modifié avec succès');
      resetFlow();
      setPasswordSectionOpen(false);
    } catch {
      setError('Impossible de contacter le serveur.');
    } finally {
      setSaving(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0) return;
    setError(null);
    setResending(true);
    try {
      const res = await fetch(`${API_BASE}/users/me/change-password/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message || "Échec de l'envoi du code");
        return;
      }
      setSuccess('Nouveau code envoyé par email.');
      setCooldown(RESEND_COOLDOWN_S);
    } catch {
      setError('Impossible de contacter le serveur.');
    } finally {
      setResending(false);
    }
  };

  if (!authChecked) {
    return <div className="min-h-screen bg-white dark:bg-black" />;
  }

  const fieldInputClass =
    'w-full rounded-xl border border-transparent bg-gray-100 px-4 py-3 pr-20 text-sm text-black outline-hidden transition-colors focus:border-primary focus:bg-white dark:bg-[#2C303B] dark:text-white dark:focus:border-manatee dark:focus:bg-black';
  const labelClass = 'text-sm font-medium text-black dark:text-white';
  const toggleBtnClass =
    'absolute right-4 top-1/2 -translate-y-1/2 text-xs font-medium text-waterloo hover:text-primary dark:text-manatee';
  const roleStyle = (currentUser?.role && ROLE_STYLES[currentUser.role]) || 'bg-gray-100 text-waterloo dark:bg-[#2C303B] dark:text-manatee';

  return (
    <div className="min-h-screen bg-white dark:bg-black">
      <section className="pt-35 pb-20 md:pt-40">
        <div className="mx-auto max-w-c-1016 px-4 md:px-8 2xl:px-0">

          {/* En-tête profil — carte large et illustrée */}
          <div className="relative mb-8 overflow-hidden rounded-3xl border border-stroke bg-linear-to-br from-[#eef4ff] via-white to-[#f0f9ff] p-8 dark:border-strokedark dark:from-[#0a0f1f] dark:via-black dark:to-[#08131f] md:p-10">
            <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
            <div className="absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-sky-400/10 blur-3xl" />

            <div className="relative z-1 flex flex-col items-start gap-6 sm:flex-row sm:items-center">
              <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-primary to-sky-500 text-3xl font-bold text-white shadow-solid-8 ring-4 ring-white dark:ring-black">
                {initials(currentUser?.name || currentUser?.email)}
              </div>

              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-3">
                  {editingName ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={nameDraft}
                        onChange={e => setNameDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') cancelEditName(); }}
                        maxLength={80}
                        className="rounded-lg border border-stroke bg-white px-3 py-1.5 text-xl font-bold text-black outline-hidden focus:border-primary dark:border-strokedark dark:bg-black dark:text-white md:text-2xl"
                      />
                      <button
                        type="button" onClick={saveName} disabled={savingName} aria-label="Enregistrer"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black text-white disabled:opacity-60 dark:bg-btndark"
                      >
                        {savingName ? '…' : <CheckIcon className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button" onClick={cancelEditName} disabled={savingName} aria-label="Annuler"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-stroke text-waterloo hover:text-black dark:border-strokedark dark:text-manatee dark:hover:text-white"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <h1 className="flex items-center gap-2 text-2xl font-bold text-black dark:text-white md:text-3xl">
                      {currentUser?.name || currentUser?.email}
                      <button
                        type="button" onClick={startEditName} aria-label="Modifier le nom"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-stroke text-waterloo hover:border-primary hover:text-primary dark:border-strokedark dark:text-manatee"
                      >
                        <PencilIcon />
                      </button>
                    </h1>
                  )}
                  {currentUser?.role && (
                    <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${roleStyle}`}>
                      <ShieldIcon /> {currentUser.role}
                    </span>
                  )}
                  {currentUser?.isEmailVerified ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-3 py-1 text-xs font-bold text-green-600 dark:bg-green-500/10 dark:text-green-400">
                      <CheckIcon /> Vérifié
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-3 py-1 text-xs font-bold text-red-500 dark:bg-red-500/10">
                      Non vérifié
                    </span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-waterloo dark:text-manatee">
                  <span className="inline-flex items-center gap-1.5">
                    <MailIcon /> {currentUser?.email || '—'}
                  </span>
                  {currentUser?.created_at && (
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarIcon /> Membre depuis{' '}
                      {new Date(currentUser.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })}
                    </span>
                  )}
                </div>
                {nameError && <p className="mt-1.5 text-xs text-red-500">{nameError}</p>}
              </div>
            </div>
          </div>

          {/* Jira / Thème — grille 2 colonnes */}
          <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-2">

            {/* Jira — statut de connexion */}
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-stroke p-7 shadow-solid-8 dark:border-strokedark">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <LinkIcon />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-black dark:text-white">Jira</h2>
                  {jiraStatusLoaded ? (
                    jiraStatus?.connected ? (
                      <p className="inline-flex items-center gap-1 text-xs font-semibold text-green-600 dark:text-green-400">
                        <CheckIcon /> Connecté à Jira{jiraStatus.jiraEmail ? ` (${jiraStatus.jiraEmail})` : ''}
                      </p>
                    ) : (
                      <p className="text-xs text-waterloo dark:text-manatee">Non connecté</p>
                    )
                  ) : (
                    <p className="text-xs text-waterloo dark:text-manatee">Chargement...</p>
                  )}
                </div>
              </div>
              <button
                type="button" onClick={() => setShowJiraSettings(true)}
                className="shrink-0 rounded-full border border-stroke px-4 py-2 text-xs font-bold text-black hover:border-primary hover:text-primary dark:border-strokedark dark:text-white"
              >
                {jiraStatus?.connected ? 'Gérer' : 'Connecter'}
              </button>
            </div>

            {/* Thème — préférence liée au profil */}
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-stroke p-7 shadow-solid-8 dark:border-strokedark">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-black dark:text-white">Thème</h2>
                  <p className="text-xs text-waterloo dark:text-manatee">Lié à votre profil</p>
                </div>
              </div>
              <div className="flex shrink-0 gap-1 rounded-full border border-stroke p-1 dark:border-strokedark">
                <button
                  type="button" onClick={() => handleThemeChange('light')}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${theme === 'light' ? 'bg-black text-white dark:bg-btndark' : 'text-waterloo dark:text-manatee'}`}
                >
                  <SunIcon /> Clair
                </button>
                <button
                  type="button" onClick={() => handleThemeChange('dark')}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${theme === 'dark' ? 'bg-black text-white dark:bg-btndark' : 'text-waterloo dark:text-manatee'}`}
                >
                  <MoonIcon /> Sombre
                </button>
              </div>
            </div>

            {/* Mot de passe */}
            <div className="rounded-2xl border border-stroke p-7 shadow-solid-8 dark:border-strokedark md:col-span-2">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <LockIcon />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-black dark:text-white">Mot de passe</h2>
                    <p className="text-xs text-waterloo dark:text-manatee">
                      {currentUser?.passwordChangedAt
                        ? `Modifié le ${formatDate(currentUser.passwordChangedAt)}`
                        : 'Sécurisé par vérification OTP'}
                    </p>
                  </div>
                </div>

                {!passwordSectionOpen && (
                  <button
                    type="button"
                    onClick={() => setPasswordSectionOpen(true)}
                    className="shrink-0 rounded-full border border-stroke px-4 py-2 text-xs font-bold text-black hover:border-primary hover:text-primary dark:border-strokedark dark:text-white"
                  >
                    Modifier
                  </button>
                )}
              </div>

            {passwordSectionOpen && (
              <div className="mt-6 border-t border-stroke pt-6 dark:border-strokedark">
                <p className="mb-5 text-xs text-waterloo dark:text-manatee">
                  {step === 'form'
                    ? 'Un code de confirmation vous sera envoyé par email avant le changement.'
                    : <>Code envoyé à <span className="font-semibold text-black dark:text-white">{currentUser?.email}</span>. Il expire dans 15 minutes.</>}
                </p>

                {step === 'form' ? (
                  <form onSubmit={handleRequestOtp} className="space-y-4">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="current-password" className={labelClass}>Mot de passe actuel</label>
                      <div className="relative">
                        <input
                          id="current-password"
                          type={showCurrent ? 'text' : 'password'}
                          placeholder="Mot de passe actuel"
                          autoComplete="current-password"
                          required
                          value={currentPassword} onChange={e => setCurrentPassword(e.target.value)}
                          className={fieldInputClass}
                        />
                        <button type="button" onClick={() => setShowCurrent(s => !s)} className={toggleBtnClass}>
                          {showCurrent ? 'Masquer' : 'Afficher'}
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="new-password" className={labelClass}>Nouveau mot de passe</label>
                      <div className="relative">
                        <input
                          id="new-password"
                          type={showNew ? 'text' : 'password'}
                          placeholder="Nouveau mot de passe"
                          autoComplete="new-password"
                          required minLength={8} maxLength={32}
                          value={newPassword} onChange={e => setNewPassword(e.target.value)}
                          className={fieldInputClass}
                        />
                        <button type="button" onClick={() => setShowNew(s => !s)} className={toggleBtnClass}>
                          {showNew ? 'Masquer' : 'Afficher'}
                        </button>
                      </div>

                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {PASSWORD_CHECKS.map(check => {
                          const valid = check.test(newPassword);
                          return (
                            <span
                              key={check.label}
                              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                                valid
                                  ? 'bg-green-50 text-green-600 dark:bg-green-500/10 dark:text-green-400'
                                  : 'bg-gray-100 text-waterloo dark:bg-[#2C303B] dark:text-manatee'
                              }`}
                            >
                              <CheckIcon />
                              {check.label}
                            </span>
                          );
                        })}
                      </div>

                      {isSameAsCurrent && (
                        <p className="mt-1 text-xs text-red-500">Doit être différent du mot de passe actuel</p>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="confirm-password" className={labelClass}>Confirmer le nouveau mot de passe</label>
                      <div className="relative">
                        <input
                          id="confirm-password"
                          type={showConfirm ? 'text' : 'password'}
                          placeholder="Confirmer le nouveau mot de passe"
                          autoComplete="new-password"
                          required minLength={8} maxLength={32}
                          value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                          className={fieldInputClass}
                        />
                        <button type="button" onClick={() => setShowConfirm(s => !s)} className={toggleBtnClass}>
                          {showConfirm ? 'Masquer' : 'Afficher'}
                        </button>
                      </div>
                      {confirmPassword.length > 0 && !passwordsMatch && (
                        <p className="mt-1 text-xs text-red-500">Les mots de passe ne correspondent pas</p>
                      )}
                    </div>

                    {error && (
                      <div className="rounded-lg border border-red-600/40 bg-red-600/5 px-3.5 py-2.5 text-xs text-red-700 dark:border-red-700/40 dark:bg-red-600/10 dark:text-red-400">{error}</div>
                    )}
                    {success && (
                      <div className="rounded-lg border border-meta/30 bg-meta/5 px-3.5 py-2.5 text-xs text-meta">{success}</div>
                    )}

                    <div className="flex gap-3">
                      <button
                        type="button" onClick={closePasswordSection}
                        className="rounded-full border border-stroke px-5 py-2.5 text-sm font-bold text-waterloo hover:text-black dark:border-strokedark dark:text-manatee dark:hover:text-white"
                      >
                        Annuler
                      </button>
                      <button
                        type="submit" disabled={saving || !canRequestOtp}
                        className="flex-1 rounded-full bg-black px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-blackho disabled:cursor-not-allowed disabled:opacity-60 dark:bg-btndark dark:hover:bg-blackho"
                      >
                        {saving ? 'Envoi du code...' : 'Envoyer le code de confirmation'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={handleConfirmChange} className="space-y-4">
                    <input
                      ref={otpInputRef}
                      type="text"
                      inputMode="numeric"
                      placeholder="000000"
                      autoComplete="one-time-code"
                      required minLength={4} maxLength={6}
                      value={otpCode} onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      className="w-full border-b border-stroke bg-white! pb-3.5 text-center text-2xl font-bold tracking-[0.5em] outline-hidden focus:border-primary dark:border-strokedark dark:bg-black!"
                    />

                    {error && (
                      <div className="rounded-lg border border-red-600/40 bg-red-600/5 px-3.5 py-2.5 text-xs text-red-700 dark:border-red-700/40 dark:bg-red-600/10 dark:text-red-400">{error}</div>
                    )}
                    {success && (
                      <div className="rounded-lg border border-meta/30 bg-meta/5 px-3.5 py-2.5 text-xs text-meta">{success}</div>
                    )}

                    <button
                      type="submit" disabled={saving || otpCode.length < 4}
                      className="w-full rounded-full bg-black px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-blackho disabled:cursor-not-allowed disabled:opacity-60 dark:bg-btndark dark:hover:bg-blackho"
                    >
                      {saving ? 'Confirmation...' : 'Confirmer le changement'}
                    </button>

                    <div className="flex items-center justify-between text-xs">
                      <button
                        type="button" onClick={resetFlow}
                        className="font-medium text-waterloo hover:text-black dark:text-manatee dark:hover:text-white"
                      >
                        ← Retour
                      </button>
                      <button
                        type="button" onClick={handleResend} disabled={resending || cooldown > 0}
                        className="font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline"
                      >
                        {resending ? 'Envoi...' : cooldown > 0 ? `Renvoyer le code (${cooldown}s)` : 'Renvoyer le code'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
            </div>
          </div>

          {/* Zone danger */}
          <div className="mt-8 rounded-2xl border border-red-500/30 bg-red-500/5 p-7">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10 text-red-500">
                <AlertIcon />
              </div>
              <div>
                <h2 className="text-lg font-bold text-red-600 dark:text-red-400">Zone danger</h2>
                <p className="text-xs text-waterloo dark:text-manatee">Suppression du compte</p>
              </div>
            </div>

            {dangerDone ? (
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-meta/30 bg-meta/5 px-3.5 py-2.5 text-xs font-medium text-meta">
                <CheckIcon /> {dangerDone}
              </div>
            ) : dangerConfirming ? (
              <div className="space-y-3 rounded-xl border border-red-500/30 bg-white p-4 dark:bg-black">
                <p className="text-sm font-medium text-black dark:text-white">
                  Confirmer la demande de suppression de votre compte ?
                </p>
                <p className="text-xs text-waterloo dark:text-manatee">
                  Un administrateur recevra votre demande et la validera manuellement. Votre compte reste actif jusque-là.
                </p>
                {dangerError && (
                  <div className="rounded-lg border border-red-600/40 bg-red-600/5 px-3.5 py-2.5 text-xs text-red-700 dark:border-red-700/40 dark:bg-red-600/10 dark:text-red-400">{dangerError}</div>
                )}
                <div className="flex gap-3 pt-1">
                  <button
                    type="button" onClick={() => { setDangerConfirming(false); setDangerError(null); }} disabled={dangerBusy}
                    className="rounded-full border border-stroke px-5 py-2.5 text-sm font-bold text-waterloo hover:text-black dark:border-strokedark dark:text-manatee dark:hover:text-white"
                  >
                    Annuler
                  </button>
                  <button
                    type="button" onClick={requestDeletion} disabled={dangerBusy}
                    className="flex-1 rounded-full bg-red-600 px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {dangerBusy ? 'Envoi...' : 'Confirmer la demande'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-waterloo dark:text-manatee">
                  Envoyer une demande de suppression de compte à un administrateur.
                </p>
                <button
                  type="button" onClick={() => setDangerConfirming(true)}
                  className="shrink-0 rounded-full border border-red-500/40 px-5 py-2.5 text-sm font-bold text-red-600 hover:bg-red-500/10 dark:text-red-400"
                >
                  Demander la suppression
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {showJiraSettings && <JiraSettingsModal onClose={() => setShowJiraSettings(false)} />}
    </div>
  );
}