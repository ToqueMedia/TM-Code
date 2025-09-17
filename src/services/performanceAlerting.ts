import PerformanceMonitor, { PerformanceSnapshot } from './performanceMonitor'
import PerformanceProfiler from '../utils/performanceProfiler'

export interface PerformanceThreshold {
  name: string
  metric: 'memory' | 'fps' | 'render_time' | 'operation_time' | 'error_rate'
  operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte'
  value: number
  severity: 'low' | 'medium' | 'high' | 'critical'
  enabled: boolean
  cooldown: number // ms para evitar spam de alertas
}

export interface PerformanceAlert {
  id: string
  timestamp: number
  threshold: PerformanceThreshold
  actualValue: number
  message: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  metadata?: Record<string, any>
  acknowledged: boolean
  resolved: boolean
  resolvedAt?: number
}

export interface AlertingRule {
  name: string
  description: string
  condition: (snapshot: PerformanceSnapshot) => boolean
  severity: 'low' | 'medium' | 'high' | 'critical'
  cooldown: number
  enabled: boolean
  action?: (alert: PerformanceAlert) => void
}

class PerformanceAlerting {
  private static instance: PerformanceAlerting | null = null
  private monitor: PerformanceMonitor
  private profiler: PerformanceProfiler
  
  private thresholds: Map<string, PerformanceThreshold> = new Map()
  private alerts: PerformanceAlert[] = []
  private rules: Map<string, AlertingRule> = new Map()
  private lastAlertTimes: Map<string, number> = new Map()
  
  private isEnabled = false
  private maxAlerts = 100
  private callbacks: Array<(alert: PerformanceAlert) => void> = []

  private constructor() {
    this.monitor = PerformanceMonitor.getInstance()
    this.profiler = PerformanceProfiler.getInstance()
    this.setupDefaultThresholds()
    this.setupDefaultRules()
  }

  static getInstance(): PerformanceAlerting {
    if (!PerformanceAlerting.instance) {
      PerformanceAlerting.instance = new PerformanceAlerting()
    }
    return PerformanceAlerting.instance
  }

  // Ativa/desativa o sistema de alertas
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled
    
    if (enabled) {
      this.startMonitoring()
      console.log('🚨 Performance alerting enabled')
    } else {
      this.stopMonitoring()
      console.log('🚨 Performance alerting disabled')
    }
  }

  // Adiciona callback para receber alertas
  onAlert(callback: (alert: PerformanceAlert) => void): () => void {
    this.callbacks.push(callback)
    return () => {
      const index = this.callbacks.indexOf(callback)
      if (index > -1) {
        this.callbacks.splice(index, 1)
      }
    }
  }

  // Gerenciamento de thresholds
  addThreshold(threshold: PerformanceThreshold): void {
    this.thresholds.set(threshold.name, threshold)
  }

  removeThreshold(name: string): void {
    this.thresholds.delete(name)
  }

  updateThreshold(name: string, updates: Partial<PerformanceThreshold>): boolean {
    const threshold = this.thresholds.get(name)
    if (!threshold) return false
    
    Object.assign(threshold, updates)
    this.thresholds.set(name, threshold)
    return true
  }

  getThresholds(): PerformanceThreshold[] {
    return Array.from(this.thresholds.values())
  }

  // Gerenciamento de regras customizadas
  addRule(rule: AlertingRule): void {
    this.rules.set(rule.name, rule)
  }

  removeRule(name: string): void {
    this.rules.delete(name)
  }

  getRules(): AlertingRule[] {
    return Array.from(this.rules.values())
  }

  // Obtém alertas
  getAlerts(): PerformanceAlert[] {
    return [...this.alerts].sort((a, b) => b.timestamp - a.timestamp)
  }

  getActiveAlerts(): PerformanceAlert[] {
    return this.alerts.filter(alert => !alert.resolved)
  }

  getAlertsBySeverity(severity: 'low' | 'medium' | 'high' | 'critical'): PerformanceAlert[] {
    return this.alerts.filter(alert => alert.severity === severity)
  }

  // Gerenciar alertas
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId)
    if (alert) {
      alert.acknowledged = true
      return true
    }
    return false
  }

  resolveAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId)
    if (alert) {
      alert.resolved = true
      alert.resolvedAt = Date.now()
      return true
    }
    return false
  }

  clearResolvedAlerts(): void {
    this.alerts = this.alerts.filter(alert => !alert.resolved)
  }

  clearAllAlerts(): void {
    this.alerts = []
    this.lastAlertTimes.clear()
  }

  // Estatísticas de alertas
  getAlertStats(): {
    total: number
    active: number
    resolved: number
    acknowledged: number
    bySeverity: Record<string, number>
    recentAlerts: number // últimas 24h
  } {
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000)
    
    return {
      total: this.alerts.length,
      active: this.alerts.filter(a => !a.resolved).length,
      resolved: this.alerts.filter(a => a.resolved).length,
      acknowledged: this.alerts.filter(a => a.acknowledged).length,
      bySeverity: {
        low: this.alerts.filter(a => a.severity === 'low').length,
        medium: this.alerts.filter(a => a.severity === 'medium').length,
        high: this.alerts.filter(a => a.severity === 'high').length,
        critical: this.alerts.filter(a => a.severity === 'critical').length
      },
      recentAlerts: this.alerts.filter(a => a.timestamp > twentyFourHoursAgo).length
    }
  }

  private startMonitoring(): void {
    // Monitora snapshots de performance
    this.monitor.onSnapshot((snapshot) => {
      if (!this.isEnabled) return
      
      this.checkThresholds(snapshot)
      this.checkRules(snapshot)
    })
  }

  private stopMonitoring(): void {
    // O monitor já gerencia seus próprios callbacks
  }

  private checkThresholds(snapshot: PerformanceSnapshot): void {
    for (const threshold of this.thresholds.values()) {
      if (!threshold.enabled) continue
      
      // Verifica cooldown
      const lastAlertTime = this.lastAlertTimes.get(threshold.name) || 0
      if (Date.now() - lastAlertTime < threshold.cooldown) continue
      
      const actualValue = this.extractMetricValue(snapshot, threshold.metric)
      if (actualValue === null) continue
      
      const isViolated = this.checkThresholdViolation(actualValue, threshold)
      
      if (isViolated) {
        this.createAlert({
          threshold,
          actualValue,
          message: this.generateThresholdMessage(threshold, actualValue),
          metadata: { snapshot: snapshot.timestamp }
        })
      }
    }
  }

  private checkRules(snapshot: PerformanceSnapshot): void {
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue
      
      // Verifica cooldown
      const lastAlertTime = this.lastAlertTimes.get(rule.name) || 0
      if (Date.now() - lastAlertTime < rule.cooldown) continue
      
      try {
        if (rule.condition(snapshot)) {
          const alert = this.createAlert({
            rule,
            message: `Rule violation: ${rule.description}`,
            metadata: { snapshot: snapshot.timestamp }
          })
          
          // Executa ação customizada se definida
          if (rule.action) {
            rule.action(alert)
          }
        }
      } catch (error) {
        console.error(`Error checking rule ${rule.name}:`, error)
      }
    }
  }

  private createAlert(params: {
    threshold?: PerformanceThreshold
    rule?: AlertingRule
    actualValue?: number
    message: string
    metadata?: Record<string, any>
  }): PerformanceAlert {
    const alert: PerformanceAlert = {
      id: this.generateAlertId(),
      timestamp: Date.now(),
      threshold: params.threshold!,
      actualValue: params.actualValue || 0,
      message: params.message,
      severity: params.threshold?.severity || params.rule?.severity || 'medium',
      metadata: params.metadata,
      acknowledged: false,
      resolved: false
    }
    
    this.alerts.push(alert)
    
    // Atualiza último tempo de alerta
    const key = params.threshold?.name || params.rule?.name || 'unknown'
    this.lastAlertTimes.set(key, Date.now())
    
    // Limita número de alertas
    if (this.alerts.length > this.maxAlerts) {
      this.alerts = this.alerts.slice(-this.maxAlerts)
    }
    
    // Notifica callbacks
    this.callbacks.forEach(callback => {
      try {
        callback(alert)
      } catch (error) {
        console.error('Error in alert callback:', error)
      }
    })
    
    // Log baseado na severidade
    if (alert.severity === 'critical') {
      console.error(`🚨 CRITICAL ALERT: ${alert.message}`, alert)
    } else if (alert.severity === 'high') {
      console.warn(`⚠️ HIGH ALERT: ${alert.message}`, alert)
    } else {
      console.log(`📊 Alert: ${alert.message}`)
    }
    
    return alert
  }

  private extractMetricValue(snapshot: PerformanceSnapshot, metric: string): number | null {
    switch (metric) {
      case 'memory':
        return snapshot.memory?.usedJSHeapSize || null
      case 'fps':
        return snapshot.fps
      case 'render_time':
        // Pega média dos tempos de render dos componentes
        return snapshot.renderMetrics.length > 0
          ? snapshot.renderMetrics.reduce((sum, r) => sum + r.renderTime, 0) / snapshot.renderMetrics.length
          : null
      case 'operation_time':
        // Pega média das operações de arquivo
        return snapshot.fileOperations.length > 0
          ? snapshot.fileOperations.reduce((sum, op) => sum + op.duration, 0) / snapshot.fileOperations.length
          : null
      case 'error_rate':
        return snapshot.errors.length
      default:
        return null
    }
  }

  private checkThresholdViolation(value: number, threshold: PerformanceThreshold): boolean {
    switch (threshold.operator) {
      case 'gt': return value > threshold.value
      case 'gte': return value >= threshold.value
      case 'lt': return value < threshold.value
      case 'lte': return value <= threshold.value
      case 'eq': return value === threshold.value
      default: return false
    }
  }

  private generateThresholdMessage(threshold: PerformanceThreshold, actualValue: number): string {
    const unit = this.getMetricUnit(threshold.metric)
    return `${threshold.metric} is ${actualValue}${unit}, exceeding threshold of ${threshold.value}${unit}`
  }

  private getMetricUnit(metric: string): string {
    switch (metric) {
      case 'memory': return ' bytes'
      case 'fps': return ' fps'
      case 'render_time': return 'ms'
      case 'operation_time': return 'ms'
      case 'error_rate': return ' errors'
      default: return ''
    }
  }

  private generateAlertId(): string {
    return `alert_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  }

  private setupDefaultThresholds(): void {
    const defaultThresholds: PerformanceThreshold[] = [
      {
        name: 'high_memory_usage',
        metric: 'memory',
        operator: 'gt',
        value: 100 * 1024 * 1024, // 100MB
        severity: 'medium',
        enabled: true,
        cooldown: 30000 // 30 segundos
      },
      {
        name: 'critical_memory_usage',
        metric: 'memory',
        operator: 'gt',
        value: 200 * 1024 * 1024, // 200MB
        severity: 'critical',
        enabled: true,
        cooldown: 60000 // 1 minuto
      },
      {
        name: 'low_fps',
        metric: 'fps',
        operator: 'lt',
        value: 30,
        severity: 'high',
        enabled: true,
        cooldown: 15000 // 15 segundos
      },
      {
        name: 'critical_fps',
        metric: 'fps',
        operator: 'lt',
        value: 15,
        severity: 'critical',
        enabled: true,
        cooldown: 10000 // 10 segundos
      },
      {
        name: 'slow_render',
        metric: 'render_time',
        operator: 'gt',
        value: 16, // 16ms
        severity: 'medium',
        enabled: true,
        cooldown: 20000 // 20 segundos
      },
      {
        name: 'errors_detected',
        metric: 'error_rate',
        operator: 'gt',
        value: 0,
        severity: 'high',
        enabled: true,
        cooldown: 5000 // 5 segundos
      }
    ]
    
    defaultThresholds.forEach(threshold => {
      this.thresholds.set(threshold.name, threshold)
    })
  }

  private setupDefaultRules(): void {
    const defaultRules: AlertingRule[] = [
      {
        name: 'memory_trend_increasing',
        description: 'Memory usage has been consistently increasing',
        condition: (snapshot) => {
          // Implementação simplificada - verificar tendência de aumento
          return false // Placeholder
        },
        severity: 'medium',
        cooldown: 60000, // 1 minuto
        enabled: true
      },
      {
        name: 'performance_degradation',
        description: 'Overall performance has degraded significantly',
        condition: (snapshot) => {
          // Combina múltiplas métricas para detectar degradação geral
          const memoryIssue = snapshot.memory && snapshot.memory.usedJSHeapSize > 150 * 1024 * 1024
          const fpsIssue = snapshot.fps < 25
          const errorIssue = snapshot.errors.length > 2
          
          return !!(memoryIssue && fpsIssue) || errorIssue
        },
        severity: 'high',
        cooldown: 30000, // 30 segundos
        enabled: true,
        action: (alert) => {
          // Ação customizada para degradação de performance
          console.warn('🚨 Performance degradation detected, consider investigation')
        }
      },
      {
        name: 'component_render_spike',
        description: 'Component rendering time has spiked significantly',
        condition: (snapshot) => {
          const profiles = this.profiler.getSlowComponents(25) // > 25ms
          return profiles.length > 3 // Mais de 3 componentes lentos
        },
        severity: 'medium',
        cooldown: 45000, // 45 segundos
        enabled: true
      }
    ]
    
    defaultRules.forEach(rule => {
      this.rules.set(rule.name, rule)
    })
  }
}

export default PerformanceAlerting