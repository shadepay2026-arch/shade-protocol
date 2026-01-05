# SHADE Protocol

Authorization-Based Finance on Solana. Spend without owning.

## Overview

SHADE Protocol enables a new paradigm of payments where users don't hold funds directly. Instead, they receive cryptographic authorizations that prove permission to spend from shared liquidity pools (Fog Pools).

### Core Concepts

- **Fog Pools**: Shared liquidity reservoirs where fund ownership is non-attributable
- **Authorizations**: Cryptographic permissions to spend with defined caps, expiry, and purpose
- **Zero-Knowledge Spending**: Prove you can spend without revealing your identity or balance

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         FOG POOL                                 │
│   Shared liquidity - ownership is non-attributable              │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐           │
│   │ Deposit │  │ Deposit │  │ Deposit │  │ Deposit │           │
│   └─────────┘  └─────────┘  └─────────┘  └─────────┘           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      AUTHORIZATIONS                              │
│   Cryptographic proof of permission to spend                    │
│   ┌───────────────────────────────────────────────────────┐     │
│   │ Spender: 0x...  │ Cap: 100 USDC │ Expires: 24h        │     │
│   │ Purpose: "Coffee Shop" │ Used: 23.45 USDC             │     │
│   └───────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         SPEND                                    │
│   Authorization holder can spend up to their cap                │
│   - Validates authorization is active                           │
│   - Validates not expired                                       │
│   - Validates amount within remaining cap                       │
│   - Transfers from Fog Pool vault to recipient                  │
└─────────────────────────────────────────────────────────────────┘
```

## Program Instructions

### `initialize_fog_pool`
Create a new Fog Pool with a unique seed and associated token vault.

### `deposit_to_fog`
Deposit tokens into a Fog Pool. Depositors contribute to shared liquidity.

### `create_authorization`
Issue a spending authorization to a spender with:
- Spending cap (maximum amount)
- Expiry timestamp
- Purpose description

### `spend`
Use an authorization to spend tokens from the Fog Pool. Validates:
- Authorization is active
- Not expired
- Amount within remaining cap

### `revoke_authorization`
Cancel an authorization, preventing further spending.

## Getting Started

### Prerequisites

- Rust 1.70+
- Solana CLI 1.18+
- Anchor CLI 0.29+
- Node.js 18+

### Installation

```bash
# Clone the repository
git clone https://github.com/shadepay2026-arch/shade-protocol.git
cd shade-protocol/shade

# Install dependencies
npm install

# Build the program
anchor build

# Run tests (requires local validator)
anchor test
```

### Deploy to Devnet

```bash
# Configure Solana CLI for devnet
solana config set --url devnet

# Airdrop SOL for deployment
solana airdrop 2

# Deploy
anchor deploy --provider.cluster devnet
```

### Deploy to Mainnet

```bash
# Configure Solana CLI for mainnet
solana config set --url mainnet-beta

# Ensure sufficient SOL for deployment
solana balance

# Deploy
anchor deploy --provider.cluster mainnet
```

## Account Structures

### FogPool
```rust
pub struct FogPool {
    pub authority: Pubkey,           // Pool controller
    pub vault: Pubkey,               // Token vault
    pub total_deposited: u64,        // Total tokens deposited
    pub total_spent: u64,            // Total tokens spent
    pub active_authorizations: u64,  // Count of active auths
    pub pool_seed: [u8; 32],         // Unique seed
    pub bump: u8,                    // PDA bump
}
```

### Authorization
```rust
pub struct Authorization {
    pub fog_pool: Pubkey,            // Associated pool
    pub authorized_spender: Pubkey,  // Who can spend
    pub issuer: Pubkey,              // Who issued this
    pub spending_cap: u64,           // Maximum amount
    pub amount_spent: u64,           // Already spent
    pub created_at: i64,             // Creation time
    pub expires_at: i64,             // Expiry time
    pub purpose: String,             // Description (max 64 chars)
    pub is_active: bool,             // Still valid?
    pub bump: u8,                    // PDA bump
}
```

## Events

The program emits events for indexing and tracking:

- `FogPoolCreated` - New pool initialized
- `DepositMade` - Funds deposited to pool
- `AuthorizationCreated` - New authorization issued
- `SpendExecuted` - Funds spent via authorization
- `AuthorizationRevoked` - Authorization cancelled

## Security

- All accounts validated via Anchor constraints
- Authorization PDAs prevent unauthorized access
- Spending caps enforced on-chain
- Expiry timestamps validated against Solana clock
- Only issuers can revoke their authorizations

## License

MIT License - See LICENSE file for details.

## Links

- Website: https://shadepay.org
- Documentation: https://shadepay.org/docs
- Twitter: https://x.com/shadepay
- GitHub: https://github.com/shadepay2026-arch

