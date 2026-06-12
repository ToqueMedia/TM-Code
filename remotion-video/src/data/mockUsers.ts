// Mock data for the demo app "Katondo Queue" — a fictional clinic
// queue/reception management app the agent is fixing in the story.

export interface MockUser {
  name: string
  email: string
  role: 'admin' | 'reception' | 'staff'
  station: string
  area: string
  status: 'available' | 'locked'
}

export const USERS: MockUser[] = [
  {
    name: 'Dra. Ana Martins',
    email: 'ana.martins@clinicavida.ao',
    role: 'admin',
    station: '—',
    area: 'Administração',
    status: 'available',
  },
  {
    name: 'Recepção 01',
    email: 'recepcao01@clinicavida.ao',
    role: 'reception',
    station: 'Balcão 2',
    area: 'Triagem',
    status: 'locked',
  },
  {
    name: 'Recepção 02',
    email: 'recepcao02@clinicavida.ao',
    role: 'reception',
    station: 'Balcão 1',
    area: 'Triagem',
    status: 'available',
  },
  {
    name: 'Enf. Carlos Mendes',
    email: 'carlos.mendes@clinicavida.ao',
    role: 'staff',
    station: '—',
    area: 'Enfermaria',
    status: 'available',
  },
]

/** Row index of the blocked reception user inside USERS */
export const LOCKED_USER_INDEX = 1
export const LOCKED_USER = USERS[LOCKED_USER_INDEX]

export const STATUS_LABELS = {
  available: 'Disponível',
  locked: 'Sessão activa — Balcão 2',
} as const

export const FORCE_LOGOUT_LABEL = 'Forçar logout'

export const MODAL_TEXT = {
  title: 'Terminar sessão de Recepção 01?',
  body: 'A estação Balcão 2 será libertada e o utilizador poderá iniciar sessão novamente.',
  cancel: 'Cancelar',
  confirm: 'Confirmar',
} as const

export const TOAST_TEXT = 'Sessão terminada e estação libertada com sucesso.'

export const DEMO_APP = {
  name: 'Katondo Queue',
  adminUrl: 'http://localhost:7775/admin/users',
  loginUrl: 'http://localhost:7775/login',
  nav: ['Painel', 'Utilizadores', 'Estações', 'Filas', 'Relatórios'],
  activeNav: 'Utilizadores',
  adminTitle: 'Gestão de Utilizadores',
  adminSubtitle: 'Gerir contas, sessões e estações',
} as const

export const LOGIN_TEXT = {
  title: 'Recepção',
  subtitle: 'Insira as suas credenciais para entrar',
  emailLabel: 'Email',
  email: 'recepcao01@clinicavida.ao',
  passwordLabel: 'Password',
  passwordDots: '••••••••',
  submit: 'Entrar',
  authorized: 'Login autorizado',
  welcome: 'Bem-vindo, Recepção 01',
  errorBefore:
    'Não foi possível iniciar sessão: este utilizador tem uma sessão activa noutra estação (Balcão 2).',
} as const
