import { seatBasis } from './tabletop-projection.js?v=1';

const FACE_NAMES = ['back', 'front', 'left', 'right', 'top', 'bottom'];

/**
 * Project rack depth from the same +R seat basis used by the scene.  Side
 * seats therefore mirror each other physically; top/bottom do not acquire a
 * fake left-to-right size ramp.
 */
export function concealedTileProjection(seat, index, count) {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('index must be a non-negative integer');
  if (!Number.isInteger(count) || count < 1 || index >= count) {
    throw new RangeError('count must be positive and contain index');
  }
  const basis = seatBasis(seat);
  const denominator = Math.max(1, count - 1);
  const rowPosition = index / denominator;
  const alongR = (rowPosition * 2) - 1;
  const tableDepth = ((basis.R.y * alongR) + 1) / 2;
  return Object.freeze({
    rowPosition,
    tableDepth,
    scale: 0.86 + (tableDepth * 0.14),
  });
}

/**
 * A concealed tile is a real six-faced CSS cuboid. The seat and index are data,
 * not a bitmap rotation: CSS can project every tile from the table camera.
 */
export function concealedTileCuboid(seat, index, count) {
  const projection = concealedTileProjection(seat, index, count);
  const tile = document.createElement('div');
  tile.className = `btile cuboid-tile cuboid-seat-${seat}`;
  tile.dataset.seat = String(seat);
  tile.dataset.tileIndex = String(index);
  tile.setAttribute('aria-hidden', 'true');

  tile.style.setProperty('--cuboid-row-position', projection.rowPosition.toFixed(4));
  tile.style.setProperty('--cuboid-table-depth', projection.tableDepth.toFixed(4));
  tile.style.setProperty('--cuboid-scale', projection.scale.toFixed(4));
  tile.style.setProperty('--cuboid-row-index', String(index));

  for (const name of FACE_NAMES) {
    const face = document.createElement('span');
    face.className = `cuboid-face cuboid-face-${name}`;
    face.setAttribute('aria-hidden', 'true');
    tile.appendChild(face);
  }
  return tile;
}

export const CUBOID_FACE_COUNT = FACE_NAMES.length;
