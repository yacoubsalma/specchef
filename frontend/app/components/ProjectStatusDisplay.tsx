'use client';

import { ProjectStatus, ProjectStatusResponse } from "../hooks/useProjectPolling";
import { useEffect, useState } from "react";

interface ProjectStatusDisplayProps {
  status: ProjectStatus;
  data: ProjectStatusResponse | null;
  error: string | null;
  isPolling: boolean;
}

export function ProjectStatusDisplay({
  status,
  data,
  error,
  isPolling,
}: ProjectStatusDisplayProps) {
  const isDone = status === 'done' || data?.status === 'done';
  const isError = status === 'error';
  const [hidden, setHidden] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!isDone) {
      setHidden(false);
      setFading(false);
      return;
    }
    // start fade after 3s, hide after 3.5s
    const t1 = setTimeout(() => setFading(true), 3000);
    const t2 = setTimeout(() => setHidden(true), 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [isDone]);

  if (hidden) return null;

  if (isError) {
    return (
      <div className="rounded-xl border border-red-600/30 dark:border-red-700/40 bg-red-600/5 dark:bg-red-600/10 px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm font-bold text-red-700 dark:text-red-400">
          <span>❌</span>
          <span>Erreur lors du traitement</span>
        </div>
        {error && (
          <p className="text-xs text-red-700 dark:text-red-400 font-semibold">{error}</p>
        )}
      </div>
    );
  }

  if (isDone && data?.modules) {
    const totalReqs = data.modules.reduce((sum, m) => sum + m.requirements.length, 0);
    return (
      <div
        className="rounded-xl border border-meta/30 bg-meta/5 dark:bg-meta/10 px-4 py-3 flex items-center gap-3"
        style={{ transition: 'opacity 0.5s ease', opacity: fading ? 0 : 1 }}
      >
        <span className="text-base">✅</span>
        <span className="text-sm font-bold text-meta">
          📊 {data.modules.length} modules trouvés avec {totalReqs} exigences
        </span>
      </div>
    );
  }

  if (isDone) {
    return (
      <div
        className="rounded-xl border border-meta/30 bg-meta/5 dark:bg-meta/10 px-4 py-3 flex items-center gap-3"
        style={{ transition: 'opacity 0.5s ease', opacity: fading ? 0 : 1 }}
      >
        <span className="text-base">✅</span>
        <span className="text-sm font-bold text-meta">Traitement terminé</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-zumthor dark:bg-titlebgdark px-4 py-3 flex items-center gap-3">
      <span className="inline-block w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin flex-shrink-0" />
      <span className="text-sm font-bold text-primary">Traitement en cours...</span>
    </div>
  );
}