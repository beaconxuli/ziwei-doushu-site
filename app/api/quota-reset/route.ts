import { getStore } from '@netlify/blobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 管理员重置今日额度（用于测试或临时放开）。
 * 需要请求头 x-quota-admin 与环境变量 QUOTA_ADMIN_TOKEN 一致。
 * 只删当天的 hit 键，不影响其它数据。
 */
export async function POST(req: Request) {
  const expected = process.env.QUOTA_ADMIN_TOKEN;
  if (!expected) {
    return Response.json({ ok: false, error: '未配置 QUOTA_ADMIN_TOKEN' }, { status: 503 });
  }
  const got = req.headers.get('x-quota-admin') || '';
  if (got !== expected) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  try {
    const store = getStore({ name: 'ai-quota' });
    const prefix = `hit:${day}:`;
    const r = await store.list({ prefix });
    const keys = r.blobs.map((b) => b.key);
    for (const k of keys) await store.delete(k);
    return Response.json({ ok: true, day, deleted: keys.length });
  } catch (err) {
    return Response.json({ ok: false, day, error: String((err as Error)?.message || err) }, { status: 500 });
  }
}
