/**
 * The AI provider, behind one small interface so it can be changed (or mocked) without touching any
 * feature. ARUMA ships with one real provider (Anthropic's Claude API, docs/AI.md) and a scripted one for
 * tests. No provider configured = the AI layer is off and every feature uses its non-AI path.
 */

export type AiContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export type AiMessage = { role: 'user' | 'assistant'; content: string | AiContent[] };

/** A read-only function the model may ask ARUMA to run (search products, read sales totals…). */
export type AiToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

export type AiRequest = {
  /** Feature key, so logs and test scripts know what the call is for. */
  feature: string;
  system: string;
  messages: AiMessage[];
  tools?: AiToolSpec[];
  maxTokens: number;
};

export type AiResponse = {
  content: AiContent[];
  /** "tool_use" when the model asks for tools before answering. */
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
};

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(request: AiRequest, signal: AbortSignal): Promise<AiResponse>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * Anthropic Messages API (https://docs.anthropic.com/en/api/messages): POST /v1/messages with the
 * x-api-key and anthropic-version headers. Paid per token; the key comes from console.anthropic.com and
 * lives in the server's secrets (ANTHROPIC_API_KEY), never in the code or the apps.
 */
export function createAnthropicProvider(options: { apiKey: string; model: string; baseUrl?: string; fetch?: Fetch }): AiProvider {
  const http: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
  return {
    name: 'anthropic',
    model: options.model,
    async complete(request, signal) {
      const body = {
        model: options.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages.map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content
              : m.content.map((c) =>
                  c.type === 'tool_result' ? { type: 'tool_result', tool_use_id: c.toolUseId, content: c.content, is_error: c.isError ?? false } : c,
                ),
        })),
        ...(request.tools?.length ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
      };
      const res = await http(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal,
      });
      const json = (await res.json()) as {
        content?: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: string })[];
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
        error?: { type?: string };
      };
      if (res.status !== 200) throw new Error(`AI provider error ${res.status}: ${json.error?.type ?? 'unknown'}`);
      return {
        content: (json.content ?? []).filter((c): c is Exclude<AiContent, { type: 'tool_result' }> => c.type === 'text' || c.type === 'tool_use'),
        stopReason: json.stop_reason ?? 'end_turn',
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        model: json.model ?? options.model,
      };
    },
  };
}

/**
 * A provider that answers from a script: for tests and demonstrations without an account. Every request
 * is kept in `calls`, so tests can check what the model was (and was not) given.
 */
export function createScriptedProvider(script: (request: AiRequest) => AiResponse | string | Promise<AiResponse | string>) {
  const calls: AiRequest[] = [];
  const provider: AiProvider & { calls: AiRequest[] } = {
    name: 'scripted',
    model: 'scripted',
    calls,
    async complete(request, signal) {
      calls.push(request);
      const out = await Promise.race([
        Promise.resolve(script(request)),
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      ]);
      return typeof out === 'string' ? { content: [{ type: 'text', text: out }], stopReason: 'end_turn', inputTokens: 100, outputTokens: 50, model: 'scripted' } : out;
    },
  };
  return provider;
}
