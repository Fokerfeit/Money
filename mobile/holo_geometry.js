// ── MONEY — background geometry (tester feedback Oct 8, item B3) ──────────────
//
// The deep-space background (HoloFX.js) is a stack of SVG layers, zoomed 1.28×
// and shifted up to ±40 dp by the gyroscope. Build 13 sized every layer ONCE, at
// app start, from Dimensions.get('window'). If that number is smaller than the area
// the background really fills (short window report, fold/unfold, split screen),
// a layer's straight edge lands ON the screen — a hard line across the background.
//
// Now: the layers are sized from the background's OWN measured size (onLayout)
// and drawn with an OVERDRAW margin past every edge, so no layer edge can reach the
// screen at any tilt. The base, aurora and vignette fills cover the whole
// overdrawn area (they have no edge of their own inside it).
//
// PURE module (no React Native), so test_tester_feedback_oct8.js executes it.
'use strict';

const SCALE = 1.28;        // zoom applied to the whole background
const PARALLAX = 40;       // max gyro shift, dp, each axis
const OVERDRAW = 0.12;     // extra margin on every side, × the longer side

// Layer layout for a background area of w × h dp.
function bgLayout(w, h) {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  const M = Math.ceil(OVERDRAW * Math.max(W, H));
  return {
    w: W, h: H, M,
    // every layer: absolutely placed at (-M, -M), size (W+2M) × (H+2M),
    // drawing coordinates unchanged (0..W, 0..H is still the visible area)
    style: { position: 'absolute', left: -M, top: -M, width: W + 2 * M, height: H + 2 * M },
    viewBox: `${-M} ${-M} ${W + 2 * M} ${H + 2 * M}`,
    full: { x: -M, y: -M, width: W + 2 * M, height: H + 2 * M },
  };
}

// Where a layer's four edges land on screen. The zoom is about the centre of the
// container (cw × ch, what the background really fills), then the gyro shift.
function layerEdgesOnScreen(layout, cw, ch, parX = 0, parY = 0) {
  const cx = cw / 2, cy = ch / 2;
  const map = (v, c, par) => c + SCALE * (v - c) + par;
  const { left, top, width, height } = layout.style;
  return {
    left: map(left, cx, parX), right: map(left + width, cx, parX),
    top: map(top, cy, parY), bottom: map(top + height, cy, parY),
  };
}

// true when NO layer edge is visible on a cw × ch screen at any tilt
function edgesAlwaysOffScreen(layout, cw, ch) {
  for (const px of [-PARALLAX, 0, PARALLAX]) for (const py of [-PARALLAX, 0, PARALLAX]) {
    const e = layerEdgesOnScreen(layout, cw, ch, px, py);
    if (e.left > 0 || e.top > 0 || e.right < cw || e.bottom < ch) return false;
  }
  return true;
}

// The part of a layer (in its own 0..w coordinates) that is on screen with the
// phone held flat: the 1.28× zoom crops (1 − 1/1.28)/2 ≈ 11% off each side.
const visibleSpan = (w) => { const crop = (w * (1 - 1 / SCALE)) / 2; return [crop, w - crop]; };

// Planet rings fade toward their ends: a horizontal stroke gradient that is fully
// transparent where each ring leaves the visible screen (and beyond — the gradient
// clamps to its transparent end stops), brightest in the middle of its arc.
function ringFade(cx, rx, w) {
  const [visL, visR] = visibleSpan(w);
  const x1 = Math.max(cx - rx, visL), x2 = visR;
  return { x1, x2, stops: [[0, 0], [0.45, 1], [1, 0]] };
}

// Stroke alpha (0..1, before the ring's own opacity) at layer x — the same linear
// interpolation + end clamping Android's LinearGradient (CLAMP) applies.
function ringAlphaAt(fade, x) {
  const t = (x - fade.x1) / (fade.x2 - fade.x1);
  if (!(t > 0) || t >= 1) return 0;
  const s = fade.stops;
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i][0]) { const [o0, a0] = s[i - 1], [o1, a1] = s[i]; return a0 + ((t - o0) / (o1 - o0)) * (a1 - a0); }
  }
  return 0;
}

module.exports = { SCALE, PARALLAX, OVERDRAW, bgLayout, layerEdgesOnScreen, edgesAlwaysOffScreen, visibleSpan, ringFade, ringAlphaAt };
