/**
 * ─── SemanticDeduplicator ─────────────────────────────────────────────────────
 *
 * Remplace isTitleTooClose (Levenshtein + overlap lexical) par une vraie
 * similarité cosinus sur les embeddings nomic-embed-text (768 dims).
 *
 * Exemples :
 *  - "cannot register when email is empty" et "fails to submit form with no email"
 *    → score ~0.94 → dédupliqué ✓  (l'overlap lexical ne les matchait PAS)
 *  - "cannot register when email is empty" et "cannot register when password is too short"
 *    → score ~0.71 → accepté ✓   (l'overlap lexical les rejetait car même mots)
 *  - Zéro réseau : cosine in-process sur les vecteurs retournés par EmbeddingService
 *  - Cache LRU d'EmbeddingService couvre les appels répétés dans un même batch
 *
 * Seuils recommandés (nomic-embed-text, titres de TC) :
 *   DEDUP_THRESHOLD = 0.92  → doublon sémantique confirmé
 *   WARN_THRESHOLD  = 0.85  → proche mais accepté (loggé en warn)
 *
 * Usage dans LlmService :
 *   Au lieu de :  isTitleTooClose(tc.title, forbiddenTitles)
 *   Utiliser :    await this.semanticDedup.isTooClose(tc.title, forbiddenTitles)
 *
 * Fallback automatique :
 *   Si EmbeddingService échoue (Ollama offline, timeout), on retombe sur
 *   la comparaison exacte (string equality) uniquement (pas de Levenshtein ni d'overlap lexical, sources de faux positifs).
 */

import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingService } from '../embedding/embedding.service';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Score cosinus au-dessus duquel deux titres sont considérés comme doublons. */
const DEDUP_THRESHOLD = 0.92;

/**
 * Score cosinus au-dessus duquel on logue un avertissement mais on ACCEPTE.
 * Permet de repérer les titres "proches mais différents" sans les bloquer.
 */
const WARN_THRESHOLD = 0.85;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Similarité cosinus entre deux vecteurs de même dimension.
 * Retourne un score entre 0 (orthogonaux) et 1 (identiques).
 * Complexité O(n) — acceptable pour 768 dims en mémoire.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Normalise un titre pour le texte d'embedding :
 * Minuscules, suppression de la ponctuation superflue, normalisation des espaces.
 * On ne supprime PAS les mots vides — nomic-embed-text les gère bien et ils
 * portent de la sémantique dans les titres de TC ("cannot", "when", "without").
 */
function normalizeForEmbed(title: string): string {
  return title
    .toLowerCase()
    .replace(/["""]/g, '"')
    .replace(/['']/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripParentheticalQualifiers(title: string): string {
  return normalizeForEmbed(title)
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class SemanticDeduplicator {
  private readonly logger = new Logger(SemanticDeduplicator.name);

  /**
   * Cache des embeddings de la session courante.
   *
   * Clé   : titre normalisé (string)
   * Valeur : vecteur 768-dims (number[])
   *
   * Distinct du cache LRU interne d'EmbeddingService :
   *  - EmbeddingService.cache : texte brut → vecteur  (global process, 256 entrées)
   *  - SemanticDeduplicator.cache : titre normalisé → vecteur  (par génération)
   *
   * Les deux sont complémentaires : si EmbeddingService a déjà le texte en cache,
   * il répond en ~0ms ; sinon il appelle Ollama et on met le résultat dans les deux.
   *
   * On n'évince pas ce cache — il vit le temps d'une génération (quelques minutes).
   * Si besoin, appeler clearCache() depuis LlmService entre deux générations.
   */
  private readonly _embedCache = new Map<string, number[]>();

  constructor(private readonly embeddingService: EmbeddingService) {}

  // ── API publique ─────────────────────────────────────────────────────────────

  /**
   * Vérifie si `candidate` est sémantiquement trop proche de l'un des `existing`.
   *
   * @param candidate     Titre du nouveau TC
   * @param existing      Titres déjà acceptés dans le slot courant
   * @param threshold     Seuil de déduplication (défaut : DEDUP_THRESHOLD = 0.92)
   * @returns true si doublon sémantique, false si acceptable
   */
  async isTooClose(
    candidate: string,
    existing: string[],
    threshold: number = DEDUP_THRESHOLD,
  ): Promise<boolean> {
    if (!existing || existing.length === 0) return false;

    // 1. Correspondance exacte rapide (O(n) string compare, avant tout appel réseau)
    const norm = normalizeForEmbed(candidate);
    const baseNorm = stripParentheticalQualifiers(candidate);
    for (const e of existing) {
      const existingBaseNorm = stripParentheticalQualifiers(e);
      if (baseNorm.length > existingBaseNorm.length && baseNorm === existingBaseNorm) {
        this.logger.debug(`[SemanticDedup] Qualifier-only variant rejected: "${candidate}" vs "${e}"`);
        return true;
      }

      if (normalizeForEmbed(e) === norm) {
        this.logger.debug(`[SemanticDedup] Exact match — rejected: "${candidate}"`);
        return true;
      }
    }

    // 2. Embedding du candidat (cache LRU EmbeddingService + cache local)
    let candidateVec: number[];
    try {
      candidateVec = await this._getEmbedding(candidate);
    } catch (err: any) {
      // Fallback silencieux : Ollama offline ou timeout
      this.logger.warn(
        `[SemanticDedup] Embedding failed for "${candidate.slice(0, 60)}": ${err.message}` +
        ` — falling back to exact-match only`,
      );
      return false; // On n'éjecte pas un TC sans certitude
    }

    // 3. Comparaison cosinus contre chaque titre existant
    let maxScore = 0;
    let maxTitle = '';

    for (const e of existing) {
      let existingVec: number[];
      try {
        existingVec = await this._getEmbedding(e);
      } catch {
        continue; // Skip ce titre si embedding impossible
      }

      const score = cosineSimilarity(candidateVec, existingVec);
      if (score > maxScore) {
        maxScore = score;
        maxTitle = e;
      }

      // Guard numérique : si les deux titres contiennent des nombres distincts,
      // on relève le seuil effectif à 0.97 — deux TCs qui diffèrent par la valeur
      // exacte testée ("5 chars" vs "8 chars") sont toujours des TCs distincts.
      const effectiveThreshold = (() => {
        const numsC = (candidate.match(/\d+/g) ?? []).map(Number).sort((a,b)=>a-b);
        const numsE = (e.match(/\d+/g)        ?? []).map(Number).sort((a,b)=>a-b);
        const hasDiffNumbers =
          numsC.length > 0 && numsE.length > 0 &&
          JSON.stringify(numsC) !== JSON.stringify(numsE);
        return hasDiffNumbers ? Math.max(threshold, 0.97) : threshold;
      })();

      // Court-circuit dès qu'un seuil de doublon est atteint
      if (score >= effectiveThreshold) {
        this.logger.log(
          `[SemanticDedup] ❌ Duplicate detected (score=${score.toFixed(3)} ≥ ${threshold})\n` +
          `  candidate: "${candidate}"\n` +
          `  similar:   "${e}"`,
        );
        return true;
      }
    }

    // Log des cas proches mais acceptés (pour le monitoring et le tuning du seuil)
    if (maxScore >= WARN_THRESHOLD) {
      this.logger.warn(
        `[SemanticDedup] ⚠️  Close but accepted (score=${maxScore.toFixed(3)}, threshold=${threshold})\n` +
        `  candidate: "${candidate}"\n` +
        `  closest:   "${maxTitle}"`,
      );
    }

    return false;
  }

  /**
   * Variante batch : vérifie plusieurs candidats en une passe.
   * Utile pour filtrer un batch entier après Phase B.
   *
   * @returns Tableau parallèle de booléens (true = doublon)
   */
  async filterDuplicates(
    candidates: string[],
    existing: string[],
    threshold: number = DEDUP_THRESHOLD,
  ): Promise<boolean[]> {
    const results: boolean[] = [];
    // On maintient une liste "accepted" qui s'enrichit au fil du filtre,
    // pour que les candidats se dédupliquent aussi entre eux (pas seulement vs existing).
    const accepted = [...existing];

    for (const candidate of candidates) {
      const isDup = await this.isTooClose(candidate, accepted, threshold);
      results.push(isDup);
      if (!isDup) accepted.push(candidate); // Le candidat accepté devient référence pour les suivants
    }

    return results;
  }

  /**
   * Vide le cache local de la session.
   * Appeler depuis LlmService entre deux générations indépendantes si la mémoire
   * devient un problème (typiquement > 500 titres uniques par session).
   */
  clearCache(): void {
    const size = this._embedCache.size;
    this._embedCache.clear();
    this.logger.debug(`[SemanticDedup] Cache cleared (${size} entries)`);
  }

  /**
   * Retourne les statistiques du cache local.
   * Utile pour le monitoring et le dimensionnement du cache.
   */
  cacheStats(): { size: number; titles: string[] } {
    return {
      size: this._embedCache.size,
      titles: Array.from(this._embedCache.keys()).slice(0, 20), // preview des 20 premiers
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Récupère l'embedding d'un titre.
   * Priorité : cache local → cache LRU EmbeddingService → appel Ollama.
   */
  private async _getEmbedding(title: string): Promise<number[]> {
    const key = normalizeForEmbed(title);

    // Cache local (hit instantané — pas de promise overhead)
    const cached = this._embedCache.get(key);
    if (cached) return cached;

    // EmbeddingService (cache LRU interne + appel Ollama si miss)
    // On passe le titre normalisé pour maximiser les cache-hits entre titres
    // légèrement reformulés (majuscules, ponctuation différente).
    const vec = await this.embeddingService.embed(key);

    // Stocker dans le cache local pour les appels suivants dans ce batch
    this._embedCache.set(key, vec);
    return vec;
  }
}