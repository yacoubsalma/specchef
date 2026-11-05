"use client";

import type { PresenceUser } from "../hooks/useProjectRealtime";

/** Même logique de couleur que dans le fil de commentaires : les teintes sont
 *  espacées via l'angle doré (~137,5°) selon la position de la personne dans
 *  la liste, ce qui garantit un écart maximal entre deux avatars voisins —
 *  au lieu d'une petite palette fixe où deux couleurs pouvaient se ressembler. */
function colorFor(index: number) {
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue}, 68%, 45%)`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}

const ACTIVITY_LABEL: Record<string, string> = {
  editing: "en train de modifier",
  generating: "en train de générer des cas de test",
};

function Avatar({ u, isSelf, color, onClick }: { u: PresenceUser; isSelf: boolean; color: string; onClick?: () => void }) {
  const active = !!u.activity && u.activity !== "idle";
  const activityText = active
    ? (u.activityLabel ? `${ACTIVITY_LABEL[u.activity!] || u.activity} — ${u.activityLabel}` : (ACTIVITY_LABEL[u.activity!] || u.activity))
    : null;
  // "Suivre" (follow) n'a de sens que pour les AUTRES : on ne peut pas se
  // scroller soi-même vers ce qu'on regarde déjà.
  const followable = !isSelf && !!onClick;
  const tooltip = isSelf
    ? (activityText ? `Vous — ${activityText}` : "Vous")
    : (activityText ? `${u.userName} — ${activityText} · cliquer pour suivre` : `${u.userName} · cliquer pour suivre`);

  return (
    <div className={`relative${followable ? ' cursor-pointer' : ''}`} title={tooltip} onClick={followable ? onClick : undefined}>
      <div
        className={`w-7 h-7 rounded-full border-2 border-white dark:border-black flex items-center justify-center text-[10px] font-bold text-white select-none${followable ? ' hover:ring-2 hover:ring-offset-1 hover:ring-primary/50 dark:hover:ring-offset-black transition-all' : ''}`}
        style={{ backgroundColor: color }}
      >
        {isSelf ? "•" : initials(u.userName)}
      </div>
      {active && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-black ${
            u.activity === "generating" ? "bg-amber-500 animate-pulse" : "bg-emerald-500"
          }`}
        />
      )}
    </div>
  );
}

/**
 * Avatars empilés des utilisateurs actuellement sur ce projet (présence live
 * via useProjectRealtime).
 *
 * - "Vous" apparaît toujours en premier, distinct des autres.
 * - Le nom complet de chaque personne s'affiche au survol de son avatar.
 * - Un point coloré indique une activité en cours : orange qui pulse pour
 *   une génération, vert fixe pour une édition. Pas de point = inactif.
 */
export function ProjectPresenceBar({ users, selfUserId, onAvatarClick }: { users: PresenceUser[]; selfUserId?: string; /** Clic sur l'avatar d'un AUTRE utilisateur — "follow" vers ce qu'il regarde. */ onAvatarClick?: (u: PresenceUser) => void }) {
  if (!users || users.length === 0) return null;

  const self = users.find(u => u.userId === selfUserId);
  const others = users.filter(u => u.userId !== selfUserId);
  const ordered = self ? [self, ...others] : others;

  const activeOthers = others.filter(u => u.activity && u.activity !== "idle");

  let label: string;
  if (others.length === 0) {
    label = "Vous seul(e) sur ce projet";
  } else if (others.length === 1) {
    label = `Vous et ${others[0].userName}`;
  } else {
    label = `Vous et ${others.length} autres`;
  }
  if (activeOthers.length > 0) {
    const verbe = activeOthers.length > 1 ? "travaillent" : "travaille";
    label += ` · ${activeOthers.map(u => u.userName).join(', ')} ${verbe} dessus`;
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-2">
        {ordered.slice(0, 6).map((u, i) => (
          <Avatar key={u.userId} u={u} isSelf={u.userId === selfUserId} color={colorFor(i)} onClick={onAvatarClick ? () => onAvatarClick(u) : undefined} />
        ))}
        {ordered.length > 6 && (
          <div className="w-7 h-7 rounded-full border-2 border-white dark:border-black flex items-center justify-center text-[10px] font-bold bg-slate-400 text-white">
            +{ordered.length - 6}
          </div>
        )}
      </div>
      <span className="text-xs text-waterloo">{label}</span>
    </div>
  );
}