/**
 * AI 服务商配置解析（服务端专用）。
 * 支持：deepseek / mimo（小米）/ 任意 OpenAI 兼容接口。
 * 对应 .env.example 的变量名，按 AI_PROVIDER 选择。
 */
export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function resolveProvider(): ProviderConfig | null {
  const provider = (process.env.AI_PROVIDER || 'deepseek').trim().toLowerCase();

  if (provider === 'deepseek') {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return null;
    return {
      name: 'deepseek',
      baseUrl: trimSlash(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
      apiKey,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    };
  }

  if (provider === 'mimo') {
    const apiKey = process.env.MIMO_API_KEY;
    if (!apiKey) return null;
    return {
      name: 'mimo',
      baseUrl: trimSlash(process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1'),
      apiKey,
      model: process.env.MIMO_MODEL || 'mimo-v2-flash',
    };
  }

  // 其它任意 OpenAI 兼容服务
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || !process.env.AI_BASE_URL) return null;
  return {
    name: provider || 'openai-compatible',
    baseUrl: trimSlash(process.env.AI_BASE_URL),
    apiKey,
    model: process.env.AI_MODEL || 'gpt-4o-mini',
  };
}

/** 上游 OpenAI 兼容 SSE → 前端约定的 SSE：data: {"delta":{"text":"..."}} … data: [DONE] */
export function toAppSse(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            continue;
          }
          try {
            const json = JSON.parse(data);
            const text: string =
              json.choices?.[0]?.delta?.content ??
              json.choices?.[0]?.message?.content ??
              json.delta?.text ??
              '';
            if (text) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: { text } })}\n\n`));
            }
          } catch {
            /* 忽略无法解析的行（注释/心跳） */
          }
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      },
    }),
  );
}

/** 简易进程内限流：同一 IP 10 分钟内最多 limit 次。 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(ip: string, limit = 30, windowMs = 10 * 60 * 1000): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  // 防止 Map 无限增长
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) if (value.resetAt < now) buckets.delete(key);
  }
  return true;
}
