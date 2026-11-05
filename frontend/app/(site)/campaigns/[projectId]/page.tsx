'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { getWsTicket } from '@/lib/notifications-api';
import {
  IconFlag, IconArrowLeft, IconAlert, IconClock, IconCheckCircle,
  IconXCircle, IconInbox, IconExternalOpen, IconRefresh,
  IconDownload, IconHistory, IconChevronDown, IconChevronRight,
} from '@/app/components/CampaignIcons';

const API_BASE = '/api/backend';
const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || 'http://localhost:3000';

interface TcRef {
  id: string; testId: string; title: string; priority: string;
  moduleName: string; reqId: string;
  executedAt: string | null; executedBy: string | null;
}

interface WorkflowItemRef {
  id: string; name: string; status: string; lastRunAt: string | null;
  executedBy: string | null; startedAt: string | null; finishedAt: string | null;
  stepsPassed: number; stepsFailed: number; stepsTotal: number;
}

interface CampaignProgress {
  projectId: string;
  projectName: string;
  campaignStatus: string;
  launchedAt: string | null;
  closedAt: string | null;
  launchedBy: string | null;
  progressPct: number;
  testCases: { total: number; passed: number; failed: number; notTested: number };
  passedTestCases: TcRef[];
  failedTestCases: TcRef[];
  workflows: { total: number; byStatus: Record<string, number>; items: WorkflowItemRef[] };
  pendingChangesCount: number;
}

interface CampaignHistoryEntry {
  id: string;
  launchedAt: string;
  launchedBy: string | null;
  closedAt: string;
  closedBy: string | null;
  progressPct: number;
  testCases: { total: number; passed: number; failed: number };
  appliedChangesCount: number;
  discardedChangesCount: number;
  // null pour une entrée clôturée avant l'ajout de ce détail — l'export
  // retombe alors sur le résumé agrégé ci-dessus uniquement.
  failedTestCases: TcRef[] | null;
  workflows: WorkflowItemRef[] | null;
}

function fmtDate(v?: string | null) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return v;
  }
}

function progressColor(pct: number): string {
  if (pct >= 70) return '#0d9488';
  if (pct >= 30) return '#d97706';
  return '#dc2626';
}

const WF_STATUS_LABELS: Record<string, string> = {
  passed: 'Réussi', failed: 'Échoué', partial: 'Partiel', aborted: 'Abandonné', running: 'En cours', not_run: 'Jamais exécuté',
};
const WF_STATUS_COLORS: Record<string, string> = {
  passed: '#0d9488', failed: '#dc2626', partial: '#d97706', aborted: '#94a3b8', running: '#4169E1', not_run: '#94a3b8',
};

function fmtDuration(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min} min ${sec} s` : `${min} min`;
}

// Ouvre un document HTML autonome dans un nouvel onglet et déclenche
// l'impression — utilisé par le rapport complet et les exports par entrée
// d'historique (pas de dépendance PDF : ces pages n'ont accès qu'aux
// données déjà chargées ici).
function openPrintWindow(html: string) {
  const win = window.open('', '_blank');
  if (!win) return; // popup bloqué par le navigateur — rien de plus à faire côté script
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300); // laisse le temps au document de peindre avant d'ouvrir l'impression
}

// Une cellule CSV normale (échappée automatiquement), ou déjà mise en forme
// (raw) — utilisé par csvDate() ci-dessous pour empêcher Excel de "digérer"
// une date en interne.
type CsvCell = string | number | null | { raw: string };

// Échappe une valeur pour un champ CSV (RFC 4180) : entourée de guillemets
// dès qu'elle contient le séparateur, un guillemet ou un retour à la ligne.
// Séparateur ";" plutôt que "," : c'est ce qu'Excel en local FR attend par
// défaut à l'ouverture directe d'un .csv — avec une virgule, tout finit dans
// une seule colonne illisible.
function csvEscape(value: CsvCell): string {
  if (value !== null && typeof value === 'object') return value.raw; // déjà mis en forme, ne pas ré-échapper
  const s = value === null || value === undefined ? '' : String(value);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells: CsvCell[]): string {
  return cells.map(csvEscape).join(';');
}
// Un "bloc" = un titre de section + son en-tête de colonnes + ses lignes —
// plusieurs blocs peuvent être concaténés (séparés par une ligne vide) dans
// un même fichier pour un export "plusieurs tableaux en un CSV".
function csvBlock(title: string | null, headers: string[], rows: CsvCell[][]): string {
  const lines = [...(title ? [csvRow([title])] : []), csvRow(headers), ...rows.map(csvRow)];
  return lines.join('\r\n');
}

// Une date normale (ex: "22/09/2026, 16:03") est un nombre valide pour
// Excel, qui la reconvertit silencieusement en valeur numérique — la colonne
// par défaut étant trop étroite pour l'affichage, la cellule montre alors
// "#######" au lieu de la date. `="..."` force une lecture en texte brut.
function csvDate(v?: string | null): CsvCell {
  return { raw: `="${fmtDate(v).replace(/"/g, '""')}"` };
}

// Télécharge un CSV déjà construit — BOM UTF-8 en tête pour qu'Excel détecte
// correctement l'encodage (accents) à l'ouverture directe du fichier.
function downloadCsv(filename: string, content: string) {
  const blob = new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const REPORT_STYLE = `
  body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;margin:32px;font-size:13px;}
  h1{font-size:20px;margin:0 0 2px;} h2{font-size:14px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px;}
  .meta{color:#666;font-size:12px;margin-bottom:20px;}
  .stats{display:flex;gap:16px;margin-bottom:8px;flex-wrap:wrap;}
  .stat{border:1px solid #ddd;border-radius:8px;padding:10px 14px;min-width:110px;}
  .stat b{display:block;font-size:20px;}
  table{width:100%;border-collapse:collapse;margin-top:6px;}
  th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;font-size:12px;}
  th{background:#f5f5f5;} td.empty{color:#888;text-align:center;font-style:italic;}
  @media print{ body{margin:12mm;} }
`;

function StatCard({ icon, label, value, accent, onClick, active }: { icon: React.ReactNode; label: string; value: string | number; accent: string; onClick?: () => void; active?: boolean }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`rounded-xl border bg-white dark:bg-blacksection p-4 flex items-start gap-3 text-left w-full transition-colors ${
        active ? 'border-primary ring-1 ring-primary/40' : 'border-stroke dark:border-strokedark'
      } ${onClick ? 'cursor-pointer hover:border-primary/40' : ''}`}
    >
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${accent}1A`, color: accent }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wide text-waterloo dark:text-manatee mb-0.5">{label}</div>
        <div className="text-2xl font-extrabold text-black dark:text-white leading-tight">{value}</div>
      </div>
    </Tag>
  );

}

// Barre segmentée réussi/échoué/non testé — plus lisible qu'un simple %
// global pour un PO qui doit décider si la campagne peut être clôturée.
function SegmentedBar({ passed, failed, notTested }: { passed: number; failed: number; notTested: number }) {
  const total = passed + failed + notTested;
  if (total === 0) {
    return <div className="h-3.5 w-full rounded-full bg-alabaster dark:bg-black" />;
  }
  const pPct = (passed / total) * 100;
  const fPct = (failed / total) * 100;
  const nPct = (notTested / total) * 100;
  return (
    <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-alabaster dark:bg-black">
      {pPct > 0 && <div style={{ width: `${pPct}%`, backgroundColor: '#0d9488' }} title={`${passed} réussi(s)`} />}
      {fPct > 0 && <div style={{ width: `${fPct}%`, backgroundColor: '#dc2626' }} title={`${failed} échoué(s)`} />}
      {nPct > 0 && <div style={{ width: `${nPct}%`, backgroundColor: '#cbd5e1' }} title={`${notTested} non testé(s)`} />}
    </div>
  );
}

function LegendDot({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
      <span className="text-xs text-waterloo dark:text-manatee">{label} <span className="font-bold text-black dark:text-white">{value}</span></span>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="min-h-screen bg-white dark:bg-black pt-40 pb-16 px-4 md:px-8 lg:pt-40">
      <div className="mx-auto max-w-c-1390 animate-pulse">
        <div className="h-3 w-32 rounded bg-alabaster dark:bg-blacksection mb-4" />
        <div className="h-7 w-64 rounded bg-alabaster dark:bg-blacksection mb-8" />
        <div className="h-24 w-full rounded-xl bg-alabaster dark:bg-blacksection mb-6" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-20 rounded-xl bg-alabaster dark:bg-blacksection" />)}
        </div>
      </div>
    </div>
  );
}

async function apiGet(path: string) {
  const res = await fetch(`${API_BASE}${path}`);
  if (res.status === 403) throw new Error('FORBIDDEN');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function CampaignDetailPage() {
  const params = useParams();
  const projectId = params?.projectId as string;

  const { user: currentUser, loading: authLoading } = useCurrentUser();
  const authChecked = !authLoading;
  const [data, setData] = useState<CampaignProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<CampaignHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Panneau "Cas de test" déclenché par un clic sur la carte Réussis/Échoués
  // (voir StatCard onClick plus bas) — null = replié.
  const [tcFilter, setTcFilter] = useState<'passed' | 'failed' | null>(null);
  const [tcListExpanded, setTcListExpanded] = useState(false);
  // Filtre module/exigence dans le panneau "Cas de test" — pour repérer une
  // zone à risque sans dérouler toute la liste.
  const [tcModuleFilter, setTcModuleFilter] = useState('all');
  const [tcReqFilter, setTcReqFilter] = useState('all');
  const [tcPriorityFilter, setTcPriorityFilter] = useState('all');
  // Bandeau "mise à jour en direct" pour les événements de campagne
  // (lancement/clôture/mise en attente) — voir plus bas.
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const liveNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Anti-rebond pour les événements de données (exécution QA d'un TC,
  // validation de workflow...) qui font aussi bouger l'avancement affiché
  // mais peuvent arriver en rafale (plusieurs TC exécutés à la suite) —
  // pas de bandeau pour ceux-là, juste un refetch groupé silencieux.
  const dataRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    apiGet(`/projects/${projectId}/campaign/progress`)
      .then((d) => setData(d?.data ?? null))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  const loadHistory = useCallback(() => {
    if (!projectId) return;
    setHistoryError(null);
    apiGet(`/projects/${projectId}/campaign/history`)
      .then((d) => setHistory(d?.data ?? []))
      .catch((e) => { setHistory(null); setHistoryError(e.message === 'FORBIDDEN' ? 'Accès refusé.' : `Erreur de chargement (${e.message}).`); });
  }, [projectId]);

  const scheduleDataRefetch = useCallback(() => {
    if (dataRefetchTimer.current) clearTimeout(dataRefetchTimer.current);
    dataRefetchTimer.current = setTimeout(() => load(), 400);
  }, [load]);

  useEffect(() => {
    if (authChecked && currentUser) { load(); loadHistory(); }
  }, [authChecked, currentUser, load, loadHistory]);

  // Écoute les événements de campagne diffusés sur la room `project:<id>`
  // (même namespace /notifications que useProjectRealtime côté analyzer).
  // On n'utilise volontairement PAS le hook partagé useProjectRealtime ici :
  // il ignore par défaut les événements dont l'auteur est l'utilisateur
  // courant (pertinent sur analyzer/page.tsx, qui met déjà à jour son état
  // local de son côté) — mais CETTE page n'a aucune autre source de vérité,
  // donc si on filtrait nos propres actions, le PO qui vient de lancer/
  // clôturer la campagne depuis l'analyzer ne verrait PAS cette page se
  // rafraîchir tant qu'il ne la recharge pas manuellement. Ici on refetch
  // pour TOUT le monde, auteur de l'action inclus.
  useEffect(() => {
    if (!currentUser || !projectId) return;
    let cancelled = false;
    let socket: Socket | null = null;

    (async () => {
      try {
        const ticket = await getWsTicket();
        if (cancelled) return;
        socket = io(`${BACKEND_WS_URL}/notifications`, { auth: { ticket }, transports: ['websocket'] });

        socket.on('connect', () => socket?.emit('project:join', { projectId }));

        const onCampaignEvent = (event: 'campaign:launched' | 'campaign:closed' | 'campaign:change-queued') =>
          (payload: { actorName?: string; actorId?: string }) => {
            load();
            if (event === 'campaign:closed') loadHistory();
            const isSelf = payload?.actorId === currentUser.id;
            const who = isSelf ? 'vous' : (payload.actorName || 'un autre utilisateur');
            setLiveNote(
              event === 'campaign:closed' ? `Campagne clôturée à l'instant par ${who}.`
                : event === 'campaign:launched' ? `Campagne lancée à l'instant par ${who}.`
                : `Modification mise en attente par ${who}.`,
            );
            if (liveNoteTimer.current) clearTimeout(liveNoteTimer.current);
            liveNoteTimer.current = setTimeout(() => setLiveNote(null), 6000);
          };
        socket.on('campaign:launched', onCampaignEvent('campaign:launched'));
        socket.on('campaign:closed', onCampaignEvent('campaign:closed'));
        socket.on('campaign:change-queued', onCampaignEvent('campaign:change-queued'));

        // Événements "données" : l'avancement affiché (réussi/échoué/non
        // testé, workflows validés) en dépend directement même si aucune
        // campagne n'est lancée/clôturée à ce moment — voir
        // ProjectController.recordTestCaseExecution (bouton Réussi/Échoué
        // QA) et WorkflowController (validation d'un run).
        const DATA_EVENTS = [
          'testcase:created', 'testcase:updated', 'testcase:deleted',
          'requirement:created', 'requirement:deleted',
          'module:created', 'module:deleted',
          'workflow:created', 'workflow:updated', 'workflow:deleted', 'workflow:run-updated',
        ];
        for (const evt of DATA_EVENTS) socket.on(evt, scheduleDataRefetch);
      } catch (err) {
        console.error('[realtime] impossible d\u2019obtenir le ticket WebSocket:', err);
      }
    })();

    return () => {
      cancelled = true;
      socket?.emit('project:leave', { projectId });
      socket?.disconnect();
      if (liveNoteTimer.current) clearTimeout(liveNoteTimer.current);
      if (dataRefetchTimer.current) clearTimeout(dataRefetchTimer.current);
    };
  }, [currentUser, projectId, load, loadHistory, scheduleDataRefetch]);

  // Générateurs de lignes de tableau partagés entre le rapport de la
  // campagne en cours et celui d'une entrée d'historique.
  const buildFailedRows = useCallback((list: TcRef[]) => list.length > 0
    ? list.map((tc) => `<tr><td>${tc.testId}</td><td>${tc.title}</td><td>${tc.moduleName} / ${tc.reqId}</td><td>${tc.priority}</td><td>${tc.executedBy ?? '—'}</td><td>${fmtDate(tc.executedAt)}</td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">Aucun cas de test en échec.</td></tr>`, []);
  const buildWfRows = useCallback((list: WorkflowItemRef[]) => list.length > 0
    ? list.map((w) => `<tr><td>${w.name}</td><td>${WF_STATUS_LABELS[w.status] ?? w.status}</td><td>${w.executedBy ?? '—'}</td><td>${fmtDate(w.lastRunAt)}</td><td>${w.stepsTotal > 0 ? `${w.stepsPassed}/${w.stepsTotal}` : '—'}</td></tr>`).join('')
    : `<tr><td colspan="5" class="empty">Aucun workflow validé.</td></tr>`, []);

  // Génère un rapport HTML autonome (mise en page imprimable) et ouvre la
  // boîte de dialogue d'impression du navigateur — le PO choisit "Enregistrer
  // en PDF" ou imprime directement. Pas de dépendance PDF côté client : cette
  // page n'a de toute façon accès qu'aux données déjà chargées ici.
  const handleExportReport = useCallback(() => {
    if (!data) return;
    const genDate = new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
    const failedRows = buildFailedRows(data.failedTestCases);
    const wfRows = buildWfRows(data.workflows.items);
    const historyRows = (history && history.length > 0)
      ? history.map((h) => `<tr><td>${fmtDate(h.launchedAt)}</td><td>${fmtDate(h.closedAt)}</td><td>${h.progressPct}%</td><td>${h.testCases.passed}/${h.testCases.total} réussi(s)</td><td>${h.launchedBy ?? '—'}</td><td>${h.closedBy ?? '—'}</td></tr>`).join('')
      : `<tr><td colspan="6" class="empty">Aucune campagne précédente enregistrée.</td></tr>`;

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Rapport de campagne — ${data.projectName}</title><style>${REPORT_STYLE}</style></head><body>
      <h1>Rapport de campagne de tests — ${data.projectName}</h1>
      <div class="meta">Généré le ${genDate} · Statut : ${data.campaignStatus === 'launched' ? 'Campagne active' : 'Aucune campagne active'}${data.launchedBy && data.campaignStatus === 'launched' ? ` · lancée par ${data.launchedBy} le ${fmtDate(data.launchedAt)}` : ''}${data.campaignStatus !== 'launched' && data.closedAt ? ` · dernière clôture le ${fmtDate(data.closedAt)}` : ''}</div>
      <div class="stats">
        <div class="stat">Avancement<b>${data.progressPct}%</b></div>
        <div class="stat">Réussis<b>${data.testCases.passed}</b></div>
        <div class="stat">Échoués<b>${data.testCases.failed}</b></div>
        <div class="stat">Non testés<b>${data.testCases.notTested}</b></div>
        <div class="stat">Modifs. en attente<b>${data.pendingChangesCount}</b></div>
      </div>
      <h2>Cas de test échoués (${data.failedTestCases.length})</h2>
      <table><thead><tr><th>ID</th><th>Titre</th><th>Module / Exigence</th><th>Priorité</th><th>Exécuté par</th><th>Date</th></tr></thead><tbody>${failedRows}</tbody></table>
      <h2>Workflows (${data.workflows.total})</h2>
      <table><thead><tr><th>Nom</th><th>Statut</th><th>Exécuté par</th><th>Date</th><th>Étapes</th></tr></thead><tbody>${wfRows}</tbody></table>
      <h2>Historique des campagnes précédentes</h2>
      <table><thead><tr><th>Lancée le</th><th>Clôturée le</th><th>Avancement final</th><th>Résultats</th><th>Lancée par</th><th>Clôturée par</th></tr></thead><tbody>${historyRows}</tbody></table>
    </body></html>`;

    openPrintWindow(html);
  }, [data, history, buildFailedRows, buildWfRows]);

  // Export d'UNE entrée d'historique — inclut le détail complet (TC échoués
  // + workflows) quand il a été conservé (voir CampaignRun.failed_test_cases_detail
  // / workflows_detail côté backend). Pour une entrée clôturée avant l'ajout
  // de ce détail, ces champs sont null et le rapport reste un résumé.
  const handleExportHistoryEntry = useCallback((h: CampaignHistoryEntry) => {
    const genDate = new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
    const notTested = h.testCases.total - h.testCases.passed - h.testCases.failed;
    const hasDetail = h.failedTestCases !== null && h.workflows !== null;
    const detailSection = hasDetail
      ? `
      <h2>Cas de test échoués (${h.failedTestCases!.length})</h2>
      <table><thead><tr><th>ID</th><th>Titre</th><th>Module / Exigence</th><th>Priorité</th><th>Exécuté par</th><th>Date</th></tr></thead><tbody>${buildFailedRows(h.failedTestCases!)}</tbody></table>
      <h2>Workflows (${h.workflows!.length})</h2>
      <table><thead><tr><th>Nom</th><th>Statut</th><th>Exécuté par</th><th>Date</th><th>Étapes</th></tr></thead><tbody>${buildWfRows(h.workflows!)}</tbody></table>`
      : `<p style="color:#888;font-style:italic;margin-top:24px;">Le détail par cas de test et par workflow n'a pas été conservé pour cette campagne (clôturée avant l'ajout de ce suivi).</p>`;

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Rapport de campagne — ${data?.projectName ?? ''} (${fmtDate(h.launchedAt)})</title><style>${REPORT_STYLE}</style></head><body>
      <h1>Rapport de campagne de tests — ${data?.projectName ?? ''}</h1>
      <div class="meta">Généré le ${genDate} · Campagne clôturée · lancée le ${fmtDate(h.launchedAt)}${h.launchedBy ? ` par ${h.launchedBy}` : ''} · clôturée le ${fmtDate(h.closedAt)}${h.closedBy ? ` par ${h.closedBy}` : ''}</div>
      <div class="stats">
        <div class="stat">Avancement final<b>${h.progressPct}%</b></div>
        <div class="stat">Réussis<b>${h.testCases.passed}</b></div>
        <div class="stat">Échoués<b>${h.testCases.failed}</b></div>
        <div class="stat">Non testés<b>${notTested}</b></div>
        <div class="stat">Modifs. gardées<b>${h.appliedChangesCount}</b></div>
        <div class="stat">Modifs. annulées<b>${h.discardedChangesCount}</b></div>
      </div>
      ${detailSection}
    </body></html>`;
    openPrintWindow(html);
  }, [data, buildFailedRows, buildWfRows]);

  // Export CSV des cas de test de la campagne en cours (réussis + échoués) —
  // ouvrable directement dans un tableur, contrairement au rapport imprimable.
  const handleExportTcCsv = useCallback(() => {
    if (!data) return;
    const rows = [
      ...data.passedTestCases.map((tc) => ['Réussi', tc.testId, tc.title, tc.moduleName, tc.reqId, tc.priority, tc.executedBy ?? '', csvDate(tc.executedAt)]),
      ...data.failedTestCases.map((tc) => ['Échoué', tc.testId, tc.title, tc.moduleName, tc.reqId, tc.priority, tc.executedBy ?? '', csvDate(tc.executedAt)]),
    ];
    downloadCsv(
      `campagne-${data.projectName}-cas-de-test.csv`.replace(/[^\w.-]+/g, '_'),
      csvBlock(null, ['Statut', 'ID', 'Titre', 'Module', 'Exigence', 'Priorité', 'Exécuté par', 'Date'], rows),
    );
  }, [data]);

  // Export CSV de l'historique COMPLET — une ligne par cycle clôturé, pour
  // une vue d'ensemble rapide de toutes les campagnes passées à la fois.
  const handleExportHistoryCsv = useCallback(() => {
    if (!history || history.length === 0) return;
    const rows = history.map((h) => [
      csvDate(h.launchedAt), csvDate(h.closedAt), h.progressPct,
      h.testCases.passed, h.testCases.failed, h.testCases.total - h.testCases.passed - h.testCases.failed,
      h.launchedBy ?? '', h.closedBy ?? '', h.appliedChangesCount, h.discardedChangesCount,
    ]);
    downloadCsv(
      `campagne-${data?.projectName ?? ''}-historique.csv`.replace(/[^\w.-]+/g, '_'),
      csvBlock(null, ['Lancée le', 'Clôturée le', 'Avancement final (%)', 'Réussis', 'Échoués', 'Non testés', 'Lancée par', 'Clôturée par', 'Modifs. gardées', 'Modifs. annulées'], rows),
    );
  }, [history, data]);

  // Export CSV d'UNE seule entrée d'historique — résumé + détail (TC échoués
  // et workflows) quand il a été conservé, comme pour le rapport imprimable
  // par entrée. C'est le pendant tableur du bouton "Exporter le rapport" de
  // chaque campagne passée.
  const handleExportHistoryEntryCsv = useCallback((h: CampaignHistoryEntry) => {
    const notTested = h.testCases.total - h.testCases.passed - h.testCases.failed;
    const blocks = [
      csvBlock('Résumé', ['Lancée le', 'Clôturée le', 'Avancement final (%)', 'Réussis', 'Échoués', 'Non testés', 'Lancée par', 'Clôturée par', 'Modifs. gardées', 'Modifs. annulées'],
        [[csvDate(h.launchedAt), csvDate(h.closedAt), h.progressPct, h.testCases.passed, h.testCases.failed, notTested, h.launchedBy ?? '', h.closedBy ?? '', h.appliedChangesCount, h.discardedChangesCount]]),
    ];
    if (h.failedTestCases !== null) {
      blocks.push(csvBlock('Cas de test échoués', ['ID', 'Titre', 'Module', 'Exigence', 'Priorité', 'Exécuté par', 'Date'],
        h.failedTestCases.map((tc) => [tc.testId, tc.title, tc.moduleName, tc.reqId, tc.priority, tc.executedBy ?? '', csvDate(tc.executedAt)])));
    }
    if (h.workflows !== null) {
      blocks.push(csvBlock('Workflows', ['Nom', 'Statut', 'Exécuté par', 'Date', 'Étapes réussies', 'Étapes totales'],
        h.workflows.map((w) => [w.name, WF_STATUS_LABELS[w.status] ?? w.status, w.executedBy ?? '', csvDate(w.lastRunAt), w.stepsPassed, w.stepsTotal])));
    }
    downloadCsv(
      `campagne-${data?.projectName ?? ''}-${fmtDate(h.launchedAt)}.csv`.replace(/[^\w.-]+/g, '_'),
      blocks.join('\r\n\r\n'),
    );
  }, [data]);

  if (!authChecked || (currentUser && loading && !data)) {
    return <DetailSkeleton />;
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-white dark:bg-black text-center px-4">
        <p className="text-black dark:text-white font-semibold">Connectez-vous pour accéder à cette page.</p>
        <Link href="/auth/signin" className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-primaryho">Se connecter</Link>
      </div>
    );
  }

  if (error === 'FORBIDDEN') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-black">
        <p className="text-waterloo text-sm">Vous n'avez pas accès à ce projet.</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-white dark:bg-black text-center px-4">
        <p className="text-[#dc2626] dark:text-[#f87171] font-semibold">Erreur de chargement.</p>
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm font-bold text-black transition-colors hover:border-primary/40 dark:border-strokedark dark:text-white">
          <IconRefresh className="w-3.5 h-3.5" /> Réessayer
        </button>
      </div>
    );
  }

  const wfEntries = Object.entries(data.workflows.byStatus).filter(([, v]) => v > 0);
  const isLaunched = data.campaignStatus === 'launched';

  return (
    <div className="min-h-screen bg-white dark:bg-black pt-40 pb-16 px-4 md:px-8 lg:pt-40">
      <div className="mx-auto max-w-c-1390">
        {/* Fil d'Ariane + en-tête */}
        <div className="mb-6">
          <Link href="/campaigns" className="inline-flex items-center gap-1 text-xs font-bold text-waterloo hover:text-primary transition-colors">
            <IconArrowLeft className="w-3.5 h-3.5" /> Toutes les campagnes
          </Link>
          <div className="mt-3 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <IconFlag className="w-4.5 h-4.5" />
              </span>
              <div>
                <h1 className="text-2xl font-bold text-black dark:text-white leading-tight">{data.projectName}</h1>
                <p className="mt-0.5 text-xs font-semibold text-waterloo dark:text-manatee">
                  {isLaunched ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#2563eb] animate-pulse" /> Campagne active
                    </span>
                  ) : 'Aucune campagne active'}
                  {data.launchedBy && isLaunched && ` · lancée par ${data.launchedBy} le ${fmtDate(data.launchedAt)}`}
                  {!isLaunched && data.closedAt && ` · dernière clôture le ${fmtDate(data.closedAt)}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handleExportReport}
                className="inline-flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-xs font-bold text-black transition-colors hover:border-primary/40 dark:border-strokedark dark:text-white"
              >
                <IconDownload className="w-3.5 h-3.5" /> Exporter le rapport
              </button>
              <button
                onClick={handleExportTcCsv}
                title="Export CSV des cas de test (réussis + échoués), ouvrable dans un tableur"
                className="inline-flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-xs font-bold text-black transition-colors hover:border-primary/40 dark:border-strokedark dark:text-white"
              >
                <IconDownload className="w-3.5 h-3.5" /> Exporter en CSV
              </button>
              <Link
                href={`/analyzer?projectId=${data.projectId}`}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-primaryho"
              >
                Ouvrir le projet <IconExternalOpen className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        </div>

        {liveNote && (
          <div className="mb-5 flex items-center gap-2 rounded-lg border border-[#2563eb]/25 bg-[#2563eb]/10 px-3.5 py-2 text-xs font-semibold text-[#1d4ed8] dark:text-[#93b4f5] animate-[fadeIn_.2s_ease-out]">
            <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#2563eb] animate-pulse" />
            {liveNote}
          </div>
        )}

        {/* Avancement global — barre segmentée + légende */}
        <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-5 mb-6">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <span className="text-sm font-bold text-black dark:text-white">Avancement global (cas de test)</span>
            <span className="text-xl font-extrabold" style={{ color: progressColor(data.progressPct) }}>{data.progressPct}%</span>
          </div>
          <SegmentedBar passed={data.testCases.passed} failed={data.testCases.failed} notTested={data.testCases.notTested} />
          <div className="flex items-center gap-5 mt-3 flex-wrap">
            <LegendDot color="#0d9488" label="Réussis" value={data.testCases.passed} />
            <LegendDot color="#dc2626" label="Échoués" value={data.testCases.failed} />
            <LegendDot color="#cbd5e1" label="Non testés" value={data.testCases.notTested} />
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard icon={<IconInbox className="w-4.5 h-4.5" />} label="Cas de test — total" value={data.testCases.total} accent="#475569" />
          <StatCard
            icon={<IconCheckCircle className="w-4.5 h-4.5" />} label="Réussis" value={data.testCases.passed} accent="#0d9488"
            active={tcFilter === 'passed'}
            onClick={data.testCases.passed > 0 ? () => { setTcFilter((f) => (f === 'passed' ? null : 'passed')); setTcListExpanded(false); setTcModuleFilter('all'); setTcReqFilter('all'); setTcPriorityFilter('all'); } : undefined}
          />
          <StatCard
            icon={<IconXCircle className="w-4.5 h-4.5" />} label="Échoués" value={data.testCases.failed} accent="#dc2626"
            active={tcFilter === 'failed'}
            onClick={data.testCases.failed > 0 ? () => { setTcFilter((f) => (f === 'failed' ? null : 'failed')); setTcListExpanded(false); setTcModuleFilter('all'); setTcReqFilter('all'); setTcPriorityFilter('all'); } : undefined}
          />
          <StatCard icon={<IconClock className="w-4.5 h-4.5" />} label="Non testés" value={data.testCases.notTested} accent="#94a3b8" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Workflows validés */}
          <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-5">
            <h2 className="text-sm font-bold text-black dark:text-white mb-4">Workflows validés ({data.workflows.total})</h2>
            {wfEntries.length === 0 ? (
              <p className="text-xs text-waterloo dark:text-manatee">Aucun workflow validé pour ce projet.</p>
            ) : (
              <div className="flex flex-col gap-2.5 mb-4">
                {wfEntries.map(([status, count]) => {
                  const pct = data.workflows.total > 0 ? Math.round((count / data.workflows.total) * 100) : 0;
                  return (
                    <div key={status}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-black dark:text-white">{WF_STATUS_LABELS[status] ?? status}</span>
                        <span className="text-xs font-bold text-waterloo dark:text-manatee">{count}</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-alabaster dark:bg-black overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: WF_STATUS_COLORS[status] }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {data.workflows.items.length > 0 && (
              <div className="max-h-[280px] overflow-y-auto pr-1 border-t border-stroke dark:border-strokedark pt-3 flex flex-col gap-2.5">
                {data.workflows.items.map((w) => {
                  const duration = fmtDuration(w.startedAt, w.finishedAt);
                  const isRunning = w.status === 'running';
                  return (
                    <Link
                      key={w.id}
                      href={`/analyzer?projectId=${data.projectId}&view=workflow&workflowId=${w.id}`}
                      className={`block rounded-lg px-3 py-2 transition-colors ${
                        isRunning
                          ? 'bg-[#4169E1]/10 hover:bg-[#4169E1]/15 ring-1 ring-[#4169E1]/30'
                          : 'bg-alabaster/60 dark:bg-black/30 hover:bg-alabaster dark:hover:bg-black/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1">
                        {/* Nom affiché en entier (pas de troncature) — passe à la ligne si besoin */}
                        <span className="text-xs font-bold text-black dark:text-white">{w.name}</span>
                        <span className="flex items-center gap-1.5 flex-shrink-0 text-[11px] font-bold" style={{ color: WF_STATUS_COLORS[w.status] ?? '#94a3b8' }}>
                          <span className={`h-1.5 w-1.5 rounded-full ${isRunning ? 'animate-pulse' : ''}`} style={{ backgroundColor: WF_STATUS_COLORS[w.status] ?? '#94a3b8' }} />
                          {WF_STATUS_LABELS[w.status] ?? w.status}
                          <IconChevronRight className="w-3 h-3 text-waterloo dark:text-manatee" />
                        </span>
                      </div>
                      {w.lastRunAt ? (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-waterloo dark:text-manatee">
                          <span>{isRunning ? 'Lancé le' : 'Exécuté le'} {fmtDate(w.lastRunAt)}</span>
                          {w.executedBy && <span>par {w.executedBy}</span>}
                          {duration && <span>· {duration}</span>}
                          {w.stepsTotal > 0 && (
                            <span>
                              · <span className="font-semibold text-[#0d9488]">{w.stepsPassed}</span> étape{w.stepsPassed > 1 ? 's' : ''} réussie{w.stepsPassed > 1 ? 's' : ''}
                              {w.stepsFailed > 0 && <> · <span className="font-semibold text-[#dc2626]">{w.stepsFailed}</span> échouée{w.stepsFailed > 1 ? 's' : ''}</>}
                              {' '}/ {w.stepsTotal}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-waterloo dark:text-manatee">Jamais exécuté</span>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {/* Modifications en attente */}
          <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-5">
            <h2 className="text-sm font-bold text-black dark:text-white mb-3">Modifications en attente</h2>
            {data.pendingChangesCount === 0 ? (
              <div className="flex flex-col items-start gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0d9488]">
                  <IconCheckCircle className="w-4 h-4" /> Rien en attente
                </span>
                <p className="text-xs text-waterloo dark:text-manatee">Aucune modification en attente de résolution.</p>
              </div>
            ) : (
              <>
                <div className="flex items-start gap-2.5 mb-4 rounded-lg bg-amber-500/10 p-3">
                  <IconAlert className="w-4 h-4 flex-shrink-0 text-amber-700 dark:text-amber-400 mt-0.5" />
                  <p className="text-xs text-waterloo dark:text-manatee">
                    <span className="font-bold text-amber-700 dark:text-amber-400">{data.pendingChangesCount}</span> modification(s) mise(s) en standby pendant la campagne — à garder ou annuler avant la clôture.
                  </p>
                </div>
                <Link
                  href={`/analyzer?projectId=${data.projectId}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-bold text-white transition-colors hover:bg-primaryho"
                >
                  Ouvrir le projet pour résoudre <IconExternalOpen className="w-3.5 h-3.5" />
                </Link>
              </>
            )}
          </div>
        </div>

        {/* Cas de test — n'apparaît qu'au clic sur la carte Réussis/Échoués ci-dessus */}
        {tcFilter && (() => {
          const fullList = tcFilter === 'passed' ? data.passedTestCases : data.failedTestCases;
          const color = tcFilter === 'passed' ? '#0d9488' : '#dc2626';
          const label = tcFilter === 'passed' ? 'réussis' : 'échoués';

          // Options du filtre module — dérivées de la liste complète (pas de
          // la liste déjà filtrée) pour toujours proposer tous les modules
          // concernés, même quand un module est déjà sélectionné.
          const modules = Array.from(new Set(fullList.map((tc) => tc.moduleName))).sort((a, b) => a.localeCompare(b, 'fr'));
          // Options du filtre exigence — dépendantes du module choisi, pour
          // affiner "module → exigence" en deux clics.
          const reqsInModule = tcModuleFilter === 'all'
            ? []
            : Array.from(new Set(fullList.filter((tc) => tc.moduleName === tcModuleFilter).map((tc) => tc.reqId))).sort((a, b) => a.localeCompare(b, 'fr'));
          // Options du filtre priorité — indépendant du module/exigence.
          const priorities = Array.from(new Set(fullList.map((tc) => tc.priority))).sort((a, b) => a.localeCompare(b, 'fr'));

          const list = fullList.filter((tc) =>
            (tcModuleFilter === 'all' || tc.moduleName === tcModuleFilter) &&
            (tcReqFilter === 'all' || tc.reqId === tcReqFilter) &&
            (tcPriorityFilter === 'all' || tc.priority === tcPriorityFilter),
          );
          const shown = tcListExpanded ? list : list.slice(0, 6);
          const hasActiveFilter = tcModuleFilter !== 'all' || tcReqFilter !== 'all' || tcPriorityFilter !== 'all';
          return (
            <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-5 mb-6">
              <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                <h2 className="text-sm font-bold text-black dark:text-white">
                  Cas de test {label} ({list.length}{list.length !== fullList.length ? ` / ${fullList.length}` : ''})
                </h2>
                <button onClick={() => setTcFilter(null)} className="text-waterloo hover:text-black dark:hover:text-white transition-colors" title="Fermer">
                  <IconXCircle className="w-4 h-4" />
                </button>
              </div>

              {(modules.length > 0 || priorities.length > 0) && (
                <div className="flex items-center gap-2 mt-3 mb-1 flex-wrap">
                  {modules.length > 0 && (
                    <select
                      value={tcModuleFilter}
                      onChange={(e) => { setTcModuleFilter(e.target.value); setTcReqFilter('all'); setTcListExpanded(false); }}
                      className="rounded-full border border-stroke bg-white dark:bg-blacksection dark:border-strokedark px-3 py-1.5 text-xs font-bold text-black dark:text-white focus:outline-none focus:border-primary/50 cursor-pointer"
                    >
                      <option value="all">Tous les modules</option>
                      {modules.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  )}
                  {tcModuleFilter !== 'all' && reqsInModule.length > 0 && (
                    <select
                      value={tcReqFilter}
                      onChange={(e) => { setTcReqFilter(e.target.value); setTcListExpanded(false); }}
                      className="rounded-full border border-stroke bg-white dark:bg-blacksection dark:border-strokedark px-3 py-1.5 text-xs font-bold text-black dark:text-white focus:outline-none focus:border-primary/50 cursor-pointer"
                    >
                      <option value="all">Toutes les exigences</option>
                      {reqsInModule.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  )}
                  {priorities.length > 0 && (
                    <select
                      value={tcPriorityFilter}
                      onChange={(e) => { setTcPriorityFilter(e.target.value); setTcListExpanded(false); }}
                      className="rounded-full border border-stroke bg-white dark:bg-blacksection dark:border-strokedark px-3 py-1.5 text-xs font-bold text-black dark:text-white focus:outline-none focus:border-primary/50 cursor-pointer"
                    >
                      <option value="all">Toutes priorités</option>
                      {priorities.map((pr) => <option key={pr} value={pr}>Priorité {pr}</option>)}
                    </select>
                  )}
                  {hasActiveFilter && (
                    <button
                      onClick={() => { setTcModuleFilter('all'); setTcReqFilter('all'); setTcPriorityFilter('all'); }}
                      className="text-xs font-bold text-primary hover:underline"
                    >
                      Réinitialiser
                    </button>
                  )}
                </div>
              )}

              {list.length === 0 ? (
                <p className="text-xs text-waterloo dark:text-manatee mt-2">
                  {fullList.length === 0 ? `Aucun cas de test ${label}.` : 'Aucun cas de test ne correspond à ce filtre.'}
                </p>
              ) : (
                <>
                  <div className="mt-3 flex flex-col gap-2">
                    {shown.map((tc) => (
                      <Link
                        key={tc.id}
                        href={`/analyzer?projectId=${data.projectId}&commentEntityType=test_case&commentEntityId=${tc.id}`}
                        className="block rounded-lg bg-alabaster/60 dark:bg-black/30 px-3.5 py-2.5 hover:bg-alabaster dark:hover:bg-black/50 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <span className="font-bold text-xs" style={{ color }}>{tc.testId}</span>
                            {/* Titre affiché en entier (pas de troncature) — passe à la ligne si besoin */}
                            <span className="block text-sm font-medium text-black dark:text-white">{tc.title}</span>
                          </div>
                          <IconChevronRight className="w-4 h-4 flex-shrink-0 text-waterloo dark:text-manatee mt-0.5" />
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-waterloo dark:text-manatee">
                          <span>{tc.moduleName} / {tc.reqId}</span>
                          <span>Priorité {tc.priority}</span>
                          {tc.executedBy && <span>par {tc.executedBy}</span>}
                          {tc.executedAt && <span>{fmtDate(tc.executedAt)}</span>}
                        </div>
                      </Link>
                    ))}
                  </div>
                  {list.length > 6 && (
                    <button
                      onClick={() => setTcListExpanded((v) => !v)}
                      className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
                    >
                      {tcListExpanded ? 'Réduire' : `Voir les ${list.length - 6} autres`}
                      <IconChevronDown className={`w-3.5 h-3.5 transition-transform ${tcListExpanded ? 'rotate-180' : ''}`} />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })()}

        {/* Historique des campagnes */}
        <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-5 mb-6">
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setHistoryOpen((v) => !v)} className="flex-1 flex items-center justify-between min-w-0">
              <span className="inline-flex items-center gap-2 text-sm font-bold text-black dark:text-white">
                <IconHistory className="w-4 h-4 text-waterloo dark:text-manatee" />
                Historique des campagnes {history ? `(${history.length})` : ''}
                {historyError && <IconAlert className="w-3.5 h-3.5 text-amber-600" />}
              </span>
            </button>
            <div className="flex items-center gap-2 flex-shrink-0">
              {history && history.length > 0 && (
                <button
                  onClick={handleExportHistoryCsv}
                  title="Export CSV de l'historique"
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-primary hover:underline"
                >
                  <IconDownload className="w-3 h-3" /> CSV
                </button>
              )}
              <button onClick={() => setHistoryOpen((v) => !v)}>
                <IconChevronDown className={`w-4 h-4 text-waterloo dark:text-manatee transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>
          </div>
          {historyOpen && (
            historyError ? (
              <div className="mt-3 flex items-center gap-3">
                <p className="text-xs text-[#dc2626] dark:text-[#f87171]">{historyError}</p>
                <button onClick={loadHistory} className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline flex-shrink-0">
                  <IconRefresh className="w-3 h-3" /> Réessayer
                </button>
              </div>
            ) : history === null ? (
              <p className="text-xs text-waterloo dark:text-manatee mt-3">Chargement…</p>
            ) : history.length === 0 ? (
              <p className="text-xs text-waterloo dark:text-manatee mt-3">
                Aucune campagne précédente enregistrée pour ce projet. (Seules les campagnes clôturées à partir d'aujourd'hui sont conservées dans l'historique.)
              </p>
            ) : (
              <div className="mt-4 flex flex-col gap-3">
                {history.map((h) => (
                  <div key={h.id} className="rounded-lg bg-alabaster/60 dark:bg-black/30 px-3.5 py-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap mb-1.5">
                      <span className="text-xs font-bold text-black dark:text-white">
                        {fmtDate(h.launchedAt)} → {fmtDate(h.closedAt)}
                      </span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-extrabold" style={{ color: progressColor(h.progressPct) }}>{h.progressPct}%</span>
                        <button
                          onClick={() => handleExportHistoryEntry(h)}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-primary hover:underline flex-shrink-0"
                        >
                          <IconDownload className="w-3 h-3" /> Rapport
                        </button>
                        <button
                          onClick={() => handleExportHistoryEntryCsv(h)}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-primary hover:underline flex-shrink-0"
                        >
                          <IconDownload className="w-3 h-3" /> CSV
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-waterloo dark:text-manatee">
                      <span><span className="font-semibold text-[#0d9488]">{h.testCases.passed}</span> réussi(s)</span>
                      <span><span className="font-semibold text-[#dc2626]">{h.testCases.failed}</span> échoué(s)</span>
                      <span>sur {h.testCases.total} cas de test</span>
                      {h.launchedBy && <span>· lancée par {h.launchedBy}</span>}
                      {h.closedBy && <span>· clôturée par {h.closedBy}</span>}
                      {(h.appliedChangesCount > 0 || h.discardedChangesCount > 0) && (
                        <span>· {h.appliedChangesCount} modif. gardée(s), {h.discardedChangesCount} annulée(s)</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}