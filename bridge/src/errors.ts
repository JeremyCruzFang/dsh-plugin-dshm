export class DmpError extends Error {
  constructor(public readonly code: string, message = code, public readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'DmpError'
  }
}
