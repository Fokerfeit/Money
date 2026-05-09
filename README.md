<p align="center">
  <img src="logo.png" width="200" alt="MONEY Logo"/>
</p>

<h1 align="center">MONEY</h1>
<p align="center"><em>Proof of Swarm — Money. For Everyone. Forever.</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/status-building-gold?style=flat-square"/>
  <img src="https://img.shields.io/badge/validation-Proof%20of%20Swarm-green?style=flat-square"/>
  <img src="https://img.shields.io/badge/pre--mine-NONE-red?style=flat-square"/>
  <img src="https://img.shields.io/badge/CEO-NONE-red?style=flat-square"/>
</p>

---

## What is MONEY?

MONEY is a decentralized digital currency validated by smartphones — not mining rigs, not data centers, not banks.

No pre-mine. No CEO. No central authority. Just people and their phones.

The validation model is called **Proof of Swarm**: a peer-to-peer network where every participant's device acts as a node. The more people join, the stronger and more distributed the network becomes. Think Pi Network's accessibility meets Kaspa's DAG speed architecture — then improved on both.

> *"The money of the future should belong to the people of the future."*

---

## How It Works

### Proof of Swarm
Each smartphone that joins the network becomes a validator node. Transactions are confirmed by the swarm — no single point of failure, no gatekeepers.

### Faucet & Decay Model
New users claim an initial allocation through the faucet. The reward decays as the network grows:

| Network Size | New User Reward |
|---|---|
| 0 – 1M users | 1,000,000 MONEY |
| 1M – 2M users | 800,000 MONEY |
| 2M – 3M users | 640,000 MONEY |
| 3M+ users | Continues decaying at 20% per million |

Early adopters are rewarded. The supply is self-regulating. No one prints money out of thin air.

### Clay Tablet Ledger
Every transaction is recorded on a public ledger — transparent, permanent, and verifiable by anyone. Inspired by the oldest record-keeping system in human history.

### DAG Architecture (in progress)
Transactions are structured as a Directed Acyclic Graph (DAG), enabling high throughput without traditional blockchain bottlenecks. Reference model: Kaspa.

---

## Current Stack

| Layer | Technology |
|---|---|
| Mobile App | React Native + Expo 54 |
| Backend | Node.js + Express |
| Ledger | In-memory → DAG (in progress) |
| Validation | Proof of Swarm (in progress) |
| Languages | TypeScript, JavaScript, Python |
| Desktop Simulator | Python (validator_simulator_main.py) |

---

## Repo Structure

```
Money-main/
├── logo.png                        # Brand mark
├── mobile/                         # React Native app
├── validator_simulator_main.py     # Desktop swarm simulator
├── validator_cli_menu.py           # CLI validator tool
├── ledger_state.py                 # Ledger logic
├── transaction_generator.py        # Test transaction generator
├── gui_validator.py                # GUI validator (Python)
├── Earths Money Guide.pdf          # Full project guide
└── MONEY_Decay_Graphs*.png         # Faucet decay model visualizations
```

---

## Vision

MONEY is not a crypto speculation vehicle. It is infrastructure.

The goal is a currency that works for a farmer in rural Africa, a student in Montreal North, and a mechanic in Calgary — without requiring a bank account, a credit score, or a powerful computer.

The phone in your pocket is enough.

---

## References & Inspiration

- **Kaspa** — DAG architecture and transaction speed model
- **Pi Network** — Smartphone-first validation concept
- *"Somewhere in the Milky Way"* by Luca Urbani — the philosophy behind this project

---

## Status

> This project is in active development. The mobile app prototype is functional locally. DAG architecture and full Proof of Swarm validation are in progress.

---

<p align="center">Built by one person with a phone, a laptop, and a vision.</p>
