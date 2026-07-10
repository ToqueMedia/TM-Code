import { classifySelectedPair } from '../collabMesh'

// Synthetic getStats() reports — a Map satisfies the Iterable<[id, stats]>
// contract the classifier consumes (RTCStatsReport is maplike/iterable).

function report(entries: Record<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
  return new Map(Object.entries(entries))
}

const candidate = (id: string, candidateType: string) => ({
  [id]: { type: id.startsWith('L') ? 'local-candidate' : 'remote-candidate', candidateType },
})

describe('classifySelectedPair', () => {
  it('classifies a host↔host selected pair as direct (transport path)', () => {
    const stats = report({
      T1: { type: 'transport', selectedCandidatePairId: 'P1' },
      P1: { type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' },
      ...candidate('L1', 'host'),
      ...candidate('R1', 'host'),
    })
    expect(classifySelectedPair(stats)).toBe('direct')
  })

  it('classifies srflx↔host as direct (STUN traversal is still P2P)', () => {
    const stats = report({
      T1: { type: 'transport', selectedCandidatePairId: 'P1' },
      P1: { type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' },
      ...candidate('L1', 'srflx'),
      ...candidate('R1', 'host'),
    })
    expect(classifySelectedPair(stats)).toBe('direct')
  })

  it('classifies as turn when EITHER side is a relay candidate', () => {
    const local = report({
      T1: { type: 'transport', selectedCandidatePairId: 'P1' },
      P1: { type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' },
      ...candidate('L1', 'relay'),
      ...candidate('R1', 'srflx'),
    })
    const remote = report({
      T1: { type: 'transport', selectedCandidatePairId: 'P1' },
      P1: { type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' },
      ...candidate('L1', 'host'),
      ...candidate('R1', 'relay'),
    })
    expect(classifySelectedPair(local)).toBe('turn')
    expect(classifySelectedPair(remote)).toBe('turn')
  })

  it('falls back to the selected/nominated candidate-pair when no transport stat exists', () => {
    const stats = report({
      P0: { type: 'candidate-pair', state: 'failed', nominated: false, localCandidateId: 'L0', remoteCandidateId: 'R0' },
      P1: { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1' },
      ...candidate('L0', 'relay'),
      ...candidate('R0', 'relay'),
      ...candidate('L1', 'host'),
      ...candidate('R1', 'srflx'),
    })
    expect(classifySelectedPair(stats)).toBe('direct')
  })

  it('honours the pre-standard selected=true flag over nomination', () => {
    const stats = report({
      P1: { type: 'candidate-pair', selected: true, localCandidateId: 'L1', remoteCandidateId: 'R1' },
      ...candidate('L1', 'relay'),
      ...candidate('R1', 'host'),
    })
    expect(classifySelectedPair(stats)).toBe('turn')
  })

  it('returns null while nothing is selected yet or candidates are missing', () => {
    expect(classifySelectedPair(report({}))).toBeNull()
    expect(
      classifySelectedPair(
        report({
          P1: { type: 'candidate-pair', state: 'in-progress', nominated: false },
        }),
      ),
    ).toBeNull()
    // Selected pair whose candidate entries were pruned from the report.
    expect(
      classifySelectedPair(
        report({
          T1: { type: 'transport', selectedCandidatePairId: 'P1' },
          P1: { type: 'candidate-pair', localCandidateId: 'LX', remoteCandidateId: 'RX' },
        }),
      ),
    ).toBeNull()
  })
})
