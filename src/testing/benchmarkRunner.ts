import * as os from 'os'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { 
  BenchmarkOptions, 
  BenchmarkResult, 
  BenchmarkMetrics, 
  BenchmarkSuite,
  BenchmarkFunction,
  SystemInfo
} from './types'

export class BenchmarkRunner {
  private options: BenchmarkOptions
  private suites: BenchmarkSuite[] = []

  constructor(options: BenchmarkOptions) {
    this.options = options
  }

  async runAllBenchmarks(): Promise<BenchmarkResult[]> {
    await this.loadBenchmarkSuites()
    
    const systemInfo = this.getSystemInfo()
    const results: BenchmarkResult[] = []

    console.log(`📋 Found ${this.suites.length} benchmark suite(s)`)
    
    for (const suite of this.suites) {
      if (this.options.suite && suite.name !== this.options.suite) {
        continue
      }

      console.log(`\n🧪 Running suite: ${suite.name}`)
      
      if (suite.setup) {
        await suite.setup()
      }

      try {
        for (const benchmark of suite.benchmarks) {
          if (benchmark.skip) {
            console.log(`  ⏭️  Skipping: ${benchmark.name}`)
            continue
          }

          const result = await this.runSingleBenchmark(benchmark, suite, systemInfo)
          results.push(result)
        }
      } finally {
        if (suite.teardown) {
          await suite.teardown()
        }
      }
    }

    return results
  }

  private async runSingleBenchmark(
    benchmark: BenchmarkFunction, 
    suite: BenchmarkSuite, 
    systemInfo: SystemInfo
  ): Promise<BenchmarkResult> {
    const result: BenchmarkResult = {
      name: benchmark.name,
      suite: suite.name,
      description: benchmark.description,
      timestamp: new Date().toISOString(),
      environment: {
        nodeVersion: systemInfo.nodeVersion,
        platform: systemInfo.platform,
        arch: systemInfo.arch,
        memory: systemInfo.memory,
        cpus: systemInfo.cpus,
      },
      metrics: {
        mean: {} as BenchmarkMetrics,
        median: {} as BenchmarkMetrics,
        min: {} as BenchmarkMetrics,
        max: {} as BenchmarkMetrics,
        stdDev: {} as BenchmarkMetrics,
        iterations: 0,
      },
      rawResults: [],
      status: 'completed',
    }

    console.log(`  🏃 ${benchmark.name}...`)

    try {
      // Warmup iterations
      for (let i = 0; i < this.options.warmupIterations; i++) {
        if (this.options.verbose) {
          console.log(`    🔥 Warmup ${i + 1}/${this.options.warmupIterations}`)
        }
        await this.runBenchmarkIteration(benchmark, true)
      }

      // Actual benchmark iterations
      const rawResults: BenchmarkMetrics[] = []
      
      for (let i = 0; i < this.options.iterations; i++) {
        if (this.options.verbose) {
          console.log(`    📊 Iteration ${i + 1}/${this.options.iterations}`)
        }
        
        const metrics = await this.runBenchmarkIteration(benchmark, false)
        rawResults.push(metrics)
      }

      result.rawResults = rawResults
      result.metrics = this.calculateStatistics(rawResults)
      result.metrics.iterations = rawResults.length

      const avgTime = result.metrics.mean.executionTime.toFixed(2)
      const avgMemory = (result.metrics.mean.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)
      
      console.log(`    ✅ ${avgTime}ms (${avgMemory}MB heap)`)

    } catch (error) {
      result.status = 'failed'
      result.error = error instanceof Error ? error.message : String(error)
      console.log(`    ❌ Failed: ${result.error}`)
    }

    return result
  }

  private async runBenchmarkIteration(
    benchmark: BenchmarkFunction, 
    isWarmup: boolean
  ): Promise<BenchmarkMetrics> {
    // Setup
    if (benchmark.setup) {
      await benchmark.setup()
    }

    try {
      // Force garbage collection if available
      if (global.gc) {
        global.gc()
      }

      const startCpu = process.cpuUsage()
      const startMemory = process.memoryUsage()
      const startTime = process.hrtime.bigint()

      // Run the benchmark
      const timeout = benchmark.timeout || this.options.timeout
      const benchmarkPromise = Promise.resolve(benchmark.fn())
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Benchmark timeout after ${timeout}ms`)), timeout)
      })

      await Promise.race([benchmarkPromise, timeoutPromise])

      const endTime = process.hrtime.bigint()
      const endCpu = process.cpuUsage(startCpu)
      const endMemory = process.memoryUsage()

      return {
        executionTime: Number(endTime - startTime) / 1000000, // Convert to milliseconds
        memoryUsage: {
          heapUsed: endMemory.heapUsed,
          heapTotal: endMemory.heapTotal,
          external: endMemory.external,
          arrayBuffers: endMemory.arrayBuffers,
        },
        cpuUsage: {
          user: endCpu.user,
          system: endCpu.system,
        }
      }

    } finally {
      // Teardown
      if (benchmark.teardown) {
        await benchmark.teardown()
      }
    }
  }

  private calculateStatistics(results: BenchmarkMetrics[]): {
    mean: BenchmarkMetrics
    median: BenchmarkMetrics
    min: BenchmarkMetrics
    max: BenchmarkMetrics
    stdDev: BenchmarkMetrics
    iterations: number
  } {
    const sortedByTime = [...results].sort((a, b) => a.executionTime - b.executionTime)
    
    const mean: BenchmarkMetrics = {
      executionTime: results.reduce((sum, r) => sum + r.executionTime, 0) / results.length,
      memoryUsage: {
        heapUsed: results.reduce((sum, r) => sum + r.memoryUsage.heapUsed, 0) / results.length,
        heapTotal: results.reduce((sum, r) => sum + r.memoryUsage.heapTotal, 0) / results.length,
        external: results.reduce((sum, r) => sum + r.memoryUsage.external, 0) / results.length,
        arrayBuffers: results.reduce((sum, r) => sum + r.memoryUsage.arrayBuffers, 0) / results.length,
      },
      cpuUsage: {
        user: results.reduce((sum, r) => sum + r.cpuUsage.user, 0) / results.length,
        system: results.reduce((sum, r) => sum + r.cpuUsage.system, 0) / results.length,
      }
    }

    const median = sortedByTime[Math.floor(sortedByTime.length / 2)]
    const min = sortedByTime[0]
    const max = sortedByTime[sortedByTime.length - 1]

    // Calculate standard deviation
    const variance = results.reduce((sum, r) => sum + Math.pow(r.executionTime - mean.executionTime, 2), 0) / results.length
    const stdDev: BenchmarkMetrics = {
      executionTime: Math.sqrt(variance),
      memoryUsage: {
        heapUsed: Math.sqrt(results.reduce((sum, r) => sum + Math.pow(r.memoryUsage.heapUsed - mean.memoryUsage.heapUsed, 2), 0) / results.length),
        heapTotal: Math.sqrt(results.reduce((sum, r) => sum + Math.pow(r.memoryUsage.heapTotal - mean.memoryUsage.heapTotal, 2), 0) / results.length),
        external: Math.sqrt(results.reduce((sum, r) => sum + Math.pow(r.memoryUsage.external - mean.memoryUsage.external, 2), 0) / results.length),
        arrayBuffers: Math.sqrt(results.reduce((sum, r) => sum + Math.pow(r.memoryUsage.arrayBuffers - mean.memoryUsage.arrayBuffers, 2), 0) / results.length),
      },
      cpuUsage: {
        user: Math.sqrt(results.reduce((sum, r) => sum + Math.pow(r.cpuUsage.user - mean.cpuUsage.user, 2), 0) / results.length),
        system: Math.sqrt(results.reduce((sum, r) => sum + Math.pow(r.cpuUsage.system - mean.cpuUsage.system, 2), 0) / results.length),
      }
    }

    return { mean, median, min, max, stdDev, iterations: results.length }
  }

  private async loadBenchmarkSuites(): Promise<void> {
    const benchmarkDir = path.join(process.cwd(), 'src', 'testing', 'benchmarks')
    
    try {
      const files = await fs.readdir(benchmarkDir)
      const suiteFiles = files.filter(file => file.endsWith('.benchmark.ts') || file.endsWith('.benchmark.js'))
      
      for (const file of suiteFiles) {
        try {
          const suitePath = path.join(benchmarkDir, file)
          const suite = await import(suitePath)
          
          if (suite.default && typeof suite.default === 'object') {
            this.suites.push(suite.default as BenchmarkSuite)
          }
        } catch (error) {
          console.warn(`⚠️  Failed to load benchmark suite from ${file}:`, error)
        }
      }
      
      if (this.suites.length === 0) {
        // Create default benchmarks if no suite files found
        this.suites = this.createDefaultBenchmarks()
      }
    } catch (error) {
      console.warn('⚠️  Benchmark directory not found, using default benchmarks')
      this.suites = this.createDefaultBenchmarks()
    }
  }

  private createDefaultBenchmarks(): BenchmarkSuite[] {
    return [
      {
        name: 'core',
        description: 'Core application performance benchmarks',
        benchmarks: [
          {
            name: 'startup-time',
            description: 'Measure application startup time',
            fn: async () => {
              // Simulate app startup operations
              await new Promise(resolve => setTimeout(resolve, 100))
              
              // Simulate some CPU work
              let sum = 0
              for (let i = 0; i < 100000; i++) {
                sum += Math.random()
              }
              return sum
            }
          },
          {
            name: 'memory-allocation',
            description: 'Test memory allocation patterns',
            fn: () => {
              const arrays = []
              for (let i = 0; i < 1000; i++) {
                arrays.push(new Array(1000).fill(Math.random()))
              }
              return arrays.length
            }
          },
          {
            name: 'file-operations',
            description: 'Test file system operations',
            fn: async () => {
              const tempDir = path.join(os.tmpdir(), 'benchmark-test')
              await fs.mkdir(tempDir, { recursive: true })
              
              for (let i = 0; i < 10; i++) {
                const content = 'x'.repeat(1000)
                await fs.writeFile(path.join(tempDir, `test-${i}.txt`), content)
              }
              
              const files = await fs.readdir(tempDir)
              
              // Cleanup
              for (const file of files) {
                await fs.unlink(path.join(tempDir, file))
              }
              await fs.rmdir(tempDir)
              
              return files.length
            }
          }
        ]
      }
    ]
  }

  private getSystemInfo(): SystemInfo {
    return {
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      memory: os.totalmem(),
      cpus: os.cpus().length,
      loadAverage: os.loadavg(),
      timestamp: new Date().toISOString(),
    }
  }
}