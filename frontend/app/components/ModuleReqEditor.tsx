"use client";
/**
 * ModuleReqEditor — CRUD inline pour modules et exigences
 * Toutes les modifications sont persistées en base via l'API NestJS.
 */

import { useState, useRef, useEffect } from "react";
import { TraceabilityBadge } from "./RequirementTraceability";
import ConfirmDeleteModal from "./ConfirmDeleteModal";
import VersionHistoryPanel from "./VersionHistoryPanel";

// ─── Palette ──────────────────────────────────────────────────────────────────
const C = {
  teal:        "#0f766e",
  tealLight:   "#0d948820",
  tealBorder:  "#0d948840",
  tealText:    "#0d9488",
  red:         "#ef4444",
  redLight:    "#fee2e2",
  redBorder:   "#fca5a5",
  amber:       "#f59e0b",
  amberLight:  "#fef3c7",
  slate100:    "#f1f5f9",
  slate200:    "#e2e8f0",
  slate400:    "#94a3b8",
  slate500:    "#64748b",
  slate700:    "#334155",
  slate900:    "#0f172a",
  white:       "#ffffff",
};

// ─── Types ────────────────────────────────────────────────────────────────────
type Priority = "SHALL" | "SHOULD" | "MAY" | "MUST";

export interface EditorReq {
  id: string;          // req_id métier (FR-01)
  _uuid?: string;      // DB ObjectId
  description: string;
  priority: Priority;
  needsReview?: boolean;
  needsReviewReason?: string | null;
  /** Horodatage de dernière modification côté serveur — sert de base au
   *  contrôle de version optimiste (voir patchReq dans ReqEditRow) : envoyé
   *  tel quel en `expectedUpdatedAt` à la sauvegarde, pour que le backend
   *  détecte si quelqu'un d'autre a modifié l'exigence entre-temps. */
  updatedAt?: string | null;
}

export interface EditorModule {
  name: string;
  _uuid?: string;      // DB ObjectId du module
  description?: string;
  requirements: EditorReq[];
}

interface ModuleReqEditorProps {
  apiBaseUrl: string;
  projectId: string | null | undefined;
  modules: EditorModule[];
  onModuleAdded:    (mod: EditorModule) => void;
  onModuleEdited:   (oldName: string, patch: Partial<EditorModule>) => void;
  onModuleDeleted:  (name: string) => void;
  onReqAdded:       (moduleName: string, req: EditorReq) => void;
  onReqEdited:      (moduleName: string, reqId: string, patch: Partial<EditorReq>) => void;
  onReqDeleted:     (moduleName: string, reqId: string) => void;
  onImpact?:        (impact: ImpactInfo) => void;
  /** Appelé quand un impact affiché en ligne est résolu (gardé ou annulé) — permet de fermer un modal global éventuellement ouvert sur le même impact. */
  onImpactResolved?: () => void;
  /** Signal envoyé par un modal global (ou tout autre affichage externe) quand un impact vient d'être résolu ailleurs, pour fermer le bandeau en ligne correspondant. */
  resolvedImpact?: { uuid: string; nonce: number; phase?: "start" | "done" | "error" } | null;
  /** Exigences actuellement éditées par un AUTRE utilisateur (clé = _uuid),
   *  alimenté en direct via WebSocket (requirement:editing) — voir
   *  page.tsx/handleProjectRealtimeEvent. Purement informatif : le vrai
   *  filet de sécurité contre l'écrasement reste le contrôle de version
   *  optimiste (409 renvoyé par PATCH /projects/requirements/:id). */
  activeEdits?: Record<string, { actorName: string }>;
  /** Appelé au focus/blur d'un champ d'exigence pour poser/libérer le verrou d'édition côté serveur. Pour `active: true`, la promesse résolue indique si le verrou a été accordé. */
  onEditingChange?: (reqUUID: string, active: boolean) => Promise<{ ok: boolean; lockedByName?: string }>;
  /** Campagne de tests en cours (voir analyzer/page.tsx → campaignStatus) :
   *  fige TOUT l'éditeur (modules + exigences) en lecture seule — plus
   *  aucune création/modification/suppression n'est possible tant que la
   *  campagne n'est pas clôturée. Le backend applique la même règle
   *  indépendamment (ProjectService.assertProjectUnlocked) : cette prop ne
   *  sert qu'à donner un feedback UI immédiat, pas de sécurité côté client. */
  locked?: boolean;
}

const PRIORITIES: Priority[] = ["SHALL", "SHOULD", "MAY", "MUST"];

// ─── Message d'impact lisible (remplace le score cosinus brut "similarité") ──
export type ImpactInfo = {
  changed: boolean;
  similarity: number | null;
  testCasesFlagged: number;
  impactedRequirements: { id: string; req_id: string; similarity: number }[];
  /** UUID DB de l'exigence éditée — nécessaire pour proposer le retour en arrière. */
  requirementUuid: string;
  /** Description telle qu'elle était AVANT cette édition — pour le bouton "Revenir à l'ancienne version". */
  previousDescription: string;
};

export function describeImpact(impact: ImpactInfo): { icon: string; title: string; text: string; tone: "info" | "warn" | "danger" } {
  const uniqueReqIds = Array.from(new Set(impact.impactedRequirements.map(r => r.req_id)));

  if (!impact.changed) {
    return {
      icon: "ℹ️", title: "Modification mineure",
      text: "Ce changement est trop léger pour affecter les cas de test existants. Rien à réviser.",
      tone: "info",
    };
  }
  if (impact.testCasesFlagged === 0) {
    return {
      icon: "⚠️", title: "Impact détecté",
      text: `Ce changement est significatif, mais n'impacte aucun cas de test existant pour l'instant.${uniqueReqIds.length > 0 ? ` Il concerne toutefois ${uniqueReqIds.length > 1 ? "les exigences" : "l'exigence"} ${uniqueReqIds.join(", ")}, désormais marquée(s) à réviser.` : ""}`,
      tone: "warn",
    };
  }
  return {
    icon: "⚠️", title: "Impact détecté",
    text: `Ce changement va impacter ${impact.testCasesFlagged} cas de test, désormais marqué(s) « à réviser »${uniqueReqIds.length > 0 ? `, ainsi que ${uniqueReqIds.length > 1 ? "les exigences" : "l'exigence"} ${uniqueReqIds.join(", ")}` : ""}.`,
    tone: "warn",
  };
}

const priorityColor = (p: Priority) => ({
  SHALL: "#dc2626", SHOULD: "#d97706", MAY: "#60a5fa", MUST: "#1d4ed8",
}[p] ?? "#94a3b8");

// ─── Spinner ──────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <span style={{
      display: "inline-block", width: 12, height: 12,
      border: "2px solid currentColor", borderTopColor: "transparent",
      borderRadius: "50%", animation: "mre-spin 0.7s linear infinite",
    }} />
  );
}

// ─── IconBtn ──────────────────────────────────────────────────────────────────
function IconBtn({
  icon, title, color = C.slate400, hoverColor = C.teal,
  onClick, disabled = false,
}: {
  icon: string; title: string; color?: string; hoverColor?: string;
  onClick: (e: React.MouseEvent) => void; disabled?: boolean;
}) {
  const [hov, setHov] = useState(false);
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: "transparent", border: "none", cursor: disabled ? "not-allowed" : "pointer",
        padding: "4px 6px", borderRadius: 5, fontSize: 13,
        color: hov && !disabled ? hoverColor : color,
        transition: "color 0.15s", opacity: disabled ? 0.4 : 1,
      }}
    >
      {icon}
    </button>
  );
}

// ─── InlineEdit ───────────────────────────────────────────────────────────────
function InlineEdit({
  value, onSave, onCancel, placeholder = "", mono = false, multiline = false,
}: {
  value: string; onSave: (v: string) => void; onCancel: () => void;
  placeholder?: string; mono?: boolean; multiline?: boolean;
}) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  const commit = () => { if (v.trim()) onSave(v.trim()); };
  const keyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !multiline) { e.preventDefault(); commit(); }
    if (e.key === "Escape") onCancel();
  };

  const sharedStyle: React.CSSProperties = {
    fontFamily: mono ? "'JetBrains Mono', monospace" : "inherit",
    fontSize: 13, border: `1.5px solid ${C.teal}`, borderRadius: 6,
    padding: "4px 8px", background: C.white, color: C.slate900,
    outline: "none", width: "100%", boxSizing: "border-box",
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-start", width: "100%" }}>
      {multiline ? (
        <textarea ref={ref as any} value={v} onChange={e => setV(e.target.value)}
          onKeyDown={keyDown} placeholder={placeholder} rows={2}
          style={{ ...sharedStyle, resize: "vertical" }} />
      ) : (
        <input ref={ref as any} value={v} onChange={e => setV(e.target.value)}
          onKeyDown={keyDown} placeholder={placeholder} style={sharedStyle} />
      )}
      <button onClick={commit} style={{
        padding: "4px 10px", borderRadius: 6, border: "none",
        background: C.teal, color: C.white, fontSize: 12, fontWeight: 700,
        cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
      }}>✓</button>
      <button onClick={onCancel} style={{
        padding: "4px 8px", borderRadius: 6, border: `1px solid ${C.slate200}`,
        background: C.slate100, color: C.slate500, fontSize: 12, fontWeight: 700,
        cursor: "pointer", flexShrink: 0,
      }}>✕</button>
    </div>
  );
}

// ─── AddForm ──────────────────────────────────────────────────────────────────
function AddForm({
  fields, submitLabel, onSubmit, onCancel, keepOpenAfterSubmit = false, autoFocusFirst = true,
}: {
  fields: { key: string; label: string; placeholder: string; required?: boolean; type?: "select"; options?: string[] }[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onCancel: () => void;
  /** Si true : après un ajout réussi, le formulaire se vide et reste ouvert pour enchaîner (utile pour saisir plusieurs exigences à la suite, comme un formulaire). */
  keepOpenAfterSubmit?: boolean;
  /** Si true : le premier champ reçoit le focus à l'ouverture, pour pouvoir écrire immédiatement. */
  autoFocusFirst?: boolean;
}) {
  const defaults = () => Object.fromEntries(fields.map(f => [f.key, f.options?.[0] ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(defaults());
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState("");
  const [justAdded, setJustAdded] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (autoFocusFirst) firstFieldRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handle = async () => {
    setErr("");
    for (const f of fields) {
      if (f.required && !values[f.key]?.trim()) { setErr(`"${f.label}" est requis`); return; }
    }
    setBusy(true);
    try {
      await onSubmit(values);
      if (keepOpenAfterSubmit) {
        setValues(defaults());
        setJustAdded(true);
        setTimeout(() => setJustAdded(false), 1500);
        firstFieldRef.current?.focus();
      }
    }
    catch (e: any) { setErr(e.message ?? "Erreur"); }
    finally { setBusy(false); }
  };

  return (
    <div style={{
      background: "#f8fafc", border: `1.5px solid ${C.teal}`, borderRadius: 10,
      padding: "14px 16px", marginTop: 8,
    }}>
      {fields.map((f, i) => (
        <div key={f.key} style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: C.slate500, letterSpacing: "0.05em", textTransform: "uppercase" }}>
            {f.label}{f.required && <span style={{ color: C.red }}> *</span>}
          </label>
          {f.type === "select" ? (
            <select value={values[f.key]} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
              style={{
                display: "block", width: "100%", marginTop: 4, padding: "6px 8px",
                border: `1.5px solid ${C.slate200}`, borderRadius: 6,
                fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                background: C.white, color: C.slate900, outline: "none",
              }}>
              {f.options?.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              ref={i === 0 ? firstFieldRef : undefined}
              value={values[f.key]} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              onKeyDown={e => { if (e.key === "Enter") handle(); if (e.key === "Escape") onCancel(); }}
              style={{
                display: "block", width: "100%", marginTop: 4, padding: "6px 8px",
                border: `1.5px solid ${C.slate200}`, borderRadius: 6,
                fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                background: C.white, color: C.slate900, outline: "none", boxSizing: "border-box",
              }} />
          )}
        </div>
      ))}
      {err && <div style={{ fontSize: 11, color: C.red, marginBottom: 8 }}>⚠ {err}</div>}
      {justAdded && <div style={{ fontSize: 11, color: C.tealText, marginBottom: 8, fontWeight: 700 }}>✓ Ajouté — continuez avec le suivant</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button onClick={handle} disabled={busy} style={{
          padding: "6px 14px", borderRadius: 6, border: "none",
          background: busy ? C.slate200 : C.teal, color: busy ? C.slate400 : C.white,
          fontSize: 12, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer",
          fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6,
        }}>
          {busy ? <Spinner /> : null}{submitLabel}
        </button>
        <button onClick={onCancel} style={{
          padding: "6px 12px", borderRadius: 6, border: `1px solid ${C.slate200}`,
          background: "transparent", color: C.slate500, fontSize: 12, fontWeight: 700,
          cursor: "pointer", fontFamily: "inherit",
        }}>{keepOpenAfterSubmit ? "Terminer" : "Annuler"}</button>
      </div>
    </div>
  );
}

// ─── StatusBadge — feedback visuel inline ─────────────────────────────────────
export type RowStatus = "saving" | "saved" | "error" | "reverting" | "reverted";
function StatusBadge({ status }: { status: RowStatus | null }) {
  if (!status) return null;
  const cfg = {
    saving:    { label: "Sauvegarde...",              bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
    saved:     { label: "✓ Sauvegardé",                bg: "#d1fae5", color: "#065f46", border: "#6ee7b7" },
    error:     { label: "✗ Erreur",                    bg: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
    reverting: { label: "↩ Restauration en cours...",  bg: "#e0f2fe", color: "#075985", border: "#7dd3fc" },
    reverted:  { label: "✓ Version restaurée",         bg: "#d1fae5", color: "#065f46", border: "#6ee7b7" },
  }[status];
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
      background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
      display: "inline-flex", alignItems: "center", gap: 4,
    }}>
      {(status === "saving" || status === "reverting") && <Spinner />}{cfg.label}
    </span>
  );
}


// ─── ReqEditRow ───────────────────────────────────────────────────────────────
function ReqEditRow({
  req, apiBaseUrl, projectId, onEdited, onDeleted, onImpact, onImpactResolved, resolvedImpact,
  activeEdit, onEditingChange, locked,
}: {
  req: EditorReq;
  apiBaseUrl: string;
  projectId?: string | null;
  onEdited: (patch: Partial<EditorReq>) => void;
  onDeleted: () => void;
  onImpact?: (impact: ImpactInfo) => void;
  onImpactResolved?: () => void;
  resolvedImpact?: { uuid: string; nonce: number; phase?: "start" | "done" | "error" } | null;
  /** Renseigné si un AUTRE utilisateur a actuellement un champ de cette exigence ouvert en édition. */
  activeEdit?: { actorName: string };
  onEditingChange?: (reqUUID: string, active: boolean) => Promise<{ ok: boolean; lockedByName?: string }>;
  /** Campagne de tests en cours (voir page.tsx → campaignStatus) : le projet
   *  entier est figé, plus aucune édition/suppression n'est autorisée ici. */
  locked?: boolean;
}) {
  const [editField, setEditField]   = useState<"id" | "desc" | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [status, setStatus]         = useState<RowStatus | null>(null);
  const [impactInfo, setImpactInfo] = useState<ImpactInfo | null>(null);
  const [reverting, setReverting]   = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const uuid = req._uuid;

  // ── Verrou d'édition (bloquant) ───────────────────────────────────────────
  // Ouvrir un champ (id/description) pose un verrou côté serveur — si un
  // AUTRE utilisateur l'a déjà, le champ ne s'ouvre PAS et un message
  // explique pourquoi. Le vrai filet de sécurité contre l'écrasement à la
  // sauvegarde reste le contrôle de version optimiste (409 conflict), mais
  // ce verrou évite déjà la collision en amont, avant même que le BA ne
  // commence à taper.
  const editFieldRef = useRef(editField);
  editFieldRef.current = editField;
  // Libère le verrou si le composant est démonté pendant qu'un champ était
  // encore ouvert (ex: navigation ailleurs sans annuler/sauvegarder).
  useEffect(() => {
    return () => { if (editFieldRef.current !== null && uuid) onEditingChange?.(uuid, false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid]);

  const tryStartEditing = async (field: "id" | "desc") => {
    if (!uuid) { setEditField(field); return; } // pas encore en base — pas de verrou possible ni nécessaire
    if (activeEdit) {
      // Déjà su via la présence live — pas la peine d'attendre l'aller-retour réseau.
      setConflictMessage(`${activeEdit.actorName} modifie déjà cette exigence — réessayez une fois qu'il/elle aura terminé.`);
      setTimeout(() => setConflictMessage(null), 4000);
      return;
    }
    const result = await onEditingChange?.(uuid, true);
    if (result && result.ok === false) {
      setConflictMessage(result.lockedByName ? `${result.lockedByName} modifie déjà cette exigence — réessayez une fois qu'il/elle aura terminé.` : "Cette exigence est déjà en cours de modification par un autre utilisateur.");
      setTimeout(() => setConflictMessage(null), 4000);
      return;
    }
    setEditField(field);
  };

  const stopEditing = () => {
    setEditField(null);
    if (uuid) onEditingChange?.(uuid, false);
  };

  // Un impact résolu depuis le modal global (Garder ou Revenir) doit aussi
  // fermer le bandeau affiché ici, sous l'exigence — sinon les deux se
  // désynchronisent et le bandeau local reste affiché indéfiniment. On répercute
  // aussi un feedback visuel (badge "Restauration en cours..." / "Restaurée")
  // pour que l'utilisateur voie l'action, même si le clic vient du modal.
  useEffect(() => {
    if (resolvedImpact && uuid && resolvedImpact.uuid === uuid) {
      setImpactInfo(null);
      if (resolvedImpact.phase === "start") {
        setStatus("reverting");
      } else if (resolvedImpact.phase === "done") {
        setStatus("reverted");
        setTimeout(() => setStatus(null), 2500);
      } else if (resolvedImpact.phase === "error") {
        setStatus("error");
        setTimeout(() => setStatus(null), 3000);
      }
    }
  }, [resolvedImpact, uuid]);

  // ── Appel API PATCH puis mise à jour locale ──────────────────────────────
  const patchReq = async (apiData: Partial<{ req_id: string; description: string; priority: string }>, localPatch: Partial<EditorReq>) => {
    // Snapshot de la description AVANT édition — nécessaire pour pouvoir
    // proposer un retour en arrière si un impact significatif est détecté.
    const previousDescription = req.description;
    if (!uuid) {
      // Pas encore en base — mise à jour locale uniquement
      onEdited(localPatch);
      return;
    }
    setStatus("saving");
    setConflictMessage(null);
    try {
      const res = await fetch(`${apiBaseUrl}/projects/requirements/${uuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // expectedUpdatedAt : la version qu'on avait sous les yeux en ouvrant
        // ce champ — le backend refuse (409) si elle ne correspond plus à la
        // version en base, signe que quelqu'un d'autre a sauvegardé entre-temps
        // (voir RequirementConflictError côté ProjectService).
        body: JSON.stringify({ ...apiData, expectedUpdatedAt: req.updatedAt ?? undefined }),
      });
      if (res.status === 409) {
        const conflict = await res.json().catch(() => null);
        setEditField(null);
        setStatus(null);
        if (conflict?.locked) {
          // Le verrou a été repris entre l'ouverture du champ et la
          // sauvegarde (ex: TTL expiré après une longue édition) — rien à
          // actualiser localement, la description locale n'a pas encore été
          // écrasée en base, on informe juste et on referme.
          setConflictMessage(conflict?.message || `${conflict?.actorName || "Quelqu'un"} modifie déjà cette exigence — réessayez une fois qu'il/elle aura terminé.`);
          setTimeout(() => setConflictMessage(null), 6000);
          return;
        }
        // Conflit de version : quelqu'un a déjà sauvegardé entre-temps. On
        // n'écrase JAMAIS silencieusement : on actualise la ligne avec la
        // vraie version en base, et on affiche clairement ce qui s'est passé
        // — à l'utilisateur de rouvrir le champ et de refaire son édition
        // sur la base à jour si besoin.
        const current = conflict?.current;
        setConflictMessage(conflict?.message || "Cette exigence a été modifiée entre-temps par un autre utilisateur — valeur actualisée, vérifiez avant de réessayer.");
        if (current) {
          onEdited({
            description: current.description,
            priority: current.priority,
            updatedAt: current.updated_at ?? current.updatedAt ?? null,
          });
        }
        setTimeout(() => setConflictMessage(null), 6000);
        return;
      }
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(msg);
      }
      const json = await res.json().catch(() => null);
      if (json?.pending) {
        // Campagne en cours : le backend n'a PAS appliqué la modification —
        // elle est en standby. On n'applique donc pas `localPatch` (l'exigence
        // reste affichée telle qu'elle était) et on informe l'utilisateur.
        setEditField(null);
        setStatus(null);
        setConflictMessage(json.message || "Campagne de tests en cours : cette modification est mise en attente et sera appliquée (ou annulée) à la clôture de la campagne.");
        setTimeout(() => setConflictMessage(null), 6000);
        return;
      }
      onEdited({ ...localPatch, updatedAt: json?.data?.updated_at ?? json?.data?.updatedAt ?? null });
      setStatus("saved");
      // ── Analyse d'impact (édition de la description uniquement) ──────────
      const impact = json?.data?.impact;
      if (impact) {
        const info: ImpactInfo = {
          changed: impact.changed,
          similarity: impact.similarity,
          testCasesFlagged: impact.testCasesFlagged,
          impactedRequirements: impact.impactedRequirements ?? [],
          requirementUuid: uuid,
          previousDescription,
        };
        setImpactInfo(info);
        if (impact.changed) onImpact?.(info); // affiche aussi le modal global, en plus du bandeau sous l'exigence
      } else {
        setImpactInfo(null);
      }
      setTimeout(() => setStatus(null), 2000);
    } catch (err: any) {
      console.error("[ModuleReqEditor] patchReq error:", err);
      setStatus("error");
      setTimeout(() => setStatus(null), 3000);
    }
  };

  // ── Lever manuellement le flag "à réviser" (exigence couplée) ────────────
  const [clearingReview, setClearingReview] = useState(false);
  const acknowledgeReview = async () => {
    if (!uuid) return;
    setClearingReview(true);
    try {
      const res = await fetch(`${apiBaseUrl}/projects/requirements/${uuid}/acknowledge-review`, { method: "PATCH" });
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const json = await res.json().catch(() => null);
      if (json?.pending) {
        setConflictMessage(json.message || "Campagne de tests en cours : cette action est mise en attente jusqu'à la clôture de la campagne.");
        setTimeout(() => setConflictMessage(null), 6000);
        return;
      }
      onEdited({ needsReview: false, needsReviewReason: null });
    } catch (err: any) {
      console.error("[ModuleReqEditor] acknowledgeReview error:", err);
    } finally {
      setClearingReview(false);
    }
  };

  // ── Revenir à l'ancienne version après un impact détecté ──────────────────
  const revertChange = async () => {
    if (!uuid || !impactInfo) return;
    const { previousDescription, impactedRequirements } = impactInfo;
    // On masque le bandeau tout de suite (la décision de revenir en arrière
    // est prise), mais on n'applique la description précédente qu'APRÈS
    // confirmation du serveur — si une campagne est en cours, la restauration
    // est mise en attente et ne doit rien changer à l'affichage.
    setImpactInfo(null);
    onImpactResolved?.();
    setStatus("reverting");
    setReverting(true);
    try {
      const res = await fetch(`${apiBaseUrl}/projects/requirements/${uuid}/revert-edit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: previousDescription,
          impactedRequirementIds: impactedRequirements.map(r => r.id).filter(Boolean),
        }),
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const json = await res.json().catch(() => null);
      if (json?.pending) {
        setStatus(null);
        setConflictMessage(json.message || "Campagne de tests en cours : ce retour en arrière est mis en attente jusqu'à la clôture de la campagne.");
        setTimeout(() => setConflictMessage(null), 6000);
        return;
      }
      // On applique avec la valeur exacte renvoyée par le serveur, au cas où
      // un autre rafraîchissement (polling, etc.) serait passé entretemps.
      const restoredDescription = json?.data?.description ?? previousDescription;
      onEdited({ description: restoredDescription, needsReview: false, needsReviewReason: null });
      setStatus("reverted");
      setTimeout(() => setStatus(null), 2500);
    } catch (err: any) {
      // La description n'a pas encore été touchée localement (on n'applique
      // plus l'optimistic update en amont) ; on journalise juste l'échec.
      console.error("[ModuleReqEditor] revertChange error:", err);
      setStatus("error");
      setTimeout(() => setStatus(null), 3000);
    } finally {
      setReverting(false);
    }
  };

  // ── Garder le changement — ferme le bandeau (et le modal global associé) ──
  const keepChange = () => {
    setImpactInfo(null);
    onImpactResolved?.();
  };

  // ── DELETE ────────────────────────────────────────────────────────────────
  const deleteReq = async () => {
    if (!uuid) { onDeleted(); return; }
    setStatus("saving");
    try {
      const res = await fetch(`${apiBaseUrl}/projects/requirements/${uuid}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const json = await res.json().catch(() => null);
      setConfirmDel(false);
      if (json?.pending) {
        setStatus(null);
        setConflictMessage(json.message || "Campagne de tests en cours : cette suppression est mise en attente jusqu'à la clôture de la campagne.");
        setTimeout(() => setConflictMessage(null), 6000);
        return;
      }
      onDeleted();
    } catch (err: any) {
      console.error("[ModuleReqEditor] deleteReq error:", err);
      setStatus("error");
      setTimeout(() => setStatus(null), 3000);
      setConfirmDel(false);
    }
  };

  const color = priorityColor(req.priority);
  // La campagne de tests ne bloque plus l'édition (voir queueIfCampaignActive
  // côté backend) : une modification pendant une campagne est simplement mise
  // en attente (voir patchReq/deleteReq ci-dessus). Seul un AUTRE utilisateur
  // en train d'éditer CETTE MÊME exigence bloque encore le champ.
  const blocked = !!activeEdit;
  const blockedTitle = activeEdit ? `${activeEdit.actorName} modifie déjà cette exigence` : undefined;

  return (
    <div style={{
      display: "flex", gap: 10, padding: "12px 20px",
      borderBottom: `1px solid ${C.slate100}`, alignItems: "flex-start",
      background: C.white, transition: "background 0.15s",
    }}
      onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
      onMouseLeave={e => (e.currentTarget.style.background = C.white)}
    >
      {/* req_id badge */}
      <div style={{ flexShrink: 0, minWidth: 72 }}>
        {editField === "id" ? (
          <InlineEdit
            value={req.id}
            onSave={v => {
              stopEditing();
              patchReq({ req_id: v }, { id: v });
            }}
            onCancel={stopEditing}
            mono
            placeholder="FR-01"
          />
        ) : (
          <span
            onClick={() => tryStartEditing("id")}
            title={blockedTitle ?? "Cliquer pour modifier l'identifiant"}
            style={{
              display: "inline-block", cursor: blocked ? "not-allowed" : "text",
              background: color + "20", color, border: `1.5px solid ${color}40`,
              borderRadius: 6, padding: "4px 10px", fontSize: 12, fontWeight: 800,
              fontFamily: "'JetBrains Mono', monospace",
              opacity: blocked ? 0.6 : 1,
            }}>
            {req.id}
          </span>
        )}
      </div>

      {/* description */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {editField === "desc" ? (
          <InlineEdit
            value={req.description}
            onSave={v => {
              stopEditing();
              patchReq({ description: v }, { description: v });
            }}
            onCancel={stopEditing}
            placeholder="Description de l'exigence"
            multiline
          />
        ) : (
          <>
            <span
              onClick={() => tryStartEditing("desc")}
              title={blockedTitle ?? "Cliquer pour modifier la description"}
              style={{ fontSize: 13, color: C.slate700, cursor: blocked ? "not-allowed" : "text", lineHeight: 1.6, opacity: blocked ? 0.7 : 1 }}
            >
              {req.description}
            </span>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <TraceabilityBadge apiBaseUrl={apiBaseUrl} projectId={projectId} reqId={req.id} reqDescription={req.description} />
              {activeEdit && (
                <span
                  title={`${activeEdit.actorName} a un champ de cette exigence ouvert en édition`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700,
                    color: "#92400e", background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.3)",
                    borderRadius: 999, padding: "2px 8px",
                  }}
                >
                  ✏️ {activeEdit.actorName} modifie cette exigence
                </span>
              )}
            </div>
            {conflictMessage && (
              <div style={{
                marginTop: 6, fontSize: 11, fontWeight: 700, color: "#92400e",
                background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.35)",
                borderRadius: 6, padding: "6px 9px",
              }}>
                ⚠ {conflictMessage}
              </div>
            )}
            {req.needsReview && (
              <div style={{
                marginTop: 6, fontSize: 11, fontWeight: 700, color: "#b91c1c",
                background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.35)",
                borderRadius: 6, padding: "6px 9px", display: "flex", alignItems: "center", gap: 6,
              }}>
                <span title={req.needsReviewReason || undefined}>⚠ À RÉVISER{req.needsReviewReason ? ` — ${req.needsReviewReason}` : ""}</span>
                <button
                  onClick={acknowledgeReview}
                  disabled={clearingReview}
                  title="Lever le flag à réviser"
                  style={{ background: "none", border: "1px solid rgba(220,38,38,0.4)", borderRadius: 4, cursor: clearingReview ? "default" : "pointer", color: "#b91c1c", fontWeight: 800, marginLeft: "auto", fontSize: 10, padding: "2px 8px", opacity: clearingReview ? 0.6 : 1 }}
                >
                  {clearingReview ? "…" : "✕"}
                </button>
              </div>
            )}
            {impactInfo && (() => {
              const msg = describeImpact(impactInfo);
              const toneColor = msg.tone === "danger" ? "#b91c1c" : msg.tone === "warn" ? "#b45309" : "#0369a1";
              const toneBg = msg.tone === "danger" ? "rgba(220,38,38,0.06)" : msg.tone === "warn" ? C.amberLight : "rgba(3,105,161,0.06)";
              const toneBorder = msg.tone === "danger" ? "rgba(220,38,38,0.35)" : msg.tone === "warn" ? `${C.amber}60` : "rgba(3,105,161,0.35)";
              return (
                <div style={{
                  marginTop: 6, fontSize: 11, fontWeight: 700, color: toneColor,
                  background: toneBg, border: `1px solid ${toneBorder}`,
                  borderRadius: 6, padding: "6px 9px", display: "flex", flexDirection: "column", gap: 8,
                }}>
                  <span style={{ lineHeight: 1.5 }}>{msg.icon} {msg.title} — {msg.text}</span>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      onClick={keepChange}
                      disabled={reverting}
                      title="Conserver la nouvelle description et réviser les cas de test marqués"
                      style={{
                        padding: "4px 10px", borderRadius: 6, border: `1px solid ${toneColor}60`,
                        background: toneColor, color: C.white, fontSize: 10, fontWeight: 800,
                        cursor: reverting ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: reverting ? 0.6 : 1,
                      }}
                    >
                      ✓ Garder &amp; réviser
                    </button>
                    <button
                      onClick={revertChange}
                      disabled={reverting}
                      title="Annuler cette modification et restaurer l'ancienne description"
                      style={{
                        padding: "4px 10px", borderRadius: 6, border: `1px solid ${toneColor}60`,
                        background: "transparent", color: toneColor, fontSize: 10, fontWeight: 800,
                        cursor: reverting ? "not-allowed" : "pointer", fontFamily: "inherit",
                        display: "inline-flex", alignItems: "center", gap: 5, opacity: reverting ? 0.6 : 1,
                      }}
                    >
                      {reverting && <Spinner />} ↩ Revenir à l'ancienne version
                    </button>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>

      {/* priority selector */}
      <div style={{ flexShrink: 0 }}>
        <select
          value={req.priority}
          disabled={status === "saving"}
          onChange={e => {
            const p = e.target.value as Priority;
            patchReq({ priority: p }, { priority: p });
          }}
          style={{
            padding: "3px 6px", borderRadius: 6, border: `1.5px solid ${color}50`,
            background: color + "12", color, fontSize: 11, fontWeight: 700,
            fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", outline: "none",
          }}
        >
          {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* status + actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        <StatusBadge status={status} />
        {uuid && (
          <IconBtn icon="🕓" title="Historique des versions" hoverColor={C.teal}
            onClick={e => { e.stopPropagation(); setShowHistory(true); }} />
        )}
        <IconBtn icon="🗑️" title="Supprimer l'exigence" hoverColor={C.red}
          onClick={e => { e.stopPropagation(); setConfirmDel(true); }} disabled={status === "saving"} />
      </div>
      <ConfirmDeleteModal
        open={confirmDel}
        title="Supprimer l'exigence ?"
        message="Cette exigence sera définitivement supprimée. Cette action est irréversible."
        loading={status === "saving"}
        onCancel={() => setConfirmDel(false)}
        onConfirm={deleteReq}
      />
      {uuid && (
        <VersionHistoryPanel
          open={showHistory}
          onClose={() => setShowHistory(false)}
          entityType="requirement"
          entityId={uuid}
          entityLabel={`Exigence « ${req.id} »`}
          onRestored={updated => onEdited({
            id: updated.req_id,
            description: updated.description,
            priority: updated.priority,
            updatedAt: updated.updated_at ?? updated.updatedAt ?? null,
          })}
        />
      )}
    </div>
  );
}


// ─── ModuleEditCard ───────────────────────────────────────────────────────────
function ModuleEditCard({
  mod, apiBaseUrl, projectId,
  onEdited, onDeleted, onReqAdded, onReqEdited, onReqDeleted, onImpact, onImpactResolved, resolvedImpact,
  activeEdits, onEditingChange, locked,
}: {
  mod: EditorModule;
  apiBaseUrl: string;
  projectId: string | null | undefined;
  onEdited:    (patch: Partial<EditorModule>) => void;
  onDeleted:   () => void;
  onReqAdded:  (req: EditorReq) => void;
  onReqEdited: (reqId: string, patch: Partial<EditorReq>) => void;
  onReqDeleted:(reqId: string) => void;
  onImpact?:   (impact: ImpactInfo) => void;
  onImpactResolved?: () => void;
  resolvedImpact?: { uuid: string; nonce: number; phase?: "start" | "done" | "error" } | null;
  activeEdits?: Record<string, { actorName: string }>;
  onEditingChange?: (reqUUID: string, active: boolean) => Promise<{ ok: boolean; lockedByName?: string }>;
  /** Campagne de tests en cours : figé, mêmes règles que ReqEditRow. */
  locked?: boolean;
}) {
  const [expanded, setExpanded]     = useState(true);
  const [editField, setEditField]   = useState<"name" | "desc" | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAddReq, setShowAddReq] = useState(mod.requirements.length === 0);
  const [status, setStatus]         = useState<"saving" | "saved" | "error" | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const uuid = mod._uuid;

  // ── PATCH module ──────────────────────────────────────────────────────────
  const patchModule = async (apiData: { name?: string; description?: string }, localPatch: Partial<EditorModule>) => {
    if (!uuid) { onEdited(localPatch); return; }
    setStatus("saving");
    try {
      const res = await fetch(`${apiBaseUrl}/projects/modules/${uuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiData),
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const json = await res.json().catch(() => null);
      setStatus(null);
      if (json?.pending) {
        setPendingMessage(json.message || "Campagne de tests en cours : cette modification est mise en attente jusqu'à la clôture de la campagne.");
        setTimeout(() => setPendingMessage(null), 6000);
        return;
      }
      onEdited(localPatch);
      setStatus("saved");
      setTimeout(() => setStatus(null), 2000);
    } catch (err: any) {
      console.error("[ModuleReqEditor] patchModule error:", err);
      setStatus("error");
      setTimeout(() => setStatus(null), 3000);
    }
  };

  // ── DELETE module ─────────────────────────────────────────────────────────
  const deleteModule = async () => {
    if (!uuid) { onDeleted(); return; }
    setStatus("saving");
    try {
      const res = await fetch(`${apiBaseUrl}/projects/modules/${uuid}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const json = await res.json().catch(() => null);
      setConfirmDel(false);
      if (json?.pending) {
        setStatus(null);
        setPendingMessage(json.message || "Campagne de tests en cours : cette suppression est mise en attente jusqu'à la clôture de la campagne.");
        setTimeout(() => setPendingMessage(null), 6000);
        return;
      }
      onDeleted();
    } catch (err: any) {
      console.error("[ModuleReqEditor] deleteModule error:", err);
      setStatus("error");
      setTimeout(() => setStatus(null), 3000);
      setConfirmDel(false);
    }
  };

  // ── Export PDF / Excel ────────────────────────────────────────────────────
  const [exporting, setExporting] = useState<"pdf" | "excel" | null>(null);
  const [exportError, setExportError] = useState("");

  const exportModule = async (format: "pdf" | "excel") => {
    if (!uuid || !projectId) return;
    setExporting(format);
    setExportError("");
    try {
      const res = await fetch(`${apiBaseUrl}/projects/${projectId}/modules/${uuid}/export/${format}`);
      if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `${mod.name}.${format === "pdf" ? "pdf" : "xlsx"}`;

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error("[ModuleReqEditor] exportModule error:", err);
      setExportError(`Échec de l'export ${format.toUpperCase()}`);
      setTimeout(() => setExportError(""), 4000);
    } finally {
      setExporting(null);
    }
  };

  // ── POST requirement ──────────────────────────────────────────────────────
  const addReq = async (values: Record<string, string>) => {
    if (!uuid) throw new Error("Module non sauvegardé en base — sauvegardez d'abord le projet");
    const res = await fetch(`${apiBaseUrl}/projects/modules/${uuid}/requirements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ req_id: values.req_id, description: values.description, priority: values.priority }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    const json = await res.json();
    if (json?.pending) {
      // Campagne en cours : l'exigence n'a pas été créée, elle est en
      // attente — on informe l'utilisateur au lieu de l'ajouter localement.
      setPendingMessage(json.message || "Campagne de tests en cours : cette création est mise en attente jusqu'à la clôture de la campagne.");
      setTimeout(() => setPendingMessage(null), 6000);
      return;
    }
    const created = json.data;
    onReqAdded({
      id:          created.req_id,
      _uuid:       created.id,
      description: created.description,
      priority:    created.priority,
    });
    // Le formulaire reste ouvert (voir keepOpenAfterSubmit) pour permettre d'enchaîner la saisie des exigences.
  };

  return (
    <div style={{
      background: C.white, border: `1.5px solid ${C.slate200}`,
      borderRadius: 12, marginBottom: 12, overflow: "hidden",
      boxShadow: "0 2px 6px rgba(0,0,0,0.05)",
    }}>
      {/* Header */}
      <div style={{
        padding: "14px 18px",
        background: expanded ? "#f8fafc" : C.white,
        borderBottom: expanded ? `1px solid ${C.slate200}` : "none",
        display: "flex", alignItems: "flex-start", gap: 10,
      }}>
        <button onClick={() => setExpanded(x => !x)} style={{
          background: "none", border: "none", cursor: "pointer",
          color: C.slate400, fontSize: 12, padding: "2px 4px", flexShrink: 0, marginTop: 2,
        }}>
          {expanded ? "▲" : "▼"}
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* module name */}
          {editField === "name" ? (
            <InlineEdit
              value={mod.name}
              onSave={v => {
                setEditField(null);
                patchModule({ name: v }, { name: v });
              }}
              onCancel={() => setEditField(null)}
              placeholder="Nom du module"
            />
          ) : (
            <div
              onClick={() => setEditField("name")}
              title="Cliquer pour renommer"
              style={{
                fontSize: 15, fontWeight: 800, color: C.slate900,
                cursor: "text", display: "flex", alignItems: "center", gap: 8,
              }}
            >
              📦 {mod.name}
              <span style={{ fontSize: 10, color: C.slate400, fontWeight: 600 }}>✏️</span>
            </div>
          )}

          {/* module description */}
          {editField === "desc" ? (
            <div style={{ marginTop: 6 }}>
              <InlineEdit
                value={mod.description ?? ""}
                onSave={v => {
                  setEditField(null);
                  patchModule({ description: v }, { description: v });
                }}
                onCancel={() => setEditField(null)}
                placeholder="Description optionnelle"
              />
            </div>
          ) : (
            <div
              onClick={() => setEditField("desc")}
              title="Cliquer pour modifier la description"
              style={{ fontSize: 12, color: C.slate400, marginTop: 3, cursor: "text", minHeight: 18 }}
            >
              {mod.description || <span style={{ fontStyle: "italic" }}>Ajouter une description...</span>}
            </div>
          )}
          {pendingMessage && (
            <div style={{
              marginTop: 6, fontSize: 11, fontWeight: 700, color: "#92400e",
              background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.35)",
              borderRadius: 6, padding: "6px 9px",
            }}>
              ⏳ {pendingMessage}
            </div>
          )}
        </div>

        {/* stat badge */}
        <span style={{
          background: C.tealLight, border: `1px solid ${C.tealBorder}`,
          color: C.tealText, borderRadius: 6, padding: "4px 10px",
          fontSize: 11, fontWeight: 800, flexShrink: 0,
        }}>
          {mod.requirements.length} req.
        </span>

        {/* status + actions */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <StatusBadge status={status} />
          {uuid && projectId && (
            <>
              <IconBtn icon="📄" title="Exporter en PDF" hoverColor={C.tealText}
                onClick={e => { e.stopPropagation(); exportModule("pdf"); }}
                disabled={exporting !== null} />
              <IconBtn icon="📊" title="Exporter en Excel" hoverColor={C.tealText}
                onClick={e => { e.stopPropagation(); exportModule("excel"); }}
                disabled={exporting !== null} />
              {exporting && <Spinner />}
            </>
          )}
          <IconBtn icon="➕" title="Ajouter une exigence" hoverColor={C.teal}
            onClick={e => { e.stopPropagation(); setShowAddReq(x => !x); }} />
          {uuid && (
            <IconBtn icon="🕓" title="Historique des versions" hoverColor={C.teal}
              onClick={e => { e.stopPropagation(); setShowHistory(true); }} />
          )}
          <IconBtn icon="🗑️" title="Supprimer le module" hoverColor={C.red}
            onClick={e => { e.stopPropagation(); setConfirmDel(true); }} disabled={status === "saving"} />
        </div>
      </div>
      <ConfirmDeleteModal
        open={confirmDel}
        title="Supprimer le module ?"
        message="Le module et toutes ses exigences seront définitivement supprimés. Cette action est irréversible."
        loading={status === "saving"}
        onCancel={() => setConfirmDel(false)}
        onConfirm={deleteModule}
      />
      {uuid && (
        <VersionHistoryPanel
          open={showHistory}
          onClose={() => setShowHistory(false)}
          entityType="requirement_module"
          entityId={uuid}
          entityLabel={`Module « ${mod.name} »`}
          onRestored={updated => onEdited({ name: updated.name, description: updated.description })}
        />
      )}
      {exportError && (
        <div style={{ padding: "0 18px 8px", fontSize: 11, color: C.red, fontWeight: 700 }}>
          {exportError}
        </div>
      )}

      {/* Add req form */}
      {showAddReq && (
        <div style={{ padding: "0 18px 12px" }}>
          <AddForm
            fields={[
              { key: "req_id",      label: "Identifiant", placeholder: "FR-01",                required: true },
              { key: "description", label: "Description",  placeholder: "L'utilisateur peut…", required: true },
              { key: "priority",    label: "Priorité",     placeholder: "",                    type: "select", options: PRIORITIES },
            ]}
            submitLabel="Ajouter l'exigence"
            onSubmit={addReq}
            onCancel={() => setShowAddReq(false)}
            keepOpenAfterSubmit
          />
        </div>
      )}

      {/* Requirements list */}
      {expanded && (
        <div>
          {mod.requirements.length === 0 ? (
            <div style={{ padding: "16px 20px", fontSize: 12, color: C.slate400, fontStyle: "italic" }}>
              Aucune exigence — cliquez ➕ pour en ajouter une.
            </div>
          ) : (
            mod.requirements.map(req => (
              <ReqEditRow
                key={req._uuid ?? req.id}
                req={req}
                apiBaseUrl={apiBaseUrl}
                locked={locked}
                projectId={projectId}
                onEdited={patch => onReqEdited(req.id, patch)}
                onDeleted={() => onReqDeleted(req.id)}
                onImpact={onImpact}
                onImpactResolved={onImpactResolved}
                resolvedImpact={resolvedImpact}
                activeEdit={req._uuid ? activeEdits?.[req._uuid] : undefined}
                onEditingChange={onEditingChange}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Composant principal ──────────────────────────────────────────────────────
export default function ModuleReqEditor({
  apiBaseUrl, projectId, modules,
  onModuleAdded, onModuleEdited, onModuleDeleted,
  onReqAdded, onReqEdited, onReqDeleted, onImpact, onImpactResolved, resolvedImpact,
  activeEdits, onEditingChange, locked,
}: ModuleReqEditorProps) {
  const [showAddModule, setShowAddModule] = useState(modules.length === 0);
  const [addModulePendingMessage, setAddModulePendingMessage] = useState<string | null>(null);

  const addModule = async (values: Record<string, string>) => {
    if (!projectId) throw new Error("Aucun projet actif — chargez ou créez un projet d'abord");
    const res = await fetch(`${apiBaseUrl}/projects/${projectId}/modules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: values.name, description: values.description }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    const json = await res.json();
    if (json?.pending) {
      // Campagne en cours : le module n'a pas été créé, il est en attente.
      setAddModulePendingMessage(json.message || "Campagne de tests en cours : cette création est mise en attente jusqu'à la clôture de la campagne.");
      setTimeout(() => setAddModulePendingMessage(null), 6000);
      setShowAddModule(false);
      return;
    }
    const created = json.data;
    onModuleAdded({
      name:         created.name,
      _uuid:        created.id,
      description:  created.description ?? "",
      requirements: [],
    });
    setShowAddModule(false);
  };

  return (
    <>
      <style>{`@keyframes mre-spin { to { transform: rotate(360deg); } }`}</style>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 11, color: locked ? "#92400e" : C.slate400, fontWeight: 700, letterSpacing: "0.04em" }}>
          {locked
            ? "⏳ CAMPAGNE DE TESTS EN COURS — vos modifications sont mises en attente jusqu'à la clôture"
            : "ÉDITION DIRECTE — cliquez sur un nom ou une description pour modifier"}
        </div>
        {addModulePendingMessage && (
          <div style={{
            fontSize: 11, fontWeight: 700, color: "#92400e",
            background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.35)",
            borderRadius: 6, padding: "6px 9px",
          }}>
            ⏳ {addModulePendingMessage}
          </div>
        )}
        {(
          <button
            onClick={() => setShowAddModule(x => !x)}
            style={{
              padding: "6px 14px", borderRadius: 7,
              border: `1.5px solid ${C.tealBorder}`,
              background: showAddModule ? C.tealLight : "transparent",
              color: C.tealText, fontSize: 11, fontWeight: 800,
              cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
              display: "flex", alignItems: "center", gap: 6,
            }}
            onMouseEnter={e => { if (!showAddModule) e.currentTarget.style.background = C.tealLight; }}
            onMouseLeave={e => { if (!showAddModule) e.currentTarget.style.background = "transparent"; }}
          >
            ➕ Nouveau module
          </button>
        )}
      </div>

      {showAddModule && (
        <AddForm
          fields={[
            { key: "name",        label: "Nom du module", placeholder: "Authentification",    required: true },
            { key: "description", label: "Description",   placeholder: "Gestion des accès…"                },
          ]}
          submitLabel="Créer le module"
          onSubmit={addModule}
          onCancel={() => setShowAddModule(false)}
        />
      )}

      <div style={{ marginTop: 10 }}>
        {modules.length === 0 ? (
          !showAddModule && (
            <div style={{ textAlign: "center", padding: "48px 24px", color: C.slate400, fontSize: 13 }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>📭</div>
              Aucun module — créez-en un ci-dessus.
            </div>
          )
        ) : (
          modules.map(mod => (
            <ModuleEditCard
              key={mod._uuid ?? mod.name}
              mod={mod}
              locked={locked}
              apiBaseUrl={apiBaseUrl}
              projectId={projectId}
              onEdited={patch => onModuleEdited(mod.name, patch)}
              onDeleted={() => onModuleDeleted(mod.name)}
              onReqAdded={req => onReqAdded(mod.name, req)}
              onReqEdited={(reqId, patch) => onReqEdited(mod.name, reqId, patch)}
              onReqDeleted={reqId => onReqDeleted(mod.name, reqId)}
              onImpact={onImpact}
              onImpactResolved={onImpactResolved}
              resolvedImpact={resolvedImpact}
              activeEdits={activeEdits}
              onEditingChange={onEditingChange}
            />
          ))
        )}
      </div>
    </>
  );
}