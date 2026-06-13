// The full agent conversation shown in the video — single source of truth
// so every scene renders the same story.

export const PROJECT = {
  name: 'katondo-queue',
  path: '/Users/ithustle/dev/web/katondo-queue',
  branch: 'main',
  lastCommit: 'a3f82c1 feat(queue): painel de triagem em tempo real',
  tip: 'tip: type / to browse all commands',
} as const

export const PROMPT_TEXT =
  "Os users da recepção ficam presos com 'sessão activa noutra estação'. " +
  'Adiciona uma acção no User Admin para forçar logout e libertar a estação.'

export const AGENT_MESSAGES = {
  investigate: 'Vou investigar como a sessão e a estação ficam associadas ao utilizador.',
  found: 'Encontrei o bloqueio: `station.lockedBy` impede novo login enquanto a sessão anterior existir.',
  adding: 'Vou adicionar uma acção administrativa segura para libertar a estação.',
  te2eStart: 'A conduzir um browser real sobre a preview ao vivo — sem ficheiros de spec.',
  done: 'Os utilizadores de recepção já conseguem voltar a entrar. Todos os testes passaram.',
} as const

// /te2e — the feature this video sells. Copy mirrors the real product strings
// (src/i18n/translations.ts: slashCmd.te2e.desc + e2e.usage).
export const TE2E = {
  command: '/te2e',
  args: 'force-logout',
  /** What the user types in the dedicated command scene and in scene 5. */
  typed: '/te2e force-logout',
  description:
    'Valida o preview ao vivo conduzindo um browser real — exploratório, permissão por ação, sem ficheiros de spec.',
  usage: 'Uso: /te2e <o que validar>',
  examples: ['/te2e fluxo de login', '/te2e clicar no carrinho abre o drawer'],
} as const

export interface ToolCallSpec {
  verbRunning: string
  verbDone: string
  subtitle: string
  summary?: string
}

export const TOOL_CALLS = {
  search: {
    verbRunning: 'Searching',
    verbDone: 'Searched',
    subtitle: 'stationSession',
    summary: '7 results',
  },
  readUsersRoute: {
    verbRunning: 'Reading',
    verbDone: 'Read',
    subtitle: 'server/routes/users.ts',
    summary: '182 lines',
  },
  readApiUsers: {
    verbRunning: 'Reading',
    verbDone: 'Read',
    subtitle: 'client/src/api/users.ts',
    summary: '91 lines',
  },
  readUserManagement: {
    verbRunning: 'Reading',
    verbDone: 'Read',
    subtitle: 'client/src/pages/admin/user-management.tsx',
    summary: '243 lines',
  },
  editUsersRoute: {
    verbRunning: 'Editing',
    verbDone: 'Edited',
    subtitle: 'server/routes/users.ts',
    summary: 'Added 12 lines',
  },
  editApiUsers: {
    verbRunning: 'Editing',
    verbDone: 'Edited',
    subtitle: 'client/src/api/users.ts',
    summary: 'Added 4 lines',
  },
  editUserManagement: {
    verbRunning: 'Editing',
    verbDone: 'Edited',
    subtitle: 'client/src/pages/admin/user-management.tsx',
    summary: 'Added 26 lines',
  },
  runTests: {
    verbRunning: 'Validating',
    verbDone: 'Validated',
    subtitle: '/te2e force-logout',
    summary: '✓ 4 passed',
  },
  // /te2e browser-driving steps — left terminal, synced with the cursor on the right
  te2eOpen: {
    verbRunning: 'Opening',
    verbDone: 'Opened',
    subtitle: 'localhost:7775/admin/users',
  },
  te2eClickLogout: {
    verbRunning: 'Clicking',
    verbDone: 'Clicked',
    subtitle: '“Forçar logout”',
  },
  te2eClickConfirm: {
    verbRunning: 'Clicking',
    verbDone: 'Clicked',
    subtitle: '“Confirmar”',
  },
  te2eAssert: {
    verbRunning: 'Checking',
    verbDone: 'Checked',
    subtitle: 'estado → “Disponível”',
    summary: '✓ estação libertada',
  },
} as const satisfies Record<string, ToolCallSpec>

export const WORKED_FOR_TEXT = 'Trabalhou por 1m 32s'

export const TEST_COMMAND = '/te2e force-logout'

export const TEST_CHECKS = [
  'admin can force logout locked reception user',
  'station is released after force logout',
  'reception user can login again',
  'user management status updates',
] as const

export const TEST_SUMMARY = '4 passed (3.2s)'

export const BRANDING = {
  name: 'TM Code',
  tagline: 'The Agent-First IDE',
  phrase: 'Chat with AI. Watch it code. Ship faster.',
  cta: 'Get TM Code',
  ctaSub: 'Build, test and ship with an AI coding agent.',
  platforms: 'Available for macOS · Windows · Linux',
} as const
