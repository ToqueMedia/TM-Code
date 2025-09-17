interface PerformanceMetric {
  timestamp: number
  value: number
  type: string
  metadata?: Record<string, any>
}

interface MemoryInfo {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

interface RenderMetric {
  componentName: string
  renderTime: number
  propsChanges: number
  reRenderReason?: string
}

interface FileOperationMetric {
  operation: 'read' | 'write' | 'delete' | 'rename' | 'copy'
  filePath: string
  fileSize: number
  duration: number
  success: boolean
  error?: string
}

interface WebVitalsMetric {
  name: 'FCP' | 'LCP' | 'FID' | 'CLS' | 'TTFB' | 'INP'
  value: number
  rating: 'good' | 'needs-improvement' | 'poor'
}

export interface PerformanceSnapshot {
  timestamp: number
  memory: MemoryInfo | null
  fps: number
  renderMetrics: RenderMetric[]
  fileOperations: FileOperationMetric[]
  webVitals: WebVitalsMetric[]
  customMetrics: PerformanceMetric[]
  errors: Array<{
    message: string
    stack?: string
    timestamp: number
  }>
}

class PerformanceMonitor {
  private static instance: PerformanceMonitor | null = null
  private isMonitoring = false
  private metrics: PerformanceMetric[] = []
  private snapshots: PerformanceSnapshot[] = []
  private maxSnapshots = 100
  private maxMetrics = 1000
  private snapshotInterval = 5000 // 5 segundos
  private intervalId: NodeJS.Timeout | null = null
  private observers: PerformanceObserver[] = []
  private callbacks: Array<(snapshot: PerformanceSnapshot) => void> = []
  
  private constructor() {
    this.setupPerformanceObservers()
    this.setupErrorHandling()
  }

  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor()
    }
    return PerformanceMonitor.instance
  }

  // Inicia o monitoramento
  startMonitoring(): void {
    if (this.isMonitoring) return
    
    this.isMonitoring = true
    this.intervalId = setInterval(() => {
      this.captureSnapshot()
    }, this.snapshotInterval)
    
    console.log('🎯 Performance monitoring started')
  }

  // Para o monitoramento
  stopMonitoring(): void {
    if (!this.isMonitoring) return
    
    this.isMonitoring = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    
    this.observers.forEach(observer => {
      try {
        observer.disconnect()
      } catch (error) {
        console.warn('Failed to disconnect performance observer:', error)
      }
    })
    this.observers = []
    
    console.log('🎯 Performance monitoring stopped')
  }

  // Registra callback para receber snapshots
  onSnapshot(callback: (snapshot: PerformanceSnapshot) => void): () => void {
    this.callbacks.push(callback)
    return () => {
      const index = this.callbacks.indexOf(callback)
      if (index > -1) {
        this.callbacks.splice(index, 1)
      }
    }
  }

  // Adiciona métrica customizada
  addMetric(type: string, value: number, metadata?: Record<string, any>): void {
    const metric: PerformanceMetric = {
      timestamp: performance.now(),
      value,
      type,
      metadata
    }
    
    this.metrics.push(metric)
    
    // Limita o número de métricas armazenadas
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics)
    }
  }

  // Mede duração de operação
  async measureOperation<T>(
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    const startTime = performance.now()
    const startMark = `${operation}-start`
    const endMark = `${operation}-end`
    
    performance.mark(startMark)
    
    try {
      const result = await fn()
      
      performance.mark(endMark)
      performance.measure(operation, startMark, endMark)
      
      const duration = performance.now() - startTime
      this.addMetric(`operation:${operation}`, duration, {
        success: true,
        ...metadata
      })
      
      return result
    } catch (error) {
      performance.mark(endMark)
      performance.measure(operation, startMark, endMark)
      
      const duration = performance.now() - startTime
      this.addMetric(`operation:${operation}`, duration, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        ...metadata
      })
      
      throw error
    }
  }

  // Obtém métricas atuais
  getCurrentMetrics(): PerformanceMetric[] {
    return [...this.metrics]
  }

  // Obtém snapshots históricos
  getSnapshots(): PerformanceSnapshot[] {
    return [...this.snapshots]
  }

  // Obtém último snapshot
  getLatestSnapshot(): PerformanceSnapshot | null {
    return this.snapshots[this.snapshots.length - 1] || null
  }

  // Exporta dados para análise
  exportData(): {
    snapshots: PerformanceSnapshot[]
    metrics: PerformanceMetric[]
    summary: {
      monitoringDuration: number
      totalSnapshots: number
      totalMetrics: number
      averageMemoryUsage: number
      averageFPS: number
    }
  } {
    const totalMemory = this.snapshots.reduce((sum, s) => sum + (s.memory?.usedJSHeapSize || 0), 0)
    const totalFPS = this.snapshots.reduce((sum, s) => sum + s.fps, 0)
    const snapshotCount = this.snapshots.length || 1
    
    return {
      snapshots: this.snapshots,
      metrics: this.metrics,
      summary: {
        monitoringDuration: this.snapshots.length > 0 ? 
          (this.snapshots[this.snapshots.length - 1].timestamp - this.snapshots[0].timestamp) : 0,
        totalSnapshots: this.snapshots.length,
        totalMetrics: this.metrics.length,
        averageMemoryUsage: totalMemory / snapshotCount,
        averageFPS: totalFPS / snapshotCount
      }
    }
  }

  // Limpa dados históricos
  clearData(): void {
    this.metrics = []
    this.snapshots = []
    console.log('🎯 Performance data cleared')
  }

  private setupPerformanceObservers(): void {
    if (typeof window === 'undefined' || !('PerformanceObserver' in window)) return

    try {
      // Observer para Navigation Timing
      if (PerformanceObserver.supportedEntryTypes.includes('navigation')) {
        const navObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const navEntry = entry as PerformanceNavigationTiming
            this.addMetric('navigation:domContentLoaded', navEntry.domContentLoadedEventEnd - navEntry.domContentLoadedEventStart)
            this.addMetric('navigation:loadComplete', navEntry.loadEventEnd - navEntry.loadEventStart)
          }
        })
        navObserver.observe({ entryTypes: ['navigation'] })
        this.observers.push(navObserver)
      }

      // Observer para Resource Timing
      if (PerformanceObserver.supportedEntryTypes.includes('resource')) {
        const resourceObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const resourceEntry = entry as PerformanceResourceTiming
            this.addMetric(`resource:${resourceEntry.initiatorType}`, resourceEntry.duration, {
              name: resourceEntry.name,
              size: resourceEntry.transferSize
            })
          }
        })
        resourceObserver.observe({ entryTypes: ['resource'] })
        this.observers.push(resourceObserver)
      }

      // Observer para Measure
      if (PerformanceObserver.supportedEntryTypes.includes('measure')) {
        const measureObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.addMetric(`measure:${entry.name}`, entry.duration)
          }
        })
        measureObserver.observe({ entryTypes: ['measure'] })
        this.observers.push(measureObserver)
      }

      // Observer para Long Tasks (se suportado)
      if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        const longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.addMetric('longtask:duration', entry.duration, {
              startTime: entry.startTime
            })
          }
        })
        longTaskObserver.observe({ entryTypes: ['longtask'] })
        this.observers.push(longTaskObserver)
      }
    } catch (error) {
      console.warn('Failed to setup performance observers:', error)
    }
  }

  private setupErrorHandling(): void {
    if (typeof window === 'undefined') return

    // Global error handler
    window.addEventListener('error', (event) => {
      this.addMetric('error:javascript', 1, {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      })
    })

    // Unhandled promise rejection handler
    window.addEventListener('unhandledrejection', (event) => {
      this.addMetric('error:unhandledPromise', 1, {
        reason: event.reason?.toString() || 'Unknown reason'
      })
    })
  }

  private captureSnapshot(): void {
    const snapshot: PerformanceSnapshot = {
      timestamp: Date.now(),
      memory: this.getMemoryInfo(),
      fps: this.calculateFPS(),
      renderMetrics: this.collectRenderMetrics(),
      fileOperations: this.collectFileOperations(),
      webVitals: this.collectWebVitals(),
      customMetrics: this.metrics.slice(-50), // Últimas 50 métricas
      errors: this.collectErrors()
    }

    this.snapshots.push(snapshot)
    
    // Limita o número de snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.maxSnapshots)
    }
    
    // Notifica callbacks
    this.callbacks.forEach(callback => {
      try {
        callback(snapshot)
      } catch (error) {
        console.error('Performance monitor callback error:', error)
      }
    })
  }

  private getMemoryInfo(): MemoryInfo | null {
    if (typeof window !== 'undefined' && 'performance' in window && 'memory' in performance) {
      const memory = (performance as any).memory
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit
      }
    }
    return null
  }

  private calculateFPS(): number {
    // Implementação simplificada - em produção use requestAnimationFrame
    return 60 // Placeholder - implementar medição real de FPS
  }

  private collectRenderMetrics(): RenderMetric[] {
    // Placeholder - integrar com React DevTools ou usar react-render-tracker
    return []
  }

  private collectFileOperations(): FileOperationMetric[] {
    // Placeholder - coletar métricas de operações de arquivo
    return []
  }

  private collectWebVitals(): WebVitalsMetric[] {
    const vitals: WebVitalsMetric[] = []
    
    // Usar web-vitals library se disponível
    if (typeof window !== 'undefined' && 'performance' in window) {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
      if (navigation) {
        const fcp = navigation.domContentLoadedEventStart - navigation.fetchStart
        vitals.push({
          name: 'FCP',
          value: fcp,
          rating: fcp < 1800 ? 'good' : fcp < 3000 ? 'needs-improvement' : 'poor'
        })
      }
    }
    
    return vitals
  }

  private collectErrors(): Array<{ message: string; stack?: string; timestamp: number }> {
    // Retornar erros recentes coletados pelo error handler
    const recentErrors = this.metrics
      .filter(m => m.type.startsWith('error:'))
      .slice(-10)
      .map(m => ({
        message: m.metadata?.message || 'Unknown error',
        stack: m.metadata?.stack,
        timestamp: m.timestamp
      }))
    
    return recentErrors
  }
}

export default PerformanceMonitor