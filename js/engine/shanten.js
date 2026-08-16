// shanten.js — 向聴数計算 (標準形/七対子/国士の最小値)
// COMの思考と聴牌判定の基盤。counts は 34種カウント(13枚 or 14枚相当)。
// meldCount: 副露数。副露1つにつき完成面子1として扱う。

import { KIND_COUNT, isHonor } from './tiles.js';

export function shanten(counts, meldCount = 0) {
  let best = shantenStandard(counts, meldCount);
  if (meldCount === 0) {
    best = Math.min(best, shantenChiitoi(counts), shantenKokushi(counts));
  }
  return best;
}

export function shantenChiitoi(counts) {
  let pairs = 0, kinds = 0;
  for (let i = 0; i < KIND_COUNT; i++) {
    if (counts[i] >= 2) pairs++;
    if (counts[i] >= 1) kinds++;
  }
  return 6 - pairs + Math.max(0, 7 - kinds);
}

const YAOCHU = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
export function shantenKokushi(counts) {
  let kinds = 0, hasPair = false;
  for (const k of YAOCHU) {
    if (counts[k] >= 1) kinds++;
    if (counts[k] >= 2) hasPair = true;
  }
  return 13 - kinds - (hasPair ? 1 : 0);
}

// 標準形: 面子・搭子を全探索して 8 - 2*面子 - max(搭子+雀頭) を最小化
export function shantenStandard(counts, meldCount = 0) {
  const c = counts.slice();
  let best = 8;
  const needSets = 4 - meldCount;

  // 雀頭候補を先に抜くパターンと抜かないパターン
  const search = (i, sets, partials, hasPair) => {
    while (i < KIND_COUNT && c[i] === 0) i++;
    if (i >= KIND_COUNT) {
      const useSets = Math.min(sets, needSets);
      const usePartials = Math.min(partials, needSets - useSets);
      const s = 8 - 2 * (useSets + meldCount) - usePartials - (hasPair ? 1 : 0);
      best = Math.min(best, s);
      return;
    }
    // 刻子
    if (c[i] >= 3) {
      c[i] -= 3; search(i, sets + 1, partials, hasPair); c[i] += 3;
    }
    // 順子
    if (!isHonor(i) && (i % 9) <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      search(i, sets + 1, partials, hasPair);
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
    // 対子 → 雀頭 or 搭子
    if (c[i] >= 2) {
      c[i] -= 2;
      if (!hasPair) search(i, sets, partials, true);
      search(i, sets, partials + 1, hasPair);
      c[i] += 2;
    }
    // 両面/嵌張搭子
    if (!isHonor(i) && (i % 9) <= 7 && c[i + 1] > 0) {
      c[i]--; c[i + 1]--;
      search(i, sets, partials + 1, hasPair);
      c[i]++; c[i + 1]++;
    }
    if (!isHonor(i) && (i % 9) <= 6 && c[i + 2] > 0) {
      c[i]--; c[i + 2]--;
      search(i, sets, partials + 1, hasPair);
      c[i]++; c[i + 2]++;
    }
    // この牌を孤立牌として捨てる
    const saved = c[i];
    c[i] = 0;
    search(i + 1, sets, partials, hasPair);
    c[i] = saved;
  };
  search(0, 0, 0, false);
  return best;
}

// 聴牌なら待ち牌kindの配列、そうでなければ空配列 (counts=13枚相当)
export function waitingTiles(counts, meldCount = 0) {
  const waits = [];
  for (let k = 0; k < KIND_COUNT; k++) {
    if (counts[k] >= 4) continue;
    counts[k]++;
    // isAgariの代わりにshanten===-1で判定(import循環回避で直接計算)
    if (shanten(counts, meldCount) === -1) waits.push(k);
    counts[k]--;
  }
  return waits;
}
