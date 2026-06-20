import { invoke } from '@/utils/invokeMetrics';
import { useSettingsStore } from '../stores/settingsStore';
import { useAiCompletionStore } from '../stores/aiCompletionStore';
import { resolveAIWorkerUrl } from '../utils/devUrls';
import { logger } from '../utils/logger';

// Histórico (2026-06-12): este serviço chamava a DashScope BEIJING
// diretamente do cliente com uma key VITE_ que, se definida, embarcava no
// bundle distribuído — leak por design, sem billing nem gate (desenho
// anterior à arquitetura de dois workers). Como a env var nunca foi
// definida em produção, o caminho cloud estava simplesmente MORTO e o
// autocomplete só funcionava para quem tem Ollama local. Agora: o FIM passa
// pelo data-plane com X-Request-Type: 'fim' → sidecar barato publicado no
// KV; a key vive só no worker e o consumo entra no billing normal.

class AICompletionService {
  private static instance: AICompletionService;
  private cache = new Map<string, string>();
  private maxCacheSize = 50;
  private currentRequestId = 0;
  private lastErrorTime = 0;
  private errorCooldownMs = 10_000;
  private pendingStatus: 'idle' | 'loading' | 'error' | null = null;
  private abortController: AbortController | null = null;
  /** Desliga o caminho cloud na sessão quando o worker responde SEM o
   *  sidecar:fim — completar a cada tecla no modelo flagship ativo seria
   *  queimar tokens caros; sem sidecar, só o fallback Ollama local serve. */
  private cloudFimUnavailable = false;

  static getInstance(): AICompletionService {
    if (!this.instance) this.instance = new AICompletionService();
    return this.instance;
  }

  async getCompletion(prefix: string, suffix: string): Promise<string | null> {
    const { autocomplete } = useSettingsStore.getState();
    if (!autocomplete.enabled) return null;

    // FIM is a TM sidecar. On free + BYOK everything is self-funded and the
    // user's key may not offer FIM, so it's disabled (Phase 2 policy). Paid +
    // BYOK and non-BYOK keep the worker sidecar.
    const { resolveAuxByokRoute } = await import('./agent/byokRouting');
    if (resolveAuxByokRoute()) return null;

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
      const result = !this.cloudFimUnavailable
        ? await this.cloudFimCompletion(prefix, suffix)
        : await invoke<string>('fim_completion', {
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
      if (msg === 'cancelled' || msg.includes('cancelled') || msg.includes('aborted')) {
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
    this.abortController?.abort();
    this.abortController = null;
    this.setStatus('idle');
  }

  /** FIM completion via data-plane (sidecar:fim publicado no KV). */
  private async cloudFimCompletion(prefix: string, suffix: string): Promise<string> {
    this.abortController?.abort()
    this.abortController = new AbortController()

    const { default: FirebaseAuthService } = await import('./auth/firebaseAuth')
    const token = await FirebaseAuthService.getInstance().getIdToken()
    if (!token) throw new Error('FIM: not authenticated')

    const res = await fetch(`${resolveAIWorkerUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Request-Type': 'fim',
      },
      body: JSON.stringify({
        model: 'tm-active-model', // substituído pelo worker (sidecar:fim)
        messages: [{
          role: 'user',
          content: `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
        }],
        stream: false,
        temperature: 0.01,
        max_tokens: 128,
        stop: ['\n\n\n', '<|fim_pad|>', '<|endoftext|>'],
      }),
      signal: this.abortController.signal,
    })

    if (!res.ok) {
      throw new Error(`FIM ${res.status}`)
    }

    // Sem sidecar publicado, o pedido foi servido pelo modelo ATIVO —
    // flagship caro a cada tecla. Desliga o caminho cloud para a sessão e
    // descarta este resultado; o fallback Ollama assume (se existir).
    if (res.headers.get('x-tm-config-key') !== 'sidecar:fim') {
      this.cloudFimUnavailable = true
      logger.info('ai-completion', 'cloud FIM disabled: no sidecar:fim published (active model would be billed per keystroke)')
      return ''
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content || ''
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
