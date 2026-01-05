use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("XEyyUoXxLN3DE9ezqwUvPp8FZehunWxmkcsWyoi8vzG");

/// SHADE Protocol: Authorization-Based Finance
/// Spend without owning - cryptographic permission to spend from shared liquidity
#[program]
pub mod shade {
    use super::*;

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

    /// Deposit funds into the Fog Pool
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

    /// Create a spending authorization - permission to spend from the fog
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

        // Transfer from vault to recipient using PDA authority
        let fog_pool = &ctx.accounts.fog_pool;
        let seeds = &[
            b"fog_pool",
            fog_pool.pool_seed.as_ref(),
            &[fog_pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: fog_pool.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;

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

        emit!(SpendExecuted {
            authorization: authorization.key(),
            fog_pool: fog_pool.key(),
            spender: ctx.accounts.spender.key(),
            recipient: ctx.accounts.recipient_token_account.key(),
            amount,
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
// Account Structures
// ============================================================================

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
        constraint = vault.key() == fog_pool.vault
    )]
    pub vault: Account<'info, TokenAccount>,

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
}
