// hand-plans.js — アガリ形プラン評価層 (AI_DESIGN_V12 第1段)
//
// 手牌(本人のみ)+公開情報から「狙えるアガリ形プラン」を列挙し、
// 各牌の「手に残す価値(retention)」を返す。decision-evaluatorの
// utilityAdjustmentsへ合流し、受け入れ枚数だけでは決まらない
// 打牌方針(タンヤオピンフ基本線・孤立役牌の見切り等)を与える。
//
// 決定性: 入力が同じなら出力は同一。乱数・時刻・非公開情報は使わない。

import {
  isDragon,
  isHonor,
  isTerminal,
  numOf,
  suitOf,
  toCounts,
  KIND_COUNT,
} from './tiles.js';

export const PLAN_SCALE = 2.0;

const SUIT_LETTERS = ['m', 'p', 's'];
function suitIndex(kind) {
  return SUIT_LETTERS.indexOf(suitOf(kind)); // 字牌は-1
}

function isValueHonorKind(kind, context) {
  return isHonor(kind) && (isDragon(kind) || kind === context.seatWind || kind === context.roundWind);
}

function isDoubleWindKind(kind, context) {
  return kind === context.seatWind && kind === context.roundWind;
}

// 数牌のタンヤオ・赤5連結support。5に近いほど高い(4,5,6が最良帯)。
function simpleTileSupport(kind) {
  if (isHonor(kind)) return 0;
  const distance = Math.abs(numOf(kind) - 5);
  return Math.max(0, 1 - 0.18 * distance);
}

/**
 * プラン列挙。handAll = {kind, red}[] (打牌前の全持ち牌)、melds = 自分の副露。
 * context = { seatWind, roundWind, doraKinds:[kind...], phase:'early'|'middle'|'late' }
 */
export function evaluateHandPlans(handAll, melds = [], context = {}) {
  const counts = toCounts(handAll);
  const total = handAll.length + melds.length * 3;
  const plans = [];

  // --- 基本線: 面前タンヤオ・ピンフ(3900+狙い)。常に最低weightを持つ ---
  let simpleCount = 0;
  let redCount = 0;
  for (const tile of handAll) {
    if (!isHonor(tile.kind) && !isTerminal(tile.kind)) simpleCount++;
    if (tile.red) redCount++;
  }
  const meldAllSimple = melds.every(meld =>
    (meld.tiles ?? []).every(tile => !isHonor(tile.kind) && !isTerminal(tile.kind)));
  const tanyaoRatio = total > 0 ? (simpleCount + (meldAllSimple ? melds.length * 3 : 0)) / total : 0;
  plans.push({
    code: 'TANYAO_PINFU',
    weight: Math.max(0.35, Math.min(1, tanyaoRatio * 1.15)),
    value: 1 + 0.3 * redCount,
    notes: redCount > 0 ? ['RED5_IN_HAND'] : [],
  });

  // --- 役牌: 対子以上のときだけ速度プランとして立てる ---
  for (let kind = 27; kind < KIND_COUNT; kind++) {
    if (!isValueHonorKind(kind, context)) continue;
    if (counts[kind] >= 2) {
      plans.push({ code: 'YAKUHAI_PAIR', kind, weight: 0.85, value: 0.8, notes: [] });
    }
  }

  // --- ホンイツ: 最多色+字牌が9枚以上で立ち上げ ---
  const suitCounts = [0, 0, 0];
  let honorCount = 0;
  for (const tile of handAll) {
    if (isHonor(tile.kind)) honorCount++;
    else suitCounts[suitIndex(tile.kind)]++;
  }
  for (const meld of melds) {
    const kind = meld.tiles?.[0]?.kind;
    if (kind === undefined) continue;
    if (isHonor(kind)) honorCount += 3;
    else suitCounts[suitIndex(kind)] += 3;
  }
  const bestSuit = suitCounts.indexOf(Math.max(...suitCounts));
  const flushSize = suitCounts[bestSuit] + honorCount;
  if (flushSize >= 9 && suitCounts[bestSuit] >= 6) {
    plans.push({
      code: 'HONITSU',
      suit: bestSuit,
      weight: Math.min(1, (flushSize - 8) / 4),
      value: 1.6,
      notes: [],
    });
  }

  // --- チャンタ: 么九牌を含みうるブロック比率で立ち上げ ---
  let yaochuBlocks = 0;
  for (let kind = 0; kind < KIND_COUNT; kind++) {
    if (counts[kind] === 0) continue;
    if (isHonor(kind) || isTerminal(kind)) yaochuBlocks += counts[kind];
    else if (numOf(kind) === 2 || numOf(kind) === 8) yaochuBlocks += counts[kind] * 0.5;
  }
  if (yaochuBlocks >= 8) {
    plans.push({
      code: 'CHANTA',
      weight: Math.min(1, (yaochuBlocks - 7) / 5),
      value: 1.4,
      notes: [],
    });
  }

  // --- 七対子: 対子4組以上で立ち上げ。完成面子があるほど現実味が薄れるため減衰 ---
  const pairKinds = [];
  for (let kind = 0; kind < KIND_COUNT; kind++) {
    if (counts[kind] >= 2) pairKinds.push(kind);
  }
  if (melds.length === 0 && pairKinds.length >= 4) {
    const { runCount } = decomposeBlocks(handAll, context);
    const weight = Math.min(1, (pairKinds.length - 3) / 3) * Math.max(0, 1 - 0.5 * runCount);
    if (weight >= 0.2) {
      plans.push({ code: 'CHIITOI', pairKinds, weight, value: 1.3, notes: [] });
    }
  }

  return plans;
}

// ---- ブロック分解 (v12.1: 5ブロックの骨組みを認識する) ----
// 決定的な貪欲分解: 完成面子 → 両面/辺張 → 嵌張 → 対子。
// 品質: 完成1.0 / 両面0.9 / 嵌張・辺張0.7 / 対子(1組目)0.8 / 対子(2組目)0.5 / 役無し字牌対子0.35。
// 品質0.5以上の上位5ブロックを「骨組み」とし、構成牌の残留価値を引き上げる。
export function decomposeBlocks(handAll, context = {}) {
  const counts = toCounts(handAll);
  const work = counts.slice();
  const blocks = [];

  // 完成面子(刻子優先→順子)
  for (let kind = 0; kind < KIND_COUNT; kind++) {
    while (work[kind] >= 3) {
      work[kind] -= 3;
      blocks.push({ type: 'set', kinds: [kind, kind, kind], quality: 1.0 });
    }
  }
  for (let kind = 0; kind < KIND_COUNT - 2; kind++) {
    if (isHonor(kind) || suitIndex(kind) !== suitIndex(kind + 2)) continue;
    while (work[kind] >= 1 && work[kind + 1] >= 1 && work[kind + 2] >= 1) {
      work[kind]--; work[kind + 1]--; work[kind + 2]--;
      blocks.push({ type: 'run', kinds: [kind, kind + 1, kind + 2], quality: 1.0 });
    }
  }
  // 両面・辺張(隣接ターツ)
  for (let kind = 0; kind < KIND_COUNT - 1; kind++) {
    if (isHonor(kind) || suitIndex(kind) !== suitIndex(kind + 1)) continue;
    while (work[kind] >= 1 && work[kind + 1] >= 1) {
      work[kind]--; work[kind + 1]--;
      const edge = numOf(kind) === 1 || numOf(kind + 1) === 9;
      blocks.push({ type: 'taatsu', kinds: [kind, kind + 1], quality: edge ? 0.7 : 0.9 });
    }
  }
  // 嵌張
  for (let kind = 0; kind < KIND_COUNT - 2; kind++) {
    if (isHonor(kind) || suitIndex(kind) !== suitIndex(kind + 2)) continue;
    while (work[kind] >= 1 && work[kind + 2] >= 1) {
      work[kind]--; work[kind + 2]--;
      blocks.push({ type: 'kanchan', kinds: [kind, kind + 2], quality: 0.7 });
    }
  }
  // 対子(1組目=雀頭候補0.8、2組目以降0.5、役の無い字牌対子0.35)
  let pairRank = 0;
  for (let kind = 0; kind < KIND_COUNT; kind++) {
    if (work[kind] >= 2) {
      work[kind] -= 2;
      let quality;
      if (isHonor(kind) && !isValueHonorKind(kind, context)) quality = 0.35;
      else quality = pairRank === 0 ? 0.8 : 0.5;
      pairRank++;
      blocks.push({ type: 'pair', kinds: [kind, kind], quality });
    }
  }

  const chosen = blocks
    .filter(block => block.quality >= 0.5)
    .sort((a, b) => b.quality - a.quality)
    .slice(0, 5);
  const runCount = blocks.filter(block => block.type === 'run' || block.type === 'set').length;
  return { blocks, chosen, runCount };
}

function planSupportForTile(plan, tile, counts, context) {
  const kind = tile.kind;
  switch (plan.code) {
    case 'TANYAO_PINFU': {
      if (isHonor(kind)) return { support: 0, notes: [] };
      let support = simpleTileSupport(kind);
      const notes = [];
      if (isTerminal(kind)) support = 0.1;
      // 赤5連結: 同色の5に隣接する4/6(と5自身)は赤との連結価値を上乗せ
      const n = numOf(kind);
      if (n >= 4 && n <= 6) {
        support += 0.15;
        notes.push('RED5_LINK');
      }
      // ドラ牌・ドラ隣接
      if (context.doraKinds?.includes(kind)) support += 0.4;
      return { support: Math.min(1.3, support), notes };
    }
    case 'YAKUHAI_PAIR':
      return kind === plan.kind ? { support: 1, notes: [] } : { support: 0, notes: [] };
    case 'HONITSU': {
      if (isHonor(kind)) return { support: 0.9, notes: [] };
      return suitIndex(kind) === plan.suit ? { support: 0.9, notes: [] } : { support: 0, notes: [] };
    }
    case 'CHANTA':
      if (isHonor(kind) || isTerminal(kind)) return { support: 0.9, notes: [] };
      if (numOf(kind) === 2 || numOf(kind) === 8) return { support: 0.45, notes: [] };
      return { support: 0, notes: [] };
    case 'CHIITOI':
      return counts[kind] >= 2 ? { support: 0.8, notes: [] } : { support: 0, notes: [] };
    default:
      return { support: 0, notes: [] };
  }
}

/**
 * 牌を手に残す価値(0..~2)。高いほど「切ると損」。
 * 返り値: { retention, notes[], topPlans[] }
 */
export function tileRetentionValue(tile, plans, handAll, context = {}) {
  const counts = toCounts(handAll);
  const kind = tile.kind;
  const notes = new Set();
  let best = 0;
  let second = 0;

  for (const plan of plans) {
    const { support, notes: supportNotes } = planSupportForTile(plan, tile, counts, context);
    const contribution = plan.weight * plan.value * support;
    if (contribution > best) { second = best; best = contribution; }
    else if (contribution > second) { second = contribution; }
    if (contribution > 0.2) supportNotes.forEach(note => notes.add(note));
  }

  let retention = best + second * 0.35;

  // ブロック骨組みボーナス (v12.1): 選ばれた5ブロックの構成牌は「手の骨」。
  // 受け入れ枚数の揺れで両面ターツ等が壊されるのを防ぐ。
  const { chosen } = decomposeBlocks(handAll, context);
  let blockQuality = 0;
  for (const block of chosen) {
    if (block.kinds.includes(kind)) blockQuality = Math.max(blockQuality, block.quality);
  }
  if (blockQuality > 0) {
    retention += blockQuality * 0.9;
    if (blockQuality >= 0.9) notes.add('BLOCK_CORE');
  }

  // --- 孤立役牌の見切り(カルテ2号) ---
  // 対子未満の役牌は、基本線では後追いしない。例外だけ引き上げる。
  if (isHonor(kind) && counts[kind] === 1) {
    let loneValue = isValueHonorKind(kind, context) ? 0.15 : 0.05;
    if (isDoubleWindKind(kind, context)) {
      // ダブ風は1枚でも「しばらく持つ」(ユーザー指定)。浮き数牌の残留価値より高くする
      loneValue = Math.max(loneValue, 1.1);
      notes.add('DOUBLE_WIND_KEEP');
    }
    if (context.doraKinds?.includes(kind)) {
      loneValue += 0.5;
      notes.add('DORA_HONOR_KEEP');
    }
    // HONITSU/CHANTAが立っていればプラン側supportが既にbestへ入っている
    retention = Math.max(retention, loneValue);
    const planKeep = plans.some(plan =>
      (plan.code === 'HONITSU' || plan.code === 'CHANTA') && plan.weight > 0.25);
    if (!planKeep && !isDoubleWindKind(kind, context) && !context.doraKinds?.includes(kind)) {
      retention = Math.min(retention, loneValue);
      if (isValueHonorKind(kind, context) && context.phase !== 'late') {
        notes.add('LONE_YAKUHAI_EARLY_CUT');
      }
    }
  }

  // 赤牌そのものは常に高価値
  if (tile.red) {
    retention = Math.max(retention, 1.2);
    notes.add('RED_TILE');
  }

  const topPlans = [...plans]
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .slice(0, 2)
    .map(plan => ({ code: plan.code, weight: plan.weight, value: plan.value }));

  return { retention, notes: [...notes].sort(), topPlans };
}
