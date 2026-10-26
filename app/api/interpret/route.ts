import type { NextRequest } from 'next/server';
import type { ZiweiChart } from '@/lib/ziwei/types';
import { buildChartContext, INTERPRET_SYSTEM_PROMPT } from '@/lib/ai/chart-context';
import { resolveProvider, toAppSse, rateLimit } from '@/lib/ai/provider';
import { consumeQuota } from '@/lib/ai/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Body {
  chart?: ZiweiChart;
  messages?: ChatMessage[];
}

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'local';
  if (!rateLimit(ip)) return json(429, { error: '提问太频繁，请稍后再试' });

  const quota = await consumeQuota(ip);
  if (!quota.ok) {
    return json(429, {
      error:
        quota.reason === 'ip'
          ? '今天的个人解读次数用完了，明天再来（每日约 20 次）'
          : '今天的解读名额已用完，明天再来',
      quota: { reason: quota.reason, used: quota.used, limit: quota.limit },
    });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: '请求体不是合法 JSON' });
  }

  const chart = body.chart;
  if (!chart || !Array.isArray(chart.palaces) || chart.palaces.length !== 12) {
    return json(400, { error: '缺少或非法的命盘数据 chart' });
  }

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m): m is ChatMessage =>
        !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0,
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));

  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return json(400, { error: '最后一条消息必须是 user' });
  }

  const provider = resolveProvider();
  if (!provider) {
    return json(503, {
      error: '未配置 AI Key：请在 .env.local 设置 DEEPSEEK_API_KEY，或配置 AI_API_KEY + AI_BASE_URL + AI_MODEL',
      missing: 'AI_KEY',
    });
  }

  const system = `${INTERPRET_SYSTEM_PROMPT}\n\n${buildChartContext(chart)}`;

  let upstream: Response;
  try {
    upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: provider.model,
        stream: true,
        temperature: 0.7,
        max_tokens: 2200,
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
  } catch {
    return json(502, { error: `无法连接 AI 服务（${provider.baseUrl}）` });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return json(502, {
      error: `AI 服务返回错误（HTTP ${upstream.status}）`,
      detail: detail.slice(0, 500),
    });
  }

  return new Response(toAppSse(upstream.body), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function GET() {
  const provider = resolveProvider();
  return json(200, {
    ok: true,
    configured: Boolean(provider),
    provider: provider ? { name: provider.name, model: provider.model } : null,
  });
}
