/**
 * Contabilidade de LEITURAS para os evals — quantas vezes o agente voltou a
 * buscar conteúdo que já tinha.
 *
 * PORQUÊ EXISTE COMO MÓDULO PRÓPRIO (2026-08-07)
 * ──────────────────────────────────────────────
 * A primeira versão vivia inline no headlessRunner e contava apenas tool calls
 * cujo nome batesse `/read/i` E que trouxessem um `file_path`. Isso deixa de
 * fora `execute_command` (`tail`, `grep`, `sed`…), `search_files` e `glob` —
 * e o modelo troca de estratégia sozinho: nas corridas da matriz de 07-08
 * apareceram células com **"0 releituras de 0 ficheiros"** em corridas que
 * ACERTARAM a soma de oito ficheiros. Ler oito ficheiros e ser visto a ler
 * zero não é uma corrida limpa — é o instrumento cego.
 *
 * O perigo não é o número errado: é ser INDISTINGUÍVEL do número certo. Um
 * zero de cegueira lê-se como o melhor resultado possível, e enviesa a
 * comparação para o braço onde a cegueira calhar.
 *
 * O QUE ESTE MÓDULO GARANTE, E O QUE NÃO
 * ──────────────────────────────────────
 * Garante: leituras por ferramenta de ficheiro E por comando de shell entram
 * na mesma conta; e `toolsUsed` expõe a MISTURA de ferramentas, para uma
 * mudança de estratégia ser visível em vez de silenciosa.
 *
 * NÃO garante precisão de parser: extrair caminhos de uma linha de shell é
 * heurística. Um `grep -rn foo src/` conta como leitura de um caminho que é
 * uma pasta; um comando exótico pode escapar. Por isso `toolsUsed` vai no
 * resultado — quem interpretar um export vê a mistura e sabe quanto pesar o
 * número, em vez de confiar num total que não pode auditar.
 */

/** Comandos de shell que LÊEM o conteúdo de um ficheiro. */
const SHELL_READ_COMMANDS =
  /^(cat|tail|head|sed|awk|nl|less|more|strings|grep|rg|egrep|fgrep)$/

/** Separadores que dividem uma linha de shell em comandos independentes. */
const SEGMENT_SPLIT = /\||&&|\|\||;|\n/

export interface ToolCallLike {
  toolName: string
  input?: unknown
}

export interface MessageLike {
  toolCalls?: ToolCallLike[]
}

export interface ReadAccounting {
  /** Nº de acessos a um ficheiro que já tinha sido lido antes. */
  rereads: number
  /** Ficheiros distintos vistos a ser lidos, por qualquer via. */
  distinctFilesRead: number
  /** Mistura de ferramentas usadas (nome → nº de chamadas). */
  toolsUsed: Record<string, number>
  /** Quantas leituras vieram de comandos de shell — 0 aqui e um
   *  `distinctFilesRead` alto significa que a estratégia foi de tool calls. */
  shellReads: number
}

/**
 * Um token de uma linha de shell parece um caminho de ficheiro?
 *
 * Conservador de propósito: exige barra OU extensão. Assim o PADRÃO de um
 * `grep REFERENCIA_AUTH src/auth.js` (sem barra, sem extensão) não é contado
 * como ficheiro, que é o falso positivo mais provável. Tokens terminados em
 * `/` são pastas e ficam de fora.
 */
function pareceCaminho(token: string): boolean {
  if (!token || token.startsWith('-')) return false
  if (token.endsWith('/')) return false
  return token.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(token)
}

/** Tira aspas simples/duplas à volta de um token. */
function semAspas(token: string): string {
  return token.replace(/^["']|["']$/g, '')
}

/**
 * Caminhos que um comando de shell terá LIDO. Vazio quando o comando não é de
 * leitura — um `npm test` ou um `git commit` não contam.
 */
export function extractShellReadTargets(command: string): string[] {
  if (!command) return []
  const alvos: string[] = []
  for (const segmento of command.split(SEGMENT_SPLIT)) {
    const tokens = segmento.trim().split(/\s+/).filter(Boolean).map(semAspas)
    if (tokens.length === 0) continue
    // O comando é o primeiro token; `sudo x` e caminhos como /bin/cat contam
    // pelo último segmento do nome.
    const nome = (tokens[0].split('/').pop() ?? '').toLowerCase()
    if (!SHELL_READ_COMMANDS.test(nome)) continue
    for (const token of tokens.slice(1)) {
      if (pareceCaminho(token)) alvos.push(token)
    }
  }
  return alvos
}

/**
 * Chave de comparação entre vias diferentes: o ÚLTIMO segmento do caminho.
 *
 * Simplificação deliberada — o `read_file` usa caminho absoluto e a shell
 * costuma usar relativo, portanto comparar caminhos inteiros contaria a mesma
 * leitura duas vezes como ficheiros diferentes. O custo é conflacionar
 * ficheiros homónimos em pastas distintas; nas fixtures de eval os nomes são
 * únicos, e o alternativa (não comparar de todo) é o ponto cego que isto veio
 * fechar.
 */
function chave(caminho: string): string {
  return (caminho.split('/').pop() ?? caminho).toLowerCase()
}

/** Alvos lidos por UMA tool call, por qualquer via. */
function alvosDaChamada(tc: ToolCallLike): { alvos: string[]; viaShell: boolean } {
  const input = (tc.input ?? {}) as Record<string, unknown>

  // Via 1: ferramenta de ficheiro com caminho explícito.
  const filePath = input.file_path
  if (typeof filePath === 'string' && /read/i.test(tc.toolName)) {
    return { alvos: [filePath], viaShell: false }
  }

  // Via 2: comando de shell que lê. O nome da tool não é fiável (aliases:
  // execute_command, Bash, …), portanto o gatilho é haver um `command`.
  const command = input.command
  if (typeof command === 'string') {
    const alvos = extractShellReadTargets(command)
    return { alvos, viaShell: alvos.length > 0 }
  }

  return { alvos: [], viaShell: false }
}

/**
 * Percorre as mensagens e conta leituras e releituras por TODAS as vias.
 */
export function computeReadAccounting(messages: MessageLike[]): ReadAccounting {
  const vistos = new Map<string, number>()
  const toolsUsed: Record<string, number> = {}
  let rereads = 0
  let shellReads = 0

  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      toolsUsed[tc.toolName] = (toolsUsed[tc.toolName] ?? 0) + 1
      const { alvos, viaShell } = alvosDaChamada(tc)
      if (viaShell) shellReads += alvos.length
      for (const alvo of alvos) {
        const k = chave(alvo)
        const n = (vistos.get(k) ?? 0) + 1
        vistos.set(k, n)
        if (n > 1) rereads++
      }
    }
  }

  return { rereads, distinctFilesRead: vistos.size, toolsUsed, shellReads }
}
