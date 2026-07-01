import { extractAssistantTextFromCompletion } from '../completionText'

describe('extractAssistantTextFromCompletion', () => {
  test('extracts standard chat completion content', () => {
    expect(extractAssistantTextFromCompletion({
      choices: [{ message: { content: '{"ok":true}' } }],
    })).toBe('{"ok":true}')
  })

  test('extracts content parts returned by OpenAI-compatible gateways', () => {
    expect(extractAssistantTextFromCompletion({
      choices: [{
        message: {
          content: [
            { type: 'text', text: '{"taskDomain":"' },
            { type: 'text', text: 'billing_payment_ui"}' },
          ],
        },
      }],
    })).toBe('{"taskDomain":"billing_payment_ui"}')
  })

  test('extracts Responses-style output_text', () => {
    expect(extractAssistantTextFromCompletion({
      output: [{
        content: [{ type: 'output_text', text: '{"selectedContexts":[]}' }],
      }],
    })).toBe('{"selectedContexts":[]}')
  })

  test('uses reasoning_content only when no visible content is present', () => {
    expect(extractAssistantTextFromCompletion({
      choices: [{ message: { content: '', reasoning_content: '{"from":"reasoning"}' } }],
    })).toBe('{"from":"reasoning"}')
  })
})
