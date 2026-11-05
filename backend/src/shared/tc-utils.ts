/**
 * ─── TC UTILS — Utilitaires partagés pour les Test Cases ─────────────────────
 *
 * Fonctions partagées entre llm.service.ts et project.service.ts.
 *
 * Exports :
 *   - GENERIC_PH          — ensemble des placeholders génériques interdits
 *   - levenshtein()       — distance d'édition
 *   - isTitleTooClose()   — garde synchrone légère (exact-match + levenshtein ≤ 4)
 *                           La déduplication sémantique complète est dans SemanticDeduplicator
 *   - safeParseJson()     — parsing JSON robuste (handles truncated/fenced JSON)
 *   - validateTestCase()  — validation structurelle d'un TC
 *   - isAngleCovered()    — vérifie si un angle est déjà couvert
 *   - runWithConcurrency() — pool de concurrence
 *   - buildExistingTCs()  — construit la liste dédupliquée des TcSnapshot
 *   - buildForbiddenTitles() — construit la liste des titres interdits
 *   - extractExistingTypes() — extrait les types déjà couverts
 *   - filterHistoryTitles()  — filtre les titres d'historique déjà présents
 *
 * CHANGELOG :
 *   - Fix 3 : isTitleTooClose() réduite à exact-match + Levenshtein ≤ 4 uniquement.
 *     L'overlap lexical 70% est supprimé — il causait des faux positifs sur des
 *     domaines à vocabulaire dense (registration, email, password, account…).
 *     La déduplication sémantique complète est désormais dans SemanticDeduplicator
 *     (shared/semantic-dedup.service.ts) via nomic-embed-text cosine similarity.
 */

// ─── Placeholders génériques interdits ────────────────────────────────────────

export const GENERIC_PH = new Set([
  '[PLACEHOLDER_NAME]', '[PLACEHOLDER]', '[VALUE]', '[DATA]', '[INPUT]',
  '[FIELD_VALUE]', '[FIELD_NAME]', '[BUTTON]', '[PAGE]', '[OUTCOME]',
  '[TEXT]', '[RESULT]', '[ACTION]', '[ITEM]', '[OPTION]', '[LABEL]',
  '[FIELD]', '[MSG]', '[URL]', '[PATH]',
  // [NAME] et [TYPE] retirés — placeholders légitimes pour champs boundary générés par qwen
  // Ex: "Enter [NAME] with exactly 50 chars" est sémantiquement correct
]);

// ─── Levenshtein ──────────────────────────────────────────────────────────────

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

/**
 * Garde synchrone légère — utilisée UNIQUEMENT dans validateTestCase().
 *
 * ⚠️  DEPRECATED pour tout appel direct depuis LlmService.
 *     Utiliser await semanticDedup.isTooClose() à la place.
 *
 * Cette version ne fait que :
 *   1. Correspondance exacte normalisée
 *   2. Levenshtein ≤ 4 sur titres courts (anti-typo uniquement)
 *
 * L'ancien overlap 70% est SUPPRIMÉ — il rejetait des TCs légitimes partageant
 * le même vocabulaire de domaine (register, email, account, password…).
 */
export function isTitleTooClose(candidate: string, existing: string[]): boolean {
  const c = candidate.toLowerCase().trim();

  return existing.some(e => {
    const ev = e.toLowerCase().trim();

    // 1. Correspondance exacte
    if (c === ev) return true;

    // 2. Levenshtein très court — anti-typo seulement, pas anti-sémantique
    //    Seuil réduit à 4 (était 6) pour éviter les faux positifs résiduels
    if (c.length <= 60 && ev.length <= 60 && levenshtein(c, ev) <= 4) return true;

    return false;
  });
}

// ─── Safe JSON parsing ────────────────────────────────────────────────────────

/**
 * Tente de parser un JSON potentiellement malformé ou tronqué.
 * Gère : fences markdown, JSON partiel, accolades non fermées.
 * Retourne null si le parsing échoue complètement.
 */
/**
 * Découpe une liste séparée par virgules en respectant les guillemets — une
 * simple `inner.split(',')` casserait sur les virgules qui apparaissent DANS
 * une valeur textuelle (ex: "Address, City, Country").
 */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, inStr = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { i++; cur += s[i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

export function safeParseJson(raw: string): any | null {
  if (!raw) return null;

  // Fix 1 — garde de type : safeParseJson doit toujours recevoir une string.
  // Si le LLM retourne un objet déjà parsé (cas rare mais observé avec certains
  // adaptateurs Ollama), on le retourne directement sans tenter JSON.parse.
  if (typeof raw !== 'string') {
    if (typeof raw === 'object' && raw !== null) return raw;
    return null;
  }

  let clean = raw.trim().replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) clean = fence[1].trim();

  const firstBrace = clean.indexOf('{');
  if (firstBrace === -1) return null;
  clean = clean.slice(firstBrace);

  // ⚠️ Erreur récurrente et 100% déterministe de qwen2.5-coder:7b (vu en prod
  // sur Phase B, toujours reproduite car PHASE_B_OPTIONS.temperature = 0) :
  // un champ censé être un tableau (ex: "testData") est encadré par des
  // accolades d'objet au lieu de crochets, ex:
  //   "testData": { "KEY: val", "KEY2: val2" }   ← invalide (pas de "clé": valeur)
  // au lieu de
  //   "testData": [ "KEY: val", "KEY2: val2" ]
  // On ne convertit que si le contenu est UNIQUEMENT une liste de strings
  // sans aucune paire "clé": valeur à l'intérieur — un vrai objet JSON valide
  // n'est jamais touché.
  clean = clean.replace(/:(\s*)\{([^{}]*)\}/g, (match, ws, inner) => {
    const trimmedInner = inner.trim();
    if (trimmedInner === '') return match;
    const looksLikeArrayOfStrings = /^"(?:[^"\\]|\\.)*"(\s*,\s*"(?:[^"\\]|\\.)*")*\s*,?$/.test(trimmedInner);
    const hasKeyValuePairs = /"(?:[^"\\]|\\.)*"\s*:/.test(trimmedInner);
    if (looksLikeArrayOfStrings && !hasKeyValuePairs) {
      return `:${ws}[${inner}]`;
    }
    return match;
  });

  // ⚠️ Variante plus vicieuse du même problème, vue aussi en prod : un objet
  // avec un mélange de vraies paires "clé": "valeur" ET une (ou plusieurs)
  // string orpheline "CLE: valeur" glissée au milieu sans son ":" JSON — le
  // repair ci-dessus l'ignore volontairement (il détecte de vraies paires et
  // laisse l'objet intact pour ne jamais toucher un objet réellement valide).
  // On répare ici chaque entrée orpheline en la scindant sur son premier ": "
  // interne pour la transformer en vraie paire clé/valeur.
  clean = clean.replace(/\{([^{}]*)\}/g, (match, inner) => {
    if (!/"(?:[^"\\]|\\.)*"\s*:/.test(inner)) return match; // pas un objet — déjà géré ci-dessus
    const items = splitTopLevelCommas(inner);
    let changed = false;
    const fixedItems = items.map((item) => {
      const trimmed = item.trim();
      if (/^"(?:[^"\\]|\\.)*"\s*:/.test(trimmed)) return item;
      const bare = trimmed.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (bare) {
        const content = bare[1];
        const colonIdx = content.indexOf(': ');
        if (colonIdx !== -1) {
          const key = content.slice(0, colonIdx).trim().replace(/"/g, '\\"');
          const val = content.slice(colonIdx + 2).trim().replace(/"/g, '\\"');
          changed = true;
          return ` "${key}": "${val}"`;
        }
      }
      return item;
    });
    return changed ? `{${fixedItems.join(',')}}` : match;
  });

  try { return JSON.parse(clean); } catch { /* continue */ }

  for (let i = clean.length - 1; i >= 0; i--) {
    if (clean[i] === '}') { try { return JSON.parse(clean.slice(0, i + 1)); } catch { /* continue */ } }
  }

  const openBraces  = (clean.match(/\{/g) || []).length;
  const closeBraces = (clean.match(/\}/g) || []).length;
  const missing     = openBraces - closeBraces;
  if (missing > 0) {
    const completed = clean.trimEnd().replace(/,\s*$/, '') + '}'.repeat(missing);
    try { return JSON.parse(completed); } catch { /* give up */ }
  }

  return null;
}

/**
 * Variante qui lève une erreur au lieu de retourner null.
 * Utilisée dans project.service.ts (_safeParseJson).
 */
export function safeParseJsonOrThrow(raw: string): any {
  const result = safeParseJson(raw);
  if (result === null) {
    // ⚠️ Avant : message générique "LLM returned invalid JSON" sans le texte
    // brut → impossible de savoir si c'est tronqué (num_predict trop bas),
    // noyé dans de la prose, ou juste cassé. On logue maintenant un aperçu
    // (longueur totale + 300 premiers/derniers caractères) pour diagnostiquer
    // sans devoir reproduire l'appel.
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const preview = text.length > 600
      ? `${text.slice(0, 300)} …[${text.length - 600} chars omis]… ${text.slice(-300)}`
      : text;
    throw new Error(`LLM returned invalid JSON (${text.length} chars) — raw: ${preview}`);
  }
  return result;
}

// ─── Validation structurelle d'un TC ─────────────────────────────────────────

export interface TcSnapshot {
  title:    string;
  steps?:   string[];
  testData?: string[];
  type?:    string;
}

// ─── Détection de contradictions préconditions vs businessRules ────────────────

/**
 * Détecte si une précondition contredit une règle métier.
 * 
 * Patterns de contradiction :
 *   - "admin|manager|super" vs "only job seekers|guest access only"
 *   - "logged in|authenticated" vs "not logged in|guest"
 *   - "[FIELD] is allowed" vs "[FIELD] is forbidden|prohibited|disabled"
 *   - "premium|paid|subscription" vs "free|trial|no subscription"
 */
function hasContradiction(precondition: string, businessRule: string): boolean {
  const preL = (precondition || '').toLowerCase();
  const ruleL = (businessRule || '').toLowerCase();

  // Patterns de contradictions explicites
  const contradictionPairs = [
    // Role-based
    [['admin', 'manager', 'super'], ['job seeker', 'guest', 'user', 'only users', 'non-admin']],
    [['logged in', 'authenticated', 'auth'], ['not logged in', 'guest', 'unauthenticated', 'anon']],
    [['owner', 'creator'], ['non-owner', 'non-creator', 'other user']],
    
    // Permission-based
    [['allowed', 'permitted', 'can'], ['forbidden', 'prohibited', 'disabled', 'rejected', 'blocked']],
    [['enabled', 'active'], ['disabled', 'inactive', 'deactivated']],
    
    // Subscription / Plan
    [['premium', 'paid', 'subscription'], ['free', 'trial', 'no subscription', 'freemium']],
    [['trial'], ['paid', 'premium', 'licensed']],
    
    // Account status
    [['locked', 'suspended', 'banned'], ['active', 'unlocked', 'normal', 'enabled']],
    [['verified', 'confirmed'], ['unverified', 'pending', 'not confirmed']],
    
    // Access level
    [['public'], ['private', 'restricted', 'confidential']],
    [['internal'], ['external', 'public', 'open']],
  ];

  for (const [leftPatterns, rightPatterns] of contradictionPairs) {
    const leftMatch = leftPatterns.some(p => preL.includes(p));
    const rightMatch = rightPatterns.some(p => ruleL.includes(p));
    if (leftMatch && rightMatch) return true;

    // Symétrique : vérifie aussi dans l'autre sens
    const rightMatch2 = leftPatterns.some(p => ruleL.includes(p));
    const leftMatch2 = rightPatterns.some(p => preL.includes(p));
    if (leftMatch2 && rightMatch2) return true;
  }

  return false;
}

/**
 * Valide les préconditions contre les règles métier.
 * Retourne la liste des contradictions détectées.
 */
export function validatePreconditionsAgainstBusinessRules(
  preconditions: string[] = [],
  businessRules: string[] = [],
): string[] {
  if (!preconditions.length || !businessRules.length) return [];

  const contradictions: string[] = [];

  for (const pre of preconditions) {
    if (!pre || typeof pre !== 'string') continue;

    for (const rule of businessRules) {
      if (!rule || typeof rule !== 'string') continue;

      if (hasContradiction(pre, rule)) {
        contradictions.push(
          `Precondition contradicts business rule: "${pre}" vs "${rule}"`
        );
      }
    }
  }

  return contradictions;
}

// ─── Validation structurelle d'un TC ─────────────────────────────────────────

export function validateTestCase(
  tc: Partial<Record<string, any>>,
  existingTitles: string[] = [],
  businessRules: string[] = [],
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Fix 1 — gardes de type sur steps et testData avant tout .match() ou .filter()
  // Le LLM peut retourner des tableaux contenant des non-strings (objets, null…)
  const rawSteps    = Array.isArray(tc['steps'])    ? tc['steps']    : [];
  const rawTestData = Array.isArray(tc['testData']) ? tc['testData'] : [];
  const rawPreconditions = Array.isArray(tc['preconditions']) ? tc['preconditions'] : [];

  // Coercition : on ne traite que les strings, on ignore silencieusement le reste
  const steps    = rawSteps.map((s: any) => (typeof s === 'string' ? s : String(s ?? '')));
  const testData = rawTestData.map((d: any) => (typeof d === 'string' ? d : String(d ?? '')));
  const preconditions = rawPreconditions.map((p: any) => (typeof p === 'string' ? p : String(p ?? '')));

  // 1. Vérifier les contradictions préconditions vs businessRules
  if (businessRules.length > 0) {
    const contradictions = validatePreconditionsAgainstBusinessRules(preconditions, businessRules);
    issues.push(...contradictions);
  }

  // 2. Placeholder génériques
  const allPH = steps.flatMap((s: string) => (s.match(/\[[A-Z_\s]+\]/g) || []));
  const genericFound = allPH.filter((p: string) => GENERIC_PH.has(p.toUpperCase().trim()));
  if (genericFound.length > 0)
    issues.push(`Generic placeholder names (must be semantic): ${[...new Set(genericFound)].join(', ')}`);

  // 3. Étapes commençant par un placeholder
  const stepsStartPH = steps.filter((s: string) => /^\s*\[/.test(s));
  if (stepsStartPH.length > 0)
    issues.push(`Steps must start with a verb, not a placeholder: ${stepsStartPH.slice(0, 2).map((s: string) => `"${s.slice(0, 60)}"`).join(' | ')}`);

  // 4. Placeholders non couverts par testData
  const testDataKeys = testData
    .map((d: string) => { const m = d.match(/^([^:]+):/); return m ? `[${m[1].trim().toUpperCase().replace(/\s+/g, '_')}]` : null; })
    .filter(Boolean) as string[];
  const uncovered = allPH.filter((p: string) => !testDataKeys.includes(p));
  if (uncovered.length > 0) issues.push(`Uncovered placeholders: ${uncovered.join(', ')}`);

  // 5. Dernière étape = vérification
  // Couvre les verbes standards + formulations fréquentes du LLM (observe, expect, the system...)
  const lastStep = steps[steps.length - 1] || '';
  if (!/^(verify|assert|check|ensure|confirm|validate|observe|expect|the system|result should|system should|user should)/i.test(lastStep.trim()))
    issues.push('Last step is not a verification');

  // 6. Nombre d'étapes
  if (steps.length < 2 || steps.length > 10)
    issues.push(`Invalid step count: ${steps.length} (expected 2-10)`);

  // 7. Données brutes dans les étapes
  const dataInSteps = steps.filter((s: string) => {
    if (/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/.test(s)) return true;
    if (/https?:\/\//.test(s)) return true;
    if (/\b\d{6,}\b/.test(s)) return true;
    if (/\s\/[a-zA-Z]/.test(s) && !/\[/.test(s)) return true;
    if (/\b\d+(\.\d+)?\s*(KB|MB|GB|ko|Mo|Go)\b/i.test(s)) return true;
    if (/\b[\w\-]+\.(pdf|docx|txt|png|jpg|jpeg|csv|xlsx|zip|doc)\b/i.test(s) && !/\[/.test(s)) return true;
    return false;
  });
  if (dataInSteps.length > 0)
    issues.push(`Raw data values in steps: ${dataInSteps.slice(0, 2).map((s: string) => `"${s.slice(0, 80)}"`).join(' | ')}`);

  // 8. Déduplication des titres — garde synchrone légère (exact-match + levenshtein ≤ 4)
  //    La déduplication sémantique complète est faite en amont via SemanticDeduplicator.
  if (tc['title'] && existingTitles.length > 0 && isTitleTooClose(tc['title'], existingTitles))
    issues.push(`Title too similar to an existing TC: "${tc['title']}"`);

  return { valid: issues.length === 0, issues };
}

// ─── isAngleCovered ───────────────────────────────────────────────────────────

export function isAngleCovered(
  angle: { focus: string },
  existingTCs: TcSnapshot[],
): boolean {
  const focusTokens = angle.focus
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 4);

  if (focusTokens.length < 4) return false;

  for (const tc of existingTCs) {
    const tcText = [tc.title, ...(tc.steps ?? []), ...(tc.testData ?? [])]
      .join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const overlap = focusTokens.filter(t => tcText.includes(t)).length;
    if (overlap / focusTokens.length >= 0.80) return true;
  }
  return false;
}

// ─── Pool de concurrence ──────────────────────────────────────────────────────

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) break;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── buildExistingTCs ─────────────────────────────────────────────────────────

export function buildExistingTCs(
  sources: Array<any[]>,
  seen: Set<string> = new Set<string>(),
): { existingTCs: TcSnapshot[]; seen: Set<string> } {
  const existingTCs: TcSnapshot[] = [];
  for (const list of sources) {
    for (const tc of list ?? []) {
      const norm = (tc.title ?? '').toLowerCase().trim();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      existingTCs.push({
        title:    tc.title,
        steps:    Array.isArray(tc.steps)    ? tc.steps    : [],
        testData: Array.isArray(tc.test_data)
          ? tc.test_data
          : Array.isArray(tc.testData)
            ? tc.testData
            : [],
        type: tc.type ?? 'positive',
      });
    }
  }
  return { existingTCs, seen };
}

// ─── buildForbiddenTitles ─────────────────────────────────────────────────────

export function buildForbiddenTitles(
  existingTCs: TcSnapshot[],
  historyTitles: string[],
): string[] {
  return Array.from(
    new Set<string>([...existingTCs.map(tc => tc.title), ...historyTitles]),
  ).filter(Boolean);
}

// ─── extractExistingTypes ─────────────────────────────────────────────────────

export function extractExistingTypes(existingTCs: TcSnapshot[]): string[] {
  return [...new Set(existingTCs.map(tc => tc.type).filter(Boolean))];
}

// ─── filterHistoryTitles ──────────────────────────────────────────────────────

export function filterHistoryTitles(
  rawTitles: string[],
  seen: Set<string>,
): string[] {
  return rawTitles.filter(t => !seen.has(t.toLowerCase().trim()));
}

// ─── getDedupeThreshold ───────────────────────────────────────────────────────

/**
 * Seuil de déduplication sémantique (cosine similarity nomic-embed-text)
 * adapté au type de test case.
 *
 * Seuil plus bas (plus strict) = plus de déduplication
 * Seuil plus haut (plus permissif) = moins de déduplication
 *
 * Rationale :
 *   - positive (0.90) : strict, mais laisse passer des variantes réelles
 *   - boundary (0.90) : "7 chars" vs "8 chars" sont distincts (score ~0.977)
 *   - negative (0.93) : "email vide" vs "email sans @" sur champs différents sont acceptés
 *   - security/edge_case (0.92) : comportement par défaut
 *   - default (0.90) : fallback raisonnable
 */
/**
 * Retourne le seuil de déduplication sémantique pour un type de TC.
 *
 * SEUILS PAR TYPE :
 *   positive  0.93 — relevé car les TCs positifs boundary-like ont des titres structurellement
 *                    proches ("at exact min length (2)" vs "at exact max length (50)")
 *   boundary  0.95 — "min (8 chars)" vs "max (64 chars)" ont score ~0.94 mais testent
 *                    des valeurs opposées → ne pas bloquer
 *   negative  0.93 — deux champs différents ont parfois des titres proches
 *   security/edge_case 0.92
 *
 * GUARD NUMÉRIQUE : si les deux titres contiennent des nombres distincts, on relève
 * le seuil effectif à 0.97 — deux TCs qui diffèrent par la valeur exacte testée
 * (ex: "5 chars" vs "8 chars", "8 digits" vs "15 digits") sont toujours distincts.
 */
export function getDedupeThreshold(
  tcType?: string,
  candidateTitle?: string,
  existingTitle?: string,
): number {
  // Guard numérique : si les titres contiennent des nombres distincts → seuil très haut
  if (candidateTitle && existingTitle) {
    const numsInCandidate = (candidateTitle.match(/\d+/g) ?? []).map(Number).sort((a,b)=>a-b);
    const numsInExisting  = (existingTitle.match(/\d+/g)  ?? []).map(Number).sort((a,b)=>a-b);
    const hasDifferentNumbers =
      numsInCandidate.length > 0 &&
      numsInExisting.length > 0 &&
      JSON.stringify(numsInCandidate) !== JSON.stringify(numsInExisting);
    if (hasDifferentNumbers) return 0.97;
  }

  switch (tcType?.toLowerCase()) {
    case 'positive':  return 0.93;
    case 'boundary':  return 0.95;
    case 'negative':  return 0.93;
    case 'security':
    case 'edge_case': return 0.92;
    default:          return 0.90;
  }
}