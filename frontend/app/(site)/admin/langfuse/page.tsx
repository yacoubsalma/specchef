'use client';

import { useState, useEffect, useCallback, Fragment, type ReactNode } from 'react';

const API_BASE = '/api/backend';

type Role = 'ADMIN' | 'QA' | 'BA' | 'PO';

interface CurrentUser {
  id?: string;
  email?: string;
  name?: string;
  role?: Role;
}

type TabId = 'overview' | 'history' | 'quality';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Aperçu' },
  { id: 'history', label: 'Historique' },
  { id: 'quality', label: 'Qualité' },
];

function Spinner() {
  return <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />;
}

// ─── Squelettes de chargement (plus agréables qu'un simple spinner) ─────────
function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-alabaster dark:bg-blacksection ${className}`} />;
}

function SkeletonChartCard() {
  return (
    <div className="rounded-2xl border border-stroke dark:border-strokedark p-5">
      <SkeletonBlock className="h-4 w-32 mb-1" />
      <SkeletonBlock className="h-3 w-48 mb-4" />
      <SkeletonBlock className="h-32 w-full" />
    </div>
  );
}

function SkeletonTable({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-2xl border border-stroke dark:border-strokedark overflow-hidden">
      <div className="bg-alabaster dark:bg-blacksection h-10" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 px-5 py-3.5 border-t border-stroke dark:border-strokedark">
          {Array.from({ length: cols }).map((_, j) => (
            <SkeletonBlock key={j} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

function fmtDate(v?: string) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return v;
  }
}

function fmtDayShort(v?: string) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  } catch {
    return v;
  }
}

// Étiquette d'un bucket, adaptée à la granularité renvoyée par le backend :
// "14h" pour un bucket horaire (période "Aujourd'hui"), "16/07" pour un bucket journalier.
function fmtBucketLabel(v?: string, granularity: 'hour' | 'day' = 'day') {
  if (!v) return '—';
  try {
    if (granularity === 'hour') return new Date(v).toLocaleTimeString('fr-FR', { hour: '2-digit' });
    return fmtDayShort(v);
  } catch {
    return v;
  }
}

function fmtMs(v?: number | null) {
  if (v === null || v === undefined) return '—';
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtCost(v?: number | null) {
  if (v === null || v === undefined) return '—';
  return `$${v < 0.01 && v > 0 ? v.toFixed(5) : v.toFixed(4)}`;
}

function fmtNum(v?: number | null) {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('fr-FR');
}

// Affichage compact des tokens (12,3k / 1,2M) avec la valeur exacte au survol (title)
function fmtTokens(v?: number | null) {
  if (v === null || v === undefined) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`;
  if (v >= 1_000) return `${(v / 1_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k`;
  return v.toLocaleString('fr-FR');
}

// Détaille les tokens entrée/sortie quand ils sont disponibles (utilisé en title / tooltip)
function tokensDetail(t: any): string | undefined {
  const inTok = t.promptTokens ?? t.inputTokens ?? t.usage?.input;
  const outTok = t.completionTokens ?? t.outputTokens ?? t.usage?.output;
  const total = t.totalTokens ?? t.usage?.total;
  const parts: string[] = [];
  if (total !== undefined && total !== null) parts.push(`${fmtNum(total)} tokens au total`);
  if (inTok !== undefined && inTok !== null) parts.push(`${fmtNum(inTok)} en entrée`);
  if (outTok !== undefined && outTok !== null) parts.push(`${fmtNum(outTok)} en sortie`);
  return parts.length ? parts.join(' · ') : undefined;
}

// Période couverte par les données (pour afficher dates/durée en haut du tableau de bord)
function periodRangeLabel(daily?: { date: string }[], granularity: 'hour' | 'day' = 'day'): string | null {
  if (!daily || daily.length === 0) return null;
  const start = daily[0]?.date;
  const end = daily[daily.length - 1]?.date;
  if (!start || !end) return null;
  if (granularity === 'hour') {
    return `${fmtBucketLabel(start, 'hour')} → ${fmtBucketLabel(end, 'hour')} · aujourd'hui`;
  }
  const days = daily.length;
  return `${fmtDayShort(start)} → ${fmtDayShort(end)} (${days} jour${days > 1 ? 's' : ''})`;
}

function truncate(s: string | undefined | null, n = 48) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ─── Fetch helper commun ────────────────────────────────────────────────────
async function apiGet(path: string, params?: Record<string, string | number | undefined>) {
  const qs = params
    ? '?' + Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
    : '';
  const res = await fetch(`${API_BASE}/admin/langfuse${path}${qs}`);
  if (res.status === 403) throw new Error('FORBIDDEN');
  if (res.status === 503) throw new Error('NOT_CONFIGURED');
  if (res.status === 429) throw new Error('RATE_LIMITED');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── KPI Card ───────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }) {
  const accents: Record<string, string> = {
    neutral: 'bg-white dark:bg-blacksection border-stroke dark:border-strokedark text-black dark:text-white',
    info: 'bg-white dark:bg-blacksection border-stroke dark:border-strokedark text-black dark:text-white border-l-4 border-l-[#7B93EB] dark:border-l-[#93A9F0]',
    success: 'bg-white dark:bg-blacksection border-stroke dark:border-strokedark text-black dark:text-white border-l-4 border-l-[#4169E1]/80 dark:border-l-[#6C8EEF]',
    warning: 'bg-white dark:bg-blacksection border-stroke dark:border-strokedark text-black dark:text-white border-l-4 border-l-[#27408B]/80 dark:border-l-[#4169E1]',
    danger: 'bg-white dark:bg-blacksection border-stroke dark:border-strokedark text-black dark:text-white border-l-4 border-l-red-600/70 dark:border-l-red-500/70',
  };
  return (
    <div className={`rounded-2xl border p-3.5 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200 ${accents[accent ?? 'neutral']}`}>
      <div className="text-xl font-bold truncate tracking-tight">{value}</div>
      <div className="text-[11px] font-semibold text-waterloo dark:text-manatee mt-0.5 leading-tight">{label}</div>
      {sub && <div className="text-[9px] text-waterloo/70 dark:text-manatee/70 mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Carte de graphique unifiée (icône + titre + sous-titre) ────────────────
function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-stroke dark:border-strokedark p-4 hover:shadow-sm transition-shadow duration-200">
      <h3 className="text-sm font-bold text-black dark:text-white mb-0.5">{title}</h3>
      <p className="text-[11px] text-waterloo mb-2">{subtitle}</p>
      {children}
    </div>
  );
}

// ─── Barre "dernière actualisation" + bouton refresh, en haut de chaque onglet ─
function UpdatedBar({ onRefresh, loading }: { onRefresh: () => void; loading?: boolean }) {
  const [updatedAt, setUpdatedAt] = useState<string>('');
  useEffect(() => {
    if (!loading) setUpdatedAt(new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
  }, [loading]);
  return (
    <div className="flex items-center justify-end gap-2 mb-4 -mt-1">
      {updatedAt && <span className="text-[10px] text-waterloo/70">Actualisé à {updatedAt}</span>}
      <button
        onClick={onRefresh}
        disabled={loading}
        className="text-[10px] font-bold text-waterloo hover:text-primary transition-all disabled:opacity-40 underline underline-offset-2"
      >
        Actualiser
      </button>
    </div>
  );
}

// ─── Lien discret vers la trace Langfuse (détail technique, pas mis en avant) ─
function ExternalTraceLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Voir le détail technique complet"
      className="inline-flex items-center justify-center w-6 h-6 rounded-full text-waterloo hover:text-primary hover:bg-zumthor dark:hover:bg-primary/10 transition-all"
    >
      ↗
    </a>
  );
}

// ─── Graphique en barres verticales (volume / jour) ─────────────────────────
function DailyVolumeChart({ data, granularity = 'day' }: { data: { date: string; count: number; cost: number }[]; granularity?: 'hour' | 'day' }) {
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { setHover(null); }, [data]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);
  if (!data || data.length === 0) {
    return <p className="text-xs text-waterloo text-center py-10">Pas encore assez de données pour un graphique.</p>;
  }
  const max = Math.max(...data.map((d) => d.count), 1);
  // 24 barres horaires ("Aujourd'hui") ont besoin de moins d'espace par barre
  // que 7/30 barres journalières, sinon la rangée déborde du conteneur.
  const dense = data.length > 14;
  return (
    <div className="relative">
      {hover !== null && data[hover] && (
        <div
          className="absolute -top-1 px-2.5 py-1.5 rounded-lg bg-black dark:bg-white text-white dark:text-black text-[10px] font-semibold shadow-lg pointer-events-none whitespace-nowrap z-10 -translate-x-1/2 -translate-y-full"
          style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}
        >
          {fmtBucketLabel(data[hover].date, granularity)} · {data[hover].count} fois · {fmtCost(data[hover].cost)}
        </div>
      )}
      <div className={`flex items-end h-40 px-1 ${dense ? 'gap-0.5' : 'gap-2'}`}>
        {data.map((d, i) => (
          <div
            key={d.date}
            className="flex-1 min-w-0 flex flex-col items-center gap-1.5"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div className="w-full flex items-end justify-center" style={{ height: 112 }}>
              <div
                className={`w-full ${dense ? 'max-w-[10px]' : 'max-w-[26px]'} rounded-t-md transition-all ease-out ${hover === i ? 'bg-[#082a8a]' : 'bg-[#0a38b8]/90'}`}
                style={{
                  height: mounted ? `${Math.max((d.count / max) * 100, 4)}%` : '0%',
                  transitionProperty: 'height, background-color',
                  transitionDuration: '600ms',
                  transitionDelay: `${i * 30}ms`,
                }}
              />
            </div>
            {/* En mode dense (24 barres horaires), on n'affiche qu'une étiquette sur 3 pour éviter que le texte se chevauche */}
            <span className={`text-[10px] whitespace-nowrap transition-colors ${hover === i ? 'text-[#0a38b8] dark:text-[#7B93EB] font-bold' : 'text-waterloo'} ${dense && i % 3 !== 0 ? 'invisible' : ''}`}>{fmtBucketLabel(d.date, granularity)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Graphique en barres horizontales (coût par modèle) ─────────────────────
function CostByModelChart({ data }: { data: { model: string; count: number; cost: number; tokens: number }[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);
  if (!data || data.length === 0) {
    return <p className="text-xs text-waterloo text-center py-10">Aucune donnée de coût disponible.</p>;
  }
  const max = Math.max(...data.map((d) => d.cost), 0.0001);
  return (
    <div className="space-y-3">
      {data.slice(0, 6).map((d, i) => (
        <div key={d.model} className="group">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="font-semibold text-black dark:text-white">{d.model}</span>
            <span className="text-waterloo">{fmtCost(d.cost)} · {fmtNum(d.count)} appel(s)</span>
          </div>
          <div className="h-2 rounded-full bg-alabaster dark:bg-blacksection overflow-hidden">
            <div
              className="h-full rounded-full bg-[#4169E1]/75 group-hover:bg-[#27408B] transition-colors ease-out"
              style={{
                width: mounted ? `${Math.max((d.cost / max) * 100, 3)}%` : '0%',
                transitionProperty: 'width, background-color',
                transitionDuration: '600ms',
                transitionDelay: `${i * 60}ms`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Graphique en courbe (tendance dans le temps) ────────────────────────────
function LineChart({
  data, valueKey, color = '#4169E1', formatValue, height = 140, granularity = 'day',
}: {
  data: Record<string, any>[];
  valueKey: string;
  color?: string;
  formatValue?: (v: number) => string;
  height?: number;
  granularity?: 'hour' | 'day';
}) {
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { setHover(null); }, [data]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);
  if (!data || data.length === 0) {
    return <p className="text-xs text-waterloo text-center py-10">Pas encore assez de données.</p>;
  }
  const values = data.map((d) => Number(d[valueKey]) || 0);
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const w = 100; // viewBox width en %, points calculés en pourcentage
  const points = values.map((v, i) => {
    const x = data.length === 1 ? 50 : (i / (data.length - 1)) * w;
    const y = 100 - ((v - min) / range) * 90 - 5; // marge 5% haut/bas
    return { x, y, v, date: data[i].date };
  });
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaD = `${pathD} L ${points[points.length - 1].x} 100 L ${points[0].x} 100 Z`;
  // Longueur exacte du tracé (segments de droites) pour l'animation "dessin" de la courbe
  const pathLength = points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0) || 1;

  return (
    <div className="relative">
      {hover !== null && points[hover] && (
        <div
          className="absolute px-2.5 py-1.5 rounded-lg bg-black dark:bg-white text-white dark:text-black text-[10px] font-semibold shadow-lg pointer-events-none whitespace-nowrap z-10 -translate-x-1/2"
          style={{ left: `${points[hover].x}%`, top: `${Math.max(points[hover].y - 14, 0)}%` }}
        >
          {fmtBucketLabel(points[hover].date, granularity)} · {formatValue ? formatValue(points[hover].v) : points[hover].v}
        </div>
      )}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height }} className="overflow-visible">
        <path
          d={areaD}
          fill={color}
          opacity={mounted ? 0.08 : 0}
          style={{ transition: 'opacity 500ms ease-out', transitionDelay: '500ms' }}
        />
        <path
          d={pathD}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          strokeDasharray={pathLength}
          strokeDashoffset={mounted ? 0 : pathLength}
          style={{ transition: 'stroke-dashoffset 700ms ease-out' }}
        />
        {points.map((p, i) => (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            {/* Zone de survol invisible plus large que le point visible, pour faciliter le hover */}
            <circle cx={p.x} cy={p.y} r={4} fill="transparent" />
            <circle
              cx={p.x} cy={p.y}
              r={hover === i ? 2.2 : 1.4}
              fill={color}
              vectorEffect="non-scaling-stroke"
              opacity={mounted ? 1 : 0}
              style={{ transition: 'opacity 300ms ease-out, r 150ms ease-out', transitionDelay: mounted ? `${700 + i * 15}ms` : '0ms' }}
            />
          </g>
        ))}
      </svg>
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-waterloo">{fmtBucketLabel(data[0]?.date, granularity)}</span>
        <span className="text-[10px] text-waterloo">{fmtBucketLabel(data[data.length - 1]?.date, granularity)}</span>
      </div>
    </div>
  );
}


// ─── Graphique en anneau (répartition par modèle) ────────────────────────────
function DonutChart({ data }: { data: { model: string; count: number }[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 30);
    return () => clearTimeout(t);
  }, []);
  if (!data || data.length === 0) {
    return <p className="text-xs text-waterloo text-center py-10">Aucune donnée.</p>;
  }
  const COLORS = ['#0426a3', '#4169E1', '#6C8EEF', '#0a38b8', '#7B93EB', '#1646d6', '#93A9F0'];
  const total = data.reduce((sum, d) => sum + d.count, 0) || 1;
  const radius = 15.9155; // rayon donnant une circonférence de 100 (facilite les % en dasharray)
  let cumulative = 0;
  const segments = data.slice(0, 7).map((d, i) => {
    const pct = (d.count / total) * 100;
    const dashArray = `${pct} ${100 - pct}`;
    const dashOffset = 25 - cumulative; // départ en haut (12h)
    cumulative += pct;
    return { ...d, pct, dashArray, dashOffset, color: COLORS[i % COLORS.length] };
  });

  return (
    <div className="flex items-center gap-6 flex-wrap">
      <svg viewBox="0 0 42 42" style={{ width: 140, height: 140 }}>
        <circle cx="21" cy="21" r={radius} fill="transparent" stroke="#e5e7eb" strokeWidth="6" />
        {segments.map((s, i) => (
          <circle
            key={s.model}
            cx="21" cy="21" r={radius}
            fill="transparent"
            stroke={s.color}
            strokeWidth={hover === s.model ? 7.5 : 6}
            strokeDasharray={mounted ? s.dashArray : `0 100`}
            strokeDashoffset={s.dashOffset}
            opacity={hover && hover !== s.model ? 0.35 : 1}
            style={{
              transitionProperty: 'stroke-dasharray, stroke-width, opacity',
              transitionDuration: '700ms, 150ms, 150ms',
              transitionDelay: mounted ? `${i * 80}ms` : '0ms',
              transitionTimingFunction: 'ease-out',
              cursor: 'pointer',
            }}
            onMouseEnter={() => setHover(s.model)}
            onMouseLeave={() => setHover(null)}
          >
            <title>{`${s.model} — ${fmtNum(s.count)} (${s.pct.toFixed(1)}%)`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex flex-col gap-1.5">
        {segments.map((s) => (
          <div
            key={s.model}
            className="flex items-center gap-2 text-xs rounded-md px-1.5 py-0.5 -mx-1.5 cursor-pointer transition-colors"
            style={{ opacity: hover && hover !== s.model ? 0.4 : 1, background: hover === s.model ? 'rgba(60,80,224,0.08)' : 'transparent' }}
            onMouseEnter={() => setHover(s.model)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: s.color }} />
            <span className="font-semibold text-black dark:text-white">{s.model}</span>
            {/* Nombre brut d'appels en plus du % : ce graphique doit maintenant porter à lui seul toutes les données (fusion avec l'ancien "Nombre d'appels par modèle") */}
            <span className="text-waterloo">{fmtNum(s.count)} appel(s) · {s.pct.toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Erreur / états communs ────────────────────────────────────────────────
function TabError({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error === 'FORBIDDEN') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[30vh] gap-3 text-center">
        <p className="text-waterloo text-sm">Accès refusé.</p>
      </div>
    );
  }
  if (error === 'NOT_CONFIGURED') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[30vh] gap-3 text-center">
        <p className="text-waterloo text-sm">Le monitoring IA n’est pas encore configuré côté serveur.</p>
      </div>
    );
  }
  if (error === 'RATE_LIMITED') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[30vh] gap-4 text-center">
        <p className="text-waterloo text-sm">Trop de demandes envoyées d’un coup. Patiente quelques secondes puis réessaie.</p>
        <button onClick={onRetry} className="px-5 py-2.5 rounded-full border border-primary/40 text-primary text-sm font-bold hover:bg-zumthor transition-all">Réessayer</button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center min-h-[30vh] gap-4 text-center">
      <p className="text-waterloo text-sm">Impossible de récupérer les données pour le moment.</p>
      <button onClick={onRetry} className="px-5 py-2.5 rounded-full border border-primary/40 text-primary text-sm font-bold hover:bg-zumthor transition-all">Réessayer</button>
    </div>
  );
}

function Pagination({ page, hasMore, onPrev, onNext }: { page: number; hasMore: boolean; onPrev: () => void; onNext: () => void }) {
  return (
    <div className="flex items-center justify-center gap-3 mt-5">
      <button onClick={onPrev} disabled={page <= 1} className="px-4 py-2 rounded-full border border-stroke dark:border-strokedark text-xs font-bold text-waterloo hover:text-black dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all">← Précédent</button>
      <span className="text-xs font-bold text-waterloo">Page {page}</span>
      <button onClick={onNext} disabled={!hasMore} className="px-4 py-2 rounded-full border border-stroke dark:border-strokedark text-xs font-bold text-waterloo hover:text-black dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all">Suivant →</button>
    </div>
  );
}

// ─── Onglet: Aperçu ─────────────────────────────────────────────────────────
type OverviewPeriod = 'today' | 'week' | 'month';
const PERIOD_OPTIONS: { id: OverviewPeriod; label: string }[] = [
  { id: 'today', label: "Aujourd'hui" },
  { id: 'week', label: '7 jours' },
  { id: 'month', label: '30 jours' },
];

function OverviewTab({ baseUrl }: { baseUrl: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<OverviewPeriod>('week');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet('/overview', { period })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return (
      <div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-stroke dark:border-strokedark p-4">
              <SkeletonBlock className="h-6 w-14 mb-2" />
              <SkeletonBlock className="h-3 w-20" />
            </div>
          ))}
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 my-4"><SkeletonChartCard /><SkeletonChartCard /><SkeletonChartCard /></div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4"><SkeletonChartCard /><SkeletonChartCard /><SkeletonChartCard /></div>
        <SkeletonTable rows={4} cols={6} />
      </div>
    );
  }
  if (error) return <TabError error={error} onRetry={load} />;
  if (!data) return null;

  return (
    <div className="animate-[fadeIn_0.25s_ease]">
      <div className="flex items-center justify-between gap-3 -mt-1 mb-2 flex-wrap">
        {/* Sélecteur de période : pilote la vraie fenêtre calendaire envoyée au backend (today/week/month) */}
        <div className="inline-flex rounded-full border border-stroke dark:border-strokedark p-0.5 bg-white dark:bg-blacksection">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setPeriod(opt.id)}
              disabled={loading}
              className={`px-3.5 py-1.5 rounded-full text-[11px] font-bold transition-all disabled:opacity-50 ${
                period === opt.id
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-waterloo hover:text-black dark:hover:text-white'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <UpdatedBar onRefresh={load} loading={loading} />
      </div>

      {/* Période couverte par les chiffres ci-dessous : dates + durée, demandée pour situer les cases en haut */}
      {periodRangeLabel(data.dailyVolume, data.granularity) && (
        <p className="text-[10px] font-semibold text-waterloo/80 dark:text-manatee/80 -mt-2 mb-3">
          Période analysée : {periodRangeLabel(data.dailyVolume, data.granularity)} · {fmtNum(data.totalTracesInPage)} utilisation{data.totalTracesInPage > 1 ? 's' : ''} sur cette période
        </p>
      )}

      {/* Toutes les métriques clés dans une seule rangée pour tout voir sans défiler */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-4">
        <KpiCard label="Appels au modèle IA" value={fmtNum(data.totalTracesInPage)} accent="info" sub={PERIOD_OPTIONS.find((p) => p.id === data.period)?.label ?? 'période sélectionnée'} />
        {data.granularity === 'hour' && (
          <KpiCard
            label="Appels cette heure"
            value={fmtNum(data.dailyVolume?.[data.dailyVolume.length - 1]?.count ?? 0)}
            accent="info"
            sub="heure en cours"
          />
        )}
        <KpiCard label="Coût estimé" value={fmtCost(data.estimatedCostOnSample)} accent="success" sub="sur cet échantillon" />
        <KpiCard label="Temps de réponse moyen" value={fmtMs(data.avgLatencyMsOnSample)} accent="neutral" sub="sur cet échantillon" />
        <KpiCard
          label="Erreurs"
          value={fmtNum(data.errorCountOnSample)}
          accent={data.errorCountOnSample > 0 ? 'danger' : 'success'}
          sub={data.errorCountOnSample > 0 ? 'à vérifier' : 'aucune détectée sur cet échantillon'}
        />
        <KpiCard label="Habituel" value={fmtMs(data.latencyPercentiles?.p50)} accent="neutral" sub="cas normal (médiane)" />
        <KpiCard label="Occasionnel" value={fmtMs(data.latencyPercentiles?.p90)} accent="warning" sub="un peu plus lent" />
        <KpiCard label="Exceptionnel" value={fmtMs(data.latencyPercentiles?.p99)} accent="danger" sub="le cas le plus lent observé" />
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
        <ChartCard title={data.granularity === 'hour' ? 'Utilisation par heure' : 'Utilisation par jour'} subtitle={data.granularity === 'hour' ? "Nombre de fois par heure" : 'Nombre de fois par jour'}>
          <DailyVolumeChart data={data.dailyVolume ?? []} granularity={data.granularity} />
        </ChartCard>
        <ChartCard title={data.granularity === 'hour' ? 'Coût par heure' : 'Coût par jour'} subtitle={data.granularity === 'hour' ? 'Dépense par heure' : 'Dépense par jour'}>
          <LineChart data={data.dailyVolume ?? []} valueKey="cost" color="#6C8EEF" formatValue={(v) => fmtCost(v)} height={110} granularity={data.granularity} />
        </ChartCard>
        <ChartCard title={data.granularity === 'hour' ? 'Rapidité par heure' : 'Rapidité par jour'} subtitle="Temps de réponse moyen">
          <LineChart data={data.dailyVolume ?? []} valueKey="avgLatencyMs" color="#0ea5e9" formatValue={(v) => fmtMs(v)} height={110} granularity={data.granularity} />
        </ChartCard>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
        <ChartCard title="Tokens utilisés" subtitle={data.granularity === 'hour' ? 'Texte échangé par heure' : 'Texte échangé par jour'}>
          <LineChart data={data.dailyTokens ?? []} valueKey="tokens" color="#0891b2" formatValue={(v) => fmtTokens(v)} height={110} granularity={data.granularity} />
        </ChartCard>
        <ChartCard title="Appels par modèle" subtitle="Volume et part de chaque modèle">
          <DonutChart data={data.costByModel ?? []} />
        </ChartCard>
        <ChartCard title="Coût par IA utilisée" subtitle="Quelle IA coûte le plus">
          <CostByModelChart data={data.costByModel ?? []} />
        </ChartCard>
      </div>

      <h3 className="text-sm font-bold text-black dark:text-white mb-2">Utilisations récentes</h3>
      <div className="overflow-auto max-h-72 rounded-2xl border border-stroke dark:border-strokedark">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="bg-alabaster dark:bg-blacksection text-left text-xs font-bold text-waterloo uppercase">
              <th className="px-5 py-2.5">Élément généré</th>
              <th className="px-5 py-2.5">Date</th>
              <th className="px-5 py-2.5">Durée</th>
              <th className="px-5 py-2.5">Tokens</th>
              <th className="px-5 py-2.5">Coût</th>
              <th className="px-5 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {(data.recentTraces ?? []).map((t: any, i: number) => (
              <tr key={t.id} className={`border-t border-stroke dark:border-strokedark hover:bg-alabaster/60 dark:hover:bg-blacksection/60 transition-colors ${i % 2 === 1 ? 'bg-alabaster/30 dark:bg-blacksection/30' : ''}`}>
                <td className="px-5 py-2.5 font-semibold text-black dark:text-white">{truncate(t.name ?? t.id, 40)}</td>
                <td className="px-5 py-2.5 text-waterloo">{fmtDate(t.timestamp)}</td>
                <td className="px-5 py-2.5 text-waterloo">{fmtMs(t.latency)}</td>
                <td className="px-5 py-2.5 text-waterloo cursor-help" title={tokensDetail(t)}>{fmtTokens(t.totalTokens)}</td>
                <td className="px-5 py-2.5 text-waterloo">{fmtCost(t.totalCost ?? t.calculatedTotalCost)}</td>
                <td className="px-5 py-2.5 text-right">
                  <ExternalTraceLink href={`${baseUrl}/project/${t.projectId ?? ''}/traces/${t.id}`} />
                </td>
              </tr>
            ))}
            {(!data.recentTraces || data.recentTraces.length === 0) && (
              <tr><td colSpan={6} className="px-5 py-8 text-center text-waterloo text-sm">Aucune génération récente</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Onglet: Historique ─────────────────────────────────────────────────────
function HistoryTab({ baseUrl }: { baseUrl: string }) {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<any[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const limit = 20;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet('/traces', { page, limit, orderBy: 'timestamp.desc' })
      .then((d) => {
        setItems(d?.data ?? []);
        const total = d?.meta?.totalItems ?? 0;
        setHasMore(page * limit < total);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = (id: string) => {
    if (expanded === id) { setExpanded(null); setDetail(null); return; }
    setExpanded(id);
    setDetail(null);
    setDetailLoading(true);
    apiGet(`/traces/${id}`).then(setDetail).catch(() => setDetail({ error: true })).finally(() => setDetailLoading(false));
  };

  if (loading && items.length === 0) return <div><SkeletonTable rows={6} cols={6} /></div>;
  if (error) return <TabError error={error} onRetry={load} />;

  return (
    <div className="animate-[fadeIn_0.25s_ease]">
      <div className="flex items-center justify-between mb-4 -mt-1 flex-wrap gap-2">
        <p className="text-xs text-waterloo">Chaque ligne correspond à une fois où l'IA a été utilisée. Clique dessus pour voir ce qui a été demandé et ce qui a été produit.</p>
        <UpdatedBar onRefresh={load} loading={loading} />
      </div>
      <div className="overflow-x-auto rounded-2xl border border-stroke dark:border-strokedark">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-alabaster dark:bg-blacksection text-left text-xs font-bold text-waterloo uppercase">
              <th className="px-5 py-3 w-6"></th>
              <th className="px-5 py-3">Élément généré</th>
              <th className="px-5 py-3">Date</th>
              <th className="px-5 py-3">Durée</th>
              <th className="px-5 py-3">Tokens</th>
              <th className="px-5 py-3">Coût</th>
              <th className="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((t: any, i: number) => (
              <Fragment key={t.id}>
                <tr
                  className={`border-t border-stroke dark:border-strokedark hover:bg-alabaster/60 dark:hover:bg-blacksection/60 cursor-pointer transition-colors ${i % 2 === 1 && expanded !== t.id ? 'bg-alabaster/30 dark:bg-blacksection/30' : ''} ${expanded === t.id ? 'bg-zumthor/40 dark:bg-primary/5' : ''}`}
                  onClick={() => toggleExpand(t.id)}
                >
                  <td className="px-5 py-3">
                    <span className={`inline-block text-waterloo transition-transform ${expanded === t.id ? 'rotate-90 text-primary' : ''}`}>›</span>
                  </td>
                  <td className="px-5 py-3 font-semibold text-black dark:text-white">{truncate(t.name ?? t.id, 36)}</td>
                  <td className="px-5 py-3 text-waterloo">{fmtDate(t.timestamp)}</td>
                  <td className="px-5 py-3 text-waterloo">{fmtMs(t.latency)}</td>
                  <td className="px-5 py-3 text-waterloo cursor-help" title={tokensDetail(t)}>{fmtTokens(t.totalTokens)}</td>
                  <td className="px-5 py-3 text-waterloo">{fmtCost(t.totalCost ?? t.calculatedTotalCost)}</td>
                  <td className="px-5 py-3 text-right">
                    <ExternalTraceLink href={`${baseUrl}/project/${t.projectId ?? ''}/traces/${t.id}`} />
                  </td>
                </tr>
                {expanded === t.id && (
                  <tr className="border-t border-stroke dark:border-strokedark bg-alabaster/40 dark:bg-blacksection/40">
                    <td colSpan={7} className="px-5 py-4">
                      {detailLoading ? (
                        <div className="flex items-center gap-2 text-waterloo text-xs"><Spinner /> Chargement...</div>
                      ) : detail?.error ? (
                        <p className="text-xs text-red-500">Impossible de charger le détail.</p>
                      ) : (
                        <div className="grid md:grid-cols-2 gap-4 text-xs">
                          <div>
                            <div className="font-bold text-black dark:text-white mb-1">Ce qui a été demandé</div>
                            <pre className="whitespace-pre-wrap break-words bg-white dark:bg-black rounded-lg p-3 border border-stroke dark:border-strokedark max-h-60 overflow-y-auto">{typeof detail?.input === 'string' ? detail.input : JSON.stringify(detail?.input, null, 2)}</pre>
                          </div>
                          <div>
                            <div className="font-bold text-black dark:text-white mb-1">Ce qui a été produit</div>
                            <pre className="whitespace-pre-wrap break-words bg-white dark:bg-black rounded-lg p-3 border border-stroke dark:border-strokedark max-h-60 overflow-y-auto">{typeof detail?.output === 'string' ? detail.output : JSON.stringify(detail?.output, null, 2)}</pre>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={7} className="px-5 py-8 text-center text-waterloo text-sm">Aucune génération</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} hasMore={hasMore} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
    </div>
  );
}

// ─── Onglet: Qualité ────────────────────────────────────────────────────────
function QualityTab() {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<any[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const limit = 20;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiGet('/scores', { page, limit })
      .then((d) => {
        setItems(d?.data ?? []);
        const total = d?.meta?.totalItems ?? 0;
        setHasMore(page * limit < total);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => { load(); }, [load]);

  if (loading && items.length === 0) return <div><SkeletonTable rows={4} cols={3} /></div>;
  if (error) return <TabError error={error} onRetry={load} />;

  return (
    <div className="animate-[fadeIn_0.25s_ease]">
      <div className="flex justify-end"><UpdatedBar onRefresh={load} loading={loading} /></div>
      <div className="overflow-x-auto rounded-2xl border border-stroke dark:border-strokedark">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-alabaster dark:bg-blacksection text-left text-xs font-bold text-waterloo uppercase">
              <th className="px-5 py-3">Critère</th>
              <th className="px-5 py-3">Note</th>
              <th className="px-5 py-3">Date</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s: any, i: number) => (
              <tr key={s.id} className={`border-t border-stroke dark:border-strokedark hover:bg-alabaster/60 dark:hover:bg-blacksection/60 transition-colors ${i % 2 === 1 ? 'bg-alabaster/30 dark:bg-blacksection/30' : ''}`}>
                <td className="px-5 py-3 font-semibold text-black dark:text-white">{s.name}</td>
                <td className="px-5 py-3 text-waterloo">{s.value}</td>
                <td className="px-5 py-3 text-waterloo">{fmtDate(s.timestamp ?? s.createdAt)}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={3} className="px-5 py-8 text-center text-waterloo text-sm">Aucune donnée de qualité pour le moment</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} hasMore={hasMore} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
    </div>
  );
}

// ─── Badge statut Ollama (ping direct /llm/health, hors métriques Langfuse) ──
function OllamaStatusBadge() {
  const [status, setStatus] = useState<'loading' | 'online' | 'offline'>('loading');

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch(`${API_BASE}/llm/health`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => { if (!cancelled) setStatus(d?.ollama?.online ? 'online' : 'offline'); })
        .catch(() => { if (!cancelled) setStatus('offline'); });
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const config = {
    loading: { dot: 'bg-waterloo', text: 'text-waterloo', label: 'Vérification…' },
    online: { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400', label: 'Ollama en ligne' },
    offline: { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: 'Ollama hors ligne' },
  }[status];

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-full border border-stroke dark:border-strokedark bg-white dark:bg-black text-xs font-bold">
      <span className={`w-2 h-2 rounded-full ${config.dot} ${status === 'loading' ? 'animate-pulse' : ''}`} />
      <span className={config.text}>{config.label}</span>
    </div>
  );
}

// ─── Page principale ────────────────────────────────────────────────────────
export default function AdminMonitoringPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [tab, setTab] = useState<TabId>('overview');
  const [baseUrl, setBaseUrl] = useState<string>('https://cloud.langfuse.com');

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCurrentUser(d?.user ?? null))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (authChecked && currentUser?.role === 'ADMIN') {
      apiGet('/dashboard-url').then((d) => { if (d?.baseUrl) setBaseUrl(d.baseUrl); }).catch(() => {});
    }
  }, [authChecked, currentUser]);

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-black">
        <Spinner />
      </div>
    );
  }

  if (currentUser?.role !== 'ADMIN') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-white dark:bg-black px-4 text-center">
        <h1 className="text-xl font-bold text-black dark:text-white">Accès réservé aux administrateurs</h1>
        <p className="text-waterloo text-sm max-w-sm">Cette page n’est accessible qu’aux comptes avec le rôle Admin.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white dark:bg-black">
      <style jsx global>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <section className="pt-35 pb-10 md:pt-40">
        <div className="mx-auto max-w-c-1390 px-4 md:px-8 2xl:px-0">

          {/* Header */}
          <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="mb-4 inline-block rounded-full bg-zumthor dark:border dark:border-strokedark dark:bg-blacksection px-4.5 py-1.5">
                <span className="text-sectiontitle font-medium text-black dark:text-white">Pilotage IA</span>
              </div>
              <p className="text-waterloo dark:text-manatee">Combien l'IA est utilisée, ce que ça coûte, et si tout fonctionne bien</p>
            </div>
            <div className="relative inline-block">
              <div className="absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-full bg-[#0426a3] transition-transform" />
              <a
                href={baseUrl}
                target="_blank"
                rel="noreferrer"
                className="relative block px-5 py-2.5 rounded-full border border-stroke dark:border-strokedark bg-white dark:bg-black text-waterloo hover:text-[#6C8EEF] hover:border-[#6C8EEF]/40 hover:shadow-sm text-xs font-bold transition-all whitespace-nowrap"
              >
                Langfuse ↗
              </a>
            </div>
          </div>

          {/* Statut technique (indépendant des métriques d'usage IA) */}
          <div className="mb-6">
            <OllamaStatusBadge />
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-alabaster dark:bg-blacksection border border-stroke dark:border-strokedark rounded-full p-1 mb-6 w-fit overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 rounded-full text-xs font-bold transition-all duration-200 whitespace-nowrap ${tab === t.id ? 'bg-white dark:bg-btndark text-black dark:text-white shadow-solid-2 scale-100' : 'text-waterloo hover:text-black dark:hover:text-white scale-95'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Content */}
          {tab === 'overview' && <OverviewTab baseUrl={baseUrl} />}
          {tab === 'history' && <HistoryTab baseUrl={baseUrl} />}
          {tab === 'quality' && <QualityTab />}

        </div>
      </section>
    </div>
  );
}