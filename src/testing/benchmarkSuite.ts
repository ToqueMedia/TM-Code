import PerformanceTestRunner, { TestSuite, BenchmarkResult } from './performanceTestRunner'
import PerformanceMonitor from '../services/performanceMonitor'
import { useFileTreeRepository } from '../stores/fileTreeStore'
import { useEditorRepository } from '../stores/editorStore'

interface BenchmarkConfig {
  name: string
  description: string
  version: string
  environment: {
    nodeSize: 'small' | 'medium' | 'large' | 'xl'
    fileCount: number
    iterations: number
  }
  expectedMetrics: {
    fileTreeLoad?: number
    fileTreeSearch?: number
    editorOpen?: number
    editorRender?: number
    memoryUsage?: number
  }
}

interface BenchmarkComparison {
  baseline: BenchmarkResult
  current: BenchmarkResult
  improvements: Array<{
    metric: string
    baseline: number
    current: number
    improvement: number // percentage
    status: 'improved' | 'degraded' | 'stable'
  }>
  regression: boolean
  summary: {
    overallImprovement: number
    significantChanges: number
    regressions: number
  }
}

class BenchmarkSuite {
  private testRunner: PerformanceTestRunner
  private monitor: PerformanceMonitor
  private configs: BenchmarkConfig[] = []
  private results: Map<string, BenchmarkResult> = new Map()

  constructor() {
    this.testRunner = new PerformanceTestRunner()
    this.monitor = PerformanceMonitor.getInstance()
    this.setupDefaultBenchmarks()
  }

  // Adiciona configuração de benchmark
  addBenchmark(config: BenchmarkConfig): void {
    this.configs.push(config)
  }

  // Executa todos os benchmarks
  async runAllBenchmarks(): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = []
    
    console.log(`🏃 Starting benchmark suite with ${this.configs.length} benchmarks`)
    
    for (const config of this.configs) {
      console.log(`📊 Running benchmark: ${config.name}`)
      
      try {
        const suite = this.createTestSuite(config)
        const result = await this.testRunner.runSuite(suite)
        results.push(result)
        this.results.set(config.name, result)
        
        console.log(`✅ Completed benchmark: ${config.name}`)
      } catch (error) {
        console.error(`❌ Failed benchmark: ${config.name}`, error)
      }
    }
    
    return results
  }

  // Executa benchmark específico
  async runBenchmark(benchmarkName: string): Promise<BenchmarkResult | null> {
    const config = this.configs.find(c => c.name === benchmarkName)
    if (!config) {
      console.error(`Benchmark not found: ${benchmarkName}`)
      return null
    }
    
    console.log(`📊 Running single benchmark: ${config.name}`)
    
    try {
      const suite = this.createTestSuite(config)
      const result = await this.testRunner.runSuite(suite)
      this.results.set(config.name, result)
      return result
    } catch (error) {
      console.error(`❌ Failed benchmark: ${config.name}`, error)
      return null
    }
  }

  // Compara resultados entre versões
  compareBenchmarks(baselineResult: BenchmarkResult, currentResult: BenchmarkResult): BenchmarkComparison {
    const improvements: BenchmarkComparison['improvements'] = []
    let regressions = 0
    let significantChanges = 0
    
    // Compara cada teste
    baselineResult.results.forEach(baselineTest => {
      const currentTest = currentResult.results.find(t => t.testName === baselineTest.testName)
      if (!currentTest) return
      
      // Compara duração
      const durationImprovement = ((baselineTest.duration - currentTest.duration) / baselineTest.duration) * 100
      if (Math.abs(durationImprovement) > 5) { // Mudança significativa > 5%
        significantChanges++
        improvements.push({
          metric: `${baselineTest.testName}_duration`,
          baseline: baselineTest.duration,
          current: currentTest.duration,
          improvement: durationImprovement,
          status: durationImprovement > 0 ? 'improved' : 'degraded'
        })
        
        if (durationImprovement < 0) regressions++
      }
      
      // Compara uso de memória
      const memoryImprovement = ((baselineTest.memoryUsage - currentTest.memoryUsage) / baselineTest.memoryUsage) * 100
      if (Math.abs(memoryImprovement) > 10) { // Mudança significativa > 10%
        significantChanges++
        improvements.push({
          metric: `${baselineTest.testName}_memory`,
          baseline: baselineTest.memoryUsage,
          current: currentTest.memoryUsage,
          improvement: memoryImprovement,
          status: memoryImprovement > 0 ? 'improved' : 'degraded'
        })
        
        if (memoryImprovement < 0) regressions++
      }
    })
    
    // Calcula melhoria geral
    const overallImprovement = improvements.length > 0
      ? improvements.reduce((sum, imp) => sum + imp.improvement, 0) / improvements.length
      : 0
    
    return {
      baseline: baselineResult,
      current: currentResult,
      improvements,
      regression: regressions > 0,
      summary: {
        overallImprovement,
        significantChanges,
        regressions
      }
    }
  }

  // Gera relatório de comparação
  generateComparisonReport(comparison: BenchmarkComparison): string {
    let report = `# Performance Benchmark Comparison\n\n`
    report += `**Baseline:** ${comparison.baseline.suiteName} (${new Date(comparison.baseline.timestamp).toISOString()})\n`
    report += `**Current:** ${comparison.current.suiteName} (${new Date(comparison.current.timestamp).toISOString()})\n\n`
    
    // Sumário
    report += `## Summary\n\n`
    report += `- **Overall Performance Change:** ${comparison.summary.overallImprovement.toFixed(2)}%\n`
    report += `- **Significant Changes:** ${comparison.summary.significantChanges}\n`
    report += `- **Regressions:** ${comparison.summary.regressions}\n`
    report += `- **Status:** ${comparison.regression ? '❌ Regression Detected' : '✅ No Regressions'}\n\n`
    
    // Melhorias/Degradações
    if (comparison.improvements.length > 0) {
      report += `## Detailed Changes\n\n`
      
      const improved = comparison.improvements.filter(i => i.status === 'improved')
      const degraded = comparison.improvements.filter(i => i.status === 'degraded')
      
      if (improved.length > 0) {
        report += `### ✅ Improvements\n\n`
        improved.forEach(imp => {
          report += `- **${imp.metric}**: ${imp.improvement.toFixed(2)}% faster\n`
          report += `  - Baseline: ${this.formatMetric(imp.baseline, imp.metric)}\n`
          report += `  - Current: ${this.formatMetric(imp.current, imp.metric)}\n\n`
        })
      }
      
      if (degraded.length > 0) {
        report += `### ❌ Degradations\n\n`
        degraded.forEach(imp => {
          report += `- **${imp.metric}**: ${Math.abs(imp.improvement).toFixed(2)}% slower\n`
          report += `  - Baseline: ${this.formatMetric(imp.baseline, imp.metric)}\n`
          report += `  - Current: ${this.formatMetric(imp.current, imp.metric)}\n\n`
        })
      }
    }
    
    // Recomendações
    report += `## Recommendations\n\n`
    if (comparison.summary.regressions > 0) {
      report += `⚠️ **Action Required:** Performance regressions detected. Consider:\n`
      report += `- Reviewing recent changes that might impact performance\n`
      report += `- Running additional profiling on degraded areas\n`
      report += `- Implementing targeted optimizations\n\n`
    } else {
      report += `✅ **No Action Required:** Performance is stable or improved.\n\n`
    }
    
    return report
  }

  // Exporta resultados de benchmarks
  exportBenchmarks(format: 'json' | 'csv' | 'markdown' = 'json'): string {
    const results = Array.from(this.results.values())
    
    switch (format) {
      case 'json':
        return JSON.stringify(results, null, 2)
      
      case 'csv':
        return this.generateBenchmarkCSV(results)
        
      case 'markdown':
        return this.generateBenchmarkReport(results)
        
      default:
        throw new Error(`Unsupported format: ${format}`)
    }
  }

  // Executa benchmark de regressão contra baseline
  async runRegressionTest(baselineFile?: string): Promise<BenchmarkComparison[]> {
    const currentResults = await this.runAllBenchmarks()
    const comparisons: BenchmarkComparison[] = []
    
    // Se não há baseline específico, usa os resultados salvos
    if (!baselineFile) {
      console.log('📊 Running regression test against previous results')
      // Implementar carregamento de resultados anteriores
      return comparisons
    }
    
    // Carrega baseline do arquivo
    try {
      const baselineData = JSON.parse(baselineFile)
      
      currentResults.forEach(current => {
        const baseline = baselineData.find((b: BenchmarkResult) => b.suiteName === current.suiteName)
        if (baseline) {
          const comparison = this.compareBenchmarks(baseline, current)
          comparisons.push(comparison)
        }
      })
    } catch (error) {
      console.error('Failed to parse baseline file:', error)
    }
    
    return comparisons
  }

  private createTestSuite(config: BenchmarkConfig): TestSuite {
    const { environment } = config
    
    return {
      name: config.name,
      beforeAll: async () => {
        // Setup inicial
        console.log(`Setting up benchmark: ${config.name}`)
        this.monitor.clearData()
      },
      afterAll: async () => {
        // Cleanup
        console.log(`Cleaning up benchmark: ${config.name}`)
      },
      tests: [
        // Teste de carregamento da árvore de arquivos
        {
          name: 'fileTree_load',
          description: 'Load file tree with specified number of files',
          test: async () => {
            const fileTreeStore = useFileTreeRepository.getState()
            await fileTreeStore.loadFileTree('/mock/project/path', { showHidden: true })
          },
          expectedThresholds: {
            maxDuration: config.expectedMetrics.fileTreeLoad || 1000,
            maxMemoryUsage: config.expectedMetrics.memoryUsage || 50 * 1024 * 1024
          },
          tags: ['fileTree', 'load']
        },
        
        // Teste de busca na árvore
        {
          name: 'fileTree_search',
          description: 'Search files in the tree',
          test: async () => {
            const fileTreeStore = useFileTreeRepository.getState()
            await fileTreeStore.searchInTree('test')
          },
          expectedThresholds: {
            maxDuration: config.expectedMetrics.fileTreeSearch || 500,
            maxMemoryUsage: 10 * 1024 * 1024
          },
          tags: ['fileTree', 'search']
        },
        
        // Teste de abertura de arquivo no editor
        {
          name: 'editor_openFile',
          description: 'Open file in editor',
          test: async () => {
            const editorStore = useEditorRepository.getState()
            await editorStore.openFile('/mock/file.tsx')
          },
          expectedThresholds: {
            maxDuration: config.expectedMetrics.editorOpen || 300,
            maxMemoryUsage: 20 * 1024 * 1024
          },
          tags: ['editor', 'open']
        },
        
        // Teste de renderização do editor
        {
          name: 'editor_render',
          description: 'Render editor with content',
          setup: async () => {
            // Setup mock content
            const content = 'function test() {\n  return "Hello World";\n}'.repeat(environment.fileCount / 10)
            return content
          },
          test: async () => {
            // Simula renderização do Monaco Editor
            await new Promise(resolve => setTimeout(resolve, 50))
          },
          expectedThresholds: {
            maxDuration: config.expectedMetrics.editorRender || 100,
            minFPS: 30
          },
          tags: ['editor', 'render']
        },
        
        // Teste de operações em lote
        {
          name: 'batch_operations',
          description: 'Perform multiple operations in sequence',
          test: async () => {
            const fileTreeStore = useFileTreeRepository.getState()
            const editorStore = useEditorRepository.getState()
            
            // Simula operações típicas do usuário
            for (let i = 0; i < environment.iterations; i++) {
              await fileTreeStore.searchInTree(`query_${i}`)
              await editorStore.openFile(`/mock/file_${i}.tsx`)
              
              // Pequena pausa para simular interação do usuário
              await new Promise(resolve => setTimeout(resolve, 10))
            }
          },
          expectedThresholds: {
            maxDuration: environment.iterations * 100,
            maxMemoryUsage: config.expectedMetrics.memoryUsage || 100 * 1024 * 1024
          },
          tags: ['batch', 'integration']
        },
        
        // Teste de stress de memória
        {
          name: 'memory_stress',
          description: 'Test memory usage under load',
          test: async () => {
            const editorStore = useEditorRepository.getState()
            
            // Abre múltiplos arquivos para testar uso de memória
            const promises = []
            for (let i = 0; i < Math.min(20, environment.fileCount); i++) {
              promises.push(editorStore.openFile(`/mock/large_file_${i}.tsx`))
            }
            
            await Promise.all(promises)
          },
          expectedThresholds: {
            maxDuration: 2000,
            maxMemoryUsage: config.expectedMetrics.memoryUsage || 150 * 1024 * 1024
          },
          tags: ['memory', 'stress']
        }
      ]
    }
  }

  private setupDefaultBenchmarks(): void {
    const defaultConfigs: BenchmarkConfig[] = [
      {
        name: 'small_project',
        description: 'Small project with ~50 files',
        version: '1.0.0',
        environment: {
          nodeSize: 'small',
          fileCount: 50,
          iterations: 5
        },
        expectedMetrics: {
          fileTreeLoad: 200,
          fileTreeSearch: 100,
          editorOpen: 150,
          editorRender: 50,
          memoryUsage: 30 * 1024 * 1024
        }
      },
      {
        name: 'medium_project',
        description: 'Medium project with ~500 files',
        version: '1.0.0',
        environment: {
          nodeSize: 'medium',
          fileCount: 500,
          iterations: 10
        },
        expectedMetrics: {
          fileTreeLoad: 800,
          fileTreeSearch: 300,
          editorOpen: 200,
          editorRender: 80,
          memoryUsage: 80 * 1024 * 1024
        }
      },
      {
        name: 'large_project',
        description: 'Large project with ~2000 files',
        version: '1.0.0',
        environment: {
          nodeSize: 'large',
          fileCount: 2000,
          iterations: 15
        },
        expectedMetrics: {
          fileTreeLoad: 2000,
          fileTreeSearch: 800,
          editorOpen: 300,
          editorRender: 120,
          memoryUsage: 150 * 1024 * 1024
        }
      },
      {
        name: 'xl_project',
        description: 'Extra large project with ~5000+ files',
        version: '1.0.0',
        environment: {
          nodeSize: 'xl',
          fileCount: 5000,
          iterations: 20
        },
        expectedMetrics: {
          fileTreeLoad: 5000,
          fileTreeSearch: 1500,
          editorOpen: 500,
          editorRender: 200,
          memoryUsage: 300 * 1024 * 1024
        }
      }
    ]
    
    this.configs = defaultConfigs
  }

  private formatMetric(value: number, metricName: string): string {
    if (metricName.includes('memory')) {
      const mb = value / (1024 * 1024)
      return `${mb.toFixed(2)} MB`
    }
    if (metricName.includes('duration')) {
      return `${value.toFixed(2)}ms`
    }
    return value.toString()
  }

  private generateBenchmarkCSV(results: BenchmarkResult[]): string {
    const headers = [
      'Suite', 'Test', 'Duration(ms)', 'Memory(bytes)', 'FPS', 
      'Passed', 'Environment', 'Timestamp'
    ]
    
    let csv = headers.join(',') + '\n'
    
    results.forEach(result => {
      result.results.forEach(test => {
        const row = [
          result.suiteName,
          test.testName,
          test.duration,
          test.memoryUsage,
          test.metrics.fps || 0,
          test.passed,
          `${result.environment.platform} ${result.environment.cores}c ${result.environment.memory}GB`,
          result.timestamp
        ]
        csv += row.map(cell => `"${cell}"`).join(',') + '\n'
      })
    })
    
    return csv
  }

  private generateBenchmarkReport(results: BenchmarkResult[]): string {
    let report = `# Performance Benchmark Report\n\n`
    report += `Generated: ${new Date().toISOString()}\n\n`
    
    results.forEach(result => {
      report += `## ${result.suiteName}\n\n`
      report += `- **Tests:** ${result.totalTests}\n`
      report += `- **Passed:** ${result.passedTests} (${(result.passedTests / result.totalTests * 100).toFixed(1)}%)\n`
      report += `- **Duration:** ${result.totalDuration}ms\n`
      report += `- **Memory:** ${(result.averageMemoryUsage / (1024 * 1024)).toFixed(2)} MB avg\n\n`
      
      result.results.forEach(test => {
        const status = test.passed ? '✅' : '❌'
        report += `${status} **${test.testName}**: ${test.duration}ms, ${(test.memoryUsage / (1024 * 1024)).toFixed(2)} MB\n`
      })
      
      report += '\n'
    })
    
    return report
  }
}

export default BenchmarkSuite