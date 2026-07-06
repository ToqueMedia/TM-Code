import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Box, Button, Dialog, Flex, Text } from '@chakra-ui/react'
import { tokens } from '@/theme/tokens'
import { useTranslation } from '@/i18n'
import { isBlobMarker, type Cell, type ColumnInfo, type RowValues } from '../../services/dataViewerService'

type Mode = 'add' | 'edit'

interface RowMutationDialogProps {
  open: boolean
  mode: Mode
  table: string
  columns: ColumnInfo[]
  initialValues?: RowValues | null
  saving: boolean
  onClose: () => void
  onSubmit: (values: RowValues) => Promise<void>
}

interface FieldState {
  value: string
  isNull: boolean
}

function RowMutationDialog({
  open,
  mode,
  table,
  columns,
  initialValues,
  saving,
  onClose,
  onSubmit,
}: RowMutationDialogProps) {
  const t = useTranslation()
  const editableColumns = useMemo(() => columns.filter(c => !isBlobColumn(c)), [columns])
  const blobColumns = useMemo(() => columns.filter(isBlobColumn), [columns])
  const [fields, setFields] = useState<Record<string, FieldState>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const next: Record<string, FieldState> = {}
    for (const column of editableColumns) {
      const value = initialValues?.[column.name]
      next[column.name] = {
        value: cellToInput(value),
        isNull: value === null || value === undefined,
      }
    }
    setFields(next)
    setError(null)
  }, [editableColumns, initialValues, open])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      const values: RowValues = {}
      for (const column of editableColumns) {
        const state = fields[column.name] ?? { value: '', isNull: false }
        if (mode === 'add' && column.isPrimaryKey && !state.isNull && state.value.trim() === '') {
          continue
        }
        values[column.name] = parseInputValue(column, state)
      }
      await onSubmit(values)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(event) => { if (!event.open && !saving) onClose() }}>
      <Dialog.Backdrop bg="rgba(0,0,0,0.62)" backdropFilter="blur(8px)" />
      <Dialog.Positioner display="flex" alignItems="center" justifyContent="center" p={4}>
        <Dialog.Content
          maxW="560px"
          w="100%"
          maxH="82vh"
          overflow="hidden"
          bg={tokens.colors.bg.sidebar}
          border={`1px solid ${tokens.colors.border.sidebarPanel}`}
          borderRadius={tokens.radius.xl}
          color={tokens.colors.text.primary}
          boxShadow={tokens.shadow.overlay}
        >
          <form onSubmit={submit}>
            <Dialog.Header px={4} py={3} borderBottom={`1px solid ${tokens.colors.border.sidebarPanel}`}>
              <Dialog.Title fontSize="14px" fontWeight="700">
                {mode === 'add' ? t('dataViewer.addRow') : t('dataViewer.editRow')}
              </Dialog.Title>
              <Text mt={1} fontSize="11px" color={tokens.colors.text.disabled} fontFamily={tokens.fontFamily.mono}>
                {table}
              </Text>
            </Dialog.Header>

            <Dialog.Body px={4} py={3} overflowY="auto" maxH="58vh">
              {error && (
                <Box mb={3} p={3} borderRadius={tokens.radius.md} bg={tokens.colors.accent.redSubtle} color={tokens.colors.accent.red} fontSize="12px">
                  {error}
                </Box>
              )}

              <Flex direction="column" gap={3}>
                {editableColumns.map(column => {
                  const field = fields[column.name] ?? { value: '', isNull: false }
                  return (
                    <Box key={column.name}>
                      <Flex align="center" justify="space-between" gap={3} mb={1}>
                        <Flex align="baseline" gap={2} minW={0}>
                          <Text fontSize="11px" fontWeight="700" color={tokens.colors.text.secondary} fontFamily={tokens.fontFamily.mono} lineClamp={1}>
                            {column.name}
                          </Text>
                          <Text fontSize="9px" color={tokens.colors.text.disabled}>
                            {column.type || 'TEXT'}{column.isPrimaryKey ? ' · PK' : ''}{column.notNull ? ' · NOT NULL' : ''}
                          </Text>
                        </Flex>
                        {!column.notNull && (
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: tokens.colors.text.muted, fontSize: 10 }}>
                            <input
                              type="checkbox"
                              checked={field.isNull}
                              disabled={saving}
                              onChange={event => {
                                const checked = event.target.checked
                                setFields(current => ({
                                  ...current,
                                  [column.name]: { ...(current[column.name] ?? field), isNull: checked },
                                }))
                              }}
                            />
                            NULL
                          </label>
                        )}
                      </Flex>
                      <input
                        value={field.value}
                        disabled={saving || field.isNull}
                        onChange={event => {
                          const value = event.target.value
                          setFields(current => ({
                            ...current,
                            [column.name]: { ...(current[column.name] ?? field), value },
                          }))
                        }}
                        style={{
                          width: '100%',
                          minHeight: '30px',
                          borderRadius: tokens.radius.md,
                          border: `1px solid ${tokens.colors.border.sidebarPanel}`,
                          background: field.isNull ? tokens.colors.bg.mainLayout : tokens.colors.bg.input,
                          color: tokens.colors.text.primary,
                          fontFamily: tokens.fontFamily.mono,
                          fontSize: '12px',
                          outline: 'none',
                          padding: '6px 8px',
                          opacity: saving ? 0.6 : 1,
                        }}
                      />
                    </Box>
                  )
                })}

                {blobColumns.length > 0 && (
                  <Box p={3} borderRadius={tokens.radius.md} bg={tokens.colors.bg.mainLayout} color={tokens.colors.text.disabled} fontSize="11px">
                    {t('dataViewer.blobEditUnsupported')}: {blobColumns.map(c => c.name).join(', ')}
                  </Box>
                )}
              </Flex>
            </Dialog.Body>

            <Dialog.Footer px={4} py={3} borderTop={`1px solid ${tokens.colors.border.sidebarPanel}`} gap={2}>
              <Button size="sm" variant="ghost" disabled={saving} onClick={onClose}>
                {t('misc.cancel')}
              </Button>
              <Button size="sm" type="submit" disabled={saving} bg={tokens.colors.accent.primary} color={tokens.colors.text.inverse}>
                {saving ? t('dataViewer.saving') : t('menu.save')}
              </Button>
            </Dialog.Footer>
          </form>
        </Dialog.Content>
      </Dialog.Positioner>
    </Dialog.Root>
  )
}

function isBlobColumn(column: ColumnInfo): boolean {
  return /\bBLOB\b/i.test(column.type)
}

function cellToInput(value: Cell | undefined): string {
  if (value === null || value === undefined) return ''
  if (isBlobMarker(value)) return `<binary, ${value.__binary} bytes>`
  return String(value)
}

function parseInputValue(column: ColumnInfo, state: FieldState): Cell {
  if (state.isNull) return null
  const raw = state.value
  const type = column.type.toUpperCase()
  const trimmed = raw.trim()

  if (trimmed === '' && !column.notNull && /(INT|REAL|FLOA|DOUB|NUM|DEC)/.test(type)) {
    return null
  }
  if (column.notNull && trimmed === '' && /(INT|REAL|FLOA|DOUB|NUM|DEC)/.test(type)) {
    throw new Error(`${column.name}: ${column.type || 'numeric'} value is required.`)
  }
  if (/INT/.test(type)) {
    const parsed = Number.parseInt(trimmed, 10)
    if (Number.isNaN(parsed)) throw new Error(`${column.name}: invalid integer.`)
    return parsed
  }
  if (/(REAL|FLOA|DOUB|NUM|DEC)/.test(type)) {
    const parsed = Number(trimmed)
    if (Number.isNaN(parsed)) throw new Error(`${column.name}: invalid number.`)
    return parsed
  }
  if (/(BOOL)/.test(type)) {
    if (/^(true|1)$/i.test(trimmed)) return 1
    if (/^(false|0)$/i.test(trimmed)) return 0
    throw new Error(`${column.name}: use true/false or 1/0.`)
  }
  return raw
}

export default RowMutationDialog
