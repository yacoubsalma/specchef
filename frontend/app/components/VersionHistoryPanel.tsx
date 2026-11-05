'use client';

/**
 * VersionHistoryPanel — timeline des versions d'une entité (module, exigence,
 * cas de test) avec restauration (rollback) en un clic.
 *
 * Réutilisable partout où une entité versionnée est éditée : voir
 * ModuleReqEditor.tsx (module + exigence), TCCard (cas de test dans
 * analyzer/page.tsx). Suit la même convention Tailwind/tokens que
 * ConfirmDeleteModal.tsx (bg-blacksection, text-waterloo, border-stroke...).
 *
 * Ne fait AUCUNE hypothèse sur la forme de `snapshot` au-delà de ce qui est
 * listé dans `FIELD_LABELS` — les champs inconnus sont affichés tels quels
 * (clé + JSON.stringify), pour ne jamais rien cacher au BA/QA qui consulte
 * l'historique.
 */

import { useEffect, useState } from 'react';
import { EntityVersion, VersionedEntityType, getEntityVersions, restoreEntityVersion } from '@/lib/versions-api';
import ConfirmDeleteModal from './ConfirmDeleteModal';

const FIELD_LABELS: Record<string, string> = {
  req_id: 'Identifiant',
  description: 'Description',
  priority: 'Priorité',
  name: 'Nom',
  title: 'Titre',
  steps: 'Étapes',
  preconditions: 'Préconditions',
  test_data: 'Données de test',
  expected_result: 'Résultat attendu',
  type: 'Type',
  nodes: 'Étapes du graphe',
  edges: 'Liaisons du graphe',
  variables: 'Variables',
};

const CHANGE_TYPE_BADGE: Record<string, { label: string; className: string }> = {
  create:  { label: 'Création',     className: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
  update:  { label: 'Modification', className: 'bg-primary/10 text-primary' },
  restore: { label: 'Restauration', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  delete:  { label: 'Suppression',  className: 'bg-red-500/10 text-red-600 dark:text-red-400' },
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function formatFieldValue(key: string, value: any): string {
  if (value == null) return '—';
  // Cas spécifiques au workflow : un compte brut ("3 élément(s)") ne dit
  // rien d'utile sur CE qui a changé — on liste les étapes par leur nom,
  // qui est l'information que le BA cherche réellement en consultant une
  // version de canevas.
  if (key === 'nodes' && Array.isArray(value)) {
    if (value.length === 0) return '(vide)';
    const labels = value.map((n: any) => n?.data?.label || '(étape sans nom)');
    return `${value.length} étape(s) : ${labels.join(' → ')}`;
  }
  if (key === 'edges' && Array.isArray(value)) {
    if (value.length === 0) return '(vide)';
    return `${value.length} liaison(s) entre étapes`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '(vide)';
    // Un tableau d'objets générique (variables, etc.) ne peut pas être joint
    // en texte lisible — .join() afficherait "[object Object]".
    if (value.some(v => v !== null && typeof v === 'object')) return `${value.length} élément(s)`;
    return value.join(' • ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface VersionHistoryPanelProps {
  open: boolean;
  onClose: () => void;
  entityType: VersionedEntityType | 'test_workflow';
  entityId: string | null | undefined;
  /** Libellé humain affiché en en-tête, ex: "Module « Authentification »" */
  entityLabel?: string;
  /** Appelé après une restauration réussie, avec l'entité mise à jour retournée par le backend. */
  onRestored?: (updatedEntity: any) => void;
  /**
   * Contrôle l'affichage du bouton "Restaurer" — le serveur revérifie de
   * toute façon le rôle à l'appel (403 sinon), cette prop ne sert qu'à ne pas
   * proposer une action vouée à échouer. Par défaut à `true` (rétrocompatible
   * avec les appelants qui ne le passent pas encore).
   * Convention appelée par les call sites : BA → module/exigence, QA → cas de
   * test, BA → workflow (voir ModuleReqEditor.tsx, page.tsx, TestWorkflowBoard.tsx).
   */
  canRestore?: boolean;
  /**
   * Overrides optionnels — nécessaires pour le workflow, dont les endpoints
   * sont imbriqués sous /projects/:projectId/workflows/:id/versions (throttlé
   * côté backend) plutôt que le générique /projects/versions/:type/:id utilisé
   * par module/exigence/cas de test (voir lib/workflow-api.ts).
   */
  fetchVersions?: (entityId: string) => Promise<EntityVersion[]>;
  doRestore?: (entityId: string, versionId: string) => Promise<any>;
}

export default function VersionHistoryPanel({ open, onClose, entityType, entityId, entityLabel, onRestored, fetchVersions, doRestore, canRestore = true }: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<EntityVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<EntityVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

  const loadVersions = (id: string) => fetchVersions ? fetchVersions(id) : getEntityVersions(entityType as VersionedEntityType, id);
  const runRestore = (id: string, versionId: string) => doRestore ? doRestore(id, versionId) : restoreEntityVersion(entityType as VersionedEntityType, id, versionId);

  useEffect(() => {
    if (!open || !entityId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadVersions(entityId)
      .then(data => { if (!cancelled) setVersions(data); })
      .catch(err => { if (!cancelled) setError(err.message || 'Impossible de charger l\'historique'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entityType, entityId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && !restoring) onClose(); };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, restoring, onClose]);

  if (!open) return null;

  async function handleConfirmRestore() {
    if (!pendingRestore || !entityId) return;
    setRestoring(true);
    setError(null);
    try {
      const result = await runRestore(entityId, pendingRestore.id);
      // Le générique module/exigence/cas de test renvoie { pending, data } (voir
      // lib/versions-api.ts) ; le workflow (doRestore, throttlé) renvoie
      // directement l'entité — on ne touche pas à ce cas.
      if (result && typeof result === 'object' && 'pending' in result) {
        if (result.pending) {
          setInfoMessage(result.message || "Campagne de tests en cours : cette restauration est mise en attente jusqu'à la clôture de la campagne.");
          setTimeout(() => setInfoMessage(null), 6000);
          setPendingRestore(null);
          return;
        }
        onRestored?.(result.data);
      } else {
        onRestored?.(result);
      }
      // Recharge l'historique — la restauration vient de créer une nouvelle entrée.
      const fresh = await loadVersions(entityId);
      setVersions(fresh);
      setPendingRestore(null);
    } catch (err: any) {
      setError(err.message || 'La restauration a échoué');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[998] flex items-center justify-center bg-black/50 px-4"
        onClick={onClose}
        role="presentation"
      >
        <div
          className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl bg-white dark:bg-blacksection border border-stroke dark:border-strokedark shadow-solid-3"
          onClick={e => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          {/* En-tête */}
          <div className="flex items-start justify-between gap-3 p-5 border-b border-stroke dark:border-strokedark">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-black dark:text-white flex items-center gap-2">
                <span aria-hidden>🕓</span> Historique des versions
              </h3>
              {entityLabel && <p className="mt-1 text-xs text-waterloo truncate">{entityLabel}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-waterloo hover:text-black dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
              aria-label="Fermer"
            >
              ✕
            </button>
          </div>

          {/* Corps */}
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {loading && <p className="text-xs text-waterloo">Chargement de l'historique…</p>}
            {error && !loading && <p className="text-xs text-red-600">{error}</p>}
            {infoMessage && !loading && <p className="text-xs font-bold text-amber-700 dark:text-amber-400">⏳ {infoMessage}</p>}
            {!loading && !error && versions.length === 0 && (
              <p className="text-xs text-waterloo">Aucune version enregistrée pour le moment.</p>
            )}

            {!loading && versions.map((v, idx) => {
              const badge = CHANGE_TYPE_BADGE[v.change_type] ?? CHANGE_TYPE_BADGE.update;
              const isLatest = idx === 0;
              const isExpanded = expandedId === v.id;
              return (
                <div key={v.id} className="rounded-xl border border-stroke dark:border-strokedark p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${badge.className}`}>{badge.label}</span>
                        <span className="text-xs font-bold text-black dark:text-white">Version #{v.version_number}</span>
                        {isLatest && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 dark:bg-white/5 text-waterloo">
                            version actuelle
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-waterloo">
                        {v.change_summary || 'Mise à jour'} — {formatDate(v.created_at)}
                        {v.changed_by_name ? ` · ${v.changed_by_name}` : ''}
                      </p>
                    </div>
                    {canRestore && (
                      <button
                        type="button"
                        onClick={() => setPendingRestore(v)}
                        disabled={restoring}
                        className="shrink-0 px-3 py-1.5 rounded-lg border border-stroke dark:border-strokedark text-[11px] font-bold text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Restaurer l'état de cette version"
                      >
                        Restaurer
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : v.id)}
                    className="mt-2 text-[11px] font-semibold text-primary hover:underline"
                  >
                    {isExpanded ? 'Masquer le détail' : 'Voir le détail'}
                  </button>

                  {isExpanded && (
                    <dl className="mt-2 space-y-1.5 rounded-lg bg-slate-50 dark:bg-white/5 p-3">
                      {Object.entries(v.snapshot).map(([key, value]) => (
                        <div key={key}>
                          <dt className="text-[10px] font-bold uppercase tracking-wide text-waterloo">{FIELD_LABELS[key] ?? key}</dt>
                          <dd className="text-xs text-black dark:text-white whitespace-pre-wrap break-words">{formatFieldValue(key, value)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <ConfirmDeleteModal
        open={!!pendingRestore}
        title="Restaurer cette version ?"
        message={pendingRestore ? `L'état actuel sera conservé dans l'historique (rien n'est perdu) puis remplacé par la version #${pendingRestore.version_number} du ${formatDate(pendingRestore.created_at)}.` : undefined}
        confirmLabel="Restaurer"
        cancelLabel="Annuler"
        danger={false}
        loading={restoring}
        onConfirm={handleConfirmRestore}
        onCancel={() => !restoring && setPendingRestore(null)}
      />
    </>
  );
}