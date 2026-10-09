// HoloFX.js — native holographic FX layer (iOS/Android).
//
// Recreates an anamorphic "3D box" illusion on device with react-native-svg +
// Animated + expo-sensors (gyroscope) — Expo-Go-safe, no native build.
//
// The illusion has three depth layers:
//   • BACK  — deep-space starfield/planet, drawn in PERSPECTIVE and parallaxed
//             by the phone's gyroscope (tilt the phone → the world shifts).
//   • MID   — a beveled DepthFrame: the rim of the "screen box".
//   • FRONT — your UI cards/buttons, beveled + drop-shadowed so they appear to
//             pop out past the frame toward the viewer.
//
// Exports (match HoloFX.web.js public API): useHoloBackground, useHoloTransition,
//   HoloBackground, DepthFrame, useTilt, glass* styles.

import React, { useRef, useEffect, useState } from 'react';
import { View, Dimensions, Animated, Platform, StyleSheet } from 'react-native';
import Svg, { Defs, RadialGradient, LinearGradient, Stop, Rect, Circle, Line, Ellipse } from 'react-native-svg';
import { DeviceMotion } from 'expo-sensors';
import { SCALE, PARALLAX, bgLayout, ringFade } from './holo_geometry';

// ── Deterministic starfield ─────────────────────────────────────────────────
const _rng = (() => { let s = 0x1a2b3c4d; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const STARS = Array.from({ length: 64 }, (_, i) => ({
  x: _rng(), y: _rng(),
  r: 0.5 + _rng() * (_rng() > 0.9 ? 2.4 : 1.5),
  grp: i % 3,
  gold: _rng() > 0.72,
}));
const LINES = [];
for (let i = 0; i < STARS.length && LINES.length < 26; i++) {
  for (let j = i + 1; j < STARS.length && LINES.length < 26; j++) {
    const dx = STARS[i].x - STARS[j].x, dy = STARS[i].y - STARS[j].y;
    if (Math.hypot(dx, dy) < 0.15) LINES.push([i, j]);
  }
}

// ── Gyroscope tilt → two smoothed Animated.Values in [-1, 1] ────────────────
// x = left/right tilt, y = front/back tilt. No-op on web (returns dead values).
export const useTilt = () => {
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let sub = null, mounted = true, sx = 0, sy = 0;
    (async () => {
      try {
        const ok = await DeviceMotion.isAvailableAsync();
        if (!ok || !mounted) return;
        // iOS needs motion permission; Android does not. Requesting on Android
        // can briefly background the app and trip the re-auth lock screen.
        if (Platform.OS === 'ios') { try { await DeviceMotion.requestPermissionsAsync(); } catch {} }
        DeviceMotion.setUpdateInterval(40);
        sub = DeviceMotion.addListener((data) => {
          const r = data && data.rotation;
          if (!r) return;
          const gx = Math.max(-1, Math.min(1, (r.gamma || 0) / (Math.PI / 5)));  // ±36°
          const gy = Math.max(-1, Math.min(1, (r.beta  || 0) / (Math.PI / 5)));
          sx += (gx - sx) * 0.18;  // low-pass smoothing
          sy += (gy - sy) * 0.18;
          x.setValue(sx); y.setValue(sy);
        });
      } catch {}
    })();
    return () => { mounted = false; if (sub) sub.remove(); };
  }, []);
  return { x, y };
};

// ── Shooting star — RN view, native-driver motion ───────────────────────────
const ShootingStar = ({ delay, x, y, dx, dy, len, angle, gap }) => {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(t, { toValue: 1, duration: 1000, useNativeDriver: true }),
      Animated.delay(gap),
      Animated.timing(t, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  const tx = t.interpolate({ inputRange: [0, 1], outputRange: [x, x + dx] });
  const ty = t.interpolate({ inputRange: [0, 1], outputRange: [y, y + dy] });
  const op = t.interpolate({ inputRange: [0, 0.12, 0.75, 1], outputRange: [0, 1, 0.9, 0] });
  return (
    <Animated.View pointerEvents="none" style={{
      position: 'absolute', width: len, height: 2, borderRadius: 2, backgroundColor: '#FFE7A8',
      shadowColor: '#FFE7A8', shadowOpacity: 0.95, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
      opacity: op, transform: [{ translateX: tx }, { translateY: ty }, { rotate: `${angle}deg` }],
    }} />
  );
};

// One background layer: the overdrawn canvas, same drawing coordinates (0..W × 0..H
// is still the visible area). Module-level so re-renders never remount the SVGs.
const Layer = ({ L, children }) => <Svg width={L.style.width} height={L.style.height} viewBox={L.viewBox}>{children}</Svg>;

// ── BACK layer — perspective deep-space, parallaxed by gyro ─────────────────
// Sized from its OWN measured area (onLayout), never from a number read once at
// app start, and every layer is overdrawn past every edge (holo_geometry.js) — so
// no straight layer edge can ever cross the screen (tester feedback Oct 8, B3).
export const HoloBackground = ({ tilt }) => {
  const tw = [useRef(new Animated.Value(0.5)).current, useRef(new Animated.Value(0.8)).current, useRef(new Animated.Value(0.35)).current];
  const neb1 = useRef(new Animated.Value(0)).current;
  const neb2 = useRef(new Animated.Value(0)).current;
  const aura = useRef(new Animated.Value(0)).current;
  const planet = useRef(new Animated.Value(0)).current;
  // first frame: the full SCREEN (never smaller than the area we fill); then the real measured size
  const [size, setSize] = useState(() => { const s = Dimensions.get('screen'); return { w: s.width, h: s.height }; });
  const onLayout = (e) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0 && (Math.round(width) !== Math.round(size.w) || Math.round(height) !== Math.round(size.h))) setSize({ w: width, h: height });
  };

  useEffect(() => {
    const loops = [];
    const pulse = (v, hi, dur, lo = 0) => Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: hi, duration: dur, useNativeDriver: true }),
      Animated.timing(v, { toValue: lo, duration: dur, useNativeDriver: true }),
    ]));
    loops.push(pulse(tw[0], 1, 1500, 0.35), pulse(tw[1], 0.95, 2100, 0.45), pulse(tw[2], 0.9, 2700, 0.25));
    loops.push(pulse(neb1, 1, 9000), pulse(neb2, 1, 7600), pulse(aura, 1, 6200), pulse(planet, 1, 8000));
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, []);

  const neb1Op   = neb1.interpolate({ inputRange: [0, 1], outputRange: [0.16, 0.42] });
  const neb2Op   = neb2.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.34] });
  const auraOp   = aura.interpolate({ inputRange: [0, 1], outputRange: [0.05, 0.18] });
  const planetOp = planet.interpolate({ inputRange: [0, 1], outputRange: [0.10, 0.22] });

  // Gyro-driven parallax. (rotateX/rotateY 3D rotation isn't supported by the
  // Expo Go renderer, so depth is conveyed by translate + over-scan instead.)
  const TX = tilt && tilt.x, TY = tilt && tilt.y;
  const parX = TX ? TX.interpolate({ inputRange: [-1, 1], outputRange: [PARALLAX, -PARALLAX] }) : 0;
  const parY = TY ? TY.interpolate({ inputRange: [-1, 1], outputRange: [PARALLAX, -PARALLAX] }) : 0;

  const L = bgLayout(size.w, size.h);
  const W = L.w, H = L.h;
  const svgLayer = L.style;
  const ringA = ringFade(W * 1.02, W * 0.82, W);
  const ringB = ringFade(W * 1.02, W * 1.05, W);
  const fadeStops = (r) => r.stops.map(([o, a], i) => <Stop key={i} offset={o} stopColor="#D4AF37" stopOpacity={a} />);

  return (
    <View style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]} pointerEvents="none" onLayout={onLayout}>
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: parX }, { translateY: parY }, { scale: SCALE }] }]}>

        {/* Static base: space background (fills the WHOLE overdrawn area) + constellation lines */}
        <View style={svgLayer}>
          <Layer L={L}>
            <Defs>
              <RadialGradient id="space" cx={W * 0.5} cy={H * 0.3} rx={W * 0.9} ry={H * 0.9} gradientUnits="userSpaceOnUse">
                <Stop offset="0%" stopColor="#2A1803" /><Stop offset="45%" stopColor="#130B02" /><Stop offset="100%" stopColor="#040207" />
              </RadialGradient>
            </Defs>
            <Rect {...L.full} fill="url(#space)" />
            {LINES.map(([a, b], i) => (
              <Line key={`l${i}`} x1={STARS[a].x * W} y1={STARS[a].y * H} x2={STARS[b].x * W} y2={STARS[b].y * H} stroke="#D4AF37" strokeWidth="0.5" strokeOpacity="0.14" />
            ))}
          </Layer>
        </View>

        {/* Aurora — fills the whole overdrawn width and runs past the bottom; the
            gradient is in absolute (userSpaceOnUse) coordinates and is fully
            transparent from 62% upward, so it has no edge anywhere on screen. */}
        <Animated.View style={[svgLayer, { opacity: auraOp }]} pointerEvents="none">
          <Layer L={L}>
            <Defs>
              <LinearGradient id="aurora" x1={0} y1={H} x2={0} y2={H * 0.62} gradientUnits="userSpaceOnUse">
                <Stop offset="0%" stopColor="#1FB6A8" stopOpacity="0.55" /><Stop offset="60%" stopColor="#2A7DC9" stopOpacity="0.18" /><Stop offset="100%" stopColor="#2A7DC9" stopOpacity="0" />
              </LinearGradient>
            </Defs>
            <Rect {...L.full} fill="url(#aurora)" />
          </Layer>
        </Animated.View>

        {/* Planet — native-driver opacity. Rings FADE toward their ends (no hard straight segments). */}
        <Animated.View style={[svgLayer, { opacity: planetOp }]} pointerEvents="none">
          <Layer L={L}>
            <Defs>
              <RadialGradient id="planet" cx="38%" cy="38%" r="65%">
                <Stop offset="0%" stopColor="#FFE7A8" stopOpacity="0.9" /><Stop offset="35%" stopColor="#C9962E" stopOpacity="0.65" />
                <Stop offset="70%" stopColor="#5A2E00" stopOpacity="0.35" /><Stop offset="100%" stopColor="#5A2E00" stopOpacity="0" />
              </RadialGradient>
              <LinearGradient id="ringA" x1={ringA.x1} y1={0} x2={ringA.x2} y2={0} gradientUnits="userSpaceOnUse">{fadeStops(ringA)}</LinearGradient>
              <LinearGradient id="ringB" x1={ringB.x1} y1={0} x2={ringB.x2} y2={0} gradientUnits="userSpaceOnUse">{fadeStops(ringB)}</LinearGradient>
            </Defs>
            <Circle cx={W * 1.02} cy={H * 0.1} r={W * 0.62} fill="url(#planet)" />
            <Ellipse cx={W * 1.02} cy={H * 0.1} rx={W * 0.82} ry={W * 0.34} fill="none" stroke="url(#ringA)" strokeWidth="0.7" strokeOpacity="0.5" />
            <Ellipse cx={W * 1.02} cy={H * 0.1} rx={W * 1.05} ry={W * 0.5}  fill="none" stroke="url(#ringB)" strokeWidth="0.6" strokeOpacity="0.32" />
          </Layer>
        </Animated.View>

        {/* Nebula 1 — native-driver opacity */}
        <Animated.View style={[svgLayer, { opacity: neb1Op }]} pointerEvents="none">
          <Layer L={L}>
            <Defs>
              <RadialGradient id="nebGold" cx="50%" cy="50%" r="50%"><Stop offset="0%" stopColor="#E8C04A" stopOpacity="0.95" /><Stop offset="100%" stopColor="#E8C04A" stopOpacity="0" /></RadialGradient>
            </Defs>
            <Ellipse cx={W * 0.2}  cy={H * 0.24} rx={W * 0.6}  ry={W * 0.6}  fill="url(#nebGold)" />
          </Layer>
        </Animated.View>

        {/* Nebula 2 — native-driver opacity */}
        <Animated.View style={[svgLayer, { opacity: neb2Op }]} pointerEvents="none">
          <Layer L={L}>
            <Defs>
              <RadialGradient id="nebEmber" cx="50%" cy="50%" r="50%"><Stop offset="0%" stopColor="#9C3F00" stopOpacity="0.95" /><Stop offset="100%" stopColor="#9C3F00" stopOpacity="0" /></RadialGradient>
            </Defs>
            <Ellipse cx={W * 0.84} cy={H * 0.8}  rx={W * 0.55} ry={W * 0.55} fill="url(#nebEmber)" />
          </Layer>
        </Animated.View>

        {/* Star groups — native-driver opacity */}
        {[0, 1, 2].map(grp => (
          <Animated.View key={`sg${grp}`} style={[svgLayer, { opacity: tw[grp] }]} pointerEvents="none">
            <Layer L={L}>
              {STARS.filter(s => s.grp === grp).map((s, i) => (
                <Circle key={`s${grp}_${i}`} cx={s.x * W} cy={s.y * H} r={s.r} fill={s.gold ? '#FFE39A' : '#FFFFFF'} />
              ))}
            </Layer>
          </Animated.View>
        ))}

        {/* Vignette on top (static) — fills the whole overdrawn area */}
        <View style={svgLayer}>
          <Layer L={L}>
            <Defs>
              <RadialGradient id="vign" cx={W * 0.5} cy={H * 0.42} rx={W * 0.75} ry={H * 0.75} gradientUnits="userSpaceOnUse">
                <Stop offset="0%" stopColor="#000000" stopOpacity="0" /><Stop offset="72%" stopColor="#000000" stopOpacity="0" /><Stop offset="100%" stopColor="#000000" stopOpacity="0.6" />
              </RadialGradient>
            </Defs>
            <Rect {...L.full} fill="url(#vign)" />
          </Layer>
        </View>

        <ShootingStar delay={1200} x={-80}     y={H * 0.18} dx={W * 0.8}  dy={H * 0.28} len={120} angle={20} gap={6000} />
        <ShootingStar delay={4800} x={W * 0.5} y={-60}      dx={W * 0.45} dy={H * 0.4}  len={90}  angle={42} gap={8200} />
      </Animated.View>
    </View>
  );
};

// ── MID layer — beveled "screen box" frame ──────────────────────────────────
// A raised gold rim with light top/left + dark bottom/right bevel, plus corner
// brackets — reads as the edge of a recessed 3D screen the world sits inside.
export const DepthFrame = () => {
  const M = 6;            // inset from screen edge
  const R = 22;           // corner radius
  const C = 26;           // corner-bracket length
  const corner = (pos) => ({
    position: 'absolute', width: C, height: C, borderColor: 'rgba(212,175,55,0.8)', ...pos,
  });
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* base rim */}
      <View style={{ position: 'absolute', top: M, left: M, right: M, bottom: M, borderRadius: R, borderWidth: 1.5, borderColor: 'rgba(212,175,55,0.40)' }} />
      {/* bevel highlight (top + left) */}
      <View style={{ position: 'absolute', top: M, left: M, right: M, bottom: M, borderRadius: R, borderColor: 'transparent', borderTopWidth: 1.5, borderLeftWidth: 1.5, borderTopColor: 'rgba(255,236,170,0.55)', borderLeftColor: 'rgba(255,236,170,0.30)' }} />
      {/* bevel shadow (bottom + right) */}
      <View style={{ position: 'absolute', top: M, left: M, right: M, bottom: M, borderRadius: R, borderColor: 'transparent', borderBottomWidth: 2, borderRightWidth: 2, borderBottomColor: 'rgba(0,0,0,0.55)', borderRightColor: 'rgba(0,0,0,0.45)' }} />
      {/* corner brackets */}
      <View style={corner({ top: M - 1, left: M - 1, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: R })} />
      <View style={corner({ top: M - 1, right: M - 1, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: R })} />
      <View style={corner({ bottom: M - 1, left: M - 1, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: R })} />
      <View style={corner({ bottom: M - 1, right: M - 1, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: R })} />
    </View>
  );
};

// ── Hooks kept for API parity (no-ops on native; web uses its own) ──────────
export const useHoloBackground = () => {};
export const useHoloTransition = (_step) => {};

// ── Glass surfaces (FRONT layer) ─────────────────────────────────────────────
// Translucent gold-rimmed panes; buttons get a strong bevel + drop shadow so
// they read as raised/popping out past the DepthFrame toward the viewer.
const glow = (opacity, radius, elev) => Platform.select({
  ios: { shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 6 }, shadowOpacity: opacity, shadowRadius: radius },
  android: { elevation: elev },
  default: {},
});

export const glassOnboardCard = {
  backgroundColor: 'rgba(28,17,4,0.58)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.28)', borderRadius: 18, ...glow(0.22, 20, 10),
};
// More opaque + brighter gold edge so cards read clearly over the animated
// background (tester feedback Oct 8, B2; was 0.64 / 0.24).
export const glassCard = {
  backgroundColor: 'rgba(20,12,3,0.86)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.36)', borderRadius: 16, ...glow(0.20, 18, 9),
};
// Beveled, lifted button — light top/left, dark bottom/right + big drop shadow.
export const glassButton = Platform.select({
  ios: {
    borderWidth: 1.5,
    borderTopColor: 'rgba(255,242,200,0.95)', borderLeftColor: 'rgba(255,236,175,0.7)',
    borderRightColor: 'rgba(110,72,8,0.7)',   borderBottomColor: 'rgba(70,42,4,0.85)',
    shadowColor: '#000', shadowOffset: { width: 0, height: 9 }, shadowOpacity: 0.55, shadowRadius: 12,
  },
  android: {
    borderWidth: 1.5,
    borderTopColor: 'rgba(255,242,200,0.95)', borderLeftColor: 'rgba(255,236,175,0.7)',
    borderRightColor: 'rgba(110,72,8,0.7)',   borderBottomColor: 'rgba(70,42,4,0.85)',
    elevation: 18,
  },
  default: {},
});
export const glassTermBox = {
  backgroundColor: 'rgba(212,175,55,0.07)', borderColor: 'rgba(212,175,55,0.3)',
};
