// mobile/self_qr.js — the ignition QR (Self protocol, self-hosted "Self Pass" path).
//
// Builds the SelfApp config a phone scans, and renders it as an SVG QR. Pure and
// offline: no React, no CDN, no network call at render time. The whole point of
// this module is the ONE line marked BINDING below.
//
// BINDING: the M_ wallet travels in `userDefinedData`, which the Self app copies
// into `userContextData`, whose ripemd160(sha256(...)) digest is a PUBLIC SIGNAL of
// the zk proof. So the wallet is sealed into the proof by the circuit itself — a
// relay cannot swap it without invalidating the proof. self_gate.js recovers it and
// refuses to mint if it disagrees with the wallet being ignited. userId is NOT used
// as the carrier: with userIdType 'hex' the SDK returns it re-cast to a 20-byte
// Ethereum-shaped address, which does not round-trip a 16-byte M_ mark cleanly.
'use strict';

const { SelfAppBuilder, getUniversalLink } = require('@selfxyz/common');
const QRCode = require('qrcode-svg');

const WALLET_RE = /^M_[0-9A-Fa-f]{32}$/i;

// Mock mode must also switch the Self endpoint to staging — a mock passport is not
// registered on the production identity tree, so a prod endpoint would reject it.
const isMock = (env = process.env) => env.SELF_MOCK === '1';

function selfConfig(env = process.env) {
  return {
    appName:      env.SELF_APP_NAME || 'MONEY',
    scope:        env.SELF_SCOPE    || 'money-app',
    endpoint:     env.SELF_ENDPOINT || 'https://api.moneyforeveryone.app/ignite/self',
    endpointType: isMock(env) ? 'staging_https' : 'https',
    devMode:      isMock(env),
  };
}

// The SelfApp a phone scans to ignite `wallet`.
function buildSelfApp(wallet, env = process.env) {
  const w = String(wallet || '').trim().toUpperCase();
  if (!WALLET_RE.test(w)) throw new Error('Invalid seal mark — must be M_ followed by 32 hex characters.');
  const cfg = selfConfig(env);
  return new SelfAppBuilder({
    appName:      cfg.appName,
    scope:        cfg.scope,
    endpoint:     cfg.endpoint,
    endpointType: cfg.endpointType,
    devMode:      cfg.devMode,
    userId:       '0x' + '0'.repeat(40),   // unused as a carrier — see BINDING above
    userIdType:   'hex',
    userDefinedData: w,                    // ← BINDING: the wallet, verbatim
    disclosures:  {},                      // personhood only: disclose nothing else
  }).build();
}

const igniteLink = (wallet, env = process.env) => getUniversalLink(buildSelfApp(wallet, env));

function igniteQrSvg(wallet, env = process.env) {
  return new QRCode({
    content: igniteLink(wallet, env),
    padding: 2, width: 320, height: 320,
    color: '#0E0700', background: '#FFFFFF',
    ecl: 'M', join: true, container: 'svg-viewbox',
  }).svg();
}

module.exports = { buildSelfApp, igniteLink, igniteQrSvg, selfConfig, isMock, WALLET_RE };
