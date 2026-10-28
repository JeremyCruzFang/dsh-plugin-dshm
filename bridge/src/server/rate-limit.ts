// A monotonic token bucket: full burst capacity initially, then 20 req/s.
export class RequestRateLimit {
  private tokens = 50
  private updated: number
  constructor(private readonly clock: () => number = () => performance.now()) { this.updated = clock() }
  take(): boolean {
    const current = this.clock()
    this.tokens = Math.min(50, this.tokens + Math.max(0, current - this.updated) * 20 / 1000)
    this.updated = current
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}
