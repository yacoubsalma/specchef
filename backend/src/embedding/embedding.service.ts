import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LangfuseService } from '../shared/langfuse.service';

/**
 * EmbeddingService
 * ─────────────────
 * Service partagé pour générer des embeddings via Ollama (nomic-embed-text).
 *
 * Optimisations v2 :
 *  1. Cache LRU en mémoire (MAX_CACHE_SIZE entrées) — évite de réembedder
 *     le même texte plusieurs fois dans un même pipeline multi-angles.
 *     Gain typique : ~38s → ~0ms pour les angles 2+ si texte déjà vu.
 *  2. keep_alive étendu (10 min) — empêche Ollama de décharger nomic-embed-text
 *     entre deux appels LLM (qwen) et embedding, éliminant le model-swap de ~30s.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly ollamaUrl: string;
  private readonly model = 'nomic-embed-text'; // 768 dimensions

  // Cache LRU simple : Map conserve l'ordre d'insertion, on évince les plus anciens
  private readonly MAX_CACHE_SIZE = 256;
  private readonly _embedCache = new Map<string, number[]>();

  constructor(
    private configService: ConfigService,
    private readonly langfuseService: LangfuseService,
  ) {
    this.ollamaUrl = this.configService.get<string>('OLLAMA_URL') || 'http://localhost:11434';
  }

  /**
   * Générer un embedding pour un seul texte.
   * Retourne un tableau de 768 floats.
   * Résultat mis en cache en mémoire pour la durée de vie du process.
   */
  /**
   * Générer un embedding pour un seul texte.
   * Retourne un tableau de 768 floats.
   * Résultat mis en cache en mémoire pour la durée de vie du process.
   *
   * @param type 'query' | 'document' — nomic-embed-text est un modèle asymétrique :
   *   il attend un préfixe "search_query: " pour les requêtes de recherche et
   *   "search_document: " pour les textes indexés, afin d'aligner les deux espaces
   *   vectoriels et améliorer la pertinence du retrieval. Omis (undefined) = pas de
   *   préfixe, pour ne pas changer le comportement des usages existants (dédup, etc.).
   */
  async embed(text: string, type?: 'query' | 'document'): Promise<number[]> {
    const prefixed = type === 'query'
      ? `search_query: ${text}`
      : type === 'document'
        ? `search_document: ${text}`
        : text;

    // ── Cache hit ── clé incluant le type pour ne pas mélanger les espaces query/document
    const cacheKey = type ? `${type}:${text}` : text;
    const cached = this._embedCache.get(cacheKey);
    if (cached) {
      // Rafraîchit la position LRU en réinsérant
      this._embedCache.delete(cacheKey);
      this._embedCache.set(cacheKey, cached);
      return cached;
    }

    // ── Trace Langfuse ────────────────────────────────────────────────────
    // Un appel réel (cache miss) = une trace autonome, car EmbeddingService
    // est appelé depuis des contextes sans trace parente (dedup, vector
    // search, indexation d'historique). Best-effort : ne doit jamais faire
    // échouer l'embedding lui-même si Langfuse est down.
    let generation: any;
    try {
      const trace = this.langfuseService.client.trace({
        name: 'embedding',
        metadata: { type: type ?? 'default', textLength: text.length },
      });
      generation = trace?.generation({
        name: 'nomic-embed-text',
        model: this.model,
        input: [{ role: 'user', content: prefixed.slice(0, 500) }],
        metadata: { type: type ?? 'default' },
      });
    } catch {
      // Langfuse indisponible — on continue sans tracer, jamais bloquant.
    }

    try {
      const response = await fetch(`${this.ollamaUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: prefixed,
          // Garde nomic-embed-text chargé 10 min dans Ollama →
          // élimine le model-swap (~30-40s) entre appels LLM (qwen) et embed.
          keep_alive: '10m',
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();

      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid embedding response from Ollama');
      }

      const embedding = data.embedding as number[];

      // ── Mise en cache LRU ──────────────────────────────────────────────
      if (this._embedCache.size >= this.MAX_CACHE_SIZE) {
        // Évince la plus ancienne entrée (première clé de la Map)
        const firstKey = this._embedCache.keys().next().value;
        this._embedCache.delete(firstKey);
      }
      this._embedCache.set(cacheKey, embedding);

      generation?.end({
        output: `embedding[${embedding.length}]`,
        level: 'DEFAULT',
        statusMessage: `✓ nomic-embed-text — ${embedding.length} dims`,
      });

      return embedding;
    } catch (err: any) {
      this.logger.error(`❌ Embedding failed for text "${text.slice(0, 60)}...": ${err.message}`);
      generation?.end({
        level: 'ERROR',
        statusMessage: `✗ nomic-embed-text failed: ${err.message}`,
      });
      throw err;
    }
  }

  /**
   * Pré-charger nomic-embed-text dans Ollama sans utiliser le résultat.
   * À appeler en parallèle d'un appel LLM long (Phase A/B avec qwen) pour
   * éviter le model-swap (~30s) quand on a besoin de l'embed juste après.
   */
  async warmUpEmbeddingModel(hintText: string = 'warm'): Promise<void> {
    try {
      await this.embed(hintText);
    } catch {
      // Silencieux — le warm-up est best-effort
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}