import { quotaUsage } from '@/lib/ai/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 只读：今日额度用量（不含密钥与个人信息）。 */
export async function GET() {
  const usage = await quotaUsage();
  return new Response(
    JSON.stringify(
      {
        limits: {
          daily: process.env.AI_DAILY_LIMIT || '300(default)',
          perIp: process.env.AI_DAILY_PER_IP || '20(default)',
        },
        usage,
      },
      null,
      2,
    ),
    { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}
