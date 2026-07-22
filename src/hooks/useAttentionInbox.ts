/**
 * Fase 6a do modelo foreground: INBOX UNIFICADO DE ATENÇÃO (padrão Antigravity
 * — um só sítio com tudo o que espera pelo developer, de todos os agentes).
 *
 * Agrega, do processo atual:
 *  - pedidos interativos pendentes: permissões (atual + fila), perguntas e
 *    credenciais — com atribuição de tarefa quando têm origin;
 *  - tarefas paralelas TERMINADAS cujo resultado ainda não foi visto
 *    (`resultSeen` — visto = abrir o chat da tarefa, ou estar a vê-lo quando
 *    ela termina).
 *
 * Clique num item: tarefas → chat da tarefa (openParallelTaskChat); pedidos do
 * run principal (sem origin) → vista de chat, onde o diálogo/card vive.
 */

import { useMemo } from 'react'
import { usePermissionStore } from '@/stores/permissionStore'
import { useAskUserQuestionStore } from '@/stores/askUserQuestionStore'
import { useCredentialRequestStore } from '@/stores/credentialRequestStore'
import { useParallelTaskStore } from '@/stores/parallelTaskStore'

export type AttentionKind = 'permission' | 'question' | 'credentials' | 'task_done' | 'task_error'

export interface AttentionItem {
  id: string
  kind: AttentionKind
  /** Descrição da tarefa dona, ou o alvo do pedido (tool/serviço) no main. */
  label: string
  /** Sessão-alvo da navegação (tarefas). undefined → vista de chat do main. */
  sessionId?: string
  taskId?: string
  createdAt: number
}

export function useAttentionInbox(): AttentionItem[] {
  const pendingPermission = usePermissionStore(s => s.pendingPermission)
  const permissionQueue = usePermissionStore(s => s.permissionQueue)
  const pendingQuestions = useAskUserQuestionStore(s => s.pending)
  const pendingCredentials = useCredentialRequestStore(s => s.pending)
  const runs = useParallelTaskStore(s => s.runs)

  return useMemo(() => {
    const items: AttentionItem[] = []
    const sessionIdForTask = (taskId: string | undefined): string | undefined => {
      if (!taskId) return undefined
      for (const r of runs.values()) if (r.id === taskId) return r.sessionId
      return undefined
    }

    const permissions = pendingPermission ? [pendingPermission, ...permissionQueue] : [...permissionQueue]
    for (const perm of permissions) {
      items.push({
        id: `perm-${perm.id}`,
        kind: 'permission',
        label: perm.origin?.label ?? perm.toolName,
        sessionId: perm.origin?.sessionId ?? sessionIdForTask(perm.origin?.taskId),
        taskId: perm.origin?.taskId,
        createdAt: Date.now(),
      })
    }
    for (const [id, entry] of pendingQuestions) {
      items.push({
        id: `ask-${id}`,
        kind: 'question',
        label: entry.origin?.label ?? entry.questions[0]?.header ?? 'question',
        sessionId: sessionIdForTask(entry.origin?.taskId),
        taskId: entry.origin?.taskId,
        createdAt: Date.now(),
      })
    }
    for (const [id, entry] of pendingCredentials) {
      items.push({
        id: `cred-${id}`,
        kind: 'credentials',
        label: entry.origin?.label ?? entry.serviceName,
        sessionId: sessionIdForTask(entry.origin?.taskId),
        taskId: entry.origin?.taskId,
        createdAt: Date.now(),
      })
    }

    for (const run of runs.values()) {
      const finished = run.status === 'completed' || run.status === 'error'
      if (!finished || run.resultSeen) continue
      items.push({
        id: `task-${run.id}`,
        kind: run.status === 'completed' ? 'task_done' : 'task_error',
        label: run.description,
        sessionId: run.sessionId,
        taskId: run.id,
        createdAt: run.endedAt ?? run.createdAt,
      })
    }

    // Pedidos interativos primeiro (bloqueiam agentes), depois resultados.
    const weight = (k: AttentionKind) => (k === 'task_done' || k === 'task_error' ? 1 : 0)
    return items.sort((a, b) => weight(a.kind) - weight(b.kind) || a.createdAt - b.createdAt)
  }, [pendingPermission, permissionQueue, pendingQuestions, pendingCredentials, runs])
}
