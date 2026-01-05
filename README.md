# SHADE Protocol

Authorization-Based Finance on Solana. Spend without owning.

## Overview

SHADE Protocol enables a new paradigm of payments where users don't hold funds directly. Instead, they receive cryptographic authorizations that prove permission to spend from shared liquidity pools (Fog Pools).

### Core Concepts

- **Fog Pools**: Shared USDC liquidity reservoirs where fund ownership is non-attributable
- **Authorizations**: Cryptographic permissions to spend with defined caps, expiry, and purpose
- **$SHADE Staking**: Stake $SHADE tokens to unlock higher spending tiers and earn USDC rewards
- **Fee Sharing**: 0.1% fee on every spend is distributed to $SHADE stakers in USDC

### Two-Token Economy

```
$SHADE (Pump.fun)              USDC (Fog Pools)
      │                              │
      ▼                              ▼
  Stake $SHADE                LPs deposit USDC
      │                              │
      ▼                              ▼
  Unlock tiers        ────►    Authorize spending
      │                              │
      │                              ▼
      │                     User spends USDC
      │                              │
      │                              ▼
      │                    0.1% fee (USDC)
      │                              │
      └────────◄─────────────────────┘
           Earn USDC rewards
```

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

### Protocol Configuration

#### `initialize_protocol`
One-time setup for the protocol. Configures:
- $SHADE token mint
- Fee vault (holds USDC fees)
- Staking vault (holds staked $SHADE)
- Fee basis points (default 0.1% = 10 bp)
- Tier thresholds (Bronze: 100, Silver: 1000, Gold: 10000 $SHADE)

#### `update_fee`
Admin function to update the protocol fee rate.

### Staking

#### `stake`
Stake $SHADE tokens to:
- Unlock higher spending tiers (Bronze/Silver/Gold)
- Earn USDC rewards from protocol fees

#### `unstake`
Withdraw staked $SHADE tokens. No lock-up period.

#### `distribute_fees`
Calculate and allocate USDC fee rewards to a staker based on their stake proportion.

#### `claim_rewards`
Claim accumulated USDC rewards. Rewards are transferred from fee vault to user wallet.

### Fog Pools

#### `initialize_fog_pool`
Create a new Fog Pool with a unique seed and associated USDC token vault.

#### `deposit_to_fog`
Deposit USDC into a Fog Pool. LPs contribute to shared liquidity.

### Authorizations

#### `create_authorization`
Issue a spending authorization to a spender with:
- Spending cap (validated against staker tier)
- Expiry timestamp
- Purpose description

#### `spend`
Use an authorization to spend USDC from the Fog Pool:
- Validates authorization is active and not expired
- Validates amount within remaining cap
- Collects 0.1% fee → sent to fee vault for staker distribution
- Transfers net USDC to recipient

#### `revoke_authorization`
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

### ProtocolConfig
```rust
pub struct ProtocolConfig {
    pub authority: Pubkey,           // Protocol admin
    pub shade_mint: Pubkey,          // $SHADE token mint
    pub fee_vault: Pubkey,           // USDC fee vault
    pub staking_vault: Pubkey,       // $SHADE staking vault
    pub fee_basis_points: u16,       // Fee rate (10 = 0.1%)
    pub total_staked: u64,           // Total $SHADE staked
    pub total_fees_collected: u64,   // Total USDC fees
    pub total_fees_distributed: u64, // USDC distributed
    pub bronze_threshold: u64,       // 100 $SHADE
    pub silver_threshold: u64,       // 1,000 $SHADE
    pub gold_threshold: u64,         // 10,000 $SHADE
    pub bump: u8,
}
```

### Staker
```rust
pub struct Staker {
    pub user: Pubkey,                // User wallet
    pub staked_amount: u64,          // $SHADE staked
    pub pending_rewards: u64,        // USDC rewards pending
    pub last_claim_timestamp: i64,   // Last claim time
    pub tier: u8,                    // 0=None, 1=Bronze, 2=Silver, 3=Gold
    pub bump: u8,
}
```

### FogPool
```rust
pub struct FogPool {
    pub authority: Pubkey,           // Pool controller
    pub vault: Pubkey,               // USDC token vault
    pub total_deposited: u64,        // Total USDC deposited
    pub total_spent: u64,            // Total USDC spent
    pub total_fees_generated: u64,   // USDC fees from this pool
    pub active_authorizations: u64,  // Count of active auths
    pub pool_seed: [u8; 32],         // Unique seed
    pub bump: u8,
}
```

### Authorization
```rust
pub struct Authorization {
    pub fog_pool: Pubkey,            // Associated pool
    pub authorized_spender: Pubkey,  // Who can spend
    pub issuer: Pubkey,              // Who issued this
    pub spending_cap: u64,           // Max USDC amount
    pub amount_spent: u64,           // USDC already spent
    pub created_at: i64,             // Creation time
    pub expires_at: i64,             // Expiry time
    pub purpose: String,             // Description (max 64 chars)
    pub is_active: bool,             // Still valid?
    pub bump: u8,
}
```

## Events

The program emits events for indexing and tracking:

**Protocol**
- `ProtocolInitialized` - Protocol config created
- `FeeUpdated` - Fee rate changed

**Staking**
- `Staked` - User staked $SHADE
- `Unstaked` - User unstaked $SHADE
- `FeesDistributed` - USDC allocated to staker
- `RewardsClaimed` - User claimed USDC rewards

**Fog Pools**
- `FogPoolCreated` - New pool initialized
- `DepositMade` - USDC deposited to pool

**Authorizations**
- `AuthorizationCreated` - New authorization issued
- `SpendExecuted` - USDC spent via authorization (includes fee)
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

