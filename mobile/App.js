// Latest App.js with new M logo
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
    } catch (e) {}
  };

  useEffect(() => {
    loadLedger();
    const interval = setInterval(loadLedger, 3000);
    return () => clearInterval(interval);
  }, []);

  // ... rest of the code (shortened for this call)
  // Full code will be provided in response
