/**
 * AI 调用额度（服务端）。
 *
 * 为什么需要：Netlify Functions 无常驻内存，`rateLimit()` 的进程内计数在
 * serverless 下几乎不生效。这里用 Netlify Blobs 做「按天」持久计数：
 *   - 全局每日上限（默认 300 次），防止整体被刷爆
 *   - 单 IP 每日上限（默认 20 次），防止单个来源把额度吃光
 *
 * 设计原则：额度系统本身**绝不能**阻断正常访问——Blobs 不可用、超时、
 * 未配置时一律放行（fail-open），只记日志。
 */
import { getStore } from '@netlify/blobs';

const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 300);
const PER_IP_LIMIT = Number(process.env.AI_DAILY_PER_IP || 20);

/** 北京时间当天（UTC+8），用于按天分桶 */
function todayKey(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function ipKey(ip: string): string {
  // 不需要可逆，做个简单摘要避免把原始 IP 写进存储键
  let h = 2166136261;
  for (let i = 0; i < ip.length; i++) {
    h ^= ip.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export interface QuotaResult {
  ok: boolean;
  reason?: 'global' | 'ip' | 'disabled';
  used?: number;
  limit?: number;
}

export async function consumeQuota(ip: string): Promise<QuotaResult> {
  if (!Number.isFinite(DAILY_LIMIT) || DAILY_LIMIT <= 0) return { ok: true, reason: 'disabled' };

  try {
    const store = getStore({ name: 'ai-quota', consistency: 'strong' });
    const day = todayKey();

    const totalKey = `total:${day}`;
    const total = Number((await store.get(totalKey)) || 0);
    if (total >= DAILY_LIMIT) return { ok: false, reason: 'global', used: total, limit: DAILY_LIMIT };

    const key = `ip:${day}:${ipKey(ip)}`;
    const used = Number((await store.get(key)) || 0);
    if (used >= PER_IP_LIMIT) return { ok: false, reason: 'ip', used, limit: PER_IP_LIMIT };

    // 先写单 IP（读改写），再累加全局；并发下会有少量误差，接受
    await store.set(key, String(used + 1), { metadata: { day } });
    await store.set(totalKey, String(total + 1), { metadata: { day } });

    return { ok: true, used: total + 1, limit: DAILY_LIMIT };
  } catch (err) {
    console.log('[quota] Blobs 不可用，放行：' + String((err as Error)?.message || err));
    return { ok: true, reason: 'disabled' };
  }
}
