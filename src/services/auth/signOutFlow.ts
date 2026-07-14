/**
 * Sign-out guardado — extraído do MinimalTitleBar quando o menu de
 * utilizador migrou para o rodapé da sidebar (redesign 2026-07-13).
 *
 * closeProject guarda a sessão de chat (cleanupOnExit) e pode RECUSAR
 * quando o agente está a meio de uma tarefa e o utilizador escolhe
 * "continuar a trabalhar" — sem verificar o resultado, o sign-out
 * prosseguia com o workspace aberto e o run vivo a morrer no próximo
 * refresh de token.
 */

import { useProjectStore } from '@/stores/projectStore'
import { useAuthStore } from '@/stores/authStore'
import FirebaseAuthService from './firebaseAuth'

export async function signOutWithGuard(): Promise<void> {
  const project = useProjectStore.getState().currentProject
  if (project) {
    const closed = await useProjectStore.getState().closeProject().catch(() => false)
    if (!closed) return
  }
  useAuthStore.getState().clear()
  await FirebaseAuthService.getInstance().signOut()
}
