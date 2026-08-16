// opening-dealer.js — 仮東と二個のサイコロで起家を決める純粋契約
//
// 固定席から出目合計だけで決めると2d6の分布が偏る。先に仮東を一様に
// 選び、そこから手番順（0→1→2→3）に数えることで、起家は厳密に各1/4になる。

import { cryptoRandInt } from './wall.js';

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function dealerFromCeremony(provisionalEast, dice) {
  const east = integer(provisionalEast, 'provisionalEast', 0, 3);
  if (!Array.isArray(dice) || dice.length !== 2) {
    throw new TypeError('dice must contain exactly two values');
  }
  const first = integer(dice[0], 'dice[0]', 1, 6);
  const second = integer(dice[1], 'dice[1]', 1, 6);
  return (east + first + second - 1) % 4;
}

export function normalizeDealerCeremony(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('dealer ceremony must be an object');
  }
  const keys = Object.keys(value).sort();
  const allowed = ['dice', 'initialDealer', 'provisionalEast'].sort();
  if (JSON.stringify(keys) !== JSON.stringify(allowed)) {
    throw new TypeError('dealer ceremony contains missing or unknown fields');
  }
  const provisionalEast = integer(value.provisionalEast, 'provisionalEast', 0, 3);
  const dice = [
    integer(value.dice?.[0], 'dice[0]', 1, 6),
    integer(value.dice?.[1], 'dice[1]', 1, 6),
  ];
  if (!Array.isArray(value.dice) || value.dice.length !== 2) {
    throw new TypeError('dice must contain exactly two values');
  }
  const initialDealer = integer(value.initialDealer, 'initialDealer', 0, 3);
  if (initialDealer !== dealerFromCeremony(provisionalEast, dice)) {
    throw new RangeError('initialDealer does not match the ceremony result');
  }
  return Object.freeze({
    provisionalEast,
    dice: Object.freeze(dice),
    initialDealer,
  });
}

export function createDealerCeremony(randInt = cryptoRandInt) {
  if (typeof randInt !== 'function') throw new TypeError('randInt must be a function');
  const provisionalEast = integer(randInt(4), 'randInt(4)', 0, 3);
  const dice = [
    integer(randInt(6), 'randInt(6)', 0, 5) + 1,
    integer(randInt(6), 'randInt(6)', 0, 5) + 1,
  ];
  return normalizeDealerCeremony({
    provisionalEast,
    dice,
    initialDealer: dealerFromCeremony(provisionalEast, dice),
  });
}

export function dealerForHand(initialDealer, kyoku) {
  const start = integer(initialDealer, 'initialDealer', 0, 3);
  const hand = integer(kyoku, 'kyoku', 0, 3);
  return (start + hand) % 4;
}
