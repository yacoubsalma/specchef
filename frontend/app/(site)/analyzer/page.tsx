'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useProjectPolling } from '@/app/hooks/useProjectPolling';
import { ProjectStatusDisplay } from '@/app/components/ProjectStatusDisplay';
import { normalizeTcType, testTypeConfig } from '@/lib/tc-types';
import AssistTest, { TestFormData, FormRequirement } from '@/app/components/AssistTest';
import SaturationBanner from '@/app/components/Saturationbanner';
import GenerationModeSelector, { GenerationMode } from '@/app/components/Generationmodeselector';
import ModuleReqEditor, { describeImpact, ImpactInfo } from '@/app/components/ModuleReqEditor';
import AnglesPreview from '@/app/components/Anglespreview';
import { JiraExportSingleButton, JiraExportAllButton } from '@/app/components/JiraExportButton';
import JiraSettingsModal from '@/app/components/JiraSettingsModal';
import { useJira } from '@/app/context/JiraContext';
import TestWorkflowBoard from '@/app/components/TestWorkflowBoard';
import { useHideHeaderWhen } from '@/app/context/HeaderVisibilityContext';
import { generateRequirementTestCasesAsync } from '@/lib/tc-generation-api';
import { TraceabilityBadge } from '@/app/components/RequirementTraceability';
import { useCommentsDrawer } from '@/app/context/CommentsDrawerContext';
import { useUnreadComments } from '@/app/context/UnreadCommentsContext';
import { useProjectRealtime, ProjectRealtimeEvent, ProjectRealtimePayload } from '@/app/hooks/useProjectRealtime';
import { ProjectPresenceBar } from '@/app/components/ProjectPresenceBar';
import ProjectActivityFeed from '@/app/components/ProjectActivityFeed';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import ConfirmDeleteModal from '@/app/components/ConfirmDeleteModal';
import CampaignCloseModal from '@/app/components/CampaignCloseModal';
import VersionHistoryPanel from '@/app/components/VersionHistoryPanel';
import { Badge, IdTag, StatusPill } from '@/app/components/ui/Badge';
import { btn, btnSize, card as cardCls, sectionTitle } from '@/app/components/ui/buttonStyles';
import {
  IconSearch, IconFolder, IconFile, IconEdit, IconCheck, IconCheckCircle, IconClose,
  IconAlertTriangle, IconFlask, IconSave, IconBolt, IconTarget, IconLink, IconChart,
  IconEye, IconMessage, IconUpload, IconDownload, IconRefresh, IconTrash,
  IconChevronRight, IconChevronDown, IconInbox, IconCalendar, IconClock, IconShuffle,
  IconPackage, IconSparkle, IconPin, IconLock, IconUnlock, IconRocket,
} from '@/app/components/ui/Icon';

const API_BASE = '/api/backend';
const ENDPOINTS = {
  upload:       `${API_BASE}/documents/upload`,
  step2Tests:   `${API_BASE}/llm/step2-test-cases`,
  health:       `${API_BASE}/llm/health`,
  projects:     `${API_BASE}/projects`,
};

type AppStep = 'idle' | 'uploading' | 'extracting' | 'extracted' | 'generating_tests' | 'done' | 'error';
type ModuleGenState = 'idle' | 'generating' | 'done' | 'error';
type ViewTab = 'modules' | 'tests' | 'srs' | 'coverage' | 'workflow';

interface LogEntry { time: string; msg: string; type: 'info' | 'success' | 'error' | 'step' | 'warn'; }
interface Requirement { id: string; description: string; priority: 'SHALL' | 'SHOULD' | 'MAY' | 'MUST'; }
interface Module { name: string; description: string; requirements: Requirement[]; }
interface RequirementsJson { document_type: string; modules: Module[]; }

interface TestCase {
  testId: string; moduleId: string; requirementId: string; title: string;
  preconditions: string[]; steps: string[]; testData: string[]; expectedResult: string;
  type: 'positive' | 'negative' | 'edge_case' | 'boundary' | 'out_of_bounds' | 'state_transition' | 'security' | 'integration' | 'concurrency';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  id?: string;
  manually_edited?: boolean;
  needsReview?: boolean;
  needsReviewReason?: string | null;
  jiraIssueKey?: string | null;
  jiraIssueUrl?: string | null;
  executionStatus?: 'not_tested' | 'passed' | 'failed';
}
interface RequirementWithTests extends Requirement { total_test_cases: number; test_cases: TestCase[]; _uuid?: string; }
interface ModuleWithTests { name: string; description: string; total_requirements: number; total_test_cases: number; requirements: RequirementWithTests[]; }
interface TestCaseResult { success: boolean; model: string; duration_ms: number; total_modules: number; total_requirements: number; total_test_cases: number; modules: ModuleWithTests[]; errors?: string[]; }

// ─── Helpers ─────────────────────────────────────────────────────────────────
const priorityColor = (p: string) => { if (p === 'SHALL' || p === 'MUST') return '#dc2626'; if (p === 'SHOULD') return '#d97706'; return '#2563eb'; };
const formatDuration = (ms?: number | null): string => {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}min ${rest}s`;
};
// Code couleur unique pour tous les badges de durée (extraction, génération de
// cas de test...) : vert = rapide, orange = moyen, rouge = lent.
const DURATION_THRESHOLDS_MS = { fast: 5 * 60_000, slow: 15 * 60_000 };

function deduplicateTestIds(tcs: TestCase[]): TestCase[] {
  const seen = new Map<string, number>();
  return tcs.map(tc => {
    const count = seen.get(tc.testId) ?? 0;
    seen.set(tc.testId, count + 1);
    if (count === 0) return tc;
    const suffix = String.fromCharCode(97 + count);
    return { ...tc, testId: `${tc.testId}${suffix}` };
  });
}

// Combine les TC persistés et "en attente" d'un requirement, en excluant du
// côté "en attente" tout testId déjà présent côté persisté. Sans ça, un TC
// resté par erreur dans pending_test_cases après validation (état front
// périmé, course entre 2 utilisateurs) créait un vrai doublon que
// deduplicateTestIds renommait avec un suffixe — suffixe qui, une fois
// resauvegardé par l'autosave, grossissait un peu plus à chaque rafraîchissement
// (TC-X → TC-Xb → TC-Xbb...).
function combineTestCases(persisted: any[], pending: any[]): TestCase[] {
  const persistedIds = new Set(persisted.map((tc: any) => tc.test_id));
  const cleanPending = pending.filter((tc: any) => !persistedIds.has(tc.testId ?? tc.test_id));
  return deduplicateTestIds([...persisted.map((tc: any) => normalizeTC(tc, true)), ...cleanPending.map((tc: any) => normalizeTC(tc, false))]);
}

function mergeTCs(existing: TestCase[], next: TestCase[]): TestCase[] {
  const map = new Map<string, TestCase>();
  for (const tc of existing) map.set(tc.testId, tc);
  for (const tc of next) {
    const current = map.get(tc.testId);
    if (!current) { map.set(tc.testId, tc); }
    else {
      const currentPersisted = !!(current as any).id;
      const nextPersisted = !!(tc as any).id;
      if (nextPersisted) map.set(tc.testId, tc);
      else if (!currentPersisted) map.set(tc.testId, tc);
    }
  }
  return Array.from(map.values());
}

// Calcule, à partir des modules chargés (avec leurs TC), l'ensemble des noms
// de modules et des ids d'exigences contenant au moins un élément marqué
// "à réviser" (exigence ou TC) — pour les auto-déplier au chargement/reload,
// et pas seulement juste après une génération/édition dans la même session.
function needsReviewExpansion(modulesWithTests: { name: string; requirements: { id: string; needsReview?: boolean; test_cases: { needsReview?: boolean }[] }[] }[]): { moduleNames: Set<string>; reqIds: Set<string> } {
  const moduleNames = new Set<string>();
  const reqIds = new Set<string>();
  for (const mod of modulesWithTests) {
    for (const req of mod.requirements) {
      const flagged = !!req.needsReview || (req.test_cases || []).some(tc => !!tc.needsReview);
      if (flagged) { moduleNames.add(mod.name); reqIds.add(req.id); }
    }
  }
  return { moduleNames, reqIds };
}

function normalizeTestData(raw: any[]): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const key = item.key || item.field || item.name || item.label || Object.keys(item)[0] || 'Field';
      const value = item.value || item.val || item.data || Object.values(item)[1] || '';
      return `${key}: '${value}'`;
    }
    return String(item);
  });
}

function normalizeTC(raw: any, keepId = false): TestCase {
  const safeType = normalizeTcType(raw.type || raw.test_type || '');
  return {
    testId: raw.test_id || raw.testId || '',
    moduleId: raw.moduleId || raw.module_id || '',
    requirementId: raw.requirement_id || raw.requirementId || '',
    title: raw.title || '',
    preconditions: Array.isArray(raw.preconditions) ? raw.preconditions : [],
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    testData: normalizeTestData(raw.test_data || raw.testData || []),
    expectedResult: raw.expected_result || raw.expectedResult || '',
    type: safeType,
    priority: (raw.priority || 'HIGH') as TestCase['priority'],
    manually_edited: raw.manually_edited ?? false,
    needsReview: raw.needs_review ?? raw.needsReview ?? false,
    needsReviewReason: raw.needs_review_reason ?? raw.needsReviewReason ?? null,
    jiraIssueKey: raw.jira_issue_key ?? raw.jiraIssueKey ?? null,
    jiraIssueUrl: raw.jira_issue_url ?? raw.jiraIssueUrl ?? null,
    executionStatus: raw.execution_status ?? raw.executionStatus ?? 'not_tested',
    ...(keepId && raw.id ? { id: raw.id } : {}),
  };
}

// ─── API helpers ──────────────────────────────────────────────────────────────
async function apiCreateAndValidateTC(reqUUID: string, tc: TestCase): Promise<{ pending: boolean; message?: string; data?: any }> {
  const res = await fetch(`${API_BASE}/projects/requirements/${reqUUID}/test-cases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testId: tc.testId, title: tc.title, preconditions: tc.preconditions ?? [], steps: tc.steps ?? [], testData: tc.testData ?? [], expectedResult: tc.expectedResult ?? '', type: tc.type, priority: tc.priority, manuallyEdited: tc.manually_edited === true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  if (data?.pending) return { pending: true, message: data.message };
  return { pending: false, data: data.data };
}

// Journalise le rejet d'un TC EN ATTENTE (jamais persisté en DB — voir
// handleValidateOrDelete / TCCard) dans le fil d'activité du projet. Rien à
// supprimer côté serveur puisque ce TC n'existe qu'en mémoire côté front.
async function apiRejectPendingTC(reqUUID: string, tc: TestCase): Promise<void> {
  try {
    await fetch(`${API_BASE}/projects/requirements/${reqUUID}/test-cases/reject-pending`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testId: tc.testId, title: tc.title }),
    });
  } catch { /* silencieux — best-effort, ne doit jamais bloquer le rejet local */ }
}

// Autosave invisible des TC générés mais pas encore validés (voir backend
// Requirement.pending_test_cases). Aucun changement d'UI/comportement : ça
// sert uniquement à ce qu'un reload restaure les TC "en mémoire" tels quels.
//
// Sérialisé par requirement : deux PATCH en vol en même temps sur le même
// reqUUID peuvent arriver au serveur dans le désordre (le plus ancien mais
// plus lent après le plus récent), qui fait un écrasement inconditionnel
// côté backend — sans cette file, un rejet juste après une génération pouvait
// être écrasé par la sauvegarde (plus lente) de la génération elle-même,
// faisant "revenir" le TC qu'on venait de rejeter au prochain chargement.
const pendingSaveChains = new Map<string, Promise<void>>();
async function apiSavePendingTestCases(reqUUID: string, testCases: TestCase[]): Promise<void> {
  const previous = pendingSaveChains.get(reqUUID) ?? Promise.resolve();
  const next = previous.then(() => fetch(`${API_BASE}/projects/requirements/${reqUUID}/pending-test-cases`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testCases }),
  })).then(() => undefined, () => undefined); // silencieux — autosave best-effort, ne doit jamais gêner l'UI
  pendingSaveChains.set(reqUUID, next);
  await next;
}

async function apiDeleteTC(tcId: string): Promise<{ pending: boolean; message?: string }> {
  const res = await fetch(`${API_BASE}/projects/test-cases/${tcId}`, { method: 'DELETE' });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any)?.message || `HTTP ${res.status}`); }
  const json = await res.json().catch(() => null);
  return { pending: !!json?.pending, message: json?.message };
}

async function apiEditTestCase(tcId: string, patch: any): Promise<{ pending: boolean; message?: string }> {
  const backendPatch: any = {};
  if ('title' in patch) backendPatch.title = patch.title;
  if ('steps' in patch) backendPatch.steps = patch.steps;
  if ('preconditions' in patch) backendPatch.preconditions = patch.preconditions;
  if ('testData' in patch) backendPatch.test_data = patch.testData;
  if ('expectedResult' in patch) backendPatch.expected_result = patch.expectedResult;
  if ('type' in patch) backendPatch.type = patch.type;
  if ('priority' in patch) backendPatch.priority = patch.priority;
  const res = await fetch(`${API_BASE}/projects/test-cases/${tcId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backendPatch) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any)?.message || `HTTP ${res.status}`); }
  const json = await res.json().catch(() => null);
  return { pending: !!json?.pending, message: json?.message };
}

// dashboard QA « Rejetés (total) toujours fixe » : pour un TC déjà
// persisté, le bouton "Rejeter" appelait apiDeleteTC (DELETE définitif) au
// lieu du workflow de revue PATCH .../review avec status 'rejected'. Or ce
// dernier est le SEUL chemin qui positionne TestCase.review_status='rejected'
// en base — c'est justement ce que dashboard.service.ts compte pour la KPI
// "Rejetés (total)" (voir reviewTestCase côté backend : "'rejected' ne
// supprime PAS le TC, contrairement à deleteTestCase"). Comme ce endpoint
// n'était jamais appelé nulle part côté front, le compteur ne pouvait
// structurellement jamais bouger.
async function apiReviewTC(tcId: string, status: 'validated' | 'rejected' | 'pending'): Promise<{ pending: boolean; message?: string }> {
  const res = await fetch(`${API_BASE}/projects/test-cases/${tcId}/review`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any)?.message || `HTTP ${res.status}`); }
  const json = await res.json().catch(() => null);
  return { pending: !!json?.pending, message: json?.message };
}

// Résultat d'exécution QA pendant la campagne (bouton Réussi/Échoué/Non
// testé sur la carte du TC) — voir PATCH /projects/test-cases/:id/execution.
async function apiSetTestCaseExecution(tcId: string, status: 'passed' | 'failed' | 'not_tested'): Promise<TestCase> {
  const res = await fetch(`${API_BASE}/projects/test-cases/${tcId}/execution`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d as any)?.message || `HTTP ${res.status}`); }
  const json = await res.json();
  return normalizeTC(json.data, true);
}

async function apiGenerateSingleTC(reqUUID: string, model: string, acceptSimilar = false): Promise<{ testCase: TestCase; warning?: any }> {
  const res = await fetch(`${API_BASE}/projects/requirements/${reqUUID}/generate-single`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, acceptSimilar }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  const raw = data.test_case || data;
  return { testCase: normalizeTC(raw, false), warning: raw?.warning };
}

async function apiGenerateSingleTCWithInstruction(reqUUID: string, instruction: string, model: string, acceptSimilar = false): Promise<{ testCase: TestCase; warning?: any }> {
  const res = await fetch(`${API_BASE}/projects/requirements/${reqUUID}/generate-single-with-instruction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, model, acceptSimilar }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  const raw = data.test_case || data;
  return { testCase: normalizeTC(raw, false), warning: raw?.warning };
}

async function apiVerifyTC(tc: TestCase, changedFields: string[], model: string, reqDescription: string): Promise<{ testCase: TestCase; pending?: boolean; message?: string }> {
  const endpoint = (tc as any).id ? `${API_BASE}/projects/test-cases/${(tc as any).id}/verify` : `${API_BASE}/projects/test-cases/verify-memory`;
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, reqDescription, changedFields, testCase: { testId: tc.testId, moduleId: tc.moduleId, requirementId: tc.requirementId, title: tc.title, type: tc.type, priority: tc.priority, preconditions: tc.preconditions, steps: tc.steps, testData: tc.testData ?? [], expectedResult: tc.expectedResult } }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  if (data?.pending) {
    // Campagne en cours : le backend n'a PAS appliqué la vérification/sauvegarde
    // — pas de `test_case` dans la réponse. On ne doit surtout pas normaliser
    // `data` tel quel (ça produirait un TC vidé de tous ses champs).
    return { testCase: tc, pending: true, message: data.message };
  }
  // keepId=true : sinon un TC déjà persisté/validé perd son `id` dans l'état local
  // après édition (isPersisted redevient false → badge "en attente") jusqu'au reload.
  return { testCase: { ...normalizeTC(data.test_case || data, true), testId: tc.testId, id: (data.test_case || data)?.id ?? (tc as any).id } };
}

async function apiRegenSingleTC(tc: TestCase, instruction: string, model: string, reqDescription: string, otherTestCases: TestCase[] = [], projectId: string | null = null, acceptSimilar = false): Promise<{ testCase: TestCase; warning?: any }> {
  const allowedTypes = Object.keys(testTypeConfig);
  const safeType = allowedTypes.includes(tc.type) ? tc.type : 'positive';
  if ((tc as any).id) {
    const res = await fetch(`${API_BASE}/projects/test-cases/${(tc as any).id}/regenerate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, model, acceptSimilar, memoryTestCases: otherTestCases.filter(t => !(t as any).id).map(t => ({ type: t.type, title: t.title, preconditions: t.preconditions, steps: t.steps, testData: t.testData, expectedResult: t.expectedResult })) }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    return { testCase: { ...normalizeTC(data.test_case || data, false), testId: tc.testId }, warning: (data.test_case || data)?.warning };
  } else {
    const payload = { instruction, model, projectId: projectId || undefined, acceptSimilar, testCase: { testId: tc.testId, moduleId: tc.moduleId, requirementId: tc.requirementId, title: tc.title, type: safeType, priority: tc.priority, preconditions: tc.preconditions, steps: tc.steps, testData: tc.testData ?? [], expectedResult: tc.expectedResult }, reqDescription, otherTestCases: otherTestCases.filter(t => (t as any).id).map(t => ({ type: t.type, title: t.title, preconditions: t.preconditions, steps: t.steps, testData: t.testData, expectedResult: t.expectedResult })) };
    const res = await fetch(`${API_BASE}/projects/test-cases/regen-in-memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    return { testCase: { ...normalizeTC(data.test_case || data, false), testId: tc.testId }, warning: (data.test_case || data)?.warning };
  }
}

export interface DedupRejection {
  focus: string;
  tcType?: string;
  attemptedTitle: string;
  similarTitle?: string;
  reason: string;
}

// ✅ Génération asynchrone (job + polling) — voir lib/tc-generation-api.ts.
// Historiquement cette fonction faisait un seul fetch() synchrone qui restait
// ouvert toute la durée de la génération (jusqu'à 30+ min observées) : le
// proxy Next.js (PROXY_TIMEOUT_MS) finissait par couper la connexion avant
// que le backend n'ait terminé, et l'UI affichait une erreur générique alors
// que la génération se terminait bien côté serveur quelques minutes plus
// tard. On démarre maintenant le job côté backend (réponse quasi instantanée)
// puis on poll son statut — plus aucune requête HTTP longue.
// ─── Statut de génération détaillé (mode + étape) ─────────────────────────────
// Utilisé partout où l'on affiche "X est en train de..." pour un AUTRE
// utilisateur (bandeau persistant, toast de verrou, bannière dans les modals
// AnglesPreview/AssistTest) — voir activeGenerations plus bas.
type ActiveGenerationInfo = { actorId?: string; actorName: string; genMode?: GenerationMode; step?: 'angles' | 'testcases' | 'form' };

const GEN_MODE_LABELS: Record<GenerationMode, string> = { fast: 'Mode Flash', assisted: 'Mode Création', explicit: 'Mode Signature' };
const GEN_STEP_LABELS: Record<NonNullable<ActiveGenerationInfo['step']>, string> = {
  angles: 'génère les angles de test',
  testcases: 'génère les cas de test',
  form: 'remplit le formulaire assisté',
};

function formatGenerationStatus(info: ActiveGenerationInfo): string {
  const modeLabel = info.genMode ? ` (${GEN_MODE_LABELS[info.genMode]})` : '';
  const stepLabel = info.step ? GEN_STEP_LABELS[info.step] : 'génère des cas de test';
  return `${info.actorName}${modeLabel} ${stepLabel}`;
}

async function apiGenerateRequirementTC(reqUUID: string, model: string, projectId?: string | null, formContext?: string, formData?: TestFormData, selectedScope?: string[], approvedAngles?: { focus: string; tcType?: string }[], forceAngleFocuses?: string[], existingTcCount?: number, actorName?: string, actorId?: string, genMode?: GenerationMode): Promise<{ test_cases: TestCase[]; duration_ms?: number; dedupRejections?: DedupRejection[] }> {
  const data = await generateRequirementTestCasesAsync(reqUUID, {
    model,
    project_id: projectId || 'default',
    formContext,
    ...(formData ? { formData: formData as any } : {}),
    ...(selectedScope ? { selectedScope } : {}),
    ...(approvedAngles ? { approvedAngles } : {}),
    ...(forceAngleFocuses ? { forceAngleFocuses } : {}),
    ...(typeof existingTcCount === 'number' ? { existingTcCount } : {}),
    ...(actorName ? { actorName } : {}),
    ...(actorId ? { actorId } : {}),
    ...(genMode ? { genMode } : {}),
  } as any);
  const tcs = Array.isArray(data.test_cases) ? data.test_cases.map((tc: any) => normalizeTC(tc, false)) : [];
  return { test_cases: tcs, duration_ms: data.duration_ms, ...(Array.isArray(data.dedupRejections) && data.dedupRejections.length > 0 ? { dedupRejections: data.dedupRejections } : {}) };
}

// ─── ProjectNameEditor — inline rename in analyzer ────────────────────────────
function ProjectNameEditor({ projectId, name, onRenamed }: { projectId: string; name: string; onRenamed: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) { setEditing(false); setDraft(name); return; }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.ok) { onRenamed(trimmed); }
    } catch { }
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 mt-2">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setEditing(false); setDraft(name); } }}
          autoFocus
          className="px-3 py-1.5 rounded-lg border border-primary bg-white dark:bg-black text-xl font-bold text-black dark:text-white focus:outline-none min-w-[250px]"
        />
        <button onClick={handleSave} disabled={saving} className={`${btn.primary} ${btnSize.sm}`}>
          {saving ? <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" /> : <IconCheck className="w-3.5 h-3.5" />} Sauvegarder
        </button>
        <button onClick={() => { setEditing(false); setDraft(name); }} className={`${btn.secondary} ${btnSize.sm}`}><IconClose className="w-3.5 h-3.5" /></button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 mt-2 group">
      <span className="flex items-center gap-2 text-black dark:text-white text-xl font-bold tracking-tight">
        <IconFolder className="w-5 h-5 text-primary shrink-0" strokeWidth={1.6} />
        {name}
      </span>
      <button
        onClick={() => { setEditing(true); setDraft(name); }}
        className={`opacity-0 group-hover:opacity-100 ${btn.iconOnly} ${btnSize.iconSm}`}
        title="Renommer le projet"
      ><IconEdit className="w-3.5 h-3.5" /></button>
    </div>
  );
}

// ─── ProjectPicker ────────────────────────────────────────────────────────────
function ProjectPicker({ onClose, onSelect }: { onClose: () => void; onSelect: (p: any) => void }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetch(ENDPOINTS.projects).then(r => r.json()).then(d => { setProjects(Array.isArray(d) ? d : []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const filtered = projects.filter(p => p.name?.toLowerCase().includes(search.toLowerCase()) || p.document_type?.toLowerCase().includes(search.toLowerCase()));

  const handleDelete = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation(); setDeletingId(id);
    await fetch(`${ENDPOINTS.projects}/${id}`, { method: 'DELETE' }).catch(() => {});
    setProjects(prev => prev.filter(p => p.id !== id)); setDeletingId(null); setConfirmId(null);
  };

  return (
    <div className="fixed inset-0 z-99999 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-white dark:bg-black rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-solid-l border border-stroke dark:border-strokedark" onClick={e => e.stopPropagation()}>
        <div className="px-7 py-5 border-b border-stroke dark:border-strokedark flex items-center justify-between bg-alabaster dark:bg-blacksection">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0"><IconFolder className="w-5 h-5" /></span>
            <div>
              <h3 className={sectionTitle}>Mes projets</h3>
              <p className="text-xs text-waterloo dark:text-manatee mt-0.5">{projects.length} projet{projects.length !== 1 ? 's' : ''} sauvegardé{projects.length !== 1 ? 's' : ''}</p>
            </div>
          </div>
          <button onClick={onClose} className={`${btn.iconOnly} ${btnSize.icon}`} title="Fermer"><IconClose className="w-4.5 h-4.5" /></button>
        </div>
        <div className="px-7 py-3 border-b border-stroke dark:border-strokedark bg-alabaster dark:bg-blacksection">
          <div className="relative">
            <IconSearch className="w-4 h-4 text-manatee absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Chercher un projet..." autoFocus className="w-full pl-10 pr-4 py-2.5 rounded-full border border-stroke dark:border-strokedark bg-white dark:bg-black text-sm text-black dark:text-white focus:border-primary focus:outline-none dark:shadow-none" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-40 text-waterloo dark:text-manatee text-sm gap-2"><span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" /> Chargement des projets...</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 gap-3 text-manatee">
              {search ? <IconSearch className="w-9 h-9 opacity-40" /> : <IconInbox className="w-9 h-9 opacity-40" />}
              <p className="text-sm text-waterloo dark:text-manatee">{search ? 'Aucun projet trouvé' : 'Aucun projet sauvegardé'}</p>
            </div>
          ) : filtered.map(project => {
            const totalReqs = (project.modules || []).reduce((a: number, m: any) => a + (m.requirements?.length ?? 0), 0);
            const totalTCs = (project.modules || []).reduce((a: number, m: any) => a + (m.requirements || []).reduce((b: number, r: any) => b + (r.test_cases?.length ?? 0), 0), 0);
            return (
              <div key={project.id} onClick={() => onSelect(project)} className="p-4 rounded-xl mb-2.5 border border-stroke dark:border-strokedark cursor-pointer flex items-center justify-between hover:border-primary/40 hover:bg-alabaster dark:hover:bg-blackho hover:shadow-solid-2 transition-all">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-sm font-bold text-black dark:text-white">{project.name}</span>
                    {project.document_type && <Badge tone="primary">{project.document_type}</Badge>}
                  </div>
                  <div className="flex gap-4 text-xs text-waterloo dark:text-manatee">
                    <span className="inline-flex items-center gap-1"><IconCalendar className="w-3.5 h-3.5" />{new Date(project.created_at).toLocaleDateString('fr-FR')}</span>
                    {totalReqs > 0 && <span className="inline-flex items-center gap-1"><IconFile className="w-3.5 h-3.5" />{totalReqs} exigences</span>}
                    {totalTCs > 0 && <span className="inline-flex items-center gap-1 text-meta font-semibold"><IconFlask className="w-3.5 h-3.5" />{totalTCs} cas</span>}
                  </div>
                </div>
                <div onClick={e => e.stopPropagation()} className="ml-3 flex-shrink-0">
                  <button onClick={e => { e.stopPropagation(); setConfirmId(project.id); }} title="Supprimer" className={`${btn.iconOnly} ${btnSize.iconSm} hover:!bg-red-500/8 hover:!text-red-600`}><IconTrash className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="px-7 py-3 border-t border-stroke dark:border-strokedark text-center text-xs text-manatee">Cliquez sur un projet · Cliquez en dehors pour fermer</div>
      </div>

      <ConfirmDeleteModal
        open={confirmId !== null}
        title="Supprimer ce projet ?"
        message="Le projet, ses modules, exigences et cas de test seront définitivement supprimés. Cette action est irréversible."
        loading={deletingId !== null}
        onCancel={() => setConfirmId(null)}
        onConfirm={() => confirmId && handleDelete(confirmId)}
      />
    </div>
  );
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function Spinner() { return <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />; }
function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <IconSearch className="w-3.5 h-3.5 text-manatee absolute left-3 top-1/2 -translate-y-1/2" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder="Chercher..." className="pl-8 pr-3 py-1.5 rounded-full border border-stroke dark:border-strokedark bg-white dark:bg-black text-[11px] text-black dark:text-white focus:border-primary focus:outline-none w-36 transition-all" />
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function AnalyzerPage() {
  const searchParams = useSearchParams();
  const { user: authUser } = useCurrentUser();
  const [isLoadingFromUrl, setIsLoadingFromUrl] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return new URLSearchParams(window.location.search).has('projectId');
    }
    return false;
  });
  const [file, setFile] = useState<File | null>(null);
  const [model, setModel] = useState('qwen2.5-coder:7b');
  const [appStep, setAppStep] = useState<AppStep>('idle');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [reqResult, setReqResult] = useState<any>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  // ── Campagne de tests (gel global du projet) ──────────────────────────────
  // "draft" = projet modifiable normalement ; "launched" = campagne en cours,
  // tout le projet est figé (modules/exigences/TC/workflows) — seule
  // l'exécution des workflows déjà créés reste possible (voir
  // TestWorkflowBoard → bouton "Lancer l'exécution"). Alimenté au chargement
  // du projet (openExistingProject/refreshCurrentProject) et tenu à jour en
  // direct par les événements temps réel 'campaign:launched'/'campaign:closed'.
  const [campaignStatus, setCampaignStatus] = useState<'draft' | 'launched'>('draft');
  const [campaignBusy, setCampaignBusy] = useState(false);
  const [cacheHit, setCacheHit] = useState<boolean>(false);
  const [extractionDurationMs, setExtractionDurationMs] = useState<number | undefined>(undefined);
  // Temps de génération des cas de test par exigence (reqUUID -> ms), quel que
  // soit le mode utilisé (Mode Flash / Mode Création / Mode Signature) : les 3 modes appellent
  // tous handleGenerateRequirementTC, qui reçoit duration_ms du backend.
  const [tcGenDurations, setTcGenDurations] = useState<Record<string, number>>({});
  const [testResult, setTestResult] = useState<TestCaseResult | null>(null);
  // Ref toujours synchronisée avec testResult — nécessaire pour les lookups
  // synchrones (ex: handleTCRejected) où on ne peut pas attendre le prochain
  // rendu pour lire l'état à jour (setState est asynchrone : lire une valeur
  // assignée dans son updater juste après l'appel donne systématiquement
  // undefined, voir bug handleTCRejected corrigé ci-dessous).
  const [dragOver, setDragOver] = useState(false);
  const [ollamaOnline, setOllamaOnline] = useState<boolean | null>(null);
  const [activeView, setActiveView] = useState<ViewTab>('modules');
  // Workflow à ouvrir directement à l'arrivée sur la page (clic sur une
  // notification "workflow validé/exécuté" — voir ?view=workflow&workflowId=...
  // plus bas dans l'effet de chargement depuis l'URL).
  const [openWorkflowId, setOpenWorkflowId] = useState<string | null>(null);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [expandedReqs, setExpandedReqs] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTestType, setFilterTestType] = useState('all');
  const [moduleGenStates, setModuleGenStates] = useState<Record<string, ModuleGenState>>({});
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  // Confirmation avant lancement de campagne — action globale et impactante
  // (fige les workflows, met en standby le reste pour tout le monde), on ne
  // la déclenche jamais sur un simple clic sans confirmation explicite. La
  // CLÔTURE, elle, passe par showCampaignCloseModal ci-dessous (résolution
  // garder/annuler des modifications mises en attente).
  const [showCampaignConfirm, setShowCampaignConfirm] = useState<'launch' | null>(null);
  const [showCampaignCloseModal, setShowCampaignCloseModal] = useState(false);
  const [pendingImpact, setPendingImpact] = useState<ImpactInfo | null>(null);
  const [refreshingImpact, setRefreshingImpact] = useState(false);
  const [revertingImpact, setRevertingImpact] = useState(false);
  const [resolvedImpact, setResolvedImpact] = useState<{ uuid: string; nonce: number; phase?: 'start' | 'done' | 'error' } | null>(null);
  const [showJiraSettings, setShowJiraSettings] = useState(false);
  const { status: jiraStatus } = useJira();
  const [pollingProjectId, setPollingProjectId] = useState<string | null>(null);
  const [formReq, setFormReq] = useState<FormRequirement | null>(null);
  const [anglesPreviewReq, setAnglesPreviewReq] = useState<FormRequirement | null>(null);
  const [dedupRejections, setDedupRejections] = useState<DedupRejection[] | null>(null);
  const commentsDrawer = useCommentsDrawer();
  const unreadComments = useUnreadComments();

  useEffect(() => {
    unreadComments.setActiveProject(projectId);
  }, [projectId]);

  // Mode Création — nombre de TCs déjà affichés EN MÉMOIRE pour ce requirement (validés
  // ou non). Envoyé au backend à chaque appel generate-requirement pour que la
  // numérotation testId continue au lieu de repartir à 01 et écraser les TCs existants
  // au merge (cas "générer quand même" après un rejet dedup, sans validation manuelle entre les deux).
  const getInMemoryTcCount = useCallback((reqUUID: string): number => {
    if (!testResult) return 0;
    const targetReq = testResult.modules
      .flatMap(m => m.requirements)
      .find(r => (r as any)._uuid === reqUUID || r.id === reqUUID);
    return targetReq?.test_cases?.length || 0;
  }, [testResult]);
  const [srsFile, setSrsFile] = useState<File | null>(null);
  const [srsDoc, setSrsDoc] = useState<any>(null);
  const [srsUploadState, setSrsUploadState] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [currentUser, setCurrentUser] = useState<{ email?: string; name?: string; role?: string } | null>(null);
  // Recherche sémantique SRS : tous les rôles y ont accès (ADMIN/BA/PO pour le contexte du contenu qu'ils gèrent, QA pour rédiger des TC pertinents)
  const canAccessSrs = currentUser?.role === 'ADMIN' || currentUser?.role === 'BA' || currentUser?.role === 'PO' || currentUser?.role === 'QA';
  // BA (et PO, même accès) est seul autorisé à éditer le contenu du SRS (modules/exigences)
  const isBA = currentUser?.role === 'BA' || currentUser?.role === 'PO';
  // PO est le rôle hiérarchiquement supérieur au BA : seul lui peut lancer/clôturer la campagne
  const isPO = currentUser?.role === 'PO';
  const canManageCampaign = currentUser?.role === 'PO';
  // QA est seul autorisé à générer/modifier/valider/rejeter/supprimer des cas de test
  const isQA = currentUser?.role === 'QA';
  // BA, PO et QA peuvent exporter vers Jira (pas ADMIN)
  const canExportJira = currentUser?.role === 'BA' || currentUser?.role === 'PO' || currentUser?.role === 'QA';
  const [genModeReq, setGenModeReq] = useState<FormRequirement | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [assistTestError, setAssistTestError] = useState<string | null>(null);
  const [autoGeneratingReq, setAutoGeneratingReq] = useState<FormRequirement | null>(null);
  // Erreur du mode Flash uniquement : contrairement aux modes Signature/Création
  // (qui ont un modal ouvert pour afficher `assistTestError` via externalError),
  // le mode Flash génère directement sans modal — il lui faut son propre toast.
  // Toast de verrou de génération, PARTAGÉ par les 3 modes (Flash, Création,
  // Signature) — le verrou serveur est par exigence, pas par mode : peu importe
  // le mode utilisé par l'autre utilisateur, celui qui tente de générer (avec
  // n'importe quel mode) sur la même exigence doit voir le même message.
  const [genLockToast, setGenLockToast] = useState<{ reqId: string; reqDesc: string; message: string } | null>(null);
  useEffect(() => {
    if (!genLockToast) return;
    const t = setTimeout(() => setGenLockToast(null), 7000);
    return () => clearTimeout(t);
  }, [genLockToast]);
  const [docLanguage, setDocLanguage] = useState<string>('fr');

  // Masque le Header global tant qu'un overlay plein écran est ouvert
  // (GenerationModeSelector, AnglesPreview, AssistTest, ProjectPicker,
  // JiraSettingsModal) : ces modales ont un z-index inférieur à celui du
  // Header et se retrouvaient sinon affichées "sous" la barre de navigation.
  useHideHeaderWhen(
    !!genModeReq || !!anglesPreviewReq || !!formReq || showProjectPicker || showJiraSettings
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const srsFileInputRef = useRef<HTMLInputElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const { status: pollingStatus, data: pollingData, error: pollingError, isPolling } = useProjectPolling({
    projectId: pollingProjectId || undefined,
    pollingInterval: 2000,
    maxRetries: 60,
    onStatusChange: (status) => {
      if (status === 'processing') addLog('⏳ Traitement en cours...', 'info');
      else if (status === 'done') addLog('✅ Traitement terminé', 'success');
      else if (status === 'error') addLog('❌ Erreur lors du traitement', 'error');
    },
    onComplete: (data) => {
      if (data.modules) {
        // ── Normalisation : req.id=ObjectId, req.req_id=FR-01 ──
        const normalizedModules = (data.modules as any[]).map((mod: any) => ({
          name: mod.name,
          _uuid: mod.id,          // ObjectId du module
          description: mod.description ?? '',
          requirements: (mod.requirements || []).map((req: any) => ({
            id: req.req_id ?? req.id,   // identifiant métier FR-01
            _uuid: req.id,              // ObjectId Mongo pour les appels API
            description: req.description,
            priority: req.priority,
            needsReview: req.needs_review ?? false,
            needsReviewReason: req.needs_review_reason ?? null,
            test_cases: req.test_cases || [],
          })),
        }));
        setReqResult({ data: { document_type: 'Document', modules: normalizedModules }, success: true, model: 'async', duration_ms: 0 });
        const hasTestCases = normalizedModules.some((m: any) => m.requirements?.some((r: any) => r.test_cases && r.test_cases.length > 0));
        if (hasTestCases) {
          const modulesWithTests: ModuleWithTests[] = normalizedModules.map((mod: any) => {
            const reqs: RequirementWithTests[] = (mod.requirements || []).map((req: any) => ({ id: req.id, _uuid: req._uuid, description: req.description, priority: req.priority, total_test_cases: req.test_cases?.length || 0, test_cases: deduplicateTestIds((req.test_cases || []).map((tc: any) => normalizeTC(tc, false))) }));
            return { name: mod.name, description: mod.description, total_requirements: reqs.length, total_test_cases: reqs.reduce((a, r) => a + r.total_test_cases, 0), requirements: reqs };
          });
          const totalTCs = modulesWithTests.reduce((a, m) => a + m.total_test_cases, 0);
          setTestResult({ success: true, model: 'async-generated', duration_ms: 0, total_modules: modulesWithTests.length, total_requirements: modulesWithTests.reduce((a, m) => a + m.total_requirements, 0), total_test_cases: totalTCs, modules: modulesWithTests });
          setAppStep('done'); setActiveView('tests');
          addLog(`${totalTCs} cas de test générés`, 'success');
          setExtractionDurationMs(data.extraction_duration_ms);
          const { moduleNames: reviewModules, reqIds: reviewReqs } = needsReviewExpansion(modulesWithTests);
          setExpandedModules(new Set([...modulesWithTests.slice(0, 3).map(m => m.name), ...reviewModules]));
          if (reviewReqs.size > 0) setExpandedReqs(reviewReqs);
        } else {
          setAppStep('extracted');
          setExpandedModules(new Set(data.modules.slice(0, 3).map(m => m.name)));
          addLog(`${data.modules.length} modules · ${data.modules.reduce((a, m) => a + m.requirements.length, 0)} exigences chargés`, 'success');
          setExtractionDurationMs(data.extraction_duration_ms);
        }
      }
    },
    onError: (error) => { addLog(`Erreur: ${error}`, 'error'); setAppStep('error'); },
  });

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  // ── Autosave invisible des TC générés pas encore validés ────────────────────
  // Ne change rien à l'affichage ni au comportement : sert uniquement à ce
  // qu'un reload restaure les TC "en mémoire" (⏳ ATTENTE) tels qu'ils étaient,
  // au lieu de les perdre. Débouncé + dédupliqué par requirement pour éviter
  // de spammer le backend à chaque frappe/rendu.
  const pendingSnapshotRef = useRef<Map<string, string>>(new Map());
  // Posé à `true` juste avant tout setTestResult() qui vient d'un FETCH
  // externe (chargement initial, refreshCurrentProject déclenché par un
  // événement temps réel) plutôt que d'une édition locale réelle. Une simple
  // comparaison de contenu ne suffisait pas : les données fraîchement reçues
  // d'un AUTRE utilisateur diffèrent forcément de notre cache local, ce qui
  // déclenchait à tort une resauvegarde → rebroadcast → faux "vous avez
  // modifié" en boucle chez l'auteur d'origine.
  const skipNextAutosaveRef = useRef(false);
  useEffect(() => {
    if (!testResult || !projectId) return;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      // On met quand même à jour la référence locale (sans sauvegarder), pour
      // qu'une VRAIE édition locale ultérieure soit comparée à l'état actuel
      // et pas à un ancien snapshot périmé.
      testResult.modules.forEach(mod => mod.requirements.forEach(req => {
        const reqUUID = (req as any)._uuid || req.id;
        if (!reqUUID) return;
        pendingSnapshotRef.current.set(reqUUID, JSON.stringify(req.test_cases.filter(tc => !(tc as any).id)));
      }));
      return;
    }
    const timer = setTimeout(() => {
      testResult.modules.forEach(mod => {
        mod.requirements.forEach(req => {
          const reqUUID = (req as any)._uuid || req.id;
          if (!reqUUID) return;
          const pending = req.test_cases.filter(tc => !(tc as any).id);
          const snapshot = JSON.stringify(pending);
          if (pendingSnapshotRef.current.get(reqUUID) === snapshot) return;
          pendingSnapshotRef.current.set(reqUUID, snapshot);
          apiSavePendingTestCases(reqUUID, pending);
        });
      });
    }, 900);
    return () => clearTimeout(timer);
  }, [testResult, projectId]);

  // Charge l'utilisateur courant — sert à réserver l'onglet SRS aux rôles ADMIN et BA
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setCurrentUser(d?.user ?? null))
      .catch(() => setCurrentUser(null));
  }, []);


  // Auto-charger le projet si ?projectId= dans l'URL (venant de /projects, ou d'un
  // clic sur une notification). On accepte aussi l'ancien format (?project=,
  // ?req=/?tc=) pour ne pas casser les notifications déjà stockées en base
  // générées avant la correction du format de lien.
  useEffect(() => {
    const urlProjectId = searchParams?.get('projectId') || searchParams?.get('project');
    const urlMode = searchParams?.get('mode'); // 'create' = nouveau projet vide → édition manuelle directe
    if (urlProjectId) {
      setIsLoadingFromUrl(true);
      fetch(`${ENDPOINTS.projects}/${urlProjectId}`)
        .then(r => r.json())
        .then(async (full) => {
          if (!full?.id) {
            console.warn('[analyzer] Projet introuvable pour projectId=', urlProjectId);
            setIsLoadingFromUrl(false);
            return;
          }
          if (full.status === 'processing') {
            // Document SRS importé depuis /projects, extraction encore en cours côté backend.
            // On bascule sur le même mécanisme de polling que l'upload direct depuis cette page.
            clearResults();
            addLog(`Ouverture : ${full.name}`, 'step');
            addLog('⏳ Extraction du document en cours (import depuis "Nouveau projet")...', 'info');
            setProjectId(full.id);
            setProjectName(full.name || null);
            setAppStep('extracting');
            setPollingProjectId(full.id);
            setSrsDoc(null); setSrsUploadState('idle');
            pollSrsReady(full.id);
          } else {
            await openExistingProject(full);
            // Projet vide créé via "Créer mon SRS dans l'app" → on ouvre directement l'éditeur
            if (urlMode === 'create' && (full.modules || []).length === 0) {
              setEditMode(true);
            }

            // Venant d'un clic sur une notification : ouvre directement le fil de
            // commentaires de l'exigence/TC concernée, une fois le projet chargé.
            // Nouveau format : commentEntityType/commentEntityId.
            // Ancien format (notifications déjà en base) : req=<id> ou tc=<id>.
            let commentEntityType = searchParams?.get('commentEntityType');
            let commentEntityId = searchParams?.get('commentEntityId');
            if (!commentEntityType || !commentEntityId) {
              const legacyReq = searchParams?.get('req');
              const legacyTc = searchParams?.get('tc');
              if (legacyReq) { commentEntityType = 'requirement'; commentEntityId = legacyReq; }
              else if (legacyTc) { commentEntityType = 'test_case'; commentEntityId = legacyTc; }
            }
            if (commentEntityType === 'requirement' || commentEntityType === 'test_case') {
              const allReqs: any[] = (full.modules || []).flatMap((m: any) => m.requirements || []);
              let title: string | undefined;
              if (commentEntityType === 'requirement') {
                title = allReqs.find(r => r.id === commentEntityId)?.req_id;
              } else {
                title = allReqs.flatMap(r => r.test_cases || []).find((t: any) => t.id === commentEntityId)?.test_id;
              }
              commentsDrawer.open({
                projectId: full.id,
                entityType: commentEntityType,
                entityId: commentEntityId!,
                title,
              });
              unreadComments.markRead(full.id, commentEntityType, commentEntityId!);
            }

            // Venant d'un clic sur une notification de workflow (validation,
            // fin d'exécution...) — ouvre directement l'onglet Workflow sur
            // le workflow concerné plutôt que la galerie générale.
            const urlView = searchParams?.get('view');
            const urlWorkflowId = searchParams?.get('workflowId');
            if (urlView === 'workflow' && urlWorkflowId) {
              setActiveView('workflow');
              setOpenWorkflowId(urlWorkflowId);
            }
          }
          window.history.replaceState({}, '', '/analyzer');
          // laisser un tick pour que React applique les états avant d'enlever le loading
          setTimeout(() => setIsLoadingFromUrl(false), 50);
        })
        .catch(err => { console.error('[analyzer] Échec du chargement du projet depuis l\'URL:', err); setIsLoadingFromUrl(false); });
    } else {
      setIsLoadingFromUrl(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  useEffect(() => {
    fetch(ENDPOINTS.health).then(r => r.json()).then(d => setOllamaOnline(d?.ollama?.online ?? false)).catch(() => setOllamaOnline(false));
  }, []);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), msg, type }]);
  }, []);

  const clearResults = useCallback(() => {
    setAppStep('idle'); setLogs([]); setReqResult(null); setCacheHit(false); setExtractionDurationMs(undefined); setTcGenDurations({});
    setTestResult(null); setProjectId(null); setProjectName(null); setExpandedModules(new Set());
    setExpandedReqs(new Set()); setSearchQuery(''); setFilterTestType('all');
    setActiveView('modules'); setModuleGenStates({}); setPollingProjectId(null); setCampaignStatus('draft');
  }, []);

  const reset = useCallback(() => { setFile(null); clearResults(); }, [clearResults]);

  const isRunning = appStep === 'uploading' || appStep === 'extracting' || appStep === 'generating_tests' || Object.values(moduleGenStates).some(s => s === 'generating');

  const openExistingProject = useCallback(async (project: any) => {
    setShowProjectPicker(false); clearResults();
    addLog(`Ouverture : ${project.name}`, 'step');
    try {
      const res = await fetch(`${ENDPOINTS.projects}/${project.id}`);
      const full = await res.json();
      if (!res.ok) throw new Error(full?.message || `HTTP ${res.status}`);
      const data: RequirementsJson = { document_type: full.document_type || 'SRS', modules: (full.modules || []).map((mod: any) => ({ name: mod.name, _uuid: mod.id, description: mod.description, requirements: (mod.requirements || []).map((req: any) => ({ id: req.req_id, _uuid: req.id, description: req.description, priority: req.priority, needsReview: req.needs_review ?? false, needsReviewReason: req.needs_review_reason ?? null })) })) };
      const hasTC = (full.modules || []).some((m: any) => (m.requirements || []).some((r: any) => (r.test_cases || []).length > 0 || (r.pending_test_cases || []).length > 0));
      setReqResult({ data, success: true, model: 'postgresql', duration_ms: 0 });
      setProjectId(full.id); setCacheHit(true);
      setProjectName(full.name || null);
      setCampaignStatus(full.campaign_status === 'launched' ? 'launched' : 'draft');
      setAppStep(hasTC ? 'done' : 'extracted');
      addLog(`${data.modules.length} modules · ${data.modules.reduce((a, m) => a + m.requirements.length, 0)} exigences chargés`, 'success');
      if (hasTC) {
        const modulesWithTests: ModuleWithTests[] = (full.modules || []).map((mod: any) => {
          const reqs: RequirementWithTests[] = (mod.requirements || []).map((req: any) => ({ id: req.req_id, _uuid: req.id, description: req.description, priority: req.priority, total_test_cases: (req.test_cases?.length || 0) + ((req.pending_test_cases || []) as any[]).length, test_cases: combineTestCases(req.test_cases || [], (req.pending_test_cases || []) as any[]) }));
          return { name: mod.name, description: mod.description, total_requirements: reqs.length, total_test_cases: reqs.reduce((a, r) => a + r.total_test_cases, 0), requirements: reqs };
        });
        const totalTCs = modulesWithTests.reduce((a, m) => a + m.total_test_cases, 0);
        skipNextAutosaveRef.current = true;
        setTestResult({ success: true, model: 'postgresql', duration_ms: 0, total_modules: modulesWithTests.length, total_requirements: modulesWithTests.reduce((a, m) => a + m.total_requirements, 0), total_test_cases: totalTCs, modules: modulesWithTests });
        addLog(`${totalTCs} cas de test chargés`, 'success'); setActiveView('tests');
        const { moduleNames: reviewModules, reqIds: reviewReqs } = needsReviewExpansion(modulesWithTests);
        setExpandedModules(new Set([...modulesWithTests.slice(0, 3).map(m => m.name), ...reviewModules]));
        if (reviewReqs.size > 0) setExpandedReqs(reviewReqs);
      } else {
        setExpandedModules(new Set(data.modules.slice(0, 3).map(m => m.name)));
      }
      try {
        const srsRes = await fetch(`${API_BASE}/srs/${full.id}`);
        if (srsRes.ok) { const srsData = await srsRes.json(); if (srsData?.id) { setSrsDoc(srsData); setSrsUploadState('done'); } }
      } catch { }
    } catch (err: any) { addLog(`Erreur : ${err.message}`, 'error'); setAppStep('error'); }
  }, [clearResults, addLog]);

  // ── Recharge les données du projet courant sans réinitialiser l'UI ─────────
  // (contrairement à openExistingProject : ne touche ni activeView, ni
  // expandedModules, ni editMode — utilisé après confirmation du modal
  // "Impact détecté" pour que les badges à réviser apparaissent immédiatement).
  // Patch local ciblé par uuid — utilisé par le retour à l'ancienne version
  // pour appliquer la réponse serveur exacte, sans passer par un rechargement
  // complet du projet (qui pourrait entrer en course avec un polling en cours
  // et écraser la mise à jour par des données pas encore à jour côté serveur).
  const applyRequirementPatchByUuid = useCallback((uuid: string, patch: Record<string, any>) => {
    setReqResult((prev: any) => {
      if (!prev) return prev;
      return {
        ...prev,
        data: {
          ...prev.data,
          modules: (prev.data?.modules ?? []).map((m: any) => ({
            ...m,
            requirements: (m.requirements ?? []).map((r: any) => (r._uuid === uuid ? { ...r, ...patch } : r)),
          })),
        },
      };
    });
  }, []);

  const refreshCurrentProject = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`${ENDPOINTS.projects}/${projectId}`);
      const full = await res.json();
      if (!res.ok) throw new Error(full?.message || `HTTP ${res.status}`);
      setCampaignStatus(full.campaign_status === 'launched' ? 'launched' : 'draft');
      const data: RequirementsJson = { document_type: full.document_type || 'SRS', modules: (full.modules || []).map((mod: any) => ({ name: mod.name, _uuid: mod.id, description: mod.description, requirements: (mod.requirements || []).map((req: any) => ({ id: req.req_id, _uuid: req.id, description: req.description, priority: req.priority, needsReview: req.needs_review ?? false, needsReviewReason: req.needs_review_reason ?? null })) })) };
      setReqResult({ data, success: true, model: 'postgresql', duration_ms: 0 });
      // Toujours recalculer testResult (comme reqResult ci-dessus), même si le
      // projet n'a plus aucun TC : sinon un événement temps réel qui fait
      // tomber le total de TC à 0 (suppression en masse, dernier TC supprimé)
      // laisse testResult bloqué sur son ancien état au lieu de refléter le
      // vide — c'est ce qui cassait le temps réel côté TC (modules/exigences
      // n'ont pas ce problème car setReqResult est déjà inconditionnel).
      const modulesWithTests: ModuleWithTests[] = (full.modules || []).map((mod: any) => {
        const reqs: RequirementWithTests[] = (mod.requirements || []).map((req: any) => ({ id: req.req_id, _uuid: req.id, description: req.description, priority: req.priority, total_test_cases: (req.test_cases?.length || 0) + ((req.pending_test_cases || []) as any[]).length, test_cases: combineTestCases(req.test_cases || [], (req.pending_test_cases || []) as any[]) }));
        return { name: mod.name, description: mod.description, total_requirements: reqs.length, total_test_cases: reqs.reduce((a, r) => a + r.total_test_cases, 0), requirements: reqs };
      });
      const totalTCs = modulesWithTests.reduce((a, m) => a + m.total_test_cases, 0);
      skipNextAutosaveRef.current = true;
      setTestResult({ success: true, model: 'postgresql', duration_ms: 0, total_modules: modulesWithTests.length, total_requirements: modulesWithTests.reduce((a, m) => a + m.total_requirements, 0), total_test_cases: totalTCs, modules: modulesWithTests });
      const { moduleNames: reviewModules, reqIds: reviewReqs } = needsReviewExpansion(modulesWithTests);
      if (reviewModules.size > 0) setExpandedModules(prev => new Set([...Array.from(prev), ...reviewModules]));
      if (reviewReqs.size > 0) setExpandedReqs(prev => new Set([...Array.from(prev), ...reviewReqs]));
    } catch (err: any) {
      addLog(`Erreur de rafraîchissement : ${err.message}`, 'error');
    }
  }, [projectId, addLog]);

  // ── Campagne de tests ────────────────────────────────────────────────────
  // Lance ou clôture la campagne pour le projet courant. Ouverte à tous les
  // rôles (ADMIN/BA/QA) — voir ProjectController.launchCampaign/closeCampaign
  // côté backend, qui vérifie seulement l'appartenance au projet. La mise à
  // jour locale de campaignStatus est immédiate (pas besoin d'attendre le
  // refresh temps réel, qui arrivera aussi via 'campaign:launched'/'closed'
  // pour les AUTRES utilisateurs de la page).
  const handleToggleCampaign = useCallback(async (action: 'launch') => {
    if (!projectId) return;
    setCampaignBusy(true);
    try {
      const res = await fetch(`${ENDPOINTS.projects}/${projectId}/campaign/${action}`, { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`);
      setCampaignStatus('launched');
      addLog("🚦 Campagne de tests lancée — les workflows sont figés ; les autres modifications sont mises en attente jusqu'à la clôture.", 'success');
    } catch (err: any) {
      addLog(`Erreur : ${err.message}`, 'error');
    } finally {
      setCampaignBusy(false);
      setShowCampaignConfirm(null);
    }
  }, [projectId, addLog]);

  // Appelé par CampaignCloseModal une fois la clôture confirmée côté serveur
  // (chaque modification en attente a été résolue — voir ce composant).
  const handleCampaignClosed = useCallback((result: { appliedCount: number; discardedCount: number; failedCount: number }) => {
    setCampaignStatus('draft');
    setShowCampaignCloseModal(false);
    const parts: string[] = [];
    if (result.appliedCount) parts.push(`${result.appliedCount} modification(s) appliquée(s)`);
    if (result.discardedCount) parts.push(`${result.discardedCount} annulée(s)`);
    if (result.failedCount) parts.push(`⚠ ${result.failedCount} en échec (conflit détecté)`);
    addLog(
      `🚦 Campagne de tests clôturée — le projet redevient modifiable${parts.length ? ' (' + parts.join(', ') + ')' : ''}.`,
      result.failedCount ? 'error' : 'success',
    );
    // Les modifications gardées ont été appliquées côté serveur — on
    // recharge le projet pour refléter le nouvel état réel.
    refreshCurrentProject?.();
  }, [addLog, refreshCurrentProject]);

  // ── Collaboration temps réel ────────────────────────────────────────────
  // Tant que ce projet est ouvert, on rejoint sa room WebSocket : dès qu'un
  // autre utilisateur crée/modifie/supprime un module, une exigence, un cas
  // de test, ou lance une génération, on le voit apparaître ici sans reload
  // manuel. On regroupe les événements rapprochés (debounce) pour éviter de
  // spammer refreshCurrentProject si plusieurs changements arrivent d'un coup.
  const [realtimeToast, setRealtimeToast] = useState<string | null>(null);
  const realtimeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showRealtimeToast = useCallback((message: string) => {
    setRealtimeToast(message);
    if (realtimeToastTimer.current) clearTimeout(realtimeToastTimer.current);
    realtimeToastTimer.current = setTimeout(() => setRealtimeToast(null), 4000);
  }, []);

  // Générations actuellement en cours chez LES AUTRES utilisateurs (les
  // événements dont on est soi-même l'auteur sont déjà filtrés par
  // useProjectRealtime — voir le hook). Clé = requirementId, absent pour les
  // générations "module entier" qui ne portent pas de requirementId unique.
  // Alimente à la fois le bandeau persistant et le garde-fou avant de
  // lancer sa propre génération sur la même exigence (voir plus bas).
  const [activeGenerations, setActiveGenerations] = useState<Record<string, ActiveGenerationInfo>>({});
  const activeGenerationsRef = useRef(activeGenerations);
  activeGenerationsRef.current = activeGenerations;

  // Panneau global des générations en cours (voir plus bas, juste avant la
  // toolbar) : replié par défaut dès qu'il y a plus de quelques générations
  // simultanées, pour rester lisible sur un gros projet multi-modules. L'état
  // est réinitialisé implicitement à chaque montage (pas besoin de le
  // persister — il ne s'agit que d'un confort d'affichage).
  const [generationsPanelExpanded, setGenerationsPanelExpanded] = useState(false);

  // Exigences actuellement ouvertes en édition par UN AUTRE utilisateur —
  // présence best-effort (pas un verrou dur, voir requirement:editing côté
  // gateway) affichée dans ModuleReqEditor pour prévenir les collisions
  // AVANT même la sauvegarde. Le vrai filet de sécurité contre l'écrasement
  // silencieux reste le contrôle de version optimiste (voir conflit 409 dans
  // ModuleReqEditor.patchReq).
  const [activeEdits, setActiveEdits] = useState<Record<string, { actorName: string }>>({});
  // Même forme qu'activeEdits, mais pour "quelqu'un a le formulaire
  // + Nouveau TC ouvert" (voir requirement:adding / notifyRequirementAdding).
  const [activeAdditions, setActiveAdditions] = useState<Record<string, { actorName: string }>>({});
  // Cas de test actuellement en cours de modification (édits locaux non
  // encore sauvegardés) par UN AUTRE utilisateur — même présence légère que
  // activeEdits, mais côté TC (voir testcase:editing / notifyTestCaseEditing,
  // déclenché depuis TCCard sur les transitions de `hasEdits`). Clé =
  // testCaseId (uniquement les TC persistés ont un id exploitable). Alimente
  // la bannière "Activité de l'équipe en cours" au même titre que
  // génération/édition d'exigence/ajout — c'est ce qui manquait pour que les
  // actions sur les TC (modification) y apparaissent.
  const [activeTcEdits, setActiveTcEdits] = useState<Record<string, { actorName: string; testId?: string; reqUUID?: string }>>({});

  // Présence légère "qui regarde cette ligne" — badge "👀 Nom" affiché
  // directement sur la ligne de l'exigence ou du TC (voir requirement:viewing
  // / testcase:viewing côté gateway). Contrairement à activeEdits ci-dessus,
  // plusieurs personnes peuvent apparaître sur la même ligne à la fois — d'où
  // un tableau de noms par clé (`req:<uuid>` ou `tc:<testId>`) plutôt qu'une
  // seule entrée. Purement informatif, aucun verrou associé.
  const [activeViews, setActiveViews] = useState<Record<string, string[]>>({});

  // Registre des éléments DOM des lignes exigence/TC (mêmes clés `req:<uuid>` /
  // `tc:<testId>` que activeViews/flashIds ci-dessus) — alimenté par chaque
  // ReqWithTestsCard/TCCard via registerEntityRef (ref callback). Sert
  // uniquement au "follow" (clic sur un avatar de présence → scrollIntoView
  // vers ce que cette personne regarde, voir scrollToEntity plus bas) : pas
  // besoin de re-render sur ces changements, un objet ref simple suffit.
  const entityRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const registerEntityRef = useCallback((key: string, el: HTMLDivElement | null) => {
    entityRefs.current[key] = el;
  }, []);

  // Flash de mise à jour live : quand un `requirement:updated`/`testcase:updated`
  // arrive d'un autre utilisateur, on surligne brièvement la ligne concernée
  // (au lieu du refresh silencieux) pour que l'œil capte immédiatement où le
  // changement a eu lieu. Clé = `req:<reqUuid>` ou `tc:<testId>`. On garde
  // aussi l'horodatage pour pouvoir re-déclencher le flash si un 2e événement
  // arrive sur la même ligne pendant que l'animation précédente tourne encore.
  const [flashIds, setFlashIds] = useState<Record<string, number>>({});
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const FLASH_DURATION_MS = 1800;

  const triggerFlash = useCallback((key: string) => {
    setFlashIds(prev => ({ ...prev, [key]: Date.now() }));
    if (flashTimers.current[key]) clearTimeout(flashTimers.current[key]);
    flashTimers.current[key] = setTimeout(() => {
      setFlashIds(prev => { const n = { ...prev }; delete n[key]; return n; });
      delete flashTimers.current[key];
    }, FLASH_DURATION_MS);
  }, []);

  useEffect(() => () => { Object.values(flashTimers.current).forEach(clearTimeout); }, []);

  // ── "Follow" : clic sur un avatar de présence → scroll jusqu'à ce que
  // cette personne regarde ────────────────────────────────────────────────
  // Déplie (module + exigence), scrolle et flashe la ligne ciblée par la
  // clé `req:<uuid>` ou `tc:<testId>` (mêmes clés que activeViews/flashIds).
  // Un léger délai laisse le temps au DOM de se rendre après le dépli avant
  // d'appeler scrollIntoView, sinon la ref pointe encore vers une ligne pas
  // encore montée (module/exigence repliés).
  const scrollToEntity = useCallback((key: string, preferredView?: ViewTab) => {
    const [kind, id] = key.split(':');
    let targetModuleName: string | undefined;
    let targetReqId: string | undefined;

    // Pour une exigence, on cherche d'abord dans reqResult : contrairement à
    // testResult (null tant qu'aucun cas de test n'a été généré, et qui de
    // toute façon ne liste que les exigences ayant déjà des TC — voir le
    // filtre de filteredTestModules), reqResult est disponible dès que les
    // exigences sont chargées. Indispensable pour suivre quelqu'un qui
    // regarde/édite une exigence dans l'onglet Exigences (ModuleCard), avant
    // toute génération.
    if (kind === 'req' && reqResult?.data?.modules) {
      for (const mod of reqResult.data.modules) {
        const match = (mod.requirements || []).find((r: any) => ((r as any)._uuid || r.id) === id);
        if (match) { targetModuleName = mod.name; targetReqId = match.id; break; }
      }
    }
    // Repli sur testResult (obligatoire pour un TC, qui n'existe que là).
    if ((!targetModuleName || kind === 'tc') && testResult) {
      for (const mod of testResult.modules) {
        for (const req of mod.requirements) {
          const reqUUID = (req as any)._uuid || req.id;
          const matches = kind === 'req' ? reqUUID === id : req.test_cases.some(tc => (tc as any).id === id);
          if (matches) { targetModuleName = mod.name; targetReqId = req.id; break; }
        }
        if (targetModuleName) break;
      }
    }
    if (!targetModuleName || !targetReqId) return;

    const view: ViewTab = kind === 'tc' ? 'tests' : (preferredView ?? 'tests');
    setActiveView(view);
    // ModuleCard (où sont enregistrées les refs des exigences de l'onglet
    // "Exigences") n'est monté que si le SUIVEUR n'a pas lui-même son mode
    // édition ouvert (sinon c'est ModuleReqEditor qui s'affiche à la place).
    if (view === 'modules') setEditMode(false);
    setExpandedModules(prev => { const n = new Set(prev); n.add(targetModuleName!); return n; });
    if (view === 'tests') setExpandedReqs(prev => { const n = new Set(prev); n.add(targetReqId!); return n; });
    triggerFlash(key);
    setTimeout(() => { entityRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 300);
  }, [reqResult, testResult, triggerFlash]);

  // Suivre quelqu'un = retrouver CE QU'IL REGARDE (activeViews, présence "👀")
  // en priorité, avec repli sur CE QU'IL GÉNÈRE (activeGenerations) si cette
  // personne n'a actuellement aucune ligne dépliée — ex: génération lancée en
  // Mode Flash, sans jamais ouvrir la ligne. Recalculé à chaque changement de
  // présence : reflète toujours l'endroit actuel, pas un snapshot figé au clic.
  const handleFollowUser = useCallback((u: { userId: string; userName: string }) => {
    if (u.userId === authUser?.id) return; // se suivre soi-même n'a pas de sens
    let key: string | undefined;
    let preferredView: ViewTab | undefined;
    // 1. Ce qu'il regarde activement (👀, onglet Cahier — seul endroit qui
    // émet requirement:viewing/testcase:viewing aujourd'hui).
    for (const [entityKey, names] of Object.entries(activeViews)) {
      if (names.includes(u.userName)) { key = entityKey; preferredView = 'tests'; break; }
    }
    // 2. Repli : une exigence qu'il est en train d'éditer (onglet Exigences,
    // ModuleReqEditor — voir activeEdits/requirement:editing).
    if (!key) {
      const editing = Object.entries(activeEdits).find(([, info]) => info.actorName === u.userName);
      if (editing) { key = `req:${editing[0]}`; preferredView = 'modules'; }
    }
    // 3. Repli : une génération en cours pour lui (pas de ligne dépliée,
    // ex: Mode Flash lancé sans jamais ouvrir la ligne).
    if (!key) {
      const generating = Object.entries(activeGenerations).find(([, info]) => info.actorId === u.userId);
      if (generating) { key = `req:${generating[0]}`; preferredView = 'tests'; }
    }
    if (!key) { showRealtimeToast(`${u.userName} ne consulte rien en ce moment`); return; }
    scrollToEntity(key, preferredView);
  }, [activeViews, activeEdits, activeGenerations, authUser?.id, scrollToEntity, showRealtimeToast]);

  const realtimeRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Dernier événement temps réel concernant un workflow de test (voir plus
  // bas dans handleProjectRealtimeEvent) — relayé à TestWorkflowBoard via
  // une prop dédiée pour qu'il rafraîchisse sa propre galerie (validation
  // par un BA visible instantanément chez les autres utilisateurs).
  const [workflowRealtimeEvent, setWorkflowRealtimeEvent] = useState<{ event: ProjectRealtimeEvent; payload: ProjectRealtimePayload; at: number } | null>(null);
  const handleProjectRealtimeEvent = useCallback((event: ProjectRealtimeEvent, payload: ProjectRealtimePayload) => {
    const who = payload.actorName || 'Quelqu\'un';
    // Le toast (bannière) affiche EXACTEMENT le même texte que le fil
    // d'activité : au lieu de reconstituer un libellé approximatif à partir
    // du seul type d'événement (qui ne distingue pas "créé à la main" de
    // "validé depuis une génération", etc. — source des messages incohérents
    // constatés), on réutilise TEL QUEL le message déjà calculé côté backend
    // (voir buildActivityLog dans project.controller.ts) et diffusé via
    // l'événement dédié 'activity:new' — la même donnée qui alimente le
    // panneau 🕒 Fil d'activité.
    if (event === 'activity:new') {
      const message = (payload as any).message as string | undefined;
      if (message) { addLog(`👥 ${message}`, 'info'); showRealtimeToast(message); }
      // 'activity:new' est le SEUL événement diffusé sans filtrage
      // par auteur (voir useProjectRealtime.ts) — on le reçoit donc aussi
      // pour nos propres actions. Sans ce retour, il tombait dans le code
      // générique plus bas qui programme refreshCurrentProject() à 600ms,
      // ce qui pouvait arriver AVANT que l'autosave débouncée à 900ms
      // (apiSavePendingTestCases) n'ait persisté un rejet de TC en attente
      // côté serveur : le refresh rechargeait alors un `pending_test_cases`
      // encore périmé (TC pas encore retiré en base), FAISANT RÉAPPARAÎTRE
      // le TC qu'on venait de rejeter — et annulant au passage le timer de
      // sauvegarde de 900ms (cleanup du useEffect), donc le rejet n'était
      // jamais réellement persisté au 1er clic (d'où le besoin d'un 2e
      // rejet pour que ça "marche"). Pour nos propres actions, la donnée
      // locale est déjà à jour (mise à jour optimiste faite par le handler
      // de l'action elle-même) : pas besoin de refetch, et surtout pas
      // question de risquer d'écraser un changement local pas encore
      // persisté.
      if (payload.actorId && payload.actorId === authUser?.id) return;
      // Pas de `return` ici pour les événements d'un AUTRE utilisateur : on
      // laisse les événements 'testcase:*' / 'module:*' / ... continuer à
      // arriver en parallèle plus bas pour leurs propres effets de bord
      // (flash de ligne, refresh des données).
    } else if (event === 'generation:started') {
      // Seul événement transitoire volontairement absent du fil d'activité
      // (voir commentaire dans buildActivityLog côté backend) — son propre
      // toast local, puisqu'il n'existe pas de message backend équivalent.
      const label = `${who} lance une génération de cas de test…`;
      addLog(`👥 ${label}`, 'info');
      showRealtimeToast(label);
    }

    const reqId = (payload as any).requirementId as string | undefined;
    const actorId = payload.actorId as string | undefined;
    const genMode = (payload as any).genMode as GenerationMode | undefined;
    const step = (payload as any).step as ActiveGenerationInfo['step'] | undefined;
    if (event === 'generation:started' && reqId) {
      setActiveGenerations(prev => ({ ...prev, [reqId]: { actorId, actorName: who, genMode, step } }));
    }
    if (event === 'generation:completed' && reqId) {
      // Une étape informative (angles/form, sans verrou) qui se termine ne
      // doit pas effacer une étape 'testcases' déjà en cours pour le même
      // req si un événement arrive en retard/désordonné (rare, best-effort) —
      // on ne supprime que si l'étape en base correspond à celle qui se
      // termine, ou si aucune étape n'est renseignée (ancien format).
      setActiveGenerations(prev => {
        const current = prev[reqId];
        if (current && step && current.step && current.step !== step) return prev;
        const n = { ...prev }; delete n[reqId]; return n;
      });
    }

    if (event === 'project:deleted') {
      addLog(`⚠️ Ce projet a été supprimé par ${who}`, 'error');
      return;
    }
    // Campagne de tests : mise à jour immédiate (pas d'attente du refresh
    // débounce ci-dessous) pour que les boutons se grisent/dégrisent sans
    // délai perceptible chez les autres utilisateurs de la page.
    if (event === 'campaign:launched') {
      setCampaignStatus('launched');
      const message = `${who} a lancé la campagne de tests — le projet est figé, seule l'exécution des workflows reste possible.`;
      addLog(`🚦 ${message}`, 'info'); showRealtimeToast(message);
    }
    if (event === 'campaign:closed') {
      setCampaignStatus('draft');
      const message = `${who} a clôturé la campagne de tests — le projet redevient modifiable.`;
      addLog(`🚦 ${message}`, 'info'); showRealtimeToast(message);
    }
    // Présence d'édition : pas de refresh de données (rien n'a changé en
    // base), juste un badge visuel — traité à part, avant le early-return
    // "generation:started" ci-dessous qui ne le concerne pas.
    if (event === 'requirement:editing') {
      const reqId = (payload as any).requirementId as string | undefined;
      if (!reqId) return;
      const active = Boolean((payload as any).active);
      setActiveEdits(prev => {
        if (active) return { ...prev, [reqId]: { actorName: who } };
        const n = { ...prev }; delete n[reqId]; return n;
      });
      return;
    }
    // Présence "formulaire + Nouveau TC ouvert" — même mécanique que
    // requirement:editing ci-dessus, alimente activeAdditions (fusionné avec
    // activeGenerations/activeEdits dans la bannière "Activité en cours").
    if (event === 'requirement:adding') {
      const reqId = (payload as any).requirementId as string | undefined;
      if (!reqId) return;
      const active = Boolean((payload as any).active);
      setActiveAdditions(prev => {
        if (active) return { ...prev, [reqId]: { actorName: who } };
        const n = { ...prev }; delete n[reqId]; return n;
      });
      return;
    }
    // Présence "quelqu'un modifie ce cas de test" (édits locaux non
    // sauvegardés) — même mécanique que requirement:editing/adding
    // ci-dessus, alimente activeTcEdits (fusionné dans la bannière "Activité
    // en cours", voir activeTeamWorkEntries plus bas).
    if (event === 'testcase:editing') {
      const testCaseId = (payload as any).testCaseId as string | undefined;
      if (!testCaseId) return;
      const active = Boolean((payload as any).active);
      const testId = (payload as any).testId as string | undefined;
      const reqUUID = (payload as any).requirementId as string | undefined;
      setActiveTcEdits(prev => {
        if (active) return { ...prev, [testCaseId]: { actorName: who, testId, reqUUID } };
        const n = { ...prev }; delete n[testCaseId]; return n;
      });
      return;
    }
    // Présence légère "qui regarde" — même logique que ci-dessus mais avec
    // plusieurs viewers possibles par ligne (ajout/retrait d'un nom dans la
    // liste au lieu d'une entrée unique).
    if (event === 'requirement:viewing' || event === 'testcase:viewing') {
      const entityId = event === 'requirement:viewing'
        ? (payload as any).requirementId as string | undefined
        : (payload as any).testCaseId as string | undefined;
      if (!entityId) return;
      const key = event === 'requirement:viewing' ? `req:${entityId}` : `tc:${entityId}`;
      const active = Boolean((payload as any).active);
      setActiveViews(prev => {
        const names = prev[key] || [];
        if (active) {
          if (names.includes(who)) return prev;
          return { ...prev, [key]: [...names, who] };
        }
        const filtered = names.filter(n => n !== who);
        const next = { ...prev };
        if (filtered.length > 0) next[key] = filtered; else delete next[key];
        return next;
      });
      return;
    }
    // On ne rafraîchit pas sur un simple "generation:started" (rien de
    // nouveau à charger tant que ce n'est pas terminé).
    if (event === 'generation:started') return;

    // Workflows de test — géré entièrement par TestWorkflowBoard (son propre
    // état, séparé de testResult/modules) : on relaie juste le dernier
    // événement reçu via une prop dédiée plutôt que de dupliquer une seconde
    // connexion WebSocket dans ce composant. `refreshCurrentProject()`
    // ci-dessous ne concerne que modules/exigences/cas de test, donc on
    // s'arrête ici pour un événement workflow — pas de rapport avec lui.
    if (event.startsWith('workflow:')) {
      setWorkflowRealtimeEvent({ event, payload, at: Date.now() });
      return;
    }

    // Flash de la ligne modifiée : au lieu de laisser le refresh silencieux
    // être la seule trace visible du changement, on surligne brièvement la
    // ligne concernée dès que le refresh a eu le temps de charger la donnée
    // à jour (même délai que realtimeRefreshTimer ci-dessous, +un poil pour
    // être sûr que la ligne existe déjà dans le DOM au moment du flash).
    if (event === 'requirement:updated') {
      const req = (payload as any).requirement as any;
      const reqUuid = req?.id || req?._id;
      if (reqUuid) setTimeout(() => triggerFlash(`req:${reqUuid}`), 650);
    }
    if (event === 'testcase:updated') {
      const tcData = (payload as any).testCase as any;
      const testId = tcData?.test_id || tcData?.testId;
      if (testId) setTimeout(() => triggerFlash(`tc:${testId}`), 650);
      // Autosave des TC en attente (voir savePendingTestCases côté backend) :
      // pas un seul `testCase`, mais une liste de `testIds` modifiés d'un coup.
      const testIds = (payload as any).testIds as string[] | undefined;
      if (Array.isArray(testIds) && testIds.length > 0) {
        setTimeout(() => testIds.forEach(id => triggerFlash(`tc:${id}`)), 650);
      }
    }

    if (realtimeRefreshTimer.current) clearTimeout(realtimeRefreshTimer.current);
    realtimeRefreshTimer.current = setTimeout(() => { refreshCurrentProject(); }, 600);
  }, [addLog, refreshCurrentProject, showRealtimeToast, triggerFlash, authUser?.id]);

  const { presence: projectPresence, notifyActivity } = useProjectRealtime(projectId, handleProjectRealtimeEvent);

  // Un utilisateur qui a lancé une génération peut fermer son onglet avant
  // qu'elle ne se termine — le job continue côté serveur (voir jobStore.run
  // dans llm.controller.ts), mais sa présence live disparaît alors (socket
  // déconnecté). Sans ce merge, le bandeau "X (Mode Y) génère..." reste
  // visible mais la barre de présence affiche à tort "Vous seul(e) sur ce
  // projet", ce qui est incohérent pour qui lit les deux à la fois.
  const mergedProjectPresence = useMemo(() => {
    const byId = new Map(projectPresence.map(u => [u.userId, u] as const));
    for (const info of Object.values(activeGenerations)) {
      if (!info.actorId) continue; // ancien format d'événement sans actorId — rien à fusionner
      const existing = byId.get(info.actorId);
      // 'form' (remplissage du formulaire Signature, pas encore de génération
      // en cours) est plus proche d'une édition que d'une génération active ;
      // 'angles'/'testcases' correspondent à un vrai appel LLM en cours.
      const activity: 'editing' | 'generating' = info.step === 'form' ? 'editing' : 'generating';
      const activityLabel = info.genMode ? GEN_MODE_LABELS[info.genMode] : undefined;
      byId.set(info.actorId, {
        userId: info.actorId,
        userName: existing?.userName || info.actorName,
        // Ne rétrograde jamais une activité déjà affichée par la présence live
        // (ex: 'editing' un autre req) — sauf s'il n'y en avait pas encore.
        activity: existing?.activity && existing.activity !== 'idle' ? existing.activity : activity,
        activityLabel: existing?.activityLabel || activityLabel,
      });
    }
    return Array.from(byId.values());
  }, [projectPresence, activeGenerations]);

  // Signale aux autres utilisateurs qu'on est en train d'éditer le SRS
  // (mode édition BA) — repasse à 'idle' à la fermeture ou au changement de projet.
  useEffect(() => {
    if (!projectId) return;
    notifyActivity(editMode ? 'editing' : 'idle', editMode ? 'édition des exigences' : undefined);
  }, [editMode, projectId, notifyActivity]);

  // Signale la présence fine "j'édite CETTE exigence" — voir ModuleReqEditor
  // (appelé au focus/blur d'un champ). Pose un vrai verrou côté serveur (voir
  // POST .../editing-presence) : si quelqu'un d'autre a déjà la main, l'appel
  // renvoie { ok: false, lockedByName } et ModuleReqEditor refuse d'ouvrir le
  // champ localement. En cas d'erreur réseau on n'empêche pas l'édition
  // locale (best-effort) — le vrai filet de sécurité reste le contrôle de
  // version optimiste à la sauvegarde (409 sur PATCH requirements/:id).
  const notifyRequirementEditing = useCallback(async (reqUUID: string, active: boolean): Promise<{ ok: boolean; lockedByName?: string }> => {
    if (!reqUUID) return { ok: true };
    try {
      const res = await fetch(`${API_BASE}/projects/requirements/${reqUUID}/editing-presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => null);
        return { ok: false, lockedByName: data?.actorName || data?.message };
      }
      return { ok: res.ok };
    } catch {
      return { ok: true };
    }
  }, []);

  // Présence légère "j'ai ouvert/sélectionné cette exigence" — pas de verrou
  // (voir POST .../requirements/:id/viewing-presence), best-effort : une
  // erreur réseau ne bloque rien côté UI, juste pas de badge affiché aux
  // autres pour cette session.
  //
  // Garde-fou anti-tempête réseau : ces callbacks sont déclenchés par des
  // useEffect de montage/démontage (voir ReqWithTestsCard / TCCard). Si un
  // composant venait à se démonter/remonter en boucle pour une raison
  // quelconque (ex: collision de clé React sur une liste), ces effets
  // enverraient autant de requêtes par seconde que de cycles de montage,
  // jusqu'à épuiser les connexions du navigateur (ERR_INSUFFICIENT_RESOURCES)
  // — cf. bug corrigé sur la clé de ReqWithTestsCard. sendPresenceDebounced
  // coalesce les appels rapprochés (< 250ms) sur une même clé en un seul
  // envoi de la dernière valeur, et ignore les envois redondants (valeur
  // identique au dernier envoi confirmé) : quoi qu'il arrive côté rendu, le
  // volume réseau réel reste borné à quelques requêtes par seconde et par
  // entité, jamais une rafale illimitée.
  const presenceStateRef = useRef<Map<string, { timer: ReturnType<typeof setTimeout> | null; lastSent?: boolean }>>(new Map());
  const sendPresenceDebounced = useCallback((key: string, active: boolean, doSend: () => void) => {
    const entry = presenceStateRef.current.get(key) || { timer: null };
    if (entry.timer === null && entry.lastSent === active) return; // rien de nouveau à envoyer
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      presenceStateRef.current.set(key, { timer: null, lastSent: active });
      doSend();
    }, 250);
    presenceStateRef.current.set(key, entry);
  }, []);

  const notifyRequirementViewing = useCallback((reqUUID: string | undefined, active: boolean) => {
    if (!reqUUID) return;
    sendPresenceDebounced(`reqView:${reqUUID}`, active, () => {
      fetch(`${API_BASE}/projects/requirements/${reqUUID}/viewing-presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      }).catch(() => {});
    });
  }, [sendPresenceDebounced]);

  // Présence "j'ai le formulaire + Nouveau TC ouvert pour cette exigence" —
  // même mécanique légère (sans verrou) que notifyRequirementViewing
  // ci-dessus, voir POST .../requirements/:id/adding-presence. Alimente la
  // bannière "Activité de l'équipe en cours" (avec génération/édition).
  const notifyRequirementAdding = useCallback((reqUUID: string | undefined, active: boolean) => {
    if (!reqUUID) return;
    sendPresenceDebounced(`reqAdd:${reqUUID}`, active, () => {
      fetch(`${API_BASE}/projects/requirements/${reqUUID}/adding-presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      }).catch(() => {});
    });
  }, [sendPresenceDebounced]);

  // Même chose pour un cas de test (voir POST .../test-cases/:id/viewing-presence).
  const notifyTestCaseViewing = useCallback((testCaseId: string | undefined, active: boolean) => {
    if (!testCaseId) return;
    sendPresenceDebounced(`tcView:${testCaseId}`, active, () => {
      fetch(`${API_BASE}/projects/test-cases/${testCaseId}/viewing-presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      }).catch(() => {});
    });
  }, [sendPresenceDebounced]);

  // Présence "je modifie ce cas de test" — déclenchée par TCCard sur les
  // transitions de `hasEdits` (édits locaux non sauvegardés). Même mécanique
  // légère (sans verrou) que notifyTestCaseViewing ci-dessus, voir POST
  // .../test-cases/:id/editing-presence. C'est ce qui manquait pour que les
  // actions sur les TC (modification) apparaissent dans la bannière/panneau
  // "Activité de l'équipe en cours", au même titre que génération/édition
  // d'exigence/ajout — testId/reqUUID sont transmis pour un libellé précis
  // ("X modifie le cas de test TC-3.2") sans aller-retour DB côté serveur.
  const notifyTestCaseEditing = useCallback((testCaseId: string | undefined, active: boolean, testId?: string, reqUUID?: string) => {
    if (!testCaseId) return;
    sendPresenceDebounced(`tcEdit:${testCaseId}`, active, () => {
      fetch(`${API_BASE}/projects/test-cases/${testCaseId}/editing-presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active, testId, requirementId: reqUUID }),
      }).catch(() => {});
    });
  }, [sendPresenceDebounced]);

  // Le backend indexe le SRS automatiquement dès l'upload (étape 1 du pipeline,
  // avant l'extraction LLM qui peut durer jusqu'à ~20 min). On poll ce endpoint
  // séparément et rapidement pour que "Recherche intelligente" soit utilisable
  // dès que l'indexation est prête, sans attendre la fin de toute l'extraction.
  const pollSrsReady = useCallback((pid: string) => {
    let attempts = 0;
    const maxAttempts = 30; // ~60s à 2s d'intervalle — largement suffisant pour l'indexation
    const tick = async () => {
      attempts++;
      try {
        const res = await fetch(`${API_BASE}/srs/${pid}`);
        if (res.ok) {
          const data = await res.json();
          if (data?.id) { setSrsDoc(data); setSrsUploadState('done'); return; }
        }
      } catch { /* on réessaiera */ }
      if (attempts < maxAttempts) setTimeout(tick, 2000);
    };
    tick();
  }, []);

  const runExtraction = async () => {
    if (!file || isRunning) return;
    clearResults();
    addLog(`Fichier : ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`, 'info');
    setAppStep('uploading');
    addLog('Étape 1/2 — Upload du fichier...', 'step');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('projectName', file.name.replace(/\.[^/.]+$/, '') || `Project-${Date.now()}`);
    try {
      const res = await fetch(ENDPOINTS.upload, { method: 'POST', body: formData });
      const text = await res.text();
      let uploadResult: any;
      try { uploadResult = JSON.parse(text); } catch { throw new Error(`Non-JSON: ${text.slice(0, 200)}`); }
      if (!res.ok) throw new Error(uploadResult.error || `HTTP ${res.status}`);
      const newProjectId = uploadResult.projectId;
      if (!newProjectId) throw new Error('No projectId returned from server');
      addLog(`✅ Projet créé — ID: ${newProjectId.slice(0, 8)}...`, 'success');
      addLog('Étape 2/2 — Traitement en arrière-plan (polling)...', 'step');
      setProjectId(newProjectId);
      setProjectName(file.name.replace(/\.[^/.]+$/, '') || `Project-${Date.now()}`);
      setPollingProjectId(newProjectId); setAppStep('extracting');
      setSrsDoc(null); setSrsUploadState('idle');
      pollSrsReady(newProjectId);
    } catch (err: any) { addLog(`Erreur upload : ${err.message}`, 'error'); setAppStep('error'); }
  };


  const runTestGeneration = async (singleModuleName?: string) => {
    if (!reqResult?.data || isRunning) return;
    const targetModules = singleModuleName ? reqResult.data.modules.filter((m: any) => m.name === singleModuleName) : reqResult.data.modules;
    if (targetModules.length === 0) return;
    if (singleModuleName) { setModuleGenStates(prev => ({ ...prev, [singleModuleName]: 'generating' })); addLog(`Génération pour "${singleModuleName}"...`, 'step'); }
    else { setAppStep('generating_tests'); setActiveView('tests'); addLog(`Génération — ${targetModules.length} modules`, 'step'); }
    notifyActivity('generating', singleModuleName ? `module ${singleModuleName}` : 'cas de test');
    try {
      const res = await fetch(`${ENDPOINTS.step2Tests}?model=${encodeURIComponent(model)}${singleModuleName ? '&nocache=true' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requirements: { ...reqResult.data, modules: targetModules }, model, project_id: projectId }) });
      const data: TestCaseResult = await res.json();
      if (!res.ok) throw new Error((data as any)?.error || `HTTP ${res.status}`);
      addLog(`✓ ${data.total_test_cases} cas générés${data.duration_ms ? ` — en ${formatDuration(data.duration_ms)}` : ''} — validez pour sauvegarder`, 'success');
      if (data.errors?.length) data.errors.forEach(e => addLog(`⚠ ${e}`, 'warn'));
      setTestResult(prev => {
        const enriched = data.modules.map((mod: any) => ({ ...mod, requirements: mod.requirements.map((req: any) => { const srcMod = (reqResult?.data?.modules ?? []).find((m: any) => m.name === mod.name); const srcReq = (srcMod?.requirements ?? []).find((r: any) => r.id === req.id); return { ...req, _uuid: (srcReq as any)?._uuid ?? req._uuid ?? null, test_cases: deduplicateTestIds((req.test_cases || []).map((tc: any) => normalizeTC(tc, false))) }; }) }));
        if (!prev || !prev.modules || prev.modules.length === 0) return { ...data, modules: enriched };
        const mergedModules = prev.modules.map(prevMod => {
          const newMod = enriched.find(m => m.name === prevMod.name);
          if (!newMod) return prevMod;
          const mergedReqs = prevMod.requirements.map(prevReq => {
            const newReq = newMod.requirements.find((r: any) => r.id === prevReq.id);
            if (!newReq) return prevReq;
            const mergedTCs = mergeTCs(prevReq.test_cases || [], newReq.test_cases || []);
            return { ...prevReq, _uuid: prevReq._uuid || (newReq as any)._uuid, test_cases: mergedTCs, total_test_cases: mergedTCs.length };
          }).concat(newMod.requirements.filter((newReq: any) => !prevMod.requirements.some((r: any) => r.id === newReq.id)));
          return { ...prevMod, ...newMod, requirements: mergedReqs, total_test_cases: mergedReqs.reduce((sum, r) => sum + r.total_test_cases, 0), total_requirements: mergedReqs.length };
        }).concat(enriched.filter(newMod => !prev.modules.some(m => m.name === newMod.name)));
        return { ...prev, modules: mergedModules, total_test_cases: mergedModules.reduce((sum, mod) => sum + (mod.total_test_cases || 0), 0), total_modules: mergedModules.length };
      });
      if (singleModuleName) { setModuleGenStates(prev => ({ ...prev, [singleModuleName]: 'done' })); setExpandedModules(prev => { const n = new Set(prev); n.add(singleModuleName); return n; }); setActiveView('tests'); }
      else { setAppStep('done'); setExpandedModules(prev => new Set([...Array.from(prev), ...data.modules.map(m => m.name)])); const done: Record<string, ModuleGenState> = {}; targetModules.forEach((m: any) => { done[m.name] = 'done'; }); setModuleGenStates(prev => ({ ...prev, ...done })); }
    } catch (err: any) { addLog(`Erreur : ${err.message}`, 'error'); if (singleModuleName) setModuleGenStates(prev => ({ ...prev, [singleModuleName]: 'error' })); else setAppStep('error'); }
    finally { notifyActivity('idle'); }
  };

  const handleTCRegenerated = useCallback((reqUUID: string, newTCs: any[]) => {
    const normalized = deduplicateTestIds(newTCs.map(tc => normalizeTC(tc, false)));
    setTestResult(prev => { if (!prev) return prev; return { ...prev, modules: prev.modules.map(mod => ({ ...mod, requirements: mod.requirements.map(req => { const match = (req as any)._uuid === reqUUID; if (!match) return req; return { ...req, test_cases: normalized, total_test_cases: normalized.length }; }) })) }; });
    addLog('TC régénérés — validez pour sauvegarder', 'success');
  }, [addLog]);

  const handleSingleTCUpdated = useCallback((tcTestId: string, updatedTC: TestCase) => {
    setTestResult(prev => { if (!prev) return prev; return { ...prev, modules: prev.modules.map(mod => ({ ...mod, requirements: mod.requirements.map(req => ({ ...req, test_cases: req.test_cases.map(tc => tc.testId === tcTestId ? { ...updatedTC, testId: tcTestId } : tc) })) })) }; });
  }, []);

  const handleTCValidated = useCallback(async (tcTestId: string, patch: Partial<TestCase>) => {
    setTestResult(prev => { if (!prev) return prev; return { ...prev, modules: prev.modules.map(mod => ({ ...mod, requirements: mod.requirements.map(req => ({ ...req, test_cases: req.test_cases.map(tc => tc.testId === tcTestId ? { ...tc, ...patch } : tc) })) })) }; });
  }, []);

  const handleTCRejected = useCallback(async (tcTestId: string, requirementIdForBulk?: string) => {
    if (requirementIdForBulk) {
      // Suppression atomique côté serveur (par UUID du requirement) — évite toute
      // dépendance au suivi individuel des id Mongo de chaque TC côté front.
      try {
        const res = await fetch(`${API_BASE}/projects/requirements/${requirementIdForBulk}/test-cases`, { method: 'DELETE' });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error((d as any)?.message || `HTTP ${res.status}`);
        }
      } catch (err: any) {
        console.error('[handleTCRejected] bulk delete error:', err);
        addLog(`Erreur lors du rejet en masse : ${err.message}`, 'error');
        return; // ne pas vider l'affichage si la suppression en base a échoué
      }
      setTestResult(prev => { if (!prev) return prev; const modules = prev.modules.map(mod => ({ ...mod, requirements: mod.requirements.map(req => ((req as any)._uuid === requirementIdForBulk || req.id === requirementIdForBulk) ? { ...req, test_cases: [], total_test_cases: 0 } : req) })); return { ...prev, modules }; });
      return;
    }
    // La suppression/le rejet côté serveur a déjà eu lieu dans
    // TCCard.confirmReject (apiDeleteTC ou apiRejectPendingTC) AVANT l'appel à
    // onRejected() qui aboutit ici — y compris la gestion du cas "campagne en
    // cours" (voir showPendingCampaignMessage côté TCCard). Il ne reste donc
    // qu'à retirer le TC de l'état local, directement, sans repasser par un
    // second appel réseau ni dépendre d'une ref annexe pour retrouver le TC
    // (source d'un raté occasionnel au premier clic).
    setTestResult(prev => { if (!prev) return prev; const modules = prev.modules.map(mod => ({ ...mod, requirements: mod.requirements.map(req => { const tcs = req.test_cases.filter(tc => tc.testId !== tcTestId); return { ...req, test_cases: tcs, total_test_cases: tcs.length }; }) })); return { ...prev, modules, total_test_cases: modules.reduce((a, m) => a + m.total_test_cases, 0) }; });
  }, []);

  const handleTCAdded = useCallback((reqUUID: string, newTC: TestCase) => {
    if (!testResult && reqResult?.data?.modules) {
      const modules = reqResult.data.modules.map((mod: any) => {
        const requirements = (mod.requirements || []).map((req: any) => {
          const matches = req._uuid === reqUUID || req.id === reqUUID;
          const testCases = matches ? [newTC] : [];
          return {
            id: req.id,
            _uuid: req._uuid,
            description: req.description,
            priority: req.priority,
            total_test_cases: testCases.length,
            test_cases: testCases,
          };
        });
        return {
          name: mod.name,
          description: mod.description,
          total_requirements: requirements.length,
          total_test_cases: requirements.reduce((total: number, req: RequirementWithTests) => total + req.total_test_cases, 0),
          requirements,
        };
      });
      const targetModule = modules.find((mod: ModuleWithTests) => mod.requirements.some((req: RequirementWithTests) => req._uuid === reqUUID || req.id === reqUUID));
      setTestResult({
        success: true,
        model: 'manual',
        duration_ms: 0,
        total_modules: modules.length,
        total_requirements: modules.reduce((total: number, mod: ModuleWithTests) => total + mod.total_requirements, 0),
        total_test_cases: 1,
        modules,
      });
      setAppStep('done');
      setActiveView('tests');
      if (targetModule) {
        setExpandedModules(prev => new Set([...prev, targetModule.name]));
        const targetRequirements = targetModule.requirements as RequirementWithTests[];
        let targetReq: RequirementWithTests | undefined;
        for (const requirement of targetRequirements) {
          if (requirement._uuid === reqUUID || requirement.id === reqUUID) {
            targetReq = requirement;
            break;
          }
        }
        if (targetReq) setExpandedReqs(prev => new Set([...prev, targetReq.id]));
      }
      return;
    }

    setTestResult(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        total_test_cases: prev.total_test_cases + 1,
        modules: prev.modules.map(mod => ({
          ...mod,
          requirements: mod.requirements.map(req => {
            if ((req as any)._uuid !== reqUUID && req.id !== reqUUID) return req;
            return { ...req, test_cases: [...req.test_cases, newTC], total_test_cases: req.total_test_cases + 1 };
          }),
        })),
      };
    });
  }, [reqResult, testResult]);

  const handleGenerateRequirementTC = useCallback(async (reqUUID: string, formContext?: string, formData?: TestFormData, selectedScope?: string[], onGenerationError?: (msg: string) => void, approvedAngles?: { focus: string; tcType?: string }[], forceAngleFocuses?: string[], existingTcCount?: number, genMode?: GenerationMode): Promise<{ dedupRejections?: DedupRejection[] }> => {
    const conflict = activeGenerationsRef.current[reqUUID];
    if (conflict) {
      // Blocage strict : le serveur refuse de toute façon tout appel concurrent
      // sur la même exigence (verrou anti-génération), donc pas d'option
      // "continuer quand même" ici — juste informer clairement l'utilisateur.
      const msg = `${formatGenerationStatus(conflict)} pour cette exigence. Réessayez une fois sa génération terminée.`;
      addLog(`⏸️ ${msg}`, 'warn');
      onGenerationError?.(msg);
      throw new Error(msg);
    }
    notifyActivity('generating', 'un cas de test');
    try {
      const result = await apiGenerateRequirementTC(reqUUID, model, projectId, formContext, formData, selectedScope, approvedAngles, forceAngleFocuses, existingTcCount, currentUser?.name, authUser?.id, genMode);
      if (!result.test_cases?.length) return { dedupRejections: result.dedupRejections };
      const normalizedTCs = deduplicateTestIds(result.test_cases);
      const durationSuffix = result.duration_ms ? ` — en ${formatDuration(result.duration_ms)}` : '';
      if (typeof result.duration_ms === 'number') {
        setTcGenDurations(prev => ({ ...prev, [reqUUID]: (prev[reqUUID] || 0) + (result.duration_ms as number) }));
      }
      setTestResult(prev => {
        if (!prev && reqResult?.data) {
          const modulesWithTests: ModuleWithTests[] = reqResult.data.modules.map((mod: any) => { const reqs: RequirementWithTests[] = (mod.requirements || []).map((req: any) => { if (req.id === reqUUID || (req as any)._uuid === reqUUID) return { id: req.id, _uuid: (req as any)._uuid || req.id, description: req.description, priority: req.priority, total_test_cases: normalizedTCs.length, test_cases: normalizedTCs }; return { id: req.id, _uuid: (req as any)._uuid || req.id, description: req.description, priority: req.priority, total_test_cases: 0, test_cases: [] }; }); return { name: mod.name, description: mod.description, total_requirements: reqs.length, total_test_cases: reqs.reduce((a, r) => a + r.total_test_cases, 0), requirements: reqs }; });
          const totalTCs = modulesWithTests.reduce((a, m) => a + m.total_test_cases, 0);
          addLog(`✓ ${normalizedTCs.length} TC générés${durationSuffix}`, 'success'); setAppStep('done'); setActiveView('tests');
          return { success: true, model, duration_ms: 0, total_modules: modulesWithTests.length, total_requirements: modulesWithTests.reduce((a, m) => a + m.total_requirements, 0), total_test_cases: totalTCs, modules: modulesWithTests };
        }
        if (!prev) return prev;
        let targetModuleName = ''; let targetReqId = '';
        for (const mod of prev.modules) { const req = mod.requirements.find(r => (r as any)._uuid === reqUUID || r.id === reqUUID); if (req) { targetModuleName = mod.name; targetReqId = req.id; break; } }
        if (!targetModuleName) return prev;
        const mergedModules = prev.modules.map(mod => { if (mod.name !== targetModuleName) return mod; return { ...mod, requirements: mod.requirements.map(req => { if (req.id !== targetReqId) return req; const mergedTCs = mergeTCs(req.test_cases || [], normalizedTCs); return { ...req, test_cases: mergedTCs, total_test_cases: mergedTCs.length }; }), total_test_cases: mod.requirements.reduce((sum, req) => { if (req.id !== targetReqId) return sum + (req.test_cases?.length || 0); return sum + mergeTCs(req.test_cases || [], normalizedTCs).length; }, 0) }; });
        addLog(`✓ ${normalizedTCs.length} TC générés${durationSuffix}`, 'success'); setAppStep('done'); setActiveView('tests');
        return { ...prev, modules: mergedModules, total_test_cases: mergedModules.reduce((sum, mod) => sum + (mod.total_test_cases || 0), 0) };
      });
      setTimeout(() => { setTestResult(prev => { if (!prev) return prev; const targetMod = prev.modules.find(m => m.requirements.some(r => (r as any)._uuid === reqUUID || r.id === reqUUID)); if (targetMod) setExpandedModules(prev => { const n = new Set(prev); n.add(targetMod.name); return n; }); const targetReq = targetMod?.requirements.find(r => (r as any)._uuid === reqUUID || r.id === reqUUID); if (targetReq) setExpandedReqs(prev => { const n = new Set(prev); n.add(targetReq.id); return n; }); return prev; }); }, 100);
      return { dedupRejections: result.dedupRejections };
    } catch (e: any) {
      const errMsg = e?.message || 'Erreur inconnue';
      const isSanitizationError = errMsg.includes('InputSanitizer') || errMsg.includes('rejeté') || errMsg.includes('injection') || errMsg.includes('catégorie');
      addLog(isSanitizationError ? `🚫 Entrée rejetée — ${errMsg}` : `✗ Erreur génération : ${errMsg}`, 'error');
      onGenerationError?.(errMsg);
      throw e;
    } finally {
      notifyActivity('idle');
    }
  }, [model, projectId, reqResult, addLog, notifyActivity]);
  const toggleModule = (name: string) => setExpandedModules(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const toggleReq = (id: string) => setExpandedReqs(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ── Export complet du projet (tous les modules, exigences et cas de test générés) ──
  const [exportingProject, setExportingProject] = useState<'pdf' | 'excel' | null>(null);
  const [exportProjectError, setExportProjectError] = useState('');
  const exportProject = async (format: 'pdf' | 'excel') => {
    if (!projectId) return;
    setExportingProject(format);
    setExportProjectError('');
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/export/${format}`);
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `export-projet.${format === 'pdf' ? 'pdf' : 'xlsx'}`;

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('[AnalyzerPage] exportProject error:', err);
      setExportProjectError(`Échec de l'export ${format.toUpperCase()}`);
      setTimeout(() => setExportProjectError(''), 4000);
    } finally {
      setExportingProject(null);
    }
  };


  const allReqs = (reqResult?.data?.modules ?? []).flatMap((m: any) => m.requirements);
  const reqStats = { modules: reqResult?.data?.modules?.length ?? 0, total: allReqs.length };
  const resolveReqDisplayId = (uuidOrId: string) => allReqs.find((r: any) => r._uuid === uuidOrId || r.id === uuidOrId)?.id || uuidOrId.slice(0, 8);
  // Récap compact du panneau global des générations en cours (ex: "FR-2.1
  // par Salma, FR-3.2 par Ahmed +2 autres") — tronqué au-delà de 3 entrées
  // pour ne pas déborder sur un gros projet multi-modules avec beaucoup de
  // générations simultanées. Le détail complet reste disponible en dépliant
  // le panneau (voir generationsPanelExpanded plus bas).
  const GENERATIONS_SUMMARY_LIMIT = 3;
  const activeGenerationsEntries = Object.entries(activeGenerations);
  // Bannière "Activité de l'équipe en cours" — fusionne les 3 signaux live
  // déjà suivis séparément (génération / édition d'exigence / ajout de TC)
  // en une seule liste, pour que "modification" et "ajout" soient visibles
  // au même endroit que "génération", pas seulement via les petits badges
  // sur chaque ligne. Priorité génération > édition > ajout en cas de
  // signaux simultanés sur le même req (évite une double entrée redondante).
  const activeTeamWorkEntries = [
    ...activeGenerationsEntries.map(([reqId, info]) => ({
      reqId, entityId: reqId, kind: 'generating' as const, actorName: info.actorName, detail: formatGenerationStatus(info),
    })),
    ...Object.entries(activeEdits)
      .filter(([reqId]) => !activeGenerations[reqId])
      .map(([reqId, info]) => ({
        reqId, entityId: reqId, kind: 'editing' as const, actorName: info.actorName, detail: `${info.actorName} modifie cette exigence`,
      })),
    ...Object.entries(activeAdditions)
      .filter(([reqId]) => !activeGenerations[reqId] && !activeEdits[reqId])
      .map(([reqId, info]) => ({
        reqId, entityId: reqId, kind: 'adding' as const, actorName: info.actorName, detail: `${info.actorName} ajoute un cas de test`,
      })),
    // Modifications de cas de test (TC) en cours — clé unique = testCaseId
    // (et non reqId, plusieurs TC pouvant être modifiés en même temps sous
    // la même exigence) ; affichées rattachées à leur exigence via reqUUID
    // (resolveReqDisplayId), avec le testId dans le libellé pour distinguer
    // le TC précis concerné.
    ...Object.entries(activeTcEdits).map(([testCaseId, info]) => ({
      reqId: info.reqUUID || testCaseId, entityId: testCaseId, kind: 'tc-editing' as const, actorName: info.actorName,
      detail: `${info.actorName} modifie le cas de test ${info.testId || ''}`.trim(),
    })),
  ];
  const activeTeamWorkSummary = (() => {
    const parts = activeTeamWorkEntries.slice(0, GENERATIONS_SUMMARY_LIMIT).map(e => `${resolveReqDisplayId(e.reqId)} par ${e.actorName}`);
    const overflow = activeTeamWorkEntries.length - parts.length;
    return parts.join(', ') + (overflow > 0 ? ` +${overflow} autre${overflow > 1 ? 's' : ''}` : '');
  })();
  const allTCs = (testResult?.modules ?? []).flatMap(m => m.requirements.flatMap(r => r.test_cases));
  const tcStats = { total: allTCs.length, saved: allTCs.filter(t => !!(t as any).id).length, pending: allTCs.filter(t => !(t as any).id).length };
  const filteredModules = (reqResult?.data?.modules ?? []).map((mod: any) => ({ ...mod, requirements: mod.requirements.filter((req: any) => !searchQuery || req.description.toLowerCase().includes(searchQuery.toLowerCase()) || req.id.toLowerCase().includes(searchQuery.toLowerCase())) })).filter((mod: any) => mod.requirements.length > 0 || !searchQuery);
  const filteredTestModules = (testResult?.modules ?? []).map(mod => ({ ...mod, requirements: mod.requirements.map(req => ({ ...req, _uuid: (req as any)._uuid, test_cases: req.test_cases.filter(tc => (filterTestType === 'all' || tc.type === filterTestType) && (!searchQuery || tc.title.toLowerCase().includes(searchQuery.toLowerCase()))) })).filter(req => req.test_cases.length > 0) })).filter(mod => mod.requirements.length > 0);

  return (
    <div className="min-h-screen bg-white dark:bg-black" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {showProjectPicker && <ProjectPicker onClose={() => setShowProjectPicker(false)} onSelect={openExistingProject} />}
      {showJiraSettings && <JiraSettingsModal onClose={() => setShowJiraSettings(false)} />}
      <ConfirmDeleteModal
        open={showCampaignConfirm === 'launch'}
        danger
        icon="🔒"
        title="Lancer la campagne de tests ?"
        message="Les workflows de test seront figés (aucune création/modification/suppression), et le démarrage de leurs exécutions sera débloqué. Les modifications sur les modules, exigences et cas de test resteront possibles, mais seront mises en attente : elles ne s'appliqueront qu'à la clôture de la campagne, une fois gardées ou annulées."
        confirmLabel="Lancer la campagne"
        loading={campaignBusy}
        onConfirm={() => handleToggleCampaign('launch')}
        onCancel={() => setShowCampaignConfirm(null)}
      />
      {projectId && (
        <CampaignCloseModal
          open={showCampaignCloseModal}
          apiBaseUrl={API_BASE}
          projectId={projectId}
          onClosed={handleCampaignClosed}
          onCancel={() => setShowCampaignCloseModal(false)}
        />
      )}

      {/* ─── Page header with Solid styling ─── */}
      <section className="pt-35 pb-8 md:pt-40">
        <div className="mx-auto max-w-c-1390 px-4 md:px-8 2xl:px-0">
          <div className="flex items-center justify-between flex-wrap gap-4 mb-8">
            <div>
              {projectName && projectId ? (
                <h1 className="text-4xl font-extrabold text-black dark:text-white xl:text-5xl tracking-tight">
                  <ProjectNameEditor
                    projectId={projectId}
                    name={projectName}
                    onRenamed={setProjectName}
                  />
                </h1>
              ) : (
                <p className="text-waterloo dark:text-manatee mt-2 inline-flex items-center gap-1.5"><IconFile className="w-4 h-4" />Exigences <IconChevronRight className="w-3.5 h-3.5" /> Cas de test <IconChevronRight className="w-3.5 h-3.5" /> Validation</p>
              )}
              {projectId && (
                <div className="mt-2 flex items-center gap-3 flex-wrap">
                  <ProjectPresenceBar users={mergedProjectPresence} selfUserId={authUser?.id} onAvatarClick={handleFollowUser} />
                  <ProjectActivityFeed projectId={projectId} />
                  {campaignStatus === 'launched' ? (
                    <div className="flex items-center gap-2">
                      <Badge tone="warning" size="md" icon={<IconLock className="w-3 h-3" />}>
                        Campagne en cours — modifications mises en attente
                      </Badge>
                      {canManageCampaign && (
                        <button
                          onClick={() => setShowCampaignCloseModal(true)}
                          disabled={campaignBusy}
                          className={`${btn.secondary} ${btnSize.sm}`}
                          title="Clôturer la campagne — choisir de garder ou annuler les modifications en attente"
                        >
                          <IconUnlock className="w-3.5 h-3.5" /> Clôturer la campagne
                        </button>
                      )}
                    </div>
                  ) : (
                    canManageCampaign && (
                      <button
                        onClick={() => setShowCampaignConfirm('launch')}
                        disabled={campaignBusy}
                        className={`${btn.primary} ${btnSize.sm}`}
                        title="Figer les workflows et débloquer l'exécution ; les autres modifications seront mises en attente"
                      >
                        <IconRocket className="w-3.5 h-3.5" /> Lancer la campagne
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {[{ label: 'Upload', done: !!reqResult }, { label: 'Exigences', done: !!reqResult }, { label: 'Cahier', done: appStep === 'done' }].map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  {i > 0 && <div className={`w-6 h-px ${s.done ? 'bg-meta' : 'bg-stroke dark:bg-strokedark'}`} />}
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold ${s.done ? 'text-meta' : 'text-manatee'}`}>
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] ${s.done ? 'bg-meta/15' : 'bg-slate-500/10'}`}>{s.done ? <IconCheck className="w-2.5 h-2.5" strokeWidth={2.5} /> : i + 1}</span>
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {realtimeToast && (
            <div className="fixed top-20 right-6 z-50 bg-black text-white dark:bg-white dark:text-black px-4 py-3 rounded-xl shadow-solid-3 text-sm font-semibold animate-in fade-in slide-in-from-top-2">
              {realtimeToast}
            </div>
          )}

          {activeTeamWorkEntries.length > 0 && (
            <div className="mb-6 rounded-xl bg-amber-500/6 px-4 py-3">
              <button
                type="button"
                onClick={() => setGenerationsPanelExpanded(v => !v)}
                className="w-full flex items-center justify-between gap-3 text-left"
              >
                <span className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-300 min-w-0">
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
                  <span className="font-bold flex-shrink-0">
                    {activeTeamWorkEntries.length} activité{activeTeamWorkEntries.length > 1 ? 's' : ''} en cours
                  </span>
                  <span className="truncate">: {activeTeamWorkSummary}</span>
                </span>
                <span className="text-amber-600 dark:text-amber-400 flex-shrink-0"><IconChevronDown className={`w-3.5 h-3.5 transition-transform ${generationsPanelExpanded ? 'rotate-180' : ''}`} /></span>
              </button>
              {generationsPanelExpanded && (
                <div className="mt-2 pt-2 border-t border-amber-400/30 flex flex-col gap-1.5">
                  {activeTeamWorkEntries.map(entry => (
                    <div key={`${entry.kind}-${entry.entityId ?? entry.reqId}`} className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
                      {entry.detail} pour <span className="font-mono">{resolveReqDisplayId(entry.reqId)}</span>…
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {isLoadingFromUrl && (
            <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection shadow-solid-3 p-8 mb-6 flex flex-col items-center justify-center gap-4 min-h-[200px]">
              <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-semibold text-waterloo">Chargement du projet...</p>
            </div>
          )}

          {/* ─── Toolbar ─── */}
          {/* une fois reqResult ET testResult présents (et rien en
              cours), il ne restait plus rien à afficher dans ce cadre (zone
              d'upload masquée, boutons Analyser/Générer masqués, plus de
              chip Cache) — mais le cadre blanc restait visible, vide. On ne
              le rend désormais que s'il a un contenu réel à montrer. */}
          {!isLoadingFromUrl && (!projectId || isRunning || (pollingProjectId && (isPolling || pollingStatus === 'done'))) && <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection shadow-solid-3 p-5 mb-6">
            <div className="flex items-center gap-5 flex-wrap">
              {/* Upload zone */}
              {!projectId && (
                <div className="flex-shrink-0 w-60">
                  <div onClick={() => fileInputRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) { setFile(f); clearResults(); } }} className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all ${dragOver ? 'border-primary bg-zumthor dark:bg-blacksection' : file ? 'border-primary/40 bg-zumthor dark:bg-blacksection' : 'border-stroke dark:border-strokedark hover:border-primary/40'}`}>
                    <div className="mb-1 flex justify-center">{file ? <IconCheckCircle className="w-6 h-6 text-meta" /> : <IconUpload className="w-6 h-6 text-manatee" />}</div>
                    {file ? (
                      <>
                        <div className="text-[10px] text-primary font-bold truncate">{file.name}</div>
                        <div className="text-[9px] text-waterloo">{(file.size / 1024 / 1024).toFixed(2)} MB · <span onClick={e => { e.stopPropagation(); setFile(null); reset(); }} className="text-red-700 dark:text-red-400 cursor-pointer font-semibold">Retirer</span></div>
                      </>
                    ) : (
                      <>
                        <div className="text-[11px] text-meta font-bold">Déposer</div>
                        <div className="text-[10px] text-waterloo">PDF, XLSX, DOCX, TXT</div>
                      </>
                    )}
                    <input ref={fileInputRef} type="file" accept=".pdf,.xlsx,.xls,.txt,.md,.csv,.docx" className="hidden" onChange={e => { if (e.target.files?.[0]) { setFile(e.target.files[0]); clearResults(); } }} />
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex-1 flex items-center gap-3 flex-wrap">
                {!reqResult && (
                  <>
                    <button onClick={runExtraction} disabled={!file || isRunning || ollamaOnline === false} className={`${btnSize.lg} ${!file || isRunning ? 'inline-flex items-center justify-center gap-2 rounded-lg bg-slate-500/10 text-waterloo dark:text-manatee cursor-not-allowed' : btn.primary}`}>
                      {isRunning && appStep !== 'generating_tests' ? <><Spinner /> Extraction...</> : <><IconBolt className="w-4 h-4" /> Analyser le fichier</>}
                    </button>
                    <button onClick={() => setShowProjectPicker(true)} disabled={isRunning} className={`${btn.secondary} ${btnSize.lg}`}>
                      <IconFolder className="w-4 h-4" /> Charger projet
                    </button>
                    {(file || projectId) && (
                      <button onClick={reset} className={`${btn.ghost} ${btnSize.lg}`}>
                        Nouvelle session
                      </button>
                    )}
                  </>
                )}
                {isRunning && <div className="w-24 h-1 rounded-full bg-stroke dark:bg-strokedark overflow-hidden"><div className="h-full bg-primary rounded-full animate-pulse w-full" /></div>}
              </div>
            </div>

            {/* Polling status */}
            {pollingProjectId && (isPolling || pollingStatus === 'done') && (
              <div className="mt-4 pt-4 border-t border-stroke dark:border-strokedark">
                <ProjectStatusDisplay status={pollingStatus} data={pollingData} error={pollingError} isPolling={isPolling} />
              </div>
            )}
          </div>}

          {!isLoadingFromUrl && <div>
          {/* ─── Tabs ─── */}
          <div className="flex items-center border-b border-stroke dark:border-strokedark mb-4 gap-1 overflow-x-auto">
            {[
              { key: 'modules', label: 'Exigences', icon: IconFile, count: reqStats.modules },
              { key: 'tests', label: 'Cahier', icon: IconFlask, count: tcStats.pending },
              ...(canAccessSrs ? [{ key: 'srs', label: 'Recherche intelligente', icon: IconSearch, count: srsDoc?.chunks_count ?? 0 }] : []),
              { key: 'workflow', label: 'Workflow', icon: IconShuffle, count: 0 },

            ].map(t => (
              <button key={t.key} onClick={() => setActiveView(t.key as ViewTab)} className={`px-4 py-3 text-xs font-semibold whitespace-nowrap border-b-2 transition-all flex items-center gap-2 ${activeView === t.key ? 'border-primary text-primary' : 'border-transparent text-waterloo dark:text-manatee hover:text-black dark:hover:text-white'}`}>
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
                {t.count > 0 && <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${activeView === t.key ? 'bg-zumthor dark:bg-blacksection text-primary' : 'bg-stroke dark:bg-strokedark text-waterloo dark:text-manatee'}`}>{t.count}</span>}
              </button>
            ))}

            {canAccessSrs && srsDoc && (
              <button
                onClick={() => setActiveView('coverage')}
                title="Vérifier que chaque partie du cahier des charges a bien une exigence"
                className={`ml-1 px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-all flex items-center gap-1.5 flex-shrink-0 ${activeView === 'coverage' ? 'border-primary bg-zumthor dark:bg-blacksection text-primary' : 'border-stroke dark:border-strokedark text-waterloo dark:text-manatee hover:border-primary/40'}`}
              >
                <IconTarget className="w-3.5 h-3.5" /> Vérifier la qualité de l'extraction
              </button>
            )}

            {activeView === 'modules' && reqResult && (
              <div className="ml-auto flex items-center gap-2 pb-1 flex-shrink-0">
                {isBA && (
                  <button
                    onClick={() => setEditMode(x => !x)}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-all flex items-center gap-1.5 ${editMode ? 'border-primary bg-zumthor dark:bg-blacksection text-primary' : 'border-stroke dark:border-strokedark text-waterloo dark:text-manatee hover:border-primary/40'}`}
                  >
                    {editMode ? <><IconClose className="w-3.5 h-3.5" /> Fermer l'édition</> : <><IconEdit className="w-3.5 h-3.5" /> Éditer</>}
                  </button>
                )}
                {!editMode && <SearchBar value={searchQuery} onChange={setSearchQuery} />}
              </div>
            )}
          </div>

          {/* ─── Barre d'outils "Cahier" (filtres + recherche + Atlassian) ─── */}
          {activeView === 'tests' && testResult && (
            <div className="flex flex-col gap-3 mb-6 pb-4 border-b border-stroke dark:border-strokedark">
              <div className="flex flex-wrap items-center gap-1.5">
                {['all', 'positive', 'negative', 'edge_case', 'boundary', 'state_transition', 'security', 'integration', 'concurrency'].map(f => {
                  const cfg = f !== 'all' ? testTypeConfig[f as keyof typeof testTypeConfig] : null;
                  const active = filterTestType === f;
                  const activeStyle = active && cfg ? { color: cfg.color, background: cfg.bg } : undefined;
                  const activeClass = active
                    ? (cfg ? '' : 'bg-primary/10 text-primary')
                    : 'text-waterloo dark:text-manatee hover:bg-slate-500/8 hover:text-black dark:hover:text-white';
                  return (
                    <button
                      key={f}
                      onClick={() => setFilterTestType(f)}
                      style={activeStyle}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all capitalize ${activeClass}`}
                    >
                      {f === 'all' ? `Tous · ${tcStats.pending ?? 0}` : (cfg?.label ?? f.replace('_', ' '))}
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <SearchBar value={searchQuery} onChange={setSearchQuery} />
                <button
                  onClick={() => setShowJiraSettings(true)}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap inline-flex items-center gap-1.5 ${
                    jiraStatus?.connected
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-blue-600/8 text-blue-700 dark:text-blue-400 hover:bg-blue-600/14'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${jiraStatus?.connected ? 'bg-white' : 'bg-blue-600 animate-pulse'}`} />
                  <IconLink className="w-3.5 h-3.5" />
                  Atlassian
                  {jiraStatus?.connected ? ' · Connecté' : ' · Se connecter'}
                </button>
              </div>
            </div>
          )}

          {/* ─── Content ─── */}
          {activeView === 'modules' && (
            !reqResult ? (
              <div className="flex flex-col items-center justify-center min-h-[50vh] gap-5">
                {!isLoadingFromUrl && <>
                <IconFile className="w-14 h-14 text-manatee opacity-40" strokeWidth={1.2} />
                <p className="text-waterloo dark:text-manatee text-sm text-center">Choisissez un document et cliquez sur <span className="text-primary font-semibold inline-flex items-center gap-1"><IconBolt className="w-3.5 h-3.5" />Analyser le fichier</span></p>
                <p className="text-manatee text-xs">ou</p>
                <button onClick={() => setShowProjectPicker(true)} className={`${btn.secondary} ${btnSize.lg}`}><IconFolder className="w-4 h-4" /> Ouvrir un projet existant</button>
                </>}
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-3 mb-6 flex-wrap">
                  {[{ label: `${reqStats.modules} modules`, tone: 'info' as const }, { label: `${reqStats.total} exigences`, tone: 'primary' as const }, ...(extractionDurationMs ? [{ label: formatDuration(extractionDurationMs), tone: 'neutral' as const, icon: <IconClock className="w-3 h-3" /> }] : [])].map(b => (
                    <Badge key={b.label} tone={b.tone} size="md" icon={(b as any).icon}>{b.label}</Badge>
                  ))}
                  {projectId && (
                    <div className="ml-auto flex items-center gap-2">
                      <button onClick={() => exportProject('pdf')} disabled={exportingProject !== null} className={`${btn.ghost} ${btnSize.xs}`}>
                        {exportingProject === 'pdf' ? <Spinner /> : <IconDownload className="w-3.5 h-3.5" />} Export PDF
                      </button>
                      <button onClick={() => exportProject('excel')} disabled={exportingProject !== null} className={`${btn.ghost} ${btnSize.xs}`}>
                        {exportingProject === 'excel' ? <Spinner /> : <IconDownload className="w-3.5 h-3.5" />} Export Excel
                      </button>
                    </div>
                  )}
                  {exportProjectError && (
                    <span className="text-xs text-red-600 font-bold w-full">{exportProjectError}</span>
                  )}
                </div>
                {editMode ? (
                  <ModuleReqEditor
                    apiBaseUrl={API_BASE}
                    projectId={projectId}
                    locked={campaignStatus === 'launched'}
                    onImpact={setPendingImpact}
                    onImpactResolved={() => setPendingImpact(null)}
                    resolvedImpact={resolvedImpact}
                    activeEdits={activeEdits}
                    onEditingChange={notifyRequirementEditing}
                    modules={(reqResult.data?.modules ?? []).map((mod: any) => ({
                      name: mod.name,
                      _uuid: mod._uuid ?? mod.id,
                      description: mod.description ?? '',
                      requirements: mod.requirements.map((r: any) => {
                        const isObjectId = (v: any) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
                        const uuid = [r._uuid, r.dbId, r.id].find(isObjectId);
                        const businessId = r.req_id ?? (isObjectId(r.id) ? undefined : r.id);
                        if (!uuid) console.warn("[analyzer] Aucun ObjectId valide trouvé pour ce requirement:", r);
                        return {
                          id: businessId ?? r.id,
                          _uuid: uuid,
                          description: r.description,
                          priority: r.priority,
                          needsReview: r.needs_review ?? r.needsReview ?? false,
                          needsReviewReason: r.needs_review_reason ?? r.needsReviewReason ?? null,
                          updatedAt: r.updated_at ?? r.updatedAt ?? null,
                        };
                      }),
                    }))}
                    onModuleAdded={mod => {
                      setReqResult((prev: any) => {
                        if (!prev) return prev;
                        return { ...prev, data: { ...prev.data, modules: [...(prev.data?.modules ?? []), { name: mod.name, _uuid: mod._uuid, description: mod.description, requirements: [] }] } };
                      });
                    }}
                    onModuleEdited={(oldName, patch) => {
                      setReqResult((prev: any) => {
                        if (!prev) return prev;
                        return { ...prev, data: { ...prev.data, modules: (prev.data?.modules ?? []).map((m: any) => m.name === oldName ? { ...m, ...patch } : m) } };
                      });
                    }}
                    onModuleDeleted={name => {
                      setReqResult((prev: any) => {
                        if (!prev) return prev;
                        return { ...prev, data: { ...prev.data, modules: (prev.data?.modules ?? []).filter((m: any) => m.name !== name) } };
                      });
                    }}
                    onReqAdded={(moduleName, req) => {
                      setReqResult((prev: any) => {
                        if (!prev) return prev;
                        return { ...prev, data: { ...prev.data, modules: (prev.data?.modules ?? []).map((m: any) => m.name !== moduleName ? m : { ...m, requirements: [...m.requirements, { id: req.id, _uuid: req._uuid, description: req.description, priority: req.priority }] }) } };
                      });
                    }}
                    onReqEdited={(moduleName, reqId, patch) => {
                      setReqResult((prev: any) => {
                        if (!prev) return prev;
                        return {
                          ...prev, data: {
                            ...prev.data, modules: (prev.data?.modules ?? []).map((m: any) =>
                              m.name !== moduleName ? m : {
                                ...m, requirements: m.requirements.map((r: any) =>
                                  r.id === reqId ? { ...r, ...patch } : r
                                )
                              }
                            )
                          }
                        };
                      });
                    }}
                    onReqDeleted={(moduleName, reqId) => {
                      setReqResult((prev: any) => {
                        if (!prev) return prev;
                        return { ...prev, data: { ...prev.data, modules: (prev.data?.modules ?? []).map((m: any) => m.name !== moduleName ? m : { ...m, requirements: m.requirements.filter((r: any) => r.id !== reqId) }) } };
                      });
                    }}
                  />
                ) : filteredModules.length === 0 ? (
                  <div className="text-center text-waterloo text-sm py-16">Aucun résultat pour ces filtres</div>
                ) : filteredModules.map((mod: any) => (
                  <ModuleCard key={mod.name} mod={mod} projectId={projectId} expanded={expandedModules.has(mod.name)} onToggle={() => toggleModule(mod.name)} searchQuery={searchQuery} genState={moduleGenStates[mod.name] ?? 'idle'} onGenerateTests={() => runTestGeneration(mod.name)} onOpenForm={(req: any) => setGenModeReq({ reqId: req.id, reqUUID: (req as any)._uuid || req.id, reqDesc: req.description, module: mod.name, priority: req.priority })} isGlobalRunning={isRunning} userRole={currentUser?.role} activeEdits={activeEdits} flashIds={flashIds} registerEntityRef={registerEntityRef} />
                ))}
              </div>
            )
          )}

          {activeView === 'tests' && (
            !testResult && appStep !== 'generating_tests' ? (
              <div className="flex flex-col items-center justify-center min-h-[50vh] gap-5">
                {!isLoadingFromUrl && <><IconFlask className="w-14 h-14 text-manatee opacity-40" strokeWidth={1.2} />
                {reqResult ? (
                  <>
                    <p className="text-waterloo dark:text-manatee text-sm">Les cas de test se génèrent depuis une exigence ou un module.</p>
                  </>
                ) : <p className="text-waterloo dark:text-manatee text-sm">Extrayez d'abord les exigences.</p>}</>}
              </div>
            ) : appStep === 'generating_tests' && !testResult ? (
              <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
                <IconFlask className="w-12 h-12 text-primary animate-pulse" strokeWidth={1.2} />
                <p className="text-waterloo dark:text-manatee text-sm">Génération en cours...</p>
              </div>
            ) : testResult ? (
              <div>
                <div className="flex items-center gap-3 mb-6 flex-wrap">
                  <h2 className="text-2xl font-bold text-black dark:text-white">Cahier de recettes</h2>
                  <Badge tone="success" size="md">{tcStats.saved} en base</Badge>
                  <Badge tone="warning" size="md">{tcStats.pending} en attente</Badge>
                </div>
                {filteredTestModules.length === 0 ? (
                  <div className="text-center text-waterloo dark:text-manatee text-sm py-16">Aucun résultat pour ces filtres</div>
                ) : filteredTestModules.map(mod => (
                  <TestModuleCard key={mod.name} mod={mod} expanded={expandedModules.has(mod.name)} onToggle={() => toggleModule(mod.name)} expandedReqs={expandedReqs} onToggleReq={toggleReq} searchQuery={searchQuery} model={model} projectId={projectId} onTCRegenerated={handleTCRegenerated} onSingleTCUpdated={handleSingleTCUpdated} onTCValidated={handleTCValidated} onTCRejected={handleTCRejected} onTCAdded={handleTCAdded} tcGenDurations={tcGenDurations} userRole={currentUser?.role} campaignStatus={campaignStatus} flashIds={flashIds} activeViews={activeViews} onReqViewingChange={notifyRequirementViewing} onReqAddingChange={notifyRequirementAdding} onTCViewingChange={notifyTestCaseViewing} onTCEditingChange={notifyTestCaseEditing} registerEntityRef={registerEntityRef} />
                ))}
              </div>
            ) : null
          )}

          {activeView === 'srs' && canAccessSrs && (
            <SrsPanel projectId={projectId} srsDoc={srsDoc} srsFile={srsFile} setSrsFile={setSrsFile} srsUploadState={srsUploadState} setSrsUploadState={setSrsUploadState} setSrsDoc={setSrsDoc} srsFileInputRef={srsFileInputRef} canUploadSrs={currentUser?.role === 'ADMIN' || currentUser?.role === 'BA' || currentUser?.role === 'PO'} />
          )}

          {activeView === 'coverage' && canAccessSrs && srsDoc && (
            <CoveragePanel projectId={projectId} onRequirementsChanged={refreshCurrentProject} />
          )}
          {activeView === 'workflow' && (
            <TestWorkflowBoard projectId={projectId} testModules={testResult?.modules} userRole={currentUser?.role} currentUserId={authUser?.id} workflowRealtimeEvent={workflowRealtimeEvent} initialWorkflowId={openWorkflowId} campaignLocked={campaignStatus === 'launched'} />
          )}


          </div>
          }
        </div>
      </section>

      {/* ── Sélecteur de mode de génération ── */}
      {genModeReq && (
        <GenerationModeSelector
          reqId={genModeReq.reqId}
          reqDesc={genModeReq.reqDesc}
          onClose={() => setGenModeReq(null)}
          onSelect={(mode: GenerationMode) => {
            const req = genModeReq;
            setGenModeReq(null);
            setGenLockToast(null);

            // Nouvel épisode de génération pour cette exigence : on repart de zéro
            // pour que le badge affiche le temps total de CET épisode (y compris
            // les éventuelles relances "générer quand même" après rejet dedup),
            // sans additionner d'anciennes générations sans rapport.
            setTcGenDurations(prev => ({ ...prev, [req.reqUUID]: 0 }));

            // ── Vérification proactive, COMMUNE aux 3 modes ──────────────────
            // Le verrou serveur est par exigence, pas par mode : si un autre
            // utilisateur génère déjà sur cette exigence — peu importe le mode
            // qu'IL a choisi — on informe immédiatement, dès la sélection du
            // mode, avant même d'ouvrir un formulaire ou d'appeler l'API.
            const conflict = activeGenerationsRef.current[req.reqUUID];
            if (conflict) {
              setGenLockToast({
                reqId: req.reqId,
                reqDesc: req.reqDesc,
                message: `${formatGenerationStatus(conflict)} pour ${req.reqId}… vous pourrez générer une fois terminé.`,
              });
            }

            if (mode === 'explicit') {
              // Mode Signature → Formulaire assisté complet. On l'ouvre quand
              // même si conflit : le bandeau live (liveGenerationLock) y reste
              // affiché en détail et se met à jour en temps réel, et le bouton
              // Générer y est désactivé tant que le verrou est actif.
              setFormReq(req);
              return;
            }

            if (mode === 'assisted') {
              // Mode Création → preview des angles Phase A. Même logique :
              // ouvert quand même, bandeau live + bouton désactivé en détail.
              setAnglesPreviewReq(req);
              return;
            }

            // Mode Flash → génération directe, sans auto-validation.
            // Pas de modal ici : si conflit, le toast suffit, on n'appelle
            // même pas l'API (elle refuserait de toute façon).
            if (conflict) return;
            setAutoGeneratingReq(req);
            handleGenerateRequirementTC(
              req.reqUUID,
              undefined,
              undefined,
              undefined,
              (errMsg) => {
                setAssistTestError(errMsg);
                setAutoGeneratingReq(null);
                setGenLockToast({ reqId: req.reqId, reqDesc: req.reqDesc, message: errMsg });
              },
              undefined,
              undefined,
              undefined,
              'fast'
            ).then(() => {
              setAssistTestError(null);
              setAutoGeneratingReq(null);
              // Les TC générés restent "en attente" (pending_test_cases, autosave
              // existant) — validation manuelle requise, comme pour les modes
              // Création et Signature. Voir onValidated / apiCreateAndValidateTC
              // dans TCCard pour la validation au clic.
            }).catch(() => {
              setAutoGeneratingReq(null);
            });
          }}
        />
      )}

      {/* Toast génération automatique en cours */}
      {autoGeneratingReq && (
        <div className="fixed bottom-7 left-1/2 -translate-x-1/2 z-[3000] bg-primary text-white rounded-xl px-6 py-3.5 flex items-center gap-3 shadow-solid-5 min-w-[320px] max-w-[520px]">
          <Spinner />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold mb-0.5">Génération des cas de test...</div>
            <div className="text-[10px] font-semibold opacity-80 truncate">{autoGeneratingReq.reqId} — {autoGeneratingReq.reqDesc}</div>
          </div>
        </div>
      )}

      {/* Toast de verrou de génération — PARTAGÉ par les 3 modes. Pour
          Signature/Création, le même message est aussi affiché en détail et
          en direct DANS le modal (voir liveGenerationLock ci-dessous) ; ce
          toast sert de signal immédiat dès la sélection du mode, avant même
          l'ouverture du formulaire. Pour Flash (pas de modal), c'est le seul
          signal — sans lui l'utilisateur voyait juste le toast "en cours"
          disparaître, sans savoir pourquoi. */}
      {genLockToast && (
        <div className="fixed bottom-7 left-1/2 -translate-x-1/2 z-[3000] bg-white dark:bg-blacksection border border-amber-500/50 text-amber-800 dark:text-amber-400 rounded-xl px-6 py-3.5 flex items-center gap-3 shadow-solid-5 min-w-[320px] max-w-[520px]">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold mb-0.5">Génération déjà en cours</div>
            <div className="text-[10px] font-semibold opacity-90 truncate">{genLockToast.reqId} — {genLockToast.reqDesc}</div>
            <div className="text-xs font-semibold mt-1">{genLockToast.message}</div>
          </div>
          <button onClick={() => setGenLockToast(null)} className="text-amber-800 dark:text-amber-400 hover:opacity-70 shrink-0">✕</button>
        </div>
      )}

      {/* AssistTest */}
      {formReq && (
        <AssistTest
          key={docLanguage}
          requirement={formReq}
          model={model}
          projectId={projectId}
          apiBaseUrl={API_BASE}
          docLanguage={docLanguage}
          externalError={assistTestError}
          actorId={authUser?.id}
          actorName={currentUser?.name}
          liveGenerationLock={activeGenerations[formReq.reqUUID] ?? null}
          onTCsGenerated={({ formContext, formData, selectedScope }) => {
            setAssistTestError(null);
            handleGenerateRequirementTC(
              formReq.reqUUID,
              formContext,
              formData,
              selectedScope,
              (errMsg) => {
                addLog(`🚫 ${errMsg}`, 'error');
                setAssistTestError(errMsg);
              },
              undefined,
              undefined,
              undefined,
              'explicit'
            ).then(() => {
              setAssistTestError(null);
              setFormReq(null);
            }).catch(() => { /* le formulaire reste ouvert, le banner d'erreur s'affiche */ });
          }}
          onClose={() => { setAssistTestError(null); setFormReq(null); }}
        />
      )}

      {/* AnglesPreview — Mode Création */}
      {anglesPreviewReq && (
        <AnglesPreview
          requirement={anglesPreviewReq}
          apiBaseUrl={API_BASE}
          model={model}
          projectId={projectId}
          actorId={authUser?.id}
          actorName={currentUser?.name}
          isGenerating={!!autoGeneratingReq}
          externalError={assistTestError}
          liveGenerationLock={activeGenerations[anglesPreviewReq.reqUUID] ?? null}
          dedupRejections={dedupRejections}
          onClose={() => { setAssistTestError(null); setAnglesPreviewReq(null); setDedupRejections(null); }}
          onApprove={({ angles }) => {
            const req = anglesPreviewReq;
            setAutoGeneratingReq(req);
            handleGenerateRequirementTC(
              req.reqUUID,
              undefined,
              undefined,
              undefined,
              (errMsg) => {
                addLog(`🚫 ${errMsg}`, 'error');
                setAssistTestError(errMsg);
                setAutoGeneratingReq(null);
              },
              angles,
              undefined,
              getInMemoryTcCount(req.reqUUID),
              'assisted',
            ).then(({ dedupRejections: rejections }) => {
              setAssistTestError(null);
              setAutoGeneratingReq(null);
              if (rejections && rejections.length > 0) {
                // Certains angles validés ont été rejetés par le dedup — on laisse
                // AnglesPreview ouvert pour proposer à l'utilisateur de les forcer.
                setDedupRejections(rejections);
              } else {
                setAnglesPreviewReq(null);
              }
            }).catch(() => { /* AnglesPreview reste ouvert, banner d'erreur visible */ });
          }}
          onForceGenerate={(rejectionsToForce) => {
            const req = anglesPreviewReq;
            setAutoGeneratingReq(req);
            // On renvoie les angles rejetés comme approvedAngles (focus = titre du TC tenté,
            // c'est ce que le backend reconnaît) pour que Phase A reste skippée, plus
            // forceAngleFocuses pour bypasser le dedup sur ces titres précis.
            const anglesToResend = rejectionsToForce.map(r => ({ focus: r.attemptedTitle, tcType: r.tcType }));
            const focusesToForce = rejectionsToForce.map(r => r.attemptedTitle);
            handleGenerateRequirementTC(
              req.reqUUID,
              undefined,
              undefined,
              undefined,
              (errMsg) => {
                addLog(`🚫 ${errMsg}`, 'error');
                setAssistTestError(errMsg);
                setAutoGeneratingReq(null);
              },
              anglesToResend,
              focusesToForce,
              getInMemoryTcCount(req.reqUUID),
              'assisted',
            ).then(() => {
              setAssistTestError(null);
              setAutoGeneratingReq(null);
              setDedupRejections(null);
              setAnglesPreviewReq(null);
            }).catch(() => { /* AnglesPreview reste ouvert, banner d'erreur visible */ });
          }}
        />
      )}
      {pendingImpact && (
        <ImpactConfirmModal
          impact={pendingImpact}
          loading={refreshingImpact}
          reverting={revertingImpact}
          onOk={async () => {
            setRefreshingImpact(true);
            await refreshCurrentProject();
            setRefreshingImpact(false);
            setPendingImpact(null);
            setResolvedImpact({ uuid: pendingImpact.requirementUuid, nonce: Date.now() });
          }}
          onRevert={() => {
            // Le modal se ferme tout de suite pour ne pas bloquer l'utilisateur, mais
            // la ligne de l'exigence affiche aussitôt "Restauration en cours..." puis
            // "✓ Version restaurée" une fois la confirmation serveur reçue — on
            // applique la réponse serveur exacte à cette exigence précise, sans
            // passer par un rechargement complet du projet (qui pourrait entrer en
            // course avec un polling en cours et laisser la description non restaurée).
            const { requirementUuid, previousDescription, impactedRequirements } = pendingImpact;
            setPendingImpact(null);
            setResolvedImpact({ uuid: requirementUuid, nonce: Date.now(), phase: 'start' });
            setRevertingImpact(true);
            fetch(`${API_BASE}/projects/requirements/${requirementUuid}/revert-edit`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                description: previousDescription,
                impactedRequirementIds: impactedRequirements.map(r => r.id).filter(Boolean),
              }),
            })
              .then(async res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json().catch(() => null);
                const restoredDescription = json?.data?.description ?? previousDescription;
                applyRequirementPatchByUuid(requirementUuid, {
                  description: restoredDescription,
                  needsReview: false,
                  needsReviewReason: null,
                });
                setResolvedImpact({ uuid: requirementUuid, nonce: Date.now(), phase: 'done' });
              })
              .catch((err: any) => {
                addLog(`Erreur lors du retour à l'ancienne version : ${err.message}`, 'error');
                setResolvedImpact({ uuid: requirementUuid, nonce: Date.now(), phase: 'error' });
              })
              .finally(() => setRevertingImpact(false));
          }}
        />
      )}
    </div>
  );
}

// ─── Modal de confirmation d'impact (édition SRS) ──────────────────────────────
function ImpactConfirmModal({ impact, loading, reverting, onOk, onRevert }: {
  impact: ImpactInfo;
  loading: boolean;
  reverting: boolean;
  onOk: () => void;
  onRevert: () => void;
}) {
  const msg = describeImpact(impact);
  const toneClasses = msg.tone === "danger"
    ? { border: "border-red-600/30", btn: "bg-red-600 hover:bg-red-700", text: "text-red-600" }
    : msg.tone === "warn"
    ? { border: "border-amber-500/40", btn: "bg-amber-600 hover:bg-amber-700", text: "text-amber-600" }
    : { border: "border-sky-500/40", btn: "bg-sky-600 hover:bg-sky-700", text: "text-sky-600" };
  const busy = loading || reverting;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
      <div className={`bg-white dark:bg-neutral-900 border ${toneClasses.border} rounded-2xl shadow-2xl max-w-md w-full p-6`}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-2xl">{msg.icon}</span>
          <h3 className="text-base font-bold text-black dark:text-white">{msg.title}</h3>
        </div>
        <p className="text-sm text-black dark:text-white leading-relaxed mb-5">{msg.text}</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onOk}
            disabled={busy}
            className={`w-full py-2.5 rounded-xl ${toneClasses.btn} disabled:opacity-60 text-white text-sm font-bold transition-colors`}
          >
            {loading ? "Actualisation…" : "✓ Garder & réviser les cas de test"}
          </button>
          <button
            onClick={onRevert}
            disabled={busy}
            className={`w-full py-2.5 rounded-xl border ${toneClasses.border} ${toneClasses.text} disabled:opacity-60 text-sm font-bold transition-colors hover:bg-black/5 dark:hover:bg-white/5`}
          >
            {reverting ? "Retour en arrière…" : "↩ Revenir à l'ancienne version"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Module Card ──────────────────────────────────────────────────────────────
// ─── Badge "à réviser" sur une exigence (impact d'édition SRS) ────────────────
function ReqReviewBadge({ apiBaseUrl, reqUuid, reason, canClear }: { apiBaseUrl: string; reqUuid?: string; reason?: string | null; canClear: boolean }) {
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [pendingMsg, setPendingMsg] = useState<string | null>(null);
  if (cleared) return null;

  const acknowledge = async () => {
    if (!reqUuid) return;
    setClearing(true);
    try {
      const res = await fetch(`${apiBaseUrl}/projects/requirements/${reqUuid}/acknowledge-review`, { method: 'PATCH' });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json?.pending) {
          setPendingMsg(json.message || 'Campagne de tests en cours : mis en attente jusqu\'à la clôture.');
          setTimeout(() => setPendingMsg(null), 6000);
        } else {
          setCleared(true);
        }
      }
    } catch (err) {
      console.error('[ReqReviewBadge] acknowledge error:', err);
    } finally {
      setClearing(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-red-700 dark:text-red-400 bg-red-600/8 rounded-full px-2.5 py-1">
      <IconAlertTriangle className="w-3 h-3 shrink-0" />
      À réviser{reason ? ` — ${reason}` : ""}
      {canClear && (
        <button onClick={acknowledge} disabled={clearing} title={pendingMsg || "Lever le flag à réviser"} className="hover:text-red-900 dark:hover:text-red-300 disabled:opacity-50">
          {clearing ? '…' : <IconClose className="w-3 h-3" />}
        </button>
      )}
      {pendingMsg && <span className="text-amber-700 dark:text-amber-400 font-bold">⏳ mis en attente</span>}
    </span>
  );
}

function ModuleCard({ mod, projectId, expanded, onToggle, searchQuery, genState, onGenerateTests, onOpenForm, isGlobalRunning, userRole, activeEdits, flashIds, registerEntityRef }: { mod: any; projectId?: string | null; expanded: boolean; onToggle: () => void; searchQuery: string; genState: ModuleGenState; onGenerateTests: () => void; onOpenForm?: (req: any) => void; isGlobalRunning: boolean; userRole?: string; activeEdits?: Record<string, { actorName: string }>; flashIds?: Record<string, number>; /** Enregistre l'élément DOM d'une ligne exigence pour le "follow" (clic sur un avatar de présence → scrollIntoView) — voir scrollToEntity dans AnalyzerPage. */ registerEntityRef?: (key: string, el: HTMLDivElement | null) => void; }) {
  const isQA = userRole === 'QA';
  const commentsDrawer = useCommentsDrawer();
  const unreadComments = useUnreadComments();

  const moduleUuid = mod._uuid ?? mod.id;
  const [exporting, setExporting] = useState<'pdf' | 'excel' | null>(null);
  const [exportError, setExportError] = useState('');
  const [showModuleHistory, setShowModuleHistory] = useState(false);
  const [historyReqUuid, setHistoryReqUuid] = useState<string | null>(null);

  const exportModule = async (format: 'pdf' | 'excel') => {
    if (!moduleUuid || !projectId) return;
    setExporting(format);
    setExportError('');
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/modules/${moduleUuid}/export/${format}`);
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `${mod.name}.${format === 'pdf' ? 'pdf' : 'xlsx'}`;

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error('[ModuleCard] exportModule error:', err);
      setExportError(`Échec de l'export ${format.toUpperCase()}`);
      setTimeout(() => setExportError(''), 4000);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="bg-white dark:bg-blacksection border border-stroke dark:border-strokedark rounded-2xl mb-4 overflow-hidden shadow-solid-3 hover:shadow-solid-4 hover:border-primary/30 transition-all">
      <div className={`p-6 flex items-center justify-between ${expanded ? 'border-b border-stroke dark:border-strokedark bg-alabaster dark:bg-black/20' : ''}`}>
        <div onClick={onToggle} className="flex items-start gap-4 flex-1 min-w-0 cursor-pointer">
          <span className="inline-flex items-center gap-1.5 bg-primary/8 text-primary text-sm font-bold px-3 py-1.5 rounded-lg flex-shrink-0"><IconPackage className="w-4 h-4" strokeWidth={1.6} />{mod.requirements.length}</span>
          <div className="flex-1 min-w-0">
            <div className="text-base font-bold text-black dark:text-white truncate">{mod.name}</div>
            {mod.description && <div className="text-sm text-waterloo dark:text-manatee mt-0.5 truncate">{mod.description}</div>}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 ml-4">
          {moduleUuid && projectId && (
            <div className="flex items-center gap-1.5">
              <button onClick={e => { e.stopPropagation(); exportModule('pdf'); }} disabled={exporting !== null} title="Exporter en PDF" className={`${btn.iconOnly} ${btnSize.iconSm} disabled:opacity-50`}><IconDownload className="w-4 h-4" /></button>
              <button onClick={e => { e.stopPropagation(); exportModule('excel'); }} disabled={exporting !== null} title="Exporter en Excel" className={`${btn.iconOnly} ${btnSize.iconSm} disabled:opacity-50`}><IconChart className="w-4 h-4" /></button>
              <button onClick={e => { e.stopPropagation(); setShowModuleHistory(true); }} title="Historique des versions" className={`${btn.iconOnly} ${btnSize.iconSm}`}><IconClock className="w-4 h-4" /></button>
              {exporting && <Spinner />}
            </div>
          )}
          <button onClick={onToggle} className={`${btn.iconOnly} ${btnSize.iconSm}`}><IconChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></button>
        </div>
      </div>
      {exportError && (
        <div className="px-6 pb-2 text-xs text-red-600 font-semibold">{exportError}</div>
      )}
      {expanded && (
        <div className="divide-y divide-stroke dark:divide-strokedark">
          {mod.requirements.map((req: any, i: number) => {
            const color = priorityColor(req.priority);
            const highlight = (text: string) => { if (!searchQuery) return text; const idx = text.toLowerCase().indexOf(searchQuery.toLowerCase()); if (idx === -1) return text; return text.slice(0, idx) + '【' + text.slice(idx, idx + searchQuery.length) + '】' + text.slice(idx + searchQuery.length); };
            const isObjectId = (v: any) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
            const reqUuid = [req._uuid, req.dbId, req.id].find(isObjectId);
            const isFlashing = !!(reqUuid && flashIds?.[`req:${reqUuid}`]);
            return (
              <div key={req.id + i} ref={el => { if (reqUuid) registerEntityRef?.(`req:${reqUuid}`, el); }} className={`flex items-center gap-4 px-7 py-4${isFlashing ? ' animate-realtime-flash' : ''}`}>
                <IdTag color={color}>{req.id}</IdTag>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-black dark:text-white leading-relaxed font-medium block">{highlight(req.description)}</span>
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                    <TraceabilityBadge apiBaseUrl={API_BASE} projectId={projectId} reqId={req.id} reqDescription={req.description} />
                    {req.needsReview && (
                      <ReqReviewBadge apiBaseUrl={API_BASE} reqUuid={req._uuid ?? req.id} reason={req.needsReviewReason} canClear={userRole === 'BA' || userRole === 'PO'} />
                    )}
                    {reqUuid && activeEdits?.[reqUuid] && (
                      <span
                        title={`${activeEdits[reqUuid].actorName} a un champ de cette exigence ouvert en édition`}
                        className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold rounded-full px-2.5 py-0.5 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      >
                        <IconEdit className="w-3 h-3" /> {activeEdits[reqUuid].actorName} modifie cette exigence
                      </span>
                    )}
                  </div>
                </div>
                {reqUuid && projectId && (
                  <button
                    onClick={() => {
                      commentsDrawer.open({ projectId, entityType: 'requirement', entityId: reqUuid, title: req.id });
                      unreadComments.markRead(projectId, 'requirement', reqUuid);
                    }}
                    title="Commentaires"
                    className={`relative ${btn.iconOnly} ${btnSize.iconSm} flex-shrink-0`}
                  >
                    <IconMessage className="w-4 h-4" />
                    {unreadComments.isUnread('requirement', reqUuid) && (
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-600 border-2 border-white dark:border-black" />
                    )}
                  </button>
                )}
                {reqUuid && (
                  <button
                    onClick={() => setHistoryReqUuid(reqUuid)}
                    title="Historique des versions"
                    className={`${btn.iconOnly} ${btnSize.iconSm} flex-shrink-0`}
                  >
                    <IconClock className="w-4 h-4" />
                  </button>
                )}
                {isQA && (
                  <button onClick={() => onOpenForm?.(req)} className="px-3 py-1.5 rounded-lg border border-sky-600/40 dark:border-sky-700/40 text-sky-700 dark:text-sky-400 text-xs font-semibold flex-shrink-0 hover:bg-sky-600/8 transition-all whitespace-nowrap inline-flex items-center gap-1.5"><IconSparkle className="w-3.5 h-3.5" /> Générer des cas de test</button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {moduleUuid && projectId && (
        <VersionHistoryPanel
          open={showModuleHistory}
          onClose={() => setShowModuleHistory(false)}
          entityType="requirement_module"
          entityId={moduleUuid}
          entityLabel={`Module « ${mod.name} »`}
          canRestore={userRole === 'BA' || userRole === 'PO'}
        />
      )}
      {historyReqUuid && (
        <VersionHistoryPanel
          open={!!historyReqUuid}
          onClose={() => setHistoryReqUuid(null)}
          entityType="requirement"
          entityId={historyReqUuid}
          entityLabel={`Exigence « ${mod.requirements.find((r: any) => [r._uuid, r.dbId, r.id].includes(historyReqUuid))?.id ?? ''} »`}
          canRestore={userRole === 'BA' || userRole === 'PO'}
        />
      )}
    </div>
  );
}

// ─── Test Module Card ─────────────────────────────────────────────────────────
function TestModuleCard({ mod, expanded, onToggle, expandedReqs, onToggleReq, searchQuery, model, projectId, onTCRegenerated, onSingleTCUpdated, onTCValidated, onTCRejected, onTCAdded, tcGenDurations, userRole, campaignStatus, flashIds, activeViews, onReqViewingChange, onReqAddingChange, onTCViewingChange, onTCEditingChange, registerEntityRef }: { mod: ModuleWithTests; expanded: boolean; onToggle: () => void; expandedReqs: Set<string>; onToggleReq: (id: string) => void; searchQuery: string; model: string; projectId?: string | null; onTCRegenerated: any; onSingleTCUpdated: any; onTCValidated: any; onTCRejected: any; onTCAdded: any; tcGenDurations?: Record<string, number>; userRole?: string; campaignStatus?: 'draft' | 'launched'; flashIds?: Record<string, number>; activeViews?: Record<string, string[]>; onReqViewingChange?: (reqUUID: string | undefined, active: boolean) => void; /** Signale l'ouverture/fermeture du formulaire "+ Nouveau TC" — voir notifyRequirementAdding / bannière "Activité en cours". */ onReqAddingChange?: (reqUUID: string | undefined, active: boolean) => void; onTCViewingChange?: (testCaseId: string | undefined, active: boolean) => void; /** Signale qu'on a des édits locaux non sauvegardés sur ce TC — voir notifyTestCaseEditing / bannière "Activité en cours". */ onTCEditingChange?: (testCaseId: string | undefined, active: boolean, testId?: string, reqUUID?: string) => void; /** Enregistre l'élément DOM d'une ligne exigence/TC pour le "follow" (clic avatar → scrollIntoView) — voir scrollToEntity dans AnalyzerPage. */ registerEntityRef?: (key: string, el: HTMLDivElement | null) => void; }) {
  const allFlat = mod.requirements.flatMap(r => r.test_cases);
  const savedN = allFlat.filter(t => !!(t as any).id).length;
  const pendingN = allFlat.length - savedN;
  return (
    <div className="bg-white dark:bg-blacksection border border-stroke dark:border-strokedark rounded-2xl mb-4 overflow-hidden shadow-solid-3 hover:shadow-solid-4 hover:border-primary/30 transition-all">
      <div onClick={onToggle} className={`p-6 cursor-pointer flex items-center justify-between ${expanded ? 'border-b border-stroke dark:border-strokedark bg-alabaster dark:bg-black/20' : ''}`}>
        <div className="flex items-start gap-4 flex-1 min-w-0">
          <span className="inline-flex items-center gap-1.5 bg-meta/10 text-meta text-sm font-bold px-3 py-1.5 rounded-lg flex-shrink-0"><IconFlask className="w-4 h-4" strokeWidth={1.6} />{mod.total_test_cases}</span>
          <div className="flex-1 min-w-0">
            <div className="text-xl font-bold text-black dark:text-white truncate">{mod.name}</div>
            <div className="text-sm text-waterloo dark:text-manatee mt-1 flex items-center gap-2.5 flex-wrap">
              <span>{mod.total_requirements} exigences · {mod.total_test_cases} cas</span>
              {savedN > 0 && <StatusPill tone="success" dotColor="#0cc4ac">{savedN} sauvegardés</StatusPill>}
              {pendingN > 0 && <StatusPill tone="warning" dotColor="#d97706">{pendingN} en attente</StatusPill>}
            </div>
          </div>
        </div>
        <span className={`${btn.iconOnly} ${btnSize.iconSm} flex-shrink-0 ml-4`}><IconChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></span>
      </div>
      {expanded && (
        <div>
          {mod.requirements.map(req => {
            const reqUUID = (req as any)._uuid || req.id;
            // Clé stable = l'ObjectId Mongo (_uuid), PAS le req.id métier (ex: "FR-1.1") :
            // ce dernier est éditable par le BA et deux exigences peuvent temporairement
            // le partager (renumérotation, fusion de résultats async). Avec req.id comme
            // clé React, une collision fait "sauter" l'identité du composant entre deux
            // exigences à chaque rafraîchissement (polling) → démontage/remontage en boucle
            // → l'effet de présence (viewing-presence) repart à chaque fois → tempête de
            // requêtes réseau jusqu'à ERR_INSUFFICIENT_RESOURCES.
            return <ReqWithTestsCard key={reqUUID} req={req} moduleName={mod.name} expanded={expandedReqs.has(req.id)} onToggle={() => onToggleReq(req.id)} searchQuery={searchQuery} model={model} projectId={projectId} onRegenerated={(newTCs: any) => onTCRegenerated(reqUUID, newTCs)} onSingleTCUpdated={onSingleTCUpdated} onTCValidated={onTCValidated} onTCRejected={onTCRejected} onTCAdded={(newTC: any) => onTCAdded(reqUUID, newTC)} genDurationMs={tcGenDurations?.[reqUUID]} userRole={userRole} campaignStatus={campaignStatus} flashIds={flashIds} viewers={activeViews?.[`req:${reqUUID}`]} onViewingChange={onReqViewingChange} onAddingChange={onReqAddingChange} activeViews={activeViews} onTCViewingChange={onTCViewingChange} onTCEditingChange={onTCEditingChange} registerEntityRef={registerEntityRef} />;
          })}
        </div>
      )}
    </div>
  );
}

// ─── ReqWithTestsCard ─────────────────────────────────────────────────────────
function ReqWithTestsCard({ req, moduleName, expanded, onToggle, searchQuery, model, projectId, onRegenerated, onSingleTCUpdated, onTCValidated, onTCRejected, onTCAdded, genDurationMs, userRole, campaignStatus, flashIds, viewers, onViewingChange, onAddingChange, activeViews, onTCViewingChange, onTCEditingChange, registerEntityRef }: { req: RequirementWithTests; moduleName: string; expanded: boolean; onToggle: () => void; searchQuery: string; model: string; projectId?: string | null; onRegenerated: any; onSingleTCUpdated: any; onTCValidated: any; onTCRejected: any; onTCAdded: any; genDurationMs?: number; userRole?: string; campaignStatus?: 'draft' | 'launched'; flashIds?: Record<string, number>; /** Noms des AUTRES utilisateurs ayant actuellement cette exigence dépliée — voir requirement:viewing. */ viewers?: string[]; onViewingChange?: (reqUUID: string | undefined, active: boolean) => void; /** Signale l'ouverture/fermeture du formulaire "+ Nouveau TC" — voir notifyRequirementAdding. */ onAddingChange?: (reqUUID: string | undefined, active: boolean) => void; activeViews?: Record<string, string[]>; onTCViewingChange?: (testCaseId: string | undefined, active: boolean) => void; /** Signale des édits locaux non sauvegardés sur un TC — voir notifyTestCaseEditing. */ onTCEditingChange?: (testCaseId: string | undefined, active: boolean, testId?: string, reqUUID?: string) => void; registerEntityRef?: (key: string, el: HTMLDivElement | null) => void; }) {
  const isQA = userRole === 'QA';
  const canExportJira = userRole === 'BA' || userRole === 'PO' || userRole === 'QA';
  const [bulkState, setBulkState] = useState<'idle' | 'running'>('idle');
  const [bulkPendingMessage, setBulkPendingMessage] = useState<string | null>(null);
  const [bulkRejectConfirm, setBulkRejectConfirm] = useState(false);
  const [showNewTCForm, setShowNewTCForm] = useState(false);
  const [genOneState, setGenOneState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [genOneWarning, setGenOneWarning] = useState<any>(null);
  const color = priorityColor(req.priority);
  const savedN = req.test_cases.filter(tc => !!(tc as any).id).length;
  const pendingN = req.test_cases.length - savedN;
  const reqUUID = (req as any)._uuid || req.id;

  const [genOneError, setGenOneError] = useState('');
  const [showGenOneInstrPanel, setShowGenOneInstrPanel] = useState(false);
  const [genOneInstruction, setGenOneInstruction] = useState('');

  // Signale aux autres utilisateurs qu'on a cette exigence dépliée (présence
  // légère, pas un verrou — voir requirement:viewing). On repasse à `false`
  // au repli ET au démontage (navigation ailleurs, changement de recherche
  // qui referme le module...) pour ne pas laisser un badge fantôme.
  const isObjectIdReq = typeof reqUUID === "string" && /^[a-f0-9]{24}$/i.test(reqUUID);
  useEffect(() => {
    if (!isObjectIdReq) return;
    onViewingChange?.(reqUUID, expanded);
  }, [expanded, reqUUID, isObjectIdReq, onViewingChange]);
  useEffect(() => {
    return () => { if (isObjectIdReq) onViewingChange?.(reqUUID, false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqUUID, isObjectIdReq]);

  const handleGenerateOne = async (instruction?: string) => {
    if (genOneState === 'running') return;
    setGenOneState('running');
    setGenOneError('');
    try {
      const trimmed = instruction?.trim();
      const { testCase, warning } = trimmed
        ? await apiGenerateSingleTCWithInstruction(reqUUID, trimmed, model)
        : await apiGenerateSingleTC(reqUUID, model);
      if (warning?.isStrict) { setGenOneWarning({ ...warning, generatedTC: testCase }); setGenOneState('idle'); return; }
      onTCAdded({ ...testCase }); if (!expanded) onToggle();
      setGenOneState('done'); setTimeout(() => setGenOneState('idle'), 2000);
      setShowGenOneInstrPanel(false); setGenOneInstruction('');
    } catch (e: any) {
      // Message serveur explicite (ex: verrou anti-génération concurrente :
      // "X est déjà en train de générer un cas de test pour cette exigence")
      // — on l'affiche tel quel plutôt que de le jeter silencieusement.
      setGenOneError(e?.message || "Échec de la génération");
      setGenOneState('error');
      setTimeout(() => { setGenOneState('idle'); setGenOneError(''); }, 5000);
    }
  };

  const handleBulkValidate = async () => {
    if (bulkState === 'running') return;
    setBulkState('running');
    try {
      const inMemory = req.test_cases.filter(tc => !(tc as any).id);
      if (inMemory.length === 0) { setBulkState('idle'); return; }
      let anyPending = false;
      for (const tc of inMemory) {
        try {
          const result = await apiCreateAndValidateTC(reqUUID, tc);
          if (result.pending) { anyPending = true; continue; } // campagne en cours : ce TC reste "en attente" localement
          const saved = result.data;
          onTCValidated(tc.testId, { id: saved.id || saved._id });
        } catch { }
      }
      if (anyPending) {
        setBulkPendingMessage("Campagne de tests en cours : ces validations sont mises en attente jusqu'à la clôture de la campagne.");
        setTimeout(() => setBulkPendingMessage(null), 6000);
      }
    } finally { setBulkState('idle'); }
  };

  const isReqFlashing = !!flashIds?.[`req:${reqUUID}`];

  return (
    <div ref={el => registerEntityRef?.(`req:${reqUUID}`, el)} className="border-b border-stroke dark:border-strokedark last:border-0">
      <div className={`px-7 py-4 flex items-center justify-between flex-wrap gap-3${isReqFlashing ? ' animate-realtime-flash' : ''}`}>
        <div onClick={onToggle} className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
          <IdTag color={color}>{req.id}</IdTag>
          <span className="text-sm text-black dark:text-white flex-1 truncate font-medium">{req.description}</span>
          {req.test_cases.length > 0 && <Badge tone="neutral">{req.test_cases.length} TC</Badge>}
          {savedN > 0 && <StatusPill tone="success" dotColor="#0cc4ac">{savedN}</StatusPill>}
          {pendingN > 0 && <StatusPill tone="warning" dotColor="#d97706">{pendingN}</StatusPill>}
          {typeof genDurationMs === 'number' && (
            <Badge tone="neutral" icon={<IconClock className="w-3 h-3" />}>{formatDuration(genDurationMs)}</Badge>
          )}
          {viewers && viewers.length > 0 && (
            <span
              title={`${viewers.join(', ')} consulte${viewers.length > 1 ? 'nt' : ''} cette exigence`}
              className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-2 py-0.5 flex-shrink-0 bg-sky-600/8 text-sky-700 dark:text-sky-400"
            >
              <IconEye className="w-3 h-3" /> {viewers[0]}{viewers.length > 1 ? ` +${viewers.length - 1}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
          {isQA && pendingN > 0 && (
            <button onClick={handleBulkValidate} disabled={bulkState === 'running'} className={`${btn.success} ${btnSize.xs}`}>
              {bulkState === 'running' ? <><Spinner /> Validation...</> : <><IconCheck className="w-3 h-3" /> Valider {pendingN}</>}
            </button>
          )}
          {bulkPendingMessage && (
            <span className="text-[10px] font-bold text-amber-700 dark:text-amber-400">⏳ {bulkPendingMessage}</span>
          )}
          {canExportJira && savedN > 0 && (
            <JiraExportAllButton
              requirementUuid={reqUUID}
              reqId={req.id}
              reqDescription={req.description}
              moduleName={moduleName}
              count={savedN}
              onExported={results => {
                const byId = new Map(req.test_cases.filter(tc => !!(tc as any).id).map(tc => [(tc as any).id, tc.testId]));
                results.forEach(r => {
                  if (!r.success) return;
                  const testId = byId.get(r.testCaseId);
                  if (testId) onTCValidated(testId, { jiraIssueKey: r.issueKey, jiraIssueUrl: r.issueUrl });
                });
              }}
            />
          )}
          {isQA && req.test_cases.length > 0 && (
            <button onClick={() => setBulkRejectConfirm(true)} className={`${btn.danger} ${btnSize.xs}`}><IconClose className="w-3 h-3" /> Tout rejeter</button>
          )}
          <ConfirmDeleteModal
            open={bulkRejectConfirm}
            title="Rejeter tous les cas de test ?"
            message="Tous les cas de test de cette exigence seront rejetés/supprimés. Cette action est irréversible."
            confirmLabel="Tout rejeter"
            onCancel={() => setBulkRejectConfirm(false)}
            onConfirm={() => { onTCRejected('', (req as any)._uuid ?? req.id); setBulkRejectConfirm(false); }}
          />
          {isQA && (
            <div className="relative">
              <button onClick={() => setShowGenOneInstrPanel(!showGenOneInstrPanel)} disabled={genOneState === 'running'} className={genOneState === 'done' ? `${btn.success} ${btnSize.xs}` : genOneState === 'error' ? `${btn.danger} ${btnSize.xs}` : showGenOneInstrPanel ? `${btn.secondary} ${btnSize.xs} !bg-sky-600/10 !text-sky-700 dark:!text-sky-400` : `${btn.secondary} ${btnSize.xs}`}>
                {genOneState === 'running' ? <><Spinner /> Génération...</> : genOneState === 'done' ? <><IconCheck className="w-3 h-3" /> Ajouté</> : genOneState === 'error' ? <><IconAlertTriangle className="w-3 h-3" /> Échec</> : <><IconSparkle className="w-3 h-3" /> 1 TC</>}
              </button>
              {genOneState === 'error' && genOneError && (
                <div className="absolute z-50 top-full right-0 mt-1 w-64 text-[10px] text-red-700 dark:text-red-400 bg-white dark:bg-blacksection border border-red-600/30 rounded-lg px-2 py-1.5 shadow-solid-3">
                  {genOneError}
                </div>
              )}
            </div>
          )}
          {isQA && (
            <button onClick={() => { const next = !showNewTCForm; setShowNewTCForm(next); onAddingChange?.(reqUUID, next); }} className={`${btn.secondary} ${btnSize.xs} !border-sky-600/40 !text-sky-700 dark:!text-sky-400`}><IconEdit className="w-3 h-3" /> Manuel</button>
          )}
          <button onClick={onToggle} className={`${btn.iconOnly} ${btnSize.iconSm}`}><IconChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} /></button>
        </div>
      </div>

      {/* Panneau génération (avec ou sans instruction) */}
      {isQA && showGenOneInstrPanel && (
        <div className="px-4 py-3 bg-sky-600/5 dark:bg-sky-600/10 border-t border-sky-600/30 dark:border-sky-700/40">
          <p className="inline-flex items-center gap-1.5 text-[10px] text-sky-700 dark:text-sky-400 font-semibold mb-2"><IconSparkle className="w-3 h-3" /> Générer un TC — instruction optionnelle</p>
          <div className="flex gap-2">
            <input
              value={genOneInstruction}
              onChange={e => setGenOneInstruction(e.target.value)}
              disabled={genOneState === 'running'}
              placeholder="laisser vide pour une génération libre, ou préciser un angle..."
              onKeyDown={e => { if (e.key === 'Enter') handleGenerateOne(genOneInstruction); }}
              className="flex-1 px-3 py-2 rounded-lg border border-sky-600/40 bg-white dark:bg-black text-xs text-black dark:text-white focus:outline-none focus:border-sky-600"
            />
            <button
              onClick={() => handleGenerateOne(genOneInstruction)}
              disabled={genOneState === 'running'}
              className={genOneState === 'running' ? 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-slate-500/10 text-waterloo dark:text-manatee cursor-not-allowed' : `${btn.secondary} ${btnSize.sm} !border-sky-600/40 !text-sky-700 dark:!text-sky-400`}
            >
              {genOneState === 'running' ? <Spinner /> : <><IconSparkle className="w-3.5 h-3.5" /> Générer</>}
            </button>
            <button onClick={() => { setShowGenOneInstrPanel(false); setGenOneInstruction(''); }} className={`${btn.iconOnly} ${btnSize.icon}`}><IconClose className="w-4 h-4" /></button>
          </div>
        </div>
      )}

      {/* Bannière de similarité — génération d'un nouveau TC via "1 TC" */}
      {isQA && genOneWarning && (
        <div className="px-4 py-4 bg-amber-50 dark:bg-amber-900/10 border-t border-amber-300 dark:border-amber-700/40">
          <h3 className="inline-flex items-center gap-2 text-sm font-bold text-black dark:text-white mb-2">
            <IconAlertTriangle className="w-4 h-4 text-amber-600" /> Similarité détectée ({genOneWarning?.scorePercent || 0}%)
          </h3>
          <p className="text-xs text-waterloo dark:text-manatee mb-3">Ce nouveau cas de test est {genOneWarning?.scorePercent || 0}% similaire à un existant.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div className={`${cardCls} p-4`}>
              <p className="inline-flex items-center gap-1.5 text-sm font-bold text-meta mb-2"><IconSparkle className="w-3.5 h-3.5" /> Nouveau TC</p>
              <p className="text-xs text-black dark:text-white">{genOneWarning?.generatedTC?.title || 'N/A'}</p>
            </div>
            <div className={`${cardCls} p-4`}>
              <p className="inline-flex items-center gap-1.5 text-sm font-bold text-amber-700 dark:text-amber-400 mb-2"><IconPin className="w-3.5 h-3.5" /> TC similaire existant</p>
              <p className="text-xs text-black dark:text-white">{genOneWarning?.similarTC?.title || 'N/A'}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setGenOneWarning(null); }}
              className={`${btn.secondary} ${btnSize.md}`}
            >
              <IconEdit className="w-4 h-4" /> Modifier
            </button>
            <button
              onClick={() => {
                if (genOneWarning?.generatedTC) { onTCAdded({ ...genOneWarning.generatedTC }); if (!expanded) onToggle(); }
                setGenOneWarning(null); setShowGenOneInstrPanel(false); setGenOneInstruction('');
              }}
              className={`${btn.success} ${btnSize.md}`}
            >
              <IconCheck className="w-4 h-4" /> Accepter quand même
            </button>
            <button
              onClick={() => { setGenOneWarning(null); setGenOneInstruction(''); setShowGenOneInstrPanel(true); }}
              className={`${btn.danger} ${btnSize.md}`}
            >
              <IconRefresh className="w-4 h-4" /> Régénérer
            </button>
          </div>
        </div>
      )}

      {isQA && showNewTCForm && (
        <NewTCForm
          reqId={req.id} reqDescription={req.description} reqUUID={reqUUID}
          model={model} existingCount={req.test_cases.length}
          onAdd={tc => { onTCAdded(tc); setShowNewTCForm(false); onAddingChange?.(reqUUID, false); }}
          onCancel={() => { setShowNewTCForm(false); onAddingChange?.(reqUUID, false); }} />
      )}

      {expanded && (
        <div className="px-7">
          <SaturationBanner requirementUuid={reqUUID} apiBase={API_BASE} pollingInterval={30_000} />
        </div>
      )}
      {expanded && req.test_cases.length > 0 && (
        <div className="px-7 pb-4">
          {req.test_cases.map(tc => (
            <TCCard key={tc.id ? `${tc.testId}-${tc.id}` : tc.testId} tc={tc} model={model} projectId={projectId} reqUUID={reqUUID} reqId={req.id} reqDescription={req.description} moduleName={moduleName} allOtherTCs={req.test_cases.filter(t => t.testId !== tc.testId)} searchQuery={searchQuery} onUpdated={updated => onSingleTCUpdated(tc.testId, updated)} onValidated={patch => onTCValidated(tc.testId, patch)} onRejected={() => onTCRejected(tc.testId)} onTCAdded={onTCAdded} userRole={userRole} campaignStatus={campaignStatus} isFlashing={!!flashIds?.[`tc:${tc.testId}`]} viewers={(tc as any).id ? activeViews?.[`tc:${(tc as any).id}`] : undefined} onViewingChange={onTCViewingChange} onEditingChange={onTCEditingChange} registerEntityRef={registerEntityRef} />
          ))}
        </div>
      )}
      {expanded && req.test_cases.length === 0 && (
        <div className="px-7 pb-4 text-center text-waterloo dark:text-manatee text-xs py-6">Aucun cas de test pour cette exigence</div>
      )}
    </div>
  );
}

// Génère un id déterministe au format ObjectId Mongo (24 hex) à partir d'une
// chaîne quelconque — utilisé pour donner un entityId de commentaire valide
// (le champ Comment.entity_id est typé @db.ObjectId côté Prisma) aux TC pas
// encore validés, qui n'ont pas d'id DB. Même entrée → même id à chaque
// rendu, donc le fil de commentaires reste stable tant que le TC est en
// attente.
function fnv1a(str: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
function pseudoObjectId(input: string): string {
  const h1 = fnv1a(input, 0x811c9dc5).toString(16).padStart(8, '0');
  const h2 = fnv1a(`${input}:a`, 0x9e3779b9).toString(16).padStart(8, '0');
  const h3 = fnv1a(`${input}:b`, 0x85ebca6b).toString(16).padStart(8, '0');
  return (h1 + h2 + h3).slice(0, 24);
}

// ─── TC Card ──────────────────────────────────────────────────────────────────
function TCCard({ tc, model, projectId, reqUUID, reqId, reqDescription, moduleName, allOtherTCs, searchQuery, onUpdated, onValidated, onRejected, onTCAdded, userRole, campaignStatus, isFlashing, viewers, onViewingChange, onEditingChange, registerEntityRef }: { tc: TestCase; model: string; projectId?: string | null; reqUUID: string; reqId: string; reqDescription: string; moduleName: string; allOtherTCs: TestCase[]; searchQuery: string; onUpdated: (tc: TestCase) => void; onValidated: (patch: any) => void; onRejected: () => void; onTCAdded?: (tc: TestCase) => void; userRole?: string; campaignStatus?: 'draft' | 'launched'; isFlashing?: boolean; /** Noms des AUTRES utilisateurs ayant actuellement ce TC ouvert — voir testcase:viewing. */ viewers?: string[]; onViewingChange?: (testCaseId: string | undefined, active: boolean) => void; /** Signale des édits locaux non sauvegardés sur ce TC (voir `hasEdits` plus bas) — alimente la bannière "Activité en cours" via testcase:editing. */ onEditingChange?: (testCaseId: string | undefined, active: boolean, testId?: string, reqUUID?: string) => void; registerEntityRef?: (key: string, el: HTMLDivElement | null) => void; }) {
  const isQA = userRole === 'QA';
  const canExportJira = userRole === 'BA' || userRole === 'PO' || userRole === 'QA';
  const [open, setOpen] = useState(false);
  const [localEdits, setLocalEdits] = useState<Partial<TestCase>>({});
  const [hasEdits, setHasEdits] = useState(false);
  const [actionState, setActionState] = useState<'idle' | 'running'>('idle');
  const [validationState, setValidationState] = useState<'idle' | 'saved'>('idle');
  const [regenerationState, setRegenerationState] = useState<'idle' | 'running' | 'done'>('idle');
  const [verifyState, setVerifyState] = useState<'idle' | 'running' | 'done'>('idle');
  const [verifyLog, setVerifyLog] = useState('');
  const [showRegenPanel, setShowRegenPanel] = useState(false);
  const [regenerationInstruction, setRegenerationInstruction] = useState('');
  const [showGenSimilarPanel, setShowGenSimilarPanel] = useState(false);
  const [genSimilarInstruction, setGenSimilarInstruction] = useState('');
  const [genSimilarState, setGenSimilarState] = useState<'idle' | 'running'>('idle');
  const [similarityWarning, setSimilarityWarning] = useState<any>(null);
  const [genSimilarWarning, setGenSimilarWarning] = useState<any>(null);
  const [genSimilarError, setGenSimilarError] = useState('');
  const [confirmRejectTC, setConfirmRejectTC] = useState(false);
  const [rejectingTC, setRejectingTC] = useState(false);
  const [confirmDeleteTC, setConfirmDeleteTC] = useState(false);
  const [deletingTC, setDeletingTC] = useState(false);
  const [showTCHistory, setShowTCHistory] = useState(false);
  const [pendingCampaignMessage, setPendingCampaignMessage] = useState<string | null>(null);
  const [executionStatus, setExecutionStatus] = useState<'not_tested' | 'passed' | 'failed'>(tc.executionStatus || 'not_tested');
  const [executionSaving, setExecutionSaving] = useState(false);
  useEffect(() => { setExecutionStatus(tc.executionStatus || 'not_tested'); }, [tc.executionStatus]);
  const showPendingCampaignMessage = (msg?: string) => {
    setPendingCampaignMessage(msg || 'Campagne de tests en cours : cette action est mise en attente jusqu\'à la clôture de la campagne.');
    setTimeout(() => setPendingCampaignMessage(null), 6000);
  };
  const commentsDrawer = useCommentsDrawer();
  const unreadComments = useUnreadComments();

  const isPersisted = !!(tc as any).id;
  // Identifiant stable pour le fil de commentaires : id DB une fois le TC
  // validé, sinon un id synthétique (scopé à l'exigence) tant qu'il est en
  // attente — permet de commenter aussi les TC non encore validés.
  // Limite connue : à la validation, l'id change (pending-* → id DB), donc
  // un fil commencé avant validation n'est pas rattaché automatiquement au
  // TC persisté.
  const commentEntityId = isPersisted ? ((tc as any).id as string) : pseudoObjectId(`pending:${reqUUID}:${tc.testId}`);
  const displayed = { ...tc, ...localEdits };
  const cfg = testTypeConfig[displayed.type as keyof typeof testTypeConfig] || testTypeConfig.positive;

  const borderColor = isPersisted ? '#05966930' : hasEdits ? '#d9770630' : '#e2e8f0';

  // Signale aux autres utilisateurs qu'on a ce TC ouvert (présence légère,
  // pas un verrou — voir testcase:viewing). Seuls les TC persistés ont un id
  // exploitable par l'endpoint /test-cases/:id/viewing-presence ; un TC en
  // mémoire (pas encore sauvegardé) n'a pas d'entrée en base à signaler.
  const tcDbId = isPersisted ? ((tc as any).id as string) : undefined;
  useEffect(() => {
    if (!tcDbId) return;
    onViewingChange?.(tcDbId, open);
  }, [open, tcDbId, onViewingChange]);
  useEffect(() => {
    return () => { if (tcDbId) onViewingChange?.(tcDbId, false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tcDbId]);

  // Signale aux autres qu'on a des édits locaux en attente sur ce TC (voir
  // testcase:editing) — c'est ce qui fait apparaître "modifie le cas de
  // test..." dans la bannière/panneau "Activité de l'équipe en cours",
  // exactement comme pour une exigence (requirement:editing) ou un ajout
  // (requirement:adding). Se déclenche à chaque transition de `hasEdits`
  // (posé/levé par editLocal, et remis à false après sauvegarde/annulation
  // — voir handleValidateOrDelete/handleSaveTypeAndPriority/handleVerify/
  // handleRegenerate). Uniquement pour les TC déjà persistés (mêmes
  // limitations que onViewingChange ci-dessus).
  useEffect(() => {
    if (!tcDbId) return;
    onEditingChange?.(tcDbId, hasEdits, tc.testId, reqUUID);
  }, [hasEdits, tcDbId, onEditingChange, tc.testId, reqUUID]);
  useEffect(() => {
    return () => { if (tcDbId) onEditingChange?.(tcDbId, false, tc.testId, reqUUID); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tcDbId]);

  const editLocal = (key: string, val: any) => { setLocalEdits(p => ({ ...p, [key]: val })); setHasEdits(true); };
  const editListItem = (key: string, i: number, val: string) => { const arr = [...((displayed as any)[key] || [])]; arr[i] = val; editLocal(key, arr); };
  const removeListItem = (key: string, i: number) => { const arr = [...((displayed as any)[key] || [])]; arr.splice(i, 1); editLocal(key, arr); };
  const addListItem = (key: string, val: string) => { const arr = [...((displayed as any)[key] || [])]; arr.push(val); editLocal(key, arr); };

  const highlight = (text: string) => { if (!searchQuery) return text; const idx = text.toLowerCase().indexOf(searchQuery.toLowerCase()); if (idx === -1) return text; return text.slice(0, idx) + '【' + text.slice(idx, idx + searchQuery.length) + '】' + text.slice(idx + searchQuery.length); };

  const handleValidateOrDelete = async () => {
    if (actionState === 'running') return;
    if (isPersisted) { setConfirmDeleteTC(true); return; }
    setActionState('running');
    try {
      const result = await apiCreateAndValidateTC(reqUUID, { ...tc, ...localEdits });
      if (result.pending) { showPendingCampaignMessage(result.message); return; }
      onValidated({ id: result.data.id || result.data._id }); setValidationState('saved'); setLocalEdits({}); setHasEdits(false);
    } catch { } finally { setActionState('idle'); }
  };

  const deleteTC = async () => {
    setDeletingTC(true); setActionState('running');
    try {
      const result = await apiDeleteTC((tc as any).id);
      if (result.pending) { showPendingCampaignMessage(result.message); return; }
      onRejected();
    } catch { } finally { setDeletingTC(false); setActionState('idle'); setConfirmDeleteTC(false); }
  };

  const handleSaveTypeAndPriority = async () => {
    const changedFields = Object.keys(localEdits).filter(f => f === 'type' || f === 'priority');
    if (!changedFields.length) return;
    if (isPersisted) {
      try {
        const result = await apiEditTestCase((tc as any).id, { type: displayed.type, priority: displayed.priority });
        if (result.pending) { showPendingCampaignMessage(result.message); return; }
        onUpdated({ ...tc, ...localEdits }); setLocalEdits({}); setHasEdits(false);
      } catch { }
    }
    else { onUpdated({ ...tc, ...localEdits }); setLocalEdits({}); setHasEdits(false); }
  };

  const handleVerify = async () => {
    if (verifyState === 'running') return;
    setVerifyState('running'); setVerifyLog('');
    const changedFields = Object.keys(localEdits);
    try {
      const result = await apiVerifyTC({ ...tc, ...localEdits }, changedFields, model, reqDescription);
      if (result.pending) { showPendingCampaignMessage(result.message); setVerifyState('idle'); return; }
      onUpdated({ ...result.testCase, testId: tc.testId }); setLocalEdits({}); setHasEdits(false);
      setVerifyLog('TC vérifié et corrigé par le modèle.'); setVerifyState('done'); setTimeout(() => { setVerifyLog(''); setVerifyState('idle'); }, 4000);
    } catch (e: any) { setVerifyLog(e.message); setVerifyState('idle'); }
  };

  const handleRegenerate = async () => {
    if (!regenerationInstruction.trim() || regenerationState === 'running' || isPersisted) return;
    setRegenerationState('running');
    try {
      const { testCase, warning } = await apiRegenSingleTC(tc, regenerationInstruction, model, reqDescription, allOtherTCs, projectId || null);
      if (warning?.isStrict) { setSimilarityWarning({ ...warning, generatedTC: testCase }); setRegenerationState('idle'); return; }
      onUpdated({ ...testCase, testId: tc.testId }); setLocalEdits({}); setHasEdits(false);
      setShowRegenPanel(false); setRegenerationInstruction(''); setRegenerationState('done'); setTimeout(() => setRegenerationState('idle'), 2000);
    } catch { setRegenerationState('idle'); }
  };

  const handleReject = async () => {
    if (actionState === 'running') return;
    setConfirmRejectTC(true);
  };

  const confirmReject = async () => {
    setRejectingTC(true); setActionState('running');
    try {
      if (isPersisted) {
        // appelait apiDeleteTC (suppression définitive, jamais
        // comptée comme "rejet" côté dashboard) — voir commentaire sur
        // apiReviewTC. On appelle désormais le vrai workflow de revue, qui
        // conserve le TC en base avec review_status='rejected' (audit +
        // KPI "Rejetés (total)" du dashboard QA).
        const result = await apiReviewTC((tc as any).id, 'rejected');
        if (result.pending) { showPendingCampaignMessage(result.message); return; }
      } else {
        await apiRejectPendingTC(reqUUID, tc);
      }
      onRejected();
    } catch { onRejected(); } finally { setActionState('idle'); setRejectingTC(false); setConfirmRejectTC(false); }
  };

  const handleSetExecution = async (status: 'passed' | 'failed' | 'not_tested') => {
    if (!isPersisted || executionSaving) return;
    const previous = executionStatus;
    setExecutionStatus(status); setExecutionSaving(true);
    try {
      const updated = await apiSetTestCaseExecution((tc as any).id, status);
      onUpdated({ ...tc, executionStatus: updated.executionStatus });
    } catch (e: any) {
      setExecutionStatus(previous);
      showPendingCampaignMessage(e?.message || "Impossible d'enregistrer le résultat d'exécution.");
    } finally { setExecutionSaving(false); }
  };


  return (
    <div ref={el => { if (tcDbId) registerEntityRef?.(`tc:${tcDbId}`, el); }} className={`rounded-xl mb-3 overflow-hidden transition-all shadow-solid-2 hover:shadow-solid-3${isFlashing ? ' animate-realtime-flash' : ''}`} style={{ border: `1.5px solid ${borderColor}` }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-3 bg-alabaster dark:bg-blacksection flex-wrap">
        <div onClick={() => setOpen(!open)} className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
          <IdTag color="#2563eb">{tc.testId}</IdTag>
          {isPersisted
            ? <StatusPill tone="success" dotColor="#0cc4ac">Sauvegardé</StatusPill>
            : <StatusPill tone="warning" dotColor="#d97706">En attente</StatusPill>}
          {hasEdits && <Badge tone="info" icon={<IconEdit className="w-2.5 h-2.5" />}>Modifié</Badge>}
          {displayed.needsReview && (
            <span title={displayed.needsReviewReason || undefined} className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-red-700 dark:text-red-400 bg-red-600/8 rounded-full px-2 py-0.5 flex-shrink-0">
              <IconAlertTriangle className="w-3 h-3" /> À réviser
              {userRole === 'QA' && (tc as any).id && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      const res = await fetch(`${API_BASE}/projects/test-cases/${(tc as any).id}/acknowledge-review`, { method: 'PATCH' });
                      if (res.ok) {
                        const json = await res.json().catch(() => null);
                        if (json?.pending) { showPendingCampaignMessage(json.message); return; }
                        onUpdated({ ...tc, needsReview: false, needsReviewReason: null });
                      }
                    } catch (err) { console.error('[TCCard] acknowledge-review error:', err); }
                  }}
                  className="hover:text-red-900 dark:hover:text-red-300"
                  title="Lever le flag à réviser"
                >
                  <IconClose className="w-3 h-3" />
                </button>
              )}
            </span>
          )}
          {regenerationState === 'running' && <Badge tone="info" icon={<Spinner />}>IA en cours</Badge>}
          {viewers && viewers.length > 0 && (
            <span
              title={`${viewers.join(', ')} consulte${viewers.length > 1 ? 'nt' : ''} ce cas de test`}
              className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-2 py-0.5 flex-shrink-0 bg-sky-600/8 text-sky-700 dark:text-sky-400"
            >
              <IconEye className="w-3 h-3" /> {viewers[0]}{viewers.length > 1 ? ` +${viewers.length - 1}` : ''}
            </span>
          )}
          <span className="text-sm font-bold text-black dark:text-white flex-1 min-w-0" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: open ? 'normal' : 'nowrap' }}>{highlight(displayed.title)}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
          {isQA && !isPersisted && (
            <>
              <button onClick={() => setShowRegenPanel(!showRegenPanel)} title="Régénérer avec instruction" className={`${btn.iconOnly} ${btnSize.iconSm} ${showRegenPanel ? '!bg-sky-600/10 !text-sky-700 dark:!text-sky-400' : 'hover:!text-sky-700 dark:hover:!text-sky-400'}`}><IconRefresh className="w-3.5 h-3.5" /></button>
            </>
          )}
          {isQA && !isPersisted && (
            <button onClick={handleReject} disabled={actionState === 'running'} className={`${btn.danger} ${btnSize.xs}`}><IconClose className="w-3 h-3" /> Rejeter</button>
          )}
          <ConfirmDeleteModal
            open={confirmRejectTC}
            title="Rejeter ce cas de test ?"
            message="Ce cas de test sera rejeté et retiré de la liste. Cette action est irréversible."
            confirmLabel="Rejeter"
            loading={rejectingTC}
            onCancel={() => setConfirmRejectTC(false)}
            onConfirm={confirmReject}
          />
          {isQA && (
            <button onClick={handleValidateOrDelete} disabled={actionState === 'running'} className={isPersisted ? `${btn.danger} ${btnSize.xs}` : `${btn.success} ${btnSize.xs}`}>
              {actionState === 'running' ? <Spinner /> : isPersisted ? <><IconTrash className="w-3 h-3" /> Supprimer</> : validationState === 'saved' ? <><IconCheck className="w-3 h-3" /> Validé</> : <><IconCheck className="w-3 h-3" /> Valider</>}
            </button>
          )}
          <ConfirmDeleteModal
            open={confirmDeleteTC}
            title="Supprimer ce cas de test ?"
            message="Ce cas de test sera définitivement supprimé. Cette action est irréversible."
            loading={deletingTC}
            onCancel={() => setConfirmDeleteTC(false)}
            onConfirm={deleteTC}
          />
          <button
            onClick={() => {
              commentsDrawer.open({ projectId: projectId || '', entityType: 'test_case', entityId: commentEntityId, title: tc.testId });
              unreadComments.markRead(projectId || '', 'test_case', commentEntityId);
            }}
            title="Commentaires"
            className={`relative ${btn.iconOnly} ${btnSize.iconSm}`}
          >
            <IconMessage className="w-3.5 h-3.5" />
            {unreadComments.isUnread('test_case', commentEntityId) && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-600 border-2 border-white dark:border-black" />
            )}
          </button>
          <button onClick={() => setOpen(!open)} className={`${btn.iconOnly} ${btnSize.iconSm}`}><IconChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} /></button>
          {isPersisted && (
            <button
              onClick={() => setShowTCHistory(true)}
              title="Historique des versions"
              className={`${btn.iconOnly} ${btnSize.iconSm}`}
            >
              <IconClock className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {pendingCampaignMessage && (
        <div className="px-4 py-2 text-[11px] font-bold text-amber-800 dark:text-amber-300 bg-amber-500/10 border-t border-amber-500/25">
          ⏳ {pendingCampaignMessage}
        </div>
      )}

      {isPersisted && (
        <VersionHistoryPanel
          open={showTCHistory}
          onClose={() => setShowTCHistory(false)}
          entityType="test_case"
          entityId={tcDbId}
          entityLabel={`Cas de test « ${tc.testId} »`}
          canRestore={isQA}
          onRestored={updated => {
            onUpdated({
              ...tc,
              title: updated.title,
              steps: updated.steps,
              preconditions: updated.preconditions,
              testData: updated.test_data,
              expectedResult: updated.expected_result,
              type: updated.type,
              priority: updated.priority,
            } as TestCase);
            setLocalEdits({});
            setHasEdits(false);
          }}
        />
      )}

      {/* Edit warning bar */}
      {isQA && hasEdits && (() => {
        const changedFields = Object.keys(localEdits);
        const onlyTypeOrPriority = changedFields.length > 0 && changedFields.every(f => f === 'type' || f === 'priority');
        return (
          <div className={`px-4 py-2.5 flex items-center justify-between gap-3 border-t border-b ${onlyTypeOrPriority ? 'bg-primary/5 dark:bg-primary/10 border-primary/30' : 'bg-sky-600/5 dark:bg-sky-600/10 border-sky-600/30'}`}>
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${onlyTypeOrPriority ? 'text-primary dark:text-primary' : 'text-sky-800 dark:text-sky-300'}`}>
              {onlyTypeOrPriority ? <><IconSave className="w-3.5 h-3.5" /> <strong>Type / priorité modifiés</strong> — sauvegarde directe</> : <><IconEdit className="w-3.5 h-3.5" /> <strong>Modifications locales</strong> — vérifier via IA avant application</>}
            </span>
            <button onClick={onlyTypeOrPriority ? handleSaveTypeAndPriority : handleVerify} disabled={!onlyTypeOrPriority && verifyState === 'running'} className={onlyTypeOrPriority ? `${btn.primary} ${btnSize.xs}` : `${btn.secondary} ${btnSize.xs} !border-sky-600/40 !text-sky-700 dark:!text-sky-400`}>
              {onlyTypeOrPriority ? <><IconSave className="w-3 h-3" /> Sauvegarder</> : verifyState === 'running' ? <><Spinner /> Vérification...</> : <><IconSearch className="w-3 h-3" /> Vérifier</>}
            </button>
          </div>
        );
      })()}

      {/* Regen panel — jamais pour un TC déjà persisté (voir le bouton
          déclencheur, déjà limité à !isPersisted dans l'en-tête). */}
      {showRegenPanel && !isPersisted && (
        <div className="px-4 py-3 bg-sky-600/5 dark:bg-sky-600/10 border-t border-sky-600/30 dark:border-sky-700/40">
          <p className="inline-flex items-center gap-1.5 text-[10px] text-sky-700 dark:text-sky-400 font-semibold mb-2"><IconRefresh className="w-3 h-3" /> Régénérer — instruction obligatoire</p>
          <div className="flex gap-2">
            <input value={regenerationInstruction} onChange={e => setRegenerationInstruction(e.target.value)} disabled={isPersisted} placeholder="ex: transforme en test security..." onKeyDown={e => { if (e.key === 'Enter' && regenerationInstruction.trim()) handleRegenerate(); }} className="flex-1 px-3 py-2 rounded-lg border border-sky-600/40 bg-white dark:bg-black text-xs text-black dark:text-white focus:outline-none focus:border-sky-600" />
            <button onClick={handleRegenerate} disabled={!regenerationInstruction.trim() || regenerationState === 'running' || isPersisted} className={!regenerationInstruction.trim() || regenerationState === 'running' || isPersisted ? 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-slate-500/10 text-waterloo dark:text-manatee cursor-not-allowed' : `${btn.secondary} ${btnSize.sm} !border-sky-600/40 !text-sky-700 dark:!text-sky-400`}>{regenerationState === 'running' ? <Spinner /> : <><IconRefresh className="w-3.5 h-3.5" /> Régénérer</>}</button>
            <button onClick={() => { setShowRegenPanel(false); setRegenerationInstruction(''); }} className={`${btn.iconOnly} ${btnSize.icon}`}><IconClose className="w-4 h-4" /></button>
          </div>
        </div>
      )}

      {/* Panneau "Générer similaire" retiré : il créait un TC séparé plutôt
          que d'éditer le TC en place, ce qui ne correspond pas au besoin
          d'édition ciblée. "Régénérer" (avec instruction obligatoire) est
          l'unique mode conservé pour modifier un TC existant. */}

      {verifyLog && <div className={`px-4 py-2 text-xs font-semibold border-t inline-flex items-center gap-1.5 w-full ${verifyState === 'done' ? 'bg-meta/10 border-meta/30 text-meta' : 'bg-red-600/5 dark:bg-red-600/10 border-red-600/30 text-red-700 dark:text-red-400'}`}>{verifyState === 'done' ? <IconCheck className="w-3.5 h-3.5" /> : <IconAlertTriangle className="w-3.5 h-3.5" />}{verifyLog}</div>}

      {/* Detail */}
      {open && (
        <div className="px-4 pb-5 pt-2 border-t border-stroke dark:border-strokedark">
          {!isPersisted && <div className="mt-3 mb-4 p-3 bg-amber-600/8 rounded-lg text-xs text-amber-800 dark:text-amber-300 font-medium inline-flex items-center gap-2 w-full"><IconAlertTriangle className="w-4 h-4 shrink-0" /> TC en mémoire — cliquez <strong>Valider</strong> pour sauvegarder.</div>}
          {/* Exécution (Réussi/Échoué) — déplacé ici (hors du premier coup
              d'œil) pour alléger l'en-tête toujours visible de la carte. */}
          {isPersisted && (executionStatus === 'passed' || executionStatus === 'failed' || (isQA && campaignStatus === 'launched')) && (
            <div className="mt-3 mb-4">
              <div className="text-[10px] text-waterloo dark:text-manatee uppercase tracking-widest font-bold mb-2">Exécution</div>
              <div className="flex items-center gap-2 flex-wrap">
                {isQA && campaignStatus === 'launched' && (
                  <div className="flex items-center gap-0.5 rounded-lg border border-stroke dark:border-strokedark p-0.5 bg-white dark:bg-boxdark w-fit">
                    <button
                      onClick={() => handleSetExecution('passed')}
                      disabled={executionSaving}
                      title="Marquer réussi"
                      className={`${btnSize.iconSm} rounded-md flex items-center justify-center transition-colors ${executionStatus === 'passed' ? 'bg-meta/15 text-meta' : 'text-waterloo hover:bg-meta/10 hover:text-meta'}`}
                    ><IconCheck className="w-3.5 h-3.5" /></button>
                    <button
                      onClick={() => handleSetExecution('failed')}
                      disabled={executionSaving}
                      title="Marquer échoué"
                      className={`${btnSize.iconSm} rounded-md flex items-center justify-center transition-colors ${executionStatus === 'failed' ? 'bg-red-500/15 text-red-700 dark:text-red-400' : 'text-waterloo hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-400'}`}
                    ><IconClose className="w-3.5 h-3.5" /></button>
                  </div>
                )}
                {executionStatus === 'passed' && <Badge tone="success" icon={<IconCheck className="w-2.5 h-2.5" />}>Réussi</Badge>}
                {executionStatus === 'failed' && <Badge tone="danger" icon={<IconClose className="w-2.5 h-2.5" />}>Échoué</Badge>}
              </div>
            </div>
          )}
          {/* Export Jira — déplacé ici (hors du premier coup d'œil) pour
              alléger l'en-tête toujours visible de la carte. */}
          {canExportJira && isPersisted && (
            <div className="mt-3 mb-4">
              <div className="text-[10px] text-waterloo dark:text-manatee uppercase tracking-widest font-bold mb-2">Jira</div>
              <JiraExportSingleButton
                testCaseId={(tc as any).id}
                reqUUID={reqUUID}
                reqId={reqId}
                reqDescription={reqDescription}
                moduleName={moduleName}
                jiraIssueKey={(displayed as any).jiraIssueKey}
                jiraIssueUrl={(displayed as any).jiraIssueUrl}
                onExported={patch => onValidated(patch)}
              />
            </div>
          )}
          {/* Type selector */}
          <div className="mt-4">
            <div className="text-[10px] text-waterloo dark:text-manatee uppercase tracking-widest font-bold mb-2">Type de test</div>
            <div className="flex items-center gap-3">
              <select value={displayed.type} onChange={e => editLocal('type', e.target.value)} className="px-3 py-2 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-xs text-black dark:text-white focus:border-primary focus:outline-none cursor-pointer">
                {Object.entries(testTypeConfig).map(([value, c]) => <option key={value} value={value}>{c.label}</option>)}
              </select>
              <Badge tone="neutral" size="md" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</Badge>
            </div>
          </div>
          {/* Priority */}
          <div className="mt-4">
            <div className="text-[10px] text-waterloo dark:text-manatee uppercase tracking-widest font-bold mb-2">Priorité</div>
            <select value={displayed.priority} onChange={e => editLocal('priority', e.target.value)} className="px-3 py-2 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-black text-xs text-black dark:text-white focus:border-primary focus:outline-none cursor-pointer">
              <option value="HIGH">HIGH</option><option value="MEDIUM">MEDIUM</option><option value="LOW">LOW</option>
            </select>
          </div>
          {/* Title */}
          <div className="mt-4">
            <div className="text-[10px] text-waterloo dark:text-manatee uppercase tracking-widest font-bold mb-2">Titre</div>
            <LocalEditableField value={displayed.title} onChange={val => editLocal('title', val)} style={{ fontSize: '14px', fontWeight: 700 }} />
          </div>
          {/* Preconditions */}
          <div className="mt-4">
            <div className="text-[10px] text-waterloo dark:text-manatee uppercase tracking-widest font-bold mb-2">Préconditions</div>
            <div className="space-y-2">
              {displayed.preconditions.map((p: string, i: number) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-xs text-waterloo dark:text-manatee mt-1.5 flex-shrink-0">{i + 1}.</span>
                  <LocalEditableField value={p} onChange={val => editListItem('preconditions', i, val)} />
                  <button onClick={() => removeListItem('preconditions', i)} className="text-red-700 dark:text-red-400 mt-1 flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"><IconClose className="w-3.5 h-3.5" /></button>
                </div>
              ))}
              <AddItemRow onAdd={val => addListItem('preconditions', val)} placeholder="Nouvelle précondition..." />
            </div>
          </div>
          {/* Steps */}
          <div className="mt-4">
            <div className="text-[10px] text-waterloo dark:text-manatee uppercase tracking-widest font-bold mb-2">Étapes</div>
            <div className="space-y-2">
              {displayed.steps.map((s: string, i: number) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-xs text-waterloo dark:text-manatee mt-1.5 flex-shrink-0">{i + 1}.</span>
                  <LocalEditableField value={s} onChange={val => editListItem('steps', i, val)} />
                  <button onClick={() => removeListItem('steps', i)} className="text-red-700 dark:text-red-400 mt-1 flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"><IconClose className="w-3.5 h-3.5" /></button>
                </div>
              ))}
              <AddItemRow onAdd={val => addListItem('steps', val)} placeholder="Nouvelle étape..." />
            </div>
          </div>
          {/* Test data */}
          {displayed.testData.length > 0 && (
            <div className="mt-4">
              <div className="text-[10px] text-waterloo dark:text-manatee uppercase tracking-widest font-bold mb-2">Jeux de données</div>
              <div className="bg-alabaster dark:bg-blacksection border border-stroke dark:border-strokedark rounded-lg p-3 space-y-2">
                {displayed.testData.map((entry: string, i: number) => {
                  const ci = entry.indexOf(':'); const fn = ci > -1 ? entry.slice(0, ci).trim() : entry; const fv = ci > -1 ? entry.slice(ci + 1).trim() : '';
                  return (
                    <div key={i} className="flex items-center gap-2 pb-2 border-b border-stroke dark:border-strokedark last:border-0 last:pb-0">
                      <LocalEditableField value={fn} onChange={newFn => editListItem('testData', i, `${newFn}: ${fv}`)} style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', width: '130px', flexShrink: 0 }} />
                      <span className="text-waterloo dark:text-manatee flex-shrink-0 text-sm">:</span>
                      <LocalEditableField value={fv} onChange={val => editListItem('testData', i, `${fn}: ${val}`)} style={{ fontSize: '12px', flex: 1 }} />
                      <button onClick={() => removeListItem('testData', i)} className="text-red-700 dark:text-red-400 flex-shrink-0 opacity-50 hover:opacity-100"><IconClose className="w-3.5 h-3.5" /></button>
                    </div>
                  );
                })}
                <AddDataRow onAdd={(key, val) => addListItem('testData', `${key}: '${val}'`)} />
              </div>
            </div>
          )}
          {/* Expected result */}
          <div className="mt-4">
            <div className="text-[10px] text-waterloo dark:text-manatee uppercase tracking-widest font-bold mb-2">Résultat attendu</div>
            <LocalEditableField value={displayed.expectedResult} onChange={val => editLocal('expectedResult', val)} multiline style={{ color: '#0f766e', background: '#0d948814', border: '1px solid #0d948840', borderRadius: '10px', padding: '10px 14px' }} />
          </div>
        </div>
      )}

      {/* Similarity warning modal */}
      {(similarityWarning || genSimilarWarning) && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-99999 p-5">
          <div className="bg-white dark:bg-blacksection rounded-2xl shadow-solid-l border border-amber-500/30 p-6 max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <h3 className="inline-flex items-center gap-2 text-lg font-bold text-black dark:text-white mb-2"><IconAlertTriangle className="w-5 h-5 text-amber-600" /> Similarité détectée ({((genSimilarWarning || similarityWarning)?.scorePercent || 0)}%)</h3>
            <p className="text-sm text-waterloo dark:text-manatee mb-4">Ce nouveau cas de test est {((genSimilarWarning || similarityWarning)?.scorePercent || 0)}% similaire à un existant.</p>
            <div className="grid grid-cols-2 gap-4 mb-5">
              <div className={`${cardCls} p-4`}><p className="inline-flex items-center gap-1.5 text-sm font-bold text-meta mb-2"><IconSparkle className="w-3.5 h-3.5" /> Nouveau TC</p><p className="text-xs text-black dark:text-white">{((genSimilarWarning || similarityWarning)?.generatedTC?.title) || 'N/A'}</p></div>
              <div className={`${cardCls} p-4`}><p className="inline-flex items-center gap-1.5 text-sm font-bold text-amber-700 dark:text-amber-400 mb-2"><IconPin className="w-3.5 h-3.5" /> TC similaire existant</p><p className="text-xs text-black dark:text-white">{((genSimilarWarning || similarityWarning)?.similarTC?.title) || 'N/A'}</p></div>
            </div>
            <div className="flex gap-3 justify-end">
              <button onClick={() => { setSimilarityWarning(null); setGenSimilarWarning(null); }} className={`${btn.secondary} ${btnSize.md}`}><IconEdit className="w-4 h-4" /> Modifier</button>
              <button onClick={() => { if ((genSimilarWarning || similarityWarning)?.generatedTC) { if (genSimilarWarning && onTCAdded) onTCAdded(genSimilarWarning.generatedTC); else if (similarityWarning) { onUpdated({ ...similarityWarning.generatedTC, testId: tc.testId }); } setRegenerationInstruction(''); setShowRegenPanel(false); setGenSimilarInstruction(''); setShowGenSimilarPanel(false); } setSimilarityWarning(null); setGenSimilarWarning(null); }} className={`${btn.success} ${btnSize.md}`}><IconCheck className="w-4 h-4" /> Accepter quand même</button>
              <button onClick={() => { setSimilarityWarning(null); setRegenerationInstruction(''); setShowRegenPanel(false); setRegenerationState('idle'); setTimeout(() => { setShowRegenPanel(true); }, 100); }} className={`${btn.danger} ${btnSize.md}`}><IconRefresh className="w-4 h-4" /> Régénérer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── LocalEditableField ───────────────────────────────────────────────────────
function LocalEditableField({ value, onChange, multiline = false, style = {} }: { value: string; onChange: (val: string) => void; multiline?: boolean; style?: React.CSSProperties; }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const handleBlur = () => { setEditing(false); if (draft.trim() !== value.trim()) onChange(draft.trim()); };
  const handleChange = (val: string) => { setDraft(val); onChange(val.trim()); };
  const baseStyle: React.CSSProperties = { fontSize: 14, lineHeight: 1.7, color: '#1a202c', fontWeight: 500, background: editing ? '#fffbeb' : 'transparent', border: editing ? '1.5px solid #d97706' : '1px dashed transparent', borderRadius: 6, padding: editing ? '5px 8px' : '2px 4px', outline: 'none', width: '100%', resize: multiline ? 'vertical' as const : undefined, fontFamily: 'inherit', cursor: editing ? 'text' : 'pointer', transition: 'all 0.15s', ...style };
  if (!editing) return <span onClick={() => { setEditing(true); setDraft(value); }} title="Cliquer pour modifier" className="block hover:border-dashed hover:border-stroke dark:hover:border-strokedark" style={{ ...baseStyle, whiteSpace: 'pre-wrap' as const }}>{value || <span className="text-waterloo italic">Cliquer pour éditer...</span>}</span>;
  if (multiline) return <textarea value={draft} onChange={e => handleChange(e.target.value)} onBlur={handleBlur} autoFocus rows={3} style={baseStyle} />;
  return <input value={draft} onChange={e => handleChange(e.target.value)} onBlur={handleBlur} autoFocus style={baseStyle} />;
}

function NewTCForm({ reqId, reqDescription, reqUUID, model, existingCount, onAdd, onCancel }: {
  reqId: string; reqDescription: string; reqUUID: string; model: string; existingCount: number;
  onAdd: (tc: TestCase) => void; onCancel: () => void;
}) {
  const nextN = String(existingCount + 1).padStart(2, '0');
  const [title, setTitle]               = useState('');
  const [type, setType]                 = useState<TestCase['type']>('positive');
  const [priority, setPriority]         = useState<TestCase['priority']>('HIGH');
  const [preconditions, setPreconditions] = useState<string[]>(['']);
  const [steps, setSteps]               = useState<string[]>(['', '']);
  const [testData, setTestData]         = useState<string[]>([]);
  const [expectedResult, setExpectedResult] = useState('');
  const [verifyState, setVerifyState]   = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [verifyMsg, setVerifyMsg]       = useState('');

  const testId = `TC-${reqId.replace('-', '')}-${nextN}`;

  const buildTC = (): TestCase => ({
    testId, moduleId: '', requirementId: reqId,
    title: title.trim(), type, priority,
    preconditions: preconditions.filter(p => p.trim()),
    steps: steps.filter(s => s.trim()),
    testData: testData.filter(d => d.trim()),
    expectedResult: expectedResult.trim(),
    // Distingue dans le fil d'activité "a créé le cas de test" (ce TC, tapé
    // à la main) de "a validé le cas de test" (un TC généré par le LLM que
    // l'utilisateur persiste ensuite) — voir apiCreateAndValidateTC.
    manually_edited: true,
  });

  const isValid = title.trim() && steps.filter(s => s.trim()).length >= 1 && expectedResult.trim();

  const handleVerify = async () => {
    if (verifyState === 'running') return;
    setVerifyState('running'); setVerifyMsg('');
    const tc = buildTC();
    try {
      const res = await fetch(`${API_BASE}/projects/test-cases/verify-memory`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, reqDescription,
          changedFields: ['title', 'preconditions', 'steps', 'testData', 'expectedResult'],
          testCase: tc,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      const corrected = data.test_case;
      if (corrected.title)          setTitle(corrected.title);
      if (corrected.preconditions)  setPreconditions(corrected.preconditions.length ? corrected.preconditions : preconditions);
      if (corrected.steps)          setSteps(corrected.steps.length ? corrected.steps : steps);
      if (corrected.testData)       setTestData(corrected.testData.length ? corrected.testData : testData);
      if (corrected.expectedResult) setExpectedResult(corrected.expectedResult);
      if (corrected.type)           setType(corrected.type);
      if (corrected.priority)       setPriority(corrected.priority);
      setVerifyMsg('TC corrigé par le modèle — vérifiez les champs puis cliquez Ajouter.');
      setVerifyState('done');
    } catch (err: any) { setVerifyMsg(err.message); setVerifyState('error'); }
  };

  const handleAdd = () => {
    if (!isValid) return;
    onAdd(buildTC());
  };

  const S: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
  const inputStyle = (color = '#e2e8f0'): React.CSSProperties => ({
    padding: '7px 10px', background: '#ffffff', border: `1.5px solid ${color}`,
    borderRadius: 7, color: '#1a202c', fontSize: 13, fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box',
  });
  const labelStyle: React.CSSProperties = { fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 };

  return (
    <div className="mx-4 mb-3 rounded-2xl overflow-hidden border border-primary/25 bg-zumthor/40 dark:bg-primary/5">
      {/* Header */}
      <div className="px-4.5 py-3.5 border-b border-primary/15 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-primary"><IconSparkle className="w-3.5 h-3.5" /> Nouveau cas de test</span>
          <IdTag color="#2563eb">{testId}</IdTag>
        </div>
        <button onClick={onCancel} className={`${btn.iconOnly} ${btnSize.iconSm}`}><IconClose className="w-4 h-4" /></button>
      </div>

      <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Titre + Type + Priorité */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 120px', gap: 10 }}>
          <div style={S}>
            <div style={labelStyle}>Titre *</div>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex: Login with valid credentials"
              style={inputStyle(title.trim() ? '#2563eb40' : '#e2e8f0')} />
          </div>
          <div style={S}>
            <div style={labelStyle}>Type</div>
            <select value={type} onChange={e => setType(e.target.value as TestCase['type'])} style={{ ...inputStyle(), cursor: 'pointer' }}>
              {(['positive', 'negative', 'edge_case', 'boundary', 'state_transition', 'security', 'integration', 'concurrency'] as const).map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div style={S}>
            <div style={labelStyle}>Priorité</div>
            <select value={priority} onChange={e => setPriority(e.target.value as TestCase['priority'])} style={{ ...inputStyle(), cursor: 'pointer' }}>
              {(['HIGH','MEDIUM','LOW'] as const).map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        {/* Préconditions */}
        <div style={S}>
          <div style={labelStyle}>Préconditions</div>
          {preconditions.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0, width: 18, textAlign: 'right' }}>{i+1}.</span>
              <input value={p} onChange={e => { const n=[...preconditions]; n[i]=e.target.value; setPreconditions(n); }}
                placeholder={`Précondition ${i+1}...`} style={{ ...inputStyle(), flex: 1 }} />
              {preconditions.length > 1 && <button onClick={() => setPreconditions(preconditions.filter((_,j)=>j!==i))} style={{ background:'none',border:'none',color:'#dc2626',cursor:'pointer',flexShrink:0,padding:'2px 4px',opacity:0.6 }} className="hover:!opacity-100"><IconClose className="w-3.5 h-3.5" /></button>}
            </div>
          ))}
          <button onClick={() => setPreconditions([...preconditions,''])} style={{ marginTop:4, padding:'4px 10px', background:'transparent', border:'1px dashed #cbd5e1', borderRadius:6, color:'#94a3b8', fontSize:11, cursor:'pointer', fontFamily:'inherit', textAlign:'left' }}
            onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.borderColor='#2563eb';(e.currentTarget as HTMLElement).style.color='#2563eb';}}
            onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.borderColor='#cbd5e1';(e.currentTarget as HTMLElement).style.color='#94a3b8';}}>
            + Ajouter
          </button>
        </div>

        {/* Étapes */}
        <div style={S}>
          <div style={labelStyle}>Étapes *</div>
          {steps.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0, width: 18, textAlign: 'right' }}>{i+1}.</span>
              <input value={s} onChange={e => { const n=[...steps]; n[i]=e.target.value; setSteps(n); }}
                placeholder={i === steps.length - 1 ? 'Dernière étape = vérification...' : `Étape ${i+1}...`}
                style={{ ...inputStyle(s.trim() ? '#e2e8f0' : '#e2e8f0'), flex: 1 }} />
              {steps.length > 2 && <button onClick={() => setSteps(steps.filter((_,j)=>j!==i))} style={{ background:'none',border:'none',color:'#dc2626',cursor:'pointer',flexShrink:0,padding:'2px 4px',opacity:0.6 }} className="hover:!opacity-100"><IconClose className="w-3.5 h-3.5" /></button>}
            </div>
          ))}
          <button onClick={() => setSteps([...steps,''])} style={{ marginTop:4, padding:'4px 10px', background:'transparent', border:'1px dashed #cbd5e1', borderRadius:6, color:'#94a3b8', fontSize:11, cursor:'pointer', fontFamily:'inherit', textAlign:'left' }}
            onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.borderColor='#2563eb';(e.currentTarget as HTMLElement).style.color='#2563eb';}}
            onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.borderColor='#cbd5e1';(e.currentTarget as HTMLElement).style.color='#94a3b8';}}>
            + Ajouter
          </button>
        </div>

        {/* Jeux de données */}
        <div style={S}>
          <div style={labelStyle}>Jeux de données</div>
          {testData.map((d, i) => {
            const ci = d.indexOf(':'); const fn = ci>-1?d.slice(0,ci).trim():d; const fv = ci>-1?d.slice(ci+1).trim():'';
            return (
              <div key={i} style={{ display:'flex', gap:6, alignItems:'center' }}>
                <input value={fn} onChange={e => { const n=[...testData]; n[i]=`${e.target.value}: ${fv}`; setTestData(n); }}
                  placeholder="Nom du champ" style={{ ...inputStyle(), width:140, flexShrink:0 }} />
                <span style={{ color:'#94a3b8', flexShrink:0 }}>:</span>
                <input value={fv} onChange={e => { const n=[...testData]; n[i]=`${fn}: ${e.target.value}`; setTestData(n); }}
                  placeholder="Valeur" style={{ ...inputStyle(), flex:1 }} />
                <button onClick={() => setTestData(testData.filter((_,j)=>j!==i))} style={{ background:'none',border:'none',color:'#dc2626',cursor:'pointer',flexShrink:0,padding:'2px 4px',opacity:0.6 }} className="hover:!opacity-100"><IconClose className="w-3.5 h-3.5" /></button>
              </div>
            );
          })}
          <button onClick={() => setTestData([...testData,'Field: value'])} style={{ marginTop:4, padding:'4px 10px', background:'transparent', border:'1px dashed #cbd5e1', borderRadius:6, color:'#94a3b8', fontSize:11, cursor:'pointer', fontFamily:'inherit', textAlign:'left' }}
            onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.borderColor='#2563eb';(e.currentTarget as HTMLElement).style.color='#2563eb';}}
            onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.borderColor='#cbd5e1';(e.currentTarget as HTMLElement).style.color='#94a3b8';}}>
            + Ajouter un champ
          </button>
        </div>

        {/* Résultat attendu */}
        <div style={S}>
          <div style={labelStyle}>Résultat attendu *</div>
          <textarea value={expectedResult} onChange={e => setExpectedResult(e.target.value)}
            placeholder="Ex: The system displays a success message and redirects to the dashboard"
            rows={2} style={{ ...inputStyle(expectedResult.trim() ? '#05966940' : '#e2e8f0'), resize:'vertical', lineHeight:1.6 }} />
        </div>

        {/* Feedback vérification */}
        {verifyMsg && (
          <div style={{ padding:'8px 12px', background: verifyState==='done'?'#f0fdf4':'#fef2f2', border:`1px solid ${verifyState==='done'?'#05966940':'#f8717140'}`, borderRadius:7, fontSize:11, color: verifyState==='done'?'#166534':'#991b1b', fontWeight:600 }}>
            <span style={{display:'inline-flex',alignItems:'center',gap:5}}>{verifyState==='done'?<IconCheck className="w-3.5 h-3.5" />:<IconAlertTriangle className="w-3.5 h-3.5" />}{verifyMsg}</span>
          </div>
        )}

        {/* Actions */}
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', paddingTop:4, borderTop:'1px solid #e2e8f0' }}>
          <button onClick={onCancel} style={{ padding:'8px 16px', background:'transparent', border:'1px solid #e2e8f0', borderRadius:8, color:'#64748b', fontSize:12, cursor:'pointer', fontFamily:'inherit' }}>Annuler</button>
          <button onClick={handleVerify} disabled={!isValid || verifyState==='running'}
            style={{ padding:'8px 16px', background: !isValid||verifyState==='running'?'#f1f5f9':'#fff7ed', border:`1.5px solid ${!isValid||verifyState==='running'?'#e2e8f0':'#d9770650'}`, borderRadius:8, color: !isValid||verifyState==='running'?'#94a3b8':'#d97706', fontSize:12, fontWeight:700, cursor: !isValid||verifyState==='running'?'not-allowed':'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', gap:5 }}>
            {verifyState==='running'?<><Spinner /> Vérification...</>:<><IconSearch className="w-3.5 h-3.5" /> Vérifier via IA</>}
          </button>
          <button onClick={handleAdd} disabled={!isValid}
            style={{ padding:'8px 20px', background: isValid?'linear-gradient(135deg,#2563eb,#1d4ed8)':'#f1f5f9', border:'none', borderRadius:8, color: isValid?'#fff':'#94a3b8', fontSize:12, fontWeight:700, cursor: isValid?'pointer':'not-allowed', fontFamily:'inherit', display:'inline-flex', alignItems:'center', gap:5 }}>
            <IconCheck className="w-3.5 h-3.5" /> Ajouter le cas de test
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AddItemRow — ajouter une précondition ou une étape ───────────────────────
function AddItemRow({ onAdd, placeholder }: { onAdd: (val: string) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const [active, setActive] = useState(false);
  const submit = () => { if (draft.trim()) { onAdd(draft.trim()); setDraft(''); setActive(false); } };
  if (!active) return <button onClick={() => setActive(true)} className="mt-1.5 px-3 py-1 w-full text-left border border-dashed border-stroke dark:border-strokedark text-waterloo text-xs rounded-lg hover:border-primary/40 hover:text-primary transition-all">+ Ajouter</button>;
  return (
    <div className="flex gap-2 mt-1.5">
      <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={placeholder} autoFocus onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setDraft(''); setActive(false); } }} className="flex-1 px-3 py-1.5 bg-amber-600/5 border border-amber-600/40 rounded-lg text-xs text-black dark:text-white focus:outline-none" />
      <button onClick={submit} className="px-3 py-1.5 bg-amber-500 text-white text-xs font-bold rounded-lg">+</button>
      <button onClick={() => { setDraft(''); setActive(false); }} className="px-2.5 py-1.5 border border-stroke dark:border-strokedark text-waterloo text-xs rounded-lg">✕</button>
    </div>
  );
}

function AddDataRow({ onAdd }: { onAdd: (key: string, val: string) => void }) {
  const [active, setActive] = useState(false);
  const [key, setKey] = useState('');
  const [val, setVal] = useState('');
  const submit = () => { if (key.trim()) { onAdd(key.trim(), val.trim()); setKey(''); setVal(''); setActive(false); } };
  if (!active) return <button onClick={() => setActive(true)} className="mt-2 px-3 py-1 w-full text-left border border-dashed border-stroke dark:border-strokedark text-waterloo text-xs rounded-lg hover:border-primary/40 hover:text-primary transition-all">+ Ajouter un champ</button>;
  return (
    <div className="flex gap-2 mt-2 items-center">
      <input value={key} onChange={e => setKey(e.target.value)} placeholder="Nom du champ" autoFocus onKeyDown={e => { if (e.key === 'Tab') { e.preventDefault(); (e.currentTarget.nextElementSibling as HTMLElement)?.focus(); } if (e.key === 'Escape') { setKey(''); setVal(''); setActive(false); } }} className="w-28 px-2 py-1 bg-amber-600/5 border border-amber-600/40 rounded-lg text-xs font-bold text-waterloo focus:outline-none flex-shrink-0" />
      <span className="text-waterloo text-xs flex-shrink-0">:</span>
      <input value={val} onChange={e => setVal(e.target.value)} placeholder="Valeur" onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setKey(''); setVal(''); setActive(false); } }} className="flex-1 px-2 py-1 bg-amber-600/5 border border-amber-600/40 rounded-lg text-xs text-black dark:text-white focus:outline-none" />
      <button onClick={submit} className="px-2.5 py-1 bg-amber-500 text-white text-xs font-bold rounded-lg flex-shrink-0">+</button>
      <button onClick={() => { setKey(''); setVal(''); setActive(false); }} className="px-2 py-1 border border-stroke dark:border-strokedark text-waterloo text-xs rounded-lg flex-shrink-0">✕</button>
    </div>
  );
}

// ─── SRS Panel ────────────────────────────────────────────────────────────────
// ─── Recherche globale SRS (dans la fenêtre dédiée) ────────────────────────────
function escapeRegExp(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function highlightRelevantText(text: string, query: string) {
  const words = Array.from(new Set(query.split(/\s+/).map(w => w.trim()).filter(w => w.length >= 3)));
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    words.some(w => w.toLowerCase() === part.toLowerCase())
      ? <mark key={i} className="bg-zumthor text-primary dark:bg-primary/20 dark:text-white rounded px-0.5">{part}</mark>
      : <span key={i}>{part}</span>
  );
}

// Extrait l'ID d'exigence (FR-6.3, NFR-2, REQ-04...) en tête d'un chunk, si présent.
function extractReqId(text: string): string | null {
  const m = text.match(/\b(FR|NFR|REQ|REQUIREMENT|US|UC)[-\s]?\d+(?:\.\d+)*\b/i);
  return m ? m[0].toUpperCase().replace(/\s+/, '-') : null;
}

// Sépare le titre de section ("## E-KYC Identity Verification") du corps du chunk.
function extractSectionTitle(text: string): { title: string | null; body: string } {
  const m = text.match(/^##\s*(.+?)\n+([\s\S]*)$/);
  if (m) return { title: m[1].trim(), body: m[2].trim() };
  return { title: null, body: text.trim() };
}

function SrsResultCard({ chunk, query, index }: { chunk: any; query: string; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const { title, body } = extractSectionTitle(chunk.text || '');
  const reqId = extractReqId(body);
  const scorePct = chunk.score !== undefined ? Math.round(chunk.score * 100) : null;
  const isLong = body.length > 320;
  const displayText = expanded || !isLong ? body : body.slice(0, 320).trimEnd() + '…';

  const handleCopy = () => {
    navigator.clipboard?.writeText(chunk.text || '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="bg-white dark:bg-blacksection border border-stroke dark:border-strokedark rounded-xl p-4">
      <div className="flex items-center justify-between mb-2 gap-2">
        {reqId ? (
          <span className="text-[11px] font-bold text-primary bg-zumthor dark:bg-blackho border border-primary/30 rounded px-2 py-0.5">{reqId}</span>
        ) : (
          <span className="text-[11px] font-bold text-waterloo bg-alabaster dark:bg-black/30 border border-stroke dark:border-strokedark rounded px-2 py-0.5">Extrait #{index + 1}</span>
        )}
        {scorePct !== null && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-14 rounded-full bg-alabaster dark:bg-black/30 overflow-hidden">
              <div
                className={`h-full rounded-full ${scorePct >= 85 ? 'bg-meta' : scorePct >= 70 ? 'bg-amber-500' : 'bg-waterloo'}`}
                style={{ width: `${scorePct}%` }}
              />
            </div>
            <span className={`text-[11px] font-bold ${scorePct >= 85 ? 'text-meta' : scorePct >= 70 ? 'text-amber-600 dark:text-amber-400' : 'text-waterloo'}`}>{scorePct}%</span>
          </div>
        )}
      </div>

      {title && <p className="text-[11px] font-bold text-waterloo mb-1.5">{title}</p>}

      <p className="text-xs text-black dark:text-manatee leading-relaxed" style={{ whiteSpace: 'pre-wrap' }}>
        {highlightRelevantText(displayText, query)}
      </p>

      <div className="flex items-center gap-4 mt-2.5">
        {isLong && (
          <button onClick={() => setExpanded(v => !v)} className="text-[11px] font-bold text-primary hover:underline">
            {expanded ? 'Voir moins' : 'Voir plus'}
          </button>
        )}
        <button onClick={handleCopy} className="text-[11px] font-bold text-waterloo hover:text-black dark:hover:text-white">
          {copied ? '✓ Copié' : 'Copier'}
        </button>
      </div>
    </div>
  );
}

function GlobalSrsSearch({ projectId, srsDoc }: { projectId: string | null; srsDoc: any }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [state, setState] = useState<'idle' | 'searching' | 'done' | 'error'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (e.key === '/' && !isTyping) { e.preventDefault(); inputRef.current?.focus(); }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSearch = async (override?: string) => {
    const q = override ?? query;
    if (!q.trim() || !projectId || state === 'searching') return;
    setState('searching');
    try {
      const res = await fetch(`${API_BASE}/srs/${projectId}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, topK: 10 }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      setResults(data.chunks || []); setState('done');
    } catch { setResults([]); setState('error'); }
  };

  const handleClear = () => { setQuery(''); setResults([]); setState('idle'); };

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2.5 bg-white dark:bg-blacksection border border-stroke dark:border-strokedark rounded-full shadow-solid-3 px-4 py-2.5 focus-within:border-primary transition-all">
        <span className="text-waterloo text-sm">🔍</span>
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch(); if (e.key === 'Escape') handleClear(); }}
          placeholder="Rechercher dans le SRS du projet..."
          className="flex-1 bg-transparent text-sm text-black dark:text-white placeholder:text-waterloo focus:outline-none"
        />
        {state === 'searching' && <Spinner />}
        <button
          onClick={() => handleSearch()}
          disabled={!query.trim() || state === 'searching'}
          className={`px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all ${!query.trim() || state === 'searching' ? 'bg-stroke text-waterloo cursor-not-allowed' : 'bg-primary text-white hover:bg-primaryho'}`}
        >
          Chercher
        </button>
        <span className="hidden sm:inline text-[10px] font-bold text-waterloo bg-alabaster dark:bg-black/30 border border-stroke dark:border-strokedark rounded px-2 py-1">/</span>
      </div>

      {state === 'idle' && (
        <div className="mt-4 flex flex-wrap items-center gap-2 px-1">
          <span className="text-[11px] text-waterloo dark:text-manatee">Essayez par exemple :</span>
          {['Comment l\'authentification est gérée', 'Règles de validation du formulaire', 'Contraintes de performance', 'Gestion des erreurs réseau'].map((example) => (
            <button
              key={example}
              onClick={() => { setQuery(example); handleSearch(example); }}
              className="text-[11px] font-medium text-waterloo dark:text-manatee bg-alabaster dark:bg-black/30 border border-stroke dark:border-strokedark rounded-full px-3 py-1 hover:border-primary/40 hover:text-primary transition-colors"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {state !== 'idle' && (
        <div className="mt-4">
          {state === 'searching' && <p className="text-xs text-waterloo text-center py-6">Recherche en cours...</p>}
          {state === 'error' && <p className="text-xs text-red-700 dark:text-red-400 text-center py-6">❌ Erreur lors de la recherche.</p>}
          {state === 'done' && results.length === 0 && (
            <p className="text-xs text-waterloo text-center py-6">⚠️ Aucun passage pertinent trouvé dans le SRS pour « {query} ».</p>
          )}
          {results.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs font-bold text-waterloo">{results.length} passage(s) pertinent(s) sur {srsDoc?.chunks_count ?? '?'} chunks</p>
                <button onClick={handleClear} className="text-[11px] font-bold text-waterloo hover:text-black dark:hover:text-white">✕ Effacer</button>
              </div>
              {results.map((chunk: any, i: number) => (
                <SrsResultCard key={chunk.id || i} chunk={chunk} query={query} index={i} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SrsPanel({ projectId, srsDoc, srsFile, setSrsFile, srsUploadState, setSrsUploadState, setSrsDoc, srsFileInputRef, canUploadSrs }: any) {
  const [dragOver, setDragOver] = useState(false);
  const [uploadLog, setUploadLog] = useState('');

  const handleUploadSrs = async () => {
    if (!srsFile || !projectId || srsUploadState === 'uploading') return;
    setSrsUploadState('uploading'); setUploadLog('');
    try {
      const formData = new FormData(); formData.append('file', srsFile);
      const res = await fetch(`${API_BASE}/srs/${projectId}/upload`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      setSrsDoc(data); setSrsUploadState('done'); setUploadLog(`✅ ${data.chunksCount} chunks indexés`);
    } catch (err: any) { setSrsUploadState('error'); setUploadLog(`❌ ${err.message}`); setTimeout(() => setSrsUploadState('idle'), 3000); }
  };

  if (!projectId) return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <div className="text-6xl opacity-20">📄</div>
      <p className="text-waterloo text-sm text-center">Ouvrez ou créez un projet pour uploader un document SRS.</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-black dark:text-white">🔍 Recherche intelligente</h2>
          <p className="text-waterloo text-sm mt-1">Retrouvez un passage du cahier des charges par le sens, pas seulement par mot-clé exact</p>
        </div>
        {srsDoc && (
          <div className="flex items-center gap-3 rounded-full border border-meta/30 bg-meta/5 pl-3 pr-4 py-1.5">
            <span className="text-lg">✅</span>
            <div className="text-xs leading-tight">
              <p className="font-bold text-meta truncate max-w-[220px]">{srsDoc.filename}</p>
              <p className="text-waterloo">{srsDoc.chunks_count} chunks · indexé le {srsDoc.indexed_at ? new Date(srsDoc.indexed_at).toLocaleDateString('fr-FR') : '—'}</p>
            </div>
          </div>
        )}
      </div>

      <div className={canUploadSrs ? "grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start" : "grid grid-cols-1 gap-6 items-start"}>
        {/* ─── Colonne principale : recherche ─── */}
        <div>
          {srsDoc ? (
            <GlobalSrsSearch projectId={projectId} srsDoc={srsDoc} />
          ) : (
            <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 border-2 border-dashed border-stroke dark:border-strokedark rounded-2xl px-6 text-center">
              <div className="text-5xl opacity-20">🔍</div>
              <p className="text-black dark:text-white text-sm font-bold">Aucun document indexé pour l'instant</p>
              <p className="text-waterloo text-xs max-w-xs">{canUploadSrs ? 'Indexez un document SRS depuis le panneau à droite pour activer la recherche sémantique.' : "Aucun document SRS n'a encore été indexé pour ce projet."}</p>
            </div>
          )}
        </div>

        {/* ─── Colonne latérale : gestion du document (réservée à ADMIN/BA) ─── */}
        {canUploadSrs && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-blacksection border border-stroke dark:border-strokedark rounded-2xl overflow-hidden shadow-solid-3">
            <div className="px-4 py-3 border-b border-stroke dark:border-strokedark bg-alabaster dark:bg-black/20 flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-black dark:text-white">{srsDoc ? '🔄 Remplacer' : '⬆ Indexer un SRS'}</span>
              <span className="text-[9px] font-bold text-waterloo bg-stroke dark:bg-strokedark border border-stroke dark:border-strokedark rounded px-1.5 py-0.5">PDF · TXT · MD</span>
            </div>
            <div className="p-4">
              <div onClick={() => srsFileInputRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) setSrsFile(f); }} className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all mb-3 ${dragOver ? 'border-primary bg-zumthor dark:bg-blacksection' : srsFile ? 'border-primary/40 bg-zumthor dark:bg-blacksection' : 'border-stroke dark:border-strokedark hover:border-primary/40'}`}>
                {srsFile ? (
                  <><div className="text-2xl mb-1.5">📄</div><p className="text-xs font-bold text-primary truncate">{srsFile.name}</p><p className="text-[10px] text-waterloo">{(srsFile.size / 1024 / 1024).toFixed(2)} MB</p></>
                ) : (
                  <><div className="text-3xl mb-1.5 opacity-30">📥</div><p className="text-xs text-waterloo">Déposer le fichier ici ou cliquer</p></>
                )}
                <input ref={srsFileInputRef} type="file" accept=".pdf,.txt,.md" className="hidden" onChange={e => { if (e.target.files?.[0]) setSrsFile(e.target.files[0]); }} />
              </div>
              <div className="flex gap-2">
                <button onClick={handleUploadSrs} disabled={!srsFile || srsUploadState === 'uploading'} className={`flex-1 py-2 rounded-full text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${!srsFile || srsUploadState === 'uploading' ? 'bg-stroke text-waterloo cursor-not-allowed' : 'bg-primary text-white hover:bg-primaryho'}`}>{srsUploadState === 'uploading' ? <><Spinner /> Indexation...</> : srsDoc ? '🔄 Réindexer' : '⬆ Indexer'}</button>
                {srsFile && <button onClick={() => setSrsFile(null)} className="px-3 py-2 rounded-full border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white text-xs transition-all">✕</button>}
              </div>
              {uploadLog && <div className={`mt-3 p-2.5 rounded-lg text-[11px] font-semibold ${srsUploadState === 'done' ? 'bg-meta/10 border border-meta/30 text-meta' : 'bg-red-600/5 dark:bg-red-600/10 border border-red-600/30 text-red-700 dark:text-red-400'}`}>{uploadLog}</div>}
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

// ─── Coverage Panel ─────────────────────────────────────────────────────────
// Dashboard de couverture SRS ↔ Exigences : pour chaque chunk indexé du SRS,
// on cherche (via similarité cosinus brute côté backend) l'exigence générée
// la plus proche. % de couverture = chunks avec un match ≥ seuil / total.

interface CoverageOrphanChunk {
  chunkId: string;
  chunkIndex: number;
  text: string;
  bestScore: number;
  bestMatch: { requirementId: string; reqId: string; description: string } | null;
}
interface CoverageCoveredChunk {
  chunkId: string;
  chunkIndex: number;
  text: string;
  score: number;
  requirement: { requirementId: string; reqId: string; description: string; moduleName: string };
}
interface CoverageUngroundedReq {
  requirementId: string;
  reqId: string;
  description: string;
  moduleName: string;
  bestScore: number;
}
interface CoverageIgnoredChunk {
  chunkId: string;
  chunkIndex: number;
  text: string;
  reason: string;
}
interface CoverageData {
  hasSrs: boolean;
  hasRequirements: boolean;
  threshold: number;
  totalChunks: number;
  analyzedChunksCount: number;
  coveredChunksCount: number;
  orphanChunksCount: number;
  ignoredChunksCount: number;
  coveragePercentage: number;
  orphanChunks: CoverageOrphanChunk[];
  coveredChunks: CoverageCoveredChunk[];
  ignoredChunks: CoverageIgnoredChunk[];
  ungroundedRequirements: CoverageUngroundedReq[];
  dismissedRequirements: CoverageUngroundedReq[];
  computedAt: string;
}

function coverageColor(pct: number): string {
  if (pct >= 85) return '#059669'; // vert — meta
  if (pct >= 60) return '#d97706'; // orange
  return '#dc2626'; // rouge
}

// Chunk exclu du calcul par l'heuristique de bruit (titre vide, pagination, texte
// trop court). L'utilisateur peut contester ce classement : le chunk sort alors de
// cette liste et rejoint le calcul normal (couvert ou orphelin) au recalcul suivant.
function IgnoredChunkCard({ chunk, onConfirmContent, onConfirmIgnored }: { chunk: CoverageIgnoredChunk; onConfirmContent: (chunkId: string) => Promise<void>; onConfirmIgnored: (chunkId: string) => Promise<void> }) {
  const [busy, setBusy] = useState<'content' | 'ignore' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);

  const handleConfirm = async () => {
    setBusy('content'); setError(null);
    try {
      await onConfirmContent(chunk.chunkId);
    } catch (err: any) {
      setError(err.message || 'Échec');
    } finally {
      setBusy(null);
    }
  };

  const handleIgnore = async () => {
    setBusy('ignore'); setError(null);
    try {
      await onConfirmIgnored(chunk.chunkId);
      setReviewed(true);
    } catch (err: any) {
      setError(err.message || 'Échec');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border border-stroke dark:border-strokedark bg-alabaster dark:bg-black/20 rounded-xl px-3.5 py-2.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-stroke dark:bg-strokedark text-waterloo">passage {chunk.chunkIndex}</span>
        <span className="text-[9px] font-bold text-waterloo italic">mis de côté automatiquement : {chunk.reason}</span>
      </div>
      <p className="text-xs text-waterloo">{chunk.text}</p>
      {reviewed ? (
        <p className="mt-2 text-[10px] font-bold text-waterloo flex items-center gap-1.5">✓ Exclusion confirmée</p>
      ) : (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <button
            onClick={handleConfirm}
            disabled={busy !== null}
            className="px-3 py-1.5 rounded-full text-[10px] font-bold border border-primary/40 text-primary hover:bg-primary/10 transition-all flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy === 'content' ? <Spinner /> : '✅'} C'est du contenu réel
          </button>
          <button
            onClick={handleIgnore}
            disabled={busy !== null}
            className="px-3 py-1.5 rounded-full text-[10px] font-bold border border-stroke dark:border-strokedark text-waterloo hover:border-black/30 dark:hover:border-white/30 transition-all flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy === 'ignore' ? <Spinner /> : '🚫'} Confirmer l'exclusion
          </button>
          {error && <span className="text-[10px] text-red-600">{error}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Bloc explicatif "Comment ça marche" — vulgarisé pour un utilisateur non
// technique (BA/QA). Ouvert par défaut, repliable une fois compris. ──────────
function CoverageExplainer({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="bg-zumthor/40 dark:bg-blacksection border border-primary/20 rounded-2xl overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between gap-3 px-5 py-3 text-left">
        <span className="text-sm font-bold text-black dark:text-white flex items-center gap-2">ℹ️ Comment ça marche ?</span>
        <span className="text-waterloo text-xs flex-shrink-0">{open ? '▲ replier' : '▼ afficher'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 space-y-3 text-sm text-black dark:text-white">
          <p>Chaque section du cahier des charges doit avoir au moins une exigence. Voilà les 4 onglets :</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-red-600/30 bg-red-600/5 p-3">
              <p className="font-bold text-red-700 dark:text-red-400 mb-1">❌ À traiter</p>
              <p className="text-xs text-waterloo dark:text-manatee">Il manque une exigence pour cette section. Clique sur "Générer une exigence".</p>
            </div>
            <div className="rounded-xl border border-meta/30 bg-meta/5 p-3">
              <p className="font-bold text-meta mb-1">✅ Traité</p>
              <p className="text-xs text-waterloo dark:text-manatee">Cette section a déjà ses exigences. Rien à faire.</p>
            </div>
            <div className="rounded-xl border border-amber-600/30 bg-amber-600/5 p-3">
              <p className="font-bold text-amber-700 dark:text-amber-400 mb-1">⚠️ Exigences à vérifier</p>
              <p className="text-xs text-waterloo dark:text-manatee">Une exigence a été générée mais ne correspond à rien de précis dans le document. Vérifie si elle est justifiée.</p>
            </div>
            <div className="rounded-xl border border-stroke dark:border-strokedark bg-alabaster dark:bg-black/20 p-3">
              <p className="font-bold text-black dark:text-white mb-1">🚫 Passages exclus</p>
              <p className="text-xs text-waterloo dark:text-manatee">Du texte sans vraie information (titre vide, numéro de page...), mis de côté automatiquement. Vérifie si l'outil s'est trompé.</p>
            </div>
          </div>
          <p className="text-xs text-waterloo dark:text-manatee">Le % en haut = (passages couverts) ÷ (tout le document, passages exclus compris).</p>
        </div>
      )}
    </div>
  );
}

function CoveragePanel({ projectId, onRequirementsChanged }: { projectId: string | null; onRequirementsChanged?: () => Promise<void> }) {
  const [data, setData] = useState<CoverageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [category, setCategory] = useState<'todo' | 'done' | 'ungrounded' | 'ignored'>('todo');
  const [sectionSearch, setSectionSearch] = useState('');

  const flashSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 4000);
  };

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${API_BASE}/coverage/${projectId}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.message || `HTTP ${res.status}`);
      setData(json.data);
    } catch (err: any) {
      setError(err.message || 'Erreur lors du calcul de la couverture');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleConfirmContent = useCallback(async (chunkId: string) => {
    const res = await fetch(`${API_BASE}/coverage/chunk/${chunkId}/override`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asContent: true }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json?.message || `HTTP ${res.status}`);
    await load();
    flashSuccess('✅ Passage repris en compte — visible dans "À traiter".');
  }, [load]);

  const handleIgnoreChunk = useCallback(async (chunkId: string) => {
    const res = await fetch(`${API_BASE}/coverage/chunk/${chunkId}/ignore`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignored: true }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json?.message || `HTTP ${res.status}`);
    await load();
    flashSuccess('🚫 Passage exclu — visible dans "Passages exclus".');
  }, [load]);

  const handleDismissRequirement = useCallback(async (requirementId: string) => {
    const res = await fetch(`${API_BASE}/coverage/requirement/${requirementId}/dismiss`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismissed: true }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json?.message || `HTTP ${res.status}`);
    await load();
    flashSuccess('✅ Exigence confirmée comme justifiée — visible dans "Traité".');
  }, [load]);

  const handleExtract = useCallback(async (chunkId: string) => {
    const res = await fetch(`${API_BASE}/coverage/chunk/${chunkId}/extract-requirement`, { method: 'POST' });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json?.message || `HTTP ${res.status}`);
    return json.data as { requirementIds: string[]; requirements: { requirementId: string; reqId: string; description: string }[]; moduleName: string };
  }, []);

  const handleKeepExtraction = useCallback(async () => {
    await load();
    await onRequirementsChanged?.();
    flashSuccess('✅ Exigence conservée — visible dans "Traité".');
  }, [load]);

  const handleDiscardExtraction = useCallback(async (chunkId: string, requirementIds: string[]) => {
    await Promise.all(requirementIds.map(id => fetch(`${API_BASE}/projects/requirements/${id}`, { method: 'DELETE' })));
    await fetch(`${API_BASE}/coverage/chunk/${chunkId}/override`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asContent: false }),
    });
    await load();
    await onRequirementsChanged?.();
    flashSuccess('❌ Exigence générée annulée — le passage reste "À traiter".');
  }, [load]);

  // Génère et garde directement une exigence pour chaque passage donné (raccourci
  // "toute la section" — sans aperçu individuel, contrairement au bouton par passage).
  const handleBulkExtract = useCallback(async (chunkIds: string[]) => {
    let success = 0;
    for (const chunkId of chunkIds) {
      try {
        const res = await fetch(`${API_BASE}/coverage/chunk/${chunkId}/extract-requirement`, { method: 'POST' });
        const json = await res.json();
        if (res.ok && json.success) success++;
      } catch {
        // on continue avec les passages suivants même si l'un échoue
      }
    }
    await load();
    await onRequirementsChanged?.();
    flashSuccess(`✅ ${success}/${chunkIds.length} exigence(s) générée(s) pour cette section.`);
  }, [load]);

  if (!projectId) return null;

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3">
        <Spinner />
        <p className="text-waterloo text-xs">Analyse du cahier des charges en cours...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3">
        <p className="text-red-600 text-sm font-bold">❌ {error}</p>
        <button onClick={() => load()} className="px-4 py-2 rounded-full text-xs font-bold border border-stroke dark:border-strokedark hover:border-primary/40 text-waterloo hover:text-black dark:hover:text-white transition-all">Réessayer</button>
      </div>
    );
  }

  if (!data || !data.hasSrs) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-center">
        <div className="text-5xl opacity-20">🎯</div>
        <p className="text-waterloo text-sm">Indexez d'abord un document SRS pour calculer la couverture.</p>
      </div>
    );
  }

  if (!data.hasRequirements) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 text-center">
        <div className="text-5xl opacity-20">🎯</div>
        <p className="text-waterloo text-sm">Générez d'abord des exigences pour ce projet pour calculer la couverture.</p>
      </div>
    );
  }

  // Regroupe les passages par section du SRS (titre "## ...") pour une checklist
  // lisible : une ligne par section, "traité" si tous ses passages sont couverts.
  // Les passages sans titre de section (souvent d'anciens passages exclus tout
  // juste repris en compte) gardent chacun leur propre entrée, plutôt que d'être
  // noyés dans une carte "Autres passages" commune où on ne les retrouve plus.
  const sections = (() => {
    const extractHeading = (text: string) => text.match(/^##\s*([^\n]+)/)?.[1]?.trim() || null;
    const map = new Map<string, { name: string; covered: CoverageCoveredChunk[]; orphans: CoverageOrphanChunk[] }>();
    const ensure = (name: string) => {
      if (!map.has(name)) map.set(name, { name, covered: [], orphans: [] });
      return map.get(name)!;
    };
    data.coveredChunks.forEach(c => ensure(extractHeading(c.text) || `Passage ${c.chunkIndex} (sans titre de section)`).covered.push(c));
    data.orphanChunks.forEach(c => ensure(extractHeading(c.text) || `Passage ${c.chunkIndex} (sans titre de section)`).orphans.push(c));
    return Array.from(map.values()).sort((a, b) => (b.orphans.length > 0 ? 1 : 0) - (a.orphans.length > 0 ? 1 : 0));
  })();
  const treatedCount = sections.filter(s => s.orphans.length === 0).length;
  const todoSections = sections.filter(s => s.orphans.length > 0);
  const doneSections = sections.filter(s => s.orphans.length === 0);
  const searchLower = sectionSearch.trim().toLowerCase();
  const filteredTodoSections = searchLower ? todoSections.filter(s => s.name.toLowerCase().includes(searchLower)) : todoSections;
  const filteredDoneSections = searchLower ? doneSections.filter(s => s.name.toLowerCase().includes(searchLower)) : doneSections;
  const catTabs: { key: 'todo' | 'done' | 'ungrounded' | 'ignored'; label: string }[] = [
    { key: 'todo', label: `❌ À traiter · ${todoSections.length}` },
    { key: 'done', label: `✅ Traité · ${doneSections.length + data.dismissedRequirements.length}` },
    { key: 'ungrounded', label: `⚠️ Exigences à vérifier · ${data.ungroundedRequirements.length}` },
    { key: 'ignored', label: `🚫 Passages exclus · ${data.ignoredChunks.length}` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-black dark:text-white">Qualité de l'extraction</h2>
          <p className="text-waterloo text-sm mt-1">Est-ce que tout ce qui est écrit dans le cahier des charges a bien été transformé en exigence testable ?</p>
        </div>
        <button onClick={() => load()} disabled={loading} className="px-3 py-1.5 rounded-full text-[10px] font-bold border border-stroke dark:border-strokedark hover:border-primary/40 text-waterloo hover:text-black dark:hover:text-white transition-all flex items-center gap-1.5">
          {loading ? <Spinner /> : '🔄'} Recalculer
        </button>
      </div>

      <CoverageExplainer open={showExplainer} onToggle={() => setShowExplainer(x => !x)} />

      {successMsg && (
        <div className="rounded-xl border border-meta/30 bg-meta/10 px-4 py-2.5 text-sm font-semibold text-meta">
          {successMsg}
        </div>
      )}

      {/* ─── Résumé (% + compteurs) ─── */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-waterloo dark:text-manatee">{treatedCount} section{treatedCount > 1 ? 's' : ''} traitée{treatedCount > 1 ? 's' : ''} sur {sections.length} · {data.coveredChunksCount}/{data.analyzedChunksCount} passages couverts</p>
        <span className={`text-2xl font-bold flex-shrink-0 ${data.coveragePercentage === 100 ? 'text-meta' : 'text-primary'}`}>{data.coveragePercentage}%</span>
      </div>

      {/* ─── Recherche par section ─── */}
      <input
        type="text"
        value={sectionSearch}
        onChange={e => setSectionSearch(e.target.value)}
        placeholder="Rechercher une section..."
        className="w-full px-3.5 py-2 rounded-full text-xs border border-stroke dark:border-strokedark bg-white dark:bg-blacksection text-black dark:text-white placeholder:text-waterloo focus:outline-none focus:border-primary/50"
      />

      {/* ─── Onglets par catégorie ─── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {catTabs.map(t => (
          <button
            key={t.key}
            onClick={() => setCategory(t.key)}
            className={`px-3 py-1.5 rounded-full text-[11px] font-bold border transition-all ${category === t.key ? 'border-primary bg-zumthor dark:bg-blacksection text-primary' : 'border-stroke dark:border-strokedark text-waterloo hover:border-primary/40'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── Contenu de l'onglet actif ─── */}
      <div className="space-y-2.5">
        {category === 'todo' && (
          filteredTodoSections.length === 0
            ? <p className="text-center text-waterloo text-xs py-10">{sectionSearch ? 'Aucune section ne correspond à la recherche.' : 'Tout est traité. 🎉'}</p>
            : filteredTodoSections.map(section => <SectionRow key={section.name} section={section} onExtract={handleExtract} onIgnore={handleIgnoreChunk} onKeep={handleKeepExtraction} onDiscard={handleDiscardExtraction} onBulkExtract={handleBulkExtract} />)
        )}
        {category === 'done' && (
          filteredDoneSections.length === 0 && data.dismissedRequirements.length === 0
            ? <p className="text-center text-waterloo text-xs py-10">{sectionSearch ? 'Aucune section ne correspond à la recherche.' : "Aucune section traitée pour l'instant."}</p>
            : <>
                {filteredDoneSections.map(section => <SectionRow key={section.name} section={section} onExtract={handleExtract} onIgnore={handleIgnoreChunk} onKeep={handleKeepExtraction} onDiscard={handleDiscardExtraction} onBulkExtract={handleBulkExtract} />)}
                {!sectionSearch && data.dismissedRequirements.map(req => (
                  <div key={req.requirementId} className="bg-white dark:bg-blacksection border border-stroke dark:border-strokedark rounded-2xl px-5 py-4 shadow-solid-3">
                    <p className="text-[10px] font-bold text-meta mb-1">✅ {req.reqId} · {req.moduleName} — confirmée justifiée</p>
                    <p className="text-sm text-black dark:text-white">{req.description}</p>
                  </div>
                ))}
              </>
        )}
        {category === 'ungrounded' && (
          data.ungroundedRequirements.length === 0
            ? <p className="text-center text-waterloo text-xs py-10">Toutes les exigences correspondent bien à un passage du document. 👍</p>
            : data.ungroundedRequirements.map(req => (
                <UngroundedRequirementCard key={req.requirementId} req={req} onDismiss={handleDismissRequirement} />
              ))
        )}
        {category === 'ignored' && (
          data.ignoredChunks.length === 0
            ? <p className="text-center text-waterloo text-xs py-10">Aucun passage exclu.</p>
            : data.ignoredChunks.map(chunk => (
                <IgnoredChunkCard key={chunk.chunkId} chunk={chunk} onConfirmContent={handleConfirmContent} onConfirmIgnored={handleIgnoreChunk} />
              ))
        )}
      </div>
    </div>
  );
}

function UngroundedRequirementCard({ req, onDismiss }: { req: CoverageUngroundedReq; onDismiss: (requirementId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDismiss = async () => {
    setBusy(true); setError(null);
    try {
      await onDismiss(req.requirementId);
    } catch (e: any) {
      setError(e.message || 'Échec');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white dark:bg-blacksection border border-amber-600/30 rounded-2xl px-5 py-4 shadow-solid-3">
      <p className="text-[10px] font-bold text-amber-700 dark:text-amber-400 mb-1">{req.reqId} · {req.moduleName}</p>
      <p className="text-sm text-black dark:text-white mb-3">{req.description}</p>
      <div className="flex items-center gap-2">
        <button
          onClick={handleDismiss}
          disabled={busy}
          className="px-3 py-1.5 rounded-full text-[10px] font-bold border border-meta/40 text-meta hover:bg-meta/10 transition-all flex items-center gap-1.5 disabled:opacity-50"
        >
          {busy ? <Spinner /> : '✅'} Confirmer comme justifiée
        </button>
        {error && <span className="text-[10px] text-red-600">{error}</span>}
      </div>
    </div>
  );
}

// Une ligne = une section du SRS. Vert si tout est couvert, sinon bouton d'action direct.
function SectionRow({ section, onExtract, onIgnore, onKeep, onDiscard, onBulkExtract }: {
  section: { name: string; covered: CoverageCoveredChunk[]; orphans: CoverageOrphanChunk[] };
  onExtract: (chunkId: string) => Promise<{ requirementIds: string[]; requirements: { requirementId: string; reqId: string; description: string }[]; moduleName: string }>;
  onIgnore: (chunkId: string) => Promise<void>;
  onKeep: () => Promise<void>;
  onDiscard: (chunkId: string, requirementIds: string[]) => Promise<void>;
  onBulkExtract: (chunkIds: string[]) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const done = section.orphans.length === 0;
  const total = section.covered.length + section.orphans.length;

  const handleBulk = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBulkBusy(true);
    try {
      await onBulkExtract(section.orphans.map(c => c.chunkId));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className={`bg-white dark:bg-blacksection rounded-2xl border shadow-solid-3 overflow-hidden ${done ? 'border-stroke dark:border-strokedark' : 'border-red-600/30'}`}>
      <button onClick={() => setExpanded(x => !x)} className="w-full flex items-center gap-3 px-5 py-4 text-left">
        <span className={`text-xl flex-shrink-0 ${done ? 'text-meta' : 'text-red-600 dark:text-red-400'}`}>{done ? '✅' : '❌'}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-black dark:text-white font-semibold truncate">{section.name}</p>
          <p className="text-[11px] text-waterloo dark:text-manatee mt-0.5">
            {done ? `${total} passage${total > 1 ? 's' : ''} couvert${total > 1 ? 's' : ''}` : `${section.orphans.length} passage${section.orphans.length > 1 ? 's' : ''} sans exigence sur ${total}`}
          </p>
        </div>
        {!done && section.orphans.length > 1 && (
          <button
            onClick={handleBulk}
            disabled={bulkBusy}
            className="flex-shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold border border-meta/40 text-meta hover:bg-meta/10 transition-all flex items-center gap-1 disabled:opacity-50"
          >
            {bulkBusy ? <Spinner /> : '⚡'} Générer pour tous ({section.orphans.length})
          </button>
        )}
        <span className="text-waterloo text-xs flex-shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-5 pb-4 pt-0 space-y-2.5 border-t border-current/10">
          {section.orphans.map(chunk => (
            <OrphanChunkRow key={chunk.chunkId} chunk={chunk} onExtract={onExtract} onIgnore={onIgnore} onKeep={onKeep} onDiscard={onDiscard} />
          ))}
          {section.covered.map(chunk => (
            <div key={chunk.chunkId} className="mt-2.5 rounded-xl border border-stroke dark:border-strokedark bg-alabaster dark:bg-black/20 p-3">
              <p className="text-xs text-black dark:text-white mb-2">{chunk.text}</p>
              <div className="flex items-start gap-1.5 text-xs pl-2 border-l-2 border-meta/40">
                <span className="opacity-60">✅</span>
                <div>
                  <p className="font-bold text-black dark:text-white">{chunk.requirement.reqId} · {chunk.requirement.moduleName}</p>
                  <p className="text-waterloo dark:text-manatee">{chunk.requirement.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Un passage sans exigence : l'utilisateur choisit soit d'en générer une, soit
// de confirmer que ce passage n'a volontairement pas besoin d'exigence.
function OrphanChunkRow({ chunk, onExtract, onIgnore, onKeep, onDiscard }: {
  chunk: CoverageOrphanChunk;
  onExtract: (chunkId: string) => Promise<{ requirementIds: string[]; requirements: { requirementId: string; reqId: string; description: string }[]; moduleName: string }>;
  onIgnore: (chunkId: string) => Promise<void>;
  onKeep: () => Promise<void>;
  onDiscard: (chunkId: string, requirementIds: string[]) => Promise<void>;
}) {
  const [busy, setBusy] = useState<'extract' | 'ignore' | 'keep' | 'discard' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{ moduleName: string; requirements: { requirementId: string; reqId: string; description: string }[] } | null>(null);
  const [kept, setKept] = useState(false);

  const handleExtract = async () => {
    setBusy('extract'); setErr(null);
    try {
      const data = await onExtract(chunk.chunkId);
      setGenerated({ moduleName: data.moduleName, requirements: data.requirements });
    } catch (e: any) {
      setErr(e.message || 'Échec');
    } finally {
      setBusy(null);
    }
  };

  const handleIgnore = async () => {
    setBusy('ignore'); setErr(null);
    try {
      await onIgnore(chunk.chunkId);
    } catch (e: any) {
      setErr(e.message || 'Échec');
    } finally {
      setBusy(null);
    }
  };

  const handleKeep = async () => {
    setBusy('keep'); setErr(null);
    try {
      await onKeep();
      setKept(true);
    } catch (e: any) {
      setErr(e.message || 'Échec');
    } finally {
      setBusy(null);
    }
  };

  const handleDiscard = async () => {
    if (!generated) return;
    setBusy('discard'); setErr(null);
    try {
      await onDiscard(chunk.chunkId, generated.requirements.map(r => r.requirementId));
      setGenerated(null);
    } catch (e: any) {
      setErr(e.message || 'Échec');
    } finally {
      setBusy(null);
    }
  };

  if (generated) {
    return (
      <div className="mt-2.5 rounded-xl border border-meta/30 bg-meta/5 p-3">
        <p className="text-[10px] font-bold text-meta mb-1">Exigence générée · {generated.moduleName}</p>
        <p className="text-xs text-black dark:text-white mb-2.5 italic">Source : {chunk.text}</p>
        <div className="space-y-2 mb-3">
          {generated.requirements.map(req => (
            <div key={req.requirementId} className="rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-2.5">
              <p className="text-[10px] font-bold text-black dark:text-white mb-0.5">{req.reqId}</p>
              <p className="text-xs text-waterloo dark:text-manatee">{req.description}</p>
            </div>
          ))}
        </div>
        {kept ? (
          <p className="text-[10px] font-bold text-meta">✓ Exigence conservée</p>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleKeep}
              disabled={busy !== null}
              className="px-2.5 py-1 rounded-full text-[10px] font-bold border border-meta/40 text-meta hover:bg-meta/10 transition-all flex items-center gap-1 disabled:opacity-50"
            >
              {busy === 'keep' ? <Spinner /> : '✅'} Garder
            </button>
            <button
              onClick={handleDiscard}
              disabled={busy !== null}
              className="px-2.5 py-1 rounded-full text-[10px] font-bold border border-stroke dark:border-strokedark text-waterloo hover:border-black/30 dark:hover:border-white/30 transition-all flex items-center gap-1 disabled:opacity-50"
            >
              {busy === 'discard' ? <Spinner /> : '✕'} Ne pas garder
            </button>
            {err && <span className="text-[10px] text-red-600">{err}</span>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2.5 rounded-xl border border-red-600/20 bg-red-600/5 p-3">
      <p className="text-[10px] font-bold text-red-700 dark:text-red-400 mb-1">Passage sans exigence</p>
      <p className="text-xs text-black dark:text-white mb-2.5">{chunk.text}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleExtract}
          disabled={busy !== null}
          className="px-2.5 py-1 rounded-full text-[10px] font-bold border border-meta/40 text-meta hover:bg-meta/10 transition-all flex items-center gap-1 disabled:opacity-50"
        >
          {busy === 'extract' ? <Spinner /> : '🪄'} Générer une exigence
        </button>
        <button
          onClick={handleIgnore}
          disabled={busy !== null}
          className="px-2.5 py-1 rounded-full text-[10px] font-bold border border-stroke dark:border-strokedark text-waterloo hover:border-black/30 dark:hover:border-white/30 transition-all flex items-center gap-1 disabled:opacity-50"
        >
          {busy === 'ignore' ? <Spinner /> : '⊘'} Ignorer ce passage
        </button>
        {err && <span className="text-[10px] text-red-600">{err}</span>}
      </div>
    </div>
  );
}