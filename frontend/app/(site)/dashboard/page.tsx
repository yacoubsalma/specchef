'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

const API_BASE = '/api/backend';

type Role = 'ADMIN' | 'QA' | 'BA' | 'PO';

interface CurrentUser {
  id?: string;
  email?: string;
  name?: string;
  role?: Role;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function Spinner() {
  return <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />;
}

// Skeleton affiché pendant le (re)chargement du dashboard (changement de
// période/projet, ou tout premier chargement) — évite l'écran vide/spinner
// central qui masque la mise en page déjà connue.
function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-stroke/60 dark:bg-strokedark/60 ${className}`} />;
}

function DashboardSkeleton() {
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        {Array.from({ length: 5 }).map((_, i) => <SkeletonBlock key={i} className="h-[92px]" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
        <SkeletonBlock className="lg:col-span-2 h-[220px]" />
        <SkeletonBlock className="h-[220px]" />
      </div>
      <SkeletonBlock className="h-[280px] mb-5" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SkeletonBlock className="h-[200px]" />
        <SkeletonBlock className="h-[200px]" />
      </div>
    </div>
  );
}

function fmtDate(v?: string | null) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return v;
  }
}

function truncate(s: string | undefined | null, n = 48) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function timeAgo(v?: string | null) {
  if (!v) return 'date inconnue';
  const d = new Date(v).getTime();
  if (Number.isNaN(d)) return 'date inconnue';
  const diffMin = Math.floor((Date.now() - d) / 60000);
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return `il y a ${h} h`;
  const j = Math.floor(h / 24);
  if (j < 30) return `il y a ${j} j`;
  return `il y a ${Math.floor(j / 30)} mois`;
}

function fmtNum(n: number | undefined | null) {
  return (n ?? 0).toLocaleString('fr-FR');
}

function isStale(v: string | null | undefined, days: number) {
  if (!v) return false;
  const d = new Date(v).getTime();
  if (Number.isNaN(d)) return false;
  return (Date.now() - d) / 86400000 > days;
}

function initials(name?: string | null) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? '';
  const b = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (a + b).toUpperCase() || name.slice(0, 2).toUpperCase();
}

function statusDotColor(status: string): string {
  const map: Record<string, string> = {
    processing: CHART.slate,
    done: CHART.teal,
    error: CHART.red,
    validated: CHART.teal,
    rejected: CHART.red,
    pending: CHART.slateSoft,
  };
  return map[status] ?? CHART.slateSoft;
}

async function apiGet(path: string) {
  const res = await fetch(`${API_BASE}${path}`);
  if (res.status === 403) throw new Error('FORBIDDEN');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Palette des graphiques ────────────────────────────────────────────────
// Dégradé de bleus (du plus foncé au plus clair) pour toute la hiérarchie
// visuelle — le rouge reste la seule couleur à part, réservée aux états
// "ça a cassé" (erreur, rejeté, priorité critique).
const CHART = {
  ink: '#0426a3',        // le plus foncé — métrique principale / info / accent fort
  charcoal: '#0a38b8',   // second niveau — rôles / secondaire (pas "succès")
  slate: '#4169E1',      // neutre / en cours
  slateSoft: '#93A9F0',  // secondaire / en attente
  blueMid1: '#1646d6',   // teintes intermédiaires disponibles pour des
  blueMid2: '#6C8EEF',   // graphiques à plus de 4 segments (ex: priorités)
  blueMid3: '#7B93EB',
  teal: '#0d9488',       // succès / validé / terminé — seule couleur non-bleue autorisée avec le rouge
  red: '#dc2626',        // erreur / rejeté / critique
} as const;

// ─── Sparkline (mini courbe avec info-bulle au survol) ────────────────────────
function Sparkline({ data, color = CHART.ink, height = 28 }: { data: number[]; color?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data || data.length < 2) return null;

  const width = 100;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((v, i) => [i * stepX, height - ((v - min) / range) * (height - 4) - 2] as const);
  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const idx = Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1))));
    setHover(idx);
  };

  return (
    <div className="relative mt-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full cursor-crosshair"
        style={{ height }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {hover !== null && (
          <>
            <line x1={points[hover][0]} x2={points[hover][0]} y1={0} y2={height} stroke={color} strokeWidth={0.75} strokeDasharray="2,2" opacity={0.5} />
            <circle cx={points[hover][0]} cy={points[hover][1]} r={2.5} fill={color} stroke="white" strokeWidth={0.75} />
          </>
        )}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute -top-6 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-black px-1.5 py-0.5 text-[10px] font-bold text-white shadow-lg dark:bg-white dark:text-black"
          style={{ left: `${(points[hover][0] / width) * 100}%` }}
        >
          {data[hover]}
        </div>
      )}
    </div>
  );
}

// ─── Courbe de tendance multi-séries avec info-bulle au survol (style Langfuse) ──
function TrendChart({
  labels,
  series,
  height = 220,
  fill = false,
}: {
  labels: string[];
  series: { name: string; color: string; data: number[]; fill?: boolean }[];
  height?: number;
  fill?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!labels?.length) return null;

  const width = 600;
  const padding = 10;
  const allValues = series.flatMap((s) => s.data);
  const max = Math.max(...allValues, 1);
  const stepX = (width - padding * 2) / Math.max(labels.length - 1, 1);
  const toY = (v: number) => height - padding - (v / max) * (height - padding * 2);
  const toX = (i: number) => padding + i * stepX;

  const paths = series.map((s) => ({
    ...s,
    d: s.data.map((v, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(2)},${toY(v).toFixed(2)}`).join(' '),
    areaD: `M${toX(0).toFixed(2)},${(height - padding).toFixed(2)} ` +
      s.data.map((v, i) => `L${toX(i).toFixed(2)},${toY(v).toFixed(2)}`).join(' ') +
      ` L${toX(s.data.length - 1).toFixed(2)},${(height - padding).toFixed(2)} Z`,
  }));

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const idx = Math.max(0, Math.min(labels.length - 1, Math.round(ratio * (labels.length - 1))));
    setHover(idx);
  };

  return (
    <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-4">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5 text-[11px] font-semibold text-waterloo dark:text-manatee">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="w-full cursor-crosshair"
          style={{ height }}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <line
              key={f}
              x1={padding}
              x2={width - padding}
              y1={padding + f * (height - padding * 2)}
              y2={padding + f * (height - padding * 2)}
              className="stroke-stroke dark:stroke-strokedark"
              strokeWidth={1}
            />
          ))}
          {paths.filter((p) => fill || p.fill).map((p) => (
            <path key={`area-${p.name}`} d={p.areaD} fill={`${p.color}22`} stroke="none" />
          ))}
          {paths.map((p) => (
            <path key={p.name} d={p.d} fill="none" stroke={p.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {hover !== null && (
            <line
              x1={toX(hover)} x2={toX(hover)} y1={padding} y2={height - padding}
              className="stroke-waterloo/40 dark:stroke-manatee/40" strokeWidth={1} strokeDasharray="3,3"
            />
          )}
          {hover !== null && paths.map((p) => (
            <circle key={p.name} cx={toX(hover)} cy={toY(p.data[hover])} r={3} fill={p.color} stroke="white" strokeWidth={1.25} />
          ))}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-[120px] -translate-x-1/2 rounded-xl border border-stroke bg-white px-3 py-2 text-[11px] shadow-lg dark:border-strokedark dark:bg-black"
            style={{ left: `${Math.min(90, Math.max(10, (toX(hover) / width) * 100))}%` }}
          >
            <div className="mb-1 font-bold text-black dark:text-white">{labels[hover]}</div>
            {paths.map((p) => (
              <div key={p.name} className="flex items-center justify-between gap-3 text-waterloo dark:text-manatee">
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: p.color }} />
                  {p.name}
                </span>
                <span className="font-semibold text-black dark:text-white">{p.data[hover]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Jauge circulaire (couverture SRS ↔ Exigences) — même langage visuel que
// l'onglet Couverture SRS de l'analyzer, en version compacte pour le dashboard ──
function coverageColor(pct: number): string {
  if (pct >= 85) return CHART.ink;
  if (pct >= 60) return CHART.slate;
  return CHART.red;
}

// ─── Donut multi-segments avec survol (répartition par statut / priorité) ────
function StatusDonut({ segments, size = 150, stroke = 20 }: { segments: { name: string; value: number; color: string }[]; size?: number; stroke?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  if (total === 0) {
    return <div className="flex items-center justify-center text-xs text-waterloo dark:text-manatee" style={{ height: size }}>Aucune donnée</div>;
  }

  let offsetSoFar = 0;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} className="stroke-alabaster dark:stroke-black" />
          {segments.map((s, i) => {
            const len = (s.value / total) * circumference;
            const dashOffset = -offsetSoFar;
            offsetSoFar += len;
            return (
              <circle
                key={s.name}
                cx={size / 2} cy={size / 2} r={radius} fill="none"
                stroke={s.color} strokeWidth={hover === i ? stroke + 4 : stroke}
                strokeDasharray={`${len} ${circumference - len}`} strokeDashoffset={dashOffset}
                style={{ transition: 'stroke-width 0.15s ease', cursor: 'pointer' }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          {hover !== null ? (
            <>
              <span className="text-xl font-extrabold text-black dark:text-white">{segments[hover].value}</span>
              <span className="text-[9px] font-bold text-waterloo text-center px-2 leading-tight">{segments[hover].name}</span>
            </>
          ) : (
            <>
              <span className="text-xl font-extrabold text-black dark:text-white">{fmtNum(total)}</span>
              <span className="text-[10px] font-bold text-waterloo">total</span>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {segments.map((s, i) => (
          <div key={s.name} className="flex items-center gap-2 text-xs cursor-pointer" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="font-semibold text-black dark:text-white">{s.value}</span>
            <span className="text-waterloo dark:text-manatee">{s.name}</span>
            <span className="text-[10px] text-waterloo/60">({Math.round((s.value / total) * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Barres verticales par jour (style "Usage per day" du dashboard Langfuse) ──
// Le survol d'une barre indique aussi les projets concernés ce jour-là.
function DailyBarChart({
  buckets, color = CHART.ink, height = 130, total, renderCaption,
}: {
  buckets: { label: string; count: number; projects: { name: string; count: number }[] }[];
  color?: string; height?: number; total?: number;
  renderCaption?: (sum: number) => React.ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!buckets?.length) return null;

  const max = Math.max(...buckets.map((b) => b.count), 1);
  const sum = total ?? buckets.reduce((a, b) => a + b.count, 0);

  return (
    <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4 md:p-5">
      <p className="mb-4 text-xs text-waterloo dark:text-manatee">
        {renderCaption ? renderCaption(sum) : (
          <>
            <span className="text-sm font-extrabold text-black dark:text-white">{sum}</span> marqué{sum > 1 ? 's' : ''} à réviser sur les {buckets.length} derniers jours
          </>
        )}
      </p>
      <div className="flex items-end justify-center gap-[3px]" style={{ height }}>
        {buckets.map((b, i) => {
          const h = Math.max(2, (b.count / max) * (height - 4));
          const isHover = hover === i;
          return (
            <div
              key={i}
              className="relative flex items-end justify-center"
              style={{ flex: '0 1 32px' }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {isHover && (
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-max max-w-[240px] -translate-x-1/2 rounded-md border border-stroke bg-white px-2.5 py-1.5 text-[10px] shadow-lg dark:border-strokedark dark:bg-black">
                  <div className="font-bold text-black dark:text-white">{b.label} · {b.count}</div>
                  {b.projects.length > 0 ? (
                    <div className="mt-1 space-y-0.5">
                      {b.projects.map((p) => (
                        <div key={p.name} className="flex items-center justify-between gap-2 text-waterloo dark:text-manatee">
                          <span>{p.name}</span>
                          <span className="font-semibold text-black dark:text-white flex-shrink-0">{p.count}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-waterloo dark:text-manatee">Rien ce jour-là</div>
                  )}
                </div>
              )}
              <div
                className="w-full rounded-[3px] transition-all"
                style={{ height: h, backgroundColor: isHover ? color : `${color}b3`, minWidth: 4 }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[9px] text-waterloo/70 dark:text-manatee/70">
        <span>{buckets[0].label}</span>
        <span>{buckets[buckets.length - 1].label}</span>
      </div>
    </div>
  );
}

// Diagramme en barres verticales pour "Exigences marquées à réviser" —
// 1 barre par module, couleur = projet (légende si plusieurs projets),
// info-bulle au survol (module, projet, total), même style que DailyBarChart.
// Regroupe une liste "needing review" (exigences ou test cases, mêmes champs
// projectId/projectName) par PROJET — 1 barre = 1 projet, chacune sa couleur.
function groupNeedingReviewByProject(items: any[]) {
  const byProject = new Map<string, { projectName: string; count: number }>();
  for (const it of items) {
    const key = it.projectId ?? it.projectName;
    const entry = byProject.get(key) ?? { projectName: it.projectName, count: 0 };
    entry.count++;
    byProject.set(key, entry);
  }
  const sorted = Array.from(byProject.values()).sort((a, b) => b.count - a.count);
  const maxCount = Math.max(...sorted.map((r) => r.count), 1);
  const projectPalette = [CHART.ink, CHART.teal, CHART.charcoal, CHART.blueMid1, CHART.slate, CHART.blueMid2, CHART.blueMid3, CHART.red];
  const projectColor = new Map<string, string>();
  sorted.forEach((r, i) => projectColor.set(r.projectName, projectPalette[i % projectPalette.length]));
  // `moduleName` est réutilisé comme libellé de la barre (ici = nom du
  // projet) pour rester compatible avec ReviewByModuleBarChart sans le
  // dupliquer — voir ce composant, qui masque la 2e ligne de l'info-bulle
  // quand moduleName === projectName.
  const rows = sorted.map((r) => ({ moduleName: r.projectName, projectName: r.projectName, count: r.count }));
  return { rows, maxCount, projectColor, projectsInvolved: sorted.map((r) => r.projectName) };
}

function ReviewByModuleBarChart({
  rows, maxCount, projectColor, projectsInvolved, total, title = 'Exigences marquées à réviser', showLegend = true,
}: {
  rows: { moduleName: string; projectName: string; count: number }[];
  maxCount: number;
  projectColor: Map<string, string>;
  projectsInvolved: string[];
  total: number;
  title?: string;
  showLegend?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const height = 150;

  return (
    <Section title={title} action={total > 0 ? <span className="text-[10px] font-bold text-[#0426a3] dark:text-[#93A9F0]">{total} au total</span> : undefined}>
      <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4 md:p-5">
        {rows.length > 0 ? (
          <>
            {showLegend && projectsInvolved.length > 1 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 mb-4 pb-2 border-b border-stroke dark:border-strokedark">
                {projectsInvolved.map((p) => (
                  <span key={p} className="flex items-center gap-1.5 text-[10.5px] text-waterloo dark:text-manatee">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: projectColor.get(p) }} />
                    {p}
                  </span>
                ))}
              </div>
            )}
            {/* l'ancien conteneur avait `overflow-x-auto` sans
                `overflow-y-visible` explicite — CSS force alors overflow-y à
                `auto` aussi (règle du spec quand un axe est différent de
                `visible`), ce qui rognait l'info-bulle dès qu'elle dépassait
                le cadre (ex: 2e barre). On passe donc en `flex-wrap` (pas de
                scroll horizontal, pas de clip) et on retire la troncature à
                6 caractères du nom de module — le nom complet s'affiche
                désormais en entier sous chaque barre. */}
            <div className="flex flex-wrap items-end gap-x-[6px] gap-y-3">
              {rows.map((r, i) => {
                const h = Math.max(2, (r.count / maxCount) * (height - 4));
                const isHover = hover === i;
                const color = projectColor.get(r.projectName) ?? CHART.ink;
                return (
                  <div
                    key={`${r.projectName}-${r.moduleName}`}
                    className="relative flex flex-col items-center flex-shrink-0"
                    style={{ width: 64 }}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  >
                    {isHover && (
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-max max-w-[220px] -translate-x-1/2 rounded-md border border-stroke bg-white px-2.5 py-1.5 text-[10px] shadow-lg dark:border-strokedark dark:bg-black">
                        <div className="font-bold text-black dark:text-white">{r.moduleName} · {r.count}</div>
                        {r.projectName !== r.moduleName && (
                          <div className="mt-0.5 text-waterloo dark:text-manatee">{r.projectName}</div>
                        )}
                      </div>
                    )}
                    <div className="flex items-end justify-center w-full" style={{ height }}>
                      <div
                        className="rounded-[3px] transition-all"
                        style={{ height: h, width: 24, backgroundColor: isHover ? color : `${color}b3` }}
                      />
                    </div>
                    <span className="mt-1.5 block w-full text-center text-[9px] leading-tight text-waterloo dark:text-manatee break-words">
                      {r.moduleName}
                    </span>
                    <span className="text-[9px] font-bold" style={{ color }}>{r.count}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center py-6">
            <span className="text-[11px] font-bold px-3 py-1.5 rounded-full border text-[#0d9488] border-[#0d9488]/30 bg-[#0d9488]/5">
              Rien à signaler
            </span>
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── KPI Card ────────────────────────────────────────────────────────────────
// `hero` : traitement mis en avant pour le KPI principal de chaque rôle
// (fond dégradé léger, valeur plus grande) — les autres cards restent sobres.
function computeTrend(series?: number[]) {
  if (!series || series.length < 4) return null;
  const n = series.length;
  const half = Math.floor(n / 2);
  const prev = series.slice(0, n - half).reduce((a, b) => a + b, 0);
  const recent = series.slice(n - half).reduce((a, b) => a + b, 0);
  if (prev === 0 && recent === 0) return null;
  if (prev === 0) return { pct: null as number | null, dir: 'up' as const };
  const pct = Math.round(((recent - prev) / prev) * 100);
  return { pct, dir: (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat') as 'up' | 'down' | 'flat' };
}

function KpiCard({
  label, value, sub, accent, series, hero, trendGoodDirection = 'up',
}: {
  label: string; value: string; sub?: string; accent?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; series?: number[];
  hero?: boolean; trendGoodDirection?: 'up' | 'down';
}) {
  const accentColor: Record<string, string> = {
    neutral: CHART.slate, info: CHART.ink, success: CHART.teal, warning: CHART.slateSoft, danger: CHART.red,
  };
  const color = accentColor[accent ?? 'neutral'];
  const trend = computeTrend(series);
  const trendIsGood = trend && (trend.dir === trendGoodDirection || trend.dir === 'flat');
  return (
    <div
      className={`rounded-2xl border p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
        hero ? 'border-transparent' : 'border-stroke dark:border-strokedark bg-white dark:bg-blacksection hover:border-primary/30'
      }`}
      style={hero ? { background: `linear-gradient(135deg, ${color}17, ${color}05)`, borderColor: `${color}33` } : undefined}
    >
      <div className="flex items-center justify-between gap-1.5 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee truncate">{label}</span>
        </div>
        {trend && (
          <span className={`flex-shrink-0 text-[10px] font-bold ${trendIsGood ? 'text-[#0d9488]' : trend.dir === 'flat' ? 'text-waterloo dark:text-manatee' : 'text-[#dc2626]'}`}>
            {trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '—'} {trend.pct !== null ? `${Math.abs(trend.pct)}%` : 'nouveau'}
          </span>
        )}
      </div>
      <div className={`font-bold tracking-tight text-black dark:text-white truncate ${hero ? 'text-3xl' : 'text-2xl'}`}>{value}</div>
      {sub && <div className="text-[10px] text-waterloo/70 dark:text-manatee/70 mt-1">{sub}</div>}
      {series && series.length >= 2 && (
        <>
          <Sparkline data={series} color={color} />
          <div className="text-[9px] text-waterloo/60 dark:text-manatee/60 mt-1">Évolution sur {series.length} jours</div>
        </>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, string> = {
    processing: CHART.slate, done: CHART.teal, error: CHART.red,
    validated: CHART.teal, rejected: CHART.red, pending: CHART.slateSoft,
    partial: CHART.slate, aborted: CHART.slateSoft,
  };
  const labels: Record<string, string> = {
    processing: 'En cours', done: 'Terminé', error: 'Erreur',
    validated: 'Validé', rejected: 'Rejeté', pending: 'En attente',
    partial: 'Partiel', aborted: 'Abandonné',
  };
  const color = colors[status] ?? CHART.slate;
  return (
    <span
      className="text-[10px] font-semibold px-2 py-0.5 rounded-full border"
      style={{ color, borderColor: `${color}40`, backgroundColor: `${color}0d` }}
    >
      {labels[status] ?? status}
    </span>
  );
}

// ─── Dernières éditions du SRS — fil d'activité plutôt qu'un tableau ────────
function RecentEditsList({ items }: { items: any[] }) {
  if (!items.length) {
    return (
      <div className="rounded-xl border border-dashed border-stroke dark:border-strokedark py-10 text-center text-sm text-waterloo dark:text-manatee">
        Aucune édition récente.
      </div>
    );
  }
  return (
    <div className="max-h-[320px] overflow-y-auto rounded-xl border border-stroke dark:border-strokedark divide-y divide-stroke/60 dark:divide-strokedark/60">
      {items.map((e: any) => (
        <Link
          key={e.requirementId}
          href={`/analyzer?projectId=${e.projectId}`}
          className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-alabaster/60 dark:hover:bg-black/40"
        >
          <span className="mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: CHART.ink }} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14.5px] font-semibold text-black dark:text-white">
              <span className="font-normal text-waterloo dark:text-manatee">{e.reqId} · </span>
              {truncate(e.description, 62)}
            </p>
            <p className="mt-0.5 truncate text-xs text-waterloo dark:text-manatee">
              {e.moduleName} · {truncate(e.projectName, 24)} · {timeAgo(e.updatedAt)}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}

function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return <tr><td colSpan={colSpan} className="px-1 py-10 text-center text-waterloo dark:text-manatee text-[14.5px]">{label}</td></tr>;
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-stroke dark:border-strokedark">
        <h2 className="text-[13px] font-semibold text-black dark:text-white uppercase tracking-wide">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-stroke dark:border-strokedark">
      <table className="w-full text-[14.5px]">{children}</table>
    </div>
  );
}

// ─── Activité récente (timeline) — remplace le tableau "Projets récents" ─────
function RecentProjectsTimeline({ projects }: { projects: any[] }) {
  if (!projects.length) {
    return (
      <div className="rounded-xl border border-dashed border-stroke dark:border-strokedark py-10 text-center text-sm text-waterloo dark:text-manatee">
        Aucun projet pour l'instant — les nouveaux projets apparaîtront ici.
      </div>
    );
  }
  return (
    <div className="relative">
      <div className="absolute left-[15px] top-2 bottom-2 w-px bg-gradient-to-b from-primary/60 via-stroke dark:via-strokedark to-transparent" />
      <div className="space-y-3">
        {projects.map((p: any) => (
          <div key={p.id} className="relative pl-9">
            <span
              className="absolute left-2.5 top-6 h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-4 ring-white dark:ring-black"
              style={{ backgroundColor: statusDotColor(p.status) }}
            />
            <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4 md:p-5 transition-all hover:border-primary/40">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-black dark:text-white truncate">{truncate(p.name, 42)}</h3>
                    <StatusPill status={p.status} />
                  </div>
                  <p className="text-xs text-waterloo dark:text-manatee mt-1">
                    Créé {timeAgo(p.createdAt)} · propriétaire {p.owner?.name ?? '—'}
                  </p>
                </div>
                <Link href={`/analyzer?projectId=${p.id}`} className="shrink-0 text-xs font-bold text-primary hover:underline">
                  Ouvrir ↗
                </Link>
              </div>

              {(p.assignedUsers?.length ?? 0) > 0 && (
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex -space-x-2">
                    {p.assignedUsers.slice(0, 4).map((u: any, idx: number) => (
                      <span
                        key={idx}
                        title={u.name}
                        className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary ring-2 ring-white dark:ring-blacksection"
                      >
                        {initials(u.name)}
                      </span>
                    ))}
                    {p.assignedUsers.length > 4 && (
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-alabaster text-[9px] font-bold text-waterloo ring-2 ring-white dark:bg-black dark:text-manatee dark:ring-blacksection">
                        +{p.assignedUsers.length - 4}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-waterloo dark:text-manatee">
                    assigné{p.assignedUsers.length > 1 ? 's' : ''} au projet
                  </span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── File d'attente de validation — juste le compte, détail par projet au survol ──
function ValidationQueueSummary({ items }: { items: any[] }) {
  const total = items.length;
  const urgent = items.filter((tc: any) => isStale(tc.createdAt, 3)).length;

  if (total === 0) {
    return (
      <div className="rounded-xl border border-dashed border-stroke dark:border-strokedark py-8 text-center text-sm text-waterloo dark:text-manatee">
        File d'attente vide — tout est traité
      </div>
    );
  }

  // Regroupé par projectId (pas juste par nom, pour éviter toute collision si
  // deux projets partagent le même nom) — chaque entrée garde son lien direct.
  const byProject = new Map<string, { projectId: string; name: string; count: number }>();
  for (const tc of items) {
    const key = tc.projectId ?? tc.projectName;
    const entry = byProject.get(key);
    if (entry) entry.count++;
    else byProject.set(key, { projectId: tc.projectId, name: tc.projectName, count: 1 });
  }
  const projectBreakdown = Array.from(byProject.values()).sort((a, b) => b.count - a.count);

  return (
    <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-5">
      <div className="flex flex-wrap items-center gap-5">
        <div>
          <div className="text-3xl font-bold tracking-tight text-black dark:text-white">{fmtNum(total)}</div>
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee mt-1">
            test case{total > 1 ? 's' : ''} en attente de validation
          </div>
        </div>
        {urgent > 0 && (
          <div className="flex items-center gap-2 rounded-full border border-[#0426a3]/40 dark:border-[#93A9F0]/40 px-3 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: CHART.ink }} />
            <span className="text-xs font-semibold text-[#0426a3] dark:text-[#93A9F0]">
              {urgent} en attente depuis plus de 3 jours
            </span>
          </div>
        )}
        <Link href="/analyzer" className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-full bg-primary px-3.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-primaryho">
          Traiter la file ↗
        </Link>
      </div>

      <div className="mt-4 space-y-1.5 max-h-[240px] overflow-y-auto pr-1">
        {projectBreakdown.map((p) => (
          <Link
            key={p.projectId ?? p.name}
            href={`/analyzer?projectId=${p.projectId}`}
            className="flex items-center justify-between gap-3 rounded-lg border border-stroke dark:border-strokedark px-3.5 py-2 text-xs transition-colors hover:border-primary/40"
          >
            <span className="truncate font-semibold text-black dark:text-white">{truncate(p.name, 42)}</span>
            <span className="shrink-0 rounded-full bg-alabaster px-2 py-0.5 font-bold text-waterloo dark:bg-black dark:text-manatee">
              {p.count} en attente
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Grille de projets à traiter (cartes + progression) — remplace le tableau BA
function ProjectsToProcessGrid({ projects }: { projects: any[] }) {
  if (!projects.length) {
    return (
      <div className="rounded-xl border border-dashed border-stroke dark:border-strokedark py-10 text-center text-sm text-waterloo dark:text-manatee">
        Aucun projet à traiter pour le moment.
      </div>
    );
  }
  const maxReq = Math.max(...projects.map((p: any) => p.requirementsCount || 0), 1);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((p: any) => (
        <div
          key={p.id}
          className="group relative overflow-hidden rounded-xl border border-stroke bg-white p-5 transition-all hover:border-primary/40 dark:border-strokedark dark:bg-blacksection"
        >
          <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary to-primary/10" />

          <h3 className="truncate pr-2 font-semibold text-black dark:text-white">{truncate(p.name, 30)}</h3>
          <p className="mt-1 text-[11px] text-waterloo dark:text-manatee">Mis à jour {timeAgo(p.updatedAt)}</p>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <div className="text-lg font-bold text-black dark:text-white">{p.modulesCount}</div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee">Modules</div>
            </div>
            <div>
              <div className="text-lg font-bold text-black dark:text-white">{p.requirementsCount}</div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee">Exigences</div>
            </div>
          </div>

          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-alabaster dark:bg-black">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, ((p.requirementsCount || 0) / maxReq) * 100)}%` }}
            />
          </div>

          <Link
            href={`/analyzer?projectId=${p.id}`}
            className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
          >
            Éditer le SRS ↗
          </Link>
        </div>
      ))}
    </div>
  );
}

// ─── ADMIN ───────────────────────────────────────────────────────────────────
// ─── Couverture SRS — résumé compact (dashboard Admin uniquement) ────────────
// Volontairement minimal : une alerte plateforme (moyenne + pires projets),
// pas un audit détaillé — ça, c'est l'onglet Couverture SRS de chaque projet.
function SrsCoverageCompact({ coverage }: { coverage: any }) {
  if (!coverage || coverage.evaluatedCount === 0) {
    return (
      <div className="rounded-xl border border-dashed border-stroke dark:border-strokedark py-6 text-center text-xs text-waterloo dark:text-manatee">
        Pas encore de données de couverture disponibles.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-extrabold" style={{ color: coverageColor(coverage.avgPercentage) }}>{coverage.avgPercentage}%</span>
        <span className="text-[11px] text-waterloo dark:text-manatee">en moyenne sur {coverage.evaluatedCount} projet{coverage.evaluatedCount > 1 ? 's' : ''} évalué{coverage.evaluatedCount > 1 ? 's' : ''}</span>
      </div>
      {coverage.worst?.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-stroke dark:border-strokedark pt-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee">Pires couvertures</p>
          {coverage.worst.map((p: any) => (
            <Link key={p.projectId} href={`/analyzer?projectId=${p.projectId}`} className="flex items-center gap-2 text-xs hover:text-primary">
              <span className="truncate flex-1 text-black dark:text-white">{truncate(p.projectName, 22)}</span>
              <span className="font-bold flex-shrink-0" style={{ color: coverageColor(p.coveragePercentage) }}>{p.coveragePercentage}%</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AdminDashboard({ data }: { data: any }) {
  const k = data.kpis;
  const s = data.series;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <KpiCard label="Projets (total)" value={fmtNum(k.totalProjects)} accent="success" series={s?.created} hero />
        <KpiCard label="Créés ce mois-ci" value={fmtNum(k.projectsThisMonth)} accent="neutral" />
        <KpiCard label="Extractions terminées" value={fmtNum(k.byStatus?.done ?? 0)} accent="success" series={s?.done} />
        <KpiCard label="Extractions en cours" value={fmtNum(k.byStatus?.processing ?? 0)} accent="warning" series={s?.processing} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        <KpiCard label="Utilisateurs (total)" value={fmtNum(k.totalUsers ?? 0)} sub={`Admin: ${k.usersByRole?.ADMIN ?? 0} · BA: ${k.usersByRole?.BA ?? 0} · QA: ${k.usersByRole?.QA ?? 0}`} accent="neutral" />
        <div className="md:col-span-2 rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4 flex items-center gap-3">
          <Link href="/projects" className="inline-flex items-center justify-center gap-1 rounded-full bg-primary px-3.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-primaryho">+ Créer un projet</Link>
          <Link href="/admin/users" className="inline-flex items-center justify-center gap-1 rounded-full border border-stroke px-3.5 py-1.5 text-xs font-bold text-black transition-colors hover:border-primary/40 dark:border-strokedark dark:text-white">Gérer les utilisateurs</Link>
        </div>
      </div>

      {s && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          <Section title="Utilisateurs par rôle">
            <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4">
              <StatusDonut
                size={96} stroke={14}
                segments={[
                  { name: 'BA', value: k.usersByRole?.BA ?? 0, color: CHART.ink },
                  { name: 'PO', value: k.usersByRole?.PO ?? 0, color: CHART.teal },
                  { name: 'QA', value: k.usersByRole?.QA ?? 0, color: CHART.slateSoft },
                  { name: 'Admin', value: k.usersByRole?.ADMIN ?? 0, color: CHART.charcoal },
                ]}
              />
            </div>
          </Section>
          <Section title="Extractions — statut actuel">
            <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4">
              <StatusDonut
                size={96} stroke={14}
                segments={[
                  { name: 'Terminées', value: k.byStatus?.done ?? 0, color: CHART.teal },
                  { name: 'En cours', value: k.byStatus?.processing ?? 0, color: CHART.slate },
                ]}
              />
            </div>
          </Section>
          <Section title="Couverture SRS" action={<span className="text-[10px] font-bold text-waterloo dark:text-manatee">Moyenne plateforme</span>}>
            <SrsCoverageCompact coverage={data.srsCoverage} />
          </Section>
        </div>
      )}

      <div className="mb-5">
        <Section title="Projets récents" action={<Link href="/projects" className="inline-flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-[11px] font-bold text-black transition-colors hover:border-primary/40 dark:border-strokedark dark:text-white">Voir tous les projets</Link>}>
          <div className="max-h-[380px] overflow-y-auto pr-1">
            <RecentProjectsTimeline projects={data.recentProjects} />
          </div>
        </Section>
      </div>

      {data.alerts?.count > 0 && (
        <div className="mb-5 rounded-xl border border-amber-400/40 bg-amber-400/5 dark:bg-amber-400/10 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400 mb-2">Extractions bloquées depuis plus de 2h — probablement plantées</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
            {data.alerts.stuckProjects.map((p: any) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-blacksection px-3 py-2 hover:border-amber-400 transition-colors">
                <span className="text-[13px] font-semibold text-black dark:text-white truncate">{truncate(p.name, 30)}</span>
                <span className="text-[10px] text-waterloo dark:text-manatee flex-shrink-0">{timeAgo(p.updatedAt)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <Section title="Nouveaux projets par jour" action={<span className="text-[10px] font-bold text-waterloo dark:text-manatee">Survolez une barre pour le détail</span>}>
        <DailyBarChart
          buckets={data.projectsByDay ?? []}
          total={k.totalProjects}
          renderCaption={(sum) => (
            <><span className="text-sm font-extrabold text-black dark:text-white">{sum}</span> projet{sum > 1 ? 's' : ''} créé{sum > 1 ? 's' : ''} sur les {(data.projectsByDay ?? []).length} derniers jours, tous utilisateurs confondus</>
          )}
        />
      </Section>
    </>
  );
}

// ─── BA ──────────────────────────────────────────────────────────────────────
function BaDashboard({ data }: { data: any }) {
  const k = data.kpis;
  const s = data.series;
  const byProject = data.byProject ?? [];
  const [projectSearch, setProjectSearch] = useState('');
  const filteredByProject = projectSearch.trim()
    ? byProject.filter((p: any) => p.projectName.toLowerCase().includes(projectSearch.trim().toLowerCase()))
    : byProject;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <KpiCard label="Projets actifs" value={fmtNum(k.activeProjects)} accent="info" hero />
        <KpiCard label="Modules" value={fmtNum(k.totalModules)} accent="neutral" />
        <KpiCard label="Exigences (total)" value={fmtNum(k.totalRequirements)} accent="neutral" series={s?.requirementsAdded} />
        <KpiCard label="Exports Jira" value={fmtNum(k.jiraExportsCount)} accent="success" />
        <KpiCard label="À réviser" value={fmtNum(k.requirementsNeedingReview ?? 0)} accent={(k.requirementsNeedingReview ?? 0) > 0 ? 'warning' : 'neutral'} />
      </div>

      <div className="mb-5">
        <Section
          title="Répartition par projet"
          action={
            <input
              type="text"
              value={projectSearch}
              onChange={(e) => setProjectSearch(e.target.value)}
              placeholder="Rechercher un projet…"
              className="rounded-md border border-stroke dark:border-strokedark bg-white dark:bg-blacksection px-2.5 py-1 text-[11px] text-black dark:text-white placeholder:text-waterloo dark:placeholder:text-manatee w-40"
            />
          }
        >
          <div className="max-h-[380px] overflow-y-auto">
            <TableShell>
              <thead>
                <tr className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee border-b border-stroke dark:border-strokedark">
                  <th className="px-5 py-3">Projet</th>
                  <th className="px-5 py-3 text-right">Modules</th>
                  <th className="px-5 py-3 text-right">Exigences</th>
                  <th className="px-5 py-3 text-right">Exports Jira</th>
                  <th className="px-5 py-3 text-right">À réviser</th>
                  <th className="px-5 py-3">SRS</th>
                </tr>
              </thead>
              <tbody>
                {filteredByProject.map((p: any) => (
                  <tr key={p.projectId} className="border-b border-stroke/60 dark:border-strokedark/60">
                    <td className="px-5 py-3">
                      <Link href={`/projects/${p.projectId}`} className="text-[15px] font-semibold text-black dark:text-white hover:text-primary">{truncate(p.projectName, 28)}</Link>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-[15px] text-waterloo">{p.modulesCount}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[15px] text-waterloo">{p.requirementsCount}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[15px] text-waterloo">{p.jiraExportsCount}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[15px] font-semibold" style={{ color: p.reqsNeedingReviewCount > 0 ? CHART.red : undefined }}>{p.reqsNeedingReviewCount}</td>
                    <td className="px-5 py-3">
                      {p.srsUpdatedAt ? (
                        p.srsOutdated ? (
                          <span title={`SRS mis à jour le ${fmtDate(p.srsUpdatedAt)}, après la dernière extraction — une ré-extraction est probablement nécessaire.`} className="text-[10px] font-semibold px-2 py-0.5 rounded-full border text-amber-700 border-amber-400/40 bg-amber-400/10">
                            À ré-extraire
                          </span>
                        ) : (
                          <span title={`SRS indexé le ${fmtDate(p.srsUpdatedAt)}`} className="text-[10px] font-semibold px-2 py-0.5 rounded-full border text-[#0d9488] border-[#0d9488]/30 bg-[#0d9488]/5">
                            À jour
                          </span>
                        )
                      ) : (
                        <span className="text-[10px] text-waterloo dark:text-manatee">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {filteredByProject.length === 0 && <EmptyRow colSpan={6} label={projectSearch ? 'Aucun projet ne correspond à la recherche' : 'Aucun projet'} />}
              </tbody>
            </TableShell>
          </div>
        </Section>
      </div>

      {s && (() => {
        let addedRunning = 0, editedRunning = 0;
        const cumulativeAdded = s.requirementsAdded.map((v: number) => (addedRunning += v));
        const cumulativeEdited = s.requirementsEdited.map((v: number) => (editedRunning += v));
        return (
        <div className="mb-5">
          <Section title={`Évolution des exigences (${s.labels.length} derniers jours)`} action={<span className="text-[10px] font-bold text-waterloo dark:text-manatee">Nouveaux événements cumulés sur la période — pas le total historique</span>}>
            <div
              className="rounded-xl border p-4"
              style={{ background: `linear-gradient(135deg, ${CHART.ink}12, ${CHART.blueMid3}08)`, borderColor: `${CHART.ink}22` }}
            >
              <TrendChart
                labels={s.labels}
                height={170}
                series={[
                  { name: 'Ajoutées (cumulé, période)', color: CHART.ink, data: cumulativeAdded, fill: true },
                  { name: 'Modifiées (cumulé, période)', color: CHART.blueMid3, data: cumulativeEdited },
                ]}
              />
            </div>
          </Section>
        </div>
        );
      })()}

      {(() => {
        const items: any[] = data.reqsNeedingReview ?? [];
        // Regroupement par PROJET : 1 barre = 1 projet, trié par nombre
        // décroissant (demande explicite : par projet, pas par module).
        const { rows, maxCount, projectColor, projectsInvolved } = groupNeedingReviewByProject(items);
        return (
          <ReviewByModuleBarChart
            rows={rows}
            maxCount={maxCount}
            projectColor={projectColor}
            projectsInvolved={projectsInvolved}
            total={items.length}
            showLegend={false}
          />
        );
      })()}

      <div className="mt-5">
        <Section title="Projets à traiter (SRS extrait)" action={<Link href="/projects" className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[11px] font-bold text-white transition-colors hover:bg-primaryho">+ Créer un projet</Link>}>
          <div className="max-h-[420px] overflow-y-auto pr-1">
            <ProjectsToProcessGrid projects={data.projectsToProcess} />
          </div>
        </Section>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mt-5">
        <Section title="Dernières éditions du SRS">
          <RecentEditsList items={data.recentEdits} />
        </Section>

        <Section title="Activité des autres BA" action={<span className="text-[10px] font-bold text-waterloo dark:text-manatee">Sur vos projets partagés</span>}>
          <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-1">
            {(data.otherBaActivity ?? []).map((a: any) => (
              <div key={a.id} className="rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-blacksection px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-black dark:text-white">{a.changedByName}</span>
                  <span className="text-[10px] text-waterloo dark:text-manatee flex-shrink-0">{timeAgo(a.createdAt)}</span>
                </div>
                <p className="text-[12px] text-waterloo dark:text-manatee mt-0.5">
                  {a.changeSummary ?? (a.changeType === 'create' ? 'Création' : a.changeType === 'delete' ? 'Suppression' : 'Modification')} · {truncate(a.projectName, 24)}
                </p>
              </div>
            ))}
            {(data.otherBaActivity ?? []).length === 0 && <EmptyRow colSpan={1} label="Aucune activité récente d'un autre BA" />}
          </div>
        </Section>

        <Section title="Derniers exports Jira">
          <div className="max-h-[320px] overflow-y-auto">
            <TableShell>
              <thead>
                <tr className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee border-b border-stroke dark:border-strokedark">
                  <th className="px-5 py-3">Test Case</th>
                  <th className="px-5 py-3">Issue Jira</th>
                  <th className="px-5 py-3">Exporté le</th>
                </tr>
              </thead>
              <tbody>
                {data.recentJiraExports.map((e: any) => (
                  <tr key={e.testCaseId} className="border-b border-stroke/60 dark:border-strokedark/60">
                    <td className="px-5 py-3 text-[15px] font-semibold text-black dark:text-white">{truncate(e.title, 32)}</td>
                    <td className="px-5 py-3">
                      {e.jiraIssueUrl ? <a href={e.jiraIssueUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">{e.jiraIssueKey}</a> : (e.jiraIssueKey ?? '—')}
                    </td>
                    <td className="px-5 py-3 text-waterloo">{fmtDate(e.jiraExportedAt)}</td>
                  </tr>
                ))}
                {data.recentJiraExports.length === 0 && <EmptyRow colSpan={3} label="Aucun export récent" />}
              </tbody>
            </TableShell>
          </div>
        </Section>
      </div>
    </>
  );
}

// ─── Campagnes (widget global, PO uniquement) ─────────────────────────────────
// Résumé multi-projets de l'avancement des campagnes de tests — voir
// GET /dashboard/po/campaigns côté backend (DashboardService.getPoCampaignsOverview).
// Chaque ligne renvoie vers /campaigns/[projectId] pour le détail (TC + workflows
// + modifications en attente) ; le lien "Voir tout" mène à /campaigns.
function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-2 w-full rounded-full bg-alabaster dark:bg-black overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(Math.max(pct, 0), 100)}%`, backgroundColor: color }} />
    </div>
  );
}

// ─── PO ──────────────────────────────────────────────────────────────────────
// Dashboard dédié : avancement produit (campagnes, projets prêts à lancer,
// couverture SRS, traçabilité Jira) — pas d'édition d'exigences ici (voir BA).
// Alimenté par GET /dashboard/po (DashboardService.getPoDashboard).
function PoDashboard({ data }: { data: any }) {
  const k = data.kpis;
  const campaignRows = (data.campaignProjects ?? []).slice(0, 6);
  const readiness = data.readiness ?? [];
  const campaignTotals = (data.campaignProjects ?? []).reduce(
    (acc: { passed: number; failed: number; notTested: number }, p: any) => ({
      passed: acc.passed + (p.testCases?.passed ?? 0),
      failed: acc.failed + (p.testCases?.failed ?? 0),
      notTested: acc.notTested + (p.testCases?.notTested ?? 0),
    }),
    { passed: 0, failed: 0, notTested: 0 },
  );

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <KpiCard label="Campagnes actives" value={fmtNum(k.activeCampaigns)} accent="info" hero />
        <KpiCard label="Projets" value={fmtNum(k.totalProjects)} accent="neutral" />
        <KpiCard label="Avancement moyen" value={`${k.avgProgress}%`} sub="Test cases exécutés (verdict) sur le total, campagnes lancées" accent={k.avgProgress >= 70 ? 'success' : k.avgProgress >= 30 ? 'warning' : 'neutral'} />
        <KpiCard label="Modifs en attente" value={fmtNum(k.totalPendingChanges)} accent={k.totalPendingChanges > 0 ? 'warning' : 'neutral'} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-5">
        <div className="xl:col-span-2">
          <Section
            title="Campagnes de tests"
            action={<Link href="/campaigns" className="inline-flex items-center gap-1 rounded-full border border-stroke px-3 py-1 text-[11px] font-bold text-black transition-colors hover:border-primary/40 dark:border-strokedark dark:text-white">Voir tout</Link>}
          >
            <div className="flex flex-col gap-3 max-h-[420px] overflow-y-auto pr-1">
              {campaignRows.map((p: any) => (
                <Link
                  key={p.projectId}
                  href={`/campaigns/${p.projectId}`}
                  className="block rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-3 hover:border-primary/40 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-sm font-bold text-black dark:text-white truncate">{p.projectName}</span>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {p.pendingChangesCount > 0 && (
                        <span className="text-[10px] font-bold text-amber-700 dark:text-amber-400">{p.pendingChangesCount} en attente</span>
                      )}
                      <StatusPill status={p.campaignStatus === 'launched' ? 'processing' : 'done'} />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <ProgressBar pct={p.progressPct} color={coverageColor(p.progressPct)} />
                    <span className="text-xs font-bold text-waterloo dark:text-manatee flex-shrink-0">{p.progressPct}%</span>
                  </div>
                  <div className="mt-1 text-[10px] text-waterloo dark:text-manatee">
                    {p.testCases.passed} réussi · {p.testCases.failed} échoué · {p.testCases.notTested} non testé
                  </div>
                </Link>
              ))}
              {campaignRows.length === 0 && <EmptyRow colSpan={1} label="Aucun projet" />}
            </div>
          </Section>
        </div>

        <Section title="Résultats globaux" action={<span className="text-[10px] font-bold text-waterloo dark:text-manatee">Tous les projets de campagne</span>}>
          <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4">
            <StatusDonut
              size={110} stroke={16}
              segments={[
                { name: 'Réussi', value: campaignTotals.passed, color: CHART.teal },
                { name: 'Échoué', value: campaignTotals.failed, color: CHART.red },
                { name: 'Non testé', value: campaignTotals.notTested, color: CHART.slateSoft },
              ]}
            />
          </div>
        </Section>
      </div>

      {data.launchesByDay?.length > 0 && (() => {
        let running = 0;
        const cumulative = data.launchesByDay.map((c: any) => (running += c.count));
        const dayLabels = data.launchesByDay.map((c: any) => new Date(`${c.date}T00:00:00`).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
        const total = running;
        return (
          <div className="mb-5">
            <Section
              title="Historique des lancements (cumulé)"
              action={<span className="text-[10px] font-bold text-waterloo dark:text-manatee">{total} au total sur {data.launchesByDay.length} jours</span>}
            >
              <TrendChart
                labels={dayLabels}
                height={160}
                fill
                series={[{ name: 'Total cumulé', color: CHART.ink, data: cumulative }]}
              />
            </Section>
          </div>
        );
      })()}

      <Section
        title="Prêts à lancer"
        action={<span className="text-[10px] font-bold text-waterloo dark:text-manatee">Projets en brouillon, 100% validés QA</span>}
      >
        {readiness.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {readiness.map((p: any) => (
              <Link
                key={p.id}
                href={`/campaigns/${p.id}`}
                className="block rounded-xl border border-[#0d9488]/30 bg-[#0d9488]/5 dark:bg-[#0d9488]/10 p-4 hover:border-[#0d9488]/60 transition-colors"
              >
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="text-sm font-bold text-black dark:text-white truncate">{p.name}</span>
                  <span className="flex-shrink-0 text-[10px] font-bold text-[#0d9488] bg-[#0d9488]/10 rounded-full px-2 py-0.5 border border-[#0d9488]/30">100% validé</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[12px] text-waterloo dark:text-manatee">
                  <span>{p.requirementsCount} exigences</span>
                  <span>{p.testCasesCount} test cases</span>
                </div>
                <div className="mt-2 text-[10px] text-waterloo/70 dark:text-manatee/70">Dernière activité {timeAgo(p.updatedAt)}</div>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyRow colSpan={1} label="Aucun projet à 100% de validation pour l'instant" />
        )}
      </Section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-5">
        <Section title="Exécutions de workflows">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
            <KpiCard label="Total (période)" value={fmtNum(data.workflowRuns?.kpis?.total ?? 0)} accent="neutral" series={data.workflowRuns?.series?.counts} />
            <KpiCard label="Réussies" value={fmtNum(data.workflowRuns?.kpis?.passed ?? 0)} accent="success" />
            <KpiCard label="Échouées" value={fmtNum(data.workflowRuns?.kpis?.failed ?? 0)} accent="danger" />
            <KpiCard label="Partielles" value={fmtNum(data.workflowRuns?.kpis?.partial ?? 0)} accent="warning" />
            <KpiCard label="Abandonnées" value={fmtNum(data.workflowRuns?.kpis?.aborted ?? 0)} accent="neutral" />
            <KpiCard label="En cours" value={fmtNum(data.workflowRuns?.kpis?.running ?? 0)} accent={data.workflowRuns?.kpis?.running > 0 ? 'info' : 'neutral'} />
          </div>
        </Section>
        <Section title="Derniers runs">
          <div className="max-h-[280px] overflow-y-auto">
            <TableShell>
              <thead>
                <tr className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee border-b border-stroke dark:border-strokedark">
                  <th className="px-5 py-3">Workflow</th>
                  <th className="px-5 py-3">Statut</th>
                  <th className="px-5 py-3">Lancé le</th>
                </tr>
              </thead>
              <tbody>
                {(data.workflowRuns?.recent ?? []).map((r: any) => (
                  <tr key={r.id} className="border-b border-stroke/60 dark:border-strokedark/60">
                    <td className="px-5 py-3">
                      <div className="text-[15px] font-semibold text-black dark:text-white">{truncate(r.workflowName, 26)}</div>
                      <div className="text-[11px] text-waterloo dark:text-manatee">{truncate(r.projectName, 26)}{r.executedByName ? ` · ${r.executedByName}` : ''}</div>
                    </td>
                    <td className="px-5 py-3"><StatusPill status={r.status === 'passed' ? 'done' : r.status === 'failed' ? 'error' : r.status === 'running' ? 'processing' : r.status} /></td>
                    <td className="px-5 py-3 text-waterloo">{timeAgo(r.startedAt)}</td>
                  </tr>
                ))}
                {(data.workflowRuns?.recent ?? []).length === 0 && <EmptyRow colSpan={3} label="Aucune exécution récente" />}
              </tbody>
            </TableShell>
          </div>
        </Section>
      </div>
    </>
  );
}

// ─── QA ──────────────────────────────────────────────────────────────────────
function QaDashboard({ data }: { data: any }) {
  const k = data.kpis;
  const s = data.series;
  const [projectSearch, setProjectSearch] = useState('');
  const filteredByProject = projectSearch.trim()
    ? (data.byProject ?? []).filter((p: any) => p.projectName.toLowerCase().includes(projectSearch.trim().toLowerCase()))
    : (data.byProject ?? []);
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <KpiCard label="Test cases (total)" value={fmtNum(k.totalTestCases)} accent="success" series={s?.created} hero />
        <KpiCard label="Validés (total)" value={fmtNum(k.validated)} accent="success" series={s?.validated} />
        <KpiCard label="En attente (total)" value={fmtNum(k.pending)} accent="warning" />
        <KpiCard label="Rejetés (total)" value={fmtNum(k.rejected)} accent="danger" series={s?.rejected} trendGoodDirection="down" />
        <KpiCard label="À réviser" value={fmtNum(k.testCasesNeedingReview ?? 0)} accent={(k.testCasesNeedingReview ?? 0) > 0 ? 'warning' : 'neutral'} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        <KpiCard label="Taux de validation" value={`${k.validationRate}%`} accent="neutral" />
        <KpiCard label="Exports Jira" value={fmtNum(k.jiraExportsCount)} accent="success" />
      </div>

      {s && (() => {
        let createdRunning = 0, validatedRunning = 0, rejectedRunning = 0;
        const cumulativeCreated = s.created.map((v: number) => (createdRunning += v));
        const cumulativeValidated = s.validated.map((v: number) => (validatedRunning += v));
        const cumulativeRejected = s.rejected.map((v: number) => (rejectedRunning += v));
        return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5">
          <div className="lg:col-span-2">
            <Section title={`Tendance des test cases (${s.labels.length} derniers jours)`} action={<span className="text-[10px] font-bold text-waterloo dark:text-manatee">Nouveaux événements cumulés sur la période — pas le total historique (voir ci-dessus)</span>}>
              <TrendChart
                labels={s.labels}
                height={170}
                series={[
                  { name: 'Créés (cumulé, période)', color: CHART.ink, data: cumulativeCreated, fill: true },
                  { name: 'Validés (cumulé, période)', color: CHART.teal, data: cumulativeValidated },
                  { name: 'Rejetés (cumulé, période)', color: CHART.red, data: cumulativeRejected },
                ]}
              />
            </Section>
          </div>
          <Section title="Par statut" action={<span className="text-[10px] font-bold text-waterloo dark:text-manatee">Total historique</span>}>
            <div className="rounded-xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection p-4">
              <StatusDonut
                size={110} stroke={16}
                segments={[
                  { name: 'Validés', value: k.validated, color: CHART.teal },
                  { name: 'En attente', value: k.pending, color: CHART.slateSoft },
                  { name: 'Rejetés', value: k.rejected, color: CHART.red },
                ]}
              />
            </div>
          </Section>
        </div>
        );
      })()}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-5">
        <Section title="Test cases marqués à réviser" action={k.testCasesNeedingReview > 0 ? <span className="text-[10px] font-bold text-[#0426a3] dark:text-[#93A9F0]">{k.testCasesNeedingReview} au total</span> : undefined}>
          <DailyBarChart buckets={data.tcsReviewByDay ?? []} total={k.testCasesNeedingReview ?? 0} color={CHART.slateSoft} />
        </Section>
        <Section title="File d'attente de validation">
          <ValidationQueueSummary items={data.reviewQueue} />
        </Section>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-5">
        <Section title="Exécutions de workflows">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
            <KpiCard label="Total (période)" value={fmtNum(data.workflowRuns?.kpis?.total ?? 0)} accent="neutral" series={data.workflowRuns?.series?.counts} />
            <KpiCard label="Réussies" value={fmtNum(data.workflowRuns?.kpis?.passed ?? 0)} accent="success" />
            <KpiCard label="Échouées" value={fmtNum(data.workflowRuns?.kpis?.failed ?? 0)} accent="danger" />
            <KpiCard label="Partielles" value={fmtNum(data.workflowRuns?.kpis?.partial ?? 0)} accent="warning" />
            <KpiCard label="Abandonnées" value={fmtNum(data.workflowRuns?.kpis?.aborted ?? 0)} accent="neutral" />
            <KpiCard label="En cours" value={fmtNum(data.workflowRuns?.kpis?.running ?? 0)} accent={data.workflowRuns?.kpis?.running > 0 ? 'info' : 'neutral'} />
          </div>
        </Section>
        <Section title="Derniers runs">
          <div className="max-h-[280px] overflow-y-auto">
            <TableShell>
              <thead>
                <tr className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee border-b border-stroke dark:border-strokedark">
                  <th className="px-5 py-3">Workflow</th>
                  <th className="px-5 py-3">Statut</th>
                  <th className="px-5 py-3">Lancé le</th>
                </tr>
              </thead>
              <tbody>
                {(data.workflowRuns?.recent ?? []).map((r: any) => (
                  <tr key={r.id} className="border-b border-stroke/60 dark:border-strokedark/60">
                    <td className="px-5 py-3">
                      <div className="text-[15px] font-semibold text-black dark:text-white">{truncate(r.workflowName, 26)}</div>
                      <div className="text-[11px] text-waterloo dark:text-manatee">{truncate(r.projectName, 26)}{r.executedByName ? ` · ${r.executedByName}` : ''}</div>
                    </td>
                    <td className="px-5 py-3"><StatusPill status={r.status === 'passed' ? 'done' : r.status === 'failed' ? 'error' : r.status === 'running' ? 'processing' : r.status} /></td>
                    <td className="px-5 py-3 text-waterloo">{timeAgo(r.startedAt)}</td>
                  </tr>
                ))}
                {(data.workflowRuns?.recent ?? []).length === 0 && <EmptyRow colSpan={3} label="Aucune exécution récente" />}
              </tbody>
            </TableShell>
          </div>
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section
          title="Répartition par projet"
          action={
            <input
              type="text"
              value={projectSearch}
              onChange={(e) => setProjectSearch(e.target.value)}
              placeholder="Rechercher un projet…"
              className="rounded-md border border-stroke dark:border-strokedark bg-white dark:bg-blacksection px-2.5 py-1 text-[11px] text-black dark:text-white placeholder:text-waterloo dark:placeholder:text-manatee w-40"
            />
          }
        >
          <div className="max-h-[320px] overflow-y-auto">
            <TableShell>
              <thead>
                <tr className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee border-b border-stroke dark:border-strokedark">
                  <th className="px-5 py-3">Projet</th>
                  <th className="px-5 py-3 text-right">Total</th>
                  <th className="px-5 py-3 text-right">Validés</th>
                  <th className="px-5 py-3 text-right">Rejetés</th>
                  <th className="px-5 py-3 text-right">En attente</th>
                </tr>
              </thead>
              <tbody>
                {filteredByProject.map((p: any) => (
                  <tr key={p.projectId} className="border-b border-stroke/60 dark:border-strokedark/60">
                    <td className="px-5 py-3 text-[15px] font-semibold text-black dark:text-white">{truncate(p.projectName, 26)}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[15px] text-waterloo">{p.total}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[15px] text-[#0d9488] dark:text-[#2dd4bf] font-semibold">{p.validated}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[15px] text-[#dc2626] dark:text-[#f87171] font-semibold">{p.rejected}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[15px] text-[#4169E1] dark:text-[#93A9F0] font-semibold">{p.pending}</td>
                  </tr>
                ))}
                {filteredByProject.length === 0 && <EmptyRow colSpan={5} label={projectSearch ? 'Aucun projet ne correspond à la recherche' : 'Aucun test case'} />}
              </tbody>
            </TableShell>
          </div>
        </Section>

        <Section title="Derniers exports Jira">
          <div className="max-h-[320px] overflow-y-auto">
            <TableShell>
              <thead>
                <tr className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-waterloo dark:text-manatee border-b border-stroke dark:border-strokedark">
                  <th className="px-5 py-3">Test Case</th>
                  <th className="px-5 py-3">Issue Jira</th>
                  <th className="px-5 py-3">Exporté le</th>
                </tr>
              </thead>
              <tbody>
                {data.recentJiraExports.map((e: any) => (
                  <tr key={e.testCaseId} className="border-b border-stroke/60 dark:border-strokedark/60">
                    <td className="px-5 py-3 text-[15px] font-semibold text-black dark:text-white">{truncate(e.title, 30)}</td>
                    <td className="px-5 py-3">
                      {e.jiraIssueUrl ? <a href={e.jiraIssueUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">{e.jiraIssueKey}</a> : (e.jiraIssueKey ?? '—')}
                    </td>
                    <td className="px-5 py-3 text-waterloo">{fmtDate(e.jiraExportedAt)}</td>
                  </tr>
                ))}
                {data.recentJiraExports.length === 0 && <EmptyRow colSpan={3} label="Aucun export récent" />}
              </tbody>
            </TableShell>
          </div>
        </Section>
      </div>
    </>
  );
}

// ─── Page principale ─────────────────────────────────────────────────────────
const PERIOD_OPTIONS = [7, 14, 30] as const;

export default function DashboardPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<number>(14);
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [projectOptions, setProjectOptions] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCurrentUser(d?.user ?? null))
      .finally(() => setAuthChecked(true));
  }, []);

  // Liste des projets accessibles, pour le filtre global — indépendant du rôle
  // (le backend /projects applique déjà le même périmètre que les dashboards).
  useEffect(() => {
    if (!currentUser) return;
    apiGet('/projects')
      .then((list: any) => setProjectOptions(Array.isArray(list) ? list.map((p: any) => ({ id: p.id, name: p.name })) : []))
      .catch(() => setProjectOptions([]));
  }, [currentUser]);

  const load = useCallback((role: Role, days: number, projectId: string) => {
    setLoading(true);
    setError(null);
    const endpoint = role === 'ADMIN' ? '/dashboard/admin' : role === 'BA' ? '/dashboard/ba' : role === 'PO' ? '/dashboard/po' : '/dashboard/qa';
    const params = new URLSearchParams({ days: String(days) });
    if (projectId) params.set('projectId', projectId);
    apiGet(`${endpoint}?${params.toString()}`)
      .then((d) => setData(d?.data ?? null))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (authChecked && currentUser?.role) load(currentUser.role, period, projectFilter);
  }, [authChecked, currentUser, period, projectFilter, load]);

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-black">
        <Spinner />
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-white dark:bg-black text-center px-4">
        <p className="text-black dark:text-white font-semibold">Connectez-vous pour accéder à votre interface de suivi.</p>
        <Link href="/auth/signin" className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-primaryho">Se connecter</Link>
      </div>
    );
  }

  if (error === 'FORBIDDEN') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white dark:bg-black">
        <p className="text-waterloo text-sm">Accès refusé pour votre rôle.</p>
      </div>
    );
  }

  const roleLabels: Record<Role, string> = { ADMIN: 'Administrateur', BA: 'Business Analyst', QA: 'Quality Assurance', PO: 'Product Owner' };

  return (
    <div className="min-h-screen bg-white dark:bg-black pt-40 pb-16 px-4 md:px-8 lg:pt-40">
      <div className="mx-auto max-w-c-1390">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-black dark:text-white">
              <span className="inline-flex items-center gap-2">
                Bonjour {currentUser.name ?? currentUser.email}
                <img src="/icons/vague.png" alt="Bot" className="h-7 w-7" />
              </span>
            </h1>
            <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-waterloo dark:text-manatee">
              Suivi & visualisation · {roleLabels[currentUser.role as Role] ?? currentUser.role}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-blacksection px-3 py-1.5 text-xs font-semibold text-black dark:text-white"
            >
              <option value="">Tous les projets</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>{truncate(p.name, 36)}</option>
              ))}
            </select>
            <div className="inline-flex rounded-lg border border-stroke dark:border-strokedark p-0.5">
              {PERIOD_OPTIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => setPeriod(d)}
                  className={`rounded-md px-2.5 py-1 text-xs font-bold transition-colors ${
                    period === d ? 'bg-primary text-white' : 'text-waterloo dark:text-manatee hover:text-black dark:hover:text-white'
                  }`}
                >
                  {d}j
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading && !data && <DashboardSkeleton />}

        {error && error !== 'FORBIDDEN' && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-[#dc2626] dark:text-[#f87171] font-semibold">Erreur de chargement du dashboard.</p>
            <button onClick={() => currentUser.role && load(currentUser.role, period, projectFilter)} className="inline-flex items-center gap-1 rounded-full border border-stroke px-4 py-2 text-sm font-bold text-black transition-colors hover:border-primary/40 dark:border-strokedark dark:text-white">Réessayer</button>
          </div>
        )}

        {!error && data && loading && <DashboardSkeleton />}

        {!error && data && !loading && (
          <>
            {currentUser.role === 'ADMIN' && <AdminDashboard data={data} />}
            {currentUser.role === 'BA' && <BaDashboard data={data} />}
            {currentUser.role === 'PO' && <PoDashboard data={data} />}
            {currentUser.role === 'QA' && <QaDashboard data={data} />}
          </>
        )}
      </div>
    </div>
  );
}