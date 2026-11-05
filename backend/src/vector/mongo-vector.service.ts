import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ObjectId } from 'bson';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';

/**
 * MongoVectorService
 * ───────────────────
 *
 * Fonctionnalités :
 *  - Déduplication des test cases par similarité cosinus (collection test_cases)
 *  - Recherche sémantique dans GenerationHistoryEntry (collection generation_history_entries)
 *  - Index Atlas Vector Search sur les deux collections
 *  - Synchronisation depuis MongoDB au démarrage
 *
 * Prérequis Atlas :
 *  1. Index "test_cases_vector_index" sur la collection test_cases :
 *     { fields: [{ type: 'vector', path: 'embedding', numDimensions: 768, similarity: 'cosine' },
 *                { type: 'filter', path: 'requirement_id' }] }
 *
 *  2. Index "generation_history_vector_index" sur la collection generation_history_entries :
 *     { fields: [{ type: 'vector', path: 'embedding', numDimensions: 768, similarity: 'cosine' },
 *                { type: 'filter', path: 'project_id' },
 *                { type: 'filter', path: 'requirement_id' }] }
 */
// ── Types du cache vectoriel ─────────────────────────────────────────────────

type HistorySearchResult = {
  isDuplicate: boolean;
  similarId?: string;
  score?: number;
  similarTitle?: string;
  similarTC?: any;
  source: 'history';
};

type SimilarSearchResult = {
  isDuplicate: boolean;
  similarId?: string;
  score?: number;
  similarTitle?: string;
  similarSteps?: string[];
  similarTC?: any;
};

// ── Types saturation ─────────────────────────────────────────────────────────

export type SaturationStatus = {
  isSaturated: boolean;
  tcCount: number;
  rejectionRate: number;   // 0-1 : ratio rejets sur les dernières tentatives
  avgScore: number;        // score moyen des derniers checks de similarité
  reason: string;          // message lisible pour la bannière
  threshold: number;       // seuil adaptatif utilisé actuellement
};

// Entrée de tracking par requirement
type RejectionEntry = {
  timestamp: number;
  score: number;
  rejected: boolean;
};

@Injectable()
export class MongoVectorService implements OnModuleInit {
  private readonly logger = new Logger(MongoVectorService.name);
  private readonly SIMILARITY_THRESHOLD = 0.90;
  private readonly HISTORY_SIMILARITY_THRESHOLD = 0.85;
  private _historyCountRetryAfter = 0;
  private _syncRetryAfter = 0;

  // ── Tracking des rejets par requirement ──────────────────────────────────
  // Garde en mémoire les N dernières tentatives (score + résultat)
  // pour calculer le taux de rejet en temps réel.
  private readonly REJECTION_WINDOW = 6; // nb de tentatives à observer
  private readonly _rejectionLog = new Map<string, RejectionEntry[]>();

  // ── Cache en mémoire des recherches vectorielles ─────────────────────────
  //
  // Principe : chercher → stocker → réutiliser → réutiliser → réutiliser
  //
  // Clé = projectId + requirementId  (PAS le contenu du TC)
  // → 1 requirement = 1 seule recherche Atlas, quel que soit le nombre de TCs
  //   générés ou vérifiés pour ce requirement.
  //
  // Le cache vit pour toute la durée de vie du process NestJS.
  // Il NE DOIT PAS être vidé entre deux générations : il s'accumule.

  private readonly _historySearchCache = new Map<string, HistorySearchResult>();
  private readonly _similarSearchCache = new Map<string, SimilarSearchResult>();

  // Statistiques légères pour le debug
  private _cacheStats = { historyHits: 0, historyCalls: 0, similarHits: 0, similarCalls: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  // ── Clé de cache : scoped au requirement (pas au TC) ────────────────────
  // 1 requirement = 1 clé = 1 seule recherche vectorielle

  private _cacheKey(requirementId: string, projectId: string, tcContent?: string): string {
    if (tcContent) {
      // Clé spécifique au TC candidat : évite les faux hits entre angles différents
      const hash = tcContent.slice(0, 80).replace(/\s+/g, '_');
      return `${projectId}:${requirementId}:${hash}`;
    }
    return `${projectId}:${requirementId}`;
  }

  getVectorSearchCacheStats() {
    return {
      history: {
        size: this._historySearchCache.size,
        hits: this._cacheStats.historyHits,
        calls: this._cacheStats.historyCalls,
      },
      similar: {
        size: this._similarSearchCache.size,
        hits: this._cacheStats.similarHits,
        calls: this._cacheStats.similarCalls,
      },
    };
  }

  async onModuleInit() {
    this.logger.log('✅ MongoVectorService prêt — Atlas Vector Search pour test_cases + generation_history_entries');
    await this.syncMissingEmbeddings();
  }

  private isMongoConnectivityError(err: any): boolean {
    const msg = String(err?.message ?? '').toLowerCase();
    return (
      msg.includes('server selection timeout') ||
      msg.includes('no available servers') ||
      msg.includes('replicasetnoprimary') ||
      msg.includes('i/o error: timed out') ||
      msg.includes('topology')
    );
  }

  private shortMongoError(err: any): string {
    const msg = String(err?.message ?? 'Erreur MongoDB inconnue');
    if (!msg.includes('Topology:')) {
      return msg;
    }
    return msg.split('Topology:')[0].trim();
  }

  // ── Synchroniser les TCs existants qui n'ont pas encore d'embedding ─────────

  private async syncMissingEmbeddings(): Promise<void> {
    const now = Date.now();
    if (now < this._syncRetryAfter) {
      return;
    }

    try {
      const tcsWithoutEmbedding = await this.prisma.testCase.findMany({
        where: { embedding: { equals: [] } },
        include: { requirement: { include: { module: { include: { project: true } } } } },
        take: 200,
      });

      if (tcsWithoutEmbedding.length === 0) {
        this.logger.log('✅ Tous les TCs ont déjà des embeddings');
        return;
      }

      this.logger.log(`🔄 Sync embeddings pour ${tcsWithoutEmbedding.length} TC(s) sans vecteur...`);

      const BATCH_SIZE = 5;
      let synced = 0;

      for (let i = 0; i < tcsWithoutEmbedding.length; i += BATCH_SIZE) {
        const batch = tcsWithoutEmbedding.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (tc) => {
            try {
              const text = this.buildText({ title: tc.title, steps: tc.steps });
              const embedding = await this.embeddingService.embed(text);
              await this.prisma.testCase.update({
                where: { id: tc.id },
                data: { embedding },
              });
              synced++;
            } catch (err: any) {
              this.logger.warn(`⚠️ Embedding sync failed for TC ${tc.test_id}: ${err.message}`);
            }
          }),
        );

        this.logger.log(`🔄 Sync: ${Math.min(i + BATCH_SIZE, tcsWithoutEmbedding.length)}/${tcsWithoutEmbedding.length}`);
      }

      this.logger.log(`✅ Sync terminée — ${synced} TCs mis à jour`);
    } catch (err: any) {
      if (this.isMongoConnectivityError(err)) {
        this._syncRetryAfter = Date.now() + 60_000;
        this.logger.warn(`⚠️ MongoDB Atlas indisponible pour la sync embeddings (${this.shortMongoError(err)}). Nouvelle tentative dans 60s.`);
        setTimeout(() => {
          void this.syncMissingEmbeddings();
        }, 60_000);
        return;
      }

      this.logger.warn(`⚠️ Sync embeddings échouée : ${this.shortMongoError(err)}`);
    }
  }

  // ── Vérifier si un TC similaire existe dans test_cases (déduplication) ──────

  async isSimilar(tc: {
    title: string;
    steps: string[];
    requirementId: string;
    projectId: string;
  }): Promise<{
    isDuplicate: boolean;
    similarId?: string;
    score?: number;
    similarTitle?: string;
    similarSteps?: string[];
    similarTC?: any;
  }> {
    try {
      const queryText = this.buildText(tc);

      // ── Cache lookup ──────────────────────────────────────────────────────
      this._cacheStats.similarCalls++;
      const cacheKey = this._cacheKey(tc.requirementId, tc.projectId);
      const cached = this._similarSearchCache.get(cacheKey);
      if (cached !== undefined) {
        this._cacheStats.similarHits++;
        this.logger.log(`🎯 [VECTOR CACHE HIT] isSimilar — clé: ${cacheKey} (${this._cacheStats.similarHits}/${this._cacheStats.similarCalls} hits)`);
        return cached;
      }
      // ─────────────────────────────────────────────────────────────────────

      const queryVector = await this.embeddingService.embed(queryText);

      // 🔍 Log le vecteur de requête
      if (!queryVector || queryVector.length === 0) {
        this.logger.warn(`⚠️ [test_cases] Query vector is EMPTY — cannot perform search`);
        return { isDuplicate: false, score: 0 };
      }
      this.logger.log(`📊 [test_cases] Query vector: ${queryVector.length} dimensions`);

      let requirementObjectId: ObjectId;
      try {
        requirementObjectId = new ObjectId(tc.requirementId);
      } catch {
        this.logger.warn(`MongoVector isSimilar: requirementId n'est pas un ObjectId valide: ${tc.requirementId}`);
        return { isDuplicate: false };
      }

      const results = await (this.prisma.testCase as any).aggregateRaw({
        pipeline: [
          {
            $vectorSearch: {
              index: 'test_cases_vector_index',
              path: 'embedding',
              queryVector,
              numCandidates: 20,
              limit: 3,
              filter: { requirement_id: requirementObjectId },
            },
          },
          {
            $project: {
              _id: 1,
              test_id: 1,
              title: 1,
              steps: 1,
              preconditions: 1,
              test_data: 1,
              expected_result: 1,
              type: 1,
              priority: 1,
              score: { $meta: 'vectorSearchScore' },
            },
          },
        ],
      });

      let score: number = 0;
      if (!results || results.length === 0) {
        this.logger.log(`🔎 [test_cases] Aucun résultat trouvé — Score: 0.000`);
        const emptyResult: SimilarSearchResult = { isDuplicate: false, score: 0 };
        this._similarSearchCache.set(cacheKey, emptyResult);
        return emptyResult;
      }

      // Afficher tous les résultats avec leurs scores
      this.logger.log(`🔎 [test_cases] ${results.length} résultat(s) trouvé(s):`);
      results.forEach((r, i) => {
        const scoreVal: number = r.score ?? 0;
        this.logger.log(`   ${i + 1}. «${r.title}» — Score: ${scoreVal.toFixed(3)} (${Math.round(scoreVal * 100)}%) ${scoreVal >= this.SIMILARITY_THRESHOLD ? '⚠️ THRESHOLD' : ''}`);
      });

      const best = results[0];
      score = best.score ?? 0;

      if (score >= this.SIMILARITY_THRESHOLD) {
        const dupResult: SimilarSearchResult = {
          isDuplicate: true,
          similarId: best._id?.$oid || best._id,
          score,
          similarTitle: best.title,
          similarSteps: best.steps || [],
          similarTC: {
            title: best.title,
            preconditions: best.preconditions || [],
            steps: best.steps || [],
            testData: best.test_data || [],
            expectedResult: best.expected_result || '',
            type: best.type || 'positive',
            priority: best.priority || 'MEDIUM',
          },
        };
        this._similarSearchCache.set(cacheKey, dupResult);
        this.logger.log(`💾 [VECTOR CACHE SET] isSimilar — clé: ${cacheKey} (isDuplicate: true, score: ${score.toFixed(3)})`);
        return dupResult;
      }

      const notDupResult: SimilarSearchResult = { isDuplicate: false, score };
      this._similarSearchCache.set(cacheKey, notDupResult);
      this.logger.log(`💾 [VECTOR CACHE SET] isSimilar — clé: ${cacheKey} (isDuplicate: false, score: ${score.toFixed(3)})`);
      return notDupResult;
    } catch (err: any) {
      this.logger.warn(`MongoVector isSimilar failed: ${err.message} — skip dedup`);
      // On ne cache PAS les erreurs pour permettre un retry
      return { isDuplicate: false, score: 0 };
    }
  }

  // ── Vérifier si un TC similaire existe dans GenerationHistoryEntry ──────────
  //
  // Utilise l'index Atlas "generation_history_vector_index" sur la collection
  // "generation_history_entries" pour détecter les doublons dans l'historique
  // complet (y compris les TCs rejetés ou remplacés).
  //
  // Seuil : 0.85 (plus souple que test_cases car l'historique peut contenir
  // des TCs anciens ou légèrement reformulés qu'on veut quand même détecter).

  // ── Seuil adaptatif selon densité historique ─────────────────────────────
  // Plus l'historique est dense, plus on tolère la similarité.
  // Évite les fallbacks infinis quand l'espace sémantique est saturé.
  private _adaptiveHistoryThreshold(tcCount: number): number {
    if (tcCount >= 20) return 0.94;
    if (tcCount >= 15) return 0.91;
    if (tcCount >= 10) return 0.88;
    return this.HISTORY_SIMILARITY_THRESHOLD; // 0.85 par défaut
  }

  // ── Logger un résultat de vérification similarité ────────────────────────
  private _logRejection(requirementId: string, score: number, rejected: boolean): void {
    const key = requirementId;
    const entries = this._rejectionLog.get(key) ?? [];
    entries.push({ timestamp: Date.now(), score, rejected });
    // Garder seulement les N dernières entrées
    if (entries.length > this.REJECTION_WINDOW) entries.shift();
    this._rejectionLog.set(key, entries);
  }

  // ── Compter l'historique sans bloquer si Mongo est indisponible ──────────
  private async _getSafeHistoryCount(requirementId: string): Promise<number> {
    const now = Date.now();
    if (now < this._historyCountRetryAfter) {
      return 0;
    }

    try {
      return await this.prisma.generationHistoryEntry.count({
        where: { requirement_id: requirementId },
      });
    } catch (err: any) {
      this._historyCountRetryAfter = now + 60_000;
      this.logger.warn(`⚠️ [generation_history] Count indisponible, fallback à 0: ${err.message}`);
      return 0;
    }
  }

  // ── Calculer le statut de saturation pour un requirement ─────────────────
  async getSaturationStatus(requirementId: string, projectId: string): Promise<SaturationStatus> {
    // Compter le nombre de TCs dans l'historique
    const tcCount = await this._getSafeHistoryCount(requirementId);

    const entries = this._rejectionLog.get(requirementId) ?? [];
    const threshold = this._adaptiveHistoryThreshold(tcCount);

    // Taux de rejet sur la fenêtre
    const rejectionRate = entries.length > 0
      ? entries.filter(e => e.rejected).length / entries.length
      : 0;

    // Score moyen des dernières tentatives
    const avgScore = entries.length > 0
      ? entries.reduce((sum, e) => sum + e.score, 0) / entries.length
      : 0;

    // Critères de saturation combinés :
    // 1. Taux de rejet ≥ 80% sur la fenêtre ET au moins 4 tentatives observées
    // 2. Score moyen ≥ seuil adaptatif (toutes les tentatives similaires)
    const highRejectionRate = entries.length >= 4 && rejectionRate >= 0.8;
    const highAvgScore      = entries.length >= 4 && avgScore >= threshold;
    const isSaturated       = highRejectionRate && highAvgScore;

    let reason = '';
    if (isSaturated) {
      reason = `L'espace sémantique de cette exigence est saturé — ${tcCount} scénarios couverts, taux de rejet ${Math.round(rejectionRate * 100)}%. Il n'existe probablement plus de scénario distinct à générer.`;
    } else if (rejectionRate >= 0.5 && entries.length >= 4) {
      reason = `Génération difficile — ${Math.round(rejectionRate * 100)}% des tentatives récentes ont été rejetées (${tcCount} TCs existants).`;
    }

    return { isSaturated, tcCount, rejectionRate, avgScore, reason, threshold };
  }

  async isSimilarInHistory(tc: {
    title: string;
    steps: string[];
    requirementId: string;
    projectId: string;
    // ⚠️ FIX : quand on régénère un TC déjà indexé (généré en masse, avant
    // même validation — voir persistTestCase() dans llm.service.ts), sa
    // propre entrée est déjà dans generation_history_entries. Une édition
    // ciblée qui reste volontairement proche du contenu d'origine matchait
    // alors contre elle-même avec un score proche de 100%, et était rejetée
    // comme "trop similaire" — écartant l'instruction au lieu de l'appliquer.
    // excludeTestId permet d'écarter cette entrée avant de choisir le
    // meilleur candidat.
    excludeTestId?: string;
  }): Promise<{
    isDuplicate: boolean;
    similarId?: string;
    score?: number;
    similarTitle?: string;
    similarTC?: any;
    source: 'history';
  }> {
    try {
      const queryText = this.buildText(tc);

      // ── Cache lookup — clé incluant le contenu du TC candidat ────────────
      // Sans le contenu, deux angles différents partageraient la même clé et
      // le second obtiendrait un faux cache-hit basé sur le résultat du premier.
      this._cacheStats.historyCalls++;
      const cacheKey = this._cacheKey(tc.requirementId, tc.projectId, queryText);
      const cached = this._historySearchCache.get(cacheKey);
      if (cached !== undefined) {
        this._cacheStats.historyHits++;
        this.logger.log(`🎯 [VECTOR CACHE HIT] isSimilarInHistory — clé: ${cacheKey} (${this._cacheStats.historyHits}/${this._cacheStats.historyCalls} hits)`);
        return cached;
      }
      // ─────────────────────────────────────────────────────────────────────


      const queryVector = await this.embeddingService.embed(queryText);

      // 🔍 Log le vecteur de requête
      if (!queryVector || queryVector.length === 0) {
        this.logger.warn(`⚠️ [generation_history] Query vector is EMPTY — cannot perform search`);
        return { isDuplicate: false, source: 'history', score: 0 };
      }
      this.logger.log(`📊 [generation_history] Query vector: ${queryVector.length} dimensions`);

      let requirementObjectId: ObjectId;
      let projectObjectId: ObjectId;

      try {
        requirementObjectId = new ObjectId(tc.requirementId);
      } catch {
        this.logger.warn(`MongoVector isSimilarInHistory: requirementId invalide: ${tc.requirementId}`);
        return { isDuplicate: false, source: 'history' };
      }

      try {
        projectObjectId = new ObjectId(tc.projectId);
      } catch {
        this.logger.warn(`MongoVector isSimilarInHistory: projectId invalide: ${tc.projectId}`);
        return { isDuplicate: false, source: 'history' };
      }

      this.logger.log(`🔧 [VECTOR SEARCH] Filters — project: ${projectObjectId.toHexString()}, requirement: ${requirementObjectId.toHexString()}`);

      // Atlas Vector Search sur generation_history_entries
      // Index : "generation_history_vector_index"
      // Les filtres doivent être des ObjectIds en format hex string
      let results: any[];
      try {
        results = await (this.prisma.generationHistoryEntry as any).aggregateRaw({
          pipeline: [
            {
              $vectorSearch: {
                index: 'generation_history_vector_index',
                path: 'embedding',
                queryVector,
                numCandidates: 20,
                limit: 3,
                filter: {
                  project_id: { $oid: projectObjectId.toHexString() },
                  requirement_id: { $oid: requirementObjectId.toHexString() },
                },
              },
            },
            {
              $project: {
                _id: 1,
                test_id: 1,
                title: 1,
                preconditions: 1,
                steps: 1,
                test_data: 1,
                expected_result: 1,
                type: 1,
                priority: 1,
                score: { $meta: 'vectorSearchScore' },
              },
            },
          ],
        });
      } catch (err: any) {
        this.logger.error(`❌ [VECTOR SEARCH] MongoDB error: ${err.message}`);
        this.logger.error(`   Error code: ${err.code}`);
        this.logger.error(`   This might mean the "generation_history_vector_index" doesn't exist on Atlas`);
        return { isDuplicate: false, source: 'history', score: 0 };
      }

      // ⚠️ FIX : on écarte l'entrée du TC en cours d'édition avant toute
      // sélection — voir commentaire sur excludeTestId ci-dessus.
      if (tc.excludeTestId) {
        results = (results || []).filter((r: any) => r.test_id !== tc.excludeTestId);
      }

      let score: number = 0;
      if (!results || results.length === 0) {
        this.logger.log(`🔎 [generation_history] Aucun résultat trouvé — Score: 0.000`);
        return { isDuplicate: false, source: 'history', score: 0 };
      }

      // Afficher tous les résultats avec leurs scores
      this.logger.log(`🔎 [generation_history] ${results.length} résultat(s) trouvé(s):`);

      // Seuil adaptatif selon la densité de l'historique
      const tcCount = await this._getSafeHistoryCount(tc.requirementId);
      const adaptiveThreshold = this._adaptiveHistoryThreshold(tcCount);

      results.forEach((r, i) => {
        const scoreVal: number = r.score ?? 0;
        this.logger.log(`   ${i + 1}. «${r.title}» — Score: ${scoreVal.toFixed(3)} (${Math.round(scoreVal * 100)}%) ${scoreVal >= adaptiveThreshold ? '⚠️ HISTORY_THRESHOLD' : ''}`);
      });

      const best = results[0];
      score = best.score ?? 0;

      if (score >= adaptiveThreshold) {
        // Logger le rejet pour le suivi de saturation
        this._logRejection(tc.requirementId, score, true);

        const result: HistorySearchResult = {
          isDuplicate: true,
          similarId: best._id?.$oid || best._id,
          score,
          similarTitle: best.title,
          similarTC: {
            title: best.title,
            preconditions: best.preconditions || [],
            steps: best.steps || [],
            testData: best.test_data || best.testData || [],
            expectedResult: best.expected_result || best.expectedResult || '',
            type: best.type || 'positive',
            priority: best.priority || 'MEDIUM',
          },
          source: 'history',
        };
        this._historySearchCache.set(cacheKey, result);
        this.logger.log(`💾 [VECTOR CACHE SET] isSimilarInHistory — clé: ${cacheKey} (isDuplicate: true, score: ${score.toFixed(3)}, threshold: ${adaptiveThreshold})`);
        return result;
      }

      // Accepté — logger aussi pour le suivi de saturation
      this._logRejection(tc.requirementId, score, false);
      const notDupResult: HistorySearchResult = { isDuplicate: false, source: 'history', score };
      this._historySearchCache.set(cacheKey, notDupResult);
      this.logger.log(`💾 [VECTOR CACHE SET] isSimilarInHistory — clé: ${cacheKey} (isDuplicate: false, score: ${score.toFixed(3)}, threshold: ${adaptiveThreshold})`);
      return notDupResult;
    } catch (err: any) {
      this.logger.warn(`MongoVector isSimilarInHistory failed: ${err.message} — skip history dedup`);
      // On ne cache PAS les erreurs pour permettre un retry
      return { isDuplicate: false, source: 'history', score: 0 };
    }
  }

  // ── Ajouter / mettre à jour un TC avec son embedding dans test_cases ────────

  async addTestCase(tc: {
    testId: string;
    title: string;
    steps: string[];
    requirementId: string;
    moduleId: string;
    projectId: string;
    preconditions?: string[];
    testData?: string[];
    expectedResult?: string;
    type?: string;
    priority?: string;
  }): Promise<void> {
    try {
      const text = this.buildText(tc);
      const embedding = await this.embeddingService.embed(text);

      await this.prisma.testCase.updateMany({
        where: { test_id: tc.testId },
        data: { embedding },
      });

      this.logger.log(`📌 Embedding mis à jour pour TC : ${tc.testId}`);
    } catch (err: any) {
      this.logger.warn(`MongoVector addTestCase failed: ${err.message}`);
    }
  }

  // ── Normaliser un array en strings uniquement ──────────────────────────────────
  private ensureStringArray(items: any): string[] {
    if (!Array.isArray(items)) return [];
    return items
      .map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
          // Extract action from step objects { stepNumber, action, data }
          if (item.action) return String(item.action).trim();
          if (item.value) return String(item.value).trim();
          if (item.content) return String(item.content).trim();
          // Try any string property
          const val = Object.values(item).find((v: any) => typeof v === 'string');
          if (val) return String(val).trim();
        }
        return String(item).trim();
      })
      .filter(s => s.length > 0);
  }

  // ── Indexer un TC complet dans GenerationHistoryEntry ───────────────────────
  //
  // Appelé depuis project.service.ts après chaque régénération (même si rejeté).
  // Génère l'embedding et insère une entrée dans generation_history_entries.

  async addToHistoryIndex(tc: {
    testId?: string;
    test_id?: string;
    title: string;
    preconditions: string[];
    steps: string[];
    testData: string[];
    expectedResult: string;
    type: string;
    priority: string;
    requirementId: string;  // ObjectId
    projectId: string;      // ObjectId
    reqId: string;          // req_id métier (FR-01)
  }): Promise<void> {
    try {
      // Correction : mapping automatique et vérification explicite
      const testId = tc.testId || tc.test_id;
      if (!testId) {
        throw new Error('Argument manquant : testId (ou test_id) est requis pour l’indexation dans GenerationHistoryEntry');
      }
      const normalizedSteps = this.ensureStringArray(tc.steps);
      const text = this.buildText({ title: tc.title, steps: normalizedSteps });
      const embedding = await this.embeddingService.embed(text);

      if (!embedding || embedding.length === 0) {
        this.logger.warn(`⚠️ [HISTORY INDEX] Embedding VIDE pour TC: "${testId}" — L'insertion ne sera pas utile pour la recherche vectorielle`);
      } else {
        this.logger.log(`✅ [HISTORY INDEX] Embedding généré: ${embedding.length} dimensions pour TC: "${testId}"`);
      }

      await this.prisma.generationHistoryEntry.create({
        data: {
          project_id:     tc.projectId,
          requirement_id: tc.requirementId,
          req_id:         tc.reqId,
          test_id:        testId,
          title:          tc.title,
          preconditions:  this.ensureStringArray(tc.preconditions),
          steps:          this.ensureStringArray(tc.steps),
          test_data:      this.ensureStringArray(tc.testData),
          expected_result: tc.expectedResult,
          type:           tc.type,
          priority:       tc.priority,
          embedding,
        },
      });

      this.logger.log(`📚 [HISTORY INDEX] TC indexé dans GenerationHistoryEntry: "${tc.title}" (${testId})`);

      // ── Invalider le cache history pour ce requirement ────────────────────
      // La clé inclut désormais le contenu du TC → on efface toutes les entrées
      // dont la clé commence par "projectId:requirementId:" pour ce requirement.
      const keyPrefix = `${tc.projectId}:${tc.requirementId}`;
      let invalidated = 0;
      for (const key of this._historySearchCache.keys()) {
        if (key.startsWith(keyPrefix)) {
          this._historySearchCache.delete(key);
          invalidated++;
        }
      }
      if (invalidated > 0) {
        this.logger.log(`🗑️  [VECTOR CACHE INVALIDATED] ${invalidated} entrée(s) — nouveau TC indexé, prochaine recherche sera fraîche`);
      }

    } catch (err: any) {
      this.logger.warn(`MongoVector addToHistoryIndex failed: ${err.message}`);
    }
  }

  // ── Récupérer les titres existants pour un projet + exigence ─────────────

  async getExistingTitles(requirementId: string, projectId: string): Promise<string[]> {
    try {
      let requirementObjectId: ObjectId;
      try {
        requirementObjectId = new ObjectId(requirementId);
      } catch {
        this.logger.warn(`MongoVector getExistingTitles: requirementId n'est pas un ObjectId valide: ${requirementId}`);
        return [];
      }
      const tcs = await this.prisma.testCase.findMany({
        where: { requirement_id: requirementObjectId.toHexString() },
        select: { title: true },
      });
      return tcs.map((tc) => tc.title);
    } catch (err: any) {
      this.logger.warn(`MongoVector getExistingTitles failed: ${err.message}`);
      return [];
    }
  }

  // ── Récupérer les TCs COMPLETS depuis generation_history_entries ────────
  // Pour envoyer au LLM avec TOUS les détails (steps, preconditions, etc.)

  async getExistingTestCasesFromHistory(requirementId: string, projectId: string): Promise<any[]> {
    try {
      let requirementObjectId: ObjectId;
      let projectObjectId: ObjectId;
      
      try {
        requirementObjectId = new ObjectId(requirementId);
      } catch {
        this.logger.warn(`MongoVector getExistingTestCasesFromHistory: requirementId invalide: ${requirementId}`);
        return [];
      }

      try {
        projectObjectId = new ObjectId(projectId);
      } catch {
        this.logger.warn(`MongoVector getExistingTestCasesFromHistory: projectId invalide: ${projectId}`);
        return [];
      }

      // Récupérer TOUS les TCs complets depuis generation_history_entries
      const historyEntries = await this.prisma.generationHistoryEntry.findMany({
        where: {
          project_id: projectObjectId.toHexString(),
          requirement_id: requirementObjectId.toHexString(),
        },
        select: {
          test_id: true,
          title: true,
          preconditions: true,
          steps: true,
          test_data: true,
          expected_result: true,
          type: true,
          priority: true,
        },
      });

      // Formatter pour présentation lisible au LLM
      return historyEntries.map((tc: any) => ({
        testId: tc.test_id,
        title: tc.title,
        type: tc.type,
        priority: tc.priority,
        preconditions: tc.preconditions || [],
        steps: tc.steps || [],
        testData: tc.test_data || [],
        expectedResult: tc.expected_result || '',
      }));
    } catch (err: any) {
      this.logger.warn(`MongoVector getExistingTestCasesFromHistory failed: ${err.message}`);
      return [];
    }
  }

  // ── Supprimer l'embedding d'un TC (reset à vide) ────────────────────────

  async removeTestCase(testId: string, projectId: string = 'default'): Promise<void> {
    try {
      await this.prisma.testCase.updateMany({
        where: { test_id: testId },
        data: { embedding: [] },
      });
      this.logger.log(`🗑️  Embedding supprimé pour TC : ${testId}`);
    } catch (err: any) {
      this.logger.warn(`MongoVector removeTestCase failed: ${err.message}`);
    }
  }

  // ── Reset tous les embeddings d'un projet ────────────────────────────────

  async clearAll(): Promise<void> {
    try {
      const updated = await this.prisma.testCase.updateMany({
        data: { embedding: [] },
      });
      this.logger.log(`🗑️  ${updated.count} embeddings TC réinitialisés`);
    } catch (err: any) {
      this.logger.warn(`MongoVector clearAll failed: ${err.message}`);
    }
  }

  // ── Texte représentatif du TC pour l'embedding ────────────────────────────

  public buildText(tc: { title: string; steps: string[] }): string {
    return `${tc.title}. ${tc.steps.join('. ')}`;
  }
}