import {
  IMAGE_DESCRIBED_BODY,
  IMAGE_UNDELIVERED_BODY,
  resolveAttachments,
  resolveDescribedAttachments,
} from '../attachmentService'
import type { Attachment } from '../../types/chat'

const pasted: Attachment = {
  id: 'att_1',
  type: 'image',
  name: 'pasted-image.png',
  path: '',
  mimeType: 'image/png',
  sizeBytes: 15938,
}

describe('resolveAttachments — image XML', () => {
  it('default (undelivered) tells the model this image did not arrive', async () => {
    const xml = await resolveAttachments([pasted])
    expect(xml).toContain('pasted-image.png')
    expect(xml).toContain(IMAGE_UNDELIVERED_BODY)
    expect(xml).not.toContain(IMAGE_DESCRIBED_BODY)
  })

  it('described mode must NOT instruct the model to claim delivery failed', async () => {
    const xml = await resolveDescribedAttachments([pasted])
    expect(xml).toContain('pasted-image.png')
    expect(xml).toContain(IMAGE_DESCRIBED_BODY)
    expect(xml).not.toContain(IMAGE_UNDELIVERED_BODY)
    expect(xml).not.toContain('could not be delivered')
    expect(xml).not.toContain('did not reach you')
  })

})
