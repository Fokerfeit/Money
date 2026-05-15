import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, Alert, StyleSheet, ScrollView,
  TouchableOpacity, Share, Image, AppState, SafeAreaView,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import nacl from 'tweetnacl';
import * as ExpoCrypto from 'expo-crypto';
import { BACKEND_URL, BASE_PENALTY, DISCONNECT_GRACE_MS, RESERVE_ADDRESS } from './config';

// ── Crypto ─────────────────────────────────────────────────────────────────
const toHex   = (arr) => Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));

const createKeypair = () => {
  // Use expo-crypto for secure random seed — bypasses nacl's getRandomValues dependency
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
// First 1,000,000 users → 1,000,000 MONEY each (everyone a millionaire)
// After that → decays 20% per additional million users
const calcReward = (count) => {
  const tiers = Math.floor(count / 1_000_000);
  let r = 1_000_000;
  for (let i = 0; i < tiers; i++) r *= 0.8;
  return Math.max(Math.floor(r), 1);
};

const fmt = (n) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── App ────────────────────────────────────────────────────────────────────
export default function App() {
  const [address,  setAddress]  = useState('');
  const [balance,  setBalance]  = useState(0);
  const [userCount, setUserCount] = useState(0);
  const [txs,      setTxs]      = useState([]);
  const [claimed,  setClaimed]  = useState(false);
  const [recipient, setRecipient] = useState('');
  const [amount,   setAmount]   = useState('');

  const addrRef      = useRef('');
  const pubKeyRef    = useRef('');
  const secKeyRef    = useRef('');
  const bgTimer      = useRef(null);
  const appStateRef  = useRef(AppState.currentState);

  // ── Load or create wallet ─────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        let stored = await AsyncStorage.getItem('keypair_v2');
        let kp;
        if (stored) {
          kp = JSON.parse(stored);
        } else {
          kp = createKeypair();
          await AsyncStorage.setItem('keypair_v2', JSON.stringify(kp));
        }
        setAddress(kp.address);
        addrRef.current   = kp.address;
        pubKeyRef.current = kp.publicKey;
        secKeyRef.current = kp.secretKey;
      } catch {
        const kp = createKeypair();
        setAddress(kp.address);
        addrRef.current   = kp.address;
        pubKeyRef.current = kp.publicKey;
        secKeyRef.current = kp.secretKey;
      }
    })();
  }, []);

  // ── Load claimed flag ─────────────────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem('claimed_v4')
      .then(v => { if (v === '1') setClaimed(true); })
      .catch(() => {});
  }, []);

  // ── Sync ledger + user count ──────────────────────────────────────────
  const sync = async () => {
    const addr = addrRef.current;
    if (!addr) return;
    try {
      const [lr, ur] = await Promise.all([
        fetch(`${BACKEND_URL}/ledger`),
        fetch(`${BACKEND_URL}/usercount`),
      ]);
      const ledger = await lr.json();
      const { count } = await ur.json();

      setTxs(ledger);
      setUserCount(count);

      const bal = ledger.reduce((b, t) => {
        if (t.to   === addr) return b + t.amount;
        if (t.from === addr) return b - t.amount;
        return b;
      }, 0);
      setBalance(Math.max(0, parseFloat(bal.toFixed(2))));
    } catch {}
  };

  useEffect(() => {
    if (!address) return;
    sync();
    const iv = setInterval(sync, 3000);
    return () => clearInterval(iv);
  }, [address]);

  // ── Disconnect penalty ────────────────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (appStateRef.current === 'active' && next === 'background') {
        bgTimer.current = setTimeout(applyPenalty, DISCONNECT_GRACE_MS);
      }
      if (next === 'active') clearTimeout(bgTimer.current);
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, []);

  const applyPenalty = async () => {
    try {
      const from      = addrRef.current;
      const amt       = BASE_PENALTY * 2;
      const timestamp = Date.now();
      const signature = signTx(from, RESERVE_ADDRESS, amt, timestamp, secKeyRef.current);
      await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: RESERVE_ADDRESS, amount: amt,
          reason: 'disconnect_penalty',
          signature, publicKey: pubKeyRef.current, timestamp,
        }),
      });
    } catch {}
  };

  // ── Claim faucet ──────────────────────────────────────────────────────
  const claim = async () => {
    if (!address) return Alert.alert('One moment', 'Wallet is still loading…');
    if (claimed) return;
    const reward = calcReward(userCount);
    try {
      const res  = await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'FAUCET', to: address, amount: reward }),
      });
      const data = await res.json();
      if (data.success) {
        await AsyncStorage.setItem('claimed_v4', '1').catch(() => {});
        setClaimed(true);
        Alert.alert('🎉 YOU ARE A MILLIONAIRE!', `${fmt(reward)} MONEY\nWelcome to the Swarm.`);
      } else {
        Alert.alert('Claim failed', data.error || 'Unknown error');
      }
    } catch (e) {
      Alert.alert('Connection error', e.message);
    }
  };

  // ── Send ──────────────────────────────────────────────────────────────
  const send = async () => {
    if (!recipient || !amount) return Alert.alert('Missing fields', 'Enter recipient and amount');
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return Alert.alert('Invalid', 'Amount must be positive');
    if (amt > balance) return Alert.alert('Insufficient balance');
    try {
      const timestamp = Date.now();
      const signature = signTx(address, recipient, amt, timestamp, secKeyRef.current);
      const res = await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: address, to: recipient, amount: amt,
          signature, publicKey: pubKeyRef.current, timestamp,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setRecipient('');
        setAmount('');
        Alert.alert('✅ Sent', `${fmt(amt)} MONEY sent`);
      } else {
        Alert.alert('Send failed', data.error);
      }
    } catch (e) {
      Alert.alert('Connection error', e.message);
    }
  };

  // ── Invite ────────────────────────────────────────────────────────────
  const invite = () =>
    Share.share({
      message:
        `I just joined the Swarm.\n` +
        `No banks. No CEOs. Just people and phones.\n\n` +
        `My address: ${address}\n\n` +
        `Money. For Everyone. Forever.`,
    }).catch(() => {});

  const reward = calcReward(userCount);
  const isMillion = reward === 1_000_000;

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.scroll}>

        {/* HEADER */}
        <View style={s.header}>
          <View style={s.logoRing}>
            <Image source={require('./assets/logo.png')} style={s.logo} resizeMode="contain" />
          </View>
          <Text style={s.title}>Proof of Swarm</Text>
          <Text style={s.tagline}>Money. For Everyone. Forever.</Text>
          <Text style={s.stat}>
            {userCount === 0
              ? 'Be the first — claim 1,000,000 MONEY'
              : `${userCount.toLocaleString()} users · next reward: ${fmt(reward)} MONEY`}
          </Text>
        </View>

        {/* WALLET */}
        <TouchableOpacity style={s.card} onPress={() => Alert.alert('Your Address', address)}>
          <Text style={s.label}>CLAY TABLET WALLET</Text>
          <Text style={s.addr} numberOfLines={1}>{address || '…'}</Text>
          <Text style={s.hint}>Tap to see full address</Text>
        </TouchableOpacity>

        {/* BALANCE */}
        <View style={s.card}>
          <Text style={s.label}>YOUR BALANCE</Text>
          <Text style={s.balance}>{fmt(balance)} MONEY</Text>
          {balance >= 1_000_000 && (
            <Text style={s.millionaire}>🎉 YOU ARE ONE OF THE FIRST MILLIONAIRES</Text>
          )}
        </View>

        {/* INVITE */}
        <TouchableOpacity style={s.btnOrange} onPress={invite}>
          <Text style={s.btnText}>Invite Friends to the Swarm</Text>
        </TouchableOpacity>

        {/* CLAIM */}
        <TouchableOpacity
          style={[s.btnGreen, claimed && s.btnDone]}
          onPress={claim}
          disabled={claimed || !address}
        >
          <Text style={s.btnText}>
            {claimed
              ? '✅ FAUCET CLAIMED'
              : isMillion
                ? `CLAIM YOUR 1,000,000 MONEY — BE A MILLIONAIRE`
                : `CLAIM YOUR ${fmt(reward)} MONEY`}
          </Text>
        </TouchableOpacity>

        {/* SEND */}
        <View style={s.section}>
          <Text style={s.label}>SEND MONEY</Text>
          <TextInput
            style={s.input}
            placeholder="Recipient address"
            placeholderTextColor="#555"
            value={recipient}
            onChangeText={setRecipient}
            autoCapitalize="none"
          />
          <TextInput
            style={s.input}
            placeholder="Amount"
            placeholderTextColor="#555"
            keyboardType="numeric"
            value={amount}
            onChangeText={setAmount}
          />
          <TouchableOpacity style={s.btnBlue} onPress={send}>
            <Text style={s.btnText}>SEND</Text>
          </TouchableOpacity>
        </View>

        {/* LEDGER */}
        <View style={s.section}>
          <Text style={s.label}>PUBLIC LEDGER — CLAY TABLETS</Text>
          {txs.length === 0
            ? <Text style={s.empty}>No transactions yet. Be the first.</Text>
            : txs.map((tx, i) => (
              <View key={i} style={[s.tx, tx.reason === 'disconnect_penalty' && s.txPenalty]}>
                <Text style={s.txAddr} numberOfLines={1}>{tx.from} → {tx.to}</Text>
                <Text style={s.txAmt}>
                  {tx.reason === 'disconnect_penalty' ? '⚠️ ' : ''}{fmt(tx.amount)} MONEY
                </Text>
                <Text style={s.txTime}>{tx.time}</Text>
              </View>
            ))}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: '#0a0a0a' },
  scroll: { paddingBottom: 60 },

  header: { alignItems: 'center', paddingVertical: 36, paddingHorizontal: 20, backgroundColor: '#111' },
  logoRing: {
    width: 130, height: 130, borderRadius: 65, overflow: 'hidden',
    marginBottom: 16,
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7, shadowRadius: 20, elevation: 14,
  },
  logo:    { width: 130, height: 130 },
  title:   { fontSize: 24, color: '#4CAF50', fontWeight: 'bold', marginBottom: 4 },
  tagline: { fontSize: 16, color: '#D2B48C', fontStyle: 'italic', marginBottom: 8 },
  stat:    { fontSize: 13, color: '#FF9800', textAlign: 'center' },

  card: {
    backgroundColor: '#1a1a1a', margin: 16, padding: 20,
    borderRadius: 16, alignItems: 'center',
    borderWidth: 1.5, borderColor: '#8B4513',
  },
  label:       { color: '#D2B48C', fontSize: 11, letterSpacing: 2, marginBottom: 8 },
  addr:        { color: '#fff', fontSize: 13, fontFamily: 'monospace' },
  hint:        { color: '#444', fontSize: 11, marginTop: 6 },
  balance:     { color: '#4CAF50', fontSize: 38, fontWeight: 'bold' },
  millionaire: { color: '#FFD700', fontSize: 12, marginTop: 8, fontWeight: 'bold', textAlign: 'center' },

  btnOrange: { backgroundColor: '#FF9800', margin: 16, marginBottom: 8, padding: 16, borderRadius: 12, alignItems: 'center' },
  btnGreen:  { backgroundColor: '#4CAF50', margin: 16, marginTop: 8,  padding: 16, borderRadius: 12, alignItems: 'center' },
  btnBlue:   { backgroundColor: '#2196F3', padding: 14, borderRadius: 12, alignItems: 'center', marginTop: 8 },
  btnDone:   { backgroundColor: '#1a3a1a' },
  btnText:   { color: '#fff', fontWeight: 'bold', fontSize: 15 },

  section: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  input: {
    backgroundColor: '#1a1a1a', color: '#fff', padding: 14,
    marginVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: '#333',
  },

  tx: {
    backgroundColor: '#1a1a1a', padding: 14, marginVertical: 5,
    borderRadius: 12, borderLeftWidth: 4, borderLeftColor: '#8B4513',
  },
  txPenalty: { borderLeftColor: '#FF5722' },
  txAddr:    { color: '#777', fontSize: 11 },
  txAmt:     { color: '#4CAF50', fontSize: 16, fontWeight: 'bold', marginVertical: 2 },
  txTime:    { color: '#444', fontSize: 11 },
  empty:     { color: '#444', textAlign: 'center', marginTop: 20, fontStyle: 'italic' },
});
