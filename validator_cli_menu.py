
import random
import time
import json
from hashlib import sha256

ledger = {}
faucet_wallet = {'address': 'faucet', 'balance': 1_000_000}
confirmed_transactions = set()
cooldown_ips = {}
VALIDATION_THRESHOLD = 500
COOLDOWN_SECONDS = 600
FAUCET_AMOUNT = 500
validators = [{'ip': f'192.168.0.{i}', 'cooldown': 0} for i in range(1, 1001)]

def hash_transaction(tx):
    return sha256(json.dumps(tx, sort_keys=True).encode()).hexdigest()

def validate_transaction(tx):
    tx_id = hash_transaction(tx)
    if tx_id in confirmed_transactions:
        return False, "Duplicate transaction"
    sender = tx['from']
    if sender != 'faucet' and ledger.get(sender, 0) < tx['amount']:
        return False, "Insufficient balance"
    return True, "Valid"

def simulate_validation(tx):
    tx_id = hash_transaction(tx)
    valid_count = 0
    selected_validators = random.sample(validators, 700)
    for device in selected_validators:
        ip = device['ip']
        if ip in cooldown_ips and time.time() < cooldown_ips[ip]:
            continue
        valid_count += 1
        if valid_count >= VALIDATION_THRESHOLD:
            break
    if valid_count >= VALIDATION_THRESHOLD:
        confirmed_transactions.add(tx_id)
        sender = tx['from']
        receiver = tx['to']
        amount = tx['amount']
        if sender != 'faucet':
            ledger[sender] -= amount
        ledger[receiver] = ledger.get(receiver, 0) + amount
        print(f"✅ Confirmed! {amount} MONEY sent from {sender} to {receiver}")
    else:
        print("❌ Not enough validators. Try again.")

def add_user(address):
    if address in ledger:
        print(f"User {address} already exists.")
        return
    tx = {'from': 'faucet', 'to': address, 'amount': FAUCET_AMOUNT}
    ok, msg = validate_transaction(tx)
    if ok:
        simulate_validation(tx)
        faucet_wallet['balance'] -= FAUCET_AMOUNT
    else:
        print(f"❌ Faucet error: {msg}")

def simulate_tx(from_addr, to_addr, amount):
    tx = {'from': from_addr, 'to': to_addr, 'amount': amount}
    ok, msg = validate_transaction(tx)
    if ok:
        simulate_validation(tx)
    else:
        print(f"❌ {msg}")

def remove_device(ip):
    cooldown_ips[ip] = time.time() + COOLDOWN_SECONDS
    print(f"Device at {ip} put in cooldown for 10 minutes.")

def print_ledger():
    print("📒 Ledger:")
    for k, v in ledger.items():
        print(f"{k}: {v} MONEY")

def menu():
    while True:
        print("\n=== Money Validator CLI ===")
        print("1. Add new user")
        print("2. Send transaction")
        print("3. View ledger")
        print("4. Remove device (cooldown)")
        print("5. Exit")
        choice = input("Choose an option: ")
        if choice == "1":
            user = input("Enter new username: ")
            add_user(user)
        elif choice == "2":
            from_addr = input("From: ")
            to_addr = input("To: ")
            amount = int(input("Amount: "))
            simulate_tx(from_addr, to_addr, amount)
        elif choice == "3":
            print_ledger()
        elif choice == "4":
            ip = input("Enter IP to remove: ")
            remove_device(ip)
        elif choice == "5":
            print("Goodbye.")
            break
        else:
            print("Invalid option.")

if __name__ == '__main__':
    menu()
