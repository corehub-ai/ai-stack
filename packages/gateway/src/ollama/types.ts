// ── Ollama wire types (verificados ao vivo contra Ollama 0.31.1, 2026-07-03) ──
export type OllamaToolCall = {
  id?: string;
  function: { index?: number; name: string; arguments: Record<string, unknown> };
};

export type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string; // request-side tool result identifier (não tool_call_id)
  images?: string[];
};

export type OllamaTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
};

export type OllamaChatRequest = {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream?: boolean;
  think?: boolean | "low" | "medium" | "high" | "max";
  options?: Record<string, unknown>;
  format?: unknown;
};

export type OllamaGenerateRequest = {
  model: string;
  prompt: string;
  system?: string;
  stream?: boolean;
  think?: boolean | "low" | "medium" | "high" | "max";
  options?: Record<string, unknown>;
};

export type OllamaDurations = {
  total_duration: number;
  load_duration: number;
  prompt_eval_duration: number;
  eval_duration: number;
};

export type OllamaChatChunk = {
  model: string;
  created_at: string;
  message: { role: "assistant"; content: string; tool_calls?: OllamaToolCall[] };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

export type OllamaGenerateChunk = {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

// ── OpenAI chat completion request (subconjunto que o gateway monta) ──
export type OpenAiChatRequest = {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  seed?: number;
  reasoning_effort?: "low" | "medium" | "high";
};

export type TranslateCtx = {
  model: string;
  createdAt: string;
  durations: OllamaDurations;
  promptEvalCount: number;
  evalCount: number;
};
