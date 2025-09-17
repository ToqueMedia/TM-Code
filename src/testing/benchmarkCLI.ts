import BenchmarkSuite from './benchmarkSuite'
import type { BenchmarkResult } from './performanceTestRunner'

interface CLIOptions {
  suite?: string
  output?: string
  format?: 'json' | 'csv' | 'markdown'
  baseline?: string
  regression?: boolean
  verbose?: boolean
  compare?: string
  saveBaseline?: string
}

class BenchmarkCLI {
  private benchmarkSuite: BenchmarkSuite

  constructor() {
    this.benchmarkSuite = new BenchmarkSuite()
  }

  async run(args: string[] = []): Promise<void> {
    const options = this.parseArgs(args)

    try {
      if (options.regression && options.baseline) {
        await this.runRegressionTest(options)
      } else if (options.compare) {
        await this.runComparison(options)
      } else if (options.suite) {
        await this.runSingleBenchmark(options)
      } else {
        await this.runAllBenchmarks(options)
      }
    } catch (error) {
      console.error('❌ Benchmark execution failed:', error)
      process.exit(1)
    }
  }

  private async runAllBenchmarks(options: CLIOptions): Promise<void> {
    console.log('🏃 Running all performance benchmarks...\n')

    const startTime = Date.now()
    const results = await this.benchmarkSuite.runAllBenchmarks()
    const duration = Date.now() - startTime

    this.printSummary(results, duration)

    if (options.output) {
      await this.saveResults(results, options)
    }

    if (options.saveBaseline) {
      await this.saveBaseline(results, options.saveBaseline)
    }
  }

  private async runSingleBenchmark(options: CLIOptions): Promise<void> {
    if (!options.suite) {
      throw new Error('Suite name is required')
    }

    console.log(`🏃 Running benchmark: ${options.suite}\n`)

    const startTime = Date.now()
    const result = await this.benchmarkSuite.runBenchmark(options.suite)
    const duration = Date.now() - startTime

    if (!result) {
      console.error(`❌ Benchmark '${options.suite}' not found`)
      process.exit(1)
    }

    this.printSummary([result], duration)

    if (options.output) {
      await this.saveResults([result], options)
    }
  }

  private async runRegressionTest(options: CLIOptions): Promise<void> {
    if (!options.baseline) {
      throw new Error('Baseline file is required for regression testing')
    }

    console.log('🔍 Running regression test against baseline...\n')

    try {
      const baselineContent = await this.loadFile(options.baseline)
      const comparisons = await this.benchmarkSuite.runRegressionTest(baselineContent)

      if (comparisons.length === 0) {
        console.log('⚠️  No comparisons available - baseline might be incompatible')
        return
      }

      let hasRegressions = false
      comparisons.forEach(comparison => {
        console.log(`\n📊 ${comparison.current.suiteName}`)
        console.log(`   Overall improvement: ${comparison.summary.overallImprovement.toFixed(2)}%`)
        console.log(`   Significant changes: ${comparison.summary.significantChanges}`)
        console.log(`   Regressions: ${comparison.summary.regressions}`)

        if (comparison.regression) {
          hasRegressions = true
          console.log('   ❌ Regression detected!')
        } else {
          console.log('   ✅ No regressions')
        }
      })

      if (hasRegressions) {
        console.log('\n⚠️  Performance regressions detected!')
        
        if (options.output) {
          const report = comparisons
            .map(c => this.benchmarkSuite.generateComparisonReport(c))
            .join('\n---\n\n')
          
          await this.saveFile(options.output, report)
          console.log(`📄 Detailed regression report saved to: ${options.output}`)
        }

        process.exit(1)
      } else {
        console.log('\n✅ No performance regressions found!')
      }
    } catch (error) {
      console.error('❌ Failed to load baseline file:', error)
      process.exit(1)
    }
  }

  private async runComparison(options: CLIOptions): Promise<void> {
    if (!options.compare) {
      throw new Error('Compare file is required')
    }

    console.log('🔄 Comparing with previous results...\n')

    try {
      const compareContent = await this.loadFile(options.compare)
      const compareData = JSON.parse(compareContent) as BenchmarkResult[]
      const currentResults = await this.benchmarkSuite.runAllBenchmarks()

      const comparisons = currentResults.map(current => {
        const baseline = compareData.find(b => b.suiteName === current.suiteName)
        if (baseline) {
          return this.benchmarkSuite.compareBenchmarks(baseline, current)
        }
        return null
      }).filter(Boolean)

      comparisons.forEach(comparison => {
        if (!comparison) return
        
        console.log(`\n📊 ${comparison.current.suiteName}`)
        
        const improved = comparison.improvements.filter(i => i.status === 'improved')
        const degraded = comparison.improvements.filter(i => i.status === 'degraded')
        
        if (improved.length > 0) {
          console.log('   ✅ Improvements:')
          improved.forEach(imp => {
            console.log(`      ${imp.metric}: ${imp.improvement.toFixed(2)}% better`)
          })
        }
        
        if (degraded.length > 0) {
          console.log('   ❌ Degradations:')
          degraded.forEach(imp => {
            console.log(`      ${imp.metric}: ${Math.abs(imp.improvement).toFixed(2)}% worse`)
          })
        }
      })

      if (options.output) {
        const report = comparisons
          .map(c => c ? this.benchmarkSuite.generateComparisonReport(c) : '')
          .join('\n---\n\n')
        
        await this.saveFile(options.output, report)
        console.log(`\n📄 Comparison report saved to: ${options.output}`)
      }
    } catch (error) {
      console.error('❌ Failed to load comparison file:', error)
      process.exit(1)
    }
  }

  private printSummary(results: BenchmarkResult[], duration: number): void {
    const totalTests = results.reduce((sum, r) => sum + r.totalTests, 0)
    const passedTests = results.reduce((sum, r) => sum + r.passedTests, 0)
    const failedTests = totalTests - passedTests
    const avgMemory = results.reduce((sum, r) => sum + r.averageMemoryUsage, 0) / results.length

    console.log('\n📈 BENCHMARK SUMMARY')
    console.log('=' .repeat(50))
    console.log(`Suites run:        ${results.length}`)
    console.log(`Total tests:       ${totalTests}`)
    console.log(`Passed:            ${passedTests} (${(passedTests / totalTests * 100).toFixed(1)}%)`)
    console.log(`Failed:            ${failedTests}`)
    console.log(`Execution time:    ${duration}ms`)
    console.log(`Average memory:    ${(avgMemory / (1024 * 1024)).toFixed(2)} MB`)
    console.log('=' .repeat(50))

    // Detalhes por suite
    results.forEach(result => {
      const passRate = (result.passedTests / result.totalTests * 100).toFixed(1)
      const status = result.passedTests === result.totalTests ? '✅' : '❌'
      
      console.log(`${status} ${result.suiteName}: ${result.passedTests}/${result.totalTests} (${passRate}%) - ${result.totalDuration}ms`)
      
      if (result.passedTests !== result.totalTests) {
        const failedTests = result.results.filter(t => !t.passed)
        failedTests.forEach(test => {
          console.log(`   ❌ ${test.testName}: ${test.duration}ms`)
        })
      }
    })

    console.log('')
  }

  private async saveResults(results: BenchmarkResult[], options: CLIOptions): Promise<void> {
    if (!options.output) return

    const format = options.format || 'json'
    let content = ''

    switch (format) {
      case 'json':
        content = JSON.stringify(results, null, 2)
        break
      case 'csv':
        content = this.generateCSV(results)
        break
      case 'markdown':
        content = this.generateMarkdownReport(results)
        break
    }

    await this.saveFile(options.output, content)
    console.log(`📄 Results saved to: ${options.output} (${format} format)`)
  }

  private async saveBaseline(results: BenchmarkResult[], filename: string): Promise<void> {
    const content = JSON.stringify(results, null, 2)
    await this.saveFile(filename, content)
    console.log(`💾 Baseline saved to: ${filename}`)
  }

  private generateCSV(results: BenchmarkResult[]): string {
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

  private generateMarkdownReport(results: BenchmarkResult[]): string {
    let report = `# Performance Benchmark Report\n\n`
    report += `Generated: ${new Date().toISOString()}\n\n`
    
    results.forEach(result => {
      report += `## ${result.suiteName}\n\n`
      report += `- **Tests:** ${result.totalTests}\n`
      report += `- **Passed:** ${result.passedTests} (${(result.passedTests / result.totalTests * 100).toFixed(1)}%)\n`
      report += `- **Duration:** ${result.totalDuration}ms\n`
      report += `- **Memory:** ${(result.averageMemoryUsage / (1024 * 1024)).toFixed(2)} MB avg\n\n`
      
      report += `### Test Results\n\n`
      report += `| Test | Duration | Memory | FPS | Status |\n`
      report += `|------|----------|---------|-----|--------|\n`
      
      result.results.forEach(test => {
        const status = test.passed ? '✅ Pass' : '❌ Fail'
        const memory = (test.memoryUsage / (1024 * 1024)).toFixed(2)
        const fps = test.metrics.fps?.toFixed(1) || 'N/A'
        
        report += `| ${test.testName} | ${test.duration}ms | ${memory}MB | ${fps} | ${status} |\n`
      })
      
      report += '\n'
    })
    
    return report
  }

  private parseArgs(args: string[]): CLIOptions {
    const options: CLIOptions = {}
    
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      
      switch (arg) {
        case '--suite':
        case '-s':
          options.suite = args[++i]
          break
        case '--output':
        case '-o':
          options.output = args[++i]
          break
        case '--format':
        case '-f':
          options.format = args[++i] as 'json' | 'csv' | 'markdown'
          break
        case '--baseline':
        case '-b':
          options.baseline = args[++i]
          break
        case '--compare':
        case '-c':
          options.compare = args[++i]
          break
        case '--save-baseline':
          options.saveBaseline = args[++i]
          break
        case '--regression':
        case '-r':
          options.regression = true
          break
        case '--verbose':
        case '-v':
          options.verbose = true
          break
        case '--help':
        case '-h':
          this.printHelp()
          process.exit(0)
          break
      }
    }
    
    return options
  }

  private printHelp(): void {
    console.log(`
Performance Benchmark CLI

Usage: npm run benchmark [options]

Options:
  -s, --suite <name>         Run specific benchmark suite
  -o, --output <file>        Save results to file
  -f, --format <format>      Output format (json|csv|markdown)
  -b, --baseline <file>      Baseline file for comparison
  -c, --compare <file>       Compare with previous results
  -r, --regression           Run regression test
  --save-baseline <file>     Save results as baseline
  -v, --verbose              Verbose output
  -h, --help                 Show this help

Examples:
  npm run benchmark                           # Run all benchmarks
  npm run benchmark -s small_project          # Run specific suite
  npm run benchmark -o results.json          # Save results to file
  npm run benchmark -f markdown -o report.md  # Generate markdown report
  npm run benchmark -b baseline.json -r      # Regression test
  npm run benchmark -c previous.json         # Compare results
`)
  }

  private async loadFile(filename: string): Promise<string> {
    // Em um ambiente real, você usaria fs.readFile
    // Para este exemplo, vamos simular
    try {
      // return await fs.readFile(filename, 'utf-8')
      throw new Error('File loading not implemented - use fs.readFile in real environment')
    } catch (error) {
      throw new Error(`Failed to load file: ${filename}`)
    }
  }

  private async saveFile(filename: string, content: string): Promise<void> {
    // Em um ambiente real, você usaria fs.writeFile
    // Para este exemplo, vamos simular
    try {
      // await fs.writeFile(filename, content, 'utf-8')
      console.log(`Content would be saved to: ${filename}`)
      console.log(`Content length: ${content.length} characters`)
    } catch (error) {
      throw new Error(`Failed to save file: ${filename}`)
    }
  }
}

// Script para executar via linha de comando
async function main() {
  const cli = new BenchmarkCLI()
  await cli.run(process.argv.slice(2))
}

// Executa se for chamado diretamente
if (require.main === module) {
  main().catch(error => {
    console.error('❌ CLI execution failed:', error)
    process.exit(1)
  })
}

export default BenchmarkCLI