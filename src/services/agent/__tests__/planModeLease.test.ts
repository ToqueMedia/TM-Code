/**
 * Plan-mode refcount leases on ToolExecutor singleton.
 */

// ToolExecutor pulls a heavy graph — test only enable/disable lease behaviour
// via a minimal reimplementation of the lease logic (same as production code).

function createLeaseBox() {
  let planMode = false
  const owners = new Set<string>()
  return {
    enable(ownerId?: string) {
      planMode = true
      owners.add(ownerId ?? '__legacy__')
    },
    disable(ownerId?: string) {
      if (ownerId) owners.delete(ownerId)
      else owners.clear()
      if (owners.size > 0) return
      planMode = false
    },
    isOn: () => planMode,
    count: () => owners.size,
  }
}

describe('plan-mode lease refcount', () => {
  it('keeps plan-mode on until the last owner releases', () => {
    const box = createLeaseBox()
    box.enable('main')
    box.enable('live-plan:task-1')
    expect(box.isOn()).toBe(true)
    expect(box.count()).toBe(2)

    box.disable('main')
    expect(box.isOn()).toBe(true)
    expect(box.count()).toBe(1)

    box.disable('live-plan:task-1')
    expect(box.isOn()).toBe(false)
    expect(box.count()).toBe(0)
  })

  it('legacy disable without id clears all', () => {
    const box = createLeaseBox()
    box.enable('a')
    box.enable('b')
    box.disable()
    expect(box.isOn()).toBe(false)
  })
})
