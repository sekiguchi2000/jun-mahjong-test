// audio-manifest.js — 配布物へ同梱する音響assetの唯一の対応表
// 外部URLやruntime TTSは使わない。VOICEVOXの生成済みWAVだけを参照する。

const voice = {};
for (const character of ['hanzo', 'joe', 'himeko']) {
  for (const call of ['riichi', 'pon', 'chi', 'kan', 'ron', 'tsumo']) {
    voice[`${character}.${call}`] = Object.freeze({
      src: `assets/audio/voice/${character}/${call}-v1.wav`,
      gain: call === 'ron' || call === 'tsumo' ? 1 : 0.92,
      critical: call === 'ron' || call === 'tsumo',
    });
  }
  for (const thought of ['defense', 'push', 'efficiency', 'value', 'suit_read']) {
    voice[`${character}.thought-${thought}`] = Object.freeze({
      src: `assets/audio/voice/${character}/thought-${thought}-v1.wav`,
      gain: 0.86,
    });
  }
}

export const AUDIO_MANIFEST = Object.freeze({
  bgm: Object.freeze({
    'night-private-table': Object.freeze({
      src: 'assets/audio/music/night_private_table_loop_v1.ogg',
      loop: true,
      gain: 0.78,
    }),
  }),
  voice: Object.freeze(voice),
  sfx: Object.freeze({
    'tile-discard': Object.freeze({
      src: 'assets/audio/sfx/tile_discard_v2.ogg',
      gain: 0.72,
    }),
    'ui-button': Object.freeze({
      src: 'assets/audio/sfx/ui_button_v1.ogg',
      gain: 0.52,
    }),
    'call-accent': Object.freeze({
      src: 'assets/audio/sfx/call_accent_v1.ogg',
      gain: 0.66,
    }),
    // v124 演出用(tools/make-cinematic-sfx.mjs で合成)
    'stick-drop': Object.freeze({ src: 'assets/audio/sfx/stick_drop_v1.ogg', gain: 0.7 }),
    'slam': Object.freeze({ src: 'assets/audio/sfx/slam_v1.ogg', gain: 0.8 }),
    'yakuman-hit': Object.freeze({ src: 'assets/audio/sfx/yakuman_hit_v1.ogg', gain: 0.85, critical: true }),
  }),
});

export const CHARACTER_AUDIO_IDS = Object.freeze([null, 'hanzo', 'joe', 'himeko']);

// 収録済みの短文がDecisionAnalysisの事実を越えて断定しない組合せだけを返す。
// 表示本文とは別経路でも「期待値」「序盤」「河」などを捏造しないための境界。
export function selectThoughtVoiceId(player, analysis) {
  const character = CHARACTER_AUDIO_IDS[player];
  if (!character || !analysis || typeof analysis !== 'object') return null;
  const reasons = new Set();
  for (const code of analysis.reasonCodes ?? []) {
    if (typeof code === 'string') reasons.add(code);
  }
  for (const code of analysis.selected?.reasonCodes ?? []) {
    if (typeof code === 'string') reasons.add(code);
  }
  for (const factor of analysis.decisiveFactors ?? []) {
    if (typeof factor?.code === 'string') reasons.add(factor.code);
  }
  for (const constraint of analysis.hardConstraints ?? []) {
    if (constraint?.active === true && typeof constraint.code === 'string') reasons.add(constraint.code);
  }
  if (typeof analysis.legacyTrace?.reason === 'string') reasons.add(analysis.legacyTrace.reason);
  if (reasons.has('SUIT_PRESSURE_AVOIDED')) {
    if (player === 2) {
      const factor = analysis.decisiveFactors?.find?.(item => item?.code === 'SUIT_PRESSURE_AVOIDED');
      const riverSupportsCue = factor?.signals?.some?.(signal =>
        Number.isFinite(signal?.evidence?.offSuitDiscards) && signal.evidence.offSuitDiscards >= 4);
      if (!riverSupportsCue) return null;
    }
    return `${character}.thought-suit_read`;
  }
  if (reasons.has('RIICHI_COMMON_GENBUTSU') ||
      reasons.has('RIICHI_LEAST_RISK_NON_GENBUTSU') ||
      reasons.has('FOLD_ON_RIICHI_THREAT')) {
    return player === 2 ? null : `${character}.thought-defense`;
  }
  if (reasons.has('KNOWN_VALUE_PRESERVED')) {
    return player === 1 ? null : `${character}.thought-value`;
  }
  if (reasons.has('EARLY_EFFICIENCY_PRIORITY')) {
    return `${character}.thought-efficiency`;
  }
  if (reasons.has('EFFICIENCY_EDGE')) {
    return player === 3 ? null : `${character}.thought-efficiency`;
  }
  return null;
}
