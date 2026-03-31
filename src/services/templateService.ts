import { invoke } from '@tauri-apps/api/core'
import { detectSystemPackageManager, adaptCommand } from './packageManagerDetector'

export interface Requirement {
  name: string
  command: string
  versionFlag: string
  minVersion: string
  installUrl: string
  installHint: string
}

export interface Template {
  id: string
  name: string
  description: string
  category: 'frontend' | 'backend' | 'fullstack'
  framework: string
  installCommand: string
  devCommand: string
  tags: string[]
  /** Sub-directories that need separate install (when npm workspaces is not configured). */
  workspaces?: string[]
  /** Runtime requirements to check before scaffolding. */
  requirements?: Requirement[]
}

const NODE_REQUIREMENTS: Requirement[] = [
  {
    name: 'Node.js',
    command: 'node',
    versionFlag: '--version',
    minVersion: '18.0.0',
    installUrl: 'https://nodejs.org',
    installHint: 'Download from nodejs.org or install via nvm',
  },
]


/** Persisted to .toquemedia-template in project root after scaffold. */
export interface TemplateManifest {
  templateId: string
  name: string
  framework: string
  installCommand: string
  devCommand: string
  scaffoldedAt: string
}

const TEMPLATES: Template[] = [
  {
    id: 'react-ts-vite',
    name: 'React + TypeScript + Vite',
    description: 'React app with TypeScript and Vite bundler',
    category: 'frontend',
    framework: 'react',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['react', 'typescript', 'vite', 'frontend', 'web', 'spa'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'nextjs-ts',
    name: 'Next.js + TypeScript',
    description: 'Full-stack React framework with SSR',
    category: 'frontend',
    framework: 'nextjs',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['next', 'nextjs', 'react', 'typescript', 'ssr', 'fullstack'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'vue-ts-vite',
    name: 'Vue + TypeScript + Vite',
    description: 'Vue 3 app with TypeScript and Vite',
    category: 'frontend',
    framework: 'vue',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['vue', 'vuejs', 'typescript', 'vite', 'frontend'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'nuxt-ts',
    name: 'Nuxt + TypeScript',
    description: 'Full-stack Vue framework with SSR',
    category: 'frontend',
    framework: 'nuxt',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['nuxt', 'vue', 'typescript', 'ssr', 'fullstack'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'svelte-ts-vite',
    name: 'SvelteKit + TypeScript',
    description: 'Svelte app with SvelteKit and TypeScript',
    category: 'frontend',
    framework: 'svelte',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['svelte', 'sveltekit', 'typescript', 'vite', 'frontend'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'angular-ts',
    name: 'Angular + TypeScript',
    description: 'Angular app with TypeScript',
    category: 'frontend',
    framework: 'angular',
    installCommand: 'npm install',
    devCommand: 'npm start',
    tags: ['angular', 'typescript', 'frontend', 'enterprise'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'astro',
    name: 'Astro',
    description: 'Content-focused static site framework',
    category: 'frontend',
    framework: 'astro',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['astro', 'static', 'content', 'blog', 'website'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'express-ts',
    name: 'Express + TypeScript',
    description: 'Express.js REST API with TypeScript',
    category: 'backend',
    framework: 'express',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['express', 'api', 'rest', 'backend', 'node', 'typescript'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'fastify-ts',
    name: 'Fastify + TypeScript',
    description: 'High-performance Node.js server',
    category: 'backend',
    framework: 'fastify',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['fastify', 'api', 'rest', 'backend', 'node', 'typescript'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'nestjs-ts',
    name: 'NestJS + TypeScript',
    description: 'Progressive Node.js framework for scalable APIs',
    category: 'backend',
    framework: 'nestjs',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['nestjs', 'nest', 'typescript', 'api', 'rest', 'backend', 'node'],
    requirements: NODE_REQUIREMENTS,
  },
  {
    id: 'react-express-ts',
    name: 'React + Express (Monorepo)',
    description: 'Full-stack monorepo with React frontend and Express backend',
    category: 'fullstack',
    framework: 'react+express',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['react', 'express', 'fullstack', 'monorepo', 'typescript'],
    workspaces: ['client', 'server'],
    requirements: NODE_REQUIREMENTS,
  }
]

class TemplateService {
  getAll(): Template[] {
    return TEMPLATES
  }

  getByCategory(category: Template['category']): Template[] {
    return TEMPLATES.filter(t => t.category === category)
  }

  getById(id: string): Template | undefined {
    return TEMPLATES.find(t => t.id === id)
  }

  matchPrompt(prompt: string): Template[] {
    const lower = prompt.toLowerCase()
    return TEMPLATES
      .map(t => ({
        template: t,
        score: t.tags.filter(tag => lower.includes(tag)).length
      }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(m => m.template)
  }

  /**
   * Scaffold a template into the destination directory.
   * Path resolution happens entirely on the Rust side via AppHandle.
   * After copy, writes a .toquemedia-template manifest so the context
   * builder can auto-detect which template was used.
   */
  async scaffold(templateId: string, destinationPath: string): Promise<void> {
    const template = this.getById(templateId)
    if (!template) {
      throw new Error(`Unknown template: ${templateId}`)
    }

    // Rust resolves resource path internally — no resolveResource needed
    await invoke('scaffold_template', {
      templateId,
      destination: destinationPath,
    })

    // Write manifest with the actual PM available on the system
    const pm = await detectSystemPackageManager()
    const manifest: TemplateManifest = {
      templateId: template.id,
      name: template.name,
      framework: template.framework,
      installCommand: adaptCommand(template.installCommand, pm),
      devCommand: adaptCommand(template.devCommand, pm),
      scaffoldedAt: new Date().toISOString(),
    }

    await invoke('write_file', {
      path: `${destinationPath}/.toquemedia-template`,
      content: JSON.stringify(manifest, null, 2),
    })
  }
}

export const templateService = new TemplateService()
