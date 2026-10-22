import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

/** Start a low-cardinality HTTP span; the API is a no-op until the host installs an SDK provider. */
export function startHttpSpan(method: string, route: string, requestId: string): Span {
  return trace.getTracer("a2a-registry").startSpan(`HTTP ${method} ${route}`, {
    attributes: {
      "http.request.method": method,
      "http.route": route,
      "a2a.registry.request_id": requestId,
    },
  });
}

/** Finish an HTTP span with the response outcome without recording request-specific labels. */
export function finishHttpSpan(span: Span, statusCode: number, error?: unknown): void {
  span.setAttribute("http.response.status_code", statusCode);
  if (statusCode >= 500 || error !== undefined) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    if (error instanceof Error) span.recordException(error);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}
