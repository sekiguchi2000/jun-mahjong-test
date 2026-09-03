// progression.js — Exp・Lv・アチーブメント (仕様: spec_document/Level_Exp.txt, Achievement.txt)
//
// Expの基本は「25000点持ち30000点返し・ウマ10-30」で固定換算(現行ルール設定に依存しない)。
// 東風0.7倍/半荘1.0倍/一荘1.5倍、マイナスは0。＋対局中のハン合計×10＋アチーブメントExp。
// 1000Expで1Lv。Lv99の先、合計100000Expで称号「雀王」(以後Expは貯まるが称号固定)。

export const EXP_PER_LEVEL = 1000;
export const MAX_LEVEL = 99;
export const JANOU_EXP = 100000;

const EXP_UMA = [30, 10, -10, -30];
const EXP_OKA = 20;
const EXP_RETURN = 30000;
export const GAME_LENGTH_MULT = Object.freeze({ tonpuu: 0.7, tonnan: 1.0, issou: 1.5 });

export function levelFromExp(exp) {
  const total = Math.max(0, Math.floor(Number(exp) || 0));
  return Math.min(MAX_LEVEL, Math.floor(total / EXP_PER_LEVEL) + 1);
}

export function isJanou(exp) {
  return (Number(exp) || 0) >= JANOU_EXP;
}

export function levelLabel(exp) {
  return isJanou(exp) ? '雀王' : `Lv ${levelFromExp(exp)}`;
}

// レベル内の進捗(バー表示用)。雀王到達後は満タン扱い。
export function levelProgress(exp) {
  const total = Math.max(0, Math.floor(Number(exp) || 0));
  if (isJanou(total)) return { into: EXP_PER_LEVEL, need: EXP_PER_LEVEL };
  if (levelFromExp(total) >= MAX_LEVEL) {
    // Lv99帯: 雀王(合計100000)までの残りを1本のバーで見せる
    const start = (MAX_LEVEL - 1) * EXP_PER_LEVEL;
    return { into: total - start, need: JANOU_EXP - start };
  }
  return { into: total % EXP_PER_LEVEL, need: EXP_PER_LEVEL };
}

// 1試合の基本Exp。myPoints=終局素点, myRank=0始まりの順位, gameLength=ルール値
export function baseGameExp({ myPoints, myRank, gameLength }) {
  const rank = Math.min(3, Math.max(0, Number(myRank) || 0));
  const pts = (Number(myPoints) - EXP_RETURN) / 1000 + EXP_UMA[rank] + (rank === 0 ? EXP_OKA : 0);
  const mult = GAME_LENGTH_MULT[gameLength] ?? 1.0;
  return Math.max(0, Math.floor(pts * mult));
}

export function hanBonusExp(totalHan) {
  return Math.max(0, Math.floor(Number(totalHan) || 0)) * 10;
}

// ============ Lv解禁 ============
export const UNLOCKS = Object.freeze([
  { level: 2, kind: 'guide', value: 'balance', label: '打ち手ガイド「バランス」' },
  { level: 3, kind: 'rule', key: 'akaDora', value: 3, label: '赤ドラ3枚設定' },
  { level: 5, kind: 'rule', key: 'nagashiMangan', value: true, label: '流し満貫設定' },
  { level: 7, kind: 'guide', value: 'efficiency', label: '打ち手ガイド「効率」' },
  { level: 10, kind: 'rule', key: 'kazoeYakuman', value: true, label: '数え役満設定' },
  { level: 15, kind: 'rule', key: 'gameLength', value: 'tonpuu', label: '東風戦' },
  { level: 21, kind: 'com', value: 'ronbolt', label: 'COM新キャラ「ロンボルト」' },
  { level: 28, kind: 'guide', value: 'attack', label: '打ち手ガイド「攻め」' },
  { level: 38, kind: 'rule', key: 'gameLength', value: 'issou', label: '一荘戦' },
  { level: 50, kind: 'rule', key: 'akaDora', value: 4, label: '赤ドラ4枚設定' },
  { level: 65, kind: 'guide', value: 'defense', label: '打ち手ガイド「守り」' },
  { level: 80, kind: 'com', value: 'wanfu', label: 'COM新キャラ「ワンフー」' },
  { level: 90, kind: 'com', value: 'sawaka', label: 'COM新キャラ「サワカ・アックス」' },
  { level: 99, kind: 'guide', value: 'spiritual', label: '打ち手ガイド「スピリチュアル」' },
]);

export function guideUnlockLevel(profile) {
  return UNLOCKS.find(u => u.kind === 'guide' && u.value === profile)?.level ?? 1;
}
export function isGuideUnlocked(profile, level) {
  return level >= guideUnlockLevel(profile);
}
export function comUnlockLevel(id) {
  return UNLOCKS.find(u => u.kind === 'com' && u.value === id)?.level ?? 1;
}
export function isComUnlocked(id, level) {
  return level >= comUnlockLevel(id);
}
export function ruleValueUnlockLevel(key, value) {
  return UNLOCKS.find(u => u.kind === 'rule' && u.key === key
    && JSON.stringify(u.value) === JSON.stringify(value))?.level ?? 1;
}

// 保存済みルールを現在Lvで実効値に丸める(未解禁は「なし固定」)。
export function clampRulesToLevel(rules, level) {
  const clamped = { ...rules };
  if (level < ruleValueUnlockLevel('gameLength', clamped.gameLength)) clamped.gameLength = 'tonnan';
  if (clamped.akaDora === 4 && level < ruleValueUnlockLevel('akaDora', 4)) {
    clamped.akaDora = level >= ruleValueUnlockLevel('akaDora', 3) ? 3 : 0;
  } else if (clamped.akaDora > 0 && level < ruleValueUnlockLevel('akaDora', 3)) {
    clamped.akaDora = 0;
  }
  if (clamped.nagashiMangan && level < ruleValueUnlockLevel('nagashiMangan', true)) clamped.nagashiMangan = false;
  if (clamped.kazoeYakuman && level < ruleValueUnlockLevel('kazoeYakuman', true)) clamped.kazoeYakuman = false;
  return clamped;
}

// ============ アチーブメント定義 ============
// 一度達成すると以後は達成できない(Expは1回だけ)。counter系は必要数/現在数を画面に出す。
const YAKU_HAN = [
  ['リーチ', 1], ['一発', 1], ['門前清自摸和', 1], ['断么九', 1], ['平和', 1],
  ['一盃口', 1], ['海底摸月', 1], ['河底撈魚', 1], ['嶺上開花', 1], ['槍槓', 1],
  ['役牌 白', 1], ['役牌 發', 1], ['役牌 中', 1], ['場風', 1], ['自風', 1],
  ['ダブルリーチ', 2], ['七対子', 2], ['混老頭', 2], ['三暗刻', 2], ['三槓子', 2],
  ['三色同刻', 2], ['対々和', 2], ['小三元', 2], ['三色同順', 2], ['一気通貫', 2],
  ['混全帯么九', 2],
  ['二盃口', 3], ['純全帯么九', 3], ['混一色', 3],
  ['清一色', 6],
  ['天和', 13], ['地和', 13], ['国士無双', 13], ['国士無双十三面', 13],
  ['四暗刻', 13], ['四暗刻単騎', 13], ['大三元', 13], ['小四喜', 13], ['大四喜', 13],
  ['字一色', 13], ['清老頭', 13], ['緑一色', 13], ['四槓子', 13],
  ['九蓮宝燈', 13], ['純正九蓮宝燈', 13],
];

function buildAchievements() {
  const list = [];
  list.push({ id: 'hanchan:1', section: '対局', label: '半荘を1回終了する', exp: 1000, counter: 'hanchan', target: 1 });
  for (const n of [5, 10, 20, 50, 100]) {
    list.push({ id: `hanchan:${n}`, section: '対局', label: `半荘を${n}回終了する`, exp: 500, counter: 'hanchan', target: n });
  }
  list.push({ id: 'top2:1', section: '順位', label: '2位以上を1回とる', exp: 500, counter: 'top2', target: 1 });
  for (const n of [1, 3, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
    list.push({ id: `rank1:${n}`, section: '順位', label: `1位を${n}回とる`, exp: 500, counter: 'rank1', target: n });
  }
  list.push({ id: 'limit:満貫', section: '打点', label: '満貫であがる', exp: 100 });
  list.push({ id: 'limit:跳満', section: '打点', label: '跳満であがる', exp: 200 });
  list.push({ id: 'limit:倍満', section: '打点', label: '倍満であがる', exp: 400 });
  list.push({ id: 'limit:三倍満', section: '打点', label: '3倍満であがる', exp: 800 });
  list.push({ id: 'limit:役満', section: '打点', label: '役満であがる', exp: 2000 });
  list.push({ id: 'dora8', section: '打点', label: 'ドラ8以上を達成する', exp: 500 });
  list.push({ id: 'renchan5', section: '打点', label: '親を5連荘する', exp: 500 });
  for (const [name, han] of YAKU_HAN) {
    list.push({ id: `yaku:${name}`, section: '役', label: `${name}であがる`, exp: han * 100 });
  }
  return list;
}

export const ACHIEVEMENTS = Object.freeze(buildAchievements());
const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map(a => [a.id, a]));
export function achievementById(id) { return ACHIEVEMENT_BY_ID.get(id) ?? null; }

// 和了スコアから該当するアチーブメントidを列挙(達成済み除外は呼び出し側)。
export function winAchievementIds(score) {
  if (!score) return [];
  const ids = [];
  const name = score.limitName ?? '';
  if (score.yakumanCount > 0 || name === '数え役満') ids.push('limit:役満');
  if (name === '満貫') ids.push('limit:満貫');
  if (name === '跳満') ids.push('limit:跳満');
  if (name === '倍満') ids.push('limit:倍満');
  if (name === '三倍満') ids.push('limit:三倍満');
  let doraHan = 0;
  for (const yaku of score.yaku ?? []) {
    if (yaku.name === 'ドラ' || yaku.name === '裏ドラ' || yaku.name === '赤ドラ') {
      doraHan += yaku.han || 0;
      continue;
    }
    const key = yaku.name.startsWith('場風') ? '場風'
      : yaku.name.startsWith('自風') ? '自風'
      : yaku.name;
    if (ACHIEVEMENT_BY_ID.has(`yaku:${key}`)) ids.push(`yaku:${key}`);
  }
  if (doraHan >= 8) ids.push('dora8');
  return ids;
}

// ハンボーナス用: この和了のハン数(役満は1つ13ハン換算)
export function winHanForBonus(score) {
  if (!score) return 0;
  if (score.yakumanCount > 0) return 13 * score.yakumanCount;
  return Number(score.han) || 0;
}

// ============ 永続化とトラッカー ============
const STORAGE_KEY = 'jun-progression-v1';

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadProgression(storage = defaultStorage()) {
  let parsed = null;
  try { parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null'); } catch { /* 壊れていたら初期化 */ }
  return {
    exp: Math.max(0, Math.floor(Number(parsed?.exp) || 0)),
    counters: {
      hanchan: Math.max(0, Math.floor(Number(parsed?.counters?.hanchan) || 0)),
      rank1: Math.max(0, Math.floor(Number(parsed?.counters?.rank1) || 0)),
      top2: Math.max(0, Math.floor(Number(parsed?.counters?.top2) || 0)),
    },
    achieved: (parsed?.achieved && typeof parsed.achieved === 'object') ? { ...parsed.achieved } : {},
  };
}

export function saveProgression(data, storage = defaultStorage()) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(data)); return true; } catch { return false; }
}

// 対局中〜終局のExp/アチーブメント確定を担う。アチーブメントは達成した瞬間に永続化する
// (中断リトライで二重取得できない)。基本Exp・ハンボーナスは終局時に加算する。
export class ProgressionTracker {
  constructor(storage = defaultStorage()) {
    this.storage = storage;
    this.data = loadProgression(storage);
    this.session = null;
    this.dealerRun = 0;
  }

  get exp() { return this.data.exp; }
  get level() { return levelFromExp(this.data.exp); }

  startGame() {
    this.session = { hanTotal: 0, achievements: [] };
    this.dealerRun = 0;
  }

  award(id) {
    const def = ACHIEVEMENT_BY_ID.get(id);
    if (!def || this.data.achieved[id]) return false;
    this.data.achieved[id] = true;
    this.data.exp += def.exp;
    this.session?.achievements.push({ id, label: def.label, exp: def.exp });
    saveProgression(this.data, this.storage);
    return true;
  }

  awardCounterTiers(counter) {
    const value = this.data.counters[counter] || 0;
    for (const def of ACHIEVEMENTS) {
      if (def.counter === counter && value >= def.target) this.award(def.id);
    }
  }

  onRoundStart({ dealer }) {
    if (!this.session) return;
    this.dealerRun = dealer === 0 ? this.dealerRun + 1 : 0;
    // 5連荘 = 自分の親が6局続く(親→1本場→…→5本場)
    if (this.dealerRun >= 6) this.award('renchan5');
  }

  onWin({ winner, score }) {
    if (!this.session || winner !== 0 || !score) return;
    this.session.hanTotal += winHanForBonus(score);
    for (const id of winAchievementIds(score)) this.award(id);
  }

  // 終局。myRankは0始まり。返り値は終局画面表示用の内訳。
  finishGame({ myRank, myPoints, gameLength }) {
    if (!this.session) return null;
    const levelBefore = levelFromExp(this.data.exp - this.sessionAchievementExp());
    if (gameLength === 'tonnan') {
      this.data.counters.hanchan += 1;
      this.awardCounterTiers('hanchan');
    }
    if (myRank <= 1) {
      this.data.counters.top2 += 1;
      this.awardCounterTiers('top2');
    }
    if (myRank === 0) {
      this.data.counters.rank1 += 1;
      this.awardCounterTiers('rank1');
    }
    const base = baseGameExp({ myPoints, myRank, gameLength });
    const hanBonus = hanBonusExp(this.session.hanTotal);
    this.data.exp += base + hanBonus;
    saveProgression(this.data, this.storage);
    const summary = {
      base,
      hanBonus,
      hanTotal: this.session.hanTotal,
      achievements: [...this.session.achievements],
      achievementExp: this.sessionAchievementExp(),
      totalGained: base + hanBonus + this.sessionAchievementExp(),
      exp: this.data.exp,
      levelBefore,
      levelAfter: levelFromExp(this.data.exp),
      janou: isJanou(this.data.exp),
      unlocked: [],
    };
    summary.unlocked = UNLOCKS.filter(u => u.level > summary.levelBefore && u.level <= summary.levelAfter);
    this.session = null;
    this.dealerRun = 0;
    return summary;
  }

  sessionAchievementExp() {
    return (this.session?.achievements ?? []).reduce((sum, entry) => sum + entry.exp, 0);
  }
}

// アチーブメント画面用の行データ。達成済みはachieved=true(インアクティブ表示)。
export function achievementRows(data = loadProgression()) {
  return ACHIEVEMENTS.map(def => ({
    ...def,
    achieved: data.achieved[def.id] === true,
    current: def.counter ? Math.min(data.counters[def.counter] || 0, def.target) : null,
  }));
}
