// Icônes SVG légères (stroke, 20x20) — évite les emojis pour un rendu plus
// sobre/pro, sans ajouter de dépendance (pas de lucide-react dans le projet).
// `className` pour la taille/couleur (ex: "w-4 h-4 text-primary").

type IconProps = { className?: string };

const base = {
  fill: 'none',
  viewBox: '0 0 24 24',
  strokeWidth: 1.8,
  stroke: 'currentColor',
};

export function IconFlag({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 21V4.5c0-.28.22-.5.5-.5h11.7c.4 0 .6.48.32.77L13 8l3.52 3.23c.28.29.08.77-.32.77H4.5" />
    </svg>
  );
}

export function IconFolder({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 7.5A1.5 1.5 0 0 1 5.25 6h4.19c.4 0 .78.16 1.06.44l1.3 1.3c.28.28.66.44 1.06.44h6.14a1.5 1.5 0 0 1 1.5 1.5v8.32a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5V7.5Z" />
    </svg>
  );
}

export function IconTrendUp({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m3 16 6-6 4 4 8-9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 5h6v6" />
    </svg>
  );
}

export function IconAlert({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 3.5h.01M10.6 3.9 2.4 18a1.5 1.5 0 0 0 1.3 2.25h16.6a1.5 1.5 0 0 0 1.3-2.25L13.4 3.9a1.5 1.5 0 0 0-2.6 0Z" />
    </svg>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="10.5" cy="10.5" r="6.5" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m20 20-4.5-4.5" />
    </svg>
  );
}

export function IconCheckCircle({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.5 12.5 2.3 2.3L16 9.5" />
    </svg>
  );
}

export function IconClock({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3.2 2" />
    </svg>
  );
}

export function IconArrowLeft({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 12H5m0 0 6-6m-6 6 6 6" />
    </svg>
  );
}

export function IconChevronRight({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function IconExternalOpen({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 4.5h5.5V10M19.2 4.8l-8.4 8.4M11 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V13" />
    </svg>
  );
}

export function IconRefresh({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12a8 8 0 0 1 14-5.2M20 12a8 8 0 0 1-14 5.2M20 3v5h-5M4 21v-5h5" />
    </svg>
  );
}

export function IconXCircle({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m9.5 9.5 5 5m0-5-5 5" />
    </svg>
  );
}

export function IconInbox({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 13.5 6.2 5.7A1.5 1.5 0 0 1 7.6 4.5h8.8a1.5 1.5 0 0 1 1.44 1.2L20 13.5m-16 0v4.7A1.8 1.8 0 0 0 5.8 20h12.4a1.8 1.8 0 0 0 1.8-1.8v-4.7m-16 0h4.2l1 2.2h5.6l1-2.2H20" />
    </svg>
  );
}

export function IconDownload({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v11m0 0 4-4m-4 4-4-4M5 19.5h14" />
    </svg>
  );
}

export function IconHistory({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.2 9.5A8 8 0 1 1 4 14M4.2 9.5H8M4.2 9.5V5.3M12 8v4.5l3 2" />
    </svg>
  );
}

export function IconChevronDown({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconSort({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 6v13m0-13 3 3M7 6 4 9m13 9V5m0 13-3-3m3 3 3-3" />
    </svg>
  );
}