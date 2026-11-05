/**
 * Test Workflows API
 *
 * Utilitaires pour appeler les endpoints du canvas de workflow de test
 * (création, autosave du graphe, exécutions). Suit la même convention que
 * lib/comments-api.ts : fetch direct vers le proxy /api/backend, qui injecte
 * le Bearer token côté serveur à partir de la session cookie.
 */

import { WorkflowNode, WorkflowEdge, WorkflowVariable, WorkflowStepStatus } from './workflow-types';
import type { EntityVersion } from './versions-api';

const API_BASE = '/api/backend';

export interface WorkflowAuthor {
  id: string;
  name: string;
  email: string;
}

export interface TestWorkflow {
  id: string;
  project_id: string;
  name: string;
  description?: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: WorkflowVariable[];
  created_by?: WorkflowAuthor | null;
  /** Un workflow créé par un BA reste un brouillon (visible uniquement par
   *  son créateur et les BA assignés ci-dessous) tant qu'il n'a pas été
   *  explicitement validé. */
  is_validated?: boolean;
  validated_at?: string | null;
  validated_by?: WorkflowAuthor | null;
  /** BA (autres que le créateur) autorisés à voir/modifier/valider ce
   *  workflow tant qu'il est en brouillon — choisis par le créateur. */
  assignedUsers?: WorkflowAuthor[];
  /** QA autorisés à exécuter ce workflow une fois validé — liste vide =
   *  tout QA du projet peut l'exécuter (comportement par défaut). */
  assignedQas?: WorkflowAuthor[];
  last_run_status?: string | null;
  last_run_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStepResult {
  nodeId: string;
  status: WorkflowStepStatus;
  note?: string;
  variableValues?: Record<string, string>;
  startedAt?: string;
  finishedAt?: string;
  executedById?: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  project_id: string;
  status: 'running' | 'passed' | 'failed' | 'partial' | 'aborted';
  nodes_snapshot: WorkflowNode[];
  edges_snapshot: WorkflowEdge[];
  step_results: WorkflowStepResult[];
  variable_values: Record<string, string>;
  executed_by?: WorkflowAuthor | null;
  started_at: string;
  finished_at?: string | null;
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(data?.message || (Array.isArray(data?.message) ? data.message.join(', ') : `HTTP ${res.status}`));
    // Propage les champs du 409 anti-édition-concurrente (voir tryLockAction
    // côté backend) — utilisé par exemple dans TestWorkflowBoard.persist()
    // pour distinguer un verrou pris entre-temps par un autre BA d'une
    // erreur de sauvegarde ordinaire.
    if (data?.locked) { err.locked = true; err.actorName = data.actorName; }
    throw err;
  }
  return data;
}

// ─── CRUD workflows ─────────────────────────────────────────────────────────

export async function listWorkflows(projectId: string): Promise<TestWorkflow[]> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows`);
  const data = await parseJson(res);
  return data.data;
}

export async function createWorkflow(
  projectId: string,
  input: { name: string; description?: string; nodes?: WorkflowNode[]; edges?: WorkflowEdge[]; variables?: WorkflowVariable[]; assignedUserIds?: string[] },
): Promise<TestWorkflow> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await parseJson(res);
  return data.data;
}

/** Remplace la liste des BA autorisés à voir/modifier/valider ce workflow tant qu'il est en brouillon — réservé au créateur (ou Admin). */
export async function setWorkflowAccess(
  projectId: string,
  workflowId: string,
  userIds: string[],
): Promise<TestWorkflow> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/access`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds }),
  });
  const data = await parseJson(res);
  return data.data;
}

/** Remplace la liste des QA autorisés à exécuter ce workflow (vide = tout QA du projet) — réservé au créateur (ou Admin). */
export async function setWorkflowQaAccess(
  projectId: string,
  workflowId: string,
  userIds: string[],
): Promise<TestWorkflow> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/qa-access`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds }),
  });
  const data = await parseJson(res);
  return data.data;
}

export async function getWorkflow(projectId: string, workflowId: string): Promise<TestWorkflow> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}`);
  const data = await parseJson(res);
  return data.data;
}

export async function updateWorkflow(
  projectId: string,
  workflowId: string,
  input: Partial<{ name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[]; variables: WorkflowVariable[] }>,
): Promise<TestWorkflow> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await parseJson(res);
  return data.data;
}

export async function deleteWorkflow(projectId: string, workflowId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}`, { method: 'DELETE' });
  await parseJson(res);
}

// ─── Historique / rollback ──────────────────────────────────────────────────
// Contrairement à Requirement/Module/TestCase (voir lib/versions-api.ts), le
// workflow est throttlé côté backend (checkpoints espacés d'au moins 2 min)
// car `updateWorkflow` sert aussi à l'autosave du canvas à chaque frappe.

export async function getWorkflowVersions(projectId: string, workflowId: string): Promise<EntityVersion[]> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/versions`);
  const data = await parseJson(res);
  return data.data;
}

export async function restoreWorkflowVersion(projectId: string, workflowId: string, versionId: string): Promise<TestWorkflow> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/versions/${versionId}/restore`, { method: 'POST' });
  const data = await parseJson(res);
  return data.data;
}

/** Valide (publie) un workflow — le rend visible aux autres utilisateurs du projet. BA uniquement. */
export async function validateWorkflow(projectId: string, workflowId: string): Promise<TestWorkflow> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/validate`, { method: 'POST' });
  const data = await parseJson(res);
  return data.data;
}

/** Repasse un workflow validé en brouillon (retrait de publication). BA uniquement. */
export async function unvalidateWorkflow(projectId: string, workflowId: string): Promise<TestWorkflow> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/unvalidate`, { method: 'POST' });
  const data = await parseJson(res);
  return data.data;
}

/**
 * Demande au LLM de proposer une valeur réaliste pour chaque variable
 * déclarée sur le workflow (cohérentes entre elles, ex: même identifiant de
 * dossier réutilisé à travers les étapes). Les valeurs sont aussi
 * enregistrées comme `exampleValue` sur le workflow retourné.
 */
export async function generateWorkflowTestData(
  projectId: string,
  workflowId: string,
  notes?: string,
): Promise<{ workflow: TestWorkflow; values: Record<string, string> }> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/generate-test-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  });
  const data = await parseJson(res);
  return data.data;
}

/**
 * Demande au LLM d'identifier, parmi tous les cas de test du projet, ceux
 * qui pourraient réalistement s'exécuter juste après le dernier cas de test
 * du workflow — en tenant compte de TOUT le scénario déjà construit
 * (`workflowTestCaseIds`, dans l'ordre), pas seulement de la dernière étape
 * isolée. Utilisé par le panneau "Ajouter une étape".
 */
export async function suggestNextTestCases(
  projectId: string,
  testCaseId: string,
  workflowTestCaseIds?: string[],
): Promise<{ suggestions: { id: string; reason?: string }[] }> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/suggest-next-test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testCaseId, workflowTestCaseIds }),
  });
  const data = await parseJson(res);
  return data.data;
}

// ─── Exécution (runs) ───────────────────────────────────────────────────────

export async function startWorkflowRun(projectId: string, workflowId: string): Promise<WorkflowRun> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/runs`, { method: 'POST' });
  const data = await parseJson(res);
  return data.data;
}

export async function listWorkflowRuns(projectId: string, workflowId: string): Promise<WorkflowRun[]> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/runs`);
  const data = await parseJson(res);
  return data.data;
}

export async function getWorkflowRun(projectId: string, workflowId: string, runId: string): Promise<WorkflowRun> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/runs/${runId}`);
  const data = await parseJson(res);
  return data.data;
}

export async function updateWorkflowStepResult(
  projectId: string,
  workflowId: string,
  runId: string,
  nodeId: string,
  input: { status: WorkflowStepStatus; note?: string; variableValues?: Record<string, string> },
): Promise<WorkflowRun> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/runs/${runId}/steps/${nodeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await parseJson(res);
  return data.data;
}

export async function finishWorkflowRun(projectId: string, workflowId: string, runId: string): Promise<WorkflowRun> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/runs/${runId}/finish`, { method: 'POST' });
  const data = await parseJson(res);
  return data.data;
}

export async function abortWorkflowRun(projectId: string, workflowId: string, runId: string): Promise<WorkflowRun> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/runs/${runId}/abort`, { method: 'POST' });
  const data = await parseJson(res);
  return data.data;
}
/** Signale (ou libère) une session d'édition sur ce workflow — pose un vrai verrou côté serveur (409 si un autre BA l'a déjà). */
export async function setWorkflowEditingPresence(
  projectId: string,
  workflowId: string,
  active: boolean,
): Promise<{ locked: true; message: string; actorName: string } | { locked: false }> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/editing-presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    return { locked: true, message: data.message || 'Ce workflow est déjà en cours de modification', actorName: data.actorName || 'un autre BA' };
  }
  await parseJson(res);
  return { locked: false };
}

/** Signale (ou arrête de signaler) qu'on consulte ce workflow — présence légère, sans verrou, pour le point vert affiché aux autres. */
export async function setWorkflowViewingPresence(projectId: string, workflowId: string, active: boolean): Promise<void> {
  await fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/viewing-presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  }).catch(() => { /* best-effort */ });
}

/** Diffusion éphémère (sans sauvegarde) du graphe en cours d'édition — pour que les autres voient les nœuds bouger en direct. À throttler côté appelant. */
export function broadcastWorkflowCanvasLive(projectId: string, workflowId: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): void {
  fetch(`${API_BASE}/projects/${projectId}/workflows/${workflowId}/canvas-live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges }),
    keepalive: true,
  }).catch(() => { /* best-effort, jamais bloquant */ });
}