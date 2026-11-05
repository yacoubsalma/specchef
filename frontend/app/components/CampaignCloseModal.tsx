'use client';

import { useEffect, useMemo, useState } from 'react';

// ─── Modification mise en attente pendant la campagne (voir CampaignChange
// côté backend / ProjectService.queueIfCampaignActive) ─────────────────────
export interface PendingCampaignChange {
  id: string;
  entity_type: 'requirement_module' | 'requirement' | 'test_case';
  entity_id: string | null;
  label: string;
  changed_by_name?: string | null;
  created_at: string;
  // Nom de la méthode ProjectService à rejouer + ses arguments positionnels
  // (voir queueIfCampaignActive côté backend) — sert uniquement à extraire
  // un aperçu lisible du contenu de la modification (ex: nouvelle
  // description, étapes...) avant de décider de la garder ou l'annuler.
  method?: string;
  args?: any[];
  // État ACTUEL en base de l'entité visée (avant application) — voir
  // ProjectService.listPendingCampaignChanges côté backend. `null` pour une
  // création, ou si l'entité a été supprimée entre-temps.
  current?: Record<string, any> | null;
}

const ENTITY_ICON: Record<PendingCampaignChange['entity_type'], string> = {
  requirement_module: '📦',
  requirement: '📋',
  test_case: '✅',
};

// Le proxy backend (/api/backend/[...path]) tolère jusqu'à ~25 min de délai
// pour couvrir les générations LLM longues — mais un simple GET/POST comme
// pending-changes/close ne devrait jamais prendre autant de temps. Sans
// timeout dédié ici, un backend qui ne répond pas (crash, deadlock) laisse
// la modale "tourner" indéfiniment (bouton bloqué sur "...") sans aucun
// message d'erreur exploitable. On borne donc ces deux appels à 20s.
const REQUEST_TIMEOUT_MS = 20_000;
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(`Le serveur ne répond pas (délai de ${REQUEST_TIMEOUT_MS / 1000}s dépassé). Réessayez.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Libellés FR pour les champs les plus courants d'un dto edit/create requirement/testcase/module.
const FIELD_LABELS: Record<string, string> = {
  req_id: "ID de l'exigence", description: 'Description', priority: 'Priorité',
  name: 'Nom', title: 'Titre', type: 'Type',
  preconditions: 'Préconditions', steps: 'Étapes',
  test_data: 'Données de test', testData: 'Données de test',
  expected_result: 'Résultat attendu', expectedResult: 'Résultat attendu',
  testId: 'ID du cas de test',
};

// Correspondance clé du dto (nouvelle valeur, snake ou camelCase selon la
// méthode) → clé de `current` (toujours snake_case, tel que renvoyé par Prisma)
// — permet d'aligner "avant" et "après" pour le même champ.
const CURRENT_KEY: Record<string, string> = {
  description: 'description', priority: 'priority', req_id: 'req_id', name: 'name',
  title: 'title', type: 'type', preconditions: 'preconditions', steps: 'steps',
  test_data: 'test_data', testData: 'test_data',
  expected_result: 'expected_result', expectedResult: 'expected_result',
};

interface DetailRow { label: string; before?: string | string[]; after: string | string[]; }

const fmtVal = (v: any): string | string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  return Array.isArray(v) ? v.map(String) : String(v);
};
const sameVal = (a: string | string[] | undefined, b: string | string[] | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Extrait une comparaison avant/après lisible d'une modification en attente
 * à partir de `method`/`args` (nouvelle valeur, voir queueIfCampaignActive)
 * et `current` (valeur actuelle en base, voir listPendingCampaignChanges) —
 * les arguments sont positionnels (pas de clés), donc mappés au cas par cas
 * selon la méthode. `null` si la méthode n'a pas de contenu à comparer
 * (suppression, accusé de lecture...) — le libellé suffit alors.
 */
function getChangeDetails(change: PendingCampaignChange): DetailRow[] | null {
  const args = Array.isArray(change.args) ? change.args : [];
  const current = change.current;
  const dtoRows = (dto: any): DetailRow[] => {
    if (!dto || typeof dto !== 'object') return [];
    return Object.entries(dto)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => {
        const currentKey = CURRENT_KEY[k];
        const before = current && currentKey ? fmtVal(current[currentKey]) : undefined;
        return { label: FIELD_LABELS[k] ?? k, before, after: fmtVal(v) ?? '' };
      })
      // Pas de vraie modification sur ce champ (valeur identique à l'existant) → rien à comparer.
      .filter(row => !sameVal(row.before, row.after));
  };

  switch (change.method) {
    case 'editRequirement':
    case 'editTestCase':
    case 'editModule':
    case 'createRequirement':
    case 'createModule':
    case 'createAndValidateTestCase':
      return dtoRows(args[1]);
    case 'validateTestCase': {
      const statusBefore = current?.validated === true ? 'Validé' : current?.validated === false ? 'Dévalidé' : undefined;
      const statusAfter = args[1] ? 'Validé' : 'Dévalidé';
      const rows: DetailRow[] = sameVal(statusBefore, statusAfter) ? [] : [{ label: 'Statut', before: statusBefore, after: statusAfter }];
      return [...rows, ...dtoRows(args[2])];
    }
    case 'reviewTestCase':
      return [{ label: 'Statut de revue', before: fmtVal(current?.review_status), after: String(args[1] ?? '') }];
    case 'validateAllTestCasesForRequirement':
      return [{ label: 'Action', after: args[1] ? 'Valider tous les cas de test' : 'Dévalider tous les cas de test' }];
    case 'revertRequirementEdit':
      return [{ label: 'Description', before: fmtVal(current?.description), after: String(args[1] ?? '') }];
    case 'restoreTestCaseVersion':
    case 'restoreRequirementVersion':
    case 'restoreModuleVersion':
      return [{ label: 'Version restaurée', after: String(args[1] ?? '') }];
    default:
      return null;
  }
}

/**
 * Modale de clôture de campagne. Tant qu'une campagne de tests est active,
 * les modifications de modules/exigences/cas de test ne s'appliquent pas —
 * elles restent en attente (voir CampaignChange). À la clôture, CHAQUE
 * modification en attente doit être explicitement résolue : "Garder" (elle
 * sera appliquée aux données réelles) ou "Annuler" (elle ne sera jamais
 * appliquée). Le backend refuse la clôture tant qu'il en reste une non
 * résolue (voir ProjectService.closeCampaign).
 */
export default function CampaignCloseModal({
  open,
  apiBaseUrl,
  projectId,
  onClosed,
  onCancel,
}: {
  open: boolean;
  apiBaseUrl: string;
  projectId: string;
  /** Appelé une fois la campagne effectivement clôturée côté serveur. */
  onClosed: (result: { appliedCount: number; discardedCount: number; failedCount: number }) => void;
  onCancel: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<PendingCampaignChange[]>([]);
  const [resolutions, setResolutions] = useState<Record<string, 'keep' | 'discard'>>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => setExpandedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setResolutions({});
    fetchWithTimeout(`${apiBaseUrl}/projects/${projectId}/campaign/pending-changes`)
      .then(r => r.json())
      .then(json => setChanges(Array.isArray(json?.data) ? json.data : []))
      .catch((err: any) => setError(err?.message || "Impossible de charger les modifications en attente."))
      .finally(() => setLoading(false));
  }, [open, apiBaseUrl, projectId]);

  // Échap + verrouillage du scroll pendant l'affichage, comme ConfirmDeleteModal.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && !closing) onCancel(); };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, closing, onCancel]);

  const allResolved = useMemo(
    () => changes.every(c => resolutions[c.id] === 'keep' || resolutions[c.id] === 'discard'),
    [changes, resolutions],
  );
  const setResolution = (id: string, value: 'keep' | 'discard') => setResolutions(prev => ({ ...prev, [id]: value }));
  const resolveAll = (value: 'keep' | 'discard') => setResolutions(Object.fromEntries(changes.map(c => [c.id, value])));

  const handleClose = async () => {
    setClosing(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(`${apiBaseUrl}/projects/${projectId}/campaign/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutions }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`);
      onClosed({
        appliedCount: json?.applied?.length ?? 0,
        discardedCount: json?.discarded?.length ?? 0,
        failedCount: json?.failed?.length ?? 0,
      });
    } catch (err: any) {
      console.error('[CampaignCloseModal] close error:', err);
      setError(err?.message || "Échec de la clôture de la campagne.");
    } finally {
      setClosing(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 px-4"
      onClick={() => !closing && onCancel()}
      role="presentation"
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white dark:bg-blacksection border border-stroke dark:border-strokedark shadow-solid-3 p-6 max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="campaign-close-title"
      >
        <div className="flex items-start gap-3 mb-1">
          <div className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full text-lg bg-primary/10 text-primary">
            🔓
          </div>
          <div className="min-w-0 pt-1">
            <h3 id="campaign-close-title" className="text-sm font-bold text-black dark:text-white">
              Clôturer la campagne de tests
            </h3>
            <p className="mt-1 text-xs text-waterloo leading-relaxed">
              {loading
                ? 'Chargement des modifications en attente…'
                : changes.length === 0
                ? "Aucune modification n'a été mise en attente pendant cette campagne — le projet peut être débloqué directement."
                : `${changes.length} modification(s) mise(s) en attente pendant la campagne. Choisissez, pour chacune, de la garder (elle sera appliquée) ou de l'annuler (elle sera perdue).`}
            </p>
          </div>
        </div>

        {changes.length > 0 && (
          <>
            <div className="flex items-center justify-end gap-2 mt-3 mb-1 text-[11px]">
              <span className="text-waterloo mr-auto">Action groupée :</span>
              <button
                type="button"
                onClick={() => resolveAll('keep')}
                className="px-2.5 py-1 rounded-md border border-stroke dark:border-strokedark font-bold text-primary hover:bg-primary/10 transition-colors"
              >
                Tout garder
              </button>
              <button
                type="button"
                onClick={() => resolveAll('discard')}
                className="px-2.5 py-1 rounded-md border border-stroke dark:border-strokedark font-bold text-red-600 hover:bg-red-500/10 transition-colors"
              >
                Tout annuler
              </button>
            </div>

            <div className="mt-1 flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
              {changes.map(change => {
                const decision = resolutions[change.id];
                const details = getChangeDetails(change);
                const isExpanded = expandedIds.has(change.id);
                return (
                  <div
                    key={change.id}
                    className="rounded-lg border border-stroke dark:border-strokedark p-3"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-base leading-none mt-0.5">{ENTITY_ICON[change.entity_type] ?? '•'}</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold text-black dark:text-white break-words">{change.label}</div>
                        {change.changed_by_name && (
                          <div className="text-[10px] text-waterloo mt-0.5">
                            par {change.changed_by_name} · {new Date(change.created_at).toLocaleString('fr-FR')}
                          </div>
                        )}
                        {details && details.length > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(change.id)}
                            className="mt-1 text-[10px] font-bold text-primary hover:underline"
                          >
                            {isExpanded ? '▾ Masquer le détail' : '▸ Voir le détail'}
                          </button>
                        )}
                        {isExpanded && details && details.length > 0 && (
                          <div className="mt-2 rounded-md bg-alabaster dark:bg-black/20 border border-stroke dark:border-strokedark p-2 space-y-2 max-h-56 overflow-y-auto">
                            {details.map((row, i) => (
                              <div key={i} className="text-[11px]">
                                <div className="font-bold text-black dark:text-white mb-0.5">{row.label}</div>
                                {row.before !== undefined ? (
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <div className="text-[9px] font-bold uppercase tracking-wide text-red-600/70 mb-0.5">Avant</div>
                                      {Array.isArray(row.before) ? (
                                        <ul className="list-disc pl-4 text-red-700/80 dark:text-red-400/80 line-through space-y-0.5">
                                          {row.before.map((item, j) => <li key={j} className="break-words">{item}</li>)}
                                        </ul>
                                      ) : (
                                        <div className="text-red-700/80 dark:text-red-400/80 line-through break-words whitespace-pre-wrap">{row.before || '—'}</div>
                                      )}
                                    </div>
                                    <div>
                                      <div className="text-[9px] font-bold uppercase tracking-wide text-emerald-600/80 mb-0.5">Après</div>
                                      {Array.isArray(row.after) ? (
                                        <ul className="list-disc pl-4 text-emerald-700 dark:text-emerald-400 space-y-0.5">
                                          {row.after.map((item, j) => <li key={j} className="break-words">{item}</li>)}
                                        </ul>
                                      ) : (
                                        <div className="text-emerald-700 dark:text-emerald-400 break-words whitespace-pre-wrap">{row.after || '—'}</div>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  Array.isArray(row.after) ? (
                                    <ul className="list-disc pl-4 text-waterloo space-y-0.5">
                                      {row.after.map((item, j) => <li key={j} className="break-words">{item}</li>)}
                                    </ul>
                                  ) : (
                                    <div className="text-waterloo break-words whitespace-pre-wrap">{row.after}</div>
                                  )
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => setResolution(change.id, 'keep')}
                        className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-bold border transition-colors ${
                          decision === 'keep'
                            ? 'bg-primary text-white border-primary'
                            : 'border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white'
                        }`}
                      >
                        ✓ Garder
                      </button>
                      <button
                        type="button"
                        onClick={() => setResolution(change.id, 'discard')}
                        className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-bold border transition-colors ${
                          decision === 'discard'
                            ? 'bg-red-600 text-white border-red-600'
                            : 'border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white'
                        }`}
                      >
                        ✕ Annuler
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {error && (
          <div className="mt-3 text-xs font-bold text-red-600 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            ⚠ {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={closing}
            className="px-4 py-2 rounded-lg border border-stroke dark:border-strokedark text-xs font-bold text-waterloo hover:text-black dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={handleClose}
            disabled={closing || loading || (changes.length > 0 && !allResolved)}
            title={changes.length > 0 && !allResolved ? 'Résolvez (garder/annuler) chaque modification en attente avant de clôturer' : undefined}
            className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-primary hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {closing ? '...' : 'Clôturer la campagne'}
          </button>
        </div>
      </div>
    </div>
  );
}