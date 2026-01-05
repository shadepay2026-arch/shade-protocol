/**
 * SHADE Protocol v2 Test Suite
 * Tests the updated protocol with staking, fees, and tiers
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Shade } from "../target/types/shade";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("SHADE Protocol v2 Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Shade as Program<Shade>;
  const authority = (provider.wallet as anchor.Wallet).payer;

  // Mints
  let shadeMint: PublicKey;
  let spendMint: PublicKey;

  // Protocol accounts
  let protocolConfig: PublicKey;
  let feeVault: PublicKey;
  let stakingVault: PublicKey;

  // Fog pool accounts
  let fogPool: PublicKey;
  let fogPoolVault: PublicKey;

  // Token accounts
  let authorityShadeAccount: PublicKey;
  let authoritySpendAccount: PublicKey;
  let recipientAccount: PublicKey;

  // Staker account
  let stakerPda: PublicKey;

  // Use unique seeds per test run
  const poolSeed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) poolSeed[i] = Math.floor(Math.random() * 255);

  const recipient = Keypair.generate();

  console.log("\n========================================");
  console.log("SHADE Protocol v2 Test Suite");
  console.log("========================================\n");

  before(async () => {
    console.log("Setting up test environment...");
    console.log("Authority:", authority.publicKey.toBase58());

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
    [protocolConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_config")],
      program.programId
    );
    console.log("Protocol Config:", protocolConfig.toBase58());

    // Get fee vault and staking vault addresses (owned by protocol config PDA)
    feeVault = getAssociatedTokenAddressSync(spendMint, protocolConfig, true);
    stakingVault = getAssociatedTokenAddressSync(shadeMint, protocolConfig, true);

    // Create vault token accounts
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
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(createFeeVaultIx).add(createStakingVaultIx)
    );
    console.log("Fee Vault:", feeVault.toBase58());
    console.log("Staking Vault:", stakingVault.toBase58());

    // Create authority token accounts
    const shadeAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      shadeMint,
      authority.publicKey
    );
    authorityShadeAccount = shadeAccount.address;

    const spendAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      spendMint,
      authority.publicKey
    );
    authoritySpendAccount = spendAccount.address;

    // Mint SHADE tokens to authority
    await mintTo(
      provider.connection,
      authority,
      shadeMint,
      authorityShadeAccount,
      authority,
      20_000_000_000 // 20,000 SHADE
    );

    // Mint spend tokens to authority
    await mintTo(
      provider.connection,
      authority,
      spendMint,
      authoritySpendAccount,
      authority,
      100_000_000_000 // 100,000 tokens
    );

    // Create recipient token account
    const recipientTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      spendMint,
      recipient.publicKey
    );
    recipientAccount = recipientTokenAccount.address;

    // Derive staker PDA
    [stakerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker"), authority.publicKey.toBuffer()],
      program.programId
    );

    // Derive fog pool PDA
    [fogPool] = PublicKey.findProgramAddressSync(
      [Buffer.from("fog_pool"), Buffer.from(poolSeed)],
      program.programId
    );

    // Create fog pool vault
    fogPoolVault = getAssociatedTokenAddressSync(spendMint, fogPool, true);
    const createFogVaultIx = createAssociatedTokenAccountInstruction(
      authority.publicKey,
      fogPoolVault,
      fogPool,
      spendMint
    );
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(createFogVaultIx));
    console.log("Fog Pool:", fogPool.toBase58());
    console.log("Fog Pool Vault:", fogPoolVault.toBase58());

    console.log("Setup complete!\n");
  });

  // =========================================================================
  // PROTOCOL INITIALIZATION
  // =========================================================================
  describe("Protocol Initialization", () => {
    it("Initializes protocol with 10 basis point fee (0.1%)", async () => {
      await program.methods
        .initializeProtocol(10)
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
      console.log("  Protocol initialized with 0.1% fee");
      console.log("  Tier thresholds:", {
        bronze: `${config.bronzeThreshold.toNumber() / 1_000_000} SHADE`,
        silver: `${config.silverThreshold.toNumber() / 1_000_000} SHADE`,
        gold: `${config.goldThreshold.toNumber() / 1_000_000} SHADE`,
      });
    });
  });

  // =========================================================================
  // STAKING
  // =========================================================================
  describe("Staking", () => {
    it("Stakes 12,000 SHADE to reach Gold tier", async () => {
      const stakeAmount = 12_000_000_000; // 12,000 SHADE

      await program.methods
        .stake(new anchor.BN(stakeAmount))
        .accounts({
          protocolConfig,
          staker: stakerPda,
          stakingVault,
          userShadeAccount: authorityShadeAccount,
          user: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.stakedAmount.toNumber()).to.equal(stakeAmount);
      expect(staker.tier).to.equal(3); // Gold tier
      console.log("  Staked:", stakeAmount / 1_000_000, "SHADE");
      console.log("  Tier: Gold (3)");
    });

    it("Unstakes 2,000 SHADE (still Gold)", async () => {
      const unstakeAmount = 2_000_000_000;

      await program.methods
        .unstake(new anchor.BN(unstakeAmount))
        .accounts({
          protocolConfig,
          staker: stakerPda,
          stakingVault,
          userShadeAccount: authorityShadeAccount,
          user: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.stakedAmount.toNumber()).to.equal(10_000_000_000);
      console.log("  Remaining stake:", staker.stakedAmount.toNumber() / 1_000_000, "SHADE");
      console.log("  Tier:", staker.tier === 3 ? "Gold" : staker.tier === 2 ? "Silver" : "Bronze/None");
    });
  });

  // =========================================================================
  // FOG POOL
  // =========================================================================
  describe("Fog Pool", () => {
    it("Initializes fog pool", async () => {
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
      console.log("  Fog pool created");
    });

    it("Deposits 50,000 tokens to fog pool", async () => {
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
      console.log("  Deposited:", pool.totalDeposited.toNumber() / 1_000_000, "tokens");
    });

    it("Rejects zero deposit", async () => {
      try {
        await program.methods
          .depositToFog(new anchor.BN(0))
          .accounts({
            fogPool,
            vault: fogPoolVault,
            depositorTokenAccount: authoritySpendAccount,
            depositor: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("InvalidAmount");
        console.log("  Correctly rejected zero deposit");
      }
    });
  });

  // =========================================================================
  // AUTHORIZATIONS & SPENDING WITH FEES
  // =========================================================================
  describe("Authorizations & Spending", () => {
    let authorization: PublicKey;
    const nonce = Date.now();

    it("Creates authorization for self-spending", async () => {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;

      [authorization] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPool.toBuffer(),
          authority.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(10_000_000_000), // 10,000 token cap
          new anchor.BN(expiresAt),
          "Self-authorization for testing"
        )
        .accounts({
          authorization,
          fogPool,
          protocolConfig,
          staker: stakerPda,
          spender: authority.publicKey,
          issuer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const auth = await program.account.authorization.fetch(authorization);
      expect(auth.spendingCap.toNumber()).to.equal(10_000_000_000);
      expect(auth.isActive).to.be.true;
      console.log("  Authorization created:", authorization.toBase58());
    });

    it("Spends and collects 0.1% fee", async () => {
      const spendAmount = 1_000_000_000; // 1,000 tokens
      const expectedFee = spendAmount * 10 / 10000; // 0.1%

      const configBefore = await program.account.protocolConfig.fetch(protocolConfig);
      const feesBefore = configBefore.totalFeesCollected.toNumber();

      await program.methods
        .spend(new anchor.BN(spendAmount))
        .accounts({
          authorization,
          fogPool,
          protocolConfig,
          vault: fogPoolVault,
          feeVault,
          recipientTokenAccount: recipientAccount,
          spender: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const configAfter = await program.account.protocolConfig.fetch(protocolConfig);
      const feesCollected = configAfter.totalFeesCollected.toNumber() - feesBefore;

      expect(feesCollected).to.equal(expectedFee);
      console.log("  Spent:", spendAmount / 1_000_000, "tokens");
      console.log("  Fee collected:", feesCollected / 1_000_000, "tokens (0.1%)");

      const auth = await program.account.authorization.fetch(authorization);
      console.log("  Remaining cap:", (auth.spendingCap.toNumber() - auth.amountSpent.toNumber()) / 1_000_000, "tokens");
    });

    it("Revokes authorization", async () => {
      await program.methods
        .revokeAuthorization()
        .accounts({
          authorization,
          fogPool,
          issuer: authority.publicKey,
        })
        .rpc();

      const auth = await program.account.authorization.fetch(authorization);
      expect(auth.isActive).to.be.false;
      console.log("  Authorization revoked");
    });

    it("Fails to spend with revoked authorization", async () => {
      try {
        await program.methods
          .spend(new anchor.BN(100_000_000))
          .accounts({
            authorization,
            fogPool,
            protocolConfig,
            vault: fogPoolVault,
            feeVault,
            recipientTokenAccount: recipientAccount,
            spender: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (e: any) {
        expect(e.message).to.include("AuthorizationInactive");
        console.log("  Correctly rejected spend with revoked auth");
      }
    });
  });

  // =========================================================================
  // FEE DISTRIBUTION
  // =========================================================================
  describe("Fee Distribution", () => {
    it("Distributes fees to staker", async () => {
      await program.methods
        .distributeFees()
        .accounts({
          protocolConfig,
          staker: stakerPda,
        })
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      console.log("  Pending rewards:", staker.pendingRewards.toNumber() / 1_000_000, "tokens");
    });

    it("Claims accumulated rewards", async () => {
      const staker = await program.account.staker.fetch(stakerPda);
      const pending = staker.pendingRewards.toNumber();

      if (pending > 0) {
        await program.methods
          .claimRewards()
          .accounts({
            protocolConfig,
            staker: stakerPda,
            feeVault,
            userTokenAccount: authoritySpendAccount,
            user: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        const stakerAfter = await program.account.staker.fetch(stakerPda);
        expect(stakerAfter.pendingRewards.toNumber()).to.equal(0);
        console.log("  Claimed:", pending / 1_000_000, "tokens in rewards");
      } else {
        console.log("  No pending rewards to claim");
      }
    });
  });

  // =========================================================================
  // ADMIN
  // =========================================================================
  describe("Admin Functions", () => {
    it("Updates protocol fee to 0.2%", async () => {
      await program.methods
        .updateFee(20)
        .accounts({
          protocolConfig,
          authority: authority.publicKey,
        })
        .rpc();

      const config = await program.account.protocolConfig.fetch(protocolConfig);
      expect(config.feeBasisPoints).to.equal(20);
      console.log("  Fee updated to 0.2%");
    });
  });

  // =========================================================================
  // SUMMARY
  // =========================================================================
  after(() => {
    console.log("\n========================================");
    console.log("TEST SUMMARY");
    console.log("========================================");
    console.log("Program ID:", program.programId.toBase58());
    console.log("Protocol Config:", protocolConfig.toBase58());
    console.log("========================================");
    console.log("Features Tested:");
    console.log("  - Protocol initialization with fee & tiers");
    console.log("  - Staking with tier calculation (Gold)");
    console.log("  - Unstaking");
    console.log("  - Fog pool creation and deposits");
    console.log("  - Authorization creation with tier validation");
    console.log("  - Spending with fee collection");
    console.log("  - Authorization revocation");
    console.log("  - Fee distribution to stakers");
    console.log("  - Reward claiming");
    console.log("  - Admin fee updates");
    console.log("========================================\n");
  });
});

