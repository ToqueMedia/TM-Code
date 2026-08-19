export type EmptySessionPeriod = 'morning' | 'afternoon' | 'evening'

/** 05–11 morning, 12–17 afternoon, otherwise evening — conversational
 *  greeting bands, not a clock widget. */
export function emptySessionPeriod(hour: number): EmptySessionPeriod {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  return 'evening'
}
