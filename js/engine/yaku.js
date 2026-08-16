// yaku.js — 役判定と翻数計算
// evaluateWin(ctx, rules) が唯一の入口。全分解×全待ち解釈を試し、最高得点の解釈を返す。
//
// ctx = {
//   hand: [{kind,red}...]   // 門前部分13枚相当から和了牌を除いたもの(副露・和了牌を含まない)
//   melds: [{type:'chi'|'pon'|'minkan'|'ankan', tiles:[{kind,red}...]}],
//   winTile: {kind,red},
//   tsumo: bool,
//   riichi, doubleRiichi, ippatsu, rinshan, chankan, haitei, houtei, tenhou, chihou: bool,
//   seatWind, roundWind: kind(27-30),
//   doraIndicators: [kind...], uraIndicators: [kind...]
// }

import { toCounts, isHonor, isTerminal, isYaochu, isDragon, numOf, suitOf,
         doraFromIndicator, TON, HAKU, KIND_COUNT } from './tiles.js';
import { decompose, isChiitoi, isKokushi } from './agari.js';

const YAOCHU_KINDS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

export function evaluateWin(ctx, rules) {
  const concealed = [...ctx.hand, ctx.winTile];
  const counts14 = toCounts(concealed);
  const allTiles = [...concealed, ...ctx.melds.flatMap(m => m.tiles)];
  const menzen = ctx.melds.every(m => m.type === 'ankan');

  const candidates = [];

  // --- 特殊形 ---
  if (ctx.melds.length === 0 && isKokushi(counts14)) {
    const juusanmen = counts14[ctx.winTile.kind] === 2; // 13面待ち
    const yakuman = (juusanmen && rules.doubleYakuman) ? 2 : 1;
    candidates.push(finish(ctx, rules, {
      yakuList: [{ name: juusanmen ? '国士無双十三面' : '国士無双', yakuman }],
      fu: 30, menzen, allTiles, isYakumanHand: true,
    }));
  }
  if (ctx.melds.length === 0 && isChiitoi(counts14)) {
    const yl = [];
    addStateYaku(yl, ctx, menzen, rules);
    yl.push({ name: '七対子', han: 2 });
    addChiitoiExtras(yl, counts14, allTiles, ctx, rules);
    candidates.push(finish(ctx, rules, { yakuList: yl, fu: 25, menzen, allTiles }));
  }

  // --- 標準形: 全分解 × 全待ち解釈 ---
  for (const dec of decompose(counts14)) {
    const closedSets = dec.sets.map(s => ({ ...s, open: false, kan: false }));
    const meldSets = ctx.melds.map(m => ({
      type: m.type === 'chi' ? 'shuntsu' : 'kotsu',
      tile: m.type === 'chi' ? Math.min(...m.tiles.map(t => t.kind)) : m.tiles[0].kind,
      open: m.type !== 'ankan',
      kan: m.type === 'minkan' || m.type === 'ankan',
      ankan: m.type === 'ankan',
    }));

    // 和了牌がどのグループを完成させたかの解釈を列挙
    const w = ctx.winTile.kind;
    const waitInterps = [];
    if (dec.pair === w) waitInterps.push({ group: 'pair' });
    closedSets.forEach((s, i) => {
      if (s.type === 'kotsu' && s.tile === w) waitInterps.push({ group: i, wait: 'shanpon' });
      if (s.type === 'shuntsu' && w >= s.tile && w <= s.tile + 2) {
        waitInterps.push({ group: i, wait: waitOf(s.tile, w) });
      }
    });
    if (waitInterps.length === 0) continue; // 和了牌が副露にしかない=不正

    for (const interp of waitInterps) {
      const sets = closedSets.map((s, i) => {
        // ロンで完成した刻子は明刻扱い(三暗刻・四暗刻・符に影響)
        if (!ctx.tsumo && interp.group === i && s.type === 'kotsu') return { ...s, open: true, ronMade: true };
        return { ...s };
      }).concat(meldSets);

      const yl = [];
      addStateYaku(yl, ctx, menzen, rules);
      addPatternYaku(yl, { sets, pair: dec.pair, interp, ctx, rules, menzen, allTiles, counts14 });

      const yakumanList = yl.filter(y => y.yakuman);
      if (yakumanList.length > 0) {
        candidates.push(finish(ctx, rules, { yakuList: yakumanList, fu: 30, menzen, allTiles, isYakumanHand: true }));
      } else {
        const fu = calcFu({ sets, pair: dec.pair, interp, ctx, menzen, yl, rules });
        candidates.push(finish(ctx, rules, { yakuList: yl, fu, menzen, allTiles }));
      }
    }
  }

  const valid = candidates.filter(c => c && c.han > 0);
  if (valid.length === 0) return null;
  valid.sort((a, b) => (b.yakumanCount - a.yakumanCount) || (b.han - a.han) || (b.fu - a.fu));
  return valid[0];
}

function waitOf(setStart, winKind) {
  const pos = winKind - setStart;
  const n = setStart % 9; // 0-indexed start
  if (pos === 1) return 'kanchan';
  if (pos === 2 && n === 0) return 'penchan';  // 12待ち3
  if (pos === 0 && n === 6) return 'penchan';  // 89待ち7
  return 'ryanmen';
}

// --- 状況役(形に依存しない) ---
function addStateYaku(yl, ctx, menzen, rules) {
  if (ctx.tenhou) { yl.push({ name: '天和', yakuman: 1 }); return; }
  if (ctx.chihou) { yl.push({ name: '地和', yakuman: 1 }); return; }
  if (ctx.doubleRiichi) yl.push({ name: 'ダブルリーチ', han: 2 });
  else if (ctx.riichi) yl.push({ name: 'リーチ', han: 1 });
  if (ctx.ippatsu && rules.ippatsu) yl.push({ name: '一発', han: 1 });
  if (ctx.tsumo && menzen) yl.push({ name: '門前清自摸和', han: 1 });
  if (ctx.haitei) yl.push({ name: '海底摸月', han: 1 });
  if (ctx.houtei) yl.push({ name: '河底撈魚', han: 1 });
  if (ctx.rinshan) yl.push({ name: '嶺上開花', han: 1 });
  if (ctx.chankan) yl.push({ name: '槍槓', han: 1 });
}

// --- 七対子にも複合する形役 ---
function addChiitoiExtras(yl, counts14, allTiles, ctx, rules) {
  if (allTiles.every(t => !isYaochu(t.kind)) && rules.kuitan !== 'never') yl.push({ name: '断么九', han: 1 });
  if (allTiles.every(t => isHonor(t.kind))) { yl.length = 0; addStateYaku(yl, ctx, true, rules); yl.push({ name: '字一色', yakuman: 1 }); return; }
  if (allTiles.every(t => isYaochu(t.kind))) yl.push({ name: '混老頭', han: 2 });
  const suits = new Set(allTiles.filter(t => !isHonor(t.kind)).map(t => suitOf(t.kind)));
  const hasHonor = allTiles.some(t => isHonor(t.kind));
  if (suits.size === 1) yl.push(hasHonor ? { name: '混一色', han: 3 } : { name: '清一色', han: 6 });
}

// --- 形の役 ---
function addPatternYaku(yl, env) {
  const { sets, pair, ctx, rules, menzen, allTiles, interp } = env;
  const shuntsu = sets.filter(s => s.type === 'shuntsu');
  const kotsu = sets.filter(s => s.type === 'kotsu');
  const anko = kotsu.filter(s => !s.open || (s.ankan));
  const kan = sets.filter(s => s.kan);

  // --- 役満 ---
  if (anko.length === 4) {
    const tanki = interp.group === 'pair';
    yl.push({ name: tanki ? '四暗刻単騎' : '四暗刻', yakuman: (tanki && rules.doubleYakuman) ? 2 : 1 });
  }
  const dragonKotsu = kotsu.filter(s => isDragon(s.tile)).length;
  if (dragonKotsu === 3) yl.push({ name: '大三元', yakuman: 1 });
  const windKotsu = kotsu.filter(s => s.tile >= 27 && s.tile <= 30).length;
  const windPair = pair >= 27 && pair <= 30;
  if (windKotsu === 4) yl.push({ name: '大四喜', yakuman: rules.doubleYakuman ? 2 : 1 });
  else if (windKotsu === 3 && windPair) yl.push({ name: '小四喜', yakuman: 1 });
  if (allTiles.every(t => isHonor(t.kind))) yl.push({ name: '字一色', yakuman: 1 });
  if (allTiles.every(t => isTerminal(t.kind))) yl.push({ name: '清老頭', yakuman: 1 });
  const GREEN = [19, 20, 21, 23, 25, 32]; // 23468s + 發
  if (allTiles.every(t => GREEN.includes(t.kind))) yl.push({ name: '緑一色', yakuman: 1 });
  if (kan.length === 4) yl.push({ name: '四槓子', yakuman: 1 });
  // 九蓮宝燈 (門前清一色で 1112345678999+X)
  if (menzen && env.counts14) {
    const c = env.counts14;
    const suits = new Set(allTiles.map(t => suitOf(t.kind)));
    if (suits.size === 1 && !allTiles.some(t => isHonor(t.kind))) {
      const base = allTiles[0].kind - (allTiles[0].kind % 9);
      let ok = true, extra = -1;
      const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
      for (let i = 0; i < 9; i++) {
        const d = c[base + i] - need[i];
        if (d === 1 && extra === -1) extra = i;
        else if (d !== 0) { ok = false; break; }
      }
      if (ok && extra >= 0) {
        const junsei = (ctx.winTile.kind === base + extra);
        yl.push({ name: junsei ? '純正九蓮宝燈' : '九蓮宝燈', yakuman: (junsei && rules.doubleYakuman) ? 2 : 1 });
      }
    }
  }
  if (yl.some(y => y.yakuman)) return;

  // --- 通常役 ---
  // 平和
  if (menzen && shuntsu.length === 4 && interp.wait === 'ryanmen' &&
      !isDragon(pair) && pair !== ctx.seatWind && pair !== ctx.roundWind) {
    yl.push({ name: '平和', han: 1 });
  }
  // 断么九
  if (allTiles.every(t => !isYaochu(t.kind))) {
    if (menzen || rules.kuitan) yl.push({ name: '断么九', han: 1 });
  }
  // 役牌
  for (const s of kotsu) {
    if (isDragon(s.tile)) yl.push({ name: `役牌 ${['白', '發', '中'][s.tile - HAKU]}`, han: 1 });
    if (s.tile === ctx.roundWind) yl.push({ name: `場風 ${['東', '南', '西', '北'][s.tile - TON]}`, han: 1 });
    if (s.tile === ctx.seatWind) yl.push({ name: `自風 ${['東', '南', '西', '北'][s.tile - TON]}`, han: 1 });
  }
  // 一盃口・二盃口
  if (menzen) {
    const key = (s) => `${s.tile}`;
    const shuntsuCounts = {};
    for (const s of shuntsu) shuntsuCounts[key(s)] = (shuntsuCounts[key(s)] || 0) + 1;
    const pairsOfShuntsu = Object.values(shuntsuCounts).filter(n => n >= 2).reduce((a, n) => a + Math.floor(n / 2), 0);
    if (pairsOfShuntsu >= 2) yl.push({ name: '二盃口', han: 3 });
    else if (pairsOfShuntsu === 1) yl.push({ name: '一盃口', han: 1 });
  }
  // 三色同順
  {
    const byNum = {};
    for (const s of shuntsu) {
      const n = s.tile % 9, suit = suitOf(s.tile);
      byNum[n] = byNum[n] || new Set();
      byNum[n].add(suit);
    }
    if (Object.values(byNum).some(set => set.size === 3)) yl.push({ name: '三色同順', han: menzen ? 2 : 1 });
  }
  // 三色同刻
  {
    const byNum = {};
    for (const s of kotsu) {
      if (isHonor(s.tile)) continue;
      const n = s.tile % 9;
      byNum[n] = byNum[n] || new Set();
      byNum[n].add(suitOf(s.tile));
    }
    if (Object.values(byNum).some(set => set.size === 3)) yl.push({ name: '三色同刻', han: 2 });
  }
  // 一気通貫
  {
    for (const suitBase of [0, 9, 18]) {
      const have = new Set(shuntsu.filter(s => s.tile >= suitBase && s.tile < suitBase + 9).map(s => s.tile % 9));
      if (have.has(0) && have.has(3) && have.has(6)) { yl.push({ name: '一気通貫', han: menzen ? 2 : 1 }); break; }
    }
  }
  // 対々和
  if (kotsu.length === 4) yl.push({ name: '対々和', han: 2 });
  // 三暗刻
  if (anko.length === 3) yl.push({ name: '三暗刻', han: 2 });
  // 三槓子
  if (kan.length === 3) yl.push({ name: '三槓子', han: 2 });
  // 小三元
  if (dragonKotsu === 2 && isDragon(pair)) yl.push({ name: '小三元', han: 2 });
  // 混老頭
  if (allTiles.every(t => isYaochu(t.kind)) && allTiles.some(t => isHonor(t.kind))) yl.push({ name: '混老頭', han: 2 });
  // チャンタ・純チャン (全グループに么九牌)
  {
    const groupHasYaochu = (s) => s.type === 'kotsu' ? isYaochu(s.tile)
      : (isTerminal(s.tile) || isTerminal(s.tile + 2));
    if (sets.every(groupHasYaochu) && isYaochu(pair) && shuntsu.length > 0) {
      const anyHonor = allTiles.some(t => isHonor(t.kind));
      if (anyHonor) yl.push({ name: '混全帯么九', han: menzen ? 2 : 1 });
      else yl.push({ name: '純全帯么九', han: menzen ? 3 : 2 });
    }
  }
  // 混一色・清一色
  {
    const suits = new Set(allTiles.filter(t => !isHonor(t.kind)).map(t => suitOf(t.kind)));
    const hasHonor = allTiles.some(t => isHonor(t.kind));
    if (suits.size === 1) {
      if (hasHonor) yl.push({ name: '混一色', han: menzen ? 3 : 2 });
      else yl.push({ name: '清一色', han: menzen ? 6 : 5 });
    }
  }
}

// --- 符計算 ---
function calcFu({ sets, pair, interp, ctx, menzen, yl, rules }) {
  const isPinfu = yl.some(y => y.name === '平和');
  if (isPinfu) return ctx.tsumo ? 20 : 30;

  let fu = 20;
  if (menzen && !ctx.tsumo) fu += 10;
  if (ctx.tsumo) fu += 2;

  for (const s of sets) {
    if (s.type !== 'kotsu') continue;
    let f = isYaochu(s.tile) ? 4 : 2;
    if (!s.open) f *= 2;
    if (s.kan) f *= 4;
    fu += f;
  }
  if (isDragon(pair)) fu += 2;
  if (pair === ctx.seatWind) fu += 2;
  if (pair === ctx.roundWind) fu += 2;
  if (interp.wait === 'kanchan' || interp.wait === 'penchan' || interp.group === 'pair') fu += 2;

  if (fu === 20 && !menzen) fu = 30; // 喰い平和形は30符
  return Math.ceil(fu / 10) * 10;
}

// --- ドラを足して最終形にまとめる ---
function finish(ctx, rules, { yakuList, fu, menzen, allTiles, isYakumanHand = false }) {
  if (isYakumanHand) {
    let count = yakuList.reduce((a, y) => a + y.yakuman, 0);
    return { yaku: yakuList, han: 13 * count, fu, yakumanCount: count, menzen };
  }
  const yl = [...yakuList];
  let han = yl.reduce((a, y) => a + (y.han || 0), 0);
  if (han === 0) return null; // 役なし(ドラのみでは和了れない)

  // ドラ
  const doraKinds = (ctx.doraIndicators || []).map(doraFromIndicator);
  let dora = 0;
  for (const t of allTiles) for (const d of doraKinds) if (t.kind === d) dora++;
  if (dora > 0) yl.push({ name: 'ドラ', han: dora });
  const aka = allTiles.filter(t => t.red).length;
  if (aka > 0) yl.push({ name: '赤ドラ', han: aka });
  let ura = 0;
  if (ctx.riichi && rules.uraDora) {
    const uraKinds = (ctx.uraIndicators || []).map(doraFromIndicator);
    for (const t of allTiles) for (const d of uraKinds) if (t.kind === d) ura++;
    if (ura > 0) yl.push({ name: '裏ドラ', han: ura });
  }
  han += dora + aka + ura;
  return { yaku: yl, han, fu, yakumanCount: 0, menzen };
}
