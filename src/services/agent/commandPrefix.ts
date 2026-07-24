/**
 * Extração e matching de PREFIXO de comando para grants de permissão —
 * porte do sistema de prefixos do claude-vaz (`getSimpleCommandPrefix` +
 * `DEPTH_RULES` + guarda de compostos), adaptado ao TM.
 *
 * PORQUÊ (auditoria 2026-07-22, sessão momenu-fact)
 * ─────────────────────────────────────────────────
 * O grant "always allow" do TM era POR NOME de tool: aprovar um
 * `execute_command` uma vez dava carta-branca a QUALQUER comando de shell —
 * foi assim que um `gcloud secrets versions add` mutou o Secret Manager de
 * produção sem prompt. O claude-vaz nunca concede a tool inteira: grava uma
 * regra com o PREFIXO do comando (`Bash(gcloud secrets versions add:*)`),
 * narrow o suficiente para não arrastar comandos futuros. Este módulo é a
 * peça que reduz um comando ao seu prefixo de grant e decide se um comando
 * bate num conjunto de prefixos concedidos.
 *
 * TRÊS INVARIANTES DE SEGURANÇA (todas do claude-vaz):
 *   1. Prefixos bare-shell NUNCA são sugeridos (`bash:*`, `sh:*`, `env:*`,
 *      `sudo:*`, `xargs:*` deixariam passar código arbitrário via `-c`).
 *   2. Comandos COMPOSTOS (`a && b`, pipes, subshells) não têm prefixo e um
 *      prefixo concedido NUNCA bate num composto — senão `echo:*` arrastaria
 *      `echo x && rm -rf /`.
 *   3. Match por FRONTEIRA DE PALAVRA (`cmd === prefix` ou
 *      `cmd.startsWith(prefix + ' ')`) — para `ls:*` não bater `lsof`.
 *
 * Puro (sem imports de runtime) — testável em isolamento.
 */

/**
 * Profundidade de prefixo por raiz de comando. CLIs cloud/infra ganham
 * prefixos MAIS FUNDOS (o grant fica mais específico): `gcloud secrets
 * versions add` em vez de `gcloud`. Chaves multi-token batem primeiro (mais
 * específico ganha). Espelha o `DEPTH_RULES` do claude-vaz (specPrefix.ts),
 * estendido com as CLIs que o TM vê (firebase/wrangler) — foram o vetor real
 * do incidente. Sem regra ⇒ profundidade default (ver getCommandPrefix).
 */
const DEPTH_RULES: ReadonlyArray<{ prefix: readonly string[]; depth: number }> = [
  { prefix: ['gcloud', 'compute'], depth: 6 },
  { prefix: ['gcloud', 'beta'], depth: 6 },
  { prefix: ['gcloud'], depth: 4 },
  { prefix: ['aws'], depth: 4 },
  { prefix: ['az'], depth: 4 },
  { prefix: ['gsutil'], depth: 3 },
  { prefix: ['kubectl'], depth: 3 },
  { prefix: ['docker'], depth: 3 },
  { prefix: ['docker-compose'], depth: 3 },
  { prefix: ['firebase'], depth: 3 },
  { prefix: ['wrangler'], depth: 3 },
  { prefix: ['supabase'], depth: 3 },
  { prefix: ['vercel'], depth: 2 },
  { prefix: ['netlify'], depth: 2 },
  { prefix: ['heroku'], depth: 2 },
  { prefix: ['terraform'], depth: 2 },
  { prefix: ['flyctl'], depth: 2 },
  { prefix: ['fly'], depth: 2 },
]

/** Default para roots de DEV conhecidos: profundidade 2 (raiz + um sub-comando)
 *  quando o 2º token parece um sub-comando; senão 1 (a raiz só). É o caso comum
 *  e seguro (`git push`, `npm run`). Igual ao getSimpleCommandPrefix. */
const DEFAULT_DEPTH = 2

/**
 * Default CONSERVADOR para roots que NÃO estão nem no DEPTH_RULES nem na lista
 * de dev-tools conhecidos (KNOWN_DEV_ROOTS) — tipicamente um CLI cloud/infra
 * novo que a tabela estática ainda não cobre. Como o vetor do incidente foram
 * CLIs cloud (`gcloud secrets versions add`), um desconhecido cai numa
 * profundidade MAIOR: o grant fica mais ESTREITO (cobre menos comandos
 * futuros), nunca mais largo. Ir mais fundo é monotonicamente mais seguro — só
 * custa conveniência (mais re-prompts), e o user pode alargar o prefixo à mão
 * no diálogo. Cobre o "a tabela apodrece" sem fingir conhecer o CLI. */
const CONSERVATIVE_UNKNOWN_DEPTH = 3

/**
 * Roots de ferramentas de DEV locais onde a profundidade 2 é o grant certo e
 * seguro (`git push`, `npm run`, `cargo build`). Estar aqui evita que estas
 * caiam no default conservador (que as tornaria desnecessariamente estreitas).
 * NÃO é uma allow-list de segurança — é só a calibração de profundidade; o
 * gate de permissão/classificador é outra camada. Gerível à mão (ao contrário
 * das fig-specs do claude-vaz, que não replicamos).
 */
const KNOWN_DEV_ROOTS = new Set([
  'git', 'gh', 'hg', 'svn',
  'npm', 'npx', 'yarn', 'pnpm', 'bun', 'bunx', 'deno', 'node', 'nvm', 'corepack',
  'cargo', 'rustup', 'rustc',
  'go', 'gofmt',
  'python', 'python3', 'pip', 'pip3', 'pipx', 'poetry', 'uv', 'pytest', 'ruff', 'mypy',
  'ruby', 'gem', 'bundle', 'bundler', 'rails', 'rake', 'rbenv',
  'php', 'composer', 'artisan',
  'dotnet', 'nuget',
  'mvn', 'gradle', 'gradlew', 'java', 'javac', 'kotlin',
  'make', 'cmake', 'ninja', 'just', 'task', 'turbo', 'nx', 'lerna',
  'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'playwright', 'cypress',
  'webpack', 'vite', 'rollup', 'esbuild', 'tsx', 'ts-node',
  'brew', 'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'pacman', 'apk', 'snap', 'port',
  'grep', 'rg', 'fd', 'find', 'sed', 'awk', 'jq', 'yq', 'curl', 'wget', 'tar', 'zip', 'unzip',
  // Coreutils / shell locais comuns — depth 2 chega e evita grants estranhos
  // tipo `ls somedir`. (A maioria já é cortada pela flag/não-subcomando, mas
  // listá-las mantém o comportamento previsível.)
  'ls', 'cat', 'echo', 'pwd', 'cd', 'mkdir', 'rmdir', 'cp', 'mv', 'rm', 'touch',
  'chmod', 'chown', 'ln', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr',
  'file', 'stat', 'du', 'df', 'ps', 'kill', 'pkill', 'which', 'whoami', 'date',
  'open', 'code', 'cp', 'diff', 'ping', 'ssh', 'scp', 'rsync',
])

/**
 * Wrappers de shell / execução arbitrária: a sua "raiz" é inútil ou perigosa
 * como prefixo (o comando real vai no argumento). Um prefixo destes deixaria
 * passar tudo — por isso getCommandPrefix devolve null para eles. Superset do
 * BARE_SHELL_PREFIXES do claude-vaz + os wrappers de privilégio do TM.
 */
const BARE_SHELL_ROOTS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  'pwsh', 'powershell', 'cmd',
  'env', 'xargs', 'nice', 'nohup', 'timeout', 'watch', 'time',
  'eval', 'exec', 'command', 'builtin',
  'sudo', 'su', 'doas', 'pkexec', 'runuser',
])

/** Um token "parece sub-comando" (não flag, não path, não valor): letras
 *  minúsculas/dígitos/hífens, a começar por letra. Igual ao regex do
 *  claude-vaz para decidir se o 2º token entra no prefixo. */
const SUBCOMMAND_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/**
 * Divide um comando em tokens shell respeitando aspas simples/duplas. Devolve
 * null se as aspas estiverem desequilibradas (comando suspeito → sem prefixo).
 * Não expande nada — só separa por whitespace fora de aspas.
 */
function tokenize(command: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  let has = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) { current += ch; has = true; escaped = false; continue }
    if (ch === '\\' && !inSingle) { escaped = true; continue }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; has = true; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; has = true; continue }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (has) { tokens.push(current); current = ''; has = false }
      continue
    }
    current += ch
    has = true
  }
  if (inSingle || inDouble || escaped) return null
  if (has) tokens.push(current)
  return tokens
}

/**
 * True se o comando é COMPOSTO — tem operadores de shell não-citados
 * (`&&`, `||`, `;`, `|`, `` ` ``, `$(`, `<(`, `>(`) ou uma nova linha. Um
 * prefixo concedido nunca bate num composto (invariante 2). Detetamos com um
 * scan quote-aware (não regex ingénuo — `echo "a && b"` NÃO é composto).
 */
export function isCompoundCommand(command: string): boolean {
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const next = command[i + 1]
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && !inSingle) { escaped = true; continue }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (inSingle || inDouble) continue
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '`') return true
    if (ch === '$' && next === '(') return true
    if ((ch === '<' || ch === '>') && next === '(') return true
  }
  return false
}

/** Salta atribuições de env var à cabeça (`FOO=bar cmd`) — o prefixo é do
 *  comando real, não da atribuição. Devolve os tokens a partir do comando. */
function skipLeadingEnvAssignments(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  return tokens.slice(i)
}

function depthFor(tokens: string[]): number {
  // Mais específico primeiro: a regra cujo array de tokens é um prefixo dos
  // tokens do comando e mais longa ganha.
  let best: { depth: number; len: number } | null = null
  for (const rule of DEPTH_RULES) {
    if (rule.prefix.length > tokens.length) continue
    let ok = true
    for (let i = 0; i < rule.prefix.length; i++) {
      if (tokens[i]?.toLowerCase() !== rule.prefix[i]) { ok = false; break }
    }
    if (ok && (!best || rule.prefix.length > best.len)) best = { depth: rule.depth, len: rule.prefix.length }
  }
  if (best) return best.depth
  // Sem regra explícita: dev-tool conhecido → depth 2 (grant comum e seguro);
  // desconhecido (possível CLI cloud novo) → default conservador mais fundo,
  // para o grant ficar mais estreito por defeito.
  const root = tokens[0]?.toLowerCase() ?? ''
  return KNOWN_DEV_ROOTS.has(root) ? DEFAULT_DEPTH : CONSERVATIVE_UNKNOWN_DEPTH
}

/**
 * Reduz um comando ao seu PREFIXO de grant, ou null quando não é seguro/possível
 * conceder por prefixo (composto, bare-shell, path, atribuição pura). Exemplos:
 *   `gcloud secrets versions add X --data-file=-` → `gcloud secrets versions add`
 *   `firebase deploy --only functions`            → `firebase deploy`
 *   `npm run test`                                → `npm run`
 *   `ls -la`                                      → `ls`
 *   `bash -c "rm -rf /"`                          → null (bare shell)
 *   `./deploy.sh`                                 → null (path)
 *   `a && b`                                      → null (composto)
 */
export function getCommandPrefix(rawCommand: string): string | null {
  if (!rawCommand || !rawCommand.trim()) return null
  // Composto → sem prefixo.
  if (isCompoundCommand(rawCommand)) return null

  const allTokens = tokenize(rawCommand)
  if (!allTokens || allTokens.length === 0) return null
  const tokens = skipLeadingEnvAssignments(allTokens)
  if (tokens.length === 0) return null

  const root = tokens[0]
  const rootLower = root.toLowerCase()
  // Path (absoluto/relativo) ou atribuição residual — não prefixável.
  if (root.includes('/') || root.includes('=')) return null
  if (BARE_SHELL_ROOTS.has(rootLower)) return null
  // A raiz tem de parecer um comando (não uma flag, não um valor citado).
  if (!SUBCOMMAND_RE.test(rootLower)) return null

  const depth = depthFor(tokens)
  const prefix: string[] = [root]
  for (let i = 1; i < depth && i < tokens.length; i++) {
    if (SUBCOMMAND_RE.test(tokens[i].toLowerCase())) prefix.push(tokens[i])
    else break
  }
  return prefix.join(' ')
}

/**
 * Normaliza um prefixo editado à mão (campo do diálogo): colapsa whitespace e
 * corta. Devolve null se ficar vazio, bare-shell, com path/`=`, com operadores
 * de shell, ou se algum token não parecer sub-comando — as MESMAS invariantes
 * de getCommandPrefix, aplicadas ao que o user escreveu (não confiamos no
 * input só porque foi digitado).
 */
export function sanitizeCommandPrefix(input: string): string | null {
  const trimmed = (input ?? '').trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  if (isCompoundCommand(trimmed)) return null
  const tokens = trimmed.split(' ')
  const rootLower = tokens[0].toLowerCase()
  if (tokens[0].includes('/') || tokens[0].includes('=')) return null
  if (BARE_SHELL_ROOTS.has(rootLower)) return null
  for (const tok of tokens) {
    if (!SUBCOMMAND_RE.test(tok.toLowerCase())) return null
  }
  return trimmed
}

/**
 * True se `command` bate na regra de prefixo `prefix` — igualdade exata OU
 * `prefix` seguido de espaço (fronteira de palavra, invariante 3). Um comando
 * COMPOSTO nunca bate (invariante 2): um prefixo concedido não pode varrer
 * `granted && evil`.
 */
export function commandMatchesPrefix(command: string, prefix: string): boolean {
  if (!command || !prefix) return false
  if (isCompoundCommand(command)) return false
  // Compara sobre os tokens (colapsa espaçamento irregular sem alterar
  // fronteiras): `git   push` bate `git push`.
  const cmdTokens = tokenize(command)
  if (!cmdTokens) return false
  const effective = skipLeadingEnvAssignments(cmdTokens)
  const prefixTokens = prefix.trim().split(/\s+/)
  if (prefixTokens.length > effective.length) return false
  for (let i = 0; i < prefixTokens.length; i++) {
    if (effective[i]?.toLowerCase() !== prefixTokens[i].toLowerCase()) return false
  }
  return true
}

/**
 * Devolve o prefixo concedido que cobre `command`, ou null. Usado no
 * fast-path de permissão: se bater, o comando corre sem prompt (e, em Modo
 * Auto, sem classificador — um prefixo narrow e consentido é o caso seguro).
 */
export function matchGrantedPrefix(command: string, grantedPrefixes: Iterable<string>): string | null {
  const cmd = typeof command === 'string' ? command : ''
  if (!cmd) return null
  for (const prefix of grantedPrefixes) {
    if (commandMatchesPrefix(cmd, prefix)) return prefix
  }
  return null
}
