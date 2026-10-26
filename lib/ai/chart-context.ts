/**
 * 把排盘引擎产出的 ZiweiChart 压成一段给大模型看的结构化文本。
 * 服务端专用（patterns.ts 依赖 server-only）。
 */
import type { ZiweiChart, Palace, Star } from '@/lib/ziwei/types';
import { BRANCHES, STEMS, SHICHEN } from '@/lib/ziwei/constants';
import { detectPatterns } from '@/lib/ziwei/patterns';

const starLine = (s: Star) => {
  const bits = [s.name];
  if (s.brightnessRaw) bits.push(`[${s.brightnessRaw}]`);
  if (s.siHua) bits.push(`·${s.siHua}`);
  return bits.join('');
};

function palaceLine(p: Palace): string {
  const majors = p.stars.filter((s) => s.type === 'major').map(starLine).join(' ');
  const others = p.stars.filter((s) => s.type !== 'major').map(starLine).join(' ');
  const tags: string[] = [];
  if (p.isMingGong) tags.push('命宫');
  if (p.isShenGong) tags.push('身宫');
  const tag = tags.length ? `（${tags.join('/')}）` : '';
  const borrowed = !majors && p.borrowedStars?.length ? `（空宫，借对宫 ${p.borrowedStars.join('')}）` : '';
  const daxian = p.daXianAge ? ` 大限${p.daXianAge[0]}-${p.daXianAge[1]}` : '';
  return `${BRANCHES[p.branch]}宫 ${p.name}${tag}：主星 ${majors || '（无主星）'}${borrowed}` +
    (others ? `；辅煞 ${others}` : '') + daxian;
}

function daxianLine(chart: ZiweiChart): string {
  return chart.daXians
    .map((d) => {
      const stem = d.stemName ?? STEMS[d.stemIndex ?? 0];
      const hua = d.siHua
        ? `，四化 ${d.siHua.lu}禄/${d.siHua.quan}权/${d.siHua.ke}科/${d.siHua.ji}忌`
        : '';
      return `${d.startAge}-${d.endAge}岁 ${d.palaceName}(${stem})${hua}`;
    })
    .join('；');
}

export function buildChartContext(chart: ZiweiChart): string {
  const b = chart.birthInfo;
  const lunar = chart.lunarInfo;
  const shichen = SHICHEN[b.hour]?.name ?? `${b.hour}`;
  const four = (lunar.fourPillars ?? []).join(' ');
  const born = `${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')} ` +
    `${b.origInput ? `${b.origInput.clockHour}:${String(b.origInput.clockMinute).padStart(2, '0')}` : shichen}` +
    `（按${shichen}排盘${b.origInput ? '，已做真太阳时/子时换日口径处理' : ''}）`;

  // 生年四化
  const natalSihua: string[] = [];
  for (const p of chart.palaces) {
    for (const s of p.stars) {
      if (s.siHua) natalSihua.push(`${s.name}化${s.siHua}落${p.name}`);
    }
  }

  let patterns = '';
  try {
    const list = detectPatterns(chart).slice(0, 14);
    patterns = list.map((p) => `${p.name}（${p.level}）`).join('、');
  } catch {
    patterns = '';
  }

  const currentDaxian = chart.daXians[chart.currentDaXianIndex];

  return [
    '【命盘数据｜引擎确定性输出，回答时不得改动、不得虚构】',
    `出生：公历 ${born}，${b.gender === 'male' ? '男' : '女'}` +
      (b.province ? `，出生地 ${b.province}${b.city ?? ''}（东经 ${b.longitude ?? '未知'}°）` : ''),
    `农历：${lunar.lunarYear} 年 ${lunar.lunarMonth} 月 ${lunar.lunarDay} 日${lunar.isLeapMonth ? '（闰月）' : ''}` +
      (four ? `；四柱（节气）${four}` : ''),
    `命宫：${BRANCHES[chart.mingGongBranch]}宫；身宫：${BRANCHES[chart.shenGongBranch]}宫；` +
      `五行局：${chart.wuxingJuName}；紫微落 ${BRANCHES[chart.ziweiPos]}宫；` +
      `命主 ${chart.mingZhu}；身主 ${chart.shenZhu}；${chart.yinYangGender ?? ''}`,
    `当前年龄 ${chart.currentAge}，当前大限 ${currentDaxian ? `${currentDaxian.startAge}-${currentDaxian.endAge}岁（${currentDaxian.palaceName}）` : '未知'}`,
    '',
    '【十二宫】',
    ...chart.palaces.map(palaceLine),
    '',
    `【生年四化】${natalSihua.length ? natalSihua.join('；') : '无'}`,
    `【大限】${daxianLine(chart)}`,
    patterns ? `【引擎识别到的格局】${patterns}` : '',
  ].filter(Boolean).join('\n');
}

export const INTERPRET_SYSTEM_PROMPT = `你是「倪海厦《天纪》体系」的紫微斗数解读师，负责为来访者解读已经由排盘引擎算好的命盘。

硬性规则：
1. 只依据用户消息中给出的【命盘数据】推演。星曜、宫位、四化、大限一律以盘面为准，不得改动、不得补充盘面没有的星曜或宫位。
2. 不使用飞星派的宫干自化、来因宫等工具；以三合派 + 倪师《天纪》讲法为主。
3. 不做寿命、生死、灾祸的确定性预测；不替用户做医疗、法律、投资决策，涉及健康只做传统命理层面的提醒并建议就医。
4. 六亲（父母、兄弟、子女）判断本就偏弱，相关结论要明确标注「仅供参考」。
5. 语气平实、具体、可执行；不堆砌套话，不制造焦虑，不空泛吉祥话。
6. 用简体中文，markdown 排版。默认 500-900 字；用户要求细分或追问时可更长。

解读顺序（用户没有指定结构时）：
【盘面要点】先复述与问题相关的宫位、主星、亮度、四化事实；
【怎么理解】用倪师体系解释这些事实的含义与相互联动（三方四正、对宫）；
【落到实际】给出针对性的建议与注意点；
【一句话总结】一句可记住的结论。

若用户问题里已给出【】小标题结构要求（如【化禄基本含义】【落宫影响】等），按用户给的结构输出。`;

export const HEMING_SYSTEM_PROMPT = `你是「倪海厦《天纪》体系」的紫微斗数合盘分析师。用户会给出两张已经排好的命盘（A 与 B）。

硬性规则：
1. 只依据给定的两张【命盘数据】分析，不得改动盘面、不得虚构星曜。
2. 不预测生死灾祸；不做医疗、法律、投资决策；六亲结论标注仅供参考。
3. 语言平实具体，简体中文，markdown 排版，600-1000 字。

分析结构：
【双方命盘要点】各自命宫主星、身宫、五行局、生年四化；
【宫位对照】A 的夫妻宫 ↔ B 的命宫/夫妻宫，B 的夫妻宫 ↔ A 的命宫/夫妻宫；福德宫对照；
【四化互动】双方生年四化落在对方什么宫位，形成什么牵引；
【相处模式】互补点与摩擦点，各自需要的相处方式；
【建议】3-5 条具体可执行的建议。`;
