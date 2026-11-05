"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type SaturationStatus = {
  isSaturated: boolean;
  tcCount: number;
  rejectionRate: number;
  avgScore: number;
  reason: string;
  threshold: number;
};

interface SaturationBannerProps {
  requirementUuid: string;
  apiBase?: string;
  pollingInterval?: number;
  onStatusChange?: (status: SaturationStatus) => void;
}

const DEFAULT_API_BASE = '/api/backend';
const DEFAULT_POLLING_INTERVAL = 30_000;

function isValidRequirementId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value) || /^[0-9a-fA-F-]{36}$/.test(value);
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div style={{ flex: 1, minWidth: 80, height: 5, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden' }}>
      <div
        style={{
          width: `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`,
          height: '100%',
          background: color,
          transition: 'width 0.3s ease',
        }}
      />
    </div>
  );
}

export function SaturationBanner({
  requirementUuid,
  apiBase = DEFAULT_API_BASE,
  pollingInterval = DEFAULT_POLLING_INTERVAL,
  onStatusChange,
}: SaturationBannerProps) {
  const [status, setStatus] = useState<SaturationStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const mountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    if (!isValidRequirementId(requirementUuid)) return;
    setLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${apiBase}/projects/requirements/${requirementUuid}/saturation`, {
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (!mountedRef.current) return;

      const nextStatus: SaturationStatus = {
        isSaturated: !!data.isSaturated,
        tcCount: Number(data.tcCount || 0),
        rejectionRate: Number(data.rejectionRate || 0),
        avgScore: Number(data.avgScore || 0),
        reason: String(data.reason || ''),
        threshold: Number(data.threshold || 0),
      };
      setStatus(nextStatus);
      setLastFetch(new Date());
      onStatusChange?.(nextStatus);
      if (!nextStatus.isSaturated) setDismissed(false);
    } catch {
      // Keep UI silent on transient API/network errors.
    } finally {
      clearTimeout(timeoutId);
      if (mountedRef.current) setLoading(false);
    }
  }, [apiBase, onStatusChange, requirementUuid]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isValidRequirementId(requirementUuid)) return;

    fetchStatus();
    const id = setInterval(fetchStatus, pollingInterval);

    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [fetchStatus, pollingInterval, requirementUuid]);

  const level = useMemo(() => {
    if (!status) return 'none' as const;
    if (status.isSaturated) return 'saturated' as const;
    if (status.reason) return 'warning' as const;
    return 'ok' as const;
  }, [status]);

  if (!isValidRequirementId(requirementUuid)) return null;

  if (!status && loading) {
    return (
      <div
        style={{
          margin: '0 0 8px',
          padding: 'clamp(7px, 1.2vw, 9px) clamp(10px, 2vw, 14px)',
          borderRadius: 8,
          border: '1px solid #e2e8f0',
          background: '#f8fafc',
          color: '#64748b',
          fontSize: 'clamp(10px, 1.4vw, 11px)',
        }}
      >
        Analyse de saturation en cours...
      </div>
    );
  }

  if (!status || level === 'ok' || level === 'none') return null;
  if (dismissed && level === 'saturated') return null;

  const palette =
    level === 'saturated'
      ? {
          bg: '#fff7ed',
          border: '#fb923c',
          title: '#9a3412',
          text: '#c2410c',
          chipBg: '#fed7aa',
          chipText: '#7c2d12',
          barA: '#f97316',
          barB: '#fb923c',
          icon: 'SAT',
        }
      : {
          bg: '#fefce8',
          border: '#facc15',
          title: '#854d0e',
          text: '#92400e',
          chipBg: '#fef08a',
          chipText: '#713f12',
          barA: '#eab308',
          barB: '#facc15',
          icon: 'WARN',
        };

  const rejectionPct = Math.round(status.rejectionRate * 100);
  const scorePct = Math.round(status.avgScore * 100);
  const thresholdPct = Math.round(status.threshold * 100);
  const lastFetchLabel = lastFetch ? lastFetch.toLocaleTimeString('fr-FR') : '--';

  return (
    <div
      style={{
        margin: '0 0 10px',
        borderRadius: 10,
        border: `1.5px solid ${palette.border}66`,
        background: palette.bg,
        overflow: 'hidden',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 'clamp(8px, 1.5vw, 10px) clamp(10px, 2vw, 14px)', borderBottom: `1px solid ${palette.border}55` }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ color: palette.title, fontWeight: 900, fontSize: 'clamp(10px, 1.4vw, 11px)' }}>
              {palette.icon} {level === 'saturated' ? 'Espace semantique sature' : 'Generation difficile'}
            </span>
            <span style={{ background: palette.chipBg, color: palette.chipText, borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 800 }}>
              {status.tcCount} TC
            </span>
          </div>
          {!!status.reason && (
            <div style={{ marginTop: 6, color: palette.text, fontSize: 'clamp(10px, 1.4vw, 11px)', lineHeight: 1.5, wordBreak: 'break-word' }}>
              {status.reason}
            </div>
          )}
        </div>
        {level === 'saturated' && (
          <button
            onClick={() => setDismissed(true)}
            style={{
              border: 'none',
              background: 'transparent',
              color: palette.text,
              fontSize: 14,
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1,
            }}
          >
            x
          </button>
        )}
      </div>

      <div style={{ padding: 'clamp(8px, 1.5vw, 10px) clamp(10px, 2vw, 14px)', display: 'grid', gap: 7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 92, color: '#64748b', fontSize: 10, flexShrink: 0 }}>Taux rejet</span>
          <Bar value={status.rejectionRate} color={palette.barA} />
          <span style={{ width: 34, textAlign: 'right', color: palette.title, fontWeight: 800, fontSize: 10, flexShrink: 0 }}>{rejectionPct}%</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 92, color: '#64748b', fontSize: 10, flexShrink: 0 }}>Ressemblance</span>
          <Bar value={status.avgScore} color={palette.barB} />
          <span style={{ width: 34, textAlign: 'right', color: palette.title, fontWeight: 800, fontSize: 10, flexShrink: 0 }}>{scorePct}%</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, color: '#94a3b8', fontSize: 10, flexWrap: 'wrap' }}>
          <span>Seuil adaptatif: {thresholdPct}%</span>
          <span>{loading ? 'Actualisation...' : `Maj ${lastFetchLabel}`}</span>
        </div>
      </div>
    </div>
  );
}

export default SaturationBanner;
