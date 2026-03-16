# Patch: Fix Post-Scaffold Flow — Install + Dev Server + Live Preview

> **Destino:** Claude Code  
> **Projecto:** `exodus-ide/` (IDE)  
> **Pré-requisito:** Templates implementados  
> **Objectivo:** Corrigir o flow pós-scaffold: instalar dependências automaticamente, lançar dev server, mostrar preview live num iframe.

---

## Problema Actual

```
ACTUAL:   Scaffold → Open Project → (projecto morto, nada funciona)
ESPERADO: Scaffold → Install deps → Start dev server → Show preview
```

4 problemas identificados pela auditoria:
1. `npm install` nunca executa após scaffold
2. Dev server nunca inicia
3. Preview é estático (não funciona com React/Vue/etc.)
4. Monorepo não instala dependências nos subdirectórios

---

## Flow Correcto

```
1. User escolhe template + pasta
2. IDE copia template (scaffold_template) ✅ já funciona
3. IDE lê .toquemedia-template manifesto
4. IDE corre installCommand ("npm install") ← FIX
5. IDE mostra progresso no chat
6. Quando install completa, IDE corre devCommand ("npm run dev") ← FIX
7. IDE detecta URL no output (localhost:5173) ← FIX
8. IDE abre PreviewView com iframe apontando ao URL ← FIX
9. Hot reload funciona — agente modifica ficheiro → preview actualiza
```

---

## 1. Actualizar flow pós-scaffold

**Ficheiro:** Onde o scaffold é disparado (provavelmente `TemplateSelector.tsx` ou `WelcomeScreen.tsx`)

**Actualmente:**
```typescript
await templateService.scaffold(templateId, destinationPath)
projectStore.openProject(destinationPath)
// FIM — projecto morto
```

**Corrigir para:**
```typescript
const template = templateService.getById(templateId)

// 1. Scaffold
await templateService.scaffold(templateId, destinationPath)

// 2. Open project (para o agente ter contexto)
projectStore.openProject(destinationPath)

// 3. Criar sessão de chat
chatStore.createNewSession(destinationPath)

// 4. Post-scaffold pipeline (install + dev server)
await postScaffoldPipeline(destinationPath, template)
```

---

## 2. Criar postScaffoldPipeline

**Criar:** `src/services/agent/postScaffoldPipeline.ts`

```typescript
import { invoke } from '@tauri-apps/api/core'
import { useChatStore } from '../../stores/chatStore'
import { useLayoutStore } from '../../stores/layoutStore'

interface TemplateManifest {
  framework: string
  installCommand: string    // "npm install"
  devCommand: string        // "npm run dev"
  devPort?: number          // 5173 para Vite, 3000 para Next, etc.
}

export async function postScaffoldPipeline(
  projectPath: string,
  manifest: TemplateManifest
): Promise<void> {
  const chatStore = useChatStore.getState()

  // === FASE 1: Install dependencies ===
  chatStore.addSystemMessage(`📦 Installing dependencies...`)

  try {
    const installResult = await invoke<{
      stdout: string
      stderr: string
      exitCode: number
      success: boolean
    }>('execute_command', {
      command: manifest.installCommand,
      cwd: projectPath
    })

    if (installResult.success) {
      chatStore.addSystemMessage(`✅ Dependencies installed successfully.`)
    } else {
      chatStore.addSystemMessage(
        `⚠️ Install finished with warnings.\n${installResult.stderr?.slice(0, 500) || ''}`
      )
      // Não bloquear — warnings do npm são comuns
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    chatStore.addSystemMessage(
      `❌ Failed to install dependencies: ${msg}\nYou can try running "${manifest.installCommand}" manually in the terminal.`
    )
    // Não bloquear — user pode instalar manualmente
    return
  }

  // === FASE 2: Start dev server ===
  chatStore.addSystemMessage(`🚀 Starting dev server...`)

  try {
    await startDevServer(projectPath, manifest)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    chatStore.addSystemMessage(
      `⚠️ Could not start dev server: ${msg}\nYou can start it manually: ${manifest.devCommand}`
    )
  }
}
```

---

## 3. Dev Server Manager

**Criar:** `src/services/devServerManager.ts`

**Responsabilidade:** Lançar, monitorizar, e parar dev servers. Detectar URL no output.

```typescript
import { Command } from '@tauri-apps/plugin-shell'
import { useChatStore } from '../stores/chatStore'
import { useLayoutStore } from '../stores/layoutStore'

interface DevServerState {
  process: any              // Tauri child process
  url: string | null        // URL detectado (localhost:5173)
  status: 'starting' | 'running' | 'stopped' | 'error'
  projectPath: string
  command: string
}

class DevServerManager {
  private static instance: DevServerManager
  private currentServer: DevServerState | null = null

  static getInstance(): DevServerManager {
    if (!DevServerManager.instance) {
      DevServerManager.instance = new DevServerManager()
    }
    return DevServerManager.instance
  }

  async start(projectPath: string, devCommand: string): Promise<void> {
    // Parar server anterior se existir
    await this.stop()

    // Separar comando e args
    // "npm run dev" → command: "npm", args: ["run", "dev"]
    const parts = devCommand.split(' ')
    const command = parts[0]
    const args = parts.slice(1)

    const chatStore = useChatStore.getState()
    const layoutStore = useLayoutStore.getState()

    this.currentServer = {
      process: null,
      url: null,
      status: 'starting',
      projectPath,
      command: devCommand
    }

    try {
      const cmd = Command.create(command, args, {
        cwd: projectPath,
        env: {
          // Forçar saída com cores desactivadas para parsing limpo
          FORCE_COLOR: '0',
          NO_COLOR: '1'
        }
      })

      // Monitorizar stdout para detectar URL
      cmd.stdout.on('data', (data: string) => {
        this.handleOutput(data, 'stdout')
      })

      cmd.stderr.on('data', (data: string) => {
        // Muitos dev servers (Vite, Next) enviam output para stderr
        this.handleOutput(data, 'stderr')
      })

      cmd.on('close', (code: number) => {
        if (this.currentServer) {
          this.currentServer.status = 'stopped'
          if (code !== 0 && code !== null) {
            chatStore.addSystemMessage(`⚠️ Dev server exited with code ${code}`)
          }
        }
      })

      cmd.on('error', (error: string) => {
        if (this.currentServer) {
          this.currentServer.status = 'error'
          chatStore.addSystemMessage(`❌ Dev server error: ${error}`)
        }
      })

      this.currentServer.process = await cmd.spawn()

    } catch (error) {
      this.currentServer.status = 'error'
      throw error
    }
  }

  private handleOutput(data: string, stream: string): void {
    if (!this.currentServer) return

    // Detectar URL no output
    // Patterns comuns:
    //   Vite:     "Local:   http://localhost:5173/"
    //   Next.js:  "- Local: http://localhost:3000"
    //   CRA:      "Local:   http://localhost:3000"
    //   Angular:  "Local: http://localhost:4200"
    //   Nuxt:     "Local:    http://localhost:3000"
    //   Astro:    "Local    http://localhost:4321"
    //   Express:  "Server listening on port 3000" ou "http://localhost:3000"

    const urlMatch = data.match(/https?:\/\/localhost:\d+\/?/)
    const portMatch = data.match(/(?:listening on|running at|port)\s+(\d{4,5})/i)

    let detectedUrl: string | null = null

    if (urlMatch) {
      detectedUrl = urlMatch[0]
    } else if (portMatch) {
      detectedUrl = `http://localhost:${portMatch[1]}`
    }

    if (detectedUrl && !this.currentServer.url) {
      // Primeira detecção de URL — dev server está pronto
      this.currentServer.url = detectedUrl
      this.currentServer.status = 'running'

      const chatStore = useChatStore.getState()
      const layoutStore = useLayoutStore.getState()

      chatStore.addSystemMessage(`✅ Dev server running at ${detectedUrl}`)

      // Transicionar para PreviewView automaticamente
      layoutStore.setPreviewUrl(detectedUrl)
      layoutStore.setViewMode('preview')
    }
  }

  async stop(): Promise<void> {
    if (this.currentServer?.process) {
      try {
        this.currentServer.process.kill()
      } catch {
        // Processo pode já ter terminado
      }
      this.currentServer = null
    }
  }

  // Restart (útil quando agente muda configs)
  async restart(): Promise<void> {
    if (!this.currentServer) return
    const { projectPath, command } = this.currentServer
    await this.stop()
    await this.start(projectPath, command)
  }

  getStatus(): DevServerState | null {
    return this.currentServer
  }

  getUrl(): string | null {
    return this.currentServer?.url || null
  }

  isRunning(): boolean {
    return this.currentServer?.status === 'running'
  }
}

export const devServerManager = DevServerManager.getInstance()
```

---

## 4. Actualizar layoutStore — preview URL

**Ficheiro:** `src/stores/layoutStore.ts`

**Adicionar:**

```typescript
interface LayoutState {
  // ... estado existente ...
  previewUrl: string | null
}

interface LayoutActions {
  // ... actions existentes ...
  setPreviewUrl: (url: string | null) => void
}
```

---

## 5. Actualizar PreviewView — iframe live

**Ficheiro:** `src/components/views/PreviewView.tsx`

**Estado actual:** Preview estático (staticPreviewBuilder).

**Novo:** Iframe apontando ao dev server live.

```typescript
function PreviewView() {
  const { previewUrl } = useLayoutStore()
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  if (!previewUrl) {
    return (
      <Flex align="center" justify="center" flex="1" direction="column" gap={4}>
        <Text color="text.muted">No dev server running</Text>
        <Text color="text.muted" fontSize="sm">
          Start a dev server to see the preview
        </Text>
      </Flex>
    )
  }

  return (
    <Flex direction="column" flex="1" overflow="hidden">
      {/* Toolbar */}
      <Flex
        h="36px"
        align="center"
        px={3}
        gap={2}
        bg="bg.sidebar"
        borderBottom="1px solid"
        borderColor="border.default"
      >
        {/* URL bar */}
        <Flex
          flex="1"
          bg="bg.input"
          borderRadius="md"
          px={2}
          py={1}
          align="center"
        >
          <Text fontSize="xs" color="text.muted" fontFamily="mono">
            {previewUrl}
          </Text>
        </Flex>

        {/* Actions */}
        <IconButton
          icon={<FiRefreshCw />}
          size="xs"
          aria-label="Refresh"
          onClick={() => {
            if (iframeRef.current) {
              iframeRef.current.src = previewUrl
            }
          }}
        />
        <IconButton
          icon={<FiExternalLink />}
          size="xs"
          aria-label="Open in browser"
          onClick={() => {
            window.open(previewUrl, '_blank')
          }}
        />
        <IconButton
          icon={<FiSquare />}
          size="xs"
          aria-label="Stop server"
          onClick={() => {
            devServerManager.stop()
            useLayoutStore.getState().setPreviewUrl(null)
            useLayoutStore.getState().setViewMode('chat')
          }}
        />
      </Flex>

      {/* Iframe */}
      <Box flex="1" position="relative">
        {isLoading && (
          <Flex
            position="absolute"
            inset="0"
            align="center"
            justify="center"
            bg="bg.app"
            zIndex={1}
          >
            <Spinner />
            <Text ml={2} color="text.muted">Loading preview...</Text>
          </Flex>
        )}

        <iframe
          ref={iframeRef}
          src={previewUrl}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            backgroundColor: 'white'
          }}
          onLoad={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false)
            setError('Failed to load preview')
          }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          title="Preview"
        />
      </Box>
    </Flex>
  )
}
```

---

## 6. Auto-transição para PreviewView

A Fase 4 já definiu auto-transições entre views. Garantir que funcionam:

```
ChatView → PreviewView: quando devServerManager detecta URL no output
PreviewView → ChatView: quando user fecha preview ou server para
```

O trigger já está no `devServerManager.handleOutput()`:
```typescript
layoutStore.setPreviewUrl(detectedUrl)
layoutStore.setViewMode('preview')
```

---

## 7. Fix para monorepo (react-express-ts)

**Problema:** O template monorepo tem `client/` e `server/` com package.json próprios. O `npm install` na raiz não instala dependências dos subdirectórios.

**Fix no postScaffoldPipeline:**

Ler o manifesto `.toquemedia-template` para detectar se é monorepo:

```typescript
// No manifesto do template react-express-ts:
{
  "framework": "react+express",
  "installCommand": "npm install",
  "devCommand": "npm run dev",
  "monorepo": true,
  "workspaces": ["client", "server"]
}
```

```typescript
// No postScaffoldPipeline, antes do install:
if (manifest.monorepo && manifest.workspaces) {
  // Se é monorepo com workspaces npm, o npm install na raiz
  // já deve instalar tudo (se package.json tem "workspaces")
  // Verificar que o package.json raiz tem workspaces configurado
  
  // Se não usa npm workspaces, instalar em cada subdirectório:
  for (const workspace of manifest.workspaces) {
    chatStore.addSystemMessage(`📦 Installing ${workspace} dependencies...`)
    await invoke('execute_command', {
      command: manifest.installCommand,
      cwd: `${projectPath}/${workspace}`
    })
  }
} else {
  // Projecto normal — install na raiz
  await invoke('execute_command', {
    command: manifest.installCommand,
    cwd: projectPath
  })
}
```

---

## 8. Remover staticPreviewBuilder

**Ficheiro:** `src/services/staticPreviewBuilder.ts` (ou onde estiver)

**Acção:** Pode ser removido ou mantido como fallback para ficheiros HTML isolados. Se mantiver, o PreviewView tenta primeiro o dev server URL, e se não houver, tenta o static preview.

Decisão: **manter como fallback** — se o user abre um projecto com apenas `index.html` sem framework, o static preview funciona.

```typescript
// PreviewView logic:
if (previewUrl) {
  // Dev server live → iframe com URL
  return <LivePreview url={previewUrl} />
} else if (staticHtmlPath) {
  // Fallback: ficheiro HTML estático
  return <StaticPreview path={staticHtmlPath} />
} else {
  // Nada para preview
  return <NoPreview />
}
```

---

## 9. Parar dev server no cleanup

**Quando:**
- User fecha o projecto → `devServerManager.stop()`
- User troca de projecto → `devServerManager.stop()` antes de abrir novo
- App fecha → `devServerManager.stop()`

**Ficheiro:** `src/App.tsx` ou `MainLayout.tsx`

```typescript
useEffect(() => {
  return () => {
    // Cleanup ao desmontar
    devServerManager.stop()
  }
}, [])

// Ao trocar de projecto:
useEffect(() => {
  if (currentProject) {
    // Parar server anterior
    devServerManager.stop()
    useLayoutStore.getState().setPreviewUrl(null)
  }
}, [currentProject?.path])
```

---

## 10. Tauri Shell Plugin — verificar

O `devServerManager` usa `Command.create()` do `@tauri-apps/plugin-shell` para lançar o dev server como child process (mesmo plugin usado pelo MCP stdio). Verificar que:

- `tauri-plugin-shell` está no Cargo.toml
- `@tauri-apps/plugin-shell` está no package.json
- Permissões `shell:allow-spawn` configuradas

Se o patch de MCP já foi aplicado, isto já está configurado.

---

## Critérios de Done

- [ ] `postScaffoldPipeline.ts` criado — orquestra install + dev server
- [ ] `devServerManager.ts` criado — start, stop, restart, detect URL
- [ ] Após scaffold, `npm install` executa automaticamente
- [ ] Progresso de install visível no chat (system messages)
- [ ] Após install, dev server inicia automaticamente
- [ ] URL detectado no output do dev server (Vite, Next, Angular, etc.)
- [ ] PreviewView transiciona automaticamente quando URL detectado
- [ ] PreviewView mostra iframe com dev server live (não estático)
- [ ] Toolbar com URL, refresh, open in browser, stop
- [ ] Hot reload funciona (agente modifica ficheiro → preview actualiza)
- [ ] Monorepo instala dependências em todos os workspaces
- [ ] Dev server para quando user fecha/troca projecto
- [ ] Static preview mantido como fallback para HTML simples
- [ ] `npm run build` sem erros

---

## O que NÃO fazer

- Não fazer build de produção (`npm run build`) — apenas dev server
- Não implementar múltiplos dev servers simultâneos (futuro)
- Não implementar responsive preview (device frames, etc.) — futuro
- Não modificar os templates existentes (apenas ler o manifesto)
- Não modificar o Worker
- Não implementar proxy para o dev server (iframe directo a localhost)
