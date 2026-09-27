# The Coin Purse: An Agent That Pays but Can't Be Drained

An LLM research agent that calls paid x402 endpoints while enforcing hard spending limits that the model cannot override.

---

## Architecture Overview

```
LLM Research Agent
       │
       ▼ chooses tool
paid_fetch tool (url, method, headers, body)
       │
       ▼ HTTP request
Seller Endpoint
       │
       ▼ 402 Payment Required
x402 Requirement Parsing (@x402/core)
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│             DETERMINISTIC SECURITY BOUNDARY              │
│                                                          │
│  1. Network Allowlist: eip155:84532 (Base Sepolia)       │
│  2. Asset Allowlist: 0x036cbd... (Test USDC)             │
│  3. Amount Validity: Integer base units (BigInt only)     │
│  4. Per-Call Ceiling: quote <= 500,000 base units ($0.50) │
│  5. Cumulative Budget: spent + quote <= 5,000,000 ($5.00)│
│  6. Durable SQLite Ledger & Concurrency Reservation     │
└──────────────────────────────────────────────────────────┘
       │
       ├─► IF REFUSED: Durably log refusal in SQLite
       │               NEVER SIGN (Signer is never invoked)
       │               NEVER PAY
       │               Return structured refusal to agent
       │
       └─► IF ALLOWED: Hold in-flight reservation
                       Sign payment authorization payload
                       Submit X-PAYMENT header
                       Commit to SQLite on 200 OK
                       Rollback reservation on failure
```

---

## Key Security Principles

1. **Deterministic Isolation**: Spending limits (`MAX_PER_CALL`, `TOTAL_BUDGET`), allowlists, and wallet keys are immutable configuration values. They are never exposed to tool arguments or LLM prompts.
2. **Pre-Signing Ceiling & Budget Check**: Quoted payment requirements from untrusted sellers are strictly evaluated **BEFORE** the wallet signer is ever invoked. If a quote exceeds the ceiling or budget, the signer is called **zero** times.
3. **Integer Base-Unit Arithmetic**: All monetary logic operates exclusively in integer base units (`BigInt`). 1 USDC = 1,000,000 base units. Floating-point `number` arithmetic is strictly forbidden.
4. **Durable Persistence**: Cumulative spend is tracked in SQLite outside process memory, surviving restarts and process crashes.
5. **Two Test Sellers**:
   - **Honest Seller**: Quotes 50,000 base units ($0.05 USDC) on Base Sepolia.
   - **Rogue Seller**: Abusive seller quoting 4,990,000 base units ($4.99 USDC) and offering trap endpoints for unapproved networks and assets.

---

## Testnet Status

### Base Sepolia Configuration
- **Network**: Base Sepolia (`eip155:84532`, Chain ID: `84532`)
- **RPC URL**: `https://sepolia.base.org`
- **Approved Asset**: `0x036cbd53842c5426634e7929541ec2318f3dcf7e` (Official Base Sepolia test USDC)
- **Per-Call Ceiling**: `500000` base units ($0.50 USDC)
- **Total Run Budget**: `5000000` base units ($5.00 USDC)

### Wallet Pre-Flight Check Results
A pre-flight verification was performed against the live Base Sepolia network:
- **Wallet Address**: `0x751fc0fa4f7BA49c57172F9a900f4CFeF382F1E6`
- **Base Sepolia ETH Balance (Gas)**: `0 ETH`
- **Base Sepolia USDC Balance**: `0 USDC` (`0` base units)
- **Status**: `blocked_no_testnet_funds` (Recorded in `artifacts/testnet-status.json`)

### Explicit Distinction: Automated Local Evidence vs Real Testnet Settlement
- **No Real Base Sepolia Transaction Performed**: Because the test wallet holds zero testnet ETH and zero test USDC, no live on-chain settlement occurred. **No transaction hash is claimed or fabricated.**
- **Automated Local Evidence**: The complete end-to-end x402 payment protocol, spending policy evaluation, pre-signing refusal, concurrency reservations, and durable SQLite ledger writes are fully validated locally against runnable HTTP 402 sellers. The sanitized audit trail is recorded in `artifacts/local-decision-record.json`.
- **Reproducibility**: Once the wallet (`0x751fc0fa4f7BA49c57172F9a900f4CFeF382F1E6`) is funded with test ETH and test USDC (or when a funded private key is placed in `.env`), the identical payment flow executes on-chain without modifying any application or policy code.

---

## Running Locally

### 1. Build TypeScript
```bash
npm run build
```

### 2. Run Test Suite (61 Automated Tests)
```bash
npm test
```
All 10 rubric criteria are tested in `tests/acceptance.test.ts`.

### 3. Generate Local Decision Artifact
```bash
npx tsx src/x402/generateLocalEvidence.ts
```
Outputs audit records to `artifacts/local-decision-record.json`.
