/**
 * ─── SOURCE DE VÉRITÉ UNIQUE — Types de Test Cases (Frontend) ────────────────
 *
 * Miroir exact de backend/src/shared/tc-types.ts
 * Si tu ajoutes un type : mets à jour LES DEUX fichiers + testTypeConfig dans page.tsx
 */

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

  // positive + types hors-scope LLM
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

/**
 * Normalise n'importe quelle chaîne vers un TcType valide.
 * Même logique que le backend — résultat toujours dans VALID_TC_TYPES.
 */
export function normalizeTcType(raw: string | undefined | null): TcType {
  const v = (raw || '').toLowerCase().trim().replace(/[-\s]/g, '_');
  if (!v) return 'positive';

  if ((VALID_TC_TYPES as readonly string[]).includes(v)) return v as TcType;
  if (TC_TYPE_ALIASES[v] !== undefined) return TC_TYPE_ALIASES[v];

  if (/^negat/.test(v))                      return 'negative';
  if (/^bound|^border|^threshold/.test(v))   return 'boundary';
  if (/^edge|^corner/.test(v))               return 'edge_case';
  if (/^secur|^auth/.test(v))                return 'security';
  if (/^integrat|^e2e/.test(v))              return 'integration';
  if (/^state|^transit|^workflow/.test(v))   return 'state_transition';
  if (/^concurrent|^parallel|^race/.test(v)) return 'concurrency';

  console.warn(`[normalizeTcType] Type inconnu "${raw}" → fallback 'positive'`);
  return 'positive';
}

/**
 * Configuration UI pour chaque type de TC
 */
export const testTypeConfig: Record<TcType, { color: string; label: string; bg: string; border?: string; cursor?: string }> = {
  positive:         { color: '#0d9488', label: 'Positif',            bg: '#0d948812', border: '#0d948840', cursor: 'pointer' },
  negative:         { color: '#e11d48', label: 'Négatif',            bg: '#e11d4812', border: '#e11d4840', cursor: 'pointer' },
  edge_case:        { color: '#7c3aed', label: 'Cas limite',         bg: '#7c3aed12', border: '#7c3aed40', cursor: 'pointer' },
  boundary:         { color: '#0284c7', label: 'Frontière',          bg: '#0284c712', border: '#0284c740', cursor: 'pointer' },
  out_of_bounds:    { color: '#0891b2', label: 'Hors limites',       bg: '#0891b212', border: '#0891b240', cursor: 'pointer' },
  security:         { color: '#d97706', label: 'Sécurité',           bg: '#d9770612', border: '#d9770640', cursor: 'pointer' },
  integration:      { color: '#2563eb', label: 'Intégration',        bg: '#2563eb12', border: '#2563eb40', cursor: 'pointer' },
  state_transition: { color: '#ca8a04', label: 'Transition d\'état', bg: '#ca8a0412', border: '#ca8a0440', cursor: 'pointer' },
  concurrency:      { color: '#475569', label: 'Concurrence',        bg: '#47556912', border: '#47556940', cursor: 'pointer' },
};
