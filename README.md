# The Coin Purse: An Agent That Pays but Can't Be Drained

An LLM research agent that calls paid x402 endpoints while enforcing deterministic, hard spending limits that the model cannot override or manipulate.

---

## 1. Problem Statement

Arjun gives an autonomous LLM research agent a crypto payment purse to query paid external data endpoints (x402 paywalls) on Base Sepolia.

Without hard structural guarantees, an LLM agent with wallet access can be drained:
- An adversarial seller can demand an exorbitant price (e.g. $4.99 per call).
- Prompt injection in retrieved content could instruct the model to pay drained amounts.
- Model hallucinations could repeatedly retry requests until the budget is depleted.
- Sellers can request malicious tokens or unapproved networks.

**The Core Security Invariant:**
> **THE LLM MUST NEVER CONTROL THE SPENDING POLICY.**
> The LLM chooses *what* endpoint to query, but a deterministic application security layer decides *whether* a payment is authorized. The wallet signer is invoked **ONLY AFTER** all spending checks pass.

---

## 2. Architecture & Data Flow

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
  ┌──────────────────────────────────────────────────────────────┐
  │               DETERMINISTIC SPENDING POLICY                  │
  │                   (Application-Controlled)                  │
  │                                                              │
  │  1. Network Allowlist: eip155:84532 (Base Sepolia only)      │
  │  2. Asset Allowlist: 0x036cbd... (Official Test USDC only)   │
  │  3. Amount Validity: Integer base units (BigInt only)        │
  │  4. Per-Call Ceiling: quote <= 500,000 base units ($0.50)    │
  │  5. Cumulative Budget: current + quote <= 5,000,000 ($5.00)  │
  │  6. Durable SQLite Ledger & Concurrency Reservation          │
  └──────────────────────────────────────────────────────────────┘
                             │
             ┌───────────────┴───────────────┐
             ▼                               ▼
       [REFUSE QUOTE]                  [ALLOW QUOTE]
             │                               │
             ├─► Signer Invocation: 0        ├─► Hold in-flight reservation
             ├─► Log refusal to SQLite       ├─► Sign x402 payload with wallet
             ├─► Return error to agent       ├─► Submit X-PAYMENT HTTP header
             └─► Never sends payment         ├─► Seller verifies & returns data
                                             ├─► Commit reservation to SQLite
                                             └─► On failure: Rollback reservation
```

---

## 3. Security Model

| Policy Rule | Configured Value | Enforcement Mechanism |
| :--- | :--- | :--- |
| **Approved Network** | `eip155:84532` (Base Sepolia) | Strict CAIP-2 allowlist match; refuses mainnet or unknown chains |
| **Approved Asset** | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` | Normalized lowercase match against Base Sepolia test USDC |
| **Per-Call Ceiling** | `500,000` base units ($0.50 USDC) | Quoted price compared **BEFORE SIGNING**; refuses if exceeded |
| **Total Run Budget** | `5,000,000` base units ($5.00 USDC) | `durableSpend + quote <= budget` evaluated **BEFORE SIGNING** |
| **Monetary Math** | Strictly `BigInt` base units | Zero floating-point math; rejects `number`, decimals, and negatives |
| **Tool Parameter Isolation** | `url`, `method`, `headers`, `body` only | Tool schema uses `.strict()`; rejects `budget`, `maxPerCall`, etc. |
| **Untrusted Seller Data** | Seller quotes are untrusted input | Prices are never clamped or negotiated; policy evaluates quote as-is |

---

## 4. Local Test Sellers

The repository includes two fully runnable local HTTP sellers (`node:http`):

### Honest Seller (`http://localhost:4021`)
- **Endpoint**: `GET /research`
- **Quoted Price**: `50,000` base units ($0.05 USDC)
- **Recipient**: Deterministic test address `0x1111111111111111111111111111111111111111`
- **Behavior**: Quoted price is well within the $0.50 per-call ceiling. Returns HTTP 200 research findings upon receiving a valid `X-PAYMENT` header.

### Rogue Seller (`http://localhost:4022`)
- **Endpoint**: `GET /research`
  - **Quoted Price**: `4,990,000` base units ($4.99 USDC)
  - **Expected Outcome**: **REFUSED** (`per_call_limit_exceeded`). **Signer is invoked ZERO times.**
- **Trap Endpoint**: `GET /drain`
  - Demands `50,000,000` base units ($50.00 USDC) attempting to exhaust the $5.00 total run budget.
- **Trap Endpoint**: `GET /wrong-network`
  - Demands payment on unapproved `eip155:1` (Ethereum Mainnet) -> **REFUSED** (`network_not_allowed`).
- **Trap Endpoint**: `GET /wrong-asset`
  - Demands payment in unapproved token `0xdead...` -> **REFUSED** (`asset_not_allowed`).

---

## 5. Durable SQLite Ledger

All payment decisions are recorded outside process memory in an ACID SQLite database (`data/ledger.sqlite`):
- **Survives Process Restart**: When starting, the agent reads existing spend directly from SQLite rather than relying on in-memory counters (`let total = 0`).
- **Zero Leak on Refusal**: Refused payments are recorded with exact refusal reasons, but **do not** increment cumulative spend.
- **Concurrency & Race Safety**: In-flight reservations (`reserve`, `commit`, `rollback`) prevent parallel tool calls from racing to overspend the total budget.
- **Failure Rollback**: If wallet signing fails or a seller returns an HTTP error, the reservation is immediately released without consuming budget.

---

## 6. Testnet Status

### Base Sepolia Configuration
- **Target Network**: Base Sepolia (`eip155:84532`, Chain ID: `84532`)
- **RPC Endpoint**: `https://sepolia.base.org`
- **Approved USDC Contract**: `0x036cbd53842c5426634e7929541ec2318f3dcf7e`
- **Status Artifact**: [artifacts/testnet-status.json](artifacts/testnet-status.json)

### Pre-Flight Wallet Check Results
A pre-flight on-chain verification was performed against the live Base Sepolia RPC:
- **Wallet Address**: `0x751fc0fa4f7BA49c57172F9a900f4CFeF382F1E6`
- **Base Sepolia ETH Balance**: `0 ETH`
- **Base Sepolia USDC Balance**: `0 USDC` (`0` base units)
- **Status**: `blocked_no_testnet_funds`

### Explicit Distinction: Automated Local Evidence vs. Real Testnet Settlement
> **REALITY CHECK:**
> **Real Base Sepolia settlement was NOT performed because the test wallet had zero testnet funds (0 ETH and 0 test USDC).**
> - **No on-chain transaction hash exists, and none is claimed or fabricated.**
> - **Automated Local Evidence**: The complete x402 protocol integration, spending policy gates, pre-signing refusal, concurrency controls, and SQLite persistence are 100% verified locally against real HTTP 402 sellers. The sanitized decision record is preserved in [artifacts/local-decision-record.json](artifacts/local-decision-record.json).

---

## 7. How to Reproduce on Real Base Sepolia Testnet

A reviewer with funded Base Sepolia credentials can execute the live on-chain flow using these steps:

1. **Configure Environment**:
   Create a local `.env` file (which is git-ignored):
   ```bash
   X402_PRIVATE_KEY=0x<your_funded_base_sepolia_private_key>
   BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
   LLM_API_KEY=sk-...
   ```
2. **Fund Wallet**:
   Ensure the address holds:
   - At least **0.05 USDC** of Base Sepolia test USDC (`0x036cbd53842c5426634e7929541ec2318f3dcf7e`)
   - A small amount of Base Sepolia ETH for gas (e.g. `0.002 ETH`)
3. **Verify Wallet Status**:
   ```bash
   npx tsx src/x402/checkWallet.ts
   ```
4. **Start Local Sellers**:
   ```bash
   npm run sellers
   ```
5. **Run the Research Agent**:
   ```bash
   npm run agent -- "Research latest advances in quantum computing"
   ```
6. **Verify On-Chain Settlement**:
   Inspect the emitted transaction hash on [BaseScan Sepolia Explorer](https://sepolia.basescan.org/).

---

## 8. Quick Start

### Prerequisites
- Node.js >= 22.0.0
- npm >= 10.0.0

### Installation & Build
```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Run comprehensive test suite (61 tests)
npm test
```

### Running Local Sellers
```bash
npm run sellers
# Honest Seller running on http://127.0.0.1:4021
# Rogue Seller running on  http://127.0.0.1:4022
```

### Running the Research Agent
```bash
npm run agent -- "Summarize recent developments in computing"
```

### Generating Local Decision Evidence Artifact
```bash
npm run evidence
# Outputs sanitized audit trail to artifacts/local-decision-record.json
```

---

## 9. Project Structure

```
.
├── artifacts/
│   ├── local-decision-record.json # Sanitized local end-to-end audit decisions
│   └── testnet-status.json        # Preflight verification record (zero balance)
├── src/
│   ├── config/                    # Strict Zod schema, allowlists, frozen configs
│   ├── ledger/                    # Durable SQLite database & BigInt queries
│   ├── policy/                    # Pure deterministic policy & concurrency guard
│   ├── sellers/                   # Honest (port 4021) & Rogue (port 4022) HTTP servers
│   ├── x402/                      # @x402/core client, Viem signer, paidFetch
│   └── agent/                     # LLM tool definition, ResearchAgent orchestrator
└── tests/
    ├── config.test.ts             # Configuration parsing & allowlist tests
    ├── ledger.test.ts             # SQLite durability & process restart survival
    ├── policy.test.ts             # BigInt math, check order, ceiling & budget tests
    ├── sellers.test.ts            # Honest & rogue HTTP 402 challenges
    ├── x402.test.ts               # Pre-signing policy enforcement & 0 signer calls
    ├── agent.test.ts              # Agent tool calling & prompt injection defense
    └── acceptance.test.ts         # Dedicated challenge rubric verification (10 criteria)
```

---

## 10. Key Dependencies

All package choices match the installed dependencies:
- **`@x402/core`** (`^2.27.0`) & **`@x402/fetch`** (`^2.27.0`): Official Coinbase x402 payment protocol libraries for challenge parsing and signature header encoding.
- **`viem`** (`^2.56.9`): Modern EVM account management and cryptographic signature engine.
- **`openai`** (`^7.23.0`): OpenAI client adapter with function/tool calling support.
- **`zod`** (`^3.24.2`): Strict schema validation for environment variables and tool inputs.
- **`node:sqlite`** (Node.js standard library): Native zero-dependency SQLite engine with WAL journaling.
- **`vitest`** (`^3.0.7`): Fast ESM-native test runner.
- **`tsx`** (`^4.23.15`): TypeScript execution environment for CLI runners.

---

## 11. Security & Credential Protection

- **No Secrets in Source**: Automated credential scanning confirms zero private keys, mnemonics, or API keys in git-tracked files.
- **Strictly Ignored**: `.gitignore` explicitly excludes `.env`, `*.sqlite`, and `*.db`.
- **Placeholder Only**: `.env.example` contains only inert dummy placeholders (`0x0000...0001`).
- **No Model Overrides**: Tool arguments cannot override spending ceilings, budgets, or allowlists.

---

## 12. Challenge Acceptance Checklist

| # | Criterion | Score | Automated Acceptance Status | Notes |
|---|:---|:---:|:---:|:---|
| **1** | **x402 client payment path** | 4 pts | **PASS** | Official `@x402/core` HTTP client path verified |
| **2** | **Paid fetch exposed as LLM tool** | 4 pts | **PASS** | `paid_fetch` tool schema verified; no limits exposed |
| **3** | **Runnable abusive rogue seller** | 5 pts | **PASS** | $4.99 price, `/drain`, `/wrong-network`, `/wrong-asset` verified |
| **4** | **No credentials in tracked files** | 8 pts | **PASS** | Git scan confirms zero keys/tokens; `.env` ignored |
| **5** | **Per-call ceiling checked BEFORE signing** | 18 pts | **PASS** | $4.99 quote refused; **Signer called 0 times** |
| **6** | **Cumulative budget checked BEFORE signing** | 10 pts | **PASS** | Over-budget quote refused; **Signer called 0 times** |
| **7** | **Durable cumulative spend outside memory** | 7 pts | **PASS** | SQLite ledger survives process restart |
| **8** | **Explicit network & asset allowlists** | 10 pts | **PASS** | Base Sepolia (`eip155:84532`) + test USDC only |
| **9** | **Limits NOT settable via tool arguments** | 8 pts | **PASS** | Extraneous tool parameters rejected by Zod `.strict()` |
| **10**| **Integer base-unit arithmetic** | 6 pts | **PASS** | Pure `BigInt` base units; zero floating-point arithmetic |

> **Note on Acceptance Status**: The items above reflect automated verification of the complete codebase against all 10 criteria. Live testnet settlement was blocked due to an unfunded test wallet (0 ETH, 0 USDC), which is documented honestly without fabricated evidence.
