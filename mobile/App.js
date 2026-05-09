import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, Alert, StyleSheet, ScrollView,
  SafeAreaView, TouchableOpacity, Share, Image, AppState
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKEND_URL = 'http://192.168.4.34:3000';
const DISCONNECT_GRACE_MS = 5 * 60 * 1000; // 5 min grace period

const formatMoney = (num) =>
  Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const generateAddress = () =>
  'swarm_' + Math.random().toString(36).substring(2, 9).toUpperCase() +
  '_' + Math.random().toString(36).substring(2, 6).toUpperCase();

export default function App() {
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState(0);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [userCount] = useState(1240000);
  const [allTransactions, setAllTransactions] = useState([]);
  const [claimed, setClaimed] = useState(false);
  const [penaltyWarning, setPenaltyWarning] = useState(false);

  const backgroundTimer = useRef(null);
  const appState = useRef(AppState.currentState);

  // ── Persistent wallet address ──────────────────────────────────────────────
  useEffect(() => {
    const loadOrCreateAddress = async () => {
      try {
        let stored = await AsyncStorage.getItem('wallet_address');
        if (!stored) {
          stored = generateAddress();
          await AsyncStorage.setItem('wallet_address', stored);
        }
        setAddress(stored);
      } catch {
        setAddress(generateAddress());
      }
    };
    loadOrCreateAddress();
  }, []);

  // ── Load claimed state ─────────────────────────────────────────────────────
  useEffect(() => {
    const loadClaimed = async () => {
      const c = await AsyncStorage.getItem('faucet_claimed');
      if (c === 'true') setClaimed(true);
    };
    loadClaimed();
  }, []);

  // ── Sync ledger & recalculate balance ─────────────────────────────────────
  const loadLedger = async () => {
    if (!address) return;
    try {
      const res = await fetch(`${BACKEND_URL}/ledger`);
      const data = await res.json();
      setAllTransactions(data);

      // Recalculate balance from ledger
      let bal = 0;
      data.forEach(tx => {
        if (tx.to === address) bal += tx.amount;
        if (tx.from === address) bal -= tx.amount;
      });
      setBalance(Math.max(0, parseFloat(bal.toFixed(2))));
    } catch {}
  };

  useEffect(() => {
    if (!address) return;
    loadLedger();
    const interval = setInterval(loadLedger, 3000);
    return () => clearInterval(interval);
  }, [address]);

  // ── Intentional disconnect penalty ────────────────────────────────────────
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (appState.current === 'active' && nextState === 'background') {
        // Start grace period timer
        backgroundTimer.current = setTimeout(() => {
          setPenaltyWarning(true);
          applyDisconnectPenalty();
        }, DISCONNECT_GRACE_MS);
      }
      if (nextState === 'active') {
        clearTimeout(backgroundTimer.current);
        setPenaltyWarning(false);
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
  }, [balance]);

  const applyDisconnectPenalty = async () => {
    try {
      const BASE_PENALTY = 100;
      const penalty = BASE_PENALTY * 2; // 2× for intentional disconnect
      await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: address,
          to: 'SWARM_RESERVE',
          amount: penalty,
          reason: 'disconnect_penalty'
        })
      });
    } catch {}
  };

  // ── Faucet reward ──────────────────────────────────────────────────────────
  const getFaucetReward = () => {
    const millions = Math.floor(userCount / 1000000);
    let reward = 1000000;
    for (let i = 0; i < millions; i++) reward *= 0.8;
    return Math.max(Math.floor(reward), 1);
  };

  const claimFaucet = async () => {
    if (claimed) return Alert.alert('Already Claimed', 'One faucet per wallet.');
    const reward = getFaucetReward();
    try {
      await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'FAUCET', to: address, amount: reward })
      });
      await AsyncStorage.setItem('faucet_claimed', 'true');
      setClaimed(true);
      Alert.alert(
        '🎉 YOU ARE A MILLIONAIRE!',
        `${formatMoney(reward)} MONEY\nWelcome to the Swarm.`
      );
    } catch {
      Alert.alert('Error', 'Backend not reachable');
    }
  };

  // ── Send ───────────────────────────────────────────────────────────────────
  const sendMoney = async () => {
    if (!recipient || !amount) return Alert.alert('Error', 'Fill all fields');
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return Alert.alert('Error', 'Invalid amount');
    if (amt > balance) return Alert.alert('Insufficient Balance');
    try {
      await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: address, to: recipient, amount: amt })
      });
      Alert.alert('✅ Sent', `${formatMoney(amt)} MONEY sent`);
      setRecipient('');
      setAmount('');
    } catch {
      Alert.alert('Error', 'Backend not reachable');
    }
  };

  // ── Invite ─────────────────────────────────────────────────────────────────
  const inviteFriends = async () => {
    try {
      await Share.share({
        message:
          `I just joined the Swarm and became a MILLIONAIRE.\n` +
          `No banks. No CEOs. Just people and phones.\n\n` +
          `My address: ${address}\n\n` +
          `Money. For Everyone. Forever.`,
        title: 'MONEY — Proof of Swarm'
      });
    } catch {}
  };

  const currentReward = getFaucetReward();

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView>

        {/* HEADER */}
        <View style={styles.header}>
          <View style={styles.logoWrap}>
            <Image source={require('./assets/logo.png')} style={styles.logo} resizeMode="contain"/>
          </View>
          <Text style={styles.subtitle}>Proof of Swarm</Text>
          <Text style={styles.tagline}>Money. For Everyone. Forever.</Text>
          <Text style={styles.swarmStatus}>
            {Math.floor(userCount / 1000000)}M phones · New user reward: {formatMoney(currentReward)} MONEY
          </Text>
        </View>

        {/* PENALTY WARNING */}
        {penaltyWarning && (
          <View style={styles.penaltyBanner}>
            <Text style={styles.penaltyText}>
              ⚠️ Disconnecting from the Swarm costs 2× penalty. Stay connected to protect the network.
            </Text>
          </View>
        )}

        {/* WALLET */}
        <TouchableOpacity
          style={styles.walletCard}
          onPress={() => Alert.alert('Your Address', address)}
        >
          <Text style={styles.walletLabel}>CLAY TABLET WALLET</Text>
          <Text style={styles.walletAddress} numberOfLines={1}>{address}</Text>
          <Text style={styles.copyHint}>Tap to view full address · Ancient & Future</Text>
        </TouchableOpacity>

        {/* BALANCE */}
        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>YOUR BALANCE</Text>
          <Text style={styles.balance}>{formatMoney(balance)} MONEY</Text>
          {balance >= 1000000 && (
            <Text style={styles.millionaire}>🎉 YOU ARE ONE OF THE FIRST MILLIONAIRES</Text>
          )}
        </View>

        {/* INVITE */}
        <TouchableOpacity style={styles.inviteButton} onPress={inviteFriends}>
          <Text style={styles.inviteText}>Invite Friends to the Swarm</Text>
        </TouchableOpacity>

        {/* CLAIM */}
        <TouchableOpacity
          style={[styles.claimButton, claimed && styles.claimButtonDone]}
          onPress={claimFaucet}
          disabled={claimed}
        >
          <Text style={styles.claimText}>
            {claimed ? '✅ FAUCET CLAIMED' : `CLAIM YOUR ${formatMoney(currentReward)} MONEY`}
          </Text>
        </TouchableOpacity>

        {/* SEND */}
        <View style={styles.sendSection}>
          <Text style={styles.sectionTitle}>SEND & RECEIVE</Text>
          <TextInput
            style={styles.input}
            placeholder="Recipient Clay Address"
            placeholderTextColor="#555"
            value={recipient}
            onChangeText={setRecipient}
          />
          <TextInput
            style={styles.input}
            placeholder="Amount"
            placeholderTextColor="#555"
            keyboardType="numeric"
            value={amount}
            onChangeText={setAmount}
          />
          <TouchableOpacity style={styles.sendButton} onPress={sendMoney}>
            <Text style={styles.sendText}>SEND MONEY</Text>
          </TouchableOpacity>
        </View>

        {/* LEDGER */}
        <View style={styles.ledgerSection}>
          <Text style={styles.sectionTitle}>PUBLIC LEDGER (Clay Tablets)</Text>
          {allTransactions.length === 0 ? (
            <Text style={styles.empty}>No Clay Tablets yet. Be the first.</Text>
          ) : (
            allTransactions.map((tx, i) => (
              <View key={i} style={[styles.txCard, tx.reason === 'disconnect_penalty' && styles.txPenalty]}>
                <Text style={styles.txAddress} numberOfLines={1}>{tx.from} → {tx.to}</Text>
                <Text style={styles.txAmount}>
                  {tx.reason === 'disconnect_penalty' ? '⚠️ ' : ''}{formatMoney(tx.amount)} MONEY
                </Text>
                <Text style={styles.txTime}>{tx.time}</Text>
              </View>
            ))
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },

  header: { alignItems: 'center', padding: 30, paddingTop: 40, backgroundColor: '#111' },
  logoWrap: {
    width: 140, height: 140, borderRadius: 70, overflow: 'hidden',
    marginBottom: 16,
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6, shadowRadius: 20, elevation: 12
  },
  logo: { width: 140, height: 140 },
  subtitle: { fontSize: 22, color: '#4CAF50', marginBottom: 6 },
  tagline: { fontSize: 17, color: '#D2B48C', fontStyle: 'italic' },
  swarmStatus: { color: '#FF9800', fontSize: 14, marginTop: 8 },

  penaltyBanner: {
    backgroundColor: '#3a1a00', margin: 16, padding: 14,
    borderRadius: 10, borderLeftWidth: 4, borderLeftColor: '#FF5722'
  },
  penaltyText: { color: '#FF8A65', fontSize: 13 },

  walletCard: {
    backgroundColor: '#1f1f1f', margin: 20, padding: 20,
    borderRadius: 16, alignItems: 'center', borderWidth: 2, borderColor: '#8B4513'
  },
  walletLabel: { color: '#D2B48C', fontSize: 12, letterSpacing: 2 },
  walletAddress: { color: '#fff', fontSize: 13, marginVertical: 8, fontFamily: 'monospace' },
  copyHint: { color: '#444', fontSize: 11 },

  balanceCard: {
    backgroundColor: '#1f1f1f', margin: 20, padding: 28,
    borderRadius: 16, alignItems: 'center', borderWidth: 2, borderColor: '#8B4513'
  },
  balanceLabel: { color: '#D2B48C', fontSize: 14, letterSpacing: 2 },
  balance: { color: '#4CAF50', fontSize: 40, fontWeight: 'bold', marginTop: 6 },
  millionaire: { color: '#FFD700', fontSize: 13, marginTop: 10, fontWeight: 'bold', textAlign: 'center' },

  inviteButton: {
    backgroundColor: '#FF9800', marginHorizontal: 20, marginBottom: 10,
    padding: 16, borderRadius: 12, alignItems: 'center'
  },
  inviteText: { color: '#000', fontWeight: 'bold', fontSize: 15 },

  claimButton: {
    backgroundColor: '#4CAF50', marginHorizontal: 20, marginBottom: 20,
    padding: 16, borderRadius: 12, alignItems: 'center'
  },
  claimButtonDone: { backgroundColor: '#1a3a1a' },
  claimText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },

  sendSection: { padding: 20 },
  sectionTitle: { color: '#D2B48C', fontSize: 16, marginBottom: 14, letterSpacing: 1 },
  input: {
    backgroundColor: '#1a1a1a', color: '#fff', padding: 14,
    marginVertical: 7, borderRadius: 12, borderWidth: 1, borderColor: '#333'
  },
  sendButton: {
    backgroundColor: '#2196F3', padding: 14, borderRadius: 12,
    alignItems: 'center', marginTop: 6
  },
  sendText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },

  ledgerSection: { padding: 20, paddingBottom: 40 },
  txCard: {
    backgroundColor: '#1f1f1f', marginVertical: 6, padding: 14,
    borderRadius: 12, borderLeftWidth: 5, borderLeftColor: '#8B4513'
  },
  txPenalty: { borderLeftColor: '#FF5722' },
  txAddress: { color: '#888', fontSize: 12 },
  txAmount: { color: '#4CAF50', fontSize: 17, fontWeight: 'bold', marginVertical: 2 },
  txTime: { color: '#444', fontSize: 11 },
  empty: { color: '#444', textAlign: 'center', marginTop: 30, fontStyle: 'italic' }
});
