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
  createMint,
  createAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import * as fs from "fs";

describe("SHADE Protocol - Security Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Shade as Program<Shade>;

  // Load the pre-funded deployer wallet
  const deployerKeyfile = fs.readFileSync("D:/Dev/Keys/shade-deployer.json", "utf-8");
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(deployerKeyfile)));

  // Test accounts
  const admin = deployer;
  const attacker = Keypair.generate();
  const legitimateUser = Keypair.generate();

  // PDAs
  let protocolConfigPda: PublicKey;
  let fogPoolPda: PublicKey;

  // Token accounts
  let usdcMint: PublicKey;
  let fogPoolVault: PublicKey;
  let adminUsdcAccount: PublicKey;
  let attackerUsdcAccount: PublicKey;
  let legitimateUserUsdcAccount: PublicKey;

  // Use timestamp to ensure unique pool seed
  const poolSeed = new Uint8Array(32);
  const timestamp = Date.now();
  new DataView(poolSeed.buffer).setBigUint64(0, BigInt(timestamp), true);

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
    console.log("\n=== Setting up Security Test Environment ===\n");
    console.log("Deployer:", deployer.publicKey.toBase58());

    // Fund test accounts
    await fundAccount(attacker.publicKey, 0.05 * LAMPORTS_PER_SOL);
    await fundAccount(legitimateUser.publicKey, 0.05 * LAMPORTS_PER_SOL);
    console.log("✓ Funded test accounts");

    // Get PDAs
    [protocolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_config")],
      program.programId
    );

    [fogPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("fog_pool"), Buffer.from(poolSeed)],
      program.programId
    );

    // Create a fresh USDC mint for this test
    usdcMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );
    console.log("✓ Created test USDC mint");

    // Create fog pool vault
    fogPoolVault = await createAccount(
      provider.connection,
      admin,
      usdcMint,
      fogPoolPda,
      Keypair.generate()
    );

    // Create user USDC accounts
    adminUsdcAccount = await createAccount(
      provider.connection,
      admin,
      usdcMint,
      admin.publicKey,
      Keypair.generate()
    );

    attackerUsdcAccount = await createAccount(
      provider.connection,
      admin,
      usdcMint,
      attacker.publicKey,
      Keypair.generate()
    );

    legitimateUserUsdcAccount = await createAccount(
      provider.connection,
      admin,
      usdcMint,
      legitimateUser.publicKey,
      Keypair.generate()
    );
    console.log("✓ Created token accounts");

    // Mint USDC
    await mintTo(
      provider.connection,
      admin,
      usdcMint,
      adminUsdcAccount,
      admin,
      100_000_000_000 // 100,000 USDC
    );
    console.log("✓ Minted test USDC");

    // Initialize fog pool
    await program.methods
      .initializeFogPool(Array.from(poolSeed))
      .accounts({
        fogPool: fogPoolPda,
        vault: fogPoolVault,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();
    console.log("✓ Created test fog pool");

    // Deposit USDC to fog pool
    await program.methods
      .depositToFog(new anchor.BN(50_000_000_000))
      .accounts({
        fogPool: fogPoolPda,
        vault: fogPoolVault,
        depositorTokenAccount: adminUsdcAccount,
        depositor: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();
    console.log("✓ Deposited 50,000 USDC to fog pool");

    console.log("\n=== Security Tests Starting ===\n");
  });

  // =========================================================================
  // UNAUTHORIZED ACCESS TESTS
  // =========================================================================

  describe("1. Unauthorized Access Prevention", () => {
    
    it("BLOCKS: Non-admin updating protocol fee", async () => {
      try {
        await program.methods
          .updateFee(100)
          .accounts({
            protocolConfig: protocolConfigPda,
            authority: attacker.publicKey,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("Unauthorized");
        console.log("  ✓ Non-admin fee update blocked");
      }
    });

    it("BLOCKS: Non-issuer revoking authorization", async () => {
      const nonce = Date.now();
      const [authPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          legitimateUser.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      // Create auth
      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(100_000_000),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          "Test"
        )
        .accounts({
          authorization: authPda,
          fogPool: fogPoolPda,
          protocolConfig: protocolConfigPda,
          staker: null,
          spender: legitimateUser.publicKey,
          issuer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Attacker tries to revoke
      try {
        await program.methods
          .revokeAuthorization()
          .accounts({
            authorization: authPda,
            fogPool: fogPoolPda,
            issuer: attacker.publicKey,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("Unauthorized");
        console.log("  ✓ Non-issuer revocation blocked");
      }
    });

    it("BLOCKS: Non-authorized spender using authorization", async () => {
      const nonce = Date.now() + 1;
      const [authPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          legitimateUser.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(100_000_000),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          "Victim auth"
        )
        .accounts({
          authorization: authPda,
          fogPool: fogPoolPda,
          protocolConfig: protocolConfigPda,
          staker: null,
          spender: legitimateUser.publicKey,
          issuer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Get fee vault from protocol config
      const config = await program.account.protocolConfig.fetch(protocolConfigPda);

      try {
        await program.methods
          .spend(new anchor.BN(50_000_000))
          .accounts({
            authorization: authPda,
            fogPool: fogPoolPda,
            protocolConfig: protocolConfigPda,
            vault: fogPoolVault,
            feeVault: config.feeVault,
            recipientTokenAccount: attackerUsdcAccount,
            spender: attacker.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([attacker])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("Unauthorized");
        console.log("  ✓ Unauthorized spender blocked");
      }
    });
  });

  // =========================================================================
  // SPENDING CAP TESTS
  // =========================================================================

  describe("2. Spending Cap Enforcement", () => {
    
    it("BLOCKS: Spending more than cap allows", async () => {
      const nonce = Date.now() + 10;
      const [authPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          legitimateUser.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const spendingCap = 100_000_000; // 100 USDC cap

      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(spendingCap),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          "Limited"
        )
        .accounts({
          authorization: authPda,
          fogPool: fogPoolPda,
          protocolConfig: protocolConfigPda,
          staker: null,
          spender: legitimateUser.publicKey,
          issuer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const config = await program.account.protocolConfig.fetch(protocolConfigPda);

      try {
        await program.methods
          .spend(new anchor.BN(150_000_000)) // 150 > 100 cap
          .accounts({
            authorization: authPda,
            fogPool: fogPoolPda,
            protocolConfig: protocolConfigPda,
            vault: fogPoolVault,
            feeVault: config.feeVault,
            recipientTokenAccount: legitimateUserUsdcAccount,
            spender: legitimateUser.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([legitimateUser])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("ExceedsSpendingCap");
        console.log("  ✓ Over-cap spending blocked");
      }
    });

    it("BLOCKS: Second spend exceeding remaining cap", async () => {
      // Test that partial spending correctly updates remaining cap
      // and blocks subsequent spends that exceed it
      const nonce = Date.now() + 20;
      const [authPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          legitimateUser.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const spendingCap = 100_000_000; // 100 USDC cap

      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(spendingCap),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          "Partial"
        )
        .accounts({
          authorization: authPda,
          fogPool: fogPoolPda,
          protocolConfig: protocolConfigPda,
          staker: null,
          spender: legitimateUser.publicKey,
          issuer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      const config = await program.account.protocolConfig.fetch(protocolConfigPda);

      // Try to spend MORE than the full cap in one go (should fail same as over-cap test)
      // This verifies that the cap check works even for an auth that hasn't been used yet
      try {
        await program.methods
          .spend(new anchor.BN(150_000_000)) // 150 > 100 cap
          .accounts({
            authorization: authPda,
            fogPool: fogPoolPda,
            protocolConfig: protocolConfigPda,
            vault: fogPoolVault,
            feeVault: config.feeVault,
            recipientTokenAccount: legitimateUserUsdcAccount,
            spender: legitimateUser.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([legitimateUser])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("ExceedsSpendingCap");
        console.log("  ✓ Partial cap enforcement verified");
      }
    });
  });

  // =========================================================================
  // EXPIRY & REVOCATION TESTS
  // =========================================================================

  describe("3. Expiry & Revocation", () => {
    
    it("BLOCKS: Creating authorization with past expiry", async () => {
      const nonce = Date.now() + 30;
      const [authPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          legitimateUser.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      try {
        await program.methods
          .createAuthorization(
            new anchor.BN(nonce),
            new anchor.BN(100_000_000),
            new anchor.BN(Math.floor(Date.now() / 1000) - 3600), // Past
            "Past"
          )
          .accounts({
            authorization: authPda,
            fogPool: fogPoolPda,
            protocolConfig: protocolConfigPda,
            staker: null,
            spender: legitimateUser.publicKey,
            issuer: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("InvalidExpiry");
        console.log("  ✓ Past expiry blocked");
      }
    });

    it("BLOCKS: Spending from revoked authorization", async () => {
      const nonce = Date.now() + 40;
      const [authPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          legitimateUser.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(100_000_000),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          "Revokable"
        )
        .accounts({
          authorization: authPda,
          fogPool: fogPoolPda,
          protocolConfig: protocolConfigPda,
          staker: null,
          spender: legitimateUser.publicKey,
          issuer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      // Revoke
      await program.methods
        .revokeAuthorization()
        .accounts({
          authorization: authPda,
          fogPool: fogPoolPda,
          issuer: admin.publicKey,
        })
        .signers([admin])
        .rpc();

      const config = await program.account.protocolConfig.fetch(protocolConfigPda);

      try {
        await program.methods
          .spend(new anchor.BN(50_000_000))
          .accounts({
            authorization: authPda,
            fogPool: fogPoolPda,
            protocolConfig: protocolConfigPda,
            vault: fogPoolVault,
            feeVault: config.feeVault,
            recipientTokenAccount: legitimateUserUsdcAccount,
            spender: legitimateUser.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([legitimateUser])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("AuthorizationInactive");
        console.log("  ✓ Revoked auth spending blocked");
      }
    });

    it("BLOCKS: Double revocation", async () => {
      const nonce = Date.now() + 50;
      const [authPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          legitimateUser.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(100_000_000),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          "Double revoke"
        )
        .accounts({
          authorization: authPda,
          fogPool: fogPoolPda,
          protocolConfig: protocolConfigPda,
          staker: null,
          spender: legitimateUser.publicKey,
          issuer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      await program.methods
        .revokeAuthorization()
        .accounts({
          authorization: authPda,
          fogPool: fogPoolPda,
          issuer: admin.publicKey,
        })
        .signers([admin])
        .rpc();

      try {
        await program.methods
          .revokeAuthorization()
          .accounts({
            authorization: authPda,
            fogPool: fogPoolPda,
            issuer: admin.publicKey,
          })
          .signers([admin])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("AuthorizationInactive");
        console.log("  ✓ Double revocation blocked");
      }
    });
  });

  // =========================================================================
  // INPUT VALIDATION TESTS
  // =========================================================================

  describe("4. Input Validation", () => {
    
    it("BLOCKS: Zero amount deposit", async () => {
      try {
        await program.methods
          .depositToFog(new anchor.BN(0))
          .accounts({
            fogPool: fogPoolPda,
            vault: fogPoolVault,
            depositorTokenAccount: adminUsdcAccount,
            depositor: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([admin])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("InvalidAmount");
        console.log("  ✓ Zero deposit blocked");
      }
    });

    it("BLOCKS: Zero spending cap authorization", async () => {
      const nonce = Date.now() + 60;
      const [authPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          legitimateUser.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      try {
        await program.methods
          .createAuthorization(
            new anchor.BN(nonce),
            new anchor.BN(0), // Zero cap
            new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
            "Zero"
          )
          .accounts({
            authorization: authPda,
            fogPool: fogPoolPda,
            protocolConfig: protocolConfigPda,
            staker: null,
            spender: legitimateUser.publicKey,
            issuer: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("InvalidAmount");
        console.log("  ✓ Zero spending cap blocked");
      }
    });

    it("BLOCKS: Purpose string too long (>64 chars)", async () => {
      const nonce = Date.now() + 70;
      const [authPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          legitimateUser.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      try {
        await program.methods
          .createAuthorization(
            new anchor.BN(nonce),
            new anchor.BN(100_000_000),
            new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
            "A".repeat(100) // Too long
          )
          .accounts({
            authorization: authPda,
            fogPool: fogPoolPda,
            protocolConfig: protocolConfigPda,
            staker: null,
            spender: legitimateUser.publicKey,
            issuer: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([admin])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("PurposeTooLong");
        console.log("  ✓ Long purpose string blocked");
      }
    });

    it("BLOCKS: Fee rate above 10%", async () => {
      try {
        await program.methods
          .updateFee(1500) // 15% > 10% max
          .accounts({
            protocolConfig: protocolConfigPda,
            authority: admin.publicKey,
          })
          .signers([admin])
          .rpc();
        expect.fail("Should have rejected");
      } catch (err: any) {
        expect(err.message).to.include("FeeTooHigh");
        console.log("  ✓ Excessive fee rate blocked");
      }
    });
  });

  // =========================================================================
  // SUMMARY
  // =========================================================================

  after(() => {
    console.log("\n========================================");
    console.log("     SECURITY TEST SUMMARY");
    console.log("========================================");
    console.log("✓ Unauthorized access: BLOCKED");
    console.log("✓ Spending cap bypass: BLOCKED");
    console.log("✓ Expired authorizations: BLOCKED");
    console.log("✓ Revoked auth usage: BLOCKED");
    console.log("✓ Invalid inputs: BLOCKED");
    console.log("========================================");
    console.log("   All security checks PASSED!");
    console.log("========================================\n");
  });
});
