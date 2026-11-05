"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { listComments, createComment, resolveComment, reopenComment, deleteComment, getCommentSeenBy, remindComment, markCommentsRead, getReadReceipts, Comment, CommentEntityType, CommentSeenBy, ReadReceipt } from "@/lib/comments-api";
import { getProjectMembers, ProjectMember } from "@/lib/projects-api";
import { getWsTicket } from "@/lib/notifications-api";

const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "http://localhost:3000";

interface CommentThreadProps {
  projectId: string;
  entityType: CommentEntityType;
  entityId: string;
}

const C = {
  border: "#e2e8f0",
  slate300: "#cbd5e1",
  slate400: "#94a3b8",
  slate500: "#64748b",
  slate600: "#475569",
  blue: "#2563eb",
  blueLight: "#eff6ff",
  amber: "#f59e0b",
  amberLight: "#fffbeb",
  red: "#dc2626",
  redLight: "#fef2f2",
  green: "#16a34a",
  greenLight: "#f0fdf4",
};

/** Couleur propre à chaque utilisateur, espacée uniformément sur le cercle
 *  chromatique via l'angle doré (~137,5°) plutôt que par simple hash : ça
 *  garantit un écart maximal entre les couleurs de deux utilisateurs voisins,
 *  quel que soit leur nombre, au lieu de risquer deux teintes trop proches.
 *  L'ordre des membres du projet étant stable, chaque utilisateur garde
 *  toujours la même couleur d'une session à l'autre. */
function buildColorMap(members: ProjectMember[]) {
  const map = new Map<string, string>();
  members.forEach((m, i) => {
    const hue = Math.round((i * 137.508) % 360);
    map.set(m.id, `hsl(${hue}, 68%, 45%)`);
  });
  return map;
}

/** Repli si un auteur n'apparaît plus dans la liste des membres (ex: retiré du projet). */
function fallbackColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 68%, 45%)`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Horodatage relatif ("il y a 5 min") ; bascule sur une date courte au-delà d'une semaine. */
function relativeTime(iso: string) {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `il y a ${d} j`;
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function absoluteTime(iso: string) {
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Parse le texte affiché et remplace les tokens @Nom insérés par des <mark>. */
function renderContent(content: string, members: ProjectMember[]) {
  const names = members.map(m => m.name).sort((a, b) => b.length - a.length);
  if (names.length === 0) return content;
  const pattern = new RegExp(`@(${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  const parts = content.split(pattern);
  return parts.map((part, i) =>
    names.includes(part) ? (
      <span key={i} style={{ color: C.blue, fontWeight: 700, background: C.blueLight, borderRadius: 4, padding: "0 3px" }}>@{part}</span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function Avatar({ name, color, size = 28 }: { name: string; color: string; size?: number }) {
  return (
    <div
      title={name}
      style={{
        width: size, height: size, borderRadius: "50%", background: color,
        color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: size * 0.36, fontWeight: 800, flexShrink: 0, userSelect: "none",
        border: "2px solid #fff", boxSizing: "border-box", boxShadow: "0 0 0 1px rgba(15,23,42,0.06)",
      }}
    >
      {initials(name)}
    </div>
  );
}

/** Délai d'inactivité avant d'annoncer automatiquement "a arrêté d'écrire" (ms). */
const TYPING_IDLE_MS = 3000;

function CommentComposer({
  members, onSubmit, onCancel, placeholder, autoFocus, showResolutionOption, onTypingChange,
}: {
  members: ProjectMember[];
  onSubmit: (content: string, mentionedUserIds: string[], requiresResolution: boolean) => Promise<void>;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Affiche la case "nécessite une résolution" (proposée à l'auteur, pas aux autres). */
  showResolutionOption?: boolean;
  /** Signale en direct (via WebSocket, voir CommentThread) que l'utilisateur est en train / a fini d'écrire. */
  onTypingChange?: (active: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [query, setQuery] = useState("");
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [mentioned, setMentioned] = useState<Set<string>>(new Set());
  const [requiresResolution, setRequiresResolution] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);

  /** Annonce active/inactive en évitant les envois redondants (un keystroke sur deux). */
  const setTyping = (active: boolean) => {
    if (isTypingRef.current === active) return;
    isTypingRef.current = active;
    onTypingChange?.(active);
  };

  // Coupe proprement l'indicateur "écrit un commentaire..." si le composeur
  // est démonté en pleine frappe (drawer fermé, changement d'exigence...).
  useEffect(() => () => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    setTyping(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const suggestions = useMemo(
    () => members.filter(m => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6),
    [members, query],
  );
  const colorMap = useMemo(() => buildColorMap(members), [members]);

  useEffect(() => { setActiveSuggestion(0); }, [query, showSuggestions]);

  const handleChange = (value: string) => {
    setText(value);
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    const upToCursor = value.slice(0, cursor);
    const match = upToCursor.match(/@(\w*)$/);
    if (match) {
      setQuery(match[1]);
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }

    // ── Indicateur de frappe ────────────────────────────────────────────
    // Style Slack/Teams : "actif" tant que du texte est présent et que
    // l'utilisateur tape, "inactif" après TYPING_IDLE_MS d'inactivité (le
    // timer est relancé à chaque frappe) ou dès que le champ est vidé.
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    if (value.trim()) {
      setTyping(true);
      typingTimeoutRef.current = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
    } else {
      setTyping(false);
    }
  };

  const insertMention = (member: ProjectMember) => {
    const cursor = textareaRef.current?.selectionStart ?? text.length;
    const upToCursor = text.slice(0, cursor);
    const replaced = upToCursor.replace(/@(\w*)$/, `@${member.name} `);
    const newText = replaced + text.slice(cursor);
    setText(newText);
    setMentioned(prev => new Set(prev).add(member.id));
    setShowSuggestions(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submit = async () => {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    setTyping(false); // l'envoi coupe immédiatement l'indicateur, pas besoin d'attendre TYPING_IDLE_MS
    try {
      // On ne garde que les mentions dont le @Nom est toujours présent dans le texte final
      const activeMentions = Array.from(mentioned).filter(id => {
        const m = members.find(mm => mm.id === id);
        return m && text.includes(`@${m.name}`);
      });
      await onSubmit(text.trim(), activeMentions, requiresResolution);
      setText("");
      setMentioned(new Set());
      setRequiresResolution(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          borderRadius: 10, border: `1.5px solid ${focused ? C.blue : C.border}`,
          transition: "border-color 0.15s ease", background: "#fff",
          boxShadow: focused ? "0 0 0 3px rgba(37,99,235,0.12)" : "none",
        }}
      >
        <textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // Quitte le champ (clic ailleurs, changement d'onglet...) : pas la
            // peine d'attendre TYPING_IDLE_MS, l'utilisateur n'écrit plus.
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
            setTyping(false);
          }}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={e => {
            if (showSuggestions && suggestions.length > 0) {
              if (e.key === "ArrowDown") { e.preventDefault(); setActiveSuggestion(i => (i + 1) % suggestions.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setActiveSuggestion(i => (i - 1 + suggestions.length) % suggestions.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(suggestions[activeSuggestion]); return; }
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            if (e.key === "Escape") {
              setShowSuggestions(false);
              if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
              setTyping(false);
              onCancel?.();
            }
          }}
          placeholder={placeholder ?? "Ajouter un commentaire… (@ pour mentionner)"}
          rows={2}
          style={{
            width: "100%", resize: "vertical", padding: "9px 10px", borderRadius: 10,
            border: "none", outline: "none", fontFamily: "inherit", fontSize: 13,
            color: "#1e293b", boxSizing: "border-box", display: "block",
          }}
        />
      </div>

      {showSuggestions && suggestions.length > 0 && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#fff",
          border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 10px 28px rgba(15,23,42,0.14)",
          zIndex: 50, minWidth: 200, overflow: "hidden", padding: 4,
        }}>
          {suggestions.map((m, i) => (
            <div
              key={m.id}
              onMouseDown={e => { e.preventDefault(); insertMention(m); }}
              onMouseEnter={() => setActiveSuggestion(i)}
              style={{
                padding: "7px 10px", borderRadius: 7, cursor: "pointer", fontSize: 13, display: "flex",
                gap: 8, alignItems: "center", background: i === activeSuggestion ? C.blueLight : "transparent",
              }}
            >
              <Avatar name={m.name} color={colorMap.get(m.id) ?? fallbackColor(m.id)} size={22} />
              <span style={{ fontWeight: 700, color: "#1e293b" }}>{m.name}</span>
              <span style={{ fontSize: 11, color: C.slate400, marginLeft: "auto" }}>{m.role}</span>
            </div>
          ))}
        </div>
      )}

      {showResolutionOption && (
        <div style={{ marginTop: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.slate600, cursor: "pointer", width: "fit-content" }}>
            <input
              type="checkbox"
              checked={requiresResolution}
              onChange={e => setRequiresResolution(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            <span>Demander une résolution</span>
            <span
              title="Les autres membres du projet verront un bouton « Résoudre » sur ce commentaire tant qu'il ne sera pas traité. Vous ne verrez pas ce bouton vous-même, mais vous saurez que votre commentaire est toujours en attente."
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 15, height: 15, borderRadius: "50%", border: `1px solid ${C.slate300}`,
                fontSize: 10, fontWeight: 700, color: C.slate400, cursor: "help", flexShrink: 0,
              }}
            >
              ?
            </span>
          </label>
          {requiresResolution && (
            <div style={{ fontSize: 11, color: C.slate500, marginTop: 4, paddingLeft: 22 }}>
              Les autres membres devront cliquer sur « Résoudre » pour indiquer que c'est traité.
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
        <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
          {onCancel && (
            <button onClick={onCancel} style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", cursor: "pointer" }}>
              Annuler
            </button>
          )}
          <button
            onClick={submit}
            disabled={!text.trim() || submitting}
            title="Commenter"
            aria-label="Commenter"
            style={{
              fontSize: 12, fontWeight: 700, padding: submitting ? "5px 12px" : "6px 10px", borderRadius: 6, border: "none",
              background: C.blue, color: "#fff", cursor: text.trim() ? "pointer" : "default",
              opacity: !text.trim() || submitting ? 0.5 : 1, display: "flex", alignItems: "center", gap: 5,
            }}
          >
            {submitting ? "Envoi…" : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Badge d'accusé de lecture ("vu") affiché sous mes propres commentaires
 * mentionnant quelqu'un. Style double-coche façon messagerie : gris tant que
 * personne n'a lu, ambre si lu partiellement (plusieurs mentionnés), bleu
 * quand tout le monde a lu — avec le détail par personne au survol. Propose
 * un bouton "Relancer" tant que la lecture n'est pas complète, pour prévenir
 * uniquement les personnes qui n'ont pas encore vu.
 */
function SeenBadge({
  seen, remindStatus, onRemind,
}: {
  seen: CommentSeenBy[];
  remindStatus?: "sending" | "sent" | "error";
  onRemind: () => void;
}) {
  if (seen.length === 0) return null;
  const readOnes = seen.filter(s => s.read);
  const allRead = readOnes.length === seen.length;
  const someRead = readOnes.length > 0 && !allRead;

  const tooltip = seen
    .map(s => `${s.userName} — ${s.read && s.readAt ? `vu ${absoluteTime(s.readAt)}` : "pas encore vu"}`)
    .join("\n");

  const label = allRead
    ? (seen.length === 1 ? `Vu par ${seen[0].userName}` : "Vu par tous")
    : someRead
      ? `Vu par ${readOnes.length}/${seen.length}`
      : "Envoyé — non vu";

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        title={tooltip}
        style={{
          display: "flex", alignItems: "center", gap: 3, fontSize: 11, fontWeight: 700,
          color: allRead ? C.blue : someRead ? C.amber : C.slate400, cursor: "default",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        {label}
      </span>

      {!allRead && (
        <button
          onClick={onRemind}
          disabled={remindStatus === "sending" || remindStatus === "sent"}
          title="Envoyer un rappel aux personnes qui n'ont pas encore lu ce commentaire"
          style={{
            display: "flex", alignItems: "center", gap: 3, background: "none", border: "none",
            fontSize: 11, fontWeight: 700, padding: 0,
            color: remindStatus === "sent" ? C.green : remindStatus === "error" ? C.red : C.blue,
            cursor: remindStatus === "sending" || remindStatus === "sent" ? "default" : "pointer",
            opacity: remindStatus === "sending" ? 0.6 : 1,
          }}
        >
          {remindStatus === "sending" ? "Envoi…" : remindStatus === "sent" ? "✓ Relance envoyée" : remindStatus === "error" ? "Déjà vu entre-temps" : "🔔 Relancer"}
        </button>
      )}
    </span>
  );
}

/**
 * Petits avatars "vu" affichés sous CHAQUE commentaire (contrairement à
 * SeenBadge ci-dessus, limité aux commentaires de l'auteur qui mentionnent
 * quelqu'un) : un avatar par membre du projet ayant consulté le fil après la
 * création de ce commentaire précis (voir readReceipts dans CommentThread,
 * calculé à partir de GET .../comments/read-receipts). L'auteur du
 * commentaire n'apparaît jamais dans sa propre liste. Se met à jour en
 * direct via l'événement socket 'comment:thread-seen', y compris pour un
 * utilisateur déjà présent sur le fil au moment où le commentaire arrive.
 */
function SeenAvatars({
  viewers, colorMap,
}: {
  viewers: { userId: string; userName: string; readAt: string }[];
  colorMap: Map<string, string>;
}) {
  if (viewers.length === 0) return null;
  const shown = viewers.slice(0, 4);
  const overflow = viewers.length - shown.length;
  const tooltip = viewers.map(v => `${v.userName} — vu ${absoluteTime(v.readAt)}`).join("\n");

  return (
    <span title={tooltip} style={{ display: "flex", alignItems: "center" }}>
      {shown.map((v, i) => (
        <span
          key={v.userId}
          style={{
            width: 16, height: 16, borderRadius: "50%",
            background: colorMap.get(v.userId) ?? fallbackColor(v.userId),
            color: "#fff", fontSize: 8, fontWeight: 800,
            display: "flex", alignItems: "center", justifyContent: "center",
            border: "1.5px solid #fff", boxSizing: "border-box",
            marginLeft: i === 0 ? 0 : -5, boxShadow: "0 0 0 1px rgba(15,23,42,0.08)",
          }}
        >
          {initials(v.userName)}
        </span>
      ))}
      {overflow > 0 && (
        <span style={{ fontSize: 10, color: C.slate400, fontWeight: 700, marginLeft: 4 }}>+{overflow}</span>
      )}
    </span>
  );
}

type FilterMode = "all" | "unresolved" | "resolved";

/** "Salma écrit un commentaire..." — style Slack/Teams, avec de 1 à N personnes. */
function TypingIndicator({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const label =
    names.length === 1
      ? `${names[0]} écrit un commentaire`
      : names.length === 2
        ? `${names[0]} et ${names[1]} écrivent un commentaire`
        : `${names[0]}, ${names[1]} et ${names.length - 2} autre${names.length - 2 > 1 ? "s" : ""} écrivent un commentaire`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.slate500, fontStyle: "italic", padding: "0 2px", marginBottom: 6 }}>
      <span>{label}</span>
      <span style={{ display: "inline-flex", gap: 2 }}>
        {[0, 1, 2].map(i => (
          <span
            key={i}
            style={{
              width: 4, height: 4, borderRadius: "50%", background: C.slate400, display: "inline-block",
              animation: `ct-typing-dot 1.2s ease-in-out ${i * 0.15}s infinite`,
            }}
          />
        ))}
      </span>
      <style>{`
        @keyframes ct-typing-dot {
          0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-2px); }
        }
      `}</style>
    </div>
  );
}

function CommentSkeleton() {
  return (
    <div>
      {[0, 1].map(i => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 14, opacity: 0.7 - i * 0.15 }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#e2e8f0", flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ width: "40%", height: 10, borderRadius: 4, background: "#e2e8f0", marginBottom: 6 }} />
            <div style={{ width: "90%", height: 9, borderRadius: 4, background: "#eef2f7", marginBottom: 4 }} />
            <div style={{ width: "65%", height: 9, borderRadius: 4, background: "#eef2f7" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function CommentThread({ projectId, entityType, entityId }: CommentThreadProps) {
  const { user } = useCurrentUser();
  const [comments, setComments] = useState<Comment[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Indicateur de frappe : userId -> nom affiché ("Salma écrit un commentaire...").
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  // Accusés "vu" (mentions/réponses) par commentaire, uniquement chargés pour
  // les commentaires de l'utilisateur courant qui mentionnent quelqu'un.
  const [seenByComment, setSeenByComment] = useState<Map<string, CommentSeenBy[]>>(new Map());
  // Statut du bouton "Relancer" par commentaire (sending/sent/error) — voir SeenBadge.
  const [remindState, setRemindState] = useState<Map<string, "sending" | "sent" | "error">>(new Map());
  // Accusés "vu" de TOUT le fil (un par membre l'ayant déjà consulté, avec sa
  // dernière date de lecture) — sert à afficher les avatars SeenAvatars sous
  // chaque commentaire, contrairement à seenByComment ci-dessus qui reste
  // limité aux mentions. Mis à jour en direct via 'comment:thread-seen'.
  const [readReceipts, setReadReceipts] = useState<Map<string, ReadReceipt>>(new Map());
  const remindTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const socketRef = useRef<Socket | null>(null);
  // Filet de sécurité côté client : efface un "X écrit..." si aucun événement
  // `active:false` n'arrive (onglet gelé, perte réseau...) — indépendant du
  // nettoyage best-effort déjà fait côté serveur à la déconnexion du socket.
  const typingExpiryRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const membersById = useMemo(() => new Map(members.map(m => [m.id, m])), [members]);
  const colorMap = useMemo(() => buildColorMap(members), [members]);

  const load = async () => {
    try {
      const [commentsData, membersData] = await Promise.all([
        listComments(projectId, entityType, entityId),
        getProjectMembers(projectId),
      ]);
      setComments(commentsData);
      setMembers(membersData);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId, entityType, entityId]);

  // ── Accusés "vu" généralisés (tous les commentaires, pas seulement les
  // mentions) ──────────────────────────────────────────────────────────────
  // Chargement initial de qui a déjà consulté ce fil, pour tout le monde.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const receipts = await getReadReceipts(projectId, entityType, entityId);
        if (!cancelled) setReadReceipts(new Map(receipts.map(r => [r.userId, r])));
      } catch {
        // Pas critique : les avatars "vu" restent simplement absents pour ce fil.
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, entityType, entityId]);

  /**
   * Marque le fil comme lu par l'utilisateur courant "maintenant" — appelé à
   * l'ouverture du fil ET à chaque nouveau commentaire reçu en direct pendant
   * qu'on a le fil déjà ouvert (voir socket.on('comment:new') plus bas) :
   * c'est ce qui fait qu'un utilisateur déjà présent sur le fil est marqué
   * "vu" automatiquement, sans action explicite de sa part. Mise à jour
   * optimiste en local en plus de l'appel réseau, pour ne pas dépendre du
   * timing du socket (join de room vs appel PATCH).
   */
  const markSeenNow = async () => {
    if (!user) return;
    try {
      await markCommentsRead(projectId, entityType, entityId);
      const readAt = new Date().toISOString();
      setReadReceipts(prev => new Map(prev).set(user.id, { userId: user.id, userName: user.name, readAt }));
    } catch {
      // Pas critique : l'utilisateur reste simplement absent des avatars "vu".
    }
  };

  useEffect(() => { markSeenNow(); }, [projectId, entityType, entityId, user?.id]);

  // La room de l'entité (voir socket.on('comment:new') plus bas) est jointe
  // une seule fois indépendamment de `user` : on passe par une ref pour que
  // le handler appelle toujours la version la plus récente de markSeenNow
  // (celle qui connaît l'utilisateur courant une fois chargé), au lieu d'une
  // closure figée au montage du socket.
  const markSeenNowRef = useRef(markSeenNow);
  useEffect(() => { markSeenNowRef.current = markSeenNow; });

  // ── Accusés "vu" (mentions/réponses) ────────────────────────────────────
  // Chargés à la demande (pas dans `load()`) uniquement pour les commentaires
  // de l'utilisateur courant qui mentionnent quelqu'un : c'est la seule
  // situation où "savoir qui a lu avant de relancer" a du sens, et l'endpoint
  // est de toute façon réservé à l'auteur côté backend (403 sinon).
  const fetchedSeenIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!user) return;
    const toFetch = comments.filter(
      c => c.author_id === user.id && c.mentioned_user_ids.length > 0 && !fetchedSeenIdsRef.current.has(c.id),
    );
    if (toFetch.length === 0) return;

    let cancelled = false;
    (async () => {
      for (const c of toFetch) {
        fetchedSeenIdsRef.current.add(c.id);
        try {
          const data = await getCommentSeenBy(projectId, c.id);
          if (!cancelled) setSeenByComment(prev => new Map(prev).set(c.id, data));
        } catch {
          // Pas critique : le badge "Vu" reste simplement absent pour ce commentaire.
        }
      }
    })();

    return () => { cancelled = true; };
  }, [comments, user, projectId]);

  // ── Temps réel — rejoint la room de cette exigence/TC pendant que le
  // drawer est ouvert ; reçoit les nouveaux commentaires, résolutions et
  // suppressions faits par d'autres utilisateurs sans avoir à rafraîchir.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const ticket = await getWsTicket();
        if (cancelled) return;

        const socket = io(`${BACKEND_WS_URL}/notifications`, {
          auth: { ticket },
          transports: ["websocket"],
        });

        socket.on("connect", () => {
          socket.emit("comments:join", { entityType, entityId });
          setLive(true);
        });
        socket.on("disconnect", () => setLive(false));

        socket.on("comment:new", (c: Comment) => {
          setComments(prev => (prev.some(p => p.id === c.id) ? prev : [...prev, c].sort((a, b) => a.created_at.localeCompare(b.created_at))));
          // Un utilisateur déjà sur le fil au moment où un nouveau commentaire
          // arrive est considéré comme l'ayant vu tout de suite — pas besoin
          // de fermer/rouvrir le drawer pour que le "vu" se déclenche.
          markSeenNowRef.current();
        });
        socket.on("comment:updated", (c: Comment) => {
          setComments(prev => prev.map(p => (p.id === c.id ? c : p)));
        });
        socket.on("comment:deleted", ({ id }: { id: string }) => {
          setComments(prev => prev.filter(p => p.id !== id));
        });

        socket.on("comment:typing", (payload: { actorId: string; actorName: string; active: boolean }) => {
          if (payload.actorId === user?.id) return; // ne jamais s'auto-afficher
          const { actorId, actorName, active } = payload;

          const existingTimer = typingExpiryRef.current.get(actorId);
          if (existingTimer) clearTimeout(existingTimer);
          typingExpiryRef.current.delete(actorId);

          setTypingUsers(prev => {
            const next = new Map(prev);
            if (active) next.set(actorId, actorName);
            else next.delete(actorId);
            return next;
          });

          if (active) {
            // Filet de sécurité de 5s (voir déclaration de typingExpiryRef ci-dessus).
            const timer = setTimeout(() => {
              setTypingUsers(prev => {
                const next = new Map(prev);
                next.delete(actorId);
                return next;
              });
              typingExpiryRef.current.delete(actorId);
            }, 5000);
            typingExpiryRef.current.set(actorId, timer);
          }
        });

        // Accusé "vu" en direct : re-fetch la vérité serveur pour ce
        // commentaire (au lieu de corriger seulement la copie locale) — sinon,
        // si l'événement arrivait avant que loadSeenBy ait fini de charger ce
        // commentaire (course entre le socket et le fetch initial), la mise à
        // jour était silencieusement perdue et "Relancer" ne disparaissait
        // qu'après un rechargement manuel de la page.
        socket.on("comment:seen", async (payload: { commentId: string; userId: string; userName: string; readAt: string }) => {
          try {
            const fresh = await getCommentSeenBy(projectId, payload.commentId);
            fetchedSeenIdsRef.current.add(payload.commentId);
            setSeenByComment(prev => new Map(prev).set(payload.commentId, fresh));
          } catch {
            // Pas critique : le badge reste simplement pas à jour pour ce commentaire.
          }
        });

        // Accusé "vu" généralisé en direct (voir SeenAvatars) : quelqu'un
        // (n'importe quel membre, pour n'importe quel commentaire) vient de
        // consulter le fil — met à jour son avatar sur tous les commentaires
        // concernés sans attendre un rechargement.
        socket.on("comment:thread-seen", (payload: { userId: string; userName: string; readAt: string }) => {
          setReadReceipts(prev => new Map(prev).set(payload.userId, payload));
        });

        socketRef.current = socket;
      } catch {
        // Pas de temps réel disponible — le fil reste utilisable, juste sans
        // mise à jour live (rechargé manuellement via load() après chaque action).
      }
    })();

    return () => {
      cancelled = true;
      socketRef.current?.emit("comments:typing", { entityType, entityId, active: false });
      socketRef.current?.emit("comments:leave", { entityType, entityId });
      socketRef.current?.disconnect();
      socketRef.current = null;
      setLive(false);
      setTypingUsers(new Map());
      for (const timer of typingExpiryRef.current.values()) clearTimeout(timer);
      typingExpiryRef.current.clear();
    };
  }, [projectId, entityType, entityId]);

  const allRoots = comments.filter(c => !c.parent_id);
  const repliesOf = (id: string) => comments.filter(c => c.parent_id === id);
  const resolvableRoots = allRoots.filter(c => c.requires_resolution);
  const unresolvedCount = resolvableRoots.filter(c => !c.resolved).length;
  const resolvedCount = resolvableRoots.length - unresolvedCount;

  /**
   * Un seul avatar "vu" par utilisateur dans tout le fil (comme Messenger),
   * placé uniquement sur le DERNIER commentaire qu'il a vu — pas répété sur
   * chaque commentaire antérieur. La bulle "se déplace" naturellement d'un
   * commentaire à l'autre à mesure que readReceipts se met à jour (lecture
   * initiale, ou événement 'comment:thread-seen' en direct).
   */
  const lastSeenByUser = useMemo(() => {
    const sorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const map = new Map<string, string>(); // userId -> id du dernier commentaire vu
    for (const [userId, r] of readReceipts) {
      if (userId === user?.id) continue; // pas la peine de s'afficher soi-même
      const readAtTime = new Date(r.readAt).getTime();
      let target: Comment | undefined;
      for (const c of sorted) {
        if (new Date(c.created_at).getTime() <= readAtTime) target = c;
        else break;
      }
      if (target) map.set(userId, target.id);
    }
    return map;
  }, [comments, readReceipts, user?.id]);

  const roots = allRoots.filter(c => {
    if (filter === "unresolved") return c.requires_resolution && !c.resolved;
    if (filter === "resolved") return c.requires_resolution && c.resolved;
    return true;
  });

  const handleCreate = async (content: string, mentionedUserIds: string[], requiresResolution: boolean) => {
    await createComment(projectId, { entityType, entityId, content, mentionedUserIds, requiresResolution });
    await load();
  };

  const toggleResolve = async (c: Comment) => {
    if (c.resolved) await reopenComment(projectId, c.id);
    else await resolveComment(projectId, c.id);
    await load();
  };

  const handleDelete = async (c: Comment) => {
    setDeletingId(c.id);
    try {
      await deleteComment(projectId, c.id);
      setComments(prev => prev.filter(p => p.id !== c.id && p.parent_id !== c.id));
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  /** Relance les destinataires qui n'ont pas encore lu ce commentaire (voir SeenBadge). */
  const handleRemind = async (commentId: string) => {
    const existingTimer = remindTimersRef.current.get(commentId);
    if (existingTimer) clearTimeout(existingTimer);

    setRemindState(prev => new Map(prev).set(commentId, "sending"));
    try {
      await remindComment(projectId, commentId);
      setRemindState(prev => new Map(prev).set(commentId, "sent"));
      // Repasse le bouton en "Relancer" après un délai raisonnable, plutôt que
      // de le laisser désactivé indéfiniment — au cas où d'autres personnes
      // mentionnées n'auraient toujours pas lu un peu plus tard.
      remindTimersRef.current.set(commentId, setTimeout(() => {
        setRemindState(prev => { const next = new Map(prev); next.delete(commentId); return next; });
        remindTimersRef.current.delete(commentId);
      }, 60000));
    } catch {
      // Cas typique : tout le monde vient de lire entre-temps (course avec un
      // accusé "vu" arrivé juste avant le clic) — pas une vraie erreur pour
      // l'utilisateur, juste rien à faire.
      setRemindState(prev => new Map(prev).set(commentId, "error"));
      remindTimersRef.current.set(commentId, setTimeout(() => {
        setRemindState(prev => { const next = new Map(prev); next.delete(commentId); return next; });
        remindTimersRef.current.delete(commentId);
      }, 4000));
    }
  };

  // Nettoie les timers de "Relancer" au démontage du fil.
  useEffect(() => () => {
    for (const timer of remindTimersRef.current.values()) clearTimeout(timer);
    remindTimersRef.current.clear();
  }, []);

  const renderComment = (c: Comment, isReply: boolean) => {
    const author = membersById.get(c.author_id);
    const authorName = author?.name ?? (c.author_id === user?.id ? "Vous" : "Utilisateur");
    const isOwn = c.author_id === user?.id;
    const canDelete = isOwn;
    const isDeleting = deletingId === c.id;

    // Accusé "vu" façon Messenger : une seule bulle par utilisateur dans tout
    // le fil, affichée uniquement sur le dernier commentaire qu'il a vu (voir
    // lastSeenByUser) — pas un avatar répété sur chaque commentaire vu.
    const seenViewers = Array.from(readReceipts.values()).filter(
      r => lastSeenByUser.get(r.userId) === c.id,
    );

    return (
      <div
        key={c.id}
        style={{
          marginLeft: isReply && !isOwn ? 32 : 0,
          marginRight: isReply && isOwn ? 32 : 0,
          marginBottom: 12, display: "flex", flexDirection: isOwn ? "row-reverse" : "row",
          gap: 8, opacity: isDeleting ? 0.4 : 1, transition: "opacity 0.15s ease",
        }}
      >
        <Avatar name={authorName} color={colorMap.get(c.author_id) ?? fallbackColor(c.author_id)} size={isReply ? 24 : 28} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: isOwn ? "flex-end" : "flex-start", maxWidth: "78%" }}>
          <div style={{
            padding: "8px 11px", borderRadius: isOwn ? "12px 4px 12px 12px" : "4px 12px 12px 12px",
            background: c.resolved ? C.greenLight : (isOwn ? C.blueLight : "#f8fafc"),
            border: `1px solid ${c.resolved ? "#bbf7d0" : (isOwn ? "#bfdbfe" : C.border)}`,
          }}>
            <div style={{ display: "flex", flexDirection: isOwn ? "row-reverse" : "row", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>
                {authorName}
              </span>
              <span title={absoluteTime(c.created_at)} style={{ fontSize: 10, color: C.slate400, flexShrink: 0 }}>
                {relativeTime(c.created_at)}
              </span>
            </div>
            <div style={{ fontSize: 13, color: "#334155", marginTop: 3, whiteSpace: "pre-wrap", wordBreak: "break-word", textAlign: "left" }}>
              {renderContent(c.content, members)}
            </div>
          </div>

          {/* "Résoudre" n'est proposé qu'aux autres membres, et uniquement si
              l'auteur a coché "Nécessite une résolution" à l'écriture — jamais
              affiché à l'auteur lui-même. L'auteur voit à la place un simple
              statut (lecture seule) tant que son commentaire n'est pas résolu. */}
          <div style={{ display: "flex", flexDirection: isOwn ? "row-reverse" : "row", alignItems: "center", gap: 12, marginTop: 5, minHeight: 16 }}>
            {!isReply && c.requires_resolution && !isOwn && (
              <button
                onClick={() => toggleResolve(c)}
                style={{ background: "none", border: "none", color: c.resolved ? C.slate400 : C.green, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 }}
              >
                {c.resolved ? "↺ Rouvrir" : "✓ Résoudre"}
              </button>
            )}
            {!isReply && c.requires_resolution && isOwn && !c.resolved && (
              <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 700, color: C.amber }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.amber, display: "inline-block" }} />
                En attente de résolution
              </span>
            )}

            {/* Accusé "vu" généralisé : petits avatars de tous ceux qui ont déjà
                consulté le fil après ce commentaire, quel que soit le commentaire
                (plus seulement quand quelqu'un est mentionné). */}
            <SeenAvatars viewers={seenViewers} colorMap={colorMap} />

            {/* Bouton "Relancer" : uniquement sur mes propres commentaires qui
                mentionnent quelqu'un — permet de relancer ceux qui n'ont pas lu. */}
            {isOwn && c.mentioned_user_ids.length > 0 && seenByComment.get(c.id) && (
              <SeenBadge
                seen={seenByComment.get(c.id)!}
                remindStatus={remindState.get(c.id)}
                onRemind={() => handleRemind(c.id)}
              />
            )}

            {canDelete && (
              confirmDeleteId === c.id ? (
                <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
                  <span style={{ color: C.slate500 }}>Supprimer ?</span>
                  <button
                    onClick={() => handleDelete(c)}
                    disabled={isDeleting}
                    style={{ background: "none", border: "none", color: C.red, fontWeight: 700, cursor: "pointer", padding: 0 }}
                  >
                    Oui
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    style={{ background: "none", border: "none", color: C.slate500, fontWeight: 700, cursor: "pointer", padding: 0 }}
                  >
                    Non
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmDeleteId(c.id)}
                  title="Supprimer"
                  aria-label="Supprimer"
                  style={{ background: "none", border: "none", color: C.slate400, fontSize: 13, cursor: "pointer", padding: 0, lineHeight: 1 }}
                  onMouseEnter={e => (e.currentTarget.style.color = C.red)}
                  onMouseLeave={e => (e.currentTarget.style.color = C.slate400)}
                >
                  🗑
                </button>
              )
            )}
          </div>

          {repliesOf(c.id).map(r => renderComment(r, true))}
        </div>
      </div>
    );
  };

  if (loading) {
    return <CommentSkeleton />;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.slate600 }}>
          {allRoots.length === 0 ? "Aucun commentaire" : `${allRoots.length} commentaire${allRoots.length > 1 ? "s" : ""}`}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: live ? C.green : C.slate400, fontWeight: 700, flexShrink: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: live ? C.green : C.slate400, display: "inline-block" }} />
          {live ? "Live" : "Hors ligne"}
        </span>
      </div>

      {resolvableRoots.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {([
            ["all", `Tous (${allRoots.length})`],
            ["unresolved", `À résoudre (${unresolvedCount})`],
            ["resolved", `Résolus (${resolvedCount})`],
          ] as [FilterMode, string][]).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setFilter(mode)}
              style={{
                fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 20, cursor: "pointer",
                border: `1px solid ${filter === mode ? C.blue : C.border}`,
                background: filter === mode ? C.blue : "#fff",
                color: filter === mode ? "#fff" : C.slate600,
                transition: "all 0.12s ease",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {roots.length === 0 ? (
        <div style={{
          textAlign: "center", padding: "24px 12px", color: C.slate400, fontSize: 12,
          border: `1px dashed ${C.border}`, borderRadius: 10, marginBottom: 12,
        }}>
          {allRoots.length === 0
            ? "💬 Aucun commentaire pour l'instant."
            : "Aucun commentaire ne correspond à ce filtre."}
        </div>
      ) : (
        roots.map(c => renderComment(c, false))
      )}

      <TypingIndicator names={Array.from(typingUsers.values())} />

      <div style={{ marginTop: 4 }}>
        <CommentComposer
          members={members}
          showResolutionOption
          onSubmit={(content, mentionedUserIds, requiresResolution) => handleCreate(content, mentionedUserIds, requiresResolution)}
          onTypingChange={active => socketRef.current?.emit("comments:typing", { entityType, entityId, active })}
        />
      </div>
    </div>
  );
}