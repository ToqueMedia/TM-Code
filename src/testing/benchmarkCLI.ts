#!/usr/bin/env node

import { program } from 'commander'
import { BenchmarkRunner } from './benchmarkRunner'
import { BenchmarkReporter } from './benchmarkReporter'
import type { BenchmarkOptions, BenchmarkResult } from './types'

async function main() {
  program
    .name('benchmark-cli')
    .description('ToqueMedia Studio Performance Benchmark CLI')
    .version('1.0.0')

  program
    .option('-o, --output <path>', 'Output file path for results')
    .option('-f, --format <format>', 'Output format (json, csv, markdown)', 'json')
    .option('-s, --suite <name>', 'Specific benchmark suite to run')
    .option('-b, --baseline <path>', 'Baseline file for comparison')
    .option('-r, --regression', 'Run regression analysis')
    .option('--save-baseline <path>', 'Save current results as baseline')
    .option('--timeout <ms>', 'Timeout for individual benchmarks', '30000')
    .option('--iterations <num>', 'Number of iterations per benchmark', '5')
    .option('--warmup <num>', 'Number of warmup iterations', '2')
    .option('--verbose', 'Verbose output')

  program.action(async (options) => {
    try {
      const benchmarkOptions: BenchmarkOptions = {
        suite: options.suite,
        timeout: parseInt(options.timeout),
        iterations: parseInt(options.iterations),
        warmupIterations: parseInt(options.warmup),
        verbose: options.verbose || false,
        baselinePath: options.baseline,
        regression: options.regression || false,
      }

      console.log('🚀 Starting ToqueMedia Studio Performance Benchmarks...\n')
      
      if (options.verbose) {
        console.log('Options:', benchmarkOptions)
      }

      const runner = new BenchmarkRunner(benchmarkOptions)
      const results = await runner.runAllBenchmarks()

      const reporter = new BenchmarkReporter()
      
      // Save baseline if requested
      if (options.saveBaseline) {
        await reporter.saveBaseline(results, options.saveBaseline)
        console.log(`✅ Baseline saved to: ${options.saveBaseline}`)
      }

      // Generate output in requested format
      if (options.output) {
        switch (options.format) {
          case 'json':
            await reporter.generateJSON(results, options.output)
            break
          case 'csv':
            await reporter.generateCSV(results, options.output)
            break
          case 'markdown':
            await reporter.generateMarkdown(results, options.output)
            break
          default:
            throw new Error(`Unsupported format: ${options.format}`)
        }
        console.log(`📊 Results saved to: ${options.output}`)
      } else {
        // Print to console
        console.log(await reporter.generateConsoleReport(results))
      }

      // Run regression analysis if requested
      if (options.regression && options.baseline) {
        const regressionResults = await reporter.analyzeRegression(results, options.baseline)
        
        if (options.output && options.format === 'markdown') {
          const regressionPath = options.output.replace(/\.(md|json|csv)$/, '-regression.$1')
          await reporter.generateRegressionReport(regressionResults, regressionPath)
          console.log(`📈 Regression report saved to: ${regressionPath}`)
        } else {
          console.log('\n📈 Regression Analysis:')
          console.log(await reporter.generateRegressionConsoleReport(regressionResults))
        }

        // Exit with error code if significant regressions found
        const hasSignificantRegression = regressionResults.some(
          result => result.regressionType === 'significant' && result.performanceChange < -10
        )
        
        if (hasSignificantRegression) {
          console.error('\n❌ Significant performance regression detected!')
          process.exit(1)
        }
      }

      console.log('\n✅ Benchmarks completed successfully!')
      
    } catch (error) {
      console.error('\n❌ Benchmark failed:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
  })

  await program.parseAsync()
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}

export { main }