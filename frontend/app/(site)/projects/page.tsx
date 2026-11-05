'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { retryConfluenceSpace, getConfluenceStatus, listConfluenceSpaces, searchConfluencePages, importFromConfluence, ConfluenceSpaceSummary, ConfluencePageSummary } from '@/lib/confluence-api';
import ConfirmDeleteModal from '@/app/components/ConfirmDeleteModal';
import JiraSettingsModal from '@/app/components/JiraSettingsModal';
import { useJira } from '@/app/context/JiraContext';

const API_BASE = '/api/backend';

interface ProjectMember {
  id: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'QA' | 'BA' | 'PO';
}

interface Project {
  id: string;
  name: string;
  document_type?: string;
  created_at: string;
  owner?: ProjectMember | null;
  assignedUsers?: ProjectMember[];
  confluence_status?: 'none' | 'pending' | 'created' | 'failed';
  confluence_space_url?: string | null;
  confluence_error?: string | null;
  modules?: Array<{
    name: string;
    requirements?: Array<{ test_cases?: any[] }>;
  }>;
}

function Spinner() {
  return <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />;
}

const ROLE_STYLES: Record<string, string> = {
  ADMIN: 'text-purple-600 bg-purple-50 dark:bg-purple-900/20 border-purple-200',
  QA: 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 border-blue-200',
  BA: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20 border-amber-200',
};

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'date' | 'name' | 'tcs'>('date');
  const [ownerFilter, setOwnerFilter] = useState<'all' | 'mine' | 'others'>('all');
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<{ id?: string; role?: string; pinnedProjectIds?: string[] } | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [pinningId, setPinningId] = useState<string | null>(null);
  // QA n'a pas le droit de créer des projets (seuls ADMIN et BA le peuvent)
  const canCreateProject = currentUser?.role !== 'QA';
  const [assignModalProject, setAssignModalProject] = useState<Project | null>(null);
  const [renameProject, setRenameProject] = useState<Project | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [retryingConfluenceId, setRetryingConfluenceId] = useState<string | null>(null);
  const [showJiraSettings, setShowJiraSettings] = useState(false);
  const { status: jiraStatus } = useJira();

  const handleRetryConfluence = async (projectId: string) => {
    setRetryingConfluenceId(projectId);
    try {
      await retryConfluenceSpace(projectId);
      setProjects(prev => prev.map(p => p.id === projectId ? { ...p, confluence_status: 'pending' } : p));
    } catch {
      // silencieux — l'utilisateur peut réessayer
    } finally {
      setRetryingConfluenceId(null);
    }
  };

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        setCurrentUser(d?.user ?? null);
        setPinnedIds(new Set(d?.user?.pinnedProjectIds ?? []));
      })
      .catch(() => setCurrentUser(null));
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/projects`)
      .then(r => {
        if (r.status === 401) {
          router.push('/auth/signin?next=/projects');
          return null;
        }
        return r.json();
      })
      .then(d => { if (d) { setProjects(Array.isArray(d) ? d : []); } setLoading(false); })
      .catch(() => { setError('Impossible de joindre le backend'); setLoading(false); });
  }, [router]);

  // Rafraîchit le statut Confluence des projets encore "pending" (création en cours)
  useEffect(() => {
    const pendingIds = projects.filter(p => p.confluence_status === 'pending').map(p => p.id);
    if (pendingIds.length === 0) return;
    const timer = setInterval(() => {
      pendingIds.forEach(id => {
        getConfluenceStatus(id)
          .then(s => {
            if (s.status !== 'pending') {
              setProjects(prev => prev.map(p => p.id === id
                ? { ...p, confluence_status: s.status, confluence_space_url: s.spaceUrl, confluence_error: s.error }
                : p));
            }
          })
          .catch(() => {});
      });
    }, 4000);
    return () => clearInterval(timer);
  }, [projects]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' }).catch(() => {});
    setProjects(prev => prev.filter(p => p.id !== id));
    setDeletingId(null);
    setConfirmId(null);
  };

  const handleTogglePin = async (id: string) => {
    const isPinned = pinnedIds.has(id);
    setPinningId(id);
    // optimiste
    setPinnedIds(prev => {
      const next = new Set(prev);
      if (isPinned) next.delete(id); else next.add(id);
      return next;
    });
    try {
      const res = await fetch(`${API_BASE}/projects/${id}/pin`, { method: isPinned ? 'DELETE' : 'POST' });
      if (!res.ok) throw new Error();
      const data = await res.json().catch(() => null);
      if (data?.pinnedProjectIds) setPinnedIds(new Set(data.pinnedProjectIds));
    } catch {
      // rollback si l'appel échoue
      setPinnedIds(prev => {
        const next = new Set(prev);
        if (isPinned) next.add(id); else next.delete(id);
        return next;
      });
    } finally {
      setPinningId(null);
    }
  };

  const getStats = (project: Project) => {
    const totalReqs = (project.modules || []).reduce((a, m) => a + (m.requirements?.length ?? 0), 0);
    const totalTCs = (project.modules || []).reduce((a, m) => a + (m.requirements || []).reduce((b, r) => b + (r.test_cases?.length ?? 0), 0), 0);
    return { totalReqs, totalTCs, modules: project.modules?.length ?? 0 };
  };

  const filtered = projects
    .filter(p => !search || p.name?.toLowerCase().includes(search.toLowerCase()) || p.document_type?.toLowerCase().includes(search.toLowerCase()))
    .filter(p => {
      if (ownerFilter === 'mine') return p.owner?.id === currentUser?.id;
      if (ownerFilter === 'others') return p.owner?.id !== currentUser?.id;
      return true;
    })
    .sort((a, b) => {
      const pinDiff = Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id));
      if (pinDiff !== 0) return pinDiff;
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'tcs') return getStats(b).totalTCs - getStats(a).totalTCs;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  return (
    <div className="min-h-screen bg-white dark:bg-black">
      {/* Hero */}
      <section className="pt-35 pb-10 md:pt-40">
        <div className="mx-auto max-w-c-1390 px-4 md:px-8 2xl:px-0">

          {/* Header */}
          <div className="mb-10">
            <div className="mb-4 inline-block rounded-full bg-zumthor dark:border dark:border-strokedark dark:bg-blacksection px-4.5 py-1.5">
              <span className="text-sectiontitle font-medium text-black dark:text-white">PROJETS</span>
            </div>
            <h1 className="text-3xl font-bold text-black dark:text-white xl:text-sectiontitle3 mb-3">
              Mes{' '}
              <span className="relative inline-block before:absolute before:bottom-2.5 before:left-0 before:-z-1 before:h-3 before:w-full before:bg-titlebg dark:before:bg-titlebgdark">
                Projets
              </span>
            </h1>
            <p className="text-waterloo dark:text-manatee">Gérez vos projets d'analyse de documents et vos cahiers de recettes</p>
          </div>

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
            <div className="relative flex-1 max-w-md">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-waterloo text-sm">🔍</span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Chercher un projet..."
                className="w-full pl-10 pr-4 py-2.5 rounded-full border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none transition-all"
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="flex gap-1 bg-alabaster dark:bg-blacksection border border-stroke dark:border-strokedark rounded-full p-1">
                {[{ key: 'all', label: 'Tous' }, { key: 'mine', label: '👤 Créés par moi' }, { key: 'others', label: '👥 Autres' }].map(f => (
                  <button key={f.key} onClick={() => setOwnerFilter(f.key as any)} className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${ownerFilter === f.key ? 'bg-white dark:bg-btndark text-black dark:text-white shadow-solid-2' : 'text-waterloo hover:text-black dark:hover:text-white'}`}>{f.label}</button>
                ))}
              </div>
              <div className="flex gap-1 bg-alabaster dark:bg-blacksection border border-stroke dark:border-strokedark rounded-full p-1">
                {[{ key: 'date', label: '📅 Date' }, { key: 'name', label: '🔤 Nom' }, { key: 'tcs', label: '🧪 TCs' }].map(s => (
                  <button key={s.key} onClick={() => setSortBy(s.key as any)} className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${sortBy === s.key ? 'bg-white dark:bg-btndark text-black dark:text-white shadow-solid-2' : 'text-waterloo hover:text-black dark:hover:text-white'}`}>{s.label}</button>
                ))}
              </div>
              <button
                onClick={() => setShowJiraSettings(true)}
                className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all whitespace-nowrap inline-flex items-center gap-1.5 ${
                  jiraStatus?.connected
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-blue-600/8 text-blue-700 dark:text-blue-400 hover:bg-blue-600/14'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${jiraStatus?.connected ? 'bg-white' : 'bg-blue-600 animate-pulse'}`} />
                Atlassian
                {jiraStatus?.connected ? ' · Connecté' : ' · Se connecter'}
              </button>
              {canCreateProject && (
                <button onClick={() => setShowCreateModal(true)} className="px-5 py-2.5 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho transition-all">+ Nouveau projet</button>
              )}
            </div>
          </div>

          {/* Content */}
          {loading ? (
            <div className="flex items-center justify-center min-h-[40vh] gap-3 text-waterloo">
              <Spinner />
              <span className="text-sm">Chargement des projets...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4">
              <div className="text-5xl">🔌</div>
              <p className="text-waterloo text-sm text-center">{error}</p>
              <p className="text-manatee text-xs">Vérifiez que le backend NestJS est démarré et accessible (variable d'environnement <code className="bg-stroke dark:bg-strokedark px-1.5 py-0.5 rounded text-black dark:text-white">BACKEND_URL</code>)</p>
              <button onClick={() => { setLoading(true); setError(null); fetch(`${API_BASE}/projects`).then(r => { if (r.status === 401) { router.push('/auth/signin?next=/projects'); return null; } return r.json(); }).then(d => { if (d) setProjects(Array.isArray(d) ? d : []); setLoading(false); }).catch(() => { setError('Impossible de joindre le backend'); setLoading(false); }); }} className="px-5 py-2.5 rounded-full border border-primary/40 text-primary text-sm font-bold hover:bg-zumthor transition-all">🔄 Réessayer</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4">
              <div className="text-6xl opacity-20">{search ? '🔍' : '📭'}</div>
              <p className="text-waterloo text-sm">
                {search
                  ? 'Aucun projet correspond à votre recherche'
                  : ownerFilter === 'mine'
                  ? "Vous n'avez créé aucun projet pour le moment"
                  : ownerFilter === 'others'
                  ? "Aucun projet créé par d'autres utilisateurs"
                  : 'Aucun projet sauvegardé pour le moment'}
              </p>
              {!search && ownerFilter === 'all' && canCreateProject && <button onClick={() => setShowCreateModal(true)} className="px-6 py-2.5 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho transition-all">+ Créer mon premier projet</button>}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              {filtered.map(project => {
                const stats = getStats(project);
                const date = new Date(project.created_at);
                const isRecent = (Date.now() - date.getTime()) < 86400000 * 2;
                return (
                  <div key={project.id} className="bg-white dark:bg-blacksection border border-stroke dark:border-strokedark rounded-2xl overflow-hidden shadow-solid-3 hover:shadow-solid-4 hover:border-primary/30 transition-all group">
                    {/* Card header */}
                    <div className="p-5 border-b border-stroke dark:border-strokedark bg-alabaster dark:bg-black/20">
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <h3 className="text-sm font-bold text-black dark:text-white truncate">{project.name}</h3>
                            {pinnedIds.has(project.id) && <span className="text-[9px] font-bold text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700/40 rounded-full px-2 py-0.5 flex-shrink-0">📌 Épinglé</span>}
                            {isRecent && <span className="text-[9px] font-bold text-primary bg-zumthor dark:bg-blackho border border-primary/30 rounded-full px-2 py-0.5 flex-shrink-0">NOUVEAU</span>}
                          </div>
                          {project.document_type && (
                            <span className="inline-block text-[10px] font-bold text-sky-700 dark:text-sky-400 bg-sky-600/5 dark:bg-sky-600/10 border border-sky-600/30 dark:border-sky-700/40 rounded px-2 py-0.5">{project.document_type}</span>
                          )}
                          {project.confluence_status === 'created' && project.confluence_space_url && (
                            <a
                              href={project.confluence_space_url}
                              target="_blank"
                              rel="noreferrer"
                              title="Ouvrir l'espace Confluence"
                              className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-600/5 dark:bg-emerald-600/10 border border-emerald-600/30 dark:border-emerald-700/40 rounded px-2 py-0.5 hover:underline"
                            >
                              🗂️ Confluence
                            </a>
                          )}
                          {project.confluence_status === 'pending' && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 dark:text-amber-400 bg-amber-600/5 dark:bg-amber-600/10 border border-amber-600/30 dark:border-amber-700/40 rounded px-2 py-0.5">
                              <Spinner /> Confluence…
                            </span>
                          )}
                          {project.confluence_status === 'failed' && (
                            <button
                              onClick={() => handleRetryConfluence(project.id)}
                              title={project.confluence_error || "Échec de la création de l'espace Confluence — cliquer pour réessayer"}
                              className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700 dark:text-red-400 bg-red-600/5 dark:bg-red-600/10 border border-red-600/30 dark:border-red-700/40 rounded px-2 py-0.5 hover:bg-red-600/10"
                            >
                              {retryingConfluenceId === project.id ? <Spinner /> : '⚠️ Confluence — réessayer'}
                            </button>
                          )}
                        </div>
                        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-lg flex-shrink-0">📂</div>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-waterloo">
                        <span>📅 {date.toLocaleDateString('fr-FR')}</span>
                        <span className="text-stroke dark:text-strokedark">·</span>
                        <span>{date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      {(project.owner || (project.assignedUsers && project.assignedUsers.length > 0)) && (
                        <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
                          {project.owner && (
                            <span className={`text-[10px] font-bold rounded-full px-2.5 py-0.5 border ${project.owner.id === currentUser?.id ? 'text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-900/30 border-purple-300' : 'text-purple-600 bg-purple-50 dark:bg-purple-900/20 border-purple-200'}`}>
                              👤 {project.owner.id === currentUser?.id ? 'Vous' : project.owner.name}
                            </span>
                          )}
                          {(project.assignedUsers ?? []).map(u => (
                            <span key={u.id} className="text-[10px] font-bold text-blue-600 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 rounded-full px-2.5 py-0.5">
                              {u.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Stats */}
                    <div className="grid grid-cols-3 divide-x divide-stroke dark:divide-strokedark">
                      {[
                        { label: 'Modules', value: stats.modules, icon: '📦' },
                        { label: 'Exigences', value: stats.totalReqs, icon: '📋' },
                        { label: 'Cas de test', value: stats.totalTCs, icon: '🧪', highlight: stats.totalTCs > 0 },
                      ].map(s => (
                        <div key={s.label} className="px-4 py-3 text-center">
                          <div className={`text-lg font-bold ${s.highlight ? 'text-meta' : 'text-black dark:text-white'}`}>{s.value}</div>
                          <div className="text-[9px] text-waterloo font-semibold mt-0.5">{s.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Actions */}
                    <div className="px-5 py-3 border-t border-stroke dark:border-strokedark flex items-center justify-end gap-3">
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => handleTogglePin(project.id)}
                          disabled={pinningId === project.id}
                          className={`p-1.5 rounded-lg border transition-all text-sm ${pinnedIds.has(project.id) ? 'border-amber-500/50 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400' : 'border-stroke dark:border-strokedark text-waterloo hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20'}`}
                          title={pinnedIds.has(project.id) ? 'Désépingler' : 'Épingler ce projet'}
                        >
                          {pinningId === project.id ? <Spinner /> : '📌'}
                        </button>
                        {(currentUser?.role === 'ADMIN' || currentUser?.id === project.owner?.id) && (
                          <button onClick={() => setAssignModalProject(project)} className="p-1.5 rounded-lg border border-primary/30 text-primary hover:bg-zumthor dark:hover:bg-blacksection transition-all text-sm" title="Assigner des utilisateurs">👥</button>
                        )}
                        <button onClick={() => setRenameProject(project)} className="p-1.5 rounded-lg border border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-all text-sm" title="Renommer le projet">✏️</button>
                        <button onClick={() => setConfirmId(project.id)} className="p-1.5 rounded-lg border border-red-600/30 text-red-700 dark:text-red-400 hover:text-red-700 dark:hover:text-red-400 hover:bg-red-600/5 transition-all text-sm" title="Supprimer le projet">🗑️</button>
                        <Link href={`/analyzer?projectId=${project.id}`} className="px-4 py-1.5 rounded-full bg-primary text-white text-xs font-bold hover:bg-primaryho transition-all">Ouvrir →</Link>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer info */}
          {!loading && filtered.length > 0 && (
            <div className="mt-8 pt-6 border-t border-stroke dark:border-strokedark flex items-center justify-between text-xs text-waterloo flex-wrap gap-3">
              <span>{filtered.length} projet{filtered.length !== 1 ? 's' : ''} affiché{filtered.length !== 1 ? 's' : ''}{(search || ownerFilter !== 'all') ? ` sur ${projects.length}` : ''}</span>
              <div className="flex items-center gap-3">
                {canCreateProject && (
                  <button onClick={() => setShowCreateModal(true)} className="text-primary hover:text-primaryho font-semibold transition-colors">+ Nouveau projet →</button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {assignModalProject && (
        <AssignUsersModal
          project={assignModalProject}
          onClose={() => setAssignModalProject(null)}
          onSaved={(updated) => {
            setProjects(prev => prev.map(p => (p.id === updated.id ? { ...p, ...updated } : p)));
            setAssignModalProject(null);
          }}
        />
      )}

      {renameProject && (
        <RenameProjectModal
          project={renameProject}
          onClose={() => setRenameProject(null)}
          onSaved={(updated) => {
            setProjects(prev => prev.map(p => (p.id === updated.id ? { ...p, name: updated.name } : p)));
            setRenameProject(null);
          }}
        />
      )}

      <ConfirmDeleteModal
        open={confirmId !== null}
        title="Supprimer ce projet ?"
        message="Le projet, ses modules, exigences et cas de test seront définitivement supprimés. Cette action est irréversible."
        loading={deletingId !== null}
        onCancel={() => setConfirmId(null)}
        onConfirm={() => confirmId && handleDelete(confirmId)}
      />

      {showJiraSettings && <JiraSettingsModal onClose={() => setShowJiraSettings(false)} />}

      {showCreateModal && (
        <CreateProjectModal
          currentUserId={currentUser?.id}
          currentUserRole={currentUser?.role}
          onClose={() => setShowCreateModal(false)}
          onCreated={(newProject) => {
            setProjects(prev => [newProject, ...prev]);
            setShowCreateModal(false);
          }}
        />
      )}
    </div>
  );
}

// ─── AssignUsersModal — choisir les collaborateurs d'un projet ──────────────
function AssignUsersModal({
  project, onClose, onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const [directory, setDirectory] = useState<ProjectMember[]>([]);
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(
    new Set((project.assignedUsers ?? []).map(u => u.id))
  );
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/users/directory`)
      .then(r => (r.ok ? r.json() : []))
      .then(d => setDirectory(Array.isArray(d) ? d : []))
      .catch(() => setError('Impossible de charger la liste des utilisateurs'))
      .finally(() => setLoadingDirectory(false));
  }, []);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/projects/${project.id}/assignees`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: Array.from(selected) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message || "Échec de l'assignation");
        setSaving(false);
        return;
      }
      onSaved(data.data ?? data);
    } catch {
      setError('Impossible de contacter le serveur.');
      setSaving(false);
    }
  };

  const assignable = directory.filter(u => u.id !== project.owner?.id);
  const filteredDirectory = assignable.filter(u =>
    !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-black border border-stroke dark:border-strokedark shadow-solid-8 overflow-hidden max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-stroke dark:border-strokedark flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="font-bold text-black dark:text-white">Assigner des utilisateurs</h3>
            <p className="text-xs text-waterloo truncate max-w-[280px]">{project.name}</p>
          </div>
          <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-lg">✕</button>
        </div>

        <div className="px-6 py-3 border-b border-stroke dark:border-strokedark flex-shrink-0">
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Chercher un utilisateur..."
            className="w-full px-3.5 py-2 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none"
          />
        </div>

        <div className="overflow-y-auto flex-1 px-3 py-2">
          {loadingDirectory ? (
            <div className="flex items-center justify-center py-10 gap-2 text-waterloo text-sm"><Spinner /> Chargement...</div>
          ) : filteredDirectory.length === 0 ? (
            <div className="text-center text-waterloo text-sm py-10">Aucun utilisateur trouvé</div>
          ) : (
            filteredDirectory.map(u => (
              <label key={u.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-alabaster dark:hover:bg-blacksection cursor-pointer transition-all">
                <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} className="rounded" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-black dark:text-white truncate">{u.name}</div>
                  <div className="text-xs text-waterloo truncate">{u.email}</div>
                </div>
                <span className={`text-[10px] font-bold border rounded-full px-2 py-0.5 flex-shrink-0 ${ROLE_STYLES[u.role] ?? ''}`}>{u.role}</span>
              </label>
            ))
          )}
        </div>

        {error && (
          <div className="px-6 py-2 flex-shrink-0">
            <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-3.5 py-2.5 text-xs text-red-600 dark:text-red-400">{error}</div>
          </div>
        )}

        <div className="px-6 py-4 border-t border-stroke dark:border-strokedark flex items-center justify-between flex-shrink-0">
          <span className="text-xs text-waterloo">{selected.size} sélectionné{selected.size !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="px-4 py-2 rounded-full text-sm font-bold text-waterloo hover:text-black dark:hover:text-white transition-all">Annuler</button>
            <button onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho disabled:opacity-60 transition-all flex items-center gap-2">
              {saving && <Spinner />} Enregistrer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
// ─── RenameProjectModal ──────────────────────────────────────────────────────
function RenameProjectModal({
  project, onClose, onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim() || name.trim() === project.name) { onClose(); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch(`${API_BASE}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.message || 'Erreur lors du renommage'); setSaving(false); return; }
      onSaved(data.data ?? { ...project, name: name.trim() });
    } catch {
      setError('Impossible de contacter le serveur.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-black border border-stroke dark:border-strokedark shadow-solid-8 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-stroke dark:border-strokedark flex items-center justify-between">
          <div>
            <h3 className="font-bold text-black dark:text-white">Renommer le projet</h3>
            <p className="text-xs text-waterloo truncate max-w-[240px]">{project.name}</p>
          </div>
          <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-lg">✕</button>
        </div>
        <div className="px-6 py-5">
          <label className="block text-xs font-bold text-waterloo uppercase tracking-widest mb-2">Nouveau nom</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
            autoFocus
            placeholder="Nom du projet..."
            className="w-full px-3.5 py-2.5 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none"
          />
          {error && <div className="mt-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
        </div>
        <div className="px-6 py-4 border-t border-stroke dark:border-strokedark flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded-full text-sm font-bold text-waterloo hover:text-black dark:hover:text-white transition-all">Annuler</button>
          <button onClick={handleSave} disabled={saving || !name.trim()} className="px-5 py-2 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho disabled:opacity-60 transition-all flex items-center gap-2">
            {saving && <Spinner />} Renommer
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ProjectNameField (composant stable : ne doit jamais être redéfini à chaque rendu) ──────
function ProjectNameField({
  name, setName, nameIsValid, mode, onEnterSubmit,
}: {
  name: string;
  setName: (v: string) => void;
  nameIsValid: boolean;
  mode: 'choice' | 'import' | 'manual' | 'confluence';
  onEnterSubmit: () => void;
}) {
  return (
    <div className="mb-4">
      <label className="block text-xs font-bold text-waterloo uppercase tracking-widest mb-2">Nom du projet</label>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && mode === 'manual') onEnterSubmit(); }}
        autoFocus
        placeholder="Domaine_NomDuProjet"
        className={`w-full px-3.5 py-2.5 rounded-lg border bg-white dark:bg-black text-sm text-black dark:text-white focus:outline-none ${
          name.trim() && !nameIsValid ? 'border-red-400 focus:border-red-400' : 'border-stroke dark:border-strokedark focus:border-primary'
        }`}
      />
      <p className="mt-1.5 text-[11px] text-waterloo">
        Format attendu : <span className="font-mono font-bold text-primary">Domaine_NomDuProjet</span> (ex: RH_GestionConges)
      </p>
    </div>
  );
}

// ─── AssignUsersSection (composant stable, état de recherche isolé en local) ────
function AssignUsersSection({
  showAssign, setShowAssign, loadingDirectory, directory, currentUserId, selectedUserIds, toggleUser,
}: {
  showAssign: boolean;
  setShowAssign: (v: boolean | ((x: boolean) => boolean)) => void;
  loadingDirectory: boolean;
  directory: ProjectMember[];
  currentUserId?: string;
  selectedUserIds: Set<string>;
  toggleUser: (id: string) => void;
}) {
  // État local : taper dans cette barre ne re-rend QUE ce composant, jamais le parent.
  const [userSearch, setUserSearch] = useState('');
  const selectedUsers = directory.filter(u => selectedUserIds.has(u.id));
  const filteredDirectory = directory
    .filter(u => u.id !== currentUserId)
    .filter(u =>
      !userSearch || u.name.toLowerCase().includes(userSearch.toLowerCase()) || u.email.toLowerCase().includes(userSearch.toLowerCase())
    );

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setShowAssign(x => !x)}
        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-left transition-all ${
          showAssign ? 'border-primary/60 bg-zumthor dark:bg-blacksection' : 'border-stroke dark:border-strokedark hover:border-primary/40'
        }`}
      >
        <span className="text-2xl flex-shrink-0">👥</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-black dark:text-white">Collaborateurs sur ce projet</div>
          {selectedUsers.length === 0 ? (
            <p className="text-xs text-waterloo">Optionnel — donnez accès à ce projet à d'autres membres de l'équipe</p>
          ) : (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {selectedUsers.map(u => (
                <span key={u.id} className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary bg-primary/10 border border-primary/30 rounded-full px-2 py-0.5">
                  {u.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="text-xs font-bold text-primary flex-shrink-0 whitespace-nowrap">
          {showAssign ? 'Fermer ▲' : selectedUsers.length > 0 ? 'Modifier ▾' : '+ Ajouter'}
        </span>
      </button>
      {showAssign && (
        <div className="mt-2 rounded-lg border border-stroke dark:border-strokedark overflow-hidden">
          <div className="px-3 py-2.5 border-b border-stroke dark:border-strokedark bg-alabaster dark:bg-blacksection">
            <p className="text-xs font-bold text-black dark:text-white mb-1.5">Sélectionnez les collaborateurs à inviter</p>
            <input
              value={userSearch}
              onChange={e => setUserSearch(e.target.value)}
              placeholder="Chercher par nom ou email..."
              className="w-full px-3 py-1.5 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-xs text-black dark:text-white focus:border-primary focus:outline-none"
            />
          </div>
          <div className="max-h-40 overflow-y-auto px-1.5 py-1">
            {loadingDirectory ? (
              <div className="flex items-center justify-center py-6 gap-2 text-waterloo text-xs"><Spinner /> Chargement...</div>
            ) : filteredDirectory.length === 0 ? (
              <div className="text-center text-waterloo text-xs py-6">Aucun utilisateur trouvé</div>
            ) : (
              filteredDirectory.map(u => {
                const checked = selectedUserIds.has(u.id);
                return (
                  <label key={u.id} className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-all ${checked ? 'bg-primary/5' : 'hover:bg-alabaster dark:hover:bg-blacksection'}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleUser(u.id)} className="rounded w-4 h-4 accent-primary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-black dark:text-white truncate">{u.name}</div>
                      <div className="text-[11px] text-waterloo truncate">{u.email}</div>
                    </div>
                    <span className={`text-[9px] font-bold border rounded-full px-1.5 py-0.5 flex-shrink-0 ${ROLE_STYLES[u.role] ?? ''}`}>{u.role}</span>
                  </label>
                );
              })
            )}
          </div>
          <div className="px-3 py-2 border-t border-stroke dark:border-strokedark bg-alabaster dark:bg-blacksection">
            <span className="text-[11px] text-waterloo">{selectedUsers.length} sélectionné{selectedUsers.length > 1 ? 's' : ''}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CreateProjectModal ──────────────────────────────────────────────────────
function CreateProjectModal({
  onClose, onCreated, currentUserId, currentUserRole,
}: {
  onClose: () => void;
  onCreated: (p: Project) => void;
  currentUserId?: string;
  currentUserRole?: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'choice' | 'import' | 'manual' | 'confluence'>('choice');
  // Seul BA peut saisir/éditer le contenu du SRS (modules/exigences) à la main
  const canManualSrs = currentUserRole === 'BA' || currentUserRole === 'PO';

  // ── État commun : nom du projet (nomenclature attendue : Domaine_NomDuProjet) ──
  const [name, setName] = useState('');
  const nameIsValid = /^[^\s_]+_.+$/.test(name.trim());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── État spécifique à l'import ──
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── État spécifique à l'import Confluence ──
  const [confluenceSpaces, setConfluenceSpaces] = useState<ConfluenceSpaceSummary[]>([]);
  const [loadingSpaces, setLoadingSpaces] = useState(false);
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const [selectedSpaceKey, setSelectedSpaceKey] = useState('');
  const [confluencePages, setConfluencePages] = useState<ConfluencePageSummary[]>([]);
  const [loadingPages, setLoadingPages] = useState(false);
  const [pageQuery, setPageQuery] = useState('');
  const [selectedPage, setSelectedPage] = useState<ConfluencePageSummary | null>(null);

  useEffect(() => {
    if (mode !== 'confluence' || confluenceSpaces.length > 0) return;
    setLoadingSpaces(true);
    setSpacesError(null);
    listConfluenceSpaces()
      .then(setConfluenceSpaces)
      .catch(err => setSpacesError(err.message || "Impossible de charger les espaces Confluence. Vérifie que ton compte Atlassian est connecté."))
      .finally(() => setLoadingSpaces(false));
  }, [mode, confluenceSpaces.length]);

  useEffect(() => {
    if (!selectedSpaceKey) { setConfluencePages([]); return; }
    setLoadingPages(true);
    const timer = setTimeout(() => {
      searchConfluencePages(selectedSpaceKey, pageQuery)
        .then(setConfluencePages)
        .catch(() => setConfluencePages([]))
        .finally(() => setLoadingPages(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [selectedSpaceKey, pageQuery]);

  // ── Assignation d'utilisateurs (optionnel, dès la création) ──
  const [showAssign, setShowAssign] = useState(false);
  const [directory, setDirectory] = useState<ProjectMember[]>([]);
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(`${API_BASE}/users/directory`)
      .then(r => (r.ok ? r.json() : []))
      .then(d => setDirectory(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoadingDirectory(false));
  }, []);

  const toggleUser = (id: string) => {
    setSelectedUserIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedUsers = directory.filter(u => selectedUserIds.has(u.id));

  // Assignation best-effort : la création du projet reste valide même si cette étape échoue
  // (l'utilisateur pourra réessayer depuis "👥 Assigner des utilisateurs" sur la liste des projets).
  const applyAssignment = async (projectId: string) => {
    if (selectedUserIds.size === 0) return;
    try {
      await fetch(`${API_BASE}/projects/${projectId}/assignees`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: Array.from(selectedUserIds) }),
      });
    } catch (e) {
      console.error('[CreateProjectModal] assignation échouée :', e);
    }
  };

  const pickFile = (f: File | null) => {
    setFile(f);
    if (f && !name.trim()) setName(f.name.replace(/\.[^/.]+$/, ''));
  };

  const pickPage = (p: ConfluencePageSummary) => {
    setSelectedPage(p);
    if (!name.trim()) setName(p.title.replace(/[\s_]+/g, '_'));
  };

  // ── Créer un projet vide puis ouvrir l'éditeur manuel (template de l'app) ──
  const handleCreateManual = async () => {
    if (!nameIsValid) { setError('Le nom doit respecter le format Domaine_NomDuProjet'); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.message || 'Erreur lors de la création'); setSaving(false); return; }
      const project = data.data ?? data;
      await applyAssignment(project.id);
      onCreated({ ...project, assignedUsers: selectedUsers });
      router.push(`/analyzer?projectId=${project.id}&mode=create`);
    } catch {
      setError('Impossible de contacter le serveur.');
      setSaving(false);
    }
  };

  // ── Importer un document SRS : crée le projet ET lance l'extraction IA ──
  const handleImport = async () => {
    if (!file) { setError('Choisissez un fichier SRS'); return; }
    if (!nameIsValid) { setError('Le nom doit respecter le format Domaine_NomDuProjet'); return; }
    setSaving(true); setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('projectName', name.trim());
      const res = await fetch(`${API_BASE}/documents/upload`, { method: 'POST', body: formData });
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { throw new Error(`Réponse invalide : ${text.slice(0, 200)}`); }
      if (!res.ok) { setError(data?.message || data?.error || 'Erreur lors de l\'import'); setSaving(false); return; }
      const projectId = data.projectId;
      if (!projectId) throw new Error('Aucun projectId retourné par le serveur');
      await applyAssignment(projectId);
      onCreated({
        id: projectId, name: name.trim(), document_type: undefined, created_at: new Date().toISOString(),
        assignedUsers: selectedUsers,
      });
      router.push(`/analyzer?projectId=${projectId}`);
    } catch (err: any) {
      setError(err.message || 'Impossible de contacter le serveur.');
      setSaving(false);
    }
  };

  // ── Importer une page Confluence existante : crée le projet ET lance l'extraction IA ──
  const handleImportConfluence = async () => {
    if (!selectedPage) { setError('Choisissez une page Confluence'); return; }
    if (!nameIsValid) { setError('Le nom doit respecter le format Domaine_NomDuProjet'); return; }
    setSaving(true); setError(null);
    try {
      const result = await importFromConfluence(selectedSpaceKey, selectedPage.id, name.trim());
      const projectId = result.projectId;
      if (!projectId) throw new Error('Aucun projectId retourné par le serveur');
      await applyAssignment(projectId);
      onCreated({
        id: projectId, name: name.trim(), document_type: undefined, created_at: new Date().toISOString(),
        assignedUsers: selectedUsers,
      });
      router.push(`/analyzer?projectId=${projectId}`);
    } catch (err: any) {
      setError(err.message || "Impossible d'importer la page Confluence.");
      setSaving(false);
    }
  };

  // ── Bloc réutilisable : sélection des collaborateurs ──
  // (le rendu est délégué au composant stable AssignUsersSection, voir plus bas)

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 px-4" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-black border border-stroke dark:border-strokedark shadow-solid-8 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-stroke dark:border-strokedark flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="font-bold text-black dark:text-white">
              {mode === 'choice' ? 'Nouveau projet' : mode === 'import' ? 'Importer un document SRS' : mode === 'confluence' ? 'Importer depuis Confluence' : 'Créer mon SRS dans l\'app'}
            </h3>
            <p className="text-xs text-waterloo">
              {mode === 'choice' ? 'Comment voulez-vous démarrer ?' : mode === 'import' ? 'Le document sera analysé automatiquement par l\'IA' : mode === 'confluence' ? 'La page sera analysée automatiquement par l\'IA, comme un document uploadé' : 'Ajoutez vos modules et exigences selon le template de l\'app'}
            </p>
          </div>
          <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-lg">✕</button>
        </div>

        <div className="overflow-y-auto flex-1">
          {/* ── Étape 1 : choix du mode de création ── */}
          {mode === 'choice' && (
            <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                onClick={() => { setError(null); setMode('import'); }}
                className="text-left p-5 rounded-xl border-2 border-stroke dark:border-strokedark hover:border-primary/60 hover:bg-zumthor dark:hover:bg-blacksection transition-all"
              >
                <div className="text-3xl mb-3">📤</div>
                <div className="font-bold text-black dark:text-white text-sm mb-1">Importer un document SRS</div>
                <p className="text-xs text-waterloo">PDF, DOCX, TXT, MD — extraction automatique des modules et exigences par IA</p>
              </button>
              {canManualSrs && (
                <button
                  onClick={() => { setError(null); setMode('manual'); }}
                  className="text-left p-5 rounded-xl border-2 border-stroke dark:border-strokedark hover:border-primary/60 hover:bg-zumthor dark:hover:bg-blacksection transition-all"
                >
                  <div className="text-3xl mb-3">✍️</div>
                  <div className="font-bold text-black dark:text-white text-sm mb-1">Créer mon SRS dans l'app</div>
                  <p className="text-xs text-waterloo">Saisissez vos modules et exigences à la main, selon le template intégré</p>
                </button>
              )}
              <button
                onClick={() => { setError(null); setMode('confluence'); }}
                className="text-left p-5 rounded-xl border-2 border-stroke dark:border-strokedark hover:border-primary/60 hover:bg-zumthor dark:hover:bg-blacksection transition-all"
              >
                <div className="text-3xl mb-3">🗂️</div>
                <div className="font-bold text-black dark:text-white text-sm mb-1">Importer depuis Confluence</div>
                <p className="text-xs text-waterloo">Choisissez une page existante dans un espace Confluence connecté</p>
              </button>
            </div>
          )}

          {/* ── Étape 2a : import de document ── */}
          {mode === 'import' && (
            <div className="px-6 py-5">
              <ProjectNameField name={name} setName={setName} nameIsValid={nameIsValid} mode={mode} onEnterSubmit={handleCreateManual} />
              <label className="block text-xs font-bold text-waterloo uppercase tracking-widest mb-2">Document SRS</label>
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) pickFile(f); }}
                className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${dragOver ? 'border-primary bg-zumthor dark:bg-blacksection' : file ? 'border-primary/40 bg-zumthor dark:bg-blacksection' : 'border-stroke dark:border-strokedark hover:border-primary/40'}`}
              >
                {file ? (
                  <><div className="text-3xl mb-2">📄</div><p className="text-sm font-bold text-primary">{file.name}</p><p className="text-xs text-waterloo">{(file.size / 1024 / 1024).toFixed(2)} MB · <span onClick={e => { e.stopPropagation(); setFile(null); }} className="text-red-700 dark:text-red-400 cursor-pointer font-semibold">Retirer</span></p></>
                ) : (
                  <><div className="text-4xl mb-2 opacity-30">📥</div><p className="text-sm text-waterloo">Déposer le fichier SRS ici ou cliquer</p><p className="text-xs text-manatee mt-1">PDF, DOCX, TXT, Markdown</p></>
                )}
                <input ref={fileInputRef} type="file" accept=".pdf,.docx,.txt,.md" className="hidden" onChange={e => { if (e.target.files?.[0]) pickFile(e.target.files[0]); }} />
              </div>
              <AssignUsersSection
                showAssign={showAssign} setShowAssign={setShowAssign} loadingDirectory={loadingDirectory}
                directory={directory} currentUserId={currentUserId} selectedUserIds={selectedUserIds}
                toggleUser={toggleUser}
              />
              {error && <div className="mt-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
            </div>
          )}

          {/* ── Étape 2b : création manuelle (template app) ── */}
          {mode === 'manual' && (
            <div className="px-6 py-5">
              <ProjectNameField name={name} setName={setName} nameIsValid={nameIsValid} mode={mode} onEnterSubmit={handleCreateManual} />
              <AssignUsersSection
                showAssign={showAssign} setShowAssign={setShowAssign} loadingDirectory={loadingDirectory}
                directory={directory} currentUserId={currentUserId} selectedUserIds={selectedUserIds}
                toggleUser={toggleUser}
              />
              {error && <div className="mt-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
              <p className="mt-3 text-xs text-manatee">Le projet s'ouvrira directement dans l'éditeur : vous pourrez y ajouter des modules puis des exigences (identifiant, description, priorité), comme dans un SRS classique.</p>
            </div>
          )}

          {/* ── Étape 2c : import depuis Confluence ── */}
          {mode === 'confluence' && (
            <div className="px-6 py-5">
              <label className="block text-xs font-bold text-waterloo uppercase tracking-widest mb-2">Espace Confluence</label>
              {loadingSpaces ? (
                <div className="flex items-center gap-2 text-sm text-waterloo py-2"><Spinner /> Chargement des espaces…</div>
              ) : spacesError ? (
                <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-600 dark:text-red-400">{spacesError}</div>
              ) : (
                <select
                  value={selectedSpaceKey}
                  onChange={e => { setSelectedSpaceKey(e.target.value); setSelectedPage(null); setPageQuery(''); }}
                  className="w-full mb-4 px-3 py-2 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-blacksection text-sm text-black dark:text-white"
                >
                  <option value="">— Choisir un espace —</option>
                  {confluenceSpaces.map(s => (
                    <option key={s.key} value={s.key}>{s.name} ({s.key})</option>
                  ))}
                </select>
              )}

              {selectedSpaceKey && (
                <>
                  <label className="block text-xs font-bold text-waterloo uppercase tracking-widest mb-2">Page à importer</label>
                  <input
                    type="text"
                    value={pageQuery}
                    onChange={e => setPageQuery(e.target.value)}
                    placeholder="Rechercher une page par titre…"
                    className="w-full mb-2 px-3 py-2 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-blacksection text-sm text-black dark:text-white"
                  />
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-stroke dark:border-strokedark divide-y divide-stroke dark:divide-strokedark">
                    {loadingPages ? (
                      <div className="flex items-center gap-2 text-sm text-waterloo px-3 py-3"><Spinner /> Recherche…</div>
                    ) : confluencePages.length === 0 ? (
                      <div className="text-xs text-manatee px-3 py-3">Aucune page trouvée.</div>
                    ) : (
                      confluencePages.map(p => (
                        <button
                          key={p.id}
                          onClick={() => pickPage(p)}
                          className={`w-full text-left px-3 py-2 text-sm transition-all ${selectedPage?.id === p.id ? 'bg-zumthor dark:bg-blacksection text-primary font-semibold' : 'hover:bg-zumthor dark:hover:bg-blacksection text-black dark:text-white'}`}
                        >
                          📄 {p.title}
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}

              {selectedPage && (
                <div className="mt-4">
                  <ProjectNameField name={name} setName={setName} nameIsValid={nameIsValid} mode={mode} onEnterSubmit={handleImportConfluence} />
                  <AssignUsersSection
                    showAssign={showAssign} setShowAssign={setShowAssign} loadingDirectory={loadingDirectory}
                    directory={directory} currentUserId={currentUserId} selectedUserIds={selectedUserIds}
                    toggleUser={toggleUser}
                  />
                </div>
              )}
              {error && <div className="mt-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-stroke dark:border-strokedark flex items-center justify-between gap-3 flex-shrink-0">
          {mode === 'choice' ? (
            <button onClick={onClose} className="px-4 py-2 rounded-full text-sm font-bold text-waterloo hover:text-black dark:hover:text-white transition-all">Annuler</button>
          ) : (
            <button onClick={() => { setError(null); setMode('choice'); }} className="px-4 py-2 rounded-full text-sm font-bold text-waterloo hover:text-black dark:hover:text-white transition-all">← Retour</button>
          )}
          {mode === 'import' && (
            <button onClick={handleImport} disabled={saving || !file || !nameIsValid} className="px-5 py-2 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho disabled:opacity-60 transition-all flex items-center gap-2">
              {saving && <Spinner />} Créer et analyser
            </button>
          )}
          {mode === 'manual' && (
            <button onClick={handleCreateManual} disabled={saving || !nameIsValid} className="px-5 py-2 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho disabled:opacity-60 transition-all flex items-center gap-2">
              {saving && <Spinner />} Créer le projet
            </button>
          )}
          {mode === 'confluence' && (
            <button onClick={handleImportConfluence} disabled={saving || !selectedPage || !nameIsValid} className="px-5 py-2 rounded-full bg-primary text-white text-sm font-bold hover:bg-primaryho disabled:opacity-60 transition-all flex items-center gap-2">
              {saving && <Spinner />} Créer et analyser
            </button>
          )}
        </div>
      </div>
    </div>
  );
}