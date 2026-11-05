/**
 * ─── SOURCE DE VÉRITÉ UNIQUE — Types de Test Cases ───────────────────────────
 *
 * CE FICHIER EST IDENTIQUE DANS LE FRONTEND ET LE BACKEND.
 * Ne modifier qu'ICI — copier ensuite dans l'autre dépôt (ou créer un package partagé).
 *
 * Emplacements :
 *   frontend  → llm-viewer/lib/tc-types.ts
 *   backend   → backend/src/shared/tc-types.ts
 *
 * Règle d'or : si tu ajoutes un type :
 *   1. Ajoute-le dans VALID_TC_TYPES
 *   2. Ajoute les alias courants dans TC_TYPE_ALIASES
 *   3. Ajoute la config UI dans testTypeConfig (frontend seulement)
 *   4. Mets à jour PHASE_B_TYPE_NOTES dans prompt-builders.ts (backend seulement)
 */

// ─── Types valides ─────────────────────────────────────────────────────────────

export const VALID_TC_TYPES = [
  'positive',
  'negative',
  'edge_case',
  'boundary',
  'out_of_bounds',
  'state_transition',
  'security',
  'integration',
  'concurrency',
] as const;

export type TcType = (typeof VALID_TC_TYPES)[number];

// ─── Alias — valeurs produites par les LLM mappées vers un type valide ─────────

export const TC_TYPE_ALIASES: Record<string, TcType> = {
  // edge_case
  'edge':              'edge_case',
  'corner':            'edge_case',
  'corner_case':       'edge_case',
  'unusual':           'edge_case',
  'special':           'edge_case',
  'atypical':          'edge_case',
  'exotic':            'edge_case',

  // negative
  'error':             'negative',
  'error_case':        'negative',
  'invalid':           'negative',
  'invalid_input':     'negative',
  'fail':              'negative',
  'failure':           'negative',
  'rejection':         'negative',
  'exception':         'negative',

  // boundary
  'limit':             'boundary',
  'limit_case':        'boundary',
  'border':            'boundary',
  'border_case':       'boundary',
  'threshold':         'boundary',
  'range':             'boundary',
  'min_max':           'boundary',

  // integration
  'e2e':               'integration',
  'end_to_end':        'integration',
  'contract':          'integration',
  'interop':           'integration',
  'api':               'integration',
  'system':            'integration',

  // state_transition
  'workflow':          'state_transition',
  'lifecycle':         'state_transition',
  'session':           'state_transition',
  'flow':              'state_transition',
  'sequence':          'state_transition',
  'transit':           'state_transition',

  // security
  'auth':              'security',
  'authorization':     'security',
  'authentication':    'security',
  'permission':        'security',
  'access':            'security',
  'privilege':         'security',
  'role':              'security',

  // concurrency
  'concurrent':        'concurrency',
  'parallel':          'concurrency',
  'race':              'concurrency',
  'race_condition':    'concurrency',
  'simultaneous':      'concurrency',

  // auth_* — produits par les scope IDs LLM (auth_login, auth_mfa, etc.)
  'auth_login':            'security',
  'auth_password_policy':  'security',
  'auth_mfa':              'security',
  'auth_session':          'state_transition',
  'auth_rate_limiting':    'security',
  'auth_logout':           'security',
  'auth_token':            'security',
  'auth_oauth':            'security',

  // journey_* — produits par les scope IDs LLM (journey_navigation, journey_multi_step, etc.)
  'journey_navigation':    'state_transition',
  'journey_redirections':  'state_transition',
  'journey_multi_step':    'state_transition',
  'journey_prev_next':     'state_transition',
  'journey_stepper':       'state_transition',

  // crud_* — produits par les scope IDs LLM
  'crud_create':           'integration',
  'crud_read':             'integration',
  'crud_update':           'integration',
  'crud_delete':           'integration',
  'journey_crud_create':   'integration',
  'journey_crud_read':     'integration',
  'journey_crud_update':   'integration',
  'journey_crud_delete':   'integration',

  // optional → champ optionnel non rempli = scénario positif
  'optional':          'positive',
  'optional_field':    'positive',

  // positive + types hors-scope → fallback propre
  'positive':          'positive',
  'happy':             'positive',
  'happy_path':        'positive',
  'valid':             'positive',
  'success':           'positive',
  'normal':            'positive',
  'smoke':             'positive',
  'functional':        'positive',
  'standard':          'positive',
  'regression':        'positive',
  'basic':             'positive',
  'primary':           'positive',
  'performance':       'positive',
  'load':              'positive',
  'stress':            'positive',
  'usability':         'positive',
  'ux':                'positive',
  'accessibility':     'positive',
};

// ─── normalizeTcType ───────────────────────────────────────────────────────────

/**
 * Normalise n'importe quelle chaîne reçue (LLM, base de données, formulaire)
 * vers un TcType valide.
 *
 * Ordre de résolution :
 *  1. La valeur est déjà un type valide  → retour direct
 *  2. La valeur est un alias connu       → retour du type cible
 *  3. Préfixe flou (dernier recours)     → matching partiel ancré
 *  4. Défaut sûr                         → 'positive'
 */
export function normalizeTcType(raw: string | undefined | null): TcType {
  const v = (raw || '').toLowerCase().trim().replace(/[-\s]/g, '_');
  if (!v) return 'positive';

  // 1. Valeur déjà valide
  if ((VALID_TC_TYPES as readonly string[]).includes(v)) return v as TcType;

  // 2. Alias exact connu
  if (TC_TYPE_ALIASES[v] !== undefined) return TC_TYPE_ALIASES[v];

  // 3. Matching partiel ancré (dernier recours pour variantes inattendues)
  if (/^negat/.test(v))                      return 'negative';
  if (/^bound|^border|^threshold/.test(v))   return 'boundary';
  if (/^edge|^corner/.test(v))               return 'edge_case';
  if (/^secur|^auth/.test(v))                return 'security';
  if (/^integrat|^e2e/.test(v))              return 'integration';
  if (/^state|^transit|^workflow/.test(v))   return 'state_transition';
  if (/^concurrent|^parallel|^race/.test(v)) return 'concurrency';

  // 4. Défaut sûr — jamais de valeur brute inconnue vers le frontend
  console.warn(`[normalizeTcType] Type inconnu "${raw}" → fallback 'positive'`);
  return 'positive';
}

// ─── Prompt LLM ───────────────────────────────────────────────────────────────

/**
 * Chaîne prête à être injectée dans un prompt LLM.
 * Garantit que le prompt reflète toujours les types valides actuels.
 */
export const TC_TYPES_FOR_PROMPT: string =
  `Allowed type values: ${VALID_TC_TYPES.join(' | ')}`;

// ─── Constantes de génération ─────────────────────────────────────────────────

/**
 * MIN_TC_PER_REQ : Nombre minimum de test cases à générer par exigence.
 *
 * Distribution Myers-aware (20 angles) :
 *   4 × positive         (happy path + variante rôle + variante données + champ différent)
 *   4 × negative         (email vide, password invalide, champ manquant, règle métier violée)
 *   4 × boundary         (min-1, min, max, max+1 — valeurs numériques exactes)
 *   2 × state_transition (si états mentionnés — sinon edge_case)
 *   2 × security         (accès non autorisé + injection/XSS)
 *   2 × edge_case        (whitespace-only, très long input, unicode)
 *   1 × integration      (service externe : email activation, SMS, webhook)
 *   1 × concurrency      (double soumission simultanée)
 *   = 20 angles distincts et non redondants
 */
export const MIN_TC_PER_REQ = 20;

/**
 * ADAPTIVE_TC_FLOOR : Plancher absolu pour le budget de TC estimé par le LLM
 * (voir LlmService.estimateTcBudget). Le LLM 7B est interrogé en amont pour
 * évaluer combien de TC ont RÉELLEMENT un sens pour l'exigence donnée
 * (au lieu de toujours viser MIN_TC_PER_REQ=20 avec 8 types fixes, y compris
 * security/concurrency/integration/state_transition qui n'existent pas pour
 * une simple validation de formulaire — voir historique du 06/07/2026).
 * On ne descend jamais sous ce plancher, même si le LLM estime moins :
 * ça protège contre une sous-estimation grossière du modèle.
 */
export const ADAPTIVE_TC_FLOOR = 8;

/**
 * MAX_PHASE_A_ANGLES : Limite supérieure d'angles générés en Phase A.
 * Protège contre les boucles infinies et les timeouts.
 */
export const MAX_PHASE_A_ANGLES = 100;

// ─── Configuration UI (frontend uniquement) ───────────────────────────────────
//
// Ce bloc est utilisé dans page.tsx pour le rendu des badges, filtres et selects.
// Il n'est pas importé dans le backend.

export const testTypeConfig: Record<TcType, {
  color:   string;
  label:   string;
  bg:      string;
  border?: string;
  cursor?: string;
}> = {
  positive:         { color: '#34d399', label: '✓ Positive',         bg: '#34d39912', border: '#34d39940', cursor: 'pointer' },
  negative:         { color: '#ef4444', label: '✗ Negative',         bg: '#ef444412', border: '#ef444440', cursor: 'pointer' },
  edge_case:        { color: '#a78bfa', label: '◈ Edge Case',        bg: '#a78bfa12', border: '#a78bfa40', cursor: 'pointer' },
  boundary:         { color: '#38bdf8', label: '⇔ Boundary',         bg: '#38bdf812', border: '#38bdf840', cursor: 'pointer' },
  out_of_bounds:    { color: '#22c55e', label: '↯ Out of Bounds',    bg: '#22c55e12', border: '#22c55e40', cursor: 'pointer' },
  security:         { color: '#fb923c', label: '⚠ Security',         bg: '#fb923c12', border: '#fb923c40', cursor: 'pointer' },
  integration:      { color: '#f472b6', label: '🔗 Integration',      bg: '#f472b612', border: '#f472b640', cursor: 'pointer' },
  state_transition: { color: '#facc15', label: '⟳ State Transition', bg: '#facc1512', border: '#facc1540', cursor: 'pointer' },
  concurrency:      { color: '#60a5fa', label: '⧉ Concurrency',      bg: '#60a5fa12', border: '#60a5fa40', cursor: 'pointer' },
};