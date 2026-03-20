import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../stores/settingsStore';
import { useAiCompletionStore } from '../stores/aiCompletionStore';
import { logger } from '../utils/logger';

class AICompletionService {
  private static instance: AICompletionService;
  private cache = new Map<string, string>();
  private maxCacheSize = 50;
  private currentRequestId = 0;
  private lastErrorTime = 0;
  private errorCooldownMs = 10_000;
  private pendingStatus: 'idle' | 'loading' | 'error' | null = null;

  static getInstance(): AICompletionService {
    if (!this.instance) this.instance = new AICompletionService();
    return this.instance;
  }

  async getCompletion(prefix: string, suffix: string): Promise<string | null> {
    const { autocomplete } = useSettingsStore.getState();
    if (!autocomplete.enabled) return null;

    // Skip if Ollama recently failed — avoid hammering + misleading loading state
    if (Date.now() - this.lastErrorTime < this.errorCooldownMs) return null;

    const cacheKey = `${autocomplete.model}|${prefix.slice(-200)}|${suffix.slice(0, 100)}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      logger.debug('ai-completion', `cache hit (${this.cache.size} entries)`);
      return cached || null;
    }

    const requestId = ++this.currentRequestId;
    this.setStatus('loading');

    const startTime = performance.now();
    logger.info('ai-completion', `[req #${requestId}] ${autocomplete.model} | prefix: ${prefix.length} chars | suffix: ${suffix.length} chars`);

    try {
      const result = await invoke<string>('fim_completion', {
        ollamaUrl: autocomplete.ollamaUrl,
        model: autocomplete.model,
        prefix,
        suffix,
      });

      const elapsed = Math.round(performance.now() - startTime);

      if (requestId !== this.currentRequestId) {
        logger.info('ai-completion', `[req #${requestId}] discarded (stale) after ${elapsed}ms`);
        return null;
      }

      this.setStatus('idle');
      const trimmed = result?.trimEnd() || '';
      if (trimmed && trimmed.trim().length > 0) {
        logger.info('ai-completion', `[req #${requestId}] completed in ${elapsed}ms | ${trimmed.length} chars: "${trimmed.slice(0, 80).replace(/\n/g, '\\n')}${trimmed.length > 80 ? '...' : ''}"`);
        this.addToCache(cacheKey, trimmed);
        return trimmed;
      }
      logger.info('ai-completion', `[req #${requestId}] empty response in ${elapsed}ms`);
      return null;
    } catch (e) {
      const elapsed = Math.round(performance.now() - startTime);
      if (requestId !== this.currentRequestId) {
        logger.info('ai-completion', `[req #${requestId}] discarded (stale error) after ${elapsed}ms`);
        return null;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'cancelled' || msg.includes('cancelled')) {
        logger.info('ai-completion', `[req #${requestId}] cancelled after ${elapsed}ms`);
        return null;
      }
      this.lastErrorTime = Date.now();
      this.setStatus('error');
      logger.warn('ai-completion', `[req #${requestId}] failed after ${elapsed}ms:`, e);
      return null;
    }
  }

  cancel() {
    this.currentRequestId++;
    this.setStatus('idle');
  }

  resetCooldown() {
    this.lastErrorTime = 0;
  }

  clearCache() {
    this.cache.clear();
  }

  private setStatus(status: 'idle' | 'loading' | 'error') {
    // NEVER call Zustand set() from here — it causes re-renders that freeze Monaco in Tauri WebView.
    // Use setTimeout to fully decouple from Monaco's event loop.
    this.pendingStatus = status;
    setTimeout(() => {
      if (this.pendingStatus === status) {
        useAiCompletionStore.getState().setStatus(status);
        this.pendingStatus = null;
      }
    }, 50);
  }

  private addToCache(key: string, value: string) {
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}

export default AICompletionService;
