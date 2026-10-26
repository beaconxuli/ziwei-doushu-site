/**
 * AI 调用额度（服务端）。
 *
 * 为什么需要：Netlify Functions 无常驻内存，`rateLimit()` 的进程内计数在
 * serverless 下几乎不生效。这里用 Netlify Blobs 做「按天」持久计数：
 *   - 全局每日上限（默认 300 次），防止整体被刷爆
 *   - 单 IP 每日上限（默认 20 次），防止单个来源把额度吃光
 *
 * 设计原则：额度系统本身**绝不能**阻断正常访问。
 *   - 任何异常（Blobs 未配置/超时/报错）一律 fail-open 放行
 *   - 每次检查都有硬超时（默认 1200ms），绝不拖慢 SSE 首字节
 *   - 一旦发现 Blobs 不可用，本实例内直接跳过后续检查
 */
import { getStore } from '@netlify/blobs';

const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 300);
const PER_IP_LIMIT = Number(process.env.AI_DAILY_PER_IP || 20);
const TIMEOUT_MS = Number(process.env.AI_QUOTA_TIMEOUT_MS || 1200);

/** 本实例发现 Blobs 不可用后就不再尝试 */
let blobsBroken = false;

/** 北京时间当天（UTC+8），用于按天分桶 */
function todayKey(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function ipKey(ip: string): string {
  let h = 2166136261;
  for (let i = 0; i < ip.length; i++) {
    h ^= ip.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('quota-timeout')), ms)),
  ]);
}

export interface QuotaResult {
  ok: boolean;
  reason?: 'global' | 'ip' | 'disabled';
  used?: number;
  limit?: number;
}

export async function consumeQuota(ip: string): Promise<QuotaResult> {
  if (!Number.isFinite(DAILY_LIMIT) || DAILY_LIMIT <= 0) return { ok: true, reason: 'disabled' };
  if (blobsBroken) return { ok: true, reason: 'disabled' };

  try {
    const result = await withTimeout(
      (async () => {
        const store = getStore({ name: 'ai-quota', consistency: 'strong' });
        const day = todayKey();

        const totalKey = `total:${day}`;
        const total = Number((await store.get(totalKey)) || 0);
        if (total >= DAILY_LIMIT) return { ok: false as const, reason: 'global' as const, used: total, limit: DAILY_LIMIT };

        const key = `ip:${day}:${ipKey(ip)}`;
        const used = Number((await store.get(key)) || 0);
        if (used >= PER_IP_LIMIT) return { ok: false as const, reason: 'ip' as const, used, limit: PER_IP_LIMIT };

        // 读改写：并发下会有少量误差，接受（额度只需要近似）
        await store.set(key, String(used + 1));
        await store.set(totalKey, String(total + 1));

        return { ok: true as const, used: total + 1, limit: DAILY_LIMIT };
      })(),
      TIMEOUT_MS,
    );
    return result;
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    console.log('[quota] 放行（' + msg + '）');
    // 超时或配置缺失：本实例后续直接跳过，避免每次请求都卡
    blobsBroken = true;
    return { ok: true, reason: 'disabled' };
  }
}
