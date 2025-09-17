import PerformanceMonitor from '../services/performanceMonitor'

export interface PerformanceTestCase {
  name: string
  description: string
  setup?: () => Promise<void> | void
  test: () => Promise<void> | void
  cleanup?: () => Promise<void> | void
  expectedThresholds: {
    maxDuration?: number // ms
    maxMemoryUsage?: number // bytes
    maxRenderTime?: number // ms
    minFPS?: number
  }
  tags: string[]
}

export interface TestResult {
  testName: string
  passed: boolean
  duration: number
  memoryUsage: number
  errors: string[]
  metrics: {
    renderTime?: number
    fps?: number
    customMetrics: Record<string, number>
  }
  threshold: {
    duration: { value: number; passed: boolean; threshold?: number }
    memory: { value: number; passed: boolean; threshold?: number }
    fps: { value: number; passed: boolean; threshold?: number }
  }
}

export interface TestSuite {
  name: string
  tests: PerformanceTestCase[]
  beforeAll?: () => Promise<void> | void
  afterAll?: () => Promise<void> | void
}

export interface BenchmarkResult {
  suiteName: string
  timestamp: number
  totalTests: number
  passedTests: number
  failedTests: number
  totalDuration: number
  averageMemoryUsage: number
  results: TestResult[]
  environment: {
    userAgent: string
    platform: string
    memory: number
    cores: number
  }
}

class PerformanceTestRunner {
  private monitor: PerformanceMonitor
  private isRunning = false

  constructor() {
    this.monitor = PerformanceMonitor.getInstance()
  }

  async runSuite(suite: TestSuite): Promise<BenchmarkResult> {
    if (this.isRunning) {
      throw new Error('Test suite is already running')
    }

    this.isRunning = true
    console.log(`🧪 Running performance test suite: ${suite.name}`)

    const startTime = Date.now()
    const results: TestResult[] = []
    
    try {
      // Setup global
      if (suite.beforeAll) {
        await suite.beforeAll()
      }

      // Executa cada teste
      for (const test of suite.tests) {
        console.log(`  Running: ${test.name}`)
        const result = await this.runSingleTest(test)
        results.push(result)
        
        // Pequena pausa entre testes
        await this.sleep(100)
      }

      // Cleanup global
      if (suite.afterAll) {
        await suite.afterAll()
      }

    } finally {
      this.isRunning = false
    }

    const totalDuration = Date.now() - startTime
    const passedTests = results.filter(r => r.passed).length
    const averageMemoryUsage = results.reduce((sum, r) => sum + r.memoryUsage, 0) / results.length

    const benchmark: BenchmarkResult = {
      suiteName: suite.name,
      timestamp: startTime,
      totalTests: results.length,
      passedTests,
      failedTests: results.length - passedTests,
      totalDuration,
      averageMemoryUsage,
      results,
      environment: this.getEnvironmentInfo()
    }

    console.log(`✅ Suite completed: ${passedTests}/${results.length} tests passed`)
    return benchmark
  }

  async runSingleTest(testCase: PerformanceTestCase): Promise<TestResult> {
    const testResult: TestResult = {
      testName: testCase.name,
      passed: false,
      duration: 0,
      memoryUsage: 0,
      errors: [],
      metrics: { customMetrics: {} },
      threshold: {
        duration: { value: 0, passed: true },
        memory: { value: 0, passed: true },
        fps: { value: 60, passed: true }
      }
    }

    try {
      // Setup
      if (testCase.setup) {
        await testCase.setup()
      }

      // Limpa métricas anteriores
      this.monitor.clearData()
      
      // Inicia monitoramento
      this.monitor.startMonitoring()
      
      const startTime = Date.now()
      const startMemory = this.getMemoryUsage()

      // Executa o teste
      await testCase.test()

      // Coleta métricas finais
      const endTime = Date.now()
      const endMemory = this.getMemoryUsage()
      const duration = endTime - startTime
      const memoryUsage = endMemory - startMemory

      // Para monitoramento
      this.monitor.stopMonitoring()

      // Coleta snapshot final
      const finalSnapshot = this.monitor.getLatestSnapshot()
      
      testResult.duration = duration
      testResult.memoryUsage = memoryUsage
      testResult.metrics.fps = finalSnapshot?.fps || 60
      testResult.metrics.customMetrics = this.extractCustomMetrics()

      // Avalia thresholds
      testResult.threshold = {
        duration: {
          value: duration,
          passed: !testCase.expectedThresholds.maxDuration || duration <= testCase.expectedThresholds.maxDuration,
          threshold: testCase.expectedThresholds.maxDuration
        },
        memory: {
          value: memoryUsage,
          passed: !testCase.expectedThresholds.maxMemoryUsage || memoryUsage <= testCase.expectedThresholds.maxMemoryUsage,
          threshold: testCase.expectedThresholds.maxMemoryUsage
        },
        fps: {
          value: finalSnapshot?.fps || 60,
          passed: !testCase.expectedThresholds.minFPS || (finalSnapshot?.fps || 60) >= testCase.expectedThresholds.minFPS,
          threshold: testCase.expectedThresholds.minFPS
        }
      }

      testResult.passed = testResult.threshold.duration.passed && 
                         testResult.threshold.memory.passed && 
                         testResult.threshold.fps.passed

    } catch (error) {
      testResult.errors.push(error instanceof Error ? error.message : 'Unknown error')
      testResult.passed = false
    } finally {
      // Cleanup
      try {
        this.monitor.stopMonitoring()
        if (testCase.cleanup) {
          await testCase.cleanup()
        }
      } catch (error) {
        testResult.errors.push(`Cleanup error: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    return testResult
  }

  generateReport(benchmarks: BenchmarkResult[]): string {
    let report = `# Performance Test Report\n\n`
    report += `Generated: ${new Date().toISOString()}\n\n`

    for (const benchmark of benchmarks) {
      report += `## ${benchmark.suiteName}\n\n`
      report += `- **Total Tests:** ${benchmark.totalTests}\n`
      report += `- **Passed:** ${benchmark.passedTests} (${(benchmark.passedTests / benchmark.totalTests * 100).toFixed(1)}%)\n`
      report += `- **Failed:** ${benchmark.failedTests}\n`
      report += `- **Total Duration:** ${benchmark.totalDuration}ms\n`
      report += `- **Average Memory:** ${this.formatBytes(benchmark.averageMemoryUsage)}\n\n`

      report += `### Test Results\n\n`
      
      for (const result of benchmark.results) {
        const status = result.passed ? '✅' : '❌'
        report += `${status} **${result.testName}**\n`
        report += `  - Duration: ${result.duration}ms`
        
        if (result.threshold.duration.threshold) {
          report += ` (limit: ${result.threshold.duration.threshold}ms)`
        }
        report += `\n`
        
        report += `  - Memory: ${this.formatBytes(result.memoryUsage)}`
        if (result.threshold.memory.threshold) {
          report += ` (limit: ${this.formatBytes(result.threshold.memory.threshold)})`
        }
        report += `\n`
        
        report += `  - FPS: ${result.metrics.fps}`
        if (result.threshold.fps.threshold) {
          report += ` (min: ${result.threshold.fps.threshold})`
        }
        report += `\n`

        if (result.errors.length > 0) {
          report += `  - Errors: ${result.errors.join(', ')}\n`
        }
        report += `\n`
      }
      report += `\n`
    }

    return report
  }

  exportResults(benchmarks: BenchmarkResult[], format: 'json' | 'csv' | 'markdown' = 'json'): string {
    switch (format) {
      case 'json':
        return JSON.stringify(benchmarks, null, 2)
      
      case 'csv':
        return this.generateCSV(benchmarks)
      
      case 'markdown':
        return this.generateReport(benchmarks)
      
      default:
        throw new Error(`Unsupported format: ${format}`)
    }
  }

  private generateCSV(benchmarks: BenchmarkResult[]): string {
    const headers = [
      'Suite', 'Test', 'Passed', 'Duration(ms)', 'Memory(bytes)', 
      'FPS', 'Errors', 'Timestamp'
    ]
    
    let csv = headers.join(',') + '\n'
    
    for (const benchmark of benchmarks) {
      for (const result of benchmark.results) {
        const row = [
          benchmark.suiteName,
          result.testName,
          result.passed,
          result.duration,
          result.memoryUsage,
          result.metrics.fps,
          result.errors.join('; '),
          benchmark.timestamp
        ]
        csv += row.map(cell => `"${cell}"`).join(',') + '\n'
      }
    }
    
    return csv
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private getMemoryUsage(): number {
    if (typeof window !== 'undefined' && 'performance' in window && 'memory' in performance) {
      return (performance as any).memory.usedJSHeapSize
    }
    return 0
  }

  private extractCustomMetrics(): Record<string, number> {
    const metrics = this.monitor.getCurrentMetrics()
    const customMetrics: Record<string, number> = {}
    
    // Agrupa métricas por tipo
    const groups = metrics.reduce((acc, metric) => {
      const [category] = metric.type.split(':')
      if (!acc[category]) acc[category] = []
      acc[category].push(metric.value)
      return acc
    }, {} as Record<string, number[]>)
    
    // Calcula médias
    for (const [category, values] of Object.entries(groups)) {
      customMetrics[`${category}_avg`] = values.reduce((sum, v) => sum + v, 0) / values.length
      customMetrics[`${category}_max`] = Math.max(...values)
      customMetrics[`${category}_min`] = Math.min(...values)
    }
    
    return customMetrics
  }

  private getEnvironmentInfo() {
    const nav = typeof navigator !== 'undefined' ? navigator : {} as any
    
    return {
      userAgent: nav.userAgent || 'Unknown',
      platform: nav.platform || 'Unknown',
      memory: (nav.deviceMemory || 0) * 1024, // GB to MB
      cores: nav.hardwareConcurrency || 0
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }
}

export default PerformanceTestRunner