/**
 * Stub of `openclaw/plugin-sdk/tool-results` for the standalone typecheck and
 * tests. Mirrors the host's implementation (src/agents/tools/tool-results.ts):
 * a text content block carrying the pretty-printed JSON, plus the payload
 * itself on `details` for callers that want it structured.
 */
export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

export function textResult(text: string, details?: unknown): ToolCallResult {
  return { content: [{ type: "text", text }], details };
}

export function jsonResult(payload: unknown): ToolCallResult {
  return textResult(JSON.stringify(payload, null, 2), payload);
}
