import tkinter as tk
from tkinter import messagebox
import random
import uuid

ledger = {}
ledger_history = []
tx_seen = set()

def validate_transaction(tx):
    if tx["id"] in tx_seen:
        return False
    return ledger.get(tx["from"], 100) >= tx["amount"]

def commit_transaction(tx):
    sender, receiver, amount = tx["from"], tx["to"], tx["amount"]
    ledger[sender] = ledger.get(sender, 100) - amount
    ledger[receiver] = ledger.get(receiver, 0) + amount
    ledger_history.append(tx)
    tx_seen.add(tx["id"])

def simulate_tx():
    sender = f"user_{random.randint(1, 100)}"
    receiver = f"user_{random.randint(101, 200)}"
    amount = random.randint(1, 20)
    tx = {"id": str(uuid.uuid4()), "from": sender, "to": receiver, "amount": amount}
    approvals = 0
    for _ in range(20):
        if validate_transaction(tx):
            approvals += 1
    if approvals >= 10:
        commit_transaction(tx)
        messagebox.showinfo("✅ Transaction Confirmed",
                            f"TX {tx['id'][:8]} confirmed\nFrom: {sender}\nTo: {receiver}\nAmount: {amount}")
    else:
        messagebox.showwarning("❌ Transaction Failed",
                               f"TX {tx['id'][:8]} rejected\nNot enough approvals.")

def show_ledger():
    ledger_win = tk.Toplevel(root)
    ledger_win.title("📒 Ledger Balances")
    text = tk.Text(ledger_win, width=40, height=20)
    for user, balance in ledger.items():
        text.insert(tk.END, f"{user}: {balance}\n")
    text.pack()

root = tk.Tk()
root.title("Money Validator GUI")

tk.Button(root, text="🚀 Simulate Transaction", command=simulate_tx, width=30).pack(pady=10)
tk.Button(root, text="📒 View Ledger", command=show_ledger, width=30).pack(pady=10)

root.mainloop()
