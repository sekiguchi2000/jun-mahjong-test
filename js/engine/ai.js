// ai.js — Gameのactor契約と共通DecisionEvaluatorをつなぐ薄いadapter
// 評価本体は本人手牌＋公開情報だけを受け取るdecision-evaluator.jsに集約する。

import {
  AI_STYLES,
  DecisionEvaluator,
  isForbiddenLastPlaceWin,
  pickSafeTile,
  pickSafeTileDetailed,
  remainingCopies,
  visibleCounts,
} from './decision-evaluator.js?v=20';

export { AI_STYLES, DecisionEvaluator, isForbiddenLastPlaceWin } from './decision-evaluator.js?v=20';

export class ComActor {
  constructor(name = 'COM', profile = 'analyst') {
    this.name = name;
    this.profile = AI_STYLES[profile] ? profile : 'analyst';
    this.isHuman = false;
    this.evaluator = new DecisionEvaluator();
    this.lastDecisionAnalysis = null;
    this.lastDecisionTrace = null;
  }

  decide(decision, trace, analysis = null) {
    this.lastDecisionAnalysis = analysis;
    this.lastDecisionTrace = {
      actor: this.name,
      profile: this.profile,
      ...trace,
      decision: decision?.action ?? 'pass',
    };
    if (analysis) {
      Object.assign(this.lastDecisionTrace, {
        evaluatorVersion: analysis.evaluatorVersion,
        facts: analysis.facts,
        estimates: analysis.estimates,
        hardConstraints: analysis.hardConstraints,
        candidates: analysis.candidates,
        selected: analysis.selected,
        decisiveFactors: analysis.decisiveFactors,
        confidence: analysis.confidence,
        completeness: analysis.completeness,
        elapsedMs: analysis.elapsedMs,
      });
    }
    if (!decision) return null;
    return {
      ...decision,
      ...(Array.isArray(decision.tiles) ? { tiles: [...decision.tiles] } : {}),
    };
  }

  async onTurn(view, options) {
    // 降りの粘着 (EV監査1号 2026-09-02): 局が変わったら降り状態をリセット
    const roundKey = `${view.public?.roundWindIdx}:${view.public?.kyoku}:${view.public?.honba}`;
    if (this.foldRoundKey !== roundKey) { this.foldRoundKey = roundKey; this.foldCommitted = false; }
    const analysis = this.evaluator.evaluateTurn(view, options, this.profile,
      { foldCommitted: this.foldCommitted === true });
    // この手番で降り系の判断をしたら、以後この局は降り続ける
    const factors = new Set((analysis.decisiveFactors ?? []).map(factor => factor.code));
    if (factors.has('FOLD_ON_RIICHI_THREAT') || factors.has('CHEAP_TENPAI_FOLD') ||
        factors.has('LEAD_PROTECT_FOLD') || factors.has('STICKY_FOLD')) {
      this.foldCommitted = true;
    }
    return this.decide(analysis.selected.action, analysis.legacyTrace, analysis);
  }

  async onClaim(view, offer) {
    const analysis = this.evaluator.evaluateClaim(view, offer, this.profile);
    return this.decide(analysis.selected.action, analysis.legacyTrace, analysis);
  }

  // 見えている牌(自分の手牌・全員の河・副露・ドラ表示牌)のカウント
  visibleCounts(view) {
    return visibleCounts(view);
  }

  remainingCopies(visible, kind) {
    return remainingCopies(visible, kind);
  }

  // 安全牌選び。複数リーチ時の現物は相手ごとに判定し、全員への現物
  // （各河の積集合）だけを完全安全として扱う。
  pickSafeTile(handAll, threats, view) {
    return pickSafeTile(handAll, threats, view);
  }

  pickSafeTileDetailed(handAll, threats, view) {
    return pickSafeTileDetailed(handAll, threats, view);
  }
}
