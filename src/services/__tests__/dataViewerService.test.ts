import { invoke } from '@/utils/invokeMetrics'
import type { ProjectContext } from '../dataViewerService'
import {
  deleteRow,
  getRows,
  insertRow,
  updateRow,
  type ColumnInfo,
} from '../dataViewerService'

jest.mock('@/utils/invokeMetrics', () => ({
  invoke: jest.fn(),
}))

jest.mock('../tauriFetch', () => ({
  tauriFetch: jest.fn(),
}))

jest.mock('../../utils/devUrls', () => ({
  resolveWorkerUrl: () => 'https://worker.example',
}))

const invokeMock = invoke as jest.MockedFunction<typeof invoke>

const project: ProjectContext = {
  id: 'project-1',
  name: 'Project',
  path: '/tmp/project',
}

const noPkColumns: ColumnInfo[] = [
  { name: 'name', type: 'TEXT', notNull: false, isPrimaryKey: false },
]

const pkColumns: ColumnInfo[] = [
  { name: 'id', type: 'INTEGER', notNull: true, isPrimaryKey: true },
  { name: 'name', type: 'TEXT', notNull: false, isPrimaryKey: false },
]

beforeEach(() => {
  invokeMock.mockReset()
})

describe('dataViewerService mutations', () => {
  it('loads internal rowids for tables without primary keys and strips them from visible rows', async () => {
    invokeMock.mockImplementation(async (_command, args) => {
      const sql = (args as { sql?: string }).sql ?? ''
      if (sql.startsWith('PRAGMA table_info')) {
        return {
          columns: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'],
          rows: [[0, 'name', 'TEXT', 0, null, 0]],
        }
      }
      return {
        columns: ['__tmcode_rowid__', 'name'],
        rows: [[7, 'Ana']],
      }
    })

    const result = await getRows('dev', project, 'people', 1, 20)

    expect(result.columns).toEqual(['name'])
    expect(result.rows).toEqual([['Ana']])
    expect(result.rowIds).toEqual([7])
    expect(invokeMock).toHaveBeenLastCalledWith('data_viewer_dev_query', {
      projectPath: '/tmp/project',
      sql: 'SELECT _rowid_ AS "__tmcode_rowid__", * FROM "people" LIMIT ? OFFSET ?',
      params: [20, 0],
    })
  })

  it('updates rows by primary key using parameterized SQL', async () => {
    invokeMock.mockResolvedValue({ rowsAffected: 1 })

    await updateRow(
      'dev',
      project,
      'users',
      pkColumns,
      { id: 1, name: 'Old' },
      undefined,
      { name: 'New' },
    )

    expect(invokeMock).toHaveBeenCalledWith('data_viewer_dev_execute', {
      projectPath: '/tmp/project',
      sql: 'UPDATE "users" SET "name" = ? WHERE "id" IS ?',
      params: ['New', 1],
    })
  })

  it('deletes rows by rowid when no primary key exists', async () => {
    invokeMock.mockResolvedValue({ rowsAffected: 1 })

    await deleteRow('dev', project, 'people', noPkColumns, { name: 'Ana' }, 7)

    expect(invokeMock).toHaveBeenCalledWith('data_viewer_dev_execute', {
      projectPath: '/tmp/project',
      sql: 'DELETE FROM "people" WHERE _rowid_ IS ?',
      params: [7],
    })
  })

  it('inserts rows with parameterized values', async () => {
    invokeMock.mockResolvedValue({ rowsAffected: 1 })

    await insertRow('dev', project, 'users', pkColumns, { name: 'Ana' })

    expect(invokeMock).toHaveBeenCalledWith('data_viewer_dev_execute', {
      projectPath: '/tmp/project',
      sql: 'INSERT INTO "users" ("name") VALUES (?)',
      params: ['Ana'],
    })
  })
})
