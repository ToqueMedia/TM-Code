# Patch: Boilerplate Templates System

> **Destino:** Claude Code  
> **Projecto:** `exodus-ide/` (IDE)  
> **Pré-requisito:** Patch Project Creation + Permissions aplicado  
> **Objectivo:** Sistema de templates Hello World bundled na app para scaffolding rápido de projectos. Após copiar o template, o agente corre `npm install` (ou equivalente) automaticamente e depois executa o prompt do user.

---

## Arquitectura

```
User: "Cria uma aplicação React todo"
  ↓
IDE mostra templates que match
  ↓
User escolhe "React + TypeScript + Vite"
  ↓
IDE copia template para pasta do projecto
  ↓
Agente corre "npm install" automaticamente
  ↓
Agente recebe prompt original + contexto do projecto scaffolded
  ↓
Agente implementa o que o user pediu
```

---

## 1. Templates a criar

Cada template é uma pasta completa Hello World, sem `node_modules/`, pronta para `npm install`.

O CC deve criar cada template do zero (não copiar de repos externos). Versão mínima funcional de cada framework.

### Frontend:

| ID | Nome | Comando equivalente | Conteúdo mínimo |
|---|---|---|---|
| `react-ts-vite` | React + TypeScript + Vite | `npm create vite -- --template react-ts` | package.json, vite.config.ts, tsconfig.json, index.html, src/main.tsx, src/App.tsx, src/App.css |
| `nextjs-ts` | Next.js + TypeScript | `npx create-next-app --typescript` | package.json, next.config.ts, tsconfig.json, app/layout.tsx, app/page.tsx, app/globals.css |
| `vue-ts-vite` | Vue + TypeScript + Vite | `npm create vite -- --template vue-ts` | package.json, vite.config.ts, tsconfig.json, index.html, src/main.ts, src/App.vue |
| `nuxt-ts` | Nuxt + TypeScript | `npx nuxi init` | package.json, nuxt.config.ts, tsconfig.json, app.vue, pages/index.vue |
| `svelte-ts-vite` | SvelteKit + TypeScript | `npm create svelte` | package.json, vite.config.ts, svelte.config.js, tsconfig.json, src/routes/+page.svelte, src/app.html |
| `angular-ts` | Angular + TypeScript | `ng new` | package.json, angular.json, tsconfig.json, src/main.ts, src/app/app.component.ts, src/index.html |
| `astro` | Astro | `npm create astro` | package.json, astro.config.mjs, tsconfig.json, src/pages/index.astro, src/layouts/Layout.astro |

### Backend:

| ID | Nome | Conteúdo mínimo |
|---|---|---|
| `express-ts` | Express + TypeScript | package.json, tsconfig.json, src/index.ts (hello world server na porta 3000) |
| `fastify-ts` | Fastify + TypeScript | package.json, tsconfig.json, src/index.ts (hello world server na porta 3000) |
| `go-gin` | Go + Gin | go.mod, main.go (hello world server na porta 8080) |
| `python-fastapi` | Python + FastAPI | requirements.txt, main.py (hello world server na porta 8000) |

### Full-stack:

| ID | Nome | Conteúdo mínimo |
|---|---|---|
| `react-express-ts` | React + Express (monorepo) | package.json (workspace), client/ (react-ts-vite), server/ (express-ts) |

**Total: 12 templates.**

---

## 2. Onde ficam os templates

```
src-tauri/
└── resources/
    └── templates/
        ├── react-ts-vite/
        │   ├── package.json
        │   ├── vite.config.ts
        │   ├── tsconfig.json
        │   ├── index.html
        │   └── src/
        │       ├── main.tsx
        │       ├── App.tsx
        │       └── App.css
        ├── nextjs-ts/
        │   └── ...
        ├── vue-ts-vite/
        │   └── ...
        └── ... (restantes)
```

**Em `tauri.conf.json`**, adicionar os templates como resources bundled:

```json
{
  "bundle": {
    "resources": [
      "resources/templates/**/*"
    ]
  }
}
```

Isto garante que os templates são incluídos no binário da app.

---

## 3. Template Service

**Criar:** `src/services/templateService.ts`

```typescript
import { resolveResource } from '@tauri-apps/api/path'
import { invoke } from '@tauri-apps/api/core'

interface Template {
  id: string
  name: string
  description: string
  category: 'frontend' | 'backend' | 'fullstack'
  framework: string
  installCommand: string    // "npm install" | "go mod tidy" | "pip install -r requirements.txt"
  devCommand: string        // "npm run dev" | "go run main.go" | "uvicorn main:app"
  tags: string[]            // para matching com prompt do user
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

  // Listar todos os templates
  getAll(): Template[] {
    return TEMPLATES
  }

  // Filtrar por categoria
  getByCategory(category: Template['category']): Template[] {
    return TEMPLATES.filter(t => t.category === category)
  }

  // Match com texto do prompt (para sugestões)
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

  // Copiar template para pasta destino
  async scaffold(templateId: string, destinationPath: string): Promise<void> {
    // Resolve path do template bundled
    const templatePath = await resolveResource(`resources/templates/${templateId}`)

    // Copiar recursivamente via Tauri command
    await invoke('copy_directory', {
      source: templatePath,
      destination: destinationPath
    })
  }
}

export const templateService = new TemplateService()
export type { Template }
```

---

## 4. Tauri Command — copy_directory

**Criar:** Novo command Rust para copiar directoria recursivamente.

**Ficheiro:** `src-tauri/src/commands/filesystem.rs` (ou onde os commands de filesystem estão)

```rust
#[tauri::command]
pub async fn copy_directory(source: String, destination: String) -> Result<(), String> {
    let source_path = std::path::Path::new(&source);
    let dest_path = std::path::Path::new(&destination);

    if !source_path.exists() {
        return Err(format!("Source does not exist: {}", source));
    }

    copy_dir_recursive(source_path, dest_path)
        .map_err(|e| format!("Failed to copy template: {}", e))
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dest_entry = dst.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_entry)?;
        } else {
            std::fs::copy(entry.path(), &dest_entry)?;
        }
    }

    Ok(())
}
```

**Registar** o command no Tauri app builder.

---

## 5. Flow completo — New Project com Template

### 5.1 Actualizar WelcomeScreen

O botão "New Project" agora abre o flow de template:

```
┌─────────────────────────────────────────────────┐
│           ToqueMedia Studio                     │
│                                                 │
│   [📁 Open Project]  [✨ New Project]           │
│                                                 │
│   Recent Projects:                              │
│   • ~/Projects/meu-app                          │
│   └─────────────────────────────────────────────┘
```

### 5.2 Criar TemplateSelector component

**Criar:** `src/components/TemplateSelector.tsx`

**Aparece após clicar "New Project" — ANTES de escolher a pasta.**

```
┌─────────────────────────────────────────────────┐
│  Choose a template                              │
│                                                 │
│  Frontend                                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │  React   │ │  Next.js │ │   Vue    │       │
│  │  TS+Vite │ │    TS    │ │  TS+Vite │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │   Nuxt   │ │  Svelte  │ │ Angular  │       │
│  │    TS    │ │  Kit+TS  │ │    TS    │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐                                   │
│  │  Astro   │                                   │
│  └──────────┘                                   │
│                                                 │
│  Backend                                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Express  │ │ Fastify  │ │  Go+Gin  │       │
│  │    TS    │ │    TS    │ │          │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐                                   │
│  │  Python  │                                   │
│  │ FastAPI  │                                   │
│  └──────────┘                                   │
│                                                 │
│  Full-stack                                     │
│  ┌──────────────────┐                           │
│  │ React + Express  │                           │
│  │   Monorepo TS    │                           │
│  └──────────────────┘                           │
│                                                 │
│  [Empty Project — no template]                  │
└─────────────────────────────────────────────────┘
```

**Após user clicar num template:**
1. Dialog nativo do OS: "Choose a folder for your project"
2. User seleciona/cria pasta
3. `templateService.scaffold(templateId, path)` — copia template
4. `projectStore.setCurrentProject(path)`
5. `chatStore.createNewSession(path)`
6. IDE abre ChatView

### 5.3 Actualizar ChatView — empty state pós-scaffold

**Quando:** Sessão nova com 0 mensagens num projecto com template.

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  ✅ Project scaffolded: React + TypeScript + Vite│
│  📁 ~/Projects/meu-projecto                     │
│                                                 │
│  Installing dependencies...                     │
│  ██████████░░░░░░░░░░ npm install               │
│                                                 │
│  (after install completes)                      │
│                                                 │
│  ✅ Dependencies installed                       │
│  What do you want to build?                     │
│                                                 │
│  ┌─────────────────────────────────────┐        │
│  │ Describe what you want to build... │        │
│  └─────────────────────────────────────┘        │
└─────────────────────────────────────────────────┘
```

### 5.4 Auto npm install — via agente

Após o scaffold, a IDE envia automaticamente um **system-level prompt** ao agente (não visível como mensagem do user):

```typescript
// Após scaffold:
const template = templateService.getById(selectedTemplateId)

// Mensagem automática ao agente
agentService.runCommand({
  command: template.installCommand,  // "npm install"
  cwd: projectPath,
  onSuccess: () => {
    // Mostrar "Dependencies installed" no chat
    chatStore.addSystemMessage('✅ Dependencies installed. Ready to build.')
  },
  onError: (error) => {
    // Mostrar erro mas não bloquear
    chatStore.addSystemMessage(`⚠️ Failed to install dependencies: ${error}. You may need to run "${template.installCommand}" manually.`)
  }
})
```

**NOTA:** O `npm install` NÃO passa pelo sistema de permissões (é uma operação iniciada pela IDE, não pelo agente). É um step automático do scaffold.

### 5.5 "Empty Project — no template"

Se o user escolhe "Empty Project":
1. Dialog do OS para escolher pasta
2. Pasta vazia (ou cria se não existe)
3. ChatView abre com empty state genérico (sem "installing dependencies")
4. User descreve o que quer, agente cria tudo do zero

---

## 6. Context Builder — informar o agente sobre o template

**Ficheiro:** `src/services/agent/contextBuilder.ts`

**Quando um projecto é scaffolded a partir de template**, incluir no contexto do system prompt:

```typescript
// Adicionar ao system prompt:
`This project was scaffolded from the "${template.name}" template.
Framework: ${template.framework}
Dev command: ${template.devCommand}
The base Hello World structure is in place. Build on top of it.`
```

Isto evita que o agente recrie ficheiros que já existem ou use patterns incompatíveis com o framework.

---

## 7. Verificar Tauri plugin path

Para `resolveResource` funcionar, verificar que `@tauri-apps/api` está actualizado e que o path resolve correctamente para resources bundled.

```bash
npm install @tauri-apps/api@latest
```

Testar com:
```typescript
const path = await resolveResource('resources/templates/react-ts-vite/package.json')
console.log(path)  // Deve resolver para o path real dentro do bundle
```

---

## Critérios de Done

### Templates:
- [ ] 12 templates Hello World criados em `src-tauri/resources/templates/`
- [ ] Cada template compila e corre após `npm install` (ou equivalente)
- [ ] Nenhum template tem `node_modules/`
- [ ] Templates bundled via `tauri.conf.json` resources

### Tauri:
- [ ] Command `copy_directory` funciona (copia recursivamente)
- [ ] `resolveResource` resolve paths de templates bundled

### IDE:
- [ ] `templateService.ts` criado com getAll, matchPrompt, scaffold
- [ ] `TemplateSelector.tsx` mostra templates por categoria
- [ ] Flow: New Project → Template → Pasta → Scaffold → npm install → ChatView
- [ ] "Empty Project" funciona (sem template)
- [ ] Empty state pós-scaffold mostra progresso do npm install
- [ ] Context builder inclui info do template no system prompt
- [ ] `npm run build` sem erros

### Agente:
- [ ] npm install (ou equivalente) corre automaticamente após scaffold
- [ ] Erro no install não bloqueia — mostra warning, user pode continuar
- [ ] Prompt do user é executado sobre o projecto scaffolded

---

## O que NÃO fazer

- Não correr `npx create-vite` ou comandos de scaffold externos — templates são estáticos bundled
- Não incluir `node_modules/` nos templates
- Não incluir `.git/` nos templates
- Não implementar download de templates remotos (futuro)
- Não implementar criação de templates custom pelo user (futuro)
- Não modificar o Worker
- Não modificar o sistema de permissões (npm install é automático, não pede permissão)
