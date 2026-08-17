// stats-store.js — 成績のデータ蓄積と集計 (v13)
//
// 自分(seat0)の対局成績をlocalStorageへ半荘単位で蓄積し、分析画面用の
// 集計を提供する。記録するのは対局イベントから分かる事実のみ。
// 表示(分析画面)の見た目は別途UI側が担当する。

const STORAGE_KEY = 'jun-stats-v1';
const MAX_GAMES = 300;

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadGameRecords(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveGameRecords(records, storage = defaultStorage()) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

export function clearGameRecords(storage = defaultStorage()) {
  try { storage?.removeItem(STORAGE_KEY); return true; } catch { return false; }
}

// 対局中の一時トラッカー。UIのイベントディスパッチから叩く
export class StatsTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.game = null;
  }

  startGame() {
    this.active = true;
    this.game = {
      version: 1,
      startedAt: new Date().toISOString(),
      hands: 0,
      myWins: 0,
      myWinPoints: [],
      myTsumoWins: 0,
      myDealIns: 0,
      myDealInPoints: [],
      riichiHands: 0,
      callHands: 0,
      ryukyoku: 0,
      tenpaiAtRyukyoku: 0,
      yaku: {},
      maxWin: 0,
    };
    this.handFlags = { riichi: false, called: false };
  }

  startHand() {
    if (!this.active) return;
    this.game.hands += 1;
    this.handFlags = { riichi: false, called: false };
  }

  onMyRiichi() {
    if (!this.active || this.handFlags.riichi) return;
    this.handFlags.riichi = true;
    this.game.riichiHands += 1;
  }

  onMyCall() {
    if (!this.active || this.handFlags.called) return;
    this.handFlags.called = true;
    this.game.callHands += 1;
  }

  onWin({ winner, loser, score }) {
    if (!this.active || !score) return;
    if (winner === 0) {
      this.game.myWins += 1;
      const total = Number(score.total) || 0;
      this.game.myWinPoints.push(total);
      this.game.maxWin = Math.max(this.game.maxWin, total);
      if (loser === null || loser === undefined) this.game.myTsumoWins += 1;
      for (const yaku of score.yaku ?? []) {
        this.game.yaku[yaku.name] = (this.game.yaku[yaku.name] || 0) + 1;
      }
    } else if (loser === 0) {
      this.game.myDealIns += 1;
      this.game.myDealInPoints.push(Number(score.total) || 0);
    }
  }

  onRyukyoku({ tenpai, tochu }) {
    if (!this.active || tochu) return;
    this.game.ryukyoku += 1;
    if ((tenpai ?? []).includes(0)) this.game.tenpaiAtRyukyoku += 1;
  }

  finishGame({ ranking, points, finalScore }, storage = defaultStorage()) {
    if (!this.active) return null;
    const rank = (ranking ?? []).indexOf(0);
    const record = {
      ...this.game,
      endedAt: new Date().toISOString(),
      rank: rank >= 0 ? rank + 1 : null,
      points: Array.isArray(points) ? points[0] : null,
      finalScore: Number.isFinite(finalScore) ? finalScore : null,
    };
    const records = loadGameRecords(storage);
    records.push(record);
    while (records.length > MAX_GAMES) records.shift();
    saveGameRecords(records, storage);
    this.reset();
    return record;
  }
}

// 分析画面用の集計
export function summarizeStats(records) {
  const summary = {
    games: records.length,
    rankCounts: [0, 0, 0, 0],
    avgRank: null,
    hands: 0,
    winRate: null,
    dealInRate: null,
    riichiRate: null,
    callRate: null,
    tsumoShare: null,
    avgWinPoints: null,
    avgDealInPoints: null,
    maxWin: 0,
    ryukyokuTenpaiRate: null,
    yakuRanking: [],
    recentRanks: [],
    totalFinalScore: 0,
  };
  if (records.length === 0) return summary;
  let rankSum = 0, ranked = 0, wins = 0, dealIns = 0, riichi = 0, calls = 0;
  let winPoints = 0, dealInPoints = 0, tsumo = 0, ryukyoku = 0, tenpai = 0;
  const yaku = {};
  for (const record of records) {
    if (record.rank >= 1 && record.rank <= 4) {
      summary.rankCounts[record.rank - 1] += 1;
      rankSum += record.rank;
      ranked += 1;
    }
    summary.hands += record.hands || 0;
    wins += record.myWins || 0;
    tsumo += record.myTsumoWins || 0;
    dealIns += record.myDealIns || 0;
    riichi += record.riichiHands || 0;
    calls += record.callHands || 0;
    ryukyoku += record.ryukyoku || 0;
    tenpai += record.tenpaiAtRyukyoku || 0;
    winPoints += (record.myWinPoints || []).reduce((sum, value) => sum + value, 0);
    dealInPoints += (record.myDealInPoints || []).reduce((sum, value) => sum + value, 0);
    summary.maxWin = Math.max(summary.maxWin, record.maxWin || 0);
    summary.totalFinalScore += record.finalScore || 0;
    for (const [name, count] of Object.entries(record.yaku || {})) {
      yaku[name] = (yaku[name] || 0) + count;
    }
  }
  if (ranked > 0) summary.avgRank = rankSum / ranked;
  if (summary.hands > 0) {
    summary.winRate = wins / summary.hands;
    summary.dealInRate = dealIns / summary.hands;
    summary.riichiRate = riichi / summary.hands;
    summary.callRate = calls / summary.hands;
  }
  if (wins > 0) {
    summary.avgWinPoints = winPoints / wins;
    summary.tsumoShare = tsumo / wins;
  }
  if (dealIns > 0) summary.avgDealInPoints = dealInPoints / dealIns;
  if (ryukyoku > 0) summary.ryukyokuTenpaiRate = tenpai / ryukyoku;
  summary.yakuRanking = Object.entries(yaku)
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => ({ name, count }));
  summary.recentRanks = records.slice(-10).map(record => record.rank);
  return summary;
}
