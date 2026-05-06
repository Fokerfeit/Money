import React, { useState } from 'react';
import { View, Text, TextInput, Button, Alert, StyleSheet, ScrollView, SafeAreaView, TouchableOpacity, Share } from 'react-native';

const formatMoney = (num) => Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function App() {
  const [address] = useState('luca_swarm_' + Math.random().toString(36).substring(2, 10).toUpperCase() + 'f');
  const [balance, setBalance] = useState(800000);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');

  const claimFaucet = () => {
    Alert.alert("🎉 Welcome to the Swarm", "You received 800,000 MONEY");
    setBalance(800000);
  };

  const sendMoney = () => {
    if (!recipient || !amount) return Alert.alert("Error", "Fill all fields");
    const amt = parseFloat(amount);
    if (amt > balance) return Alert.alert("Insufficient balance");
    setBalance(prev => prev - amt);
    Alert.alert("✅ Sent", `${formatMoney(amt)} MONEY sent`);
    setRecipient('');
    setAmount('');
  };

  const inviteFriends = () => {
    Share.share({
      message: `Join the Money Swarm!\nMy address: ${address}\nMoney. For Everyone. Forever.`,
      title: 'Money – Proof of Swarm'
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView>
        <View style={styles.header}>
          <Text style={styles.logo}>M</Text>
          <Text style={styles.subtitle}>Proof of Swarm</Text>
          <Text style={styles.tagline}>Money. For Everyone. Forever.</Text>
        </View>

        <View style={styles.balanceCard}>
          <Text style={styles.balanceLabel}>YOUR BALANCE</Text>
          <Text style={styles.balance}>{formatMoney(balance)} MONEY</Text>
        </View>

        <TouchableOpacity style={styles.button} onPress={inviteFriends}>
          <Text style={styles.buttonText}>Invite Friends to the Swarm</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.claimButton} onPress={claimFaucet}>
          <Text style={styles.buttonText}>CLAIM FAUCET</Text>
        </TouchableOpacity>

        <View style={styles.sendSection}>
          <TextInput style={styles.input} placeholder="Recipient address" value={recipient} onChangeText={setRecipient} />
          <TextInput style={styles.input} placeholder="Amount" keyboardType="numeric" value={amount} onChangeText={setAmount} />
          <Button title="SEND MONEY" onPress={sendMoney} color="#00D4FF" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: { alignItems: 'center', padding: 40, backgroundColor: '#111' },
  logo: { fontSize: 160, fontWeight: '900', color: '#D2B48C' },
  subtitle: { fontSize: 24, color: '#4CAF50' },
  tagline: { fontSize: 18, color: '#D2B48C' },
  balanceCard: { backgroundColor: '#1f1f1f', margin: 20, padding: 30, borderRadius: 16, alignItems: 'center' },
  balanceLabel: { color: '#D2B48C', fontSize: 16 },
  balance: { color: '#4CAF50', fontSize: 42, fontWeight: 'bold' },
  button: { backgroundColor: '#FF9800', margin: 20, padding: 18, borderRadius: 12, alignItems: 'center' },
  claimButton: { backgroundColor: '#4CAF50', margin: 20, padding: 18, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#000', fontWeight: 'bold', fontSize: 17 },
  sendSection: { padding: 20 },
  input: { backgroundColor: '#222', color: '#fff', padding: 16, marginVertical: 8, borderRadius: 12 }
});