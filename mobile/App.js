import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, Alert, StyleSheet, ScrollView, SafeAreaView, TouchableOpacity, Share, Image
} from 'react-native';

const BACKEND_URL = 'http://192.168.4.34:3000';

const formatMoney = (num) => {
  return Number(num).toLocaleString('en-US', { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  });
};

export default function App() {
  const [address] = useState('luca_swarm_' + Math.random().toString(36).substring(2, 10).toUpperCase() + 'f');
  const [balance, setBalance] = useState(800000);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [userCount, setUserCount] = useState(1240000);
  const [allTransactions, setAllTransactions] = useState([]);

  const getFaucetReward = () => {
    const millions = Math.floor(userCount / 1000000);
    let reward = 1000000;
    for (let i = 0; i < millions; i++) reward *= 0.8;
    return Math.max(Math.floor(reward), 10);
  };

  const loadLedger = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/ledger`);
      const data = await res.json();
      setAllTransactions(data);
    } catch (e) {
      console.log('Ledger sync failed');
    }
  };

  useEffect(() => {
    loadLedger();
    const interval = setInterval(loadLedger, 3000);
    return () => clearInterval(interval);
  }, []);

  const claimFaucet = async () => {
    if (balance > 100) return Alert.alert('Already Claimed');
    const reward = getFaucetReward();
    try {
      await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'FAUCET', to: address.substring(0,12) + '...', amount: reward })
      });
      setBalance(reward);
      Alert.alert('🎉 Welcome', `You received ${formatMoney(reward)} MONEY`);
    } catch (e) {
      Alert.alert('Error', 'Backend not reachable');
    }
  };

  const sendMoney = async () => {
    if (!recipient || !amount) return Alert.alert('Error', 'Fill all fields');
    const amt = parseFloat(amount);
    if (amt > balance) return Alert.alert('Insufficient balance');
    try {
      await fetch(`${BACKEND_URL}/transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          from: address.substring(0,12) + '...', 
          to: recipient.substring(0,12) + '...', 
          amount: amt 
        })
      });
      setBalance(prev => parseFloat((prev - amt).toFixed(2)));
      Alert.alert('✅ Sent', `${formatMoney(amt)} MONEY sent`);
      setRecipient('');
      setAmount('');
      loadLedger();
    } catch (e) {
      Alert.alert('Error', 'Backend not reachable');
    }
  };

  const inviteFriends = async () => {
    try {
      await Share.share({
        message: `Join the Money Swarm!\nMy address: ${address}\n\nMoney. For Everyone. Forever.`,
        title: 'Money – Proof of Swarm'
      });
    } catch (error) {
      Alert.alert('Share failed', error.message);
    }
  };

  const currentReward = getFaucetReward();

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView>
        <View style={styles.header}>
          <View style={styles.logoContainer}>
            <Image 
              source={require('../assets/m-logo.png')} 
              style={styles.logoImage}
              resizeMode="contain"
            />
          </View>
          <Text style={styles.subtitle}>Proof of Swarm</Text>
          <Text style={styles.tagline}>Money. For Everyone. Forever.</Text>
          <Text style={styles.swarmStatus}>
            {Math.floor(userCount/1000000)}M phones • New user reward: {formatMoney(currentReward)} MONEY
          </Text>
        </View>

        <TouchableOpacity style={styles.walletCard} onPress={() => Alert.alert('Copied', address)}>
          <Text style={styles.walletLabel}>YOUR WALLET</Text>
          <Text style={styles.walletAddress}>{address}</Text>
          <Text style={styles.copyHint}>Tap to copy address</Text>
        </TouchableOpacity>

        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>YOUR BALANCE</Text>
          <Text style={styles.balance}>{formatMoney(balance)} MONEY</Text>
        </View>

        <TouchableOpacity style={styles.inviteButton} onPress={inviteFriends}>
          <Text style={styles.inviteText}>Invite Friends to the Swarm</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.claimButton} onPress={claimFaucet}>
          <Text style={styles.claimText}>CLAIM YOUR {formatMoney(currentReward)} MONEY</Text>
        </TouchableOpacity>

        <View style={styles.sendSection}>
          <Text style={styles.sectionTitle}>Send MONEY</Text>
          <TextInput style={styles.input} placeholder="Recipient address" value={recipient} onChangeText={setRecipient} />
          <TextInput style={styles.input} placeholder="Amount" keyboardType="numeric" value={amount} onChangeText={setAmount} />
          <Button title="SEND INTO THE SWARM" onPress={sendMoney} color="#00D4FF" />
        </View>

        <View style={styles.ledgerSection}>
          <Text style={styles.sectionTitle}>Public Ledger (Clay Tablets)</Text>
          {allTransactions.length === 0 ? (
            <Text style={styles.empty}>No clay tablets yet. Be the first in the swarm!</Text>
          ) : (
            allTransactions.slice(0, 10).map((tx, i) => (
              <View key={i} style={styles.txCard}>
                <Text style={styles.txFromTo}>{tx.from} → {tx.to}</Text>
                <Text style={styles.txAmount}>{formatMoney(tx.amount)} MONEY</Text>
                <Text style={styles.txTime}>{tx.time || 'Just now'}</Text>
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
  header: { alignItems: 'center', padding: 40, backgroundColor: '#111' },
  logoContainer: { marginBottom: 12 },
  logoImage: { width: 180, height: 180, tintColor: '#D2B48C' },
  subtitle: { fontSize: 24, color: '#4CAF50', marginBottom: 4 },
  tagline: { fontSize: 18, color: '#D2B48C', fontStyle: 'italic' },
  swarmStatus: { color: '#FF9800', fontSize: 16, marginTop: 8 },
  walletCard: { backgroundColor: '#1f1f1f', margin: 20, padding: 20, borderRadius: 16, borderWidth: 3, borderColor: '#8B4513', alignItems: 'center' },
  walletLabel: { color: '#D2B48C', fontSize: 14, fontWeight: 'bold' },
  walletAddress: { color: '#fff', fontSize: 16, marginVertical: 8, fontFamily: 'monospace' },
  copyHint: { color: '#666', fontSize: 12 },
  balanceCard: { backgroundColor: '#1f1f1f', margin: 20, padding: 30, borderRadius: 16, alignItems: 'center', borderWidth: 3, borderColor: '#8B4513' },
  balanceLabel: { color: '#D2B48C', fontSize: 16 },
  balance: { color: '#4CAF50', fontSize: 42, fontWeight: 'bold' },
  inviteButton: { backgroundColor: '#FF9800', marginHorizontal: 20, padding: 18, borderRadius: 12, alignItems: 'center', marginBottom: 12 },
  inviteText: { color: '#000', fontWeight: 'bold', fontSize: 17 },
  claimButton: { backgroundColor: '#4CAF50', marginHorizontal: 20, padding: 18, borderRadius: 12, alignItems: 'center', marginBottom: 20 },
  claimText: { color: '#fff', fontWeight: 'bold', fontSize: 17 },
  sendSection: { padding: 20 },
  sectionTitle: { color: '#D2B48C', fontSize: 20, marginBottom: 15, fontWeight: 'bold' },
  input: { backgroundColor: '#222', color: '#fff', padding: 16, marginVertical: 8, borderRadius: 12, fontSize: 16 },
  ledgerSection: { padding: 20 },
  txCard: { backgroundColor: '#1f1f1f', marginVertical: 8, padding: 16, borderRadius: 12, borderLeftWidth: 6, borderLeftColor: '#8B4513' },
  txFromTo: { color: '#ccc', fontSize: 14 },
  txAmount: { color: '#4CAF50', fontSize: 20, fontWeight: 'bold', marginVertical: 4 },
  txTime: { color: '#666', fontSize: 12 },
  empty: { color: '#666', textAlign: 'center', marginTop: 40, fontSize: 16 }
});