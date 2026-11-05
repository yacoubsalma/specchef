/**
 * ─── OLLAMA CLIENT — Client HTTP partagé ─────────────────────────────────────
 *
 * Centralise l'appel HTTP à l'API Ollama /api/chat.
 * Intègre Langfuse pour tracer chaque appel LLM avec les tokens input/output.
 */

import axios from 'axios';

export interface OllamaOptions {
  temperature:    number;
  num_predict:    number;
  num_ctx:        number;
  top_k:          number;
  top_p:          number;
  repeat_penalty: number;
  repeat_last_n?: number;
  min_p?:         number;
  seed?:          number;   // seed fixe → reproductibilité entre appels
  format?:        'json';   // force la sortie JSON structurée côté Ollama
  keep_alive?:    string;   // ex: '10m' — évite le déchargement du modèle entre deux appels rapprochés
}

// ─── Présets d'options ────────────────────────────────────────────────────────

export const PHASE_A_OPTIONS: OllamaOptions = {
  temperature:    0.2,
  num_predict:    2000,
  num_ctx:        6144,
  top_k:          40,
  top_p:          0.9,
  repeat_penalty: 1.15,
  repeat_last_n:  64,
};

export const PHASE_B_OPTIONS: OllamaOptions = {
  temperature:    0,
  num_predict:    900,
  num_ctx:        6144,
  top_k:          20,
  top_p:          0.85,
  repeat_penalty: 1.15,
  repeat_last_n:  128,
  min_p:          0.05,
};

export const PHASE_A_SINGLE_OPTIONS: OllamaOptions = {
  temperature:    0.3,
  num_predict:    300,
  num_ctx:        3072,
  top_k:          40,
  top_p:          0.9,
  repeat_penalty: 1.15,
  repeat_last_n:  64,
};

export const PHASE_B_SINGLE_OPTIONS: OllamaOptions = {
  temperature:    0,
  num_predict:    900,
  num_ctx:        5120,
  top_k:          20,
  top_p:          0.85,
  repeat_penalty: 1.15,
  repeat_last_n:  128,
  min_p:          0.05,
};

export const PHASE_A_RECOVERY_OPTIONS: OllamaOptions = {
  temperature:    0.2,
  num_predict:    600,   // rattrapage = 4-6 angles courts, pas besoin de 2000
  num_ctx:        3072,  // existingTCs = titres seuls, prompt léger
  top_k:          40,
  top_p:          0.9,
  repeat_penalty: 1.15,
  repeat_last_n:  64,
};

// ─── Presets dédiés à la régénération (_runRegenPipeline uniquement) ───────────
//
// Séparés de PHASE_A_OPTIONS/PHASE_B_OPTIONS pour ne PAS impacter la
// génération initiale ni la génération d'un TC seul, qui gardent leur
// comportement d'origine à l'identique. Ici : `format: 'json'` (contraint
// Ollama à un décodage JSON syntaxiquement valide — plus de commentaires
// `//`, plus d'accolades à la place de crochets, etc.) et un num_predict
// relevé (troncatures observées en prod sur des scénarios verbeux : grands
// nombres, focus longs).
export const PHASE_A_REGEN_OPTIONS: OllamaOptions = {
  temperature:    0.2,
  num_predict:    2000, // inchangé par rapport à PHASE_A_OPTIONS — la troncature observée venait de Phase B (grands nombres dans testData), pas de Phase A (angles courts). Un num_predict plus élevé ici ne faisait qu'allonger l'appel jusqu'à cogner LLM_CALL_TIMEOUT_MS (120s).
  num_ctx:        6144,
  top_k:          40,
  top_p:          0.9,
  repeat_penalty: 1.15,
  repeat_last_n:  64,
  format:         'json',
  // ⚠️ Timeouts observés en prod (Phase A ET B > 120s) : nomic-embed-text a
  // keep_alive:'10m' (embedding.service.ts) mais qwen n'en avait aucun — sur
  // une machine qui ne garde qu'un modèle en mémoire à la fois, chaque appel
  // de vérification de similarité (embedding, appelé après Phase B) éjecte
  // qwen, qui doit ensuite être rechargé à froid (~30-40s, déjà documenté
  // ailleurs dans le code) pour la tentative suivante. Sur un cycle régén
  // avec plusieurs allers-retours, ça peut suffire à dépasser 120s.
  keep_alive:     '10m',
};

export const PHASE_B_REGEN_OPTIONS: OllamaOptions = {
  temperature:    0,
  num_predict:    1300,
  num_ctx:        6144,
  top_k:          20,
  top_p:          0.85,
  repeat_penalty: 1.15,
  repeat_last_n:  128,
  min_p:          0.05,
  format:         'json',
  keep_alive:     '10m',
};

// ─── Estimation du budget de TC (combien de TC ont un sens pour cette exigence) ──
//
// Appelé UNE FOIS par exigence, AVANT Phase A. Réponse attendue très courte
// ({"recommended_total": N, "applicable_types": [...]}) → num_predict faible
// suffit largement. Objectif : éviter de viser aveuglément MIN_TC_PER_REQ (20)
// avec 8 types fixes pour des exigences simples où security/concurrency/
// integration/state_transition n'ont structurellement aucun scénario possible
// (voir le rattrapage qui échoue systématiquement à 0 résultat dans ce cas —
// historique du 06/07/2026). Cet appel coûte ~10-20s ; en échange, il évite un
// aller-retour de rattrapage complet (~70-100s) systématiquement voué à
// l'échec, ET une Phase A initiale qui ne réclame plus des types absents.
export const TC_BUDGET_ESTIMATE_OPTIONS: OllamaOptions = {
  temperature:    0,
  num_predict:    200,   // {"recommended_total":N,"applicable_types":[...]} tient largement dedans
  num_ctx:        3072,
  top_k:          20,
  top_p:          0.85,
  repeat_penalty: 1.1,
  repeat_last_n:  64,
};

export const PHASE_AB_FAST_OPTIONS: OllamaOptions = {
  temperature:    0,
  num_predict:    700,
  num_ctx:        4096,
  top_k:          20,
  top_p:          0.85,
  repeat_penalty: 1.15,
  repeat_last_n:  128,
  min_p:          0.05,
};

export const SELF_CRITIQUE_OPTIONS: OllamaOptions = {
  temperature:    0,
  num_predict:    800,
  num_ctx:        5120,
  top_k:          20,
  top_p:          0.85,
  repeat_penalty: 1.1,
  repeat_last_n:  64,
  min_p:          0.05,
};

export const VERIFY_OPTIONS: OllamaOptions = {
  temperature:    0,
  num_predict:    900,
  num_ctx:        5120,
  top_k:          20,
  top_p:          0.85,
  repeat_penalty: 1.1,
  repeat_last_n:  64,
  min_p:          0.05,
};

// ─── Interface Langfuse (optionnelle, évite d'importer langfuse partout) ───────

export interface LangfuseSpan {
  generation: (params: {
    name: string;
    model: string;
    input: Array<{ role: string; content: string }>;
    metadata?: Record<string, any>;
  }) => {
    end: (params: {
      output?: string | null;
      usage?: { input?: number; output?: number; unit?: string };
      level?: string;
      statusMessage?: string;
      metadata?: Record<string, any>;
    }) => void;
  };
}

// ─── Client Ollama ─────────────────────────────────────────────────────────────

/**
 * Envoie une requête chat à Ollama et retourne la réponse brute.
 * Si un `langfuseTrace` est fourni, chaque appel est tracé automatiquement
 * avec les tokens input/output retournés par Ollama.
 *
 * @param ollamaUrl     — URL de base (ex: http://localhost:11434)
 * @param model         — nom du modèle
 * @param userMessage   — contenu du message utilisateur
 * @param signal        — AbortSignal pour timeout externe
 * @param systemPrompt  — prompt système
 * @param options       — options LLM
 * @param langfuseTrace — trace Langfuse parente (optionnel)
 * @param generationName— nom affiché dans Langfuse (ex: "phase-a", "phase-b")
 */
export async function callOllama(
  ollamaUrl:      string,
  model:          string,
  userMessage:    string,
  signal?:        AbortSignal,
  systemPrompt:   string = 'You are a JSON API. Output ONLY raw valid JSON. No prose, no markdown, no code fences.',
  options:        OllamaOptions = PHASE_B_OPTIONS,
  langfuseTrace?: LangfuseSpan,
  generationName: string = 'ollama-call',
): Promise<any> {
  const previewText = (value: string, maxLength: number = 240): string => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
  };

  const countLines = (value: string): number => {
    if (!value) return 0;
    return value.split(/\r?\n/).length;
  };

  const requestMetadata = {
    'request.url': ollamaUrl,
    'request.model': model,
    'request.generation_name': generationName,
    'request.system_prompt_chars': systemPrompt.length,
    'request.system_prompt_lines': countLines(systemPrompt),
    'request.system_prompt_preview': previewText(systemPrompt, 220),
    'request.user_message_chars': userMessage.length,
    'request.user_message_lines': countLines(userMessage),
    'request.user_message_preview': previewText(userMessage, 320),
  };

  // ── Créer le span Langfuse AVANT l'appel ─────────────────────────────────
  const langfuseGeneration = langfuseTrace?.generation({
    name:  `[${model}] ${generationName}`,
    model,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage  },
    ],
    metadata: {
      // Afficher tous les paramètres importants pour faciliter le debug
      ...requestMetadata,
      'llm.temperature':     options.temperature,
      'llm.num_predict':     options.num_predict,
      'llm.num_ctx':         options.num_ctx,
      'llm.top_k':           options.top_k,
      'llm.top_p':           options.top_p,
      'llm.repeat_penalty':  options.repeat_penalty,
      'llm.repeat_last_n':   options.repeat_last_n,
      ...(options.min_p !== undefined && { 'llm.min_p': options.min_p }),
    },
  });

  let data: any = null;
  const startedAt = Date.now();

  try {
    // ── Use axios instead of fetch for better timeout control ──
    // Axios timeout is in milliseconds and can be set to any value we want (no 5-min hard limit)
    // Use signal if provided, otherwise rely on axios timeout
    const response = await axios.post(
      `${ollamaUrl}/api/chat`,
      {
        model,
        stream: false,
        ...(options.format ? { format: options.format } : {}),
        ...(options.keep_alive ? { keep_alive: options.keep_alive } : {}),
        options: {
          temperature:    options.temperature,
          num_predict:    options.num_predict,
          num_ctx:        options.num_ctx,
          top_k:          options.top_k,
          top_p:          options.top_p,
          repeat_penalty: options.repeat_penalty,
          repeat_last_n:  options.repeat_last_n,
          ...(options.min_p !== undefined ? { min_p: options.min_p } : {}),
        },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage  },
        ],
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15 * 60 * 1000,  // 15 minutes (no more 5-min fetch hard limit)
        signal,  // AbortSignal from caller can still abort early
      },
    );

    data = response.data;

    // ── Envoyer les tokens à Langfuse ──────────────────────
    // prompt_eval_count et eval_count sont à la RACINE de data
    if (langfuseGeneration) {
      const inputTokens  = data?.prompt_eval_count ?? 0;
      const outputTokens = data?.eval_count ?? 0;
      const totalTokens  = inputTokens + outputTokens;
      const content = data?.message?.content ?? null;
      const contentText = typeof content === 'string' ? content : '';
      
      langfuseGeneration.end({
        output: content,
        usage: {
          input:  inputTokens,
          output: outputTokens,
          unit:   'TOKENS',
        },
        level: 'DEFAULT',
        statusMessage: `✓ Complété | tokens input: ${inputTokens}, output: ${outputTokens}, total: ${totalTokens}`,
        metadata: {
          ...requestMetadata,
          'response.ok': true,
          'response.status_code': response.status,
          'response.content_chars': contentText.length,
          'response.content_lines': countLines(contentText),
          'response.content_preview': previewText(contentText, 400),
          'response.has_think_tag': /<think>[\s\S]*?<\/think>/i.test(contentText),
          'response.model': data?.model ?? model,
          'response.created_at': data?.created_at ?? null,
          'response.duration_ms': Date.now() - startedAt,
          'usage.tokens.input': inputTokens,
          'usage.tokens.output': outputTokens,
          'usage.tokens.total': totalTokens,
        },
      });
    }

    return data;

  } catch (err: any) {
    // Notifier Langfuse de l'erreur si generation pas encore fermée
    if (langfuseGeneration && !data) {
      let errorType = 'unknown_error';
      let details = err.message;

      if (err.name === 'AbortError' || err.name === 'CanceledError' || err.message === 'canceled') {
        errorType = 'timeout';
        details = 'Request timeout (AbortError/CanceledError)';
      } else if (err.code === 'ECONNREFUSED') {
        errorType = 'connection_refused';
        details = 'Ollama service not reachable';
      } else if (err.code === 'ENOTFOUND') {
        errorType = 'dns_error';
        details = 'Cannot resolve Ollama host';
      } else if (err.code === 'ECONNRESET' || err.code?.includes('socket')) {
        errorType = 'socket_error';
        details = 'Network socket error';
      } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
        errorType = 'network_timeout';
        details = 'Network operation timeout';
      } else if (err.response?.status) {
        errorType = 'http_error';
        details = `HTTP ${err.response.status}: ${err.response.statusText}`;
      }

      langfuseGeneration.end({
        level:         'ERROR',
        statusMessage: `✗ ${errorType}: ${details}`,
        metadata: {
          ...requestMetadata,
          'response.ok': false,
          'response.error_type': errorType,
          'response.error_message': details,
          'response.error_code': err.code ?? err.name ?? 'Error',
          'usage.tokens.input': 0,
          'usage.tokens.output': 0,
          'usage.tokens.total': 0,
          'duration_ms': Date.now() - startedAt,
        },
      });
    }

    if (err.name === 'AbortError' || err.name === 'CanceledError' || err.message === 'canceled')
      throw new Error('timeout');
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND')
      throw new Error(`connection_error: ${err.message}`);
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')
      throw new Error(`network_error: ${err.message}`);
    if (err.response?.status === 404 || err.message?.includes('not found'))
      throw new Error(`model_not_found: ${err.message}`);
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')
      throw new Error(`timeout: Ollama request exceeded timeout`);
    throw err;
  }
}

/**
 * Variante retournant directement le texte parsé (pour project.service).
 */
export async function callOllamaAndParse(
  ollamaUrl:    string,
  model:        string,
  userMessage:  string,
  signal?:      AbortSignal,
  systemPrompt?: string,
  options:       OllamaOptions = PHASE_B_OPTIONS,
  timeoutMs:     number = 45_000,
  langfuseTrace?: LangfuseSpan,
  generationName: string = 'ollama-parse',
): Promise<any> {
  const { safeParseJsonOrThrow } = await import('./tc-utils');

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), timeoutMs);
  const combinedSignal = signal ?? controller.signal;

  try {
    const data = await callOllama(
      ollamaUrl, model, userMessage, combinedSignal,
      systemPrompt, options,
      langfuseTrace, generationName,
    );
    const raw = (data?.message?.content || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return safeParseJsonOrThrow(raw);
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error('LLM call timeout');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}