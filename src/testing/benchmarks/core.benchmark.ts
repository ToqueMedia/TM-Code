import type { BenchmarkSuite } from '../types'

const coreBenchmarks: BenchmarkSuite = {
  name: 'core',
  description: 'Core application performance benchmarks',
  benchmarks: [
    {
      name: 'app-startup-simulation',
      description: 'Simulate application startup operations',
      fn: async () => {
        // Simulate React component mounting
        const components = []
        for (let i = 0; i < 100; i++) {
          components.push({
            id: `component-${i}`,
            props: { key: i, name: `Component ${i}` },
            state: { mounted: true, renderCount: 1 }
          })
        }

        // Simulate state initialization
        const initialState = {
          editor: { files: [], activeFile: null, theme: 'dark' },
          terminal: { sessions: [], activeSession: null },
          fileTree: { expanded: new Set(), selected: null },
          project: { info: null, recentProjects: [] }
        }

        // Simulate some async operations
        await Promise.all([
          new Promise(resolve => setTimeout(resolve, 50)),
          new Promise(resolve => setTimeout(resolve, 30)),
          new Promise(resolve => setTimeout(resolve, 20))
        ])

        return { components: components.length, state: initialState }
      }
    },

    {
      name: 'file-tree-operations',
      description: 'Benchmark file tree operations',
      fn: async () => {
        const fileTree = new Map()
        const operations = []

        // Simulate building a large file tree
        for (let i = 0; i < 1000; i++) {
          const path = `/project/src/components/Component${i}.tsx`
          fileTree.set(path, {
            name: `Component${i}.tsx`,
            path,
            type: 'file',
            size: Math.random() * 10000,
            lastModified: Date.now()
          })
        }

        // Simulate file tree filtering
        const filteredFiles = Array.from(fileTree.values()).filter(file => 
          file.name.includes('Component') && file.name.endsWith('.tsx')
        )

        // Simulate tree expansion/collapse operations
        const expanded = new Set()
        for (let i = 0; i < 100; i++) {
          const path = `/project/src/components`
          if (expanded.has(path)) {
            expanded.delete(path)
          } else {
            expanded.add(path)
          }
        }

        return { 
          totalFiles: fileTree.size, 
          filteredFiles: filteredFiles.length,
          expandedPaths: expanded.size 
        }
      }
    },

    {
      name: 'editor-state-management',
      description: 'Benchmark editor state operations',
      fn: () => {
        const editorStates = new Map()
        const operations = []

        // Simulate managing multiple open files
        for (let i = 0; i < 50; i++) {
          const fileName = `file-${i}.ts`
          editorStates.set(fileName, {
            content: 'x'.repeat(1000 + Math.random() * 5000),
            cursor: { line: Math.floor(Math.random() * 100), column: 0 },
            selections: [],
            decorations: new Set(),
            isDirty: Math.random() > 0.5
          })
        }

        // Simulate cursor movements and text changes
        for (let i = 0; i < 200; i++) {
          const fileName = `file-${Math.floor(Math.random() * 50)}.ts`
          const state = editorStates.get(fileName)
          if (state) {
            state.cursor.line += Math.floor(Math.random() * 10) - 5
            state.cursor.column += Math.floor(Math.random() * 10) - 5
            state.isDirty = Math.random() > 0.3
          }
        }

        // Simulate saving operations
        let savedFiles = 0
        for (const [fileName, state] of editorStates) {
          if (state.isDirty) {
            state.isDirty = false
            savedFiles++
          }
        }

        return { 
          openFiles: editorStates.size,
          savedFiles,
          operations: operations.length 
        }
      }
    },

    {
      name: 'search-indexing',
      description: 'Benchmark search index operations',
      fn: () => {
        const searchIndex = new Map()
        const documents = []

        // Create mock documents
        for (let i = 0; i < 500; i++) {
          const doc = {
            id: `doc-${i}`,
            path: `/project/src/file-${i}.ts`,
            content: `
              function component${i}() {
                const state = useState(null)
                const effect = useEffect(() => {
                  // Some effect logic
                }, [])
                return <div>Component ${i}</div>
              }
              export default component${i}
            `.repeat(Math.floor(Math.random() * 10) + 1)
          }
          documents.push(doc)

          // Build search index
          const words = doc.content.toLowerCase().split(/\s+/)
          for (const word of words) {
            if (word.length > 2) {
              if (!searchIndex.has(word)) {
                searchIndex.set(word, new Set())
              }
              searchIndex.get(word)!.add(doc.id)
            }
          }
        }

        // Simulate search queries
        const queries = ['function', 'component', 'useState', 'useEffect', 'export', 'return']
        let totalResults = 0

        for (const query of queries) {
          const results = searchIndex.get(query.toLowerCase()) || new Set()
          totalResults += results.size
        }

        return { 
          documents: documents.length,
          indexedWords: searchIndex.size,
          totalResults
        }
      }
    },

    {
      name: 'memory-cleanup',
      description: 'Test memory cleanup and garbage collection patterns',
      fn: () => {
        const largeObjects = []
        
        // Create large objects that should be cleaned up
        for (let i = 0; i < 100; i++) {
          largeObjects.push({
            data: new Array(1000).fill(Math.random()),
            metadata: {
              id: i,
              timestamp: Date.now(),
              refs: new Set([`ref-${i}`, `ref-${i + 1}`])
            },
            cleanup: () => {
              // Simulate cleanup operations
            }
          })
        }

        // Simulate cleanup
        let cleanedUp = 0
        for (const obj of largeObjects) {
          if (Math.random() > 0.3) {
            obj.cleanup()
            cleanedUp++
          }
        }

        // Clear references
        largeObjects.length = 0

        return { 
          created: 100,
          cleanedUp,
          remaining: 100 - cleanedUp 
        }
      }
    }
  ]
}

export default coreBenchmarks