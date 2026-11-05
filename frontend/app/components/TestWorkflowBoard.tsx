'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  validateWorkflow,
  unvalidateWorkflow,
  setWorkflowAccess,
  setWorkflowQaAccess,
  setWorkflowEditingPresence,
  setWorkflowViewingPresence,
  broadcastWorkflowCanvasLive,
  startWorkflowRun,
  listWorkflowRuns,
  getWorkflowRun,
  updateWorkflowStepResult,
  finishWorkflowRun,
  abortWorkflowRun,
  generateWorkflowTestData,
  getWorkflowVersions,
  restoreWorkflowVersion,
  TestWorkflow,
  WorkflowRun,
} from '@/lib/workflow-api';
import { getProjectMembers, ProjectMember } from '@/lib/projects-api';
import { WorkflowNode, WorkflowEdge, WorkflowVariable, WorkflowStepStatus, parseTestDataEntries } from '@/lib/workflow-types';
import TestWorkflowCanvas, { TestCaseOption, countStepAlerts } from './TestWorkflowCanvas';
import ConfirmDeleteModal from './ConfirmDeleteModal';
import VersionHistoryPanel from './VersionHistoryPanel';
import { ProjectRealtimeEvent, ProjectRealtimePayload } from '@/app/hooks/useProjectRealtime';

function Spinner() {
  return <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />;
}

const RUN_STATUS_META: Record<string, { icon: string; color: string; label: string }> = {
  running: { icon: '⏳', color: '#2563eb', label: 'En cours' },
  passed:  { icon: '✅', color: '#16a34a', label: 'Réussi' },
  failed:  { icon: '❌', color: '#dc2626', label: 'Échoué' },
  partial: { icon: '⚠️', color: '#d97706', label: 'Partiel' },
  aborted: { icon: '⏹️', color: '#94a3b8', label: 'Abandonné' },
};

function formatDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ── Avatars propriétaire/collaborateurs ─────────────────────────────────────
// Même logique que ProjectPresenceBar (angle doré ~137,5° pour un écart de
// teinte maximal entre personnes voisines) — cohérence visuelle avec le
// reste de l'app, sans emoji.
function avatarColorFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = Math.round((hash * 137.508) % 360);
  return `hsl(${hue}, 68%, 45%)`;
}

function avatarInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

function WorkflowAvatar({ id, name, isSelf, size = 20, online, activityLabel }: { id: string; name: string; isSelf?: boolean; size?: number; online?: boolean; activityLabel?: string }) {
  const tooltip = online ? `${isSelf ? 'Vous' : name} — ${activityLabel || 'en ligne'}` : (isSelf ? 'Vous' : name);
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <div
        title={tooltip}
        className="w-full h-full rounded-full border-2 border-white dark:border-black flex items-center justify-center font-bold text-white select-none"
        style={{ fontSize: size * 0.42, backgroundColor: avatarColorFor(id) }}
      >
        {isSelf ? '•' : avatarInitials(name)}
      </div>
      {online && (
        <span
          title={tooltip}
          className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-white dark:border-black bg-emerald-500"
          style={{ width: Math.max(size * 0.4, 7), height: Math.max(size * 0.4, 7) }}
        />
      )}
    </div>
  );
}

/** Pile d'avatars superposés (avec léger chevauchement) pour une liste de collaborateurs. */
function WorkflowAvatarStack({ users, size = 20, presence }: { users: { id: string; name?: string | null; email?: string | null }[]; size?: number; presence?: Record<string, { actorName: string; activity: 'viewing' | 'editing' }> }) {
  if (users.length === 0) return null;
  return (
    <div className="flex items-center" style={{ marginLeft: 4 }}>
      {users.map(u => {
        const p = presence?.[u.id];
        return (
          <div key={u.id} style={{ marginLeft: -6 }}>
            <WorkflowAvatar
              id={u.id}
              name={u.name || u.email || '?'}
              size={size}
              online={!!p}
              activityLabel={p ? (p.activity === 'editing' ? 'en train de modifier' : 'en train de consulter') : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

// ── Structure minimale attendue depuis testResult.modules (analyzer/page.tsx) ──
interface ModuleLike {
  name: string;
  requirements: { id?: string; test_cases?: { id?: string; testId?: string; test_id?: string; title: string; type: string; priority: string; requirementId?: string; requirement_id?: string; validated?: boolean; testData?: string[]; needsReview?: boolean; needsReviewReason?: string | null }[] }[];
}

interface TestWorkflowBoardProps {
  projectId: string | null;
  testModules?: ModuleLike[];
  /** Rôle de l'utilisateur connecté — détermine les actions autorisées :
   *  BA = création/édition du workflow, QA = exécution, ADMIN = consultation seule. */
  userRole?: 'ADMIN' | 'QA' | 'BA' | 'PO' | string;
  /** Id de l'utilisateur connecté — sert à déterminer s'il est le créateur
   *  du workflow actif (seul le créateur, ou un Admin, peut choisir les BA
   *  ayant accès à un brouillon). */
  currentUserId?: string;
  /** Dernier événement temps réel concernant un workflow (voir
   *  handleProjectRealtimeEvent dans analyzer/page.tsx), relayé depuis
   *  l'unique connexion WebSocket de la page — évite d'ouvrir une seconde
   *  connexion dédiée dans ce composant. */
  workflowRealtimeEvent?: { event: ProjectRealtimeEvent; payload: ProjectRealtimePayload; at: number } | null;
  /** Workflow à ouvrir directement au montage (arrivée depuis un clic sur une
   *  notification — voir ?view=workflow&workflowId=... dans analyzer/page.tsx). */
  initialWorkflowId?: string | null;
  /** Campagne de tests en cours pour ce projet (voir analyzer/page.tsx →
   *  campaignStatus === 'launched'). Inverse totalement les permissions du
   *  board : tant qu'elle est active, plus AUCUNE création/édition/
   *  suppression de workflow n'est permise (même pour un BA) — et à
   *  l'inverse, c'est la SEULE condition qui autorise un QA à démarrer une
   *  exécution (voir canAuthor/canExecute ci-dessous). Le backend applique
   *  la même règle indépendamment (assertProjectUnlocked / 
   *  assertCampaignLaunched côté WorkflowService) : cette prop ne sert qu'à
   *  donner un feedback UI immédiat.  */
  campaignLocked?: boolean;
}

export default function TestWorkflowBoard({ projectId, testModules, userRole, currentUserId, workflowRealtimeEvent, initialWorkflowId, campaignLocked = false }: TestWorkflowBoardProps) {
  // ── Permissions par rôle ───────────────────────────────────────────────────
  // BA : peut créer/éditer/supprimer un workflow — MAIS PLUS si une campagne
  // est en cours (campaignLocked), le projet est alors figé. QA : peut
  // UNIQUEMENT exécuter, et UNIQUEMENT si une campagne est active (c'est le
  // seul moment où canExecute passe à true — avant le lancement de la
  // campagne, le bouton d'exécution reste désactivé). ADMIN : consultation
  // seule dans tous les cas.
  const canAuthor = (userRole === 'BA' || userRole === 'PO') && !campaignLocked;
  const canExecute = userRole === 'QA' && campaignLocked;
  const isAdmin = userRole === 'ADMIN';
  const [workflows, setWorkflows] = useState<TestWorkflow[]>([]);
  // Filtre d'affichage de la galerie : "mine" isole les workflows dont
  // l'utilisateur connecté est le créateur, pour les distinguer visuellement
  // des workflows des autres BA.
  const [galleryFilter, setGalleryFilter] = useState<'all' | 'mine'>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<TestWorkflow | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showRunHistory, setShowRunHistory] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [activeRun, setActiveRun] = useState<WorkflowRun | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [showGenData, setShowGenData] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  const [showAccessModal, setShowAccessModal] = useState(false);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [savingAccess, setSavingAccess] = useState(false);
  // Présence temps réel : qui d'autre consulte/modifie tel workflow en ce
  // moment, par workflowId puis actorId — alimente le point vert affiché sur
  // les avatars (voir handleWorkflowRealtimeEvent et les effets de
  // signalement de présence plus bas).
  const [presence, setPresence] = useState<Record<string, Record<string, { actorName: string; activity: 'viewing' | 'editing' }>>>({});
  // Message affiché si un AUTRE BA a déjà la main sur ce workflow (verrou
  // dur — voir setWorkflowEditingPresence) : le canvas repasse en lecture
  // seule tant que ce verrou n'est pas levé par son détenteur.
  const [editLockError, setEditLockError] = useState<string | null>(null);

  // Créateur du workflow actif (ou Admin) : seul lui peut choisir les BA/QA
  // autorisés à voir/modifier/valider ce workflow tant qu'il est en brouillon.
  const isWorkflowOwner = !!active && (isAdmin || active.created_by?.id === currentUserId);
  // Un BA ne peut modifier/valider/supprimer QUE les workflows dont il est
  // le créateur ou un assigné (voir hasWorkflowAccess côté backend) — un BA
  // "non assigné" peut toujours CONSULTER (lecture seule), jamais agir.
  const hasEditAccess = !!active && (isAdmin || active.created_by?.id === currentUserId || (active.assignedUsers ?? []).some(u => u.id === currentUserId));
  // Même avec les droits d'édition, le canvas repasse en lecture seule tant
  // qu'un AUTRE BA détient le verrou d'édition de ce workflow (voir
  // editLockError, alimenté par setWorkflowEditingPresence ci-dessous) —
  // c'est ce qui empêche deux BA de modifier le même workflow en même temps.
  const canEditActive = hasEditAccess && !editLockError;
  const canEditWorkflow = useCallback((w: TestWorkflow) => (
    isAdmin || w.created_by?.id === currentUserId || (w.assignedUsers ?? []).some(u => u.id === currentUserId)
  ), [isAdmin, currentUserId]);
  // Fermé par défaut : liste QA vide = personne ne peut lancer/gérer une
  // exécution tant que le créateur n'a explicitement autorisé au moins un
  // QA — reflète la même règle appliquée côté backend (voir hasQaAccess).
  const qaCanExecuteActive = !!active && (isAdmin || !!active.assignedQas?.some(u => u.id === currentUserId));

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Nom de l'utilisateur qui détient actuellement le verrou d'édition affiché
  // (editLockError) — posé soit par un événement 'workflow:editing' reçu en
  // direct d'un autre utilisateur, soit par ma propre sauvegarde refusée
  // (voir persist()). Sert à ne lever la lecture seule que quand ce même
  // acteur relâche la main, pas sur n'importe quel signal.
  const editLockOwner = useRef<string | null>(null);

  // ── Catalogue des cas de test validés, utilisables comme étapes ──────────
  const testCaseOptions: TestCaseOption[] = useMemo(() => {
    const out: TestCaseOption[] = [];
    for (const mod of testModules || []) {
      for (const req of mod.requirements || []) {
        for (const tc of req.test_cases || []) {
          if (!tc.id) continue; // seuls les TC persistés (validés) sont référençables
          out.push({
            id: tc.id,
            testId: tc.testId || tc.test_id || tc.id,
            title: tc.title,
            type: tc.type,
            priority: tc.priority,
            requirementId: req.id || tc.requirementId || tc.requirement_id,
            moduleName: mod.name,
            testData: tc.testData || [],
            needsReview: tc.needsReview ?? false,
            needsReviewReason: tc.needsReviewReason ?? null,
          });
        }
      }
    }
    return out;
  }, [testModules]);

  // ── Chargement de la liste des workflows ──────────────────────────────────
  const loadList = useCallback(async () => {
    if (!projectId) return;
    setLoading(true); setError(null);
    try {
      const data = await listWorkflows(projectId);
      setWorkflows(data);
    } catch (err: any) {
      setError(err.message || 'Erreur lors du chargement des workflows');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => { loadList(); }, [loadList]);

  // Ouverture directe depuis une notification (?view=workflow&workflowId=...).
  // On ne consomme la valeur qu'une fois : un changement ultérieur (ex: une
  // autre notification cliquée pendant que ce composant est déjà monté) doit
  // pouvoir rouvrir un autre workflow, donc on suit `initialWorkflowId` tel
  // quel plutôt qu'un simple flag "déjà consommé".
  useEffect(() => {
    if (initialWorkflowId) setActiveId(initialWorkflowId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWorkflowId]);

  // ── Chargement du workflow actif ───────────────────────────────────────────
  useEffect(() => {
    if (!activeId || !projectId) { setActive(null); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const data = await getWorkflow(projectId, activeId);
        if (cancelled) return;
        setActive(data);
        setNameDraft(data.name);
        setActiveRun(null);
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Erreur lors du chargement du workflow');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeId, projectId]);

  // ── Présence : consultation (tout le monde) ────────────────────────────────
  // Signale l'ouverture/fermeture de ce workflow, quel que soit le rôle ou
  // les droits d'édition — c'est ce qui alimente le point vert affiché sur
  // l'avatar aux autres utilisateurs, y compris pour un QA ou un BA non
  // assigné en simple consultation.
  useEffect(() => {
    if (!activeId || !projectId) return;
    setWorkflowViewingPresence(projectId, activeId, true);
    return () => { setWorkflowViewingPresence(projectId, activeId, false); };
  }, [activeId, projectId]);

  // ── Présence : édition (verrou dur, BA autorisés uniquement) ────────────────
  // Le verrou n'est PAS posé à l'ouverture du workflow — seulement au premier
  // vrai changement, via le PATCH /:id d'autosave lui-même (voir
  // WorkflowController.update, qui appelle tryLockAction et renouvelle donc
  // le verrou à chaque autosave tant que l'onglet reste ouvert). `persist()`
  // capte déjà l'erreur `locked` renvoyée par ce PATCH pour remplir
  // `editLockError` (→ canEditActive repasse à false, canvas en lecture
  // seule) — inutile de dupliquer cet appel ici. On se contente de
  // réinitialiser l'erreur à l'ouverture d'un workflow et de libérer le
  // verrou à la fermeture (no-op si on ne le détient pas).
  useEffect(() => {
    setEditLockError(null);
    editLockOwner.current = null;
    if (!activeId || !projectId || !canAuthor || !hasEditAccess) return;
    return () => {
      setWorkflowEditingPresence(projectId, activeId, false);
    };
  }, [activeId, projectId, canAuthor, hasEditAccess]);

  // ── Temps réel ─────────────────────────────────────────────────────────
  // Quand un BA valide (ou dé-valide) un workflow, ou qu'un workflow est
  // créé/supprimé/modifié par quelqu'un d'autre, on rafraîchit instantanément
  // la galerie (et le workflow ouvert le cas échéant) sans que l'utilisateur
  // ait besoin de recharger la page. Les événements dont on est soi-même
  // l'auteur sont déjà filtrés par le hook (on a la donnée à jour localement).
  const activeRef = useRef(active);
  activeRef.current = active;
  const activeRunRef = useRef(activeRun);
  activeRunRef.current = activeRun;
  const showRunHistoryRef = useRef(showRunHistory);
  showRunHistoryRef.current = showRunHistory;

  const handleWorkflowRealtimeEvent = useCallback((event: ProjectRealtimeEvent, payload: ProjectRealtimePayload) => {
    if (!event.startsWith('workflow:')) return;
    const workflowId = (payload as any).workflowId as string | undefined;

    if (event === 'workflow:canvas-live') {
      // Rendu live du graphe en cours d'édition par quelqu'un d'autre — on
      // n'applique QUE si c'est le workflow actuellement ouvert ici ET
      // qu'aucune sauvegarde locale n'est en attente (sinon on écraserait
      // les propres modifications non encore débouncées de l'utilisateur —
      // situation normalement impossible grâce au verrou d'édition, mais on
      // se protège quand même). Ne touche jamais à la base ni à `persist()`.
      if (workflowId && activeRef.current?.id === workflowId && !saveTimer.current) {
        const nodes = (payload as any).nodes as WorkflowNode[] | undefined;
        const edges = (payload as any).edges as WorkflowEdge[] | undefined;
        if (nodes && edges) {
          setActive(prev => (prev ? { ...prev, nodes, edges } : prev));
        }
      }
      return;
    }

    if (event === 'workflow:viewing' || event === 'workflow:editing') {
      // Présence d'un AUTRE utilisateur (les événements dont on est
      // soi-même l'auteur sont déjà filtrés en amont par useProjectRealtime)
      // — alimente le point vert + l'activité affichés sur son avatar.
      const actorId = (payload as any).actorId as string | undefined;
      const actorName = (payload as any).actorName as string | undefined;
      const isActive = !!(payload as any).active;
      if (workflowId && actorId && actorName) {
        setPresence(prev => {
          const forWf = { ...(prev[workflowId] || {}) };
          if (isActive) {
            forWf[actorId] = { actorName, activity: event === 'workflow:editing' ? 'editing' : 'viewing' };
          } else if (event === 'workflow:editing' && forWf[actorId]) {
            // Fin d'édition : l'utilisateur reste probablement sur la page
            // (verrou libéré mais canvas encore ouvert) — on le repasse en
            // simple "consultation" plutôt que de le faire disparaître.
            forWf[actorId] = { ...forWf[actorId], activity: 'viewing' };
          } else {
            delete forWf[actorId];
          }
          return { ...prev, [workflowId]: forWf };
        });

        // Bascule immédiatement en lecture seule dès qu'un AUTRE utilisateur
        // édite ce workflow — sans attendre que je tente moi-même une
        // sauvegarde qui échouerait (voir editLockError / persist() plus
        // bas, qui gère le cas symétrique où c'est MA sauvegarde qui est
        // refusée). `editLockOwner` retient qui détient le verrou affiché
        // pour ne le lever que quand ce même acteur relâche la main.
        if (event === 'workflow:editing' && workflowId === activeRef.current?.id) {
          if (isActive) {
            editLockOwner.current = actorName;
            setEditLockError(`${actorName} modifie déjà ce workflow.`);
          } else if (editLockOwner.current === actorName) {
            editLockOwner.current = null;
            setEditLockError(null);
          }
        }
      }
      return;
    }

    if (event === 'workflow:created' && workflowId) {
      // Nouveau workflow créé par quelqu'un d'autre — on récupère UNIQUEMENT
      // ce workflow (pas toute la liste, qui re-téléchargerait nodes/edges/
      // variables de TOUS les workflows du projet) et on l'ajoute en tête de
      // la galerie.
      (async () => {
        try {
          const created = await getWorkflow(projectId as string, workflowId);
          setWorkflows(prev => (prev.some(w => w.id === created.id) ? prev : [created, ...prev]));
        } catch { /* brouillon privé d'un autre BA, ou déjà supprimé depuis — silencieux */ }
      })();
    }

    if (event === 'workflow:updated' && workflowId && workflowId !== activeRef.current?.id) {
      // Un workflow AUTRE que celui actuellement ouvert vient d'être modifié
      // ou validé — on ne rafraîchit QUE sa carte (le cas où c'est le
      // workflow ouvert est déjà géré séparément juste plus bas, pas la
      // peine de le refetch deux fois).
      (async () => {
        try {
          const updated = await getWorkflow(projectId as string, workflowId);
          setWorkflows(prev => prev.map(w => (w.id === updated.id ? updated : w)));
        } catch { /* best-effort */ }
      })();
    }

    if (event === 'workflow:deleted' && workflowId) {
      // Suppression : pas besoin de refetch, on retire simplement la carte.
      setWorkflows(prev => prev.filter(w => w.id !== workflowId));
    }

    if (event === 'workflow:deleted' && workflowId && activeRef.current?.id === workflowId) {
      // Le workflow actuellement ouvert vient d'être supprimé par quelqu'un
      // d'autre — on revient à la galerie plutôt que de laisser un canvas
      // orphelin.
      setActiveId(null);
      setActive(null);
      setError("Ce workflow a été supprimé par un autre utilisateur.");
      return;
    }

    if (event === 'workflow:updated' && workflowId && activeRef.current?.id === workflowId && !activeRunRef.current) {
      // Le workflow actuellement consulté a été modifié/validé ailleurs
      // (autre onglet du même BA, ou mise à jour reçue par un QA/ADMIN qui
      // le consulte) — on recharge son contenu pour rester synchronisé.
      (async () => {
        try {
          const data = await getWorkflow(projectId as string, workflowId);
          setActive(data);
          setNameDraft(data.name);
          setWorkflows(prev => prev.map(w => (w.id === data.id ? data : w)));
        } catch { /* best-effort */ }
      })();
    }

    if (event === 'workflow:run-updated' && workflowId) {
      const runId = (payload as any).runId as string | undefined;
      const deleted = !!(payload as any).deleted;
      const status = (payload as any).status as string | undefined;

      // Badge "dernière exécution" de la galerie (et de la barre d'outils si
      // ce workflow est ouvert) — sans ce refresh, seul un rechargement
      // manuel de la page faisait apparaître le résultat d'un run terminé/
      // abandonné ailleurs.
      if (!deleted && status) {
        setWorkflows(prev => prev.map(w => (w.id === workflowId ? { ...w, last_run_status: status as any, last_run_at: new Date().toISOString() } : w)));
        if (activeRef.current?.id === workflowId) {
          setActive(prev => (prev ? { ...prev, last_run_status: status as any, last_run_at: new Date().toISOString() } : prev));
        }
      }

      // Historique ouvert sur ce workflow — le tenir à jour en direct plutôt
      // que de le laisser périmé jusqu'à la prochaine ouverture de la modale.
      if (showRunHistoryRef.current && activeRef.current?.id === workflowId && runId) {
        if (deleted) {
          setRuns(prev => prev.filter(r => r.id !== runId));
        } else {
          (async () => {
            try {
              const run = await getWorkflowRun(projectId as string, workflowId, runId);
              setRuns(prev => (prev.some(r => r.id === runId) ? prev.map(r => (r.id === runId ? run : r)) : [run, ...prev]));
            } catch { /* best-effort */ }
          })();
        }
      }

      // Run actuellement affiché en plein écran (exécution en cours suivie
      // en direct, ou juste consultée) — abandonné/supprimé par quelqu'un
      // d'autre, ou une étape vient d'être cochée ailleurs.
      if (activeRunRef.current && runId && activeRunRef.current.id === runId) {
        if (deleted) {
          setActiveRun(null);
          setError("Cette exécution a été supprimée par un autre utilisateur.");
        } else {
          (async () => {
            try {
              const run = await getWorkflowRun(projectId as string, workflowId, runId);
              setActiveRun(run);
            } catch { /* best-effort */ }
          })();
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, loadList]);

  // Se déclenche à chaque nouvel événement workflow relayé par la page
  // parente (voir workflowRealtimeEvent côté analyzer/page.tsx) — la
  // dépendance sur `at` (timestamp) garantit que deux événements successifs
  // avec le même workflowId redéclenchent bien l'effet.
  useEffect(() => {
    if (!workflowRealtimeEvent) return;
    handleWorkflowRealtimeEvent(workflowRealtimeEvent.event, workflowRealtimeEvent.payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowRealtimeEvent?.at]);

  // ── Autosave débouncé du graphe ───────────────────────────────────────────
  const persist = useCallback((patch: Partial<{ name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; variables: WorkflowVariable[] }>) => {
    if (!active || !canAuthor || !canEditActive) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const updated = await updateWorkflow(active.project_id, active.id, patch);
        setActive(updated);
        setWorkflows(prev => prev.map(w => (w.id === updated.id ? updated : w)));
      } catch (err: any) {
        // Le verrou a pu être pris par un autre BA entre l'ouverture du
        // canvas et cette sauvegarde (ex: son propre verrou a expiré pile
        // entre deux renouvellements côté editing-presence) — dans ce cas
        // précis, on bascule en lecture seule (editLockError) plutôt que
        // d'afficher une simple erreur générique, pour que canEditActive se
        // désactive immédiatement et évite d'autres tentatives de sauvegarde.
        if (err?.locked) {
          editLockOwner.current = err.actorName || null;
          setEditLockError(err.message);
        } else {
          setError(err.message || 'Erreur lors de la sauvegarde');
        }
      } finally {
        setSaving(false);
        saveTimer.current = null;
      }
    }, 600);
  }, [active, projectId, canAuthor, canEditActive]);

  // Throttle de la diffusion "live" du canvas — indépendant de l'autosave
  // débouncée (600ms) : un `setTimeout` par changement retarderait le
  // premier retour visuel des autres, alors qu'ici on veut au contraire
  // émettre au plus vite, juste pas à CHAQUE frame de drag (un nœud qui
  // bouge peut déclencher des dizaines d'appels/seconde).
  const lastCanvasBroadcast = useRef(0);
  const CANVAS_LIVE_THROTTLE_MS = 250;

  const handleGraphChange = (nodes: WorkflowNode[], edges: WorkflowEdge[]) => {
    if (!active || !canAuthor || !canEditActive) return;
    setActive({ ...active, nodes, edges });
    persist({ nodes, edges });
    const now = Date.now();
    if (now - lastCanvasBroadcast.current >= CANVAS_LIVE_THROTTLE_MS) {
      lastCanvasBroadcast.current = now;
      broadcastWorkflowCanvasLive(active.project_id, active.id, nodes, edges);
    }
  };

  // Appelé pendant un glissement de nœud EN COURS (avant relâchement de la
  // souris — voir TestWorkflowCanvas.onLiveDrag, déjà throttlé côté canvas).
  // Purement une diffusion réseau : pas de setActive ni de persist() ici,
  // handleGraphChange s'en charge au relâchement (commit).
  const handleLiveDrag = (nodes: WorkflowNode[], edges: WorkflowEdge[]) => {
    if (!active || !canAuthor || !canEditActive) {
      return;
    }
    broadcastWorkflowCanvasLive(active.project_id, active.id, nodes, edges);
  };

  const handleVariablesChange = (variables: WorkflowVariable[]) => {
    if (!active || !canAuthor || !canEditActive) return;
    setActive({ ...active, variables });
    persist({ variables });
  };

  const handleRename = () => {
    if (!active || !canAuthor || !canEditActive || !nameDraft.trim() || nameDraft === active.name) return;
    setActive({ ...active, name: nameDraft.trim() });
    persist({ name: nameDraft.trim() });
  };

  // ── Création / suppression ────────────────────────────────────────────────
  const handleCreate = async (name: string) => {
    if (!projectId || !canAuthor) return;
    try {
      const created = await createWorkflow(projectId, { name });
      setWorkflows(prev => [created, ...prev]);
      setActiveId(created.id);
      setShowNewModal(false);
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la création du workflow');
    }
  };

  const handleDelete = () => {
    if (!active || !canAuthor || !canEditActive) return;
    setPendingDelete(active);
  };

  // ── Accès (BA/QA autorisés) ─────────────────────────────────────────────
  const openAccessModal = async () => {
    if (!active || !projectId) return;
    if (projectMembers.length === 0) {
      const members = await getProjectMembers(projectId);
      setProjectMembers(members);
    }
    // Relit le workflow avant d'ouvrir la modale : garantit que les cases
    // cochées reflètent bien le dernier accès enregistré, même si l'état
    // local `active` a pu dériver (édition en parallèle, événement
    // temps réel manqué, etc.).
    try {
      const fresh = await getWorkflow(active.project_id, active.id);
      setActive(fresh);
      setWorkflows(prev => prev.map(w => (w.id === fresh.id ? fresh : w)));
    } catch { /* best-effort — on ouvre quand même avec l'état local */ }
    setShowAccessModal(true);
  };

  const handleSaveAccess = async (baUserIds: string[], qaUserIds: string[]) => {
    if (!active) return;
    setSavingAccess(true); setError(null);
    try {
      await setWorkflowAccess(active.project_id, active.id, baUserIds);
      const updated = await setWorkflowQaAccess(active.project_id, active.id, qaUserIds);
      setActive(updated);
      setWorkflows(prev => prev.map(w => (w.id === updated.id ? updated : w)));
      setShowAccessModal(false);
    } catch (err: any) {
      setError(err.message || "Erreur lors de la mise à jour des accès du workflow");
    } finally {
      setSavingAccess(false);
    }
  };

  // ── Validation (publication) ───────────────────────────────────────────
  const [validating, setValidating] = useState(false);

  const handleValidate = async () => {
    if (!active || !canAuthor || !canEditActive) return;
    setValidating(true); setError(null);
    try {
      const updated = await validateWorkflow(active.project_id, active.id);
      setActive(updated);
      setWorkflows(prev => prev.map(w => (w.id === updated.id ? updated : w)));
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la validation du workflow');
    } finally {
      setValidating(false);
    }
  };

  const handleUnvalidate = async () => {
    if (!active || !canAuthor || !canEditActive) return;
    setValidating(true); setError(null);
    try {
      const updated = await unvalidateWorkflow(active.project_id, active.id);
      setActive(updated);
      setWorkflows(prev => prev.map(w => (w.id === updated.id ? updated : w)));
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la remise en brouillon du workflow');
    } finally {
      setValidating(false);
    }
  };

  // La confirmation ouvre la modale standard du projet (ConfirmDeleteModal) au
  // lieu du confirm() natif du navigateur ; la suppression réelle n'a lieu
  // qu'après validation dans cette modale (voir executeDeleteWorkflow).
  const [pendingDelete, setPendingDelete] = useState<TestWorkflow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const executeDeleteWorkflow = async () => {
    const w = pendingDelete;
    if (!w || !canAuthor || !canEditWorkflow(w)) return;
    setDeleting(true);
    try {
      await deleteWorkflow(w.project_id, w.id);
      setWorkflows(prev => prev.filter(x => x.id !== w.id));
      if (activeId === w.id) { setActiveId(null); setActive(null); }
      setPendingDelete(null);
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la suppression du workflow');
    } finally {
      setDeleting(false);
    }
  };

  // ── Génération de données de test par LLM ─────────────────────────────────
  const [genValues, setGenValues] = useState<Record<string, string> | null>(null);
  const [genNotes, setGenNotes] = useState('');

  const handleGenerateData = async () => {
    if (!active || !canAuthor || !canEditActive) return;
    if ((active.variables || []).length === 0) {
      setError("Déclarez au moins une variable de donnée de test avant de générer des valeurs (panneau à droite du canvas).");
      return;
    }
    setGenLoading(true); setError(null);
    try {
      const result = await generateWorkflowTestData(active.project_id, active.id, genNotes || undefined);
      setActive(result.workflow);
      setWorkflows(prev => prev.map(w => (w.id === result.workflow.id ? result.workflow : w)));
      setGenValues(result.values);
    } catch (err: any) {
      setError(err.message || 'Erreur lors de la génération des données de test');
    } finally {
      setGenLoading(false);
    }
  };

  const handleSaveGeneratedValues = async (values: Record<string, string>) => {
    if (!active || !canAuthor || !canEditActive) return;
    const updatedVariables = (active.variables || []).map(v => ({ ...v, exampleValue: values[v.name] ?? v.exampleValue }));
    try {
      const updated = await updateWorkflow(active.project_id, active.id, { variables: updatedVariables });
      setActive(updated);
      setWorkflows(prev => prev.map(w => (w.id === updated.id ? updated : w)));
      setShowGenData(false);
      setGenValues(null);
    } catch (err: any) {
      setError(err.message || "Erreur lors de l'enregistrement des données");
    }
  };

  // ── Extraction automatique des variables depuis les cas de test liés ─────
  const handleExtractFromTestCases = async () => {
    if (!active || !canAuthor || !canEditActive) return;
    const newVariables: WorkflowVariable[] = [...(active.variables || [])];
    const existingNames = new Set(newVariables.map(v => v.name));
    let changed = false;

    const updatedNodes: WorkflowNode[] = (active.nodes || []).map(node => {
      if (node.data.nodeType !== 'test_case') return node;

      // Le testCaseSnapshot enregistré peut être ancien (étape ajoutée avant
      // que testData y soit inclus) — on retombe sur le catalogue actuel des
      // cas de test via testCaseId, et on referait le snapshot au passage.
      const liveTc = testCaseOptions.find(tc => tc.id === node.data.testCaseId);
      const testData = node.data.testCaseSnapshot?.testData?.length ? node.data.testCaseSnapshot.testData : liveTc?.testData;
      if (!testData?.length) return node;

      const { input, output } = parseTestDataEntries(testData);
      const mergedInput = Array.from(new Set([...(node.data.inputVariables || []), ...input.map(e => e.key)]));
      const mergedOutput = Array.from(new Set([...(node.data.outputVariables || []), ...output.map(e => e.key)]));
      if (mergedInput.length !== (node.data.inputVariables || []).length || mergedOutput.length !== (node.data.outputVariables || []).length) changed = true;

      [...input, ...output].forEach(e => {
        if (!existingNames.has(e.key)) {
          existingNames.add(e.key);
          newVariables.push({ id: `var_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, name: e.key, exampleValue: e.value });
          changed = true;
        }
      });

      const refreshedSnapshot = node.data.testCaseSnapshot?.testData?.length
        ? node.data.testCaseSnapshot
        : { ...(node.data.testCaseSnapshot || { testId: liveTc?.testId || '', title: node.data.label, type: liveTc?.type || '', priority: liveTc?.priority || '' }), testData };

      return { ...node, data: { ...node.data, testCaseSnapshot: refreshedSnapshot, inputVariables: mergedInput, outputVariables: mergedOutput } };
    });

    if (!changed) {
      setError("Rien à extraire — soit ce workflow n'a aucune étape « Cas de test », soit le(s) cas de test lié(s) n'ont pas de champ testData renseigné (cas de test très ancien ou modifié manuellement).");
      return;
    }

    try {
      const updated = await updateWorkflow(active.project_id, active.id, { nodes: updatedNodes, variables: newVariables });
      setActive(updated);
      setWorkflows(prev => prev.map(w => (w.id === updated.id ? updated : w)));
    } catch (err: any) {
      setError(err.message || "Erreur lors de l'extraction des variables");
    }
  };

  // ── Exécution ────────────────────────────────────────────────────────────
  const handleStartRun = async () => {
    if (!active || !canExecute || !active.is_validated) return;
    try {
      const run = await startWorkflowRun(active.project_id, active.id);
      setActiveRun(run);
      setActive(prev => (prev ? { ...prev, last_run_status: run.status, last_run_at: null } : prev));
      setWorkflows(prev => prev.map(w => (w.id === active.id ? { ...w, last_run_status: run.status, last_run_at: null } : w)));
    } catch (err: any) {
      setError(err.message || "Erreur lors du démarrage de l'exécution");
    }
  };

  const handleStepResultChange = async (nodeId: string, result: { status: WorkflowStepStatus; note?: string; variableValues?: Record<string, string> }) => {
    if (!active || !activeRun || !canExecute) return;
    try {
      const updated = await updateWorkflowStepResult(active.project_id, active.id, activeRun.id, nodeId, result);
      setActiveRun(updated);
    } catch (err: any) {
      setError(err.message || "Erreur lors de l'enregistrement du résultat");
    }
  };

  const handleFinishRun = async () => {
    if (!active || !activeRun || !canExecute) return;
    try {
      const updated = await finishWorkflowRun(active.project_id, active.id, activeRun.id);
      setActiveRun(updated);
      setActive(prev => (prev ? { ...prev, last_run_status: updated.status, last_run_at: updated.finished_at } : prev));
      // Synchronise aussi la carte dans la liste (sinon elle reste sur l'ancien
      // statut — ❌ Échoué p. ex. — tant qu'on ne recharge pas la page).
      setWorkflows(prev => prev.map(w => (w.id === active.id ? { ...w, last_run_status: updated.status, last_run_at: updated.finished_at } : w)));
    } catch (err: any) {
      setError(err.message || "Erreur lors de la clôture de l'exécution");
    }
  };

  const handleAbortRun = async () => {
    if (!active || !activeRun || !canExecute) return;
    if (!confirm('Abandonner cette exécution en cours ?')) return;
    try {
      const aborted = await abortWorkflowRun(active.project_id, active.id, activeRun.id);
      setActiveRun(null);
      setActive(prev => (prev ? { ...prev, last_run_status: aborted.status, last_run_at: aborted.finished_at } : prev));
      setWorkflows(prev => prev.map(w => (w.id === active.id ? { ...w, last_run_status: aborted.status, last_run_at: aborted.finished_at } : w)));
    } catch (err: any) {
      setError(err.message || "Erreur lors de l'abandon de l'exécution");
    }
  };

  const openRunHistory = async () => {
    if (!active) return;
    setShowRunHistory(true);
    try {
      const data = await listWorkflowRuns(active.project_id, active.id);
      setRuns(data);
    } catch (err: any) {
      setError(err.message || "Erreur lors du chargement de l'historique");
    }
  };

  const openPastRun = async (runId: string) => {
    if (!active) return;
    try {
      const run = await getWorkflowRun(active.project_id, active.id, runId);
      setActiveRun(run);
      setShowRunHistory(false);
    } catch (err: any) {
      setError(err.message || "Erreur lors du chargement de l'exécution");
    }
  };

  if (!projectId) return null;

  return (
    <div className="space-y-4 w-full min-w-0">
      {campaignLocked ? (
        <div className="px-4 py-2.5 rounded-xl bg-amber-500/8 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-xs font-bold flex items-center gap-2">
          🔒 Campagne de tests en cours — création, édition et suppression désactivées. Seule l'exécution des workflows déjà validés est possible.
        </div>
      ) : !campaignLocked && userRole === 'QA' && (
        <div className="px-4 py-2.5 rounded-xl bg-slate-500/8 border border-stroke dark:border-strokedark text-waterloo dark:text-manatee text-xs font-bold flex items-center gap-2">
          ⏳ Aucune campagne de tests n'est active pour ce projet — l'exécution des workflows sera possible dès qu'un PO en lancera une.
        </div>
      )}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          {active ? (
            <button
              onClick={() => setActiveId(null)}
              disabled={!!activeRun}
              title="Revenir à la liste des workflows"
              className="mb-2 px-4 py-2 rounded-full text-sm font-bold border-2 border-stroke dark:border-strokedark text-black dark:text-white hover:bg-zumthor dark:hover:bg-blacksection hover:border-black dark:hover:border-white transition-all disabled:opacity-40 disabled:pointer-events-none flex items-center gap-2 w-fit"
            >
              ← Tous les workflows
            </button>
          ) : (
            <h2 className="text-2xl font-bold text-black dark:text-white">🔀 Workflows de test</h2>
          )}
          <p className="text-waterloo text-sm mt-1.5">Enchaînez des cas de test et des actions, faites circuler des données entre les étapes, puis exécutez le scénario.</p>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2.5 rounded-xl bg-red-600/5 border border-red-600/30 text-red-600 text-xs font-bold flex items-center justify-between">
          {error}
          <button onClick={() => setError(null)} className="opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* ── Sélecteur / création de workflow (galerie de cartes) ── */}
      {!active && (
        <div className="space-y-3">
          {loading && <p className="text-[10px] text-waterloo flex items-center gap-1.5"><Spinner /> Chargement des workflows...</p>}
          {!loading && canAuthor && workflows.length > 0 && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setGalleryFilter('all')}
                className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${galleryFilter === 'all' ? 'bg-black dark:bg-btndark text-white' : 'text-waterloo hover:text-black dark:hover:text-white border border-stroke dark:border-strokedark'}`}
              >
                Tous ({workflows.length})
              </button>
              <button
                onClick={() => setGalleryFilter('mine')}
                className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all ${galleryFilter === 'mine' ? 'bg-black dark:bg-btndark text-white' : 'text-waterloo hover:text-black dark:hover:text-white border border-stroke dark:border-strokedark'}`}
              >
                Les miens ({workflows.filter(w => w.created_by?.id === currentUserId).length})
              </button>
            </div>
          )}
          {(() => {
            const visibleWorkflows = galleryFilter === 'mine' ? workflows.filter(w => w.created_by?.id === currentUserId) : workflows;
            return (<>
          {!loading && visibleWorkflows.length === 0 && (
            <div className="flex flex-col items-center justify-center min-h-[26vh] gap-2 text-center border border-dashed border-stroke dark:border-strokedark rounded-2xl">
              <div className="text-5xl opacity-20">🔀</div>
              <p className="text-waterloo text-sm">
                {galleryFilter === 'mine'
                  ? "Vous n'avez créé aucun workflow pour l'instant."
                  : canAuthor
                    ? 'Créez votre premier workflow de test pour ce projet.'
                    : campaignLocked && (userRole === 'BA' || userRole === 'PO')
                      ? 'Aucun workflow de test — la campagne en cours empêche toute création tant qu\'elle est active.'
                      : "Aucun workflow de test pour l'instant — seul un BA peut en créer un."}
              </p>
            </div>
          )}
          {visibleWorkflows.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleWorkflows.map(w => {
                const alertCount = countStepAlerts(w.nodes || [], testCaseOptions);
                const isMine = w.created_by?.id === currentUserId;
                const collaborators = [...(w.assignedUsers ?? []), ...(w.assignedQas ?? [])];
                const wfPresence = presence[w.id];
                const ownerOnline = (isMine && w.id === activeId) || !!(w.created_by?.id && wfPresence?.[w.created_by.id]);
                const ownerActivity = wfPresence?.[w.created_by?.id || ''] ? (wfPresence[w.created_by!.id].activity === 'editing' ? 'en train de modifier' : 'en train de consulter') : (isMine && w.id === activeId ? 'en train de consulter' : undefined);
                return (
                <button
                  key={w.id}
                  onClick={() => setActiveId(w.id)}
                  className={`relative text-left p-4 rounded-2xl border hover:shadow-solid-3 bg-white dark:bg-black transition-all ${isMine ? 'border-primary/40 hover:border-primary/70' : 'border-stroke dark:border-strokedark hover:border-primary/50'}`}
                >
                  {canAuthor && canEditWorkflow(w) && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); setPendingDelete(w); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setPendingDelete(w); } }}
                      title="Supprimer ce workflow"
                      className="absolute top-2.5 right-2.5 w-6 h-6 rounded-full flex items-center justify-center text-waterloo hover:text-red-600 hover:bg-red-600/10 transition-all"
                    >
                      🗑️
                    </span>
                  )}
                  <div className="pr-6 space-y-1.5">
                    <p className="text-sm font-bold text-black dark:text-white break-words">{w.name}</p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        title={isMine ? 'Créé par vous' : `Créé par ${w.created_by?.name || w.created_by?.email || 'un BA'}`}
                        className={`inline-flex items-center gap-1.5 text-[9px] font-bold px-2 py-0.5 rounded-full ${isMine ? 'text-primary bg-primary/10' : 'text-waterloo bg-black/5 dark:bg-white/10'}`}
                      >
                        <WorkflowAvatar id={w.created_by?.id || 'unknown'} name={w.created_by?.name || w.created_by?.email || 'BA'} isSelf={isMine} size={14} online={ownerOnline} activityLabel={ownerActivity} />
                        {isMine ? 'Vous' : (w.created_by?.name || w.created_by?.email || 'BA')}
                      </span>
                      {!w.is_validated ? (
                        <span
                          title={canEditWorkflow(w) ? "Brouillon — vous pouvez le modifier et le valider" : "Brouillon — en cours de préparation par le créateur, vous pouvez le consulter mais pas encore le modifier"}
                          className="inline-flex text-[9px] font-bold px-2 py-0.5 rounded-full items-center gap-1 text-amber-700 dark:text-amber-400 bg-amber-500/10"
                        >
                          ✏️ Brouillon
                        </span>
                      ) : (
                        <span
                          title={w.validated_by ? `Validé par ${w.validated_by.name || w.validated_by.email}` : 'Validé'}
                          className="inline-flex text-[9px] font-bold px-2 py-0.5 rounded-full items-center gap-1 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
                        >
                          ✅ Validé
                        </span>
                      )}
                      {w.last_run_status && (
                        <span className="inline-flex text-[9px] font-bold px-2 py-0.5 rounded-full items-center gap-1" style={{ color: RUN_STATUS_META[w.last_run_status]?.color, background: `${RUN_STATUS_META[w.last_run_status]?.color}15` }}>
                          {RUN_STATUS_META[w.last_run_status]?.icon} {RUN_STATUS_META[w.last_run_status]?.label}
                        </span>
                      )}
                      {alertCount > 0 && (
                        <span
                          title="Une ou plusieurs étapes référencent un cas de test modifié, à réviser, ou supprimé depuis leur ajout à ce workflow"
                          className="inline-flex text-[9px] font-bold px-2 py-0.5 rounded-full items-center gap-1 text-red-700 dark:text-red-400 bg-red-600/8"
                        >
                          ⚠ {alertCount} étape{alertCount > 1 ? 's' : ''} à vérifier
                        </span>
                      )}
                    </div>
                    {collaborators.length > 0 && (
                      <div className="flex items-center gap-1.5" title={collaborators.map(u => u.name || u.email).join(', ')}>
                        <WorkflowAvatarStack users={collaborators} size={16} presence={wfPresence} />
                        <p className="text-[10px] text-waterloo truncate">Avec {collaborators.map(u => u.name || u.email).join(', ')}</p>
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-waterloo mt-2">
                    {w.nodes?.length || 0} étape{(w.nodes?.length || 0) > 1 ? 's' : ''} · maj le {formatDate(w.updated_at)}
                  </p>
                </button>
                );
              })}
              {canAuthor && (
                <button
                  onClick={() => setShowNewModal(true)}
                  className="flex flex-col items-center justify-center gap-1.5 p-4 rounded-2xl border border-dashed border-stroke dark:border-strokedark hover:border-primary/50 text-waterloo hover:text-primary transition-all min-h-[88px]"
                >
                  <span className="text-lg">➕</span>
                  <span className="text-xs font-bold">Nouveau workflow</span>
                </button>
              )}
            </div>
          )}
            </>);
          })()}
        </div>
      )}

      {active && (
        <div className="pt-1 space-y-4">
          {editLockError && (
            <div className="px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 text-xs font-bold flex items-center gap-2">
              🔒 {editLockError} — vous consultez ce workflow en lecture seule jusqu'à ce qu'il libère la main.
            </div>
          )}
          {/* ── Barre d'outils ── */}
          <div className="flex items-center justify-between flex-wrap gap-4 pb-4 border-b border-stroke dark:border-strokedark">
            <div className="flex items-center gap-3 flex-wrap">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={handleRename}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                disabled={!!activeRun || !canAuthor || !canEditActive}
                style={{ width: `${Math.min(Math.max(nameDraft.length + 2, 12), 60)}ch` }}
                className="px-2.5 py-1.5 rounded-lg text-sm font-bold border border-transparent hover:border-stroke dark:hover:border-strokedark bg-transparent outline-none focus:border-primary/50 text-black dark:text-white max-w-full"
              />
              {saving && <span className="text-[10px] text-waterloo flex items-center gap-1"><Spinner /> Enregistrement...</span>}
              {!activeRun && (
                !active.is_validated ? (
                  <span
                    title={canEditActive ? "Brouillon — vous pouvez le modifier et le valider" : "Brouillon — en cours de préparation par le créateur, vous pouvez le consulter mais pas encore le modifier"}
                    className="text-[10px] font-bold px-2.5 py-1.5 rounded-full flex items-center gap-1.5 text-amber-700 dark:text-amber-400 bg-amber-500/10"
                  >
                    ✏️ Brouillon
                  </span>
                ) : (
                  <span
                    title={active.validated_by ? `Validé par ${active.validated_by.name || active.validated_by.email}${active.validated_at ? ' · ' + formatDate(active.validated_at) : ''}` : 'Validé'}
                    className="text-[10px] font-bold px-2.5 py-1.5 rounded-full flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
                  >
                    ✅ Validé
                  </span>
                )
              )}
              {active.last_run_status && !activeRun && (
                <span className="text-[10px] font-bold px-2.5 py-1.5 rounded-full flex items-center gap-1.5" style={{ color: RUN_STATUS_META[active.last_run_status]?.color, background: `${RUN_STATUS_META[active.last_run_status]?.color}15` }}>
                  {RUN_STATUS_META[active.last_run_status]?.icon} Dernière exécution : {RUN_STATUS_META[active.last_run_status]?.label} · {formatDate(active.last_run_at)}
                </span>
              )}
              {activeRun && (
                <span className="text-[10px] font-bold px-2.5 py-1.5 rounded-full flex items-center gap-1.5" style={{ color: RUN_STATUS_META[activeRun.status]?.color, background: `${RUN_STATUS_META[activeRun.status]?.color}15` }}>
                  {RUN_STATUS_META[activeRun.status]?.icon} Exécution {activeRun.status === 'running' ? 'en cours' : RUN_STATUS_META[activeRun.status]?.label}
                </span>
              )}
              {(() => {
                const alertCount = countStepAlerts(active.nodes || [], testCaseOptions);
                if (alertCount === 0) return null;
                return (
                  <span
                    title="Le survol de chaque étape concernée (icône ⚠️/✏️/🗑️ sur sa carte) détaille la raison précise"
                    className="text-[10px] font-bold px-2.5 py-1.5 rounded-full flex items-center gap-1.5 text-red-700 dark:text-red-400 bg-red-600/8 border border-red-600/25"
                  >
                    ⚠ {alertCount} étape{alertCount > 1 ? 's' : ''} potentiellement affectée{alertCount > 1 ? 's' : ''} par une exigence ou un cas de test modifié
                  </span>
                );
              })()}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              {(() => {
                const activeIsMine = active.created_by?.id === currentUserId;
                const activeCollaborators = [...(active.assignedUsers ?? []), ...(active.assignedQas ?? [])];
                const ownerName = active.created_by?.name || active.created_by?.email || 'BA';
                const activePresence = presence[active.id];
                const ownerOnline = activeIsMine || !!(active.created_by?.id && activePresence?.[active.created_by.id]);
                const ownerActivity = active.created_by?.id && activePresence?.[active.created_by.id]
                  ? (activePresence[active.created_by.id].activity === 'editing' ? 'en train de modifier' : 'en train de consulter')
                  : (activeIsMine ? 'en train de consulter' : undefined);
                const tooltip = (activeIsMine ? 'Créé par vous' : `Créé par ${ownerName}`)
                  + (activeCollaborators.length > 0 ? ` · Avec ${activeCollaborators.map(u => u.name || u.email).join(', ')}` : '');
                return (
                  <div className="flex items-center" title={tooltip}>
                    <WorkflowAvatar id={active.created_by?.id || 'unknown'} name={ownerName} isSelf={activeIsMine} size={22} online={ownerOnline} activityLabel={ownerActivity} />
                    <WorkflowAvatarStack users={activeCollaborators} size={22} presence={activePresence} />
                  </div>
                );
              })()}
              {canAuthor && isWorkflowOwner && (
                <button
                  onClick={openAccessModal}
                  title="Choisir les BA autorisés à modifier/valider et les QA autorisés à exécuter ce workflow"
                  className="px-3 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white transition-all flex items-center gap-1.5"
                >
                  🔐 Accès{((active.assignedUsers?.length ?? 0) + (active.assignedQas?.length ?? 0)) > 0 ? ` (${(active.assignedUsers?.length ?? 0) + (active.assignedQas?.length ?? 0)})` : ''}
                </button>
              )}
              {!activeRun ? (
                <>
                  {canAuthor && canEditActive && (
                    active.is_validated ? (
                      <button
                        onClick={handleUnvalidate}
                        disabled={validating}
                        title="Repasser ce workflow en brouillon"
                        className="px-4 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white transition-all flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {validating ? <Spinner /> : '↩️'} Repasser en brouillon
                      </button>
                    ) : (
                      <button
                        onClick={handleValidate}
                        disabled={validating}
                        title="Valider ce workflow (les QA pourront alors l'exécuter)"
                        className="px-4 py-2 rounded-full text-xs font-bold bg-primary text-white hover:bg-primaryho transition-all flex items-center gap-1.5 disabled:opacity-50"
                      >
                        {validating ? <Spinner /> : '✅'} Valider le workflow
                      </button>
                    )
                  )}
                  {userRole === 'QA' && (
                    <button
                      onClick={handleStartRun}
                      disabled={!campaignLocked || !active.is_validated || !qaCanExecuteActive}
                      title={
                        !campaignLocked
                          ? "Aucune campagne de tests n'est active — demandez à un BA ou un Admin de la lancer avant de pouvoir exécuter"
                          : !active.is_validated
                          ? "Ce workflow est encore un brouillon — il doit être validé par un BA avant de pouvoir être exécuté"
                          : !qaCanExecuteActive
                            ? "Aucun QA n'est encore autorisé à exécuter ce workflow — demandez au créateur de vous ajouter dans 🔐 Accès"
                            : undefined
                      }
                      className="px-4 py-2 rounded-full text-xs font-bold bg-black dark:bg-btndark text-white hover:bg-blackho transition-all flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      ▶️ Lancer une exécution
                    </button>
                  )}
                  <button
                    onClick={openRunHistory}
                    title="Historique des exécutions passées de ce workflow par les QA (résultats, étapes, quand, par qui)"
                    className="px-3 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white hover:border-primary/40 transition-all"
                  >
                    🕓 Historique des exécutions
                  </button>
                  <button
                    onClick={() => setShowVersionHistory(true)}
                    title="Anciens états enregistrés du canevas de ce workflow (étapes, connexions) — pour consulter ou restaurer un état antérieur"
                    className="px-3 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white hover:border-primary/40 transition-all"
                  >
                    📜 Versions du canevas
                  </button>
                  {canAuthor && canEditActive && (
                    <button onClick={handleDelete} className="px-3 py-2 rounded-full text-xs font-bold border border-red-600/30 text-red-600 hover:bg-red-600/5 transition-all">
                      🗑️
                    </button>
                  )}
                </>
              ) : activeRun.status === 'running' && canExecute ? (
                <>
                  <button onClick={handleFinishRun} className="px-4 py-2 rounded-full text-xs font-bold bg-primary text-white hover:bg-primaryho transition-all">
                    ✅ Terminer l’exécution
                  </button>
                  <button onClick={handleAbortRun} className="px-3 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white transition-all">
                    Abandonner
                  </button>
                </>
              ) : (
                <button onClick={() => setActiveRun(null)} className="px-4 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white transition-all">
                  ← Revenir à l’édition
                </button>
              )}
            </div>
          </div>

          <TestWorkflowCanvas
            resetKey={active.id + (activeRun?.id || 'edit')}
            projectId={projectId}
            initialNodes={activeRun ? (activeRun.nodes_snapshot || []) : (active.nodes || [])}
            initialEdges={activeRun ? (activeRun.edges_snapshot || []) : (active.edges || [])}
            variables={active.variables || []}
            onVariablesChange={handleVariablesChange}
            onGraphChange={handleGraphChange}
            onLiveDrag={canAuthor && canEditActive ? handleLiveDrag : undefined}
            testCaseOptions={testCaseOptions}
            readOnly={!!activeRun || !canAuthor || !canEditActive}
            activeRun={activeRun}
            onStepResultChange={activeRun?.status === 'running' && canExecute ? handleStepResultChange : undefined}
            onExtractFromTestCases={canAuthor && canEditActive ? handleExtractFromTestCases : undefined}
            onGenerateData={canAuthor && canEditActive ? () => { setShowGenData(true); setGenValues(null); handleGenerateData(); } : undefined}
            genLoading={genLoading}
          />
        </div>
      )}

      {showNewModal && <NewWorkflowModal onCreate={handleCreate} onClose={() => setShowNewModal(false)} />}
      {showAccessModal && active && (
        <WorkflowAccessModal
          key={active.id}
          workflowName={active.name}
          members={projectMembers}
          creatorId={active.created_by?.id}
          initialBaIds={(active.assignedUsers ?? []).map(u => u.id)}
          initialQaIds={(active.assignedQas ?? []).map(u => u.id)}
          saving={savingAccess}
          onSave={handleSaveAccess}
          onClose={() => setShowAccessModal(false)}
        />
      )}
      <ConfirmDeleteModal
        open={!!pendingDelete}
        title="Supprimer ce workflow ?"
        message={pendingDelete ? `« ${pendingDelete.name} » sera définitivement supprimé, ainsi que son historique d'exécutions. Cette action est irréversible.` : undefined}
        confirmLabel="Supprimer"
        loading={deleting}
        onConfirm={executeDeleteWorkflow}
        onCancel={() => setPendingDelete(null)}
      />
      {showGenData && active && (
        <GenerateTestDataModal
          loading={genLoading}
          values={genValues}
          notes={genNotes}
          onNotesChange={setGenNotes}
          onRegenerate={handleGenerateData}
          onSave={handleSaveGeneratedValues}
          onClose={() => { setShowGenData(false); setGenValues(null); }}
        />
      )}
      {showRunHistory && active && (
        <RunHistoryModal
          runs={runs}
          onSelect={openPastRun}
          onClose={() => setShowRunHistory(false)}
        />
      )}
      {active && (
        <VersionHistoryPanel
          open={showVersionHistory}
          onClose={() => setShowVersionHistory(false)}
          entityType="test_workflow"
          entityId={active.id}
          entityLabel={`Workflow « ${active.name} »`}
          canRestore={canAuthor}
          fetchVersions={() => getWorkflowVersions(active.project_id, active.id)}
          doRestore={(_id, versionId) => restoreWorkflowVersion(active.project_id, active.id, versionId)}
          onRestored={updated => {
            setActive(updated);
            setWorkflows(prev => prev.map(w => (w.id === updated.id ? updated : w)));
          }}
        />
      )}
    </div>
  );
}

// ─── Modale de création ──────────────────────────────────────────────────────

function NewWorkflowModal({ onCreate, onClose }: { onCreate: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="bg-white dark:bg-black border border-stroke dark:border-strokedark rounded-2xl p-6 w-full max-w-sm space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-black dark:text-white">Nouveau workflow de test</h3>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) onCreate(name.trim()); }}
          placeholder="ex: Parcours de commande complet"
          className="w-full px-3 py-2 rounded-lg text-sm border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white transition-all">Annuler</button>
          <button
            disabled={!name.trim()}
            onClick={() => onCreate(name.trim())}
            className={`px-4 py-2 rounded-full text-xs font-bold transition-all ${name.trim() ? 'bg-primary text-white hover:bg-primaryho' : 'bg-stroke dark:bg-strokedark text-waterloo cursor-not-allowed'}`}
          >
            Créer
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modale de gestion des accès (BA autorisés sur ce workflow) ─────────────

function WorkflowAccessModal({ workflowName, members, creatorId, initialBaIds, initialQaIds, saving, onSave, onClose }: {
  workflowName: string;
  members: ProjectMember[];
  creatorId?: string;
  initialBaIds: string[];
  initialQaIds: string[];
  saving: boolean;
  onSave: (baUserIds: string[], qaUserIds: string[]) => void;
  onClose: () => void;
}) {
  const [selectedBa, setSelectedBa] = useState<Set<string>>(new Set(initialBaIds));
  const [selectedQa, setSelectedQa] = useState<Set<string>>(new Set(initialQaIds));
  // Seuls les BA/PO (autres que le créateur, qui a de toute façon toujours
  // accès) sont pertinents pour la liste de modification/validation.
  const baCandidates = members.filter(m => (m.role === 'BA' || m.role === 'PO') && m.id !== creatorId);
  const qaCandidates = members.filter(m => m.role === 'QA');

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="bg-white dark:bg-black border border-stroke dark:border-strokedark rounded-2xl p-6 w-full max-w-md space-y-5" onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="text-sm font-bold text-black dark:text-white">Accès au workflow</h3>
          <p className="text-xs text-waterloo mt-1">Gérez les accès à « {workflowName} ».</p>
        </div>

        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-waterloo">BA — voir, modifier, valider (brouillon)</p>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {baCandidates.length === 0 ? (
              <p className="text-xs text-waterloo italic py-1">Aucun autre BA sur ce projet.</p>
            ) : (
              baCandidates.map(m => (
                <label key={m.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-black/[.03] dark:hover:bg-white/[.04] cursor-pointer transition-all">
                  <input type="checkbox" checked={selectedBa.has(m.id)} onChange={() => toggle(selectedBa, setSelectedBa, m.id)} className="rounded border-stroke dark:border-strokedark" />
                  <span className="text-sm text-black dark:text-white flex-1 min-w-0 truncate">{m.name || m.email}</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wide text-waterloo">QA — exécuter (une fois validé)</p>
          <p className="text-[10px] text-waterloo -mt-1">Aucune case cochée = aucun QA ne peut encore l'exécuter.</p>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {qaCandidates.length === 0 ? (
              <p className="text-xs text-waterloo italic py-1">Aucun QA sur ce projet.</p>
            ) : (
              qaCandidates.map(m => (
                <label key={m.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-black/[.03] dark:hover:bg-white/[.04] cursor-pointer transition-all">
                  <input type="checkbox" checked={selectedQa.has(m.id)} onChange={() => toggle(selectedQa, setSelectedQa, m.id)} className="rounded border-stroke dark:border-strokedark" />
                  <span className="text-sm text-black dark:text-white flex-1 min-w-0 truncate">{m.name || m.email}</span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-4 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white transition-all">Annuler</button>
          <button
            disabled={saving}
            onClick={() => onSave(Array.from(selectedBa), Array.from(selectedQa))}
            className="px-4 py-2 rounded-full text-xs font-bold bg-primary text-white hover:bg-primaryho transition-all disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving && <Spinner />} Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modale de génération des données de test (LLM) ─────────────────────────

function GenerateTestDataModal({ loading, values, notes, onNotesChange, onRegenerate, onSave, onClose }: {
  loading: boolean;
  values: Record<string, string> | null;
  notes: string;
  onNotesChange: (v: string) => void;
  onRegenerate: () => void;
  onSave: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => { if (values) setDraft(values); }, [values]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="bg-white dark:bg-black border border-stroke dark:border-strokedark rounded-2xl p-6 w-full max-w-md space-y-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-black dark:text-white">🪄 Valeurs suggérées par l'IA</h3>
          <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-xs">✕</button>
        </div>

        <p className="text-[10px] text-waterloo leading-relaxed">
          Pour chaque variable déclarée sur ce workflow, le modèle propose une valeur d'exemple réaliste et cohérente (même identifiant réutilisé d'une étape à l'autre). Vérifiez et ajustez ces valeurs avant de lancer l'exécution — elles ne sont enregistrées qu'une fois validées ci-dessous.
        </p>

        {!values && !loading && (
          <div className="space-y-2">
            <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Contexte additionnel (facultatif)</label>
            <textarea
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              rows={2}
              placeholder="ex: client tunisien, dossier de rénovation domicile..."
              className="w-full px-2.5 py-1.5 rounded-lg text-[11px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50 resize-none"
            />
            <button onClick={onRegenerate} className="w-full px-4 py-2 rounded-full text-xs font-bold bg-primary text-white hover:bg-primaryho transition-all">
              🪄 Générer
            </button>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Spinner />
            <p className="text-[10px] text-waterloo">Génération en cours...</p>
          </div>
        )}

        {values && !loading && (
          <>
            <div className="space-y-2">
              {Object.keys(draft).map(name => (
                <div key={name}>
                  <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">{name}</label>
                  <input
                    value={draft[name] || ''}
                    onChange={(e) => setDraft(prev => ({ ...prev, [name]: e.target.value }))}
                    className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[11px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={onRegenerate} className="px-3 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white transition-all">
                🔄 Régénérer
              </button>
              <button onClick={() => onSave(draft)} className="flex-1 px-4 py-2 rounded-full text-xs font-bold bg-primary text-white hover:bg-primaryho transition-all">
                ✅ Utiliser ces valeurs
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Modale d'historique des exécutions ─────────────────────────────────────

function RunHistoryModal({ runs, onSelect, onClose }: { runs: WorkflowRun[]; onSelect: (runId: string) => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="bg-white dark:bg-black border border-stroke dark:border-strokedark rounded-2xl p-6 w-full max-w-md space-y-3 max-h-[70vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-black dark:text-white">🕓 Historique des exécutions</h3>
          <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-xs">✕</button>
        </div>
        {runs.length === 0 ? (
          <p className="text-xs text-waterloo text-center py-6">Aucune exécution pour l’instant</p>
        ) : (
          <ul className="space-y-1.5">
            {runs.map(run => {
              const meta = RUN_STATUS_META[run.status] || RUN_STATUS_META.running;
              const passedCount = run.step_results?.filter(r => r.status === 'passed').length || 0;
              return (
                <li key={run.id}>
                  <button onClick={() => onSelect(run.id)} className="w-full text-left px-3 py-2 rounded-lg border border-stroke dark:border-strokedark hover:border-primary/40 transition-all flex items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-bold text-black dark:text-white">{formatDate(run.started_at)}</p>
                      <p className="text-[9px] text-waterloo">{run.executed_by?.name || run.executed_by?.email || '—'} · {passedCount}/{run.step_results?.length || 0} étapes passées</p>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1" style={{ color: meta.color, background: `${meta.color}15` }}>
                      {meta.icon} {meta.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}