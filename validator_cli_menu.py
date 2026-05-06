import random
import time
import json
from hashlib import sha256
from datetime import datetime

ledger = {}  # address: balance
faucet_wallet = {'address': 'FAUCET', 'balance': 999_999_999_999}
confirmed_transactions = []
cooldown_ips = {}
VALIDATION_THRESHOLD = 500
FAUCET_BASE = 1_000_000  # First million users = 1,000,000 MONEY

def hash_transaction(tx):
    return sha256(json.dumps(tx, sort_keys=True).encode()).hexdigest()

def get_faucet_reward(user_count):
    """20% decay per million users — First million get 1,000,000 M"""
    millions = user_count // 1_000_000
    reward = FAUCET_BASE
    for _ in range(millions):
        reward = int(reward * 0.8)
    return max(reward, 1)

def validate_transaction(tx):
    tx_id = hash_transaction(tx)
    if any(t['id'] == tx_id for t in confirmed_transactions):
        return False, "Duplicate transaction"
    sender = tx['from']
    if sender != 'FAUCET' and ledger.get(sender, 0) < tx['amount']:
        return False, "Insufficient balance"
    return True, "Valid"

def simulate_validation(tx):
    tx_id = hash_transaction(tx)
    valid_count = 0
    selected_validators = random.sample(range(1000), 700)
    for _ in selected_validators:
        valid_count += 1
        if valid_count >= VALIDATION_THRESHOLD:
            break
    
    if valid_count >= VALIDATION_THRESHOLD:
        confirmed_transactions.append({
            'id': tx_id,
            'from': tx['from'],
            'to': tx['to'],
            'amount': tx['amount'],
            'time': datetime.now().strftime("%H:%M:%S")
        })
        sender = tx['from']
        receiver = tx['to']
        amount = tx['amount']
        if sender != 'FAUCET':
            ledger[sender] = ledger.get(sender, 0) - amount
        ledger[receiver] = ledger.get(receiver, 0) + amount
        print(f"✅ Confirmed! {amount:,} M from {sender} → {receiver}")
        return True
    else:
        print("❌ Not enough validators. Try again.")
        return False

def add_user(address):
    if address in ledger:
        print(f"User {address} already exists.")
        return
    reward = get_faucet_reward(len(ledger) + 1)
    tx = {'from': 'FAUCET', 'to': address, 'amount': reward}
    ok, msg = validate_transaction(tx)
    if ok:
        simulate_validation(tx)
        faucet_wallet['balance'] -= reward
        print(f"🎉 New user {address} received {reward:,} M")
    else:
        print(f"❌ Faucet error: {msg}")

def simulate_tx(from_addr, to_addr, amount):
    tx = {'from': from_addr, 'to': to_addr, 'amount': amount}
    ok, msg = validate_transaction(tx)
    if ok:
        simulate_validation(tx)
    else:
        print(f"❌ {msg}")

def print_ledger():
    print("\n📒 CURRENT LEDGER STATE")
    print(f"Total users: {len(ledger):,} | Faucet remaining: {faucet_wallet['balance']:,} M")
    for addr, bal in list(ledger.items())[:30]:
        print(f"{addr}: {bal:,} M")
    if len(ledger) > 30:
        print(f"... and {len(ledger)-30:,} more users")

def menu():
    while True:
        user_count = len(ledger) + 1
        current_reward = get_faucet_reward(user_count)
        print("\n=== MONEY Backend — Proof of Swarm ===")
        print(f"Users in swarm: {user_count:,} | Current reward for new user: {current_reward:,} M")
        print("1. Add new user (claim faucet)")
        print("2. Send transaction")
        print("3. View full ledger")
        print("4. Exit")
        choice = input("Choose an option: ")
        
        if choice == "1":
            user = input("Enter new user address: ").strip()
            add_user(user)
        elif choice == "2":
            fr = input("From address: ").strip()
            to = input("To address: ").strip()
            amt = int(input("Amount: "))
            simulate_tx(fr, to, amt)
        elif choice == "3":
            print_ledger()
        elif choice == "4":
            print("Swarm saved. Money. For Everyone. Forever.")
            break
        else:
            print("Invalid option.")

if __name__ == '__main__':
    print("🚀 MONEY Backend Swarm Started — Millionaire Faucet Active")
    menu()
