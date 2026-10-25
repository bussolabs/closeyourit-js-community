import express from 'express'
import Fastify from 'fastify'
import type { INestApplication } from '@nestjs/common'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { Client } from '@bussolabs/closeyourit-js'
import { createExpressMonitoring } from '@bussolabs/closeyourit-js/express'
import { createFastifyMonitoring } from '@bussolabs/closeyourit-js/fastify'
import { createNestMonitoring } from '@bussolabs/closeyourit-js/nest'

declare const client: Client
declare const nestApp: INestApplication
const provider = new NodeTracerProvider()
const options = { tracer: provider.getTracer('type-check') }
const expressMonitor = createExpressMonitoring(client, options)
express().use(expressMonitor.middleware, expressMonitor.errors)
createFastifyMonitoring(client, options).install(Fastify())
const nestMonitor = createNestMonitoring(expressMonitor.context)
nestApp.useGlobalInterceptors(nestMonitor.interceptor)
nestApp.useGlobalFilters(nestMonitor.wrapFilter({ catch() {} }))
