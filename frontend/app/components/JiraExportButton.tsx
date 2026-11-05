'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useJira } from '../context/JiraContext';
import { btn, btnSize } from './ui/buttonStyles';
import { IconLink, IconRefresh, IconExternalLink } from './ui/Icon';
import {
  exportTestCaseToJira,
  exportAllTestCasesToJira,
  listJiraIssueTypes,
  listJiraEpics,
  listJiraProjects,
  createJiraEpic,
  getRequirementJiraHierarchy,
  JiraExportAllResult,
  JiraIssueTypeOption,
  JiraProjectOption,
  JiraEpicOption,
  JiraRequirementHierarchy,
} from '@/lib/jira-api';

function Spinner() {
  return <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />;
}

// ═══════════════════════════════════════════════════════════════════════
// Flux d'export Jira — grand modal plein écran, dans le même esprit que le
// sélecteur de mode de génération (grandes cartes cliquables, clair et lisible)
// ═══════════════════════════════════════════════════════════════════════

/** Coquille commune à toutes les étapes du flux : overlay plein écran + carte centrée. */
function JiraFlowModal({
  stepLabel,
  title,
  contextBadge,
  onBack,
  onClose,
  children,
  footer,
}: {
  stepLabel: string;
  title: string;
  contextBadge?: ReactNode;
  onBack?: () => void;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-99999 flex items-center justify-center bg-black/60 backdrop-blur-sm p-5" onClick={onClose}>
      <div
        className="bg-white dark:bg-black rounded-2xl w-full max-w-xl max-h-[85vh] flex flex-col overflow-hidden shadow-solid-l border-2 border-stroke dark:border-strokedark"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-7 py-5 border-b-2 border-stroke dark:border-strokedark bg-gradient-to-br from-white to-alabaster dark:from-black dark:to-blacksection flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              {onBack && (
                <button
                  onClick={onBack}
                  className="w-6 h-6 flex items-center justify-center rounded-md border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white hover:border-primary/40 transition-all text-sm flex-shrink-0"
                  title="Retour"
                >
                  ←
                </button>
              )}
              <span className="text-[10px] font-bold text-waterloo uppercase tracking-widest">{stepLabel}</span>
            </div>
            <h3 className="text-lg font-bold text-black dark:text-white leading-snug">{title}</h3>
            {contextBadge}
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-btndark text-waterloo hover:text-black dark:hover:text-white transition-colors text-lg font-bold flex-shrink-0"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-stroke dark:border-strokedark bg-alabaster/50 dark:bg-blacksection/50">{footer}</div>}
      </div>
    </div>
  );
}

/** Petit badge de contexte réutilisé dans plusieurs étapes (module, exigence...). */
function ContextBadge({ icon, label, value }: { icon: string; label?: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-2 mt-2 max-w-full bg-primary/5 border border-primary/20 rounded-lg px-3 py-1.5">
      <span className="text-xs flex-shrink-0">{icon}</span>
      {label && <span className="text-[10px] font-bold text-primary flex-shrink-0">{label}</span>}
      <span className="text-xs text-waterloo truncate">{value}</span>
    </div>
  );
}

/** Grande carte cliquable réutilisée pour lister projets / epics / types de ticket. */
function BigOptionCard({
  icon,
  title,
  subtitle,
  badge,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-4 px-4 py-3.5 rounded-xl border-2 border-stroke dark:border-strokedark bg-white dark:bg-blacksection hover:border-primary hover:bg-zumthor/40 dark:hover:bg-primary/10 hover:-translate-y-0.5 hover:shadow-solid-3 transition-all text-left"
    >
      <div className="w-11 h-11 flex items-center justify-center rounded-lg bg-alabaster dark:bg-black border border-stroke dark:border-strokedark text-xl flex-shrink-0">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-black dark:text-white">{title}</span>
          {badge && (
            <span className="text-[9px] font-bold text-primary bg-primary/10 border border-primary/30 rounded px-1.5 py-0.5 uppercase tracking-wide">
              {badge}
            </span>
          )}
        </div>
        {subtitle && <div className="text-xs text-waterloo mt-0.5 truncate">{subtitle}</div>}
      </div>
      <div className="text-waterloo text-base flex-shrink-0">→</div>
    </button>
  );
}

// ─── Étape 1 : choix du projet Jira ─────────────────────────────────────────
function ProjectStep({
  onPick,
  onBack,
  onClose,
}: {
  onPick: (project: JiraProjectOption) => void;
  onBack?: () => void;
  onClose: () => void;
}) {
  const [projects, setProjects] = useState<JiraProjectOption[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    listJiraProjects()
      .then(list => { if (!cancelled) setProjects(list); })
      .catch(e => { if (!cancelled) setError(e.message || 'Impossible de charger les projets'); });
    return () => { cancelled = true; };
  }, []);

  return (
    <JiraFlowModal
      stepLabel="Étape 1 sur 4"
      title="Dans quel projet Jira exporter ?"
      onBack={onBack}
      onClose={onClose}
    >
      <div className="space-y-2.5">
        {!projects && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-waterloo text-sm"><Spinner /> Chargement des projets Jira...</div>
        )}
        {error && <div className="text-sm text-red-700 dark:text-red-400 py-4">{error}</div>}
        {projects && projects.length === 0 && (
          <div className="text-sm text-waterloo py-4">Aucun projet accessible avec ce compte Jira.</div>
        )}
        {projects?.map(p => (
          <BigOptionCard
            key={p.id}
            icon="📁"
            title={p.name}
            badge={p.key}
            onClick={() => onPick(p)}
          />
        ))}
      </div>
    </JiraFlowModal>
  );
}

// ─── Étape 2 : choix (ou création) de l'Epic du module ────────────────────
function EpicStep({
  projectKey,
  projectName,
  moduleName,
  onPick,
  onSkip,
  onBack,
  onClose,
}: {
  projectKey: string;
  projectName: string;
  moduleName: string;
  onPick: (epic: JiraEpicOption) => void;
  onSkip: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [epics, setEpics] = useState<JiraEpicOption[] | null>(null);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  // Prérempli avec le nom du module par défaut — l'utilisateur peut l'accepter
  // tel quel ou le remplacer entièrement par un nom de son choix.
  const [newEpicName, setNewEpicName] = useState(moduleName);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    let cancelled = false;
    listJiraEpics(projectKey)
      .then(list => { if (!cancelled) setEpics(list); })
      .catch(e => { if (!cancelled) setError(e.message || 'Impossible de charger les epics'); });
    return () => { cancelled = true; };
  }, [projectKey]);

  const handleCreate = async () => {
    const name = newEpicName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError('');
    try {
      const epic = await createJiraEpic(projectKey, name);
      onPick(epic);
    } catch (e: any) {
      setCreateError(e.message || "Impossible de créer l'epic");
      setCreating(false);
    }
  };

  return (
    <JiraFlowModal
      stepLabel="Étape 2 sur 4"
      title="Quel Epic pour ce module ?"
      contextBadge={<ContextBadge icon="📦" label="Projet" value={`${projectName} (${projectKey})`} />}
      onBack={onBack}
      onClose={onClose}
      footer={
        <p className="text-[11px] text-waterloo text-center">
          Ce choix sera réutilisé automatiquement pour toutes les exigences du module <strong>{moduleName}</strong>.
        </p>
      }
    >
      <div className="space-y-2.5">
        {showCreate ? (
          <div className="rounded-xl border-2 border-purple-500/40 bg-purple-50/50 dark:bg-purple-900/10 p-4">
            <label className="block text-xs font-bold text-purple-700 dark:text-purple-400 mb-2">Nom du nouvel epic (modifiable) :</label>
            <input
              autoFocus
              value={newEpicName}
              onChange={e => setNewEpicName(e.target.value)}
              onFocus={e => e.target.select()}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
              placeholder="Nom du nouvel epic..."
              disabled={creating}
              className="w-full px-3 py-2.5 rounded-lg border-2 border-purple-300 dark:border-purple-700 bg-white dark:bg-black text-sm text-black dark:text-white focus:border-purple-600 focus:outline-none"
            />
            {createError && <div className="mt-2 text-xs text-red-700 dark:text-red-400">{createError}</div>}
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleCreate}
                disabled={creating || !newEpicName.trim()}
                className="flex-1 px-4 py-2 rounded-lg bg-purple-600 text-white text-sm font-bold hover:bg-purple-700 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
              >
                {creating ? <Spinner /> : '✓'} Créer et sélectionner
              </button>
              <button onClick={() => { setShowCreate(false); setCreateError(''); }} disabled={creating} className="px-4 py-2 rounded-lg border border-stroke dark:border-strokedark text-sm font-bold text-waterloo hover:text-black dark:hover:text-white transition-all">
                Annuler
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowCreate(true)}
            className="w-full flex items-center gap-4 px-4 py-3.5 rounded-xl border-2 border-dashed border-purple-400/50 bg-purple-50/30 dark:bg-purple-900/10 hover:border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-all text-left"
          >
            <div className="w-11 h-11 flex items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-xl font-bold flex-shrink-0">+</div>
            <div>
              <div className="text-sm font-bold text-purple-700 dark:text-purple-400">Créer un nouvel epic</div>
              <div className="text-xs text-waterloo mt-0.5">Suggestion : « {moduleName} »</div>
            </div>
          </button>
        )}

        {!epics && !error && (
          <div className="flex items-center justify-center gap-2 py-6 text-waterloo text-sm"><Spinner /> Chargement des epics existants...</div>
        )}
        {error && <div className="text-sm text-red-700 dark:text-red-400 py-2">{error}</div>}
        {epics && epics.length === 0 && !showCreate && (
          <div className="text-xs text-waterloo text-center py-2">Aucun epic existant dans ce projet.</div>
        )}
        {epics?.map(e => (
          <BigOptionCard
            key={e.id}
            icon="🏔️"
            title={e.summary}
            badge={e.key}
            onClick={() => onPick(e)}
          />
        ))}

        <button
          onClick={onSkip}
          className="w-full flex items-center gap-4 px-4 py-3 rounded-xl border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white hover:border-black/20 dark:hover:border-white/20 transition-all text-left"
        >
          <div className="w-11 h-11 flex items-center justify-center rounded-lg bg-alabaster dark:bg-black text-lg flex-shrink-0">🚫</div>
          <div className="text-sm font-semibold">Continuer sans epic</div>
        </button>
      </div>
    </JiraFlowModal>
  );
}

// ─── Étape 3 : type de ticket pour représenter l'exigence (Story/Task) ────
function IssueTypeStep({
  projectKey,
  projectName,
  onPick,
  onBack,
  onClose,
}: {
  projectKey: string;
  projectName: string;
  onPick: (issueType: JiraIssueTypeOption) => void;
  onBack?: () => void;
  onClose: () => void;
}) {
  const [issueTypes, setIssueTypes] = useState<JiraIssueTypeOption[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    listJiraIssueTypes(projectKey)
      .then(types => { if (!cancelled) setIssueTypes(types); })
      .catch(e => { if (!cancelled) setError(e.message || 'Impossible de charger les types de ticket'); });
    return () => { cancelled = true; };
  }, [projectKey]);

  return (
    <JiraFlowModal
      stepLabel="Étape 3 sur 4"
      title="Quel type de ticket pour l'exigence ?"
      contextBadge={<ContextBadge icon="📁" label="Projet" value={`${projectName} (${projectKey})`} />}
      onBack={onBack}
      onClose={onClose}
    >
      <div className="space-y-2.5">
        {!issueTypes && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-waterloo text-sm"><Spinner /> Chargement des types de ticket...</div>
        )}
        {error && <div className="text-sm text-red-700 dark:text-red-400 py-4">{error}</div>}
        {issueTypes && issueTypes.length === 0 && (
          <div className="text-sm text-waterloo py-4">Aucun type de ticket disponible pour ce projet.</div>
        )}
        {issueTypes?.map(t => (
          <BigOptionCard
            key={t.id}
            icon={t.iconUrl ? <img src={t.iconUrl} alt="" className="w-5 h-5" /> : '🎫'}
            title={t.name}
            onClick={() => onPick(t)}
          />
        ))}
      </div>
    </JiraFlowModal>
  );
}

// ─── Étape 4 : nom de la Story — nom auto (module/exigence) ou personnalisé ─
function StoryNamingStep({
  reqId,
  defaultSummary,
  onConfirm,
  onBack,
  onClose,
}: {
  reqId: string;
  defaultSummary: string;
  onConfirm: (summary: string) => void;
  onBack?: () => void;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState(defaultSummary);
  const isDefault = summary === defaultSummary;

  return (
    <JiraFlowModal
      stepLabel="Étape 4 sur 4"
      title="Quel nom pour la Story de cette exigence ?"
      contextBadge={<ContextBadge icon="🧩" label={reqId} value={defaultSummary.replace(`[${reqId}] `, '')} />}
      onBack={onBack}
      onClose={onClose}
    >
      <div className="space-y-3">
        <div className="rounded-xl border-2 border-blue-500/30 bg-blue-50/40 dark:bg-blue-900/10 p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-bold text-blue-700 dark:text-blue-400">Nom de la Story (modifiable)</label>
            <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border border-blue-400/40 text-blue-600 dark:text-blue-400 bg-white dark:bg-black">
              {isDefault ? 'Nom auto' : 'Personnalisé'}
            </span>
          </div>
          <textarea
            value={summary}
            onChange={e => setSummary(e.target.value)}
            rows={4}
            autoFocus
            className="w-full px-3 py-2.5 rounded-lg border-2 border-blue-300 dark:border-blue-700 bg-white dark:bg-black text-sm text-black dark:text-white focus:border-blue-600 focus:outline-none resize-none"
          />
          {!isDefault && (
            <button onClick={() => setSummary(defaultSummary)} className="mt-2 text-xs text-waterloo hover:text-black dark:hover:text-white underline">
              ← Revenir au nom auto (module/exigence)
            </button>
          )}
        </div>
        <button
          onClick={() => onConfirm(summary.trim() || defaultSummary)}
          className="w-full px-5 py-3 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 transition-all shadow-solid-3"
        >
          ✓ Confirmer et exporter
        </button>
      </div>
    </JiraFlowModal>
  );
}

// ─── Coordinateur : Projet → Epic (module) → Type → Nom de la Story ───────
// Saute Projet+Epic si le module est déjà lié (hierarchy) ; le nom de la
// Story est TOUJOURS demandé pour une nouvelle exigence (module lié ou non).
function ExportFlowCoordinator({
  hierarchy,
  moduleName,
  reqId,
  reqDescription,
  onConfirm,
  onClose,
}: {
  hierarchy: JiraRequirementHierarchy;
  moduleName: string;
  reqId: string;
  reqDescription: string;
  onConfirm: (projectKey: string, issueTypeId: string, epicKey: string | undefined, storySummary: string) => void;
  onClose: () => void;
}) {
  const moduleAlreadyLinked = !!hierarchy.projectKey;
  const [project, setProject] = useState<{ key: string; name: string } | null>(
    moduleAlreadyLinked ? { key: hierarchy.projectKey!, name: hierarchy.projectKey! } : null,
  );
  const [epicKey, setEpicKey] = useState<string | undefined>(hierarchy.epicKey);
  const [epicChosen, setEpicChosen] = useState(moduleAlreadyLinked);
  const [issueType, setIssueType] = useState<JiraIssueTypeOption | null>(null);

  const defaultSummaryRaw = `[${reqId}] ${reqDescription}`;
  const defaultSummary = defaultSummaryRaw.length > 250 ? defaultSummaryRaw.slice(0, 247) + '...' : defaultSummaryRaw;

  if (!project) {
    return <ProjectStep onPick={p => setProject({ key: p.key, name: p.name })} onClose={onClose} />;
  }
  if (!epicChosen) {
    return (
      <EpicStep
        projectKey={project.key}
        projectName={project.name}
        moduleName={moduleName}
        onPick={e => { setEpicKey(e.key); setEpicChosen(true); }}
        onSkip={() => { setEpicKey(undefined); setEpicChosen(true); }}
        onBack={() => setProject(null)}
        onClose={onClose}
      />
    );
  }
  if (!issueType) {
    return (
      <IssueTypeStep
        projectKey={project.key}
        projectName={project.name}
        onPick={setIssueType}
        onBack={moduleAlreadyLinked ? undefined : () => setEpicChosen(false)}
        onClose={onClose}
      />
    );
  }
  return (
    <StoryNamingStep
      reqId={reqId}
      defaultSummary={defaultSummary}
      onConfirm={summary => onConfirm(project.key, issueType.id, epicKey, summary)}
      onBack={() => setIssueType(null)}
      onClose={onClose}
    />
  );
}
// ─── Export d'un seul TC ────────────────────────────────────────────────────
export function JiraExportSingleButton({
  testCaseId,
  reqUUID,
  reqId,
  reqDescription,
  moduleName,
  jiraIssueKey,
  jiraIssueUrl,
  onExported,
}: {
  testCaseId: string;
  reqUUID: string;
  reqId: string;
  reqDescription: string;
  moduleName: string;
  jiraIssueKey?: string | null;
  jiraIssueUrl?: string | null;
  onExported: (patch: { jiraIssueKey: string; jiraIssueUrl: string }) => void;
}) {
  const { status, statusLoaded, refreshStatus } = useJira();
  const [hierarchy, setHierarchy] = useState<JiraRequirementHierarchy | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [state, setState] = useState<'idle' | 'checking' | 'running' | 'error'>('idle');
  const [error, setError] = useState('');

  useEffect(() => { if (!statusLoaded) refreshStatus(); }, [statusLoaded, refreshStatus]);

  const runExport = async (projectKey?: string, issueTypeId?: string, epicKey?: string, storySummary?: string) => {
    setShowPicker(false);
    setState('running'); setError('');
    try {
      const result = await exportTestCaseToJira(testCaseId, projectKey, issueTypeId, epicKey, storySummary);
      if (!result.success) throw new Error(result.error || "Échec de l'export");
      onExported({ jiraIssueKey: result.issueKey!, jiraIssueUrl: result.issueUrl! });
      setState('idle');
    } catch (e: any) {
      setError(e.message || "Échec de l'export vers Jira");
      setState('error');
      setTimeout(() => setState('idle'), 4000);
    }
  };

  // Réexport d'un TC déjà lié : la hiérarchie (Epic + Story) existe forcément déjà
  // pour son exigence → on relance directement, sans repasser par le picker.
  const handleReExport = () => runExport();

  // 1er export d'un TC : on vérifie la hiérarchie (module déjà lié à un Epic ?
  // exigence déjà liée à une Story ?). Si la Story existe déjà → export direct.
  // Sinon → picker (skippant Projet+Epic si le module est déjà lié), avec choix
  // du nom de la Story à la dernière étape.
  const handleExportClick = async () => {
    if (state === 'checking' || state === 'running') return;
    setState('checking'); setError('');
    try {
      const h = await getRequirementJiraHierarchy(reqUUID);
      if (h.linked) {
        setState('idle');
        await runExport(h.projectKey, undefined, h.epicKey);
      } else {
        setHierarchy(h);
        setState('idle');
        setShowPicker(true);
      }
    } catch {
      // Impossible de vérifier la hiérarchie → on laisse l'utilisateur choisir manuellement.
      setHierarchy({ linked: false });
      setState('idle');
      setShowPicker(true);
    }
  };

  if (jiraIssueKey && jiraIssueUrl) {
    return (
      <div className="relative flex items-center gap-1">
        <a
          href={jiraIssueUrl}
          target="_blank"
          rel="noreferrer"
          title="Voir dans Jira"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-600/8 text-blue-700 dark:text-blue-400 text-[10px] font-semibold hover:bg-blue-600/14 transition-all whitespace-nowrap"
        >
          <IconExternalLink className="w-3 h-3" /> {jiraIssueKey}
        </a>
        <button
          onClick={handleReExport}
          disabled={state === 'running'}
          title="Réexporter (met à jour la sous-tâche Jira)"
          className={`${btn.iconOnly} ${btnSize.iconSm} hover:!text-blue-700 dark:hover:!text-blue-400`}
        >
          {state === 'running' ? <Spinner /> : <IconRefresh className="w-3.5 h-3.5" />}
        </button>
      </div>
    );
  }

  if (statusLoaded && !status?.connected) {
    return (
      <span className="text-[10px] text-waterloo dark:text-manatee italic" title="Connectez votre compte Jira dans les paramètres pour exporter">
        Jira non connecté
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={handleExportClick}
        disabled={state === 'running' || state === 'checking'}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all ${state === 'error' ? 'bg-red-600/8 text-red-700 dark:text-red-400' : 'bg-blue-600/8 text-blue-700 dark:text-blue-400 hover:bg-blue-600/14'}`}
      >
        {state === 'running' ? <><Spinner /> Export...</> : state === 'checking' ? <><Spinner /> ...</> : <><IconLink className="w-3 h-3" /> Exporter vers Jira</>}
      </button>
      {showPicker && hierarchy && (
        <ExportFlowCoordinator
          hierarchy={hierarchy}
          moduleName={moduleName}
          reqId={reqId}
          reqDescription={reqDescription}
          onConfirm={runExport}
          onClose={() => setShowPicker(false)}
        />
      )}
      {error && <div className="absolute z-50 top-full right-0 mt-1 w-56 text-[10px] text-red-700 dark:text-red-400 bg-white dark:bg-blacksection border border-red-600/30 rounded-lg px-2 py-1.5 shadow-solid-3">{error}</div>}
    </div>
  );
}

// ─── Export en masse (tous les TC sauvegardés d'un requirement) ───────────
export function JiraExportAllButton({
  requirementUuid,
  reqId,
  reqDescription,
  moduleName,
  count,
  onExported,
}: {
  requirementUuid: string;
  reqId: string;
  reqDescription: string;
  moduleName: string;
  count: number;
  onExported: (results: JiraExportAllResult['results']) => void;
}) {
  const { status, statusLoaded, refreshStatus } = useJira();
  const [hierarchy, setHierarchy] = useState<JiraRequirementHierarchy | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [state, setState] = useState<'idle' | 'checking' | 'running' | 'done' | 'error'>('idle');
  const [summary, setSummary] = useState<JiraExportAllResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { if (!statusLoaded) refreshStatus(); }, [statusLoaded, refreshStatus]);

  const runExport = async (projectKey?: string, issueTypeId?: string, epicKey?: string, storySummary?: string) => {
    setShowPicker(false);
    setState('running'); setError(''); setSummary(null);
    try {
      const result = await exportAllTestCasesToJira(requirementUuid, projectKey, issueTypeId, epicKey, storySummary);
      setSummary(result);
      onExported(result.results);
      setState('done');
      setTimeout(() => setState('idle'), 5000);
    } catch (e: any) {
      setError(e.message || "Échec de l'export en masse vers Jira");
      setState('error');
      setTimeout(() => setState('idle'), 4000);
    }
  };

  const handleExportClick = async () => {
    if (state === 'checking' || state === 'running') return;
    setState('checking'); setError('');
    try {
      const h = await getRequirementJiraHierarchy(requirementUuid);
      if (h.linked) {
        setState('idle');
        await runExport(h.projectKey, undefined, h.epicKey);
      } else {
        setHierarchy(h);
        setState('idle');
        setShowPicker(true);
      }
    } catch {
      setHierarchy({ linked: false });
      setState('idle');
      setShowPicker(true);
    }
  };

  if (count === 0) return null;

  if (statusLoaded && !status?.connected) {
    return (
      <span className="text-[10px] text-waterloo italic" title="Connectez votre compte Jira dans les paramètres pour exporter">
        Jira non connecté
      </span>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={handleExportClick}
        disabled={state === 'running' || state === 'checking'}
        className={`px-3 py-1 rounded-lg border text-[10px] font-bold transition-all flex items-center gap-1 ${
          state === 'error' ? 'border-red-600/40 text-red-700 dark:text-red-400'
          : state === 'done' ? 'border-meta/40 text-meta bg-meta/10'
          : 'border-blue-600/40 text-blue-700 dark:text-blue-400 hover:bg-blue-600/5'
        }`}
      >
        {state === 'running' ? <><Spinner /> Export {count} TC...</>
          : state === 'checking' ? <><Spinner /> ...</>
          : state === 'done' && summary ? `✓ ${summary.success}/${summary.total} exportés`
          : `🔗 Exporter tout (${count}) vers Jira`}
      </button>
      {showPicker && hierarchy && (
        <ExportFlowCoordinator
          hierarchy={hierarchy}
          moduleName={moduleName}
          reqId={reqId}
          reqDescription={reqDescription}
          onConfirm={runExport}
          onClose={() => setShowPicker(false)}
        />
      )}
      {error && <div className="absolute z-50 top-full right-0 mt-1 w-64 text-[10px] text-red-700 dark:text-red-400 bg-white dark:bg-blacksection border border-red-600/30 rounded-lg px-2 py-1.5 shadow-solid-3">{error}</div>}
      {state === 'done' && summary && summary.failed > 0 && (
        <div className="absolute z-50 top-full right-0 mt-1 w-64 text-[10px] text-amber-700 dark:text-amber-400 bg-white dark:bg-blacksection border border-amber-600/30 rounded-lg px-2 py-1.5 shadow-solid-3">
          {summary.failed} cas de test n'ont pas pu être exportés (voir la console pour le détail).
        </div>
      )}
    </div>
  );
}