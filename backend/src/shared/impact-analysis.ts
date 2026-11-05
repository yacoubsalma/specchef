/**
 * ─── Impact Analysis (Édition SRS) ─────────────────────────────────────────────
 *
 * Quand le BA édite une exigence, on compare l'ancienne et la nouvelle
 * description par similarité cosinus sur les embeddings nomic-embed-text
 * (même pipeline que SemanticDeduplicator — voir Semantic dedup.service.ts).
 *
 * Deux seuils :
 *  - IMPACT_CHANGE_THRESHOLD    : en dessous, le changement est jugé
 *    sémantiquement significatif → les TC de CETTE exigence sont marqués
 *    "à réviser" (needs_review = true).
 *  - IMPACT_COUPLING_THRESHOLD  : les AUTRES exigences du même projet dont la
 *    description est sémantiquement proche de la NOUVELLE description (donc
 *    probablement couplées fonctionnellement) voient aussi leurs TC marqués
 *    "à réviser", avec un motif référençant l'exigence modifiée.
 *
 * Zéro appel réseau supplémentaire au-delà des embeddings : cosine in-process,
 * même pattern que SemanticDeduplicator. Best-effort : si Ollama est
 * indisponible, l'édition reste appliquée mais sans analyse d'impact.
 */

/**
 * Score cosinus en dessous duquel l'exigence est considérée comme modifiée en
 * substance. Calibré sur données réelles (corpus "loan management") : même une
 * INVERSION complète de comportement ("stop sending reminders entirely" vs
 * "send reminders") ne descend qu'à 0.921 — les embeddings de phrases courtes
 * et bien formées restent proches tant que le sujet/domaine ne change pas,
 * même en cas de négation. 0.90 sous-détectait systématiquement (3 tests sur 5
 * auraient dû compter comme changement significatif et ne l'ont pas été).
 * 0.94 capture ces cas sans non plus déclencher sur une simple faute corrigée.
 */
export const IMPACT_CHANGE_THRESHOLD = 0.94;

/**
 * Score cosinus au-dessus duquel une AUTRE exigence est jugée couplée à celle
 * modifiée. Calibré sur données réelles (corpus "loan management", 35 exigences) :
 * un test sur FR-1.1 a montré un gap net entre 0.817 (exigences vraiment liées :
 * e-KYC, interface mobile, doublon du même FR) et 0.792 (bruit générique du
 * domaine — même vocabulaire "system shall / customers / loan" sans lien réel).
 * 0.80 capture le premier groupe sans laisser passer le second.
 * À réajuster si un autre corpus montre un gap ailleurs (voir le log de
 * diagnostic 🧪 [IMPACT/coupling] dans ProjectService._flagCoupledRequirements).
 */
export const IMPACT_COUPLING_THRESHOLD = 0.80;

/**
 * Similarité cosinus entre deux vecteurs de même dimension.
 * Retourne un score entre 0 (orthogonaux) et 1 (identiques).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface ImpactedRequirement {
  id: string;
  req_id: string;
  similarity: number;
  testCasesFlagged: number;
}

export interface ImpactResult {
  /** true si le changement de description a été jugé sémantiquement significatif */
  changed: boolean;
  /** score cosinus ancienne/nouvelle description, null si l'analyse a échoué (Ollama down) */
  similarity: number | null;
  /** nombre total de TC marqués "à réviser" (exigence éditée + exigences couplées) */
  testCasesFlagged: number;
  /** exigences sémantiquement couplées également impactées */
  impactedRequirements: ImpactedRequirement[];
}