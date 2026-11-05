'use client';

import { useEffect } from 'react';

export default function ConfirmDeleteModal({
  open,
  title = 'Supprimer ?',
  message,
  confirmLabel = 'Supprimer',
  cancelLabel = 'Annuler',
  loading = false,
  danger = true,
  /** Emoji affiché dans le rond en haut du popup. Par défaut 🗑️ (usage
   *  historique : suppression), mais surchargeable pour les autres
   *  confirmations "impactantes" qui réutilisent ce même popup générique
   *  (ex: 🔒/🔓 pour lancer/clôturer une campagne de tests). */
  icon = '🗑️',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  danger?: boolean;
  icon?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Fermeture au clavier (Échap) + verrouillage du scroll pendant l'affichage du popup
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, loading, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 px-4"
      onClick={() => !loading && onCancel()}
      role="presentation"
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white dark:bg-blacksection border border-stroke dark:border-strokedark shadow-solid-3 p-6"
        onClick={e => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
      >
        <div className="flex items-start gap-3 mb-2">
          <div className={`w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full text-lg ${danger ? 'bg-red-500/10 text-red-600' : 'bg-primary/10 text-primary'}`}>
            {icon}
          </div>
          <div className="min-w-0 pt-1">
            <h3 id="confirm-delete-title" className="text-sm font-bold text-black dark:text-white">
              {title}
            </h3>
            {message && (
              <p className="mt-1 text-xs text-waterloo leading-relaxed">{message}</p>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-lg border border-stroke dark:border-strokedark text-xs font-bold text-waterloo hover:text-black dark:hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 rounded-lg text-xs font-bold text-white transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:bg-primary/90'
            }`}
          >
            {loading ? '...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}