'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export type ProjectStatus = 'processing' | 'done' | 'error';

export interface ProjectStatusResponse {
  projectId: string;
  status: ProjectStatus;
  modules?: Array<{
    name: string;
    description: string;
    requirements: Array<{
      id: string;
      _uuid: string;
      description: string;
      priority: string;
      test_cases: any[];
    }>;
  }>;
  error_message?: string;
  extraction_duration_ms?: number;
}

interface UseProjectPollingOptions {
  projectId?: string;
  initialDelay?: number; // Délai avant le premier polling (ms)
  pollingInterval?: number; // Intervalle de polling (ms)
  maxRetries?: number; // Nombre max de tentatives (-1 pour illimité)
  onStatusChange?: (status: ProjectStatus) => void;
  onComplete?: (data: ProjectStatusResponse) => void;
  onError?: (error: string) => void;
}

/**
 * Hook pour interroger l'état du projet en arrière-plan
 * 
 * Usage:
 * const { status, data, error, stop } = useProjectPolling({
 *   projectId: 'xyz123',
 *   pollingInterval: 2000, // Interroger toutes les 2s
 *   onComplete: (data) => console.log('Done!', data),
 * });
 */
export function useProjectPolling({
  projectId,
  initialDelay = 500,
  pollingInterval = 2000,
  maxRetries = 60, // 2 minutos (60 * 2s)
  onStatusChange,
  onComplete,
  onError,
}: UseProjectPollingOptions) {
  const [status, setStatus] = useState<ProjectStatus>('processing');
  const [data, setData] = useState<ProjectStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const retryCountRef = useRef(0);
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const stop = useCallback(() => {
    setIsPolling(false);
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    // Vérifier que projectId est valide
    if (!projectId || projectId === 'null' || projectId === '') {
      return;
    }

    try {
      const response = await fetch(
        `/api/backend/documents/status/${projectId}`
      );

      if (response.status === 401) {
        onError?.('Session expirée — veuillez vous reconnecter.');
        stop();
        return;
      }

      if (!response.ok) {
        throw new Error(`Erreur HTTP: ${response.status}`);
      }

      const result = await response.json();

      const newStatus = result.status as ProjectStatus;
      setStatus(newStatus);
      setData(result);
      setError(null);
      retryCountRef.current = 0;

      onStatusChange?.(newStatus);

      if (newStatus === 'done') {
        onComplete?.(result);
        stop();
      } else if (newStatus === 'error') {
        onError?.(result.error_message || 'Erreur inconnue');
        stop();
      }
    } catch (err: any) {
      const errorMsg = err.message || 'Erreur de connexion';
      setError(errorMsg);
      onError?.(errorMsg);

      retryCountRef.current++;
      if (maxRetries > 0 && retryCountRef.current >= maxRetries) {
        stop();
      }
    }
  }, [projectId, maxRetries, onStatusChange, onComplete, onError, stop]);

  // Démarrage du polling quand projectId devient valide
  useEffect(() => {
    if (!projectId || projectId === 'null' || projectId === '') {
      stop();
      return;
    }

    // Démarrer le polling
    setIsPolling(true);
    retryCountRef.current = 0;

    // Premier appel après le délai initial
    pollingTimeoutRef.current = setTimeout(() => {
      fetchStatus();
    }, initialDelay);

    return () => {
      if (pollingTimeoutRef.current) {
        clearTimeout(pollingTimeoutRef.current);
      }
    };
  }, [projectId, initialDelay, fetchStatus]);

  // Polling régulier
  useEffect(() => {
    if (!isPolling || status === 'done' || status === 'error') {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    // Polling régulier
    intervalRef.current = setInterval(() => {
      fetchStatus();
    }, pollingInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isPolling, status, pollingInterval, fetchStatus]);

  return {
    status,
    data,
    error,
    isPolling,
    stop,
    retry: fetchStatus,
  };
}