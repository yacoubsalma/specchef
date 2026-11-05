"use client";

import Header from "@/components/Header";
import Lines from "@/components/Lines";
import ScrollToTop from "@/components/ScrollToTop";
import { ThemeProvider } from "next-themes";
import { usePathname } from "next/navigation";
import ToasterContext from "../context/ToastContext";
import { AuthProvider } from "../context/AuthContext";
import { JiraProvider } from "../context/JiraContext";
import { HeaderVisibilityProvider, useHeaderVisibility } from "../context/HeaderVisibilityContext";
import { CommentsDrawerProvider } from "../context/CommentsDrawerContext";
import { UnreadCommentsProvider } from "../context/UnreadCommentsContext";
import CommentsDrawer from "../components/CommentsDrawer";

// Pages sur lesquelles le header global ne doit pas s'afficher
// (ex: la page de connexion doit être "standalone").
const HIDDEN_HEADER_PATHS = [
  "/auth/signin",
  "/auth/forgot-password",
  "/auth/verify-otp",
  "/auth/reset-password",
];

// NOTE: l'ancien AuthGuard basé sur localStorage("analyzer_auth") a été
// retiré : il datait d'avant la migration vers les cookies httpOnly et
// entrait en conflit avec middleware.ts, qui protège déjà correctement
// /analyzer, /projects, /admin et /account côté serveur. Le garder
// provoquait une redirection systématique vers /auth/signin sur tout
// navigateur n'ayant jamais eu cette clé localStorage, même juste après
// un login réussi.

// Affiche le Header global sauf si la page courante est dans la liste des
// pages "standalone", ou si un overlay plein écran (GenerationModeSelector,
// AnglesPreview, AssistTest, ProjectPicker, JiraSettingsModal...) a demandé
// son masquage via useHideHeaderWhen()/requestHideHeader().
function HeaderGate({ pathOk }: { pathOk: boolean }) {
  const { hideHeader } = useHeaderVisibility();
  return pathOk && !hideHeader ? <Header /> : null;
}

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const showHeader = !HIDDEN_HEADER_PATHS.includes(pathname);

  return (
    <ThemeProvider
      enableSystem={false}
      attribute="class"
      defaultTheme="light"
    >
      <AuthProvider>
        <JiraProvider>
          <HeaderVisibilityProvider>
            <CommentsDrawerProvider>
              <UnreadCommentsProvider>
                <Lines />
                <HeaderGate pathOk={showHeader} />
                <ToasterContext />
                {children}
                <ScrollToTop />
                <CommentsDrawer />
              </UnreadCommentsProvider>
            </CommentsDrawerProvider>
          </HeaderVisibilityProvider>
        </JiraProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}