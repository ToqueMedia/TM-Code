import PerformanceMonitor from '../services/performanceMonitor'

interface ComponentProfileData {
  componentName: string
  renderCount: number
  totalRenderTime: number
  averageRenderTime: number
  lastRenderTime: number
  propsChanges: Array<{
    timestamp: number
    changedProps: string[]
    reason: string
  }>
  reRenderReasons: Record<string, number>
}

interface HookProfileData {
  hookName: string
  component: string
  executionCount: number
  totalExecutionTime: number
  averageExecutionTime: number
  dependencies: Array<{
    name: string
    changeCount: number
    lastValue: any
  }>
}

interface OperationProfile {
  operationName: string
  executionCount: number
  totalTime: number
  averageTime: number
  minTime: number
  maxTime: number
  recentExecutions: Array<{
    timestamp: number
    duration: number
    metadata?: Record<string, any>
  }>
}

class PerformanceProfiler {
  private static instance: PerformanceProfiler | null = null
  private monitor: PerformanceMonitor
  private componentProfiles = new Map<string, ComponentProfileData>()
  private hookProfiles = new Map<string, HookProfileData>()
  private operationProfiles = new Map<string, OperationProfile>()
  private isEnabled = false

  private constructor() {
    this.monitor = PerformanceMonitor.getInstance()
  }

  static getInstance(): PerformanceProfiler {
    if (!PerformanceProfiler.instance) {
      PerformanceProfiler.instance = new PerformanceProfiler()
    }
    return PerformanceProfiler.instance
  }

  // Ativa/desativa profiling
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled
    if (enabled) {
      console.log('🔍 Performance profiling enabled')
    } else {
      console.log('🔍 Performance profiling disabled')
    }
  }

  // Profiling de componentes React
  profileComponent<P extends Record<string, any>>(
    componentName: string,
    props: P,
    render: () => React.ReactElement
  ): React.ReactElement {
    if (!this.isEnabled) {
      return render()
    }

    const startTime = performance.now()
    let profile = this.componentProfiles.get(componentName)

    if (!profile) {
      profile = {
        componentName,
        renderCount: 0,
        totalRenderTime: 0,
        averageRenderTime: 0,
        lastRenderTime: 0,
        propsChanges: [],
        reRenderReasons: {}
      }
      this.componentProfiles.set(componentName, profile)
    }

    // Detecta mudanças de props
    this.trackPropsChanges(componentName, props, profile)

    try {
      const result = render()
      
      const renderTime = performance.now() - startTime
      this.updateComponentProfile(profile, renderTime)
      
      // Adiciona métrica no monitor
      this.monitor.addMetric(`component:${componentName}`, renderTime, {
        renderCount: profile.renderCount,
        propsChanges: profile.propsChanges.length
      })

      return result
    } catch (error) {
      const renderTime = performance.now() - startTime
      this.updateComponentProfile(profile, renderTime)
      
      this.monitor.addMetric(`component:${componentName}:error`, renderTime, {
        error: error instanceof Error ? error.message : 'Unknown error'
      })
      
      throw error
    }
  }

  // Profiling de hooks customizados
  profileHook<T>(
    hookName: string,
    componentName: string,
    hookFunction: () => T,
    dependencies?: any[]
  ): T {
    if (!this.isEnabled) {
      return hookFunction()
    }

    const profileKey = `${componentName}:${hookName}`
    const startTime = performance.now()
    
    let profile = this.hookProfiles.get(profileKey)
    if (!profile) {
      profile = {
        hookName,
        component: componentName,
        executionCount: 0,
        totalExecutionTime: 0,
        averageExecutionTime: 0,
        dependencies: []
      }
      this.hookProfiles.set(profileKey, profile)
    }

    // Rastrea mudanças de dependências
    if (dependencies) {
      this.trackDependencyChanges(profile, dependencies)
    }

    try {
      const result = hookFunction()
      
      const executionTime = performance.now() - startTime
      this.updateHookProfile(profile, executionTime)
      
      this.monitor.addMetric(`hook:${hookName}`, executionTime, {
        component: componentName,
        executionCount: profile.executionCount
      })

      return result
    } catch (error) {
      const executionTime = performance.now() - startTime
      this.updateHookProfile(profile, executionTime)
      
      this.monitor.addMetric(`hook:${hookName}:error`, executionTime, {
        component: componentName,
        error: error instanceof Error ? error.message : 'Unknown error'
      })
      
      throw error
    }
  }

  // Profiling de operações assíncronas
  async profileOperation<T>(
    operationName: string,
    operation: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    if (!this.isEnabled) {
      return operation()
    }

    const startTime = performance.now()
    let profile = this.operationProfiles.get(operationName)

    if (!profile) {
      profile = {
        operationName,
        executionCount: 0,
        totalTime: 0,
        averageTime: 0,
        minTime: Infinity,
        maxTime: 0,
        recentExecutions: []
      }
      this.operationProfiles.set(operationName, profile)
    }

    try {
      const result = await operation()
      
      const duration = performance.now() - startTime
      this.updateOperationProfile(profile, duration, metadata)
      
      this.monitor.addMetric(`operation:${operationName}`, duration, {
        success: true,
        executionCount: profile.executionCount,
        ...metadata
      })

      return result
    } catch (error) {
      const duration = performance.now() - startTime
      this.updateOperationProfile(profile, duration, { 
        error: error instanceof Error ? error.message : 'Unknown error',
        ...metadata 
      })
      
      this.monitor.addMetric(`operation:${operationName}:error`, duration, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        ...metadata
      })
      
      throw error
    }
  }

  // Profiling de função síncrona
  profileFunction<T>(
    functionName: string,
    func: () => T,
    metadata?: Record<string, any>
  ): T {
    if (!this.isEnabled) {
      return func()
    }

    const startTime = performance.now()
    
    try {
      const result = func()
      
      const duration = performance.now() - startTime
      this.monitor.addMetric(`function:${functionName}`, duration, {
        success: true,
        ...metadata
      })

      return result
    } catch (error) {
      const duration = performance.now() - startTime
      this.monitor.addMetric(`function:${functionName}:error`, duration, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        ...metadata
      })
      
      throw error
    }
  }

  // Obtém dados de profiling
  getComponentProfiles(): ComponentProfileData[] {
    return Array.from(this.componentProfiles.values())
  }

  getHookProfiles(): HookProfileData[] {
    return Array.from(this.hookProfiles.values())
  }

  getOperationProfiles(): OperationProfile[] {
    return Array.from(this.operationProfiles.values())
  }

  // Identifica componentes problemáticos
  getSlowComponents(threshold = 16): ComponentProfileData[] {
    return this.getComponentProfiles()
      .filter(profile => profile.averageRenderTime > threshold)
      .sort((a, b) => b.averageRenderTime - a.averageRenderTime)
  }

  getFrequentReRenders(threshold = 10): ComponentProfileData[] {
    return this.getComponentProfiles()
      .filter(profile => profile.renderCount > threshold)
      .sort((a, b) => b.renderCount - a.renderCount)
  }

  // Identifica hooks problemáticos
  getSlowHooks(threshold = 5): HookProfileData[] {
    return this.getHookProfiles()
      .filter(profile => profile.averageExecutionTime > threshold)
      .sort((a, b) => b.averageExecutionTime - a.averageExecutionTime)
  }

  // Identifica operações lentas
  getSlowOperations(threshold = 100): OperationProfile[] {
    return this.getOperationProfiles()
      .filter(profile => profile.averageTime > threshold)
      .sort((a, b) => b.averageTime - a.averageTime)
  }

  // Gera relatório de profiling
  generateReport(): {
    summary: {
      totalComponents: number
      totalHooks: number
      totalOperations: number
      slowComponents: number
      slowHooks: number
      slowOperations: number
    }
    topIssues: Array<{
      type: 'component' | 'hook' | 'operation'
      name: string
      issue: string
      metric: number
      recommendation: string
    }>
    componentReport: ComponentProfileData[]
    hookReport: HookProfileData[]
    operationReport: OperationProfile[]
  } {
    const componentProfiles = this.getComponentProfiles()
    const hookProfiles = this.getHookProfiles()
    const operationProfiles = this.getOperationProfiles()

    const slowComponents = this.getSlowComponents()
    const slowHooks = this.getSlowHooks()
    const slowOperations = this.getSlowOperations()

    const topIssues: Array<{
      type: 'component' | 'hook' | 'operation'
      name: string
      issue: string
      metric: number
      recommendation: string
    }> = []

    // Adiciona componentes lentos
    slowComponents.slice(0, 5).forEach(profile => {
      topIssues.push({
        type: 'component',
        name: profile.componentName,
        issue: 'Slow render time',
        metric: profile.averageRenderTime,
        recommendation: 'Consider memoizing props or using React.memo'
      })
    })

    // Adiciona hooks lentos
    slowHooks.slice(0, 5).forEach(profile => {
      topIssues.push({
        type: 'hook',
        name: `${profile.component}:${profile.hookName}`,
        issue: 'Slow execution time',
        metric: profile.averageExecutionTime,
        recommendation: 'Check dependencies and consider optimization'
      })
    })

    // Adiciona operações lentas
    slowOperations.slice(0, 5).forEach(profile => {
      topIssues.push({
        type: 'operation',
        name: profile.operationName,
        issue: 'Slow operation',
        metric: profile.averageTime,
        recommendation: 'Consider caching, optimization or moving to Web Worker'
      })
    })

    return {
      summary: {
        totalComponents: componentProfiles.length,
        totalHooks: hookProfiles.length,
        totalOperations: operationProfiles.length,
        slowComponents: slowComponents.length,
        slowHooks: slowHooks.length,
        slowOperations: slowOperations.length
      },
      topIssues: topIssues.sort((a, b) => b.metric - a.metric),
      componentReport: componentProfiles,
      hookReport: hookProfiles,
      operationReport: operationProfiles
    }
  }

  // Limpa dados de profiling
  clearProfiles(): void {
    this.componentProfiles.clear()
    this.hookProfiles.clear()
    this.operationProfiles.clear()
    console.log('🔍 Profiling data cleared')
  }

  // Exporta dados
  exportProfiles(): string {
    const report = this.generateReport()
    return JSON.stringify(report, null, 2)
  }

  private trackPropsChanges<P extends Record<string, any>>(
    componentName: string,
    currentProps: P,
    profile: ComponentProfileData
  ): void {
    // Implementação simplificada - em produção, fazer deep comparison
    const propKeys = Object.keys(currentProps)
    const changedProps = propKeys.filter(key => {
      // Placeholder - implementar comparação real
      return true
    })

    if (changedProps.length > 0) {
      profile.propsChanges.push({
        timestamp: Date.now(),
        changedProps,
        reason: 'Props changed'
      })

      // Mantém apenas os últimos 10 registros
      if (profile.propsChanges.length > 10) {
        profile.propsChanges = profile.propsChanges.slice(-10)
      }
    }
  }

  private updateComponentProfile(profile: ComponentProfileData, renderTime: number): void {
    profile.renderCount++
    profile.totalRenderTime += renderTime
    profile.averageRenderTime = profile.totalRenderTime / profile.renderCount
    profile.lastRenderTime = renderTime
  }

  private trackDependencyChanges(profile: HookProfileData, dependencies: any[]): void {
    dependencies.forEach((dep, index) => {
      const depName = `dep_${index}`
      let depProfile = profile.dependencies.find(d => d.name === depName)
      
      if (!depProfile) {
        depProfile = {
          name: depName,
          changeCount: 0,
          lastValue: dep
        }
        profile.dependencies.push(depProfile)
      } else if (depProfile.lastValue !== dep) {
        depProfile.changeCount++
        depProfile.lastValue = dep
      }
    })
  }

  private updateHookProfile(profile: HookProfileData, executionTime: number): void {
    profile.executionCount++
    profile.totalExecutionTime += executionTime
    profile.averageExecutionTime = profile.totalExecutionTime / profile.executionCount
  }

  private updateOperationProfile(
    profile: OperationProfile, 
    duration: number, 
    metadata?: Record<string, any>
  ): void {
    profile.executionCount++
    profile.totalTime += duration
    profile.averageTime = profile.totalTime / profile.executionCount
    profile.minTime = Math.min(profile.minTime, duration)
    profile.maxTime = Math.max(profile.maxTime, duration)

    profile.recentExecutions.push({
      timestamp: Date.now(),
      duration,
      metadata
    })

    // Mantém apenas as últimas 20 execuções
    if (profile.recentExecutions.length > 20) {
      profile.recentExecutions = profile.recentExecutions.slice(-20)
    }
  }
}

export default PerformanceProfiler