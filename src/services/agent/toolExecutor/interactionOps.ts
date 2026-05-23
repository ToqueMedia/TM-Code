/**
 * Interaction tools — request_credentials, ask_user_question.
 *
 * Extracted from toolExecutor.ts as part of the SOLID decomposition.
 * These tools render interactive cards in the chat and block until
 * the user responds (or the abort signal fires).
 */

import { useChatStore } from '../../../stores/chatStore'
import { describePlatformManagedField } from './checks'
import type { ToolRegistrationContext } from './context'

export function registerInteractionTools(ctx: ToolRegistrationContext): void {

  // === request_credentials ===
  ctx.tools.set('request_credentials', {
    definition: {
      name: 'request_credentials',
      description:
        'Request API keys, tokens, or other secrets from the developer via a secure form rendered inline in the chat. The form writes the values directly into the project .env (which is otherwise unreadable and unwritable by the agent). Never instruct the developer to create or edit .env manually, and never ask them to paste secrets into the chat.\n\nUSE FOR: third-party services the developer is integrating into their app (OpenAI, Anthropic, Stripe, SendGrid, Twilio, Resend, generic webhooks, etc.).\n\nSKIP FOR: platform-managed credentials. The platform mints these via dedicated provision_* tools — the developer doesn\'t have the values and never will. Mapping: TM_AUTH_*/VITE_TM_*/GIP_*/GCP_* → provision_auth; TMDB_URL/TMDB_TOKEN/DATABASE_URL → provision_database; TM_FILES_URL/TM_FILES_TOKEN/TM_FILES_PUBLIC_BASE → provision_files; APP_ID → provision_deploy. Calling this form for any of those is incorrect.',
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
        const blockReason = describePlatformManagedField(id)
        if (blockReason) {
          return blockReason
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

      const { id: requestId, promise: requestPromise } = useCredentialRequestStore
        .getState()
        .request({ serviceName, fields })

      const cardMessageId = chatStore.addCredentialRequestCard(
        projectRoot,
        requestId,
        serviceName,
        fields,
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
        return `Credentials saved to .env for ${serviceName}: ${keysList}. Values are masked from the chat history. Continue with the implementation.`
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
            description: 'The questions to ask the user (1-4 questions per call)',
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
            minItems: 1,
            maxItems: 4
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
        return 'Error: must provide at least one question.'
      }
      if (questionsRaw.length > 4) {
        return 'Error: maximum 4 questions per call.'
      }

      for (const q of questionsRaw) {
        if (!q.question || !q.header || !q.options || q.options.length < 2) {
          return `Error: each question needs "question", "header" (max 12 chars), and 2-4 options.`
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

      const { id: requestId, promise: answerPromise } = useAskUserQuestionStore
        .getState()
        .request(questions)

      const chatStore = useChatStore.getState()
      const cardMessageId = chatStore.addAskUserQuestionCard(projectRoot, requestId, questions)

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
