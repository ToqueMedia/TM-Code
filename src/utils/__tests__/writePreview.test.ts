import { resolveWritePreview } from '../writePreview'

describe('resolveWritePreview', () => {
  it('prefere o diff do ficheiro quando existe', () => {
    const p = resolveWritePreview({
      diffOld: 'aaa',
      diffNew: 'bbb',
      isNewFile: false,
      args: { old_string: 'x', new_string: 'y' },
    })
    expect(p).toEqual({
      oldContent: 'aaa',
      newContent: 'bbb',
      isNewFile: false,
      source: 'file',
    })
  })

  it('cai no hunk do Edit quando o ficheiro já foi libertado', () => {
    const p = resolveWritePreview({
      args: { old_string: 'foo', new_string: 'bar' },
    })
    expect(p?.source).toBe('hunk')
    expect(p?.oldContent).toBe('foo')
    expect(p?.newContent).toBe('bar')
  })

  it('aceita oldString/newString (stream a meio)', () => {
    const p = resolveWritePreview({
      args: { oldString: 'a', newString: 'b' },
    })
    expect(p?.oldContent).toBe('a')
    expect(p?.newContent).toBe('b')
  })

  it('write/create usa content como ficheiro novo', () => {
    const p = resolveWritePreview({
      args: { content: 'hello' },
    })
    expect(p).toEqual({
      oldContent: '',
      newContent: 'hello',
      isNewFile: true,
      source: 'write',
    })
  })

  it('sem argumentos ainda não há preview', () => {
    expect(resolveWritePreview({ args: { file_path: '/a.ts' } })).toBeNull()
  })
})
