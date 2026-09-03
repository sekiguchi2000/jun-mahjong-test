// yaku-guide.js — ヘルプ画面用の役一覧・符計算・点数早見の説明データ (v1 / 2026-09-03)
// 翻数・条件は本エンジン(yaku.js / score.js)の実装に合わせる。
// kuisagari: 鳴くと1翻下がる / menzen: 門前限定 / rule: ルール設定に依存する項目

export const YAKU_GROUPS = Object.freeze([
  {
    title: '1翻',
    items: [
      { name: 'リーチ', han: 1, menzen: true, how: '門前でテンパイし、1000点を出して宣言する。', note: '宣言後は手を変えられない。一発・裏ドラの権利がつく。' },
      { name: '一発', han: 1, menzen: true, how: 'リーチ後、次の自分のツモまでにあがる。', note: '間に鳴きが入ると消える。', rule: 'ippatsu' },
      { name: '門前清自摸和', han: 1, menzen: true, how: '門前でツモあがり。', note: '' },
      { name: '断么九(タンヤオ)', han: 1, how: '2〜8の数牌だけで作る。字牌と1・9を使わない。', note: '鳴いてもよいかはルール「喰いタン」で決まる。', rule: 'kuitan' },
      { name: '平和(ピンフ)', han: 1, menzen: true, how: '4組すべて順子、雀頭は役牌以外、待ちは両面。', note: '符は必ず20(ツモ)または30(ロン)。' },
      { name: '一盃口', han: 1, menzen: true, how: '同じ順子を2組作る(例: 345萬を2組)。', note: '' },
      { name: '役牌', han: 1, how: '白・發・中、場風、自風のどれかを刻子(または槓子)にする。', note: '場風と自風が同じ牌なら2翻(ダブ東など)。' },
      { name: '嶺上開花', han: 1, how: 'カンしたあとの嶺上牌でツモあがり。', note: '' },
      { name: '槍槓', han: 1, how: '他家が加槓した牌でロンする。', note: '' },
      { name: '海底摸月', han: 1, how: '山の最後の牌でツモあがり。', note: '' },
      { name: '河底撈魚', han: 1, how: '局の最後の捨て牌でロン。', note: '' },
    ],
  },
  {
    title: '2翻',
    items: [
      { name: 'ダブルリーチ', han: 2, menzen: true, how: '第一打でリーチ。', note: 'それまでに鳴きがあると成立しない。' },
      { name: '七対子', han: 2, menzen: true, how: '対子を7組作る。', note: '同じ牌4枚を2組には数えない。符は固定で25。' },
      { name: '対々和', han: 2, how: '4組すべてを刻子(槓子)にする。', note: '' },
      { name: '三暗刻', han: 2, how: '暗刻を3組作る。', note: 'ロンで完成した刻子は明刻扱い。' },
      { name: '三色同順', han: 2, kuisagari: true, how: '萬子・筒子・索子で同じ数字の順子を作る(例: 456萬 456筒 456索)。', note: '' },
      { name: '三色同刻', han: 2, how: '3色で同じ数字の刻子を作る。', note: '' },
      { name: '一気通貫', han: 2, kuisagari: true, how: '1色で123・456・789を揃える。', note: '' },
      { name: '混全帯么九(チャンタ)', han: 2, kuisagari: true, how: '全組と雀頭に1・9か字牌を含める。', note: '順子は123か789だけ。' },
      { name: '三槓子', han: 2, how: 'カンを3回する。', note: '' },
      { name: '小三元', han: 2, how: '白發中のうち2種を刻子、残り1種を雀頭にする。', note: '役牌2翻と合わせて実質4翻。' },
      { name: '混老頭', han: 2, how: '1・9と字牌だけで作る。', note: '必ず対々和か七対子になるので実質4翻。' },
    ],
  },
  {
    title: '3翻',
    items: [
      { name: '混一色(ホンイツ)', han: 3, kuisagari: true, how: '1色の数牌と字牌だけで作る。', note: '' },
      { name: '純全帯么九(純チャン)', han: 3, kuisagari: true, how: '全組と雀頭に1か9を含める。字牌は使わない。', note: '' },
      { name: '二盃口', han: 3, menzen: true, how: '一盃口を2組作る。', note: '七対子とは複合しない。' },
    ],
  },
  {
    title: '6翻',
    items: [
      { name: '清一色(チンイツ)', han: 6, kuisagari: true, how: '1色の数牌だけで作る。', note: '' },
    ],
  },
  {
    title: '役満',
    items: [
      { name: '国士無双', yakuman: true, menzen: true, how: '1・9・字牌の13種を1枚ずつ+そのどれか1枚。', note: '13面待ちはダブル役満(ルール設定)。' },
      { name: '四暗刻', yakuman: true, menzen: true, how: '暗刻を4組作る。', note: '単騎待ちはダブル役満(ルール設定)。ロンで完成した刻子は明刻扱いなので、シャンポン待ちのロンでは三暗刻+対々和になる。' },
      { name: '大三元', yakuman: true, how: '白・發・中をすべて刻子にする。', note: '3種目を鳴かせた人が包(パオ)責任を負う(ルール設定)。' },
      { name: '字一色', yakuman: true, how: '字牌だけで作る。', note: '' },
      { name: '緑一色', yakuman: true, how: '發と索子の2・3・4・6・8だけで作る。', note: '' },
      { name: '清老頭', yakuman: true, how: '1と9だけで作る。', note: '' },
      { name: '小四喜', yakuman: true, how: '東南西北のうち3種を刻子、残り1種を雀頭にする。', note: '' },
      { name: '大四喜', yakuman: true, how: '東南西北をすべて刻子にする。', note: 'ダブル役満(ルール設定)。包(パオ)あり。' },
      { name: '四槓子', yakuman: true, how: 'カンを4回する。', note: '' },
      { name: '九蓮宝燈', yakuman: true, menzen: true, how: '1色で1112345678999+同色の任意1枚。', note: '9面待ちの純正形はダブル役満(ルール設定)。' },
      { name: '天和', yakuman: true, how: '親が配牌であがっている。', note: '' },
      { name: '地和', yakuman: true, how: '子が第一ツモであがる。', note: 'それまでに鳴きがあると成立しない。' },
    ],
  },
  {
    title: '役ではないが翻がつくもの',
    items: [
      { name: 'ドラ', han: 1, how: 'ドラ表示牌の次の牌を持っていると1枚につき1翻。', note: '役がないとあがれない。' },
      { name: '赤ドラ', han: 1, how: '赤い5を持っていると1枚につき1翻。', note: '枚数はルール設定。', rule: 'akaDora' },
      { name: '裏ドラ', han: 1, how: 'リーチであがると裏の表示牌もドラになる。', note: '', rule: 'uraDora' },
      { name: '槓ドラ・槓裏', han: 1, how: 'カンごとにドラ表示牌が1枚増える。', note: '', rule: 'kanDora' },
    ],
  },
]);

// 符の内訳。engine: yaku.js calcFu と同じ規則
export const FU_RULES = Object.freeze({
  base: 20,
  special: [
    { label: '平和ツモ', fu: 20, note: '固定' },
    { label: '平和ロン', fu: 30, note: '固定' },
    { label: '七対子', fu: 25, note: '固定' },
    { label: '鳴いていて符が20のまま(喰い平和形)', fu: 30, note: '30符に繰り上げ' },
  ],
  additions: [
    { label: '門前ロン', fu: 10 },
    { label: 'ツモあがり', fu: 2 },
    { label: '雀頭が役牌(白發中・場風・自風)', fu: 2, note: '場風かつ自風なら4' },
    { label: '待ちがカンチャン・ペンチャン・単騎', fu: 2 },
  ],
  sets: [
    { label: '明刻', chunchan: 2, yaochu: 4 },
    { label: '暗刻', chunchan: 4, yaochu: 8 },
    { label: '明槓', chunchan: 8, yaochu: 16 },
    { label: '暗槓', chunchan: 16, yaochu: 32 },
  ],
  rounding: '合計を10の位で切り上げる(例: 32符→40符)。',
  examples: [
    { hand: '門前ロン・両面待ち・順子だけ・雀頭は数牌', calc: '20+10 = 30符', fu: 30 },
    { hand: '門前ツモ・カンチャン待ち・中張の暗刻1組', calc: '20+2+2+4 = 28 → 30符', fu: 30 },
    { hand: '門前ロン・単騎待ち・1の暗刻1組・雀頭は白', calc: '20+10+2+8+2 = 42 → 50符', fu: 50 },
    { hand: '役牌をポン(明刻)・両面待ち・ロン', calc: '20+4 = 24 → 30符', fu: 30 },
  ],
});

// 点数の計算方法。engine: score.js basePoints
export const SCORE_RULES = Object.freeze({
  formula: '基本点 = 符 × 2^(翻+2)。子のロンは基本点×4、親のロンは×6。ツモは子が基本点×1(親には×2)、親は全員から×2。100点未満は切り上げ。',
  limits: [
    { name: '満貫', cond: '基本点2000以上(5翻、4翻40符以上、3翻70符以上)', ko: '8000', oya: '12000' },
    { name: '跳満', cond: '6〜7翻', ko: '12000', oya: '18000' },
    { name: '倍満', cond: '8〜10翻', ko: '16000', oya: '24000' },
    { name: '三倍満', cond: '11〜12翻', ko: '24000', oya: '36000' },
    { name: '数え役満', cond: '13翻以上(ルール設定)', ko: '32000', oya: '48000' },
    { name: '役満', cond: '役満役', ko: '32000', oya: '48000' },
  ],
});

// 早見表の計算(ロン点数)。engine: score.js と同じ式
export function ronPoints(han, fu, { dealer = false, kazoeYakuman = true } = {}) {
  if (han >= 13 && kazoeYakuman) return dealer ? 48000 : 32000;
  let base = fu * Math.pow(2, 2 + han);
  if (han >= 11) base = 6000;
  else if (han >= 8) base = 4000;
  else if (han >= 6) base = 3000;
  else if (base >= 2000) base = 2000;
  const raw = base * (dealer ? 6 : 4);
  return Math.ceil(raw / 100) * 100;
}

export const SCORE_TABLE_FU = Object.freeze([20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110]);
export const SCORE_TABLE_HAN = Object.freeze([1, 2, 3, 4, 5, 6, 8, 11, 13]);

export const HOW_TO_PLAY = Object.freeze([
  { title: 'あがりの形', body: '4組(順子か刻子)+雀頭1組の14枚、または七対子・国士無双。役が1つ以上ないとあがれない。' },
  { title: '打牌', body: '手牌の牌を1回タップで選び、もう1回タップで切る。ツモ牌はそのまま切ればツモ切り。' },
  { title: '鳴き', body: '他家の捨て牌でポン・チー・カンができるときは下にボタンが出る。鳴くと門前限定の役(リーチ・平和・一盃口など)は使えず、一部の役は1翻下がる。' },
  { title: 'リーチ', body: 'テンパイしたらリーチボタンが出る。1000点を供託し、以後は手を変えられない。あがれば一発・裏ドラの権利がつく。' },
  { title: 'フリテン', body: '自分の捨て牌に待ち牌があるとロンできない(ツモならあがれる)。リーチ後に見逃した場合も同じ。' },
  { title: '流局', body: '山が尽きるとテンパイ者がノーテン者から罰符(合計3000点)を受け取る。親がテンパイなら連荘。' },
  { title: '打ち手ガイド', body: 'Lv2で解禁。あなたと同じ公開情報だけで候補と理由を説明する。COMの手牌や山は見ない。' },
  { title: '「あれ?」ボタン', body: 'COMやガイドの動きに違和感があったら押す。その局面が記録され、中断メニューから書き出せる。' },
]);
