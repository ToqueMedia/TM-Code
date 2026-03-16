# Patch: Environment Requirements Check

> **Destino:** Claude Code  
> **Projecto:** `exodus-ide/` (IDE)  
> **Pré-requisito:** Templates implementados  
> **Objectivo:** Antes de scaffoldar um template, verificar que o user tem as dependências de desenvolvimento instaladas (Node, Go, Python, etc.). Se faltar algo, informar claramente com links de instalação. Não bloquear — permitir continuar anyway.

---

## Flow

```
User escolhe template
  ↓
environmentCheck.verify(template.requirements)
  ↓
┌─────────────┐     ┌──────────────────┐
│ Tudo OK     │     │ Falta algo       │
│ ✅ Node 22  │     │ ❌ Node not found │
│ ✅ npm 10   │     │ ❌ npm not found  │
└──────┬──────┘     └────────┬─────────┘
       │                     │
       ▼                     ▼
  Scaffold              RequirementsDialog
  normal                 (informar + links)
                              │
                    ┌─────────┴──────────┐
                    │                    │
              [Continue anyway]    [Cancel]
                    │
                    ▼
              Scaffold (user assumiu risco)
```

---

## 1. Definir requirements por template

**Ficheiro:** Manifesto `.toquemedia-template` de cada template

**Adicionar campo `requirements`:**

```json
{
  "framework": "react",
  "installCommand": "npm install",
  "devCommand": "npm run dev",
  "requirements": [
    {
      "name": "Node.js",
      "command": "node",
      "versionFlag": "--version",
      "minVersion": "18.0.0",
      "installUrl": "https://nodejs.org",
      "installHint": "Download from nodejs.org or use nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
    },
    {
      "name": "npm",
      "command": "npm",
      "versionFlag": "--version",
      "minVersion": "9.0.0",
      "installUrl": "https://nodejs.org",
      "installHint": "Included with Node.js"
    }
  ]
}
```

### Requirements por grupo de templates

| Templates | Requirements |
|---|---|
| React+TS, Next.js, Vue+TS, Nuxt, SvelteKit, Angular, Astro, Express+TS, Fastify+TS, React+Express monorepo | Node.js ≥ 18, npm ≥ 9 |
| Go + Gin | Go ≥ 1.21 |
| Python + FastAPI | Python ≥ 3.10, pip |

---

## 2. Criar environmentCheck.ts

**Criar:** `src/services/environmentCheck.ts`

```typescript
import { invoke } from '@tauri-apps/api/core'

interface Requirement {
  name: string
  command: string
  versionFlag: string
  minVersion: string
  installUrl: string
  installHint: string
}

interface CheckResult {
  requirement: Requirement
  found: boolean
  version: string | null        // "22.1.0" ou null se não encontrado
  meetsMinimum: boolean         // true se version >= minVersion
  error: string | null          // mensagem de erro se falhou
}

interface EnvironmentCheckResult {
  allPassed: boolean
  results: CheckResult[]
}

class EnvironmentCheck {
  private static instance: EnvironmentCheck

  static getInstance(): EnvironmentCheck {
    if (!EnvironmentCheck.instance) {
      EnvironmentCheck.instance = new EnvironmentCheck()
    }
    return EnvironmentCheck.instance
  }

  async verify(requirements: Requirement[]): Promise<EnvironmentCheckResult> {
    const results: CheckResult[] = []

    for (const req of requirements) {
      const result = await this.checkSingle(req)
      results.push(result)
    }

    return {
      allPassed: results.every(r => r.found && r.meetsMinimum),
      results
    }
  }

  private async checkSingle(req: Requirement): Promise<CheckResult> {
    try {
      const output = await invoke<{
        stdout: string
        stderr: string
        exitCode: number
        success: boolean
      }>('execute_command', {
        command: `${req.command} ${req.versionFlag}`,
        cwd: null
      })

      if (!output.success) {
        return {
          requirement: req,
          found: false,
          version: null,
          meetsMinimum: false,
          error: `Command failed: ${req.command}`
        }
      }

      // Extrair versão do output
      // Formatos comuns:
      //   node --version → "v22.1.0"
      //   npm --version  → "10.8.0"
      //   go version     → "go version go1.22.3 darwin/arm64"
      //   python3 --version → "Python 3.12.0"
      //   pip3 --version → "pip 24.0 from ..."
      const rawOutput = (output.stdout || output.stderr || '').trim()
      const version = this.extractVersion(rawOutput)

      if (!version) {
        return {
          requirement: req,
          found: true,
          version: null,
          meetsMinimum: false,
          error: `Could not parse version from: ${rawOutput}`
        }
      }

      const meetsMinimum = this.compareVersions(version, req.minVersion) >= 0

      return {
        requirement: req,
        found: true,
        version,
        meetsMinimum,
        error: meetsMinimum ? null : `Version ${version} is below minimum ${req.minVersion}`
      }

    } catch (error) {
      return {
        requirement: req,
        found: false,
        version: null,
        meetsMinimum: false,
        error: `${req.name} not found. Is it installed and in your PATH?`
      }
    }
  }

  // Extrair versão numérica de output arbitrário
  private extractVersion(output: string): string | null {
    // Match padrões como: v22.1.0, 10.8.0, go1.22.3, Python 3.12.0
    const match = output.match(/v?(\d+\.\d+(?:\.\d+)?)/)
    return match ? match[1] : null
  }

  // Comparar versões semver (simplificado)
  // Retorna: >0 se a > b, 0 se igual, <0 se a < b
  private compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number)
    const partsB = b.split('.').map(Number)
    const len = Math.max(partsA.length, partsB.length)

    for (let i = 0; i < len; i++) {
      const numA = partsA[i] || 0
      const numB = partsB[i] || 0
      if (numA !== numB) return numA - numB
    }
    return 0
  }
}

export const environmentCheck = EnvironmentCheck.getInstance()
```

---

## 3. Criar RequirementsDialog.tsx

**Criar:** `src/components/dialogs/RequirementsDialog.tsx`

```typescript
interface RequirementsDialogProps {
  isOpen: boolean
  results: CheckResult[]
  onContinue: () => void     // user quer continuar mesmo assim
  onCancel: () => void
}
```

**UI:**

```
┌─────────────────────────────────────────────────┐
│ ⚠️  Missing Requirements                        │
│                                                  │
│ This template requires tools that were not       │
│ found on your system:                            │
│                                                  │
│ ❌ Node.js — not found                           │
│    Install from https://nodejs.org               │
│    Or use nvm:                                   │
│    curl -o- https://raw.githubusercontent.com/   │
│    nvm-sh/nvm/v0.40.3/install.sh | bash          │
│    [Open nodejs.org]                             │
│                                                  │
│ ❌ npm — not found                               │
│    Included with Node.js                         │
│                                                  │
│ ─────────────────────────────────────────────    │
│                                                  │
│ Without these tools, the project will not        │
│ build or run. You can still scaffold the         │
│ files and install the tools later.               │
│                                                  │
│        [Cancel]    [Continue anyway]             │
└─────────────────────────────────────────────────┘
```

**Quando tudo OK mas versão abaixo do mínimo:**

```
┌─────────────────────────────────────────────────┐
│ ⚠️  Version Warning                             │
│                                                  │
│ ⚠️ Node.js v16.20.0 — minimum required: 18.0.0  │
│    Update from https://nodejs.org                │
│    [Open nodejs.org]                             │
│                                                  │
│ ✅ npm v9.8.0                                    │
│                                                  │
│        [Cancel]    [Continue anyway]             │
└─────────────────────────────────────────────────┘
```

**Quando tudo OK:**

O dialog NÃO aparece. Scaffold continua directamente.

**Cada item mostra:**
- ✅ verde se encontrado e versão OK: `✅ Node.js v22.1.0`
- ⚠️ amarelo se encontrado mas versão abaixo: `⚠️ Node.js v16.20.0 — minimum: 18.0.0`
- ❌ vermelho se não encontrado: `❌ Node.js — not found`

**Botão [Open ...]:** Abre o installUrl no browser default do OS via Tauri shell plugin:

```typescript
import { open } from '@tauri-apps/plugin-shell'
await open(installUrl)
```

---

## 4. Integrar no flow de scaffold

**Ficheiro:** Onde o scaffold é disparado (TemplateSelector.tsx ou equivalente)

**Antes:**
```typescript
// User clica "Create Project"
await templateService.scaffold(templateId, destinationPath)
```

**Depois:**
```typescript
// User clica "Create Project"
const template = templateService.getById(templateId)

// 1. Verificar requirements
if (template.requirements && template.requirements.length > 0) {
  const checkResult = await environmentCheck.verify(template.requirements)

  if (!checkResult.allPassed) {
    // Mostrar dialog — esperar decisão do user
    const shouldContinue = await showRequirementsDialog(checkResult.results)
    
    if (!shouldContinue) {
      return  // User cancelou
    }
    // User escolheu "Continue anyway" — prosseguir
  }
}

// 2. Scaffold
await templateService.scaffold(templateId, destinationPath)

// 3. Post-scaffold pipeline (install + dev server)
await postScaffoldPipeline(destinationPath, template)
```

---

## 5. Actualizar os 12 manifestos de templates

Cada `.toquemedia-template` precisa do campo `requirements`:

### Templates Node.js (10 templates)

```json
"requirements": [
  {
    "name": "Node.js",
    "command": "node",
    "versionFlag": "--version",
    "minVersion": "18.0.0",
    "installUrl": "https://nodejs.org",
    "installHint": "Download from nodejs.org or install via nvm"
  },
  {
    "name": "npm",
    "command": "npm",
    "versionFlag": "--version",
    "minVersion": "9.0.0",
    "installUrl": "https://nodejs.org",
    "installHint": "Included with Node.js"
  }
]
```

### Template Go + Gin

```json
"requirements": [
  {
    "name": "Go",
    "command": "go",
    "versionFlag": "version",
    "minVersion": "1.21.0",
    "installUrl": "https://go.dev/dl/",
    "installHint": "Download from go.dev or use brew: brew install go"
  }
]
```

### Template Python + FastAPI

```json
"requirements": [
  {
    "name": "Python",
    "command": "python3",
    "versionFlag": "--version",
    "minVersion": "3.10.0",
    "installUrl": "https://www.python.org/downloads/",
    "installHint": "Download from python.org or use brew: brew install python3"
  },
  {
    "name": "pip",
    "command": "pip3",
    "versionFlag": "--version",
    "minVersion": "22.0.0",
    "installUrl": "https://www.python.org/downloads/",
    "installHint": "Included with Python 3"
  }
]
```

---

## 6. Caching — não verificar a cada scaffold

Para evitar verificar o ambiente sempre que o user cria projecto, cache o resultado por 5 minutos:

```typescript
class EnvironmentCheck {
  private cache: Map<string, {
    result: EnvironmentCheckResult
    timestamp: number
  }> = new Map()

  private CACHE_TTL = 5 * 60 * 1000  // 5 minutos

  async verify(requirements: Requirement[]): Promise<EnvironmentCheckResult> {
    // Gerar cache key baseado nos commands
    const cacheKey = requirements.map(r => r.command).sort().join(',')

    const cached = this.cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.result
    }

    // Check real
    const results: CheckResult[] = []
    for (const req of requirements) {
      results.push(await this.checkSingle(req))
    }

    const result = {
      allPassed: results.every(r => r.found && r.meetsMinimum),
      results
    }

    this.cache.set(cacheKey, { result, timestamp: Date.now() })
    return result
  }

  // Limpar cache (ex: user diz que instalou)
  clearCache(): void {
    this.cache.clear()
  }
}
```

---

## Critérios de Done

- [ ] `environmentCheck.ts` criado — verify, checkSingle, extractVersion, compareVersions
- [ ] `RequirementsDialog.tsx` criado — mostra resultados com ✅/⚠️/❌
- [ ] Dialog mostra link de instalação + hint para cada requirement falhado
- [ ] Botão "Open [url]" abre browser via Tauri shell plugin
- [ ] Botão "Continue anyway" permite prosseguir sem requirements
- [ ] Botão "Cancel" volta ao TemplateSelector
- [ ] Check integrado no flow de scaffold (antes de scaffoldar)
- [ ] Dialog NÃO aparece quando todos os checks passam
- [ ] Cache de 5 minutos para evitar checks repetidos
- [ ] 12 manifestos `.toquemedia-template` actualizados com campo `requirements`
- [ ] Extracção de versão funciona com Node, npm, Go, Python, pip
- [ ] Comparação de versão semver funciona
- [ ] `npm run build` sem erros

---

## O que NÃO fazer

- Não instalar ferramentas automaticamente (fora do scope de uma IDE)
- Não implementar gestão de versões (nvm, pyenv, etc.)
- Não bloquear o scaffold — "Continue anyway" sempre disponível
- Não verificar requirements para projectos existentes (apenas templates novos)
- Não verificar packages npm/pip específicos (apenas runtime: node, go, python)
- Não modificar o Worker
- Não mostrar dialog se tudo OK
