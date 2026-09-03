// com-characters.js — COMキャラクターのレジストリ (v4 / 2026-09-03 新キャスト9人・思考割当はユーザー指定)
// ここに1エントリ足せばキャラ選択画面へ自動で並ぶ。
// profile は decision-evaluator.js の AI_STYLES キー。voice は音声セット(無ければ無音)。
// portrait は assets/characters_v2/<portrait>_face.webp / _full.webp の接頭辞。
// style は紹介パネル用の傾向表示(1〜5)で、思考ロジックには使わない。
export const COM_CHARACTERS = Object.freeze([
  {
    id: 'hyogo', name: '権藤兵吾', kana: 'ごんどう ひょうご', title: '老練の守り手',
    profile: 'guardian', portrait: 'hyogo', voice: 'hanzo',
    tagline: '守備型・危険牌を切らない',
    description: '老練の守備型。1向聴でもリーチには降り、確実な形しかリーチしない。',
    intro: '左の頬に古傷、白髪まじりの若頭。修羅場をくぐった分だけ放銃を嫌う。相手のリーチには1向聴でも迷わず降り、リーチをかけるのは確実な形だけ。じわじわ点棒を守り切る。',
    quote: '振らなきゃ負けねえ、それだけの話だ',
    style: { attack: 2, defense: 5, call: 2, riichi: 2 },
  },
  {
    id: 'daisuke', name: '小森ダイスケ', kana: 'こもり だいすけ', title: '脳汁ギャンブラー',
    profile: 'daisuke', portrait: 'daisuke', voice: 'joe',
    tagline: '脇目もふらぬ最速あがり',
    description: '相手のリーチや気配は一切見ない。待ちが残り1枚でもリーチ、カンできれば必ずカン。',
    intro: '相手の捨て牌は鳴きたいときしか見ない。裏ドラ期待のリーチ、積極的なカン、ツイてるときは止められない',
    quote: '結局、勝ったもんが偉いんすから',
    style: { attack: 5, defense: 1, call: 3, riichi: 5 },
  },
  {
    id: 'rarapi', name: 'ララピ', kana: 'ららぴ', title: '前のめりの小さな雀士',
    profile: 'striker', portrait: 'rarapi', voice: 'himeko',
    tagline: '攻撃型・鳴いて速度を上げる',
    description: '前のめりの攻撃型。押し切るまで降りず、薄い待ちでもリーチする。',
    intro: '雑誌モデルの小学生。撮影の合間に覚えた麻雀は、とにかく前へ前へ。鳴いて速度を上げ、薄い待ちでもリーチ、相手のリーチにも押し切る。怖いもの知らずの打ち筋。',
    quote: 'まって、それ、ロンだよ？',
    style: { attack: 5, defense: 1, call: 4, riichi: 5 },
  },
  {
    id: 'ran', name: '城戸ラン', kana: 'きど らん', title: '冷静な回し打ち',
    profile: 'defense', portrait: 'ran',
    tagline: 'ガイドの「守り」思考',
    description: '手の価値よりリスクが高ければ回し、無理なら降りる。ガイドの守り思考と同一。',
    intro: '感情を表に出さない女性雀士。手の価値と危険を秤にかけ、リスクが上回れば安全牌を切りながら形を保つ回し打ち。無理と見れば潔く降りる。打ち手ガイドの「守り」思考そのもの。',
    quote: '押す理由がないなら、押さない',
    style: { attack: 2, defense: 4, call: 2, riichi: 3 },
  },
  {
    id: 'toma', name: '一色トーマ', kana: 'いっしき とうま', title: '天秤の弁護士',
    profile: 'balance', portrait: 'toma',
    tagline: 'ガイドの「バランス」思考',
    description: '攻めと守りの中間。手の価値と危険を天秤にかける。ガイドのバランス思考と同一。',
    intro: '法律事務所の若手弁護士。攻めと守りの中間で、手の価値が危険を上回るときだけ勝負に出る。順位を上げねばならない土壇場では安手でも押す。打ち手ガイドの「バランス」思考そのもの。',
    quote: '見合うかどうか、判断はそこだけです',
    style: { attack: 3, defense: 3, call: 2, riichi: 3 },
  },
  {
    id: 'lime', name: 'LIME', kana: 'らいむ', title: '高打点狙いのゲーマー',
    profile: 'attack', portrait: 'lime',
    tagline: 'ガイドの「攻め」思考',
    description: '高めを狙って多少のリスクは冒す。ガイドの攻め思考と同一。',
    intro: 'ライム色の髪にマゼンタの眼鏡、プロeスポーツ選手。高めを狙って多少のリスクは平気で冒す。テンパイなら無筋も押し、勝負手は一気に仕上げる。打ち手ガイドの「攻め」思考そのもの。',
    quote: '安手であがっても勝てないっしょ',
    style: { attack: 4, defense: 2, call: 3, riichi: 4 },
  },
  {
    id: 'ronbolt', name: 'ロンボルト', kana: 'ろんぼると', title: '無感情な効率マシン',
    profile: 'analyst', portrait: 'ronbolt',
    tagline: '効率型・受入枚数を最大化',
    description: '標準バランスの効率派。押し引きも鳴きも教科書どおり。',
    intro: '受け入れ効率を最大にする手を淡々と選び、ロマンのかけらもない。最も素直とも言える',
    quote: 'その選択は非効率です',
    style: { attack: 3, defense: 3, call: 3, riichi: 3 },
  },
  {
    id: 'wanfu', name: 'ワンフー', kana: 'わんふー', title: '鉄壁のダマ職人',
    profile: 'chen', portrait: 'wanfu',
    tagline: '鉄壁のダマ職人',
    description: '絶対にリーチしない。高めは狙わず安くても早くあがる。リーチされたら徹底的に降りる。',
    intro: '恰幅のよい料理店の主人。絶対にリーチをかけず、安くても早くあがる。相手にリーチされたら徹底的に降りる。派手さはないが、河から手が読めないので一番厄介な相手。',
    quote: 'リーチ？ 私はしませんよ',
    style: { attack: 2, defense: 5, call: 4, riichi: 1 },
  },
  {
    id: 'sawaka', name: 'サワカ・アックス', kana: 'さわか あっくす', title: '手役ロマン派',
    profile: 'sawaka', portrait: 'sawaka',
    tagline: '手役ロマン派',
    description: 'ホンイツ・国士無双・大三元・四暗刻が見えたら一直線。南場で沈むと攻めに変わる。',
    intro: 'グラフィックデザイナー。配牌に絵が見えると一直線で、ホンイツ、国士無双、大三元、四暗刻を追いかける。南場で沈んでいると攻めに転じる。決まったときの破壊力は全キャラ随一。',
    quote: 'この配牌、絵になるでしょ',
    style: { attack: 4, defense: 2, call: 2, riichi: 3 },
  },
]);

export function characterById(id) {
  return COM_CHARACTERS.find(character => character.id === id) ?? null;
}

export const DEFAULT_OPPONENTS = Object.freeze(['hyogo', 'daisuke', 'rarapi']);

export const CHARACTER_ASSET_DIR = 'assets/characters_v2';
export function characterFaceSrc(character) { return `${CHARACTER_ASSET_DIR}/${character.portrait}_face.webp`; }
export function characterFullSrc(character) { return `${CHARACTER_ASSET_DIR}/${character.portrait}_full.webp`; }

export const STYLE_AXES = Object.freeze([
  { key: 'attack', label: '攻め' },
  { key: 'defense', label: '守り' },
  { key: 'call', label: '鳴き' },
  { key: 'riichi', label: 'リーチ' },
]);
