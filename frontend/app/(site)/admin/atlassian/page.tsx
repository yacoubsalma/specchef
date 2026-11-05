'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  listAllJiraConnections,
  revokeJiraConnection,
  type JiraAdminConnectionRow,
} from '@/lib/jira-api';

type Role = 'ADMIN' | 'QA' | 'BA' | 'PO';

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

export default function AtlassianAccessPage() {
  const router = useRouter();
  const [rows, setRows] = useState<JiraAdminConnectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'CONNECTED' | 'DISCONNECTED'>('ALL');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const loadConnections = useCallback(() => {
    setLoading(true);
    setError(null);
    listAllJiraConnections()
      .then(setRows)
      .catch((e) => {
        setError(e.message?.includes('403') || /r[oô]le/i.test(e.message || '') ? 'FORBIDDEN' : (e.message || 'Impossible de contacter le serveur.'));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => {
        if (r.status === 401) { router.push('/auth/signin?next=/admin/atlassian'); return null; }
        return r.ok ? r.json() : null;
      })
      .then((d) => {
        if (d?.user && d.user.role !== 'ADMIN') { router.push('/dashboard'); return; }
        loadConnections();
      });
  }, [router, loadConnections]);

  const handleRevoke = async (userId: string) => {
    setRevokeError(null);
    setRevokingId(userId);
    try {
      await revokeJiraConnection(userId);
      setRows((prev) => prev.map((r) => (r.userId === userId ? { ...r, connected: false, jiraBaseUrl: undefined, jiraEmail: undefined, updatedAt: undefined } : r)));
    } catch (e: any) {
      setRevokeError(e.message || 'Échec de la révocation.');
    } finally {
      setRevokingId(null);
      setConfirmId(null);
    }
  };

  const filtered = rows.filter((r) => {
    const matchesSearch = !search || r.userName.toLowerCase().includes(search.toLowerCase()) || r.userEmail.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || (statusFilter === 'CONNECTED' ? r.connected : !r.connected);
    return matchesSearch && matchesStatus;
  });

  const counts = {
    total: rows.length,
    connected: rows.filter((r) => r.connected).length,
    disconnected: rows.filter((r) => !r.connected).length,
  };

  return (
    <div className="min-h-screen bg-white dark:bg-black">
      <section className="pt-35 pb-20 md:pt-40">
        <div className="mx-auto max-w-c-1016 px-4 md:px-8 2xl:px-0">
          <div className="mb-10">
            <div className="mb-4 inline-block rounded-full bg-zumthor dark:border dark:border-strokedark dark:bg-blacksection px-4.5 py-1.5">
              <span className="text-sectiontitle font-medium text-black dark:text-white">ATLASSIAN</span>
            </div>
            <h1 className="text-3xl font-bold text-black dark:text-white xl:text-sectiontitle3 mb-3">
              Gestion des{' '}
              <span className="relative inline-block before:absolute before:bottom-2.5 before:left-0 before:-z-1 before:h-3 before:w-full before:bg-titlebg dark:before:bg-titlebgdark">
                Accès Atlassian
              </span>
            </h1>
            <p className="text-waterloo dark:text-manatee">
              Vue d'ensemble des connexions Jira personnelles des utilisateurs et révocation à distance
            </p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-8 max-w-2xl">
            <div className="rounded-2xl border p-5 text-black dark:text-white bg-alabaster dark:bg-blacksection border-stroke dark:border-strokedark">
              <div className="text-2xl font-bold">{counts.total}</div>
              <div className="text-xs font-semibold opacity-70 mt-0.5">Total</div>
            </div>
            <div className="rounded-2xl border p-5 text-meta bg-meta/5 border-meta/30">
              <div className="text-2xl font-bold">{counts.connected}</div>
              <div className="text-xs font-semibold opacity-70 mt-0.5">Connectés</div>
            </div>
            <div className="rounded-2xl border p-5 text-waterloo bg-alabaster dark:bg-blacksection border-stroke dark:border-strokedark">
              <div className="text-2xl font-bold">{counts.disconnected}</div>
              <div className="text-xs font-semibold opacity-70 mt-0.5">Non connectés</div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
            <div className="relative flex-1 max-w-md">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-waterloo text-sm">🔍</span>
              <input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Chercher par email ou nom..."
                className="w-full pl-10 pr-4 py-2.5 rounded-full border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none transition-all"
              />
            </div>
            <div className="flex gap-1 bg-alabaster dark:bg-blacksection border border-stroke dark:border-strokedark rounded-full p-1">
              {(['ALL', 'CONNECTED', 'DISCONNECTED'] as const).map((s) => (
                <button
                  key={s} onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${statusFilter === s ? 'bg-white dark:bg-btndark text-black dark:text-white shadow-solid-2' : 'text-waterloo hover:text-black dark:hover:text-white'}`}
                >
                  {s === 'ALL' ? 'Tous' : s === 'CONNECTED' ? 'Connectés' : 'Non connectés'}
                </button>
              ))}
            </div>
          </div>

          {revokeError && (
            <div className="mb-4 rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-4 py-2.5 text-xs text-red-600 dark:text-red-400">{revokeError}</div>
          )}

          {/* Content */}
          {loading ? (
            <div className="flex items-center justify-center min-h-[40vh] gap-3 text-waterloo">
              <Spinner /><span className="text-sm">Chargement des connexions Atlassian...</span>
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
              <button onClick={loadConnections} className="px-5 py-2.5 rounded-full border border-primary/40 text-primary text-sm font-bold hover:bg-zumthor transition-all">🔄 Réessayer</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4">
              <div className="text-6xl opacity-20">{search ? '🔍' : '🔗'}</div>
              <p className="text-waterloo text-sm">{search ? 'Aucun utilisateur ne correspond' : 'Aucune connexion Atlassian pour le moment'}</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-stroke dark:border-strokedark">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-alabaster dark:bg-blacksection text-left text-xs font-bold text-waterloo uppercase">
                    <th className="px-5 py-3">Utilisateur</th>
                    <th className="px-5 py-3">Rôle</th>
                    <th className="px-5 py-3">Statut Atlassian</th>
                    <th className="px-5 py-3">Instance Jira</th>
                    <th className="px-5 py-3">Dernière connexion</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.userId} className="border-t border-stroke dark:border-strokedark hover:bg-alabaster/50 dark:hover:bg-blacksection/50 transition-all">
                      <td className="px-5 py-3.5">
                        <div className="font-bold text-black dark:text-white">{r.userName}</div>
                        <div className="text-xs text-waterloo">{r.userEmail}</div>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`text-xs font-bold border rounded-full px-3 py-1 ${ROLE_STYLES[r.userRole]}`}>{ROLE_LABELS[r.userRole]}</span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`text-[10px] font-bold w-fit rounded-full px-2.5 py-0.5 ${r.connected ? 'text-meta bg-meta/10' : 'text-waterloo bg-alabaster dark:bg-blacksection'}`}>
                          {r.connected ? 'Connecté' : 'Non connecté'}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-waterloo text-xs">
                        {r.connected ? (
                          <>
                            <div>{r.jiraBaseUrl}</div>
                            <div className="text-manatee">{r.jiraEmail}</div>
                          </>
                        ) : '—'}
                      </td>
                      <td className="px-5 py-3.5 text-waterloo text-xs">
                        {r.updatedAt ? new Date(r.updatedAt).toLocaleDateString('fr-FR') : '—'}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        {!r.connected ? (
                          <span className="text-xs text-manatee">—</span>
                        ) : confirmId === r.userId ? (
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleRevoke(r.userId)}
                              disabled={revokingId === r.userId}
                              className="px-3 py-1.5 rounded-full bg-red-500 text-white text-xs font-bold hover:bg-red-600 disabled:opacity-60 transition-all"
                            >
                              {revokingId === r.userId ? <Spinner /> : 'Confirmer'}
                            </button>
                            <button onClick={() => setConfirmId(null)} className="px-3 py-1.5 rounded-full text-xs font-bold text-waterloo hover:text-black dark:hover:text-white transition-all">Annuler</button>
                          </div>
                        ) : (
                          <button onClick={() => setConfirmId(r.userId)} className="px-3 py-1.5 rounded-full border border-red-200 text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all">Révoquer l'accès</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}