import * as fs from 'fs/promises'
import * as path from 'path'
import type { BenchmarkResult, RegressionResult, BenchmarkMetrics } from './types'

export class BenchmarkReporter {
  
  async generateJSON(results: BenchmarkResult[], outputPath: string): Promise<void> {
    await this.ensureDir(path.dirname(outputPath))
    await fs.writeFile(outputPath, JSON.stringify(results, null, 2))
  }

  async generateCSV(results: BenchmarkResult[], outputPath: string): Promise<void> {
    const headers = [
      'Suite',
      'Benchmark',
      'Description',
      'Status',
      'Timestamp',
      'Node Version',
      'Platform',
      'Architecture',
      'Memory (GB)',
      'CPUs',
      'Mean Execution Time (ms)',
      'Median Execution Time (ms)',
      'Min Execution Time (ms)',
      'Max Execution Time (ms)',
      'StdDev Execution Time (ms)',
      'Mean Heap Used (MB)',
      'Mean Heap Total (MB)',
      'Mean External (MB)',
      'Mean Array Buffers (MB)',
      'Mean CPU User (ms)',
      'Mean CPU System (ms)',
      'Iterations'
    ]

    const rows = results.map(result => [
      result.suite,
      result.name,
      result.description,
      result.status,
      result.timestamp,
      result.environment.nodeVersion,
      result.environment.platform,
      result.environment.arch,
      (result.environment.memory / 1024 / 1024 / 1024).toFixed(2),
      result.environment.cpus.toString(),
      result.metrics.mean.executionTime.toFixed(2),
      result.metrics.median.executionTime.toFixed(2),
      result.metrics.min.executionTime.toFixed(2),
      result.metrics.max.executionTime.toFixed(2),
      result.metrics.stdDev.executionTime.toFixed(2),
      (result.metrics.mean.memoryUsage.heapUsed / 1024 / 1024).toFixed(2),
      (result.metrics.mean.memoryUsage.heapTotal / 1024 / 1024).toFixed(2),
      (result.metrics.mean.memoryUsage.external / 1024 / 1024).toFixed(2),
      (result.metrics.mean.memoryUsage.arrayBuffers / 1024 / 1024).toFixed(2),
      (result.metrics.mean.cpuUsage.user / 1000).toFixed(2),
      (result.metrics.mean.cpuUsage.system / 1000).toFixed(2),
      result.metrics.iterations.toString()
    ])

    const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n')
    
    await this.ensureDir(path.dirname(outputPath))
    await fs.writeFile(outputPath, csv)
  }

  async generateMarkdown(results: BenchmarkResult[], outputPath: string): Promise<void> {
    const markdown = await this.generateMarkdownContent(results)
    await this.ensureDir(path.dirname(outputPath))
    await fs.writeFile(outputPath, markdown)
  }

  async generateConsoleReport(results: BenchmarkResult[]): Promise<string> {
    const successfulResults = results.filter(r => r.status === 'completed')
    const failedResults = results.filter(r => r.status === 'failed')
    const skippedResults = results.filter(r => r.status === 'skipped')

    let report = '\n📊 Performance Benchmark Results\n'
    report += '='.repeat(50) + '\n\n'

    if (results.length > 0) {
      report += `Environment: ${results[0].environment.nodeVersion} on ${results[0].environment.platform} (${results[0].environment.arch})\n`
      report += `CPUs: ${results[0].environment.cpus}, Memory: ${(results[0].environment.memory / 1024 / 1024 / 1024).toFixed(1)}GB\n\n`
    }

    report += `✅ Completed: ${successfulResults.length}\n`
    report += `❌ Failed: ${failedResults.length}\n`
    report += `⏭️  Skipped: ${skippedResults.length}\n\n`

    if (successfulResults.length > 0) {
      report += 'Benchmark Results:\n'
      report += '-'.repeat(30) + '\n'

      for (const result of successfulResults) {
        const avgTime = result.metrics.mean.executionTime.toFixed(2)
        const stdDev = result.metrics.stdDev.executionTime.toFixed(2)
        const avgMemory = (result.metrics.mean.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)

        report += `\n🏃 ${result.suite}/${result.name}\n`
        report += `   Time: ${avgTime}ms ± ${stdDev}ms\n`
        report += `   Memory: ${avgMemory}MB heap\n`
        report += `   Iterations: ${result.metrics.iterations}\n`
      }
    }

    if (failedResults.length > 0) {
      report += '\n\nFailed Benchmarks:\n'
      report += '-'.repeat(30) + '\n'
      
      for (const result of failedResults) {
        report += `\n❌ ${result.suite}/${result.name}\n`
        report += `   Error: ${result.error}\n`
      }
    }

    return report
  }

  async saveBaseline(results: BenchmarkResult[], baselinePath: string): Promise<void> {
    await this.ensureDir(path.dirname(baselinePath))
    await fs.writeFile(baselinePath, JSON.stringify(results, null, 2))
  }

  async analyzeRegression(
    currentResults: BenchmarkResult[], 
    baselinePath: string
  ): Promise<RegressionResult[]> {
    try {
      const baselineData = await fs.readFile(baselinePath, 'utf-8')
      const baselineResults: BenchmarkResult[] = JSON.parse(baselineData)

      const regressionResults: RegressionResult[] = []

      for (const current of currentResults) {
        const baseline = baselineResults.find(
          b => b.name === current.name && b.suite === current.suite
        )

        if (baseline && current.status === 'completed' && baseline.status === 'completed') {
          const performanceChange = (
            (current.metrics.mean.executionTime - baseline.metrics.mean.executionTime) /
            baseline.metrics.mean.executionTime
          ) * 100

          const memoryChange = (
            (current.metrics.mean.memoryUsage.heapUsed - baseline.metrics.mean.memoryUsage.heapUsed) /
            baseline.metrics.mean.memoryUsage.heapUsed
          ) * 100

          let regressionType: RegressionResult['regressionType'] = 'none'
          
          if (performanceChange > 20) {
            regressionType = 'significant'
          } else if (performanceChange > 10) {
            regressionType = 'moderate'
          } else if (performanceChange > 5) {
            regressionType = 'minor'
          }

          regressionResults.push({
            benchmarkName: current.name,
            suite: current.suite,
            current: current.metrics.mean,
            baseline: baseline.metrics.mean,
            performanceChange,
            memoryChange,
            regressionType,
            details: {
              executionTimeDiff: current.metrics.mean.executionTime - baseline.metrics.mean.executionTime,
              memoryDiff: current.metrics.mean.memoryUsage.heapUsed - baseline.metrics.mean.memoryUsage.heapUsed,
              cpuDiff: current.metrics.mean.cpuUsage.user - baseline.metrics.mean.cpuUsage.user,
            }
          })
        }
      }

      return regressionResults

    } catch (error) {
      throw new Error(`Failed to analyze regression: ${error instanceof Error ? error.message : error}`)
    }
  }

  async generateRegressionReport(
    regressionResults: RegressionResult[], 
    outputPath: string
  ): Promise<void> {
    let report = '# Performance Regression Analysis\n\n'
    
    const significant = regressionResults.filter(r => r.regressionType === 'significant')
    const moderate = regressionResults.filter(r => r.regressionType === 'moderate')
    const minor = regressionResults.filter(r => r.regressionType === 'minor')
    const none = regressionResults.filter(r => r.regressionType === 'none')

    report += `## Summary\n\n`
    report += `- 🔴 Significant regressions: ${significant.length}\n`
    report += `- 🟡 Moderate regressions: ${moderate.length}\n`
    report += `- 🟠 Minor regressions: ${minor.length}\n`
    report += `- 🟢 No regression: ${none.length}\n\n`

    if (significant.length > 0) {
      report += `## ❌ Significant Regressions (>20%)\n\n`
      for (const result of significant) {
        report += this.formatRegressionResult(result)
      }
    }

    if (moderate.length > 0) {
      report += `## ⚠️  Moderate Regressions (10-20%)\n\n`
      for (const result of moderate) {
        report += this.formatRegressionResult(result)
      }
    }

    if (minor.length > 0) {
      report += `## ℹ️  Minor Regressions (5-10%)\n\n`
      for (const result of minor) {
        report += this.formatRegressionResult(result)
      }
    }

    await this.ensureDir(path.dirname(outputPath))
    await fs.writeFile(outputPath, report)
  }

  async generateRegressionConsoleReport(regressionResults: RegressionResult[]): Promise<string> {
    let report = ''
    
    const significant = regressionResults.filter(r => r.regressionType === 'significant')
    const moderate = regressionResults.filter(r => r.regressionType === 'moderate')
    const minor = regressionResults.filter(r => r.regressionType === 'minor')

    if (significant.length > 0) {
      report += '\n🔴 Significant Regressions (>20%):\n'
      for (const result of significant) {
        report += `   ${result.suite}/${result.benchmarkName}: ${result.performanceChange.toFixed(1)}% slower\n`
      }
    }

    if (moderate.length > 0) {
      report += '\n🟡 Moderate Regressions (10-20%):\n'
      for (const result of moderate) {
        report += `   ${result.suite}/${result.benchmarkName}: ${result.performanceChange.toFixed(1)}% slower\n`
      }
    }

    if (minor.length > 0) {
      report += '\n🟠 Minor Regressions (5-10%):\n'
      for (const result of minor) {
        report += `   ${result.suite}/${result.benchmarkName}: ${result.performanceChange.toFixed(1)}% slower\n`
      }
    }

    if (significant.length === 0 && moderate.length === 0 && minor.length === 0) {
      report += '\n🟢 No significant regressions detected!\n'
    }

    return report
  }

  private async generateMarkdownContent(results: BenchmarkResult[]): Promise<string> {
    const successfulResults = results.filter(r => r.status === 'completed')
    const failedResults = results.filter(r => r.status === 'failed')

    let markdown = '# Performance Benchmark Results\n\n'
    
    if (results.length > 0) {
      markdown += `**Environment:** ${results[0].environment.nodeVersion} on ${results[0].environment.platform} (${results[0].environment.arch})\n`
      markdown += `**CPUs:** ${results[0].environment.cpus}, **Memory:** ${(results[0].environment.memory / 1024 / 1024 / 1024).toFixed(1)}GB\n\n`
    }

    markdown += `## Summary\n\n`
    markdown += `- ✅ Completed: ${successfulResults.length}\n`
    markdown += `- ❌ Failed: ${failedResults.length}\n\n`

    if (successfulResults.length > 0) {
      markdown += `## Benchmark Results\n\n`
      markdown += `| Suite | Benchmark | Mean Time (ms) | StdDev (ms) | Mean Memory (MB) | Iterations |\n`
      markdown += `|-------|-----------|----------------|-------------|------------------|------------|\n`

      for (const result of successfulResults) {
        const avgTime = result.metrics.mean.executionTime.toFixed(2)
        const stdDev = result.metrics.stdDev.executionTime.toFixed(2)
        const avgMemory = (result.metrics.mean.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)

        markdown += `| ${result.suite} | ${result.name} | ${avgTime} | ${stdDev} | ${avgMemory} | ${result.metrics.iterations} |\n`
      }
    }

    if (failedResults.length > 0) {
      markdown += `\n## Failed Benchmarks\n\n`
      for (const result of failedResults) {
        markdown += `- ❌ **${result.suite}/${result.name}**: ${result.error}\n`
      }
    }

    return markdown
  }

  private formatRegressionResult(result: RegressionResult): string {
    let report = `### ${result.suite}/${result.benchmarkName}\n\n`
    report += `- **Performance Change**: ${result.performanceChange > 0 ? '+' : ''}${result.performanceChange.toFixed(1)}%\n`
    report += `- **Memory Change**: ${result.memoryChange > 0 ? '+' : ''}${result.memoryChange.toFixed(1)}%\n`
    report += `- **Execution Time**: ${result.current.executionTime.toFixed(2)}ms vs ${result.baseline.executionTime.toFixed(2)}ms\n`
    report += `- **Memory Usage**: ${(result.current.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB vs ${(result.baseline.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB\n\n`
    return report
  }

  private async ensureDir(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true })
    } catch (error) {
      // Directory might already exist, which is fine
    }
  }
}