"use client";

import { useEffect, useState } from "react";
import CommentThread from "./CommentThread";
import { useCommentsDrawer } from "../context/CommentsDrawerContext";

const ENTITY_META: Record<string, { icon: string; label: string }> = {
  requirement: { icon: "📄", label: "Exigence" },
  test_case: { icon: "🧪", label: "Cas de test" },
};

export default function CommentsDrawer() {
  const { target, close } = useCommentsDrawer();
  // Reste monté pendant l'animation de sortie (300ms) avant de démonter le contenu.
  const [mountedTarget, setMountedTarget] = useState(target);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (target) {
      setMountedTarget(target);
      // Laisse le navigateur peindre l'état "fermé" avant de déclencher la transition d'ouverture.
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else {
      setVisible(false);
      const t = setTimeout(() => setMountedTarget(null), 300);
      return () => clearTimeout(t);
    }
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, close]);

  if (!mountedTarget) return null;

  const meta = ENTITY_META[mountedTarget.entityType] ?? { icon: "💬", label: "" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000, pointerEvents: target ? "auto" : "none" }}>
      {/* Overlay — assombrit tout le reste au clic pour fermer */}
      <div
        onClick={close}
        style={{
          position: "absolute", inset: 0,
          background: "rgba(15, 23, 42, 0.45)",
          backdropFilter: "blur(1.5px)",
          opacity: visible ? 1 : 0,
          transition: "opacity 0.3s ease",
        }}
      />

      {/* Panneau */}
      <div
        role="dialog"
        aria-label="Commentaires"
        style={{
          position: "absolute", top: 0, right: 0, bottom: 0,
          width: "min(420px, 100vw)",
          background: "#ffffff",
          boxShadow: "-12px 0 40px rgba(15, 23, 42, 0.18)",
          transform: visible ? "translateX(0)" : "translateX(100%)",
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
                {meta.icon} {meta.label}
              </div>
              <div style={{ fontSize: 17, fontWeight: 800, marginTop: 2 }}>
                {mountedTarget.title || "Commentaires"}
              </div>
            </div>
            <button
              onClick={close}
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

        {/* Body — scrollable */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px" }}>
          <CommentThread
            projectId={mountedTarget.projectId}
            entityType={mountedTarget.entityType}
            entityId={mountedTarget.entityId}
          />
        </div>
      </div>
    </div>
  );
}
