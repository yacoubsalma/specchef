"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useNotificationsSocket } from "../hooks/useNotificationsSocket";
import type { AppNotification } from "@/lib/notifications-api";

const TYPE_ICON: Record<string, string> = {
  mention: "💬",
  comment_reply: "↩️",
  comment_resolved: "✅",
  comment_reopened: "🔁",
  comment_reminder: "🔔",
  project_activity: "🗂️",
  module_activity: "📁",
  requirement_activity: "📄",
  testcase_activity: "🧪",
  generation_activity: "🤖",
  export_activity: "📤",
  account_deletion_request: "🗑️",
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

export default function NotificationBell() {
  const { notifications, unreadCount, markRead, markAllRead } = useNotificationsSocket();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const handleClick = async (n: AppNotification) => {
    if (!n.read) await markRead(n.id);
    setOpen(false);
    if (n.link) router.push(n.link);
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Notifications"
        style={{
          position: "relative", background: "transparent", border: "none",
          cursor: "pointer", fontSize: 20, padding: 6, lineHeight: 1,
        }}
      >
        🔔
        {unreadCount > 0 && (
          <span style={{
            position: "absolute", top: 0, right: 0, background: "#ef4444", color: "#fff",
            borderRadius: "999px", fontSize: 10, fontWeight: 800, minWidth: 16, height: 16,
            display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px",
          }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 8px)", width: 340,
          background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 1000, overflow: "hidden",
        }}>
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "10px 14px", borderBottom: "1px solid #f1f5f9",
          }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={() => markAllRead()}
                style={{ background: "none", border: "none", color: "#2563eb", fontSize: 12, cursor: "pointer", fontWeight: 700 }}
              >
                Tout marquer lu
              </button>
            )}
          </div>

          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {notifications.length === 0 ? (
              <div style={{ padding: "28px 14px", textAlign: "center", color: "#94a3b8", fontSize: 13 }}>
                Aucune notification
              </div>
            ) : (
              notifications.map(n => (
                <div
                  key={n.id}
                  onClick={() => handleClick(n)}
                  style={{
                    display: "flex", gap: 10, padding: "10px 14px", cursor: "pointer",
                    background: n.read ? "transparent" : "#eff6ff",
                    borderBottom: "1px solid #f8fafc",
                  }}
                >
                  <div style={{ fontSize: 16 }}>{TYPE_ICON[n.type] ?? "🔔"}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "#1e293b", lineHeight: 1.4 }}>{n.message}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{timeAgo(n.created_at)}</div>
                  </div>
                  {!n.read && (
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#2563eb", marginTop: 4, flexShrink: 0 }} />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
