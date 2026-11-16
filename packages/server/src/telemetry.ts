/**
 * Tracing. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; then every agent
 * run (each model call and tool call) is exported as OpenTelemetry spans.
 */
export async function startTelemetry(): Promise<(() => Promise<void>) | null> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null
  const { NodeSDK } = await import('@opentelemetry/sdk-node')
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
  const sdk = new NodeSDK({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'stetpad', traceExporter: new OTLPTraceExporter() })
  sdk.start()
  // The AI SDK reports model and tool calls only to integrations registered with it.
  const { registerTelemetry } = await import('ai')
  const { OpenTelemetry } = await import('@ai-sdk/otel')
  registerTelemetry(new OpenTelemetry())
  return () => sdk.shutdown()
}
