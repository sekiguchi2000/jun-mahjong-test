// win-presentation.js — 和了内容を、演出に必要な「格」へ正規化する純粋層。
// 対局ロジックやUIに点数帯の分岐を散らさず、テスト可能に保つ。

export const WIN_PRESENTATION_VERSION = 2;

const TIERS = Object.freeze([
  // 先に衝撃を見せ、その後に「和了した」余韻を取る。結果画面への即送りはしない。
  Object.freeze({ id: 'standard', label: '和了', minimum: 0, strikeMs: 820, holdMs: 2550, particleCount: 16 }),
  Object.freeze({ id: 'mangan', label: '満貫', minimum: 8000, strikeMs: 980, holdMs: 3100, particleCount: 24 }),
  Object.freeze({ id: 'haneman', label: '跳満', minimum: 12000, strikeMs: 1120, holdMs: 3700, particleCount: 32 }),
  Object.freeze({ id: 'baiman', label: '倍満以上', minimum: 16000, strikeMs: 1280, holdMs: 4300, particleCount: 42 }),
]);

function finiteScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function normalizedYakumanCount(score) {
  const direct = Number(score?.yakumanCount);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  return (score?.yaku ?? []).reduce((count, yaku) =>
    count + (Number.isFinite(Number(yaku?.yakuman)) ? Math.max(0, Math.floor(Number(yaku.yakuman))) : 0), 0);
}

export function classifyWinPresentation({ score = {}, loser = null } = {}) {
  const total = finiteScore(score?.total ?? score?.points ?? score);
  const yakumanCount = normalizedYakumanCount(score);
  const kind = loser === null ? 'tsumo' : 'ron';
  let tier = TIERS[0];
  // 格付けはエンジンの限度名(limitName)を正とする。点数しきい値だけで判定すると
  // 親の満貫(12000点)が跳満に化ける・供託込みで格が上振れする(実戦報告バグ)。
  const limitName = typeof score?.limitName === 'string' ? score.limitName : null;
  if (yakumanCount > 0 || (limitName && limitName.includes('役満'))) {
    const multiple = yakumanCount >= 2 || /^\d+倍役満$/.test(limitName ?? '');
    tier = Object.freeze({ id: 'yakuman', label: multiple ? '複数役満' : '役満', minimum: 32000, strikeMs: 1500, holdMs: 5200, particleCount: 54 });
  } else if (limitName === '満貫') {
    tier = TIERS[1];
  } else if (limitName === '跳満') {
    tier = TIERS[2];
  } else if (limitName === '倍満' || limitName === '三倍満') {
    tier = TIERS[3];
  } else if (limitName === '') {
    tier = TIERS[0];
  } else {
    // limitNameが無い旧形式の入力だけ、従来の点数しきい値へフォールバック
    for (const candidate of TIERS) if (total >= candidate.minimum) tier = candidate;
  }
  const tierIndex = tier.id === 'yakuman' ? 4 : TIERS.findIndex(candidate => candidate.id === tier.id);
  return Object.freeze({
    tier: tier.id,
    tierLabel: tier.label,
    kind,
    total,
    yakumanCount,
    strikeMs: tier.strikeMs,
    holdMs: tier.holdMs,
    durationMs: tier.strikeMs + tier.holdMs,
    particleCount: tier.particleCount,
    // ツモは必ず「自分で引いた和了牌に落雷」を見せる。ロンも同じ雷フレームで強調する。
    lightning: true,
    thunder: tierIndex >= 1,
    screenShake: tierIndex >= 2,
    useGeneratedFrame: true,
  });
}

export function winCinematicCopy(presentation, winnerName, loserName = null) {
  const action = presentation?.kind === 'tsumo' ? 'ツモ' : 'ロン';
  const detail = presentation?.kind === 'ron' && loserName ? `${winnerName}　←　${loserName}` : winnerName;
  return Object.freeze({ action, detail, tierLabel: presentation?.tierLabel ?? '和了' });
}

// 和了の事実を出す前に、直前の捨て牌／ツモ牌を認知するための間。
// ロンは「通るか」の緊張を優先して少し長くする。
export function winSuspenseDuration({ loser = null } = {}) {
  return loser === null ? 850 : 1150;
}
