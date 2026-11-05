import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Période "métier" sélectionnable pour l'aperçu Langfuse (voir getOverview). */
export type OverviewPeriod = 'today' | 'week' | 'month';

/**
 * LangfuseAdminService — proxy serveur-à-serveur vers l'API publique Langfuse
 * (https://api.reference.langfuse.com).
 *
 * ⚠️ Les clés Langfuse (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY) ne
 * quittent JAMAIS le backend. Le frontend n'appelle que les endpoints de
 * LangfuseAdminController, protégés par @Roles(Role.ADMIN), qui eux-mêmes
 * appellent Langfuse avec les credentials serveur (Basic Auth).
 *
 * Toutes les méthodes acceptent les query params bruts attendus par
 * l'API Langfuse (page, limit, filtres...) et renvoient la réponse JSON
 * telle quelle — la mise en forme est faite côté frontend.
 */
@Injectable()
export class LangfuseAdminService {
  private readonly logger = new Logger(LangfuseAdminService.name);
  private readonly baseUrl: string;
  private readonly authHeader: string | null;

  constructor(private readonly config: ConfigService) {
    const publicKey = this.config.get<string>('LANGFUSE_PUBLIC_KEY');
    const secretKey = this.config.get<string>('LANGFUSE_SECRET_KEY');
    this.baseUrl = this.config.get<string>('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com');

    if (!publicKey || !secretKey) {
      this.logger.warn('⚠️  Langfuse keys missing — le dashboard admin Langfuse sera indisponible');
      this.authHeader = null;
    } else {
      this.authHeader = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
    }
  }

  /** URL publique du dashboard Langfuse (pour le lien "Ouvrir dans Langfuse ↗") */
  getDashboardUrl(): { baseUrl: string } {
    return { baseUrl: this.baseUrl };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request<T = any>(
    path: string,
    query?: Record<string, string | number | undefined>,
    attempt = 1,
  ): Promise<T> {
    if (!this.authHeader) {
      throw new HttpException(
        'Langfuse non configuré (clés manquantes côté serveur)',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const url = new URL(`/api/public${path}`, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
      });
    } catch (err: any) {
      this.logger.error(`❌ [Langfuse] Échec réseau vers ${url.pathname}: ${err.message}`);
      throw new HttpException('Impossible de joindre Langfuse', HttpStatus.BAD_GATEWAY);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`⚠️  [Langfuse] ${res.status} sur ${url.pathname} — ${body.slice(0, 200)}`);
      if (res.status === 429) {
        // Langfuse elle-même rate-limite l'API publique. Avant, on n'avait que
        // 2 appels par overview donc ça n'arrivait presque jamais ; avec la
        // pagination sur toute une période (7/30 jours), on peut vite envoyer
        // une rafale de requêtes. On retente donc 3 fois avec un backoff
        // (respectant Retry-After si Langfuse le fournit) avant d'abandonner.
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
        // On ne retente en bloquant la requête QUE si l'attente demandée est
        // courte (≤ 5s). Langfuse a renvoyé ~55s dans les logs : re-tenter en
        // bloquant sur une telle durée (x2 tentatives) fait pendre la requête
        // HTTP entière 1 à 2 minutes — c'est justement ce qui rendait la page
        // "trop longue à s'ouvrir". Au-delà de 5s, on échoue tout de suite
        // avec un message clair plutôt que de faire attendre l'utilisateur en
        // silence.
        // Relevé de 5s à 12s : maintenant qu'une période tient quasiment
        // toujours en 1 seule requête (grosses pages sur /v2/observations),
        // le risque de faire attendre l'utilisateur longtemps est bien plus
        // faible, donc on peut se permettre d'absorber un 429 occasionnel
        // (ex: plusieurs onglets/périodes interrogés coup sur coup) plutôt
        // que de renvoyer directement une erreur.
        const maxBlockingWaitMs = 12000;
        const maxAttempts = 3;
        const canRetryBlocking = retryAfterMs === null || retryAfterMs <= maxBlockingWaitMs;
        if (attempt < maxAttempts && canRetryBlocking) {
          const backoffMs = retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : attempt * 800;
          this.logger.warn(`⏳ [Langfuse] 429 sur ${url.pathname} — nouvel essai dans ${backoffMs}ms (tentative ${attempt + 1}/${maxAttempts})`);
          await this.sleep(backoffMs);
          return this.request<T>(path, query, attempt + 1);
        }
        const waitSeconds = retryAfterHeader ?? 'quelques';
        throw new HttpException(
          `Trop de requêtes envoyées à Langfuse — réessaie dans ${waitSeconds} secondes.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new HttpException(`Langfuse a renvoyé ${res.status}`, res.status === 401 || res.status === 403 ? HttpStatus.BAD_GATEWAY : res.status);
    }

    return res.json();
  }

  /**
   * Interroge le Metrics API natif de Langfuse (`GET /api/public/metrics`).
   * ⚠️ C'est le MÊME moteur d'agrégation que celui utilisé par l'UI Langfuse
   * pour "Total Count Traces", "Appels par modèle", coûts, tokens, latence...
   * En passant par cet endpoint plutôt qu'en reconstruisant nous-mêmes les
   * totaux à partir de pages d'observations, les chiffres affichés côté app
   * correspondent EXACTEMENT à ceux du dashboard Langfuse (même filtre,
   * même fenêtre de temps, même calcul serveur — pas de plafond de
   * pagination silencieux, pas de traces sans génération oubliées).
   *
   * Réponse Langfuse : { data: [{ ...dimensions, "<agg>_<measure>": "123" }] }
   * — les valeurs numériques sont renvoyées en string, d'où le parseNumber
   * appliqué par les appelants.
   */
  private async queryMetrics(query: {
    view: 'traces' | 'observations' | 'scores-numeric' | 'scores-categorical' | 'scores-boolean';
    dimensions?: Array<{ field: string }>;
    metrics: Array<{ measure: string; aggregation: string }>;
    filters?: Array<{ column: string; operator: string; value: any; type: string; key?: string }>;
    timeDimension?: { granularity: 'hour' | 'day' | 'week' | 'month' | 'auto' };
    fromTimestamp: string;
    toTimestamp: string;
    orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  }): Promise<{ data: any[] }> {
    return this.request('/metrics', { query: JSON.stringify(query) });
  }

  // ── Traces ────────────────────────────────────────────────────────────
  listTraces(query: {
    page?: number; limit?: number; userId?: string; name?: string;
    sessionId?: string; tags?: string; fromTimestamp?: string; toTimestamp?: string;
    orderBy?: string;
  }) {
    return this.request('/traces', query);
  }

  /**
   * Comme listTraces, mais enrichit chaque ligne avec le nombre de tokens
   * consommés (`totalTokens`). Langfuse ne renvoie pas ce champ directement
   * sur l'objet trace (il vit sur les observations).
   *
   * ⚠️ Ne PAS faire un appel getTrace() par ligne ici (N+1) : ça consomme le
   * quota de requêtes de l'API publique Langfuse très vite et déclenche des
   * 429 (rate limit). À la place, un seul appel groupé vers /observations,
   * filtré sur la fenêtre de temps couverte par la page de traces — c'est
   * exactement ce que Langfuse recommande pour les lectures en volume.
   */
  async listTracesWithTokens(query: {
    page?: number; limit?: number; userId?: string; name?: string;
    sessionId?: string; tags?: string; fromTimestamp?: string; toTimestamp?: string;
    orderBy?: string;
  }) {
    const page = await this.listTraces(query);
    const items: any[] = page?.data ?? [];

    if (items.length === 0) {
      return { ...page, data: items };
    }

    const timestamps = items.map((t) => t.timestamp).filter(Boolean).sort();
    const fromStartTime = timestamps[0];
    // +1 minute de marge sur la borne haute pour couvrir les observations qui démarrent juste après le timestamp de la trace
    const toStartTime = new Date(new Date(timestamps[timestamps.length - 1]).getTime() + 60_000).toISOString();

    let observations: any[] = [];
    try {
      // ⚠️ Avant : un seul appel `limit: 100` — si la fenêtre de temps couverte
      // par cette page de traces contenait plus de 100 observations GENERATION
      // (pic d'activité, traces avec beaucoup de générations…), les tokens des
      // observations au-delà de la 100e étaient silencieusement ignorés, ce
      // qui pouvait afficher un total de tokens faux (ou null) sur certaines
      // lignes de l'historique, sans aucune erreur visible. On parcourt
      // maintenant toutes les pages nécessaires pour couvrir toute la fenêtre.
      observations = await this.fetchAllPages<any>('/observations', {
        type: 'GENERATION',
        fromStartTime,
        toStartTime,
      }, 1000, 100);
    } catch (err) {
      // Si l'appel groupé échoue (ex: encore rate-limited), on renvoie les traces sans les tokens plutôt que de planter la page
      this.logger.warn(`⚠️  [Langfuse] Impossible d'enrichir les tokens (fallback sans tokens): ${(err as Error).message}`);
      return { ...page, data: items.map((t) => ({ ...t, totalTokens: null })) };
    }

    const tokensByTrace = new Map<string, number>();
    for (const o of observations) {
      if (!o.traceId) continue;
      const tokens = o.usage?.totalTokens ?? (o.promptTokens ?? 0) + (o.completionTokens ?? 0);
      tokensByTrace.set(o.traceId, (tokensByTrace.get(o.traceId) ?? 0) + tokens);
    }

    const enriched = items.map((t) => ({ ...t, totalTokens: tokensByTrace.get(t.id) ?? null }));

    return { ...page, data: enriched };
  }

  getTrace(id: string) {
    return this.request(`/traces/${encodeURIComponent(id)}`);
  }

  // ── Scores ───────────────────────────────────────────────────────────
  listScores(query: { page?: number; limit?: number; traceId?: string; userId?: string }) {
    return this.request('/scores', query);
  }

  /**
   * Récupère toutes les pages d'un endpoint Langfuse paginé, jusqu'à `maxItems`
   * ou jusqu'à épuisement des pages. Nécessaire dès qu'on filtre par période
   * (from/to) plutôt que par un simple `limit` : une semaine ou un mois
   * d'activité peut largement dépasser une seule page de 100 items, et s'en
   * tenir à la première page biaiserait les KPIs vers les items les plus
   * récents de la fenêtre plutôt que la fenêtre entière.
   *
   * ⚠️ Les endpoints `/v2/*` (ex: `/v2/observations`) utilisent une pagination
   * par CURSEUR : la réponse renvoie `meta.cursor` (pas `meta.totalPages`), et
   * il faut renvoyer ce curseur tel quel dans la requête suivante — envoyer un
   * numéro de `page` ne fait rien avancer, l'API renvoie alors indéfiniment le
   * même premier lot. Les endpoints v1 (`/traces`, `/observations`, `/scores`)
   * restent en pagination par page/`meta.totalPages`. On détecte donc le mode
   * à partir du chemin, et on suit le bon protocole dans chaque cas — sinon on
   * plafonne silencieusement à la première page (100 items) dès qu'une période
   * contient plus d'activité que ça, faussant tous les KPIs à la baisse.
   */
  private async fetchAllPages<T = any>(
    path: string,
    baseQuery: Record<string, string | number | undefined>,
    maxItems = 1000,
    pageSize = 100,
  ): Promise<T[]> {
    const isCursorBased = path.startsWith('/v2/');
    const items: T[] = [];

    if (isCursorBased) {
      let cursor: string | undefined;
      while (items.length < maxItems) {
        const res = await this.request<any>(path, { ...baseQuery, limit: pageSize, cursor });
        const data: T[] = res?.data ?? [];
        items.push(...data);
        const nextCursor: string | null | undefined = res?.meta?.cursor;
        if (data.length === 0 || !nextCursor) break;
        cursor = nextCursor;
        // Petite pause entre deux pages : évite d'envoyer une rafale de requêtes
        // qui déclencherait le rate-limit de l'API publique Langfuse (429).
        await this.sleep(200);
      }
      return items.slice(0, maxItems);
    }

    let page = 1;
    while (items.length < maxItems) {
      const res = await this.request<any>(path, { ...baseQuery, page, limit: pageSize });
      const data: T[] = res?.data ?? [];
      items.push(...data);
      const totalPages = res?.meta?.totalPages ?? page;
      if (data.length === 0 || page >= totalPages) break;
      page++;
      // Petite pause entre deux pages : évite d'envoyer une rafale de requêtes
      // qui déclencherait le rate-limit de l'API publique Langfuse (429).
      await this.sleep(200);
    }
    return items.slice(0, maxItems);
  }

  /**
   * Traduit une période "métier" (aujourd'hui / 7 jours / 30 jours) en bornes
   * de dates exploitables par l'API Langfuse (fromTimestamp/toTimestamp), et
   * décide de la granularité des graphiques : "aujourd'hui" est trop court
   * pour un découpage par jour (1 jour ⇒ 1 seul point) — on découpe donc par
   * heure dans ce cas, et par jour pour "7 jours"/"30 jours".
   */
  private getPeriodRange(period: OverviewPeriod): {
    fromTimestamp: string;
    toTimestamp: string;
    granularity: 'hour' | 'day';
    bucketCount: number;
  } {
    const now = new Date();
    const toTimestamp = now.toISOString();

    // "Aujourd'hui" : alignement calendaire sur minuit heure locale du
    // serveur (comme avant) — confirmé correspondre à ce qu'affiche Langfuse
    // pour ce préréglage, donc on NE touche PAS à cette branche.
    if (period === 'today') {
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return { fromTimestamp: startOfToday.toISOString(), toTimestamp, granularity: 'hour', bucketCount: 24 };
    }

    // "7 jours" / "30 jours" : fenêtre GLISSANTE en epoch ms (`now - N×24h`),
    // comme le préréglage correspondant de Langfuse — c'est ici, et
    // uniquement ici, qu'était le décalage (790 vs 619) : l'ancien calcul
    // combinait un alignement calendaire sur minuit local ET une conversion
    // en UTC, ce qui décalait la fenêtre d'une journée entière selon le
    // fuseau du serveur.
    const days = period === 'month' ? 30 : 7;
    const fromTimestamp = new Date(now.getTime() - days * 86_400_000).toISOString();
    return { fromTimestamp, toTimestamp, granularity: 'day', bucketCount: days };
  }

  /**
   * Agrège les KPIs (coût, latence, volume, erreurs) sur une vraie fenêtre
   * calendaire (aujourd'hui / 7 jours / 30 jours), et pas sur un simple
   * "top N traces les plus récentes" — sinon la période réellement couverte
   * dépend uniquement du volume d'usage (peu d'usage ⇒ tout tient dans une
   * seule journée ⇒ un seul point sur les courbes "par jour").
   */
  async getOverview(period: OverviewPeriod = 'week') {
    const { fromTimestamp, toTimestamp, granularity, bucketCount } = this.getPeriodRange(period);

    // Toutes les valeurs ci-dessous viennent du Metrics API natif de Langfuse
    // (voir queryMetrics) — c'est le même moteur d'agrégation que celui qui
    // alimente leur propre dashboard, donc "Total Count Traces", "Appels par
    // modèle", coût, tokens et latence correspondent EXACTEMENT aux chiffres
    // affichés côté Langfuse. On ne reconstruit plus rien nous-mêmes à partir
    // de pages d'observations : plus de plafond de pagination silencieux,
    // plus de traces sans génération oubliées, plus de bucket "modèle vide"
    // fabriqué par notre propre code.
    const num = (v: any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const numOrNull = (v: any): number | null => (v === undefined || v === null ? null : num(v));

    const GENERATION_FILTER = [{ column: 'type', operator: '=', value: 'GENERATION', type: 'string' as const }];

    // ── "Total Count Traces" — identique à l'UI Langfuse (view: traces, count) ─
    const tracesCountResp = await this.queryMetrics({
      view: 'traces',
      metrics: [{ measure: 'count', aggregation: 'count' }],
      dimensions: [],
      filters: [],
      fromTimestamp,
      toTimestamp,
    });
    const totalTracesInPage = num(tracesCountResp?.data?.[0]?.count_count);

    // ── "Appels par modèle" — regroupé par providedModelName, même moteur ────
    // que Langfuse (même bucket "sans nom" s'il existe côté Langfuse aussi).
    const byModelResp = await this.queryMetrics({
      view: 'observations',
      metrics: [
        { measure: 'count', aggregation: 'count' },
        { measure: 'totalCost', aggregation: 'sum' },
        { measure: 'totalTokens', aggregation: 'sum' },
      ],
      dimensions: [{ field: 'providedModelName' }],
      filters: GENERATION_FILTER,
      fromTimestamp,
      toTimestamp,
    });
    const costByModel = (byModelResp?.data ?? [])
      .map((row: any) => ({
        model: row.providedModelName || 'Inconnu',
        count: num(row.count_count),
        cost: num(row.sum_totalCost),
        tokens: num(row.sum_totalTokens),
      }))
      .sort((a, b) => b.cost - a.cost || b.count - a.count);

    const totalObservationsInPage = costByModel.reduce((sum, m) => sum + m.count, 0);
    const estimatedCostOnSample = costByModel.reduce((sum, m) => sum + m.cost, 0);
    const estimatedTokensOnSample = costByModel.reduce((sum, m) => sum + m.tokens, 0);

    // ── Latence (moyenne + percentiles), calculée par Langfuse elle-même ────
    const latencyResp = await this.queryMetrics({
      view: 'observations',
      metrics: [
        { measure: 'latency', aggregation: 'avg' },
        { measure: 'latency', aggregation: 'p50' },
        { measure: 'latency', aggregation: 'p90' },
        { measure: 'latency', aggregation: 'p99' },
      ],
      dimensions: [],
      filters: GENERATION_FILTER,
      fromTimestamp,
      toTimestamp,
    });
    const latencyRow = latencyResp?.data?.[0] ?? {};
    const avgLatencyMsOnSample = numOrNull(latencyRow.avg_latency);
    const latencyPercentiles = {
      p50: numOrNull(latencyRow.p50_latency),
      p90: numOrNull(latencyRow.p90_latency),
      p99: numOrNull(latencyRow.p99_latency),
    };

    // ── Erreurs (level = ERROR) ──────────────────────────────────────────────
    const errorResp = await this.queryMetrics({
      view: 'observations',
      metrics: [{ measure: 'count', aggregation: 'count' }],
      dimensions: [],
      filters: [...GENERATION_FILTER, { column: 'level', operator: '=', value: 'ERROR', type: 'string' }],
      fromTimestamp,
      toTimestamp,
    });
    const errorCountOnSample = num(errorResp?.data?.[0]?.count_count);

    // ── Tendances par bucket (volume, coût, tokens, latence) ────────────────
    // Langfuse gère lui-même le regroupement temporel via `timeDimension` —
    // granularité horaire pour "aujourd'hui", journalière pour "7/30 jours".
    const trendResp = await this.queryMetrics({
      view: 'observations',
      metrics: [
        { measure: 'count', aggregation: 'count' },
        { measure: 'totalCost', aggregation: 'sum' },
        { measure: 'totalTokens', aggregation: 'sum' },
        { measure: 'latency', aggregation: 'avg' },
      ],
      dimensions: [],
      filters: GENERATION_FILTER,
      timeDimension: { granularity },
      fromTimestamp,
      toTimestamp,
    });

    const bucketMs = granularity === 'hour' ? 3_600_000 : 86_400_000;
    const windowStart = new Date(fromTimestamp).getTime();
    const bucketKeyOf = (bucketStartMs: number) =>
      granularity === 'hour' ? new Date(bucketStartMs).toISOString() : new Date(bucketStartMs).toISOString().slice(0, 10);

    // Zero-fill sur toute la période demandée, même les buckets sans activité
    // (sinon un seul point d'activité donne un seul point sur la courbe au
    // lieu d'une ligne à plat sur la période).
    const bucketMap = new Map<string, { count: number; cost: number; tokens: number; avgLatencyMs: number | null }>();
    for (let i = 0; i < bucketCount; i++) {
      bucketMap.set(bucketKeyOf(windowStart + i * bucketMs), { count: 0, cost: 0, tokens: 0, avgLatencyMs: null });
    }
    for (const row of trendResp?.data ?? []) {
      const rawKey = row.time_dimension;
      if (!rawKey) continue;
      const t = new Date(rawKey).getTime();
      if (Number.isNaN(t)) continue;
      const idx = Math.floor((t - windowStart) / bucketMs);
      if (idx < 0 || idx >= bucketCount) continue;
      const key = bucketKeyOf(windowStart + idx * bucketMs);
      const entry = bucketMap.get(key);
      if (!entry) continue;
      entry.count = num(row.count_count);
      entry.cost = num(row.sum_totalCost);
      entry.tokens = num(row.sum_totalTokens);
      entry.avgLatencyMs = numOrNull(row.avg_latency);
    }

    const dailyVolume = Array.from(bucketMap.entries())
      .map(([date, v]) => ({ date, count: v.count, cost: v.cost, avgLatencyMs: v.avgLatencyMs, errorRate: 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const dailyTokens = Array.from(bucketMap.entries())
      .map(([date, v]) => ({ date, tokens: v.tokens }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // ── Utilisations récentes : 20 dernières traces + leurs tokens ──────────
    const recentTracesRaw = await this.fetchAllPages<any>('/traces', { orderBy: 'timestamp.desc' }, 20, 20);
    let tokensByTrace = new Map<string, number>();
    if (recentTracesRaw.length > 0) {
      const timestamps = recentTracesRaw.map((t) => t.timestamp).filter(Boolean).sort();
      const tokensResp = await this.queryMetrics({
        view: 'observations',
        metrics: [{ measure: 'totalTokens', aggregation: 'sum' }],
        dimensions: [{ field: 'traceId' }],
        filters: GENERATION_FILTER,
        fromTimestamp: timestamps[0],
        toTimestamp: new Date(new Date(timestamps[timestamps.length - 1]).getTime() + 60_000).toISOString(),
      }).catch(() => ({ data: [] }));
      tokensByTrace = new Map((tokensResp?.data ?? []).map((row: any) => [row.traceId, num(row.sum_totalTokens)]));
    }
    const recentTraces = recentTracesRaw.map((t) => ({ ...t, totalTokens: tokensByTrace.get(t.id) ?? null }));

    return {
      period,
      granularity,
      fromTimestamp,
      toTimestamp,
      sampleSize: totalObservationsInPage,
      totalTracesInPage,
      totalObservationsInPage,
      estimatedCostOnSample,
      estimatedTokensOnSample,
      avgLatencyMsOnSample,
      latencyPercentiles,
      errorCountOnSample,
      dailyTokens,
      recentTraces,
      dailyVolume,
      costByModel,
    };
  }
}