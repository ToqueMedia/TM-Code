# Patch: Skills System + MCP (Model Context Protocol)

> **Destino:** Claude Code  
> **Projectos:** `exodus-ide/` (IDE) + `toquemedia-studio-api/` (Worker — apenas para MCP remoto)  
> **Pré-requisito:** Patches anteriores (streaming, queue, tools, permissions)  
> **Objectivo:** Sistema de skills (bundled + global + projecto) e suporte a MCP servers (local stdio + remoto URL) para tornar a IDE extensível.

---

# PARTE A — Skills System

## Conceito

Skills são ficheiros/pastas que injectam instruções/contexto no system prompt do agente. O agente lê-os automaticamente e segue as instruções.

Compatível com a spec [agentskills.io](https://agentskills.io) — cada skill pode ser um `SKILL.md` simples ou uma pasta com `SKILL.md` + `references/`.

```
User: "Integra pagamentos Multicaixa Express"

Sem skills:
  → Agente alucina endpoints, formatos, headers

Com skill "mom-factura-payments":
  → Agente sabe os endpoints reais, formatos SAFT-AO, headers correctos,
    flow de polling, webhooks, ambiente QA
```

## Três níveis

### Nível 1 — Skills Bundled (`src-tauri/resources/skills/`)

Embebidos na app pela ToqueMedia. Curados, versionados com a app. O user não edita.

```
src-tauri/resources/skills/
├── react-patterns/
│   └── SKILL.md              # Best practices React+TS
├── go-conventions/
│   └── SKILL.md              # Go project patterns
├── angular-patterns/
│   └── SKILL.md              # Angular patterns
├── vue-patterns/
│   └── SKILL.md              # Vue 3 patterns
└── general-coding/
    └── SKILL.md              # Clean code, naming, error handling
```

Estes skills aplicam-se automaticamente quando o agente detecta o framework do projecto (via package.json, go.mod, etc.). O contextBuilder decide quais carregar.

### Nível 2 — Skills Globais (`~/.toquemedia-studio/skills/`)

Instalados pelo user. Preferências pessoais ou skills de terceiros. Não vão para git.

Instalação via `npx skills add` ou manual:

```bash
# Via npx skills (spec agentskills.io)
npx skills add ithustle/momenu-skills

# Manual
git clone https://github.com/ithustle/momenu-skills.git
cp -r momenu-skills/skills/* ~/.toquemedia-studio/skills/
```

Estrutura:

```
~/.toquemedia-studio/
└── skills/
    ├── personal.md                    # Skill simples (1 ficheiro)
    ├── mom-factura-payments/          # Skill com references (agentskills.io format)
    │   ├── SKILL.md
    │   └── references/
    │       └── STATUS-POLLING.md
    ├── mom-factura-webhooks/
    │   └── SKILL.md
    └── mom-factura-testing/
        └── SKILL.md
```

### Nível 3 — Skills de Projecto (`.tms/skills/`)

Vivem na pasta do projecto. Partilhados com a equipa via git. Específicos ao projecto.

```
my-project/
├── .tms/
│   └── skills/
│       ├── conventions.md             # Skill simples
│       ├── api-patterns/              # Skill com references
│       │   ├── SKILL.md
│       │   └── references/
│       │       └── ENDPOINTS.md
│       └── testing.md
├── src/
├── package.json
└── ...
```

### Prioridade de carregamento

```
1. Skills bundled relevantes (carregados primeiro — base genérica)
2. Skills globais (carregados segundo — user prefs + third-party)
3. Skills de projecto (carregados por último — override máximo)
```

Se um skill de projecto contradiz um bundled ou global, o de projecto ganha (está mais perto do fim do prompt).

### Formato suportado

O skillService suporta dois formatos:

**Formato simples:** Um ficheiro `.md` (ex: `conventions.md`)

**Formato agentskills.io:** Uma pasta com `SKILL.md` + opcionalmente `references/` com ficheiros adicionais

```typescript
// Detecção automática:
// Se é ficheiro .md → ler directamente
// Se é pasta com SKILL.md → ler SKILL.md + todos os .md em references/
```

---

## 1. Criar skillService.ts

**Criar:** `src/services/agent/skillService.ts`

```typescript
interface Skill {
  id: string              // hash do path
  name: string            // nome do ficheiro/pasta
  path: string            // path absoluto do SKILL.md ou .md
  content: string         // conteúdo principal (SKILL.md ou .md)
  references: string[]    // conteúdo dos ficheiros em references/ (se existirem)
  scope: 'bundled' | 'global' | 'project'
  format: 'simple' | 'agentskills'  // .md simples ou pasta com SKILL.md
}

class SkillService {
  private static instance: SkillService

  // Carregar todas as skills (bundled + global + projecto)
  async loadSkills(projectPath: string, projectType?: string): Promise<Skill[]> {
    const bundledSkills = await this.loadBundledSkills(projectType)
    const globalSkills = await this.loadGlobalSkills()
    const projectSkills = await this.loadProjectSkills(projectPath)
    return [...bundledSkills, ...globalSkills, ...projectSkills]
  }

  // Skills bundled (filtradas por framework detectado)
  private async loadBundledSkills(projectType?: string): Promise<Skill[]> {
    const basePath = await resolveResource('resources/skills')
    const allSkills = await this.loadSkillsFromDirectory(basePath, 'bundled')

    if (!projectType) return allSkills

    // Filtrar: carregar apenas skills relevantes ao framework
    // ex: projectType === 'react' → carregar react-patterns + general-coding
    return allSkills.filter(skill => {
      const name = skill.name.toLowerCase()
      if (name.includes('general')) return true  // sempre carregar
      if (name.includes(projectType.toLowerCase())) return true
      return false
    })
  }

  // Skills globais
  private async loadGlobalSkills(): Promise<Skill[]> {
    const basePath = await this.getGlobalSkillsPath()
    return this.loadSkillsFromDirectory(basePath, 'global')
  }

  // Skills de projecto
  private async loadProjectSkills(projectPath: string): Promise<Skill[]> {
    const basePath = `${projectPath}/.tms/skills`
    return this.loadSkillsFromDirectory(basePath, 'project')
  }

  // Ler skills de uma pasta — suporta ambos os formatos
  private async loadSkillsFromDirectory(
    dirPath: string,
    scope: Skill['scope']
  ): Promise<Skill[]> {
    const skills: Skill[] = []

    try {
      // Listar conteúdo da pasta
      const entries = await invoke<any[]>('list_directory_entries', {
        path: dirPath
      })

      for (const entry of entries) {
        try {
          if (entry.isFile && entry.name.endsWith('.md')) {
            // Formato simples: ficheiro .md
            const content = await invoke<string>('read_file', { path: entry.path })
            skills.push({
              id: this.hashPath(entry.path),
              name: entry.name.replace('.md', ''),
              path: entry.path,
              content,
              references: [],
              scope,
              format: 'simple'
            })

          } else if (entry.isDirectory) {
            // Formato agentskills.io: pasta com SKILL.md
            const skillMdPath = `${entry.path}/SKILL.md`
            try {
              const content = await invoke<string>('read_file', { path: skillMdPath })

              // Carregar references/ se existir
              const references = await this.loadReferences(`${entry.path}/references`)

              skills.push({
                id: this.hashPath(entry.path),
                name: entry.name,
                path: skillMdPath,
                content,
                references,
                scope,
                format: 'agentskills'
              })
            } catch {
              // Pasta sem SKILL.md — ignorar
            }
          }
        } catch {
          // Skip entries que não consegue ler
        }
      }
    } catch {
      // Pasta não existe — retornar vazio (normal)
    }

    return skills
  }

  // Carregar ficheiros de references/
  private async loadReferences(refPath: string): Promise<string[]> {
    try {
      const files = await invoke<string[]>('glob_files', {
        pattern: '*.md',
        directory: refPath
      })

      const contents: string[] = []
      for (const file of files) {
        try {
          const content = await invoke<string>('read_file', { path: file })
          const fileName = file.split('/').pop() || ''
          contents.push(`### Reference: ${fileName}\n\n${content}`)
        } catch {
          // Skip
        }
      }
      return contents
    } catch {
      return []
    }
  }

  // Gerar bloco de skills para o system prompt
  buildSkillsPromptBlock(skills: Skill[]): string {
    if (skills.length === 0) return ''

    let block = '\n\n## Active Skills\n\n'

    for (const skill of skills) {
      block += `### ${skill.name} (${skill.scope})\n\n`
      block += skill.content
      
      // Adicionar references se existirem
      if (skill.references.length > 0) {
        block += '\n\n'
        block += skill.references.join('\n\n')
      }

      block += '\n\n---\n\n'
    }

    return block
  }

  // Instalar skill de um repo GitHub (npx skills add compatible)
  async installFromGitHub(repoSlug: string, targetScope: 'global' | 'project', projectPath?: string): Promise<void> {
    // Usar execute_command para correr npx skills add
    // Destino depende do scope:
    // global → ~/.toquemedia-studio/skills/
    // project → {projectPath}/.tms/skills/
    const destPath = targetScope === 'global'
      ? await this.getGlobalSkillsPath()
      : `${projectPath}/.tms/skills`

    await invoke('execute_command', {
      command: `npx skills add ${repoSlug} --dest ${destPath}`,
      cwd: null
    })
  }

  // Criar skill de projecto
  async createProjectSkill(
    projectPath: string,
    name: string,
    content: string
  ): Promise<Skill> {
    const dirPath = `${projectPath}/.tms/skills`
    await invoke('create_directories_all', { path: dirPath })

    const filePath = `${dirPath}/${name}.md`
    await invoke('write_file', { path: filePath, content })

    return {
      id: this.hashPath(filePath),
      name,
      path: filePath,
      content,
      references: [],
      scope: 'project',
      format: 'simple'
    }
  }

  // Criar skill global
  async createGlobalSkill(name: string, content: string): Promise<Skill> {
    const dirPath = await this.getGlobalSkillsPath()
    await invoke('create_directories_all', { path: dirPath })

    const filePath = `${dirPath}/${name}.md`
    await invoke('write_file', { path: filePath, content })

    return {
      id: this.hashPath(filePath),
      name,
      path: filePath,
      content,
      references: [],
      scope: 'global',
      format: 'simple'
    }
  }

  // Apagar skill
  async deleteSkill(skill: Skill): Promise<void> {
    if (skill.scope === 'bundled') {
      throw new Error('Cannot delete bundled skills')
    }

    if (skill.format === 'agentskills') {
      // Apagar a pasta inteira
      const parentDir = skill.path.replace('/SKILL.md', '')
      await invoke('delete_file_or_directory', { path: parentDir })
    } else {
      await invoke('delete_file_or_directory', { path: skill.path })
    }
  }

  private async getGlobalSkillsPath(): Promise<string> {
    const homeDir = await import('@tauri-apps/api/path').then(m => m.homeDir())
    return `${homeDir}/.toquemedia-studio/skills`
  }

  private hashPath(path: string): string {
    let hash = 0
    for (let i = 0; i < path.length; i++) {
      const char = path.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash |= 0
    }
    return Math.abs(hash).toString(36)
  }
}

export const skillService = SkillService.getInstance()
```

### Tauri Command — list_directory_entries

O `build_file_tree` existente retorna uma árvore aninhada. Para listar entries simples (ficheiro/pasta), pode ser necessário um command novo:

**Ficheiro:** `src-tauri/src/commands/filesystem.rs`

```rust
#[derive(serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_directory: bool,
}

#[tauri::command]
pub async fn list_directory_entries(path: String) -> Result<Vec<DirEntry>, String> {
    let dir_path = std::path::Path::new(&path);
    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir_path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_file: file_type.is_file(),
            is_directory: file_type.is_dir(),
        });
    }

    Ok(entries)
}
```

---

## 2. Integrar skills no contextBuilder

**Ficheiro:** `src/services/agent/contextBuilder.ts`

**Onde:** No `buildSystemPrompt`, após o contexto do projecto.

```typescript
async buildSystemPrompt(projectPath: string, projectType: string): Promise<string> {
  // ... código existente (file tree, package.json, etc.) ...

  // NOVO: Carregar e injectar skills (3 níveis)
  const skills = await skillService.loadSkills(projectPath, projectType)
  const skillsBlock = skillService.buildSkillsPromptBlock(skills)

  return `${basePrompt}${skillsBlock}`
}
```

**Detecção de projectType** (para filtrar bundled skills):

```typescript
function detectProjectType(projectPath: string): string | undefined {
  // Verificar package.json
  try {
    const pkg = JSON.parse(await invoke('read_file', { path: `${projectPath}/package.json` }))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps['react']) return 'react'
    if (deps['vue']) return 'vue'
    if (deps['@angular/core']) return 'angular'
    if (deps['svelte']) return 'svelte'
    if (deps['next']) return 'nextjs'
    if (deps['nuxt']) return 'nuxt'
    if (deps['astro']) return 'astro'
    if (deps['express']) return 'express'
    if (deps['fastify']) return 'fastify'
    return 'node'
  } catch {}

  // Verificar go.mod
  try {
    await invoke('read_file', { path: `${projectPath}/go.mod` })
    return 'go'
  } catch {}

  // Verificar requirements.txt / pyproject.toml
  try {
    await invoke('read_file', { path: `${projectPath}/requirements.txt` })
    return 'python'
  } catch {}

  return undefined
}
```

---

## 3. Skills bundled — criar pelo CC

**Path:** `src-tauri/resources/skills/`

O CC deve criar os seguintes skills bundled (conteúdo minimal mas útil):

| Skill | Ficheiro | Conteúdo |
|---|---|---|
| `react-patterns` | `SKILL.md` | Componentes funcionais, hooks, naming, structure, error boundaries, memo/useMemo |
| `vue-patterns` | `SKILL.md` | Composition API, refs, computed, naming, SFC structure |
| `angular-patterns` | `SKILL.md` | Modules, components, services, dependency injection, RxJS patterns |
| `svelte-patterns` | `SKILL.md` | Stores, reactivity, component structure |
| `nextjs-patterns` | `SKILL.md` | App router, server components, loading/error, API routes |
| `go-conventions` | `SKILL.md` | Error handling, project layout, interfaces, naming |
| `python-conventions` | `SKILL.md` | Type hints, project structure, virtual envs, error handling |
| `general-coding` | `SKILL.md` | Clean code, naming, DRY, error handling, comments |

**Cada SKILL.md deve ter 50-100 linhas.** Conciso, directivo, sem explicações longas. Exemplo de tom:

```markdown
# React Patterns

## Components
- Always use functional components with TypeScript
- Use React.memo() for components that receive stable props
- Name components in PascalCase
- One component per file

## Hooks
- Custom hooks in src/hooks/ directory
- Prefix with "use" (useAuth, useFetch)
- Never call hooks conditionally

## State
- Prefer useState for local state
- Use Zustand for global state (if present in project)
- Avoid prop drilling beyond 2 levels

## Error Handling
- Wrap route-level components with ErrorBoundary
- Use try/catch in async operations
- Show user-friendly error messages

## File Structure
- Components in src/components/
- Pages/routes in src/pages/ or src/app/
- Shared types in src/types/
- Utils in src/utils/
```

**Bundled no tauri.conf.json:**

```json
{
  "bundle": {
    "resources": [
      "resources/templates/**/*",
      "resources/skills/**/*"
    ]
  }
}
```

---

## 3. UI — Gestão de skills

### 3.1 Criar SkillsPanel.tsx

**Criar:** `src/components/settings/SkillsPanel.tsx`

**Acessível via:** Menu de settings ou ícone na MinimalTitleBar.

```
┌──────────────────────────────────────────────┐
│ Skills                            [+ New]    │
│                                              │
│ Bundled (read-only)                          │
│ ┌──────────────────────────────────────────┐ │
│ │ 📦 react-patterns              [auto]    │ │
│ │ 📦 general-coding              [auto]    │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ Global (~/.toquemedia-studio/skills/)        │
│ ┌──────────────────────────────────────────┐ │
│ │ 📄 personal.md            [✏️] [🗑️]     │ │
│ │ 📁 mom-factura-payments   [✏️] [🗑️]     │ │
│ │ 📁 mom-factura-webhooks   [✏️] [🗑️]     │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ Project (.tms/skills/)                       │
│ ┌──────────────────────────────────────────┐ │
│ │ 📄 conventions.md         [✏️] [🗑️]     │ │
│ │ 📁 api-patterns           [✏️] [🗑️]     │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ [Install from GitHub]                        │
│ ┌──────────────────────────────────────────┐ │
│ │ ithustle/momenu-skills        [Install]  │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ Skills are loaded in order: bundled →        │
│ global → project. Project skills override.   │
└──────────────────────────────────────────────┘
```

**Acções:**
- **New:** Dialog para criar skill (escolher scope: project/global, nome, conteúdo)
- **Edit (✏️):** Abre o SKILL.md ou .md no editor Monaco
- **Delete (🗑️):** Confirma e apaga (não disponível para bundled)
- **Install from GitHub:** Input para repo slug, instala via `npx skills add`
- **Bundled:** Mostrar quais estão activos (baseado no projectType detectado), read-only
- **[auto]:** Badge que indica que o skill foi auto-seleccionado pelo framework detectado

### 3.2 Indicador de skills activas no chat

**Ficheiro:** `src/components/chat/AgentStatusBar.tsx`

Mostrar quantas skills estão carregadas:

```
🟢 Ready | Skills: 3 (2 project, 1 global) | Tokens: 0
```

---

# PARTE B — MCP (Model Context Protocol)

## Conceito

MCP servers expõem tools adicionais ao agente. O agente descobre as tools dinamicamente e pode usá-las como se fossem nativas.

```
Exemplo: GitHub MCP Server
  → Tools: create_issue, list_pull_requests, create_pr, merge_pr
  → O agente pode: "Cria um PR com estas alterações" → chama create_pr via MCP
```

## Dois tipos de MCP servers

### Local (stdio)

A IDE lança o MCP server como child process. Comunicação via stdin/stdout (JSON-RPC).

```
IDE → spawn process ("npx @modelcontextprotocol/server-github")
IDE → stdin: {"method": "tools/list", ...}
MCP → stdout: {"result": {"tools": [...]}}
IDE → stdin: {"method": "tools/call", "params": {"name": "create_issue", ...}}
MCP → stdout: {"result": {"content": [...]}}
```

Exemplos: GitHub MCP, filesystem MCP, SQLite MCP, Postgres MCP.

### Remoto (URL/SSE)

O MCP server corre noutro sítio. Comunicação via HTTP + SSE.

```
IDE → POST https://mcp.example.com/message
       {"method": "tools/list", ...}
MCP → SSE: {"result": {"tools": [...]}}
```

Exemplos: hosted MCP servers, serviços cloud, APIs third-party.

---

## 4. Configuração de MCP servers

### 4.1 Formato de configuração

**Ficheiro de config do projecto:** `.tms/mcp.json`

```json
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      }
    },
    "postgres": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": "${env:DATABASE_URL}"
      }
    },
    "company-api": {
      "type": "remote",
      "url": "https://mcp.company.com/sse",
      "headers": {
        "Authorization": "Bearer ${env:COMPANY_API_TOKEN}"
      }
    }
  }
}
```

**Ficheiro de config global:** `~/.toquemedia-studio/mcp.json` (mesmo formato, merge com projecto)

### 4.2 Resolução de variáveis de ambiente

`${env:GITHUB_TOKEN}` resolve para `process.env.GITHUB_TOKEN`. Se não existir, o server falha ao iniciar com mensagem clara.

---

## 5. Criar mcpService.ts

**Criar:** `src/services/mcp/mcpService.ts`

```typescript
interface MCPServerConfig {
  type: 'stdio' | 'remote'
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // remote
  url?: string
  headers?: Record<string, string>
}

interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string  // qual MCP server expôs esta tool
}

interface MCPServer {
  name: string
  config: MCPServerConfig
  status: 'stopped' | 'starting' | 'running' | 'error'
  tools: MCPTool[]
  error?: string
}

class MCPService {
  private static instance: MCPService
  private servers: Map<string, MCPServer> = new Map()
  private stdioTransports: Map<string, StdioTransport> = new Map()
  private remoteTransports: Map<string, RemoteTransport> = new Map()

  // Carregar config e iniciar todos os servers
  async initialize(projectPath: string): Promise<void> {
    const config = await this.loadConfig(projectPath)

    for (const [name, serverConfig] of Object.entries(config.servers)) {
      await this.startServer(name, serverConfig)
    }
  }

  // Iniciar um MCP server
  async startServer(name: string, config: MCPServerConfig): Promise<void> {
    this.servers.set(name, {
      name,
      config,
      status: 'starting',
      tools: []
    })

    try {
      if (config.type === 'stdio') {
        await this.startStdioServer(name, config)
      } else {
        await this.startRemoteServer(name, config)
      }

      // Descobrir tools
      const tools = await this.listTools(name)
      const server = this.servers.get(name)!
      server.tools = tools
      server.status = 'running'

    } catch (error) {
      const server = this.servers.get(name)!
      server.status = 'error'
      server.error = error instanceof Error ? error.message : String(error)
    }
  }

  // Listar tools de um server
  async listTools(serverName: string): Promise<MCPTool[]> {
    const response = await this.sendRequest(serverName, 'tools/list', {})
    return (response.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {},
      serverName
    }))
  }

  // Executar uma tool
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const response = await this.sendRequest(serverName, 'tools/call', {
      name: toolName,
      arguments: args
    })

    // Extrair texto do resultado MCP
    const content = response.content || []
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
  }

  // Obter todas as tools de todos os servers (para enviar ao LLM)
  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = []
    for (const server of this.servers.values()) {
      if (server.status === 'running') {
        tools.push(...server.tools)
      }
    }
    return tools
  }

  // Parar todos os servers
  async shutdown(): Promise<void> {
    for (const [name] of this.servers) {
      await this.stopServer(name)
    }
  }

  // Carregar config (merge global + projecto)
  private async loadConfig(projectPath: string): Promise<{ servers: Record<string, MCPServerConfig> }> {
    const globalConfig = await this.loadConfigFile(
      `${await this.getGlobalConfigPath()}/mcp.json`
    )
    const projectConfig = await this.loadConfigFile(
      `${projectPath}/.tms/mcp.json`
    )

    // Merge: projecto override global
    return {
      servers: {
        ...(globalConfig?.servers || {}),
        ...(projectConfig?.servers || {})
      }
    }
  }

  private async loadConfigFile(path: string): Promise<any> {
    try {
      const content = await invoke<string>('read_file', { path })
      const config = JSON.parse(content)

      // Resolver variáveis de ambiente
      return this.resolveEnvVars(config)
    } catch {
      return null
    }
  }

  private resolveEnvVars(obj: any): any {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{env:([^}]+)\}/g, (_, varName) => {
        return process.env[varName] || ''
      })
    }
    if (Array.isArray(obj)) return obj.map(item => this.resolveEnvVars(item))
    if (typeof obj === 'object' && obj !== null) {
      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.resolveEnvVars(value)
      }
      return result
    }
    return obj
  }

  private async getGlobalConfigPath(): Promise<string> {
    const homeDir = await import('@tauri-apps/api/path').then(m => m.homeDir())
    return `${homeDir}/.toquemedia-studio`
  }

  // ... startStdioServer, startRemoteServer, sendRequest implementações abaixo
}
```

---

## 6. Transporte Stdio

**Criar:** `src/services/mcp/stdioTransport.ts`

Usa Tauri para lançar child process e comunicar via stdin/stdout.

```typescript
import { Command } from '@tauri-apps/plugin-shell'

class StdioTransport {
  private process: any = null  // Tauri child process
  private requestId = 0
  private pendingRequests: Map<number, {
    resolve: (value: any) => void
    reject: (error: Error) => void
  }> = new Map()
  private outputBuffer = ''

  async start(command: string, args: string[], env: Record<string, string>): Promise<void> {
    // Lançar processo via Tauri shell plugin
    const cmd = Command.create(command, args, { env })

    cmd.stdout.on('data', (data: string) => {
      this.handleStdout(data)
    })

    cmd.stderr.on('data', (data: string) => {
      console.error(`[MCP stderr] ${data}`)
    })

    cmd.on('close', (code: number) => {
      // Rejeitar todos os requests pendentes
      for (const [id, { reject }] of this.pendingRequests) {
        reject(new Error(`MCP process exited with code ${code}`))
      }
      this.pendingRequests.clear()
    })

    this.process = await cmd.spawn()
  }

  async sendRequest(method: string, params: any): Promise<any> {
    const id = ++this.requestId

    const message = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    }) + '\n'

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })

      // Timeout de 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error(`MCP request timeout: ${method}`))
        }
      }, 30000)

      // Escrever no stdin do processo
      this.process.write(message)
    })
  }

  private handleStdout(data: string): void {
    this.outputBuffer += data

    // Processar mensagens JSON-RPC completas (delimitadas por newline)
    const lines = this.outputBuffer.split('\n')
    this.outputBuffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        if (message.id && this.pendingRequests.has(message.id)) {
          const { resolve, reject } = this.pendingRequests.get(message.id)!
          this.pendingRequests.delete(message.id)

          if (message.error) {
            reject(new Error(message.error.message || 'MCP error'))
          } else {
            resolve(message.result)
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
  }
}
```

**Tauri plugin necessário:**

```bash
# package.json
npm install @tauri-apps/plugin-shell
```

```toml
# src-tauri/Cargo.toml
tauri-plugin-shell = "2"
```

```rust
// src-tauri/src/lib.rs ou main.rs
.plugin(tauri_plugin_shell::init())
```

**Permissões Tauri** — em `src-tauri/capabilities/`:

```json
{
  "permissions": [
    "shell:allow-spawn",
    "shell:allow-stdin-write"
  ]
}
```

---

## 7. Transporte Remoto (HTTP + SSE)

**Criar:** `src/services/mcp/remoteTransport.ts`

Para MCP remoto, os requests vão via Worker (não directo da IDE) — consistente com a decisão do WebFetch.

```typescript
class RemoteTransport {
  private workerUrl: string
  private mcpUrl: string
  private headers: Record<string, string>

  constructor(mcpUrl: string, headers: Record<string, string>) {
    this.workerUrl = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787'
    this.mcpUrl = mcpUrl
    this.headers = headers
  }

  async sendRequest(method: string, params: any): Promise<any> {
    const firebaseAuth = FirebaseAuthService.getInstance()
    const idToken = await firebaseAuth.getIdToken()

    if (!idToken) throw new Error('Not authenticated')

    const response = await fetch(`${this.workerUrl}/v1/mcp-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        mcpUrl: this.mcpUrl,
        mcpHeaders: this.headers,
        jsonrpc: {
          jsonrpc: '2.0',
          id: Date.now(),
          method,
          params
        }
      })
    })

    if (!response.ok) {
      throw new Error(`MCP proxy error: ${response.status}`)
    }

    const result = await response.json()
    if (result.error) throw new Error(result.error.message)
    return result.result
  }

  async stop(): Promise<void> {
    // Nada a parar para remoto
  }
}
```

---

## 8. Worker — Endpoint MCP proxy

**Ficheiro:** `toquemedia-studio-api/src/index.ts`

**Adicionar** novo endpoint:

```typescript
if (url.pathname === '/v1/mcp-proxy' && request.method === 'POST') {
  // Auth (igual aos outros endpoints)
  // ...

  const body = await request.json() as {
    mcpUrl: string
    mcpHeaders: Record<string, string>
    jsonrpc: any
  }

  // Validar URL (bloquear localhost/internos)
  const parsedUrl = new URL(body.mcpUrl)
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0']
  if (blocked.includes(parsedUrl.hostname)) {
    return Response.json({ error: 'Blocked URL' }, { status: 400 })
  }

  // Forward para o MCP server remoto
  const mcpResponse = await fetch(body.mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...body.mcpHeaders
    },
    body: JSON.stringify(body.jsonrpc)
  })

  const result = await mcpResponse.json()

  return Response.json(result, {
    headers: { 'Access-Control-Allow-Origin': '*' }
  })
}
```

---

## 9. Integrar MCP tools no agente

### 9.1 Registar MCP tools no toolExecutor

**Ficheiro:** `src/services/agent/toolExecutor.ts`

```typescript
class ToolExecutor {
  private mcpService: MCPService

  getToolDefinitions(): ToolDefinition[] {
    // Tools nativas (12 existentes)
    const nativeTools = Object.entries(TOOL_MAP).map(([name, tool]) => ({
      type: 'function' as const,
      function: {
        name,
        description: tool.description,
        parameters: tool.input_schema
      }
    }))

    // Tools MCP (dinâmicas)
    const mcpTools = this.mcpService.getAllTools().map(tool => ({
      type: 'function' as const,
      function: {
        name: `mcp_${tool.serverName}_${tool.name}`,  // prefixo para distinguir
        description: `[MCP: ${tool.serverName}] ${tool.description}`,
        parameters: tool.inputSchema
      }
    }))

    return [...nativeTools, ...mcpTools]
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    // Verificar se é tool MCP
    if (toolName.startsWith('mcp_')) {
      return this.executeMCPTool(toolName, input)
    }

    // Tool nativa
    const tool = TOOL_MAP[toolName]
    if (!tool) throw new Error(`Unknown tool: ${toolName}`)
    return tool.execute(input)
  }

  private async executeMCPTool(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<string> {
    // Parse: mcp_github_create_issue → server=github, tool=create_issue
    const parts = toolName.split('_')
    const serverName = parts[1]
    const mcpToolName = parts.slice(2).join('_')

    return this.mcpService.callTool(serverName, mcpToolName, input)
  }
}
```

### 9.2 Classificação de permissões para MCP tools

**Todas as MCP tools pedem permissão.** O user precisa de aprovar antes do agente executar uma tool de um MCP server externo.

```typescript
// No permissionStore:
function requiresPermission(toolName: string): boolean {
  if (SAFE_TOOLS.has(toolName)) return false
  if (toolName.startsWith('mcp_')) return true  // MCP sempre pede
  return REQUIRES_PERMISSION.has(toolName)
}
```

---

## 10. Inicialização — lifecycle

### Ao abrir projecto:

```typescript
// Em App.tsx ou MainLayout, quando projectPath muda:
useEffect(() => {
  if (currentProject) {
    // Iniciar MCP servers configurados
    mcpService.initialize(currentProject.path).catch(console.error)
  }

  return () => {
    // Parar MCP servers ao fechar/trocar projecto
    mcpService.shutdown().catch(console.error)
  }
}, [currentProject])
```

### Skills são carregadas a cada prompt:

```typescript
// No contextBuilder.buildSystemPrompt:
// Skills são lidas do disco a cada chamada (podem ter mudado)
const skills = await skillService.loadSkills(projectPath)
```

---

## 11. UI — Gestão de MCP servers

### 11.1 Criar MCPPanel.tsx

**Criar:** `src/components/settings/MCPPanel.tsx`

**Acessível via:** Settings, ao lado do SkillsPanel.

```
┌──────────────────────────────────────────────┐
│ MCP Servers                           [+ Add] │
│                                               │
│ ┌───────────────────────────────────────────┐ │
│ │ 🟢 github (stdio)                   [⏹️]  │ │
│ │    Tools: create_issue, list_prs,         │ │
│ │           create_pr, merge_pr             │ │
│ ├───────────────────────────────────────────┤ │
│ │ 🟢 company-api (remote)             [⏹️]  │ │
│ │    Tools: search_docs, get_config         │ │
│ ├───────────────────────────────────────────┤ │
│ │ 🔴 postgres (stdio) — Error         [🔄]  │ │
│ │    DATABASE_URL not set                   │ │
│ └───────────────────────────────────────────┘ │
│                                               │
│ Config: .tms/mcp.json                         │
│ [Edit Config]                                 │
└──────────────────────────────────────────────┘
```

**Status por server:**
- 🟢 Running — tools disponíveis
- 🟡 Starting — a iniciar
- 🔴 Error — falhou (mostra erro)
- ⚪ Stopped — parado manualmente

**Acções:**
- **Stop (⏹️):** Para o server
- **Restart (🔄):** Reinicia o server
- **Edit Config:** Abre `.tms/mcp.json` no editor Monaco

### 11.2 Indicador no AgentStatusBar

```
🟢 Ready | Skills: 3 | MCP: 2 servers (8 tools) | Tokens: 0
```

---

## Critérios de Done

### Skills:
- [ ] `skillService.ts` criado — load, create, delete skills (3 níveis)
- [ ] Suporta formato simples (.md) e agentskills.io (pasta com SKILL.md + references/)
- [ ] 8 skills bundled criados em `src-tauri/resources/skills/`
- [ ] Skills bundled filtrados automaticamente por projectType detectado
- [ ] Skills bundled em tauri.conf.json resources
- [ ] Skills globais carregados de `~/.toquemedia-studio/skills/`
- [ ] Skills de projecto carregados de `.tms/skills/`
- [ ] Skills injectados no system prompt: bundled → global → projecto
- [ ] `detectProjectType()` funciona para React, Vue, Angular, Svelte, Next, Go, Python
- [ ] Tauri command `list_directory_entries` criado
- [ ] `SkillsPanel.tsx` — listar 3 níveis, criar, editar, apagar (bundled read-only)
- [ ] Install from GitHub via `npx skills add`
- [ ] AgentStatusBar mostra count de skills com breakdown

### MCP:
- [ ] `mcpService.ts` criado — initialize, start, stop, listTools, callTool
- [ ] `stdioTransport.ts` — lança processo, comunica via stdin/stdout JSON-RPC
- [ ] `remoteTransport.ts` — comunica via Worker proxy
- [ ] Worker endpoint `/v1/mcp-proxy` criado
- [ ] Config lida de `.tms/mcp.json` (projecto) + `~/.toquemedia-studio/mcp.json` (global)
- [ ] Variáveis de ambiente resolvidas (`${env:VAR}`)
- [ ] MCP tools registadas no toolExecutor com prefixo `mcp_`
- [ ] MCP tools aparecem nas tool definitions enviadas ao LLM
- [ ] MCP tools pedem permissão sempre
- [ ] `MCPPanel.tsx` — listar servers, status, tools, start/stop
- [ ] Tauri shell plugin configurado
- [ ] MCP servers param ao fechar/trocar projecto
- [ ] `npm run build` sem erros nos dois projectos

---

## O que NÃO fazer

- Não implementar MCP resources (apenas tools por agora)
- Não implementar MCP prompts (apenas tools)
- Não implementar MCP sampling (o LLM não chama o MCP para sampling)
- Não implementar discovery automático de MCP servers (config manual)
- Não implementar marketplace de MCP servers (futuro)
- Não implementar hot-reload de MCP config (restart manual)
- Não implementar MCP notifications (futuro)
- Não lançar MCP stdio processes fora do Tauri shell plugin (segurança)
