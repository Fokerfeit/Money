// ── MONEY — bottom tab bar + screen routing rules ─────────────────────────────
//
// The app has no router: App.js picks ONE screen per render. routeOf() is that
// pick, in the SAME order App.js uses, so the rules below are executable:
//
//   intro video → loading → LOCK → first-launch About → onboarding / backup /
//   restore / wallet
//
//  • The LOCK screen wins over everything after it — the first-launch About and
//    every wallet tab. (Before the tab bar, About was checked first and stayed on
//    screen over a re-lock.)
//  • The tab bar exists only on the wallet route (an unlocked, set-up wallet).
//    It is never drawn on onboarding (Oath / thumbs / PIN / seal / network picker /
//    ignition), the lock screen, the intro, loading, first-launch About, or the
//    backup (50) and restore (51) screens. It also steps aside while the
//    keyboard is open.
//  • Tabs only switch which pane is shown. They have no path to the lock,
//    the passcode, signing, or the send flow — the PIN-to-send confirmation is a
//    full-screen modal drawn above the whole wallet, tab bar included.
//  • Exactly one tab is highlighted: the current one.
//
// PURE module (no React Native), so test_tab_nav.js executes it.
'use strict';

const TABS = Object.freeze([
  Object.freeze({ key: 'wallet',   icon: '💰', label: 'Wallet' }),
  Object.freeze({ key: 'ledger',   icon: '📜', label: 'Ledger' }),
  Object.freeze({ key: 'contacts', icon: '📇', label: 'Contacts' }),
  Object.freeze({ key: 'human',    icon: '🛂', label: 'Human' }),
  Object.freeze({ key: 'about',    icon: 'ℹ️', label: 'About' }),
]);
const TAB_KEYS = TABS.map((t) => t.key);

const LOCK_STEP = 99, WALLET_STEP = 0, BACKUP_STEP = 50, RESTORE_STEP = 51;

// introActive: the intro video is playing · onboardingStep: null while loading ·
// showAboutScreen: the FIRST-LAUNCH About (the wallet's About is a tab, not this).
function routeOf({ introActive, onboardingStep, showAboutScreen } = {}) {
  if (introActive === true) return 'intro';
  if (onboardingStep === null || onboardingStep === undefined) return 'loading';
  if (onboardingStep === LOCK_STEP) return 'lock';            // lock beats everything below
  if (showAboutScreen === true) return 'about-first';
  if (onboardingStep === WALLET_STEP) return 'wallet';
  if (onboardingStep === BACKUP_STEP) return 'backup';
  if (onboardingStep === RESTORE_STEP) return 'restore';
  return 'onboarding';
}

// What the bar shows. `mainTab` outside the five keys falls back to the wallet.
function tabBarModel({ route, mainTab, keyboardOpen } = {}) {
  const current = TAB_KEYS.includes(mainTab) ? mainTab : 'wallet';
  return {
    visible: route === 'wallet' && keyboardOpen !== true,
    current,
    tabs: TABS.map((t) => ({ ...t, active: t.key === current })),
  };
}

// The restore screen's way out: "Back to wallet" when it returns to the wallet,
// "Cancel" when it returns into onboarding / the lock screen.
const restoreBackLabel = (target) => (target === WALLET_STEP ? 'Back to wallet' : 'Cancel');

module.exports = { TABS, TAB_KEYS, routeOf, tabBarModel, restoreBackLabel, LOCK_STEP, WALLET_STEP, BACKUP_STEP, RESTORE_STEP };
