import type { NextRequest } from 'next/server';
import type { ZiweiChart } from '@/lib/ziwei/types';
import { buildChartContext, HEMING_SYSTEM_PROMPT } from '@/lib/ai/chart-context';
import { resolveProvider, toAppSse, rateLimit } from '@/lib/ai/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Body {
  chartA?: ZiweiChart;
  chartB?: ZiweiChart;
  question?: string;
}

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const validChart = (c?: ZiweiChart): c is ZiweiChart =>
  !!c && Array.isArray(c.palaces) && c.palaces.length === 12;

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'local';
  if (!rateLimit(ip)) return json(429, { error: '请求太频繁，请稍后再试' });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: '请求体不是合法 JSON' });
  }

  if (!validChart(body.chartA) || !validChart(body.chartB)) {
    return json(400, { error: '缺少或非法的两张命盘 chartA / chartB' });
  }

  const provider = resolveProvider();
  if (!provider) {
    return json(503, {
      error: '未配置 AI Key：请在 .env.local 设置 DEEPSEEK_API_KEY',
      missing: 'AI_KEY',
    });
  }

  const question = (body.question ?? '').slice(0, 2000).trim();
  const system = [
    HEMING_SYSTEM_PROMPT,
    '',
    '【A 的命盘】',
    buildChartContext(body.chartA),
    '',
    '【B 的命盘】',
    buildChartContext(body.chartB),
  ].join('\n');

  const userContent = question
    ? `合盘问题：${question}`
    : '请按既定结构做一次完整的合盘分析：双方命盘要点、宫位对照、四化互动、相处模式、建议。';

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
        max_tokens: 2400,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
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
