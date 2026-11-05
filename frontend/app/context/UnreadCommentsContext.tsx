"use client";

/**
 * UnreadCommentsContext — badge "commentaire non vu" par exigence/TC.
 * ───────────────────────────────────────────────────────────────────
 * Contexte global (monté une seule fois dans Provider.tsx, comme
 * CommentsDrawerContext) qui garde en mémoire, pour le projet actuellement
 * ouvert dans l'analyzer, l'ensemble des exigences/TC portant un commentaire
 * plus récent que la dernière consultation de l'utilisateur courant.
 *
 * - `setActiveProject(projectId)` : appelé par la page analyzer dès que le
 *   projet affiché change ; charge la map initiale via
 *   GET /comments/unread-entities.
 * - `isUnread(entityType, entityId)` : consommé par les boutons 💬 pour
 *   afficher le point rouge.
 * - `markRead(projectId, entityType, entityId)` : appelé au clic sur 💬 —
 *   retire l'entrée localement (retour visuel immédiat) et notifie le
 *   backend via PATCH /comments/mark-read.
 *
 * Temps réel : une connexion WebSocket unique (même ticket JWT court que
 * useNotificationsSocket) écoute l'événement `comment:unseen`, émis par le
 * backend à tous les membres du projet (hors auteur) dès qu'un commentaire
 * est ajouté — indépendamment des mentions/réponses qui alimentent la
 * cloche 🔔.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from "react";
import { io, Socket } from "socket.io-client";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { getUnreadEntities, markCommentsRead, CommentEntityType } from "@/lib/comments-api";
import { getWsTicket } from "@/lib/notifications-api";

const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "http://localhost:3000";

function entityKey(entityType: string, entityId: string) {
  return `${entityType}:${entityId}`;
}

interface UnreadCommentsContextValue {
  setActiveProject: (projectId: string | null) => void;
  isUnread: (entityType: CommentEntityType, entityId: string) => boolean;
  markRead: (projectId: string, entityType: CommentEntityType, entityId: string) => void;
}

const UnreadCommentsContext = createContext<UnreadCommentsContextValue | null>(null);

export function UnreadCommentsProvider({ children }: { children: ReactNode }) {
  const { user } = useCurrentUser();
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const projectIdRef = useRef<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const refresh = useCallback(async (projectId: string) => {
    try {
      const data = await getUnreadEntities(projectId);
      const next = new Set<string>();
      (data.requirement || []).forEach(id => next.add(entityKey("requirement", id)));
      (data.test_case || []).forEach(id => next.add(entityKey("test_case", id)));
      setUnread(next);
    } catch {
      // silencieux — les badges restent tels quels en cas d'échec réseau ponctuel
    }
  }, []);

  const setActiveProject = useCallback((projectId: string | null) => {
    projectIdRef.current = projectId;
    if (projectId) refresh(projectId);
    else setUnread(new Set());
  }, [refresh]);

  const isUnread = useCallback(
    (entityType: CommentEntityType, entityId: string) => unread.has(entityKey(entityType, entityId)),
    [unread],
  );

  const markRead = useCallback((projectId: string, entityType: CommentEntityType, entityId: string) => {
    setUnread(prev => {
      const k = entityKey(entityType, entityId);
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
    markCommentsRead(projectId, entityType, entityId).catch(() => {});
  }, []);

  // Connexion WebSocket unique — reçoit comment:unseen pour le projet actif.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      try {
        const ticket = await getWsTicket();
        if (cancelled) return;

        const socket = io(`${BACKEND_WS_URL}/notifications`, {
          auth: { ticket },
          transports: ["websocket"],
        });

        socket.on("comment:unseen", (payload: { projectId: string; entityType: CommentEntityType; entityId: string }) => {
          if (payload.projectId !== projectIdRef.current) return;
          setUnread(prev => new Set(prev).add(entityKey(payload.entityType, payload.entityId)));
        });

        socketRef.current = socket;
      } catch {
        // pas de temps réel disponible — les badges restent basés sur le refresh initial
      }
    })();

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [user]);

  const value = useMemo(() => ({ setActiveProject, isUnread, markRead }), [setActiveProject, isUnread, markRead]);

  return <UnreadCommentsContext.Provider value={value}>{children}</UnreadCommentsContext.Provider>;
}

export function useUnreadComments() {
  const ctx = useContext(UnreadCommentsContext);
  if (!ctx) throw new Error("useUnreadComments must be used inside <UnreadCommentsProvider>");
  return ctx;
}
