import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

export type JobStatus = 'pending' | 'running' | 'done' | 'error';

export interface Job<T = any> {
  id: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  result?: T;
  error?: string;
}

/**
 * Store en mémoire (process-local) pour les jobs de génération LLM longue durée.
 *
 * Objectif : permettre au front de démarrer une génération (POST .../start),
 * recevoir un jobId IMMÉDIATEMENT, puis poller le statut (GET .../job/:id)
 * au lieu de garder une requête HTTP synchrone ouverte pendant potentiellement
 * 30+ minutes (fragile : timeout du proxy Next.js, d'un reverse-proxy en prod,
 * du navigateur, etc. — voir historique du 06/07/2026).
 *
 * ⚠️ Volontairement simple : pas de persistance, pas de queue distribuée.
 * Suffisant pour une instance unique de backend. Si un jour le backend
 * tourne en plusieurs instances (scaling horizontal) ou redémarre pendant
 * qu'un job tourne, il faudra migrer vers une queue persistante (BullMQ +
 * Redis, ou une collection Mongo dédiée) — le contrat d'API (jobId / status)
 * resterait le même côté front.
 */
@Injectable()
export class JobStoreService {
  private readonly logger = new Logger(JobStoreService.name);
  private readonly jobs = new Map<string, Job>();

  // Nettoyage des jobs terminés depuis trop longtemps, pour éviter une fuite
  // mémoire si le front ne vient jamais chercher le résultat.
  private readonly JOB_TTL_MS = 60 * 60 * 1000; // 1h

  create(): Job {
    const job: Job = {
      id: randomUUID(),
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.sweep();
    return job;
  }

  markRunning(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'running';
    job.updatedAt = Date.now();
  }

  markDone(jobId: string, result: any) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'done';
    job.result = result;
    job.updatedAt = Date.now();
  }

  markError(jobId: string, error: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = 'error';
    job.error = error;
    job.updatedAt = Date.now();
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /** Lance `fn` en tâche de fond et met à jour le job au fil de l'exécution.
   *  Retourne la promesse sous-jacente (résolue avec le résultat, ou rejetée)
   *  pour permettre aux appelants de réagir à la fin du job — ex: diffusion
   *  temps réel côté LlmController — en plus du polling classique. */
  run(jobId: string, fn: () => Promise<any>): Promise<any> {
    this.markRunning(jobId);
    return fn()
      .then((result) => { this.markDone(jobId, result); return result; })
      .catch((err) => {
        this.logger.error(`Job ${jobId} failed: ${err?.message}`, err?.stack);
        this.markError(jobId, err?.message || 'Erreur inconnue');
        throw err;
      });
  }

  private sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if ((job.status === 'done' || job.status === 'error') && now - job.updatedAt > this.JOB_TTL_MS) {
        this.jobs.delete(id);
      }
    }
  }
}