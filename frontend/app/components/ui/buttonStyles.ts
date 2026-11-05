/**
 * Styles de boutons partagés — pour que TOUT ce qui est cliquable dans
 * Analyzer suive le même langage visuel (radius, ombre, transition), et se
 * distingue clairement des Badges (voir Badge.tsx) qui eux ne sont jamais
 * cliquables.
 *
 * Utilisation : className={btn.primary} / className={btn.secondary} etc.
 * On peut concaténer une taille : `${btn.primary} ${btnSize.sm}`
 */

export const btn = {
  primary:
    'inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary text-white font-semibold shadow-[0_1px_2px_rgba(15,23,42,0.08)] transition-all duration-150 hover:bg-primaryho hover:shadow-[0_4px_12px_rgba(37,99,235,0.25)] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none disabled:shadow-none',
  secondary:
    'inline-flex items-center justify-center gap-1.5 rounded-lg border border-stroke dark:border-strokedark bg-white dark:bg-blacksection text-black dark:text-white font-semibold transition-all duration-150 hover:border-primary/40 hover:bg-primary/5 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none',
  ghost:
    'inline-flex items-center justify-center gap-1.5 rounded-lg text-waterloo dark:text-manatee font-medium transition-all duration-150 hover:bg-slate-500/8 hover:text-black dark:hover:text-white active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none',
  danger:
    'inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/25 text-red-700 dark:text-red-400 font-semibold transition-all duration-150 hover:bg-red-500/8 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none',
  success:
    'inline-flex items-center justify-center gap-1.5 rounded-lg bg-meta text-white font-semibold shadow-[0_1px_2px_rgba(15,23,42,0.08)] transition-all duration-150 hover:brightness-95 hover:shadow-[0_4px_12px_rgba(13,156,111,0.25)] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none disabled:shadow-none',
  iconOnly:
    'inline-flex items-center justify-center rounded-lg text-waterloo dark:text-manatee transition-all duration-150 hover:bg-slate-500/8 hover:text-black dark:hover:text-white active:scale-[0.95] disabled:opacity-40 disabled:pointer-events-none',
};

export const btnSize = {
  xs: 'text-[11px] px-2.5 py-1',
  sm: 'text-xs px-3 py-1.5',
  md: 'text-sm px-4 py-2',
  lg: 'text-sm px-6 py-2.5',
  icon: 'w-8 h-8',
  iconSm: 'w-7 h-7',
};

/** Panneau/carte élevée standard */
export const card =
  'rounded-2xl border border-stroke dark:border-strokedark bg-white dark:bg-blacksection shadow-solid-3';

/** Titre de section standard (utilisé pour chaque "fenêtre"/panneau) */
export const sectionTitle = 'text-base font-bold text-black dark:text-white tracking-tight';