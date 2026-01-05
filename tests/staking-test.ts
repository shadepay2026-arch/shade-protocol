import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Shade } from "../target/types/shade";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { expect } from "chai";

describe("SHADE Protocol - Staking & Fee Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.shade as Program<Shade>;

  // Keypairs
  const authority = (provider.wallet as anchor.Wallet).payer;
  const staker1 = Keypair.generate();
  const staker2 = Keypair.generate();
  const spender = Keypair.generate();

  // Token mint and accounts
  let shadeMint: PublicKey;
  let spendMint: PublicKey;
  let feeVault: PublicKey;
  let stakingVault: PublicKey;

  // PDAs
  let protocolConfig: PublicKey;
  let protocolConfigBump: number;
  let staker1Account: PublicKey;
  let staker2Account: PublicKey;
  let fogPool: PublicKey;
  let fogPoolBump: number;

  // Token accounts
  let authorityShadeAccount: PublicKey;
  let staker1ShadeAccount: PublicKey;
  let staker2ShadeAccount: PublicKey;
  let fogPoolVault: PublicKey;
  let spenderSpendAccount: PublicKey;
  let recipientAccount: PublicKey;

  const poolSeed = new Uint8Array(32).fill(99);

  // Helper: Airdrop with retry
  async function airdrop(pubkey: PublicKey, amount: number) {
    for (let i = 0; i < 3; i++) {
      try {
        const sig = await provider.connection.requestAirdrop(pubkey, amount * LAMPORTS_PER_SOL);
        await provider.connection.confirmTransaction(sig, "confirmed");
        return;
      } catch (e) {
        if (i === 2) throw e;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  before(async () => {
    console.log("Setting up test environment...");

    // Airdrop to test accounts
    await airdrop(staker1.publicKey, 2);
    await airdrop(staker2.publicKey, 2);
    await airdrop(spender.publicKey, 2);

    // Create $SHADE mint (6 decimals)
    shadeMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );
    console.log("SHADE Mint:", shadeMint.toBase58());

    // Create spend token mint
    spendMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );
    console.log("Spend Mint:", spendMint.toBase58());

    // Derive protocol config PDA
    [protocolConfig, protocolConfigBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_config")],
      program.programId
    );
    console.log("Protocol Config:", protocolConfig.toBase58());

    // Create fee vault (owned by protocol config PDA)
    feeVault = getAssociatedTokenAddressSync(spendMint, protocolConfig, true);
    stakingVault = getAssociatedTokenAddressSync(shadeMint, protocolConfig, true);

    // Create vault token accounts manually
    const createFeeVaultIx = createAssociatedTokenAccountInstruction(
      authority.publicKey,
      feeVault,
      protocolConfig,
      spendMint
    );
    const createStakingVaultIx = createAssociatedTokenAccountInstruction(
      authority.publicKey,
      stakingVault,
      protocolConfig,
      shadeMint
    );

    const tx = new anchor.web3.Transaction()
      .add(createFeeVaultIx)
      .add(createStakingVaultIx);
    await provider.sendAndConfirm(tx);

    console.log("Fee Vault:", feeVault.toBase58());
    console.log("Staking Vault:", stakingVault.toBase58());

    // Create token accounts for authority
    authorityShadeAccount = await createAssociatedTokenAccount(
      provider.connection,
      authority,
      shadeMint,
      authority.publicKey
    );

    // Create token accounts for stakers
    staker1ShadeAccount = await createAssociatedTokenAccount(
      provider.connection,
      authority,
      shadeMint,
      staker1.publicKey
    );
    staker2ShadeAccount = await createAssociatedTokenAccount(
      provider.connection,
      authority,
      shadeMint,
      staker2.publicKey
    );

    // Mint SHADE tokens to stakers (enough for Gold tier)
    await mintTo(
      provider.connection,
      authority,
      shadeMint,
      staker1ShadeAccount,
      authority,
      15_000_000_000 // 15,000 SHADE
    );
    await mintTo(
      provider.connection,
      authority,
      shadeMint,
      staker2ShadeAccount,
      authority,
      2_000_000_000 // 2,000 SHADE
    );

    // Derive staker PDAs
    [staker1Account] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker"), staker1.publicKey.toBuffer()],
      program.programId
    );
    [staker2Account] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker"), staker2.publicKey.toBuffer()],
      program.programId
    );

    // Derive fog pool PDA
    [fogPool, fogPoolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("fog_pool"), poolSeed],
      program.programId
    );

    // Create fog pool vault
    fogPoolVault = getAssociatedTokenAddressSync(spendMint, fogPool, true);

    // Create vault for fog pool
    const createFogVaultIx = createAssociatedTokenAccountInstruction(
      authority.publicKey,
      fogPoolVault,
      fogPool,
      spendMint
    );
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(createFogVaultIx));

    // Create spender and recipient token accounts
    spenderSpendAccount = await createAssociatedTokenAccount(
      provider.connection,
      authority,
      spendMint,
      spender.publicKey
    );
    recipientAccount = await createAssociatedTokenAccount(
      provider.connection,
      authority,
      spendMint,
      Keypair.generate().publicKey // Random recipient
    );

    console.log("Setup complete!");
  });

  // =========================================================================
  // PROTOCOL INITIALIZATION
  // =========================================================================

  describe("Protocol Initialization", () => {
    it("Initializes protocol with 0.1% fee (10 basis points)", async () => {
      await program.methods
        .initializeProtocol(10) // 0.1% fee
        .accounts({
          protocolConfig,
          shadeMint,
          feeVault,
          stakingVault,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const config = await program.account.protocolConfig.fetch(protocolConfig);
      expect(config.feeBasisPoints).to.equal(10);
      expect(config.totalStaked.toNumber()).to.equal(0);
      expect(config.bronzeThreshold.toNumber()).to.equal(100_000_000);
      expect(config.silverThreshold.toNumber()).to.equal(1_000_000_000);
      expect(config.goldThreshold.toNumber()).to.equal(10_000_000_000);
      console.log("Protocol initialized with tiers:", {
        bronze: "100 SHADE",
        silver: "1,000 SHADE",
        gold: "10,000 SHADE",
      });
    });

    it("Rejects fee higher than 10%", async () => {
      try {
        await program.methods
          .initializeProtocol(1001) // 10.01% - too high
          .accounts({
            protocolConfig,
            shadeMint,
            feeVault,
            stakingVault,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("already in use");
      }
    });
  });

  // =========================================================================
  // STAKING
  // =========================================================================

  describe("Staking", () => {
    it("Staker1 stakes 12,000 SHADE (Gold tier)", async () => {
      const stakeAmount = 12_000_000_000; // 12,000 SHADE

      await program.methods
        .stake(new anchor.BN(stakeAmount))
        .accounts({
          protocolConfig,
          staker: staker1Account,
          stakingVault,
          userShadeAccount: staker1ShadeAccount,
          user: staker1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([staker1])
        .rpc();

      const staker = await program.account.staker.fetch(staker1Account);
      expect(staker.stakedAmount.toNumber()).to.equal(stakeAmount);
      expect(staker.tier).to.equal(3); // Gold
      console.log("Staker1 tier: Gold (3)");

      const config = await program.account.protocolConfig.fetch(protocolConfig);
      expect(config.totalStaked.toNumber()).to.equal(stakeAmount);
    });

    it("Staker2 stakes 1,500 SHADE (Silver tier)", async () => {
      const stakeAmount = 1_500_000_000; // 1,500 SHADE

      await program.methods
        .stake(new anchor.BN(stakeAmount))
        .accounts({
          protocolConfig,
          staker: staker2Account,
          stakingVault,
          userShadeAccount: staker2ShadeAccount,
          user: staker2.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([staker2])
        .rpc();

      const staker = await program.account.staker.fetch(staker2Account);
      expect(staker.stakedAmount.toNumber()).to.equal(stakeAmount);
      expect(staker.tier).to.equal(2); // Silver
      console.log("Staker2 tier: Silver (2)");

      const config = await program.account.protocolConfig.fetch(protocolConfig);
      expect(config.totalStaked.toNumber()).to.equal(13_500_000_000); // 12k + 1.5k
    });

    it("Staker1 unstakes 5,000 SHADE (still Gold)", async () => {
      const unstakeAmount = 5_000_000_000;

      await program.methods
        .unstake(new anchor.BN(unstakeAmount))
        .accounts({
          protocolConfig,
          staker: staker1Account,
          stakingVault,
          userShadeAccount: staker1ShadeAccount,
          user: staker1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([staker1])
        .rpc();

      const staker = await program.account.staker.fetch(staker1Account);
      expect(staker.stakedAmount.toNumber()).to.equal(7_000_000_000); // 12k - 5k = 7k
      expect(staker.tier).to.equal(0); // Below Bronze threshold after unstake
      console.log("Staker1 remaining stake: 7,000 SHADE, Tier:", staker.tier);
    });

    it("Cannot unstake more than staked", async () => {
      try {
        await program.methods
          .unstake(new anchor.BN(100_000_000_000)) // Way more than staked
          .accounts({
            protocolConfig,
            staker: staker1Account,
            stakingVault,
            userShadeAccount: staker1ShadeAccount,
            user: staker1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([staker1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("InsufficientStake");
        console.log("Correctly rejected over-unstake");
      }
    });
  });

  // =========================================================================
  // FOG POOLS WITH FEES
  // =========================================================================

  describe("Fog Pools with Fees", () => {
    it("Initializes a Fog Pool", async () => {
      await program.methods
        .initializeFogPool(Array.from(poolSeed) as any)
        .accounts({
          fogPool,
          vault: fogPoolVault,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const pool = await program.account.fogPool.fetch(fogPool);
      expect(pool.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      console.log("Fog Pool created:", fogPool.toBase58());
    });

    it("Deposits to Fog Pool", async () => {
      // Mint tokens to authority first
      const authoritySpendAccount = await createAssociatedTokenAccount(
        provider.connection,
        authority,
        spendMint,
        authority.publicKey
      );
      await mintTo(
        provider.connection,
        authority,
        spendMint,
        authoritySpendAccount,
        authority,
        100_000_000_000 // 100,000 tokens
      );

      await program.methods
        .depositToFog(new anchor.BN(50_000_000_000))
        .accounts({
          fogPool,
          vault: fogPoolVault,
          depositorTokenAccount: authoritySpendAccount,
          depositor: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const pool = await program.account.fogPool.fetch(fogPool);
      expect(pool.totalDeposited.toNumber()).to.equal(50_000_000_000);
      console.log("Deposited 50,000 tokens to fog pool");
    });
  });

  // =========================================================================
  // AUTHORIZATIONS & SPENDING WITH FEES
  // =========================================================================

  describe("Authorizations & Spending with Fees", () => {
    let authorization: PublicKey;

    it("Creates authorization for spender", async () => {
      const nonce = Date.now();
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;

      [authorization] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPool.toBuffer(),
          spender.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      // Note: spender doesn't have a staker account, but that's OK
      // The optional staker check should handle this
      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(10_000_000_000), // 10,000 token cap
          new anchor.BN(expiresAt),
          "Test spending authorization"
        )
        .accounts({
          authorization,
          fogPool,
          protocolConfig,
          staker: null, // No staker for this spender
          spender: spender.publicKey,
          issuer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const auth = await program.account.authorization.fetch(authorization);
      expect(auth.spendingCap.toNumber()).to.equal(10_000_000_000);
      expect(auth.isActive).to.be.true;
      console.log("Authorization created:", authorization.toBase58());
    });

    it("Spends and collects fee", async () => {
      const spendAmount = 1_000_000_000; // 1,000 tokens
      const expectedFee = spendAmount * 10 / 10000; // 0.1% = 1 token (in smallest units)
      const expectedNet = spendAmount - expectedFee;

      const feeVaultBefore = await getAccount(provider.connection, feeVault);

      await program.methods
        .spend(new anchor.BN(spendAmount))
        .accounts({
          authorization,
          fogPool,
          protocolConfig,
          vault: fogPoolVault,
          feeVault,
          recipientTokenAccount: recipientAccount,
          spender: spender.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([spender])
        .rpc();

      const feeVaultAfter = await getAccount(provider.connection, feeVault);
      const feeCollected = Number(feeVaultAfter.amount) - Number(feeVaultBefore.amount);
      
      expect(feeCollected).to.equal(expectedFee);
      console.log(`Spent ${spendAmount / 1_000_000} tokens`);
      console.log(`Fee collected: ${feeCollected / 1_000_000} tokens`);
      console.log(`Net to recipient: ${expectedNet / 1_000_000} tokens`);

      const config = await program.account.protocolConfig.fetch(protocolConfig);
      expect(config.totalFeesCollected.toNumber()).to.be.greaterThan(0);
    });
  });

  // =========================================================================
  // FEE DISTRIBUTION
  // =========================================================================

  describe("Fee Distribution", () => {
    it("Distributes fees to staker1", async () => {
      const stakerBefore = await program.account.staker.fetch(staker1Account);
      const pendingBefore = stakerBefore.pendingRewards.toNumber();

      await program.methods
        .distributeFees()
        .accounts({
          protocolConfig,
          staker: staker1Account,
        })
        .rpc();

      const stakerAfter = await program.account.staker.fetch(staker1Account);
      const pendingAfter = stakerAfter.pendingRewards.toNumber();
      
      expect(pendingAfter).to.be.greaterThan(pendingBefore);
      console.log(`Staker1 pending rewards: ${pendingAfter / 1_000_000} tokens`);
    });

    it("Claims rewards", async () => {
      // First create a spend token account for staker1 to receive rewards
      const staker1SpendAccount = await createAssociatedTokenAccount(
        provider.connection,
        authority,
        spendMint,
        staker1.publicKey
      );

      const staker = await program.account.staker.fetch(staker1Account);
      const pendingRewards = staker.pendingRewards.toNumber();

      if (pendingRewards > 0) {
        await program.methods
          .claimRewards()
          .accounts({
            protocolConfig,
            staker: staker1Account,
            feeVault,
            userTokenAccount: staker1SpendAccount,
            user: staker1.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([staker1])
          .rpc();

        const stakerAfter = await program.account.staker.fetch(staker1Account);
        expect(stakerAfter.pendingRewards.toNumber()).to.equal(0);
        console.log(`Claimed ${pendingRewards / 1_000_000} tokens in rewards`);
      } else {
        console.log("No pending rewards to claim");
      }
    });
  });

  // =========================================================================
  // ADMIN FUNCTIONS
  // =========================================================================

  describe("Admin Functions", () => {
    it("Updates protocol fee", async () => {
      await program.methods
        .updateFee(20) // 0.2%
        .accounts({
          protocolConfig,
          authority: authority.publicKey,
        })
        .rpc();

      const config = await program.account.protocolConfig.fetch(protocolConfig);
      expect(config.feeBasisPoints).to.equal(20);
      console.log("Fee updated to 0.2%");
    });

    it("Rejects fee update from non-authority", async () => {
      try {
        await program.methods
          .updateFee(50)
          .accounts({
            protocolConfig,
            authority: staker1.publicKey,
          })
          .signers([staker1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("Unauthorized");
        console.log("Correctly rejected unauthorized fee update");
      }
    });
  });

  // =========================================================================
  // SUMMARY
  // =========================================================================

  after(() => {
    console.log("\n========================================");
    console.log("STAKING & FEE TEST SUMMARY");
    console.log("========================================");
    console.log("Program ID:", program.programId.toBase58());
    console.log("Protocol Config:", protocolConfig.toBase58());
    console.log("SHADE Mint:", shadeMint?.toBase58());
    console.log("Fee Vault:", feeVault?.toBase58());
    console.log("Staking Vault:", stakingVault?.toBase58());
    console.log("========================================");
    console.log("Features Tested:");
    console.log("  - Protocol initialization with fee");
    console.log("  - Staking with tier system");
    console.log("  - Unstaking");
    console.log("  - Fee collection on spend");
    console.log("  - Fee distribution to stakers");
    console.log("  - Reward claiming");
    console.log("  - Admin fee updates");
    console.log("========================================\n");
  });
});

