/**
 * MONEY Premium Icon Set
 * ──────────────────────────────────────────────────────────────────────────
 * Design language: classical coinage × modern precision
 * "Homage to the past — currency of tomorrow"
 *
 * All icons are pure SVG — resolution independent, renders crisp at any size.
 * Zero emojis.
 */

import React from 'react';
import Svg, {
  Path, Circle, G, Line, Rect, Ellipse, Polygon,
  Defs, LinearGradient, RadialGradient, Stop,
} from 'react-native-svg';
import { View } from 'react-native';
import MoneySymbol from './MoneySymbol';

// ── Shared palette ────────────────────────────────────────────────────────
const GOLD     = '#D4AF37';
const GOLD_HI  = '#F0D060';
const GOLD_SH  = '#8B6914';
const DARK     = '#0B0600';
const STEEL    = '#3A3525';
const WOOD     = '#3D2008';

// ─────────────────────────────────────────────────────────────────────────────
// SEAL MEDALLION — welcome screen hero, replaces 🪨
// Roman coin bearing the M+handshake mark.
// ─────────────────────────────────────────────────────────────────────────────
export function SealMedallion({ size = 80 }) {
  const cx = size / 2, cy = size / 2;
  const outerR = size / 2 - 1;
  const rimR   = outerR - 4;
  const fieldR = outerR - 9;

  // 48 rim ticks — every 6th one is longer (marks the hours)
  const ticks = Array.from({ length: 48 }, (_, i) => {
    const a    = (i / 48) * Math.PI * 2;
    const long = i % 6 === 0;
    const r1   = outerR;
    const r2   = outerR - (long ? 7 : 4);
    return `M${cx + r1 * Math.cos(a)},${cy + r1 * Math.sin(a)} L${cx + r2 * Math.cos(a)},${cy + r2 * Math.sin(a)}`;
  }).join(' ');

  // 16 fine radial rays in the field
  const rays = Array.from({ length: 16 }, (_, i) => {
    const a  = (i / 16) * Math.PI * 2;
    const r1 = fieldR * 0.38;
    const r2 = fieldR * 0.88;
    return `M${cx + r1 * Math.cos(a)},${cy + r1 * Math.sin(a)} L${cx + r2 * Math.cos(a)},${cy + r2 * Math.sin(a)}`;
  }).join(' ');

  const symbolSize = size * 0.48;
  const symW = symbolSize * (380 / 442);

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute' }}>
        {/* Base disc */}
        <Circle cx={cx} cy={cy} r={outerR} fill={DARK} />
        {/* Outer ring */}
        <Circle cx={cx} cy={cy} r={outerR} fill="none" stroke={GOLD} strokeWidth={1.2} />
        {/* Tick marks */}
        <Path d={ticks} stroke={GOLD} strokeWidth={0.8} />
        {/* Inner rim ring */}
        <Circle cx={cx} cy={cy} r={rimR} fill="none" stroke={GOLD} strokeWidth={0.5} opacity={0.5} />
        {/* Field ring */}
        <Circle cx={cx} cy={cy} r={fieldR} fill={DARK} stroke={GOLD} strokeWidth={0.4} opacity={0.4} />
        {/* Radial rays */}
        <Path d={rays} stroke={GOLD} strokeWidth={0.4} opacity={0.25} />
        {/* Centre circle */}
        <Circle cx={cx} cy={cy} r={fieldR * 0.36} fill={DARK} stroke={GOLD} strokeWidth={0.5} opacity={0.5} />
      </Svg>
      {/* MoneySymbol centred over the coin field */}
      <View style={{
        position: 'absolute',
        top:  cy - symbolSize * 0.50,
        left: cx - symW * 0.50,
      }}>
        <MoneySymbol size={symbolSize} color={GOLD} />
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GOLD COIN — formation day indicator, replaces ☀️
// ─────────────────────────────────────────────────────────────────────────────
export function GoldCoin({ size = 30, active = true }) {
  const cx = size / 2, cy = size / 2, r = size / 2 - 1.5;

  const rays = Array.from({ length: 12 }, (_, i) => {
    const a  = (i / 12) * Math.PI * 2;
    const r1 = r * 0.52;
    const r2 = r * 0.88;
    return `M${cx + r1 * Math.cos(a)},${cy + r1 * Math.sin(a)} L${cx + r2 * Math.cos(a)},${cy + r2 * Math.sin(a)}`;
  }).join(' ');

  return active ? (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={cx} cy={cy} r={r}      fill={GOLD}   />
      <Circle cx={cx} cy={cy} r={r - 2}  fill={GOLD}   stroke={GOLD_HI} strokeWidth={0.5} opacity={0.4} />
      <Path   d={rays}                   stroke={GOLD_HI} strokeWidth={0.8} opacity={0.7} />
      <Circle cx={cx} cy={cy} r={r * 0.32} fill={GOLD_HI} opacity={0.6} />
      {/* Rim bevel */}
      <Circle cx={cx} cy={cy} r={r}      fill="none"   stroke={GOLD_SH} strokeWidth={1} />
    </Svg>
  ) : (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={cx} cy={cy} r={r}         fill="none" stroke={GOLD}    strokeWidth={1}   opacity={0.25} />
      <Path   d={rays}                      stroke={GOLD} strokeWidth={0.5} opacity={0.15} />
      <Circle cx={cx} cy={cy} r={r * 0.32}  fill="none" stroke={GOLD}    strokeWidth={0.5} opacity={0.2} />
    </Svg>
  );
}

// Melted / ignited coin — used when a sun has been burned off
export function IgnitedCoin({ size = 30 }) {
  const cx = size / 2, cy = size / 2, r = size / 2 - 1.5;
  // Flame tongues radiating outward
  const flames = Array.from({ length: 8 }, (_, i) => {
    const a    = (i / 8) * Math.PI * 2;
    const tip  = r * 1.15;
    const base = r * 0.6;
    const lx   = cx + base * Math.cos(a - 0.25);
    const ly   = cy + base * Math.sin(a - 0.25);
    const rx   = cx + base * Math.cos(a + 0.25);
    const ry   = cy + base * Math.sin(a + 0.25);
    const tx   = cx + tip  * Math.cos(a);
    const ty   = cy + tip  * Math.sin(a);
    return `M${lx},${ly} Q${tx},${ty} ${rx},${ry}`;
  }).join(' ');

  return (
    <Svg width={size * 1.3} height={size * 1.3}
         viewBox={`${-size * 0.15} ${-size * 0.15} ${size * 1.3} ${size * 1.3}`}>
      <Path d={flames} fill="none" stroke="#E05020" strokeWidth={1.2} opacity={0.8} />
      <Circle cx={cx} cy={cy} r={r}          fill="#8B3000" />
      <Circle cx={cx} cy={cy} r={r * 0.6}   fill="#C04000" opacity={0.7} />
      <Circle cx={cx} cy={cy} r={r * 0.28}  fill="#F06020" opacity={0.9} />
      <Circle cx={cx} cy={cy} r={r}          fill="none" stroke="#C04000" strokeWidth={1} />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FORGE HAMMER SVG — replaces 🔨 Animated.Text in forge scene
// Cross-peen blacksmith hammer, viewed at slight angle.
// ─────────────────────────────────────────────────────────────────────────────
export function ForgeHammerSVG({ size = 72 }) {
  // Drawn in natural orientation (head-top, handle-bottom), then G-rotated -45° (CCW).
  // Result: head → upper-left (~10-11 o'clock), handle → lower-right (~4-5 o'clock).
  // Animation sweeps CW + down-left translate so the head arcs onto the anvil.
  return (
    <Svg width={size} height={size} viewBox="0 0 72 72">
      <G transform="rotate(-45, 36, 36)">
        {/* Handle */}
        <Path d="M38 30 L44 66 Q44.5 68 43 68 L32 68 Q30.5 68 31 66 Z"
          fill={WOOD} />
        {/* Handle wrap grip lines */}
        <Line x1={32} y1={43} x2={43} y2={43} stroke="#5C3820" strokeWidth={1} opacity={0.5} />
        <Line x1={32} y1={49} x2={43} y2={49} stroke="#5C3820" strokeWidth={1} opacity={0.5} />
        <Line x1={32} y1={55} x2={43} y2={55} stroke="#5C3820" strokeWidth={1} opacity={0.5} />
        {/* Hammer head — main body */}
        <Rect x={6} y={8} width={56} height={24} rx={3} fill={STEEL} />
        {/* Striking face — polished flat end */}
        <Rect x={6} y={8} width={10} height={24} rx={3} fill="#5A5030" />
        {/* Cross-peen — tapered opposite end */}
        <Path d="M56 14 L62 20 L56 26 Z" fill="#2E2810" />
        {/* Top highlight edge */}
        <Rect x={6} y={8} width={56} height={2.5} rx={1.5} fill={GOLD_SH} opacity={0.35} />
        {/* Front face highlight */}
        <Rect x={6} y={8} width={2} height={24} rx={1} fill={GOLD_SH} opacity={0.25} />
        {/* Eye hole (handle attachment) */}
        <Ellipse cx={37} cy={20} rx={4} ry={5} fill="#1A1208" />
        <Ellipse cx={37} cy={20} rx={3} ry={4} fill={DARK} />
      </G>
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ANVIL SVG — replaces three grey View blocks
// ─────────────────────────────────────────────────────────────────────────────
export function AnvilSVG({ width = 180 }) {
  const h = Math.round(width * 0.5);
  const sc = width / 180; // scale factor

  return (
    <Svg width={width} height={h} viewBox="0 0 180 90">
      {/* Horn */}
      <Path d="M2 42 Q0 38 4 34 L40 30 L40 48 Z"
        fill={STEEL} />
      {/* Bick (back horn placeholder) */}
      <Rect x={138} y={33} width={30} height={12} rx={4} fill={STEEL} opacity={0.5} />
      {/* Working face / table */}
      <Rect x={32} y={20} width={116} height={26} rx={4} fill={STEEL} />
      {/* Face highlight */}
      <Rect x={32} y={20} width={116} height={3}  rx={2} fill={GOLD_SH} opacity={0.25} />
      {/* Waist */}
      <Rect x={58} y={46} width={64} height={14} fill="#2E2A1A" />
      {/* Base / foot */}
      <Rect x={36} y={60} width={108} height={22} rx={5} fill={STEEL} />
      {/* Base feet */}
      <Rect x={28} y={74} width={28} height={12} rx={3} fill={STEEL} />
      <Rect x={124} y={74} width={28} height={12} rx={3} fill={STEEL} />
      {/* Pritchel + hardy holes */}
      <Rect x={110} y={24} width={8} height={10} rx={2} fill={DARK} opacity={0.8} />
      <Rect x={124} y={24} width={12} height={10} rx={3} fill={DARK} opacity={0.6} />
      {/* Base shadow line */}
      <Rect x={36} y={60} width={108} height={2} rx={1} fill={GOLD_SH} opacity={0.15} />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SPARKS — replaces ✨ ✨ animated text in forge scene
// ─────────────────────────────────────────────────────────────────────────────
export function ForgeSparks({ size = 60 }) {
  // 8 spark lines radiating from center
  const sparks = [
    [0, -18], [11, -14], [17, -4], [14, 9],
    [4, 16], [-10, 14], [-17, 4], [-13, -11],
  ];
  return (
    <Svg width={size} height={size} viewBox="-20 -20 40 40">
      {sparks.map(([x, y], i) => (
        <G key={i}>
          <Line x1={x * 0.3} y1={y * 0.3} x2={x} y2={y}
            stroke={i % 3 === 0 ? GOLD_HI : GOLD}
            strokeWidth={i % 2 === 0 ? 1.5 : 1}
            strokeLinecap="round"
          />
          {/* Spark tip dot */}
          <Circle cx={x} cy={y} r={i % 3 === 0 ? 1.2 : 0.7}
            fill={GOLD_HI} />
        </G>
      ))}
      {/* Hot core */}
      <Circle cx={0} cy={0} r={2.5} fill={GOLD_HI} opacity={0.9} />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FLAME — replaces 🔥 in buttons and status text
// ─────────────────────────────────────────────────────────────────────────────
export function FlameIcon({ size = 20, color = GOLD }) {
  return (
    <Svg width={size * 0.75} height={size} viewBox="0 0 36 48">
      {/* Outer flame */}
      <Path
        d="M18 46 C6 46 2 34 2 24 C2 14 10 8 14 4 C13 12 17 15 19 14 C16 8 19 2 19 1 C25 7 30 15 28 23 C33 17 32 9 29 5 C38 12 42 22 38 32 C35 41 27 46 18 46 Z"
        fill={color}
      />
      {/* Inner flame core */}
      <Path
        d="M18 42 C10 42 8 32 10 25 C12 20 16 17 18 15 C18 20 20 22 22 21 C20 16 22 12 24 10 C26 15 28 21 26 27 C30 23 30 17 28 14 C34 20 35 29 32 35 C30 40 24 42 18 42 Z"
        fill={DARK}
        opacity={0.3}
      />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCK — replaces 🔒
// ─────────────────────────────────────────────────────────────────────────────
export function LockIcon({ size = 18, color = GOLD }) {
  return (
    <Svg width={size * 0.8} height={size} viewBox="0 0 32 40">
      {/* Shackle */}
      <Path d="M8 18 L8 11 A8 8 0 0 1 24 11 L24 18"
        fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      {/* Body */}
      <Rect x={2} y={17} width={28} height={21} rx={3} fill={color} />
      {/* Keyhole body */}
      <Circle cx={16} cy={26} r={3.5} fill={DARK} />
      <Rect   x={14.5} y={26} width={3} height={6} rx={1} fill={DARK} />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK SEAL — replaces ✅
// ─────────────────────────────────────────────────────────────────────────────
export function CheckSeal({ size = 20, ringColor = '#2A4A2A', checkColor = '#7DB87A' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Circle cx={18} cy={18} r={17}
        fill={ringColor} stroke={checkColor} strokeWidth={1.5} />
      <Path d="M9 18.5 L15 25 L27 11"
        fill="none" stroke={checkColor} strokeWidth={2.8}
        strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HOURGLASS — replaces ⏳
// ─────────────────────────────────────────────────────────────────────────────
export function HourglassIcon({ size = 20, color = GOLD_SH }) {
  return (
    <Svg width={size * 0.75} height={size} viewBox="0 0 30 40">
      {/* Top cap */}
      <Rect x={1} y={0} width={28} height={3}  rx={1.5} fill={color} />
      {/* Bottom cap */}
      <Rect x={1} y={37} width={28} height={3} rx={1.5} fill={color} />
      {/* Top sand */}
      <Path d="M3 3 L27 3 L19 19 L11 19 Z" fill={color} opacity={0.5} />
      {/* Bottom sand */}
      <Path d="M11 21 L19 21 L27 37 L3 37 Z"  fill={color} opacity={0.85} />
      {/* Waist dot */}
      <Ellipse cx={15} cy={20} rx={3} ry={1.2} fill={color} />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING CIRCLE — replaces ○
// ─────────────────────────────────────────────────────────────────────────────
export function PendingCircle({ size = 20, color = '#3A2810' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Circle cx={18} cy={18} r={17}
        fill="none" stroke={color} strokeWidth={1.5}
        strokeDasharray="4 3" />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA IRIS — replaces 📷
// ─────────────────────────────────────────────────────────────────────────────
export function CameraIrisIcon({ size = 60, color = GOLD }) {
  // 6-blade aperture diaphragm
  const blades = Array.from({ length: 6 }, (_, i) => {
    const a  = (i / 6) * Math.PI * 2;
    const ax = 30 + 20 * Math.cos(a - 0.38);
    const ay = 30 + 20 * Math.sin(a - 0.38);
    const bx = 30 + 20 * Math.cos(a + 0.38);
    const by = 30 + 20 * Math.sin(a + 0.38);
    return `M30,30 L${ax},${ay} L${bx},${by} Z`;
  }).join(' ');

  return (
    <Svg width={size} height={size} viewBox="0 0 60 60">
      <Circle cx={30} cy={30} r={28} fill={DARK} stroke={color} strokeWidth={1.5} />
      <Path   d={blades} fill={color} opacity={0.15} stroke={color} strokeWidth={0.5} />
      <Circle cx={30} cy={30} r={11} fill={DARK} stroke={color} strokeWidth={1} />
      <Circle cx={30} cy={30} r={4}  fill={color} opacity={0.7} />
      {/* Outer notches */}
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return (
          <Line key={i}
            x1={30 + 25 * Math.cos(a)} y1={30 + 25 * Math.sin(a)}
            x2={30 + 27 * Math.cos(a)} y2={30 + 27 * Math.sin(a)}
            stroke={color} strokeWidth={1} opacity={0.5}
          />
        );
      })}
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EYE — replaces 👁️
// ─────────────────────────────────────────────────────────────────────────────
export function EyeIcon({ size = 60, color = GOLD }) {
  const w = size, h = size * 0.56;
  // 8 iris radial lines
  const irisLines = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return (
      <Line key={i}
        x1={50 + 8 * Math.cos(a)}  y1={30 + 8 * Math.sin(a)}
        x2={50 + 15 * Math.cos(a)} y2={30 + 15 * Math.sin(a)}
        stroke={color} strokeWidth={0.8} opacity={0.55}
      />
    );
  });
  return (
    <Svg width={w} height={h} viewBox="0 0 100 56">
      {/* Eye whites / surround */}
      <Path d="M2 28 Q26 2 50 2 Q74 2 98 28 Q74 54 50 54 Q26 54 2 28 Z"
        fill={DARK} stroke={color} strokeWidth={1.5} />
      {/* Iris outer */}
      <Circle cx={50} cy={28} r={16} fill="none" stroke={color} strokeWidth={1.2} />
      {irisLines}
      {/* Pupil */}
      <Circle cx={50} cy={28} r={7}   fill={color} opacity={0.85} />
      {/* Catch light */}
      <Circle cx={54} cy={24} r={2.2} fill="white" opacity={0.35} />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THUMBPRINT — replaces 👍 for biometric prompts
// ─────────────────────────────────────────────────────────────────────────────
export function ThumbprintIcon({ size = 60, color = GOLD }) {
  // Concentric partial oval arcs — classic fingerprint pattern
  const arcs = [
    'M 30 52 Q 10 52 8 35 Q 6 18 20 12 Q 34 6 44 14 Q 54 22 52 38 Q 50 52 36 54',
    'M 30 47 Q 14 47 13 34 Q 12 21 23 16 Q 34 11 42 19 Q 48 26 46 38 Q 44 48 33 49',
    'M 30 42 Q 18 42 18 33 Q 18 24 26 20 Q 34 16 40 23 Q 44 30 42 38 Q 40 44 32 44',
    'M 30 37 Q 22 37 22 31 Q 22 25 28 22 Q 34 19 38 25 Q 40 31 38 36 Q 37 39 31 39',
    'M 30 32 Q 26 32 26 28 Q 26 24 30 22 Q 34 20 36 24 Q 37 28 35 31',
  ];

  return (
    <Svg width={size} height={size} viewBox="0 0 60 60">
      {arcs.map((d, i) => (
        <Path key={i} d={d} fill="none" stroke={color}
          strokeWidth={1.6} strokeLinecap="round" opacity={0.9 - i * 0.1} />
      ))}
      {/* Core whorl */}
      <Circle cx={30} cy={27} r={2.5} fill={color} opacity={0.7} />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// IGNITION STARBURST — replaces 🔥🔥🔥 ✨ 🔥🔥🔥 on ignition screen
// ─────────────────────────────────────────────────────────────────────────────
export function IgnitionBurst({ size = 120 }) {
  const cx = size / 2, cy = size / 2;

  // 24 rays — alternating long/short
  const rays = Array.from({ length: 24 }, (_, i) => {
    const a    = (i / 24) * Math.PI * 2;
    const long = i % 2 === 0;
    const r1   = size * 0.14;
    const r2   = long ? size * 0.46 : size * 0.32;
    return `M${cx + r1 * Math.cos(a)},${cy + r1 * Math.sin(a)} L${cx + r2 * Math.cos(a)},${cy + r2 * Math.sin(a)}`;
  }).join(' ');

  // 8 outer spark tips
  const sparks = Array.from({ length: 8 }, (_, i) => {
    const a  = ((i + 0.5) / 8) * Math.PI * 2;
    const r  = size * 0.47;
    const cx2 = cx + r * Math.cos(a);
    const cy2 = cy + r * Math.sin(a);
    const ex  = cx + (r + size * 0.07) * Math.cos(a);
    const ey  = cy + (r + size * 0.07) * Math.sin(a);
    return `M${cx2},${cy2} L${ex},${ey}`;
  }).join(' ');

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* Outer glow ring */}
      <Circle cx={cx} cy={cy} r={size * 0.47} fill="none"
        stroke={GOLD} strokeWidth={0.6} opacity={0.2} />
      {/* Rays */}
      <Path d={rays} stroke={GOLD} strokeWidth={1.2} opacity={0.6} strokeLinecap="round" />
      {/* Spark tips */}
      <Path d={sparks} stroke={GOLD_HI} strokeWidth={2} strokeLinecap="round" opacity={0.8} />
      {/* Middle ring */}
      <Circle cx={cx} cy={cy} r={size * 0.18} fill="none"
        stroke={GOLD} strokeWidth={1} opacity={0.5} />
      {/* Core disc */}
      <Circle cx={cx} cy={cy} r={size * 0.13} fill={GOLD} opacity={0.9} />
      <Circle cx={cx} cy={cy} r={size * 0.07} fill={GOLD_HI} />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY CARD ICONS — small line icons, replaces emoji in IDENTITY_CARDS
// ─────────────────────────────────────────────────────────────────────────────

// Person silhouette — Full Name
export function IconPerson({ size = 22, color = GOLD }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Circle cx={18} cy={10} r={7}  fill="none" stroke={color} strokeWidth={1.8} />
      <Path   d="M4 34 Q4 22 18 22 Q32 22 32 34"
        fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

// Calendar — Date of Birth
export function IconCalendar({ size = 22, color = GOLD }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Rect x={3} y={6} width={30} height={27} rx={3}
        fill="none" stroke={color} strokeWidth={1.8} />
      <Line x1={3}  y1={14} x2={33} y2={14} stroke={color} strokeWidth={1.5} />
      <Line x1={11} y1={3}  x2={11} y2={10} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Line x1={25} y1={3}  x2={25} y2={10} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Circle cx={12} cy={21} r={1.5} fill={color} />
      <Circle cx={18} cy={21} r={1.5} fill={color} />
      <Circle cx={24} cy={21} r={1.5} fill={color} />
      <Circle cx={12} cy={28} r={1.5} fill={color} />
      <Circle cx={18} cy={28} r={1.5} fill={color} />
    </Svg>
  );
}

// Globe — Country
export function IconGlobe({ size = 22, color = GOLD }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Circle cx={18} cy={18} r={15} fill="none" stroke={color} strokeWidth={1.8} />
      <Ellipse cx={18} cy={18} rx={7} ry={15} fill="none" stroke={color} strokeWidth={1.2} />
      <Line x1={3} y1={18} x2={33} y2={18} stroke={color} strokeWidth={1.2} />
      <Line x1={6} y1={10} x2={30} y2={10} stroke={color} strokeWidth={0.8} opacity={0.6} />
      <Line x1={6} y1={26} x2={30} y2={26} stroke={color} strokeWidth={0.8} opacity={0.6} />
    </Svg>
  );
}

// At-sign — Email
export function IconAt({ size = 22, color = GOLD }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Circle cx={18} cy={18} r={15} fill="none" stroke={color} strokeWidth={1.8} />
      <Circle cx={18} cy={18} r={6}  fill="none" stroke={color} strokeWidth={1.5} />
      <Path d="M24 12 L24 22 Q24 26 28 24"
        fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

// Profession mark — What You Do
export function IconProfession({ size = 22, color = GOLD }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      {/* Briefcase */}
      <Rect x={3} y={12} width={30} height={21} rx={3} fill="none" stroke={color} strokeWidth={1.8} />
      <Path d="M13 12 L13 8 Q13 5 18 5 Q23 5 23 8 L23 12"
        fill="none" stroke={color} strokeWidth={1.5} />
      <Line x1={3} y1={21} x2={33} y2={21} stroke={color} strokeWidth={1.2} />
      <Line x1={18} y1={18} x2={18} y2={24} stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

// Phone handset — Phone Number
export function IconPhone({ size = 22, color = GOLD }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Path
        d="M8 4 L14 4 Q16 4 16 6 L16 12 Q16 14 14 14 L12 14 Q12 22 18 26 Q22 28 24 26 L24 24 Q24 22 26 22 L32 22 Q34 22 34 24 L34 30 Q34 32 32 32 Q10 34 4 8 Q2 4 8 4 Z"
        fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round"
      />
    </Svg>
  );
}

// Link chain — Social
export function IconLink({ size = 22, color = GOLD }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Path d="M15 22 Q10 27 6 23 Q2 19 7 15 L12 10 Q16 6 20 10 L22 12"
        fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Path d="M21 14 Q26 9 30 13 Q34 17 29 21 L24 26 Q20 30 16 26 L14 24"
        fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Line x1={15} y1={21} x2={21} y2={15} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FACE DIRECTION ICONS — replaces 😐 / 😶 in face inscription steps
// ─────────────────────────────────────────────────────────────────────────────

// Front facing — neutral gaze
export function FaceFront({ size = 48, color = GOLD }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 60 60">
      {/* Head oval */}
      <Ellipse cx={30} cy={28} rx={18} ry={22}
        fill="none" stroke={color} strokeWidth={1.8} />
      {/* Eyes */}
      <Circle cx={22} cy={24} r={2.5} fill={color} />
      <Circle cx={38} cy={24} r={2.5} fill={color} />
      {/* Nose */}
      <Path d="M28 27 L26 34 Q30 36 34 34 L32 27"
        fill="none" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
      {/* Neutral mouth */}
      <Line x1={24} y1={40} x2={36} y2={40} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

// Side facing — profile silhouette
export function FaceSide({ size = 48, color = GOLD, direction = 'left' }) {
  const flip = direction === 'right' ? -1 : 1;
  const tx   = direction === 'right' ? 60 : 0;
  return (
    <Svg width={size} height={size} viewBox="0 0 60 60">
      <G transform={`translate(${tx}, 0) scale(${flip}, 1)`}>
        {/* Head profile */}
        <Path
          d="M18 8 Q32 4 38 12 Q46 20 44 30 Q42 42 34 48 Q24 54 18 50 L18 40 Q26 40 28 32 Q30 24 24 22 L18 22 Z"
          fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round"
        />
        {/* Eye */}
        <Circle cx={34} cy={20} r={2.5} fill={color} />
        {/* Ear */}
        <Path d="M18 28 Q14 28 14 32 Q14 36 18 36"
          fill="none" stroke={color} strokeWidth={1.5} />
        {/* Nose */}
        <Path d="M38 28 L42 32 L38 34"
          fill="none" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
      </G>
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DIVIDER LINE — classical engraving ornament for section separators
// ─────────────────────────────────────────────────────────────────────────────
export function GoldDivider({ width = 280, opacity = 0.4 }) {
  const cx = width / 2;
  return (
    <Svg width={width} height={12} viewBox={`0 0 ${width} 12`}>
      <Line x1={0}      y1={6} x2={cx - 14} y2={6} stroke={GOLD} strokeWidth={0.6} opacity={opacity} />
      <Line x1={cx + 14} y1={6} x2={width}   y2={6} stroke={GOLD} strokeWidth={0.6} opacity={opacity} />
      {/* Central diamond */}
      <Path d={`M${cx} 2 L${cx + 5} 6 L${cx} 10 L${cx - 5} 6 Z`}
        fill={GOLD} opacity={opacity * 1.2} />
      {/* Small flanking dots */}
      <Circle cx={cx - 10} cy={6} r={1.2} fill={GOLD} opacity={opacity} />
      <Circle cx={cx + 10} cy={6} r={1.2} fill={GOLD} opacity={opacity} />
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ABOUT SCREEN — Clay 3D illustrations
// Five scenes explaining MONEY to mom-and-pop. Clay/inflated style:
// radial gradients for puffiness, highlight ellipses for depth.
// ─────────────────────────────────────────────────────────────────────────────

// 1. "What is this?" — Puffy gold coin with the MONEY M-mark as foreground
export function ClayWhatIsThis({ size = 130 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 130 130">
      <Defs>
        <RadialGradient id="cwCoin" cx="38%" cy="32%" r="65%">
          <Stop offset="0%"   stopColor="#F5DF6A" />
          <Stop offset="45%"  stopColor="#D4AF37" />
          <Stop offset="100%" stopColor="#7A4F0A" />
        </RadialGradient>
        <RadialGradient id="cwRim" cx="50%" cy="50%" r="50%">
          <Stop offset="70%"  stopColor="#B8860B" stopOpacity="0" />
          <Stop offset="100%" stopColor="#5A3200" stopOpacity="0.6" />
        </RadialGradient>
        <RadialGradient id="cwGlow" cx="50%" cy="50%" r="50%">
          <Stop offset="0%"   stopColor="#D4AF37" stopOpacity="0.22" />
          <Stop offset="100%" stopColor="#D4AF37" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="cwInner" cx="38%" cy="32%" r="65%">
          <Stop offset="0%"   stopColor="#3D2200" />
          <Stop offset="100%" stopColor="#1A0A00" />
        </RadialGradient>
      </Defs>
      {/* Ambient glow */}
      <Ellipse cx="65" cy="65" rx="60" ry="60" fill="url(#cwGlow)" />
      {/* Shadow */}
      <Ellipse cx="67" cy="107" rx="36" ry="9" fill="#000" opacity="0.3" />
      {/* Outer coin */}
      <Circle cx="65" cy="58" r="44" fill="url(#cwCoin)" />
      <Circle cx="65" cy="58" r="44" fill="url(#cwRim)" />
      <Circle cx="65" cy="58" r="44" fill="none" stroke="#C9950A" strokeWidth="2.5" opacity="0.5" />
      <Circle cx="65" cy="58" r="39" fill="none" stroke="#F0C830" strokeWidth="1" opacity="0.35" />
      {/* Highlight blob top-left */}
      <Ellipse cx="49" cy="41" rx="15" ry="9" fill="#FFF8D0" opacity="0.38" />
      {/* Inner dark disc — makes the M pop as foreground */}
      <Circle cx="65" cy="58" r="30" fill="url(#cwInner)" opacity="0.85" />
      {/* Inner disc rim */}
      <Circle cx="65" cy="58" r="30" fill="none" stroke="#D4AF37" strokeWidth="1.2" opacity="0.4" />
      {/* M letterform — bold, sans-serif, centered */}
      <Path d="M46 72 L46 46 L65 62 L84 46 L84 72" stroke="#D4AF37" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* M highlight */}
      <Path d="M46 72 L46 46 L65 62 L84 46 L84 72" stroke="#FFF0A0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.4" />
      {/* Small handshake arc below M */}
      <Path d="M53 76 Q65 82 77 76" stroke="#D4AF37" strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0.7" />
    </Svg>
  );
}

// 2. "Who made this?" — Average dude in hoodie and joggers
export function ClayWhoMadeThis({ size = 130 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 130 130">
      <Defs>
        <RadialGradient id="cwmHoodie" cx="35%" cy="28%" r="70%">
          <Stop offset="0%"   stopColor="#4A5570" />
          <Stop offset="55%"  stopColor="#252E42" />
          <Stop offset="100%" stopColor="#0E1420" />
        </RadialGradient>
        <RadialGradient id="cwmSkin" cx="38%" cy="30%" r="65%">
          <Stop offset="0%"   stopColor="#F2C890" />
          <Stop offset="55%"  stopColor="#D09050" />
          <Stop offset="100%" stopColor="#8A5028" />
        </RadialGradient>
        <RadialGradient id="cwmJog" cx="35%" cy="28%" r="70%">
          <Stop offset="0%"   stopColor="#404A60" />
          <Stop offset="55%"  stopColor="#1E2535" />
          <Stop offset="100%" stopColor="#0A0E18" />
        </RadialGradient>
        <RadialGradient id="cwmCoin" cx="38%" cy="32%" r="65%">
          <Stop offset="0%"   stopColor="#F5DF6A" />
          <Stop offset="55%"  stopColor="#D4AF37" />
          <Stop offset="100%" stopColor="#7A4F0A" />
        </RadialGradient>
      </Defs>
      {/* Shadow on ground */}
      <Ellipse cx="60" cy="122" rx="34" ry="6" fill="#000" opacity="0.22" />
      {/* ── Legs / Joggers ── */}
      {/* Left leg */}
      <Rect x="40" y="82" width="20" height="40" rx="10" ry="10" fill="url(#cwmJog)" />
      <Ellipse cx="46" cy="88" rx="5" ry="3" fill="#fff" opacity="0.08" />
      {/* Right leg */}
      <Rect x="64" y="82" width="20" height="40" rx="10" ry="10" fill="url(#cwmJog)" />
      <Ellipse cx="70" cy="88" rx="5" ry="3" fill="#fff" opacity="0.08" />
      {/* ── Hoodie body ── */}
      <Rect x="30" y="44" width="64" height="44" rx="16" ry="16" fill="url(#cwmHoodie)" />
      <Rect x="30" y="44" width="64" height="44" rx="16" ry="16" fill="none" stroke="#5A6A88" strokeWidth="1" opacity="0.4" />
      {/* Hoodie front highlight */}
      <Ellipse cx="46" cy="54" rx="12" ry="7" fill="#fff" opacity="0.1" />
      {/* Kangaroo pocket */}
      <Rect x="50" y="72" width="24" height="14" rx="7" ry="7" fill="#1A2030" opacity="0.6" />
      <Ellipse cx="62" cy="72" rx="8" ry="2" fill="#5A6A88" opacity="0.3" />
      {/* Hoodie drawstring */}
      <Path d="M58 52 Q62 56 66 52" stroke="#5A6A88" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.5" />
      {/* ── Hood behind head ── */}
      <Path d="M38 46 Q30 24 62 18 Q94 12 92 46" fill="url(#cwmHoodie)" />
      <Path d="M38 46 Q30 24 62 18 Q94 12 92 46" fill="none" stroke="#5A6A88" strokeWidth="1" opacity="0.3" />
      {/* ── Head / Face ── */}
      <Circle cx="62" cy="32" r="18" fill="url(#cwmSkin)" />
      <Circle cx="62" cy="32" r="18" fill="none" stroke="#C07840" strokeWidth="0.8" opacity="0.3" />
      {/* Face highlight */}
      <Ellipse cx="56" cy="24" rx="7" ry="4" fill="#FFF0D0" opacity="0.3" />
      {/* Eyes */}
      <Ellipse cx="56" cy="30" rx="2.5" ry="2.8" fill="#2A1408" />
      <Ellipse cx="68" cy="30" rx="2.5" ry="2.8" fill="#2A1408" />
      {/* Smile */}
      <Path d="M56 38 Q62 43 68 38" stroke="#2A1408" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      {/* ── Gold coin in hand (right side) ── */}
      <Ellipse cx="102" cy="80" rx="14" ry="4" fill="#000" opacity="0.18" />
      <Circle cx="100" cy="74" r="13" fill="url(#cwmCoin)" />
      <Circle cx="100" cy="74" r="13" fill="none" stroke="#C9950A" strokeWidth="1.2" opacity="0.5" />
      <Ellipse cx="95" cy="68" rx="5" ry="3" fill="#FFF8D0" opacity="0.3" />
      {/* = on coin */}
      <Line x1="94" y1="72" x2="106" y2="72" stroke="#3D1F00" strokeWidth="2" strokeLinecap="round" />
      <Line x1="94" y1="77" x2="106" y2="77" stroke="#3D1F00" strokeWidth="2" strokeLinecap="round" />
      {/* Arm reaching to coin */}
      <Path d="M94 60 Q96 66 96 74" stroke="url(#cwmSkin)" strokeWidth="10" strokeLinecap="round" fill="none" />
    </Svg>
  );
}

// 3. "Is it safe?" — Gold shield protecting a phone (future state)
export function ClayIsItSafe({ size = 130 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 130 130">
      <Defs>
        <RadialGradient id="cisShield" cx="35%" cy="25%" r="72%">
          <Stop offset="0%"   stopColor="#F5DF6A" />
          <Stop offset="40%"  stopColor="#D4AF37" />
          <Stop offset="80%"  stopColor="#9A6E14" />
          <Stop offset="100%" stopColor="#5A3A08" />
        </RadialGradient>
        <RadialGradient id="cisGlow" cx="50%" cy="40%" r="55%">
          <Stop offset="0%"   stopColor="#D4AF37" stopOpacity="0.3" />
          <Stop offset="100%" stopColor="#D4AF37" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="cisPhone" cx="35%" cy="28%" r="68%">
          <Stop offset="0%"   stopColor="#4A5570" />
          <Stop offset="55%"  stopColor="#1E2535" />
          <Stop offset="100%" stopColor="#080C14" />
        </RadialGradient>
        <RadialGradient id="cisScreen" cx="40%" cy="30%" r="65%">
          <Stop offset="0%"   stopColor="#F5DF6A" stopOpacity="0.95" />
          <Stop offset="100%" stopColor="#8B6914" stopOpacity="0.5" />
        </RadialGradient>
      </Defs>
      {/* Glow behind shield */}
      <Ellipse cx="65" cy="64" rx="52" ry="52" fill="url(#cisGlow)" />
      {/* Rays of light */}
      {[0,45,90,135,180,225,270,315].map((angle, i) => {
        const rad = angle * Math.PI / 180;
        const x1 = 65 + 46 * Math.cos(rad); const y1 = 64 + 46 * Math.sin(rad);
        const x2 = 65 + 58 * Math.cos(rad); const y2 = 64 + 58 * Math.sin(rad);
        return <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#D4AF37" strokeWidth="1.5" opacity="0.2" strokeLinecap="round" />;
      })}
      {/* Shield shadow */}
      <Ellipse cx="67" cy="112" rx="32" ry="7" fill="#000" opacity="0.25" />
      {/* Shield body — classic heraldic shape */}
      <Path d="M18 22 H112 Q120 22 120 34 L120 72 Q120 100 65 118 Q10 100 10 72 L10 34 Q10 22 18 22 Z"
        fill="url(#cisShield)" />
      <Path d="M18 22 H112 Q120 22 120 34 L120 72 Q120 100 65 118 Q10 100 10 72 L10 34 Q10 22 18 22 Z"
        fill="none" stroke="#F0D060" strokeWidth="2" opacity="0.5" />
      {/* Shield inner border */}
      <Path d="M26 30 H104 Q110 30 110 40 L110 70 Q110 95 65 110 Q20 95 20 70 L20 40 Q20 30 26 30 Z"
        fill="none" stroke="#C9950A" strokeWidth="1.2" opacity="0.35" />
      {/* Shield highlight top */}
      <Ellipse cx="50" cy="40" rx="20" ry="10" fill="#FFF8D0" opacity="0.25" />
      {/* Phone inside shield — the future node */}
      <Rect x="50" y="44" width="30" height="50" rx="7" ry="7" fill="url(#cisPhone)" />
      <Rect x="50" y="44" width="30" height="50" rx="7" ry="7" fill="none" stroke="#5A6A88" strokeWidth="1" opacity="0.4" />
      <Rect x="54" y="50" width="22" height="34" rx="3" ry="3" fill="url(#cisScreen)" opacity="0.9" />
      <Ellipse cx="59" cy="54" rx="6" ry="3.5" fill="#fff" opacity="0.18" />
      <Circle cx="65" cy="88" r="3" fill="#2A3A4A" />
      {/* Lock icon on screen */}
      <Rect x="61" y="61" width="8" height="7" rx="2" fill="#3D1F00" opacity="0.8" />
      <Path d="M63 61 Q63 56 65 56 Q67 56 67 61" stroke="#3D1F00" strokeWidth="2" fill="none" strokeLinecap="round" />
    </Svg>
  );
}

// 4. "What if someone builds it better?" — A torch being held up (the idea passed on)
export function ClayBuildItBetter({ size = 130 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 130 130">
      <Defs>
        <RadialGradient id="cbbFlame" cx="50%" cy="20%" r="80%">
          <Stop offset="0%"   stopColor="#FFFFFF" stopOpacity="0.95" />
          <Stop offset="25%"  stopColor="#FFF0A0" />
          <Stop offset="60%"  stopColor="#FF8C00" />
          <Stop offset="100%" stopColor="#CC2200" stopOpacity="0.6" />
        </RadialGradient>
        <RadialGradient id="cbbTorch" cx="35%" cy="28%" r="70%">
          <Stop offset="0%"   stopColor="#8A6A3A" />
          <Stop offset="55%"  stopColor="#5A3A18" />
          <Stop offset="100%" stopColor="#2A1408" />
        </RadialGradient>
        <RadialGradient id="cbbHand" cx="38%" cy="28%" r="68%">
          <Stop offset="0%"   stopColor="#F2C890" />
          <Stop offset="55%"  stopColor="#C88050" />
          <Stop offset="100%" stopColor="#7A4020" />
        </RadialGradient>
        <RadialGradient id="cbbGlow" cx="50%" cy="30%" r="50%">
          <Stop offset="0%"   stopColor="#FF8C00" stopOpacity="0.35" />
          <Stop offset="100%" stopColor="#FF8C00" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      {/* Flame glow behind */}
      <Ellipse cx="65" cy="32" rx="38" ry="30" fill="url(#cbbGlow)" />
      {/* Flame — outermost */}
      <Path d="M65 8 Q80 20 78 38 Q76 52 65 56 Q54 52 52 38 Q50 20 65 8 Z" fill="#FF8C00" opacity="0.4" />
      {/* Flame — middle */}
      <Path d="M65 14 Q76 24 74 40 Q72 50 65 53 Q58 50 56 40 Q54 24 65 14 Z" fill="url(#cbbFlame)" />
      {/* Flame — inner bright core */}
      <Path d="M65 22 Q71 30 70 40 Q69 47 65 49 Q61 47 60 40 Q59 30 65 22 Z" fill="#FFF8D0" opacity="0.7" />
      {/* Sparks */}
      <Circle cx="52" cy="24" r="2" fill="#FF8C00" opacity="0.7" />
      <Circle cx="48" cy="18" r="1.5" fill="#FFF0A0" opacity="0.6" />
      <Circle cx="80" cy="20" r="2" fill="#FF8C00" opacity="0.65" />
      <Circle cx="84" cy="14" r="1.5" fill="#FFF0A0" opacity="0.55" />
      <Circle cx="56" cy="12" r="1.2" fill="#FFF0A0" opacity="0.5" />
      {/* Torch handle — clay wood */}
      <Rect x="58" y="50" width="14" height="50" rx="7" ry="7" fill="url(#cbbTorch)" />
      <Rect x="58" y="50" width="14" height="50" rx="7" ry="7" fill="none" stroke="#8A6A3A" strokeWidth="1" opacity="0.4" />
      {/* Torch grip band */}
      <Rect x="58" y="82" width="14" height="6" rx="3" ry="3" fill="#3A2008" opacity="0.6" />
      <Ellipse cx="62" cy="57" rx="4" ry="2.5" fill="#C8A060" opacity="0.25" />
      {/* Torch head / cup */}
      <Ellipse cx="65" cy="52" rx="12" ry="6" fill="url(#cbbTorch)" />
      <Ellipse cx="65" cy="52" rx="12" ry="6" fill="none" stroke="#8A6A3A" strokeWidth="1" opacity="0.5" />
      {/* Hand holding torch from below */}
      <Path d="M45 118 Q54 100 60 95" stroke="url(#cbbHand)" strokeWidth="18" strokeLinecap="round" fill="none" />
      <Path d="M85 118 Q76 100 70 95" stroke="url(#cbbHand)" strokeWidth="18" strokeLinecap="round" fill="none" />
      {/* Hand highlight */}
      <Ellipse cx="52" cy="104" rx="5" ry="3" fill="#F2C890" opacity="0.25" />
      <Ellipse cx="78" cy="104" rx="5" ry="3" fill="#F2C890" opacity="0.25" />
      {/* Shadow */}
      <Ellipse cx="65" cy="124" rx="28" ry="5" fill="#000" opacity="0.2" />
    </Svg>
  );
}

// 5. "Why should I trust it?" — Open scroll/tablet with a magnifying glass
export function ClayWhyTrust({ size = 130 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 130 130">
      <Defs>
        <RadialGradient id="scroll" cx="35%" cy="28%" r="70%">
          <Stop offset="0%"   stopColor="#E8D08A" />
          <Stop offset="50%"  stopColor="#C4A84A" />
          <Stop offset="100%" stopColor="#7A5A18" />
        </RadialGradient>
        <RadialGradient id="lens" cx="38%" cy="32%" r="65%">
          <Stop offset="0%"   stopColor="#A8D8F8" stopOpacity="0.85" />
          <Stop offset="60%"  stopColor="#5A9AC8" stopOpacity="0.7" />
          <Stop offset="100%" stopColor="#1A4A78" stopOpacity="0.9" />
        </RadialGradient>
        <RadialGradient id="handle" cx="35%" cy="30%" r="70%">
          <Stop offset="0%"   stopColor="#8A6A3A" />
          <Stop offset="55%"  stopColor="#5A3A18" />
          <Stop offset="100%" stopColor="#2A1408" />
        </RadialGradient>
      </Defs>
      {/* Scroll shadow */}
      <Ellipse cx="52" cy="112" rx="36" ry="7" fill="#000" opacity="0.22" />
      {/* Scroll body */}
      <Rect x="14" y="28" width="72" height="80" rx="8" ry="8" fill="url(#scroll)" />
      <Rect x="14" y="28" width="72" height="80" rx="8" ry="8" fill="none" stroke="#C4A84A" strokeWidth="1.5" opacity="0.5" />
      {/* Scroll highlight */}
      <Ellipse cx="32" cy="40" rx="14" ry="7" fill="#fff" opacity="0.2" />
      {/* Scroll top/bottom rolled edges */}
      <Rect x="14" y="28" width="72" height="12" rx="6" ry="6" fill="#8B6914" opacity="0.4" />
      <Rect x="14" y="96" width="72" height="12" rx="6" ry="6" fill="#8B6914" opacity="0.4" />
      {/* Text lines on scroll */}
      <Line x1="26" y1="52" x2="74" y2="52" stroke="#3D1F00" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
      <Line x1="26" y1="62" x2="74" y2="62" stroke="#3D1F00" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
      <Line x1="26" y1="72" x2="60" y2="72" stroke="#3D1F00" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
      <Line x1="26" y1="82" x2="68" y2="82" stroke="#3D1F00" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
      {/* Magnifying glass lens */}
      <Circle cx="88" cy="50" r="22" fill="url(#lens)" opacity="0.88" />
      <Circle cx="88" cy="50" r="22" fill="none" stroke="#2A6A9A" strokeWidth="3" opacity="0.7" />
      <Ellipse cx="80" cy="42" rx="9" ry="6" fill="#fff" opacity="0.22" />
      {/* Handle */}
      <Path d="M104 64 L118 80" stroke="url(#handle)" strokeWidth="8" strokeLinecap="round" />
      <Path d="M104 64 L118 80" stroke="#F0C878" strokeWidth="2" strokeLinecap="round" opacity="0.25" />
    </Svg>
  );
}
