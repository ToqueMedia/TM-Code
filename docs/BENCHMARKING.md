# Performance Benchmarking Suite

A comprehensive performance benchmarking system for ToqueMedia Studio that provides automated testing, regression detection, and performance monitoring capabilities.

## Overview

The benchmarking suite consists of several components working together to ensure optimal application performance:

- **BenchmarkSuite**: Main orchestrator for running performance tests
- **PerformanceTestRunner**: Framework for executing individual performance tests
- **BenchmarkCLI**: Command-line interface for running benchmarks
- **GitHub Actions**: Automated CI/CD integration
- **Monitoring**: Real-time performance tracking and alerting

## Features

### 🚀 Automated Benchmark Suites

Pre-configured benchmark suites for different project sizes:

- **Small Project**: ~50 files, 5 iterations
- **Medium Project**: ~500 files, 10 iterations  
- **Large Project**: ~2000 files, 15 iterations
- **XL Project**: ~5000+ files, 20 iterations

### 📊 Comprehensive Metrics

Each test measures:

- **Duration**: Execution time in milliseconds
- **Memory Usage**: RAM consumption in bytes
- **FPS**: Frames per second for UI operations
- **Error Rate**: Failed operations percentage
- **Throughput**: Operations per second

### 🔍 Regression Detection

Automatically compares current performance against baselines:

- **Performance Thresholds**: Configurable limits for each metric
- **Change Detection**: Identifies significant performance changes (>5% duration, >10% memory)
- **Regression Alerts**: Fails CI/CD pipeline on performance degradation
- **Historical Tracking**: Maintains performance history over time

### 📈 Reporting & Visualization

Multiple output formats:

- **JSON**: Machine-readable data for integration
- **CSV**: Data analysis and spreadsheet import
- **Markdown**: Human-readable reports with visualizations
- **GitHub Comments**: Automatic PR performance summaries

## Getting Started

### Prerequisites

```bash
# Install dependencies (tsx for TypeScript execution)
npm install --save-dev tsx

# Or use globally
npm install -g tsx
```

### Basic Usage

```bash
# Run all benchmark suites
npm run benchmark

# Run specific suite
npm run benchmark -- --suite small_project

# Save results to file
npm run benchmark -- --output results.json

# Generate markdown report
npm run benchmark -- --format markdown --output report.md

# Run regression test against baseline
npm run benchmark -- --baseline baseline.json --regression
```

### Advanced Usage

```bash
# Compare with previous results
npm run benchmark -- --compare previous-results.json

# Save current results as new baseline
npm run benchmark -- --save-baseline new-baseline.json

# Verbose output
npm run benchmark -- --verbose

# Generate CSV for data analysis
npm run benchmark -- --format csv --output data.csv
```

## Configuration

### Custom Benchmark Configuration

```typescript
import BenchmarkSuite from './src/testing/benchmarkSuite'

const suite = new BenchmarkSuite()

// Add custom benchmark
suite.addBenchmark({
  name: 'custom_test',
  description: 'Custom performance test',
  version: '1.0.0',
  environment: {
    nodeSize: 'medium',
    fileCount: 1000,
    iterations: 8
  },
  expectedMetrics: {
    fileTreeLoad: 1200,
    fileTreeSearch: 400,
    editorOpen: 250,
    editorRender: 100,
    memoryUsage: 80 * 1024 * 1024
  }
})

// Run custom benchmark
const results = await suite.runBenchmark('custom_test')
```

### Performance Thresholds

Configure expected performance limits:

```typescript
// Test configuration with thresholds
{
  name: 'fileTree_load',
  expectedThresholds: {
    maxDuration: 1000,        // Maximum 1 second
    maxMemoryUsage: 50 * 1024 * 1024,  // Maximum 50MB
    minFPS: 30               // Minimum 30 FPS
  }
}
```

## CI/CD Integration

### GitHub Actions

The included workflow (`.github/workflows/performance-benchmarks.yml`) provides:

- **Automated Testing**: Runs on every push/PR
- **Multi-Version Testing**: Tests across Node.js versions
- **Regression Detection**: Compares against baseline
- **PR Comments**: Posts results directly to pull requests
- **Artifact Storage**: Saves results for historical comparison
- **Scheduled Runs**: Daily performance monitoring

### Workflow Triggers

- `push` to main/develop branches
- `pull_request` to main branch
- `schedule`: Daily at 2 AM UTC
- `workflow_dispatch`: Manual execution

### Workflow Inputs

```yaml
# Manual trigger with options
workflow_dispatch:
  inputs:
    suite:
      description: 'Specific benchmark suite to run'
      required: false
    baseline:
      description: 'Run regression test'
      type: boolean
      default: false
```

## Test Categories

### File Tree Operations

- **Loading**: Initial file tree construction
- **Search**: File/folder search performance
- **Filtering**: Applying search filters
- **Sorting**: Tree node sorting operations

### Editor Operations

- **File Opening**: Loading files into editor
- **Rendering**: Monaco Editor rendering performance
- **Syntax Highlighting**: Code highlighting speed
- **Large Files**: Handling files >1MB

### Memory Operations

- **Stress Testing**: Multiple file operations
- **Garbage Collection**: Memory cleanup efficiency
- **Memory Leaks**: Long-running operation monitoring
- **Cache Performance**: LRU cache effectiveness

### Integration Tests

- **User Workflows**: Simulated user interactions
- **Batch Operations**: Multiple operations in sequence
- **Real-world Scenarios**: Typical development workflows

## Performance Monitoring

### Real-time Monitoring

```typescript
import PerformanceMonitor from './src/services/performanceMonitor'

const monitor = PerformanceMonitor.getInstance()

// Start monitoring
monitor.startMonitoring()

// Get current metrics
const metrics = monitor.getCurrentMetrics()

// Generate report
const report = monitor.generateReport()
```

### Performance Alerts

```typescript
import PerformanceAlerting from './src/services/performanceAlerting'

const alerting = PerformanceAlerting.getInstance()

// Configure thresholds
alerting.setThreshold('memory', 100 * 1024 * 1024, 'warning')
alerting.setThreshold('fps', 20, 'critical')

// Monitor and alert
setInterval(() => {
  const metrics = getPerformanceMetrics()
  alerting.checkAlerts(metrics)
}, 1000)
```

## Best Practices

### 1. Consistent Environment

- Use same Node.js version for comparisons
- Clear system cache before benchmarking
- Run on same hardware/OS when possible
- Close unnecessary applications

### 2. Statistical Significance

- Run multiple iterations (minimum 3)
- Calculate averages and standard deviation
- Ignore first run (warm-up)
- Use appropriate sample sizes

### 3. Baseline Management

- Update baselines after major changes
- Keep separate baselines per environment
- Archive historical baselines
- Document baseline changes

### 4. Regression Thresholds

- Set realistic thresholds (5-10%)
- Consider test variance
- Separate thresholds by metric type
- Review thresholds regularly

### 5. Result Analysis

- Look for trends over time
- Compare across different environments
- Investigate significant changes
- Document performance improvements

## Troubleshooting

### Common Issues

**High Test Variance**
```bash
# Solution: Run more iterations
npm run benchmark -- --iterations 10

# Or check system load
htop  # Linux/macOS
taskmgr  # Windows
```

**Memory Issues**
```bash
# Solution: Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096" npm run benchmark
```

**Baseline Compatibility**
```bash
# Solution: Update baseline format
npm run benchmark -- --save-baseline new-format-baseline.json
```

**CI/CD Failures**
```bash
# Check GitHub Actions logs
# Update Node.js version in workflow
# Verify artifact retention settings
```

### Performance Debugging

```typescript
// Enable detailed profiling
import PerformanceProfiler from './src/services/performanceProfiler'

const profiler = PerformanceProfiler.getInstance()

// Profile component rendering
profiler.profileComponent('FileTree', () => {
  return <FileTree />
})

// Profile async operations
await profiler.profileAsync('loadFileTree', async () => {
  return await loadFileTree(path)
})

// Get performance report
const report = profiler.generateReport()
```

## API Reference

### BenchmarkSuite

```typescript
class BenchmarkSuite {
  addBenchmark(config: BenchmarkConfig): void
  runAllBenchmarks(): Promise<BenchmarkResult[]>
  runBenchmark(name: string): Promise<BenchmarkResult | null>
  compareBenchmarks(baseline: BenchmarkResult, current: BenchmarkResult): BenchmarkComparison
  exportBenchmarks(format: 'json' | 'csv' | 'markdown'): string
  runRegressionTest(baselineFile?: string): Promise<BenchmarkComparison[]>
}
```

### BenchmarkCLI

```typescript
class BenchmarkCLI {
  run(args: string[]): Promise<void>
  
  // CLI Options
  --suite, -s <name>         // Run specific suite
  --output, -o <file>        // Save results
  --format, -f <format>      // Output format
  --baseline, -b <file>      // Baseline for comparison
  --regression, -r           // Run regression test
  --compare, -c <file>       // Compare with previous
  --save-baseline <file>     // Save as baseline
  --verbose, -v              // Verbose output
}
```

### Performance Test Structure

```typescript
interface PerformanceTest {
  name: string
  description: string
  setup?: () => Promise<any>
  test: (setupData?: any) => Promise<void>
  cleanup?: (setupData?: any) => Promise<void>
  expectedThresholds: {
    maxDuration?: number
    maxMemoryUsage?: number
    minFPS?: number
  }
  tags: string[]
}
```

## Metrics Reference

### Duration Metrics
- **File Tree Load**: Time to load and parse file structure
- **Search Operations**: Time to filter/search within tree
- **Editor Operations**: File opening and rendering time
- **UI Rendering**: Component render and update time

### Memory Metrics
- **Peak Memory**: Maximum memory usage during test
- **Memory Delta**: Memory difference before/after test
- **Garbage Collection**: Memory reclamation efficiency
- **Memory Leaks**: Persistent memory growth

### Performance Grades

| Grade | Duration | Memory | FPS | Description |
|-------|----------|---------|-----|-------------|
| A+ | <100ms | <10MB | >60fps | Excellent |
| A | <200ms | <20MB | >30fps | Good |
| B | <500ms | <50MB | >20fps | Acceptable |
| C | <1000ms | <100MB | >15fps | Poor |
| F | >1000ms | >100MB | <15fps | Unacceptable |

## Contributing

### Adding New Tests

1. Create test in appropriate benchmark config
2. Define expected thresholds
3. Add test tags for categorization
4. Update documentation
5. Verify test reliability (run 10+ times)

### Improving Performance

1. Run benchmark to establish baseline
2. Implement optimizations
3. Re-run benchmark to measure improvement
4. Update baseline if significant improvement
5. Document changes and reasoning

## Changelog

### v1.0.0
- Initial benchmark suite implementation
- Basic performance test framework
- CLI interface and GitHub Actions integration
- Regression detection and reporting

### Future Improvements
- [ ] Web Workers performance testing
- [ ] Memory leak detection
- [ ] Performance budgets
- [ ] Historical trend analysis
- [ ] Performance profiling integration
- [ ] Automated optimization suggestions