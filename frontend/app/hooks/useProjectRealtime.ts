"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { useCurrentUser } from "./useCurrentUser";
import { getWsTicket } from "@/lib/notifications-api";

const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "http://localhost:3000";

export type ProjectRealtimeEvent =
  | "project:renamed"
  | "project:deleted"
  // Campagne de tests (voir ProjectController.launchCampaign/closeCampaign
  // côté backend) — fige/dégèle tout le projet en direct pour tous les
  // utilisateurs présents sur la page.
  | "campaign:launched"
  | "campaign:closed"
  // Modification mise en standby pendant une campagne active (voir
  // ProjectService.queueIfCampaignActive côté backend) — utilisé par la page
  // /campaigns/:projectId pour rafraîchir le compteur de modifications en
  // attente en direct.
  | "campaign:change-queued"
  | "module:created"
  | "module:updated"
  | "module:deleted"
  | "requirement:created"
  | "requirement:updated"
  | "requirement:deleted"
  | "testcase:created"
  | "testcase:updated"
  | "testcase:deleted"
  | "generation:started"
  | "generation:completed"
  | "requirement:editing"
  | "testcase:editing"
  | "requirement:viewing"
  | "testcase:viewing"
  // Présence "quelqu'un a le formulaire + Nouveau TC ouvert" — voir
  // POST .../requirements/:id/adding-presence côté backend.
  | "requirement:adding"
  // Rejet d'un TC EN ATTENTE (jamais persisté en DB) — voir
  // POST .../test-cases/reject-pending côté backend.
  | "testcase:rejected"
  // Workflows de test (création, autosave/validation, suppression, avancée
  // d'une exécution) — voir WorkflowController.emitToProject côté backend.
  // Notamment : un BA qui valide un workflow doit apparaître instantanément
  // dans la galerie des autres utilisateurs (QA/ADMIN) sans recharger la page.
  | "workflow:created"
  | "workflow:updated"
  | "workflow:deleted"
  | "workflow:run-updated"
  // Présence "quelqu'un consulte/édite ce workflow" — même mécanique que
  // requirement:viewing/editing ci-dessus, voir POST
  // .../workflows/:id/viewing-presence et /editing-presence côté backend.
  | "workflow:viewing"
  | "workflow:editing"
  // Diffusion éphémère du graphe en cours d'édition (voir POST
  // .../workflows/:id/canvas-live côté backend) — pas de refetch, les
  // nodes/edges reçus sont appliqués directement pour un rendu "live".
  | "workflow:canvas-live"
  // Nouvelle entrée dans le fil d'activité du projet — voir
  // NotificationsService.notifyProjectActivity côté backend.
  | "activity:new";

export interface ProjectRealtimePayload {
  projectId: string;
  actorId?: string;
  actorName?: string;
  at?: string;
  [key: string]: unknown;
}

export type PresenceActivity = "idle" | "editing" | "generating";

export interface PresenceUser {
  userId: string;
  userName: string;
  activity?: PresenceActivity;
  activityLabel?: string;
}

/**
 * Rejoint la room temps réel `project:<projectId>` (même namespace /notifications
 * que useNotificationsSocket) pendant que la page du projet est ouverte.
 *
 * - Reçoit `project:presence` : liste des utilisateurs actuellement sur ce
 *   projet, avec leur activité (idle / editing / generating), pour afficher
 *   des avatars "qui travaille ici en ce moment" + un badge d'activité.
 * - Reçoit tous les événements de collaboration (création/modification/
 *   suppression de module/exigence/cas de test, génération démarrée/terminée)
 *   et les transmet à `onEvent`. Les événements dont on est soi-même l'auteur
 *   sont filtrés par défaut (on a déjà la donnée à jour localement).
 * - Expose `notifyActivity(activity, label?)` pour signaler aux autres
 *   qu'on est en train d'éditer ou de générer quelque chose (appeler
 *   `notifyActivity('idle')` pour repasser en inactif).
 */
export function useProjectRealtime(
  projectId: string | null | undefined,
  onEvent?: (event: ProjectRealtimeEvent, payload: ProjectRealtimePayload) => void,
) {
  const { user } = useCurrentUser();
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const socketRef = useRef<Socket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!user || !projectId) {
      setPresence([]);
      return;
    }

    let cancelled = false;
    let socket: Socket | null = null;

    const ALL_EVENTS: ProjectRealtimeEvent[] = [
      "project:renamed", "project:deleted",
      "campaign:launched", "campaign:closed", "campaign:change-queued",
      "module:created", "module:updated", "module:deleted",
      "requirement:created", "requirement:updated", "requirement:deleted",
      "testcase:created", "testcase:updated", "testcase:deleted",
      "generation:started", "generation:completed",
      "requirement:editing", "testcase:editing",
      "requirement:viewing", "testcase:viewing",
      "requirement:adding",
      "testcase:rejected",
      "workflow:created", "workflow:updated", "workflow:deleted", "workflow:run-updated",
      "workflow:viewing", "workflow:editing",
      "workflow:canvas-live",
    ];

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

        socket.on("connect_error", (err) => {
          // eslint-disable-next-line no-console
          console.error("[realtime] échec de connexion WebSocket:", err?.message || err);
        });

        socket.on("disconnect", (reason) => {
          // eslint-disable-next-line no-console
          console.warn("[realtime] déconnecté du WebSocket:", reason);
        });

        socket.on("project:presence", (data: { projectId: string; users: PresenceUser[] }) => {
          if (data.projectId === projectId) setPresence(data.users || []);
        });

        for (const event of ALL_EVENTS) {
          socket.on(event, (payload: ProjectRealtimePayload) => {
            // On ignore ses propres actions : on a déjà la donnée localement,
            // pas besoin de se re-notifier / se re-fetcher soi-même.
            if (payload?.actorId && payload.actorId === user.id) return;
            onEventRef.current?.(event, payload);
          });
        }

        // 'activity:new' (fil d'activité partagé) est diffusé à TOUT le monde
        // SANS filtrage par auteur, contrairement à ALL_EVENTS ci-dessus :
        // la bannière temps réel affiche ce message tel quel (voir
        // handleProjectRealtimeEvent côté page.tsx), donc l'auteur de
        // l'action doit lui aussi le recevoir pour un retour immédiat sans
        // recharger la page — sinon la bannière et le fil d'activité
        // divergeraient à nouveau pour ses propres actions.
        socket.on("activity:new", (payload: ProjectRealtimePayload) => {
          onEventRef.current?.("activity:new", payload);
        });

        socketRef.current = socket;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[realtime] impossible d'obtenir le ticket WebSocket:", err);
        // Pas de temps réel disponible pour cette session — l'UI reste
        // fonctionnelle, juste sans mise à jour live entre utilisateurs.
      }
    })();

    return () => {
      cancelled = true;
      socket?.emit("project:leave", { projectId });
      socket?.disconnect();
      socketRef.current = null;
      setPresence([]);
    };
  }, [user, projectId]);

  /** Signale son activité actuelle (idle / editing / generating) aux autres utilisateurs du projet. */
  const notifyActivity = useCallback((activity: PresenceActivity, label?: string) => {
    if (!projectId) return;
    socketRef.current?.emit("project:activity", { projectId, activity, label });
  }, [projectId]);

  return { presence, notifyActivity };
}