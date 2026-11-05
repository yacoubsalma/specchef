'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { io, Socket } from 'socket.io-client';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { getWsTicket } from '@/lib/notifications-api';
import {
  IconFlag, IconFolder, IconTrendUp, IconAlert, IconSearch,
  IconClock, IconChevronRight, IconRefresh, IconSort, IconChevronDown,
} from '@/app/components/CampaignIcons';

const API_BASE = '/api/backend';
const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || 'http://localhost:3000';

interface CampaignProjectRow {
  projectId: string;
  projectName: string;
  campaignStatus: string;
  launchedAt: string | null;
  closedAt: string | null;
  progressPct: number;
  testCases: { total: number; passed: number; failed: number; notTested: number };
  pendingChangesCount: number;
  lastActivityAt: string | null;
}

type SortKey = 'recent' | 'progress' | 'name' | 'pending';

// Nombre de jours sans exécution (TC ou workflow) au-delà duquel une
// campagne active est considérée "stagnante".
const STAGNANT_DAYS = 3;

function isStagnant(p: CampaignProjectRow): boolean {
  if (p.campaignStatus !== 'launched') return false;
  const ref = p.lastActivityAt ?? p.launchedAt;
  if (!ref) return false;
  const days = (Date.now() - new Date(ref).getTime()) / 86_400_000;
  return days >= STAGNANT_DAYS;
}

function fmtDate(v?: string | null) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return v;
  }
}

function fmtNum(n: number | undefined | null) {
  return (n ?? 0).toLocaleString('fr-FR');
}

// Même seuils que coverageColor() du dashboard : rouge en dessous de 30%, ambre
// jusqu'à 70%, vert au-delà — cohérence visuelle avec le widget dashboard.
function progressColor(pct: number): string {
  if (pct >= 70) return '#0d9488';
  if (pct >= 30) return '#d97706';
  return '#dc2626';
}

// Géométrie d'un arc de cercle en SVG — convention standard : angle 0° = haut
// du cercle, augmente dans le sens horaire (90° = droite, 180° = bas...).
// Voir https://stackoverflow.com/a/18473154 pour la formule de référence.
function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

// Jauge en demi-cercle (façon compteur de vitesse) : arc de -90° (gauche) à
// +90° (droite) en passant par le haut, la portion colorée avançant avec le
// pourcentage. Remplace l'ancienne barre linéaire — pur SVG, sans dépendance.
function ProgressGauge({ pct, color, size = 56 }: { pct: number; color: string; size?: number }) {
  const clamped = Math.min(Math.max(pct, 0), 100);
  const strokeWidth = Math.max(Math.round(size * 0.16), 4);
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const height = r + strokeWidth;
  const cy = height - strokeWidth / 2;
  const trackPath = describeArc(cx, cy, r, -90, 90);
  const valuePath = describeArc(cx, cy, r, -90, -90 + (clamped / 100) * 180);
  return (
    <div className="inline-flex flex-col items-center flex-shrink-0" style={{ width: size }}>
      <svg width={size} height={height} viewBox={`0 0 ${size} ${height}`}>
        <path d={trackPath} fill="none" className="stroke-alabaster dark:stroke-black" strokeWidth={strokeWidth} strokeLinecap="round" />
        {clamped > 0 && <path d={valuePath} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />}
        <text x={cx} y={height - strokeWidth * 0.35} textAnchor="middle" fontSize={size * 0.24} fontWeight={800} fill={color}>
          {Math.round(clamped)}%
        </text>
      </svg>
    </div>
  );
}

function StatusPill({ status, closedAt }: { status: string; closedAt: string | null }) {
  if (status === 'launched') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold bg-[#2563eb]/10 text-[#1d4ed8] dark:text-[#93b4f5]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#2563eb] animate-pulse" />
        Campagne active
      </span>
    );
  }
  if (closedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold bg-[#0d9488]/10 text-[#0d9488] dark:text-[#5eead4]">
        <IconClock className="w-3 h-3" />
        Terminée
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold bg-alabaster text-waterloo dark:bg-black dark:text-manatee">
      Aucune campagne lancée
    </span>
  );
}

function KpiCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent: string }) {
  return (
    <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4 flex items-start gap-3">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${accent}1A`, color: accent }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wide text-waterloo dark:text-manatee mb-0.5">{label}</div>
        <div className="text-2xl font-extrabold text-black dark:text-white leading-tight">{value}</div>
      </div>
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4 flex items-start gap-3 animate-pulse">
      <div className="h-9 w-9 flex-shrink-0 rounded-lg bg-alabaster dark:bg-black" />
      <div className="min-w-0 flex-1">
        <div className="h-2.5 w-20 rounded bg-alabaster dark:bg-black mb-2" />
        <div className="h-5 w-12 rounded bg-alabaster dark:bg-black" />
      </div>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4 animate-pulse">
      <div className="flex items-center justify-between mb-3">
        <div className="h-4 w-40 rounded bg-alabaster dark:bg-black" />
        <div className="h-5 w-24 rounded-full bg-alabaster dark:bg-black" />
      </div>
      <div className="h-2 w-full rounded-full bg-alabaster dark:bg-black mb-2" />
      <div className="h-3 w-56 rounded bg-alabaster dark:bg-black" />
    </div>
  );
}

async function apiGet(path: string) {
  const res = await fetch(`${API_BASE}${path}`);
  if (res.status === 403) throw new Error('FORBIDDEN');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function CampaignsPage() {
  const { user: currentUser, loading: authLoading } = useCurrentUser();
  const authChecked = !authLoading;
  const [data, setData] = useState<{ kpis: any; projects: CampaignProjectRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'launched' | 'draft'>('all');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('recent');
  // Case "projets en retard uniquement" — avancement < 50%.
  const [lateOnly, setLateOnly] = useState(false);
  // Case "campagnes stagnantes uniquement" — active sans activité récente.
  const [stagnantOnly, setStagnantOnly] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(true);
  // Pulse discret sur les KPIs quand un refetch vient d'un événement temps
  // réel (campagne lancée/clôturée par quelqu'un d'autre) plutôt que d'un
  // chargement initial ou d'un clic sur "Actualiser".
  const [liveFlash, setLiveFlash] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet('/dashboard/po/campaigns')
      .then((d) => setData(d?.data ?? null))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (authChecked && currentUser) load();
  }, [authChecked, currentUser, load]);

  // Rejoint la room WebSocket `project:<id>` (même namespace /notifications
  // que useProjectRealtime, voir app/hooks/useProjectRealtime.ts) pour CHAQUE
  // projet listé, afin que tout ce qui fait bouger les KPIs affichés ici —
  // campagne lancée/clôturée, mais aussi exécution QA d'un cas de test
  // (réussi/échoué) ou validation d'un workflow — se reflète sans attendre
  // un rechargement manuel, peu importe qui en est l'auteur. Anti-rebond
  // (400 ms) pour coalescer une rafale d'événements (plusieurs TC exécutés
  // d'affilée) en un seul refetch. useProjectRealtime ne gère qu'un seul
  // projet à la fois, d'où cette variante multi-room dédiée à la vue liste.
  const projectIds = useMemo(() => (data?.projects ?? []).map((p) => p.projectId), [data]);
  const projectIdsKey = projectIds.join(',');
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashOffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!currentUser || projectIds.length === 0) return;
    let cancelled = false;
    let socket: Socket | null = null;

    (async () => {
      try {
        const ticket = await getWsTicket();
        if (cancelled) return;
        socket = io(`${BACKEND_WS_URL}/notifications`, { auth: { ticket }, transports: ['websocket'] });

        socket.on('connect', () => {
          for (const id of projectIds) socket?.emit('project:join', { projectId: id });
        });

        // Contrairement à useProjectRealtime (qui ignore les événements dont
        // on est l'auteur, pertinent sur analyzer/page.tsx qui a déjà son
        // propre état local à jour), cette page N'A PAS d'autre source de
        // vérité : on refetch même pour ses propres actions, sinon le PO qui
        // vient de lancer une campagne ou le QA qui vient d'exécuter un TC
        // ne verrait pas cette liste se mettre à jour tant qu'il ne la
        // recharge pas.
        const scheduleRefetch = () => {
          if (refetchTimer.current) clearTimeout(refetchTimer.current);
          refetchTimer.current = setTimeout(() => {
            load();
            setLiveFlash(true);
            flashOffTimer.current = setTimeout(() => setLiveFlash(false), 1600);
          }, 400);
        };
        const EVENTS = [
          'campaign:launched', 'campaign:closed', 'campaign:change-queued',
          'testcase:created', 'testcase:updated', 'testcase:deleted',
          'requirement:created', 'requirement:deleted',
          'module:created', 'module:deleted',
          'workflow:updated', 'workflow:run-updated',
        ];
        for (const evt of EVENTS) socket.on(evt, scheduleRefetch);
      } catch (err) {
        // Pas de temps réel disponible pour cette session — la vue reste
        // fonctionnelle via le bouton "Actualiser".
        console.error('[realtime] impossible d\u2019obtenir le ticket WebSocket:', err);
      }
    })();

    return () => {
      cancelled = true;
      for (const id of projectIds) socket?.emit('project:leave', { projectId: id });
      socket?.disconnect();
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      if (flashOffTimer.current) clearTimeout(flashOffTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, projectIdsKey, load]);

  const projects = useMemo(() => {
    let rows = (data?.projects ?? []).filter((p) =>
      filter === 'all' ? true : filter === 'launched' ? p.campaignStatus === 'launched' : p.campaignStatus !== 'launched',
    );
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      rows = rows.filter((p) => p.projectName.toLowerCase().includes(q));
    }
    if (lateOnly) {
      rows = rows.filter((p) => p.progressPct < 50);
    }
    if (stagnantOnly) {
      rows = rows.filter(isStagnant);
    }
    const sorted = [...rows];
    switch (sortKey) {
      case 'progress':
        sorted.sort((a, b) => b.progressPct - a.progressPct);
        break;
      case 'name':
        sorted.sort((a, b) => a.projectName.localeCompare(b.projectName, 'fr'));
        break;
      case 'pending':
        sorted.sort((a, b) => b.pendingChangesCount - a.pendingChangesCount);
        break;
      case 'recent':
      default:
        sorted.sort((a, b) => {
          if (a.campaignStatus === 'launched' && b.campaignStatus !== 'launched') return -1;
          if (b.campaignStatus === 'launched' && a.campaignStatus !== 'launched') return 1;
          return new Date(b.launchedAt ?? 0).getTime() - new Date(a.launchedAt ?? 0).getTime();
        });
    }
    return sorted;
  }, [data, filter, query, sortKey, lateOnly, stagnantOnly]);

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-white dark:bg-black" />
    );
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-white dark:bg-black text-center px-4">
        <p className="text-black dark:text-white font-semibold">Connectez-vous pour accéder aux campagnes.</p>
        <Link href="/auth/signin" className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-primaryho">Se connecter</Link>
      </div>
    );
  }

  if (error === 'FORBIDDEN') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-black">
        <p className="text-waterloo text-sm">Accès réservé au PO / Admin.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-white dark:bg-black text-center px-4">
        <p className="text-[#dc2626] dark:text-[#f87171] font-semibold">Erreur de chargement des campagnes.</p>
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded-full border border-stroke px-4 py-2 text-sm font-bold text-black transition-colors hover:border-primary/40 dark:border-strokedark dark:text-white">
          <IconRefresh className="w-3.5 h-3.5" /> Réessayer
        </button>
      </div>
    );
  }

  const k = data?.kpis;
  const isEmptyLoaded = !loading && projects.length === 0;

  return (
    <div className="min-h-screen bg-white dark:bg-black pt-40 pb-16 px-4 md:px-8 lg:pt-40">
      <div className="mx-auto max-w-c-1390">
        {/* En-tête */}
        <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <IconFlag className="w-4.5 h-4.5" />
              </span>
              <h1 className="text-2xl font-bold text-black dark:text-white">Campagnes de tests</h1>
            </div>
            <p className="mt-1.5 ml-[46px] text-xs font-semibold uppercase tracking-wide text-waterloo dark:text-manatee">
              Avancement global — tous les projets
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            title="Actualiser"
            className="inline-flex items-center gap-1.5 rounded-full border border-stroke px-3.5 py-2 text-xs font-bold text-black transition-colors hover:border-primary/40 disabled:opacity-50 dark:border-strokedark dark:text-white"
          >
            <IconRefresh className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualiser
          </button>
        </div>

        {/* KPIs */}
        <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 mb-2 rounded-2xl transition-shadow duration-300 ${liveFlash ? 'ring-2 ring-[#2563eb]/40' : ''}`}>
          {!k ? (
            <>
              <KpiSkeleton /><KpiSkeleton /><KpiSkeleton /><KpiSkeleton />
            </>
          ) : (
            <>
              <KpiCard icon={<IconFlag className="w-4.5 h-4.5" />} label="Campagnes actives" value={fmtNum(k.activeCampaigns)} accent="#2563eb" />
              <KpiCard icon={<IconFolder className="w-4.5 h-4.5" />} label="Projets" value={fmtNum(k.totalProjects)} accent="#475569" />
              <KpiCard icon={<IconTrendUp className="w-4.5 h-4.5" />} label="Avancement moyen" value={`${k.avgProgress}%`} accent={progressColor(k.avgProgress)} />
              <KpiCard icon={<IconAlert className="w-4.5 h-4.5" />} label="Modifications en attente" value={fmtNum(k.totalPendingChanges)} accent={k.totalPendingChanges > 0 ? '#d97706' : '#475569'} />
            </>
          )}
        </div>
        <div className="h-5 mb-1">
          {liveFlash && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#1d4ed8] dark:text-[#93b4f5]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#2563eb] animate-pulse" /> Mis à jour en direct
            </span>
          )}
        </div>
        {/* Barre d'outils : recherche + filtres + tri */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-waterloo dark:text-manatee" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher un projet…"
              className="w-full rounded-full border border-stroke bg-white dark:bg-blacksection dark:border-strokedark pl-8 pr-3 py-1.5 text-xs font-medium text-black dark:text-white placeholder:text-waterloo dark:placeholder:text-manatee focus:outline-none focus:border-primary/50"
            />
          </div>

          <div className="flex items-center gap-1.5">
            {([
              ['all', 'Tous'],
              ['launched', 'Campagne active'],
              ['draft', 'Sans campagne'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${
                  filter === key
                    ? 'bg-primary text-white'
                    : 'border border-stroke text-black hover:border-primary/40 dark:border-strokedark dark:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setLateOnly((v) => !v)}
            disabled={!data || data.projects.length === 0}
            title="Avancement inférieur à 50%"
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              lateOnly
                ? 'bg-amber-500 text-white'
                : 'border border-stroke text-black hover:border-amber-500/50 dark:border-strokedark dark:text-white'
            }`}
          >
            <IconAlert className={`w-3.5 h-3.5 ${lateOnly ? 'text-white' : 'text-amber-600 dark:text-amber-400'}`} />
            En retard
            <span className={`h-4 min-w-4 px-1 rounded-full text-[10px] font-extrabold inline-flex items-center justify-center ${
              lateOnly ? 'bg-white/25 text-white' : 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
            }`}>
              {(data?.projects ?? []).filter((p) => p.progressPct < 50).length}
            </span>
          </button>

          <button
            onClick={() => setStagnantOnly((v) => !v)}
            disabled={!data || data.projects.length === 0}
            title={`Campagne active sans exécution depuis ${STAGNANT_DAYS} jours ou plus`}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              stagnantOnly
                ? 'bg-[#dc2626] text-white'
                : 'border border-stroke text-black hover:border-[#dc2626]/50 dark:border-strokedark dark:text-white'
            }`}
          >
            <IconClock className={`w-3.5 h-3.5 ${stagnantOnly ? 'text-white' : 'text-[#dc2626]'}`} />
            Stagnantes
            <span className={`h-4 min-w-4 px-1 rounded-full text-[10px] font-extrabold inline-flex items-center justify-center ${
              stagnantOnly ? 'bg-white/25 text-white' : 'bg-[#dc2626]/15 text-[#dc2626]'
            }`}>
              {(data?.projects ?? []).filter(isStagnant).length}
            </span>
          </button>

          <div className="relative ml-auto">
            <IconSort className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-waterloo dark:text-manatee" />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="appearance-none rounded-full border border-stroke bg-white dark:bg-blacksection dark:border-strokedark pl-8 pr-7 py-1.5 text-xs font-bold text-black dark:text-white focus:outline-none focus:border-primary/50 cursor-pointer"
            >
              <option value="recent">Actives d'abord</option>
              <option value="progress">Avancement</option>
              <option value="pending">Modif. en attente</option>
              <option value="name">Nom (A → Z)</option>
            </select>
          </div>
        </div>

        {/* Liste — table sur desktop, cartes sur mobile */}
        {loading && !data ? (
          <div className="flex flex-col gap-3">
            <RowSkeleton /><RowSkeleton /><RowSkeleton />
          </div>
        ) : isEmptyLoaded ? (
          <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-10 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-alabaster dark:bg-black text-waterloo dark:text-manatee">
              <IconFolder className="w-5 h-5" />
            </div>
            <p className="text-sm font-semibold text-black dark:text-white">
              {query ? 'Aucun projet ne correspond à cette recherche.' : 'Aucun projet dans cette catégorie.'}
            </p>
          </div>
        ) : (
          <>
            {/* Vue tableau — md et plus */}
            <div className="hidden md:block rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection overflow-hidden">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-stroke dark:border-strokedark bg-alabaster/60 dark:bg-black/30">
                    <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wide text-waterloo dark:text-manatee">Projet</th>
                    <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wide text-waterloo dark:text-manatee">Statut</th>
                    <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wide text-waterloo dark:text-manatee w-[80px]">Avancement</th>
                    <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wide text-waterloo dark:text-manatee">Cas de test</th>
                    <th className="px-4 py-3 text-[10px] font-bold uppercase tracking-wide text-waterloo dark:text-manatee">Dernière activité</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr
                      key={p.projectId}
                      className="border-b last:border-b-0 border-stroke dark:border-strokedark hover:bg-alabaster/50 dark:hover:bg-black/20 transition-colors"
                    >
                      <td className="px-4 py-3.5">
                        <Link href={`/campaigns/${p.projectId}`} className="font-bold text-sm text-black dark:text-white hover:text-primary transition-colors">
                          {p.projectName}
                        </Link>
                        <div className="mt-1 flex items-center gap-2 flex-wrap">
                          {isStagnant(p) && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#dc2626]" title={`Aucune exécution depuis ${STAGNANT_DAYS}+ jours`}>
                              <IconClock className="w-3 h-3" /> Stagnante
                            </span>
                          )}
                          {p.pendingChangesCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-700 dark:text-amber-400">
                              <IconAlert className="w-3 h-3" />
                              {p.pendingChangesCount} modif. en attente
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <StatusPill status={p.campaignStatus} closedAt={p.closedAt} />
                      </td>
                      <td className="px-4 py-3.5">
                        <ProgressGauge pct={p.progressPct} color={progressColor(p.progressPct)} size={48} />
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-xs text-waterloo dark:text-manatee">
                        <span className="text-[#0d9488] font-bold">{p.testCases.passed}</span> réussi{p.testCases.passed > 1 ? 's' : ''} ·{' '}
                        <span className="text-[#dc2626] font-bold">{p.testCases.failed}</span> échoué{p.testCases.failed > 1 ? 's' : ''} ·{' '}
                        <span className="font-bold">{p.testCases.notTested}</span> restant{p.testCases.notTested > 1 ? 's' : ''}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-xs text-waterloo dark:text-manatee">
                        {p.campaignStatus === 'launched' ? `Lancée le ${fmtDate(p.launchedAt)}` : p.closedAt ? `Clôturée le ${fmtDate(p.closedAt)}` : '—'}
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <Link href={`/campaigns/${p.projectId}`} className="inline-flex text-waterloo hover:text-primary transition-colors">
                          <IconChevronRight className="w-4 h-4" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Vue cartes — mobile */}
            <div className="flex md:hidden flex-col gap-3">
              {projects.map((p) => (
                <Link
                  key={p.projectId}
                  href={`/campaigns/${p.projectId}`}
                  className="block rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4 hover:border-primary/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                    <span className="text-sm font-bold text-black dark:text-white">{p.projectName}</span>
                    <StatusPill status={p.campaignStatus} closedAt={p.closedAt} />
                  </div>
                  <div className="flex items-center gap-3">
                    <ProgressGauge pct={p.progressPct} color={progressColor(p.progressPct)} size={56} />
                    <div className="flex flex-col gap-1 text-[11px] text-waterloo dark:text-manatee">
                      <span>{p.testCases.passed} réussi · {p.testCases.failed} échoué · {p.testCases.notTested} non testé</span>
                      {isStagnant(p) && (
                        <span className="inline-flex items-center gap-1 font-bold text-[#dc2626] w-fit">
                          <IconClock className="w-3 h-3" /> Stagnante
                        </span>
                      )}
                      {p.pendingChangesCount > 0 && (
                        <span className="inline-flex items-center gap-1 font-bold text-amber-700 dark:text-amber-400 w-fit">
                          <IconAlert className="w-3 h-3" /> {p.pendingChangesCount} modif. en attente
                        </span>
                      )}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}

        {/* Comparaison entre projets — vue d'ensemble classée par avancement,
            indépendante des filtres/tri du tableau ci-dessous. */}
        {data && data.projects.length > 1 && (
          <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-5 mb-6">
            <button onClick={() => setComparisonOpen((v) => !v)} className="w-full flex items-center justify-between">
              <span className="inline-flex items-center gap-2 text-sm font-bold text-black dark:text-white">
                <IconTrendUp className="w-4 h-4 text-waterloo dark:text-manatee" />
                Comparaison entre projets
              </span>
              <IconChevronDown className={`w-4 h-4 text-waterloo dark:text-manatee transition-transform ${comparisonOpen ? 'rotate-180' : ''}`} />
            </button>
            {comparisonOpen && (() => {
              const sorted = [...data.projects].sort((a, b) => b.progressPct - a.progressPct);
              const CHART_H = 110;
              return (
                <div className="mt-4 overflow-x-auto">
                  <div className="flex" style={{ minWidth: sorted.length * 36 + 28 }}>
                    {/* Axe Y (0/25/50/75/100%) + grille horizontale */}
                    <div className="relative flex-shrink-0" style={{ width: 24, height: CHART_H }}>
                      {[0, 25, 50, 75, 100].map((g) => (
                        <span key={g} className="absolute -translate-y-1/2 text-[9px] font-bold text-waterloo dark:text-manatee" style={{ bottom: `${g}%`, right: 4 }}>
                          {g}
                        </span>
                      ))}
                    </div>
                    {/* Colonnes */}
                    <div className="relative flex-1 flex items-end gap-1.5 border-l border-b border-stroke dark:border-strokedark" style={{ height: CHART_H }}>
                      {[0, 25, 50, 75, 100].map((g) => (
                        <div key={g} className="absolute left-0 right-0 border-t border-dashed border-stroke/60 dark:border-strokedark/60 pointer-events-none" style={{ bottom: `${g}%` }} />
                      ))}
                      {sorted.map((p) => {
                        const color = progressColor(p.progressPct);
                        const pct = Math.min(Math.max(p.progressPct, 0), 100);
                        return (
                          <Link
                            key={p.projectId}
                            href={`/campaigns/${p.projectId}`}
                            className="relative flex-1 min-w-[24px] max-w-[36px] h-full flex flex-col items-center justify-end group"
                          >
                            {/* Bulle au survol — nom complet, jamais tronqué ; ne dépend pas
                                de l'info-bulle native du navigateur (délai, parfois masquée). */}
                            <span className="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-black/90 dark:bg-white/90 px-2 py-1 text-[10px] font-bold text-white dark:text-black opacity-0 group-hover:opacity-100 transition-opacity z-10">
                              {p.projectName}
                            </span>
                            <span className="text-[9px] font-extrabold mb-0.5" style={{ color }}>{p.progressPct}%</span>
                            <div
                              className="w-full rounded-t-sm transition-all group-hover:opacity-80"
                              style={{ height: `${pct}%`, backgroundColor: color, minHeight: pct > 0 ? 2 : 0 }}
                            />
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                  {/* Libellés d'axe X — alignés avec les colonnes ci-dessus */}
                  <div className="flex" style={{ minWidth: sorted.length * 36 + 28 }}>
                    <div style={{ width: 24 }} />
                    <div className="flex-1 flex gap-1.5">
                      {sorted.map((p) => (
                        <Link
                          key={p.projectId}
                          href={`/campaigns/${p.projectId}`}
                          className="relative flex-1 min-w-[24px] max-w-[36px] text-center hover:text-primary transition-colors group"
                        >
                          <span className="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-black/90 dark:bg-white/90 px-2 py-1 text-[10px] font-bold text-white dark:text-black opacity-0 group-hover:opacity-100 transition-opacity z-10">
                            {p.projectName}
                          </span>
                          <span className="block text-[9px] text-waterloo dark:text-manatee truncate mt-1">{p.projectName}</span>
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

      </div>
    </div>
  );
}