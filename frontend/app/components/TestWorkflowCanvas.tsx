'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  WorkflowNode,
  WorkflowNodeType,
  WorkflowEdge,
  WorkflowVariable,
  WorkflowStepStatus,
  ParsedTestDataEntry,
  parseTestDataEntries,
} from '@/lib/workflow-types';
import { WorkflowRun, WorkflowStepResult, suggestNextTestCases } from '@/lib/workflow-api';
import ConfirmDeleteModal from './ConfirmDeleteModal';

// ─── Constantes de layout ───────────────────────────────────────────────────

const NODE_WIDTH = 220;
const NODE_HEIGHT = 108;
const CANVAS_WIDTH = 1800;
const CANVAS_HEIGHT = 1000;
// Type MIME custom utilisé pour le glisser-déposer depuis le panneau "Ajouter une étape" vers le canevas.
const DRAG_MIME = 'application/x-workflow-node';

function Spinner() {
  return <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />;
}

const NODE_TYPE_META: Record<WorkflowNodeType, { icon: string; color: string; bg: string; label: string }> = {
  test_case:    { icon: '🧪', color: '#2563eb', bg: 'rgba(37,99,235,0.08)',   label: 'Cas de test' },
  // Libellés affichés uniquement — la valeur interne du type reste 'action'
  // / 'decision' (data model, API, exécution) pour ne rien casser ailleurs.
  action:       { icon: '⚙️', color: '#7c3aed', bg: 'rgba(124,58,237,0.08)',  label: 'Système externe' },
  decision:     { icon: '◇',  color: '#d97706', bg: 'rgba(217,119,6,0.08)',   label: 'Condition' },
  // Jaune pastel, volontairement distinct de l'ambre déjà utilisé par
  // 'decision' — pour une notification/bannière (email, toast, alerte...).
  notification: { icon: '🔔', color: '#ca8a04', bg: 'rgba(250,204,21,0.18)', label: 'Notification / Bannière' },
};

const STEP_STATUS_META: Record<WorkflowStepStatus, { icon: string; color: string; label: string }> = {
  idle:     { icon: '⚪', color: '#94a3b8', label: 'À exécuter' },
  passed:   { icon: '✅', color: '#16a34a', label: 'Réussi' },
  failed:   { icon: '❌', color: '#dc2626', label: 'Échoué' },
  skipped:  { icon: '⏭️', color: '#94a3b8', label: 'Ignoré' },
  blocked:  { icon: '🚫', color: '#d97706', label: 'Bloqué' },
};

export interface TestCaseOption {
  id: string;
  testId: string;
  title: string;
  type: string;
  priority: string;
  requirementId?: string;
  moduleName?: string;
  testData?: string[];
  // Positionné par l'analyse d'impact backend quand l'exigence liée (ou une
  // exigence couplée) a été modifiée par le BA depuis la dernière revue QA
  // de ce cas de test — voir shared/impact-analysis.ts.
  needsReview?: boolean;
  needsReviewReason?: string | null;
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface StepAlert {
  level: 'missing' | 'review' | 'stale';
  icon: string;
  color: string;
  message: string;
}

/**
 * Détecte si une étape "cas de test" du workflow est potentiellement périmée
 * par rapport à l'état actuel du cas de test / de son exigence :
 *  - 'missing' : le TC référencé n'existe plus dans le catalogue du projet
 *    (supprimé) — l'étape s'appuie donc uniquement sur un instantané figé.
 *  - 'review'  : l'exigence liée (ou une exigence sémantiquement couplée) a
 *    été modifiée par le BA depuis la dernière revue QA (needsReview côté TC,
 *    voir backend/src/shared/impact-analysis.ts) — le comportement testé par
 *    cette étape peut ne plus correspondre à l'exigence réelle.
 *  - 'stale'   : le TC existe toujours et n'est pas en attente de revue, mais
 *    son titre/type/priorité ont changé depuis que l'instantané a été pris
 *    (édition manuelle du TC après l'ajout de l'étape) — l'étape affiche donc
 *    des informations obsolètes.
 * Retourne null si aucune de ces situations ne s'applique (ou si l'étape
 * n'est pas de type 'test_case').
 */
export function getStepAlert(node: WorkflowNode, testCaseOptions: TestCaseOption[]): StepAlert | null {
  if (node.data.nodeType !== 'test_case') return null;
  const snap = node.data.testCaseSnapshot;
  if (!snap) return null;

  const liveTc = node.data.testCaseId ? testCaseOptions.find(t => t.id === node.data.testCaseId) : undefined;

  // Ne conclut à une suppression que si le catalogue de cas de test a bien été
  // chargé (testCaseOptions non vide) — sinon un catalogue simplement pas
  // encore chargé ferait passer TOUTES les étapes pour "supprimées" à tort.
  if (node.data.testCaseId && !liveTc && testCaseOptions.length > 0) {
    return {
      level: 'missing',
      icon: '🗑️',
      color: '#dc2626',
      message: 'Le cas de test lié à cette étape a été supprimé du projet — cette étape ne montre plus que son dernier instantané connu.',
    };
  }

  if (liveTc?.needsReview) {
    return {
      level: 'review',
      icon: '⚠️',
      color: '#b91c1c',
      message: liveTc.needsReviewReason
        ? `Exigence liée modifiée — ${liveTc.needsReviewReason}`
        : "L'exigence liée à ce cas de test a été modifiée par le BA — ce cas de test est à réviser avant de faire confiance à cette étape.",
    };
  }

  if (liveTc && (liveTc.title !== snap.title || liveTc.type !== snap.type || liveTc.priority !== snap.priority)) {
    return {
      level: 'stale',
      icon: '✏️',
      color: '#d97706',
      message: `Ce cas de test a été modifié depuis son ajout à cette étape (instantané : « ${snap.title} » · ${snap.type} · ${snap.priority} → actuel : « ${liveTc.title} » · ${liveTc.type} · ${liveTc.priority}).`,
    };
  }

  return null;
}

/** Compte les étapes d'un workflow présentant une alerte (TC supprimé, à réviser, ou obsolète). */
export function countStepAlerts(nodes: WorkflowNode[], testCaseOptions: TestCaseOption[]): number {
  return nodes.filter(n => !!getStepAlert(n, testCaseOptions)).length;
}

function nodePorts(node: WorkflowNode) {
  return {
    left:  { x: node.position.x, y: node.position.y + NODE_HEIGHT / 2 },
    right: { x: node.position.x + NODE_WIDTH, y: node.position.y + NODE_HEIGHT / 2 },
  };
}

function bezierPath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(Math.abs(x2 - x1) * 0.5, 40);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

// ─────────────────────────────────────────────────────────────────────────────

interface TestWorkflowCanvasProps {
  resetKey: string;                    // id du workflow — resynchronise l'état local à chaque changement
  projectId?: string | null;           // requis pour la suggestion IA de "prochains cas de test" (panneau Ajouter une étape)
  initialNodes: WorkflowNode[];
  initialEdges: WorkflowEdge[];
  variables: WorkflowVariable[];
  onVariablesChange: (variables: WorkflowVariable[]) => void;
  onGraphChange: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
  // Diffusion "live" pendant un glissement de nœud en cours (avant relâchement
  // de la souris) — distinct de onGraphChange, qui ne se déclenche qu'à la fin
  // du geste (mouseup) et sert à la sauvegarde. Purement visuel/éphémère côté
  // appelant (voir TestWorkflowBoard → broadcastWorkflowCanvasLive) : jamais
  // de persist() déclenché depuis ce callback.
  onLiveDrag?: (nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
  testCaseOptions: TestCaseOption[];
  readOnly?: boolean;
  // ── Mode exécution ────────────────────────────────────────────────────
  activeRun?: WorkflowRun | null;
  onStepResultChange?: (nodeId: string, result: { status: WorkflowStepStatus; note?: string; variableValues?: Record<string, string> }) => void;
  // ── Préparation des données de test (affichées dans le panneau Variables,
  // voir VariablesPanel plus bas — regroupées avec ce qu'elles remplissent) ──
  onExtractFromTestCases?: () => void;
  onGenerateData?: () => void;
  genLoading?: boolean;
}

export default function TestWorkflowCanvas({
  resetKey,
  projectId,
  initialNodes,
  initialEdges,
  variables,
  onVariablesChange,
  onGraphChange,
  onLiveDrag,
  testCaseOptions,
  readOnly = false,
  activeRun = null,
  onStepResultChange,
  onExtractFromTestCases,
  onGenerateData,
  genLoading = false,
}: TestWorkflowCanvasProps) {
  const [nodes, setNodes] = useState<WorkflowNode[]>(initialNodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(initialEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [pendingDeleteNodeId, setPendingDeleteNodeId] = useState<string | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [dragOverCanvas, setDragOverCanvas] = useState(false);

  // ── Resynchronisation "live" (viewers uniquement) ────────────────────────
  // `initialNodes`/`initialEdges` ne servaient jusqu'ici qu'à amorcer l'état
  // au montage (le canvas de l'ÉDITEUR gère ensuite ses propres nodes/edges
  // localement, sans jamais se resynchroniser sur ses props — c'est
  // volontaire : on ne veut surtout pas écraser un drag local en cours).
  // Mais pour un viewer en lecture seule (readOnly), il n'y a par
  // définition aucune modification locale à protéger : on peut donc
  // resynchroniser sans risque à chaque changement de prop — c'est ce qui
  // permet de voir en direct ce qu'un autre BA fait sur le canvas (voir
  // TestWorkflowBoard.handleGraphChange → broadcastWorkflowCanvasLive).
  useEffect(() => {
    if (!readOnly) return;
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [readOnly, initialNodes, initialEdges]);

  // ── Suggestion IA "quels cas de test pourraient suivre celui-ci ?" ──────
  // Déclenchée quand le panneau "Ajouter une étape" est ouvert. On transmet
  // TOUTE la séquence des cas de test déjà présents dans le workflow, dans
  // l'ordre d'insertion (pas seulement le dernier) — voir suggestNextTestCases
  // côté backend, qui construit le contexte du scénario complet à partir de
  // cette liste pour juger la suite logique en connaissance de tout ce qui a
  // déjà été fait, pas seulement de la dernière étape isolée.
  const workflowTcSequence = useMemo(
    () => nodes.filter(n => n.data.nodeType === 'test_case' && n.data.testCaseId).map(n => n.data.testCaseId as string),
    [nodes],
  );
  const lastAddedTcId = workflowTcSequence.length > 0 ? workflowTcSequence[workflowTcSequence.length - 1] : null;
  // Clé qui change dès que la séquence change (pas seulement le dernier id) —
  // sert de garde pour ne relancer l'appel IA que quand le scénario évolue
  // réellement (nouvelle étape ajoutée), pas à chaque re-render du panneau.
  const workflowSequenceKey = workflowTcSequence.join('|');

  const [aiNextSuggest, setAiNextSuggest] = useState<{
    sequenceKey: string | null;
    loading: boolean;
    error: string | null;
    results: { id: string; reason?: string }[];
  }>({ sequenceKey: null, loading: false, error: null, results: [] });

  useEffect(() => {
    if (!showAddMenu || !projectId || !lastAddedTcId) return;
    // Déjà calculé (ou en cours de calcul) pour cette même séquence — pas
    // besoin de rappeler le modèle à chaque re-render du panneau.
    if (aiNextSuggest.sequenceKey === workflowSequenceKey && (aiNextSuggest.loading || !aiNextSuggest.error)) return;
    let cancelled = false;
    setAiNextSuggest({ sequenceKey: workflowSequenceKey, loading: true, error: null, results: [] });
    suggestNextTestCases(projectId, lastAddedTcId, workflowTcSequence)
      .then(res => { if (!cancelled) setAiNextSuggest({ sequenceKey: workflowSequenceKey, loading: false, error: null, results: res.suggestions || [] }); })
      .catch((err: any) => { if (!cancelled) setAiNextSuggest({ sequenceKey: workflowSequenceKey, loading: false, error: err?.message || 'Erreur lors de la suggestion', results: [] }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAddMenu, projectId, lastAddedTcId, workflowSequenceKey]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const connectRef = useRef<{ sourceId: string } | null>(null);
  const [connectPreview, setConnectPreview] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Aimantation en cours pendant le glisser d'une notification/bannière —
  // voir handleMouseMove/handleMouseUp. Surligne la case hôte visée pendant
  // le geste et détermine le rattachement final au relâchement.
  const [snapTarget, setSnapTarget] = useState<{ hostId: string; side: 'above' | 'below' } | null>(null);
  const SNAP_THRESHOLD = 60;
  // Throttle de onLiveDrag — handleMouseMove se déclenche à la fréquence du
  // navigateur (souvent >60/s), largement trop pour un appel réseau à chaque
  // frame.
  const lastLiveDrag = useRef(0);
  const LIVE_DRAG_THROTTLE_MS = 150;

  // Resynchronise l'état local quand on change de workflow (jamais sur un simple re-render).
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Resynchronise nodes/edges quand ils changent depuis l'extérieur (refetch
  // 'workflow:updated', ou surtout push 'workflow:canvas-live' d'un autre
  // utilisateur relayé par TestWorkflowBoard) — sans toucher à la sélection
  // locale, contrairement à l'effet ci-dessus qui ne se déclenche qu'au
  // changement de workflow. Sans ceci, `initialNodes`/`initialEdges` changent
  // bien dans le state du parent mais ne sont jamais reflétés à l'écran tant
  // que `resetKey` ne change pas — le canvas affiché "gèle". On ignore
  // pendant un geste local en cours (drag/connexion) pour ne pas l'écraser.
  useEffect(() => {
    if (dragRef.current || connectRef.current) return;
    setNodes(initialNodes);
    setEdges(initialEdges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNodes, initialEdges]);

  const commit = useCallback((nextNodes: WorkflowNode[], nextEdges: WorkflowEdge[]) => {
    setNodes(nextNodes);
    setEdges(nextEdges);
    onGraphChange(nextNodes, nextEdges);
  }, [onGraphChange]);

  // Position réellement affichée d'un nœud : pour une notification/bannière
  // déjà rattachée à une étape hôte, on ignore `node.position` (jamais mis à
  // jour pour ce type) et on calcule sa position à partir de celle — LIVE —
  // de l'hôte, pour qu'elle suive automatiquement quand l'hôte est déplacé.
  const NOTIFICATION_GAP = 14;
  const effectivePosition = useCallback((node: WorkflowNode): { x: number; y: number } => {
    // Pendant qu'ELLE est activement en train d'être glissée, on n'applique
    // jamais le calcul par rapport à l'hôte — sinon elle resterait collée à
    // l'ancien hôte pendant le geste censé la décrocher/rattacher ailleurs
    // (voir handleMouseMove, qui gère lui-même l'aimantation en direct).
    if (dragRef.current?.nodeId === node.id) return node.position;
    if (node.data.nodeType === 'notification' && node.data.attachedToNodeId) {
      const host = nodes.find(n => n.id === node.data.attachedToNodeId);
      if (host) {
        return node.data.attachedSide === 'below'
          ? { x: host.position.x, y: host.position.y + NODE_HEIGHT + NOTIFICATION_GAP }
          : { x: host.position.x, y: host.position.y - NODE_HEIGHT - NOTIFICATION_GAP };
      }
    }
    return node.position;
  }, [nodes]);

  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return { x: (clientX - rect.left + el.scrollLeft) / zoom, y: (clientY - rect.top + el.scrollTop) / zoom };
  }, [zoom]);

  // ── Drag d'un nœud ───────────────────────────────────────────────────────
  const startDragNode = (e: React.MouseEvent, node: WorkflowNode) => {
    if (readOnly) return;
    e.stopPropagation();
    setSnapTarget(null);
    const pt = canvasPoint(e.clientX, e.clientY);
    dragRef.current = { nodeId: node.id, offsetX: pt.x - node.position.x, offsetY: pt.y - node.position.y };
  };

  // ── Connexion port → port ────────────────────────────────────────────────
  const startConnect = (e: React.MouseEvent, sourceId: string) => {
    if (readOnly) return;
    const source = nodes.find(n => n.id === sourceId);
    // Une notification/bannière n'est jamais reliée par une arête — elle est
    // rattachée à sa case hôte via attachedToNodeId (voir NodeInspector).
    if (source?.data.nodeType === 'notification') return;
    e.stopPropagation();
    connectRef.current = { sourceId };
    if (source) {
      const { right } = nodePorts(source);
      const pt = canvasPoint(e.clientX, e.clientY);
      setConnectPreview({ x1: right.x, y1: right.y, x2: pt.x, y2: pt.y });
    }
  };

  const finishConnect = (targetId: string) => {
    const target = nodes.find(n => n.id === targetId);
    if (connectRef.current && connectRef.current.sourceId !== targetId && target?.data.nodeType !== 'notification') {
      const sourceId = connectRef.current.sourceId;
      const exists = edges.some(ed => ed.source === sourceId && ed.target === targetId);
      if (!exists) {
        const newEdge: WorkflowEdge = { id: uid('edge'), source: sourceId, target: targetId, data: {} };
        commit(nodes, [...edges, newEdge]);
      }
    }
    connectRef.current = null;
    setConnectPreview(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const pt = canvasPoint(e.clientX, e.clientY);
    if (dragRef.current) {
      const { nodeId, offsetX, offsetY } = dragRef.current;
      let nx = Math.max(0, Math.min(CANVAS_WIDTH - NODE_WIDTH, pt.x - offsetX));
      let ny = Math.max(0, Math.min(CANVAS_HEIGHT - NODE_HEIGHT, pt.y - offsetY));

      // Aimantation d'une notification/bannière sur la case la plus proche,
      // juste au-dessus ou en dessous — c'est cette proximité en direct qui
      // détermine le rattachement final (voir handleMouseUp), exactement
      // comme le BA le fait "à la main" pour n'importe quel autre nœud.
      const draggedNode = nodes.find(n => n.id === nodeId);
      if (draggedNode?.data.nodeType === 'notification') {
        let best: { hostId: string; side: 'above' | 'below'; x: number; y: number; dist: number } | null = null;
        for (const host of nodes) {
          if (host.id === nodeId || host.data.nodeType === 'notification') continue;
          const candidates: { side: 'above' | 'below'; x: number; y: number }[] = [
            { side: 'above', x: host.position.x, y: host.position.y - NODE_HEIGHT - NOTIFICATION_GAP },
            { side: 'below', x: host.position.x, y: host.position.y + NODE_HEIGHT + NOTIFICATION_GAP },
          ];
          for (const c of candidates) {
            const dist = Math.hypot(nx - c.x, ny - c.y);
            if (dist <= SNAP_THRESHOLD && (!best || dist < best.dist)) {
              best = { hostId: host.id, side: c.side, x: c.x, y: c.y, dist };
            }
          }
        }
        if (best) {
          nx = best.x;
          ny = best.y;
          setSnapTarget({ hostId: best.hostId, side: best.side });
        } else {
          setSnapTarget(null);
        }
      }

      const nextNodes = nodes.map(n => (n.id === nodeId ? { ...n, position: { x: nx, y: ny } } : n));
      setNodes(nextNodes);
      // Diffusion live pendant le geste (throttlée) — c'est ce qui permet aux
      // autres de voir le nœud bouger AVANT le relâchement de la souris,
      // plutôt que de ne recevoir que la position finale via commit().
      if (onLiveDrag) {
        const now = Date.now();
        if (now - lastLiveDrag.current >= LIVE_DRAG_THROTTLE_MS) {
          lastLiveDrag.current = now;
          onLiveDrag(nextNodes, edges);
        }
      }
    } else if (connectRef.current) {
      const source = nodes.find(n => n.id === connectRef.current!.sourceId);
      if (source) {
        const { right } = nodePorts(source);
        setConnectPreview({ x1: right.x, y1: right.y, x2: pt.x, y2: pt.y });
      }
    }
  };

  const handleMouseUp = () => {
    if (dragRef.current) {
      const nodeId = dragRef.current.nodeId;
      dragRef.current = null;
      const node = nodes.find(n => n.id === nodeId);
      if (node) {
        // Fige le rattachement (ou le détachement) décidé pendant le geste —
        // voir handleMouseMove. Lâchée loin de toute case : plus rattachée du
        // tout, elle reste où elle a été déposée (comportement libre normal).
        let finalNodes = nodes;
        if (node.data.nodeType === 'notification') {
          finalNodes = nodes.map(n => (n.id === nodeId
            ? { ...n, data: { ...n.data, attachedToNodeId: snapTarget?.hostId, attachedSide: snapTarget?.side } }
            : n));
          setNodes(finalNodes);
        }
        commit(finalNodes, edges); // persiste la position/le rattachement final
      }
      setSnapTarget(null);
    }
    if (connectRef.current) {
      // Relâché en dehors d'un nœud : annule la connexion.
      connectRef.current = null;
      setConnectPreview(null);
    }
  };

  // ── Ajout / suppression de nœuds ────────────────────────────────────────
  // dropPosition : position exacte du dépose (glisser-déposer) sur le canevas ;
  // sinon, position en cascade par défaut (clic depuis le panneau).
  const addNode = (type: WorkflowNodeType, testCase?: TestCaseOption, dropPosition?: { x: number; y: number }) => {
    const position = dropPosition || { x: 60 + (nodes.length % 5) * 40, y: 60 + Math.floor(nodes.length / 5) * 160 };

    // Extraction automatique des variables d'entrée/sortie depuis le testData
    // du cas de test choisi (convention "CLÉ: valeur" — voir parseTestDataEntries).
    let autoInput: string[] = [];
    let autoOutput: string[] = [];
    if (type === 'test_case' && testCase?.testData?.length) {
      const { input, output } = parseTestDataEntries(testCase.testData);
      autoInput = input.map(e => e.key);
      autoOutput = output.map(e => e.key);

      // Enregistre automatiquement les nouvelles variables au niveau du
      // workflow, avec leur vraie valeur déjà écrite dans le cas de test
      // (plus fiable qu'une valeur devinée par le LLM plus tard).
      const existingNames = new Set(variables.map(v => v.name));
      const toRegister = [...input, ...output].filter(e => !existingNames.has(e.key));
      if (toRegister.length > 0) {
        const seen = new Set<string>();
        const newVars: WorkflowVariable[] = toRegister.filter(e => (seen.has(e.key) ? false : (seen.add(e.key), true)))
          .map(e => ({ id: uid('var'), name: e.key, exampleValue: e.value }));
        onVariablesChange([...variables, ...newVars]);
      }
    }

    const node: WorkflowNode = {
      id: uid('node'),
      type,
      position,
      data: {
        label: type === 'test_case' && testCase ? testCase.title : type === 'decision' ? 'Nouvelle condition' : type === 'notification' ? 'Nouvelle notification' : 'Nouveau système externe',
        nodeType: type,
        ...(type === 'test_case' && testCase
          ? { testCaseId: testCase.id, testCaseSnapshot: { testId: testCase.testId, title: testCase.title, type: testCase.type, priority: testCase.priority, requirementId: testCase.requirementId, testData: testCase.testData } }
          : {}),
        inputVariables: autoInput,
        outputVariables: autoOutput,
      },
    };
    commit([...nodes, node], edges);
    // Le panneau "Ajouter une étape" reste ouvert (voir AddStepDrawer) : on ne le
    // ferme pas ici, pour permettre d'enchaîner plusieurs ajouts sans le rouvrir.
    setSelectedNodeId(node.id);
  };

  // ── Dépose d'une carte glissée depuis le panneau "Ajouter une étape" ────────
  const handleDropStep = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverCanvas(false);
    if (readOnly) return;
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    let payload: { type: WorkflowNodeType; testCaseId?: string };
    try { payload = JSON.parse(raw); } catch { return; }
    const pt = canvasPoint(e.clientX, e.clientY);
    const testCase = payload.type === 'test_case' ? testCaseOptions.find(t => t.id === payload.testCaseId) : undefined;
    addNode(payload.type, testCase, { x: Math.max(0, pt.x - NODE_WIDTH / 2), y: Math.max(0, pt.y - NODE_HEIGHT / 2) });
  };

  const deleteNode = (nodeId: string) => {
    // Supprime aussi les notifications/bannières rattachées à ce nœud — sans
    // ça, elles resteraient orphelines (attachedToNodeId pointant vers un
    // nœud qui n'existe plus) et invisibles (effectivePosition ne trouve
    // plus d'hôte).
    const idsToRemove = new Set([nodeId, ...nodes.filter(n => n.data.attachedToNodeId === nodeId).map(n => n.id)]);
    commit(
      nodes.filter(n => !idsToRemove.has(n.id)),
      edges.filter(ed => !idsToRemove.has(ed.source) && !idsToRemove.has(ed.target)),
    );
    if (selectedNodeId && idsToRemove.has(selectedNodeId)) setSelectedNodeId(null);
  };

  const requestDeleteNode = (nodeId: string) => setPendingDeleteNodeId(nodeId);

  const confirmDeleteNode = () => {
    if (pendingDeleteNodeId) deleteNode(pendingDeleteNodeId);
    setPendingDeleteNodeId(null);
  };

  const pendingDeleteNode = pendingDeleteNodeId ? nodes.find(n => n.id === pendingDeleteNodeId) : null;
  // Liaisons qui disparaîtront avec le nœud — affiché dans le message de
  // confirmation pour que le BA sache que ce n'est pas juste la case qui part.
  const pendingDeleteNodeEdgeCount = pendingDeleteNodeId
    ? edges.filter(ed => ed.source === pendingDeleteNodeId || ed.target === pendingDeleteNodeId).length
    : 0;
  // Notifications/bannières rattachées qui partiront avec elle (voir deleteNode).
  const pendingDeleteNodeAttachedCount = pendingDeleteNodeId
    ? nodes.filter(n => n.data.attachedToNodeId === pendingDeleteNodeId).length
    : 0;

  const deleteEdge = (edgeId: string) => {
    commit(nodes, edges.filter(ed => ed.id !== edgeId));
    if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
  };

  const updateNodeData = (nodeId: string, patch: Partial<WorkflowNode['data']>) => {
    const next = nodes.map(n => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n));
    commit(next, edges);
  };

  const updateEdgeData = (edgeId: string, patch: { variableName?: string; condition?: string }) => {
    const next = edges.map(ed => (ed.id === edgeId ? { ...ed, data: { ...ed.data, ...patch } } : ed));
    commit(nodes, next);
  };

  const selectedNode = nodes.find(n => n.id === selectedNodeId) || null;
  const selectedEdge = edges.find(ed => ed.id === selectedEdgeId) || null;

  const stepResultFor = (nodeId: string): WorkflowStepResult | undefined =>
    activeRun?.step_results?.find(r => r.nodeId === nodeId);

  return (
    <>
    <div className="flex flex-col xl:flex-row gap-4 items-start w-full min-w-0">
      {/* ─── Canvas ─── */}
      <div className="flex-1 min-w-0 w-full relative">
        <div className="mb-2 flex items-center justify-between gap-2 flex-wrap">
          {!readOnly ? (
            <button
              onClick={() => setShowAddMenu(x => !x)}
              className={`px-4 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm ${showAddMenu ? 'bg-black dark:bg-btndark text-white' : 'bg-primary text-white hover:bg-primaryho'}`}
            >
              {showAddMenu ? '✕ Fermer le panneau' : '➕ Ajouter une étape'}
            </button>
          ) : <div />}
          <div className="flex items-center gap-2">
            {!readOnly && (
              <span className="hidden md:inline text-[10px] text-waterloo">
                Glissez une étape pour la déplacer · tirez depuis le point à droite d’une étape pour la relier
              </span>
            )}
            <div className="flex items-center gap-0.5 border border-stroke dark:border-strokedark rounded-full p-0.5">
              <button
                onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))}
                className="w-6 h-6 rounded-full text-xs font-bold text-waterloo hover:text-black dark:hover:text-white hover:bg-zumthor dark:hover:bg-blacksection transition-all"
                title="Zoom arrière"
              >−</button>
              <span className="text-[9px] font-bold text-waterloo w-9 text-center">{Math.round(zoom * 100)}%</span>
              <button
                onClick={() => setZoom(z => Math.min(1.5, +(z + 0.1).toFixed(2)))}
                className="w-6 h-6 rounded-full text-xs font-bold text-waterloo hover:text-black dark:hover:text-white hover:bg-zumthor dark:hover:bg-blacksection transition-all"
                title="Zoom avant"
              >+</button>
              <button
                onClick={() => setZoom(1)}
                className="w-6 h-6 rounded-full text-[9px] font-bold text-waterloo hover:text-black dark:hover:text-white hover:bg-zumthor dark:hover:bg-blacksection transition-all"
                title="Réinitialiser le zoom"
              >⤾</button>
            </div>
          </div>
        </div>

        <div
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onMouseDown={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
          onDragOver={(e) => { if (!readOnly) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOverCanvas(true); } }}
          onDragLeave={() => setDragOverCanvas(false)}
          onDrop={handleDropStep}
          className={`relative w-full min-w-0 overflow-auto border rounded-2xl bg-[radial-gradient(circle,rgba(148,163,184,0.25)_1px,transparent_1px)] bg-[length:18px_18px] dark:bg-blacksection shadow-inner transition-colors ${dragOverCanvas ? 'border-primary border-2 bg-zumthor/40 dark:bg-blacksection' : 'border-stroke dark:border-strokedark'}`}
          style={{ height: '58vh', minHeight: 380, maxHeight: 620 }}
        >
          <div style={{ width: CANVAS_WIDTH * zoom, height: CANVAS_HEIGHT * zoom, position: 'relative' }}>
            <div style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, position: 'relative', transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
            <svg width={CANVAS_WIDTH} height={CANVAS_HEIGHT} className="absolute inset-0 pointer-events-none">
              {edges.map(ed => {
                const source = nodes.find(n => n.id === ed.source);
                const target = nodes.find(n => n.id === ed.target);
                if (!source || !target) return null;
                const { right } = nodePorts(source);
                const { left } = nodePorts(target);
                const isSelected = selectedEdgeId === ed.id;
                const label = ed.data?.variableName || ed.data?.condition;
                const midX = (right.x + left.x) / 2;
                const midY = (right.y + left.y) / 2;
                return (
                  <g key={ed.id}>
                    <path d={bezierPath(right.x, right.y, left.x, left.y)} fill="none" stroke={isSelected ? '#2563eb' : '#94a3b8'} strokeWidth={isSelected ? 2.5 : 1.5} />
                    <path
                      d={bezierPath(right.x, right.y, left.x, left.y)}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14}
                      style={{ pointerEvents: readOnly ? 'none' : 'stroke', cursor: 'pointer' }}
                      onMouseDown={(e) => { e.stopPropagation(); setSelectedEdgeId(ed.id); setSelectedNodeId(null); }}
                    />
                    {label && (
                      <g transform={`translate(${midX},${midY})`}>
                        <rect x={-((label.length * 5.2) / 2) - 6} y={-9} width={label.length * 5.2 + 12} height={18} rx={9} fill="#fff" stroke="#94a3b8" />
                        <text x={0} y={4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#2563eb">{label}</text>
                      </g>
                    )}
                  </g>
                );
              })}
              {connectPreview && (
                <path d={bezierPath(connectPreview.x1, connectPreview.y1, connectPreview.x2, connectPreview.y2)} fill="none" stroke="#2563eb" strokeWidth={2} strokeDasharray="6 4" />
              )}
              {/* Fil purement visuel entre une notification/bannière et sa case
                  hôte — pas une vraie WorkflowEdge (pas de source/target dans
                  `edges`, jamais persistée ni sélectionnable), juste le même
                  langage visuel qu'une liaison classique pour que le
                  rattachement se voie d'un coup d'œil sur le canevas. */}
              {nodes.map(node => {
                if (node.data.nodeType !== 'notification' || !node.data.attachedToNodeId) return null;
                if (dragRef.current?.nodeId === node.id) return null; // en cours d'aimantation : voir le badge dédié plus bas
                const host = nodes.find(n => n.id === node.data.attachedToNodeId);
                if (!host) return null;
                const notifPos = effectivePosition(node);
                const x = notifPos.x + NODE_WIDTH / 2;
                const hostTop = host.position.y;
                const hostBottom = host.position.y + NODE_HEIGHT;
                const y1 = node.data.attachedSide === 'below' ? notifPos.y : notifPos.y + NODE_HEIGHT;
                const y2 = node.data.attachedSide === 'below' ? hostBottom : hostTop;
                return (
                  <line
                    key={`attach-${node.id}`}
                    x1={x} y1={y1} x2={x} y2={y2}
                    stroke="#ca8a04" strokeWidth={1.5} strokeDasharray="4 3"
                  />
                );
              })}
            </svg>

            {nodes.map(node => {
              const meta = NODE_TYPE_META[node.data.nodeType] || NODE_TYPE_META.action;
              const result = stepResultFor(node.id);
              const statusMeta = activeRun ? STEP_STATUS_META[result?.status || 'idle'] : null;
              const isSelected = selectedNodeId === node.id;
              const isNotification = node.data.nodeType === 'notification';
              const pos = effectivePosition(node);
              // Le FR à afficher : on privilégie la valeur à jour du cas de test (au cas où
              // l'étape aurait été créée avant la correction du req_id), et on ne retombe
              // sur l'instantané enregistré (testCaseSnapshot) qu'en dernier recours.
              const liveReqId = testCaseOptions.find(t => t.id === node.data.testCaseId)?.requirementId;
              const alert = getStepAlert(node, testCaseOptions);
              return (
                <div
                  key={node.id}
                  onMouseDown={(e) => { startDragNode(e, node); }}
                  onMouseUp={(e) => {
                    // Ne bloque la remontée vers le canvas QUE si on est en train de
                    // tirer une connexion — sinon on doit laisser l'événement remonter
                    // pour que handleMouseUp() (sur le canvas) termine le glisser-déposer
                    // du nœud. Sans ça, relâcher la souris sur la carte elle-même (le cas
                    // le plus courant puisqu'elle suit le curseur) ne "lâchait" jamais le
                    // nœud, qui restait collé à la souris jusqu'à sortir du canvas.
                    if (connectRef.current) e.stopPropagation();
                    finishConnect(node.id);
                  }}
                  onClick={(e) => { e.stopPropagation(); setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
                  className="absolute rounded-xl border shadow-solid-3 bg-white dark:bg-black cursor-grab active:cursor-grabbing select-none transition-shadow"
                  style={{
                    left: pos.x, top: pos.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT,
                    borderColor: snapTarget?.hostId === node.id ? '#ca8a04' : alert ? alert.color : (isSelected ? meta.color : (statusMeta ? statusMeta.color : '#e2e8f0')),
                    borderWidth: snapTarget?.hostId === node.id || isSelected || alert ? 2 : statusMeta && statusMeta.icon !== '⚪' ? 2 : 1,
                    borderStyle: isNotification && !node.data.attachedToNodeId ? 'dashed' : 'solid',
                    boxShadow: snapTarget?.hostId === node.id ? '0 0 0 3px rgba(202,138,4,0.25)' : isSelected ? `0 0 0 3px ${meta.color}22` : undefined,
                  }}
                >
                  {snapTarget?.hostId === node.id && (
                    <span
                      className="absolute left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[8px] font-bold text-white whitespace-nowrap"
                      style={{ background: '#ca8a04', [snapTarget.side === 'above' ? 'top' : 'bottom']: -18 } as React.CSSProperties}
                    >
                      🔔 se rattachera ici {snapTarget.side === 'above' ? '(au-dessus)' : '(en dessous)'}
                    </span>
                  )}                  <div className="px-3 py-2 rounded-t-xl flex items-center justify-between gap-1" style={{ background: meta.bg }}>
                    <span className="text-[10px] font-bold flex items-center gap-1" style={{ color: meta.color }}>
                      {meta.icon} {isNotification && node.data.alertKind ? node.data.alertKind : meta.label}
                    </span>
                    <span className="flex items-center gap-1">
                      {isNotification && !node.data.attachedToNodeId && (
                        <span title="Pas encore rattachée à une étape — ouvrez-la pour en choisir une" className="text-xs leading-none">⚠️</span>
                      )}
                      {alert && <span title={alert.message} className="text-xs leading-none">{alert.icon}</span>}
                      {activeRun && statusMeta && <span title={statusMeta.label} className="text-xs">{statusMeta.icon}</span>}
                      {!readOnly && !activeRun && (
                        <button onClick={(e) => { e.stopPropagation(); requestDeleteNode(node.id); }} title="Supprimer cette étape" className="text-waterloo hover:text-red-600 text-[11px] leading-none">✕</button>
                      )}
                    </span>
                  </div>
                  <div className="px-3 py-2">
                    <p className="text-[11px] font-bold text-black dark:text-white line-clamp-2">{node.data.label}</p>
                    {node.data.testCaseSnapshot && (
                      <p className="text-[9px] text-waterloo mt-1 flex items-center gap-1">
                        {node.data.testCaseSnapshot.testId}
                        {(liveReqId || node.data.testCaseSnapshot.requirementId) && (
                          <span className="font-bold text-primary">· {liveReqId || node.data.testCaseSnapshot.requirementId}</span>
                        )}
                      </p>
                    )}
                    {alert && (
                      <p className="text-[8px] font-bold mt-1 line-clamp-2" style={{ color: alert.color }} title={alert.message}>
                        {alert.icon} {alert.level === 'missing' ? 'Cas de test supprimé' : alert.level === 'review' ? 'À réviser' : 'Modifié depuis l\'ajout'}
                      </p>
                    )}
                    {(node.data.inputVariables?.length || node.data.outputVariables?.length) ? (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {node.data.inputVariables?.map(v => (
                          <span key={`in-${v}`} className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-amber-600/10 text-amber-700 dark:text-amber-400">↓{v}</span>
                        ))}
                        {node.data.outputVariables?.map(v => (
                          <span key={`out-${v}`} className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-600/10 text-emerald-700 dark:text-emerald-400">↑{v}</span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {/* Ports — une notification/bannière n'est jamais reliée par une
                      arête (voir attachedToNodeId), donc pas de port du tout. */}
                  {!isNotification && (
                    <>
                      <div
                        onMouseDown={(e) => startConnect(e, node.id)}
                        className="absolute -right-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 bg-white dark:bg-black cursor-crosshair"
                        style={{ borderColor: meta.color, display: readOnly ? 'none' : 'block' }}
                        title="Tirer pour relier vers une autre étape"
                      />
                      <div
                        className="absolute -left-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 bg-white dark:bg-black"
                        style={{ borderColor: '#94a3b8' }}
                      />
                    </>
                  )}
                </div>
              );
            })}

            {nodes.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                <div className="text-4xl opacity-20 pointer-events-none">🧩</div>
                <p className="text-waterloo text-xs pointer-events-none">Ajoutez une première étape pour commencer votre workflow</p>
                {!readOnly && (
                  <button
                    onClick={() => setShowAddMenu(true)}
                    className="mt-1 px-4 py-2 rounded-full text-xs font-bold bg-primary text-white hover:bg-primaryho transition-all"
                  >
                    ➕ Ajouter une étape
                  </button>
                )}
              </div>
            )}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Panneau latéral (inspecteur) ─── */}
      <div className="w-full xl:w-[300px] xl:flex-shrink-0 xl:max-h-[58vh] xl:overflow-y-auto">
        {selectedNode && !activeRun && (
          <NodeInspector
            key={selectedNode.id}
            node={selectedNode}
            allNodes={nodes}
            variables={variables}
            testCaseOptions={testCaseOptions}
            readOnly={readOnly}
            onChange={(patch) => updateNodeData(selectedNode.id, patch)}
            onVariablesChange={onVariablesChange}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
        {selectedNode && activeRun && (
          <RunStepPanel
            key={selectedNode.id}
            node={selectedNode}
            result={stepResultFor(selectedNode.id)}
            runVariableValues={activeRun.variable_values || {}}
            variables={variables}
            onChange={(result) => onStepResultChange?.(selectedNode.id, result)}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
        {selectedEdge && !activeRun && (
          <EdgeInspector
            edge={selectedEdge}
            variables={variables}
            readOnly={readOnly}
            onChange={(patch) => updateEdgeData(selectedEdge.id, patch)}
            onDelete={() => deleteEdge(selectedEdge.id)}
            onClose={() => setSelectedEdgeId(null)}
          />
        )}
        {!selectedNode && !selectedEdge && (
          <VariablesPanel
            variables={variables}
            onChange={onVariablesChange}
            readOnly={readOnly}
            onExtractFromTestCases={onExtractFromTestCases}
            onGenerateData={onGenerateData}
            genLoading={genLoading}
          />
        )}
      </div>
    </div>

    {/* Panneau latéral fixe pour ajouter une étape par glisser-déposer (ou clic) */}
    {showAddMenu && !readOnly && (
      <AddStepDrawer
        testCaseOptions={testCaseOptions}
        usedTestCaseIds={new Set(nodes.filter(n => n.data.testCaseId).map(n => n.data.testCaseId as string))}
        // Suggestion IA (voir suggestNextTestCases / effet ci-dessus) : quels
        // cas de test pourraient réalistement suivre le dernier ajouté au
        // workflow, avec une raison par suggestion — pas une simple
        // heuristique "même module", le modèle regarde le contenu réel
        // (préconditions/étapes/résultat attendu) pour juger d'un lien de
        // séquence plausible.
        aiSuggestions={aiNextSuggest.results}
        aiLoading={aiNextSuggest.loading}
        aiError={aiNextSuggest.error}
        aiUnavailable={!projectId}
        onPick={addNode}
        onClose={() => setShowAddMenu(false)}
      />
    )}

    <ConfirmDeleteModal
      open={!!pendingDeleteNodeId}
      title="Supprimer cette étape ?"
      message={
        pendingDeleteNode
          ? `« ${pendingDeleteNode.data.label} » sera retirée du canevas${pendingDeleteNodeEdgeCount > 0 ? `, ainsi que ${pendingDeleteNodeEdgeCount} liaison(s) qui s'y rattache(nt)` : ''}${pendingDeleteNodeAttachedCount > 0 ? `, ainsi que ${pendingDeleteNodeAttachedCount} notification(s)/bannière(s) rattachée(s)` : ''}. Cette action n'est pas définitive : l'état actuel reste consultable dans l'historique des versions.`
          : undefined
      }
      confirmLabel="Supprimer"
      cancelLabel="Annuler"
      onConfirm={confirmDeleteNode}
      onCancel={() => setPendingDeleteNodeId(null)}
    />
    </>
  );
}

// ─── Menu d'ajout d'étape ───────────────────────────────────────────────────

function AddStepDrawer({ testCaseOptions, usedTestCaseIds, aiSuggestions, aiLoading, aiError, aiUnavailable, onPick, onClose }: {
  testCaseOptions: TestCaseOption[];
  usedTestCaseIds: Set<string>;
  aiSuggestions: { id: string; reason?: string }[];
  aiLoading: boolean;
  aiError: string | null;
  aiUnavailable: boolean;
  onPick: (type: WorkflowNodeType, testCase?: TestCaseOption) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<WorkflowNodeType>('test_case');
  const [search, setSearch] = useState('');
  // Optionnel (activé par défaut) : signale dans la liste les cas de test déjà
  // présents ailleurs dans ce workflow, pour éviter d'ajouter deux fois la même
  // étape par inadvertance — l'utilisateur peut le désactiver s'il veut au
  // contraire réutiliser volontairement un même cas de test à plusieurs endroits
  // du graphe (ex: revérifié après une étape de type "décision").
  const [markUsed, setMarkUsed] = useState(true);
  const aiSuggestionMap = useMemo(() => new Map(aiSuggestions.map(s => [s.id, s.reason])), [aiSuggestions]);
  // Cas de test suggérés par l'IA, résolus en objets complets et dans l'ordre
  // de pertinence renvoyé par le modèle — utilisé pour la section "Suggestions
  // IA" en haut du panneau, séparée de la liste classique par module/exigence
  // (qui les garde aussi en indigo, mais peut nécessiter de scroller/chercher).
  const suggestedTcs = useMemo(() => {
    return aiSuggestions
      .map(s => {
        const tc = testCaseOptions.find(t => t.id === s.id);
        return tc ? { tc, reason: s.reason } : null;
      })
      .filter((x): x is { tc: TestCaseOption; reason: string | undefined } => !!x);
  }, [aiSuggestions, testCaseOptions]);
  const filtered = testCaseOptions.filter(tc => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      tc.title.toLowerCase().includes(q) ||
      tc.testId.toLowerCase().includes(q) ||
      tc.moduleName?.toLowerCase().includes(q) ||
      tc.requirementId?.toLowerCase().includes(q)
    );
  });
  // Regroupe les cas de test par module, puis par exigence fonctionnelle (FR)
  // à l'intérieur de chaque module — triés par ordre alphanumérique. Les cas
  // sans module / sans exigence associée sont classés en dernier.
  const grouped = useMemo(() => {
    const modules = new Map<string, Map<string, TestCaseOption[]>>();
    for (const tc of filtered) {
      const modKey = tc.moduleName?.trim() || 'Sans module';
      const reqKey = tc.requirementId?.trim() || 'Sans exigence';
      if (!modules.has(modKey)) modules.set(modKey, new Map());
      const reqMap = modules.get(modKey)!;
      if (!reqMap.has(reqKey)) reqMap.set(reqKey, []);
      reqMap.get(reqKey)!.push(tc);
    }
    const sortKey = (a: string, b: string, noneLabel: string) => {
      if (a === noneLabel) return 1;
      if (b === noneLabel) return -1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    };
    return Array.from(modules.entries())
      .sort(([a], [b]) => sortKey(a, b, 'Sans module'))
      .map(([modName, reqMap]) => ({
        modName,
        requirements: Array.from(reqMap.entries()).sort(([a], [b]) => sortKey(a, b, 'Sans exigence')),
      }));
  }, [filtered]);

  const startDrag = (e: React.DragEvent, type: WorkflowNodeType, testCaseId?: string) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ type, testCaseId }));
  };

  return (
    <div className="fixed inset-y-0 left-0 z-[999] w-full sm:w-[380px] bg-white dark:bg-black border-r border-stroke dark:border-strokedark shadow-solid-8 flex flex-col">
      <div className="p-3 border-b border-stroke dark:border-strokedark space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold text-black dark:text-white">➕ Ajouter une étape</p>
          <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-xs">✕ Fermer</button>
        </div>
        <p className="text-[9px] text-waterloo leading-relaxed">
          🖱️ Glissez une carte ci-dessous jusqu'à l'endroit voulu sur le canevas, ou cliquez dessus pour l'ajouter directement. Ce panneau reste ouvert : vous pouvez enchaîner plusieurs étapes.
        </p>
        <div className="flex gap-1">
          {(['test_case', 'action', 'decision', 'notification'] as WorkflowNodeType[]).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition-all ${tab === t ? 'border-primary text-primary bg-zumthor dark:bg-blacksection' : 'border-stroke dark:border-strokedark text-waterloo'}`}>
              {NODE_TYPE_META[t].icon} {NODE_TYPE_META[t].label}
            </button>
          ))}
        </div>
        {tab === 'test_case' && usedTestCaseIds.size > 0 && (
          <label className="flex items-center gap-1.5 text-[9px] text-waterloo font-bold cursor-pointer select-none">
            <input type="checkbox" checked={markUsed} onChange={(e) => setMarkUsed(e.target.checked)} className="accent-primary" />
            Marquer les cas de test déjà ajoutés à ce workflow
          </label>
        )}
      </div>
      {/* Suggestion IA "cas de test suivant probable" — voir suggestNextTestCases
          côté backend (analyse le contenu réel du dernier TC ajouté : préconditions,
          étapes, résultat attendu, comparés à tous les autres TC du projet). */}
      {tab === 'test_case' && aiLoading && (
        <p className="px-4 pt-1.5 text-[9px] text-indigo-600 dark:text-indigo-400 font-bold flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
          Analyse IA en cours pour repérer les suites logiques probables…
        </p>
      )}
      {tab === 'test_case' && !aiLoading && aiError && (
        <p className="px-4 pt-1.5 text-[9px] text-red-600 dark:text-red-400 font-bold">
          ⚠ Suggestion IA indisponible ({aiError}) — la liste reste utilisable normalement.
        </p>
      )}
      {tab === 'test_case' && !aiLoading && !aiError && aiSuggestions.length > 0 && (
        <p className="px-4 pt-1.5 text-[9px] text-indigo-600 dark:text-indigo-400 font-bold flex items-center gap-1">
          💡 En indigo : cas de test que l'IA identifie comme une suite logique probable, en tenant compte de tout le scénario déjà construit dans ce workflow (survolez une carte pour le détail).
        </p>
      )}
      {tab === 'test_case' && !aiLoading && !aiError && aiUnavailable === false && aiSuggestions.length === 0 && usedTestCaseIds.size > 0 && (
        <p className="px-4 pt-1.5 text-[9px] text-waterloo">
          L'IA n'a trouvé aucune suite logique évidente parmi les cas de test disponibles pour ce scénario — la liste reste utilisable normalement (recherche, ajout manuel).
        </p>
      )}
      {tab === 'test_case' && !aiLoading && !aiError && aiUnavailable === false && aiSuggestions.length === 0 && usedTestCaseIds.size === 0 && (
        <p className="px-4 pt-1.5 text-[9px] text-waterloo">
          Ajoutez un premier cas de test pour que l'IA suggère des suites logiques.
        </p>
      )}
      {tab === 'test_case' && aiUnavailable && (
        <p className="px-4 pt-1.5 text-[9px] text-waterloo">
          Suggestion IA indisponible pour ce workflow (projet non identifié).
        </p>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'test_case' ? (
          <>
            {/* Section dédiée "Suggestions IA" — toujours en haut, indépendante de la
                recherche/du groupement par module ci-dessous, pour que l'utilisateur
                les voie immédiatement sans avoir à les chercher dans la liste complète.
                Les mêmes cartes restent aussi visibles (en indigo) à leur place normale
                plus bas, pour qui préfère naviguer par module/exigence. */}
            {suggestedTcs.length > 0 && (
              <div className="mb-4 p-2.5 rounded-lg border border-indigo-500/30 bg-indigo-500/5">
                <p className="text-[9px] font-bold text-indigo-600 dark:text-indigo-400 mb-1.5 flex items-center gap-1">
                  ✨ Suggestions IA ({suggestedTcs.length}) — suites logiques probables
                </p>
                <div className="space-y-1.5">
                  {suggestedTcs.map(({ tc, reason }) => (
                    <div
                      key={tc.id}
                      draggable
                      onDragStart={(e) => startDrag(e, 'test_case', tc.id)}
                      onClick={() => onPick('test_case', tc)}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg border border-indigo-500/50 bg-indigo-500/10 hover:border-indigo-500/70 transition-all cursor-grab active:cursor-grabbing"
                      title={reason || "Suite logique probable d'après l'IA"}
                    >
                      <p className="text-[10px] font-bold text-black dark:text-white break-words">🧪 {tc.title}</p>
                      <p className="text-[9px] text-waterloo break-words">{tc.testId} · {tc.moduleName}</p>
                      {reason && <p className="text-[8px] text-indigo-600/90 dark:text-indigo-400/90 italic mt-0.5 break-words">↳ {reason}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="text-[8px] text-waterloo mb-1.5">Seuls les cas de test déjà <strong>validés</strong> peuvent être liés à une étape. Recherche par titre, ID, module ou FR.</p>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher (titre, ID, module, FR...)"
              className="w-full px-3 py-1.5 rounded-full text-[11px] border border-stroke dark:border-strokedark bg-transparent mb-2 outline-none focus:border-primary/50"
            />
            <div className="space-y-4">
              {filtered.length === 0 && <p className="text-[10px] text-waterloo text-center py-4">Aucun cas de test validé trouvé</p>}
              {grouped.map(({ modName, requirements }) => (
                <div key={modName}>
                  <p className="text-[10px] font-bold text-black dark:text-white mb-1.5 px-0.5">📁 {modName}</p>
                  <div className="space-y-2.5 pl-2 border-l-2 border-stroke dark:border-strokedark">
                    {requirements.map(([reqId, items]) => (
                      <div key={reqId}>
                        <p className="text-[9px] font-bold text-primary uppercase tracking-wide mb-1 px-0.5">{reqId}</p>
                        <div className="space-y-1.5">
                          {items.map(tc => {
                            const isUsed = markUsed && usedTestCaseIds.has(tc.id);
                            const aiReason = aiSuggestionMap.get(tc.id);
                            const isSuggested = !isUsed && aiSuggestionMap.has(tc.id);
                            const cardClass = isUsed
                              ? 'border-emerald-600/40 bg-emerald-600/5 hover:border-emerald-600/60'
                              : isSuggested
                              ? 'border-indigo-500/50 bg-indigo-500/8 hover:border-indigo-500/70'
                              : 'border-stroke dark:border-strokedark hover:border-primary/40 hover:bg-zumthor dark:hover:bg-blacksection';
                            const title = isUsed
                              ? "Ce cas de test est déjà utilisé dans une étape de ce workflow — glissez/cliquez quand même pour l'ajouter à nouveau"
                              : isSuggested
                              ? (aiReason || "Suite logique probable d'après l'IA")
                              : "Glissez cette carte sur le canevas, ou cliquez pour l'ajouter";
                            return (
                            <div
                              key={tc.id}
                              draggable
                              onDragStart={(e) => startDrag(e, 'test_case', tc.id)}
                              onClick={() => onPick('test_case', tc)}
                              className={`w-full text-left px-2.5 py-1.5 rounded-lg border transition-all cursor-grab active:cursor-grabbing ${cardClass}`}
                              title={title}
                            >
                              <p className="text-[10px] font-bold text-black dark:text-white break-words flex items-center gap-1.5">
                                🧪 {tc.title}
                                {isUsed && (
                                  <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 flex-shrink-0">✓ déjà ajouté</span>
                                )}
                                {isSuggested && (
                                  <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex-shrink-0">✨ suite probable</span>
                                )}
                              </p>
                              {isSuggested && aiReason && (
                                <p className="text-[8px] text-indigo-600/90 dark:text-indigo-400/90 italic mt-0.5 break-words">↳ {aiReason}</p>
                              )}
                              <p className="text-[9px] text-waterloo break-words">{tc.testId}</p>
                            </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div
            draggable
            onDragStart={(e) => startDrag(e, tab)}
            onClick={() => onPick(tab)}
            className="w-full px-3 py-3 rounded-lg border border-dashed border-stroke dark:border-strokedark text-[11px] font-bold text-waterloo hover:border-primary/40 hover:text-primary transition-all cursor-grab active:cursor-grabbing"
            title="Glissez cette carte sur le canevas, ou cliquez pour l'ajouter"
          >
            {NODE_TYPE_META[tab].icon} Étape « {NODE_TYPE_META[tab].label} »
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inspecteur de nœud (mode édition) ──────────────────────────────────────

function TagInput({ label, values, onChange, placeholder, colorClass, readOnly }: {
  label: string; values: string[]; onChange: (v: string[]) => void; placeholder: string; colorClass: string; readOnly?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div>
      <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">{label}</label>
      <div className="flex flex-wrap gap-1 mt-1 mb-1">
        {values.map(v => (
          <span key={v} className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-1 ${colorClass}`}>
            {v}
            {!readOnly && <button onClick={() => onChange(values.filter(x => x !== v))} className="opacity-60 hover:opacity-100">✕</button>}
          </span>
        ))}
      </div>
      {!readOnly && (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          onBlur={add}
          placeholder={placeholder}
          className="w-full px-2 py-1 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
        />
      )}
    </div>
  );
}

function NodeInspector({ node, allNodes, variables, testCaseOptions, readOnly, onChange, onVariablesChange, onClose }: {
  node: WorkflowNode;
  allNodes: WorkflowNode[];
  variables: WorkflowVariable[];
  testCaseOptions: TestCaseOption[];
  readOnly?: boolean;
  onChange: (patch: Partial<WorkflowNode['data']>) => void;
  onVariablesChange: (variables: WorkflowVariable[]) => void;
  onClose: () => void;
}) {
  const meta = NODE_TYPE_META[node.data.nodeType];
  const liveTc = testCaseOptions.find(tc => tc.id === node.data.testCaseId);
  const stepAlert = getStepAlert(node, testCaseOptions);
  const testData = node.data.testCaseSnapshot?.testData?.length ? node.data.testCaseSnapshot.testData : liveTc?.testData;
  const suggestions = testData?.length ? parseTestDataEntries(testData) : null;

  // Enregistre les entrées/sorties détectées comme variables du workflow si elles
  // n'existent pas encore (avec leur vraie valeur, déjà écrite dans le cas de test —
  // plus fiable qu'une valeur devinée par le LLM plus tard).
  const registerDetectedVariables = (entries: ParsedTestDataEntry[]) => {
    const existingNames = new Set(variables.map(v => v.name));
    const toRegister = entries.filter(e => !existingNames.has(e.key));
    if (toRegister.length === 0) return;
    const seen = new Set<string>();
    const newVars: WorkflowVariable[] = toRegister
      .filter(e => (seen.has(e.key) ? false : (seen.add(e.key), true)))
      .map(e => ({ id: uid('var'), name: e.key, exampleValue: e.value }));
    onVariablesChange([...variables, ...newVars]);
  };

  // Pré-remplit directement « Données consommées (entrée) » et « Données produites
  // (sortie) » à partir du cas de test lié, la première fois qu'on ouvre une étape
  // dont ces deux champs sont encore vides (étape tout juste liée, ou créée avant
  // que cette détection existe). L'utilisateur reste ensuite libre de retirer ou
  // ajouter des données via les champs eux-mêmes (bouton ✕ sur chaque tag).
  useEffect(() => {
    if (readOnly || !suggestions) return;
    if ((node.data.inputVariables || []).length > 0 || (node.data.outputVariables || []).length > 0) return;
    if (suggestions.input.length === 0 && suggestions.output.length === 0) return;
    onChange({ inputVariables: suggestions.input.map(e => e.key), outputVariables: suggestions.output.map(e => e.key) });
    registerDetectedVariables([...suggestions.input, ...suggestions.output]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, testData]);

  return (
    <div className="bg-white dark:bg-black border border-stroke dark:border-strokedark rounded-2xl p-4 space-y-3 sticky top-0">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold flex items-center gap-1" style={{ color: meta.color }}>{meta.icon} {meta.label}</span>
        <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-xs">✕</button>
      </div>

      <div>
        <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Nom de l’étape</label>
        <input
          value={node.data.label}
          disabled={readOnly}
          onChange={(e) => onChange({ label: e.target.value })}
          className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
        />
      </div>

      {node.data.nodeType === 'test_case' && (
        <div>
          <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Cas de test lié</label>
          <div className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-zumthor/40 dark:bg-blacksection">
            {liveTc || node.data.testCaseSnapshot ? (
              <>
                <p className="font-bold text-black dark:text-white break-words">🧪 {liveTc?.title || node.data.testCaseSnapshot?.title}</p>
                <p className="text-waterloo mt-0.5">
                  {liveTc?.testId || node.data.testCaseSnapshot?.testId}
                  {(liveTc?.moduleName || liveTc?.requirementId || node.data.testCaseSnapshot?.requirementId) && ' · '}
                  {liveTc?.moduleName}
                  {liveTc?.moduleName && (liveTc?.requirementId || node.data.testCaseSnapshot?.requirementId) && ' · '}
                  {liveTc?.requirementId || node.data.testCaseSnapshot?.requirementId}
                </p>
              </>
            ) : (
              <p className="text-waterloo italic">Aucun cas de test lié</p>
            )}
          </div>
          <p className="mt-1 text-[8px] text-waterloo italic">Pour lier un autre cas de test, supprimez cette étape et glissez-en une nouvelle depuis le panneau "Ajouter une étape".</p>
        </div>
      )}

      {node.data.nodeType === 'notification' && (
        <div>
          <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Type</label>
          <input
            value={node.data.alertKind || ''}
            disabled={readOnly}
            onChange={(e) => onChange({ alertKind: e.target.value })}
            placeholder="Notification, Bannière, Toast, Alerte..."
            className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
          />
          <p className="mt-1 text-[8px] text-waterloo italic">Nommez-la comme vous voulez — affiché à la place de « {meta.label} » sur la case.</p>
        </div>
      )}

      {node.data.nodeType === 'notification' && (
        <div>
          <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Rattachement</label>
          {node.data.attachedToNodeId ? (
            <>
              <div className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-zumthor/40 dark:bg-blacksection">
                <p className="text-black dark:text-white font-bold break-words">
                  {allNodes.find(n => n.id === node.data.attachedToNodeId)
                    ? `${NODE_TYPE_META[allNodes.find(n => n.id === node.data.attachedToNodeId)!.data.nodeType]?.icon} ${allNodes.find(n => n.id === node.data.attachedToNodeId)!.data.label}`
                    : '(étape introuvable)'}
                </p>
              </div>
              <div className="flex gap-1.5 mt-1.5">
                {(['above', 'below'] as const).map(side => (
                  <button
                    key={side}
                    type="button"
                    disabled={readOnly}
                    onClick={() => onChange({ attachedSide: side })}
                    className={`flex-1 px-2 py-1 rounded-lg text-[9px] font-bold border transition-all ${(node.data.attachedSide || 'above') === side ? 'border-primary text-primary bg-zumthor dark:bg-blacksection' : 'border-stroke dark:border-strokedark text-waterloo'}`}
                  >
                    {side === 'above' ? '⬆️ Au-dessus' : '⬇️ En dessous'}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[8px] text-waterloo italic">Glissez-la ailleurs sur le canevas pour la rattacher à une autre étape, ou loin de toute étape pour la détacher.</p>
            </>
          ) : (
            <p className="text-[9px] text-amber-600 font-bold">⚠️ Pas encore rattachée — glissez la case sur le canevas jusqu'à juste au-dessus ou en dessous d'une étape, elle s'y aimante automatiquement.</p>
          )}
        </div>
      )}

      {node.data.nodeType === 'notification' && (
        <div>
          <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Cas de test lié (optionnel)</label>
          <select
            disabled={readOnly}
            value={node.data.testCaseId || ''}
            onChange={(e) => {
              const tc = testCaseOptions.find(t => t.id === e.target.value);
              onChange(
                tc
                  ? { testCaseId: tc.id, testCaseSnapshot: { testId: tc.testId, title: tc.title, type: tc.type, priority: tc.priority, requirementId: tc.requirementId, testData: tc.testData } }
                  : { testCaseId: undefined, testCaseSnapshot: undefined }
              );
            }}
            className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
          >
            <option value="">— Aucun —</option>
            {testCaseOptions.map(tc => (
              <option key={tc.id} value={tc.id}>{tc.testId} · {tc.title}</option>
            ))}
          </select>
          <p className="mt-1 text-[8px] text-waterloo italic">Le cas de test qui déclenche cette notification/bannière, si pertinent.</p>
        </div>
      )}

      {stepAlert && (
        <div
          style={{
            fontSize: 10.5, fontWeight: 700, color: stepAlert.color,
            background: `${stepAlert.color}0f`, border: `1px solid ${stepAlert.color}59`,
            borderRadius: 6, padding: '6px 9px', display: 'flex', alignItems: 'flex-start', gap: 6,
          }}
        >
          <span>{stepAlert.icon}</span>
          <span>{stepAlert.message}</span>
        </div>
      )}

      {node.data.nodeType !== 'test_case' && (
        <div>
          <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Description</label>
          <textarea
            disabled={readOnly}
            value={node.data.description || ''}
            onChange={(e) => onChange({ description: e.target.value })}
            rows={3}
            className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50 resize-none"
            placeholder={
              node.data.nodeType === 'decision'
                ? 'Condition évaluée à cette étape...'
                : node.data.nodeType === 'notification'
                ? 'Contenu de la notification/bannière (texte affiché, canal : email, toast, SMS...)...'
                : 'Ce que fait ce système externe (API appelée, service tiers...)...'
            }
          />
        </div>
      )}

      <TagInput
        label="Données consommées (entrée)"
        values={node.data.inputVariables || []}
        onChange={(v) => onChange({ inputVariables: v })}
        placeholder="nom de variable + Entrée"
        colorClass="bg-amber-600/10 text-amber-700 dark:text-amber-400"
        readOnly={readOnly}
      />
      <TagInput
        label="Données produites (sortie)"
        values={node.data.outputVariables || []}
        onChange={(v) => onChange({ outputVariables: v })}
        placeholder="nom de variable + Entrée"
        colorClass="bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
        readOnly={readOnly}
      />
    </div>
  );
}

// ─── Inspecteur d'arête ──────────────────────────────────────────────────────

function EdgeInspector({ edge, variables, readOnly, onChange, onDelete, onClose }: {
  edge: WorkflowEdge;
  variables: WorkflowVariable[];
  readOnly?: boolean;
  onChange: (patch: { variableName?: string; condition?: string }) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="bg-white dark:bg-black border border-stroke dark:border-strokedark rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-black dark:text-white">🔗 Connexion</span>
        <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-xs">✕</button>
      </div>
      <div>
        <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Variable associée à cette connexion</label>
        <select
          disabled={readOnly}
          value={edge.data?.variableName || ''}
          onChange={(e) => onChange({ variableName: e.target.value || undefined })}
          className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
        >
          <option value="">— Aucune (enchaînement simple) —</option>
          {variables.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
        </select>
        <p className="mt-1 text-[8px] text-waterloo italic">Note informative uniquement : elle documente quelle donnée circule sur cette branche, mais n'influence pas le déroulement réel de l'exécution.</p>
      </div>
      <div>
        <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Libellé de branche (décision)</label>
        {!readOnly && (
          <div className="flex gap-1 mt-1 mb-1">
            {['Oui', 'Non'].map(preset => (
              <button
                key={preset}
                onClick={() => onChange({ condition: preset })}
                className={`px-2.5 py-1 rounded-full text-[9px] font-bold border transition-all ${edge.data?.condition === preset ? 'border-primary text-primary bg-zumthor dark:bg-blacksection' : 'border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white'}`}
              >
                {preset}
              </button>
            ))}
          </div>
        )}
        <input
          disabled={readOnly}
          value={edge.data?.condition || ''}
          onChange={(e) => onChange({ condition: e.target.value || undefined })}
          placeholder="ex: Si valide"
          className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
        />
      </div>
      {!readOnly && (
        <button onClick={onDelete} className="w-full px-3 py-1.5 rounded-lg text-[10px] font-bold border border-red-600/30 text-red-600 hover:bg-red-600/5 transition-all">
          🗑️ Supprimer la connexion
        </button>
      )}
    </div>
  );
}

// ─── Panneau des variables globales ─────────────────────────────────────────

function VariablesPanel({ variables, onChange, readOnly, onExtractFromTestCases, onGenerateData, genLoading }: {
  variables: WorkflowVariable[];
  onChange: (v: WorkflowVariable[]) => void;
  readOnly?: boolean;
  onExtractFromTestCases?: () => void;
  onGenerateData?: () => void;
  genLoading?: boolean;
}) {
  const [name, setName] = useState('');
  const add = () => {
    const v = name.trim();
    if (!v || variables.some(x => x.name === v)) return;
    onChange([...variables, { id: uid('var'), name: v }]);
    setName('');
  };
  return (
    <div className="bg-white dark:bg-black border border-stroke dark:border-strokedark rounded-2xl p-4 space-y-3">
      <p className="text-[10px] font-bold text-black dark:text-white">🔗 Variables du workflow</p>
      <p className="text-[9px] text-waterloo leading-relaxed">
        Une variable représente une donnée qui circule d'une étape à l'autre (ex: <code>orderId</code>, <code>token</code>). Déclarez-la ici, puis utilisez-la dans une étape ou une connexion.
      </p>

      {/* ── Préparation automatique : remplit la liste ci-dessous ── */}
      {!readOnly && (onExtractFromTestCases || onGenerateData) && (
        <div className="space-y-1.5 pb-1 border-b border-stroke dark:border-strokedark">
          {onExtractFromTestCases && (
            <button
              onClick={onExtractFromTestCases}
              className="w-full px-2.5 py-1.5 rounded-lg text-[10px] font-bold border border-stroke dark:border-strokedark text-waterloo hover:text-black dark:hover:text-white hover:border-primary/40 transition-all flex items-center justify-center gap-1.5"
              title="Repère les étapes « Cas de test » du canevas et ajoute ici, automatiquement, les variables trouvées dans leurs données de test"
            >
              🔄 Importer les variables des cas de test
            </button>
          )}
          {onGenerateData && (
            <button
              onClick={onGenerateData}
              disabled={genLoading}
              className="w-full px-2.5 py-1.5 rounded-lg text-[10px] font-bold border border-primary/40 text-primary hover:bg-zumthor dark:hover:bg-blacksection transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
              title="Demande à l'IA de proposer une valeur d'exemple réaliste pour chaque variable déclarée ci-dessous"
            >
              {genLoading ? <><Spinner /> Génération...</> : <>🪄 Suggérer des valeurs (IA)</>}
            </button>
          )}
        </div>
      )}

      {variables.length === 0 ? (
        <p className="text-[9px] text-waterloo italic">Aucune variable pour l’instant</p>
      ) : (
        <ul className="space-y-1.5">
          {variables.map(v => (
            <li key={v.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-zumthor dark:bg-blacksection">
              <span className="text-[10px] font-bold text-black dark:text-white truncate">
                {v.name}
                {v.exampleValue && <span className="ml-1.5 font-normal text-waterloo">· {v.exampleValue}</span>}
              </span>
              {!readOnly && (
                <button onClick={() => onChange(variables.filter(x => x.id !== v.id))} className="text-waterloo hover:text-red-600 text-[10px] shrink-0">✕</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="nouvelle variable..."
            className="flex-1 px-2.5 py-1.5 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
          />
          <button onClick={add} className="px-3 py-1.5 rounded-lg text-[10px] font-bold bg-primary text-white hover:bg-primaryho transition-all">+</button>
        </div>
      )}
    </div>
  );
}

// ─── Panneau d'exécution d'une étape (mode run) ─────────────────────────────

function RunStepPanel({ node, result, runVariableValues, variables, onChange, onClose }: {
  node: WorkflowNode;
  result?: WorkflowStepResult;
  runVariableValues: Record<string, string>;
  variables: WorkflowVariable[];
  onChange: (result: { status: WorkflowStepStatus; note?: string; variableValues?: Record<string, string> }) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(result?.note || '');
  const [values, setValues] = useState<Record<string, string>>(result?.variableValues || {});

  useEffect(() => {
    setNote(result?.note || '');
    // Pré-remplit avec la valeur déjà saisie pour ce run, sinon avec la donnée
    // de test générée par le LLM (WorkflowVariable.exampleValue) si disponible.
    const prefilled: Record<string, string> = {};
    for (const v of node.data.outputVariables || []) {
      prefilled[v] = result?.variableValues?.[v] ?? variables.find(x => x.name === v)?.exampleValue ?? '';
    }
    setValues(prefilled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const outputVars = node.data.outputVariables || [];
  const inputVars = node.data.inputVariables || [];
  const status = result?.status || 'idle';

  const setStatus = (s: WorkflowStepStatus) => onChange({ status: s, note, variableValues: values });

  return (
    <div className="bg-white dark:bg-black border border-stroke dark:border-strokedark rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-black dark:text-white truncate">{node.data.label}</span>
        <button onClick={onClose} className="text-waterloo hover:text-black dark:hover:text-white text-xs">✕</button>
      </div>

      {inputVars.length > 0 && (
        <div>
          <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Données reçues</label>
          <div className="mt-1 space-y-1">
            {inputVars.map(v => {
              const runVal = runVariableValues[v];
              const hint = variables.find(x => x.name === v)?.exampleValue;
              return (
                <div key={v} className="flex items-center justify-between px-2 py-1 rounded-lg bg-zumthor dark:bg-blacksection text-[10px]">
                  <span className="font-bold">{v}</span>
                  {runVal ? (
                    <span className="text-waterloo">{runVal}</span>
                  ) : hint ? (
                    <span className="text-waterloo italic">{hint} (suggéré)</span>
                  ) : (
                    <span className="text-waterloo">— pas encore renseignée —</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        {(['passed', 'failed', 'skipped', 'blocked'] as WorkflowStepStatus[]).map(s => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-2 py-1.5 rounded-lg text-[10px] font-bold border transition-all flex items-center justify-center gap-1 ${status === s ? '' : 'border-stroke dark:border-strokedark text-waterloo hover:border-primary/30'}`}
            style={status === s ? { borderColor: STEP_STATUS_META[s].color, color: STEP_STATUS_META[s].color, background: `${STEP_STATUS_META[s].color}15` } : undefined}
          >
            {STEP_STATUS_META[s].icon} {STEP_STATUS_META[s].label}
          </button>
        ))}
      </div>

      {outputVars.length > 0 && (
        <div>
          <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Données produites</label>
          <div className="mt-1 space-y-1.5">
            {outputVars.map(v => (
              <input
                key={v}
                value={values[v] || ''}
                onChange={(e) => setValues(prev => ({ ...prev, [v]: e.target.value }))}
                onBlur={() => onChange({ status, note, variableValues: values })}
                placeholder={`Valeur pour ${v}`}
                className="w-full px-2.5 py-1.5 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50"
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="text-[9px] font-bold text-waterloo uppercase tracking-wide">Note</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => onChange({ status, note, variableValues: values })}
          rows={2}
          placeholder="Observation, bug rencontré..."
          className="w-full mt-1 px-2.5 py-1.5 rounded-lg text-[10px] border border-stroke dark:border-strokedark bg-transparent outline-none focus:border-primary/50 resize-none"
        />
      </div>
    </div>
  );
}