use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("3ucYdoYVtvq5dNHqCYWL1WR8kgN4dgDrKnxRK7SN65oN");

/// SHADE Protocol: Authorization-Based Finance
/// Spend without owning - cryptographic permission to spend from shared liquidity
/// 
/// Features:
/// - Fog Pools: Shared liquidity reservoirs
/// - Authorizations: Cryptographic spending permissions
/// - Staking: Stake $SHADE to unlock tiers and earn fees
/// - Fee Sharing: Protocol fees distributed to stakers
#[program]
pub mod shade {
    use super::*;

    // ========================================================================
    // PROTOCOL CONFIGURATION
    // ========================================================================

    /// Initialize the protocol configuration (one-time setup)
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_basis_points: u16,
    ) -> Result<()> {
        require!(fee_basis_points <= 1000, ShadeError::FeeTooHigh); // Max 10%

        let config = &mut ctx.accounts.protocol_config;
        config.authority = ctx.accounts.authority.key();
        config.shade_mint = ctx.accounts.shade_mint.key();
        config.fee_vault = ctx.accounts.fee_vault.key();
        config.staking_vault = ctx.accounts.staking_vault.key();
        config.fee_basis_points = fee_basis_points;
        config.total_staked = 0;
        config.total_fees_collected = 0;
        config.total_fees_distributed = 0;
        config.bump = ctx.bumps.protocol_config;

        // Tier thresholds (in $SHADE tokens with 6 decimals)
        config.bronze_threshold = 100_000_000;      // 100 $SHADE
        config.silver_threshold = 1_000_000_000;    // 1,000 $SHADE
        config.gold_threshold = 10_000_000_000;     // 10,000 $SHADE

        // Spending cap multipliers per tier (in basis points of base cap)
        config.bronze_cap_multiplier = 100;  // 1x base
        config.silver_cap_multiplier = 500;  // 5x base
        config.gold_cap_multiplier = 1000;   // 10x base

        emit!(ProtocolInitialized {
            config: config.key(),
            authority: config.authority,
            fee_basis_points,
        });

        Ok(())
    }

    /// Update protocol fee (admin only)
    pub fn update_fee(ctx: Context<UpdateProtocol>, new_fee_basis_points: u16) -> Result<()> {
        require!(new_fee_basis_points <= 1000, ShadeError::FeeTooHigh);

        let config = &mut ctx.accounts.protocol_config;
        let old_fee = config.fee_basis_points;
        config.fee_basis_points = new_fee_basis_points;

        emit!(FeeUpdated {
            old_fee,
            new_fee: new_fee_basis_points,
        });

        Ok(())
    }

    // ========================================================================
    // STAKING
    // ========================================================================

    /// Stake $SHADE tokens to earn fees and unlock higher tiers
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, ShadeError::InvalidAmount);

        // Transfer $SHADE from user to staking vault
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_shade_account.to_account_info(),
                to: ctx.accounts.staking_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        // Update or initialize staker account
        let staker = &mut ctx.accounts.staker;
        let config = &ctx.accounts.protocol_config;
        
        if staker.user == Pubkey::default() {
            staker.user = ctx.accounts.user.key();
            staker.staked_amount = 0;
            staker.pending_rewards = 0;
            staker.last_claim_timestamp = Clock::get()?.unix_timestamp;
            staker.bump = ctx.bumps.staker;
        }

        staker.staked_amount = staker
            .staked_amount
            .checked_add(amount)
            .ok_or(ShadeError::Overflow)?;

        // Update tier
        staker.tier = calculate_tier(staker.staked_amount, config);

        // Update protocol total
        let config = &mut ctx.accounts.protocol_config;
        config.total_staked = config
            .total_staked
            .checked_add(amount)
            .ok_or(ShadeError::Overflow)?;

        emit!(Staked {
            user: ctx.accounts.user.key(),
            amount,
            new_total: staker.staked_amount,
            tier: staker.tier,
        });

        Ok(())
    }

    /// Unstake $SHADE tokens
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        let staker = &ctx.accounts.staker;
        require!(amount > 0, ShadeError::InvalidAmount);
        require!(staker.staked_amount >= amount, ShadeError::InsufficientStake);

        // Transfer $SHADE from staking vault to user
        let config = &ctx.accounts.protocol_config;
        let seeds = &[
            b"protocol_config".as_ref(),
            &[config.bump][..],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.staking_vault.to_account_info(),
                to: ctx.accounts.user_shade_account.to_account_info(),
                authority: config.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;

        // Update staker account
        let staker = &mut ctx.accounts.staker;
        staker.staked_amount = staker
            .staked_amount
            .checked_sub(amount)
            .ok_or(ShadeError::Overflow)?;

        // Update tier
        let config = &ctx.accounts.protocol_config;
        staker.tier = calculate_tier(staker.staked_amount, config);

        // Update protocol total
        let config = &mut ctx.accounts.protocol_config;
        config.total_staked = config
            .total_staked
            .saturating_sub(amount);

        emit!(Unstaked {
            user: ctx.accounts.user.key(),
            amount,
            remaining: staker.staked_amount,
            tier: staker.tier,
        });

        Ok(())
    }

    /// Claim accumulated fee rewards
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let staker = &ctx.accounts.staker;
        let pending = staker.pending_rewards;
        require!(pending > 0, ShadeError::NoRewardsToClaim);

        // Transfer rewards from fee vault to user
        let config = &ctx.accounts.protocol_config;
        let seeds = &[
            b"protocol_config".as_ref(),
            &[config.bump][..],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.fee_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: config.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, pending)?;

        // Update staker
        let staker = &mut ctx.accounts.staker;
        staker.pending_rewards = 0;
        staker.last_claim_timestamp = Clock::get()?.unix_timestamp;

        // Update protocol stats
        let config = &mut ctx.accounts.protocol_config;
        config.total_fees_distributed = config
            .total_fees_distributed
            .checked_add(pending)
            .ok_or(ShadeError::Overflow)?;

        emit!(RewardsClaimed {
            user: ctx.accounts.user.key(),
            amount: pending,
        });

        Ok(())
    }

    /// Distribute fees to a staker (called by anyone, incentivized)
    pub fn distribute_fees(ctx: Context<DistributeFees>) -> Result<()> {
        let config = &ctx.accounts.protocol_config;
        let staker = &ctx.accounts.staker;

        require!(config.total_staked > 0, ShadeError::NoStakers);
        require!(staker.staked_amount > 0, ShadeError::NotStaking);

        // Calculate share of undistributed fees
        let undistributed = config.total_fees_collected
            .saturating_sub(config.total_fees_distributed);
        
        if undistributed == 0 {
            return Ok(());
        }

        // Proportional share based on stake
        let share = (undistributed as u128)
            .checked_mul(staker.staked_amount as u128)
            .ok_or(ShadeError::Overflow)?
            .checked_div(config.total_staked as u128)
            .ok_or(ShadeError::Overflow)? as u64;

        if share == 0 {
            return Ok(());
        }

        // Update staker's pending rewards
        let staker = &mut ctx.accounts.staker;
        staker.pending_rewards = staker
            .pending_rewards
            .checked_add(share)
            .ok_or(ShadeError::Overflow)?;

        emit!(FeesDistributed {
            staker: staker.user,
            amount: share,
        });

        Ok(())
    }

    // ========================================================================
    // FOG POOLS
    // ========================================================================

    /// Initialize a new Fog Pool - shared liquidity reservoir
    pub fn initialize_fog_pool(
        ctx: Context<InitializeFogPool>,
        pool_seed: [u8; 32],
    ) -> Result<()> {
        let fog_pool = &mut ctx.accounts.fog_pool;
        fog_pool.authority = ctx.accounts.authority.key();
        fog_pool.vault = ctx.accounts.vault.key();
        fog_pool.total_deposited = 0;
        fog_pool.total_spent = 0;
        fog_pool.total_fees_generated = 0;
        fog_pool.active_authorizations = 0;
        fog_pool.pool_seed = pool_seed;
        fog_pool.bump = ctx.bumps.fog_pool;

        emit!(FogPoolCreated {
            pool: fog_pool.key(),
            authority: fog_pool.authority,
            vault: fog_pool.vault,
        });

        Ok(())
    }

    /// Deposit funds into the Fog Pool (LP deposit)
    pub fn deposit_to_fog(ctx: Context<DepositToFog>, amount: u64) -> Result<()> {
        require!(amount > 0, ShadeError::InvalidAmount);

        // Transfer tokens from depositor to vault
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        // Update fog pool stats
        let fog_pool = &mut ctx.accounts.fog_pool;
        fog_pool.total_deposited = fog_pool
            .total_deposited
            .checked_add(amount)
            .ok_or(ShadeError::Overflow)?;

        emit!(DepositMade {
            pool: fog_pool.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
        });

        Ok(())
    }

    // ========================================================================
    // AUTHORIZATIONS
    // ========================================================================

    /// Create a spending authorization - permission to spend from the fog
    /// The spending cap is validated against the spender's staking tier
    pub fn create_authorization(
        ctx: Context<CreateAuthorization>,
        nonce: u64,
        spending_cap: u64,
        expires_at: i64,
        purpose: String,
    ) -> Result<()> {
        require!(spending_cap > 0, ShadeError::InvalidAmount);
        require!(purpose.len() <= 64, ShadeError::PurposeTooLong);
        
        let clock = Clock::get()?;
        require!(expires_at > clock.unix_timestamp, ShadeError::InvalidExpiry);

        // Validate spending cap against staker tier if staker exists
        if let Some(staker) = &ctx.accounts.staker {
            let config = &ctx.accounts.protocol_config;
            let max_cap = get_max_cap_for_tier(staker.tier, config);
            require!(spending_cap <= max_cap, ShadeError::ExceedsTierLimit);
        }

        let authorization = &mut ctx.accounts.authorization;
        authorization.fog_pool = ctx.accounts.fog_pool.key();
        authorization.authorized_spender = ctx.accounts.spender.key();
        authorization.issuer = ctx.accounts.issuer.key();
        authorization.spending_cap = spending_cap;
        authorization.amount_spent = 0;
        authorization.created_at = clock.unix_timestamp;
        authorization.expires_at = expires_at;
        authorization.purpose = purpose.clone();
        authorization.is_active = true;
        authorization.bump = ctx.bumps.authorization;

        // Update fog pool stats
        let fog_pool = &mut ctx.accounts.fog_pool;
        fog_pool.active_authorizations = fog_pool
            .active_authorizations
            .checked_add(1)
            .ok_or(ShadeError::Overflow)?;

        emit!(AuthorizationCreated {
            authorization: authorization.key(),
            fog_pool: fog_pool.key(),
            spender: authorization.authorized_spender,
            issuer: authorization.issuer,
            spending_cap,
            expires_at,
            purpose,
        });

        Ok(())
    }

    /// Spend using an authorization - the core of SHADE
    /// Takes a protocol fee that goes to stakers
    pub fn spend(ctx: Context<Spend>, amount: u64) -> Result<()> {
        let authorization = &ctx.accounts.authorization;
        let clock = Clock::get()?;

        // Validate authorization
        require!(authorization.is_active, ShadeError::AuthorizationInactive);
        require!(
            clock.unix_timestamp < authorization.expires_at,
            ShadeError::AuthorizationExpired
        );
        
        let remaining = authorization
            .spending_cap
            .checked_sub(authorization.amount_spent)
            .ok_or(ShadeError::Overflow)?;
        require!(amount <= remaining, ShadeError::ExceedsSpendingCap);

        // Calculate fee
        let config = &ctx.accounts.protocol_config;
        let fee = (amount as u128)
            .checked_mul(config.fee_basis_points as u128)
            .ok_or(ShadeError::Overflow)?
            .checked_div(10000)
            .ok_or(ShadeError::Overflow)? as u64;
        
        let net_amount = amount.checked_sub(fee).ok_or(ShadeError::Overflow)?;

        // Transfer net amount from vault to recipient
        let fog_pool = &ctx.accounts.fog_pool;
        let seeds = &[
            b"fog_pool",
            fog_pool.pool_seed.as_ref(),
            &[fog_pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer to recipient
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: fog_pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, net_amount)?;

        // Transfer fee to fee vault
        if fee > 0 {
            let fee_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.fee_vault.to_account_info(),
                    authority: fog_pool.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(fee_transfer_ctx, fee)?;
        }

        // Update authorization
        let authorization = &mut ctx.accounts.authorization;
        authorization.amount_spent = authorization
            .amount_spent
            .checked_add(amount)
            .ok_or(ShadeError::Overflow)?;

        // Update fog pool stats
        let fog_pool = &mut ctx.accounts.fog_pool;
        fog_pool.total_spent = fog_pool
            .total_spent
            .checked_add(amount)
            .ok_or(ShadeError::Overflow)?;
        fog_pool.total_fees_generated = fog_pool
            .total_fees_generated
            .checked_add(fee)
            .ok_or(ShadeError::Overflow)?;

        // Update protocol fee stats
        let config = &mut ctx.accounts.protocol_config;
        config.total_fees_collected = config
            .total_fees_collected
            .checked_add(fee)
            .ok_or(ShadeError::Overflow)?;

        emit!(SpendExecuted {
            authorization: authorization.key(),
            fog_pool: fog_pool.key(),
            spender: ctx.accounts.spender.key(),
            recipient: ctx.accounts.recipient_token_account.key(),
            amount,
            fee,
            net_amount,
            remaining: authorization.spending_cap - authorization.amount_spent,
        });

        Ok(())
    }

    /// Revoke an authorization
    pub fn revoke_authorization(ctx: Context<RevokeAuthorization>) -> Result<()> {
        let authorization = &mut ctx.accounts.authorization;
        require!(authorization.is_active, ShadeError::AuthorizationInactive);

        authorization.is_active = false;

        // Update fog pool stats
        let fog_pool = &mut ctx.accounts.fog_pool;
        fog_pool.active_authorizations = fog_pool
            .active_authorizations
            .saturating_sub(1);

        emit!(AuthorizationRevoked {
            authorization: authorization.key(),
            fog_pool: fog_pool.key(),
            revoked_by: ctx.accounts.issuer.key(),
        });

        Ok(())
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

fn calculate_tier(staked_amount: u64, config: &ProtocolConfig) -> u8 {
    if staked_amount >= config.gold_threshold {
        3 // Gold
    } else if staked_amount >= config.silver_threshold {
        2 // Silver
    } else if staked_amount >= config.bronze_threshold {
        1 // Bronze
    } else {
        0 // No tier
    }
}

fn get_max_cap_for_tier(tier: u8, config: &ProtocolConfig) -> u64 {
    let base_cap: u64 = 1_000_000_000; // 1000 tokens base
    let multiplier = match tier {
        3 => config.gold_cap_multiplier,
        2 => config.silver_cap_multiplier,
        1 => config.bronze_cap_multiplier,
        _ => 50, // Non-stakers get 0.5x base (50 basis points)
    };
    
    (base_cap as u128)
        .checked_mul(multiplier as u128)
        .unwrap_or(0)
        .checked_div(100)
        .unwrap_or(0) as u64
}

// ============================================================================
// Account Structures
// ============================================================================

/// Protocol configuration - global settings
#[account]
#[derive(Default)]
pub struct ProtocolConfig {
    /// Protocol admin
    pub authority: Pubkey,
    /// $SHADE token mint
    pub shade_mint: Pubkey,
    /// Fee vault for collected fees
    pub fee_vault: Pubkey,
    /// Staking vault for staked $SHADE
    pub staking_vault: Pubkey,
    /// Fee in basis points (e.g., 10 = 0.1%)
    pub fee_basis_points: u16,
    /// Total $SHADE staked
    pub total_staked: u64,
    /// Total fees collected
    pub total_fees_collected: u64,
    /// Total fees distributed to stakers
    pub total_fees_distributed: u64,
    /// Bronze tier threshold
    pub bronze_threshold: u64,
    /// Silver tier threshold
    pub silver_threshold: u64,
    /// Gold tier threshold
    pub gold_threshold: u64,
    /// Bronze tier cap multiplier (basis points)
    pub bronze_cap_multiplier: u16,
    /// Silver tier cap multiplier (basis points)
    pub silver_cap_multiplier: u16,
    /// Gold tier cap multiplier (basis points)
    pub gold_cap_multiplier: u16,
    /// PDA bump
    pub bump: u8,
}

impl ProtocolConfig {
    pub const LEN: usize = 8 +  // discriminator
        32 + // authority
        32 + // shade_mint
        32 + // fee_vault
        32 + // staking_vault
        2 +  // fee_basis_points
        8 +  // total_staked
        8 +  // total_fees_collected
        8 +  // total_fees_distributed
        8 +  // bronze_threshold
        8 +  // silver_threshold
        8 +  // gold_threshold
        2 +  // bronze_cap_multiplier
        2 +  // silver_cap_multiplier
        2 +  // gold_cap_multiplier
        1;   // bump
}

/// Staker account - tracks user's staking info
#[account]
#[derive(Default)]
pub struct Staker {
    /// User's wallet
    pub user: Pubkey,
    /// Amount of $SHADE staked
    pub staked_amount: u64,
    /// Pending rewards to claim
    pub pending_rewards: u64,
    /// Last reward claim timestamp
    pub last_claim_timestamp: i64,
    /// Current tier (0=None, 1=Bronze, 2=Silver, 3=Gold)
    pub tier: u8,
    /// PDA bump
    pub bump: u8,
}

impl Staker {
    pub const LEN: usize = 8 +  // discriminator
        32 + // user
        8 +  // staked_amount
        8 +  // pending_rewards
        8 +  // last_claim_timestamp
        1 +  // tier
        1;   // bump
}

/// Fog Pool - Shared liquidity reservoir where ownership is non-attributable
#[account]
#[derive(Default)]
pub struct FogPool {
    /// Authority who controls the fog pool
    pub authority: Pubkey,
    /// Token vault holding the pooled funds
    pub vault: Pubkey,
    /// Total tokens deposited into the pool
    pub total_deposited: u64,
    /// Total tokens spent from the pool
    pub total_spent: u64,
    /// Total fees generated from this pool
    pub total_fees_generated: u64,
    /// Number of active authorizations
    pub active_authorizations: u64,
    /// Unique seed for PDA derivation
    pub pool_seed: [u8; 32],
    /// PDA bump seed
    pub bump: u8,
}

impl FogPool {
    pub const LEN: usize = 8 + // discriminator
        32 + // authority
        32 + // vault
        8 +  // total_deposited
        8 +  // total_spent
        8 +  // total_fees_generated
        8 +  // active_authorizations
        32 + // pool_seed
        1;   // bump
}

/// Authorization - Cryptographic permission to spend from the fog
#[account]
#[derive(Default)]
pub struct Authorization {
    /// The fog pool this authorization draws from
    pub fog_pool: Pubkey,
    /// Who can use this authorization to spend
    pub authorized_spender: Pubkey,
    /// Who issued this authorization
    pub issuer: Pubkey,
    /// Maximum amount that can be spent
    pub spending_cap: u64,
    /// Amount already spent
    pub amount_spent: u64,
    /// When the authorization was created
    pub created_at: i64,
    /// When the authorization expires
    pub expires_at: i64,
    /// Purpose description (max 64 chars)
    pub purpose: String,
    /// Whether the authorization is still valid
    pub is_active: bool,
    /// PDA bump seed
    pub bump: u8,
}

impl Authorization {
    pub const LEN: usize = 8 +  // discriminator
        32 + // fog_pool
        32 + // authorized_spender
        32 + // issuer
        8 +  // spending_cap
        8 +  // amount_spent
        8 +  // created_at
        8 +  // expires_at
        68 + // purpose (4 byte len + 64 chars max)
        1 +  // is_active
        1;   // bump
}

// ============================================================================
// Context Structures (Account Validation)
// ============================================================================

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = ProtocolConfig::LEN,
        seeds = [b"protocol_config"],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// The $SHADE token mint
    pub shade_mint: Account<'info, token::Mint>,

    /// Fee vault (token account for collected fees)
    #[account(mut)]
    pub fee_vault: Account<'info, TokenAccount>,

    /// Staking vault (token account for staked $SHADE)
    #[account(mut)]
    pub staking_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateProtocol<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ ShadeError::Unauthorized
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init_if_needed,
        payer = user,
        space = Staker::LEN,
        seeds = [b"staker", user.key().as_ref()],
        bump
    )]
    pub staker: Account<'info, Staker>,

    #[account(
        mut,
        constraint = staking_vault.key() == protocol_config.staking_vault
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_shade_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"staker", user.key().as_ref()],
        bump = staker.bump,
        constraint = staker.user == user.key() @ ShadeError::Unauthorized
    )]
    pub staker: Account<'info, Staker>,

    #[account(
        mut,
        constraint = staking_vault.key() == protocol_config.staking_vault
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_shade_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"staker", user.key().as_ref()],
        bump = staker.bump,
        constraint = staker.user == user.key() @ ShadeError::Unauthorized
    )]
    pub staker: Account<'info, Staker>,

    #[account(
        mut,
        constraint = fee_vault.key() == protocol_config.fee_vault
    )]
    pub fee_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DistributeFees<'info> {
    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"staker", staker.user.as_ref()],
        bump = staker.bump
    )]
    pub staker: Account<'info, Staker>,
}

#[derive(Accounts)]
#[instruction(pool_seed: [u8; 32])]
pub struct InitializeFogPool<'info> {
    #[account(
        init,
        payer = authority,
        space = FogPool::LEN,
        seeds = [b"fog_pool", pool_seed.as_ref()],
        bump
    )]
    pub fog_pool: Account<'info, FogPool>,

    /// CHECK: Vault is validated by token program
    #[account(mut)]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DepositToFog<'info> {
    #[account(mut)]
    pub fog_pool: Account<'info, FogPool>,

    #[account(
        mut,
        constraint = vault.key() == fog_pool.vault
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct CreateAuthorization<'info> {
    #[account(
        init,
        payer = issuer,
        space = Authorization::LEN,
        seeds = [
            b"authorization",
            fog_pool.key().as_ref(),
            spender.key().as_ref(),
            &nonce.to_le_bytes()
        ],
        bump
    )]
    pub authorization: Account<'info, Authorization>,

    #[account(mut)]
    pub fog_pool: Account<'info, FogPool>,

    #[account(
        seeds = [b"protocol_config"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// Optional staker account for tier validation
    #[account(
        seeds = [b"staker", spender.key().as_ref()],
        bump
    )]
    pub staker: Option<Account<'info, Staker>>,

    /// CHECK: Can be any account that will receive the authorization
    pub spender: AccountInfo<'info>,

    #[account(
        mut,
        constraint = issuer.key() == fog_pool.authority @ ShadeError::Unauthorized
    )]
    pub issuer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Spend<'info> {
    #[account(
        mut,
        constraint = authorization.authorized_spender == spender.key() @ ShadeError::Unauthorized
    )]
    pub authorization: Account<'info, Authorization>,

    #[account(
        mut,
        constraint = authorization.fog_pool == fog_pool.key()
    )]
    pub fog_pool: Account<'info, FogPool>,

    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        constraint = vault.key() == fog_pool.vault
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = fee_vault.key() == protocol_config.fee_vault
    )]
    pub fee_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub spender: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RevokeAuthorization<'info> {
    #[account(
        mut,
        constraint = authorization.issuer == issuer.key() @ ShadeError::Unauthorized
    )]
    pub authorization: Account<'info, Authorization>,

    #[account(mut)]
    pub fog_pool: Account<'info, FogPool>,

    pub issuer: Signer<'info>,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct ProtocolInitialized {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub fee_basis_points: u16,
}

#[event]
pub struct FeeUpdated {
    pub old_fee: u16,
    pub new_fee: u16,
}

#[event]
pub struct Staked {
    pub user: Pubkey,
    pub amount: u64,
    pub new_total: u64,
    pub tier: u8,
}

#[event]
pub struct Unstaked {
    pub user: Pubkey,
    pub amount: u64,
    pub remaining: u64,
    pub tier: u8,
}

#[event]
pub struct RewardsClaimed {
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FeesDistributed {
    pub staker: Pubkey,
    pub amount: u64,
}

#[event]
pub struct FogPoolCreated {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct DepositMade {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AuthorizationCreated {
    pub authorization: Pubkey,
    pub fog_pool: Pubkey,
    pub spender: Pubkey,
    pub issuer: Pubkey,
    pub spending_cap: u64,
    pub expires_at: i64,
    pub purpose: String,
}

#[event]
pub struct SpendExecuted {
    pub authorization: Pubkey,
    pub fog_pool: Pubkey,
    pub spender: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub net_amount: u64,
    pub remaining: u64,
}

#[event]
pub struct AuthorizationRevoked {
    pub authorization: Pubkey,
    pub fog_pool: Pubkey,
    pub revoked_by: Pubkey,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum ShadeError {
    #[msg("Invalid amount specified")]
    InvalidAmount,
    #[msg("Purpose string too long (max 64 characters)")]
    PurposeTooLong,
    #[msg("Invalid expiry timestamp")]
    InvalidExpiry,
    #[msg("Authorization is not active")]
    AuthorizationInactive,
    #[msg("Authorization has expired")]
    AuthorizationExpired,
    #[msg("Amount exceeds spending cap")]
    ExceedsSpendingCap,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unauthorized action")]
    Unauthorized,
    #[msg("Fee too high (max 10%)")]
    FeeTooHigh,
    #[msg("Insufficient staked amount")]
    InsufficientStake,
    #[msg("No rewards to claim")]
    NoRewardsToClaim,
    #[msg("No stakers in the protocol")]
    NoStakers,
    #[msg("User is not staking")]
    NotStaking,
    #[msg("Spending cap exceeds tier limit")]
    ExceedsTierLimit,
}
