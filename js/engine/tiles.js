// tiles.js — 牌の定義とユーティリティ
// 牌種(kind)は 0..33 の整数:
//   0- 8: 萬子 1m-9m / 9-17: 筒子 1p-9p / 18-26: 索子 1s-9s
//   27-30: 東南西北 / 31-33: 白發中
// 牌インスタンスは { kind, red } (red=赤5フラグ)。id は山生成時に付与。

export const MAN = 0, PIN = 9, SOU = 18;
export const TON = 27, NAN = 28, SHA = 29, PEI = 30, HAKU = 31, HATSU = 32, CHUN = 33;
export const KIND_COUNT = 34;

export function suitOf(kind) {
  if (kind < 9) return 'm';
  if (kind < 18) return 'p';
  if (kind < 27) return 's';
  return 'z'; // 字牌
}

export function numOf(kind) {
  // 数牌なら 1-9、字牌なら 1-7 (東=1..中=7)
  return kind < 27 ? (kind % 9) + 1 : kind - 26;
}

export function isHonor(kind) { return kind >= 27; }
export function isTerminal(kind) { return !isHonor(kind) && (numOf(kind) === 1 || numOf(kind) === 9); }
export function isYaochu(kind) { return isHonor(kind) || isTerminal(kind); }
export function isSimple(kind) { return !isYaochu(kind); }
export function isDragon(kind) { return kind >= HAKU; }
export function isWind(kind) { return kind >= TON && kind <= PEI; }

// 表示名(日本語) と 短縮表記(1m, 5p, E, W...)
const HONOR_NAMES = ['東', '南', '西', '北', '白', '發', '中'];
export function tileName(kind, red = false) {
  if (isHonor(kind)) return HONOR_NAMES[kind - 27];
  const suit = { m: '萬', p: '筒', s: '索' }[suitOf(kind)];
  return `${red ? '赤' : ''}${numOf(kind)}${suit}`;
}
export function tileCode(kind, red = false) {
  if (isHonor(kind)) return 'ESWNPFC'[kind - 27];
  return `${red ? '0' : numOf(kind)}${suitOf(kind)}`;
}

// "123m456p789s11z" 形式の文字列 → kind配列 (テスト用)。0=赤5。
export function parseTiles(str) {
  const result = [];
  let nums = [];
  for (const ch of str) {
    if (ch >= '0' && ch <= '9') { nums.push(+ch); continue; }
    const base = { m: MAN, p: PIN, s: SOU, z: 27 }[ch];
    if (base === undefined) throw new Error(`bad tile string: ${str}`);
    for (const n of nums) {
      if (ch === 'z') result.push({ kind: 27 + n - 1, red: false });
      else if (n === 0) result.push({ kind: base + 4, red: true }); // 赤5
      else result.push({ kind: base + n - 1, red: false });
    }
    nums = [];
  }
  return result;
}

// 牌インスタンス配列 → 34種カウント配列
export function toCounts(tiles) {
  const c = new Array(KIND_COUNT).fill(0);
  for (const t of tiles) c[t.kind ?? t]++;
  return c;
}

// ドラ表示牌 → ドラ牌kind (次の牌)
export function doraFromIndicator(kind) {
  if (kind < 27) { // 数牌: 9の次は1
    const base = kind - (kind % 9);
    return base + ((kind % 9) + 1) % 9;
  }
  if (kind <= PEI) return kind === PEI ? TON : kind + 1; // 北→東
  return kind === CHUN ? HAKU : kind + 1;                 // 中→白
}
