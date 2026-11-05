'use client';

import { ReactNode, CSSProperties } from 'react';

/**
 * Badge — étiquette d'information NON cliquable (statut, compteur, méta-donnée).
 *
 * Différence volontaire avec un bouton :
 *  - fond plat en teinte pastel (10% d'opacité), jamais de couleur pleine
 *  - pas d'ombre, pas d'effet hover/active, pas de curseur pointer
 *  - poids de police medium (pas bold comme les boutons)
 *  - coin arrondi modéré (rounded-md), pas "pilule" comme les vrais boutons d'action
 *
 * Ça évite la confusion "ça ressemble à un bouton mais ça ne fait rien au clic".
 */

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-slate-500/8 text-waterloo dark:text-manatee ring-1 ring-inset ring-slate-500/15',
  primary: 'bg-primary/8 text-primary ring-1 ring-inset ring-primary/20',
  success: 'bg-meta/10 text-meta ring-1 ring-inset ring-meta/25',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 ring-1 ring-inset ring-amber-500/25',
  danger: 'bg-red-500/8 text-red-700 dark:text-red-400 ring-1 ring-inset ring-red-500/20',
  info: 'bg-sky-500/8 text-sky-700 dark:text-sky-400 ring-1 ring-inset ring-sky-500/20',
};

const SIZE_CLASSES = {
  xs: 'text-[10px] px-1.5 py-0.5 gap-1',
  sm: 'text-xs px-2 py-0.5 gap-1',
  md: 'text-xs px-2.5 py-1 gap-1.5',
};

interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  size?: keyof typeof SIZE_CLASSES;
  icon?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Badge({ children, tone = 'neutral', size = 'sm', icon, className = '', style }: BadgeProps) {
  return (
    <span
      style={style}
      className={`inline-flex select-none items-center rounded-md font-medium whitespace-nowrap ${TONE_CLASSES[tone]} ${SIZE_CLASSES[size]} ${className}`}
    >
      {icon}
      {children}
    </span>
  );
}

export default Badge;

/**
 * IdTag — identifiant (FR-xxx, TC-xxx...) affiché en monospace avec un
 * discret liseré de couleur à gauche plutôt qu'un contour plein "bouton".
 * Volontairement non cliquable / non interactif.
 */
interface IdTagProps {
  children: ReactNode;
  color?: string; // hex, ex '#2563eb' — utilisé pour le liseré + le texte
  className?: string;
}

export function IdTag({ children, color = '#2563eb', className = '' }: IdTagProps) {
  return (
    <span
      className={`inline-flex select-none items-center shrink-0 rounded-md border-l-[3px] bg-slate-500/5 dark:bg-white/5 px-2.5 py-1 font-mono text-[11px] font-semibold tracking-tight ${className}`}
      style={{ borderLeftColor: color, color }}
    >
      {children}
    </span>
  );
}

/**
 * StatusPill — statut binaire "sauvegardé / en attente" etc., avec pastille
 * pleine (pas de fond coloré massif) pour rester discret à côté d'un TC.
 */
interface StatusPillProps {
  children: ReactNode;
  tone?: BadgeTone;
  dotColor?: string;
  className?: string;
}

export function StatusPill({ children, tone = 'neutral', dotColor, className = '' }: StatusPillProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${TONE_CLASSES[tone]} ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor ?? 'currentColor' }} />
      {children}
    </span>
  );
}
