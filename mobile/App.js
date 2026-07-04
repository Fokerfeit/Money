import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, Alert, StyleSheet, ScrollView,
  TouchableOpacity, Pressable, Share, Image, AppState, SafeAreaView,
  Dimensions, Modal, Animated, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
// BIP39 (audited, RN-safe, bundles its own wordlist). We use the ENTROPY path
// (entropyToMnemonic / mnemonicToEntropy) — NOT the PBKDF2 mnemonic→seed path —
// so the 24 words encode the wallet's existing 32-byte seed directly and restore
// the EXACT same address. Proven 30001/30001 round-trips.
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist as bip39Words } from '@scure/bip39/wordlists/english.js';
import * as ExpoCrypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Audio, Video as ExpoVideo, ResizeMode } from 'expo-av';
// Sovereignty model: identity is the user's on-device ed25519 keypair.
// No third-party identity provider (no Google, no Firebase phone auth) — those
// are centralized choke points that can be banned or pressured, which would
// contradict the mission. Sybil resistance is handled separately (invite codes
// → social vouching → validator-eligibility → faucet decay), NOT by the login.
// ── Pure-JS TOTP — no native modules, RFC 6238 compliant ──────────────────
// SHA-1 (RFC 3174)
const _sha1 = (m) => {
  const H=[0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476,0xC3D2E1F0];
  const K=[0x5A827999,0x6ED9EBA1,0x8F1BBCDC,0xCA62C1D6];
  const bits=m.length*8; const p=[...m,0x80];
  while(p.length%64!==56)p.push(0);
  for(let i=7;i>=0;i--)p.push((bits/Math.pow(2,i*8))&0xFF);
  for(let i=0;i<p.length;i+=64){
    const W=[];
    for(let j=0;j<16;j++)W[j]=(p[i+j*4]<<24)|(p[i+j*4+1]<<16)|(p[i+j*4+2]<<8)|p[i+j*4+3];
    for(let j=16;j<80;j++){const x=W[j-3]^W[j-8]^W[j-14]^W[j-16];W[j]=(x<<1)|(x>>>31);}
    let [a,b,c,d,e]=H;
    for(let j=0;j<80;j++){
      const t=Math.floor(j/20); let f,k;
      if(t===0){f=(b&c)|(~b&d);k=K[0];}else if(t===1){f=b^c^d;k=K[1];}
      else if(t===2){f=(b&c)|(b&d)|(c&d);k=K[2];}else{f=b^c^d;k=K[3];}
      const tmp=(((a<<5)|(a>>>27))+f+e+k+W[j])>>>0;
      e=d;d=c;c=((b<<30)|(b>>>2))>>>0;b=a;a=tmp;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;H[4]=(H[4]+e)>>>0;
  }
  return H.reduce((r,h)=>[...r,(h>>>24)&0xFF,(h>>>16)&0xFF,(h>>>8)&0xFF,h&0xFF],[]);
};
const _hmac1 = (key,msg) => {
  const BL=64; let k=key.length>BL?_sha1(key):[...key];
  while(k.length<BL)k.push(0);
  return _sha1([...k.map(b=>b^0x5C),..._sha1([...k.map(b=>b^0x36),...msg])]);
};
const _B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const _b32dec = (s) => {
  s=s.toUpperCase().replace(/=+$/,'').replace(/[^A-Z2-7]/g,'');
  let bits=''; for(const c of s)bits+=_B32.indexOf(c).toString(2).padStart(5,'0');
  const out=[]; for(let i=0;i+8<=bits.length;i+=8)out.push(parseInt(bits.slice(i,i+8),2));
  return out;
};
const _b32enc = (bytes) => {
  let bits=''; for(const b of bytes)bits+=b.toString(2).padStart(8,'0');
  let r=''; for(let i=0;i+5<=bits.length;i+=5)r+=_B32[parseInt(bits.slice(i,i+5),2)];
  return r;
};
const _totpAt = (secret,T) => {
  const h=_hmac1(_b32dec(secret),[0,0,0,0,(T>>>24)&0xFF,(T>>>16)&0xFF,(T>>>8)&0xFF,T&0xFF]);
  const o=h[19]&0x0F; const code=((h[o]&0x7F)<<24)|(h[o+1]<<16)|(h[o+2]<<8)|h[o+3];
  return String(code%1_000_000).padStart(6,'0');
};
// Public API — drop-in replacement for otplib's authenticator
const authenticator = {
  generateSecret: () => _b32enc([...ExpoCrypto.getRandomBytes(20)]),
  generate:  (secret) => _totpAt(secret, Math.floor(Date.now()/1000/30)),
  check: (token, secret) => [-1,0,1].some(d => _totpAt(secret, Math.floor(Date.now()/1000/30)+d) === String(token).padStart(6,'0')),
};
import { BACKEND_URL, BASE_PENALTY, DISCONNECT_GRACE_MS, RESERVE_ADDRESS, getNetwork, isTestnet, setNetwork, loadNetwork } from './config';
import MoneySymbol from './MoneySymbol';
import {
  SealMedallion, GoldCoin, IgnitedCoin, ForgeHammerSVG, AnvilSVG, ForgeSparks,
  FlameIcon, LockIcon, CheckSeal, HourglassIcon, PendingCircle, CameraIrisIcon,
  EyeIcon, ThumbprintIcon, IgnitionBurst,
  IconPerson, IconCalendar, IconGlobe, IconAt, IconProfession, IconPhone, IconLink,
  FaceFront, FaceSide, GoldDivider,
  ClayWhatIsThis, ClayWhoMadeThis, ClayIsItSafe, ClayBuildItBetter, ClayWhyTrust,
} from './Icons';
import QRCode from 'react-native-qrcode-svg';
import {
  useHoloBackground, useHoloTransition, HoloBackground, DepthFrame, useTilt,
  glassCard, glassButton, glassOnboardCard, glassTermBox,
} from './HoloFX';

const { width } = Dimensions.get('window');

// ── Platform guard ──────────────────────────────────────────────────────────
// On web, biometrics and native camera don't exist.
// IS_WEB lets us skip those gates cleanly so the preview stays navigable.
const IS_WEB = typeof document !== 'undefined';
// useNativeDriver must be false on web — no native animation module in browser
const NATIVE_DRIVER = !IS_WEB;

// ── Crypto ─────────────────────────────────────────────────────────────────
const toHex   = (arr) => Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));

const createKeypair = () => {
  const seed = ExpoCrypto.getRandomBytes(32);
  const kp   = nacl.sign.keyPair.fromSeed(seed);
  return {
    address:   'M_' + toHex(kp.publicKey).substring(0, 32).toUpperCase(),
    publicKey: toHex(kp.publicKey),
    secretKey: toHex(kp.secretKey),
  };
};

const signTx = (from, to, amount, timestamp, secretKeyHex) => {
  const msg      = `${from}:${to}:${amount}:${timestamp}`;
  const msgBytes = Uint8Array.from(Array.from(msg).map(c => c.charCodeAt(0)));
  return toHex(nacl.sign.detached(msgBytes, fromHex(secretKeyHex)));
};

// ── Faucet reward formula ───────────────────────────────────────────────────
const calcReward = (count) => {
  const tiers = Math.floor(count / 1_000_000);
  let r = 1_000_000;
  for (let i = 0; i < tiers; i++) r *= 0.8;
  return Math.max(Math.floor(r), 1);
};

const fmt = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const todayStr = () => new Date().toISOString().split('T')[0];

// ── Currency symbol — used like $ or ₿ ────────────────────────────────────
const Ɱ = 'Ɱ';
const fmtM = (n) => `${Ɱ} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Liveness voice matching — multilingual ──────────────────────────────────
const NUMBER_WORDS = {
  1: ['one','1','won',                        // English
      'un','une',                              // French
      'uno',                                   // Spanish / Italian / Portuguese
      'eins','ein',                            // German
      'один','odyn',                           // Russian / Ukrainian
      'bir',                                   // Turkish / Azerbaijani
      'yek','yak',                             // Farsi / Dari
      'ichi', 'yi ',                           // Japanese / Chinese
      'wahid','واحد',                          // Arabic
      'ek','एक',                               // Hindi
      'moja','moja ',                          // Swahili
      'en ','ett',                             // Swedish / Norwegian
  ],
  2: ['two','2','too','to ',                  // English
      'deux',                                  // French
      'dos',                                   // Spanish / Portuguese
      'due',                                   // Italian
      'zwei',                                  // German
      'два','dva',                             // Russian / Ukrainian
      'iki',                                   // Turkish
      'do ',                                   // Farsi / Hindi
      'ni ','er ',                             // Japanese / Chinese
      'ithnan','اثنان',                        // Arabic
      'mbili',                                 // Swahili
      'två','to ',                             // Swedish / Norwegian
  ],
  3: ['three','3',                            // English
      'trois',                                 // French
      'tres',                                  // Spanish / Portuguese
      'tre',                                   // Italian / Swedish / Norwegian
      'drei',                                  // German
      'три','try',                             // Russian / Ukrainian
      'üç','uch',                              // Turkish
      'seh','se ',                             // Farsi
      'san ','sān',                            // Japanese / Chinese
      'thalatha','ثلاثة',                      // Arabic
      'teen','तीन',                            // Hindi
      'tatu',                                  // Swahili
  ],
  4: ['four','4','for','fore',               // English
      'quatre',                                // French
      'cuatro',                                // Spanish
      'quatro',                                // Portuguese
      'quattro',                               // Italian
      'vier',                                  // German / Dutch
      'четыре','chotyry',                      // Russian / Ukrainian
      'dört','dort',                           // Turkish
      'chahar',                                // Farsi
      'shi ','sì ',                            // Japanese / Chinese
      'arba','أربعة',                          // Arabic
      'char','चार',                            // Hindi
      'nne','ine',                             // Swahili
      'fyra','fire',                           // Swedish / Norwegian
  ],
  5: ['five','5',                             // English
      'cinq',                                  // French
      'cinco',                                 // Spanish / Portuguese
      'cinque',                                // Italian
      'fünf','funf',                           // German
      'пять','pyat',                           // Russian
      'beş','bes',                             // Turkish
      'panj',                                  // Farsi
      'go ','wǔ ',                             // Japanese / Chinese
      'khamsa','خمسة',                         // Arabic
      'paanch','पाँच',                         // Hindi
      'tano',                                  // Swahili
      'fem',                                   // Swedish / Norwegian / Danish
  ],
};
const matchesNumber = (transcript, target) =>
  (NUMBER_WORDS[target] || []).some(w => transcript.toLowerCase().includes(w.toLowerCase()));

// ── Seal-mark validation ──────────────────────────────────────────────────
// ── WobbleTile — jiggles ONLY when touched (or hovered on web) ───────────────
// `delay` kept for call-site compatibility; no longer used (was a looping idle
// wobble, which read as distracting — now it reacts to interaction instead).
function WobbleTile({ children, delay = 0, amplitude = 2.4 }) {
  const wobble = useRef(new Animated.Value(0)).current;
  const jiggle = () => {
    wobble.stopAnimation();
    wobble.setValue(0);
    // quick tip, then a springy settle that overshoots back-and-forth = wobble
    Animated.sequence([
      Animated.timing(wobble, { toValue: 1, duration: 80, useNativeDriver: NATIVE_DRIVER }),
      Animated.spring(wobble, { toValue: 0, friction: 3, tension: 90, useNativeDriver: NATIVE_DRIVER }),
    ]).start();
  };
  const rotate = wobble.interpolate({ inputRange: [-1, 1], outputRange: [`-${amplitude}deg`, `${amplitude}deg`] });
  return (
    <Pressable onPressIn={jiggle} onHoverIn={jiggle}>
      <Animated.View style={{ transform: [{ rotate }] }}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

// A real seal mark is 'M_' + 32 uppercase hex chars (see createKeypair).
// We accept a small length range to stay tolerant of any future format tweaks,
// but reject anything that clearly isn't an address so funds can't be sent into
// the void by a typo.
const isValidSealMark = (addr) => {
  const a = (addr || '').trim();
  return /^M_[0-9A-F]{16,64}$/i.test(a);
};

// ── Display helpers ─────────────────────────────────────────────────────────
const displayAddr = (addr) =>
  addr === 'FAUCET'         ? 'COMMON TREASURY' :
  addr === RESERVE_ADDRESS  ? 'COMMON RESERVE'  : addr;

// ── Face capture steps ──────────────────────────────────────────────────────
// icon: 'front' | 'left' | 'right' — rendered as SVG face icon in the scan UI
//
// Pose gating — yawAngle convention (expo-face-detector, front/selfie camera):
//   ~0        = facing straight
//   positive  = face rotated to user's LEFT  (mirrored front cam)
//   negative  = face rotated to user's RIGHT
// minYaw / maxYaw define the accepted range; -999 / 999 = unbounded on that side.
// requiresTap: true  → user must tap when they've achieved the pose (no auto-countdown)
// requiresTap: false → auto-countdown captures after 3s
const FACE_STEPS = [
  { instruction: 'Face straight — fill the oval', icon: 'front', requiresTap: false },
  { instruction: 'Turn your head to one side',    icon: 'left',  requiresTap: true  },
  { instruction: 'Return to center and hold',     icon: 'front', requiresTap: false },
];

// (Daily missions removed with the suns mechanic.)

const RE_AUTH_COUNTDOWN = 3;

// How long the app must be in the background before re-opening forces a full
// re-auth (biometric + MONEY PIN). Short app-switches stay unlocked.
const REAUTH_AWAY_MS = 5 * 60 * 1000; // 5 minutes

// (Identity/KYC contribution cards removed with the suns mechanic.)

// ── Screen entry animation — every screen fades + scales in from slightly zoomed-out ─
const ScreenWrapper = ({ children, style }) => {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, { toValue: 1, tension: 55, friction: 9, useNativeDriver: NATIVE_DRIVER }).start();
  }, []);
  const scaleInterp = anim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });
  return (
    <Animated.View style={[{ flex: 1, backgroundColor: 'transparent' }, style, { opacity: anim, transform: [{ scale: scaleInterp }] }]}>
      {/* The deep-space background + depth frame are rendered ONCE at the app
          root (see App() at the bottom) so EVERY screen shows them — not just
          the ones wrapped in ScreenWrapper. */}
      {children}
      {/* Domain bar — floats above all screens on native (web is handled by HoloFX CSS) */}
      {Platform.OS !== 'web' && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0 }} pointerEvents="none">
          <SafeAreaView style={{ backgroundColor: 'transparent' }}>
            <Text style={{
              textAlign: 'center',
              color: 'rgba(212,175,55,0.55)',
              fontSize: 10,
              letterSpacing: 3.5,
              fontWeight: '600',
              paddingVertical: 5,
              textShadowColor: 'rgba(212,175,55,0.35)',
              textShadowOffset: { width: 0, height: 0 },
              textShadowRadius: 8,
            }}>
              moneyforeveryone.app
            </Text>
          </SafeAreaView>
        </View>
      )}
    </Animated.View>
  );
};

// ── Ambient floating glow orbs — purely decorative depth layer ───────────
const GlowOrbs = () => {
  const o1 = useRef(new Animated.Value(0)).current;
  const o2 = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a1 = Animated.loop(Animated.sequence([
      Animated.timing(o1, { toValue: 1, duration: 5500, useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(o1, { toValue: 0, duration: 5500, useNativeDriver: NATIVE_DRIVER }),
    ]));
    const a2 = Animated.loop(Animated.sequence([
      Animated.timing(o2, { toValue: 0, duration: 3200, useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(o2, { toValue: 1, duration: 7000, useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(o2, { toValue: 0, duration: 5000, useNativeDriver: NATIVE_DRIVER }),
    ]));
    a1.start(); a2.start();
    return () => { a1.stop(); a2.stop(); };
  }, []);
  const y1  = o1.interpolate({ inputRange: [0, 1], outputRange: [0, 35] });
  const y2  = o2.interpolate({ inputRange: [0, 1], outputRange: [0, -28] });
  const op1 = o1.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.05, 0.13, 0.05] });
  const op2 = o2.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.03, 0.10, 0.03] });
  return (
    <View nativeID="native-glow-orbs" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none">
      <Animated.View style={{
        position: 'absolute', top: '8%', left: '-30%',
        width: width * 0.9, height: width * 0.9, borderRadius: width * 0.45,
        backgroundColor: '#D4AF37', opacity: op1, transform: [{ translateY: y1 }],
      }} />
      <Animated.View style={{
        position: 'absolute', bottom: '12%', right: '-25%',
        width: width * 0.75, height: width * 0.75, borderRadius: width * 0.375,
        backgroundColor: '#8B3A00', opacity: op2, transform: [{ translateY: y2 }],
      }} />
    </View>
  );
};

// ── Expanding pulse ring — centred on the element it surrounds ────────────
const PulseRing = ({ size, color = '#D4AF37', delay = 0 }) => {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, { toValue: 1, duration: 1800, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(anim, { toValue: 0, duration: 0,    useNativeDriver: NATIVE_DRIVER }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  const sc = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] });
  const op = anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.55, 0.20, 0] });
  return (
    <Animated.View pointerEvents="none" style={{
      position: 'absolute',
      width: size, height: size, borderRadius: size / 2,
      borderWidth: 1.5, borderColor: color,
      opacity: op, transform: [{ scale: sc }],
    }} />
  );
};

// ── App ────────────────────────────────────────────────────────────────────
// ── Animated press button — pops OUT on touch (3D lift feel) ─────────────
const AnimatedPress = ({ onPress, style, children, disabled, glowRadius = 16 }) => {
  const scale  = useRef(new Animated.Value(1)).current;
  const transY = useRef(new Animated.Value(0)).current;
  const glow   = useRef(new Animated.Value(0)).current;   // 0 → 1 light-up

  const pressIn = () => Animated.parallel([
    Animated.spring(scale,  { toValue: 1.05, speed: 200, bounciness: 0, useNativeDriver: NATIVE_DRIVER }),
    Animated.spring(transY, { toValue: -5,   speed: 200, bounciness: 0, useNativeDriver: NATIVE_DRIVER }),
    Animated.timing(glow,   { toValue: 1, duration: 90, useNativeDriver: NATIVE_DRIVER }),
  ]).start();

  const pressOut = () => Animated.parallel([
    Animated.spring(scale,  { toValue: 1.0, speed: 18, bounciness: 16, useNativeDriver: NATIVE_DRIVER }),
    Animated.spring(transY, { toValue: 0,   speed: 18, bounciness: 16, useNativeDriver: NATIVE_DRIVER }),
    Animated.timing(glow,   { toValue: 0, duration: 280, useNativeDriver: NATIVE_DRIVER }),
  ]).start();

  return (
    <TouchableOpacity onPress={onPress} onPressIn={pressIn} onPressOut={pressOut} activeOpacity={1} disabled={disabled}>
      <Animated.View style={[style, { transform: [{ scale }, { translateY: transY }] }]}>
        {children}
        {/* light-up sheen — brightens the button on press */}
        <Animated.View pointerEvents="none" style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: glowRadius,
          backgroundColor: '#FFF1C4',
          opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.30] }),
        }} />
      </Animated.View>
    </TouchableOpacity>
  );
};

// ── MoneyAmount — logo symbol + formatted number side by side ────────────
// Use this anywhere you want the real M+handshake mark instead of Ɱ.
// Inside <Text> nodes you must still use the Ɱ character (React Native
// cannot embed a View/SVG inside a Text).
const MoneyAmount = ({ value, size = 14, color = '#7DB87A', textStyle }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
    <MoneySymbol size={size} color={color} style={{ marginRight: 4 }} />
    <Text style={textStyle}>
      {Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </Text>
  </View>
);

// ── PIN Box Row — 6 individual digit boxes backed by a hidden TextInput ────
// Tapping anywhere on the row focuses the invisible input.
// Masking with ● so the PIN is never visible on screen.
const PinBoxRow = ({ value, onChange, inputRef }) => (
  <TouchableOpacity activeOpacity={1} onPress={() => inputRef?.current?.focus()} style={{ alignItems: 'center' }}>
    <View style={{ flexDirection: 'row', gap: 10, marginVertical: 8 }}>
      {Array.from({ length: 6 }, (_, i) => (
        <View key={i} style={[
          pinBoxStyle.box,
          value.length === i && pinBoxStyle.boxActive,
          value.length > i  && pinBoxStyle.boxFilled,
        ]}>
          <Text style={pinBoxStyle.dot}>{value[i] ? '●' : ''}</Text>
        </View>
      ))}
    </View>
    <TextInput
      ref={inputRef}
      style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
      keyboardType="number-pad"
      maxLength={6}
      value={value}
      onChangeText={onChange}
      caretHidden
    />
  </TouchableOpacity>
);
const pinBoxStyle = StyleSheet.create({
  box:      { width: 44, height: 54, borderRadius: 10, backgroundColor: 'rgba(30,14,4,0.9)', borderWidth: 1.5, borderColor: '#3A2010', alignItems: 'center', justifyContent: 'center' },
  boxActive:{ borderColor: '#D4AF37', shadowColor: '#D4AF37', shadowOpacity: 0.6, shadowRadius: 8, elevation: 6 },
  boxFilled:{ borderColor: 'rgba(212,175,55,0.6)' },
  dot:      { fontSize: 22, color: '#D4AF37', lineHeight: 26 },
});

function AppInner() {
  const [address,   setAddress]   = useState('');
  const [balance,   setBalance]   = useState(0);
  const [userCount, setUserCount] = useState(0);
  const [txs,       setTxs]       = useState([]);
  const [claimed,   setClaimed]   = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount,    setAmount]    = useState('');

  // Network toggle — mainnet ⇄ testnet, no rebuild required (config.js).
  const [network, setNetworkState] = useState(getNetwork());

  // Wallet backup / restore (key recovery)
  const [seedInput,      setSeedInput]      = useState('');   // recovery key typed on Restore screen
  const [restorePreview, setRestorePreview] = useState(null); // { address, publicKey, secretKey } once a valid key is checked

  // ── Onboarding / screen state ─────────────────────────────────────────
  // null=loading | 12=oath | 3=leftThumb | 32=rightThumb
  // 35=PIN | 4=sealComplete (invite code + ignite) | 5=formation | 6=ignition
  // 99=reAuth | 0=mainApp
  const [onboardingStep,  setOnboardingStep]  = useState(null);
  const [showAboutScreen, setShowAboutScreen] = useState(false);
  // ── Intro video ───────────────────────────────────────────────────────
  const [showIntroVideo,  setShowIntroVideo]  = useState(true);   // plays on first launch only
  const [introFirstTime,  setIntroFirstTime]  = useState(true);  // false if seen before
  const [showSkipBtn,     setShowSkipBtn]     = useState(true);  // always visible
  const [bioKeyActive,   setBioKeyActive]   = useState(false);
  const [hasFingerprint, setHasFingerprint] = useState(false); // true only if fingerprint sensor AND enrolled
  // 'fingerprint' | 'face' | 'credential' — what actually unlocks this device right now
  const [authMethod,     setAuthMethod]     = useState('credential');

  // Terms checkboxes (step 1)
  const [termChecks, setTermChecks] = useState([false, false, false]);

  // Face scan
  const [faceStepIdx,      setFaceStepIdx]      = useState(0);
  const [faceCountdown,    setFaceCountdown]    = useState(3);
  const [photoRejectedMsg, setPhotoRejectedMsg] = useState(null);
  // Incrementing faceRetry / reAuthRetry forces the countdown useEffect to
  // restart the interval after a rejection — without this the timer is dead
  // because the interval clears itself before calling the capture function.
  const [faceRetry,        setFaceRetry]        = useState(0);
  const [reAuthRetry,      setReAuthRetry]      = useState(0);

  // (Formation/suns state removed.)

  // Liveness check (step 25)
  const [livenessNums,           setLivenessNums]           = useState([]);
  const [livenessIdx,            setLivenessIdx]            = useState(0);
  const [livenessStatus,         setLivenessStatus]         = useState('listening'); // 'listening' | 'correct'
  const [livenessTranscript,     setLivenessTranscript]     = useState('');          // live mic feedback
  const [livenessVoiceFails,     setLivenessVoiceFails]     = useState(0);           // misses before fallback
  const [livenessShowTapFallback,setLivenessShowTapFallback]= useState(false);       // show tap-number button

  // Re-auth (step 99)
  const [reAuthPhase,  setReAuthPhase]  = useState('biometric');
  const [reAuthError,  setReAuthError]  = useState(null);

  // 2FA — TOTP authenticator (Google Authenticator / Microsoft Authenticator / Authy)
  const [googleUser,    setGoogleUser]    = useState(null);  // { sub, email, name }
  const [totpSecret,    setTotpSecret]    = useState('');    // temp during step 36 setup
  const [totpSetupCode, setTotpSetupCode] = useState('');    // verification code during setup
  const [totpEntryCode, setTotpEntryCode] = useState('');    // code during re-auth
  const [totpSetupError,setTotpSetupError]= useState('');
  const [totpEntryError,setTotpEntryError]= useState('');
  // Legacy PIN state kept to avoid breaking any remaining refs (unused after TOTP migration)
  const [pin2FA,       setPin2FA]       = useState('');
  const [pin2FAError,  setPin2FAError]  = useState('');
  const [pinSetup1,    setPinSetup1]    = useState('');
  const [pinSetup2,    setPinSetup2]    = useState('');
  const [pinSetupStep, setPinSetupStep] = useState(1);
  const [pinSetupError,setPinSetupError]= useState('');

  // Transaction face modal
  const [txModalVisible,   setTxModalVisible]   = useState(false);
  const [txModalPhase,     setTxModalPhase]     = useState('camera'); // 'camera' | 'voice' | 'biometric'
  const [txModalCountdown, setTxModalCountdown] = useState(RE_AUTH_COUNTDOWN);
  const [txModalLabel,     setTxModalLabel]     = useState('');
  const [txVoiceNum,       setTxVoiceNum]       = useState(1); // random number for voice challenge
  const txModalResolve = useRef(null);
  const txModalTimer   = useRef(null);

  // Recipient verification modal (QR → face → voice)
  const [recipientScanVisible,   setRecipientScanVisible]   = useState(false);
  const [recipientScanPhase,     setRecipientScanPhase]     = useState('qr'); // 'qr'|'face'|'voice'
  const [recipientScanAddress,   setRecipientScanAddress]   = useState('');
  const [recipientScanVoiceNum,  setRecipientScanVoiceNum]  = useState(1);
  const [recipientFaceCountdown, setRecipientFaceCountdown] = useState(3);
  const [recipientQrScanned,     setRecipientQrScanned]     = useState(false);
  const [showMyQR,               setShowMyQR]               = useState(false);
  const recipientFaceTimer = useRef(null);
  const recipientCamRef    = useRef(null);

  // Animations
  const starScale    = useRef(new Animated.Value(1)).current;
  const starOpacity  = useRef(new Animated.Value(0.7)).current;
  const igScale      = useRef(new Animated.Value(0.3)).current;
  const igOpacity    = useRef(new Animated.Value(0)).current;
  const logoScale    = useRef(new Animated.Value(1)).current;
  const balScale     = useRef(new Animated.Value(1)).current;
  // Forge scene
  const hammerY      = useRef(new Animated.Value(0)).current;
  const hammerX      = useRef(new Animated.Value(0)).current;
  const hammerRot    = useRef(new Animated.Value(0)).current;
  const sparkOp      = useRef(new Animated.Value(0)).current;
  const forgeLogoScl = useRef(new Animated.Value(1.0)).current;
  const soundRef     = useRef(null);
  // Premium ambient animations
  const shimmerAnim  = useRef(new Animated.Value(0)).current;  // sweeps across cards/bars
  const breathAnim   = useRef(new Animated.Value(0)).current;  // ambient logo/seal breathing

  const [hammerHits, setHammerHits] = useState(0);

  // Camera
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  // Refs
  const addrRef              = useRef('');
  const pubKeyRef            = useRef('');
  const secKeyRef            = useRef('');
  const bgStartRef           = useRef(null);
  const bgTimer              = useRef(null);
  const appStateRef          = useRef(AppState.currentState);
  const reAuthTimer          = useRef(null);
  const faceAutoTimer        = useRef(null);
  const isIgnitedRef         = useRef(false);
  const destinationAfterAuth = useRef(0);
  const nextAfterLiveness    = useRef(3);
  const pinSetupReturnTo     = useRef(null);   // where to go after a PIN reset (null = first-time onboarding)
  // Stable refs for the hidden PIN TextInputs — must live at component scope, not
  // be recreated inside render blocks (a fresh {current:null} each render breaks focus).
  const pinEntryRef          = useRef(null);   // step 99 re-auth PIN entry
  const pinSetupRef1         = useRef(null);   // step 36 create PIN
  const pinSetupRef2         = useRef(null);   // step 36 confirm PIN
  const livenessActive       = useRef(false);
  const livenessExpectedRef  = useRef(null);  // current number to say — readable in speech callbacks
  const voiceTimeoutRef      = useRef(null);  // fires after 15s to show tap fallback

  // ── Intro video ───────────────────────────────────────────────────────
  const introVideoRef = useRef(null);

  // End intro — called on playback finish or skip tap
  const handleIntroEnd = async () => {
    try { await introVideoRef.current?.pauseAsync(); } catch {}
    const firstTime = introFirstTime;
    await AsyncStorage.setItem('intro_seen_v1', '1').catch(() => {});
    setShowIntroVideo(false);
    setShowSkipBtn(false);
    // First ever launch → show About screen right after
    if (firstTime) {
      const aboutSeen = await AsyncStorage.getItem('about_seen_v1').catch(() => null);
      if (!aboutSeen) setShowAboutScreen(true);
    }
  };

  // Determine first-time and schedule skip button
  useEffect(() => {
    (async () => {
      const seen = await AsyncStorage.getItem('intro_seen_v1').catch(() => null);
      if (seen) {
        setIntroFirstTime(false);
      }
    })();
    // Set audio mode so video plays even on silent switch (iOS)
    Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: false }).catch(() => {});
  }, []);

  // ── Generate TOTP secret when step 36 is entered ─────────────────────
  useEffect(() => {
    if (onboardingStep !== 36) return;
    const secret = authenticator.generateSecret();
    setTotpSecret(secret);
    setTotpSetupCode('');
    setTotpSetupError('');
  }, [onboardingStep]);

  // ── Launch: check state chain ─────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        // Detect what actually unlocks this device — hardware presence alone isn't enough;
        // the sensor must also have credentials enrolled, otherwise it silently fails.
        const types    = await LocalAuthentication.supportedAuthenticationTypesAsync().catch(() => []);
        const enrolled = await LocalAuthentication.isEnrolledAsync().catch(() => false);

        const hasFingerprintHw = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
        const hasFaceHw        = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);

        const fingerprintReady = hasFingerprintHw && enrolled;
        const faceReady        = hasFaceHw && enrolled && !fingerprintReady;

        setHasFingerprint(fingerprintReady);
        setAuthMethod(fingerprintReady ? 'fingerprint' : faceReady ? 'face' : 'credential');

        // ── Security migration: move critical flags from AsyncStorage (plaintext) → SecureStore (hardware-backed) ──
        // AsyncStorage is readable by any privileged process on a rooted device.
        // SecureStore is backed by Android Keystore / iOS Secure Enclave — cannot be extracted.
        let biokey = await SecureStore.getItemAsync('biokey_v1').catch(() => null);
        if (!biokey) {
          const legacy = await AsyncStorage.getItem('biokey_v1').catch(() => null);
          if (legacy) {
            await SecureStore.setItemAsync('biokey_v1', legacy).catch(() => {});
            await AsyncStorage.removeItem('biokey_v1').catch(() => {});
            biokey = legacy;
          }
        }

        let ignited = await SecureStore.getItemAsync('formation_ignited').catch(() => null);
        if (!ignited) {
          const legacy = await AsyncStorage.getItem('formation_ignited').catch(() => null);
          if (legacy) {
            await SecureStore.setItemAsync('formation_ignited', legacy).catch(() => {});
            await AsyncStorage.removeItem('formation_ignited').catch(() => {});
            ignited = legacy;
          }
        }

        // About screen shown after intro video on first launch (handled in handleIntroEnd)

        if (biokey === '1') {
          isIgnitedRef.current = ignited === '1';
          // Not-yet-ignited returning user → the clean invite-code + IGNITE screen
          // (step 4), NOT the old suns/KYC formation screen (step 5).
          destinationAfterAuth.current = ignited === '1' ? 0 : 4;
          setReAuthPhase('biometric');
          setReAuthError(null);
          setOnboardingStep(99);
        } else {
          // Identity is the on-device keypair (already generated above). No
          // third-party login — a new user goes straight to the Oath, then the
          // body seal, then the invite-code + faucet ignition.
          setOnboardingStep(12);
        }
      } catch {
        // Any unexpected failure → go to welcome screen so the app always starts
        setOnboardingStep(10);
      }
    })();
  }, []);

  // ── Load / create wallet ──────────────────────────────────────────────
  // SecureStore = Android Keystore-backed encrypted storage.
  // Key never lives in a plain SQLite file — Gap 2 closed.
  useEffect(() => {
    (async () => {
      try {
        // 1. Try SecureStore (new, secure path)
        let raw = await SecureStore.getItemAsync('keypair_v3');

        // 2. One-time migration: if old AsyncStorage key exists, move it over
        if (!raw) {
          const legacy = await AsyncStorage.getItem('keypair_v2');
          if (legacy) {
            await SecureStore.setItemAsync('keypair_v3', legacy);
            await AsyncStorage.removeItem('keypair_v2'); // wipe plaintext copy
            raw = legacy;
          }
        }

        // 3. First-ever install: generate and store
        let kp = raw ? JSON.parse(raw) : createKeypair();
        if (!raw) await SecureStore.setItemAsync('keypair_v3', JSON.stringify(kp));

        setAddress(kp.address);
        addrRef.current   = kp.address;
        pubKeyRef.current = kp.publicKey;
        secKeyRef.current = kp.secretKey;
      } catch {
        // Fallback: keep in memory only (lost on restart, but won't crash)
        const kp = createKeypair();
        setAddress(kp.address);
        addrRef.current   = kp.address;
        pubKeyRef.current = kp.publicKey;
        secKeyRef.current = kp.secretKey;
      }
    })();
  }, []);

  // ── Sync ledger ───────────────────────────────────────────────────────
  const sync = async () => {
    const addr = addrRef.current;
    if (!addr) return;
    if (IS_WEB) return; // backend not reachable in web preview — skip silently
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000); // 8s timeout
      const [lr, ur] = await Promise.all([
        fetch(`${BACKEND_URL}/ledger`,    { signal: ctrl.signal }),
        fetch(`${BACKEND_URL}/usercount`, { signal: ctrl.signal }),
      ]);
      clearTimeout(timer);
      const ledger    = await lr.json();
      const { count } = await ur.json();
      setTxs(ledger);
      setUserCount(count);
      setClaimed(ledger.some(t => t.from === 'FAUCET' && t.to === addr));
      const bal = ledger.reduce((b, t) =>
        t.to === addr ? b + t.amount : t.from === addr ? b - t.amount : b, 0);
      setBalance(Math.max(0, parseFloat(bal.toFixed(2))));
    } catch {}
  };

  // ── Network toggle — mainnet ⇄ testnet ──────────────────────────────────
  // Restore a persisted choice at startup (independent of the address-load
  // effect above — order doesn't matter: whichever finishes second re-syncs
  // against the correct URL, so this is correct regardless of interleaving).
  useEffect(() => {
    (async () => {
      await loadNetwork(AsyncStorage);
      setNetworkState(getNetwork());
      if (addrRef.current) sync();
    })();
  }, []);

  // Switch networks: persist the choice, flip BACKEND_URL immediately (every
  // existing fetch call site reads it live), then reload data from the new URL.
  const toggleNetwork = async () => {
    const next = network === 'mainnet' ? 'testnet' : 'mainnet';
    await setNetwork(next, AsyncStorage);
    setNetworkState(next);
    await sync();
  };

  useEffect(() => {
    if (!address) return;
    if (IS_WEB) return; // no polling on web preview
    sync();
    const iv = setInterval(sync, 60_000);   // clay tablets update every minute
    return () => clearInterval(iv);
  }, [address]);

  // ── AppState: penalty + re-lock ───────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      const prev = appStateRef.current;
      if (prev === 'active' && next === 'background') {
        bgStartRef.current = Date.now();
        bgTimer.current = setTimeout(applyPenalty, DISCONNECT_GRACE_MS);
      }
      if (next === 'active') {
        clearTimeout(bgTimer.current);
        const away = bgStartRef.current ? Date.now() - bgStartRef.current : 0;
        bgStartRef.current = null;
        // Only re-lock after a real absence (5 min). Quick app-switches — copying
        // an address, taking a call, checking a message — no longer force a full
        // fingerprint + PIN dance every time the app comes back to the foreground.
        if (away > REAUTH_AWAY_MS && bioKeyActive) {
          clearReAuthTimer();
          // Not-yet-ignited user → clean invite + IGNITE screen (4), not suns/KYC (5).
          destinationAfterAuth.current = isIgnitedRef.current ? 0 : 4;
          setReAuthPhase('biometric');
          setReAuthError(null);
          setOnboardingStep(99);
        }
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, [bioKeyActive]);

  const applyPenalty = async () => {
    try {
      // Don't punish someone whose wallet isn't fully live yet: if the signing key
      // hasn't loaded, or the user never ignited, a "penalty" would either be an
      // invalid (unsignable) transaction or an unfair charge. Skip in those cases.
      if (!secKeyRef.current || !isIgnitedRef.current) return;
      const from = addrRef.current;
      const amt  = BASE_PENALTY * 2;
      const ts   = Date.now();
      const sig  = signTx(from, RESERVE_ADDRESS, amt, ts, secKeyRef.current);
      await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: RESERVE_ADDRESS, amount: amt,
          reason: 'disconnect_penalty', signature: sig,
          publicKey: pubKeyRef.current, timestamp: ts,
        }),
      });
    } catch {}
  };

  // (4D web-only debug inspector removed — it referenced deleted formation state.)

  // ── Star pulse animation (ignition screen) ───────────────────────────
  useEffect(() => {
    if (onboardingStep === 6) {
      const loop = Animated.loop(
        Animated.parallel([
          Animated.sequence([
            Animated.timing(starScale,   { toValue: 1.18, duration: 1600, useNativeDriver: NATIVE_DRIVER }),
            Animated.timing(starScale,   { toValue: 1.0,  duration: 1600, useNativeDriver: NATIVE_DRIVER }),
          ]),
          Animated.sequence([
            Animated.timing(starOpacity, { toValue: 1.0, duration: 1600, useNativeDriver: NATIVE_DRIVER }),
            Animated.timing(starOpacity, { toValue: 0.5, duration: 1600, useNativeDriver: NATIVE_DRIVER }),
          ]),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [onboardingStep]);

  // ── Ignition entrance animation ───────────────────────────────────────
  useEffect(() => {
    if (onboardingStep === 6) {
      Animated.sequence([
        Animated.timing(igOpacity, { toValue: 1, duration: 600, useNativeDriver: NATIVE_DRIVER }),
        Animated.spring(igScale,   { toValue: 1, friction: 4, tension: 40, useNativeDriver: NATIVE_DRIVER }),
      ]).start();

    }
  }, [onboardingStep]);

  // ── Logo gentle pulse on main screen ─────────────────────────────────
  useEffect(() => {
    if (onboardingStep !== 0) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(logoScale, { toValue: 1.06, duration: 2200, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(logoScale, { toValue: 1.0,  duration: 2200, useNativeDriver: NATIVE_DRIVER }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [onboardingStep]);

  // ── Balance flash when amount changes ────────────────────────────────
  useEffect(() => {
    Animated.sequence([
      Animated.timing(balScale, { toValue: 1.1,  duration: 180, useNativeDriver: NATIVE_DRIVER }),
      Animated.spring(balScale, { toValue: 1.0, friction: 3, tension: 40, useNativeDriver: NATIVE_DRIVER }),
    ]).start();
  }, [balance]);

  // ── Ambient shimmer sweep — loops forever, drives glass-card highlight ──
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(shimmerAnim, { toValue: 1, duration: 3200, useNativeDriver: NATIVE_DRIVER })
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // ── Breathing aura — drives PulseRing offset on key icons ───────────────
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breathAnim, { toValue: 1, duration: 2400, useNativeDriver: NATIVE_DRIVER }),
      Animated.timing(breathAnim, { toValue: 0, duration: 2400, useNativeDriver: NATIVE_DRIVER }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  // ── Load anvil strike sound once on mount ────────────────────────────
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync(
          require('./assets/anvil.wav'),
          { shouldPlay: false, volume: 0.55 }
        );
        if (mounted) soundRef.current = sound;
      } catch {
        // File not found or device error — animation still works, just no sound
      }
    })();
    return () => {
      mounted = false;
      soundRef.current?.unloadAsync();
    };
  }, []);

  // ── Core hammer strike: animation + sound at given volume ───────────────
  const strikeHammer = async (vol = 0.55) => {
    if (soundRef.current) {
      try {
        await soundRef.current.setVolumeAsync(vol);
        await soundRef.current.replayAsync();
      } catch {}
    }
    Animated.parallel([
      // Arc DOWN — head sweeps from upper-right to anvil
      Animated.sequence([
        Animated.timing(hammerY,      { toValue: 107, duration: 160, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(hammerY,      { toValue: 0,   duration: 300, useNativeDriver: NATIVE_DRIVER }),
      ]),
      // Tiny X nudge — head stays centred over anvil
      Animated.sequence([
        Animated.timing(hammerX,      { toValue: 5,   duration: 160, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(hammerX,      { toValue: 0,   duration: 300, useNativeDriver: NATIVE_DRIVER }),
      ]),
      // CW swing (overhead arc feel)
      Animated.sequence([
        Animated.timing(hammerRot,    { toValue: 1,   duration: 160, useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(hammerRot,    { toValue: 0,   duration: 300, useNativeDriver: NATIVE_DRIVER }),
      ]),
      Animated.sequence([
        Animated.timing(sparkOp,      { toValue: 1,   duration: 60,  useNativeDriver: NATIVE_DRIVER }),
        Animated.timing(sparkOp,      { toValue: 0,   duration: 560, useNativeDriver: NATIVE_DRIVER }),
      ]),
      Animated.sequence([
        Animated.spring(forgeLogoScl, { toValue: 1.12, speed: 60, bounciness: 2, useNativeDriver: NATIVE_DRIVER }),
        Animated.spring(forgeLogoScl, { toValue: 1.0,  speed: 20, bounciness: 8, useNativeDriver: NATIVE_DRIVER }),
      ]),
    ]).start();
  };

  // ── Auto-hammer loop: fires every 2.2s while on formation screen ─────────
  useEffect(() => {
    if (onboardingStep !== 5) return;
    // First strike immediately on screen mount, then loop
    strikeHammer(0.55);
    const interval = setInterval(() => strikeHammer(0.55), 2200);
    return () => clearInterval(interval);
  }, [onboardingStep]);

  // ── Manual hammer strike (check-in / identity card fill) ─────────────────
  // Volume starts at 0.55 and drops 0.12 per manual hit → stays audible.
  useEffect(() => {
    if (hammerHits === 0) return;
    const vol = Math.max(0.25, 0.55 - (hammerHits - 1) * 0.06);
    strikeHammer(vol);
  }, [hammerHits]);

  // ── Re-auth countdown ─────────────────────────────────────────────────
  const clearReAuthTimer = () => {
    if (reAuthTimer.current) { clearInterval(reAuthTimer.current); reAuthTimer.current = null; }
  };

  useEffect(() => {
    if (onboardingStep === 99) {
      // Auto-fire immediately on entry — TRY AGAIN button handles retries
      runBiometricReAuth();
    }
    return () => clearReAuthTimer();
  }, [onboardingStep]); // intentionally only onboardingStep — retry uses TRY AGAIN button

  const runBiometricReAuth = async () => {
    // On web biometrics don't exist — pass through automatically
    if (IS_WEB) {
      setReAuthPhase('done');
      const dest = destinationAfterAuth.current ?? 0;
      setOnboardingStep(dest);
      return;
    }
    setReAuthError(null);
    try {
      // Check if any credential is available at all
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!enrolled) {
        setReAuthError('No fingerprint or PIN set up on this device. Please set one in your device settings.');
        setReAuthPhase('biometric');
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm your seal to enter the Swarm',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
        fallbackLabel: 'Use PIN',
      });

      if (result.success) {
        // Biometric passed — check if TOTP 2FA is set up
        const totpExists = await hasTotpSetup();
        if (totpExists) {
          setTotpEntryCode('');
          setTotpEntryError('');
          setReAuthPhase('pin'); // 'pin' phase now renders TOTP entry
        } else {
          // No PIN set up yet (old install or PIN cleared) — proceed directly
          setReAuthPhase('done');
          const dest = destinationAfterAuth.current;
          setOnboardingStep(dest);
        }
      } else if (result.error === 'lockout' || result.error === 'lockoutPermanent') {
        // Too many failed biometric attempts — device requires credential to reset
        setReAuthError('Too many failed attempts. Lock your screen and unlock it with your PIN first, then tap TRY AGAIN.');
        setReAuthPhase('biometric');
      } else if (result.error === 'userCancel' || result.error === 'systemCancel') {
        // User dismissed — just show TRY AGAIN with no error
        setReAuthPhase('biometric');
      } else {
        setReAuthError(result.error ? `Auth failed: ${result.error}` : null);
        setReAuthPhase('biometric');
      }
    } catch (e) {
      setReAuthError('Could not open authentication. Please try again.');
      setReAuthPhase('biometric');
    }
  };

  // (Formation data load + daily check-in removed with the suns mechanic.)

  // ── 2FA — MONEY PIN ──────────────────────────────────────────────────
  // The PIN is never stored raw — only its SHA-256 hash survives in SecureStore.
  // ── TOTP helpers ─────────────────────────────────────────────────────
  const saveTotpSecret = async (secret) => {
    await SecureStore.setItemAsync('totp_secret_v1', secret).catch(() => {});
  };

  const hasTotpSetup = async () => {
    const s = await SecureStore.getItemAsync('totp_secret_v1').catch(() => null);
    return !!s;
  };

  // Called from step 36 when user scans QR and enters the first 6-digit code
  const confirmTotpSetup = async () => {
    if (totpSetupCode.length < 6) { setTotpSetupError('Enter the 6-digit code from your authenticator app'); return; }
    let valid = false;
    try { valid = authenticator.check(totpSetupCode, totpSecret); } catch {}
    if (!valid) { setTotpSetupError('Wrong code — check your authenticator app and try again'); setTotpSetupCode(''); return; }
    await saveTotpSecret(totpSecret);
    setTotpSetupCode(''); setTotpSetupError('');
    const returnTo = pinSetupReturnTo.current;
    if (returnTo !== null) {
      pinSetupReturnTo.current = null;
      Alert.alert('Authenticator linked 🔐', 'Your 2FA has been updated successfully.');
      setOnboardingStep(returnTo);
    } else {
      setOnboardingStep(4); // → Seal complete (first-time onboarding)
    }
  };

  // ── TOTP recovery — lost access to authenticator app ─────────────────
  // Re-confirms biometric first, then wipes old secret and re-runs step 36.
  const startTotpReset = async () => {
    if (!IS_WEB) {
      try {
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        if (!enrolled) { setTotpEntryError('Set up a fingerprint or device PIN first, then reset.'); return; }
        const r = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Confirm it\'s you to re-link your authenticator',
          cancelLabel: 'Cancel', disableDeviceFallback: false, fallbackLabel: 'Use PIN',
        });
        if (!r.success) return;
      } catch { return; }
    }
    await SecureStore.deleteItemAsync('totp_secret_v1').catch(() => {});
    setTotpEntryCode(''); setTotpEntryError('');
    pinSetupReturnTo.current = destinationAfterAuth.current ?? 0;
    setOnboardingStep(36);
  };

  // Called from step 99 when user submits their TOTP code
  const submitTotp2FA = async () => {
    if (totpEntryCode.length < 6) { setTotpEntryError('Enter the 6-digit code'); return; }
    const secret = await SecureStore.getItemAsync('totp_secret_v1').catch(() => null);
    if (!secret) { startTotpReset(); return; }
    let valid = false;
    try { valid = authenticator.check(totpEntryCode, secret); } catch {}
    if (valid) {
      setTotpEntryCode(''); setTotpEntryError('');
      setReAuthPhase('done');
      const dest = destinationAfterAuth.current;
      setOnboardingStep(dest);
    } else {
      setTotpEntryCode('');
      setTotpEntryError('Wrong code — check your authenticator app and try again');
    }
  };

  // Legacy stubs — kept so any remaining call-sites don't crash
  const submitPin2FA = submitTotp2FA;
  const hasPinSetup  = hasTotpSetup;

  // (Mission + identity-field helpers and melt-score derivation removed with the suns mechanic.)

  // ── Photo quality gate ────────────────────────────────────────────────
  // Returns a rejection message string, or null if the photo passes.
  // Brightness proxy: JPEG compresses near-black frames very tightly,
  // so (base64.length / pixel_count) drops extremely low in total darkness.
  // Threshold calibrated for quality:0.15 captures — at that compression level
  // a well-lit indoor face sits around 0.04–0.10; a pitch-black frame sits ~0.008.
  // We only reject frames that are essentially blank/dark (< 0.012).
  // Resolution: front cameras should produce at least 400×400.
  const checkPhotoQuality = (photo) => {
    if (!photo) return null; // no photo object → skip check
    const { width: pw, height: ph, base64 } = photo;
    if (pw && ph && (pw < 400 || ph < 400)) {
      return '⚠️ Resolution too low — move closer or clean your lens';
    }
    if (base64 && pw && ph) {
      const ratio = base64.length / (pw * ph);
      if (ratio < 0.012) {
        return '⚠️ Too dark — find better lighting and try again';
      }
    }
    return null; // passed
  };

  const [ignitionCode, setIgnitionCode] = useState('');
  const triggerIgnition = async () => {
    const reward = calcReward(userCount);
    const ts  = Date.now();
    const sig = signTx('FAUCET', addrRef.current, reward, ts, secKeyRef.current);

    // Stable per-install device id — a defence-in-depth Sybil signal so one
    // phone can't seal many wallets through the official app.
    let deviceId = await SecureStore.getItemAsync('device_id_v1').catch(() => null);
    if (!deviceId) {
      deviceId = [...ExpoCrypto.getRandomBytes(16)].map(b => b.toString(16).padStart(2, '0')).join('');
      await SecureStore.setItemAsync('device_id_v1', deviceId).catch(() => {});
    }

    // Sybil firewall stays server-side. The signed public key below is the real,
    // stable per-identity signal the server keys off — image hashes were dropped
    // because hashing a raw photo can never match two captures of the same face,
    // so it gave the illusion of face-dedup without the substance.

    // Ignite locally — only called on success or genuine network failure.
    // An explicit server rejection (duplicate seal, fraud flag, etc.) does NOT ignite.
    const igniteLocally = async () => {
      await SecureStore.setItemAsync('formation_ignited', '1').catch(() => {});
      isIgnitedRef.current = true;
      destinationAfterAuth.current = 0;
      setClaimed(true);
      setOnboardingStep(6);
    };

    try {
      // 10-second timeout so the app never hangs on a slow connection
      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), 10_000);

      const res  = await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          from: 'FAUCET', to: addrRef.current, amount: reward,
          signature: sig, publicKey: pubKeyRef.current, timestamp: ts,
          // Invite (ignition) code — the server's one-per-human faucet gate.
          ignitionCode: ignitionCode ? ignitionCode.trim().toUpperCase() : undefined,
          deviceId,
        }),
      });
      clearTimeout(timeoutId);

      const data = await res.json();
      if (data.success) {
        // Server accepted — ignite
        await igniteLocally();
      } else {
        // Server explicitly rejected (duplicate seal, fraud flag, etc.) — do NOT ignite locally.
        // This is the Sybil firewall: a second device for the same person gets stopped here.
        Alert.alert(
          '⛔ Ignition Rejected',
          data.error || 'The Swarm rejected this seal. Each human may only ignite once.',
        );
      }
    } catch (e) {
      // Network unreachable or timeout (AbortError) — ignite locally, reconcile on next sync.
      // We cannot penalise the user for a bad connection.
      await igniteLocally();
    }
  };

  // ── Face auto-capture countdown (onboarding) ──────────────────────────
  // requiresTap steps skip the interval entirely — capture fires on button tap.
  // Non-tap steps auto-capture after 3s.
  useEffect(() => {
    if (onboardingStep !== 2) {
      if (faceAutoTimer.current) clearInterval(faceAutoTimer.current);
      return;
    }
    const step = FACE_STEPS[faceStepIdx];
    if (step.requiresTap) return; // tap steps: no auto-countdown
    const countdown = faceStepIdx === 0 ? 5 : 3; // first step gets 5s to get in position
    setFaceCountdown(countdown);
    faceAutoTimer.current = setInterval(() => {
      setFaceCountdown(prev => {
        if (prev <= 1) { clearInterval(faceAutoTimer.current); captureFaceStepAuto(); return countdown; }
        return prev - 1;
      });
    }, 1000);
    return () => { if (faceAutoTimer.current) clearInterval(faceAutoTimer.current); };
  }, [onboardingStep, faceStepIdx, faceRetry]);


  const captureFaceStepAuto = async () => {
    // We still capture a frame so the user completes the pose ritual and we can
    // gate on a basic quality check (real lighting / resolution). We deliberately
    // do NOT hash the raw frame: a SHA-256 of an image changes completely with a
    // single pixel/lighting shift, so it can never match two photos of the same
    // face — it provided zero real Sybil protection while adding overhead.
    // True duplicate-person detection belongs server-side on face embeddings.
    try {
      if (cameraRef.current) {
        const photo = await cameraRef.current.takePictureAsync({ quality: 0.15, base64: false });
        const rejection = checkPhotoQuality(photo);
        if (rejection) {
          setPhotoRejectedMsg(rejection);
          setTimeout(() => setPhotoRejectedMsg(null), 2800);
          // Increment faceRetry → triggers the countdown useEffect to restart
          // the interval from scratch. Simply calling setFaceCountdown(3) is
          // not enough because the interval already cleared itself.
          setFaceRetry(r => r + 1);
          return;
        }
        setPhotoRejectedMsg(null);
      }
    } catch {}

    const next = faceStepIdx + 1;
    if (next >= FACE_STEPS.length) {
      // Voice liveness removed — go straight to the body seal (fingerprint/PIN).
      setOnboardingStep(hasFingerprint ? 3 : 35);
    } else {
      setFaceStepIdx(next);
      setFaceCountdown(3);
    }
  };

  // Voice-liveness removed entirely — it was English-only, failed in noise/accents,
  // and the tap fallback meant anyone could bypass it, so it provided no real
  // security while being the clunkiest part of onboarding. The face pose ritual
  // plus the body seal (fingerprint/PIN) remain as the liveness signal.

  // ── Fingerprint onboarding ────────────────────────────────────────────
  const testLeftThumb = async () => {
    if (IS_WEB) { setOnboardingStep(4); return; }
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'First seal — use your fingerprint or device PIN',
      cancelLabel: 'Cancel', disableDeviceFallback: false, fallbackLabel: 'Use PIN',
    });
    // Body seal confirmed → invite-code + ignite screen (2FA step removed).
    if (r.success) { setPinSetup1(''); setPinSetup2(''); setPinSetupStep(1); setPinSetupError(''); setOnboardingStep(4); }
    else Alert.alert('Seal not confirmed', `Couldn't verify (reason: ${r.error || 'unknown'}). Tap "Use PIN" on the prompt to seal with your device PIN instead.`);
  };

  const testRightThumb = async () => {
    if (IS_WEB) { setOnboardingStep(4); return; }
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Second seal — confirm again to lock it in',
      cancelLabel: 'Cancel', disableDeviceFallback: false, fallbackLabel: 'Use PIN',
    });
    if (r.success) { setPinSetup1(''); setPinSetup2(''); setPinSetupStep(1); setPinSetupError(''); setOnboardingStep(4); }
    else Alert.alert('Second seal not confirmed', `Couldn't verify (reason: ${r.error || 'unknown'}). Tap "Use PIN" on the prompt and enter your device PIN, or use any enrolled fingerprint.`);
  };

  const testPin = async () => {
    if (IS_WEB) { setOnboardingStep(4); return; }
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Enter your device PIN to seal your identity',
      cancelLabel: 'Cancel', disableDeviceFallback: false, fallbackLabel: 'Use PIN',
    });
    if (r.success) { setPinSetup1(''); setPinSetup2(''); setPinSetupStep(1); setPinSetupError(''); setOnboardingStep(4); }
    else Alert.alert('Try again', 'PIN confirmation failed.');
  };

  // ── Complete Seal Setup → faucet ignition ─────────────────────────────
  const completeBioKeySetup = async () => {
    // The body seal (fingerprint/PIN) is real the moment biometric is confirmed,
    // so lock it in now. But DO NOT mark the wallet "ignited" here — ignition is
    // only earned when the server accepts the invite code. triggerIgnition sets
    // formation_ignited / isIgnitedRef inside igniteLocally on success (or a
    // genuine network failure), and on an explicit rejection (bad/used code) it
    // leaves the user on this screen to fix the code instead of falsely igniting.
    await SecureStore.setItemAsync('biokey_v1', '1').catch(() => {});
    setBioKeyActive(true);
    await triggerIgnition();
  };

  // ── Transaction face modal ────────────────────────────────────────────
  const clearTxModalTimer = () => {
    if (txModalTimer.current) { clearInterval(txModalTimer.current); txModalTimer.current = null; }
  };

  const runTxBiometric = async () => {
    if (IS_WEB) {
      setTxModalVisible(false);
      if (txModalResolve.current) { txModalResolve.current(true); txModalResolve.current = null; }
      return;
    }
    try {
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: txModalLabel || 'Confirm your seal',
        cancelLabel: 'Cancel', disableDeviceFallback: false, fallbackLabel: 'Use PIN',
      });
      if (r.success) {
        setTxModalVisible(false);
        if (txModalResolve.current) { txModalResolve.current(true); txModalResolve.current = null; }
      }
      // On failure: stay on biometric — TRY AGAIN button is visible
    } catch {
      // Keep buttons visible
    }
  };

  useEffect(() => {
    if (!txModalVisible) clearTxModalTimer();
    return () => clearTxModalTimer();
  }, [txModalVisible, txModalPhase]);

  const authenticateBioKey = (reason) => {
    if (!bioKeyActive) return Promise.resolve(true);
    if (IS_WEB) return Promise.resolve(true); // biometrics unavailable on web
    return new Promise(resolve => {
      txModalResolve.current = resolve;
      setTxModalLabel(reason);
      // Camera/face step removed — the face frame was never verified, it just
      // added a tap. Go straight to the real factor: device biometric / PIN.
      setTxModalPhase('biometric');
      setTxModalVisible(true);
      // Auto-fire the native auth dialog so confirming a trade is one action.
      setTimeout(() => runTxBiometric(), 350);
    });
  };

  const cancelTxModal = () => {
    clearTxModalTimer();
    setTxModalVisible(false);
    if (txModalResolve.current) { txModalResolve.current(false); txModalResolve.current = null; }
  };

  // ── Recipient scan (QR only) ─────────────────────────────────────────
  // The old "scan their face" + "they say a number" steps verified nothing
  // (no photo was taken; the number was self-confirmed) — pure friction.
  // Reading the recipient's QR seal mark is the only step that does real work.
  const openRecipientScan = () => {
    if (!cameraPermission?.granted) {
      requestCameraPermission();
      return;
    }
    setRecipientScanAddress('');
    setRecipientScanPhase('qr');
    setRecipientQrScanned(false);
    setRecipientScanVisible(true);
  };

  const handleRecipientQrScanned = ({ data }) => {
    if (recipientQrScanned) return;
    const addr = (data || '').trim();
    if (!isValidSealMark(addr)) return; // not a valid seal mark
    setRecipientQrScanned(true);
    // QR scanned successfully → fill the recipient field and close.
    setRecipient(addr);
    setRecipientScanVisible(false);
  };

  const cancelRecipientScan = () => {
    setRecipientScanVisible(false);
  };

  // ── Claim & Send ──────────────────────────────────────────────────────
  const claim = async () => {
    if (!address) return Alert.alert('One moment', 'Your seal is still loading…');
    if (claimed) return;
    const auth = await authenticateBioKey('Confirm seal to receive your founding share');
    if (!auth) return Alert.alert('Seal Required', 'Authentication cancelled.');
    const reward = calcReward(userCount);
    const ts  = Date.now();
    const sig = signTx('FAUCET', address, reward, ts, secKeyRef.current);
    try {
      const res  = await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'FAUCET', to: address, amount: reward,
          signature: sig, publicKey: pubKeyRef.current, timestamp: ts,
          // Invite (ignition) code — the server's one-per-human faucet gate.
          ignitionCode: ignitionCode ? ignitionCode.trim().toUpperCase() : undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setClaimed(true);
        Alert.alert('🎉 WELCOME, FOUNDING MEMBER!', `${fmt(reward)} MONEY\nYour entry is inscribed on the tablets.\nWelcome to the Swarm.`);
      }
      else Alert.alert('Claim failed', data.error || 'Unknown error');
    } catch (e) { Alert.alert('The tablets are unreachable', e.message); }
  };

  const send = async () => {
    if (!recipient || !amount) return Alert.alert('Missing fields', 'Enter recipient seal mark and amount');
    const to = recipient.trim();
    // Guard against typos that would burn MONEY forever:
    if (!isValidSealMark(to)) {
      return Alert.alert(
        'Check the seal mark',
        'That does not look like a valid seal mark. A seal mark starts with "M_". Scan the recipient\'s QR code with the camera button to be sure.',
      );
    }
    if (to === address) {
      return Alert.alert('That\'s your own seal', 'You can\'t send MONEY to yourself.');
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return Alert.alert('Invalid', 'Amount must be positive');
    if (amt > balance) return Alert.alert('Insufficient balance');

    // Final confirmation — show exactly who is being paid and how much before
    // anything irreversible happens. Trades cannot be undone once inscribed.
    Alert.alert(
      'Confirm trade',
      `Send ${fmt(amt)} MONEY to:\n\n${to}\n\nThis cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send', style: 'default', onPress: () => doSend(to, amt) },
      ],
    );
  };

  const doSend = async (to, amt) => {
    const auth = await authenticateBioKey(`Confirm trade of ${fmt(amt)} MONEY`);
    if (!auth) return Alert.alert('Seal Required', 'Trade cancelled.');
    try {
      const ts  = Date.now();
      const sig = signTx(address, to, amt, ts, secKeyRef.current);
      const res = await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: address, to, amount: amt, signature: sig, publicKey: pubKeyRef.current, timestamp: ts }),
      });
      const data = await res.json();
      if (data.success) {
        setRecipient(''); setAmount('');
        Alert.alert('✅ Trade inscribed', `${fmt(amt)} MONEY sent`);
      }
      else Alert.alert('Trade failed', data.error);
    } catch (e) { Alert.alert('The tablets are unreachable', e.message); }
  };

  const invite = () => Share.share({
    message: `I just joined the Swarm.\nNo banks. No CEOs. Just people and phones.\n\nMy seal mark: ${address}\n\nMoney. For Everyone. Forever.`,
  }).catch(() => {});

  // ─────────────────────────────────────────────────────────────────────
  // ── SCREENS ───────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────

  // Adaptive auth labels — matches whatever actually unlocks this device
  const authLabel = authMethod === 'fingerprint' ? 'FINGERPRINT'
    : authMethod === 'face'        ? 'FACE ID'
    : 'DEVICE PIN';
  const AuthIcon = ({ size, color }) =>
    authMethod === 'fingerprint' ? <ThumbprintIcon size={size} color={color} />
    : authMethod === 'face'      ? <EyeIcon        size={size} color={color} />
    : <LockIcon                  size={size} color={color} />;

  // ── 4D Holographic Engine (web-only, no-ops on native) ──────────────────
  useHoloBackground();
  useHoloTransition(onboardingStep);

  // Loading
  // ── Intro video splash — plays on every launch, skip after 3s (non-first) ──
  if (showIntroVideo && !IS_WEB) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <ExpoVideo
          ref={introVideoRef}
          source={require('./assets/intro.mp4')}
          style={StyleSheet.absoluteFill}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay={true}
          isLooping={false}
          volume={1.0}
          isMuted={false}
          onPlaybackStatusUpdate={(status) => {
            if (status.didJustFinish) handleIntroEnd();
          }}
        />
        {/* Skip button — appears after 3s on subsequent launches only */}
        {showSkipBtn && (
          <TouchableOpacity
            style={{
              position: 'absolute', bottom: 60, alignSelf: 'center',
              paddingHorizontal: 28, paddingVertical: 10,
              borderWidth: 1, borderColor: 'rgba(212,175,55,0.6)',
              borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.5)',
            }}
            onPress={handleIntroEnd}
          >
            <Text style={{ color: '#D4AF37', fontSize: 14, letterSpacing: 2, fontWeight: '600' }}>
              SKIP  →
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  if (onboardingStep === null) {
    return (
      <SafeAreaView style={[s.root, { backgroundColor: '#0E0700' }]}>
        <View style={s.fullCenter}>
          <Text style={s.loadingText}>Reading the tablets…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── About / Transparency screen ───────────────────────────────────────
  // Shows once on first launch; always accessible via link in main app.
  const closeAboutScreen = async () => {
    await AsyncStorage.setItem('about_seen_v1', '1').catch(() => {});
    setShowAboutScreen(false);
  };

  if (showAboutScreen) {
    const openLink = (url) => { const { Linking } = require('react-native'); Linking.openURL(url); };

    return (
      <ScreenWrapper>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={[s.onboardScroll, { paddingBottom: 40 }]}>

          {/* Header — plain logo, no clock/ticks */}
          <View style={{ alignItems: 'center', paddingTop: 24, paddingBottom: 8 }}>
            <Image source={require('./assets/logo.png')} style={{ width: 62, height: 62, resizeMode: 'contain' }} />
            <Text style={[s.onboardTitle, { marginTop: 10, fontSize: 22 }]}>MONEY</Text>
            <Text style={[s.onboardSub, { color: '#9A7B4A', fontSize: 13 }]}>The Honest Version</Text>
          </View>

          <GoldDivider width={width - 40} opacity={0.5} />

          {/* ── Tile 1: What is this? ── */}
          <WobbleTile delay={0}>
            <View style={[s.onboardCard, glassOnboardCard, { alignItems: 'center', marginTop: 18 }]}>
              <ClayWhatIsThis size={130} />
              <Text style={[s.onboardCardTitle, { marginTop: 12, fontSize: 15 }]}>What is this?</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
                <Text style={[s.onboardBody, { textAlign: 'center', lineHeight: 20 }]}>
                  {'Every verified human gets 1,000,000 '}
                </Text>
                <MoneySymbol size={14} color="#D4AF37" style={{ marginTop: 2 }} />
                <Text style={[s.onboardBody, { textAlign: 'center', lineHeight: 20 }]}>
                  {' MONEY. That\'s it. No mining. No watching ads. You prove you\'re a real person, it\'s yours.'}
                </Text>
              </View>
            </View>
          </WobbleTile>

          {/* ── Tile 2: Who made this? ── */}
          <WobbleTile delay={400}>
            <View style={[s.onboardCard, glassOnboardCard, { alignItems: 'center', marginTop: 18 }]}>
              <ClayWhoMadeThis size={130} />
              <Text style={[s.onboardCardTitle, { marginTop: 12, fontSize: 15 }]}>Who made this?</Text>
              <Text style={[s.onboardBody, { textAlign: 'center', marginTop: 6, lineHeight: 20 }]}>
                {'One person built the first version — Luca Urbani. An average dude wearing a hoodie and joggings. He was tired of the scams, the ads and the lies.'}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
                <Text style={[s.onboardBody, { textAlign: 'center', lineHeight: 20 }]}>{'He got 1,000,000 '}</Text>
                <MoneySymbol size={14} color="#D4AF37" style={{ marginTop: 3 }} />
                <Text style={[s.onboardBody, { textAlign: 'center', lineHeight: 20 }]}>{' — the same as you. No secret stash. No hidden advantage. Being first was the only reward.'}</Text>
              </View>
              <TouchableOpacity style={{ marginTop: 10 }} onPress={() => openLink('https://m.facebook.com/Luca.Urbani007/')}>
                <Text style={{ color: '#D4AF37', fontSize: 13, letterSpacing: 0.5 }}>Meet Luca →</Text>
              </TouchableOpacity>
            </View>
          </WobbleTile>

          {/* ── Tile 3: Is it safe? ── */}
          <WobbleTile delay={800}>
            <View style={[s.onboardCard, glassOnboardCard, { alignItems: 'center', marginTop: 18 }]}>
              <ClayIsItSafe size={130} />
              <Text style={[s.onboardCardTitle, { marginTop: 12, fontSize: 15 }]}>Is it safe?</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
                <Text style={[s.onboardBody, { textAlign: 'center', lineHeight: 20 }]}>{'Right now your '}</Text>
                <MoneySymbol size={14} color="#D4AF37" style={{ marginTop: 3 }} />
                <Text style={[s.onboardBody, { textAlign: 'center', lineHeight: 20 }]}>{' lives on one computer in Germany — the initial node. That\'s the honest truth. The dream is for it to live on your phone, so no single person, company, or government can touch it. You can run the node yourself — the code is open source.'}</Text>
              </View>
              <TouchableOpacity style={{ marginTop: 10 }} onPress={() => openLink('https://github.com/Fokerfeit/Money')}>
                <Text style={{ color: '#D4AF37', fontSize: 13, letterSpacing: 0.5 }}>See the code →</Text>
              </TouchableOpacity>
            </View>
          </WobbleTile>

          {/* ── Tile 4: What if someone builds it better? ── */}
          <WobbleTile delay={1200}>
            <View style={[s.onboardCard, glassOnboardCard, { alignItems: 'center', marginTop: 18 }]}>
              <ClayBuildItBetter size={130} />
              <Text style={[s.onboardCardTitle, { marginTop: 12, fontSize: 15 }]}>What if someone builds it better?</Text>
              <Text style={[s.onboardBody, { textAlign: 'center', marginTop: 6, lineHeight: 20 }]}>
                {'Good. This idea doesn\'t belong to anyone. If someone can make this fairer, safer, or more useful for people — they should. You\'re not joining someone\'s project. You\'re part of something that belongs to everyone.'}
              </Text>
            </View>
          </WobbleTile>

          {/* ── Tile 5: Why should I trust it? ── */}
          <WobbleTile delay={1600}>
            <View style={[s.onboardCard, glassOnboardCard, { alignItems: 'center', marginTop: 18 }]}>
              <ClayWhyTrust size={130} />
              <Text style={[s.onboardCardTitle, { marginTop: 12, fontSize: 15 }]}>Why should I trust it?</Text>
              <Text style={[s.onboardBody, { textAlign: 'center', marginTop: 6, lineHeight: 20 }]}>
                {'You shouldn\'t trust it because someone told you to. Read how it works. Ask questions. If you find something wrong — say so. That\'s how it gets better.'}
              </Text>
            </View>
          </WobbleTile>

          <GoldDivider width={280} opacity={0.3} style={{ marginTop: 24 }} />

          {/* CTA */}
          <TouchableOpacity
            style={[s.btnGold, glassButton, { marginTop: 28, marginHorizontal: 24 }]}
            onPress={closeAboutScreen}
          >
            <Text style={s.btnText}>I UNDERSTAND — LET'S GO →</Text>
          </TouchableOpacity>

          <Text style={{ color: '#5A3D1A', fontSize: 11, textAlign: 'center', marginTop: 14, letterSpacing: 0.3 }}>
            You can always find this page again inside the app.
          </Text>

        </ScrollView>
      </SafeAreaView>
      </ScreenWrapper>
    );
  }

  // ── Step 99: Seal Lock ───────────────────────────────────────────────
  if (onboardingStep === 99) {
    // ── Phase: biometric ─────────────────────────────────────────────
    if (reAuthPhase !== 'pin') {
      return (
        <SafeAreaView style={s.root}>
          <View style={s.fullCenter}>
            <View style={{ alignItems: 'center', marginBottom: 32 }}>
              <PulseRing size={110} color="#D4AF37" delay={0} />
              <PulseRing size={110} color="#D4AF37" delay={900} />
              <View style={{ width: 110, height: 110, borderRadius: 55, backgroundColor: 'rgba(30,14,4,0.9)', borderWidth: 1.5, borderColor: 'rgba(212,175,55,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                <AuthIcon size={52} color="#D4AF37" />
              </View>
            </View>
            <Text style={s.reAuthTitle}>SEAL LOCK</Text>
            <Text style={[s.reAuthSub, { marginBottom: 32 }]}>Step 1 of 2 — {authLabel}</Text>
            {reAuthError ? (
              <View style={{ backgroundColor: 'rgba(239,68,68,0.12)', borderRadius: 10, padding: 14, marginHorizontal: 32, marginBottom: 20, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
                <Text style={{ color: '#ef4444', fontSize: 13, textAlign: 'center', lineHeight: 18 }}>{reAuthError}</Text>
              </View>
            ) : null}
            <TouchableOpacity style={[s.btnGold, glassButton, { paddingHorizontal: 40 }]} onPress={runBiometricReAuth}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <AuthIcon size={20} color="#160B00" />
                <Text style={s.btnText}>UNLOCK WITH {authLabel}</Text>
              </View>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    // ── Phase: TOTP (2FA — second factor) ───────────────────────────
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={[s.onboardScroll, { flexGrow: 1, justifyContent: 'center' }]} keyboardShouldPersistTaps="handled">
          <View style={s.onboardCenter}>
            <View style={{ alignItems: 'center', marginBottom: 24 }}>
              <PulseRing size={80} color="#D4AF37" delay={0} />
              <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(30,14,4,0.9)', borderWidth: 1.5, borderColor: 'rgba(212,175,55,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                <LockIcon size={38} color="#D4AF37" />
              </View>
            </View>
            <Text style={s.reAuthTitle}>AUTHENTICATOR</Text>
            <Text style={[s.reAuthSub, { marginBottom: 24 }]}>Step 2 of 2 — Open your authenticator app</Text>

            <PinBoxRow value={totpEntryCode} onChange={setTotpEntryCode} inputRef={pinEntryRef} />

            {totpEntryError ? (
              <Text style={{ color: '#ef4444', fontSize: 13, marginTop: 10, textAlign: 'center' }}>
                {totpEntryError}
              </Text>
            ) : null}

            {totpEntryCode.length === 6 && (
              <TouchableOpacity
                style={[s.btnGold, glassButton, { marginTop: 28, paddingHorizontal: 40 }]}
                onPress={submitTotp2FA}
              >
                <Text style={s.btnText}>CONFIRM →</Text>
              </TouchableOpacity>
            )}

            {/* Recovery — lost access to authenticator app */}
            <TouchableOpacity style={{ marginTop: 22, paddingVertical: 8 }} onPress={startTotpReset}>
              <Text style={{ color: '#9A7B4A', fontSize: 13, textAlign: 'center', letterSpacing: 0.5 }}>
                Lost access to your authenticator app?
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Step 12: The Oath — first screen after the on-device keypair exists ──
  if (onboardingStep === 12) {
    const TERMS = [
      'Allow face capture for identity sealing (hash only — image deleted immediately)',
      'Allow device check (no personal data stored on any server)',
      'Swear: one seal per human — any forgery voids your MONEY',
    ];
    const allChecked = termChecks.every(Boolean);
    return (
      <ScreenWrapper>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.onboardScroll}>
          <View style={s.onboardCenter}>

            <View style={{ marginBottom: 16, alignItems: 'center', justifyContent: 'center' }}>
              <PulseRing size={80} color="#D4AF37" delay={0} />
              <PulseRing size={80} color="#D4AF37" delay={900} />
              <SealMedallion size={80} />
            </View>
            <Text style={s.onboardTitle}>Forge Your Seal</Text>
            <Text style={s.onboardSub}>Your body is your key.</Text>

            <View style={[s.onboardCard, glassOnboardCard]}>
              <Text style={s.onboardCardTitle}>THE FORGING RITUAL</Text>
              {hasFingerprint
                ? <Text style={s.onboardBody}>① Fingerprint seal</Text>
                : <Text style={s.onboardBody}>① {authLabel} confirmation</Text>}
              <Text style={s.onboardBody}>② Enter your invite code</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                <Text style={s.onboardBody}>③ IGNITION — </Text>
                <MoneySymbol size={14} color="#B8956A" style={{ marginHorizontal: 3 }} />
                <Text style={s.onboardBody}>1,000,000 released 🔥</Text>
              </View>
            </View>

            <View style={[s.onboardCard, glassOnboardCard]}>
              <Text style={s.onboardCardTitle}>THE OATH</Text>
              <Text style={{ color: '#7A5C3A', fontSize: 12, marginBottom: 12 }}>
                Nothing is stored raw. Only hashes. Press each tablet to swear:
              </Text>
              {TERMS.map((term, i) => (
                <TouchableOpacity
                  key={i}
                  style={s.termRow}
                  onPress={() => setTermChecks(prev => { const n = [...prev]; n[i] = !n[i]; return n; })}
                >
                  <View
                    nativeID={termChecks[i] ? 'term-checked' : 'term-unchecked'}
                    style={[s.termBox, termChecks[i] && s.termBoxChecked, glassTermBox]}
                  >
                    {termChecks[i] && <Text style={s.termCheck}>✓</Text>}
                  </View>
                  {i === TERMS.length - 1 ? (
                    <View style={{ flex: 1, alignItems: 'flex-start' }}>
                      <Text style={s.termText}>{'Swear: one seal per human —'}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                        <Text style={s.termText}>{'any forgery voids your '}</Text>
                        <MoneySymbol size={14} color="#D4AF37" style={{ marginHorizontal: 2 }} />
                        <Text style={[s.termText, { color: '#D4AF37', fontWeight: 'bold' }]}>{'MONEY'}</Text>
                      </View>
                    </View>
                  ) : (
                    <Text style={s.termText}>{term}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>

            <AnimatedPress
              style={[s.btnGold, glassButton, { marginTop: 8 }, !allChecked && s.btnDisabled]}
              disabled={!allChecked}
              onPress={() => setOnboardingStep(hasFingerprint ? 3 : 35)}
            >
              <Text style={s.btnText}>{allChecked ? 'BEGIN THE FORGING →' : 'SWEAR ALL OATHS TO CONTINUE'}</Text>
            </AnimatedPress>

            {/* Lost-phone recovery: restore an existing wallet from its recovery key */}
            <TouchableOpacity
              style={{ marginTop: 18, paddingVertical: 8 }}
              onPress={() => { setSeedInput(''); setRestorePreview(null); setOnboardingStep(51); }}
            >
              <Text style={{ color: '#9A7B4A', fontSize: 13, textAlign: 'center', letterSpacing: 0.5 }}>
                Already have a wallet? Restore it →
              </Text>
            </TouchableOpacity>

          </View>
        </ScrollView>
      </SafeAreaView>
      </ScreenWrapper>
    );
  }

  // ── Step 2 (Face Inscription) removed — face scan eliminated from onboarding

  // ── Step 25 (Liveness) removed — voice liveness deleted. Face pose ritual
  //    + body seal now cover liveness. Kept the step number reserved so any
  //    stale navigation simply falls through to the body seal below.

  // ── Step 3: Left Thumb ────────────────────────────────────────────────
  if (onboardingStep === 3) {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.onboardScroll}>
          <View style={s.onboardCenter}>
            <View style={{ marginBottom: 16 }}><CheckSeal size={80} /></View>
            <Text style={s.onboardTitle}>Forge Your Seal</Text>
            <Text style={s.onboardSub}>Seal your identity with your {authLabel.toLowerCase()}.</Text>
            <View style={[s.onboardCard, glassOnboardCard]}>
              <Text style={s.onboardCardTitle}>BODY SEAL</Text>
              <Text style={s.onboardBody}>Confirm with your {authLabel.toLowerCase()} to bind your seal.</Text>
            </View>
            <View style={{ marginVertical: 20 }}><AuthIcon size={52} color="#D4AF37" /></View>
            <TouchableOpacity style={[s.btnGold, glassButton]} onPress={testLeftThumb}>
              <View style={{ flexDirection:'row', alignItems:'center', gap: 8 }}>
                <AuthIcon size={18} color="#160B00" />
                <Text style={s.btnText}>SEAL WITH {authLabel}</Text>
              </View>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Step 3.2 (Second fingerprint) removed

  // ── Step 3.5: PIN ─────────────────────────────────────────────────────
  if (onboardingStep === 35) {
    return (
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.onboardScroll}>
          <View style={s.onboardCenter}>
            <View style={{ marginBottom: 16 }}><CheckSeal size={80} /></View>
            <Text style={s.onboardTitle}>Face Inscribed</Text>
            <Text style={s.onboardSub}>Confirm your identity with your {authLabel.toLowerCase()}.</Text>
            <View style={[s.onboardCard, glassOnboardCard]}>
              <Text style={s.onboardCardTitle}>{authLabel} SEAL</Text>
              <Text style={s.onboardBody}>Your {authLabel.toLowerCase()} is your body seal — it binds your face to your wallet.</Text>
            </View>
            <TouchableOpacity style={[s.btnGold, glassButton]} onPress={testPin}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <AuthIcon size={18} color="#160B00" />
                <Text style={s.btnText}>SEAL WITH {authLabel}</Text>
              </View>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Step 36: 2FA — Create MONEY PIN ─────────────────────────────────
  if (onboardingStep === 36) {
    const userEmail = googleUser?.email || '';
    const otpauthUrl = totpSecret
      ? `otpauth://totp/MONEY:${encodeURIComponent(userEmail || 'user')}?secret=${totpSecret}&issuer=MONEY`
      : '';

    return (
      <ScreenWrapper>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.onboardScroll} keyboardShouldPersistTaps="handled">
          <View style={s.onboardCenter}>

            <View style={{ marginBottom: 16, alignItems:'center', justifyContent:'center' }}>
              <PulseRing size={80} color="#D4AF37" delay={0} />
              <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(30,14,4,0.9)', borderWidth: 1.5, borderColor: 'rgba(212,175,55,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                <LockIcon size={38} color="#D4AF37" />
              </View>
            </View>

            <Text style={s.onboardTitle}>Link Your Authenticator</Text>
            <Text style={s.onboardSub}>Scan with Google Authenticator, Microsoft Authenticator, or Authy</Text>

            <View style={[s.onboardCard, glassOnboardCard]}>
              <Text style={s.onboardCardTitle}>2FA — SECOND FACTOR</Text>
              <Text style={s.onboardBody}>
                Your authenticator app generates a new 6-digit code every 30 seconds. It is the second lock on your wallet — required every time the app relocks.{'\n\n'}
                The secret never leaves your device. Nobody can read it.
              </Text>
            </View>

            {/* QR code */}
            {totpSecret ? (
              <View style={{ backgroundColor: '#fff', padding: 16, borderRadius: 12, marginVertical: 16 }}>
                <QRCode value={otpauthUrl} size={200} />
              </View>
            ) : null}

            {/* Manual key fallback */}
            <Text style={{ color: '#9A7B4A', fontSize: 11, textAlign: 'center', marginBottom: 16, letterSpacing: 0.5 }}>
              Can't scan? Manual key:{'\n'}{totpSecret}
            </Text>

            {/* Verification — enter first code to confirm it's linked */}
            <Text style={{ color: '#D4AF37', fontSize: 13, marginBottom: 8, textAlign: 'center', letterSpacing: 0.5 }}>
              ENTER THE 6-DIGIT CODE TO CONFIRM
            </Text>
            <PinBoxRow value={totpSetupCode} onChange={setTotpSetupCode} inputRef={pinSetupRef1} />

            {totpSetupError ? (
              <Text style={{ color: '#ef4444', fontSize: 13, marginTop: 8, textAlign: 'center' }}>
                {totpSetupError}
              </Text>
            ) : null}

            {totpSetupCode.length === 6 && (
              <TouchableOpacity
                style={[s.btnGold, glassButton, { marginTop: 24 }]}
                onPress={confirmTotpSetup}
              >
                <Text style={s.btnText}>LOCK IN 2FA 🔐</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={{ marginTop: 16 }}
              onPress={() => {
                const secret = authenticator.generateSecret();
                setTotpSecret(secret);
                setTotpSetupCode('');
                setTotpSetupError('');
              }}
            >
              <Text style={{ color: '#5A3D1A', fontSize: 13, textAlign: 'center' }}>↺ Generate new QR code</Text>
            </TouchableOpacity>

          </View>
        </ScrollView>
      </SafeAreaView>
      </ScreenWrapper>
    );
  }

  // ── Step 4: Seal Complete → Formation begins ──────────────────────────
  if (onboardingStep === 4) {
    return (
      <ScreenWrapper>
      <SafeAreaView style={s.root}>
        <View style={s.fullCenter}>
          <View style={{ marginBottom: 16, alignItems:'center', justifyContent:'center' }}>
            <PulseRing size={80} color="#7DB87A" delay={0} />
            <CheckSeal size={80} />
          </View>
          <Text style={s.onboardTitle}>Seal Forged</Text>
          <Text style={s.onboardSub}>Face ✅  {hasFingerprint ? 'Fingerprint ✅  ✅' : `${authLabel} ✅`}</Text>
          <View style={[s.onboardCard, glassOnboardCard]}>
            <Text style={s.onboardCardTitle}>YOUR STAR IS READY</Text>
            <Text style={s.onboardBody}>Your seal is forged.{'\n\n'}</Text>
            <View style={{ flexDirection:'row', alignItems:'flex-start', marginBottom:8 }}>
              <MoneySymbol size={13} color="#B8956A" style={{ marginRight:4, marginTop:2 }} />
              <Text style={[s.onboardBody, { flex:1 }]}>1,000,000 is waiting in the Common Treasury.</Text>
            </View>
            <Text style={s.onboardBody}>{'\n'}Enter your invite code, then press IGNITE to claim your founding share.</Text>
          </View>

          {/* Invite (ignition) code — the server's one-per-human faucet gate */}
          <View style={{ width: '100%', marginBottom: 14, paddingHorizontal: 24 }}>
            <Text style={{ color: '#9A7B4A', fontSize: 11, letterSpacing: 3, textAlign: 'center', marginBottom: 8 }}>
              ✦ INVITE CODE
            </Text>
            <TextInput
              value={ignitionCode}
              onChangeText={setIgnitionCode}
              placeholder="enter your invite code"
              placeholderTextColor="#5A3D1A"
              autoCapitalize="characters"
              autoCorrect={false}
              style={{
                backgroundColor: 'rgba(28,17,4,0.6)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.35)',
                borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, color: '#F1E2C0',
                fontSize: 15, letterSpacing: 2, textAlign: 'center',
              }}
            />
          </View>

          <AnimatedPress style={[s.btnGold, glassButton]} onPress={completeBioKeySetup}>
            <View style={{ flexDirection:'row', alignItems:'center', justifyContent:'center', gap: 6 }}>
              <FlameIcon size={18} color="#1A0A00" />
              <Text style={s.btnText}>IGNITE — CLAIM </Text>
              <MoneySymbol size={14} color="#1A0A00" />
              <Text style={s.btnText}> 1,000,000</Text>
            </View>
          </AnimatedPress>
        </View>
      </SafeAreaView>
      </ScreenWrapper>
    );
  }

  // Step 5 (formation / 4-suns / KYC screen) removed — sovereignty ignites on step 4.

  // ── Step 6: IGNITION ──────────────────────────────────────────────────
  if (onboardingStep === 6) {
    const reward = calcReward(userCount);
    return (
      <ScreenWrapper>
      <SafeAreaView style={[s.root, { backgroundColor: '#0f0600' }]}>
        <View style={s.fullCenter}>
          <Animated.View style={{ opacity: igOpacity, transform: [{ scale: igScale }], alignItems: 'center' }}>
            <View style={{ marginBottom: 20, alignItems:'center', justifyContent:'center' }}>
              <PulseRing size={120} color="#D4AF37" delay={0}   />
              <PulseRing size={120} color="#E05020" delay={600} />
              <PulseRing size={120} color="#D4AF37" delay={1200}/>
              <IgnitionBurst size={120} />
            </View>

            <Text style={s.ignitionTitle}>IGNITION</Text>
            <Text style={s.ignitionSub}>Your star is born.</Text>

            <View style={[s.onboardCard, { borderColor: '#D4AF37' }]}>
              <Text style={[s.onboardCardTitle, { textAlign: 'center' }]}>WELCOME, FOUNDING MEMBER</Text>
              <Text style={s.ignitionAmount}>{fmt(reward)}</Text>
              <Text style={s.ignitionCoin}>MONEY</Text>
              <Text style={s.ignitionMsg}>
                You are one of the founding stars of the Swarm.{'\n'}
                No bank gave you this. The Swarm did.{'\n'}
                Money. For Everyone. Forever.
              </Text>
            </View>

            <TouchableOpacity
              style={[s.btnIgnite, glassButton]}
              onPress={() => { isIgnitedRef.current = true; setOnboardingStep(0); }}
            >
              <Text style={s.btnIgniteText}>ENTER THE SWARM →</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>
      </SafeAreaView>
      </ScreenWrapper>
    );
  }

  // ── Wallet backup / restore (key recovery) ───────────────────────────
  // The 32-byte seed IS the wallet: ed25519 secretKey = seed(32) ‖ publicKey(32),
  // so seed = secretKey[:32]. Rebuilding from that seed reproduces the EXACT same
  // keypair + address (proven). We surface the seed two ways that encode the SAME
  // 32-byte seed: a 24-word BIP39 phrase (primary — easiest to write down) and the
  // raw hex key (fallback). The words use BIP39's ENTROPY path (not PBKDF2), so
  // either one restores the identical wallet. No third party, no server.
  const recoverySeedHex  = () => (secKeyRef.current || '').substring(0, 64).toUpperCase();
  const recoveryMnemonic = () => {
    try { return entropyToMnemonic(fromHex((secKeyRef.current || '').substring(0, 64)), bip39Words); }
    catch { return ''; }
  };
  const groupHex = (h) => (h.match(/.{1,4}/g) || []).join(' ');

  // Check a typed recovery phrase OR raw key and reconstruct the keypair (preview only).
  // Accepts a 24-word BIP39 phrase (preferred) or the 64-char hex key (fallback).
  const previewRestore = () => {
    const raw = (seedInput || '').trim();
    const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
    let seedHex = null;
    if (words.length >= 12) {
      // 24-word recovery phrase — BIP39 entropy path (NOT pbkdf2)
      const phrase = words.join(' ');
      if (!validateMnemonic(phrase, bip39Words)) {
        Alert.alert('Check your recovery phrase', 'That phrase is not valid — a word may be misspelled or out of order. It should be 24 words from the recovery list. Check and try again.');
        return;
      }
      try { seedHex = toHex(mnemonicToEntropy(phrase, bip39Words)); }
      catch { Alert.alert('Invalid phrase', 'Could not read that recovery phrase.'); return; }
    } else {
      // raw hex recovery key (fallback)
      const h = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      if (h.length !== 64) {
        Alert.alert('Check your recovery', 'Enter EITHER your 24-word phrase OR your 64-character recovery key. Spaces are ignored.');
        return;
      }
      seedHex = h;
    }
    try {
      const kp = nacl.sign.keyPair.fromSeed(fromHex(seedHex));
      setRestorePreview({
        address:   'M_' + toHex(kp.publicKey).substring(0, 32).toUpperCase(),
        publicKey: toHex(kp.publicKey),
        secretKey: toHex(kp.secretKey),
      });
    } catch {
      Alert.alert('Invalid recovery', 'That could not be read. Double-check it and try again.');
    }
  };

  // Confirm + apply: overwrite this device's wallet with the restored one.
  const applyRestore = async () => {
    if (!restorePreview) return;
    const kp = restorePreview;
    try { await SecureStore.setItemAsync('keypair_v3', JSON.stringify(kp)); } catch {}
    setAddress(kp.address);
    addrRef.current   = kp.address;
    pubKeyRef.current = kp.publicKey;
    secKeyRef.current = kp.secretKey;
    // A restored wallet already exists on the ledger — mark this device sealed +
    // ignited so the user lands in the wallet now AND stays there on future
    // launches (re-auth then uses the device fingerprint/PIN, same as a normal seal).
    await SecureStore.setItemAsync('formation_ignited', '1').catch(() => {});
    await SecureStore.setItemAsync('biokey_v1', '1').catch(() => {});
    setBioKeyActive(true);
    isIgnitedRef.current = true;
    setSeedInput(''); setRestorePreview(null);
    Alert.alert('Wallet restored ✅', `This device now controls:\n\n${kp.address}\n\nYour balance will sync from the Clay Tablets.`);
    setOnboardingStep(0);
  };

  // ── Screen 50: BACK UP WALLET ─────────────────────────────────────────
  if (onboardingStep === 50) {
    const seedHex = recoverySeedHex();
    const mnemonic = recoveryMnemonic();
    const words = mnemonic ? mnemonic.split(' ') : [];
    return (
      <ScreenWrapper>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.onboardScroll}>
          <View style={s.onboardCenter}>
            <Text style={s.onboardTitle}>Back Up Your Wallet</Text>
            <Text style={s.onboardSub}>Your 24-word recovery phrase restores this wallet.</Text>

            <View style={[s.onboardCard, glassOnboardCard]}>
              <Text style={s.onboardCardTitle}>⚠️  READ THIS FIRST</Text>
              <Text style={s.onboardBody}>
                Write these 24 words down IN ORDER on paper and store them safely — or save them in a password manager.{'\n\n'}
                • Anyone with these words controls your wallet and your MONEY.{'\n'}
                • Never share them. Never type them into a website.{'\n'}
                • We cannot recover them for you. Lose them AND your phone, and your MONEY is gone forever.
              </Text>
            </View>

            {words.length === 24 ? (
              <View style={[s.onboardCard, glassOnboardCard]}>
                <Text style={s.onboardCardTitle}>YOUR 24-WORD RECOVERY PHRASE</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 }}>
                  {words.map((w, i) => (
                    <View key={i} style={{ width: '50%', flexDirection: 'row', paddingVertical: 5, paddingRight: 6 }}>
                      <Text style={{ color: '#7A5C3A', fontSize: 13, width: 26, textAlign: 'right', marginRight: 8 }}>{i + 1}.</Text>
                      <Text selectable style={{ color: '#F1E2C0', fontSize: 15, fontWeight: '600', letterSpacing: 0.5 }}>{w}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : (
              <View style={[s.onboardCard, glassOnboardCard]}>
                <Text style={s.onboardBody}>Couldn't render the phrase here — use the raw recovery key below instead. It restores the same wallet.</Text>
              </View>
            )}

            {/* Fallback: the raw hex key — encodes the SAME seed as the words */}
            <View style={[s.onboardCard, glassOnboardCard]}>
              <Text style={s.onboardCardTitle}>ADVANCED — RAW RECOVERY KEY (FALLBACK)</Text>
              <Text selectable style={{ color: '#B8956A', fontSize: 13, letterSpacing: 1.5, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', textAlign: 'center', lineHeight: 24, marginTop: 6 }}>
                {groupHex(seedHex)}
              </Text>
              <Text style={{ color: '#5A3D1A', fontSize: 11, textAlign: 'center', marginTop: 8 }}>
                Same wallet as the words above — either one restores it.
              </Text>
            </View>

            <Text style={{ color: '#9A7B4A', fontSize: 12, textAlign: 'center', marginBottom: 16 }}>
              Restores wallet:{'\n'}{addrRef.current}
            </Text>

            <AnimatedPress
              style={[s.btnGold, glassButton]}
              onPress={() => Share.share({ message: `MONEY wallet recovery (KEEP SECRET — anyone with this controls the wallet):\n\n24-WORD PHRASE:\n${mnemonic}\n\nRAW KEY (fallback, same wallet):\n${seedHex}\n\nWallet: ${addrRef.current}` })}
            >
              <Text style={s.btnText}>SAVE / EXPORT</Text>
            </AnimatedPress>

            <TouchableOpacity style={{ marginTop: 16, paddingVertical: 10 }} onPress={() => setOnboardingStep(0)}>
              <Text style={{ color: '#888', textAlign: 'center' }}>← Done — back to wallet</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
      </ScreenWrapper>
    );
  }

  // ── Screen 51: RESTORE WALLET ─────────────────────────────────────────
  if (onboardingStep === 51) {
    return (
      <ScreenWrapper>
      <SafeAreaView style={s.root}>
        <ScrollView contentContainerStyle={s.onboardScroll} keyboardShouldPersistTaps="handled">
          <View style={s.onboardCenter}>
            <Text style={s.onboardTitle}>Restore Your Wallet</Text>
            <Text style={s.onboardSub}>Enter your 24-word recovery phrase (or your raw recovery key).</Text>

            <View style={[s.onboardCard, glassOnboardCard]}>
              <Text style={s.onboardBody}>
                ⚠️  Restoring REPLACES the wallet on this phone with the one your recovery phrase controls. If this phone already holds MONEY, back it up first.
              </Text>
            </View>

            <TextInput
              style={{ width: '100%', backgroundColor: 'rgba(28,17,4,0.6)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.35)', borderRadius: 12, padding: 14, color: '#F1E2C0', fontSize: 14, letterSpacing: 1, minHeight: 96, textAlignVertical: 'top', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }}
              placeholder="Paste your 24 words (or your 64-character recovery key)"
              placeholderTextColor="#5A3D1A"
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              value={seedInput}
              onChangeText={(t) => { setSeedInput(t); setRestorePreview(null); }}
            />

            {!restorePreview ? (
              <AnimatedPress style={[s.btnGold, glassButton, { marginTop: 16 }]} onPress={previewRestore}>
                <Text style={s.btnText}>CHECK KEY</Text>
              </AnimatedPress>
            ) : (
              <View style={{ width: '100%', marginTop: 16 }}>
                <Text style={{ color: '#7DB87A', textAlign: 'center', marginBottom: 12 }}>
                  This key restores wallet:{'\n'}{restorePreview.address}{'\n\n'}Confirm this is the wallet you want on this phone.
                </Text>
                <AnimatedPress style={[s.btnGold, glassButton]} onPress={applyRestore}>
                  <Text style={s.btnText}>RESTORE THIS WALLET</Text>
                </AnimatedPress>
              </View>
            )}

            <TouchableOpacity style={{ marginTop: 16, paddingVertical: 10 }} onPress={() => { setSeedInput(''); setRestorePreview(null); setOnboardingStep(isIgnitedRef.current ? 0 : 12); }}>
              <Text style={{ color: '#888', textAlign: 'center' }}>← Cancel</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
      </ScreenWrapper>
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  // ── MAIN APP ──────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────
  const reward    = calcReward(userCount);
  const isMillion = reward === 1_000_000;

  return (
    <ScreenWrapper>
    <SafeAreaView style={s.root}>
      <GlowOrbs />

      {/* Transaction Seal Verification Modal — single real factor: biometric / PIN */}
      <Modal visible={txModalVisible} animationType="slide" statusBarTranslucent onRequestClose={cancelTxModal}>
        <SafeAreaView style={[s.root, { backgroundColor: '#0a0500' }]}>
          <View style={s.fullCenter}>

            {/* Header */}
            <View style={[s.reAuthHeader, { marginBottom: 28 }]}>
              <Text style={s.reAuthIcon}>🔐</Text>
              <Text style={s.reAuthTitle}>SEAL VERIFICATION</Text>
              <Text style={s.reAuthSub}>{txModalLabel || 'Confirm with your seal'}</Text>
            </View>

            <View style={{ alignItems: 'center', marginBottom: 32 }}>
              <PulseRing size={100} color="#D4AF37" delay={0} />
              <View style={{ width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(30,14,4,0.9)', borderWidth: 1.5, borderColor: 'rgba(212,175,55,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                <AuthIcon size={48} color="#D4AF37" />
              </View>
            </View>

            <TouchableOpacity style={[s.btnGold, glassButton, { paddingHorizontal: 36 }]} onPress={runTxBiometric}>
              <View style={{ flexDirection:'row', alignItems:'center', gap: 8 }}>
                <AuthIcon size={18} color="#160B00" />
                <Text style={s.btnText}>CONFIRM WITH {authLabel}</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity style={s.btnSkip} onPress={cancelTxModal}>
              <Text style={s.btnSkipText}>Cancel trade</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* ── Recipient QR scan ───────────────────────────────────────────── */}
      <Modal visible={recipientScanVisible} animationType="slide" statusBarTranslucent onRequestClose={cancelRecipientScan}>
        <SafeAreaView style={[s.root, { backgroundColor: '#0a0500' }]}>
          <View style={s.cameraContainer}>

            {/* Header */}
            <View style={s.reAuthHeader}>
              <CameraIrisIcon size={28} color="#D4AF37" />
              <Text style={s.reAuthTitle}>SCAN RECIPIENT</Text>
              <Text style={s.reAuthSub}>Point at their seal QR code</Text>
            </View>

            {/* QR scanner (back camera) */}
            {cameraPermission?.granted ? (
              <View style={s.camera}>
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={handleRecipientQrScanned}
                />
                <View style={s.qrOverlay}>
                  <View style={s.qrFrame}>
                    <View style={[s.qrCorner, s.qrTL]} />
                    <View style={[s.qrCorner, s.qrTR]} />
                    <View style={[s.qrCorner, s.qrBL]} />
                    <View style={[s.qrCorner, s.qrBR]} />
                  </View>
                  <Text style={s.qrHint}>Their seal mark fills in automatically</Text>
                </View>
              </View>
            ) : (
              <View style={[s.camera, s.cameraPlaceholder]}>
                <CameraIrisIcon size={60} />
                <Text style={{ color: '#C4956A', marginTop: 12 }}>Camera permission needed</Text>
              </View>
            )}

            <TouchableOpacity style={s.btnSkip} onPress={cancelRecipientScan}>
              <Text style={s.btnSkipText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      <ScrollView contentContainerStyle={s.scroll}>
        {/* TESTNET BANNER — unmistakable, only rendered on testnet, nothing shown on mainnet */}
        {network === 'testnet' && (
          <View style={s.testnetBanner}>
            <Text style={s.testnetBannerText}>🧪 TESTNET MODE — this is NOT real MONEY</Text>
          </View>
        )}
        {/* HEADER */}
        <View nativeID="app-header" style={s.header}>
          {/* Native: pulsing clock-ring logo with pulse rings
               Web:    logo image only — 3D chrome orb sits beside it in the header */}
          {Platform.OS !== 'web' ? (
            <View style={{ alignItems:'center', justifyContent:'center', marginBottom: 16 }}>
              <PulseRing size={130} color="#D4AF37" delay={0}    />
              <PulseRing size={130} color="#B8956A" delay={1100} />
              <Animated.View style={[s.logoRing, { marginBottom: 0, transform: [{ scale: logoScale }] }]}>
                <Image source={require('./assets/logo.png')} style={s.logo} resizeMode="contain" />
              </Animated.View>
            </View>
          ) : (
            <View style={{ alignItems:'center', justifyContent:'center', marginBottom: 16 }}>
              <Animated.View style={[s.logoRing, { marginBottom: 0, transform: [{ scale: logoScale }] }]}>
                <Image source={require('./assets/logo.png')} style={s.logo} resizeMode="contain" />
              </Animated.View>
            </View>
          )}
          <Text style={s.title}>Proof of Swarm</Text>
          <Text style={s.tagline}>Money. For Everyone. Forever.</Text>
          {bioKeyActive && (
            <View style={s.sealBadge}><Text style={s.sealBadgeText}>🔐 SEAL ACTIVE</Text></View>
          )}
          {/* Network toggle — tap to switch mainnet ⇄ testnet, no rebuild required */}
          <TouchableOpacity
            style={[s.networkBadge, network === 'testnet' && s.networkBadgeTestnet]}
            onPress={toggleNetwork}
            activeOpacity={0.7}
          >
            <Text style={s.networkBadgeText}>
              {network === 'testnet' ? '🧪 TESTNET · tap for Mainnet' : '🌐 MAINNET · tap for Testnet'}
            </Text>
          </TouchableOpacity>
          {userCount === 0 ? (
            <View style={{ flexDirection:'row', flexWrap:'wrap', alignItems:'center', justifyContent:'center', paddingHorizontal: 8 }}>
              <Text style={s.stat}>Be the first — claim your founding share of </Text>
              <MoneySymbol size={13} color="#B8956A" style={{ marginHorizontal: 2, marginTop: 1 }} />
              <Text style={s.stat}> 1,000,000</Text>
            </View>
          ) : (
            <View style={{ flexDirection:'row', flexWrap:'wrap', alignItems:'center', justifyContent:'center', paddingHorizontal: 8 }}>
              <Text style={s.stat}>{userCount.toLocaleString()} members · next share: </Text>
              <MoneySymbol size={13} color="#B8956A" style={{ marginHorizontal: 2, marginTop: 1 }} />
              <Text style={s.stat}> {Number(reward).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</Text>
            </View>
          )}
        </View>

        {/* CLAY SEAL (wallet) */}
        <TouchableOpacity style={[s.card, glassCard]} onPress={() => setShowMyQR(v => !v)} activeOpacity={0.85}>
          <Text style={s.label}>YOUR CLAY SEAL</Text>
          <Text style={s.addr} numberOfLines={1}>{address || '…'}</Text>
          {showMyQR && address ? (
            <View style={s.myQrWrap}>
              <QRCode
                value={address}
                size={160}
                color="#D4AF37"
                backgroundColor="#0E0700"
                quietZone={10}
              />
              <Text style={s.qrLabel}>Show this to receive trades</Text>
            </View>
          ) : (
            <Text style={s.hint}>Tap to show your QR seal</Text>
          )}
        </TouchableOpacity>

        {/* BALANCE */}
        <View style={[s.card, glassCard]}>
          <Text style={s.label}>YOUR LEDGER</Text>
          <Animated.View style={[s.balanceRow, { transform: [{ scale: balScale }] }]}>
            <MoneySymbol size={30} color="#7DB87A" style={{ marginRight: 8 }} />
            <Animated.Text style={[s.balance, {
              textShadowColor: '#7DB87A',
              textShadowOffset: { width: 0, height: 0 },
              textShadowRadius: 8,
            }]}>
              {Number(balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </Animated.Text>
          </Animated.View>
          {balance >= 1_000_000 && (
            <Text style={s.millionaire}>🎉 FOUNDING MEMBER OF THE SWARM</Text>
          )}
        </View>

        {/* INVITE */}
        <AnimatedPress style={[s.btnAmber, glassButton]} onPress={invite}>
          <Text style={s.btnText}>Invite to the Swarm</Text>
        </AnimatedPress>

        {/* CLAIM */}
        {!claimed && (
          <AnimatedPress style={[s.btnSage, glassButton]} onPress={claim}>
            <View style={{ flexDirection:'row', alignItems:'center', justifyContent:'center', flexWrap:'wrap', gap: 4 }}>
              <Text style={s.btnText}>RECEIVE YOUR FOUNDING SHARE —</Text>
              <MoneySymbol size={14} color="#160B00" style={{ marginTop: 1 }} />
              <Text style={s.btnText}>{isMillion ? ' 1,000,000' : ` ${Number(reward).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</Text>
            </View>
          </AnimatedPress>
        )}
        {claimed && (
          <View style={[s.btnSage, s.btnDone]}>
            <Text style={s.btnText}>✅ FOUNDING SHARE RECEIVED</Text>
          </View>
        )}

        {/* TRADE (send) */}
        <View style={s.section}>
          <Text style={s.label}>MAKE A TRADE 🔐</Text>

          {/* Recipient row: text input + QR scan button */}
          <View style={s.recipientRow}>
            <TextInput
              style={[s.input, { flex: 1, marginBottom: 0 }]}
              placeholder="Recipient seal mark"
              placeholderTextColor="#5A3D1A"
              value={recipient}
              onChangeText={setRecipient}
              autoCapitalize="none"
            />
            <AnimatedPress style={s.qrScanBtn} onPress={openRecipientScan}>
              <CameraIrisIcon size={22} color="#D4AF37" />
            </AnimatedPress>
          </View>

          <TextInput
            style={s.input}
            placeholder="Amount"
            placeholderTextColor="#5A3D1A"
            keyboardType="numeric"
            value={amount}
            onChangeText={setAmount}
          />
          <AnimatedPress style={s.btnLapis} onPress={send}>
            <Text style={s.btnText}>🔐 INSCRIBE TRADE</Text>
          </AnimatedPress>
        </View>

        {/* About MONEY link */}
        <TouchableOpacity
          style={{ alignItems: 'center', paddingVertical: 10, marginBottom: 4 }}
          onPress={() => setShowAboutScreen(true)}
        >
          <Text style={{ color: '#5A3D1A', fontSize: 12, letterSpacing: 1 }}>WHAT IS MONEY? →</Text>
        </TouchableOpacity>

        {/* Wallet backup / restore (key recovery) */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 24, paddingVertical: 6, marginBottom: 10 }}>
          <TouchableOpacity onPress={() => setOnboardingStep(50)}>
            <Text style={{ color: '#9A7B4A', fontSize: 12, letterSpacing: 1 }}>🔑 BACK UP WALLET</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setSeedInput(''); setRestorePreview(null); setOnboardingStep(51); }}>
            <Text style={{ color: '#9A7B4A', fontSize: 12, letterSpacing: 1 }}>♻️ RESTORE WALLET</Text>
          </TouchableOpacity>
        </View>

        {/* CLAY TABLETS (ledger) */}
        <View style={s.section}>
          <Text style={s.label}>THE CLAY TABLETS — PUBLIC RECORD</Text>
          <Text style={s.sublabel}>Every trade. Forever. Cannot be erased.</Text>
          {txs.length === 0
            ? <Text style={s.empty}>No trades yet. Be the first to inscribe.</Text>
            : txs.map((tx, i) => (
              <View key={i} style={[s.tablet, tx.reason === 'disconnect_penalty' && s.tabletPenalty]}>
                <View style={s.tabletHeader}>
                  <Text style={s.tabletNum}>ENTRY {txs.length - i}</Text>
                  <Text style={s.tabletTime}>{tx.time}</Text>
                </View>
                <View style={s.tabletRow}>
                  <Text style={s.tabletFromLabel}>FROM</Text>
                  <Text style={s.tabletAddr} numberOfLines={1}>{displayAddr(tx.from)}</Text>
                </View>
                <View style={s.tabletRow}>
                  <Text style={s.tabletFromLabel}>TO  </Text>
                  <Text style={s.tabletAddr} numberOfLines={1}>{displayAddr(tx.to)}</Text>
                </View>
                <View style={s.tabletAmtRow}>
                  {tx.reason === 'disconnect_penalty'
                    ? <Text style={s.tabletPenaltyBadge}>⚖️ ABSENCE LEVY</Text>
                    : null}
                  <MoneyAmount value={tx.amount} size={13} color="#7DB87A" textStyle={s.tabletAmt} />
                </View>
              </View>
            ))}
        </View>
      </ScrollView>
    </SafeAreaView>
    </ScreenWrapper>
  );
}

// ── Root shell — renders the deep-space background + depth frame ONCE, behind
//    EVERY screen (wrapped or not). Gyro tilt is read once here. ─────────────
export default function App() {
  const tilt = useTilt();
  return (
    <View style={{ flex: 1, backgroundColor: IS_WEB ? 'transparent' : '#0E0700' }}>
      {Platform.OS !== 'web' && <HoloBackground tilt={tilt} />}
      {Platform.OS !== 'web' && <DepthFrame />}
      <AppInner />
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: IS_WEB ? '#0E0700' : 'transparent' },  // native: dark base + starfield come from ScreenWrapper/HoloBackground; web unchanged
  scroll: { paddingBottom: 60 },

  // ── Header ──────────────────────────────────────────────────────────────
  header: {
    alignItems: 'center', paddingVertical: 40, paddingHorizontal: 20,
    backgroundColor: '#130A00',
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,175,55,0.15)',
  },
  logoRing: {
    width: 130, height: 130, borderRadius: 65, overflow: 'hidden',
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9, shadowRadius: 28, elevation: 20,
    borderWidth: 1.5, borderColor: 'rgba(212,175,55,0.6)',
  },
  logo:    { width: 130, height: 130 },
  title:   { fontSize: 26, color: '#D4AF37', fontWeight: 'bold', letterSpacing: 5, marginBottom: 4 },
  tagline: { fontSize: 15, color: '#B8956A', fontStyle: 'italic', letterSpacing: 1, marginBottom: 8 },
  stat:    { fontSize: 13, color: '#C4956A', textAlign: 'center', letterSpacing: 0.5 },

  sealBadge: {
    backgroundColor: 'rgba(42,21,8,0.8)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.4)',
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 5, marginBottom: 10,
  },
  sealBadgeText: { color: '#D4AF37', fontSize: 11, fontWeight: 'bold', letterSpacing: 2 },

  // ── Network toggle (mainnet ⇄ testnet) ──────────────────────────────────
  networkBadge: {
    backgroundColor: 'rgba(42,21,8,0.8)', borderWidth: 1, borderColor: 'rgba(125,184,122,0.4)',
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 5, marginBottom: 10,
  },
  networkBadgeTestnet: { borderColor: 'rgba(230,160,40,0.7)', backgroundColor: 'rgba(60,38,4,0.85)' },
  networkBadgeText:    { color: '#7DB87A', fontSize: 11, fontWeight: 'bold', letterSpacing: 1 },
  // Unmistakable — high-contrast, full-width, always the first thing visible on testnet.
  testnetBanner: {
    backgroundColor: '#E6A028', paddingVertical: 8, paddingHorizontal: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  testnetBannerText: { color: '#1A0A00', fontSize: 13, fontWeight: 'bold', letterSpacing: 0.5, textAlign: 'center' },

  // ── Glass cards ──────────────────────────────────────────────────────────
  card: {
    backgroundColor: 'rgba(30,14,4,0.82)',
    margin: 16, padding: 20, borderRadius: 18, alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.22)',
    borderTopColor: 'rgba(255,255,255,0.12)', borderTopWidth: 2,
    borderBottomColor: 'rgba(0,0,0,0.7)', borderBottomWidth: 4,
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.35, shadowRadius: 24, elevation: 20,
  },
  label:      { color: '#C4956A', fontSize: 11, letterSpacing: 2.5, marginBottom: 8 },
  sublabel:   { color: '#5A3D1A', fontSize: 11, letterSpacing: 1, marginBottom: 12, fontStyle: 'italic' },
  addr:       { color: '#E8C87A', fontSize: 13, fontFamily: 'monospace', letterSpacing: 0.5 },
  hint:       { color: '#4A2E10', fontSize: 11, marginTop: 6 },
  balanceRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 4 },
  balance:    { color: '#7DB87A', fontSize: 40, fontWeight: 'bold', letterSpacing: -1 },
  millionaire:{ color: '#D4AF37', fontSize: 12, marginTop: 8, fontWeight: 'bold', textAlign: 'center', letterSpacing: 1.5 },

  // ── Buttons — 3D lifted, glowing ─────────────────────────────────────────
  btnAmber: {
    backgroundColor: '#7A5010', margin: 16, marginBottom: 8, padding: 18, borderRadius: 16,
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(212,175,55,0.5)',
    borderTopColor: 'rgba(255,255,255,0.18)', borderTopWidth: 2,
    borderBottomColor: 'rgba(0,0,0,0.55)', borderBottomWidth: 5,
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.50, shadowRadius: 22, elevation: 20,
  },
  btnSage: {
    backgroundColor: '#1E3A1C', margin: 16, marginTop: 8, padding: 18, borderRadius: 16,
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(125,184,122,0.4)',
    borderTopColor: 'rgba(255,255,255,0.14)', borderTopWidth: 2,
    borderBottomColor: 'rgba(0,0,0,0.55)', borderBottomWidth: 5,
    shadowColor: '#7DB87A', shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.45, shadowRadius: 22, elevation: 20,
  },
  btnLapis: {
    backgroundColor: '#162A3E', padding: 16, borderRadius: 16,
    alignItems: 'center', marginTop: 8, borderWidth: 1, borderColor: 'rgba(74,110,140,0.5)',
    borderTopColor: 'rgba(255,255,255,0.08)', borderTopWidth: 1,
    shadowColor: '#4A6E8C', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 14, elevation: 10,
  },
  btnDone: { backgroundColor: '#142012', borderColor: 'rgba(58,90,55,0.4)' },
  btnText: { color: '#F5E6C8', fontWeight: 'bold', fontSize: 15, letterSpacing: 1.5 },
  btnGold: {
    backgroundColor: '#C9A832', padding: 18, borderRadius: 16,
    alignItems: 'center', width: '100%', marginTop: 12,
    borderTopColor: 'rgba(255,255,255,0.30)', borderTopWidth: 2,
    borderBottomColor: 'rgba(0,0,0,0.55)', borderBottomWidth: 5,
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.75, shadowRadius: 26, elevation: 24,
  },
  btnDisabled: { backgroundColor: '#2E1A0A', opacity: 0.5 },
  btnSkip:     { marginTop: 14, alignItems: 'center', paddingVertical: 10 },
  btnSkipText: { color: '#5A3D1A', fontSize: 13, letterSpacing: 1 },

  section: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  input: {
    backgroundColor: 'rgba(20,10,4,0.8)', color: '#E8C87A', padding: 14,
    marginVertical: 6, borderRadius: 12, borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.2)', fontFamily: 'monospace',
    borderTopColor: 'rgba(255,255,255,0.05)', borderTopWidth: 1,
  },

  // ── Clay Tablet ledger entries — glass panels ────────────────────────────
  tablet: {
    backgroundColor: 'rgba(30,12,4,0.7)',
    padding: 16, marginVertical: 6, borderRadius: 14,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.15)',
    borderTopColor: 'rgba(255,255,255,0.06)', borderTopWidth: 1.5,
    borderLeftWidth: 4, borderLeftColor: 'rgba(196,149,106,0.7)',
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 10, elevation: 6,
  },
  tabletPenalty: { borderLeftColor: 'rgba(139,58,31,0.8)', borderColor: 'rgba(90,32,16,0.5)' },
  tabletHeader:  { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(61,32,8,0.8)', paddingBottom: 6 },
  tabletNum:     { color: '#8B5E3C', fontSize: 10, fontWeight: 'bold', letterSpacing: 2.5 },
  tabletTime:    { color: '#5A3D1A', fontSize: 10 },
  tabletRow:     { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 3 },
  tabletFromLabel: { color: '#6B4423', fontSize: 10, fontFamily: 'monospace', marginRight: 8, marginTop: 1, fontWeight: 'bold', letterSpacing: 1 },
  tabletAddr:    { color: '#B8956A', fontSize: 11, fontFamily: 'monospace', flex: 1 },
  tabletAmtRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, paddingTop: 6, borderTopWidth: 1, borderTopColor: 'rgba(61,32,8,0.6)' },
  tabletAmt:     { color: '#7DB87A', fontSize: 17, fontWeight: 'bold', fontFamily: 'monospace' },
  tabletPenaltyBadge: { color: '#C4703A', fontSize: 11, fontWeight: 'bold', letterSpacing: 1 },
  empty:         { color: '#4A2E10', textAlign: 'center', marginTop: 20, fontStyle: 'italic' },

  // ── Onboarding shared ───────────────────────────────────────────────────
  fullCenter:       { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  loadingText:      { color: '#5A3D1A', fontSize: 16, fontStyle: 'italic', letterSpacing: 2 },
  onboardScroll:    { flexGrow: 1, justifyContent: 'center' },
  onboardCenter:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  bigIcon:          { fontSize: 80, marginBottom: 16 },
  onboardTitle:     { fontSize: 30, color: '#D4AF37', fontWeight: 'bold', textAlign: 'center', marginBottom: 8, letterSpacing: 2 },
  onboardSub:       { fontSize: 15, color: '#B8956A', fontStyle: 'italic', textAlign: 'center', marginBottom: 4, letterSpacing: 0.5 },
  onboardCard: {
    backgroundColor: 'rgba(28,10,2,0.88)',
    borderRadius: 16, padding: 20, borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.22)',
    borderTopColor: 'rgba(255,255,255,0.12)', borderTopWidth: 2,
    borderBottomColor: 'rgba(0,0,0,0.65)', borderBottomWidth: 4,
    marginVertical: 16, width: '100%',
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.30, shadowRadius: 22, elevation: 16,
  },
  onboardCardTitle: { color: '#D4AF37', fontSize: 11, letterSpacing: 3, fontWeight: 'bold', marginBottom: 12 },
  onboardBody:      { color: '#B8956A', fontSize: 14, lineHeight: 24, marginBottom: 4 },

  // Terms / Oath
  termRow:        { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 },
  termBox: {
    width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: 'rgba(212,175,55,0.3)',
    borderTopColor: 'rgba(255,255,255,0.10)', borderTopWidth: 1.5,
    borderBottomColor: 'rgba(0,0,0,0.6)', borderBottomWidth: 3,
    marginRight: 12, alignItems: 'center', justifyContent: 'center', marginTop: 2,
    backgroundColor: 'rgba(20,10,0,0.72)',
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.18, shadowRadius: 6, elevation: 4,
  },
  termBoxChecked: {
    backgroundColor: '#D4AF37', borderColor: '#D4AF37',
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.6, shadowRadius: 8, elevation: 6,
  },
  termCheck: { color: '#160B00', fontWeight: 'bold', fontSize: 14 },
  termText:  { color: '#8B7355', fontSize: 13, flex: 1, lineHeight: 20 },

  // ── Camera / face scan ──────────────────────────────────────────────────
  cameraContainer:      { flex: 1, backgroundColor: '#060300', alignItems: 'center' },
  progressBar:          { width: '100%', height: 3, backgroundColor: 'rgba(42,21,8,0.8)', marginTop: 8 },
  progressFill:         { height: 3, backgroundColor: '#D4AF37', shadowColor: '#D4AF37', shadowOffset: {width:0,height:0}, shadowOpacity: 0.8, shadowRadius: 6 },
  faceCounter:          { color: '#D4AF37', fontSize: 13, marginTop: 12, letterSpacing: 3 },
  faceTitle:            { color: '#F5E6C8', fontSize: 18, fontWeight: 'bold', marginBottom: 12, letterSpacing: 4 },
  camera:               { width: width, height: width * 1.2 },
  cameraPlaceholder:    { backgroundColor: '#060300', alignItems: 'center', justifyContent: 'center' },
  cameraPlaceholderText:{ fontSize: 60 },
  faceOvalContainer:    { flex: 1, alignItems: 'center', justifyContent: 'center' },
  photoRejectOverlay:   { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(180,20,20,0.88)', paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  photoRejectText:      { color: '#fff', fontSize: 14, fontWeight: 'bold', textAlign: 'center' },
  faceOval:             { width: width * 0.55, height: width * 0.75, borderRadius: (width * 0.75) / 2, borderWidth: 3, borderColor: '#D4AF37', borderStyle: 'dashed' },
  faceInstructionBox:   { alignItems: 'center', padding: 20, width: '100%' },
  faceIcon:             { fontSize: 36, marginBottom: 8 },
  faceInstruction:      { color: '#F5E6C8', fontSize: 18, fontWeight: 'bold', textAlign: 'center', letterSpacing: 1 },
  autoCountdownRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 24, gap: 12 },
  countdownRingSmall:   { width: 44, height: 44, borderRadius: 22, borderWidth: 3, borderColor: '#3a3020', alignItems: 'center', justifyContent: 'center' },
  countdownRingActive:  { borderColor: '#D4AF37' },
  countdownNumberSmall: { color: '#4a3a20', fontSize: 18, fontWeight: 'bold' },
  countdownNumberActive:{ color: '#D4AF37' },
  autoCapLabel:         { color: '#7A5C3A', fontSize: 14 },

  // ── Pose status bar (step 2) ────────────────────────────────────────────
  poseStatusBar:        { marginTop: 10, paddingVertical: 7, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', width: '100%' },
  poseStatusSearching:  { backgroundColor: 'rgba(80,60,20,0.35)' },
  poseStatusOk:         { backgroundColor: 'rgba(34,197,94,0.18)' },
  poseStatusBad:        { backgroundColor: 'rgba(239,68,68,0.18)' },
  poseStatusText:       { fontSize: 13, fontWeight: '600', textAlign: 'center' },
  poseTextSearching:    { color: '#9A7A4A' },
  poseTextOk:           { color: '#22c55e' },
  poseTextBad:          { color: '#ef4444' },

  // ── Liveness ────────────────────────────────────────────────────────────
  livenessRightCol: {
    position: 'absolute',
    right: 14,
    top: 16,
    alignItems: 'center',
    zIndex: 10,
    gap: 8,
  },
  livenessCard: {
    width: 84,
    height: 84,
    borderRadius: 12,
    backgroundColor: 'rgba(212, 175, 55, 0.93)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#D4AF37',
    shadowColor: '#D4AF37',
    shadowOpacity: 0.9,
    shadowRadius: 18,
    elevation: 14,
  },
  livenessCardOk: {
    backgroundColor: 'rgba(125, 184, 122, 0.93)',
    borderColor: '#7DB87A',
    shadowColor: '#7DB87A',
  },
  livenessNumText: { fontSize: 52, fontWeight: 'bold', color: '#160B00', lineHeight: 62 },
  livenessSay:     { color: '#D4AF37', fontSize: 10, fontWeight: 'bold', letterSpacing: 2 },
  tapConfirmBtn:   { backgroundColor: '#2A4A27', borderWidth: 1, borderColor: '#4A7A45', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24, marginTop: 10 },
  tapConfirmText:  { color: '#7DB87A', fontSize: 16, fontWeight: 'bold', letterSpacing: 1 },

  // Hand guide (right column, below number)
  handGuide: {
    alignItems: 'center',
    marginTop: 6,
    backgroundColor: 'rgba(30, 14, 2, 0.80)',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#6B3A1F',
    borderStyle: 'dashed',
    paddingVertical: 10,
    paddingHorizontal: 8,
    width: 84,
  },
  handGuideIcon:    { fontSize: 32, marginBottom: 4 },
  handCountdownRing:{ width: 40, height: 40, borderRadius: 20, borderWidth: 3, borderColor: '#D4AF37', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  handCountdownNum: { color: '#D4AF37', fontSize: 20, fontWeight: 'bold' },
  handGuideLabel:   { color: '#B8956A', fontSize: 9, textAlign: 'center', lineHeight: 13, letterSpacing: 0.5 },

  // ── Liveness voice UI ────────────────────────────────────────────────────
  micRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginBottom: 6,
  },
  micIcon:        { fontSize: 26 },
  listeningLabel: { color: '#D4AF37', fontSize: 13, fontWeight: 'bold', letterSpacing: 2 },
  transcriptText: {
    color: '#8B7355', fontSize: 12, fontStyle: 'italic', marginTop: 4,
    textAlign: 'center', paddingHorizontal: 20,
  },

  // Tap fallback box
  tapFallbackBox: {
    alignItems: 'center', marginTop: 16, paddingHorizontal: 24,
    paddingVertical: 16, marginHorizontal: 24,
    backgroundColor: 'rgba(30,14,4,0.7)',
    borderRadius: 16, borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)',
  },
  tapFallbackLabel: { color: '#8B7355', fontSize: 13, marginBottom: 12, textAlign: 'center' },
  tapFallbackNumBtn: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: 'rgba(212,175,55,0.15)',
    borderWidth: 2, borderColor: '#D4AF37',
    alignItems: 'center', justifyContent: 'center',
  },
  tapFallbackNumText: { fontSize: 48, fontWeight: 'bold', color: '#D4AF37', lineHeight: 54 },

  // ── Transaction seal verification — 3-step progress bar ────────────────
  txStepBar:        { flexDirection: 'row', gap: 6, marginHorizontal: 32, marginBottom: 8 },
  txStepSegment:    { flex: 1, height: 4, borderRadius: 2, backgroundColor: '#2A1508' },
  txStepSegmentDone:{ backgroundColor: '#D4AF37' },

  // Voice challenge (step 2) ────────────────────────────────────────────────
  txVoiceContainer: { alignItems: 'center', paddingVertical: 24, width: '100%', paddingHorizontal: 32 },
  txVoicePrompt:    { color: '#8B7355', fontSize: 14, marginBottom: 20 },
  txVoiceCard:      { width: 120, height: 120, borderRadius: 16, backgroundColor: 'rgba(212,175,55,0.12)', borderWidth: 2, borderColor: '#D4AF37', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  txVoiceNum:       { fontSize: 72, fontWeight: 'bold', color: '#D4AF37', lineHeight: 80 },
  txVoiceSub:       { color: '#4A2E10', fontSize: 12, fontStyle: 'italic', marginBottom: 24 },

  // ── Re-auth ─────────────────────────────────────────────────────────────
  reAuthHeader: { alignItems: 'center', paddingVertical: 20 },
  reAuthIcon:   { fontSize: 48, marginBottom: 8 },
  reAuthTitle:  { color: '#D4AF37', fontSize: 20, fontWeight: 'bold', letterSpacing: 3, marginBottom: 4 },
  reAuthSub:    { color: '#8B7355', fontSize: 14, textAlign: 'center' },
  countdownContainer: { alignItems: 'center', paddingVertical: 20, width: '100%', paddingHorizontal: 32 },
  countdownRing:      { width: 80, height: 80, borderRadius: 40, borderWidth: 4, borderColor: '#D4AF37', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  countdownNumber:    { color: '#D4AF37', fontSize: 36, fontWeight: 'bold' },
  countdownLabel:     { color: '#7A5C3A', fontSize: 14 },

  // ── Formation (step 5) — Forge Scene ────────────────────────────────────
  forgeScene: {
    alignItems: 'center', paddingTop: 32, paddingBottom: 16,
    backgroundColor: '#050200',
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,175,55,0.08)',
  },
  galaxyLabel: { color: '#3A2408', fontSize: 11, letterSpacing: 3, marginBottom: 12 },

  forgeContainer:  { width: 220, height: 220, alignSelf: 'center', marginBottom: 4 },
  hammerWrap:      { position: 'absolute', top: 4, left: 64, zIndex: 3 },
  forgeSparks:     { position: 'absolute', top: 120, left: 46, zIndex: 2 },
  forgeAnvilSect:  { position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center', zIndex: 1 },
  forgeLogoWrap:   { marginBottom: -12 },
  anvilTop:        { width: 154, height: 24, backgroundColor: '#3A3525', borderRadius: 4 },
  anvilBody:       { width: 68,  height: 44, backgroundColor: '#2E2A1A' },
  anvilBase:       { width: 154, height: 20, backgroundColor: '#3A3525', borderRadius: 4 },

  starDayLabel: { color: '#D4AF37', fontSize: 14, fontWeight: 'bold', letterSpacing: 4, marginTop: 8 },
  formProgressBar: {
    width: width * 0.72, height: 4, backgroundColor: 'rgba(42,21,8,0.6)',
    borderRadius: 2, marginTop: 14, overflow: 'hidden',
  },
  formProgressFill: {
    height: 4, backgroundColor: '#D4AF37', borderRadius: 2,
    shadowColor: '#D4AF37', shadowOffset: {width:0,height:0}, shadowOpacity:0.8, shadowRadius:4,
  },
  streakText: { color: '#C4903A', fontSize: 14, letterSpacing: 0.5 },

  // Locked share card — glass with gold border glow
  lockedCard: {
    backgroundColor: 'rgba(12,6,0,0.85)',
    margin: 16, padding: 22, borderRadius: 18, alignItems: 'center',
    borderWidth: 1.5, borderColor: 'rgba(212,175,55,0.5)',
    borderTopColor: 'rgba(255,255,255,0.10)', borderTopWidth: 1.5,
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.4, shadowRadius: 24, elevation: 16,
  },
  lockedLabel:  { color: '#D4AF37', fontSize: 11, letterSpacing: 3, marginBottom: 8 },
  lockedAmount: { color: '#F5E6C8', fontSize: 30, fontWeight: 'bold', letterSpacing: 1 },
  lockedLock:   { color: '#7A5C3A', fontSize: 13, marginTop: 8 },
  meltBadge:    { color: '#D4AF37', fontSize: 11, marginTop: 6, fontWeight: 'bold', letterSpacing: 1 },

  // Identity melt cards
  meltSection: { margin: 16, marginTop: 4 },
  meltTitle:   { color: '#D4AF37', fontSize: 13, fontWeight: 'bold', letterSpacing: 3, marginBottom: 10 },
  meltSub:     { color: '#7A5C3A', fontSize: 12, lineHeight: 18, marginBottom: 14 },
  meltFooter:  { color: '#4A2E10', fontSize: 11, textAlign: 'center', marginTop: 12, fontStyle: 'italic' },

  kycBox: {
    backgroundColor: 'rgba(15,8,0,0.7)',
    borderLeftWidth: 3, borderLeftColor: 'rgba(212,175,55,0.25)',
    borderRadius: 10, padding: 14, marginBottom: 14,
  },
  kycHeading: { color: '#8B6030', fontSize: 12, fontWeight: 'bold', letterSpacing: 1.5, marginBottom: 8 },
  kycBody:    { color: '#5A3D1A', fontSize: 12, lineHeight: 20, fontStyle: 'italic' },

  idCard: {
    backgroundColor: 'rgba(20,10,2,0.75)',
    borderRadius: 12, borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.12)',
    borderTopColor: 'rgba(255,255,255,0.05)', borderTopWidth: 1,
    marginBottom: 8, overflow: 'hidden',
  },
  idCardFilled: {
    borderColor: 'rgba(125,184,122,0.4)',
    shadowColor: '#7DB87A', shadowOffset: {width:0,height:4}, shadowOpacity:0.2, shadowRadius:8, elevation:4,
  },
  idCardHeader:    { flexDirection: 'row', alignItems: 'center', padding: 14 },
  idCardIconWrap:  { marginRight: 10, width: 22, alignItems: 'center' },
  idCardLabel:     { color: '#8B7355', fontSize: 13, fontWeight: 'bold', letterSpacing: 0.5 },
  idCardLabelFilled:{ color: '#7DB87A' },
  idCardPreview:   { color: '#5A7A56', fontSize: 11, marginTop: 2 },
  idCardWorth:     { color: '#C4903A', fontSize: 12, fontWeight: 'bold', marginRight: 8 },
  idCardChevron:   { color: '#4A2E10', fontSize: 11 },
  idCardInput: {
    backgroundColor: 'rgba(10,5,0,0.9)', color: '#E8C87A', padding: 14,
    borderTopWidth: 1, borderTopColor: 'rgba(212,175,55,0.15)',
    fontFamily: 'monospace', fontSize: 14,
  },

  // Ignite button — the call to action
  btnIgnite: {
    backgroundColor: '#C9A832', margin: 16, padding: 20, borderRadius: 18,
    alignItems: 'center',
    borderTopColor: 'rgba(255,255,255,0.2)', borderTopWidth: 1.5,
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.7, shadowRadius: 24, elevation: 20,
  },
  btnIgniteText: { color: '#0E0700', fontWeight: 'bold', fontSize: 16, letterSpacing: 2 },

  btnCheckIn: {
    backgroundColor: 'rgba(26,42,58,0.8)', margin: 16, padding: 16, borderRadius: 14,
    alignItems: 'center', borderWidth: 1, borderColor: 'rgba(74,110,140,0.5)',
    borderTopColor: 'rgba(255,255,255,0.07)', borderTopWidth: 1,
  },
  btnCheckedIn: { backgroundColor: 'rgba(26,42,24,0.8)', borderColor: 'rgba(74,122,69,0.5)' },

  missionCard: {
    backgroundColor: 'rgba(28,10,2,0.80)', margin: 16, padding: 20, borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.18)',
    borderTopColor: 'rgba(255,255,255,0.07)', borderTopWidth: 1.5,
    alignItems: 'center',
    shadowColor: '#D4AF37', shadowOffset: {width:0,height:4}, shadowOpacity:0.12, shadowRadius:12, elevation:6,
  },
  missionTitle: { color: '#D4AF37', fontSize: 11, letterSpacing: 3, fontWeight: 'bold', marginBottom: 12 },
  missionIcon:  { fontSize: 40, marginBottom: 10 },
  missionTask:  { color: '#B8956A', fontSize: 15, textAlign: 'center', lineHeight: 22, marginBottom: 16 },
  btnMission: {
    backgroundColor: 'rgba(42,26,8,0.8)', padding: 14, borderRadius: 12,
    alignItems: 'center', width: '100%',
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.2)',
  },
  btnMissionDone: { backgroundColor: 'rgba(26,42,24,0.8)', borderColor: 'rgba(58,90,55,0.4)' },

  gatesCard: {
    backgroundColor: 'rgba(28,10,2,0.80)', margin: 16, padding: 20, borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.12)',
    borderTopColor: 'rgba(255,255,255,0.05)', borderTopWidth: 1,
  },
  gateRow:        { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  gateIcon:       { fontSize: 16, marginRight: 10, width: 24 },
  gateGreen:      {},
  gateYellow:     {},
  gateGray:       { opacity: 0.4 },
  gateLabel:      { color: '#B8956A', fontSize: 13, letterSpacing: 0.5 },
  gateLabelFaded: { color: '#3A2008' },

  // ── Ignition (step 6) ───────────────────────────────────────────────────
  ignitionTitle:  { fontSize: 44, color: '#D4AF37', fontWeight: 'bold', letterSpacing: 8, textAlign: 'center', marginBottom: 8 },
  ignitionSub:    { fontSize: 18, color: '#B8956A', fontStyle: 'italic', textAlign: 'center', marginBottom: 20, letterSpacing: 1 },
  ignitionAmount: { fontSize: 40, color: '#D4AF37', fontWeight: 'bold', textAlign: 'center', marginTop: 8, letterSpacing: -1 },
  ignitionCoin:   { fontSize: 22, color: '#7DB87A', fontWeight: 'bold', textAlign: 'center', letterSpacing: 5, marginBottom: 12 },
  ignitionMsg:    { color: '#8B7355', fontSize: 13, textAlign: 'center', lineHeight: 22 },

  // ── QR seal / recipient verify ─────────────────────────────────────────
  myQrWrap: {
    alignItems: 'center', paddingVertical: 16,
    borderTopWidth: 1, borderTopColor: 'rgba(212,175,55,0.15)', marginTop: 12,
  },
  qrLabel: {
    color: '#B8956A', fontSize: 12, letterSpacing: 1.5, marginTop: 12, textAlign: 'center',
  },
  recipientRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10,
  },
  qrScanBtn: {
    width: 48, height: 48, borderRadius: 12,
    backgroundColor: 'rgba(212,175,55,0.08)',
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  // QR frame overlay on camera
  qrOverlay: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  qrFrame: {
    width: 200, height: 200,
    position: 'relative',
  },
  qrCorner: {
    position: 'absolute', width: 28, height: 28,
    borderColor: '#D4AF37', borderWidth: 3,
  },
  qrTL: { top: 0, left: 0,  borderRightWidth: 0, borderBottomWidth: 0 },
  qrTR: { top: 0, right: 0, borderLeftWidth: 0,  borderBottomWidth: 0 },
  qrBL: { bottom: 0, left: 0,  borderRightWidth: 0, borderTopWidth: 0 },
  qrBR: { bottom: 0, right: 0, borderLeftWidth: 0,  borderTopWidth: 0 },
  qrHint: {
    color: '#D4AF37', fontSize: 13, letterSpacing: 1, marginTop: 16,
    textAlign: 'center',
  },
});
