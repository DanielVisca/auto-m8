import type { Pressure } from '../../shared/resources.ts'

// Short builds and server restarts stay quiet. Clear more slowly to avoid flickering at a threshold.
export class ResourcePressureGate {
  level: Pressure = 'normal'
  private strainedSince: number | null = null
  private normalSince: number | null = null
  private lastAt: number | null = null
  update(next: Pressure, now: number): Pressure {
    if (this.lastAt !== null && now - this.lastAt > 20_000) { this.strainedSince = null; this.normalSince = null; this.level = 'normal' }
    this.lastAt = now
    if (next === 'normal') {
      this.strainedSince = null
      this.normalSince ??= now
      if (now - this.normalSince >= 20_000) this.level = 'normal'
    } else {
      this.normalSince = null
      this.strainedSince ??= now
      if (now - this.strainedSince >= 10_000) this.level = next
    }
    return this.level
  }
}
