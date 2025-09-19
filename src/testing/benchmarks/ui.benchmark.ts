import type { BenchmarkSuite } from '../types'

const uiBenchmarks: BenchmarkSuite = {
  name: 'ui',
  description: 'UI and rendering performance benchmarks',
  benchmarks: [
    {
      name: 'virtual-scrolling',
      description: 'Benchmark virtual scrolling for large file trees',
      fn: () => {
        const items = []
        const viewport = { height: 600, itemHeight: 24 }
        const visibleCount = Math.ceil(viewport.height / viewport.itemHeight)

        // Create large dataset
        for (let i = 0; i < 10000; i++) {
          items.push({
            id: `item-${i}`,
            name: `File ${i}.ts`,
            path: `/project/src/file-${i}.ts`,
            type: Math.random() > 0.3 ? 'file' : 'directory',
            depth: Math.floor(Math.random() * 5),
            expanded: Math.random() > 0.7
          })
        }

        // Simulate virtual scrolling calculations
        let renderedItems = 0
        for (let scrollTop = 0; scrollTop < items.length * viewport.itemHeight; scrollTop += viewport.itemHeight * 5) {
          const startIndex = Math.floor(scrollTop / viewport.itemHeight)
          const endIndex = Math.min(startIndex + visibleCount + 5, items.length) // 5 buffer items
          
          const visibleItems = items.slice(startIndex, endIndex)
          renderedItems += visibleItems.length
        }

        return { 
          totalItems: items.length,
          renderedItems,
          viewportHeight: viewport.height,
          itemHeight: viewport.itemHeight
        }
      }
    },

    {
      name: 'theme-switching',
      description: 'Benchmark theme switching performance',
      fn: () => {
        const themes = {
          light: {
            colors: {
              bg: '#ffffff',
              text: '#000000',
              border: '#e0e0e0',
              accent: '#0066cc'
            },
            shadows: {
              sm: '0 1px 2px rgba(0,0,0,0.05)',
              md: '0 4px 6px rgba(0,0,0,0.1)'
            }
          },
          dark: {
            colors: {
              bg: '#1a1a1a',
              text: '#ffffff',
              border: '#333333',
              accent: '#4da6ff'
            },
            shadows: {
              sm: '0 1px 2px rgba(255,255,255,0.05)',
              md: '0 4px 6px rgba(255,255,255,0.1)'
            }
          }
        }

        const components = []
        
        // Simulate component theme updates
        for (let i = 0; i < 1000; i++) {
          components.push({
            id: `component-${i}`,
            type: ['Button', 'Input', 'Panel', 'Icon'][Math.floor(Math.random() * 4)],
            styles: {}
          })
        }

        // Simulate theme switching
        let switchCount = 0
        for (let iteration = 0; iteration < 10; iteration++) {
          const currentTheme = iteration % 2 === 0 ? themes.light : themes.dark
          
          for (const component of components) {
            component.styles = {
              backgroundColor: currentTheme.colors.bg,
              color: currentTheme.colors.text,
              borderColor: currentTheme.colors.border,
              boxShadow: currentTheme.shadows.sm
            }
          }
          switchCount++
        }

        return {
          components: components.length,
          themesSwitched: switchCount,
          themes: Object.keys(themes).length
        }
      }
    },

    {
      name: 'monaco-editor-operations',
      description: 'Simulate Monaco Editor operations',
      fn: () => {
        const editorContent = `
          import React, { useState, useEffect } from 'react'
          import { Box, Button, Input } from '@chakra-ui/react'
          
          export default function Component() {
            const [state, setState] = useState('')
            
            useEffect(() => {
              // Effect logic
            }, [state])
            
            return (
              <Box>
                <Input value={state} onChange={(e) => setState(e.target.value)} />
                <Button onClick={() => console.log(state)}>Log State</Button>
              </Box>
            )
          }
        `.repeat(50) // Make it larger

        const operations = []
        
        // Simulate text operations
        let content = editorContent
        let operationCount = 0

        for (let i = 0; i < 100; i++) {
          const operation = Math.random()
          
          if (operation < 0.3) {
            // Insert text
            const position = Math.floor(Math.random() * content.length)
            const textToInsert = `\n// Comment ${i}`
            content = content.slice(0, position) + textToInsert + content.slice(position)
            operationCount++
          } else if (operation < 0.6) {
            // Delete text
            const start = Math.floor(Math.random() * content.length)
            const end = Math.min(start + Math.floor(Math.random() * 50), content.length)
            content = content.slice(0, start) + content.slice(end)
            operationCount++
          } else {
            // Replace text
            const start = Math.floor(Math.random() * content.length)
            const end = Math.min(start + Math.floor(Math.random() * 20), content.length)
            content = content.slice(0, start) + `replaced${i}` + content.slice(end)
            operationCount++
          }
        }

        // Simulate syntax highlighting
        const tokens = content.split(/\s+/).length
        const keywords = content.match(/(import|export|function|const|let|var|if|else|return)/g)?.length || 0

        return {
          originalLength: editorContent.length,
          finalLength: content.length,
          operations: operationCount,
          tokens,
          keywords
        }
      }
    },

    {
      name: 'component-rendering',
      description: 'Benchmark component tree rendering',
      fn: () => {
        const componentTree = {
          type: 'App',
          props: { id: 'root' },
          children: []
        }

        // Build deep component tree
        function buildTree(parent: any, depth: number, maxDepth: number) {
          if (depth >= maxDepth) return
          
          for (let i = 0; i < Math.floor(Math.random() * 5) + 2; i++) {
            const child = {
              type: ['Div', 'Button', 'Input', 'Text', 'Box'][Math.floor(Math.random() * 5)],
              props: {
                id: `${parent.props.id}-child-${i}`,
                key: `${depth}-${i}`,
                style: {
                  margin: Math.floor(Math.random() * 10),
                  padding: Math.floor(Math.random() * 10)
                }
              },
              children: []
            }
            
            parent.children.push(child)
            buildTree(child, depth + 1, maxDepth)
          }
        }

        buildTree(componentTree, 0, 6)

        // Simulate rendering passes
        let renderCount = 0
        function renderTree(node: any): any {
          renderCount++
          
          const rendered = {
            type: node.type,
            props: { ...node.props },
            children: node.children.map((child: any) => renderTree(child))
          }
          
          return rendered
        }

        const renderedTree = renderTree(componentTree)

        // Count total nodes
        function countNodes(node: any): number {
          let count = 1
          for (const child of node.children) {
            count += countNodes(child)
          }
          return count
        }

        const totalNodes = countNodes(componentTree)

        return {
          totalNodes,
          renderPasses: renderCount,
          maxDepth: 6,
          treeStructure: 'built'
        }
      }
    },

    {
      name: 'drag-drop-operations',
      description: 'Benchmark drag and drop file operations',
      fn: () => {
        const fileItems = []
        for (let i = 0; i < 200; i++) {
          fileItems.push({
            id: `file-${i}`,
            name: `File${i}.ts`,
            path: `/project/src/File${i}.ts`,
            type: 'file',
            draggable: true,
            position: { x: Math.random() * 1000, y: Math.random() * 1000 }
          })
        }

        const folderItems = []
        for (let i = 0; i < 50; i++) {
          folderItems.push({
            id: `folder-${i}`,
            name: `Folder${i}`,
            path: `/project/src/Folder${i}`,
            type: 'folder',
            droppable: true,
            children: []
          })
        }

        // Simulate drag operations
        let dragOperations = 0
        let dropOperations = 0
        
        for (let i = 0; i < 100; i++) {
          const draggedFile = fileItems[Math.floor(Math.random() * fileItems.length)]
          const targetFolder = folderItems[Math.floor(Math.random() * folderItems.length)]
          
          // Simulate drag start
          draggedFile.position.x += Math.random() * 100 - 50
          draggedFile.position.y += Math.random() * 100 - 50
          dragOperations++
          
          // Simulate drop (30% success rate)
          if (Math.random() > 0.7) {
            targetFolder.children.push(draggedFile.id)
            draggedFile.path = `${targetFolder.path}/${draggedFile.name}`
            dropOperations++
          }
        }

        return {
          files: fileItems.length,
          folders: folderItems.length,
          dragOperations,
          dropOperations,
          successRate: ((dropOperations / dragOperations) * 100).toFixed(1)
        }
      }
    }
  ]
}

export default uiBenchmarks