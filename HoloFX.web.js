// ═══════════════════════════════════════════════════════════════════════════
// HoloFX.web.js — v3  CINEMATIC PREMIUM BILLBOARD EDITION
// Three.js r184 · GSAP 3.15 · WebGL
//
// What's new in v3:
//  • PlaneGeometry filled glass panels (real glass, not wireframe boxes)
//  • 3D metallic-gold logo with 3 electron-orbit rings
//  • Halo disc sprites around each orb for volumetric depth
//  • Premium CSS: shimmer sweep, moving scanlines, text glow, border cycle
//  • Camera FOV 32° + slight Y-offset for low-angle cinematic drama
//  • Orbs 25 % larger, halos 2× wider
//  • 1 200 particles with multi-frequency orbital drift
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect } from 'react';
import * as THREE from 'three';
import { gsap } from 'gsap';

// Module-level asset import — Metro resolves this to the correct URL on web
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _logoSrc = (() => {
  try {
    const r = require('./assets/logo.png');
    // Expo web: require returns {uri:'...'} or a string
    return (r && typeof r === 'object' && r.uri) ? r.uri : (typeof r === 'string' ? r : null);
  } catch { return null; }
})();

const IS_WEB = typeof document !== 'undefined';

// ─────────────────────────────────────────────────────────────────────────────
// CSS — premium glass cards, buttons, text glow
// ─────────────────────────────────────────────────────────────────────────────
function injectCSS () {
  document.getElementById('holofx-v3')?.remove();   // always replace on HMR
  const s = document.createElement('style');
  s.id = 'holofx-v3';
  s.textContent = `
    /* ── dark stage ── */
    /* Body/html must be TRANSPARENT so the z:-1 bgCanvas (which provides the
       dark background) is not painted over by the body background fill.
       The bgCanvas renderer now clears to #060300 (opaque) instead.          */
    html, body { background-color: transparent !important; }
    /* React Native web renders nested divs — make them all transparent so the
       canvas swarm shows through the app layout                              */
    #root > div, #root > div > div, #root > div > div > div {
      background-color: transparent !important;
    }
    #native-glow-orbs { display: none !important; }

    /* ── stacking context fix ──
       React Native web content lives in #root at z:auto (0), which is BELOW the
       border div (z:3) and billboard canvas (z:2). Cards at z:4 INSIDE #root only
       stack within #root's stacking context — they don't beat the document-level
       border. Fix: give #root a document-level z:4 so ALL app content is above the
       border. Billboard canvas moves to z:6 so it still appears above app content.
       Border at z:3 becomes purely a decorative bg frame — never covers content. */
    #root {
      position: relative;
      z-index: 4;
    }

    /* ── header: fully transparent, no border — 3D billboard is the logo ── */
    #app-header {
      background-color: transparent !important;
      border-bottom-color: transparent !important;
    }
    /* hide the native pulse-ring circles on web; the 2D logo <img> shows alongside
       the chrome 3D ornament orbs (handled by App.js Platform check too) */
    #app-header [style*="border-radius: 65px"],
    #app-header [style*="border-radius:65px"] {
      display: none !important;
    }

    /* ══════════  KEYFRAMES  ══════════ */

    @keyframes card-glow {
      0%,100% {
        box-shadow:
          0 44px 88px rgba(0,0,0,.90),
          0 18px 36px rgba(0,0,0,.75),
          -16px 0 38px rgba(0,0,0,.58),
           16px 0 38px rgba(0,0,0,.58),
          0 0 0 1px rgba(212,175,55,.22),
          0 0 28px rgba(212,175,55,.10), 0 0 70px rgba(0,220,255,.06),
          inset 0 1px 0 rgba(255,255,255,.16), inset 0 -1px 0 rgba(0,0,0,.30);
      }
      50% {
        box-shadow:
          0 48px 96px rgba(0,0,0,.93),
          0 20px 40px rgba(0,0,0,.80),
          -18px 0 44px rgba(0,0,0,.64),
           18px 0 44px rgba(0,0,0,.64),
          0 0 0 1px rgba(212,175,55,.55),
          0 0 55px rgba(212,175,55,.26), 0 0 140px rgba(0,220,255,.12),
          inset 0 1px 0 rgba(255,255,255,.24), inset 0 -1px 0 rgba(0,0,0,.30);
      }
    }
    @keyframes holo-border {
      0%,100% { border-color: rgba(212,175,55,.22); }
      30%      { border-color: rgba(0,220,255,.28);  }
      65%      { border-color: rgba(255,80,0,.20);   }
    }
    @keyframes shimmer {
      0%   { left: -90%; opacity: 0; }
      8%   { opacity: 1; }
      92%  { opacity: 1; }
      100% { left: 140%; opacity: 0; }
    }
    @keyframes scan-drift {
      from { background-position: 0 0;    }
      to   { background-position: 0 -60px; }
    }
    @keyframes holo-flicker {
      0%,94%,100% { opacity: 1;    }
      95%          { opacity: .93; }
      97%          { opacity: 1;   }
      98%          { opacity: .88; }
      99%          { opacity: 1;   }
    }
    @keyframes btn-elevate {
      0%,100% { transform: perspective(700px) translateZ(22px) translateY(0px);  }
      50%      { transform: perspective(700px) translateZ(30px) translateY(-5px); }
    }
    @keyframes btn-fire {
      0%,100% {
        box-shadow:
          0 0 28px rgba(212,175,55,.48), 0 0 65px rgba(212,175,55,.22),
          inset 0 0 20px rgba(212,175,55,.12),
          0 20px 52px rgba(0,0,0,.80),
          inset 0 1px 0 rgba(255,255,255,.22);
      }
      50% {
        box-shadow:
          0 0 55px rgba(212,175,55,.75), 0 0 130px rgba(212,175,55,.38),
          inset 0 0 32px rgba(212,175,55,.22),
          0 20px 52px rgba(0,0,0,.80),
          inset 0 1px 0 rgba(255,255,255,.30);
      }
    }

    /* ══════════  PREMIUM GLASS CARD  ══════════ */
    .bb-card {
      position: relative !important;
      z-index: 4 !important;
      /* NO width/margin override — cards stay at their React Native layout width.
         The ScrollView clips at x=0; expanding cards left causes text cut-off.
         Depth illusion comes from translateZ + shadows, not from border overlap. */
      /* Cursor-wobble: JS writes --rot-x / --rot-y; transition smooths it */
      transform: perspective(1200px)
        rotateX(calc(-5deg + var(--rot-x, 0deg)))
        rotateY(var(--rot-y, 0deg))
        translateZ(18px) !important;
      transform-origin: center 55%;
      transform-style: preserve-3d;
      transition: transform 0.14s ease-out, border-color 0.40s ease !important;
      background: linear-gradient(
        148deg,
        rgba(22,13,5,.92) 0%,
        rgba(12,7,2,.88) 48%,
        rgba(18,11,3,.90) 100%
      ) !important;
      backdrop-filter: blur(44px) saturate(290%) brightness(1.20) !important;
      -webkit-backdrop-filter: blur(44px) saturate(290%) brightness(1.20) !important;
      border: 1px solid rgba(212,175,55,.22) !important;
      border-top: 1px solid rgba(255,255,255,.14) !important;
      border-radius: 14px !important;
      overflow: hidden !important;
      animation:
        card-glow    4.5s ease-in-out infinite,
        holo-border  9s   ease-in-out infinite,
        holo-flicker 22s  ease-in-out infinite;
    }
    /* shimmer sweep */
    .bb-card::before {
      content: '';
      position: absolute;
      top: 0; left: -90%; width: 55%; height: 100%;
      background: linear-gradient(90deg,
        transparent 0%,
        rgba(255,255,255,.055) 38%,
        rgba(212,175,55,.038) 50%,
        rgba(255,255,255,.055) 62%,
        transparent 100%
      );
      animation: shimmer 6s ease-in-out infinite;
      pointer-events: none;
      z-index: 10;
    }
    /* moving scanlines */
    .bb-card::after {
      content: '';
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent, transparent 3px,
        rgba(0,200,255,.013) 3px, rgba(0,200,255,.013) 4px
      );
      pointer-events: none;
      z-index: 9;
      animation: scan-drift 2.5s linear infinite;
    }
    /* text glow */
    .bb-card * {
      text-shadow:
        0 0 10px rgba(212,175,55,.34),
        0 1px 3px rgba(0,0,0,.90) !important;
    }
    .bb-card:hover {
      border-color:     rgba(212,175,55,.82) !important;
      border-top-color: rgba(255,255,255,.36) !important;
    }

    /* ══════════  PREMIUM GLASS BUTTON  ══════════ */
    .bb-btn {
      position: relative !important;
      z-index: 4 !important;
      /* Cursor-wobble via CSS variables */
      transform: perspective(700px)
        rotateX(var(--rot-x, 0deg))
        rotateY(var(--rot-y, 0deg))
        translateZ(22px) !important;
      transform-origin: center;
      transform-style: preserve-3d;
      border: 1px solid rgba(212,175,55,.60) !important;
      border-top: 1px solid rgba(255,255,255,.30) !important;
      border-radius: 10px !important;
      overflow: hidden !important;
      cursor: pointer;
      transition: transform 0.14s ease-out, box-shadow .25s ease, filter .25s ease !important;
      animation:
        btn-fire    2.8s ease-in-out infinite,
        holo-flicker 18s ease-in-out infinite;
      box-shadow:
        0 0 28px rgba(212,175,55,.48), 0 0 65px rgba(212,175,55,.22),
        inset 0 0 20px rgba(212,175,55,.12),
        0 28px 60px rgba(0,0,0,.88),
        inset 0 1px 0 rgba(255,255,255,.22) !important;
    }
    /* shimmer sweep */
    .bb-btn::before {
      content: '';
      position: absolute;
      top: 0; left: -90%; width: 55%; height: 100%;
      background: linear-gradient(90deg,
        transparent 0%, rgba(255,255,255,.14) 50%, transparent 100%
      );
      animation: shimmer 3.5s ease-in-out infinite;
      pointer-events: none;
      z-index: 2;
    }
    /* text glow */
    .bb-btn * {
      text-shadow:
        0 0 14px rgba(212,175,55,.60),
        0 1px 2px rgba(0,0,0,.92) !important;
      letter-spacing: .04em;
    }
    .bb-btn:hover {
      transform: perspective(700px) rotateX(var(--rot-x,0deg)) rotateY(var(--rot-y,0deg)) translateZ(38px) scale(1.034);
      filter: brightness(1.20) saturate(1.22);
      box-shadow:
        0 0 55px rgba(212,175,55,.75), 0 0 130px rgba(212,175,55,.38),
        inset 0 0 30px rgba(212,175,55,.22),
        -5px 0 24px rgba(0,220,255,.20),  5px 0 24px rgba(255,80,0,.16),
        0 28px 68px rgba(0,0,0,.88),
        inset 0 1px 0 rgba(255,255,255,.30) !important;
    }
    .bb-btn:active { transform: perspective(700px) translateZ(8px) scale(.97); }

    /* ══════════  OATH CHECKBOXES — CONCAVE + GLOW  ══════════ */
    /*
     * .bb-term   — unchecked: optical illusion of a hole going INTO the screen.
     *              Achieved by:
     *              • Heavy inset shadows on all 4 sides (deep top shadow = ceiling of hole)
     *              • Radial gradient darkest off-centre (floor of hole catches no light)
     *              • Top border near-black, bottom border warm amber (light from below hole)
     *              • Slight perspective recede — box appears to sit behind the surface plane
     *
     * .bb-term-checked — checked: same concave depth but the hole is now lit from inside.
     *              The ✓ glyph acts as a light source; gold glow pulses outward.
     *              inset shadow retained so it never "pops out" — it glows INWARD.
     */

    @keyframes term-glow {
      0%,100% {
        box-shadow:
          inset 0 2px 7px rgba(0,0,0,.52),
          0 0  9px rgba(255,215,55,.88),
          0 0 20px rgba(212,175,55,.62),
          0 0 42px rgba(212,175,55,.30),
          0 0  2px rgba(255,250,160,.96),
          0 6px 14px rgba(0,0,0,.70);
      }
      50% {
        box-shadow:
          inset 0 2px 7px rgba(0,0,0,.52),
          0 0 15px rgba(255,220,60,1.0),
          0 0 34px rgba(212,175,55,.85),
          0 0 66px rgba(212,175,55,.42),
          0 0  3px rgba(255,255,190,1.0),
          0 6px 14px rgba(0,0,0,.70);
      }
    }

    /* ── Unchecked: deep concave pit ── */
    .bb-term {
      position: relative !important;
      z-index: 4 !important;
      cursor: pointer !important;
      border-radius: 6px !important;
      overflow: visible !important;
      animation: none !important;
      transition: box-shadow .22s ease, transform .18s ease !important;
      /* Dark radial — off-centre so it reads like a curved concave surface */
      background: radial-gradient(ellipse 80% 70% at 38% 32%,
        rgba(10,5,0,.55) 0%,
        rgba(2,1,0,.90) 55%,
        rgba(0,0,0,.98) 100%
      ) !important;
      /* Top-heavy inset: ceiling of the hole is darkest */
      box-shadow:
        inset 0  4px 12px rgba(0,0,0,.94),   /* ceiling shadow */
        inset 0 -2px  5px rgba(90,55,0,.18), /* warm floor bounce */
        inset  3px 0  9px rgba(0,0,0,.74),   /* left wall */
        inset -2px 0  6px rgba(0,0,0,.55),   /* right wall */
        0 1px 4px rgba(0,0,0,.60),            /* outer depth */
        0 0 1px rgba(212,175,55,.16) !important; /* gold rim trace */
      /* Top border black = shadow edge; bottom border gold = light at floor of hole */
      border-width: 2px !important;
      border-style: solid !important;
      border-color:  rgba(212,175,55,.14) !important;
      border-top-color:    rgba(0,0,0,.88) !important;
      border-bottom-color: rgba(212,175,55,.32) !important;
      /* Recede behind surface plane */
      transform: perspective(280px) translateZ(-6px) !important;
      transform-origin: center !important;
    }
    .bb-term:hover {
      box-shadow:
        inset 0 4px 12px rgba(0,0,0,.94),
        inset 0 -2px 5px rgba(120,75,0,.28),
        inset  3px 0  9px rgba(0,0,0,.74),
        inset -2px 0  6px rgba(0,0,0,.55),
        0 0 6px rgba(212,175,55,.30),
        0 0 1px rgba(212,175,55,.30) !important;
    }
    /* ✓ glyph inside unchecked hole: invisible (shouldn't appear, but fallback) */
    .bb-term * { color: transparent !important; }

    /* ── Checked: glowing concave pit ── */
    .bb-term-checked {
      position: relative !important;
      z-index: 5 !important;
      cursor: pointer !important;
      border-radius: 6px !important;
      overflow: visible !important;
      transition: box-shadow .22s ease, transform .18s ease !important;
      /* Bright gold centre — hole filled with light, edges still dark = depth maintained */
      background: radial-gradient(ellipse 90% 80% at 50% 48%,
        rgba(255,235,100,.96) 0%,
        rgba(212,175,55,.90)  32%,
        rgba(160,105,12,.72)  65%,
        rgba(80,45,0,.88)    100%
      ) !important;
      border-width: 2px !important;
      border-style: solid !important;
      border-color:  rgba(255,225,70,.88) !important;
      border-top-color:    rgba(255,255,200,.65) !important;
      border-bottom-color: rgba(180,130,10,.90) !important;
      /* Concave inset + external gold glow — pulses via animation */
      animation: term-glow 2.2s ease-in-out infinite !important;
      /* Barely recede — less than unchecked so it appears to "rise" when activated */
      transform: perspective(280px) translateZ(-2px) !important;
      transform-origin: center !important;
    }
    /* ✓ glyph: dark on gold background, text-shadow for inner engraving depth */
    .bb-term-checked * {
      color: rgba(80,40,0,.90) !important;
      text-shadow:
        0 1px 0 rgba(255,255,180,.40),
        0 -1px 2px rgba(0,0,0,.55) !important;
      font-weight: 900 !important;
    }

    /* ══════════  DOMAIN BAR  ══════════ */
    /* Persistent identity strip — z:10 floats above the 3D canvas (z:2) */
    #holo-domain-bar {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 10;
      padding: 10px 0 8px;
      text-align: center;
      pointer-events: none;
      background: linear-gradient(to bottom, rgba(3,1,0,0.82) 0%, transparent 100%);
      color: rgba(212,175,55,0.60);
      font-size: 11px;
      letter-spacing: 3.5px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      text-shadow: 0 0 14px rgba(212,175,55,0.40), 0 1px 2px rgba(0,0,0,0.90);
    }

    /* ══════════  BLACK GLOSS BORDER — 15 % all sides  ══════════ */
    /* Opaque black frame with subtle gloss sheen. z:3 = above billboard(z:2)
       Cards at z:4 overlap this frame for the physical depth illusion.     */
    #holo-border {
      position: fixed;
      inset: 0;
      z-index: 3;
      pointer-events: none;
      background:
        /* Top strip — gloss fades from warm-dark-grey to pure black */
        linear-gradient(to bottom,
          rgba(52,46,40,1) 0%, rgba(18,14,10,1) 22%, rgba(0,0,0,1) 100%)
          0 0 / 100% 15vh no-repeat,
        /* Bottom strip */
        linear-gradient(to top,
          rgba(42,38,34,1) 0%, rgba(14,11,8,1) 22%, rgba(0,0,0,1) 100%)
          0 100% / 100% 15vh no-repeat,
        /* Left strip */
        linear-gradient(to right,
          rgba(52,46,40,1) 0%, rgba(18,14,10,1) 22%, rgba(0,0,0,1) 100%)
          0 0 / 15vw 100% no-repeat,
        /* Right strip */
        linear-gradient(to left,
          rgba(42,38,34,1) 0%, rgba(14,11,8,1) 22%, rgba(0,0,0,1) 100%)
          100% 0 / 15vw 100% no-repeat;
    }

    /* Gold inner frame line — the "border box" at the edge of the content area */
    #holo-border::after {
      content: '';
      position: absolute;
      inset: 15vh 15vw;
      pointer-events: none;
      border: 1.5px solid rgba(212,175,55,0.60);
      box-shadow:
        0  0 16px rgba(212,175,55,0.22),
        0  0  5px rgba(212,175,55,0.10),
        inset 0 0 12px rgba(212,175,55,0.06);
    }
  `;
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — Glass Panel  (PlaneGeometry, DoubleSide, transparent)
// ─────────────────────────────────────────────────────────────────────────────
const GLASS_VS = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main(){
    vUv = uv;
    vec4 wPos = modelMatrix * vec4(position,1.0);
    vNormal   = normalize(normalMatrix * normal);
    vViewDir  = normalize(cameraPosition - wPos.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
  }
`;
const GLASS_FS = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  uniform float uTime;
  uniform vec3  uColor;

  float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5); }
  float n21(vec2 p){
    vec2 i=floor(p), f=fract(p), u=f*f*(3.-2.*f);
    return mix(mix(h21(i),h21(i+vec2(1,0)),u.x),
               mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x),u.y);
  }
  /* thin-film iridescence */
  vec3 iri(float t, float time){
    float f = t*6.2832 + time*.22;
    return vec3(.5+.5*cos(f), .5+.5*cos(f+2.094), .5+.5*cos(f+4.189));
  }
  /* caustic light ripples */
  float caustic(vec2 uv, float t){
    vec2 p = uv*4.0;
    float c = sin(p.x*3.1+t*.7)*cos(p.y*2.4-t*.5);
    c      += sin(p.x*5.2-t*.3)*cos(p.y*4.1+t*.8);
    c      += n21(p+t*.18)*.45;
    return max(0.0,c)*.34;
  }

  void main(){
    float fres = pow(1.0-max(0.,dot(vViewDir,vNormal)),3.0);

    float caust = caustic(vUv, uTime);

    /* iridescent colour on Fresnel edges */
    vec3 iriCol = iri(fres, uTime);

    /* glass body */
    vec3 col = uColor*.28 + uColor*caust*.90;
    col = mix(col, iriCol*uColor*.65 + iriCol*.40, fres*.72);

    /* scanlines */
    float scan = sin(vUv.y*90.0+uTime*2.5)*.04+.96;
    col *= scan;

    /* micro grain */
    col += n21(vUv*80.0+uTime)*.04;

    /* edge neon frame (brighten all 4 borders) */
    float ex = smoothstep(0.,.065,vUv.x)*(1.-smoothstep(.935,1.,vUv.x));
    float ey = smoothstep(0.,.065,vUv.y)*(1.-smoothstep(.935,1.,vUv.y));
    float edge = 1.-ex*ey;
    col += uColor*edge*2.20;

    float alpha = fres*.65 + caust*.30 + edge*.72 + .10;
    gl_FragColor = vec4(col, clamp(alpha,0.,0.94));
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — Holographic Orb
// ─────────────────────────────────────────────────────────────────────────────
const ORB_VS = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main(){
    vUv = uv;
    vec4 wPos = modelMatrix * vec4(position,1.0);
    vNormal  = normalize(normalMatrix * normal);
    vViewDir = normalize(cameraPosition - wPos.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
  }
`;
const ORB_FS = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  uniform float uTime;
  uniform vec3  uColor;

  float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5); }
  float n21(vec2 p){
    vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);
    return mix(mix(h21(i),h21(i+vec2(1,0)),u.x),
               mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x),u.y);
  }
  float fbm(vec2 p){
    float v=0.,a=.5;
    for(int i=0;i<4;i++){v+=a*n21(p);p=p*2.1+.7;a*=.5;}
    return v;
  }

  void main(){
    float fres = pow(1.-max(0.,dot(vViewDir,vNormal)),2.5);
    float band = fbm(vUv*3.0+vec2(0.,uTime*.28));
    band = sin(band*10.+uTime*.75)*.5+.5;

    vec3 col = uColor*(.22+band*.42);
    col += uColor*fres*2.20;                         /* rim glow */

    float d     = distance(vUv,vec2(.5));
    col += uColor*exp(-d*8.5)*.32;                  /* inner bright spot */

    float flick = n21(vec2(uTime*12.,0.))*.06+.97;
    col *= flick;

    float alpha = fres*.82 + exp(-d*8.0)*.35 + band*.14 + .06;
    gl_FragColor = vec4(col, clamp(alpha,0.,0.96));
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — Halo disc  (large flat ring around each orb)
// ─────────────────────────────────────────────────────────────────────────────
const HALO_VS = `
  varying vec2 vUv;
  void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }
`;
const HALO_FS = `
  varying vec2 vUv;
  uniform vec3  uColor;
  uniform float uTime;
  void main(){
    vec2  uv  = vUv-.5;
    float r   = length(uv);
    float ring = exp(-abs(r-.36)*22.0)*.50;          /* bright ring */
    float glow = exp(-r*5.5)*.14;                    /* soft inner fill */
    float pulse= sin(uTime*2.4+r*9.0)*.07+.93;
    float alpha= (ring+glow)*pulse*.65;
    gl_FragColor = vec4(uColor*1.7, alpha);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — Metallic Logo  (IcosahedronGeometry, gold metallic)
// ─────────────────────────────────────────────────────────────────────────────
const METAL_VS = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vPos;
  void main(){
    vPos    = position;
    vNormal = normalize(normalMatrix * normal);
    vec4 wPos = modelMatrix * vec4(position,1.);
    vViewDir  = normalize(cameraPosition - wPos.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.);
  }
`;
const METAL_FS = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vPos;
  uniform float uTime;
  uniform vec3  uColor;

  void main(){
    float fres = pow(1.-max(0.,dot(vViewDir,vNormal)),2.5);

    vec3 L1 = normalize(vec3(1.,2.,3.));
    vec3 L2 = normalize(vec3(-2.,1.5,1.));
    float d1 = max(0.,dot(vNormal,L1));
    float d2 = max(0.,dot(vNormal,L2));
    vec3  h1 = normalize(L1+vViewDir);
    vec3  h2 = normalize(L2+vViewDir);
    float s1 = pow(max(0.,dot(vNormal,h1)),80.);
    float s2 = pow(max(0.,dot(vNormal,h2)),40.);

    vec3 dark  = vec3(.42,.28,.04);
    vec3 light = vec3(1.,.86,.36);
    vec3 col   = mix(dark, light, d1*.72+d2*.28);
    col += vec3(1.,.90,.50)*(s1*.85+s2*.42);
    col += uColor*fres*.65;

    float shimmer = sin(uTime*3.0+vPos.x*4.0)*.06+.97;
    col *= shimmer;

    gl_FragColor = vec4(col, 1.);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — Particles
// ─────────────────────────────────────────────────────────────────────────────
const PART_VS = `
  attribute float aSize;
  attribute float aPhase;
  attribute float aSpeed;
  uniform   float uTime;
  varying   float vAlpha;
  void main(){
    vec3 p = position;
    float t = uTime*aSpeed+aPhase;
    p.x += sin(t*.70+aPhase)  *9.0;
    p.y += cos(t*.53+aPhase*2.)*6.0;
    p.z += sin(t*.90+aPhase*3.)*7.0;
    vAlpha = (sin(t*1.3)*.5+.5)*.65+.15;
    vec4 mv = modelViewMatrix*vec4(p,1.);
    gl_PointSize = aSize*(190./-mv.z);
    gl_Position  = projectionMatrix*mv;
  }
`;
const PART_FS = `
  varying float vAlpha;
  uniform vec3 uColor;
  void main(){
    vec2  c = gl_PointCoord-.5;
    float r = dot(c,c);
    if(r>.25) discard;
    gl_FragColor = vec4(uColor*1.6, (1.-r*4.)*vAlpha);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — Volumetric light cone
// ─────────────────────────────────────────────────────────────────────────────
const VOL_VS = `
  varying vec2 vUv;
  void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }
`;
const VOL_FS = `
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3  uColor;
  void main(){
    float dist   = 1.-vUv.y;
    float radial = 1.-smoothstep(0.,.5,length(vUv-vec2(.5,vUv.y)));
    float pulse  = sin(uTime*2.0)*.15+.85;
    float alpha  = dist*radial*pulse*.20;
    gl_FragColor = vec4(uColor*1.5, alpha);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Three.js helpers
// ─────────────────────────────────────────────────────────────────────────────
function makeRenderer (canvas, aa) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: aa, alpha: true });
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  r.setSize(window.innerWidth, window.innerHeight);
  r.setClearColor(0x000000, 0);
  return r;
}

// Glass panel  — PlaneGeometry with glass shader + neon edge outline
function makeGlassPanel (scene, uniforms, w, h, x, y, z, rx, ry, rz, hex) {
  const col = new THREE.Color(hex);
  const uniSet = { uTime: { value: 0 }, uColor: { value: col } };
  uniforms.push(uniSet);

  // Filled glass surface
  const mat = new THREE.ShaderMaterial({
    vertexShader: GLASS_VS, fragmentShader: GLASS_FS,
    uniforms: uniSet,
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.NormalBlending,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 10, 10), mat);

  // Neon edge outline (uses EdgesGeometry of a thin box)
  const edgeGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h));
  const edgeMat = new THREE.LineBasicMaterial({
    color: hex, transparent: true, opacity: 0.92,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const edges = new THREE.LineSegments(edgeGeo, edgeMat);

  const g = new THREE.Group();
  g.add(mesh, edges);
  g.position.set(x, y, z);
  g.rotation.set(rx, ry, rz);
  scene.add(g);
  return g;
}

// Holographic orb
function makeOrb (scene, uniforms, radius, x, y, z, hex) {
  const col = new THREE.Color(hex);
  const uniSet = { uTime: { value: 0 }, uColor: { value: col } };
  uniforms.push(uniSet);

  const mat  = new THREE.ShaderMaterial({
    vertexShader: ORB_VS, fragmentShader: ORB_FS, uniforms: uniSet,
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 64), mat);
  mesh.position.set(x, y, z);
  scene.add(mesh);

  // Torus ring
  const ringMat = new THREE.MeshBasicMaterial({
    color: hex, transparent: true, opacity: 0.55,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.65, 0.55, 16, 120), ringMat);
  ring.position.set(x, y, z);
  ring.rotation.x = Math.PI / 2 + (Math.random() - .5) * .8;
  ring.rotation.z = (Math.random() - .5) * .5;
  scene.add(ring);
  return mesh;
}

// Halo disc (large glowing ring behind orb)
function makeHalo (scene, uniforms, r, x, y, z, hex) {
  const uniSet = { uTime: { value: 0 }, uColor: { value: new THREE.Color(hex) } };
  uniforms.push(uniSet);
  const mat  = new THREE.ShaderMaterial({
    vertexShader: HALO_VS, fragmentShader: HALO_FS, uniforms: uniSet,
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), mat);
  mesh.position.set(x, y, z - 2);   // slightly behind the orb
  scene.add(mesh);
  return mesh;
}

// Volumetric light cone
function makeVolCone (scene, uniforms, x, y, z, hex) {
  const uniSet = { uTime: { value: 0 }, uColor: { value: new THREE.Color(hex) } };
  uniforms.push(uniSet);
  const mat  = new THREE.ShaderMaterial({
    vertexShader: VOL_VS, fragmentShader: VOL_FS, uniforms: uniSet,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(22, 65, 32, 1, true), mat);
  mesh.position.set(x, y, z);
  scene.add(mesh);
  return mesh;
}

// Particle field
function makeParticles (scene, uniforms) {
  const N = 1200;
  const pos   = new Float32Array(N * 3);
  const sizes = new Float32Array(N);
  const phase = new Float32Array(N);
  const speed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i*3]   = (Math.random() - .5) * 260;
    pos[i*3+1] = (Math.random() - .5) * 180;
    pos[i*3+2] = (Math.random() - .5) * 240 - 40;
    sizes[i]   = Math.random() * 2.4 + 0.8;
    phase[i]   = Math.random() * Math.PI * 2;
    speed[i]   = Math.random() * 0.35 + 0.15;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos,   3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aPhase',   new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSpeed',   new THREE.BufferAttribute(speed, 1));

  const uniSet = { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xD4AF37) } };
  uniforms.push(uniSet);
  const mat  = new THREE.ShaderMaterial({
    vertexShader: PART_VS, fragmentShader: PART_FS, uniforms: uniSet,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  scene.add(new THREE.Points(geo, mat));
}

// Depth grid
function makeGrid (scene) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xD4AF37, transparent: true, opacity: 0.06,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const grid = new THREE.GridHelper(500, 40, 0xD4AF37, 0xD4AF37);
  grid.material = mat;
  grid.position.y = -105;
  scene.add(grid);
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic HDR environment map for MeshPhysicalMaterial (premium PBR chrome)
// Baked equirectangular light probe: warm key, amber fill, cyan rim, floor bounce
// ─────────────────────────────────────────────────────────────────────────────
function makeEnv (renderer) {
  const W = 512, H = 256;
  const d = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const phi = x / W * Math.PI * 2, th = y / H * Math.PI;
    const sx = Math.sin(th)*Math.cos(phi), sy = Math.cos(th), sz = Math.sin(th)*Math.sin(phi);
    let R = 0.02, G = 0.01, B = 0.02;
    const k = Math.max(0, -0.6*sx + 0.55*sy + 0.55*sz); R += k*k*8;  G += k*k*3;   B += k*k*0.3;
    const tp = Math.max(0, sy)*0.6;                       R += tp*0.35; G += tp*0.18; B += tp*0.04;
    const f  = Math.max(0, 0.52*sx - 0.42*sy - 0.74*sz); R += f*f*0.06; G += f*f*2; B += f*f*4;
    const rm = Math.max(0, 0.92*sx + 0.02*sy + 0.38*sz); R += rm*rm*4; G += rm*rm*0.12; B += rm*rm*0.2;
    const fl = Math.max(0, -sy);                          R += fl*fl;   G += fl*fl*0.42; B += fl*fl*0.06;
    const i = (y*W + x)*4; d[i] = R; d[i+1] = G; d[i+2] = B; d[i+3] = 1;
  }
  const tx = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  tx.mapping = THREE.EquirectangularReflectionMapping;
  tx.needsUpdate = true;
  const pm = new THREE.PMREMGenerator(renderer);
  pm.compileEquirectangularShader();
  const envTex = pm.fromEquirectangular(tx).texture;
  pm.dispose(); tx.dispose();
  return envTex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Studio lights for the FG scene (required for MeshPhysicalMaterial)
// ─────────────────────────────────────────────────────────────────────────────
function makeHeroLights (scene) {
  // Minimal ambient — dark surfaces stay dark, chrome relies on env map
  scene.add(new THREE.AmbientLight(0xFFFFFF, 0.06));

  // Warm amber key — drives chrome blob reflections
  const key = new THREE.PointLight(0xFF9040, 2.2, 320);
  key.position.set(-40, 72, 32);
  scene.add(key);

  // Red/magenta rim — accent on chrome facets
  const rim = new THREE.PointLight(0xFF1840, 1.1, 280);
  rim.position.set(42, 22, -42);
  scene.add(rim);
  // NO blue/cyan fill — that was the source of the blue tint on ledge and frame
}

// ─────────────────────────────────────────────────────────────────────────────
// Anamorphic billboard — vertical grey SCREEN behind the hero blob.
// Mimics the Red XIII FF7 billboard: the grey area IS the display surface.
// Blob (z=-5) floats IN FRONT of the screen (z=-16).
// A directional light positioned in front of the scene shines BACKWARD so the
// blob casts a real shadow on the vertical screen — the anamorphic depth cue.
// Gold frame borders the screen; CSS holo-vignette sits on top as the outermost
// border layer, making the 3D objects appear to truly pop out.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Three Orbits (shape G) — three interlocked chrome rings + dark central sphere
// Acts as the hero object above the billboard, casting orbital ring shadows
// onto the grey screen below it.
// ─────────────────────────────────────────────────────────────────────────────
function makeThreeOrbits (scene, envMap) {
  const ringMat = new THREE.MeshPhysicalMaterial({
    color: 0xC8C8D4, metalness: 1.0, roughness: 0.06,
    envMap, envMapIntensity: 3.5,
    clearcoat: 1, clearcoatRoughness: 0.02,
  });
  // Larger rings (r=11, tube=0.45) — they extend well above the gold frame top
  // (frame top bar at y≈33.7), creating the naked-eye 3D billboard illusion.
  const ringGeo = new THREE.TorusGeometry(11, 0.45, 24, 120);

  // Ring 1 — equatorial (horizontal plane)
  const r1 = new THREE.Mesh(ringGeo, ringMat);
  r1.rotation.x = Math.PI / 2;
  r1.castShadow = true;

  // Ring 2 — vertical meridian: its top/bottom reach y = group_y ± 11
  const r2 = new THREE.Mesh(ringGeo, ringMat);
  r2.castShadow = true;

  // Ring 3 — tilted 60° orbit
  const r3 = new THREE.Mesh(ringGeo, ringMat);
  r3.rotation.y = Math.PI / 6;
  r3.rotation.z = Math.PI / 3;
  r3.castShadow = true;

  // Central sphere — large chrome mercury orb.
  // Radius 7.5 (was 5.5): sphere bottom at y≈28.5 straddles the frame top bar
  // (y=33.7), sphere top at y≈43.5 pushes above the viewport top edge.
  // This is the lion-billboard effect: the object physically overflows the frame.
  const sphereMat = new THREE.MeshPhysicalMaterial({
    color:              0x070710,    // near-black base so bright areas really pop
    metalness:          1.0,
    roughness:          0.02,        // mirror smooth
    envMap,
    envMapIntensity:    4.5,
    clearcoat:          1.0,
    clearcoatRoughness: 0.01,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(7.5, 64, 64), sphereMat);
  sphere.castShadow = true;

  const group = new THREE.Group();
  group.add(r1, r2, r3, sphere);
  // ── THE CAT EFFECT ─────────────────────────────────────────────────────────
  // Frame top bar is at y = SY + HALF_H + 0.7 = 22 + 11 + 0.7 = 33.7
  // Group y=36: sphere bottom = 36−7.5 = 28.5 (inside frame → anchor point)
  //             sphere top    = 36+7.5 = 43.5 (above frame by 9.8 u → pops out)
  //             ring-2 top    = 36+11  = 47   (even further above → dramatic overflow)
  // Shadow of orb/rings falls on grey screen below → sells the 3D depth.
  // z=+6: all geometry in front of logo plane (z=−14) and screen (z=−16).
  group.position.set(0, 36, 6);
  scene.add(group);
  return { group, rings: [r1, r2, r3] };
}

function makeHeroBillboard (scene, envMap) {
  // Positions calibrated for mobile portrait (375×812).
  // Camera at (0,-5,95) lookAt(0,8,0) → visible y: -19 to +35.
  // On desktop the screen appears as a centred billboard; on mobile it fills the view.
  const SY = 22;   // screen centre y  — upper viewport → header zone
  const SZ = -16;  // screen z

  // ── VERTICAL grey screen — pure diffuse, no env map, shows shadow clearly ──
  const screenMat = new THREE.MeshStandardMaterial({
    color: 0x464650, roughness: 0.95, metalness: 0.0, envMap: null,
  });
  // SCREEN_H = 22: billboard fills the top ~40 % of the viewport (header zone).
  // Width 24.0 keeps the screen wider than tall — cinematic landscape header ratio.
  const SCREEN_H = 22;
  // BoxGeometry instead of PlaneGeometry: depth 0.5 so the FRONT face sits at
  // z = SZ+0.5 = −15.5 — exactly coplanar with the frame rail faces.
  // No Z-angle gap between screen surface and gold rails = no visible seam.
  // (box centre at SZ+0.25 = −15.75; front face = centre + depth/2 = −15.5)
  const screenMesh = new THREE.Mesh(new THREE.BoxGeometry(24.0, SCREEN_H, 0.5), screenMat);
  screenMesh.position.set(0, SY, SZ + 0.25);
  screenMesh.receiveShadow = true;
  scene.add(screenMesh);

  // ── gold frame — MeshBasicMaterial, env map CANNOT tint it ──
  const frameMat = new THREE.MeshBasicMaterial({ color: 0xD4AF37 });
  const HALF_H = SCREEN_H / 2;           // 11

  // Top bar — width = 2 × (rail_centre + rail_half) = 2 × 12.6 = 25.2
  // This fills the full rail outer width so no corner gap is visible.
  const topBar = new THREE.Mesh(new THREE.BoxGeometry(25.2, 1.4, 0.9), frameMat);
  topBar.position.set(0, SY + HALF_H + 0.7, SZ + 0.5);
  scene.add(topBar);

  // Bottom bar — same width
  const botBar = new THREE.Mesh(new THREE.BoxGeometry(25.2, 1.4, 0.9), frameMat);
  botBar.position.set(0, SY - HALF_H - 0.7, SZ + 0.5);
  scene.add(botBar);

  // Left rail
  const lRail = new THREE.Mesh(new THREE.BoxGeometry(1.4, SCREEN_H, 0.9), frameMat);
  lRail.position.set(-11.9, SY, SZ + 0.5);
  scene.add(lRail);

  // Right rail
  const rRail = lRail.clone();
  rRail.position.set(11.9, SY, SZ + 0.5);
  scene.add(rRail);

  // ── directional light — from FRONT-ABOVE so blob shadow falls on screen ──
  // Blob (z=-5) sits between this light and the screen (z=-16). Shadow ✓
  // Brighter light (3.6) — makes the orb/ring shadow on the grey screen more
  // dramatic, which is the primary depth cue for the billboard pop-out effect.
  const dl = new THREE.DirectionalLight(0xFFF8E8, 3.6);
  dl.position.set(10, 75, 55);
  dl.target.position.set(0, SY, SZ);
  dl.castShadow = true;
  dl.shadow.mapSize.set(2048, 2048);
  dl.shadow.camera.near   =   1;
  dl.shadow.camera.far    = 300;
  dl.shadow.camera.left   = -32;
  dl.shadow.camera.right  =  32;
  dl.shadow.camera.top    =  80;   // covers orb now at y=36 (was 60)
  dl.shadow.camera.bottom = -60;
  dl.shadow.radius        =  5;
  dl.shadow.bias          = -0.0005;
  scene.add(dl, dl.target);
}

// ─────────────────────────────────────────────────────────────────────────────
// Logo plane — renders logo.png as a flat 3D plane below the hero blob.
// Uses AdditiveBlending so the black background becomes invisible.
// ─────────────────────────────────────────────────────────────────────────────
function makeLogoPlane (scene) {
  // Load logo.png via HTML Image → Canvas → CanvasTexture (avoids CORS / path issues)
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const cv  = document.createElement('canvas');
    cv.width  = img.naturalWidth  || 512;
    cv.height = img.naturalHeight || 512;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true,
      blending: THREE.AdditiveBlending,   // black bg → invisible, gold logo glows
      depthWrite: false, opacity: 0.90,
    });
    // Centred on the header billboard (SY=22, SZ=-16), proportionally scaled
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), mat);
    plane.position.set(0, 19, -14);
    scene.add(plane);
  };
  img.onerror = (e) => console.warn('[HoloFX] logo.png not loaded:', e);
  // Use module-level require URL resolved by Metro, with fallbacks
  img.src = _logoSrc || './assets/logo.png';
}

// ─────────────────────────────────────────────────────────────────────────────
// Premium chrome logo — displaced icosahedron (Mercury Blob)
// MeshPhysicalMaterial with HDR env map for true PBR chrome + iridescence
// ─────────────────────────────────────────────────────────────────────────────
function makeLogo (scene, uniforms, envMap) {
  // Displaced icosahedron — low-frequency warp only so normals stay smooth.
  // High-freq harmonics caused faceted rainbow patches; keeping only 2 smooth lobes.
  const geo = new THREE.IcosahedronGeometry(12, 6);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const th = Math.atan2(Math.sqrt(x*x + z*z), y);
    const ph = Math.atan2(z, x);
    const dv = 1 + 0.10*Math.sin(2*th)*Math.cos(ph)
                 + 0.06*Math.cos(3*th + 0.8);
    pos.setXYZ(i, x*dv, y*dv, z*dv);
  }
  geo.computeVertexNormals();

  const blobMat = new THREE.MeshPhysicalMaterial({
    color: 0xC0C0CC, metalness: 1, roughness: 0.12,
    envMap, envMapIntensity: 2.8,
    clearcoat: 1, clearcoatRoughness: 0.05,
    iridescence: 0.22, iridescenceIOR: 1.35,
    iridescenceThicknessRange: [100, 280],
  });
  const logo = new THREE.Mesh(geo, blobMat);
  logo.castShadow = true;

  // 3 orbit rings — gold chrome
  const ringMat = new THREE.MeshPhysicalMaterial({
    color: 0xD4AA50, metalness: 1, roughness: 0.05,
    envMap, envMapIntensity: 4.0,
    clearcoat: 1, clearcoatRoughness: 0,
  });
  const ringMeshes = [];
  [[Math.PI/3, 0.20, 0], [Math.PI/3, 1.65, 0], [Math.PI/4, 3.0, 0.5]].forEach(([rx, ry, rz]) => {
    const rm = new THREE.Mesh(new THREE.TorusGeometry(18, 0.38, 16, 120), ringMat);
    rm.rotation.set(rx, ry, rz);
    rm.castShadow = true;
    ringMeshes.push(rm);
  });

  const group = new THREE.Group();
  group.add(logo, ...ringMeshes);
  // Hero position: upper-centre, clear of title text below
  // y=20: bottom of blob ≈ y=8 (inside screen), top ≈ y=32 (5u above frame top)
  group.position.set(0, 20, -5);
  scene.add(group);
  return { group, logo, ringMeshes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vignette frame — frosted glass border + corner brackets injected into DOM
// ─────────────────────────────────────────────────────────────────────────────
function injectBorder () {
  document.getElementById('holo-border')?.remove();
  const b = document.createElement('div');
  b.id = 'holo-border';
  document.body.appendChild(b);
}

function injectDomainBar () {
  document.getElementById('holo-domain-bar')?.remove();
  const bar = document.createElement('div');
  bar.id  = 'holo-domain-bar';
  bar.textContent = 'moneyforeveryone.app';
  document.body.appendChild(bar);
}

// ─────────────────────────────────────────────────────────────────────────────
// makeSwarmBackground — cosmic plexus network (background layer, z:-1)
//
// Inspired by:
//  • Plexus constellation art  — thin silver lines between drifting nodes
//  • Cosmic web (Springel/MPA) — glowing gold hub nodes, depth, filaments
//
// Architecture:
//  • 160 nodes distributed in a 3D volume
//  • LineSegments baked at init (static within group) — zero per-frame cost
//  • Points update positions each frame (organic drift)
//  • Group rotates with mouse/touch — perspective depth illusion
//  • Hub nodes (highest connectivity) are gold → bloom canvas halos them
// ─────────────────────────────────────────────────────────────────────────────
function makeSwarmBackground (bgScene) {
  const N         = 160;
  const SPREAD_XY = 88;   // half-extent x/y
  const SPREAD_Z  = 72;   // half-extent z (less deep to avoid z-fighting with FG)
  const LINK_DIST = 28;   // max distance to form a connection

  // ── Generate node positions ──────────────────────────────────────────────
  const initPos = new Float32Array(N * 3);
  const phase   = new Float32Array(N);
  const speed   = new Float32Array(N);
  const amp     = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    initPos[i*3]   = (Math.random() - 0.5) * SPREAD_XY * 2;
    initPos[i*3+1] = (Math.random() - 0.5) * SPREAD_XY * 2;
    initPos[i*3+2] = (Math.random() - 0.5) * SPREAD_Z  * 2;
    phase[i] = Math.random() * Math.PI * 2;
    speed[i] = 0.07 + Math.random() * 0.14;   // very slow drift
    amp[i]   = 0.9  + Math.random() * 1.8;    // 0.9–2.7 units of movement
  }

  // ── Build connections (done once at init) ────────────────────────────────
  const linkBuf  = [];
  const connCnt  = new Int32Array(N);

  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = initPos[i*3]   - initPos[j*3];
      const dy = initPos[i*3+1] - initPos[j*3+1];
      const dz = initPos[i*3+2] - initPos[j*3+2];
      if (dx*dx + dy*dy + dz*dz < LINK_DIST * LINK_DIST) {
        linkBuf.push(
          initPos[i*3], initPos[i*3+1], initPos[i*3+2],
          initPos[j*3], initPos[j*3+1], initPos[j*3+2]
        );
        connCnt[i]++;
        connCnt[j]++;
      }
    }
  }

  // ── Line mesh ─────────────────────────────────────────────────────────────
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(linkBuf), 3));
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xC8D8EE, opacity: 0.32, transparent: true,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);

  // ── Point cloud ───────────────────────────────────────────────────────────
  const ptPos  = new Float32Array(initPos);          // mutable copy for drift
  const ptGeo  = new THREE.BufferGeometry();
  const ptAttr = new THREE.BufferAttribute(ptPos, 3);
  ptGeo.setAttribute('position', ptAttr);

  // Colour: hub nodes → bright gold, mid → warm silver, sparse → cool white/blue
  const maxConn = Math.max(...Array.from(connCnt));
  const cols    = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const t = connCnt[i] / Math.max(maxConn, 1);
    if      (t > 0.65) { cols[i*3]=1.00; cols[i*3+1]=0.84; cols[i*3+2]=0.28; } // bright gold
    else if (t > 0.35) { cols[i*3]=0.82; cols[i*3+1]=0.78; cols[i*3+2]=0.72; } // warm silver
    else               { cols[i*3]=0.62; cols[i*3+1]=0.68; cols[i*3+2]=0.92; } // cool blue-white
  }
  ptGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));

  // Circular soft-glow texture — PointsMaterial renders squares without a map
  const ptCanvas = document.createElement('canvas');
  ptCanvas.width = ptCanvas.height = 64;
  const ptCtx = ptCanvas.getContext('2d');
  const ptGrad = ptCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
  ptGrad.addColorStop(0,   'rgba(255,255,255,1)');
  ptGrad.addColorStop(0.4, 'rgba(255,255,255,0.9)');
  ptGrad.addColorStop(0.8, 'rgba(255,255,255,0.3)');
  ptGrad.addColorStop(1,   'rgba(255,255,255,0)');
  ptCtx.fillStyle = ptGrad;
  ptCtx.beginPath();
  ptCtx.arc(32, 32, 32, 0, Math.PI * 2);
  ptCtx.fill();
  const ptTex = new THREE.CanvasTexture(ptCanvas);

  const ptMat = new THREE.PointsMaterial({
    size: 4.0, vertexColors: true, sizeAttenuation: true,
    transparent: true, opacity: 0.95,
    map: ptTex, alphaTest: 0.01,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(ptGeo, ptMat);

  // ── Scene group ───────────────────────────────────────────────────────────
  const group = new THREE.Group();
  group.add(lines, points);
  bgScene.add(group);

  // ── Mouse / touch parallax ────────────────────────────────────────────────
  let tgtY = 0, tgtX = 0;
  const onMouse = e => {
    tgtY = (e.clientX / window.innerWidth  - 0.5) *  0.90;
    tgtX = (e.clientY / window.innerHeight - 0.5) *  0.45;
  };
  const onTouch = e => {
    if (!e.touches.length) return;
    tgtY = (e.touches[0].clientX / window.innerWidth  - 0.5) * 0.90;
    tgtX = (e.touches[0].clientY / window.innerHeight - 0.5) * 0.45;
  };
  window.addEventListener('mousemove', onMouse);
  window.addEventListener('touchmove', onTouch, { passive: true });

  return {
    update (t) {
      // Smooth-lerp rotation toward mouse/touch target + slow auto-drift
      group.rotation.y += (tgtY - group.rotation.y) * 0.025 + 0.00035;
      group.rotation.x += (tgtX - group.rotation.x) * 0.025;

      // Per-node organic position drift (Points only — lines stay anchored)
      for (let i = 0; i < N; i++) {
        ptAttr.setXYZ(
          i,
          initPos[i*3]   + Math.sin(t * speed[i]        + phase[i]) * amp[i],
          initPos[i*3+1] + Math.cos(t * speed[i] * 0.70 + phase[i]) * amp[i],
          initPos[i*3+2] + Math.sin(t * speed[i] * 0.50 + phase[i] + 1.57) * amp[i] * 0.55
        );
      }
      ptAttr.needsUpdate = true;
    },
    cleanup () {
      window.removeEventListener('mousemove', onMouse);
      window.removeEventListener('touchmove', onTouch);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM scanner — applies 3D billboard CSS classes after each React render
// ─────────────────────────────────────────────────────────────────────────────
function applyBillboardClasses () {
  const root = document.getElementById('root');
  if (!root) return;

  const maxW = window.innerWidth * 0.97;

  root.querySelectorAll('div').forEach(el => {
    const cs    = window.getComputedStyle(el);
    const hasBF = cs.backdropFilter && cs.backdropFilter !== 'none';
    if (!hasBF) return;
    if (el.offsetWidth > maxW) return;

    // ── Oath term-boxes: 26 × 26 px concave checkboxes ──────────────────────
    // These are the small square tick-boxes in THE OATH section. They get a
    // dedicated class instead of bb-btn so they can have the "going into the
    // screen" concave illusion rather than the forward-floating button effect.
    if (el.offsetWidth <= 30 && el.offsetHeight <= 30 && cs.cursor === 'pointer') {
      const isChecked = el.innerText.trim() === '✓';
      const want = isChecked ? 'bb-term-checked' : 'bb-term';
      el.classList.remove('bb-btn', 'bb-card', 'bb-term', 'bb-term-checked');
      el.classList.add(want);
      return;
    }

    // ── Standard cards and buttons ───────────────────────────────────────────
    const isBtn = cs.cursor === 'pointer' && el.offsetHeight <= 70 && el.offsetHeight > 20;
    const want  = isBtn ? 'bb-btn'  : 'bb-card';
    const drop  = isBtn ? 'bb-card' : 'bb-btn';
    if (!el.classList.contains(want)) {
      el.classList.remove(drop);
      el.classList.add(want);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// makeOrnamentOrbs — two small chrome gyroscope orbs fixed to screen edges
//
// header orb : 87 % from left (overlaps right 15 vw border), 14 % from top
// footer orb :  13 % from left (overlaps left  15 vw border), 86 % from top
//
// Both orbs are positioned via screenToWorld() so they sit at the correct 3D
// world coordinate for any viewport size; they render on the fixed fgCanvas
// so they never scroll with page content.
// ─────────────────────────────────────────────────────────────────────────────
function makeOrnamentOrbs (fgScene, envMap, camera) {
  // Tiny golden gem at the centre — 4× smaller than the previous 2.4 sphere.
  // The open rings now orbit almost empty space, which reads as a premium "orrery" motif.
  const SPHERE_R  = 0.60;
  const RING_R    = 3.5;    // rings unchanged — wider orbit makes the gem feel distant
  const RING_TUBE = 0.20;   // slightly thicker than before; rings are now the hero shape

  // Gold glow texture — tight warm burst matching the app's #D4AF37 palette.
  // Tight inner stop (0.15) keeps the corona crisp rather than diffuse.
  const glowTex = (() => {
    const gc   = document.createElement('canvas');
    gc.width   = gc.height = 128;
    const gctx = gc.getContext('2d');
    const grad = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0,    'rgba(255,248,200,0.98)');   // white-gold core
    grad.addColorStop(0.15, 'rgba(212,175,55, 0.88)');   // UI gold #D4AF37
    grad.addColorStop(0.38, 'rgba(200,140,30, 0.45)');   // amber mid-ring
    grad.addColorStop(0.65, 'rgba(160, 90,10, 0.14)');   // dark amber fade
    grad.addColorStop(1,    'rgba(0,0,0,0)');
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(gc);
  })();

  function buildOrb () {
    // Gold chrome rings — colour matches the UI's primary gold (#D4AF37)
    const ringMat = new THREE.MeshPhysicalMaterial({
      color:             0xD4AF37,
      metalness:         1.0,
      roughness:         0.04,
      envMap,            envMapIntensity: 2.0,   // was 4.0 → −50 %
      clearcoat:         1.0,
      clearcoatRoughness:0.01,
    });
    const ringGeo = new THREE.TorusGeometry(RING_R, RING_TUBE, 24, 120);

    const r1 = new THREE.Mesh(ringGeo, ringMat); r1.rotation.x = Math.PI / 2; // equatorial
    const r2 = new THREE.Mesh(ringGeo, ringMat);                               // meridian
    const r3 = new THREE.Mesh(ringGeo, ringMat);
    r3.rotation.y = Math.PI / 6; r3.rotation.z = Math.PI / 3;                 // tilted orbit

    // Tiny emissive gold gem — acts like a miniature sun at the orbital centre.
    // emissive + high envMapIntensity makes it glow even without direct lighting.
    const sphereMat = new THREE.MeshPhysicalMaterial({
      color:              0xFFD966,
      emissive:           new THREE.Color(0xD4AF37),
      emissiveIntensity:  0.6,    // was 1.2 → −50 %
      metalness:          0.55,
      roughness:          0.12,
      envMap,             envMapIntensity: 1.1,  // was 2.2 → −50 %
      clearcoat:          1.0,
      clearcoatRoughness: 0.04,
    });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_R, 64, 64), sphereMat);

    // Tight gold corona sprite — AdditiveBlending adds warm light onto the dark border.
    // Scale 12 keeps the halo compact and jewel-like (not diffuse).
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, opacity: 0.41,  // was 0.82 → −50 %
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.set(12, 12, 1);
    glow.position.z = -0.3;

    const group = new THREE.Group();
    group.add(r1, r2, r3, sphere, glow);
    fgScene.add(group);
    return { group, rings: [r1, r2, r3] };
  }

  const header = buildOrb();
  const footer = buildOrb();

  // Convert a screen pixel position to a Three.js world position at depth targetZ.
  // Uses standard NDC unproject + ray-plane intersection.
  function screenToWorld (sx, sy, targetZ) {
    camera.updateMatrixWorld();
    const w = window.innerWidth, h = window.innerHeight;
    const ndc = new THREE.Vector3(
      (sx / w) * 2 - 1,
      -(sy / h) * 2 + 1,
      0.5
    );
    ndc.unproject(camera);
    const dir = ndc.sub(camera.position).normalize();
    const t   = (targetZ - camera.position.z) / dir.z;
    return new THREE.Vector3(
      camera.position.x + t * dir.x,
      camera.position.y + t * dir.y,
      targetZ
    );
  }

  function updatePositions () {
    const w = window.innerWidth, h = window.innerHeight;
    // Extreme opposite corners — deep inside the border zones
    // Header top-right corner: 94 % from left, 5 % from top
    header.group.position.copy(screenToWorld(w * 0.94, h * 0.05, 6));
    // Footer bottom-left corner: 6 % from left, 95 % from top
    footer.group.position.copy(screenToWorld(w * 0.06, h * 0.95, 6));
  }
  updatePositions();

  return { header, footer, updatePositions };
}

// ─────────────────────────────────────────────────────────────────────────────
// useHoloBackground — dual-layer architecture
//   BG layer (z:-1)  : orbs, halos, vol-cones, particles, grid
//   FG layer (z:2)   : glass panels + logo  ← ABOVE the HTML (pointer-events:none)
//   Bloom (z:-1 screen-blend): glow amplifier for BG
// ─────────────────────────────────────────────────────────────────────────────
export function useHoloBackground () {
  useEffect(() => {
    if (!IS_WEB) return;
    injectCSS();
    injectBorder();
    injectDomainBar();

    /* ── canvas factory ── */
    const mkCanvas = (id, zi, blend, filt) => {
      let c = document.getElementById(id);
      if (!c) {
        c = document.createElement('canvas');
        c.id = id;
        Object.assign(c.style, {
          position: 'fixed', inset: '0', width: '100%', height: '100%',
          zIndex: zi, pointerEvents: 'none', display: 'block',
        });
        document.body.appendChild(c);
      }
      if (filt)  c.style.filter       = filt;
      if (blend) { c.style.mixBlendMode = blend; c.style.opacity = '0.50'; }
      return c;
    };

    /* three canvases */
    const bgCanvas    = mkCanvas('holo-bg',    '-1',  null,      null);
    const bloomCanvas = mkCanvas('holo-bloom', '-1',  'screen',  'blur(22px) brightness(2.20) saturate(1.60)');
    // z:6 — orbs sit above #root (z:4) and above border (z:3).
    const fgCanvas    = mkCanvas('holo-fg',    '6',   null,      null);
    // CSS drop-shadow on the fgCanvas:
    //   • fgCanvas has a transparent background — the filter traces only the non-transparent
    //     orb pixels (sphere + rings), so the shadow is cast FROM the orb shape.
    //   • The shadow composites into the z:6 layer but visually appears to fall on everything
    //     below (border z:3, content z:4), selling the "coming out of the screen" illusion.
    // Two-layer drop-shadow:
    //  1. Deep black shadow — depth, weight, "floating above the surface"
    //  2. Warm gold halo   — premium finish, ties into #D4AF37 UI palette
    fgCanvas.style.filter =
      'drop-shadow(0 10px 24px rgba(0,0,0,0.82))' +       // was 0.97 → −50 %
      ' drop-shadow(0  2px  6px rgba(212,175,55,0.20))';  // was 0.40 → −50 %

    const W = window.innerWidth, H = window.innerHeight;
    // FOV 42° (was 32°) — wider vertical frustum needed to see the billboard frame
    // (SY=22) AND the orb that overflows above it (group y=36, sphere top y≈43).
    // At FOV 42°, z=6 half-height ≈ 34 units — enough to frame both.
    const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 1200);
    camera.position.set(0, -5, 95);
    camera.lookAt(0, 12, 0);

    /* BG scene — orbs, halos, vol cones, particles, grid */
    const bgScene = new THREE.Scene();
    bgScene.fog   = new THREE.FogExp2(0x060300, 0.0010);

    /* FG scene — glass panels, logo (no fog so they're crisp) */
    const fgScene = new THREE.Scene();

    const bgRenderer    = makeRenderer(bgCanvas,    true);
    // bgCanvas IS the page background — body is transparent so this must be opaque
    bgRenderer.setClearColor(0x060300, 1.0);
    const bloomRenderer = makeRenderer(bloomCanvas, false);
    const fgRenderer    = makeRenderer(fgCanvas,    true);

    // Enable shadow maps + PBR tone mapping on the foreground renderer
    fgRenderer.shadowMap.enabled  = true;
    fgRenderer.shadowMap.type     = THREE.PCFSoftShadowMap;
    fgRenderer.toneMapping        = THREE.ACESFilmicToneMapping;
    fgRenderer.toneMappingExposure = 1.10;
    fgRenderer.outputColorSpace   = THREE.SRGBColorSpace;

    const uniforms = [];

    // Build synthetic HDR env map + FG scene lighting + two small ornament orbs
    const envMap = makeEnv(fgRenderer);
    makeHeroLights(fgScene);

    // Front-fill light — positioned between camera (z=95) and scene (z=0).
    // It illuminates the viewer-facing surface of the orbs while back faces go dark.
    // This asymmetric light is the primary "object coming toward you" depth cue:
    // the bright front + dark back creates the impression the orb is floating off the screen.
    // Warm gold front-fill — colour-matched to #D4AF37 so reflections on the gold rings
    // pick up the UI palette rather than a neutral white.
    const frontFill = new THREE.PointLight(0xFFD966, 1.3, 260);  // was 2.6 → −50 %
    frontFill.position.set(0, 8, 75);
    fgScene.add(frontFill);

    /* ── BACKGROUND: cosmic plexus swarm ── */
    const swarm = makeSwarmBackground(bgScene);

    /* ── FOREGROUND: two chrome ornament orbs (header-right + footer-left) ── */
    const ornaments = makeOrnamentOrbs(fgScene, envMap, camera);
    const { header: headerOrb, footer: footerOrb } = ornaments;

    /* ── resize ── */
    const onResize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      const aspect = w / h;
      const cameraZ = Math.max(80, Math.min(130, 40 / aspect));
      camera.position.setZ(cameraZ);
      camera.lookAt(0, 12, 0);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      [bgRenderer, bloomRenderer, fgRenderer].forEach(r => r.setSize(w, h));
      ornaments.updatePositions();
    };
    // Apply initial responsive Z immediately
    onResize();
    window.addEventListener('resize', onResize);

    /* ── render loop ── */
    let animId;
    const clock = new THREE.Timer();
    function tick () {
      animId = requestAnimationFrame(tick);
      clock.update();
      const t = clock.getElapsed();
      uniforms.forEach(u => { if (u.uTime) u.uTime.value = t; });

      // Cosmic plexus background — interactive parallax + organic drift
      swarm.update(t);

      // Groups stay fixed in space — no drift, no pulse, no group rotation.
      // Only the individual rings spin slowly so the ornaments feel alive but anchored.
      headerOrb.rings[0].rotation.z =  t * 0.10;   // equatorial — very slow
      headerOrb.rings[1].rotation.y =  t * 0.08;   // meridian
      headerOrb.rings[2].rotation.x =  t * 0.06;   // tilted
      // Footer counter-rotates for subtle differentiation
      footerOrb.rings[0].rotation.z = -t * 0.09;
      footerOrb.rings[1].rotation.y = -t * 0.07;
      footerOrb.rings[2].rotation.x =  t * 0.05;

      bgRenderer.render(bgScene, camera);
      bloomRenderer.render(bgScene, camera);
      fgRenderer.render(fgScene, camera);
    }
    tick();

    // ── Cursor wobble — cards + buttons tilt gently toward the cursor ─────────
    // JS writes --rot-x / --rot-y CSS variables; the card's transition smooths it.
    const onWobble = (e) => {
      document.querySelectorAll('.bb-card, .bb-btn').forEach(el => {
        const r  = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        // Normalise cursor position relative to card centre
        const dx = (e.clientX - (r.left + r.width  * 0.5)) / (window.innerWidth  * 0.55);
        const dy = (e.clientY - (r.top  + r.height * 0.5)) / (window.innerHeight * 0.55);
        // Clamp max tilt — gentle, not extreme
        const ry =  Math.max(-7, Math.min(7,  dx * 6));
        const rx =  Math.max(-5, Math.min(5, -dy * 4));
        el.style.setProperty('--rot-x', `${rx}deg`);
        el.style.setProperty('--rot-y', `${ry}deg`);
      });
    };
    const onWobbleReset = () => {
      document.querySelectorAll('.bb-card, .bb-btn').forEach(el => {
        el.style.setProperty('--rot-x', '0deg');
        el.style.setProperty('--rot-y', '0deg');
      });
    };
    window.addEventListener('mousemove',  onWobble,      { passive: true });
    window.addEventListener('touchmove',  e => e.touches.length && onWobble({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }), { passive: true });
    document.addEventListener('mouseleave', onWobbleReset);

    // fgCanvas always visible — ornament orbs show on all screens
    fgCanvas.style.display = 'block';

    setTimeout(applyBillboardClasses, 900);

    // Re-classify on click/tap so term-box checked ↔ unchecked switches instantly.
    const onClickReclassify = () => setTimeout(applyBillboardClasses, 40);
    document.addEventListener('click',     onClickReclassify, { passive: true });
    document.addEventListener('touchend',  onClickReclassify, { passive: true });

    const observer = new MutationObserver(() => {
      setTimeout(applyBillboardClasses, 100);
    });
    observer.observe(document.getElementById('root') || document.body, {
      childList: true, subtree: true,
    });

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onWobble);
      document.removeEventListener('mouseleave', onWobbleReset);
      document.removeEventListener('click',    onClickReclassify);
      document.removeEventListener('touchend', onClickReclassify);
      swarm.cleanup();
      observer.disconnect();
      [bgRenderer, bloomRenderer, fgRenderer].forEach(r => r.dispose());
      [bgCanvas, bloomCanvas, fgCanvas].forEach(c => c.remove());
      document.getElementById('holo-border')?.remove();
      document.getElementById('holo-domain-bar')?.remove();
    };
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// useHoloTransition — GSAP entrance per onboarding step
// ─────────────────────────────────────────────────────────────────────────────
export function useHoloTransition (step) {
  useEffect(() => {
    if (!IS_WEB) return;

    const targets = document.querySelectorAll(
      '[class*="onboard"], [class*="card"], [class*="btn"], [class*="term"]'
    );
    if (!targets.length) return;

    gsap.fromTo(
      targets,
      { opacity: 0, y: 28, filter: 'blur(12px)', scale: 0.96 },
      {
        opacity: 1, y: 0, filter: 'blur(0px)', scale: 1,
        duration: 0.82, ease: 'power3.out',
        stagger: 0.055,
        onComplete: () => setTimeout(applyBillboardClasses, 750),
      },
    );
  }, [step]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported React-Native style objects (web: backdrop-filter glass)
// ─────────────────────────────────────────────────────────────────────────────
export const glassCard = {
  backgroundColor:     'rgba(20,12,4,0.88)',
  backdropFilter:      'blur(44px) saturate(290%) brightness(1.20)',
  WebkitBackdropFilter:'blur(44px) saturate(290%) brightness(1.20)',
};

export const glassButton = {
  backdropFilter:      'blur(22px) saturate(220%)',
  WebkitBackdropFilter:'blur(22px) saturate(220%)',
  transition:          'transform 0.22s cubic-bezier(0.23,1,0.32,1), filter 0.22s ease',
  cursor:              'pointer',
};

export const glassOnboardCard = {
  backgroundColor:     'rgba(20,12,4,0.85)',
  backdropFilter:      'blur(42px) saturate(270%) brightness(1.18)',
  WebkitBackdropFilter:'blur(42px) saturate(270%) brightness(1.18)',
  borderWidth:         1,
  borderColor:         'rgba(212,175,55,0.38)',
  borderRadius:        14,
};

export const glassTermBox = {
  backgroundColor:     'rgba(16,9,2,0.82)',
  backdropFilter:      'blur(36px) saturate(250%)',
  WebkitBackdropFilter:'blur(36px) saturate(250%)',
  borderWidth:         1,
  borderColor:         'rgba(212,175,55,0.28)',
  borderRadius:        10,
};
