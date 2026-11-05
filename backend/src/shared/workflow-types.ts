/**
 * ─── SOURCE DE VÉRITÉ UNIQUE — Types Workflow de Test ─────────────────────────
 *
 * CE FICHIER EST IDENTIQUE DANS LE FRONTEND ET LE BACKEND.
 * Ne modifier qu'ICI — copier ensuite dans l'autre dépôt (ou créer un package
 * partagé). Suit exactement la même convention que shared/tc-types.ts.
 *
 * Emplacements :
 *   frontend  → lib/workflow-types.ts
 *   backend   → backend/src/shared/workflow-types.ts
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

/**
 * Calcule le statut global d'un run à partir des statuts de ses étapes.
 * Règle : un seul échec suffit à faire échouer tout le run ; sinon, s'il
 * reste des étapes ignorées/bloquées le run est "partial" ; sinon "passed"
 * dès que toutes les étapes concernées ont un statut terminal.
 */
export function computeRunStatus(stepResults: WorkflowStepResult[]): WorkflowRunStatus {
  if (stepResults.length === 0) return 'passed';
  if (stepResults.some(s => s.status === 'failed')) return 'failed';
  if (stepResults.some(s => s.status === 'idle')) return 'running';
  if (stepResults.some(s => s.status === 'skipped' || s.status === 'blocked')) return 'partial';
  return 'passed';
}