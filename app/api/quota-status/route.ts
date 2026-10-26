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
 * 只读诊断：验证「list 是否能替代 get 判断键是否存在」。
 * 背景：这个运行时里 get 一个不存在的键会挂起（30s），而 set + get 存在的键只要 60ms。
 */
export async function GET() {
  const results = [];
  results.push(await probe('list-empty-prefix', async () => {
    const s = getStore({ name: 'ai-quota', consistency: 'strong' });
    const r = await s.list({ prefix: `zzz-none-${Date.now()}` });
    return { blobs: r.blobs.length };
  }));
  results.push(await probe('list-existing-prefix', async () => {
    const s = getStore({ name: 'ai-quota', consistency: 'strong' });
    const r = await s.list({ prefix: 'probe' });
    return { blobs: r.blobs.length, keys: r.blobs.map((b) => b.key).slice(0, 3) };
  }));
  results.push(await probe('set-only', async () => {
    const s = getStore({ name: 'ai-quota', consistency: 'strong' });
    await s.set(`probe-setonly-${Date.now()}`, '1');
    return 'ok';
  }));
  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
