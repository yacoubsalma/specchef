/**
 * Scope_catalogue.ts — Source de vérité backend
 *
 * Aligné sur le SCOPE_FEATURES du MyersWizard (frontend).
 * Toute modification du catalogue wizard doit être répercutée ici.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TcType =
  | 'positive' | 'negative' | 'boundary' | 'edge_case'
  | 'security' | 'state_transition' | 'integration' | 'concurrency';

export interface ScopeFeature {
  id:             string;
  label:          string;
  category:       ScopeCategory;
  description:    string;
  preferredTypes: TcType[];
}

export type ScopeCategory =
  | 'form_validation'
  | 'file_handling'
  | 'business_logic'
  | 'journey_flow'
  | 'crud_operations'
  | 'authentication'
  | 'integration_dependencies';

// ─── Catalogue ────────────────────────────────────────────────────────────────

export const SCOPE_CATALOGUE: ScopeFeature[] = [

  // ══ Contrôle de saisie ════════════════════════════════════════════════════

  {
    id: 'form_required_fields',
    label: 'Contrôle de saisie — Champs obligatoires',
    category: 'form_validation',
    description:
      'Vérifie que le formulaire ne peut pas être soumis tant que les champs obligatoires ne ' +
      'sont pas remplis. Les risques à couvrir incluent : un champ absent, plusieurs champs ' +
      'absents simultanément, et une valeur composée uniquement d\'espaces (considérée comme vide ' +
      'si le système effectue un trim). Le cas nominal (tous champs valides → succès) doit ' +
      'également être présent.',
    preferredTypes: ['negative', 'positive', 'edge_case'],
  },

  {
    id: 'form_regex_validation',
    label: 'Contrôle de saisie — Expressions régulières',
    category: 'form_validation',
    description:
      'Vérifie que les champs soumis à un format précis (email, téléphone, code postal…) ' +
      'acceptent les valeurs conformes et rejettent les valeurs non conformes. Chaque angle ' +
      'négatif doit cibler une violation distincte du format. Les cas limites incluent les ' +
      'valeurs valides mais inhabituelles (alias email avec +, caractères Unicode dans un nom).',
    preferredTypes: ['negative', 'positive', 'edge_case'],
  },

  {
    id: 'form_error_messages',
    label: 'Contrôle de saisie — Alertes & messages',
    category: 'form_validation',
    description:
      'Vérifie que les messages d\'erreur affichés correspondent exactement à ce que le FR ' +
      'stipule, qu\'ils apparaissent au bon endroit (inline, toast, modal…) et qu\'ils ' +
      'disparaissent une fois l\'erreur corrigée. Couvre également les toasts de succès, ' +
      'bannières d\'avertissement et les erreurs multiples simultanées.',
    preferredTypes: ['negative', 'positive'],
  },

  // ══ Upload & fichiers ═════════════════════════════════════════════════════

  {
    id: 'file_corrupted',
    label: 'Upload & fichiers — Fichiers corrompus',
    category: 'file_handling',
    description:
      'Vérifie que le système gère gracieusement les fichiers endommagés sans planter ni ' +
      'exposer d\'erreur technique à l\'utilisateur. Les scénarios typiques sont : fichier ' +
      'tronqué, contenu binaire aléatoire, encodage incorrect. Le résultat attendu est un ' +
      'message d\'erreur fonctionnel, jamais un crash.',
    preferredTypes: ['negative', 'edge_case'],
  },

  {
    id: 'file_metadata',
    label: 'Upload & fichiers — Métadonnées',
    category: 'file_handling',
    description:
      'Vérifie que les métadonnées d\'un fichier (auteur, date, titre…) sont conservées après ' +
      'upload et re-téléchargement. L\'angle négatif couvre un fichier sans métadonnées, ' +
      'qui doit être traité sans erreur. Le résultat positif doit vérifier les valeurs ' +
      'réelles des métadonnées, pas seulement l\'absence d\'erreur.',
    preferredTypes: ['positive', 'integration'],
  },

  {
    id: 'file_import',
    label: 'Upload & fichiers — Import de fichier (CSV/Excel)',
    category: 'file_handling',
    description:
      'Vérifie que l\'import de fichiers structurés (CSV, Excel…) fonctionne correctement. ' +
      'Les angles positifs couvrent un fichier bien formé et l\'import complet des données. ' +
      'Les angles négatifs couvrent : colonnes manquantes, encodage incorrect, fichier vide, ' +
      'lignes en double. Chaque erreur doit produire un message explicite pointant la ligne ou ' +
      'la colonne problématique.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  {
    id: 'file_export',
    label: 'Upload & fichiers — Export de données',
    category: 'file_handling',
    description:
      'Vérifie que l\'export de données produit un fichier correct (CSV, Excel, PDF…). ' +
      'L\'angle positif valide l\'export complet et l\'export filtré. ' +
      'Les angles négatifs couvrent l\'export d\'un jeu de données vide et la vérification ' +
      'que le format du fichier respecte les spécifications (encodage, séparateur, en-têtes).',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  // ══ Règles & calculs ══════════════════════════════════════════════════════

  {
    id: 'business_calculations',
    label: 'Règles & calculs — Calculs',
    category: 'business_logic',
    description:
      'Vérifie que les calculs produits par le système (totaux, taxes, remises, scores…) ' +
      'correspondent aux formules définies dans le FR. Chaque angle doit inclure des valeurs ' +
      'd\'entrée concrètes et le résultat numérique attendu. Les risques à couvrir sont : ' +
      'division par zéro, dépassement de capacité, règles d\'arrondi.',
    preferredTypes: ['positive', 'negative', 'boundary', 'edge_case'],
  },

  {
    id: 'business_rules_applied',
    label: 'Règles & calculs — Application des règles',
    category: 'business_logic',
    description:
      'Vérifie que les règles métier inter-champs ou inter-entités définies dans le FR sont ' +
      'bien appliquées. Chaque angle doit nommer la règle testée. Un angle de transition d\'état ' +
      'doit préciser l\'état avant et l\'état après. Le cas nominal confirme que toutes les ' +
      'conditions réunies produisent la conséquence attendue.',
    preferredTypes: ['positive', 'negative', 'state_transition'],
  },

  {
    id: 'business_conditional_flows',
    label: 'Règles & calculs — Flux conditionnels',
    category: 'business_logic',
    description:
      'Vérifie que chaque branche d\'un flux conditionnel (if/else, switch…) produit le ' +
      'comportement attendu. Les deux branches (condition vraie et condition fausse) doivent ' +
      'être couvertes. Chaque angle doit nommer la condition testée et la branche empruntée.',
    preferredTypes: ['positive', 'negative', 'state_transition'],
  },

  {
    id: 'business_state_transitions',
    label: 'Règles & calculs — Transitions d\'état',
    category: 'business_logic',
    description:
      'Vérifie que les transitions entre états du système (Draft → Submitted → Approved…) ' +
      'se produisent correctement selon les déclencheurs prévus. Les angles couvrent : ' +
      'transition nominale, tentative de transition invalide (état non autorisé), et rollback ' +
      'en cas d\'erreur. Chaque angle doit préciser l\'état initial, le déclencheur et l\'état final attendu.',
    preferredTypes: ['state_transition', 'negative', 'edge_case'],
  },

  {
    id: 'business_expected_effects',
    label: 'Règles & calculs — Effets métier attendus',
    category: 'business_logic',
    description:
      'Vérifie que les actions déclenchent les effets de bord définis dans le FR : compte créé, ' +
      'email envoyé, statut mis à jour, log écrit… Chaque angle doit vérifier l\'effet, pas ' +
      'seulement l\'absence d\'erreur. L\'angle négatif couvre un effet qui NE doit PAS se ' +
      'produire (ex. email non envoyé si l\'action échoue).',
    preferredTypes: ['positive', 'negative', 'integration'],
  },

  // ══ Navigation & étapes ═══════════════════════════════════════════════════

  {
    id: 'journey_navigation',
    label: 'Navigation & étapes — Flux de navigation',
    category: 'journey_flow',
    description:
      'Vérifie que chaque étape du parcours est atteignable dans l\'ordre prévu et que le ' +
      'saut d\'une étape non complétée est bloqué. Les cas limites sont la première et la ' +
      'dernière étape. L\'état de l\'étape (active, complétée, verrouillée) doit être vérifié, ' +
      'pas seulement la visibilité de la page.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  {
    id: 'journey_redirections',
    label: 'Navigation & étapes — Redirections',
    category: 'journey_flow',
    description:
      'Vérifie que les redirections surviennent vers la cible correcte après succès ou échec. ' +
      'L\'angle positif confirme la destination et le contenu de la page d\'arrivée. ' +
      'L\'angle négatif vérifie la redirection vers la page d\'erreur adéquate. ' +
      'Le cas limite couvre le bouton Retour : état du formulaire préservé ou vidé selon le FR.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  {
    id: 'journey_multi_step',
    label: 'Navigation & étapes — Flux multi-étapes',
    category: 'journey_flow',
    description:
      'Vérifie la cohérence d\'un parcours sur plusieurs étapes : l\'action finale n\'est ' +
      'disponible que si toutes les étapes précédentes sont valides. Les angles frontière ' +
      'couvrent explicitement la première et la dernière étape. Un angle négatif vérifie ' +
      'que le blocage sur étape incomplète affiche un retour utilisateur approprié.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  {
    id: 'journey_prev_next',
    label: 'Navigation & étapes — Navigation Précédent/Suivant',
    category: 'journey_flow',
    description:
      'Vérifie que les boutons Précédent et Suivant fonctionnent correctement : Suivant avance ' +
      'si l\'étape courante est valide, Précédent revient sans effacer les données déjà saisies ' +
      '(sauf si le FR l\'indique autrement). Précédent sur la première étape doit être désactivé ' +
      'ou absent. La préservation des données entre étapes est le risque principal.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  // ══ Actions sur les données ═══════════════════════════════════════════════

  {
    id: 'crud_create',
    label: 'Actions sur les données — Création',
    category: 'crud_operations',
    description:
      'Vérifie que la création d\'une ressource avec des données valides aboutit au résultat ' +
      'attendu : entité persistée, réponse 201, données retournées conformes. ' +
      'L\'angle négatif couvre les données invalides ou dupliquées.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  {
    id: 'crud_update',
    label: 'Actions sur les données — Modification',
    category: 'crud_operations',
    description:
      'Vérifie la mise à jour partielle (PATCH) et complète (PUT) d\'une ressource existante. ' +
      'L\'angle négatif couvre la modification d\'une ressource inexistante ou avec des ' +
      'données invalides. Les champs non modifiés doivent être préservés.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  {
    id: 'crud_delete',
    label: 'Actions sur les données — Suppression',
    category: 'crud_operations',
    description:
      'Vérifie que la suppression confirmée retire bien la ressource et renvoie 204. ' +
      'L\'angle négatif couvre la suppression annulée (ressource toujours présente) et ' +
      'la suppression d\'une ressource inexistante (404 attendu).',
    preferredTypes: ['positive', 'negative'],
  },

  {
    id: 'crud_search',
    label: 'Actions sur les données — Recherche',
    category: 'crud_operations',
    description:
      'Vérifie que la recherche retourne les bons résultats pour un terme existant et ' +
      'renvoie une liste vide (pas d\'erreur) pour un terme absent. ' +
      'Les cas limites incluent : terme vide, caractères spéciaux, casse mixte.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  {
    id: 'crud_filter',
    label: 'Actions sur les données — Filtrage',
    category: 'crud_operations',
    description:
      'Vérifie que l\'application d\'un ou plusieurs filtres retourne uniquement les ' +
      'résultats correspondants. L\'angle négatif couvre un filtre sans résultat. ' +
      'Les combinaisons de filtres multiples sont un cas limite important.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  {
    id: 'crud_sort',
    label: 'Actions sur les données — Tri',
    category: 'crud_operations',
    description:
      'Vérifie que le tri croissant et décroissant produit l\'ordre attendu. ' +
      'Les cas limites couvrent : une liste avec un seul élément, des valeurs égales ' +
      '(stabilité du tri), et un tri sur un champ non trié par défaut.',
    preferredTypes: ['positive', 'edge_case'],
  },

  // ══ Authentification ══════════════════════════════════════════════════════

  {
    id: 'auth_password_policy',
    label: 'Authentification — Politique de mot de passe',
    category: 'authentication',
    description:
      'Vérifie que la politique de complexité (longueur minimale, majuscule, chiffre, ' +
      'caractère spécial) est appliquée à la création et au changement de mot de passe. ' +
      'La confirmation incorrecte doit être rejetée avec un message explicite.',
    preferredTypes: ['negative', 'positive', 'boundary'],
  },

  {
    id: 'auth_login',
    label: 'Authentification — Connexion',
    category: 'authentication',
    description:
      'Vérifie le flux de connexion : identifiants valides → session créée ; ' +
      'mot de passe incorrect → erreur sans révéler l\'existence du compte ; ' +
      'utilisateur inexistant → même message générique (pas d\'énumération d\'utilisateurs).',
    preferredTypes: ['positive', 'negative', 'security'],
  },

  {
    id: 'auth_mfa',
    label: 'Authentification — MFA',
    category: 'authentication',
    description:
      'Vérifie l\'authentification multifactorielle : code valide → connexion autorisée, ' +
      'code expiré → rejeté avec message d\'expiration, code incorrect → rejeté sans ' +
      'indice sur le code correct. Le renvoi d\'un nouveau code doit invalider l\'ancien.',
    preferredTypes: ['positive', 'negative', 'edge_case'],
  },

  {
    id: 'auth_session',
    label: 'Authentification — Gestion des sessions',
    category: 'authentication',
    description:
      'Vérifie que les sessions s\'ouvrent à la connexion et se ferment à la déconnexion ' +
      'ou après le délai d\'inactivité défini. L\'accès avec un token expiré doit renvoyer ' +
      '401. La déconnexion doit invalider le token côté serveur (pas juste côté client).',
    preferredTypes: ['positive', 'negative', 'security'],
  },

  {
    id: 'auth_rate_limiting',
    label: 'Authentification — Limitation des tentatives',
    category: 'authentication',
    description:
      'Vérifie que le compte est temporairement bloqué après N échecs consécutifs ' +
      '(N défini dans le FR). Le compteur doit se réinitialiser après un succès. ' +
      'L\'angle de sécurité couvre une tentative de brute-force automatisée.',
    preferredTypes: ['negative', 'security', 'edge_case'],
  },

  // ══ Services externes ═════════════════════════════════════════════════════

  {
    id: 'integration_payment',
    label: 'Services externes — Passerelle de paiement',
    category: 'integration_dependencies',
    description:
      'Vérifie le comportement du système face aux différentes réponses de la passerelle ' +
      'de paiement : transaction acceptée → commande confirmée, transaction refusée / carte ' +
      'expirée / CVV incorrect → commande non créée avec message approprié. ' +
      'Les données de carte réelles ne doivent jamais apparaître dans les tests (utiliser ' +
      'des tokens de test). Le statut de la commande ET la réponse passerelle doivent être vérifiés.',
    preferredTypes: ['positive', 'negative', 'boundary', 'edge_case'],
  },

  {
    id: 'integration_notifications',
    label: 'Services externes — Notifications',
    category: 'integration_dependencies',
    description:
      'Vérifie que les notifications (email, SMS, push…) sont envoyées dans les cas prévus ' +
      'et non envoyées dans les cas où elles ne doivent pas l\'être. Les angles couvrent : ' +
      'notification envoyée après action réussie, notification non envoyée si l\'action échoue, ' +
      'absence de doublon (idempotence), et réception effective côté destinataire.',
    preferredTypes: ['positive', 'negative', 'integration'],
  },

];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const SCOPE_CATEGORIES = [
  { id: 'form_validation'          as ScopeCategory, label: 'Contrôle de saisie' },
  { id: 'file_handling'            as ScopeCategory, label: 'Upload & fichiers' },
  { id: 'business_logic'          as ScopeCategory, label: 'Règles & calculs' },
  { id: 'journey_flow'            as ScopeCategory, label: 'Navigation & étapes' },
  { id: 'crud_operations'         as ScopeCategory, label: 'Actions sur les données' },
  { id: 'authentication'          as ScopeCategory, label: 'Authentification' },
  { id: 'integration_dependencies' as ScopeCategory, label: 'Services externes' },
];

function getFeature(id: string): ScopeFeature {
  const f = SCOPE_CATALOGUE.find(f => f.id === id);
  if (!f) throw new Error(`Unknown scope feature: ${id}`);
  return f;
}

// ─── buildScopeBlock (Phase A & B) ───────────────────────────────────────────

export function buildScopeBlock(selectedIds: string[], forPhaseB = false): string {
  if (!selectedIds.length) return '';

  const features  = selectedIds.map(getFeature);
  const preferred = [...new Set(features.flatMap(f => f.preferredTypes))].join(', ');

  const descriptions = features
    .map(f => `  • [${f.id}] ${f.label}\n    ${f.description}`)
    .join('\n\n');

  const phaseBSection = forPhaseB
    ? '\nPHASE B — for each feature above, derive concrete test data values ' +
      '(boundaries, formats, limits) from the FR and SRS context. ' +
      'Do not invent values that are not present in the requirements.\n'
    : '';

  return (
    `\n━━━ TESTING SCOPE (${features.length}) ━━━\n` +
    `${descriptions}\n\n` +
    `PREFERRED TYPES: ${preferred}` +
    phaseBSection +
    `\n━━━ END SCOPE ━━━\n`
  );
}

export function buildScopeBlockFromIds(selectedIds: string[], forPhaseB = false): string {
  return buildScopeBlock(selectedIds, forPhaseB);
}

// ─── buildScopeBlockShort — version compacte (Phase A avec formData) ──────────

export function buildScopeBlockShort(selectedIds: string[]): string {
  if (!selectedIds.length) return '';

  const SHORT_HINTS: Record<string, string> = {
    // Contrôle de saisie
    form_required_fields:      'champ vide, whitespace uniquement, plusieurs absents',
    form_regex_validation:     'format valide, format invalide (violation distincte par champ)',
    form_error_messages:       'message exact correct, positionné inline/toast, disparaît après correction',

    // Upload & fichiers
    file_corrupted:            'fichier tronqué, binaire aléatoire, encodage incorrect → erreur fonctionnelle',
    file_metadata:             'métadonnées conservées après upload/re-téléchargement, fichier sans metadata',
    file_import:               'fichier bien formé → import complet, colonnes manquantes, encodage incorrect, fichier vide, doublon',
    file_export:               'export CSV/Excel/PDF complet, export filtré, export vide, format correct',

    // Règles & calculs
    business_calculations:     'résultat exact, division par zéro, arrondi flottant',
    business_rules_applied:    'règle appliquée, règle violée, changement état',
    business_conditional_flows:'branche IF vraie, branche ELSE fausse — nommer la condition',
    business_state_transitions: 'état initial → déclencheur → état final ; transition invalide rejetée',
    business_expected_effects:  'effet produit (email envoyé, log écrit) ; effet absent si action échoue',

    // Navigation & étapes
    journey_navigation:        'flux nominal, étape sautée, bookmark URL direct',
    journey_redirections:      'succès → bonne page, erreur → page erreur, retour → état préservé',
    journey_multi_step:        'toutes étapes complétées, étape incomplète bloquante, refresh en cours',
    journey_prev_next:         'Suivant bloqué si invalide, Précédent conserve les données saisies',

    // Actions sur les données
    crud_create:               'données valides → 201 créé, données invalides → rejeté',
    crud_update:               'PATCH partiel, PUT complet, ressource inexistante → 404',
    crud_delete:               'suppression confirmée → 204, annulée → ressource présente, inexistante → 404',
    crud_search:               'terme trouvé, terme absent → liste vide, terme vide, casse mixte',
    crud_filter:               'filtre simple, filtre multiple combiné, filtre sans résultat',
    crud_sort:                 'ordre croissant, décroissant, valeurs égales (stabilité)',

    // Authentification
    auth_password_policy:      'longueur min, complexité requise, confirmation incorrecte rejetée',
    auth_login:                'identifiants valides → session, mot de passe incorrect, compte inexistant',
    auth_mfa:                  'code valide, code expiré, code incorrect, renvoi invalide ancien code',
    auth_session:              'session active, expiration automatique, token expiré → 401',
    auth_rate_limiting:        'N échecs → blocage, reset après succès, brute-force bloqué',

    // Services externes
    integration_payment:       'carte sandbox acceptée, refusée, expirée, double-clic, timeout passerelle',
    integration_notifications: 'notification envoyée après succès, non envoyée si échec, pas de doublon',
  };

  const features = selectedIds.map(id => {
    const f = SCOPE_CATALOGUE.find(sf => sf.id === id);
    if (!f) return null;
    const hint = SHORT_HINTS[id] ?? f.description.slice(0, 80);
    return `  • ${id} → ${hint}`;
  }).filter(Boolean);

  const preferred = [...new Set(selectedIds.flatMap(id => {
    const f = SCOPE_CATALOGUE.find(sf => sf.id === id);
    return f ? f.preferredTypes : [];
  }))].join(' | ');

  return (
    `\n━━━ SCOPE (${selectedIds.length}) ━━━\n` +
    features.join('\n') + '\n' +
    `TYPES: ${preferred}\n` +
    `━━━ END SCOPE ━━━\n`
  );
}

// ─── buildScopeBlockShortForType — scope filtré par type de TC (Phase B) ──────

const TC_TYPE_TO_SCOPE_AFFINITY: Record<string, string[]> = {
  boundary:         ['auth_password_policy'],
  negative:         ['form_required_fields', 'form_regex_validation', 'form_error_messages',
                     'auth_login', 'auth_rate_limiting', 'crud_create', 'crud_update', 'crud_delete'],
  edge_case:        ['form_regex_validation', 'business_calculations',
                     'file_corrupted', 'file_import', 'file_export',
                     'crud_search', 'crud_filter', 'auth_mfa'],
  positive:         ['form_required_fields', 'journey_navigation', 'journey_multi_step', 'business_rules_applied',
                     'crud_create', 'crud_update', 'auth_login', 'business_expected_effects'],
  state_transition: ['business_rules_applied', 'business_conditional_flows', 'business_state_transitions',
                     'journey_multi_step', 'journey_navigation'],
  security:         ['auth_login', 'auth_session', 'auth_rate_limiting', 'auth_mfa'],
  integration:      ['integration_payment', 'integration_notifications', 'business_expected_effects', 'file_metadata'],
  concurrency:      ['auth_rate_limiting', 'crud_create', 'integration_payment'],
};

export function buildScopeBlockShortForType(selectedIds: string[], tcType: string): string {
  if (!selectedIds.length) return '';

  const affinity = TC_TYPE_TO_SCOPE_AFFINITY[tcType] ?? [];

  const filtered = affinity.length > 0
    ? selectedIds.filter(id => affinity.includes(id))
    : selectedIds;

  const idsToUse = filtered.length > 0 ? filtered : selectedIds;
  return buildScopeBlockShort(idsToUse);
}

export function getScopePreferredTypes(selectedIds: string[]): TcType[] {
  if (!selectedIds.length) return [];
  const count = new Map<TcType, number>();
  for (const id of selectedIds)
    for (const t of getFeature(id).preferredTypes)
      count.set(t, (count.get(t) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}