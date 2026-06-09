import MonacoBridge from '../../utils/monacoBridge'

function hasDocumentSelection(): boolean {
  try {
    return (window.getSelection()?.toString().length ?? 0) > 0
  } catch {
    return false
  }
}

function isSelectableTextControl(value: unknown): value is HTMLInputElement | HTMLTextAreaElement {
  if (!(value instanceof HTMLInputElement || value instanceof HTMLTextAreaElement)) return false
  if (value instanceof HTMLInputElement) {
    const selectableTypes = new Set([
      '',
      'email',
      'number',
      'password',
      'search',
      'tel',
      'text',
      'url',
    ])
    return selectableTypes.has(value.type)
  }
  return true
}

function hasTextControlSelection(target: EventTarget | null): boolean {
  const candidates = [target, document.activeElement]
  for (const candidate of candidates) {
    if (!isSelectableTextControl(candidate)) continue
    try {
      if ((candidate.selectionEnd ?? 0) > (candidate.selectionStart ?? 0)) return true
    } catch {}
  }
  return false
}

function hasMonacoSelection(target: EventTarget | null): boolean {
  try {
    const editor = MonacoBridge.getInstance().getCurrentEditor()
    if (!editor) return false

    const targetElement = target instanceof Element ? target : null
    const activeElement = document.activeElement
    const eventFromMonaco = !!targetElement?.closest('.monaco-editor')
    const activeInMonaco = activeElement instanceof Element && !!activeElement.closest('.monaco-editor')
    const editorFocused = typeof editor.hasTextFocus === 'function' && editor.hasTextFocus()
    if (!eventFromMonaco && !activeInMonaco && !editorFocused) return false

    const selection = editor.getSelection()
    return !!selection && !selection.isEmpty()
  } catch {
    return false
  }
}

export function hasCopyableSelection(target: EventTarget | null): boolean {
  return hasTextControlSelection(target) || hasDocumentSelection() || hasMonacoSelection(target)
}

