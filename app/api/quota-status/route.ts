import { getStore } from '@netlify/blobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function probe(name: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    const v = await withTimeout(fn(), 3000);
    return { name, ok: true, ms: Date.now() - t0, value: v };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - t0, error: String((err as Error)?.message || err) };
  }
}

/**
 * 只读诊断：Blobs 各调用路径的耗时（不含密钥）。
 * 用来判断额度计数能不能安全地用 Blobs 实现。
 */
export async function GET() {
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const results = [];
  results.push(await probe('default.get-missing', async () => {
    const s = getStore({ name: 'ai-quota' });
    return await s.get(`probe-missing-${Date.now()}`, { type: 'text' });
  }));
  results.push(await probe('strong.get-missing', async () => {
    const s = getStore({ name: 'ai-quota', consistency: 'strong' });
    return await s.get(`probe-missing-${Date.now()}`, { type: 'text' });
  }));
  results.push(await probe('strong.set+get', async () => {
    const s = getStore({ name: 'ai-quota', consistency: 'strong' });
    const k = `probe-${Date.now()}`;
    await s.set(k, 'ok');
    return await s.get(k, { type: 'text' });
  }));
  results.push(await probe('strong.get-total', async () => {
    const s = getStore({ name: 'ai-quota', consistency: 'strong' });
    return await s.get(`total:${day}`, { type: 'text' });
  }));

  return new Response(JSON.stringify({ day, hasBlobsContext: Boolean(process.env.NETLIFY_BLOBS_CONTEXT), results }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
