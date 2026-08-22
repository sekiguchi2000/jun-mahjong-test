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
  // 字牌・么九牌を副露した手はタンヤオ不可能(カルテ23号: 西・東ポン後に
  // 「本線はタンヤオ・ピンフ系」と言った実戦バグ)。基本線は他プランに譲る
  if (melds.length === 0 || meldAllSimple) {
    const tanyaoRatio = total > 0 ? (simpleCount + (meldAllSimple ? melds.length * 3 : 0)) / total : 0;
    // 暗刻が並ぶ牌姿はピンフが死んでいて対子系の手(カルテ27号: 暗刻2つの手で
    // 「本線はタンヤオ・ピンフ系」と言った実戦バグ)。床weightを外して他プランに譲る
    const handCounts = toCounts(handAll);
    const ankoCount = handCounts.filter(count => count >= 3).length;
    const ankoDamp = ankoCount >= 2 ? 0.3 : ankoCount === 1 ? 0.75 : 1;
    const baseWeight = Math.max(ankoCount >= 2 ? 0.05 : 0.35, Math.min(1, tanyaoRatio * 1.15)) * ankoDamp;
    plans.push({
      code: 'TANYAO_PINFU',
      weight: baseWeight,
      value: 1 + 0.3 * redCount,
      notes: redCount > 0 ? ['RED5_IN_HAND'] : [],
    });
  }
  // --- 役牌確定: 役牌のポン/カンが既にある手は役の心配なし=最速でまとめる ---
  const securedYakuhai = melds.some(meld => {
    const kind = meld.tiles?.[0]?.kind;
    return kind !== undefined && (meld.tiles?.length ?? 0) >= 3 &&
      meld.tiles.every(tile => tile.kind === kind) && isValueHonorKind(kind, context);
  });
  if (securedYakuhai) {
    plans.push({ code: 'YAKUHAI_SECURED', weight: 1, value: 1, notes: [] });
  }

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

  // --- トイトイ: ポン系副露があり対子が並ぶ手 (カルテ8号) ---
  const ponMelds = melds.filter(meld =>
    meld?.type === 'pon' || meld?.type === 'minkan' || meld?.kanOrigin).length;
  // 副露が進むほど手中の対子は減るので、ポン数を刻子分として合算して判定する
  // (カルテ23号: 西・1筒・東と3ポンした手でトイトイを見失った)。
  // 門前でも暗刻が2つ並べば対子系(トイトイ・三暗刻筋)を立てる(カルテ27号)
  const ankoKinds = [];
  for (let kind = 0; kind < KIND_COUNT; kind++) {
    if (counts[kind] >= 3) ankoKinds.push(kind);
  }
  const tripletPower = ponMelds + ankoKinds.length;
  if ((ponMelds >= 1 && ponMelds + pairKinds.length >= 4) ||
      (ankoKinds.length >= 2 && pairKinds.length >= 4)) {
    plans.push({
      code: 'TOITOI',
      pairKinds,
      weight: Math.min(1, 0.35 + 0.2 * Math.max(0, tripletPower - 1) + 0.15 * Math.max(0, pairKinds.length - 3)),
      value: 1.5,
      notes: [],
    });
  }

  // --- サワカ特殊プラン (context.specialPlans=true のキャラ専用) ---
  if (context.specialPlans === true) {
    // 国士無双: 么九牌7種以上で一直線
    let yaochuKindCount = 0;
    for (let kind = 0; kind < KIND_COUNT; kind++) {
      if (counts[kind] >= 1 && (isHonor(kind) || isTerminal(kind))) yaochuKindCount++;
    }
    if (melds.length === 0 && yaochuKindCount >= 7) {
      plans.push({ code: 'KOKUSHI', weight: Math.min(1, (yaochuKindCount - 6) / 5), value: 3, notes: [] });
    }
    // 大三元・小三元: 三元牌3種があり、うち2種以上が対子以上
    const dragonKinds = [31, 32, 33].filter(kind => counts[kind] >= 1).length;
    const dragonPairs = [31, 32, 33].filter(kind => counts[kind] >= 2).length;
    if (dragonKinds === 3 && dragonPairs >= 2) {
      plans.push({ code: 'SANGEN', weight: 0.9, value: 2.5, notes: [] });
    }
    // ホンイツ前のめり: 一色+字牌が8枚あれば通常閾値(9枚)を待たずに立てる
    if (flushSize >= 8 && suitCounts[bestSuit] >= 5 && !plans.some(plan => plan.code === 'HONITSU')) {
      plans.push({ code: 'HONITSU', suit: bestSuit, weight: 0.8, value: 1.6, notes: [] });
    }
  }

  // --- 形式テンパイ (2026-08-20ユーザー裁定①): 2副露以上で役の道が細い手は、
  // 流局時のテンパイ料を目標に切り替える。タンヤオ遠い(么九・字が2枚以上 or
  // 么九副露)・役牌の当てなし・染め/トイトイ/チャンタなし、が条件 ---
  if (melds.length >= 2) {
    const hasYakuRoute = plans.some(plan =>
      ['YAKUHAI_SECURED', 'YAKUHAI_PAIR', 'TOITOI', 'HONITSU', 'CHANTA', 'CHIITOI'].includes(plan.code));
    const nonSimpleInHand = handAll.filter(tile =>
      isHonor(tile.kind) || isTerminal(tile.kind)).length;
    const tanyaoFar = !meldAllSimple || nonSimpleInHand >= 2;
    if (!hasYakuRoute && tanyaoFar) {
      plans.push({ code: 'FORMAL_TENPAI', weight: 0.9, value: 0.6, notes: [] });
      // タンヤオはまだ理論上可能でも遠い(么九2枚以上の置き換えが必要)。
      // 本線の座は形テンに譲る
      const tanyaoPlan = plans.find(plan => plan.code === 'TANYAO_PINFU');
      if (tanyaoPlan) tanyaoPlan.weight *= 0.4;
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
  // 両面(端を含まない隣接ターツ)。辺張は最後に回す:
  // 1-2-4のような形では1-2ペンチャンを先に取ると2-4嵌張(5引きで両面へ育つ)を殺すため
  for (let kind = 0; kind < KIND_COUNT - 1; kind++) {
    if (isHonor(kind) || suitIndex(kind) !== suitIndex(kind + 1)) continue;
    if (numOf(kind) === 1 || numOf(kind + 1) === 9) continue;
    while (work[kind] >= 1 && work[kind + 1] >= 1) {
      work[kind]--; work[kind + 1]--;
      blocks.push({ type: 'taatsu', kinds: [kind, kind + 1], quality: 0.9 });
    }
  }
  // 対子(1組目=雀頭候補0.8、2組目以降0.5、役の無い字牌対子0.35)。
  // 嵌張より先に取る: 2244mは嵌張2つでなく対子2つ(雀頭+シャンポン受け)と見るのが自然
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
  // リャンカン(x, x+2, x+4): 嵌張2つ分の受け(両方の間の牌)を持つ一つの形として扱う
  for (let kind = 0; kind < KIND_COUNT - 4; kind++) {
    if (isHonor(kind) || suitIndex(kind) !== suitIndex(kind + 4)) continue;
    while (work[kind] >= 1 && work[kind + 2] >= 1 && work[kind + 4] >= 1) {
      work[kind]--; work[kind + 2]--; work[kind + 4]--;
      blocks.push({ type: 'ryankan', kinds: [kind, kind + 2, kind + 4], quality: 0.85 });
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
  // 辺張(1-2 / 8-9)。行き止まり形なので品質は最低ランク
  for (let kind = 0; kind < KIND_COUNT - 1; kind++) {
    if (isHonor(kind) || suitIndex(kind) !== suitIndex(kind + 1)) continue;
    if (numOf(kind) !== 1 && numOf(kind + 1) !== 9) continue;
    while (work[kind] >= 1 && work[kind + 1] >= 1) {
      work[kind]--; work[kind + 1]--;
      blocks.push({ type: 'taatsu', kinds: [kind, kind + 1], quality: 0.55 });
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
    case 'TOITOI':
      return counts[kind] >= 2 ? { support: 0.9, notes: [] } : { support: 0, notes: [] };
    case 'KOKUSHI':
      if (isHonor(kind) || isTerminal(kind)) {
        return { support: counts[kind] >= 2 ? 1.3 : 1.1, notes: [] };
      }
      return { support: 0, notes: [] };
    case 'SANGEN': {
      if (kind >= 31) return { support: 1.3, notes: [] };
      if (isHonor(kind)) return { support: 0.2, notes: [] };
      return { support: simpleTileSupport(kind) * 0.5, notes: [] };
    }
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
  // 余剰コピーは骨ではない: 手中の枚数がブロックで使う枚数を上回るなら、
  // その1枚を切ってもブロックは崩れない(123m+1mの4枚目の1m等。カルテ17号)
  const usedCopies = chosen.reduce((sum, block) =>
    sum + block.kinds.filter(value => value === kind).length, 0);
  const spareCopy = counts[kind] > usedCopies;
  let blockQuality = 0;
  for (const block of chosen) {
    if (!spareCopy && block.kinds.includes(kind)) blockQuality = Math.max(blockQuality, block.quality);
  }
  if (blockQuality > 0) {
    // 完成した面子(暗刻・順子)の構成牌は原則不可侵。ターツ・雀頭はやや弱い保護
    const completeSet = chosen.some(block =>
      (block.type === 'set' || block.type === 'run') && block.kinds.includes(kind));
    // 両面等の質の高いターツは、対子過多手のチートイ混じり受け入れ数に負けて
    // 壊されない程度に保護する(カルテ17号: 67pを切って対子4組へ倒れた)
    retention += completeSet ? 1.7 : blockQuality * 1.3;
    if (completeSet || blockQuality >= 0.9) notes.add('BLOCK_CORE');
  }

  // --- 孤立数牌の内在価値 (カルテ34号) ---
  // 浮き数牌はターツ化・タンヤオ/ピンフの種として孤立字牌より価値が高い(5>46>37>28>19)。
  // これが無いと浮き7mの残留価値0が孤立役牌0.15に負け、「字牌を残して数牌から切る」
  // 不自然な序盤打牌になる(実戦検品2026-08-22)。ブロック構成牌には適用しない(骨は別枠)。
  if (!isHonor(kind) && counts[kind] === 1 && blockQuality === 0) {
    const centrality = 4 - Math.abs(numOf(kind) - 5);          // 5=4, 46=3, 37=2, 28=1, 19=0
    const isolatedValue = [0.1, 0.25, 0.35, 0.45, 0.5][centrality];
    retention = Math.max(retention, isolatedValue);
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

  // 赤牌そのものは常に高価値(確定1翻)。形の価値に上乗せし、受け入れ数枚差で手放さない
  if (tile.red) {
    retention = Math.max(retention + 0.6, 1.7);
    notes.add('RED_TILE');
  }

  const topPlans = [...plans]
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .slice(0, 2)
    .map(plan => ({ code: plan.code, weight: plan.weight, value: plan.value }));

  return { retention, notes: [...notes].sort(), topPlans };
}
