/**
 * deployStore race-guard regression tests.
 *
 * The `attemptId` field defends against zombie poll loops: if the user
 * starts deploy A, closes the modal mid-build, then starts deploy B for
 * the same projectId, poll A must detect the mismatch and exit before
 * writing stale progress over B's state.
 *
 * These tests pin the invariant: every `startDeploy` for the same
 * projectId monotonically increments attemptId, regardless of phase.
 */
import { useDeployStore } from '../deployStore'

beforeEach(() => {
  useDeployStore.setState({ records: new Map() })
})

describe('deployStore.startDeploy — attemptId race guard', () => {
  it('starts at attemptId 1 on first deploy of a project', () => {
    const store = useDeployStore.getState()
    store.startDeploy('proj-a')
    expect(store.getRecord('proj-a').attemptId).toBe(1)
  })

  it('increments attemptId on each subsequent startDeploy', () => {
    const store = useDeployStore.getState()
    store.startDeploy('proj-a')
    store.startDeploy('proj-a')
    store.startDeploy('proj-a')
    expect(useDeployStore.getState().getRecord('proj-a').attemptId).toBe(3)
  })

  it('tracks attemptId independently per project', () => {
    const store = useDeployStore.getState()
    store.startDeploy('proj-a')
    store.startDeploy('proj-b')
    store.startDeploy('proj-a')
    expect(useDeployStore.getState().getRecord('proj-a').attemptId).toBe(2)
    expect(useDeployStore.getState().getRecord('proj-b').attemptId).toBe(1)
  })

  it('preserves attemptId increment across success → re-deploy', () => {
    const store = useDeployStore.getState()
    store.startDeploy('proj-a')
    store.completeDeploy('proj-a', {
      serviceUrl: 'https://x.toquemedia.net',
      provider: 'cloudflare+r2',
      databaseId: null,
    })
    store.startDeploy('proj-a')
    expect(useDeployStore.getState().getRecord('proj-a').attemptId).toBe(2)
  })

  it('preserves attemptId increment across failure → retry', () => {
    const store = useDeployStore.getState()
    store.startDeploy('proj-a')
    store.failDeploy('proj-a', 'Cloud Build FAILURE')
    store.startDeploy('proj-a')
    expect(useDeployStore.getState().getRecord('proj-a').attemptId).toBe(2)
  })

  it('blank record before any startDeploy has attemptId 0', () => {
    // A consumer reading getRecord before startDeploy sees a fresh blank.
    // The poll loop captures this 0 → would only conflict if a real attempt
    // (id 1+) starts later, which is the correct behaviour.
    expect(useDeployStore.getState().getRecord('never-deployed').attemptId).toBe(0)
  })
})
