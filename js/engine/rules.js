// rules.js — 全ルール設定の一元管理
// 「あらゆるルールは設定で変えられる」の実装本体。
// ゲームロジックはこのオブジェクトだけを参照し、ルール値をハードコードしない。

export const DEFAULT_RULES = Object.freeze({
  // --- 対局の長さ ---
  gameLength: 'tonnan',      // 'tonpuu'(東風) | 'tonnan'(東南=半荘) | 'issou'(一荘=東南西北)
  // --- 赤ドラ ---
  akaDora: 3,                // 0=なし / 3=各色5に1枚 / 4=筒子のみ2枚 など枚数指定(0-4)
  // --- 喰いタン ---
  kuitan: true,              // true=あり(喰いタン可) / false=なし
  // --- 後付け ---
  atozuke: true,             // true=あり(役の後付け可) / false=なし(完全先付け)
  // --- 点数まわり ---
  startPoints: 25000,        // 配給原点
  returnPoints: 30000,       // 返し点(オカ計算用)
  uma: [20, 10, -10, -20],   // 順位ウマ
  kiriage: false,            // 切り上げ満貫(30符4翻/60符3翻を満貫扱い)
  // --- リーチ関連 ---
  ippatsu: true,             // 一発あり
  uraDora: true,             // 裏ドラあり
  kanUra: true,              // 槓裏あり
  kanDora: true,             // 槓ドラあり
  riichiBelow1000: false,    // 持ち点1000未満でもリーチ可
  // --- 和了・特殊ルール ---
  doubleYakuman: true,       // ダブル役倍(大四喜・国士13面待ち等)あり
  kazoeYakuman: true,        // 数え役満あり(false=三倍満止まり)
  kokushiAnkanRon: false,    // 国士無双の暗槓ロンあり
  renhou: 'mangan',          // 人和: 'none' | 'mangan' | 'yakuman'
  // --- 流局・途中流局 ---
  tochuRyukyoku: true,       // 九種九牌・四風連打・四家リーチ・四槓散了の途中流局あり
  nagashiMangan: true,       // 流し満貫あり
  tenpaiRyukyoku: true,      // 形式聴牌あり(ノーテン罰符の聴牌判定に形式聴牌を認める)
  // --- 連荘・終局 ---
  agariYame: true,           // オーラストップ目の和了やめ可
  tenpaiRenchan: true,       // 親の聴牌連荘(false=和了連荘)
  tobiEnd: true,             // 飛び(持ち点0未満)で終局
  minusRiichi: false,        // 供託で0未満になるリーチ可
  // --- フリテン・細目 ---
  furitenRon: false,         // フリテンロン(同巡内以外)可 ※通常false
  pao: true,                 // 大三元・大四喜の包(パオ)あり
});

// UIの設定画面が使うメタ情報(表示名・選択肢)。設定項目を増やすときはここにも足す。
export const RULE_SCHEMA = [
  { key: 'gameLength', label: '対局の長さ', type: 'choice',
    options: [['tonpuu', '東風戦'], ['tonnan', '東南戦(半荘)'], ['issou', '一荘戦']] },
  { key: 'akaDora', label: '赤ドラ', type: 'choice',
    options: [[0, 'なし'], [3, '3枚(各色1)'], [4, '4枚(筒子2)']] },
  { key: 'kuitan', label: '喰いタン', type: 'bool' },
  { key: 'atozuke', label: '後付け', type: 'bool', labels: ['あり', 'なし(完全先付け)'] },
  { key: 'kiriage', label: '切り上げ満貫', type: 'bool' },
  { key: 'ippatsu', label: '一発', type: 'bool' },
  { key: 'uraDora', label: '裏ドラ', type: 'bool' },
  { key: 'kanDora', label: '槓ドラ', type: 'bool' },
  { key: 'kanUra', label: '槓裏', type: 'bool' },
  { key: 'kazoeYakuman', label: '数え役満', type: 'bool' },
  { key: 'tochuRyukyoku', label: '途中流局', type: 'bool' },
  { key: 'nagashiMangan', label: '流し満貫', type: 'bool' },
  { key: 'agariYame', label: '和了やめ', type: 'bool' },
  { key: 'tobiEnd', label: '飛び終了', type: 'bool' },
  { key: 'startPoints', label: '配給原点', type: 'choice',
    options: [[25000, '25000点'], [30000, '30000点'], [27000, '27000点']] },
];

export function makeRules(overrides = {}) {
  return { ...DEFAULT_RULES, ...overrides };
}
