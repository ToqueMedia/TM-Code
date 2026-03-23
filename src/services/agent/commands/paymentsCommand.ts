import { useChatStore } from '../../../stores/chatStore'

export async function executePaymentsStub(_args: string, _projectPath: string): Promise<void> {
  useChatStore.getState().addSystemMessage(
    '/payments command is coming soon.\n\n' +
    'This will load MoMenu Payment Skills:\n' +
    '- mom-factura-payments — MCX, E-kwanza, Referencia Bancaria\n' +
    '- mom-factura-webhooks — Webhook confirmations\n' +
    '- mom-factura-testing — QA environment & testing'
  )
}
