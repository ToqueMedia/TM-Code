/**
 * Preserved Thinking — as duas metades do contrato do provider.
 *
 * A doc do z.AI pede DUAS coisas para o raciocínio sobreviver entre turnos:
 *   1. `thinking.clear_thinking: false` no pedido;
 *   2. devolver o `reasoning_content` completo e intacto no histórico.
 *
 * A (2) já era cumprida com rigor pela IDE (round-trip `_native` em query.ts, e
 * uma auditoria de 2026-07-28 que RECUSOU podá-lo por causa do prefixo de
 * cache). A (1) nunca tinha sido enviada — o default da API é `true`, e a
 * descrição literal do campo é "Controls whether to clear reasoning_content
 * from previous conversation turns". Pagávamos esses tokens em input todos os
 * turnos e o servidor descartava-os.
 *
 * O teste mais importante deste ficheiro é o do DashScope: `preserve_thinking`
 * EXISTE lá e faz o que queremos, mas a doc limita-o às famílias qwen3.7,
 * qwen3.6 e kimi-k2.x — GLM NÃO está na lista. A primeira versão desta mudança
 * ia enviá-lo à mesma.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyReasoningEffort } from '../src/applyReasoningEffort'

const ZAI = { provider: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.2' }
const DASHSCOPE = {
  provider: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'glm-5.2',
}

test('z.AI GLM com thinking ligado pede Preserved Thinking', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'max', ZAI)
  assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false })
})

test('z.AI GLM em `high` também — não é exclusivo do max', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'high', ZAI)
  assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false })
})

test('z.AI GLM com thinking DESLIGADO não manda clear_thinking', () => {
  // Sem raciocínio não há nada a preservar, e o comportamento do campo com
  // type:'disabled' não está documentado — não se envia o que não se sabe.
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'none', ZAI)
  assert.deepEqual(body.thinking, { type: 'disabled' })
})

test('DashScope GLM NUNCA leva preserve_thinking', () => {
  // A regressão que isto tranca: `preserve_thinking` é real no DashScope, mas
  // a doc limita-o às famílias qwen3.7, qwen3.6 e kimi-k2.x. GLM fora da lista
  // = parâmetro não suportado = o 400 que este módulo existe para evitar.
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'max', DASHSCOPE)
  assert.equal(body.preserve_thinking, undefined)
  assert.equal(body.enable_thinking, true)
})

test('DashScope GLM não ganha `thinking` por engano', () => {
  // `thinking.clear_thinking` é forma do z.AI. No DashScope o controlo é o
  // `enable_thinking` top-level; misturar as duas formas é como se paga um 400.
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'max', DASHSCOPE)
  assert.equal(body.thinking, undefined)
})

test('Grok não ganha clear_thinking nem thinking', () => {
  const body: Record<string, unknown> = { thinking: { type: 'enabled' } }
  applyReasoningEffort(body, 'high', {
    provider: 'xai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.5',
  })
  assert.equal(body.thinking, undefined)
  assert.equal(body.preserve_thinking, undefined)
})

test('Kimi K3 não ganha clear_thinking nem thinking', () => {
  const body: Record<string, unknown> = {}
  applyReasoningEffort(body, 'max', {
    provider: 'moonshot', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3',
  })
  assert.equal(body.thinking, undefined)
  assert.equal(body.preserve_thinking, undefined)
})

test('extraBody da KV não sobrepõe o clear_thinking', () => {
  // applyReasoningEffort corre DEPOIS do merge do extraBody, de propósito: a
  // escolha do utilizador (e o contrato do provider) ganham à config.
  const body: Record<string, unknown> = { thinking: { type: 'enabled', clear_thinking: true } }
  applyReasoningEffort(body, 'max', ZAI)
  assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false })
})
