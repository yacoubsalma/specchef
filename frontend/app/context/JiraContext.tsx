'use client';

import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import {
  getJiraStatus,
  connectJira,
  disconnectJira,
  listJiraProjects,
  JiraConnectionStatus,
  JiraProjectOption,
} from '@/lib/jira-api';

interface JiraContextValue {
  status: JiraConnectionStatus | null;
  statusLoaded: boolean;
  projects: JiraProjectOption[];
  projectsLoaded: boolean;
  projectsError: string | null;
  refreshStatus: () => Promise<void>;
  connect: (payload: { jiraBaseUrl: string; jiraEmail: string; apiToken: string }) => Promise<void>;
  disconnect: () => Promise<void>;
  ensureProjectsLoaded: () => Promise<void>;
}

const JiraContext = createContext<JiraContextValue | null>(null);

export function JiraProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<JiraConnectionStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [projects, setProjects] = useState<JiraProjectOption[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getJiraStatus();
      setStatus(s);
    } catch {
      setStatus({ connected: false });
    } finally {
      setStatusLoaded(true);
    }
  }, []);

  const connect = useCallback(async (payload: { jiraBaseUrl: string; jiraEmail: string; apiToken: string }) => {
    const s = await connectJira(payload);
    setStatus(s);
    // le compte vient de changer → la liste des projets doit être rechargée
    setProjectsLoaded(false);
    setProjects([]);
  }, []);

  const disconnect = useCallback(async () => {
    await disconnectJira();
    setStatus({ connected: false });
    setProjects([]);
    setProjectsLoaded(false);
  }, []);

  const ensureProjectsLoaded = useCallback(async () => {
    if (projectsLoaded) return;
    setProjectsError(null);
    try {
      const list = await listJiraProjects();
      setProjects(list);
      setProjectsLoaded(true);
    } catch (e: any) {
      setProjectsError(e.message || 'Impossible de charger les projets Jira');
    }
  }, [projectsLoaded]);

  return (
    <JiraContext.Provider
      value={{ status, statusLoaded, projects, projectsLoaded, projectsError, refreshStatus, connect, disconnect, ensureProjectsLoaded }}
    >
      {children}
    </JiraContext.Provider>
  );
}

export function useJira() {
  const ctx = useContext(JiraContext);
  if (!ctx) throw new Error('useJira doit être utilisé à l\'intérieur de <JiraProvider>');
  return ctx;
}
