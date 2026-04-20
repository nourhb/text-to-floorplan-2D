import { roundToGrid } from './plan2dValidation.js';

const STEP = 0.25;

function isLivingName(name) {
  const s = String(name || '').toLowerCase();
  return s.includes('séjour') || s.includes('sejour') || s.includes('salon') || s.includes('living');
}

function isKitchenName(name) {
  const s = String(name || '').toLowerCase();
  return s.includes('cuisine') || s.includes('kitchen');
}


function findLivingKitchenPair(rooms) {
  if (!Array.isArray(rooms)) return null;
  const L = rooms.find((r) => r?.type === 'living_room' || isLivingName(r?.name));
  const K = rooms.find((r) => r?.type === 'kitchen' || isKitchenName(r?.name));
  if (!L || !K || L === K) return null;
  return { L, K };
}


export function livingKitchenVerticalJoint(rooms) {
  const pair = findLivingKitchenPair(rooms);
  if (!pair) return null;
  const { L, K } = pair;
  const ax = Number(L.x);
  const aw = Number(L.w);
  const ay = Number(L.y);
  const ah = Number(L.h);
  const bx = Number(K.x);
  const bw = Number(K.w);
  const by = Number(K.y);
  const bh = Number(K.h);
  if (![ax, aw, ay, ah, bx, bw, by, bh].every(Number.isFinite)) return null;
  const tol = 0.12;
  if (Math.abs(ax + aw - bx) > tol) return null;
  const xJoint = (ax + aw + bx) / 2;
  const yLo = Math.max(ay, by);
  const yHi = Math.min(ay + ah, by + bh);
  if (yHi <= yLo + 0.05) return null;
  return { x: xJoint, yLo, yHi };
}


export function buildOpenPlanSegmentsFromLivingKitchen(rooms) {
  const j = livingKitchenVerticalJoint(rooms);
  if (!j) return { openingsSegments: [], transitionDashSegments: [] };
  const ox = roundToGrid(j.x, STEP);
  const oy1 = roundToGrid(j.yLo + 0.05, STEP);
  const oy2 = roundToGrid(j.yHi - 0.05, STEP);
  if (!(oy2 > oy1 + 0.1)) return { openingsSegments: [], transitionDashSegments: [] };
  const seg = { segment: { x1: ox, y1: oy1, x2: ox, y2: oy2 } };
  return { openingsSegments: [seg], transitionDashSegments: [seg] };
}
