

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));


export const WALL_NET_FACTOR_BY_GROSS_M2 = [
  { maxGross: 50, factor: 0.9 },
  { maxGross: 100, factor: 0.88 },
  { maxGross: 200, factor: 0.87 },
  { maxGross: 400, factor: 0.86 },
  { maxGross: Infinity, factor: 0.85 },
];


export const ZONE_BUDGET_PCT = {
  private: { band0: 0.45, band1: 0.42, band2: 0.4, band3: 0.38 },
  public: { band0: 0.4, band1: 0.43, band2: 0.45, band3: 0.47 },
  service: { band0: 0.05, band1: 0.07, band2: 0.08, band3: 0.1 },
  circulation: { band0: 0.1, band1: 0.08, band2: 0.07, band3: 0.05 },
};


export const PRIVATE_BED_BATH_SHARE = {
  1: { bedroom: 0.75, bathroom: 0.25 },
  2: { bedroom: 0.72, bathroom: 0.28 },
  3: { bedroom: 0.7, bathroom: 0.3 },
  4: { bedroom: 0.68, bathroom: 0.32 },
  5: { bedroom: 0.65, bathroom: 0.35 },
};


export const DEFAULT_FOOTPRINT_BY_AREA_M2 = [
  { minA: 15, maxA: 25, ratio: 1.3, exampleW: 5.7, exampleH: 4.4 },
  { minA: 25, maxA: 40, ratio: 1.35, exampleW: 7.3, exampleH: 5.4 },
  { minA: 40, maxA: 60, ratio: 1.4, exampleW: 8.9, exampleH: 6.4 },
  { minA: 60, maxA: 80, ratio: 1.35, exampleW: 10.4, exampleH: 7.7 },
  { minA: 80, maxA: 100, ratio: 1.3, exampleW: 11.4, exampleH: 8.8 },
  { minA: 100, maxA: 130, ratio: 1.25, exampleW: 12.7, exampleH: 10.2 },
  { minA: 130, maxA: 180, ratio: 1.2, exampleW: 14.7, exampleH: 12.2 },
  { minA: 180, maxA: 250, ratio: 1.15, exampleW: 17.0, exampleH: 14.7 },
  { minA: 250, maxA: 400, ratio: 1.1, exampleW: 20.9, exampleH: 19.0 },
  { minA: 400, maxA: Infinity, ratio: 1.05, exampleW: null, exampleH: null },
];


export function computeFootprintFromAreaM2(areaMsq, step = 0.25) {
  const a = Number(areaMsq);
  if (!Number.isFinite(a) || a <= 0) return null;
  const row =
    DEFAULT_FOOTPRINT_BY_AREA_M2.find((r) => a >= r.minA && a <= r.maxA) ||
    DEFAULT_FOOTPRINT_BY_AREA_M2[DEFAULT_FOOTPRINT_BY_AREA_M2.length - 1];
  const ratio = row.ratio;
  const w0 = Math.sqrt(a * ratio);
  const h0 = Math.sqrt(a / ratio);
  const round = (n) => Math.round(n / step) * step;
  const width_m = round(Math.min(40, Math.max(5, w0)));
  const height_m = round(Math.min(40, Math.max(5, h0)));
  return { width_m, height_m, ratio, areaMsq: a };
}


export const HARD_VALIDATION = {
  areaTolerancePct: 8,
  doorClearanceM: 0.9,
  minCorridorWidthM: 0.9,
  maxCorrectionIterations: 3,
};


export function getArchitectureGuideText() {
  const p = join(__dirname, '../../../docs/FloorPlan_AI_Architecture_Guide.txt');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}


export function getArchitectureGuideBlockForPrompt() {
  const raw = getArchitectureGuideText();
  const header =
    '\n\n---\nARCHITECTURAL SPECIFICATION GUIDE (authoritative — Sections 1–8)\n' +
    'Follow this for: size normalization, room aliases, spatial graph vocabulary, norms, net/gross area, validation, user messages (FR/EN).\n\n';
  if (!raw) return `${header}(Guide file missing: docs/FloorPlan_AI_Architecture_Guide.txt)\n`;

  const max = Number(process.env.TEXT2D_ARCH_GUIDE_MAX_CHARS);
  if (Number.isFinite(max) && max > 0 && raw.length > max) {
    return `${header}${raw.slice(0, max)}\n\n… [truncated at TEXT2D_ARCH_GUIDE_MAX_CHARS=${max}]\n`;
  }
  return header + raw;
}
