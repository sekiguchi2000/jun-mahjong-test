// are-report.js — 「あれ?」ボタン
//
// テスターが判断に違和感を覚えた瞬間の局面(view)とガイド表示をワンタップで記録し、
// まとめてJSONに書き出す。評価器は決定的なので、viewさえあれば判断は完全に再現でき、
// そのまま局面カルテ(tests/test_ai_karte.mjs)のfixtureになる。
// 記録するのは本人に見えている情報(自分の手牌+公開情報)だけ。

import { DECISION_EVALUATOR_VERSION } from '../engine/decision-evaluator.js?v=18';

const STORAGE_KEY = 'jun-are-reports-v1';
const MAX_REPORTS = 60;

function loadReports() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveReports(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function areReportCount() {
  return loadReports().length;
}

export function captureAreReport({ view, options = null, offer = null, coachShown = null } = {}) {
  if (!view || typeof view !== 'object') return { ok: false, reason: 'NO_VIEW' };
  let entry;
  try {
    entry = {
      version: 1,
      evaluatorVersion: DECISION_EVALUATOR_VERSION,
      capturedAt: new Date().toISOString(),
      phase: offer ? 'claim' : 'turn',
      options: options ? JSON.parse(JSON.stringify(options)) : null,
      offer: offer ? JSON.parse(JSON.stringify(offer)) : null,
      view: JSON.parse(JSON.stringify(view)),
      coachShown,
    };
  } catch {
    return { ok: false, reason: 'SERIALIZE_FAILED' };
  }
  const list = loadReports();
  list.push(entry);
  while (list.length > MAX_REPORTS) list.shift();
  const stored = saveReports(list);
  return { ok: true, stored, count: list.length };
}

export function exportAreReports() {
  const list = loadReports();
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return {
    count: list.length,
    filename: `are_reports_${stamp}.json`,
    json: JSON.stringify({ format: 'jun-are-reports', version: 1, reports: list }, null, 1),
  };
}

export function clearAreReports() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
