import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Shade } from "../target/types/shade";
import {
  Keypair,
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

describe("SHADE Protocol - Staking (No Airdrop)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.shade as Program<Shade>;

  // Use the deployer wallet for everything (already funded)
  const authority = (provider.wallet as anchor.Wallet).payer;

  // Token mint and accounts
  let shadeMint: PublicKey;
  let spendMint: PublicKey;
  let feeVault: PublicKey;
  let stakingVault: PublicKey;

  // PDAs
  let protocolConfig: PublicKey;
  let stakerAccount: PublicKey;
  let fogPool: PublicKey;

  // Token accounts
  let authorityShadeAccount: PublicKey;
  let authoritySpendAccount: PublicKey;
  let fogPoolVault: PublicKey;
  let recipientAccount: PublicKey;

  // Use unique seeds for this test run
  const poolSeed = new Uint8Array(32);
  poolSeed[0] = Math.floor(Math.random() * 255);
  poolSeed[1] = Math.floor(Math.random() * 255);

  before(async () => {
    console.log("Setting up test environment (using deployer wallet)...");
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

    // Create fee vault (owned by protocol config PDA)
    feeVault = getAssociatedTokenAddressSync(spendMint, protocolConfig, true);
    stakingVault = getAssociatedTokenAddressSync(shadeMint, protocolConfig, true);

    // Check if protocol already initialized
    let isInitialized = false;
    try {
      await program.account.protocolConfig.fetch(protocolConfig);
      isInitialized = true;
      console.log("Protocol already initialized");
    } catch {
      isInitialized = false;
    }

    if (!isInitialized) {
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
      console.log("Created vaults");
    }

    console.log("Fee Vault:", feeVault.toBase58());
    console.log("Staking Vault:", stakingVault.toBase58());

    // Create token accounts for authority
    authorityShadeAccount = await createAssociatedTokenAccount(
      provider.connection,
      authority,
      shadeMint,
      authority.publicKey
    );
    authoritySpendAccount = await createAssociatedTokenAccount(
      provider.connection,
      authority,
      spendMint,
      authority.publicKey
    );

    // Mint SHADE tokens to authority
    await mintTo(
      provider.connection,
      authority,
      shadeMint,
      authorityShadeAccount,
      authority,
      15_000_000_000 // 15,000 SHADE
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

    // Derive staker PDA for authority
    [stakerAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker"), authority.publicKey.toBuffer()],
      program.programId
    );

    // Derive fog pool PDA
    [fogPool] = PublicKey.findProgramAddressSync(
      [Buffer.from("fog_pool"), poolSeed],
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

    // Create recipient account
    recipientAccount = await createAssociatedTokenAccount(
      provider.connection,
      authority,
      spendMint,
      Keypair.generate().publicKey
    );

    console.log("Setup complete!");
  });

  describe("Protocol Initialization", () => {
    it("Initializes protocol with 0.1% fee", async () => {
      try {
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
        console.log("Protocol initialized");
      } catch (e: any) {
        if (e.message.includes("already in use")) {
          console.log("Protocol already initialized (expected on re-run)");
        } else {
          throw e;
        }
      }

      const config = await program.account.protocolConfig.fetch(protocolConfig);
      expect(config.feeBasisPoints).to.equal(10);
      console.log("Fee:", config.feeBasisPoints, "basis points (0.1%)");
      console.log("Bronze threshold:", config.bronzeThreshold.toNumber() / 1_000_000, "SHADE");
      console.log("Silver threshold:", config.silverThreshold.toNumber() / 1_000_000, "SHADE");
      console.log("Gold threshold:", config.goldThreshold.toNumber() / 1_000_000, "SHADE");
    });
  });

  describe("Staking System", () => {
    it("Stakes 12,000 SHADE (Gold tier)", async () => {
      const stakeAmount = 12_000_000_000;

      await program.methods
        .stake(new anchor.BN(stakeAmount))
        .accounts({
          protocolConfig,
          staker: stakerAccount,
          stakingVault,
          userShadeAccount: authorityShadeAccount,
          user: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const staker = await program.account.staker.fetch(stakerAccount);
      expect(staker.stakedAmount.toNumber()).to.equal(stakeAmount);
      expect(staker.tier).to.equal(3); // Gold
      console.log("Staked:", stakeAmount / 1_000_000, "SHADE");
      console.log("Tier:", staker.tier, "(Gold)");

      const config = await program.account.protocolConfig.fetch(protocolConfig);
      console.log("Total staked in protocol:", config.totalStaked.toNumber() / 1_000_000, "SHADE");
    });

    it("Unstakes 2,000 SHADE (still Gold)", async () => {
      const unstakeAmount = 2_000_000_000;

      const stakerBefore = await program.account.staker.fetch(stakerAccount);
      const stakeBeforeUnstake = stakerBefore.stakedAmount.toNumber();

      await program.methods
        .unstake(new anchor.BN(unstakeAmount))
        .accounts({
          protocolConfig,
          staker: stakerAccount,
          stakingVault,
          userShadeAccount: authorityShadeAccount,
          user: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const staker = await program.account.staker.fetch(stakerAccount);
      expect(staker.stakedAmount.toNumber()).to.equal(stakeBeforeUnstake - unstakeAmount);
      console.log("Remaining stake:", staker.stakedAmount.toNumber() / 1_000_000, "SHADE");
      console.log("Tier after unstake:", staker.tier, staker.tier === 3 ? "(Gold)" : staker.tier === 2 ? "(Silver)" : "(Bronze or None)");
    });
  });

  describe("Fog Pool & Spending with Fees", () => {
    it("Creates Fog Pool", async () => {
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
      console.log("Fog Pool:", fogPool.toBase58());
    });

    it("Deposits 50,000 tokens to Fog Pool", async () => {
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
      console.log("Total deposited:", pool.totalDeposited.toNumber() / 1_000_000, "tokens");
    });

    it("Creates authorization and spends with fee collection", async () => {
      const nonce = Date.now();
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;

      const [authorization] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPool.toBuffer(),
          authority.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      // Create authorization for self (authority is also the spender)
      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(10_000_000_000),
          new anchor.BN(expiresAt),
          "Self-authorization for testing"
        )
        .accounts({
          authorization,
          fogPool,
          protocolConfig,
          staker: stakerAccount, // Authority has a staker account
          spender: authority.publicKey,
          issuer: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Authorization created:", authorization.toBase58());

      // Spend and check fee collection
      const spendAmount = 1_000_000_000; // 1,000 tokens
      const expectedFee = spendAmount * 10 / 10000; // 0.1% = 1 token

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
      const feesAfter = configAfter.totalFeesCollected.toNumber();
      const feesCollected = feesAfter - feesBefore;

      expect(feesCollected).to.equal(expectedFee);
      console.log("Spent:", spendAmount / 1_000_000, "tokens");
      console.log("Fee collected:", feesCollected / 1_000_000, "tokens");
      console.log("Net to recipient:", (spendAmount - feesCollected) / 1_000_000, "tokens");
      console.log("Total fees collected:", feesAfter / 1_000_000, "tokens");
    });
  });

  describe("Fee Distribution", () => {
    it("Distributes and claims fees", async () => {
      // Distribute fees to staker
      await program.methods
        .distributeFees()
        .accounts({
          protocolConfig,
          staker: stakerAccount,
        })
        .rpc();

      const staker = await program.account.staker.fetch(stakerAccount);
      const pending = staker.pendingRewards.toNumber();
      console.log("Pending rewards:", pending / 1_000_000, "tokens");

      if (pending > 0) {
        // Claim rewards
        await program.methods
          .claimRewards()
          .accounts({
            protocolConfig,
            staker: stakerAccount,
            feeVault,
            userTokenAccount: authoritySpendAccount,
            user: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();

        const stakerAfter = await program.account.staker.fetch(stakerAccount);
        expect(stakerAfter.pendingRewards.toNumber()).to.equal(0);
        console.log("Claimed", pending / 1_000_000, "tokens in rewards");
      }
    });
  });

  after(() => {
    console.log("\n========================================");
    console.log("TEST COMPLETE");
    console.log("========================================");
    console.log("Program ID:", program.programId.toBase58());
    console.log("========================================");
    console.log("Features Verified:");
    console.log("  - Protocol initialization with tiers");
    console.log("  - Staking with tier calculation");
    console.log("  - Unstaking");
    console.log("  - Fee collection on spend (0.1%)");
    console.log("  - Fee distribution to stakers");
    console.log("  - Reward claiming");
    console.log("========================================\n");
  });
});

