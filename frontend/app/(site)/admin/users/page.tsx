'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import ConfirmDeleteModal from '@/app/components/ConfirmDeleteModal';

const API_BASE = '/api/backend';

type Role = 'ADMIN' | 'QA' | 'BA' | 'PO';

interface AppUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  isEmailVerified: boolean;
  isActive: boolean;
  created_at: string;
}

interface CurrentUser {
  id?: string;
  email?: string;
  name?: string;
  role?: Role;
}

function Spinner() {
  return <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />;
}

const ROLE_STYLES: Record<Role, string> = {
  ADMIN: 'text-purple-600 bg-purple-50 dark:bg-purple-900/20 border-purple-200',
  QA: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 border-blue-200',
  BA: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20 border-amber-200',
  PO: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200',
};

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  QA: 'QA',
  BA: 'BA',
  PO: 'PO',
};

// ─── UserFormModal — création / édition ────────────────────────────────────
function UserFormModal({
  user, onClose, onSaved,
}: {
  user: AppUser | null; // null = création
  onClose: () => void;
  onSaved: (u: AppUser) => void;
}) {
  const isEdit = !!user;
  const [email, setEmail] = useState(user?.email ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'QA');
  const [password, setPassword] = useState('');
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (isEdit) {
        const res = await fetch(`${API_BASE}/users/${user!.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, role, isActive }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setError(data?.message || 'Échec de la mise à jour'); setSaving(false); return; }
        onSaved(data);
      } else {
        const res = await fetch(`${API_BASE}/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, name, role, ...(password ? { password } : {}) }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setError(data?.message || 'Échec de la création'); setSaving(false); return; }
        onSaved(data);
      }
    } catch {
      setError('Impossible de contacter le serveur.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-black border border-stroke dark:border-strokedark shadow-solid-8 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-stroke dark:border-strokedark flex items-center justify-between">
          <h3 className="font-bold text-black dark:text-white">{isEdit ? 'Modifier l\'utilisateur' : 'Nouvel utilisateur'}</h3>
          <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-lg">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-bold text-waterloo mb-1.5">Email</label>
            <input
              type="email" required disabled={isEdit} value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none disabled:opacity-50"
              placeholder="user@analyzer.local"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-waterloo mb-1.5">Nom complet</label>
            <input
              type="text" required minLength={2} maxLength={50} value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none"
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-waterloo mb-1.5">Rôle</label>
            <div className="flex gap-2">
              {(['ADMIN', 'QA', 'BA', 'PO'] as Role[]).map(r => (
                <button
                  type="button" key={r} onClick={() => setRole(r)}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold border transition-all ${role === r ? ROLE_STYLES[r] : 'text-waterloo border-stroke dark:border-strokedark hover:border-primary/40'}`}
                >
                  {ROLE_LABELS[r]}
                </button>
              ))}
            </div>
          </div>
          {!isEdit && (
            <div>
              <label className="block text-xs font-bold text-waterloo mb-1.5">Mot de passe initial (optionnel)</label>
              <input
                type="password" minLength={8} maxLength={32} value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none"
                placeholder="Laisser vide pour générer + envoyer par email"
              />
              <p className="text-[10px] text-manatee mt-1">Un code d'activation sera envoyé par email dans tous les cas.</p>
            </div>
          )}
          {isEdit && (
            <label className="flex items-center gap-2 text-sm text-black dark:text-white cursor-pointer">
              <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="rounded" />
              Compte actif
            </label>
          )}

          {error && (
            <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-3.5 py-2.5 text-xs text-red-600 dark:text-red-400">{error}</div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-full text-sm font-bold text-waterloo hover:text-black dark:hover:text-white transition-all">Annuler</button>
            <button type="submit" disabled={saving} className="px-5 py-2 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho disabled:opacity-60 transition-all flex items-center gap-2">
              {saving && <Spinner />} {isEdit ? 'Enregistrer' : 'Créer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Page principale ────────────────────────────────────────────────────────
export default function AdminUsersPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | 'ALL'>('ALL');
  const [modalUser, setModalUser] = useState<AppUser | null | 'NEW'>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setCurrentUser(d?.user ?? null))
      .finally(() => setAuthChecked(true));
  }, []);

  const loadUsers = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/users`)
      .then(r => {
        if (r.status === 401) { router.push('/auth/signin?next=/admin/users'); return null; }
        if (r.status === 403) { setError('FORBIDDEN'); return null; }
        return r.json();
      })
      .then(d => { if (Array.isArray(d)) setUsers(d); setLoading(false); })
      .catch(() => { setError('Impossible de joindre le backend'); setLoading(false); });
  }, [router]);

  useEffect(() => {
    if (authChecked && currentUser?.role === 'ADMIN') loadUsers();
    else if (authChecked) setLoading(false);
  }, [authChecked, currentUser, loadUsers]);

  const handleDelete = async (id: string) => {
    setDeleting(true);
    setDeleteError(null);
    const res = await fetch(`${API_BASE}/users/${id}`, { method: 'DELETE' }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setDeleting(false);
    if (!res || !res.ok) {
      setDeleteError(data?.message || 'Impossible de supprimer cet utilisateur');
      setConfirmId(null);
      return;
    }
    setUsers(prev => prev.filter(u => u.id !== id));
    setConfirmId(null);
  };

  const filtered = users.filter(u =>
    (roleFilter === 'ALL' || u.role === roleFilter) &&
    (!search || u.email.toLowerCase().includes(search.toLowerCase()) || u.name.toLowerCase().includes(search.toLowerCase()))
  );

  const counts = {
    total: users.length,
    ADMIN: users.filter(u => u.role === 'ADMIN').length,
    QA: users.filter(u => u.role === 'QA').length,
    BA: users.filter(u => u.role === 'BA').length,
    PO: users.filter(u => u.role === 'PO').length,
  };

  // ── Garde d'accès (UX — la vraie sécurité est appliquée par le backend) ──
  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-black">
        <Spinner />
      </div>
    );
  }

  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-white dark:bg-black px-4 text-center">
        <div className="text-5xl">🔒</div>
        <h1 className="text-xl font-bold text-black dark:text-white">Accès réservé aux administrateurs</h1>
        <p className="text-waterloo text-sm max-w-sm">Cette page de gestion des utilisateurs n'est accessible qu'aux comptes avec le rôle Admin.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white dark:bg-black">
      <section className="pt-35 pb-10 md:pt-40">
        <div className="mx-auto max-w-c-1390 px-4 md:px-8 2xl:px-0">

          {/* Header */}
          <div className="mb-10">
            <div className="mb-4 inline-block rounded-full bg-zumthor dark:border dark:border-strokedark dark:bg-blacksection px-4.5 py-1.5">
              <span className="text-sectiontitle font-medium text-black dark:text-white">UTILISATEURS</span>
            </div>
            <h1 className="text-3xl font-bold text-black dark:text-white xl:text-sectiontitle3 mb-3">
              Gestion des{' '}
              <span className="relative inline-block before:absolute before:bottom-2.5 before:left-0 before:-z-1 before:h-3 before:w-full before:bg-titlebg dark:before:bg-titlebgdark">
                Utilisateurs
              </span>
            </h1>
            <p className="text-waterloo dark:text-manatee">Comptes, rôles (Admin / QA / BA) et activation par email</p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8 max-w-3xl">
            <div className="rounded-2xl border p-5 text-black dark:text-white bg-alabaster dark:bg-blacksection border-stroke dark:border-strokedark">
              <div className="text-2xl font-bold">{counts.total}</div>
              <div className="text-xs font-semibold opacity-70 mt-0.5">Total</div>
            </div>
            <div className="rounded-2xl border p-5 text-purple-600 bg-purple-50 dark:bg-purple-900/20 border-purple-200">
              <div className="text-2xl font-bold">{counts.ADMIN}</div>
              <div className="text-xs font-semibold opacity-70 mt-0.5">Admin</div>
            </div>
            <div className="rounded-2xl border p-5 text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200">
              <div className="text-2xl font-bold">{counts.PO}</div>
              <div className="text-xs font-semibold opacity-70 mt-0.5">PO</div>
            </div>
            <div className="rounded-2xl border p-5 text-amber-600 bg-amber-50 dark:bg-amber-900/20 border-amber-200">
              <div className="text-2xl font-bold">{counts.BA}</div>
              <div className="text-xs font-semibold opacity-70 mt-0.5">BA</div>
            </div>
            <div className="rounded-2xl border p-5 text-blue-600 bg-blue-50 dark:bg-blue-900/20 border-blue-200">
              <div className="text-2xl font-bold">{counts.QA}</div>
              <div className="text-xs font-semibold opacity-70 mt-0.5">QA</div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
            <div className="relative flex-1 max-w-md">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-waterloo text-sm">🔍</span>
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Chercher par email ou nom..."
                className="w-full pl-10 pr-4 py-2.5 rounded-full border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none transition-all"
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="flex gap-1 bg-alabaster dark:bg-blacksection border border-stroke dark:border-strokedark rounded-full p-1">
                {(['ALL', 'ADMIN', 'PO', 'BA', 'QA'] as const).map(r => (
                  <button key={r} onClick={() => setRoleFilter(r)} className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${roleFilter === r ? 'bg-white dark:bg-btndark text-black dark:text-white shadow-solid-2' : 'text-waterloo hover:text-black dark:hover:text-white'}`}>
                    {r === 'ALL' ? 'Tous' : ROLE_LABELS[r]}
                  </button>
                ))}
              </div>
              <button onClick={() => setModalUser('NEW')} className="px-5 py-2.5 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho transition-all">+ Nouvel utilisateur</button>
            </div>
          </div>

          {deleteError && (
            <div className="mb-4 rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-4 py-2.5 text-xs text-red-600 dark:text-red-400">{deleteError}</div>
          )}

          {/* Content */}
          {loading ? (
            <div className="flex items-center justify-center min-h-[40vh] gap-3 text-waterloo">
              <Spinner /><span className="text-sm">Chargement des utilisateurs...</span>
            </div>
          ) : error === 'FORBIDDEN' ? (
            <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-center">
              <div className="text-5xl">🔒</div>
              <p className="text-waterloo text-sm">Le backend a refusé l'accès (rôle insuffisant).</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4 text-center">
              <div className="text-5xl">🔌</div>
              <p className="text-waterloo text-sm">{error}</p>
              <button onClick={loadUsers} className="px-5 py-2.5 rounded-full border border-primary/40 text-primary text-sm font-bold hover:bg-zumthor transition-all">🔄 Réessayer</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4">
              <div className="text-6xl opacity-20">{search ? '🔍' : '👥'}</div>
              <p className="text-waterloo text-sm">{search ? 'Aucun utilisateur ne correspond' : 'Aucun utilisateur pour le moment'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-stroke dark:border-strokedark">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-alabaster dark:bg-blacksection text-left text-xs font-bold text-waterloo uppercase">
                    <th className="px-5 py-3">Utilisateur</th>
                    <th className="px-5 py-3">Rôle</th>
                    <th className="px-5 py-3">Statut</th>
                    <th className="px-5 py-3">Créé le</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(u => (
                    <tr key={u.id} className="border-t border-stroke dark:border-strokedark hover:bg-alabaster/50 dark:hover:bg-blacksection/50 transition-all">
                      <td className="px-5 py-3.5">
                        <div className="font-bold text-black dark:text-white">{u.name}</div>
                        <div className="text-xs text-waterloo">{u.email}</div>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`text-xs font-bold border rounded-full px-3 py-1 ${ROLE_STYLES[u.role]}`}>{ROLE_LABELS[u.role]}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex flex-col gap-1">
                          <span className={`text-[10px] font-bold w-fit rounded-full px-2.5 py-0.5 ${u.isActive ? 'text-meta bg-meta/10' : 'text-red-500 bg-red-50 dark:bg-red-900/20'}`}>
                            {u.isActive ? 'Actif' : 'Désactivé'}
                          </span>
                          <span className={`text-[10px] font-bold w-fit rounded-full px-2.5 py-0.5 ${u.isEmailVerified ? 'text-primary bg-primary/10' : 'text-amber-600 bg-amber-50 dark:bg-amber-900/20'}`}>
                            {u.isEmailVerified ? 'Email vérifié' : 'En attente d\u2019activation'}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-waterloo text-xs">{new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => setModalUser(u)} className="px-3 py-1.5 rounded-full border border-stroke dark:border-strokedark text-xs font-bold text-waterloo hover:text-primary hover:border-primary/40 transition-all">Modifier</button>
                          <button onClick={() => setConfirmId(u.id)} className="px-3 py-1.5 rounded-full border border-red-200 text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all">Supprimer</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {modalUser && (
        <UserFormModal
          user={modalUser === 'NEW' ? null : modalUser}
          onClose={() => setModalUser(null)}
          onSaved={(saved) => {
            setUsers(prev => {
              const exists = prev.some(u => u.id === saved.id);
              return exists ? prev.map(u => (u.id === saved.id ? saved : u)) : [saved, ...prev];
            });
            setModalUser(null);
          }}
        />
      )}

      <ConfirmDeleteModal
        open={confirmId !== null}
        title="Supprimer cet utilisateur ?"
        message="Ce compte utilisateur sera définitivement supprimé. Cette action est irréversible."
        loading={deleting}
        onCancel={() => setConfirmId(null)}
        onConfirm={() => confirmId && handleDelete(confirmId)}
      />
    </div>
  );
}
