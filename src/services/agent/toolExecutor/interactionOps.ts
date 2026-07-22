/**
 * Interaction tools — request_credentials, ask_user_question.
 *
 * Extracted from toolExecutor.ts as part of the SOLID decomposition.
 * These tools render interactive cards in the chat and block until
 * the user responds (or the abort signal fires).
 */

import { useChatStore } from '../../../stores/chatStore'
import type { ToolRegistrationContext } from './context'
import { t } from '@/i18n'

export function registerInteractionTools(ctx: ToolRegistrationContext): void {

  // === request_credentials ===
  ctx.tools.set('request_credentials', {
    definition: {
      name: 'request_credentials',
      description:
        'Request API keys, tokens, or other secrets from the developer via a secure form rendered inline in the chat. The form writes the values directly into the project .env (which is otherwise unreadable and unwritable by the agent). Never instruct the developer to create or edit .env manually, and never ask them to paste secrets into the chat. When this tool returns "Credentials saved to .env", the keys ARE written — that result is the confirmation; do not read .env to verify (it is blocked) and do not call this again for the same keys.\n\nUSE FOR: any service the developer is integrating into their app (OpenAI, Anthropic, Stripe, SendGrid, Twilio, Resend, Firebase, database URLs, generic webhooks, etc.). Only request values the developer actually owns or can obtain; skip values with sensible local defaults (e.g. a local SQLite file URL) unless the developer wants to override them.',
      input_schema: {
        type: 'object',
        properties: {
          service_name: {
            type: 'string',
            description: 'Name of the service the credentials are for (e.g. "OpenAI", "Stripe", "Firebase")',
          },
          fields: {
            type: 'array',
            description: 'Credential fields to collect. Maximum 8 per request.',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'Env var key as it will appear in .env (UPPER_SNAKE_CASE, e.g. "OPENAI_API_KEY")',
                },
                label: {
                  type: 'string',
                  description: 'Human-readable label shown in the form',
                },
                type: {
                  type: 'string',
                  enum: ['text', 'password'],
                  description: 'Use "password" for API keys, tokens, secrets. Use "text" for non-sensitive values like project IDs.',
                },
                required: {
                  type: 'boolean',
                  description: 'Whether the field must be filled before the user can submit',
                },
                helperText: {
                  type: 'string',
                  description: 'Optional hint shown below the field (e.g. "Find this at https://...")',
                },
              },
              required: ['id', 'label', 'type', 'required'],
            },
          },
        },
        required: ['service_name', 'fields'],
      },
    },
    execute: async (input) => {
      const serviceName = String(input.service_name || '').trim()
      if (!serviceName) {
        return 'Missing required parameter: service_name'
      }

      const rawFields = input.fields
      if (!Array.isArray(rawFields) || rawFields.length === 0) {
        return 'Missing required parameter: fields (must be a non-empty array)'
      }
      if (rawFields.length > 8) {
        return 'Too many fields: maximum 8 per request. Group related credentials into separate calls.'
      }

      const fields: Array<{
        id: string
        label: string
        type: 'text' | 'password'
        required: boolean
        helperText?: string
      }> = []
      const seenIds = new Set<string>()
      for (const raw of rawFields as Array<Record<string, unknown>>) {
        const id = String(raw?.id ?? '').trim()
        const label = String(raw?.label ?? '').trim()
        if (!id || !label) {
          return 'Each field must have non-empty "id" and "label".'
        }
        if (!/^[A-Z_][A-Z0-9_]*$/.test(id)) {
          return `Field id "${id}" is not a valid env var key (must match /^[A-Z_][A-Z0-9_]*$/).`
        }
        if (seenIds.has(id)) {
          return `Duplicate field id "${id}".`
        }
        seenIds.add(id)
        const type = raw?.type === 'text' ? 'text' : 'password'
        fields.push({
          id,
          label,
          type,
          required: raw?.required !== false,
          helperText: raw?.helperText ? String(raw.helperText).trim() : undefined,
        })
      }

      const projectRoot = ctx.getProjectRoot()
      if (!projectRoot) {
        return 'No active project — cannot collect credentials. Open a project first.'
      }

      const { useCredentialRequestStore } = await import('../../../stores/credentialRequestStore')
      const chatStore = useChatStore.getState()

      // Tarefa paralela: o pedido é etiquetado (badge "Credenciais" na row)
      // e o card escrito NA SESSÃO da tarefa — o user decide no chat dela.
      const taskOrigin = ctx.getTaskOrigin()

      const { id: requestId, promise: requestPromise } = useCredentialRequestStore
        .getState()
        .request({
          serviceName,
          fields,
          ...(taskOrigin ? { origin: { taskId: taskOrigin.taskId, label: taskOrigin.label } } : {}),
        })

      const cardMessageId = chatStore.addCredentialRequestCard(
        projectRoot,
        requestId,
        serviceName,
        fields,
        taskOrigin?.sessionId,
      )

      const abortSignal = input._abortSignal as AbortSignal | undefined

      const result = await new Promise<{ submitted: boolean; keys?: string[] }>((resolve) => {
        let settled = false
        const onAbort = () => {
          if (settled) return
          settled = true
          useCredentialRequestStore.getState().cancel(requestId)
          resolve({ submitted: false })
        }
        if (abortSignal) {
          if (abortSignal.aborted) {
            onAbort()
            return
          }
          abortSignal.addEventListener('abort', onAbort, { once: true })
        }
        requestPromise.then((r) => {
          if (settled) return
          settled = true
          resolve(r)
        })
      })

      if (result.submitted) {
        chatStore.markCredentialRequestSubmitted(cardMessageId, result.keys ?? [])
        const keysList = (result.keys ?? []).join(', ') || '(none)'
        return `Credentials saved to .env for ${serviceName}: ${keysList}. These keys are now written to .env (values masked from the chat history). This message IS your confirmation — do NOT read .env to verify (it is sealed by design) and do NOT request these keys again. Continue with the implementation.`
      }

      chatStore.updateCardStatus(cardMessageId, 'cancelled')
      return `User cancelled the credential request for ${serviceName}. Ask the user how they want to proceed without these credentials.`
    },
  })

  // === ask_user_question ===
  ctx.tools.set('ask_user_question', {
    definition: {
      name: 'ask_user_question',
      description: 'Ask the user structured questions to gather context or make decisions. Use when you need the user to choose between options, provide requirements, or confirm an approach. Renders an interactive form in the chat/terminal. The agent loop blocks until the user submits answers. Supports single-select (radio) and multi-select (checkbox) options. If you just need free-text input, use a single open-ended option like "Other".',
      input_schema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'The questions to ask the user. Ask as many as the decision genuinely needs — you decide; prefer the fewest questions that unblock you, but do not artificially merge unrelated decisions.',
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The question to ask. Should be clear, specific, and end with a question mark.'
                },
                header: {
                  type: 'string',
                  description: 'Short label for the question (max 12 chars). Shown as a tag/chip.'
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'Whether multiple options can be selected. Default: false (single-select).'
                },
                options: {
                  type: 'array',
                  description: 'The available options. Each has a label (display text, 1-5 words) and optional description (explanation of what this option means). Must have 2-4 options.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Display text for the option (1-5 words)' },
                      description: { type: 'string', description: 'Explanation of what this option means or implies' }
                    },
                    required: ['label']
                  },
                  minItems: 2,
                  maxItems: 4
                }
              },
              required: ['question', 'header', 'options']
            },
            minItems: 1
          }
        },
        required: ['questions']
      }
    },
    execute: async (input) => {
      const questionsRaw = input.questions as Array<{
        question: string
        header: string
        options: Array<{ label: string; description?: string }>
        multiSelect?: boolean
      }>

      if (!questionsRaw || !Array.isArray(questionsRaw) || questionsRaw.length === 0) {
        return t('tool.minQuestions')
      }
      for (const q of questionsRaw) {
        if (!q.question || !q.header || !q.options || q.options.length < 2) {
          return t('tool.questionValidation')
        }
        if (q.options.length > 4) {
          return `Error: maximum 4 options per question. "${q.header}" has ${q.options.length}.`
        }
      }

      const questions = questionsRaw.map(q => ({
        question: q.question,
        header: q.header,
        options: q.options.map(o => ({ label: o.label, description: o.description })),
        multiSelect: !!q.multiSelect,
      }))

      const { useAskUserQuestionStore } = await import('../../../stores/askUserQuestionStore')

      const projectRoot = ctx.getProjectRoot()
      if (!projectRoot) return 'No active project — cannot ask questions. Open a project first.'

      // Tarefa paralela: pedido etiquetado (badge "Pergunta" na row) e card
      // escrito na sessão da tarefa.
      const taskOrigin = ctx.getTaskOrigin()

      const { id: requestId, promise: answerPromise } = useAskUserQuestionStore
        .getState()
        .request(
          questions,
          taskOrigin ? { taskId: taskOrigin.taskId, label: taskOrigin.label } : undefined,
        )

      const chatStore = useChatStore.getState()
      const cardMessageId = chatStore.addAskUserQuestionCard(projectRoot, requestId, questions, taskOrigin?.sessionId)

      const abortSignal = input._abortSignal as AbortSignal | undefined

      const result = await new Promise<Record<string, string | string[]>>((resolve) => {
        let settled = false
        const onAbort = () => {
          if (settled) return
          settled = true
          useAskUserQuestionStore.getState().cancel(requestId)
          resolve({})
        }
        if (abortSignal) {
          if (abortSignal.aborted) {
            onAbort()
            return
          }
          abortSignal.addEventListener('abort', onAbort, { once: true })
        }
        answerPromise.then((r) => {
          if (settled) return
          settled = true
          resolve(r)
        })
      })

      if (!result || Object.keys(result).length === 0) {
        chatStore.updateCardStatus(cardMessageId, 'cancelled')
        return 'User cancelled the questions. Continue with your best judgment.'
      }

      chatStore.updateCardStatus(cardMessageId, 'submitted')

      const answerLines = questionsRaw.map((q, i) => {
        const key = `question_${i}`
        const answer = result[key]
        if (answer === undefined) return `${q.header}: (no answer)`
        const display = Array.isArray(answer) ? answer.join(', ') : answer
        return `${q.header}: ${display}`
      })

      return `User answered:\n${answerLines.join('\n')}\n\nContinue based on these answers.`
    },
  })
}
