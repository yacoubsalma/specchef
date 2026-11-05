"use client";

/**
 * AnglesPreview — Mode Création (prévisualisation des angles Phase A avant génération)
 *
 * Flux :
 *   1. À l'ouverture, appelle POST /llm/preview-angles/:requirementId
 *      → Phase A tourne (déjà existante côté backend), renvoie { summary, angles }
 *   2. Affiche la phrase de synthèse de l'IA + la liste des angles, chacun :
 *      coché par défaut, texte éditable, type de TC affiché en badge
 *   3. L'utilisateur peut décocher / éditer / ajouter des angles
 *   4. Au clic "Générer" → onApprove(angles cochés) — le parent appelle
 *      generate-requirement avec approvedAngles, ce qui SKIP Phase A et
 *      va direct en Phase B avec exactement ces angles.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { FormRequirement } from "@/app/components/AssistTest";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreviewAngle {
  localId: string; // id stable côté front uniquement (pas envoyé au backend)
  focus: string;
  tcType?: string;
  included: boolean;
  isNew?: boolean; // ajouté manuellement par l'utilisateur
}

export interface AnglesPreviewApproval {
  angles: { focus: string; tcType?: string }[];
}

export interface DedupRejection {
  focus: string;
  tcType?: string;
  attemptedTitle: string;
  similarTitle?: string;
  reason: string;
}

interface AnglesPreviewProps {
  requirement: FormRequirement;
  apiBaseUrl: string;
  model: string;
  projectId?: string | null;
  /** Utilisateur courant — transmis à l'API pour que les AUTRES utilisateurs
   *  voient précisément "génère les angles de test" pendant cette Phase A
   *  (diffusion best-effort, sans verrou — voir apiPreviewAngles). */
  actorId?: string;
  actorName?: string;
  onApprove: (result: AnglesPreviewApproval) => void;
  onForceGenerate: (rejectionsToForce: DedupRejection[]) => void;
  onClose: () => void;
  onSwitchToExplicit?: () => void;
  isGenerating?: boolean;
  externalError?: string | null;
  dedupRejections?: DedupRejection[] | null;
  // Suivi temps réel : renseigné si un AUTRE utilisateur génère déjà des cas
  // de test sur cette même exigence (verrou serveur par exigence, valable
  // quel que soit le mode utilisé par l'autre utilisateur). Mis à jour en
  // direct — reste exact même si la génération démarre APRÈS l'ouverture.
  // `genMode`/`step` détaillent précisément ce que fait cet autre utilisateur
  // (Mode Flash/Création/Signature ; angles, cas de test, ou remplissage du
  // formulaire Signature) — voir formatGenerationStatus côté page parente.
  liveGenerationLock?: { actorName: string; genMode?: string; step?: string } | null;
}

const TC_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  positive: { label: "Positif", color: "#0d9488" },
  negative: { label: "Négatif", color: "#dc2626" },
  boundary: { label: "Limite", color: "#d97706" },
  edge: { label: "Edge case", color: "#d97706" },
  security: { label: "Sécurité", color: "#7c3aed" },
  performance: { label: "Performance", color: "#2563eb" },
};

const TC_TYPE_OPTIONS = Object.entries(TC_TYPE_LABELS).map(([value, { label }]) => ({ value, label }));

function tcTypeMeta(tcType?: string) {
  if (!tcType) return { label: "Non classé", color: "#94a3b8" };
  return TC_TYPE_LABELS[tcType.toLowerCase()] || { label: tcType, color: "#64748b" };
}

let localIdCounter = 0;
function makeLocalId() {
  localIdCounter += 1;
  return `angle-${Date.now()}-${localIdCounter}`;
}

function formatDuration(ms?: number | null): string {
  if (typeof ms !== "number" || Number.isNaN(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}min ${rest}s`;
}

// Même code couleur que le reste de l'app : vert = rapide (<5min), orange = moyen
// (<15min), rouge = lent (≥15min).
function durationColor(ms?: number | null): string {
  if (typeof ms !== "number" || Number.isNaN(ms) || ms < 0) return "#94a3b8";
  if (ms < 5 * 60_000) return "#059669";
  if (ms < 15 * 60_000) return "#d97706";
  return "#dc2626";
}

// ─── API helper ───────────────────────────────────────────────────────────────

async function apiPreviewAngles(
  apiBaseUrl: string,
  reqUUID: string,
  model: string,
  projectId?: string | null,
  actorId?: string,
  actorName?: string,
): Promise<{ summary: string; angles: { focus: string; tcType?: string }[]; duration_ms?: number; requirementQuality?: { level: 'ok' | 'warn' | 'poor'; message?: string; suggestedMode?: string } }> {
  const res = await fetch(`${apiBaseUrl}/llm/preview-angles/${reqUUID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, project_id: projectId || "default", actorId, actorName }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return { summary: data.summary || "", angles: Array.isArray(data.angles) ? data.angles : [], duration_ms: data.duration_ms, requirementQuality: data.requirementQuality };
}

// ─── Libellé détaillé mode + étape (miroir de formatGenerationStatus dans
// analyzer/page.tsx — dupliqué ici car ce composant n'importe pas ce module) ──
const GEN_MODE_LABELS: Record<string, string> = { fast: "Mode Flash", assisted: "Mode Création", explicit: "Mode Signature" };
const GEN_STEP_LABELS: Record<string, string> = {
  angles: "génère les angles de test",
  testcases: "génère les cas de test",
  form: "remplit le formulaire assisté",
};
function formatLockStatus(lock: { actorName: string; genMode?: string; step?: string }): string {
  const modeLabel = lock.genMode && GEN_MODE_LABELS[lock.genMode] ? ` (${GEN_MODE_LABELS[lock.genMode]})` : "";
  const stepLabel = lock.step && GEN_STEP_LABELS[lock.step] ? GEN_STEP_LABELS[lock.step] : "génère des cas de test";
  return `${lock.actorName}${modeLabel} ${stepLabel}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Spinner({ size = 14, color = "#7c3aed" }: { size?: number; color?: string }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        border: `2px solid ${color}30`,
        borderTopColor: color,
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

function AngleRow({
  angle,
  onToggle,
  onEdit,
  onEditType,
  onRemove,
}: {
  angle: PreviewAngle;
  onToggle: () => void;
  onEdit: (text: string) => void;
  onEditType: (tcType: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(angle.focus);
  const meta = tcTypeMeta(angle.tcType);

  const commitEdit = () => {
    const trimmed = draft.trim();
    if (trimmed) onEdit(trimmed);
    else setDraft(angle.focus);
    setEditing(false);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 10,
        border: `1.5px solid ${angle.included ? "#e2e8f0" : "#e2e8f060"}`,
        background: angle.included ? "#ffffff" : "#f8fafc",
        opacity: angle.included ? 1 : 0.55,
        transition: "all 0.15s",
      }}
    >
      {/* Checkbox */}
      <button
        onClick={onToggle}
        style={{
          width: 18,
          height: 18,
          marginTop: 1,
          borderRadius: 5,
          border: `2px solid ${angle.included ? "#7c3aed" : "#cbd5e1"}`,
          background: angle.included ? "#7c3aed" : "transparent",
          cursor: "pointer",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          color: "white",
          transition: "all 0.15s",
        }}
      >
        {angle.included ? "✓" : ""}
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
          <select
            value={angle.tcType || ""}
            onChange={(e) => onEditType(e.target.value)}
            title="Changer le type de ce TC"
            style={{
              fontSize: 9,
              fontWeight: 800,
              color: meta.color,
              background: meta.color + "18",
              border: `1px solid ${meta.color}40`,
              borderRadius: 4,
              padding: "2px 5px",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              cursor: "pointer",
              fontFamily: "'JetBrains Mono', monospace",
              appearance: "none",
              outline: "none",
            }}
          >
            {!angle.tcType && <option value="">NON CLASSÉ</option>}
            {TC_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label.toUpperCase()}</option>
            ))}
          </select>
          {angle.isNew && (
            <span style={{ fontSize: 9, fontWeight: 700, color: "#0d9488" }}>
              ✦ ajouté
            </span>
          )}
        </div>

        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === "Escape") {
                setDraft(angle.focus);
                setEditing(false);
              }
            }}
            rows={2}
            style={{
              width: "100%",
              padding: "6px 8px",
              border: "1.5px solid #7c3aed",
              borderRadius: 7,
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              color: "#0f172a",
              background: "#faf5ff",
              resize: "vertical",
              outline: "none",
              lineHeight: 1.5,
              boxSizing: "border-box",
            }}
          />
        ) : (
          <div
            onClick={() => setEditing(true)}
            title="Cliquer pour éditer"
            style={{
              fontSize: 12,
              color: "#334155",
              lineHeight: 1.5,
              cursor: "text",
              padding: "2px 0",
            }}
          >
            {angle.focus}
          </div>
        )}
      </div>

      {/* Remove */}
      <button
        onClick={onRemove}
        title="Retirer cet angle"
        style={{
          background: "none",
          border: "none",
          color: "#cbd5e1",
          fontSize: 13,
          cursor: "pointer",
          flexShrink: 0,
          padding: "2px 4px",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#dc2626")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "#cbd5e1")}
      >
        ✕
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AnglesPreview({
  requirement,
  apiBaseUrl,
  model,
  projectId,
  actorId,
  actorName,
  onApprove,
  onForceGenerate,
  onClose,
  onSwitchToExplicit,
  isGenerating = false,
  externalError,
  dedupRejections,
  liveGenerationLock,
}: AnglesPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [previewDurationMs, setPreviewDurationMs] = useState<number | undefined>(undefined);
  const [angles, setAngles] = useState<PreviewAngle[]>([]);
  const [newAngleText, setNewAngleText] = useState("");
  const [newAngleType, setNewAngleType] = useState("");
  const [reqQuality, setReqQuality] = useState<{ level: 'ok' | 'warn' | 'poor'; message?: string; suggestedMode?: string } | null>(null);
  const [selectedRejections, setSelectedRejections] = useState<Set<number>>(new Set());
  const fetchedRef = useRef(false);

  // Quand des rejets dedup arrivent, on les sélectionne tous par défaut —
  // l'utilisateur peut décocher ceux qu'il ne veut finalement pas forcer.
  useEffect(() => {
    if (dedupRejections && dedupRejections.length > 0) {
      setSelectedRejections(new Set(dedupRejections.map((_, i) => i)));
    }
  }, [dedupRejections]);

  const toggleRejection = useCallback((index: number) => {
    setSelectedRejections((prev) => {
      const next = new Set(prev);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });
  }, []);

  useEffect(() => {
    if (fetchedRef.current) return;
    if (liveGenerationLock) {
      // Un autre utilisateur génère déjà des cas de test sur cette exigence :
      // on n'appelle pas l'IA (Phase A — génération des angles) tant que ce
      // verrou est actif, pour éviter un calcul inutile en doublon pendant
      // que le serveur refuserait de toute façon la génération finale. On
      // ne marque pas fetchedRef ici : dès que liveGenerationLock repasse à
      // null (mis à jour en direct par le parent via WebSocket), cet effet
      // se redéclenche et lance l'analyse automatiquement.
      setLoading(false);
      return;
    }
    fetchedRef.current = true;
    setLoading(true);
    setLoadError(null);
    apiPreviewAngles(apiBaseUrl, requirement.reqUUID, model, projectId, actorId, actorName)
      .then(({ summary, angles, duration_ms, requirementQuality }) => {
        setSummary(summary);
        setPreviewDurationMs(duration_ms);
        setReqQuality(requirementQuality ?? null);
        setAngles(
          angles.map((a) => ({
            localId: makeLocalId(),
            focus: a.focus,
            tcType: a.tcType,
            included: true,
          }))
        );
      })
      .catch((e: any) => {
        setLoadError(e?.message || "Erreur lors de l'analyse du requirement");
      })
      .finally(() => setLoading(false));
  }, [apiBaseUrl, requirement.reqUUID, model, projectId, liveGenerationLock, actorId, actorName]);

  const toggleAngle = useCallback((localId: string) => {
    setAngles((prev) =>
      prev.map((a) => (a.localId === localId ? { ...a, included: !a.included } : a))
    );
  }, []);

  const editAngle = useCallback((localId: string, text: string) => {
    setAngles((prev) =>
      prev.map((a) => (a.localId === localId ? { ...a, focus: text } : a))
    );
  }, []);

  const editAngleType = useCallback((localId: string, tcType: string) => {
    setAngles((prev) =>
      prev.map((a) => (a.localId === localId ? { ...a, tcType: tcType || undefined } : a))
    );
  }, []);

  const removeAngle = useCallback((localId: string) => {
    setAngles((prev) => prev.filter((a) => a.localId !== localId));
  }, []);

  const addAngle = useCallback(() => {
    const trimmed = newAngleText.trim();
    if (!trimmed) return;
    setAngles((prev) => [
      ...prev,
      { localId: makeLocalId(), focus: trimmed, tcType: newAngleType || undefined, included: true, isNew: true },
    ]);
    setNewAngleText("");
    setNewAngleType("");
  }, [newAngleText, newAngleType]);

  const handleGenerate = useCallback(() => {
    const approved = angles
      .filter((a) => a.included)
      .map((a) => ({ focus: a.focus, tcType: a.tcType }));
    if (approved.length === 0) return;
    onApprove({ angles: approved });
  }, [angles, onApprove]);

  const handleForceGenerate = useCallback(() => {
    if (!dedupRejections) return;
    const toForce = dedupRejections.filter((_, i) => selectedRejections.has(i));
    if (toForce.length === 0) return;
    onForceGenerate(toForce);
  }, [dedupRejections, selectedRejections, onForceGenerate]);

  const includedCount = angles.filter((a) => a.included).length;
  const hasRejections = Boolean(dedupRejections && dedupRejections.length > 0);
  const selectedRejectionCount = selectedRejections.size;
  // Verrou actif ET aucune donnée déjà chargée : l'analyse IA n'a pas été
  // lancée (voir l'effet de fetch plus haut), donc rien à afficher hormis
  // le message d'attente ci-dessous.
  const blockedByLock = Boolean(liveGenerationLock) && !summary && angles.length === 0;

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
          maxWidth: 640,
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 32px 64px rgba(0,0,0,0.22)",
          fontFamily: "'JetBrains Mono', monospace",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: "20px 24px 16px",
            borderBottom: "2px solid #e2e8f0",
            background: "linear-gradient(135deg, #ffffff 0%, #faf5ff 100%)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                color: "#7c3aed",
                fontWeight: 800,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              ✦ Mode Création — Plan de test
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#2563eb10", border: "1.5px solid #2563eb30", borderRadius: 7, padding: "5px 12px", maxWidth: "100%" }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: "#2563eb", flexShrink: 0 }}>
                {requirement.reqId}
              </span>
              <span style={{ fontSize: 11, color: "#475569", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
                {requirement.reqDesc}
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
            }}
          >
            ✕
          </button>
        </div>

        {/* ── Verrou temps réel : quelqu'un d'autre génère déjà sur cette
            exigence (n'importe quel mode). Reste exact même si la génération
            démarre après l'ouverture de cet aperçu — mis à jour en direct par
            le parent via WebSocket. */}
        {liveGenerationLock && (
          <div style={{ padding: "9px 24px", background: "#fffbeb", borderBottom: "1.5px solid #fde68a", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#d97706", flexShrink: 0, animation: "angles-pulse 1.4s infinite" }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "#92400e" }}>
              {formatLockStatus(liveGenerationLock)} pour {requirement.reqId}… vous pourrez générer une fois terminé.
            </span>
          </div>
        )}

        {/* ── Body ── */}
        <div style={{ padding: "18px 24px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          {loading && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "40px 0" }}>
              <Spinner size={22} />
              <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>
                L'IA analyse le requirement…
              </span>
            </div>
          )}

          {!loading && !loadError && blockedByLock && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "40px 0", textAlign: "center" }}>
              <span style={{ fontSize: 26 }}>⏸️</span>
              <span style={{ fontSize: 12.5, color: "#92400e", fontWeight: 700 }}>
                En attente — {formatLockStatus(liveGenerationLock!)} pour cette exigence.
              </span>
              <span style={{ fontSize: 11, color: "#94a3b8", maxWidth: 320 }}>
                L'analyse IA (angles de test) démarrera automatiquement dès que sa génération sera terminée.
              </span>
            </div>
          )}

          {!loading && loadError && (
            <div
              style={{
                padding: "12px 14px",
                background: "#fef2f2",
                border: "1.5px solid #fecaca",
                borderRadius: 10,
                fontSize: 11,
                color: "#dc2626",
                fontWeight: 600,
              }}
            >
              🚫 {loadError}
            </div>
          )}

          {!loading && !loadError && !blockedByLock && hasRejections && (
            <>
              <div
                style={{
                  padding: "12px 14px",
                  background: "#fffbeb",
                  border: "1.5px solid #f59e0b40",
                  borderRadius: 10,
                  fontSize: 12,
                  color: "#92400e",
                  lineHeight: 1.6,
                  fontWeight: 600,
                }}
              >
                ⚠️ {dedupRejections!.length} angle{dedupRejections!.length > 1 ? "s" : ""} n'{dedupRejections!.length > 1 ? "ont" : "a"} pas pu être ajouté{dedupRejections!.length > 1 ? "s" : ""} (trop proche{dedupRejections!.length > 1 ? "s" : ""} d'un TC existant ou échec de génération). Tu peux choisir de les générer quand même.
              </div>

              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#0f172a", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    Angles non générés
                  </span>
                  <span style={{ fontSize: 10, color: "#d97706", fontWeight: 700 }}>
                    {selectedRejectionCount}/{dedupRejections!.length} sélectionné{selectedRejectionCount > 1 ? "s" : ""}
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {dedupRejections!.map((rej, i) => {
                    const meta = tcTypeMeta(rej.tcType);
                    const checked = selectedRejections.has(i);
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: `1.5px solid ${checked ? "#f59e0b50" : "#e2e8f0"}`,
                          background: checked ? "#fffbeb" : "#f8fafc",
                        }}
                      >
                        <button
                          onClick={() => toggleRejection(i)}
                          style={{
                            width: 18,
                            height: 18,
                            marginTop: 1,
                            borderRadius: 5,
                            border: `2px solid ${checked ? "#d97706" : "#cbd5e1"}`,
                            background: checked ? "#d97706" : "transparent",
                            cursor: "pointer",
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 10,
                            color: "white",
                          }}
                        >
                          {checked ? "✓" : ""}
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span
                              style={{
                                fontSize: 9,
                                fontWeight: 800,
                                color: meta.color,
                                background: meta.color + "18",
                                border: `1px solid ${meta.color}40`,
                                borderRadius: 4,
                                padding: "2px 7px",
                                letterSpacing: "0.04em",
                                textTransform: "uppercase",
                              }}
                            >
                              {meta.label}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: "#334155", lineHeight: 1.5 }}>
                            {rej.attemptedTitle}
                          </div>
                          {rej.similarTitle && (
                            <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4, fontStyle: "italic" }}>
                              ≈ proche de : "{rej.similarTitle}"
                            </div>
                          )}
                          {rej.reason === 'generation_failed' && (
                            <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4, fontStyle: "italic" }}>
                              ⏱ échec de génération (timeout ou erreur LLM)
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {!loading && !loadError && !blockedByLock && !hasRejections && (
            <>
              {/* ── Bannière qualité requirement ── */}
              {reqQuality && reqQuality.level !== 'ok' && (
                <div
                  style={{
                    padding: "12px 14px",
                    background: reqQuality.level === 'poor' ? "#fff7ed" : "#fffbeb",
                    border: `1.5px solid ${reqQuality.level === 'poor' ? "#f97316" : "#f59e0b"}`,
                    borderRadius: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>
                      {reqQuality.level === 'poor' ? "⚠️" : "💡"}
                    </span>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: reqQuality.level === 'poor' ? "#c2410c" : "#b45309", marginBottom: 3 }}>
                        {reqQuality.level === 'poor' ? "Requirement insuffisant" : "Requirement peu détaillé"}
                      </div>
                      <div style={{ fontSize: 11, color: "#78350f", lineHeight: 1.6, fontWeight: 500 }}>
                        {reqQuality.message}
                      </div>
                    </div>
                  </div>
                  {reqQuality.suggestedMode && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 23 }}>
                      <span style={{ fontSize: 10, color: "#92400e", fontWeight: 700 }}>Mode recommandé :</span>
                      <span
                        onClick={reqQuality.suggestedMode === 'explicit' ? onSwitchToExplicit : undefined}
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          color: reqQuality.suggestedMode === 'explicit' ? "#7c3aed" : "#0369a1",
                          background: reqQuality.suggestedMode === 'explicit' ? "#faf5ff" : "#f0f9ff",
                          border: `1px solid ${reqQuality.suggestedMode === 'explicit' ? "#7c3aed40" : "#0369a140"}`,
                          borderRadius: 5,
                          padding: "2px 8px",
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          cursor: reqQuality.suggestedMode === 'explicit' && onSwitchToExplicit ? "pointer" : "default",
                          textDecoration: reqQuality.suggestedMode === 'explicit' && onSwitchToExplicit ? "underline" : "none",
                        }}
                      >
                        {reqQuality.suggestedMode === 'explicit' ? "✦ Mode Signature" : "⊞ Formulaire assisté"}
                      </span>
                      <span style={{ fontSize: 10, color: "#a16207", fontWeight: 500 }}>
                        — ou enrichissez la description avant de générer.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Synthèse IA */}
              {summary && (
                <div
                  style={{
                    padding: "12px 14px",
                    background: "#faf5ff",
                    border: "1.5px solid #7c3aed30",
                    borderRadius: 10,
                    fontSize: 12,
                    color: "#4c1d95",
                    lineHeight: 1.6,
                    fontWeight: 600,
                  }}
                >
                  💬 {summary}
                </div>
              )}

              {/* Temps de génération — affiché seul, séparé de la description */}
              {previewDurationMs != null && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 10,
                    fontWeight: 800,
                    color: durationColor(previewDurationMs),
                  }}
                >
                  ⏱ généré en {formatDuration(previewDurationMs)}
                </div>
              )}

              {/* Liste des angles */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: "#0f172a", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                    Angles de test
                  </span>
                  <span style={{ fontSize: 10, color: "#7c3aed", fontWeight: 700 }}>
                    {includedCount}/{angles.length} sélectionné{includedCount > 1 ? "s" : ""}
                  </span>
                </div>

                {angles.length === 0 ? (
                  <div style={{ fontSize: 11, color: "#94a3b8", padding: "12px 0", textAlign: "center" }}>
                    Aucun angle — ajoute-en un manuellement ci-dessous.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {angles.map((angle) => (
                      <AngleRow
                        key={angle.localId}
                        angle={angle}
                        onToggle={() => toggleAngle(angle.localId)}
                        onEdit={(text) => editAngle(angle.localId, text)}
                        onEditType={(tcType) => editAngleType(angle.localId, tcType)}
                        onRemove={() => removeAngle(angle.localId)}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Ajouter un angle */}
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={newAngleType}
                  onChange={(e) => setNewAngleType(e.target.value)}
                  title="Type du TC à ajouter"
                  style={{
                    flexShrink: 0,
                    padding: "8px 8px",
                    border: "1.5px solid #e2e8f0",
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: "#475569",
                    background: "#fafafa",
                    outline: "none",
                    cursor: "pointer",
                  }}
                >
                  <option value="">Non classé</option>
                  {TC_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newAngleText}
                  onChange={(e) => setNewAngleText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addAngle();
                    }
                  }}
                  placeholder="Ajouter un angle manquant…"
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    border: "1.5px solid #e2e8f0",
                    borderRadius: 8,
                    fontSize: 12,
                    fontFamily: "'JetBrains Mono', monospace",
                    color: "#0f172a",
                    background: "#fafafa",
                    outline: "none",
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = "#7c3aed")}
                  onBlur={(e) => (e.currentTarget.style.borderColor = "#e2e8f0")}
                />
                <button
                  onClick={addAngle}
                  disabled={!newAngleText.trim()}
                  style={{
                    padding: "8px 14px",
                    border: "1.5px solid #7c3aed40",
                    borderRadius: 8,
                    background: newAngleText.trim() ? "#7c3aed18" : "#f8fafc",
                    color: "#6d28d9",
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: newAngleText.trim() ? "pointer" : "not-allowed",
                    fontFamily: "'JetBrains Mono', monospace",
                    whiteSpace: "nowrap",
                  }}
                >
                  + Ajouter
                </button>
              </div>
            </>
          )}

          {/* Error banner (génération) */}
          {externalError && (
            <div
              style={{
                padding: "10px 14px",
                background: "#fef2f2",
                border: "1.5px solid #fecaca",
                borderRadius: 10,
                fontSize: 11,
                color: "#dc2626",
                fontWeight: 600,
              }}
            >
              🚫 {externalError}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1.5px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            background: "#f8fafc",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 500 }}>
            {loading
              ? "Analyse en cours…"
              : hasRejections
              ? selectedRejectionCount > 0
                ? `${selectedRejectionCount} TC(s) seront forcés malgré la similarité`
                : "Sélectionne au moins un TC à forcer, ou ferme cette fenêtre"
              : includedCount > 0
              ? `${includedCount} angle(s) seront générés en TCs`
              : "Sélectionne au moins un angle"}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              disabled={isGenerating}
              style={{
                padding: "8px 16px",
                border: "1.5px solid #e2e8f0",
                borderRadius: 8,
                background: "#ffffff",
                color: "#64748b",
                fontSize: 12,
                fontWeight: 700,
                cursor: isGenerating ? "not-allowed" : "pointer",
                fontFamily: "'JetBrains Mono', monospace",
                opacity: isGenerating ? 0.5 : 1,
              }}
            >
              {hasRejections ? "Ignorer et terminer" : "Annuler"}
            </button>
            {hasRejections ? (
              <button
                onClick={handleForceGenerate}
                disabled={isGenerating || selectedRejectionCount === 0 || !!liveGenerationLock}
                title={liveGenerationLock ? formatLockStatus(liveGenerationLock) : undefined}
                style={{
                  padding: "8px 20px",
                  border: "none",
                  borderRadius: 8,
                  background: isGenerating || selectedRejectionCount === 0 || !!liveGenerationLock ? "#fbbf24" : "#d97706",
                  color: "#ffffff",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: isGenerating || selectedRejectionCount === 0 || !!liveGenerationLock ? "not-allowed" : "pointer",
                  fontFamily: "'JetBrains Mono', monospace",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  transition: "background 0.15s",
                }}
              >
                {isGenerating ? (
                  <>
                    <Spinner color="#ffffff" />
                    Génération…
                  </>
                ) : (
                  `⚠️ Générer quand même (${selectedRejectionCount})`
                )}
              </button>
            ) : (
              <button
                onClick={handleGenerate}
                disabled={isGenerating || loading || includedCount === 0 || !!liveGenerationLock}
                title={liveGenerationLock ? formatLockStatus(liveGenerationLock) : undefined}
                style={{
                  padding: "8px 20px",
                  border: "none",
                  borderRadius: 8,
                  background: isGenerating || loading || includedCount === 0 || !!liveGenerationLock ? "#a78bfa" : "#7c3aed",
                  color: "#ffffff",
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: isGenerating || loading || includedCount === 0 || !!liveGenerationLock ? "not-allowed" : "pointer",
                  fontFamily: "'JetBrains Mono', monospace",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  transition: "background 0.15s",
                }}
              >
                {isGenerating ? (
                  <>
                    <Spinner color="#ffffff" />
                    Génération…
                  </>
                ) : (
                  `✦ Générer (${includedCount})`
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } } @keyframes angles-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(217,119,6,0); } 50% { box-shadow: 0 0 0 3px rgba(217,119,6,0.25); } }`}</style>
    </div>
  );
}