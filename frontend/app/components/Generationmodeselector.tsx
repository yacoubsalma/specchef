"use client";

import { useState, type ReactNode } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GenerationMode = "fast" | "assisted" | "explicit";

interface GenerationModeSelectorProps {
  reqId: string;
  reqDesc: string;
  onSelect: (mode: GenerationMode) => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

// ─── Icons ──────────────────────────────────────────────────────────────────

export default function GenerationModeSelector({
  reqId,
  reqDesc,
  onSelect,
  onClose,
}: GenerationModeSelectorProps) {
  const [hovered, setHovered] = useState<GenerationMode | null>(null);

  const modes: {
    id: GenerationMode;
    icon: ReactNode;
    title: string;
    subtitle: string;
    description: string;
    badge: string;
    badgeColor: string;
    borderColor: string;
    accentColor: string;
    bgColor: string;
  }[] = [
    {
      id: "fast",
      icon: "⚡",
      title: "Mode Flash",
      subtitle: "Génération directe",
      description:
        "L'IA génère les cas de test directement depuis l'exigence. Les TCs générés restent en attente : tu les valides ensuite un par un. Idéal pour les exigences simples, bien documentées et de portée limitée.",
      badge: "Génération rapide",
      badgeColor: "#0d9488",
      borderColor: "#0d9488",
      accentColor: "#0f766e",
      bgColor: "#f0fdf4",
    },
    {
      id: "assisted",
      icon: "✦",
      title: "Mode Création",
      subtitle: "Plan de test à valider",
      description:
        "L'IA analyse le requirement et te propose son plan de test (résumé + angles). Tu coches, édites ou complètes les angles, puis elle génère les TCs sur cette base validée.",
      badge: "Validation",
      badgeColor: "#7c3aed",
      borderColor: "#7c3aed",
      accentColor: "#6d28d9",
      bgColor: "#f5f3ff",
    },
    {
      id: "explicit",
      icon: (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/icons/toque.png"
          alt=""
          style={{ width: 26, height: 26, objectFit: "contain" }}
        />
      ),
      title: "Mode Signature",
      subtitle: "Formulaire assisté",
      description:
        "Remplissez le formulaire assisté : champs, valeurs limites, règles, flux conditionnels, auth, CRUD… Génération la plus précise et exhaustive.",
      badge: "Précis",
      badgeColor: "#2563eb",
      borderColor: "#2563eb",
      accentColor: "#1d4ed8",
      bgColor: "#eff6ff",
    },
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
        backdropFilter: "blur(4px)",
        padding: "20px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: 18,
          width: "100%",
          maxWidth: 680,
          boxShadow: "0 32px 64px rgba(0,0,0,0.22)",
          fontFamily: "'JetBrains Mono', monospace",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: "22px 28px 18px",
            borderBottom: "2px solid #e2e8f0",
            background: "linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                color: "#94a3b8",
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Mode de génération
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 900,
                color: "#0f172a",
                letterSpacing: "-0.01em",
                marginBottom: 6,
              }}
            >
              Comment générer les cas de test ?
            </div>
            {/* Requirement badge */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                background: "#2563eb10",
                border: "1.5px solid #2563eb30",
                borderRadius: 7,
                padding: "5px 12px",
                maxWidth: "100%",
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  color: "#2563eb",
                  flexShrink: 0,
                }}
              >
                {reqId}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: "#475569",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontWeight: 600,
                }}
              >
                {reqDesc}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "#f1f5f9",
              border: "1.5px solid #e2e8f0",
              fontSize: 18,
              color: "#64748b",
              cursor: "pointer",
              width: 34,
              height: 34,
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#e2e8f0";
              e.currentTarget.style.color = "#0f172a";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#f1f5f9";
              e.currentTarget.style.color = "#64748b";
            }}
          >
            ✕
          </button>
        </div>

        {/* ── Mode Cards ── */}
        <div
          style={{
            padding: "20px 24px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {modes.map((mode) => {
            const isHovered = hovered === mode.id;
            return (
              <button
                key={mode.id}
                onClick={() => onSelect(mode.id)}
                onMouseEnter={() => setHovered(mode.id)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 16,
                  padding: "18px 20px",
                  background: isHovered ? mode.bgColor : "#ffffff",
                  border: `2px solid ${isHovered ? mode.borderColor : "#e2e8f0"}`,
                  borderRadius: 12,
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "'JetBrains Mono', monospace",
                  transition: "all 0.18s ease",
                  boxShadow: isHovered
                    ? `0 4px 16px ${mode.borderColor}22`
                    : "0 1px 4px rgba(0,0,0,0.05)",
                  transform: isHovered ? "translateY(-1px)" : "none",
                }}
              >
                {/* Icon */}
                <div
                  style={{
                    width: 44,
                    height: 44,
                    background: isHovered ? mode.borderColor + "22" : "#f8fafc",
                    border: `1.5px solid ${isHovered ? mode.borderColor + "50" : "#e2e8f0"}`,
                    borderRadius: 10,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 20,
                    color: isHovered ? mode.accentColor : "#475569",
                    flexShrink: 0,
                    transition: "all 0.18s",
                  }}
                >
                  {mode.icon}
                </div>

                {/* Text */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 4,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 900,
                        color: isHovered ? mode.accentColor : "#0f172a",
                        transition: "color 0.18s",
                      }}
                    >
                      {mode.title}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "#64748b",
                        fontWeight: 600,
                      }}
                    >
                      — {mode.subtitle}
                    </span>
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 800,
                        color: mode.badgeColor,
                        background: mode.badgeColor + "18",
                        border: `1px solid ${mode.badgeColor}40`,
                        borderRadius: 4,
                        padding: "2px 7px",
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                      }}
                    >
                      {mode.badge}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "#64748b",
                      lineHeight: 1.7,
                      fontWeight: 500,
                    }}
                  >
                    {mode.description}
                  </div>
                </div>

                {/* Arrow */}
                <div
                  style={{
                    fontSize: 18,
                    color: isHovered ? mode.borderColor : "#cbd5e1",
                    flexShrink: 0,
                    alignSelf: "center",
                    transition: "all 0.18s",
                    transform: isHovered ? "translateX(3px)" : "none",
                  }}
                >
                  →
                </div>
              </button>
            );
          })}
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            padding: "12px 24px",
            borderTop: "1px solid #f1f5f9",
            fontSize: 10,
            color: "#94a3b8",
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          · Le mode peut être changé à chaque génération
        </div>
      </div>
    </div>
  );
}