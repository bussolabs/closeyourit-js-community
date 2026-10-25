import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import type { Client } from './client'

export type ReactClient = Pick<Client, 'captureException'>

export interface ErrorBoundaryProps {
  client: ReactClient
  children?: ReactNode
  fallback: ReactNode
  onError?: (error: unknown, info: ErrorInfo) => void
}

/** The application owns the client and fallback; changing the React key resets the boundary. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    capture(this.props.client, error, info, true)
    this.props.onError?.(error, info)
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** React 19 createRoot/hydrateRoot callbacks; pass the same client as global handlers. */
export function createReactErrorHandlers(
  client: ReactClient,
  options: { captureRecoverableErrors?: boolean } = {},
) {
  return {
    onCaughtError(error: unknown, info: Pick<ErrorInfo, 'componentStack'>): void {
      capture(client, error, info, true)
    },
    onUncaughtError(error: unknown, info: Pick<ErrorInfo, 'componentStack'>): void {
      capture(client, error, info, false)
    },
    onRecoverableError(error: unknown, info: Pick<ErrorInfo, 'componentStack'>): void {
      if (options.captureRecoverableErrors) capture(client, error, info, true)
    },
  }
}

function capture(
  client: ReactClient,
  error: unknown,
  info: Pick<ErrorInfo, 'componentStack'>,
  handled: boolean,
): void {
  try {
    client.captureException(error, {
      handled,
      contexts: { react: { component_stack: info.componentStack?.slice(0, 8192) } },
    })
  } catch {
    // Reporting must not replace React's fallback or the application's exception.
  }
}
