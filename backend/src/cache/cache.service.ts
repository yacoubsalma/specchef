import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';

const TTL = {
  ANALYSIS: 60 * 60 * 24 * 7,
  STEP2:    60 * 60 * 24 * 3,
};

type Stored = { value: string; expiresAt?: number };

@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly store = new Map<string, Stored>();

  constructor() {}

  async onModuleInit(): Promise<void> {
    this.logger.log('CacheService: using in-memory cache (Redis removed)');
  }

  async onModuleDestroy(): Promise<void> {
    this.store.clear();
  }

  hashText(text: string): string {
    return crypto.createHash('sha256').update(text ?? '').digest('hex').slice(0, 32);
  }

  hashRequirements(requirements: any): string {
    const stable = JSON.stringify(requirements, Object.keys(requirements).sort());
    return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 32);
  }

  async hashFile(filePath: string): Promise<string> {
    const fs = await import('fs');
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  }

  isAvailable(): boolean { return true; }

  async getAnalysis(hash: string): Promise<any | null> { return this._get(`analysis:${hash}`); }
  async setAnalysis(hash: string, data: any): Promise<void> { await this._set(`analysis:${hash}`, data, TTL.ANALYSIS); }


  async getStep2(hash: string, model: string): Promise<any | null> { return this._get(`step2:${hash}:${model}`); }
  async setStep2(hash: string, model: string, data: any): Promise<void> { await this._set(`step2:${hash}:${model}`, data, TTL.STEP2); }

  async stats(): Promise<{ keys: number; memory_human: string; connected: boolean }> {
    return { keys: this.store.size, memory_human: 'N/A', connected: true };
  }

  async flushAll(): Promise<void> {
    this.store.clear();
  }

  private async _get(key: string): Promise<any | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    this.logger.log(`🎯 Cache HIT — ${key}`);
    try { return JSON.parse(item.value); } catch { return null; }
  }

  private async _set(key: string, data: any, ttl: number): Promise<void> {
    const expiresAt = ttl ? Date.now() + ttl * 1000 : undefined;
    try {
      this.store.set(key, { value: JSON.stringify(data), expiresAt });
      this.logger.log(`💾 Cache SET — ${key}`);
    } catch { /* ignore */ }
  }

  async invalidateByPrefix(prefix: string): Promise<number> {
    const keys = Array.from(this.store.keys()).filter(k => k.startsWith(prefix));
    for (const k of keys) this.store.delete(k);
    if (keys.length > 0) this.logger.log(`🗑️  Cache invalidated: ${keys.length} key(s) with prefix "${prefix}"`);
    return keys.length;
  }
}