import { livingKitchenVerticalJoint } from '../plan2d/openPlanSegmentsFromRooms.js';

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseColorToHex(color) {
  const c = String(color ?? '').trim();
  const m = /^#?([0-9a-fA-F]{6})$/.exec(c);
  if (!m) return null;
  return `#${m[1].toLowerCase()}`;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbaFromHex(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(59,130,246,${alpha})`; 
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

function fmtMeters(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, '').replace(/\.$/, '');
}

function isOpenPlanPair(a, b) {
  if (!a || !b) return false;
  const id = (r) => (r?.id != null ? String(r.id) : '');
  const ia = id(a);
  const ib = id(b);
  if (!ia || !ib) return false;
  return String(a.openPlanWith) === ib && String(b.openPlanWith) === ia;
}

function collectOpenPlanVerticalJointSegmentsM(plan) {
  const out = [];
  const pushSeg = (s) => {
    const x1 = Number(s?.x1);
    const y1 = Number(s?.y1);
    const x2 = Number(s?.x2);
    const y2 = Number(s?.y2);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    if (Math.abs(x1 - x2) < 1e-6) {
      out.push({ x: x1, yLo: Math.min(y1, y2), yHi: Math.max(y1, y2) });
    }
  };
  for (const arrName of ['transitionDashSegments', 'openingsSegments']) {
    const arr = plan?.[arrName];
    if (!Array.isArray(arr)) continue;
    for (const o of arr) pushSeg(o?.segment || o);
  }
  return out;
}

function refineOpenPlanJointsWithRoomOverlap(plan, joints) {
  const rooms = Array.isArray(plan?.rooms) ? plan.rooms : [];
  const inferred = livingKitchenVerticalJoint(rooms);
  if (!inferred) return joints;

  const tol = 0.12;
  const out = [];
  for (const j of joints) {
    if (Math.abs(j.x - inferred.x) < tol) {
      out.push({ x: j.x, yLo: inferred.yLo, yHi: inferred.yHi });
    } else {
      out.push(j);
    }
  }
  let declares = false;
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (isOpenPlanPair(rooms[i], rooms[j])) declares = true;
    }
  }
  if (inferred && declares) {
    const hasAtX = out.some((j) => Math.abs(j.x - inferred.x) < tol);
    if (!hasAtX) out.push({ x: inferred.x, yLo: inferred.yLo, yHi: inferred.yHi });
  }
  return out.length ? out : joints;
}

function subtractOneYRange(yLo, yHi, cLo, cHi, eps = 0.02) {
  if (!(yHi > yLo + eps)) return [];
  if (!(cHi > cLo + eps)) return [[yLo, yHi]];
  if (yHi <= cLo + eps || yLo >= cHi - eps) return [[yLo, yHi]];
  const out = [];
  if (yLo < cLo - eps) out.push([yLo, Math.min(yHi, cLo)]);
  if (yHi > cHi + eps) out.push([Math.max(yLo, cHi), yHi]);
  return out.filter(([a, b]) => b > a + eps);
}

function subtractOpenPlanJointsFromVerticalSpan(xM, yLoM, yHiM, joints, tol = 0.06) {
  let ranges = [[yLoM, yHiM]];
  for (const j of joints) {
    if (Math.abs(j.x - xM) > tol) continue;
    ranges = ranges.flatMap(([a, b]) => subtractOneYRange(a, b, j.yLo, j.yHi));
  }
  return ranges.filter(([a, b]) => b > a + 1e-3);
}

function shouldSkipOpenPlanVerticalWall(xM, yLoM, yHiM, rooms) {
  const tol = 0.06;
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i];
      const b = rooms[j];
      if (!isOpenPlanPair(a, b)) continue;
      const ax = Number(a?.x);
      const aw = Number(a?.w);
      const ay = Number(a?.y);
      const ah = Number(a?.h);
      const bx = Number(b?.x);
      const bw = Number(b?.w);
      const by = Number(b?.y);
      const bh = Number(b?.h);
      if (![ax, aw, ay, ah, bx, bw, by, bh].every(Number.isFinite)) continue;
      const joint = (left, right) => {
        const lR = left.x + left.w;
        const rL = right.x;
        if (Math.abs(lR - rL) > tol) return false;
        if (Math.abs(lR - xM) > tol) return false;
        const y0 = Math.max(yLoM, Math.max(left.y, right.y));
        const y1 = Math.min(yHiM, Math.min(left.y + left.h, right.y + right.h));
        if (y1 <= y0 + tol) return false;
        const mid = (yLoM + yHiM) / 2;
        return mid >= y0 - tol && mid <= y1 + tol;
      };
      if (joint({ x: ax, y: ay, w: aw, h: ah }, { x: bx, y: by, w: bw, h: bh })) return true;
      if (joint({ x: bx, y: by, w: bw, h: bh }, { x: ax, y: ay, w: aw, h: ah })) return true;
    }
  }
  return false;
}

function isRoom(name, keys) {
  const s = String(name || '').toLowerCase();
  return keys.some((k) => s.includes(k));
}

function furniturePxForRoom({ name, rx, ry, rw, rh }) {
  
  const minSide = Math.min(rw, rh);
  if (minSide < 90) return ''; 

  const stroke = '#111';
  const sw = 2;
  const pad = Math.max(10, Math.min(18, minSide * 0.08));
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;

  
  if (isRoom(name, ['chambre', 'bed'])) {
    const bw = Math.min(rw - pad * 2, 180);
    const bh = Math.min(rh - pad * 2, 120);
    const bx = cx - bw / 2;
    const by = cy - bh / 2;
    const isMaster = /\b3\b/.test(String(name || '')) || /master/i.test(String(name || ''));
    const wardrobeD = 22;
    const wardrobeW = Math.max(90, Math.min(rw - pad * 2, isMaster ? 180 : 140));
    const wx = rx + pad;
    const wy = ry + pad;
    return `
      <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <line x1="${bx}" y1="${by + bh * 0.35}" x2="${bx + bw}" y2="${by + bh * 0.35}" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${bx + bw * 0.06}" y="${by + bh * 0.06}" width="${bw * 0.26}" height="${bh * 0.2}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${bx + bw * 0.68}" y="${by + bh * 0.06}" width="${bw * 0.26}" height="${bh * 0.2}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${wx}" y="${wy}" width="${wardrobeW}" height="${wardrobeD}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      ${isMaster ? `<rect x="${rx + rw - pad - 110}" y="${ry + rh - pad - 70}" width="110" height="70" fill="none" stroke="${stroke}" stroke-width="${sw}" />` : ''}
    `;
  }

  
  if (isRoom(name, ['bain', 'bath', 'sdb', 'wc', 'toilet'])) {
    const tw = Math.min(rw - pad * 2, 170);
    const th = Math.min(rh - pad * 2, 90);
    const tx = cx - tw / 2;
    const ty = cy - th / 2;
    const sinkR = 10;
    return `
      <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="12" ry="12" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <circle cx="${tx + tw + 22}" cy="${ty + 18}" r="${sinkR}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <line x1="${tx + tw + 12}" y1="${ty + 4}" x2="${tx + tw + 32}" y2="${ty + 4}" stroke="${stroke}" stroke-width="${sw}" />
    `;
  }

  
  if (isRoom(name, ['cuisine', 'kitchen'])) {
    
    const runH = 24;
    const runW = Math.max(140, Math.min(rw - pad * 2, 280));
    const runX = rx + (rw - runW) / 2;
    const runY = ry + pad;

    const islandW = Math.max(120, Math.min(rw - pad * 2, 210));
    const islandH = 34;
    const islandX = cx - islandW / 2;
    const islandY = cy - islandH / 2;
    return `
      <rect x="${runX}" y="${runY}" width="${runW}" height="${runH}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <circle cx="${runX + runW * 0.25}" cy="${runY + runH * 0.5}" r="7" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <circle cx="${runX + runW * 0.75}" cy="${runY + runH * 0.5}" r="7" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${islandX}" y="${islandY}" width="${islandW}" height="${islandH}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
    `;
  }

  
  if (isRoom(name, ['sejour', 'séjour', 'salon', 'living'])) {
    
    
    const tvW = Math.min(80, Math.max(56, rw * 0.16));
    const tvH = 10;
    const tvX = cx - tvW / 2;
    const tvY = ry + pad;

    const sofaW = Math.min(rw - pad * 2, 260);
    const sofaH = Math.min(100, Math.max(80, rh * 0.22));
    const sofaX = cx - sofaW / 2;
    const sofaY = ry + rh - pad - sofaH - 34;

    const tableW = 58;
    const tableH = 34;
    const tableX = cx - tableW / 2;
    const tableY = sofaY - 44;
    return `
      <rect x="${tvX}" y="${tvY}" width="${tvW}" height="${tvH}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${sofaX}" y="${sofaY}" width="${sofaW}" height="${sofaH}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <line x1="${sofaX}" y1="${sofaY + sofaH * 0.25}" x2="${sofaX + sofaW}" y2="${sofaY + sofaH * 0.25}" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${tableX}" y="${tableY}" width="${tableW}" height="${tableH}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
    `;
  }

  
  if (isRoom(name, ['manger', 'dining'])) {
    const tw = Math.min(rw - pad * 2, 160);
    const th = Math.min(rh - pad * 2, 90);
    const tx = cx - tw / 2;
    const ty = cy - th / 2;
    const chair = 16;
    return `
      <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${tx - chair - 6}" y="${ty + th * 0.15}" width="${chair}" height="${chair}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${tx - chair - 6}" y="${ty + th * 0.65}" width="${chair}" height="${chair}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${tx + tw + 6}" y="${ty + th * 0.15}" width="${chair}" height="${chair}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      <rect x="${tx + tw + 6}" y="${ty + th * 0.65}" width="${chair}" height="${chair}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
    `;
  }

  return '';
}

export function renderPlan2DSvg(
  plan,
  {
    pxPerM = 80,
    wallStroke = '#111',
    bg = '#ffffff',
    theme = 'architectural_bw', 
    norms = 'fr', 
    
    showDoors = false,
  } = {}
) {
  const widthM = Number(plan?.width_m);
  const heightM = Number(plan?.height_m);
  const rooms = Array.isArray(plan?.rooms) ? plan.rooms : [];
  const doors = showDoors && Array.isArray(plan?.doors) ? plan.doors : [];

  const safeWidthM = Number.isFinite(widthM) ? widthM : 12;
  const safeHeightM = Number.isFinite(heightM) ? heightM : 9;

  const paddingPx = theme === 'architectural_bw' ? 70 : 40;
  const outerW = Math.round(safeWidthM * pxPerM);
  const outerH = Math.round(safeHeightM * pxPerM);

  const W = outerW + paddingPx * 2;
  const H = outerH + paddingPx * 2;

  const toPxX = (m) => paddingPx + Number(m) * pxPerM;
  const toPxY = (m) => paddingPx + Number(m) * pxPerM;
  const toPxLen = (m) => Number(m) * pxPerM;

  const outerStrokeW = theme === 'architectural_bw' ? 10 : 3;
  const innerStrokeW = theme === 'architectural_bw' ? 5 : 2;
  const roomFill = theme === 'architectural_bw' ? '#fff' : null;
  const doorCutPadPx = theme === 'architectural_bw' ? Math.max(2, Math.round(innerStrokeW * 0.7)) : Math.max(1, Math.round(innerStrokeW * 0.6));

  const outer = `
    <rect x="${paddingPx}" y="${paddingPx}" width="${outerW}" height="${outerH}"
      fill="none" stroke="${wallStroke}" stroke-width="${outerStrokeW}" />
  `;

  const windowEls = (() => {
    if (theme !== 'architectural_bw') return '';
    const Wm = safeWidthM;
    const Hm = safeHeightM;
    const tol = 1e-6;

    
    const touches = { N: [], S: [], E: [], W: [] };
    for (const r of rooms) {
      const x = Number(r?.x);
      const y = Number(r?.y);
      const w = Number(r?.w);
      const h = Number(r?.h);
      if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;

      if (Math.abs(y - 0) < tol) touches.N.push(r);
      if (Math.abs(y + h - Hm) < tol) touches.S.push(r);
      if (Math.abs(x - 0) < tol) touches.W.push(r);
      if (Math.abs(x + w - Wm) < tol) touches.E.push(r);
    }

    const priority = (name) => {
      const n = String(name || '').toLowerCase();
      if (n.includes('séjour') || n.includes('sejour') || n.includes('salon') || n.includes('living')) return 5;
      if (n.includes('cuisine') || n.includes('kitchen')) return 4;
      if (n.includes('chambre') || n.includes('bed')) return 3;
      if (n.includes('bain') || n.includes('bath') || n.includes('sdb')) return 2;
      if (n.includes('wc') || n.includes('toilet')) return 2;
      if (n.includes('couloir') || n.includes('hall') || n.includes('corridor')) return 1;
      return 0;
    };

    const pickTop = (arr, limit = 2) =>
      arr
        .slice()
        .sort((a, b) => {
          const pa = priority(a?.name);
          const pb = priority(b?.name);
          if (pb !== pa) return pb - pa;
          const sa = Number(a?.w) * Number(a?.h);
          const sb = Number(b?.w) * Number(b?.h);
          return sb - sa;
        })
        .slice(0, limit);

    
    
    
    const winAlongM = 0.4; 
    const winDepthM = 0.14; 
    const winFrameStrokeW = 1;
    const tickStrokeW = 1;
    const cutPadPx = Math.max(2, Math.round(outerStrokeW * 0.12));
    const cutDepthPx = Math.max(8, Math.round(outerStrokeW * 1.05));

    const mk = ({ side, room }) => {
      const x = Number(room?.x);
      const y = Number(room?.y);
      const w = Number(room?.w);
      const h = Number(room?.h);

      const centerPxX = paddingPx + (side === 'N' || side === 'S' ? x + w / 2 : x) * pxPerM;
      const centerPxY = paddingPx + (side === 'E' || side === 'W' ? y + h / 2 : y) * pxPerM;

      const alongPx = winAlongM * pxPerM;
      const depthPx = winDepthM * pxPerM;

      let cutX = 0;
      let cutY = 0;
      let cutW = 0;
      let cutH = 0;
      let frameX = 0;
      let frameY = 0;
      let frameW = 0;
      let frameH = 0;

      if (side === 'N') {
        frameW = alongPx;
        frameH = depthPx;
        frameX = centerPxX - frameW / 2;
        frameY = paddingPx - winFrameStrokeW;
        cutX = frameX - cutPadPx;
        cutY = paddingPx - cutPadPx;
        cutW = frameW + cutPadPx * 2;
        cutH = frameH + cutPadPx * 2 + winFrameStrokeW * 2;
      } else if (side === 'S') {
        frameW = alongPx;
        frameH = depthPx;
        frameX = centerPxX - frameW / 2;
        frameY = paddingPx + outerH - frameH - winFrameStrokeW;
        cutX = frameX - cutPadPx;
        cutY = paddingPx + outerH - (frameH + cutPadPx * 2 + winFrameStrokeW * 2);
        cutW = frameW + cutPadPx * 2;
        cutH = frameH + cutPadPx * 2 + winFrameStrokeW * 2;
      } else if (side === 'W') {
        frameW = depthPx;
        frameH = alongPx;
        frameX = paddingPx - winFrameStrokeW;
        frameY = centerPxY - frameH / 2;
        cutX = paddingPx - cutPadPx;
        cutY = frameY - cutPadPx;
        cutW = cutDepthPx + cutPadPx + 2;
        cutH = frameH + cutPadPx * 2;
      } else {
        
        frameW = depthPx;
        frameH = alongPx;
        frameX = paddingPx + outerW - frameW - winFrameStrokeW;
        frameY = centerPxY - frameH / 2;
        cutX = paddingPx + outerW - (cutDepthPx + cutPadPx + 2);
        cutY = frameY - cutPadPx;
        cutW = cutDepthPx + cutPadPx + 2;
        cutH = frameH + cutPadPx * 2;
      }

      
      const tick =
        side === 'N' || side === 'S'
          ? `<line x1="${frameX + frameW / 2}" y1="${frameY + 2}" x2="${frameX + frameW / 2}" y2="${frameY + frameH - 2}" stroke="${wallStroke}" stroke-width="${tickStrokeW}" stroke-linecap="square" />`
          : `<line x1="${frameX + 2}" y1="${frameY + frameH / 2}" x2="${frameX + frameW - 2}" y2="${frameY + frameH / 2}" stroke="${wallStroke}" stroke-width="${tickStrokeW}" stroke-linecap="square" />`;

      const cutout = `<rect x="${cutX}" y="${cutY}" width="${cutW}" height="${cutH}" fill="${bg}" />`;
      const frame = `<rect x="${frameX}" y="${frameY}" width="${frameW}" height="${frameH}" fill="${bg}" stroke="${wallStroke}" stroke-width="${winFrameStrokeW}" />`;

      return { cutout, frame, tick };
    };

    const els = [];
    for (const side of ['N', 'E', 'S', 'W']) {
      
      const top = pickTop(touches[side], side === 'S' ? 3 : 2);
      for (const room of top) {
        const w = mk({ side, room });
        els.push(`
          ${w.cutout}
          ${w.frame}
          ${w.tick}
        `);
      }
    }
    return els.join('\n');
  })();

  const defs = `
    <defs>
      <marker id="arrow" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L10,5 L0,10 z" fill="${wallStroke}" />
      </marker>
    </defs>
  `;

  const dimColor = wallStroke;
  const dimStroke = 1.8;
  const dimOffset = 26;
  const dimTextSize = 14;

  
  const dimTop = `
    <g>
      <line x1="${paddingPx}" y1="${paddingPx - dimOffset}" x2="${paddingPx + outerW}" y2="${paddingPx - dimOffset}"
        stroke="${dimColor}" stroke-width="${dimStroke}" marker-start="url(#arrow)" marker-end="url(#arrow)" />
      <line x1="${paddingPx}" y1="${paddingPx - dimOffset + 6}" x2="${paddingPx}" y2="${paddingPx}" stroke="${dimColor}" stroke-width="${dimStroke}" />
      <line x1="${paddingPx + outerW}" y1="${paddingPx - dimOffset + 6}" x2="${paddingPx + outerW}" y2="${paddingPx}" stroke="${dimColor}" stroke-width="${dimStroke}" />
      <text x="${paddingPx + outerW / 2}" y="${paddingPx - dimOffset - 6}" text-anchor="middle"
        font-size="${dimTextSize}" font-family="Inter, Arial, sans-serif" fill="${dimColor}">
        ${fmtMeters(safeWidthM)} m
      </text>
    </g>
  `;

  const dimLeft = `
    <g>
      <line x1="${paddingPx - dimOffset}" y1="${paddingPx}" x2="${paddingPx - dimOffset}" y2="${paddingPx + outerH}"
        stroke="${dimColor}" stroke-width="${dimStroke}" marker-start="url(#arrow)" marker-end="url(#arrow)" />
      <line x1="${paddingPx - dimOffset + 6}" y1="${paddingPx}" x2="${paddingPx}" y2="${paddingPx}" stroke="${dimColor}" stroke-width="${dimStroke}" />
      <line x1="${paddingPx - dimOffset + 6}" y1="${paddingPx + outerH}" x2="${paddingPx}" y2="${paddingPx + outerH}" stroke="${dimColor}" stroke-width="${dimStroke}" />
      <text x="${paddingPx - dimOffset - 10}" y="${paddingPx + outerH / 2}" text-anchor="middle"
        font-size="${dimTextSize}" font-family="Inter, Arial, sans-serif" fill="${dimColor}"
        transform="rotate(-90 ${paddingPx - dimOffset - 10} ${paddingPx + outerH / 2})">
        ${fmtMeters(safeHeightM)} m
      </text>
    </g>
  `;

  const dimBottom = `
    <g>
      <line x1="${paddingPx}" y1="${paddingPx + outerH + dimOffset}" x2="${paddingPx + outerW}" y2="${paddingPx + outerH + dimOffset}"
        stroke="${dimColor}" stroke-width="${dimStroke}" marker-start="url(#arrow)" marker-end="url(#arrow)" />
      <line x1="${paddingPx}" y1="${paddingPx + outerH + dimOffset - 6}" x2="${paddingPx}" y2="${paddingPx + outerH}" stroke="${dimColor}" stroke-width="${dimStroke}" />
      <line x1="${paddingPx + outerW}" y1="${paddingPx + outerH + dimOffset - 6}" x2="${paddingPx + outerW}" y2="${paddingPx + outerH}" stroke="${dimColor}" stroke-width="${dimStroke}" />
      <text x="${paddingPx + outerW / 2}" y="${paddingPx + outerH + dimOffset + 22}" text-anchor="middle"
        font-size="${dimTextSize}" font-family="Inter, Arial, sans-serif" fill="${dimColor}">
        ${fmtMeters(safeWidthM)} m
      </text>
    </g>
  `;

  const dimRight = `
    <g>
      <line x1="${paddingPx + outerW + dimOffset}" y1="${paddingPx}" x2="${paddingPx + outerW + dimOffset}" y2="${paddingPx + outerH}"
        stroke="${dimColor}" stroke-width="${dimStroke}" marker-start="url(#arrow)" marker-end="url(#arrow)" />
      <line x1="${paddingPx + outerW + dimOffset - 6}" y1="${paddingPx}" x2="${paddingPx + outerW}" y2="${paddingPx}" stroke="${dimColor}" stroke-width="${dimStroke}" />
      <line x1="${paddingPx + outerW + dimOffset - 6}" y1="${paddingPx + outerH}" x2="${paddingPx + outerW}" y2="${paddingPx + outerH}" stroke="${dimColor}" stroke-width="${dimStroke}" />
      <text x="${paddingPx + outerW + dimOffset + 10}" y="${paddingPx + outerH / 2}" text-anchor="middle"
        font-size="${dimTextSize}" font-family="Inter, Arial, sans-serif" fill="${dimColor}"
        transform="rotate(-90 ${paddingPx + outerW + dimOffset + 10} ${paddingPx + outerH / 2})">
        ${fmtMeters(safeHeightM)} m
      </text>
    </g>
  `;

  const innerWalls = (() => {
    if (theme !== 'architectural_bw') return '';

    const openVertJointsM = refineOpenPlanJointsWithRoomOverlap(plan, collectOpenPlanVerticalJointSegmentsM(plan));

    
    
    
    const gridStepM = 0.25;
    
    const unitCount = new Map();

    function bump(key) {
      unitCount.set(key, (unitCount.get(key) || 0) + 1);
    }

    for (const r of rooms) {
      const x = Number(r?.x);
      const y = Number(r?.y);
      const w = Number(r?.w);
      const h = Number(r?.h);
      if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;

      const gx1 = Math.round(x / gridStepM);
      const gx2 = Math.round((x + w) / gridStepM);
      const gy1 = Math.round(y / gridStepM);
      const gy2 = Math.round((y + h) / gridStepM);

      
      for (let gx of [gx1, gx2]) {
        for (let gy = Math.min(gy1, gy2); gy < Math.max(gy1, gy2); gy++) {
          bump(`V:${gx}:${gy}:${gy + 1}`);
        }
      }
      
      for (let gy of [gy1, gy2]) {
        for (let gx = Math.min(gx1, gx2); gx < Math.max(gx1, gx2); gx++) {
          bump(`H:${gy}:${gx}:${gx + 1}`);
        }
      }
    }

    
    const vRuns = new Map(); 
    const hRuns = new Map(); 

    for (const [key, cnt] of unitCount) {
      if (cnt < 2) continue;
      const parts = key.split(':');
      if (parts[0] === 'V') {
        const gx = Number(parts[1]);
        const gyLo = Number(parts[2]);
        const gyHi = Number(parts[3]);
        if (!vRuns.has(gx)) vRuns.set(gx, []);
        vRuns.get(gx).push([gyLo, gyHi]);
      } else {
        const gy = Number(parts[1]);
        const gxLo = Number(parts[2]);
        const gxHi = Number(parts[3]);
        if (!hRuns.has(gy)) hRuns.set(gy, []);
        hRuns.get(gy).push([gxLo, gxHi]);
      }
    }

    function mergeIntervals(ranges) {
      if (!ranges.length) return [];
      const s = ranges.slice().sort((a, b) => a[0] - b[0]);
      const out = [];
      let cur = s[0];
      for (let i = 1; i < s.length; i++) {
        if (s[i][0] <= cur[1]) cur[1] = Math.max(cur[1], s[i][1]);
        else {
          out.push(cur);
          cur = s[i];
        }
      }
      out.push(cur);
      return out;
    }

    const lines = [];
    for (const [gx, ranges] of vRuns) {
      for (const [gyLo, gyHi] of mergeIntervals(ranges)) {
        const xM = gx * gridStepM;
        const yLoM = gyLo * gridStepM;
        const yHiM = gyHi * gridStepM;
        const yParts =
          openVertJointsM.length > 0
            ? subtractOpenPlanJointsFromVerticalSpan(xM, yLoM, yHiM, openVertJointsM)
            : [[yLoM, yHiM]];
        for (const [yl, yh] of yParts) {
          if (shouldSkipOpenPlanVerticalWall(xM, yl, yh, rooms)) continue;
          const xPx = toPxX(xM);
          const y1Px = toPxY(yl);
          const y2Px = toPxY(yh);
          lines.push(`<line x1="${xPx}" y1="${y1Px}" x2="${xPx}" y2="${y2Px}" stroke="${wallStroke}" stroke-width="${innerStrokeW}" />`);
        }
      }
    }
    for (const [gy, ranges] of hRuns) {
      for (const [gxLo, gxHi] of mergeIntervals(ranges)) {
        const yPx = toPxY(gy * gridStepM);
        const x1Px = toPxX(gxLo * gridStepM);
        const x2Px = toPxX(gxHi * gridStepM);
        lines.push(`<line x1="${x1Px}" y1="${yPx}" x2="${x2Px}" y2="${yPx}" stroke="${wallStroke}" stroke-width="${innerStrokeW}" />`);
      }
    }

    return lines.join('\n');
  })();

  const roomFillEls = rooms
    .map((r, idx) => {
      const x = Number(r?.x);
      const y = Number(r?.y);
      const w = Number(r?.w);
      const h = Number(r?.h);
      if (![x, y, w, h].every((n) => Number.isFinite(n))) return '';

      const hex = parseColorToHex(r?.color) || `#${((idx * 9973) ^ 0xabcdef).toString(16).slice(0, 6).padStart(6, '0').slice(0, 6)}`;
      const fill = theme === 'architectural_bw' ? roomFill : rgbaFromHex(hex, 0.16);

      const rx = toPxX(x);
      const ry = toPxY(y);
      const rw = toPxLen(w);
      const rh = toPxLen(h);

      
      if (r?.isAlcove) {
        const hatch =
          theme === 'architectural_bw'
            ? `<defs><pattern id="alcoveHatch${idx}" patternUnits="userSpaceOnUse" width="8" height="8"><path d="M0,8 L8,0 M-2,2 L2,-2 M6,10 L10,6" stroke="#d1d5db" stroke-width="1"/></pattern></defs>
               <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="url(#alcoveHatch${idx})" stroke="${wallStroke}" stroke-width="1" stroke-dasharray="4 3" />`
            : `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${fill}" stroke="${wallStroke}" stroke-width="${innerStrokeW}" />`;
        const cx = rx + rw / 2;
        const cy = ry + rh * 0.55;
        const drumR = Math.max(6, Math.min(rw, rh) * 0.12);
        const washer = `
          <rect x="${rx + rw * 0.12}" y="${cy - drumR * 1.1}" width="${rw * 0.76}" height="${drumR * 2.2}" rx="4" fill="none" stroke="${wallStroke}" stroke-width="1.6" />
          <circle cx="${cx}" cy="${cy}" r="${drumR}" fill="none" stroke="${wallStroke}" stroke-width="1.4" />
        `;
        const lbl = escapeXml(String(r?.name || 'Buanderie'));
        return `
        <g>
          ${hatch}
          ${washer}
          <text x="${rx + 6}" y="${ry + 14}" text-anchor="start" dominant-baseline="hanging"
            font-size="10" font-family="Inter, Arial, sans-serif" fill="${wallStroke}">${lbl}</text>
        </g>`;
      }

      const furniturePx =
        theme === 'architectural_bw' ? furniturePxForRoom({ name: r?.name, rx, ry, rw, rh }) : '';

      const rectStroke = theme === 'architectural_bw' ? 'none' : wallStroke;
      const rectStrokeW = theme === 'architectural_bw' ? 0 : innerStrokeW;

      return `
        <g>
          <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}"
            rx="${theme === 'architectural_bw' ? 0 : 10}" ry="${theme === 'architectural_bw' ? 0 : 10}"
            fill="${fill}" stroke="${rectStroke}" stroke-width="${rectStrokeW}" opacity="1" />
          ${furniturePx ? `<g>${furniturePx}</g>` : ''}
        </g>
      `;
    })
    .join('\n');

  const roomLabelEls = rooms
    .map((r, idx) => {
      const x = Number(r?.x);
      const y = Number(r?.y);
      const w = Number(r?.w);
      const h = Number(r?.h);
      if (![x, y, w, h].every((n) => Number.isFinite(n))) return '';

      const rx = toPxX(x);
      const ry = toPxY(y);
      const rw = toPxLen(w);
      const rh = toPxLen(h);
      const labelX = rx + rw / 2;
      const labelY = ry + rh / 2;

      
      if (r?.isAlcove) return '';
      if (theme === 'architectural_bw' && (rw < 110 || rh < 70)) return '';

      const label = escapeXml(r?.name || `Room ${idx + 1}`);
      const labelFontSize = theme === 'architectural_bw' ? 15 : 16;
      const dimFontSize = theme === 'architectural_bw' ? 11 : 12;

      const roomWText = `${fmtMeters(w)} m`;
      const roomHText = `${fmtMeters(h)} m`;
      const localDimStroke = 1.6;
      const localDimOffset = 20;

      const haloTextAttrs =
        theme === 'architectural_bw' ? `stroke="${bg}" stroke-width="3" paint-order="stroke fill"` : '';

      return `
        <g>
          ${
            theme === 'architectural_bw'
              ? `<text x="${labelX}" y="${labelY - 6}"
            text-anchor="middle" dominant-baseline="central"
            font-size="${labelFontSize}" font-family="Inter, Arial, sans-serif"
            fill="${wallStroke}" ${haloTextAttrs}>
            ${label}
          </text>
          <line x1="${rx}" y1="${ry - localDimOffset}" x2="${rx + rw}" y2="${ry - localDimOffset}"
            stroke="${wallStroke}" stroke-width="${localDimStroke}" marker-start="url(#arrow)" marker-end="url(#arrow)" />
          <text x="${labelX}" y="${ry - localDimOffset - 8}"
            text-anchor="middle" dominant-baseline="central"
            font-size="${dimFontSize}" font-family="Inter, Arial, sans-serif"
            fill="${wallStroke}" ${haloTextAttrs}>
            ${escapeXml(roomWText)}
          </text>
          <line x1="${rx - localDimOffset}" y1="${ry}" x2="${rx - localDimOffset}" y2="${ry + rh}"
            stroke="${wallStroke}" stroke-width="${localDimStroke}" marker-start="url(#arrow)" marker-end="url(#arrow)" />
          <text x="${rx - localDimOffset - 10}" y="${labelY}"
            text-anchor="middle" dominant-baseline="central"
            font-size="${dimFontSize}" font-family="Inter, Arial, sans-serif"
            fill="${wallStroke}" ${haloTextAttrs}
            transform="rotate(-90 ${rx - localDimOffset - 10} ${labelY})">
            ${escapeXml(roomHText)}
          </text>`
              : `<text x="${labelX}" y="${labelY}"
            text-anchor="middle" dominant-baseline="central"
            font-size="${labelFontSize}" font-family="Inter, Arial, sans-serif"
            fill="${wallStroke}">
            ${label}
          </text>`
          }
        </g>
      `;
    })
    .join('\n');

  function doorPathFor({ fromRoom, wall, offset_m, width_m, swing }) {
    
    if (!fromRoom) return '';
    const rx = toPxX(fromRoom.x);
    const ry = toPxY(fromRoom.y);
    const rw = toPxLen(fromRoom.w);
    const rh = toPxLen(fromRoom.h);
    const wPx = Math.max(14, toPxLen(width_m));
    const sw = 2;
    const stroke = wallStroke;

    
    let hx, hy, ex, ey, arc;
    const roomName = String(fromRoom?.name || '').toLowerCase();
    const isTinyWet =
      theme === 'architectural_bw' &&
      (roomName.includes('wc') || roomName.includes('toilet') || roomName.includes('buanderie') || roomName.includes('laundry'));

    
    
    const baseR = isTinyWet ? Math.max(14, Math.round(wPx * 0.65)) : wPx;
    const maxR = wall === 'N' || wall === 'S' ? Math.max(14, Math.round(rh - 10)) : Math.max(14, Math.round(rw - 10));
    const arcR = Math.max(14, Math.min(baseR, maxR));

    
    const wallLenM = wall === 'N' || wall === 'S' ? Number(fromRoom.w) : Number(fromRoom.h);
    const halfM = Number(width_m) / 2;
    let startM = Number(offset_m) - halfM;
    const minM = 0.05;
    const maxM = Math.max(minM, wallLenM - Number(width_m) - 0.05);
    if (!Number.isFinite(startM)) startM = (wallLenM - Number(width_m)) / 2;
    startM = Math.min(maxM, Math.max(minM, startM));
    const endM = startM + Number(width_m);

    const startPx = toPxLen(startM);
    const endPx = toPxLen(endM);

    const hingeAtEnd = swing === 'L'; 

    
    
    let cutX = 0;
    let cutY = 0;
    let cutW = 0;
    let cutH = 0;
    if (wall === 'N') {
      cutX = rx + startPx - doorCutPadPx;
      cutY = ry - doorCutPadPx;
      cutW = (endPx - startPx) + doorCutPadPx * 2;
      cutH = innerStrokeW + doorCutPadPx * 2;
    } else if (wall === 'S') {
      cutX = rx + startPx - doorCutPadPx;
      cutY = ry + rh - doorCutPadPx;
      cutW = (endPx - startPx) + doorCutPadPx * 2;
      cutH = innerStrokeW + doorCutPadPx * 2;
    } else if (wall === 'E') {
      cutX = rx + rw - doorCutPadPx;
      cutY = ry + startPx - doorCutPadPx;
      cutW = innerStrokeW + doorCutPadPx * 2;
      cutH = (endPx - startPx) + doorCutPadPx * 2;
    } else {
      
      cutX = rx - doorCutPadPx;
      cutY = ry + startPx - doorCutPadPx;
      cutW = innerStrokeW + doorCutPadPx * 2;
      cutH = (endPx - startPx) + doorCutPadPx * 2;
    }
    const cutout = `<rect x="${cutX}" y="${cutY}" width="${cutW}" height="${cutH}" fill="${bg}" />`;

    
    if (String(swing || '').toUpperCase() === 'OPEN') {
      return `
        <g>
          ${cutout}
        </g>
      `;
    }

    if (wall === 'N') {
      hx = rx + (hingeAtEnd ? endPx : startPx);
      hy = ry;
      const dir = hingeAtEnd ? -1 : 1;
      ex = hx + dir * arcR;
      ey = hy;
      const sweep = dir > 0 ? 1 : 0;
      arc = `M ${hx} ${hy} A ${arcR} ${arcR} 0 0 ${sweep} ${hx + dir * arcR} ${hy + arcR}`;
    } else if (wall === 'S') {
      hx = rx + (hingeAtEnd ? endPx : startPx);
      hy = ry + rh;
      const dir = hingeAtEnd ? -1 : 1;
      ex = hx + dir * arcR;
      ey = hy;
      const sweep = dir > 0 ? 0 : 1;
      arc = `M ${hx} ${hy} A ${arcR} ${arcR} 0 0 ${sweep} ${hx + dir * arcR} ${hy - arcR}`;
    } else if (wall === 'E') {
      hx = rx + rw;
      hy = ry + (hingeAtEnd ? endPx : startPx);
      const dir = hingeAtEnd ? -1 : 1;
      ex = hx;
      ey = hy + dir * arcR;
      const sweep = dir > 0 ? 1 : 0;
      arc = `M ${hx} ${hy} A ${arcR} ${arcR} 0 0 ${sweep} ${hx - arcR} ${hy + dir * arcR}`;
    } else {
      
      hx = rx;
      hy = ry + (hingeAtEnd ? endPx : startPx);
      const dir = hingeAtEnd ? -1 : 1;
      ex = hx;
      ey = hy + dir * arcR;
      const sweep = dir > 0 ? 0 : 1;
      arc = `M ${hx} ${hy} A ${arcR} ${arcR} 0 0 ${sweep} ${hx + arcR} ${hy + dir * arcR}`;
    }

    return `
      <g>
        ${cutout}
        <line x1="${hx}" y1="${hy}" x2="${ex}" y2="${ey}" stroke="${stroke}" stroke-width="${sw}" />
        <path d="${arc}" fill="none" stroke="${stroke}" stroke-width="${sw}" />
      </g>
    `;
  }

  const roomByName = new Map(rooms.map((r) => [String(r?.name || '').toLowerCase(), r]));
  const doorEls =
    showDoors && theme === 'architectural_bw'
      ? doors
          .map((d) => {
            const fromName = String(d?.from || '').toLowerCase();
            const fromRoom = roomByName.get(fromName) || rooms.find((r) => String(r?.name || '').toLowerCase() === fromName);
            const wall = String(d?.wall || '').toUpperCase();
            const offset_m = Number(d?.offset_m);
            const width_m = Number(d?.width_m);
            const swingRaw = String(d?.swing || 'R').toUpperCase();
            const swing = swingRaw === 'OPEN' ? 'OPEN' : swingRaw === 'L' ? 'L' : 'R';
            if (!fromRoom) return '';
            if (!['N', 'S', 'E', 'W'].includes(wall)) return '';
            if (!Number.isFinite(offset_m) || !Number.isFinite(width_m)) return '';
            return doorPathFor({ fromRoom, wall, offset_m, width_m, swing });
          })
          .join('\n')
      : '';

  
  const segDoors = Array.isArray(plan?.doorsSegments) ? plan.doorsSegments : [];
  const segWindows = Array.isArray(plan?.windowsSegments) ? plan.windowsSegments : [];
  const segOpenings = Array.isArray(plan?.openingsSegments) ? plan.openingsSegments : [];
  const segTransitionDashForErase = Array.isArray(plan?.transitionDashSegments) ? plan.transitionDashSegments : [];

  const doorSegEls =
    theme === 'architectural_bw' && segDoors.length
      ? segDoors
          .map((d) => {
            const s = d?.segment || {};
            const x1 = toPxX(Number(s?.x1));
            const y1 = toPxY(Number(s?.y1));
            const x2 = toPxX(Number(s?.x2));
            const y2 = toPxY(Number(s?.y2));
            if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) return '';
            
            return `
              <g>
                <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${bg}" stroke-width="${outerStrokeW + 6}" stroke-linecap="square" />
                <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${wallStroke}" stroke-width="2" stroke-linecap="square" />
              </g>
            `;
          })
          .join('\n')
      : '';

  const windowSegEls =
    theme === 'architectural_bw' && segWindows.length
      ? segWindows
          .map((w) => {
            const s = w?.segment || {};
            const x1 = toPxX(Number(s?.x1));
            const y1 = toPxY(Number(s?.y1));
            const x2 = toPxX(Number(s?.x2));
            const y2 = toPxY(Number(s?.y2));
            if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) return '';
            return `
              <g>
                <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${bg}" stroke-width="${outerStrokeW + 4}" stroke-linecap="square" />
                <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${wallStroke}" stroke-width="1.5" stroke-linecap="square" />
              </g>
            `;
          })
          .join('\n')
      : '';

  
  const segOpeningsForErase = [...segOpenings, ...segTransitionDashForErase];
  const openingSegEls =
    theme === 'architectural_bw' && segOpeningsForErase.length
      ? segOpeningsForErase
          .map((o) => {
            const s = o?.segment || o || {};
            const x1 = toPxX(Number(s?.x1));
            const y1 = toPxY(Number(s?.y1));
            const x2 = toPxX(Number(s?.x2));
            const y2 = toPxY(Number(s?.y2));
            if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) return '';
            return `
              <g>
                <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${bg}" stroke-width="${outerStrokeW + 26}" stroke-linecap="square" />
              </g>
            `;
          })
          .join('\n')
      : '';

  const segTransitionDash = segTransitionDashForErase;
  const transitionDashEls =
    theme === 'architectural_bw' && segTransitionDash.length
      ? segTransitionDash
          .map((o) => {
            const s = o?.segment || o || {};
            const x1 = toPxX(Number(s?.x1));
            const y1 = toPxY(Number(s?.y1));
            const x2 = toPxX(Number(s?.x2));
            const y2 = toPxY(Number(s?.y2));
            if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) return '';
            return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#AAAAAA" stroke-width="1" stroke-dasharray="6 4" stroke-linecap="square" opacity="0.5" />`;
          })
          .join('\n')
      : '';

  
  
  const entryFrontDoorEls = (() => {
    if (theme !== 'architectural_bw') return '';
    const tol = 1e-3;
    const entry = rooms.find((r) => {
      const x = Number(r?.x);
      const y = Number(r?.y);
      const w = Number(r?.w);
      const h = Number(r?.h);
      if (![x, y, w, h].every((n) => Number.isFinite(n))) return false;
      const nm = String(r?.name || '').toLowerCase();
      const isEntry = r?.type === 'entry' || nm.includes('entr');
      const touchesEast = Math.abs(x + w - safeWidthM) < tol;
      const touchesSouth = Math.abs(y + h - safeHeightM) < tol;
      return isEntry && (touchesEast || touchesSouth);
    });
    if (!entry) return '';
    const rx = toPxX(entry.x);
    const ry = toPxY(entry.y);
    const rw = toPxLen(entry.w);
    const rh = toPxLen(entry.h);
    const wPx = Math.max(14, toPxLen(0.9));
    const sw = 2;
    const cutPad = Math.max(2, doorCutPadPx);
    const touchesEast = Math.abs(Number(entry.x) + Number(entry.w) - safeWidthM) < tol;

    if (touchesEast) {
      const hy0 = ry + rh / 2 - wPx / 2;
      const hingeX = rx + rw;
      const hingeY = hy0 + wPx;
      const arcR = Math.min(wPx * 0.95, rw * 0.85, wPx);
      const eraseW = innerStrokeW + cutPad * 2;
      return `
    <g>
      <rect x="${hingeX - eraseW / 2}" y="${hy0 - cutPad}" width="${eraseW}" height="${wPx + cutPad * 2}" fill="${bg}" />
      <line x1="${hingeX}" y1="${hingeY}" x2="${hingeX}" y2="${hingeY - arcR}" stroke="${wallStroke}" stroke-width="${sw}" />
      <path d="M ${hingeX} ${hingeY} A ${arcR} ${arcR} 0 0 0 ${hingeX - arcR} ${hingeY}" fill="none" stroke="${wallStroke}" stroke-width="${sw}" />
    </g>`;
    }

    const cx = rx + rw / 2;
    const x0 = cx - wPx / 2;
    const eraseH = innerStrokeW + cutPad * 2;
    const cutY = ry + rh - eraseH / 2;
    const hingeX = x0;
    const hingeY = ry + rh;
    const arcR = Math.min(wPx * 0.95, rh * 0.45, wPx);
    return `
    <g>
      <rect x="${x0 - cutPad}" y="${cutY - eraseH / 2}" width="${wPx + cutPad * 2}" height="${eraseH}" fill="${bg}" />
      <line x1="${hingeX}" y1="${hingeY}" x2="${hingeX + arcR}" y2="${hingeY}" stroke="${wallStroke}" stroke-width="${sw}" />
      <path d="M ${hingeX} ${hingeY} A ${arcR} ${arcR} 0 0 1 ${hingeX + arcR} ${hingeY - arcR}" fill="none" stroke="${wallStroke}" stroke-width="${sw}" />
    </g>`;
  })();

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${defs}
  <rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>
  ${dimTop}
  ${dimLeft}
  ${dimBottom}
  ${dimRight}
  ${roomFillEls}
  ${outer}
  ${windowEls}
  ${innerWalls}
  ${openingSegEls}
  ${transitionDashEls}
  ${entryFrontDoorEls}
  ${windowSegEls}
  ${doorEls}
  ${doorSegEls}
  ${roomLabelEls}
  <g>
    <text x="${paddingPx}" y="${paddingPx - 14}" font-size="13" font-family="Inter, Arial, sans-serif" fill="#6b7280">
      Plan 2D
    </text>
  </g>
</svg>
  `.trim();

  return svg;
}

