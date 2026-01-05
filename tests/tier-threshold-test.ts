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

describe("SHADE Protocol - Tier Threshold Tests", () => {
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

  // On-chain thresholds
  let bronzeThreshold: number;
  let silverThreshold: number;
  let goldThreshold: number;

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
    console.log("\n=== Testing Tier Assignment Logic ===\n");

    // Get protocol config
    [protocolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_config")],
      program.programId
    );

    // Get existing protocol config
    const config = await program.account.protocolConfig.fetch(protocolConfigPda);
    shadeMint = config.shadeMint;
    stakingVault = config.stakingVault;

    // Get on-chain thresholds (in tokens, not base units)
    bronzeThreshold = config.bronzeThreshold.toNumber() / 1_000_000;
    silverThreshold = config.silverThreshold.toNumber() / 1_000_000;
    goldThreshold = config.goldThreshold.toNumber() / 1_000_000;

    console.log("Current On-Chain Thresholds:");
    console.log(`  Bronze: ${bronzeThreshold.toLocaleString()} $SHADE`);
    console.log(`  Silver: ${silverThreshold.toLocaleString()} $SHADE`);
    console.log(`  Gold:   ${goldThreshold.toLocaleString()} $SHADE\n`);
    console.log("✓ Protocol config loaded");
  });

  describe("Tier Assignment with Current Thresholds", () => {
    it("User below Bronze threshold gets Tier 0 (None)", async () => {
      const testUser = Keypair.generate();
      await fundAccount(testUser.publicKey, 0.05 * LAMPORTS_PER_SOL);

      const [stakerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("staker"), testUser.publicKey.toBuffer()],
        program.programId
      );

      const tokenAccount = await createAccount(
        provider.connection, deployer, shadeMint, testUser.publicKey, Keypair.generate()
      );

      // Stake amount below bronze threshold (half of bronze)
      const stakeAmount = Math.floor(bronzeThreshold / 2);
      await mintTo(provider.connection, deployer, shadeMint, tokenAccount, deployer, stakeAmount * 1_000_000);

      await program.methods
        .stake(new anchor.BN(stakeAmount * 1_000_000))
        .accounts({
          protocolConfig: protocolConfigPda,
          staker: stakerPda,
          stakingVault: stakingVault,
          userShadeAccount: tokenAccount,
          user: testUser.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([testUser])
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.tier).to.equal(0);
      console.log(`  ✓ ${stakeAmount.toLocaleString()} SHADE → Tier 0 (None)`);
    });

    it("User at Bronze threshold gets Tier 1 (Bronze)", async () => {
      const testUser = Keypair.generate();
      await fundAccount(testUser.publicKey, 0.05 * LAMPORTS_PER_SOL);

      const [stakerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("staker"), testUser.publicKey.toBuffer()],
        program.programId
      );

      const tokenAccount = await createAccount(
        provider.connection, deployer, shadeMint, testUser.publicKey, Keypair.generate()
      );

      // Stake exactly bronze threshold
      await mintTo(provider.connection, deployer, shadeMint, tokenAccount, deployer, bronzeThreshold * 1_000_000);

      await program.methods
        .stake(new anchor.BN(bronzeThreshold * 1_000_000))
        .accounts({
          protocolConfig: protocolConfigPda,
          staker: stakerPda,
          stakingVault: stakingVault,
          userShadeAccount: tokenAccount,
          user: testUser.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([testUser])
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.tier).to.equal(1);
      console.log(`  ✓ ${bronzeThreshold.toLocaleString()} SHADE → Tier 1 (Bronze)`);
    });

    it("User at Silver threshold gets Tier 2 (Silver)", async () => {
      const testUser = Keypair.generate();
      await fundAccount(testUser.publicKey, 0.05 * LAMPORTS_PER_SOL);

      const [stakerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("staker"), testUser.publicKey.toBuffer()],
        program.programId
      );

      const tokenAccount = await createAccount(
        provider.connection, deployer, shadeMint, testUser.publicKey, Keypair.generate()
      );

      // Stake exactly silver threshold
      await mintTo(provider.connection, deployer, shadeMint, tokenAccount, deployer, silverThreshold * 1_000_000);

      await program.methods
        .stake(new anchor.BN(silverThreshold * 1_000_000))
        .accounts({
          protocolConfig: protocolConfigPda,
          staker: stakerPda,
          stakingVault: stakingVault,
          userShadeAccount: tokenAccount,
          user: testUser.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([testUser])
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.tier).to.equal(2);
      console.log(`  ✓ ${silverThreshold.toLocaleString()} SHADE → Tier 2 (Silver)`);
    });

    it("User at Gold threshold gets Tier 3 (Gold)", async () => {
      const testUser = Keypair.generate();
      await fundAccount(testUser.publicKey, 0.05 * LAMPORTS_PER_SOL);

      const [stakerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("staker"), testUser.publicKey.toBuffer()],
        program.programId
      );

      const tokenAccount = await createAccount(
        provider.connection, deployer, shadeMint, testUser.publicKey, Keypair.generate()
      );

      // Stake exactly gold threshold
      await mintTo(provider.connection, deployer, shadeMint, tokenAccount, deployer, goldThreshold * 1_000_000);

      await program.methods
        .stake(new anchor.BN(goldThreshold * 1_000_000))
        .accounts({
          protocolConfig: protocolConfigPda,
          staker: stakerPda,
          stakingVault: stakingVault,
          userShadeAccount: tokenAccount,
          user: testUser.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([testUser])
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.tier).to.equal(3);
      console.log(`  ✓ ${goldThreshold.toLocaleString()} SHADE → Tier 3 (Gold)`);
    });

    it("User above Gold threshold stays at Tier 3 (Gold)", async () => {
      const testUser = Keypair.generate();
      await fundAccount(testUser.publicKey, 0.05 * LAMPORTS_PER_SOL);

      const [stakerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("staker"), testUser.publicKey.toBuffer()],
        program.programId
      );

      const tokenAccount = await createAccount(
        provider.connection, deployer, shadeMint, testUser.publicKey, Keypair.generate()
      );

      // Stake 2x gold threshold
      const stakeAmount = goldThreshold * 2;
      await mintTo(provider.connection, deployer, shadeMint, tokenAccount, deployer, stakeAmount * 1_000_000);

      await program.methods
        .stake(new anchor.BN(stakeAmount * 1_000_000))
        .accounts({
          protocolConfig: protocolConfigPda,
          staker: stakerPda,
          stakingVault: stakingVault,
          userShadeAccount: tokenAccount,
          user: testUser.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([testUser])
        .rpc();

      const staker = await program.account.staker.fetch(stakerPda);
      expect(staker.tier).to.equal(3);
      console.log(`  ✓ ${stakeAmount.toLocaleString()} SHADE → Tier 3 (Gold)`);
    });
  });

  after(async () => {
    console.log("\n========================================");
    console.log("   TIER THRESHOLD TEST SUMMARY");
    console.log("========================================");
    console.log("Tier logic verified:");
    console.log(`  None:   < ${bronzeThreshold.toLocaleString()} SHADE`);
    console.log(`  Bronze: >= ${bronzeThreshold.toLocaleString()} SHADE`);
    console.log(`  Silver: >= ${silverThreshold.toLocaleString()} SHADE`);
    console.log(`  Gold:   >= ${goldThreshold.toLocaleString()} SHADE`);
    console.log("========================================\n");
  });
});
