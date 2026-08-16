// agari.js — 和了形判定と面子分解
// counts: 34種カウント配列(手牌14枚ぶん、副露は含めない)

import { KIND_COUNT, isHonor } from './tiles.js';

// --- 標準形(4面子1雀頭)の判定と全分解列挙 ---
// 分解結果: { pair: kind, sets: [{type:'shuntsu'|'kotsu', tile:kind}, ...] }
// ※副露ぶんの面子は呼び出し側が sets に足す

export function decompose(counts) {
  const results = [];
  const c = counts.slice();
  const total = c.reduce((a, b) => a + b, 0);
  if (total % 3 !== 2) return results;
  const needSets = (total - 2) / 3;

  for (let pair = 0; pair < KIND_COUNT; pair++) {
    if (c[pair] < 2) continue;
    c[pair] -= 2;
    const sets = [];
    if (searchSets(c, 0, sets, needSets, results, pair)) { /* results updated in place */ }
    c[pair] += 2;
  }
  return results;
}

function searchSets(c, start, sets, needSets, results, pair) {
  if (sets.length === needSets) {
    // 全部使い切ったか確認
    for (let i = 0; i < KIND_COUNT; i++) if (c[i] > 0) return false;
    results.push({ pair, sets: sets.slice() });
    return true;
  }
  let i = start;
  while (i < KIND_COUNT && c[i] === 0) i++;
  if (i >= KIND_COUNT) return false;

  let found = false;
  // 刻子
  if (c[i] >= 3) {
    c[i] -= 3;
    sets.push({ type: 'kotsu', tile: i, open: false });
    if (searchSets(c, i, sets, needSets, results, pair)) found = true;
    sets.pop();
    c[i] += 3;
  }
  // 順子 (数牌のみ、7,8,9始まりの範囲チェック)
  if (!isHonor(i) && (i % 9) <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    sets.push({ type: 'shuntsu', tile: i, open: false });
    if (searchSets(c, i, sets, needSets, results, pair)) found = true;
    sets.pop();
    c[i]++; c[i + 1]++; c[i + 2]++;
  }
  return found;
}

// --- 七対子 ---
export function isChiitoi(counts) {
  let pairs = 0;
  for (let i = 0; i < KIND_COUNT; i++) {
    if (counts[i] === 2) pairs++;
    else if (counts[i] !== 0) return false; // 同種4枚(2対子扱い)は不可
  }
  return pairs === 7;
}

// --- 国士無双 ---
const YAOCHU = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
export function isKokushi(counts) {
  let hasPair = false;
  let total = 0;
  for (const k of YAOCHU) {
    if (counts[k] === 0) return false;
    if (counts[k] === 2) hasPair = true;
    total += counts[k];
  }
  return hasPair && total === 14;
}

// 和了形か(標準形/七対子/国士のいずれか)。counts は門前部分14枚相当。
// meldCount: 副露数(標準形の必要面子数が減る)
export function isAgari(counts, meldCount = 0) {
  if (meldCount === 0 && (isChiitoi(counts) || isKokushi(counts))) return true;
  return decompose(counts).length > 0;
}
