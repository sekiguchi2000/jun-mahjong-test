// score.js — 符・翻から点数への変換と支払い計算
import { evaluateWin } from './yaku.js';

// 基本点(a) = 符 × 2^(2+翻)。満貫以上はテーブル。
export function basePoints(han, fu, yakumanCount, rules) {
  if (yakumanCount > 0) return 8000 * yakumanCount;
  if (han >= 13) return rules.kazoeYakuman ? 8000 : 6000;
  if (han >= 11) return 6000;
  if (han >= 8) return 4000;
  if (han >= 6) return 3000;
  if (han >= 5) return 2000;
  let base = fu * Math.pow(2, 2 + han);
  if (base > 2000) return 2000;
  if (rules.kiriage && ((han === 4 && fu === 30) || (han === 3 && fu === 60))) return 2000;
  return base;
}

const ceil100 = (x) => Math.ceil(x / 100) * 100;

// 支払い計算。返り値 { total, payments: {ron?: n, dealerPay?: n, othersPay?: n} }
export function payment(base, isDealer, tsumo, honba = 0) {
  if (tsumo) {
    if (isDealer) {
      const each = ceil100(base * 2) + honba * 100;
      return { total: each * 3, payments: { othersPay: each } };
    }
    const others = ceil100(base) + honba * 100;
    const dealer = ceil100(base * 2) + honba * 100;
    return { total: others * 2 + dealer, payments: { othersPay: others, dealerPay: dealer } };
  }
  const ron = ceil100(base * (isDealer ? 6 : 4)) + honba * 300;
  return { total: ron, payments: { ron } };
}

// 和了の総合評価: 役判定 → 点数。役なしなら null。
// extra = { isDealer, honba, riichiSticks }
export function scoreWin(ctx, rules, extra) {
  const result = evaluateWin(ctx, rules);
  if (!result) return null;
  const base = basePoints(result.han, result.fu, result.yakumanCount, rules);
  const pay = payment(base, extra.isDealer, ctx.tsumo, extra.honba);
  const name = limitName(result.han, result.fu, result.yakumanCount, base, rules);
  return {
    ...result,
    base,
    total: pay.total + (extra.riichiSticks || 0) * 1000,
    payments: pay.payments,
    limitName: name,
  };
}

export function limitName(han, fu, yakumanCount, base, rules) {
  if (yakumanCount >= 2) return `${yakumanCount}倍役満`;
  if (yakumanCount === 1) return '役満';
  if (han >= 13 && rules.kazoeYakuman) return '数え役満';
  if (han >= 11) return '三倍満';
  if (han >= 8) return '倍満';
  if (han >= 6) return '跳満';
  if (base >= 2000) return '満貫';
  return '';
}
