"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { useCurrentUser } from "./useCurrentUser";
import {
  listNotifications,
  getWsTicket,
  markNotificationRead,
  markAllNotificationsRead,
  AppNotification,
} from "@/lib/notifications-api";

// Connexion directe au backend NestJS (le WebSocket n'est pas relayé par le
// proxy Next.js /api/backend). À définir dans .env.local si différent.
const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "http://localhost:3000";

/**
 * Ouvre une connexion WebSocket vers le namespace /notifications, authentifiée
 * via un ticket JWT court obtenu au préalable via l'API REST (proxiée, donc
 * compatible avec la session httpOnly). Reçoit les notifications en temps
 * réel et maintient un compteur de non-lues.
 */
export function useNotificationsSocket() {
  const { user } = useCurrentUser();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const socketRef = useRef<Socket | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listNotifications({ pageSize: 20 });
      setNotifications(data.items);
      setUnreadCount(data.unreadCount);
    } catch {
      // silencieux — le badge reste tel quel en cas d'échec réseau ponctuel
    }
  }, []);

  const markRead = useCallback(async (id: string) => {
    setNotifications(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)));
    setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await markNotificationRead(id);
    } catch {
      refresh(); // resync en cas d'échec
    }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
    try {
      await markAllNotificationsRead();
    } catch {
      refresh();
    }
  }, [refresh]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    (async () => {
      await refresh();

      try {
        const ticket = await getWsTicket();
        if (cancelled) return;

        const socket = io(`${BACKEND_WS_URL}/notifications`, {
          auth: { ticket },
          transports: ["websocket"],
        });

        socket.on("notification", (notif: AppNotification) => {
          setNotifications(prev => [notif, ...prev].slice(0, 20));
          setUnreadCount(prev => prev + 1);
        });

        socketRef.current = socket;
      } catch {
        // Pas de temps réel disponible — le badge reste basé sur `refresh()`
        // initial ; on retente au prochain montage / refresh manuel.
      }
    })();

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [user, refresh]);

  return { notifications, unreadCount, refresh, markRead, markAllRead };
}
