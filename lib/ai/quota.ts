/**
 * AI 调用额度（服务端）。
 *
 * 为什么需要：Netlify Functions 无常驻内存，`rateLimit()` 的进程内计数在
 * serverless 下几乎不生效。这里用 Netlify Blobs 做「按天」持久计数：
 *   - 全局每日上限（默认 300 次），防止整体被刷爆
 *   - 单 IP 每日上限（默认 20 次），防止单个来源把额度吃光
 *
 * 为什么用「追加写 + list 计数」而不是计数器读改写：
 *   实测这个运行时里 `get()` 一个**不存在的键会挂起 30s**（导致 504），
 *   而 `list()` 与 `set()` 都是 30–130ms。所以改成：
 *     每次调用写一个唯一键 hit:<日>:<ip摘要>:<时间戳><随机>，
 *     计数 = list(前缀).blobs.length。
 *   代价是每天多出几百个小键（≤ 全局上限），可接受。
 *
 * 设计原则：额度系统本身**绝不能**阻断正常访问。
 *   - 任何异常（Blobs 未配置/超时/报错）一律 fail-open 放行
 *   - 每次检查都有硬超时（默认 1500ms）
 */
import { getStore } from '@netlify/blobs';

const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 300);
// 单 IP 每日上限：优先读 AI_PER_IP_LIMIT，兼容旧变量名 AI_DAILY_PER_IP
const PER_IP_LIMIT = Number(process.env.AI_PER_IP_LIMIT || process.env.AI_DAILY_PER_IP || 50);
const TIMEOUT_MS = Number(process.env.AI_QUOTA_TIMEOUT_MS || 1500);

/** 本实例发现 Blobs 不可用后就不再尝试 */
let blobsBroken = false;

/** 北京时间当天（UTC+8） */
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
    return await withTimeout(
      (async () => {
        const store = getStore({ name: 'ai-quota' });
        const day = todayKey();
        const mine = `hit:${day}:${ipKey(ip)}:`;

        // 两次 list：全局 + 本 IP（都是小前缀，实测 ~30–130ms）
        const [all, mineList] = await Promise.all([
          store.list({ prefix: `hit:${day}:` }),
          store.list({ prefix: mine }),
        ]);
        const total = all.blobs.length;
        const usedByIp = mineList.blobs.length;

        if (total >= DAILY_LIMIT) return { ok: false as const, reason: 'global' as const, used: total, limit: DAILY_LIMIT };
        if (usedByIp >= PER_IP_LIMIT) return { ok: false as const, reason: 'ip' as const, used: usedByIp, limit: PER_IP_LIMIT };

        // 记一次（唯一键，天然幂等，无并发问题）
        const rand = Math.random().toString(36).slice(2, 8);
        await store.set(`${mine}${Date.now()}-${rand}`, '1');

        return { ok: true as const, used: total + 1, limit: DAILY_LIMIT };
      })(),
      TIMEOUT_MS,
    );
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    console.log('[quota] 放行（' + msg + '）');
    if (msg.includes('timeout')) blobsBroken = true;
    return { ok: true, reason: 'disabled' };
  }
}

/** 只读：今天用了多少（诊断用） */
export async function quotaUsage(): Promise<{ day: string; total: number; ok: boolean; error?: string }> {
  const day = todayKey();
  try {
    const store = getStore({ name: 'ai-quota' });
    const r = await withTimeout(store.list({ prefix: `hit:${day}:` }), TIMEOUT_MS);
    return { day, total: r.blobs.length, ok: true };
  } catch (err) {
    return { day, total: 0, ok: false, error: String((err as Error)?.message || err) };
  }
}

