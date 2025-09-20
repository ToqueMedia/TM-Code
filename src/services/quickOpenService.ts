export interface QuickOpenItem {
  path: string
  name: string
  score: number
}

export default class QuickOpenService {
  private static instance: QuickOpenService
  private rootPath: string | null = null
  private index: string[] = []
  private building: boolean = false

  static getInstance(): QuickOpenService {
    if (!QuickOpenService.instance) {
      QuickOpenService.instance = new QuickOpenService()
    }
    return QuickOpenService.instance
  }

  async initialize(rootPath: string): Promise<void> {
    this.rootPath = rootPath
    await this.buildIndex()
  }

  async reset(): Promise<void> {
    this.rootPath = null
    this.index = []
    this.building = false
  }

  async buildIndex(): Promise<void> {
    if (!this.rootPath) return
    if (this.building) return
    this.building = true
    try {
      const fs = await import('@tauri-apps/plugin-fs')
      const stack: string[] = [this.rootPath]
      const files: string[] = []
      while (stack.length > 0) {
        const current = stack.pop() as string
        let entries: any[] = []
        try {
          entries = await fs.readDir(current)
        } catch {
          continue
        }
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]
          const p: string = entry.path || ''
          const n: string = entry.name || ''
          if (!p) continue
          const lower = n.toLowerCase()
          if (n.startsWith('.')) {
            // skip hidden files/directories
            continue
          }
          if (entry.isDirectory) {
            if (lower === 'node_modules' || lower === '.git' || lower === 'dist' || lower === 'build' || lower === '.next' || lower === 'coverage' || lower === '.turbo') {
              continue
            }
            stack.push(p)
          } else {
            files.push(p)
          }
        }
      }
      this.index = files
    } finally {
      this.building = false
    }
  }

  search(query: string, limit: number = 100): QuickOpenItem[] {
    if (!query || query.trim().length === 0) return []
    const q = query.toLowerCase()
    const results: QuickOpenItem[] = []
    for (let i = 0; i < this.index.length; i++) {
      const path = this.index[i]
      const name = path.split('/').pop() as string
      const ln = name.toLowerCase()
      const lp = path.toLowerCase()
      let score = 0
      if (ln.indexOf(q) !== -1) score += 100 - (ln.indexOf(q))
      if (lp.indexOf(q) !== -1) score += 30 - Math.min(30, lp.indexOf(q))
      if (score > 0) {
        results.push({ path, name, score })
      }
    }
    results.sort(function a(x, y) { return y.score - x.score })
    return results.slice(0, limit)
  }
}
