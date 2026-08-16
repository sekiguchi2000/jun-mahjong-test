// gameplay-controls.js — 対局中の補助表示と鳴き設定に関する純粋判定
import { toCounts } from '../engine/tiles.js';
import { shanten, waitingTiles } from '../engine/shanten.js';

export const NO_CALLS_STORAGE_KEY = 'jun-mahjong-no-calls';

export function waitKindsForHand(hand, meldCount = 0) {
  if (!Array.isArray(hand)) return [];
  const counts = toCounts(hand);
  return shanten(counts, meldCount) === 0 ? waitingTiles(counts, meldCount) : [];
}

export function remainingCopies(kind, visibleCounts) {
  const seen = Number(visibleCounts?.[kind] || 0);
  return Math.max(0, Math.min(4, 4 - seen));
}

export function shouldSuppressClaim(noCalls, offer) {
  return Boolean(noCalls && offer?.type === 'call');
}

export function loadNoCallsPreference(storage) {
  try {
    const value = storage?.getItem(NO_CALLS_STORAGE_KEY);
    return value === '1' || value === 'true';
  } catch {
    return false;
  }
}

export function saveNoCallsPreference(storage, enabled) {
  try {
    storage?.setItem(NO_CALLS_STORAGE_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}
