"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { useCurrentUser } from "./useCurrentUser";
import { getWsTicket } from "@/lib/notifications-api";
import { getProjectActivity, ProjectActivityEntry } from "@/lib/project-activity-api";

// Même namespace/connexion que useNotificationsSocket et useProjectRealtime
// (voir ces hooks) — le WebSocket n'est pas relayé par le proxy Next.js.
const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "http://localhost:3000";
const PAGE_SIZE = 30;

/**
 * Fil d'activité PARTAGÉ d'un projet — "Aujourd'hui sur ce projet" : charge
 * l'historique par pages (scroll infini via `loadMore`) et rejoint la room
 * `project:<id>` (namespace /notifications) pour recevoir les nouvelles
 * actions de toute l'équipe en direct (`activity:new`), à la différence de
 * la cloche de notifications qui est individuelle.
 *
 * Se connecte tant que ce hook est monté — à utiliser uniquement pendant que
 * le panneau est ouvert (voir ProjectActivityFeed.tsx) pour ne pas garder de
 * connexion inutile en arrière-plan.
 */
export function useProjectActivityFeed(projectId: string | null | undefined) {
  const { user } = useCurrentUser();
  const [items, setItems] = useState<ProjectActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pageRef = useRef(1);
  const socketRef = useRef<Socket | null>(null);

  const loadFirstPage = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getProjectActivity(projectId, { page: 1, pageSize: PAGE_SIZE });
      setItems(data.items);
      setHasMore(data.hasMore);
      pageRef.current = 1;
    } catch (err: any) {
      setError(err?.message || "Impossible de charger le fil d'activité");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadMore = useCallback(async () => {
    if (!projectId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = pageRef.current + 1;
      const data = await getProjectActivity(projectId, { page: nextPage, pageSize: PAGE_SIZE });
      setItems(prev => [...prev, ...data.items]);
      setHasMore(data.hasMore);
      pageRef.current = nextPage;
    } catch {
      // silencieux — l'utilisateur peut réessayer en re-scrollant en bas
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, loadingMore, hasMore]);

  useEffect(() => {
    if (!user || !projectId) {
      setItems([]);
      return;
    }

    loadFirstPage();

    let cancelled = false;
    let socket: Socket | null = null;

    (async () => {
      try {
        const ticket = await getWsTicket();
        if (cancelled) return;

        socket = io(`${BACKEND_WS_URL}/notifications`, {
          auth: { ticket },
          transports: ["websocket"],
        });

        socket.on("connect", () => {
          socket?.emit("project:join", { projectId });
        });

        socket.on("activity:new", (entry: ProjectActivityEntry) => {
          if (entry.project_id !== projectId) return;
          setItems(prev => (prev.some(e => e.id === entry.id) ? prev : [entry, ...prev]));
        });

        socketRef.current = socket;
      } catch {
        // Pas de temps réel disponible — le fil reste consultable via
        // loadFirstPage/loadMore, juste sans mise à jour live.
      }
    })();

    return () => {
      cancelled = true;
      socket?.emit("project:leave", { projectId });
      socket?.disconnect();
      socketRef.current = null;
    };
  }, [user, projectId, loadFirstPage]);

  return { items, loading, loadingMore, hasMore, error, loadMore, refresh: loadFirstPage };
}
