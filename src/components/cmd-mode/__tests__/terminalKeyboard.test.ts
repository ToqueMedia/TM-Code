const mockGetCurrentEditor = jest.fn()

jest.mock('../../../utils/monacoBridge', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getCurrentEditor: mockGetCurrentEditor,
    }),
  },
}))

import { hasCopyableSelection } from '../terminalKeyboard'

function clearDocumentSelection() {
  window.getSelection()?.removeAllRanges()
}

describe('terminalKeyboard', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    clearDocumentSelection()
    mockGetCurrentEditor.mockReturnValue(null)
  })

  afterEach(() => {
    clearDocumentSelection()
  })

  it('detects selected text in a textarea', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'copy this'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.setSelectionRange(0, 4)

    expect(hasCopyableSelection(textarea)).toBe(true)
  })

  it('detects selected document text', () => {
    const node = document.createElement('div')
    node.textContent = 'selected text'
    document.body.appendChild(node)

    const range = document.createRange()
    range.selectNodeContents(node)
    window.getSelection()?.addRange(range)

    expect(hasCopyableSelection(node)).toBe(true)
  })

  it('detects selected Monaco editor text when the editor has focus', () => {
    mockGetCurrentEditor.mockReturnValue({
      hasTextFocus: () => true,
      getSelection: () => ({ isEmpty: () => false }),
    })

    expect(hasCopyableSelection(document.body)).toBe(true)
  })

  it('ignores a stale Monaco selection when the editor is not focused', () => {
    mockGetCurrentEditor.mockReturnValue({
      hasTextFocus: () => false,
      getSelection: () => ({ isEmpty: () => false }),
    })

    expect(hasCopyableSelection(document.body)).toBe(false)
  })
})

