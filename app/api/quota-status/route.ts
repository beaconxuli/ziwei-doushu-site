import { quotaUsage } from '@/lib/ai/quota';
import { getStore } from '@netlify/blobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 只读诊断：今日额度用量 + 自检写入是否可见（不含密钥与个人信息）。 */
export async function GET() {
  const usage = await quotaUsage();
  let selfTest: Record<string, unknown> = {};
  try {
    const store = getStore({ name: 'ai-quota' });
    const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const before = (await store.list({ prefix: `hit:${day}:` })).blobs.length;
    const key = `hit:${day}:selftest:${Date.now()}`;
    await store.set(key, '1');
    const mid = (await store.list({ prefix: `hit:${day}:` })).blobs.length;
    const all = (await store.list({ prefix: 'hit:' })).blobs.length;
    selfTest = { before, afterWrite: mid, allDays: all, wroteKey: key.split(':').slice(2).join(':') };
  } catch (err) {
    selfTest = { error: String((err as Error)?.message || err) };
  }
  return new Response(
    JSON.stringify(
      {
        limits: {
          daily: process.env.AI_DAILY_LIMIT || '300(default)',
          perIp: process.env.AI_DAILY_PER_IP || '20(default)',
        },
        usage,
        selfTest,
      },
      null,
      2,
    ),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}
