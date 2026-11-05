'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Permet à n'importe quel composant descendant (ex: GenerationModeSelector,
// AnglesPreview, AssistTest, ProjectPicker, JiraSettingsModal...) de demander
// au layout global de masquer le Header le temps qu'il est affiché.
//
// Plusieurs overlays peuvent être ouverts en même temps (ou se chevaucher
// pendant une transition), donc on garde un compteur de "demandes de masquage"
// plutôt qu'un simple booléen : le header ne réapparaît que lorsque plus aucun
// overlay n'est actif.
// ─────────────────────────────────────────────────────────────────────────────

interface HeaderVisibilityContextValue {
  hideHeader: boolean;
  requestHideHeader: () => () => void;
}

const HeaderVisibilityContext = createContext<HeaderVisibilityContextValue>({
  hideHeader: false,
  requestHideHeader: () => () => {},
});

export function HeaderVisibilityProvider({ children }: { children: ReactNode }) {
  const [hideCount, setHideCount] = useState(0);

  const requestHideHeader = useCallback(() => {
    let releasedAlready = false;
    setHideCount((c) => c + 1);

    return () => {
      if (releasedAlready) return;
      releasedAlready = true;
      setHideCount((c) => Math.max(0, c - 1));
    };
  }, []);

  const value = useMemo(
    () => ({ hideHeader: hideCount > 0, requestHideHeader }),
    [hideCount, requestHideHeader]
  );

  return (
    <HeaderVisibilityContext.Provider value={value}>
      {children}
    </HeaderVisibilityContext.Provider>
  );
}

export function useHeaderVisibility() {
  return useContext(HeaderVisibilityContext);
}

/**
 * Hook pratique : masque le Header global tant que `active` est vrai.
 * À utiliser dans n'importe quel modal/overlay plein écran.
 *
 * Exemple :
 *   useHideHeaderWhen(!!genModeReq);
 */
export function useHideHeaderWhen(active: boolean) {
  const { requestHideHeader } = useHeaderVisibility();

  useEffect(() => {
    if (!active) return;
    const release = requestHideHeader();
    return release;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
