// tilesvg.js — 麻雀牌専用の固定ベクター牌面
//
// 全37面（通常34種＋赤五3種）は、牌専用に制作されたSVG輪郭データを使用する。
// 実行時の <text>、font-family、OSフォント描画には一切依存しない。
// 元アート: FluffyStuff/riichi-mahjong-tiles (Public Domain / CC0)

const MANZU = [
  'Man1.svg', 'Man2.svg', 'Man3.svg', 'Man4.svg', 'Man5.svg',
  'Man6.svg', 'Man7.svg', 'Man8.svg', 'Man9.svg',
];

const PINZU = [
  'Pin1.svg', 'Pin2.svg', 'Pin3.svg', 'Pin4.svg', 'Pin5.svg',
  'Pin6.svg', 'Pin7.svg', 'Pin8.svg', 'Pin9.svg',
];

const SOUZU = [
  'Sou1.svg', 'Sou2.svg', 'Sou3.svg', 'Sou4.svg', 'Sou5.svg',
  'Sou6.svg', 'Sou7.svg', 'Sou8.svg', 'Sou9.svg',
];

const HONORS = [
  'Ton.svg', 'Nan.svg', 'Shaa.svg', 'Pei.svg',
  'Haku.svg', 'Hatsu.svg', 'Chun.svg',
];

const RED_FIVES = new Map([
  [4, 'Man5-Dora.svg'],
  [13, 'Pin5-Dora.svg'],
  [22, 'Sou5-Dora.svg'],
]);

const FACE_FILES = [...MANZU, ...PINZU, ...SOUZU, ...HONORS];
const ASSET_ROOT = new URL('../../assets/tile_faces_v10/', import.meta.url);

export function tileFaceFile(kind, red = false) {
  if (!Number.isInteger(kind) || kind < 0 || kind >= FACE_FILES.length) {
    throw new RangeError(`Invalid mahjong tile kind: ${kind}`);
  }
  return red && RED_FIVES.has(kind) ? RED_FIVES.get(kind) : FACE_FILES[kind];
}

export function tileFaceAsset(kind, red = false) {
  return new URL(tileFaceFile(kind, red), ASSET_ROOT).href;
}

export function svgFace(kind, red = false) {
  const file = tileFaceFile(kind, red);
  const src = tileFaceAsset(kind, red);
  return `<svg class="tile-face-art" viewBox="0 0 60 82" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true" data-face="${file}">` +
    `<image href="${src}" x="0" y="1" width="60" height="80" preserveAspectRatio="xMidYMid meet"/>` +
    `</svg>`;
}
