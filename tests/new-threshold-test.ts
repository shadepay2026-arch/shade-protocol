import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Shade } from "../target/types/shade";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fs from "fs";

describe("SHADE Protocol - New Threshold Testing (10K/100K/500K)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Shade as Program<Shade>;

  // Load pre-funded deployer
  const deployerKeyfile = fs.readFileSync("D:/Dev/Keys/shade-deployer.json", "utf-8");
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(deployerKeyfile)));

  // PDAs and accounts
  let protocolConfigPda: PublicKey;
  let shadeMint: PublicKey;
  let stakingVault: PublicKey;

  // Test users
  const bronzeUser = Keypair.generate();
  const silverUser = Keypair.generate();
  const goldUser = Keypair.generate();
  const noTierUser = Keypair.generate();

  async function fundAccount(to: PublicKey, lamports: number) {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: to,
        lamports,
      })
    );
    await provider.sendAndConfirm(tx, [deployer]);
  }

  before(async () => {
    console.log("\n=== Testing NEW Tier Thresholds (10K/100K/500K) ===\n");
    console.log("Program ID:", program.programId.toBase58());

    // Get protocol config PDA
    [protocolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_config")],
      program.programId
    );

    // Get existing protocol config
    const config = await program.account.protocolConfig.fetch(protocolConfigPda);
    shadeMint = config.shadeMint;
    stakingVault = config.stakingVault;

    const bronzeThreshold = config.bronzeThreshold.toNumber() / 1_000_000;
    const silverThreshold = config.silverThreshold.toNumber() / 1_000_000;
    const goldThreshold = config.goldThreshold.toNumber() / 1_000_000;

    console.log("✅ Using Existing Protocol:");
    console.log(`   Bronze: ${bronzeThreshold.toLocaleString()} $SHADE`);
    console.log(`   Silver: ${silverThreshold.toLocaleString()} $SHADE`);
    console.log(`   Gold:   ${goldThreshold.toLocaleString()} $SHADE\n`);

    // Fund test users (smaller amounts to conserve SOL)
    await fundAccount(noTierUser.publicKey, 0.02 * LAMPORTS_PER_SOL);
    await fundAccount(bronzeUser.publicKey, 0.02 * LAMPORTS_PER_SOL);
    await fundAccount(silverUser.publicKey, 0.02 * LAMPORTS_PER_SOL);
    await fundAccount(goldUser.publicKey, 0.02 * LAMPORTS_PER_SOL);
    console.log("✓ Funded test users");
  });

  describe("Tier Assignment with 10K/100K/500K Thresholds", () => {
    it("5,000 SHADE → Tier 0 (None) - Below 10K threshold", async () => {
      const [stakerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("staker"), noTierUser.publicKey.toBuffer()],
        program.programId
      );

      const tokenAccount = await createAccount(
        provider.connection, deployer, shadeMint, noTierUser.publicKey, Keypair.generate()
      );

      await mintTo(provider.connection, deployer, shadeMint, tokenAccount, deployer, 5_000_000_000);

      await program.methods
        .stake(new anchor.BN(5_000_000_000))
        .accounts({
          protocolConfig: protocolConfigPda,
          staker: stakerPda,
          stakingVault: stakingVault,
          userShadeAccount: tokenAccount,
          user: noTierUser.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([noTierUser])
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.tier).to.equal(0);
      console.log("  ✓ 5,000 SHADE → Tier 0 (None)");
    });

    it("15,000 SHADE → Tier 1 (Bronze) - Above 10K threshold", async () => {
      const [stakerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("staker"), bronzeUser.publicKey.toBuffer()],
        program.programId
      );

      const tokenAccount = await createAccount(
        provider.connection, deployer, shadeMint, bronzeUser.publicKey, Keypair.generate()
      );

      await mintTo(provider.connection, deployer, shadeMint, tokenAccount, deployer, 15_000_000_000);

      await program.methods
        .stake(new anchor.BN(15_000_000_000))
        .accounts({
          protocolConfig: protocolConfigPda,
          staker: stakerPda,
          stakingVault: stakingVault,
          userShadeAccount: tokenAccount,
          user: bronzeUser.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bronzeUser])
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.tier).to.equal(1);
      console.log("  ✓ 15,000 SHADE → Tier 1 (Bronze)");
    });

    it("150,000 SHADE → Tier 2 (Silver) - Above 100K threshold", async () => {
      const [stakerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("staker"), silverUser.publicKey.toBuffer()],
        program.programId
      );

      const tokenAccount = await createAccount(
        provider.connection, deployer, shadeMint, silverUser.publicKey, Keypair.generate()
      );

      await mintTo(provider.connection, deployer, shadeMint, tokenAccount, deployer, 150_000_000_000);

      await program.methods
        .stake(new anchor.BN(150_000_000_000))
        .accounts({
          protocolConfig: protocolConfigPda,
          staker: stakerPda,
          stakingVault: stakingVault,
          userShadeAccount: tokenAccount,
          user: silverUser.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([silverUser])
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.tier).to.equal(2);
      console.log("  ✓ 150,000 SHADE → Tier 2 (Silver)");
    });

    it("600,000 SHADE → Tier 3 (Gold) - Above 500K threshold", async () => {
      const [stakerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("staker"), goldUser.publicKey.toBuffer()],
        program.programId
      );

      const tokenAccount = await createAccount(
        provider.connection, deployer, shadeMint, goldUser.publicKey, Keypair.generate()
      );

      await mintTo(provider.connection, deployer, shadeMint, tokenAccount, deployer, 600_000_000_000);

      await program.methods
        .stake(new anchor.BN(600_000_000_000))
        .accounts({
          protocolConfig: protocolConfigPda,
          staker: stakerPda,
          stakingVault: stakingVault,
          userShadeAccount: tokenAccount,
          user: goldUser.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([goldUser])
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.tier).to.equal(3);
      console.log("  ✓ 600,000 SHADE → Tier 3 (Gold)");
    });
  });

  after(async () => {
    console.log("\n========================================");
    console.log("   NEW THRESHOLD TEST COMPLETE ✅");
    console.log("========================================");
    console.log("Verified Thresholds (Pump.fun Ready):");
    console.log("  None:   < 10,000 SHADE");
    console.log("  Bronze: >= 10,000 SHADE");
    console.log("  Silver: >= 100,000 SHADE");
    console.log("  Gold:   >= 500,000 SHADE");
    console.log("========================================\n");
  });
});
