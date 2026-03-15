import { resolveResource } from '@tauri-apps/api/path'
import { invoke } from '@tauri-apps/api/core'

export interface Template {
  id: string
  name: string
  description: string
  category: 'frontend' | 'backend' | 'fullstack'
  framework: string
  installCommand: string
  devCommand: string
  tags: string[]
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
    tags: ['react', 'typescript', 'vite', 'frontend', 'web', 'spa']
  },
  {
    id: 'nextjs-ts',
    name: 'Next.js + TypeScript',
    description: 'Full-stack React framework with SSR',
    category: 'frontend',
    framework: 'nextjs',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['next', 'nextjs', 'react', 'typescript', 'ssr', 'fullstack']
  },
  {
    id: 'vue-ts-vite',
    name: 'Vue + TypeScript + Vite',
    description: 'Vue 3 app with TypeScript and Vite',
    category: 'frontend',
    framework: 'vue',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['vue', 'vuejs', 'typescript', 'vite', 'frontend']
  },
  {
    id: 'nuxt-ts',
    name: 'Nuxt + TypeScript',
    description: 'Full-stack Vue framework with SSR',
    category: 'frontend',
    framework: 'nuxt',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['nuxt', 'vue', 'typescript', 'ssr', 'fullstack']
  },
  {
    id: 'svelte-ts-vite',
    name: 'SvelteKit + TypeScript',
    description: 'Svelte app with SvelteKit and TypeScript',
    category: 'frontend',
    framework: 'svelte',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['svelte', 'sveltekit', 'typescript', 'vite', 'frontend']
  },
  {
    id: 'angular-ts',
    name: 'Angular + TypeScript',
    description: 'Angular app with TypeScript',
    category: 'frontend',
    framework: 'angular',
    installCommand: 'npm install',
    devCommand: 'npm start',
    tags: ['angular', 'typescript', 'frontend', 'enterprise']
  },
  {
    id: 'astro',
    name: 'Astro',
    description: 'Content-focused static site framework',
    category: 'frontend',
    framework: 'astro',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['astro', 'static', 'content', 'blog', 'website']
  },
  {
    id: 'express-ts',
    name: 'Express + TypeScript',
    description: 'Express.js REST API with TypeScript',
    category: 'backend',
    framework: 'express',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['express', 'api', 'rest', 'backend', 'node', 'typescript']
  },
  {
    id: 'fastify-ts',
    name: 'Fastify + TypeScript',
    description: 'High-performance Node.js server',
    category: 'backend',
    framework: 'fastify',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['fastify', 'api', 'rest', 'backend', 'node', 'typescript']
  },
  {
    id: 'go-gin',
    name: 'Go + Gin',
    description: 'Go REST API with Gin framework',
    category: 'backend',
    framework: 'go',
    installCommand: 'go mod tidy',
    devCommand: 'go run main.go',
    tags: ['go', 'golang', 'gin', 'api', 'rest', 'backend']
  },
  {
    id: 'python-fastapi',
    name: 'Python + FastAPI',
    description: 'Python REST API with FastAPI',
    category: 'backend',
    framework: 'python',
    installCommand: 'pip install -r requirements.txt',
    devCommand: 'uvicorn main:app --reload',
    tags: ['python', 'fastapi', 'api', 'rest', 'backend']
  },
  {
    id: 'react-express-ts',
    name: 'React + Express (Monorepo)',
    description: 'Full-stack monorepo with React frontend and Express backend',
    category: 'fullstack',
    framework: 'react+express',
    installCommand: 'npm install',
    devCommand: 'npm run dev',
    tags: ['react', 'express', 'fullstack', 'monorepo', 'typescript']
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

  async scaffold(templateId: string, destinationPath: string): Promise<void> {
    const templatePath = await resolveResource(`resources/templates/${templateId}`)
    await invoke('copy_directory', {
      source: templatePath,
      destination: destinationPath
    })
  }
}

export const templateService = new TemplateService()
