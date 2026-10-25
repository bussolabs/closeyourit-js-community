// Breadcrumb (Sentry format) and ring buffer. Mirror of `Breadcrumb` /
// `BreadcrumbBuffer` (dart). `data` and `message` are scrubbed at construction.

import { scrub, scrubMessage } from './scrubber'
import type { EventPayload } from './types'

export interface BreadcrumbInput {
  message?: string
  category?: string
  /// Sentry type: `default`, `query`, `http`, `user`, `navigation`.
  type?: string
  /// Level: `info`, `debug`, `warning`, `error`.
  level?: string
  data?: Record<string, unknown>
}

export class Breadcrumb {
  readonly timestamp: string
  readonly message: string | undefined
  readonly category: string | undefined
  readonly type: string
  readonly level: string
  readonly data: Record<string, unknown> | undefined

  constructor(input: BreadcrumbInput) {
    this.timestamp = new Date().toISOString()
    this.message = input.message === undefined ? undefined : scrubMessage(input.message)
    this.category = input.category
    this.type = input.type ?? 'default'
    this.level = input.level ?? 'info'
    this.data =
      input.data && Object.keys(input.data).length > 0 ? scrub(input.data) : undefined
  }

  toJSON(): EventPayload {
    const json: EventPayload = {
      timestamp: this.timestamp,
      type: this.type,
      level: this.level,
    }
    if (this.category !== undefined) json['category'] = this.category
    if (this.message !== undefined) json['message'] = this.message
    if (this.data !== undefined) json['data'] = this.data
    return json
  }
}

/// Ring buffer: keeps the last [maxSize], drops the oldest.
export class BreadcrumbBuffer {
  private items: Breadcrumb[] = []

  constructor(private readonly capacity: number = 50) {}

  /// Maximum number of breadcrumbs kept (used to replicate the limit in a fork).
  get maxSize(): number {
    return this.capacity
  }

  get length(): number {
    return this.items.length
  }

  add(crumb: Breadcrumb): void {
    if (this.capacity <= 0) return
    this.items.push(crumb)
    while (this.items.length > this.capacity) this.items.shift()
  }

  clear(): void {
    this.items = []
  }

  toList(): Breadcrumb[] {
    return [...this.items]
  }

  /// Serializes into `{values: [...]}` (Sentry format), or `null` if empty.
  toJSON(): EventPayload | null {
    if (this.items.length === 0) return null
    return { values: this.items.map((c) => c.toJSON()) }
  }
}
