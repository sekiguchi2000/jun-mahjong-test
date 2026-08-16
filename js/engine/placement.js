// placement.js — 公開情報だけで行う着順・終局・必要打点の厳密計算
//
// AIの性格や確率推定より下に置く共通の事実層。
// ここでは「何点動くか」「対局が終わるか」「何位になるか」だけを扱い、
// 他家の手牌や山、裏ドラなどの非公開情報は一切受け取らない。

import { basePoints, payment, limitName } from './score.js';

const GAME_ROUNDS = Object.freeze({ tonpuu: 1, tonnan: 2, issou: 4 });
const FU_VALUES = Object.freeze([20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110]);
const SCORE_TABLE_CACHE = new WeakMap();

export function maxRoundsFor(rules) {
  return GAME_ROUNDS[rules.gameLength] ?? GAME_ROUNDS.tonnan;
}

// 同点時は起家から手番順に近い席を上位とする。Array#sortの安定性へ依存させない。
export function rankPlayers(points, initialDealer = 0) {
  const start = Number.isInteger(initialDealer) && initialDealer >= 0 && initialDealer < points.length
    ? initialDealer
    : 0;
  return points.map((_, player) => player)
    .sort((a, b) => points[b] - points[a] ||
      ((a - start + points.length) % points.length) - ((b - start + points.length) % points.length));
}

export function rankOf(points, player, initialDealer = 0) {
  return rankPlayers(points, initialDealer).indexOf(player);
}

// score.paymentsを実際の4人の点棒へ反映する。供託は勝者だけが受け取る。
export function applyWinPoints({ points, winner, loser, score, dealer, riichiSticks = 0 }) {
  const after = [...points];
  if (loser !== null && loser !== undefined) {
    const ron = score.payments.ron;
    after[loser] -= ron;
    after[winner] += ron;
  } else {
    for (let player = 0; player < after.length; player++) {
      if (player === winner) continue;
      const pay = player === dealer
        ? (score.payments.dealerPay ?? score.payments.othersPay)
        : score.payments.othersPay;
      after[player] -= pay;
      after[winner] += pay;
    }
  }
  after[winner] += riichiSticks * 1000;
  return after;
}

// Game.advanceと同じ遷移を副作用なしで計算する。
export function previewRoundAdvance({
  rules, points, roundWindIdx, kyoku, honba, result,
  initialDealer = 0, dealer = (initialDealer + kyoku) % 4,
}) {
  let nextRoundWindIdx = roundWindIdx;
  let nextKyoku = kyoku;
  let nextHonba = honba;
  let finished = false;

  if (rules.tobiEnd && points.some(p => p < 0)) {
    finished = true;
  } else if (result.renchan) {
    nextHonba++;
  } else {
    nextHonba = result.ryukyoku ? nextHonba + 1 : 0;
    nextKyoku++;
    if (nextKyoku === 4) {
      nextKyoku = 0;
      nextRoundWindIdx++;
    }
    if (nextRoundWindIdx >= maxRoundsFor(rules)) finished = true;
  }

  // 最終局の親がトップで和了した時だけ、連荘より和了やめを優先する。
  if (!finished && result.renchan && rules.agariYame &&
      nextRoundWindIdx === maxRoundsFor(rules) - 1 && nextKyoku === 3) {
    const top = rankPlayers(points, initialDealer)[0];
    if (result.winner === dealer && top === dealer) finished = true;
  }

  return {
    roundWindIdx: nextRoundWindIdx,
    kyoku: nextKyoku,
    honba: nextHonba,
    finished,
  };
}

// 和了を選んだ直後の点棒・順位・終局を、Gameへ状態変更せずに先読みする。
export function previewWinOutcome({
  rules, points, roundWindIdx, kyoku, honba, riichiSticks = 0,
  winner, loser, score, initialDealer = 0,
  dealer = (initialDealer + kyoku) % 4,
}) {
  const beforeRank = rankOf(points, winner, initialDealer);
  const afterPoints = applyWinPoints({
    points, winner, loser, score, dealer, riichiSticks,
  });
  const afterRank = rankOf(afterPoints, winner, initialDealer);
  const result = { renchan: winner === dealer, ryukyoku: false, winner };
  const next = previewRoundAdvance({
    rules, points: afterPoints, roundWindIdx, kyoku, honba, result,
    initialDealer, dealer,
  });

  return {
    winner,
    loser,
    beforeRank,
    afterRank,
    beforePoints: [...points],
    afterPoints,
    ranking: rankPlayers(afterPoints, initialDealer),
    matchEnds: next.finished,
    continues: !next.finished,
    improvesRank: afterRank < beforeRank,
    endsInLastPlace: next.finished && afterRank === points.length - 1,
    next,
    // 判断用scoreは公開情報版だけを渡すこと。placement側から非公開情報は取得しない。
    score: {
      han: score.han,
      fu: score.fu,
      yakumanCount: score.yakumanCount,
      total: score.total,
      payments: { ...score.payments },
      limitName: score.limitName,
    },
  };
}

function rankAfterRon(points, winner, loser, ron, riichiSticks, initialDealer = 0) {
  const after = [...points];
  after[winner] += ron + riichiSticks * 1000;
  after[loser] -= ron;
  return rankOf(after, winner, initialDealer);
}

// 指定順位へ届くため、特定相手からロンで必要な最小支払額。100点単位。
// これは純粋な点差条件であり、実在する符翻の点数へ丸める処理はminimumScoreToRankが担う。
export function minimumRonPointsToRank({
  points, winner, loser, targetRank, riichiSticks = 0, initialDealer = 0,
}) {
  if (targetRank < 0 || winner === loser) return null;
  if (rankOf(points, winner, initialDealer) <= targetRank) return 0;

  const reaches = units =>
    rankAfterRon(points, winner, loser, units * 100, riichiSticks, initialDealer) <= targetRank;

  let high = 1;
  while (!reaches(high)) high *= 2;
  let low = 0;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (reaches(mid)) high = mid;
    else low = mid + 1;
  }
  return low * 100;
}

function validFuHan(tsumo, han, fu) {
  if (fu === 20) return tsumo && han >= 2;       // 門前平和ツモ系
  if (fu === 25) return han >= (tsumo ? 3 : 2); // 七対子（ツモなら門前清自摸を含む）
  return fu >= 30;
}

// 実際の点数表に存在する支払い候補を小さい順に作る。
export function scoreTableCandidates({ rules, isDealer, tsumo, honba = 0 }) {
  let cache = SCORE_TABLE_CACHE.get(rules);
  if (!cache) {
    cache = new Map();
    SCORE_TABLE_CACHE.set(rules, cache);
  }
  const cacheKey = `${isDealer ? 1 : 0}:${tsumo ? 1 : 0}:${honba}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const byPayments = new Map();
  for (let han = 1; han <= 13; han++) {
    for (const fu of FU_VALUES) {
      if (!validFuHan(tsumo, han, fu)) continue;
      const base = basePoints(han, fu, 0, rules);
      const paid = payment(base, isDealer, tsumo, honba);
      const candidate = {
        han, fu, yakumanCount: 0, base,
        total: paid.total,
        payments: paid.payments,
        limitName: limitName(han, fu, 0, base, rules),
      };
      const key = JSON.stringify(paid.payments);
      const old = byPayments.get(key);
      if (!old || han < old.han || (han === old.han && fu < old.fu)) byPayments.set(key, candidate);
    }
  }
  for (let yakumanCount = 1; yakumanCount <= 4; yakumanCount++) {
    const base = basePoints(0, 0, yakumanCount, rules);
    const paid = payment(base, isDealer, tsumo, honba);
    const candidate = {
      han: 0, fu: 0, yakumanCount, base,
      total: paid.total,
      payments: paid.payments,
      limitName: limitName(0, 0, yakumanCount, base, rules),
    };
    byPayments.set(JSON.stringify(paid.payments), candidate);
  }
  const candidates = [...byPayments.values()].sort((a, b) =>
    a.total - b.total || a.han - b.han || a.fu - b.fu || a.yakumanCount - b.yakumanCount);
  cache.set(cacheKey, candidates);
  return candidates;
}

// 点数表上、指定順位へ届く最小の和了条件。手牌がその役を作れるかは手役計画層が判断する。
export function minimumScoreToRank({
  rules, points, winner, loser = null, dealer, honba = 0,
  riichiSticks = 0, targetRank, initialDealer = 0,
}) {
  if (targetRank < 0) return null;
  if (rankOf(points, winner, initialDealer) <= targetRank) return {
    alreadyReached: true, total: 0, payments: {}, afterRank: rankOf(points, winner, initialDealer),
  };
  const tsumo = loser === null || loser === undefined;
  const candidates = scoreTableCandidates({
    rules, isDealer: winner === dealer, tsumo, honba,
  });
  for (const candidate of candidates) {
    const afterPoints = applyWinPoints({
      points, winner, loser, score: candidate, dealer, riichiSticks,
    });
    const afterRank = rankOf(afterPoints, winner, initialDealer);
    if (afterRank <= targetRank) return { ...candidate, afterPoints, afterRank };
  }
  return null;
}

// AIが毎巡受け取る、公開情報だけの着順目標。
export function buildPlacementContext({
  rules, points, player, roundWindIdx, kyoku, honba, riichiSticks = 0,
  initialDealer = 0, dealer = (initialDealer + kyoku) % 4,
}) {
  const ranking = rankPlayers(points, initialDealer);
  const currentRank = ranking.indexOf(player);
  const targetRank = currentRank > 0 ? currentRank - 1 : null;
  const scheduledFinalHand =
    roundWindIdx === maxRoundsFor(rules) - 1 && kyoku === 3;
  const mustPrioritizeRankUp = scheduledFinalHand && currentRank === points.length - 1;

  // 詳細な符翻表は、現段階では最重要要件の「オーラス4位」だけで生成する。
  // 通常局まで毎巡再計算するとモバイルの思考時間を浪費するため、後続の探索層は別途キャッシュする。
  const ron = !mustPrioritizeRankUp || targetRank === null ? [] : points.map((_, loser) => {
    if (loser === player) return null;
    return {
      from: loser,
      exactPoints: minimumRonPointsToRank({
        points, winner: player, loser, targetRank, riichiSticks, initialDealer,
      }),
      score: minimumScoreToRank({
        rules, points, winner: player, loser, dealer, honba,
        riichiSticks, targetRank, initialDealer,
      }),
    };
  }).filter(Boolean);

  const tsumo = !mustPrioritizeRankUp || targetRank === null ? null : minimumScoreToRank({
    rules, points, winner: player, loser: null, dealer, honba,
    riichiSticks, targetRank, initialDealer,
  });

  return {
    ranking,
    currentRank,
    targetRank,
    scheduledFinalHand,
    lastPlace: currentRank === points.length - 1,
    mustPrioritizeRankUp,
    ron,
    tsumo,
  };
}
