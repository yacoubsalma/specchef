/**
 * ─── SOURCE DE VÉRITÉ UNIQUE — Types Workflow de Test ─────────────────────────
 *
 * CE FICHIER EST IDENTIQUE DANS LE FRONTEND ET LE BACKEND.
 * Ne modifier qu'ICI — copier ensuite dans l'autre dépôt (ou créer un package
 * partagé). Suit exactement la même convention que shared/tc-types.ts.
 *
 * Emplacements :
 *   frontend  → lib/workflow-types.ts (ce fichier)
 *   backend   → backend/src/shared/workflow-types.ts (copie identique)
 *
 * Un TestWorkflow est un graphe (nodes/edges) stocké en Json côté Prisma
 * (voir schema.prisma / model TestWorkflow) : ce fichier est le contrat de
 * forme de ce Json, jamais interrogé champ par champ côté base de données.
 */

// ─── Nœuds ──────────────────────────────────────────────────────────────────

export const WORKFLOW_NODE_TYPES = ['test_case', 'action', 'decision', 'notification'] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

export const WORKFLOW_STEP_STATUSES = ['idle', 'passed', 'failed', 'skipped', 'blocked'] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

export interface WorkflowNodeData {
  label: string;
  nodeType: WorkflowNodeType;

  // ── nodeType === 'test_case' ────────────────────────────────────────────
  // Référence vers un TestCase existant du projet. Le snapshot est dénormalisé
  // au moment où le nœud est créé/rafraîchi pour affichage immédiat sur le
  // canvas sans aller rechercher le TC à chaque rendu (comme
  // RequirementModule.jira_epic_key, dénormalisé une fois puis réutilisé).
  testCaseId?: string;
  testCaseSnapshot?: {
    testId: string;
    title: string;
    type: string;
    priority: string;
    requirementId?: string;
    // testData du TC d'origine, au format "CLÉ: valeur" (convention de
    // génération — voir prompt-builders.ts). Sert de base à l'extraction
    // automatique des variables d'entrée/sortie (voir parseTestDataEntries).
    testData?: string[];
  };

  // ── nodeType === 'action' | 'decision' | 'notification' ─────────────────
  description?: string;

  // ── nodeType === 'notification' ─────────────────────────────────────────
  // Une notification/bannière n'est jamais un nœud autonome du graphe : elle
  // est rattachée à une seule étape "hôte", positionnée au-dessus ou en
  // dessous d'elle (jamais reliée par une arête comme les autres types).
  attachedToNodeId?: string;
  attachedSide?: 'above' | 'below';
  // Nom libre choisi par le BA ("Notification", "Bannière", "Toast"...) —
  // remplace un libellé figé, affiché à la place de NODE_TYPE_META.label.
  alertKind?: string;
  // Cas de test optionnellement rattaché à cette notification/bannière (ex:
  // "quel TC déclenche cet email ?") — mêmes champs que testCaseId /
  // testCaseSnapshot ci-dessus, réutilisés ici, mais jamais requis à la
  // création contrairement au type 'test_case' (voir NodeInspector).

  // ── Corrélation de données de test ──────────────────────────────────────
  // Noms de variables (déclarées au niveau du workflow, voir WorkflowVariable)
  // que ce nœud produit / consomme. C'est ce qui matérialise la "corrélation"
  // des données de test entre les étapes du flow.
  inputVariables?: string[];
  outputVariables?: string[];

  // Dernier statut connu (mis à jour pendant un run, purement indicatif hors
  // exécution — la vérité pendant un run vit dans WorkflowRun.step_results).
  status?: WorkflowStepStatus;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: WorkflowNodeData;
}

// ─── Arêtes ─────────────────────────────────────────────────────────────────

export interface WorkflowEdgeData {
  // Nom de la variable transportée par cette arête (optionnel — une arête
  // peut aussi représenter un simple enchaînement séquentiel sans donnée).
  variableName?: string;
  // Libellé de branche pour les nœuds de décision (ex: "Si valide", "Si expiré").
  condition?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  data?: WorkflowEdgeData;
}

// ─── Variables corrélées ────────────────────────────────────────────────────

export interface WorkflowVariable {
  id: string;
  name: string;
  description?: string;
  exampleValue?: string;
}

// ─── Exécution ──────────────────────────────────────────────────────────────

export const WORKFLOW_RUN_STATUSES = ['running', 'passed', 'failed', 'partial', 'aborted'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export interface WorkflowStepResult {
  nodeId: string;
  status: WorkflowStepStatus;
  note?: string;
  // Valeurs concrètes saisies pour les variables produites par ce nœud
  // pendant CE run (ex: { orderId: "CMD-4821" }).
  variableValues?: Record<string, string>;
  startedAt?: string;
  finishedAt?: string;
  executedById?: string;
  executedByName?: string;
}

// ─── Extraction automatique des variables depuis un cas de test ────────────

export interface ParsedTestDataEntry {
  key: string;
  value: string;
}

/**
 * Découpe le champ `testData` d'un TestCase (convention de génération :
 * chaîne "CLÉ: valeur", ex. "REGISTER_URL: /register") en entrées exploitables,
 * puis les classe en variables d'entrée vs de sortie pour un nœud de workflow :
 *   - toute clé qui ressemble à un résultat/message/statut → sortie
 *   - la DERNIÈRE entrée est systématiquement classée en sortie : le prompt de
 *     génération impose "Last step MUST be: Verify that [OUTCOME_MSG]" — la
 *     dernière valeur de testData est donc toujours ce que l'étape vérifie/produit
 *   - toutes les autres → entrée (données saisies pour réaliser l'étape)
 * Reste une SUGGESTION éditable par l'utilisateur, jamais appliquée à l'aveugle.
 */
export function parseTestDataEntries(testData?: string[]): { input: ParsedTestDataEntry[]; output: ParsedTestDataEntry[] } {
  const entries: ParsedTestDataEntry[] = (testData || [])
    .map(raw => {
      const idx = raw.indexOf(':');
      if (idx === -1) return null;
      const key = raw.slice(0, idx).trim();
      const value = raw.slice(idx + 1).trim();
      if (!key) return null;
      return { key, value };
    })
    .filter((e): e is ParsedTestDataEntry => !!e);

  const looksLikeOutcome = (key: string) => /OUTCOME|RESULT|MSG|MESSAGE|STATUS|ERROR/i.test(key);

  const input: ParsedTestDataEntry[] = [];
  const output: ParsedTestDataEntry[] = [];
  entries.forEach((entry, i) => {
    const isLast = i === entries.length - 1;
    if (isLast || looksLikeOutcome(entry.key)) output.push(entry);
    else input.push(entry);
  });

  return { input, output };
}