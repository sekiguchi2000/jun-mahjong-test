// wall.js — 山の生成とシャッフル
// 「牌操作なし」の心臓部。シャッフルは暗号学的乱数(crypto)による
// Fisher-Yates のみ。配牌・ツモを操作するコードはこのプロジェクトに存在しない。

import { KIND_COUNT } from './tiles.js';

// 0 <= n < max の一様乱数 (crypto、モジュロバイアス除去済み)
export function cryptoRandInt(max) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}

export function shuffle(arr, randInt = cryptoRandInt) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 136枚の山を生成してシャッフル。rules.akaDora に応じて赤5を混ぜる。
// akaDora: 0=なし / 3=5m,5p,5sの各1枚 / 4=5mと5s各1枚+5p2枚
export function buildWall(rules, randInt = cryptoRandInt) {
  const tiles = [];
  let id = 0;
  const redPlan = { 4: 0, 13: 0, 22: 0 }; // kind(5m,5p,5s) → 赤枚数
  if (rules.akaDora >= 3) { redPlan[4] = 1; redPlan[13] = 1; redPlan[22] = 1; }
  if (rules.akaDora === 4) redPlan[13] = 2;

  for (let kind = 0; kind < KIND_COUNT; kind++) {
    for (let i = 0; i < 4; i++) {
      const red = (redPlan[kind] ?? 0) > i;
      tiles.push({ kind, red, id: id++ });
    }
  }
  return shuffle(tiles, randInt);
}

// 山から配牌・王牌を切り出すヘルパ。
// 返り値: { hands: [13枚x4], live: ツモ山(70枚), deadWall: 王牌(14枚) }
export function deal(wall) {
  const w = wall.slice();
  const deadWall = w.splice(w.length - 14, 14);
  const hands = [[], [], [], []];
  // 実際の取り方(4枚x3周+1枚)と同じ順序で取る
  for (let round = 0; round < 3; round++)
    for (let p = 0; p < 4; p++) hands[p].push(...w.splice(0, 4));
  for (let p = 0; p < 4; p++) hands[p].push(w.shift());
  return { hands, live: w, deadWall };
}

// 王牌のドラ表示牌: deadWall[4]が最初の表示牌、槓のたび[6],[8]...
// 裏ドラは[5],[7],... 嶺上牌は[0]..[3]
export function doraIndicators(deadWall, kanCount) {
  const ind = [];
  for (let i = 0; i <= kanCount; i++) ind.push(deadWall[4 + i * 2]);
  return ind;
}
export function uraIndicators(deadWall, kanCount) {
  const ind = [];
  for (let i = 0; i <= kanCount; i++) ind.push(deadWall[5 + i * 2]);
  return ind;
}
export function rinshanTile(deadWall, kanCount) {
  return deadWall[kanCount]; // 0..3
}
