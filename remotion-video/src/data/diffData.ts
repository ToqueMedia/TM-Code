// Cinematic-but-plausible diffs shown in the video. Line structure mirrors the
// real TM Code TerminalStructuredDiff renderer (hunk headers, gutter, +/− rows).

export type DiffLineKind = 'context' | 'add' | 'remove' | 'hunk'

export interface DiffLine {
  kind: DiffLineKind
  /** line number shown in the gutter (new line number for add/context, old for remove) */
  lineNo?: number
  text: string
}

export interface DiffSpec {
  filePath: string
  summary: string
  lines: DiffLine[]
}

export const usersRouteDiff: DiffSpec = {
  filePath: 'server/routes/users.ts',
  summary: 'Added 12 lines',
  lines: [
    { kind: 'hunk', text: '@@ -84,6 +84,18 @@' },
    { kind: 'context', lineNo: 84, text: "  router.get('/users', requireRole('admin'), listUsers)" },
    { kind: 'add', lineNo: 85, text: '' },
    { kind: 'add', lineNo: 86, text: '  // Liberta a estação e termina a sessão activa do utilizador' },
    { kind: 'add', lineNo: 87, text: "  router.post('/users/:id/force-logout', requireRole('admin'), async (req, res) => {" },
    { kind: 'add', lineNo: 88, text: '    const user = await storage.getUser(req.params.id)' },
    { kind: 'add', lineNo: 89, text: "    if (!user) return res.status(404).json({ error: 'user_not_found' })" },
    { kind: 'add', lineNo: 90, text: '' },
    { kind: 'add', lineNo: 91, text: '    await storage.clearActiveSession(user.id)' },
    { kind: 'add', lineNo: 92, text: '    await storage.releaseStation(user.stationId)' },
    { kind: 'add', lineNo: 93, text: "    await audit.log('force_logout', { admin: req.user.id, target: user.id })" },
    { kind: 'add', lineNo: 94, text: '' },
    { kind: 'add', lineNo: 95, text: '    res.json({ ok: true, station: user.stationId })' },
    { kind: 'add', lineNo: 96, text: '  })' },
    { kind: 'context', lineNo: 97, text: '' },
    { kind: 'context', lineNo: 98, text: "  router.patch('/users/:id', requireRole('admin'), updateUser)" },
  ],
}

/** Index (within usersRouteDiff.lines) of rows to zoom/highlight in scene 4 */
export const USERS_ROUTE_FOCUS = {
  endpointLine: 4, // router.post('/users/:id/force-logout' ...)
  releaseLines: [8, 9], // clearActiveSession + releaseStation
} as const

export const apiUsersDiff: DiffSpec = {
  filePath: 'client/src/api/users.ts',
  summary: 'Added 4 lines',
  lines: [
    { kind: 'hunk', text: '@@ -42,1 +42,5 @@' },
    { kind: 'context', lineNo: 42, text: '}' },
    { kind: 'add', lineNo: 43, text: 'export async function forceLogout(userId: string) {' },
    { kind: 'add', lineNo: 44, text: "  const res = await apiRequest('POST', `/api/users/${userId}/force-logout`)" },
    { kind: 'add', lineNo: 45, text: '  return res.json()' },
    { kind: 'add', lineNo: 46, text: '}' },
  ],
}

export const userManagementDiff: DiffSpec = {
  filePath: 'client/src/pages/admin/user-management.tsx',
  summary: 'Added 8 lines',
  lines: [
    { kind: 'hunk', text: '@@ -118,2 +118,10 @@' },
    { kind: 'context', lineNo: 118, text: "  const { data: users } = useQuery({ queryKey: ['users'], queryFn: fetchUsers })" },
    { kind: 'add', lineNo: 119, text: '' },
    { kind: 'add', lineNo: 120, text: '  const forceLogoutMutation = useMutation({' },
    { kind: 'add', lineNo: 121, text: '    mutationFn: forceLogout,' },
    { kind: 'add', lineNo: 122, text: '    onSuccess: () => {' },
    { kind: 'add', lineNo: 123, text: "      queryClient.invalidateQueries({ queryKey: ['users'] })" },
    { kind: 'add', lineNo: 124, text: "      toast({ title: 'Sessão terminada e estação libertada com sucesso.' })" },
    { kind: 'add', lineNo: 125, text: '    },' },
    { kind: 'add', lineNo: 126, text: '  })' },
  ],
}
