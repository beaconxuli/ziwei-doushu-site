import { getStore } from '@netlify/blobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 只读诊断：Blobs 是否可用、今日额度用量。不含任何密钥。
 * 用途：上线后确认额度是否真的在计数。
 */
export async function GET(req: Request) {
  const out: Record<string, unknown> = {
    hasBlobsContext: Boolean(process.env.NETLIFY_BLOBS_CONTEXT),
    limits: {
      daily: process.env.AI_DAILY_LIMIT || '300(default)',
      perIp: process.env.AI_DAILY_PER_IP || '20(default)',
    },
  };
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  out.day = day;
  const t0 = Date.now();
  try {
    const store = getStore({ name: 'ai-quota', consistency: 'strong' });
    const total = Number((await store.get(`total:${day}`, { type: 'text' })) || 0);
    out.today = { totalUsed: total };
    out.blobs = { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    out.blobs = { ok: false, ms: Date.now() - t0, error: String((err as Error)?.message || err) };
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
