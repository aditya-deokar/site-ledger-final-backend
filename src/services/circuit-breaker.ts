import { createLogger } from '../config/logger.js'

const log = createLogger('circuit-breaker')

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

interface CircuitBreakerConfig {
  failureThreshold: number
  resetTimeout: number
  halfOpenMaxAttempts: number
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeout: 30_000,
  halfOpenMaxAttempts: 3,
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED'
  private failureCount = 0
  private halfOpenAttempts = 0
  private lastFailureTime = 0
  private config: CircuitBreakerConfig

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  get currentState(): CircuitState {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime
      if (elapsed >= this.config.resetTimeout) {
        this.transitionTo('HALF_OPEN')
      }
    }
    return this.state
  }

  isAllowed(): boolean {
    const state = this.currentState
    if (state === 'CLOSED') return true
    if (state === 'HALF_OPEN') {
      return this.halfOpenAttempts < this.config.halfOpenMaxAttempts
    }
    return false // OPEN
  }

  onSuccess(): void {
    if (this.state === 'HALF_OPEN' || this.failureCount > 0) {
      this.transitionTo('CLOSED')
    }
  }

  onFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++
      if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
        this.transitionTo('OPEN')
      }
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.transitionTo('OPEN')
    }
  }

  private transitionTo(newState: CircuitState): void {
    const prevState = this.state
    this.state = newState

    if (newState === 'CLOSED') {
      this.failureCount = 0
      this.halfOpenAttempts = 0
    } else if (newState === 'HALF_OPEN') {
      this.halfOpenAttempts = 0
    }

    if (prevState !== newState) {
      log.warn({ from: prevState, to: newState, failureCount: this.failureCount }, 'Circuit breaker state transition')
    }
  }
}

export const redisCircuitBreaker = new CircuitBreaker()
