// com-characters.js — COMキャラクターのレジストリ (2026-08-20)
// ここに1エントリ足せばタイトルの対戦相手セレクトに自動で並ぶ。
// profile は decision-evaluator.js の AI_STYLES キー。voice は音声セット(無ければ無音)。
export const COM_CHARACTERS = Object.freeze([
  {
    id: 'hanzou', name: '半蔵', profile: 'guardian', portrait: 'hanzou', voice: 'hanzo',
    tagline: '守備型・危険牌を切らない',
    description: '老練の守備型。1向聴でもリーチには降り、確実な形しかリーチしない。',
  },
  {
    id: 'joe', name: 'ジョー', profile: 'analyst', portrait: 'joe', voice: 'joe',
    tagline: '効率型・受入枚数を最大化',
    description: '標準バランスの効率派。押し引きも鳴きも教科書どおり。',
  },
  {
    id: 'himeko', name: 'ひめ子', profile: 'striker', portrait: 'himeko', voice: 'himeko',
    tagline: '攻撃型・鳴いて速度を上げる',
    description: '前のめりの攻撃型。押し切るまで降りず、薄い待ちでもリーチする。',
  },
  {
    id: 'mamoru', name: 'まもる', profile: 'defense', portrait: 'mamoru',
    tagline: 'ガイドの「守り」思考',
    description: '手の価値よりリスクが高ければ回し、無理なら降りる。ガイドの守り思考と同一。',
  },
  {
    id: 'seitaro', name: '征太郎', profile: 'balance', portrait: 'seitaro',
    tagline: 'ガイドの「バランス」思考',
    description: '攻めと守りの中間。手の価値と危険を天秤にかける。ガイドのバランス思考と同一。',
  },
  {
    id: 'gouda', name: '剛田', profile: 'attack', portrait: 'gouda',
    tagline: 'ガイドの「攻め」思考',
    description: '高めを狙って多少のリスクは冒す。ガイドの攻め思考と同一。',
  },
  {
    id: 'daisuke', name: 'ダイスケ', profile: 'daisuke', portrait: 'daisuke',
    tagline: '脇目もふらぬ最速あがり',
    description: '相手のリーチや気配は一切見ない。待ちが残り1枚でもリーチ、カンできれば必ずカン。',
  },
  {
    id: 'chen', name: '陳', profile: 'chen', portrait: 'chen',
    tagline: '鉄壁のダマ職人',
    description: '絶対にリーチしない。高めは狙わず安くても早くあがる。リーチされたら徹底的に降りる。',
  },
  {
    id: 'sawaka', name: 'サワカ', profile: 'sawaka', portrait: 'sawaka',
    tagline: '手役ロマン派',
    description: 'ホンイツ・国士無双・大三元・四暗刻が見えたら一直線。南場で沈むと攻めに変わる。',
  },
]);

export function characterById(id) {
  return COM_CHARACTERS.find(character => character.id === id) ?? null;
}

export const DEFAULT_OPPONENTS = Object.freeze(['hanzou', 'joe', 'himeko']);
