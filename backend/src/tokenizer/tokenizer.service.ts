import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

// ─── TokenizerService ─────────────────────────────────────────────────────────
//
// Démarre automatiquement `tokenizer-server.py` quand NestJS boot,
// et le tue proprement quand NestJS s'arrête.
//
// Cycle de vie :
//   NestJS bootstrap  →  onApplicationBootstrap()  →  spawnPython()  →  waitReady()
//   NestJS shutdown   →  onApplicationShutdown()   →  process.kill()
//
// Le script Python est cherché dans :
//   1. TOKENIZER_PATH (env var) — pour Docker / CI
//   2. <backend_root>/tokenizer-server.py — convention projet
//
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class TokenizerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TokenizerService.name);

  private process: ChildProcess | null = null;
  private ready     = false;   // true dès que le serveur répond sur /health
  private starting  = false;   // garde pour éviter double-spawn

  readonly port = 5001;
  readonly baseUrl = `http://localhost:${this.port}`;

  // ── Lifecycle hooks ────────────────────────────────────────────────────────

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** true si le serveur Python est up et prêt */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Compte les tokens via le serveur Python.
   * Si le serveur est down → fallback estimation (length / 4).
   */
  async countTokens(text: string): Promise<{ count: number; estimated: boolean }> {
    if (!this.ready) {
      const count = Math.ceil(text.length / 4);
      this.logger.warn(
        `🔢 [tokenize] ESTIMATION (serveur non prêt) — ${text.length} chars → ~${count} tok`
      );
      return { count, estimated: true };
    }

    const t0 = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/tokenize`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text }),
        signal:  AbortSignal.timeout(5_000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as { count: number };
      this.logger.log(
        `🔢 [tokenize] ${data.count} tok — ${text.length} chars — ${Date.now() - t0}ms`
      );
      return { count: data.count, estimated: false };

    } catch (err: any) {
      const count = Math.ceil(text.length / 4);
      const msg   = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `🔢 [tokenize] ESTIMATION (erreur: ${msg}) — ${text.length} chars → ~${count} tok`
      );
      return { count, estimated: true };
    }
  }

  // ── Private : spawn ────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    if (this.starting || this.ready) return;
    this.starting = true;

    // Résolution du chemin vers tokenizer-server.py
    const scriptPath =
      process.env.TOKENIZER_PATH ??
      path.resolve(process.cwd(), 'tokenizer-server.py');

    this.logger.log(`[TokenizerService] Démarrage de ${scriptPath}…`);

    try {
      this.process = spawn('python3', [scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Détaché = false → le process Python meurt si NestJS crashe brutalement
        detached: false,
      });

      // ── Logs Python → Logger NestJS ────────────────────────────────────────
      this.process.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.logger.debug(`[Python] ${line}`);
        }
      });

      this.process.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          // Le chargement HuggingFace écrit sur stderr — pas une vraie erreur
          if (line.includes('Loading') || line.includes('Downloading') || line.includes('tokenizer')) {
            this.logger.debug(`[Python/stderr] ${line}`);
          } else {
            this.logger.warn(`[Python/stderr] ${line}`);
          }
        }
      });

      this.process.on('error', (err) => {
        this.logger.error(`[TokenizerService] Impossible de lancer Python : ${err.message}`);
        this.logger.warn('[TokenizerService] Token count en mode estimation (length/4)');
        this.ready    = false;
        this.starting = false;
      });

      this.process.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          this.logger.warn(`[TokenizerService] Python s'est arrêté (code=${code}, signal=${signal})`);
        }
        this.ready   = false;
        this.process = null;
      });

      // ── Attendre que le serveur soit prêt (max 60s) ────────────────────────
      await this.waitReady(60_000);

    } catch (err: any) {
      this.logger.error(`[TokenizerService] Erreur au démarrage : ${err.message}`);
      this.ready    = false;
    } finally {
      this.starting = false;
    }
  }

  private stop(): void {
    if (!this.process) return;
    this.logger.log('[TokenizerService] Arrêt du serveur Python tokenizer…');
    this.ready = false;
    try {
      this.process.kill('SIGTERM');
      // Forcer SIGKILL après 3s si SIGTERM pas suffisant
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3_000);
    } catch { /* process déjà mort */ }
    this.process = null;
  }

  /**
   * Poll /health toutes les 500ms jusqu'à ce que le serveur réponde.
   * Timeout = maxMs millisecondes.
   */
  private async waitReady(maxMs: number): Promise<void> {
    const start    = Date.now();
    const interval = 500;

    while (Date.now() - start < maxMs) {
      try {
        const res = await fetch(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (res.ok) {
          const info = await res.json() as { model: string };
          this.ready = true;
          this.logger.log(
            `[TokenizerService] ✓ Prêt — modèle: ${info.model} (${Date.now() - start}ms)`
          );
          return;
        }
      } catch {
        // Pas encore prêt — on ré-essaye
      }

      await new Promise(r => setTimeout(r, interval));
    }

    // Timeout dépassé — mode dégradé
    this.logger.warn(
      `[TokenizerService] Timeout ${maxMs}ms dépassé — token count en mode estimation`
    );
  }
}