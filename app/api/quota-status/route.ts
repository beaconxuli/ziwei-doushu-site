import { getStore } from '@netlify/blobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 只读诊断：Blobs 是否可用、耗时多少。不含任何密钥。 */
export async function GET() {
  const out: Record<string, unknown> = {
    hasBlobsContext: Boolean(process.env.NETLIFY_BLOBS_CONTEXT),
    hasSiteId: Boolean(process.env.NETLIFY_SITE_ID || process.env.SITE_ID),
    limits: {
      daily: process.env.AI_DAILY_LIMIT || '300(default)',
      perIp: process.env.AI_DAILY_PER_IP || '20(default)',
    },
  };
  const t0 = Date.now();
  try {
    const store = getStore({ name: 'ai-quota', consistency: 'strong' });
    const key = `probe:${new Date().toISOString()}`;
    await store.set(key, 'ok');
    const v = await store.get(key);
    out.blobs = { ok: v === 'ok', ms: Date.now() - t0 };
  } catch (err) {
    out.blobs = { ok: false, ms: Date.now() - t0, error: String((err as Error)?.message || err) };
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
