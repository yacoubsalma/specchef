"use client";

import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from "react";
import type { CommentEntityType } from "@/lib/comments-api";

export interface CommentsDrawerTarget {
  projectId: string;
  entityType: CommentEntityType;
  entityId: string;
  /** Titre affiché en tête du drawer (ex: "FR-01", "TC-03"). */
  title?: string;
}

interface CommentsDrawerContextValue {
  target: CommentsDrawerTarget | null;
  open: (target: CommentsDrawerTarget) => void;
  close: () => void;
}

const CommentsDrawerContext = createContext<CommentsDrawerContextValue | null>(null);

export function CommentsDrawerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<CommentsDrawerTarget | null>(null);

  const open = useCallback((t: CommentsDrawerTarget) => setTarget(t), []);
  const close = useCallback(() => setTarget(null), []);

  const value = useMemo(() => ({ target, open, close }), [target, open, close]);

  return (
    <CommentsDrawerContext.Provider value={value}>
      {children}
    </CommentsDrawerContext.Provider>
  );
}

export function useCommentsDrawer() {
  const ctx = useContext(CommentsDrawerContext);
  if (!ctx) throw new Error("useCommentsDrawer must be used inside <CommentsDrawerProvider>");
  return ctx;
}
