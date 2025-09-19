export interface BenchmarkOptions {
  suite?: string
  timeout: number
  iterations: number
  warmupIterations: number
  verbose: boolean
  baselinePath?: string
  regression: boolean
}

export interface BenchmarkMetrics {
  executionTime: number
  memoryUsage: {
    heapUsed: number
    heapTotal: number
    external: number
    arrayBuffers: number
  }
  cpuUsage: {
    user: number
    system: number
  }
}

export interface BenchmarkResult {
  name: string
  suite: string
  description: string
  timestamp: string
  environment: {
    nodeVersion: string
    platform: string
    arch: string
    memory: number
    cpus: number
  }
  metrics: {
    mean: BenchmarkMetrics
    median: BenchmarkMetrics
    min: BenchmarkMetrics
    max: BenchmarkMetrics
    stdDev: BenchmarkMetrics
    iterations: number
  }
  rawResults: BenchmarkMetrics[]
  status: 'completed' | 'failed' | 'timeout' | 'skipped'
  error?: string
}

export interface RegressionResult {
  benchmarkName: string
  suite: string
  current: BenchmarkMetrics
  baseline: BenchmarkMetrics
  performanceChange: number // percentage change
  memoryChange: number // percentage change
  regressionType: 'none' | 'minor' | 'moderate' | 'significant'
  details: {
    executionTimeDiff: number
    memoryDiff: number
    cpuDiff: number
  }
}

export interface BenchmarkSuite {
  name: string
  description: string
  setup?: () => Promise<void>
  teardown?: () => Promise<void>
  benchmarks: BenchmarkFunction[]
}

export interface BenchmarkFunction {
  name: string
  description: string
  fn: () => Promise<void> | void
  setup?: () => Promise<void> | void
  teardown?: () => Promise<void> | void
  skip?: boolean
  timeout?: number
}

export interface SystemInfo {
  nodeVersion: string
  platform: string
  arch: string
  memory: number
  cpus: number
  loadAverage: number[]
  timestamp: string
}