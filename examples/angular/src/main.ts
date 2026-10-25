import {
  Component,
  ErrorHandler,
  NgZone,
  VERSION,
  signal,
  provideBrowserGlobalErrorListeners,
} from '@angular/core'
import { bootstrapApplication } from '@angular/platform-browser'
import { Router, RouterLink, RouterOutlet, provideRouter } from '@angular/router'
import {
  HttpClient,
  HttpContext,
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http'
import { firstValueFrom, retry } from 'rxjs'
import { Client } from '@bussolabs/closeyourit-js'
import {
  ANGULAR_HTTP_TEMPLATE,
  createAngularHttpInterceptor,
  instrumentAngularErrorHandler,
  instrumentAngularRouter,
} from '@bussolabs/closeyourit-js/angular'
import { changeDetectionProviders } from './mode'

const config = await fetch('/api/config').then((response) => response.json())
const observations: Array<{
  id: string
  kind: string
  trace_id?: string
  label?: string
}> = []
const state = signal<Record<string, unknown>>({ ready: false })
let handlerCalls = 0
let usable = 0
let failures = 0
let responsePreserved = false
let cancellationPreserved = false
let restored = false
const client = new Client({
  ...config,
  autoInstall: false,
  captureRequest: false,
  slowMethodThresholdMs: 1,
  captureMethodArguments: true,
  tracePropagationTargets: [location.origin],
  beforeSend(payload) {
    const id = payload.event_id ?? payload.sample_id
    if (typeof id === 'string' && observations.length < 32)
      observations.push({
        id,
        kind: String(payload.kind ?? 'error'),
        trace_id: typeof payload.trace_id === 'string' ? payload.trace_id : undefined,
        label: typeof payload.label === 'string' ? payload.label : undefined,
      })
    return config.constructionOnly ? null : payload
  },
})
const handler = new ErrorHandler()
const defaultHandler = handler.handleError
const previous = function (this: ErrorHandler, error: unknown) {
  handlerCalls++
  defaultHandler.call(this, error)
}
handler.handleError = previous
let errorIntegration: ReturnType<typeof instrumentAngularErrorHandler>
let routerIntegration: ReturnType<typeof instrumentAngularRouter>
const telemetryOptions: { zone?: NgZone } = {}
const httpIntegration = createAngularHttpInterceptor(client, telemetryOptions)
function snapshot() {
  state.set({
    ready: true,
    angular: VERSION.full,
    mode: config.mode,
    construction_only: !!config.constructionOnly,
    observations: [...observations],
    handler_calls: handlerCalls,
    usable,
    failures,
    response_preserved: responsePreserved,
    cancellation_preserved: cancellationPreserved,
    handler_restored: restored,
    client_enabled: client.enabled,
    stats: client.stats.toObject(),
  })
}

@Component({ selector: 'proof-home', standalone: true, template: '<p>Home route</p>' })
class Home {}
@Component({
  selector: 'proof-item',
  standalone: true,
  template: '<p>Item route remains usable</p>',
})
class Item {}
@Component({
  selector: 'proof-root',
  standalone: true,
  imports: [RouterLink, RouterOutlet],
  template: `
    <h1>Angular instrumentation proof</h1>
    <a routerLink="/">Home</a>
    <a routerLink="/items/private-item" [queryParams]="{ password: 'private-query' }"
      >Open item</a
    >
    <router-outlet />
    <p>
      <button (click)="fail()">Fail Angular handler</button>
      <button (click)="httpProof()">Run HTTP proof</button>
    </p>
    <p>
      <button (click)="flush()">Flush proof</button>
      <button (click)="uninstall()">Uninstall adapter</button>
      <button (click)="use()">Use application</button>
    </p>
    <output id="proof-status">{{ serialized() }}</output>
  `,
})
class App {
  serialized = () => JSON.stringify(state())
  constructor(private http: HttpClient) {}
  fail() {
    failures++
    throw new Error('Angular browser proof ' + failures)
  }
  use() {
    usable++
    snapshot()
  }
  async flush() {
    await client.flush()
    snapshot()
  }
  uninstall() {
    errorIntegration.uninstall()
    routerIntegration.uninstall()
    httpIntegration.uninstall()
    restored = handler.handleError === previous
    snapshot()
  }
  async httpProof() {
    const context = new HttpContext().set(
      ANGULAR_HTTP_TEMPLATE,
      '/proof-http/:operation',
    )
    const response = await firstValueFrom(
      this.http.post<{ ok: boolean; body_seen: boolean }>(
        '/proof-http/success?password=private-query',
        { password: 'private-body' },
        { context },
      ),
    )
    responsePreserved = response.ok && response.body_seen
    await firstValueFrom(this.http.get('/proof-http/retry', { context }).pipe(retry(1)))
    let delivered = false
    const subscription = this.http.get('/proof-http/cancel', { context }).subscribe({
      next: () => {
        delivered = true
      },
      error: () => {
        delivered = true
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    subscription.unsubscribe()
    await new Promise((resolve) => setTimeout(resolve, 120))
    cancellationPreserved = !delivered
    await this.flush()
  }
}

const app = await bootstrapApplication(App, {
  providers: [
    ...changeDetectionProviders,
    provideBrowserGlobalErrorListeners(),
    { provide: ErrorHandler, useValue: handler },
    provideRouter([
      { path: '', component: Home },
      { path: 'items/:id', component: Item },
    ]),
    provideHttpClient(withFetch(), withInterceptors([httpIntegration.interceptor])),
  ],
})
const zone = app.injector.get(NgZone)
telemetryOptions.zone = zone
errorIntegration = instrumentAngularErrorHandler(handler, client, { zone })
routerIntegration = instrumentAngularRouter(app.injector.get(Router), client, { zone })
app.onDestroy(() => {
  errorIntegration.uninstall()
  routerIntegration.uninstall()
  httpIntegration.uninstall()
})
snapshot()
