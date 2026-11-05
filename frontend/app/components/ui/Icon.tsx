'use client';

/**
 * Jeu d'icônes unique pour toute l'interface Analyzer.
 * Objectif : remplacer les emojis par un set cohérent, sobre et professionnel
 * (trait fin, coins arrondis, currentColor) et réduire le nombre de pictos
 * différents affichés à l'écran.
 *
 * Toutes les icônes acceptent `className` (taille/couleur pilotées par Tailwind,
 * ex. "w-4 h-4") et sont strokeWidth=1.75 par défaut pour rester légères.
 */

export interface IconProps {
  className?: string;
  strokeWidth?: number;
}

const base = (strokeWidth = 1.75) => ({
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
});

export const IconSearch = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
);

export const IconFolder = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </svg>
);

export const IconFile = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M6 2.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 20V4a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="M14 2.5V7h4.5" />
  </svg>
);

export const IconEdit = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

export const IconCheck = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export const IconCheckCircle = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.5 2.3 2.3L15.5 9.5" />
  </svg>
);

export const IconClose = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M18 6 6 18" />
    <path d="M6 6l12 12" />
  </svg>
);

export const IconAlertTriangle = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M10.6 3.9 2.7 18a1.6 1.6 0 0 0 1.4 2.4h15.8a1.6 1.6 0 0 0 1.4-2.4L13.4 3.9a1.6 1.6 0 0 0-2.8 0Z" />
    <path d="M12 9.5v4" />
    <path d="M12 17h.01" />
  </svg>
);

// ── Campagne de tests (gel du projet) ───────────────────────────────────────
export const IconLock = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5" />
  </svg>
);

export const IconUnlock = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
    <path d="M7.5 10.5V7a4.5 4.5 0 0 1 8.4-2.2" />
  </svg>
);

export const IconRocket = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M14.5 3.5c2.5.7 4.3 2.5 5 5-1 4-3.3 7.1-6.5 9.6l-3-1-1-3c2.5-3.2 5.6-5.5 9.6-6.5-1-.8-2.2-1.4-4.1-1.9Z" />
    <path d="M9.5 14.5 6 15.5l1-3.5" />
    <circle cx="15" cy="9" r="1.4" />
    <path d="M5 19c1-1.6 2.2-2 4-1.8" />
    <path d="M5 19c-.6.9-.8 2-.8 2.8.8 0 1.9-.2 2.8-.8" />
  </svg>
);

export const IconFlask = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M9 2.5h6" />
    <path d="M10 2.5v6.2L4.8 18.4A2 2 0 0 0 6.5 21.5h11a2 2 0 0 0 1.7-3.1L14 8.7V2.5" />
    <path d="M7.5 15h9" />
  </svg>
);

export const IconSave = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M5 3.5h11L21 8v12.5a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5v-16A.5.5 0 0 1 5.5 3.5Z" />
    <path d="M8 3.5V9h8V3.5" />
    <path d="M8 21v-6h8v6" />
  </svg>
);

export const IconBolt = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
  </svg>
);

export const IconTarget = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IconLink = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M11 6.5 12.6 4.9a3.6 3.6 0 0 1 5.1 5.1L16.1 11.6" />
    <path d="M13 17.5 11.4 19.1a3.6 3.6 0 0 1-5.1-5.1L7.9 12.4" />
  </svg>
);

export const IconChart = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M4 20V10" />
    <path d="M11 20V4" />
    <path d="M18 20v-7" />
    <path d="M3 20h18" />
  </svg>
);

export const IconUsers = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19.5c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5" />
    <path d="M16.5 8.3a3 3 0 1 1 0 5.9" />
    <path d="M19 14.3c2 .4 3.5 2.1 3.5 5.2" />
  </svg>
);

export const IconEye = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);

export const IconMessage = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M4 5.5h16v10.5H8.5L4 20V5.5Z" />
  </svg>
);

export const IconUpload = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M12 16V4" />
    <path d="M7 8.5 12 3.5 17 8.5" />
    <path d="M4.5 16v3.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V16" />
  </svg>
);

export const IconDownload = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M12 3.5v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M4.5 20h15" />
  </svg>
);

export const IconRefresh = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M3.5 12a8.5 8.5 0 0 1 14.6-5.9L20.5 8.5" />
    <path d="M20.5 4.5v4h-4" />
    <path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9L3.5 15.5" />
    <path d="M3.5 19.5v-4h4" />
  </svg>
);

export const IconTrash = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M4.5 7h15" />
    <path d="M8.5 7V5a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 15.5 5v2" />
    <path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

export const IconChevronRight = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const IconChevronDown = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const IconUndo = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M8.5 8.5 4 12l4.5 3.5" />
    <path d="M4 12h11a5 5 0 0 1 0 10h-2" />
  </svg>
);

export const IconInbox = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M3.5 12h5l1.6 2.6h3.8L15.5 12h5" />
    <path d="M6 5.5h12L20.5 12v6a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-6L6 5.5Z" />
  </svg>
);

export const IconCalendar = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <rect x="3.5" y="5" width="17" height="16" rx="2" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
  </svg>
);

export const IconClock = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.2 2" />
  </svg>
);

export const IconShuffle = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M3 6h4l9.5 12H21" />
    <path d="M17 3l4 3-4 3" />
    <path d="M3 18h4l3.2-4" />
    <path d="M14 6l1.3-1.5M17 15l4 3-4 3" />
  </svg>
);

export const IconPackage = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16V8Z" />
    <path d="M3.5 8 12 12.5 20.5 8" />
    <path d="M12 12.5V20.5" />
  </svg>
);

export const IconSparkle = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M12 3.5c.6 3 1.9 4.4 5 5-3.1.6-4.4 2-5 5-.6-3-1.9-4.4-5-5 3.1-.6 4.4-2 5-5Z" />
    <path d="M18.5 15.5c.3 1.4.9 2 2.3 2.3-1.4.3-2 .9-2.3 2.3-.3-1.4-.9-2-2.3-2.3 1.4-.3 2-.9 2.3-2.3Z" />
  </svg>
);

export const IconPin = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M12 21s-6.5-5.9-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.1-6.5 11-6.5 11Z" />
    <circle cx="12" cy="10" r="2.3" />
  </svg>
);

export const IconExternalLink = ({ className, strokeWidth }: IconProps) => (
  <svg className={className} {...base(strokeWidth)}>
    <path d="M9 6H5.5a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 5.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" />
    <path d="M14.5 4H20v5.5" />
    <path d="M20 4 11 13" />
  </svg>
);
