// threat-read.js — 相手の手の高さ読み・順位の傷読み・自手の見返り (2026-08-22 ユーザー設計)
//
// 「いつ攻めるか」を欲(高い役をあがりたい)や精神論(流れ・ツキ)でなく、公開情報からの
// 読みで決めるための層。麻雀は見えない情報が多く高さを言い切れないが、それでも
// 捨て牌・手出しツモ切り・ドラ周りの挙動・赤の見え方から打点分布を確度つきで推定し、
// 「あがられても傷が浅いか」「押す見返りが釣り合うか」まで含めて押し引きを決める。
//
// 定数は一般的な実戦統計(リーチ平均約5200点・満貫以上約3割・親は約1.45倍)を基準にし、
// 証拠1つごとに乗率で補正する。全て決定的・公開情報のみ。

import { isHonor, doraFromIndicator } from './tiles.js';

const CHILD_RIICHI_BASE = 5200;   // 子リーチの平均放銃失点
const DEALER_MULT = 1.45;         // 親リーチ倍率
const MANGAN_PLUS_BASE = 0.30;    // 満貫以上の基準確率

function suitIndexOf(kind) {
  return kind < 27 ? Math.floor(kind / 9) : -1;
}

// 場に見えている赤5の枚数(全員の河+全員の副露+自分の手牌)
function visibleRedCount(view) {
  let count = 0;
  for (const player of view.public?.players ?? []) {
    for (const discard of player.discards ?? []) if (discard.tile?.red) count++;
    for (const meld of player.melds ?? []) for (const tile of meld.tiles ?? []) if (tile.red) count++;
  }
  for (const tile of view.hand ?? []) if (tile.red) count++;
  if (view.drawn?.red) count++;
  return count;
}

// 1家のリーチについて、公開情報から放銃時の期待失点を読む。
// 返り値: { seat, expectedLoss, manganPlusProb, band, isDealer, evidence[] }
export function estimateRiichiValue(view, seat) {
  const player = view.public?.players?.[seat];
  if (!player?.riichi) return null;
  const evidence = [];
  const doraKinds = (view.public?.doraIndicators ?? []).map(tile => doraFromIndicator(tile.kind));
  const discards = player.discards ?? [];
  const riichiIndex = discards.findIndex(discard => discard.riichi);
  const isDealer = view.public?.dealer === seat;

  let multiplier = 1;
  let manganShift = 0;

  // 証拠1: ドラ表示の枚数(カン)。表示が増えるほど本体も裏も伸びる
  const indicators = view.public?.doraIndicators?.length ?? 1;
  if (indicators > 1) {
    multiplier *= 1 + 0.25 * (indicators - 1);
    manganShift += 0.10 * (indicators - 1);
    evidence.push({ code: 'EXTRA_INDICATORS', indicators });
  }
  // 証拠2: リーチ者自身のカン(裏ドラが倍になる)
  const ownKans = (player.melds ?? []).filter(meld => (meld.tiles?.length ?? 0) === 4).length;
  if (ownKans > 0) {
    multiplier *= 1 + 0.35 * ownKans;
    manganShift += 0.12 * ownKans;
    evidence.push({ code: 'THREAT_KAN', kans: ownKans });
  }
  // 証拠3: リーチ者がドラを自分で切っている → ドラ乗りが薄く安め寄り
  const doraDiscards = discards.filter(discard => doraKinds.includes(discard.tile?.kind)).length;
  if (doraDiscards > 0) {
    multiplier *= doraDiscards >= 2 ? 0.72 : 0.84;
    manganShift -= 0.10 * Math.min(2, doraDiscards);
    evidence.push({ code: 'DORA_DISCARDED_BY_THREAT', count: doraDiscards });
  }
  // 証拠4: ドラが数牌なのに、その色をリーチまでに1枚も切っていない → ドラ周りを抱えている気配
  const numberDora = doraKinds.find(kind => kind < 27);
  if (numberDora !== undefined && doraDiscards === 0) {
    const preRiichi = riichiIndex >= 0 ? discards.slice(0, riichiIndex + 1) : discards;
    const cutDoraSuit = preRiichi.some(discard => suitIndexOf(discard.tile?.kind) === suitIndexOf(numberDora));
    if (!cutDoraSuit && preRiichi.length >= 5) {
      multiplier *= 1.12;
      manganShift += 0.06;
      evidence.push({ code: 'DORA_SUIT_HOARDED', suit: suitIndexOf(numberDora) });
    }
  }
  // 証拠5: 赤5の見え方。見えていない赤はリーチ者の手にある可能性が残る
  const unseenReds = Math.max(0, 3 - visibleRedCount(view));
  if (unseenReds >= 2) {
    multiplier *= 1.08;
    evidence.push({ code: 'REDS_UNSEEN', count: unseenReds });
  }
  // 証拠6: 字牌をリーチ間際まで抱えていた(逆順の河) → 手役・対子系の気配
  const lateHonorCuts = discards.filter((discard, index) =>
    index >= 5 && (riichiIndex < 0 || index <= riichiIndex) && isHonor(discard.tile?.kind)).length;
  if (lateHonorCuts >= 2) {
    multiplier *= 1.10;
    manganShift += 0.05;
    evidence.push({ code: 'LATE_HONOR_CUTS', count: lateHonorCuts });
  }
  // 証拠7: 早いリーチ(6巡以内)は平均的にわずかに安い
  if (riichiIndex >= 0 && riichiIndex <= 5) {
    multiplier *= 0.94;
    evidence.push({ code: 'EARLY_RIICHI', turn: riichiIndex + 1 });
  }
  if (isDealer) evidence.push({ code: 'DEALER_RIICHI' });

  const expectedLoss = Math.round(CHILD_RIICHI_BASE * multiplier * (isDealer ? DEALER_MULT : 1) / 100) * 100;
  const manganPlusProb = Math.min(0.85, Math.max(0.08,
    (MANGAN_PLUS_BASE + manganShift) * (isDealer ? 1.15 : 1)));
  const band = expectedLoss < 4500 ? 'cheap'
    : expectedLoss < 6500 ? 'mid'
    : expectedLoss < 9000 ? 'expensive'
    : 'severe';
  return { seat, expectedLoss, manganPlusProb, band, isDealer, evidence };
}

// 全リーチ者の読みをまとめる。expectedLossは最大の相手を代表値にする
export function readThreats(view) {
  const reads = [];
  for (let seat = 0; seat < (view.public?.players?.length ?? 0); seat++) {
    if (seat === view.me) continue;
    const read = estimateRiichiValue(view, seat);
    if (read) reads.push(read);
  }
  if (reads.length === 0) return null;
  const worst = reads.reduce((max, read) => read.expectedLoss > max.expectedLoss ? read : max, reads[0]);
  return { reads, worst, expectedLoss: worst.expectedLoss, band: worst.band };
}

// 自手の見返り: あがれる確率×打点の概算。欲を数字にする(高い手でも届かなければ価値0)
export function handProspect({ shanten, liveWaits = 0, remaining = 70, valueTiles = 0, menzen = true }) {
  const drawsLeft = Math.max(0, Math.floor((remaining ?? 0) / 4));
  let winProb;
  if (shanten === 0) {
    winProb = Math.min(0.55, (0.05 + 0.05 * Math.min(8, liveWaits)) * Math.min(1, drawsLeft / 8));
  } else if (shanten === 1) {
    winProb = Math.min(0.25, 0.022 * Math.min(11, drawsLeft));
  } else if (shanten === 2) {
    winProb = drawsLeft >= 8 ? 0.10 : 0.04;
  } else {
    winProb = drawsLeft >= 10 ? 0.04 : 0.01;
  }
  const value = 2600 + 1400 * Math.min(4, valueTiles) + (menzen && shanten <= 1 ? 1800 : 0);
  return { winProb, value, gainEV: Math.round(winProb * value), drawsLeft };
}

// 順位の傷読み: 期待失点を直撃で払ったとき、順位が落ちるか・取り返す余裕はあるか
export function placementCushion(view, expectedLoss) {
  const points = view.public?.points ?? [];
  const me = view.me ?? 0;
  const myPoints = points[me] ?? 0;
  const afterHit = myPoints - expectedLoss;
  const othersAbove = points.filter((value, seat) => seat !== me && value > myPoints).length;
  const othersAboveAfter = points.filter((value, seat) => seat !== me && value > afterHit).length;
  const dropsRank = othersAboveAfter > othersAbove;
  // 残り局数の概算(半荘想定。西入り済みなら一荘扱い)。scheduledFinalHandはオーラス確定
  const roundWindIdx = view.public?.roundWindIdx ?? 0;
  const kyoku = view.public?.kyoku ?? 0;
  const totalHands = roundWindIdx >= 2 ? 16 : 8;
  const handsLeft = view.placement?.scheduledFinalHand ? 0
    : Math.max(0, totalHands - (roundWindIdx * 4 + kyoku) - 1);
  const tobi = afterHit < 0;
  const level = tobi || (dropsRank && handsLeft === 0) ? 'fatal'
    : dropsRank && handsLeft <= 2 ? 'thin'
    : dropsRank ? 'ok'
    : 'deep';
  return { level, dropsRank, afterHit, handsLeft, tobi };
}

// 押し引きペナルティ用の倍率へ変換
export function pushScales(read, cushion, prospect) {
  const lossScale = Math.min(2.6, Math.max(0.6, (read?.expectedLoss ?? CHILD_RIICHI_BASE) / CHILD_RIICHI_BASE));
  const cushionScale = { fatal: 1.6, thin: 1.35, ok: 1.0, deep: 0.85 }[cushion?.level ?? 'ok'] ?? 1.0;
  // 見返り: 自手のEVが失点期待に迫るほど押しやすく。ただし高額読みの相手には上限を締める
  let incentiveScale = 1.3 - Math.min(0.55, (prospect?.gainEV ?? 0) / Math.max(1, read?.expectedLoss ?? CHILD_RIICHI_BASE));
  if (read?.band === 'severe' || read?.band === 'expensive') incentiveScale = Math.max(0.95, incentiveScale);
  incentiveScale = Math.max(0.75, Math.min(1.35, incentiveScale));
  return { lossScale, cushionScale, incentiveScale };
}

// ガイド用: 読みの根拠を日本語にする
export function describeThreatRead(read, seatLabels = ['あなた', '下家', '対面', '上家']) {
  if (!read?.worst) return null;
  const worst = read.worst;
  const who = seatLabels[worst.seat] ?? `${worst.seat}家`;
  const parts = [];
  for (const item of worst.evidence) {
    switch (item.code) {
      case 'EXTRA_INDICATORS': parts.push(`ドラ表示が${item.indicators}枚`); break;
      case 'THREAT_KAN': parts.push('カンが入って裏ドラも倍'); break;
      case 'DORA_DISCARDED_BY_THREAT': parts.push(`ドラを自分で${item.count}枚切っている`); break;
      case 'DORA_SUIT_HOARDED': parts.push(`ドラの${['萬子', '筒子', '索子'][item.suit]}を1枚も切っていない`); break;
      case 'REDS_UNSEEN': parts.push(`赤5が${item.count}枚見えていない`); break;
      case 'LATE_HONOR_CUTS': parts.push('字牌を終盤まで抱えていた河'); break;
      case 'EARLY_RIICHI': parts.push(`${item.turn}巡目の早いリーチ`); break;
      case 'DEALER_RIICHI': parts.push('親リーチ'); break;
      default: break;
    }
  }
  const bandLabel = { cheap: '安め', mid: '平均的', expensive: '高め', severe: '満貫級以上' }[worst.band];
  const evidenceText = parts.length > 0 ? `（${parts.join('・')}）` : '';
  return `${who}のリーチは${bandLabel}とみます${evidenceText}。放銃なら${worst.expectedLoss}点前後を見込みます。`;
}

export function describeCushion(cushion, read) {
  if (!cushion) return null;
  switch (cushion.level) {
    case 'deep':
      return 'この失点を直撃で払っても順位は落ちない点差です。';
    case 'ok':
      return `直撃を受けると順位が一つ落ちますが、残り${cushion.handsLeft}局で取り返す余地はあります。`;
    case 'thin':
      return `直撃を受けると順位が落ち、残り${cushion.handsLeft}局では取り返しが難しい点差です。`;
    case 'fatal':
      return cushion.tobi ? '直撃を受けると飛んで終局します。' : 'ここで直撃を受けると順位を戻す局が残っていません。';
    default:
      return null;
  }
}
