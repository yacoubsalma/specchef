"use client";

import { useEffect, useRef, useState } from "react";
import { useProjectActivityFeed } from "../hooks/useProjectActivityFeed";
import type { ProjectActivityEntry } from "@/lib/project-activity-api";

const TYPE_ICON: Record<string, string> = {
  project_activity: "🗂️",
  module_activity: "📁",
  requirement_activity: "📄",
  testcase_activity: "🧪",
  generation_activity: "🤖",
  export_activity: "📤",
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

/** Étiquette de groupe (Aujourd'hui / Hier / date) pour une entrée du fil. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Aujourd'hui";
  if (sameDay(d, yesterday)) return "Hier";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
}

/** Regroupe une liste d'entrées (déjà triées desc) par jour, en préservant l'ordre. */
function groupByDay(items: ProjectActivityEntry[]): Array<{ label: string; entries: ProjectActivityEntry[] }> {
  const groups: Array<{ label: string; entries: ProjectActivityEntry[] }> = [];
  for (const entry of items) {
    const label = dayLabel(entry.created_at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.entries.push(entry);
    } else {
      groups.push({ label, entries: [entry] });
    }
  }
  return groups;
}

interface ProjectActivityFeedProps {
  projectId: string;
}

/**
 * Bouton "Fil d'activité" + panneau latéral listant en continu toutes les
 * actions de l'équipe sur ce projet (création/modification/suppression de
 * modules, exigences, cas de test, générations, exports Jira/Confluence...).
 *
 * Contrairement à la cloche de notifications (individuelle : chaque membre
 * n'y voit que ses propres notifications, marquables lues/non-lues), ce
 * panneau montre le même flux — complet — à tout le monde, comme un journal
 * d'activité scrollable ("Aujourd'hui sur ce projet").
 */
export default function ProjectActivityFeed({ projectId }: ProjectActivityFeedProps) {
  const [open, setOpen] = useState(false);
  // Connecté dès que le projet est chargé (comme useProjectRealtime), PAS
  // seulement à la première ouverture du panneau : sinon l'auteur d'une
  // action n'a lui-même jamais rejoint la room WebSocket et ne recevrait pas
  // sa propre entrée en direct — il faudrait recharger la page pour la voir.
  // Avec un socket toujours ouvert pendant que la page projet est affichée,
  // tout le monde (l'acteur ET les autres membres) voit la nouvelle ligne
  // apparaître immédiatement, panneau ouvert ou non.
  const { items, loading, loadingMore, hasMore, error, loadMore } = useProjectActivityFeed(projectId);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el || loadingMore || !hasMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) loadMore();
  };

  const groups = groupByDay(items);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8,
          padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700,
          color: "#1e293b",
        }}
      >
        🕒 Fil d'activité
      </button>

      <div style={{ position: "fixed", inset: 0, zIndex: 2000, pointerEvents: open ? "auto" : "none" }}>
        {/* Overlay */}
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "absolute", inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            backdropFilter: "blur(1.5px)",
            opacity: open ? 1 : 0,
            transition: "opacity 0.3s ease",
          }}
        />

        {/* Panneau */}
        <div
          role="dialog"
          aria-label="Fil d'activité du projet"
          style={{
            position: "absolute", top: 0, right: 0, bottom: 0,
            width: "min(420px, 100vw)",
            background: "#ffffff",
            boxShadow: "-12px 0 40px rgba(15, 23, 42, 0.18)",
            transform: open ? "translateX(0)" : "translateX(100%)",
            transition: "transform 0.32s cubic-bezier(0.16, 1, 0.3, 1)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <div style={{
            padding: "18px 20px",
            background: "linear-gradient(135deg, #122c89 0%, #1f40d3 100%)",
            color: "#fff",
            flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, letterSpacing: 0.4, textTransform: "uppercase" }}>
                  🕒 Fil d'activité
                </div>
                <div style={{ fontSize: 17, fontWeight: 800, marginTop: 2 }}>
                  Aujourd'hui sur ce projet
                </div>
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
                  Toutes les actions de l'équipe, en direct
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Fermer"
                style={{
                  background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 8,
                  width: 30, height: 30, color: "#fff", fontSize: 16, cursor: "pointer",
                  flexShrink: 0, lineHeight: 1,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.28)")}
                onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.15)")}
              >
                ✕
              </button>
            </div>
          </div>

          {/* Body — scrollable, scroll infini */}
          <div ref={bodyRef} onScroll={handleScroll} style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            {loading && items.length === 0 ? (
              <div style={{ padding: "28px 20px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                Chargement du fil d'activité…
              </div>
            ) : error && items.length === 0 ? (
              <div style={{ padding: "28px 20px", textAlign: "center", color: "#ef4444", fontSize: 13 }}>
                {error}
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: "28px 20px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                Aucune activité pour l'instant sur ce projet.
              </div>
            ) : (
              groups.map(group => (
                <div key={group.label}>
                  <div style={{
                    position: "sticky", top: 0, background: "#f8fafc",
                    padding: "6px 20px", fontSize: 11, fontWeight: 800,
                    color: "#64748b", textTransform: "uppercase", letterSpacing: 0.4,
                    borderBottom: "1px solid #f1f5f9", borderTop: "1px solid #f1f5f9",
                  }}>
                    {group.label}
                  </div>
                  {group.entries.map(entry => (
                    <div
                      key={entry.id}
                      style={{
                        display: "flex", gap: 10, padding: "10px 20px",
                        borderBottom: "1px solid #f8fafc",
                      }}
                    >
                      <div style={{ fontSize: 16, flexShrink: 0 }}>{TYPE_ICON[entry.type] ?? "🔔"}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "#1e293b", lineHeight: 1.4 }}>{entry.message}</div>
                        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{timeAgo(entry.created_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}

            {loadingMore && (
              <div style={{ padding: "14px 20px", textAlign: "center", color: "#94a3b8", fontSize: 12 }}>
                Chargement…
              </div>
            )}
            {!loading && !hasMore && items.length > 0 && (
              <div style={{ padding: "14px 20px", textAlign: "center", color: "#cbd5e1", fontSize: 11 }}>
                — Début du fil d'activité —
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}