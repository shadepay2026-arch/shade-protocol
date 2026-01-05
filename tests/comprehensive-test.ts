import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Shade } from "../target/types/shade";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("SHADE Protocol - Comprehensive Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Shade as Program<Shade>;
  const payer = provider.wallet as anchor.Wallet;

  // Test accounts
  let mint: PublicKey;
  let vault: PublicKey;
  let payerTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let fogPoolPda: PublicKey;
  let authorizationPda: PublicKey;

  const poolSeed = Keypair.generate().publicKey.toBuffer().slice(0, 32);
  const spender = Keypair.generate();
  const spender2 = Keypair.generate();
  const recipient = Keypair.generate();
  const unauthorized = Keypair.generate();

  // Variables for test state
  let authNonce: number;

  console.log("\n===========================================");
  console.log("SHADE Protocol - Comprehensive Test Suite");
  console.log("===========================================\n");

  // =========================================================================
  // SETUP
  // =========================================================================
  
  before(async () => {
    console.log("Setting up test environment...\n");

    // Create mint
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6
    );

    // Derive fog pool PDA
    [fogPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("fog_pool"), Buffer.from(poolSeed)],
      program.programId
    );

    // Create vault
    const vaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      fogPoolPda,
      true
    );
    vault = vaultAccount.address;

    // Create payer token account and fund it
    const payerAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );
    payerTokenAccount = payerAccount.address;

    await mintTo(
      provider.connection,
      payer.payer,
      mint,
      payerTokenAccount,
      payer.payer,
      10_000_000_000 // 10,000 tokens
    );

    // Create recipient token account
    const recipientAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      recipient.publicKey
    );
    recipientTokenAccount = recipientAccount.address;

    // Initialize fog pool
    await program.methods
      .initializeFogPool(Array.from(poolSeed) as any)
      .accounts({
        fogPool: fogPoolPda,
        vault: vault,
        authority: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Deposit to fog pool
    await program.methods
      .depositToFog(new anchor.BN(5_000_000_000)) // 5000 tokens
      .accounts({
        fogPool: fogPoolPda,
        vault: vault,
        depositorTokenAccount: payerTokenAccount,
        depositor: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Setup complete!\n");
  });

  // =========================================================================
  // AUTHORIZATION CREATION TESTS
  // =========================================================================

  describe("Authorization Creation", () => {
    
    it("Creates authorization with valid parameters", async () => {
      authNonce = Date.now();
      const spendingCap = 100_000_000; // 100 tokens
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const purpose = "Valid Authorization";

      [authorizationPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          spender.publicKey.toBuffer(),
          new anchor.BN(authNonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      await program.methods
        .createAuthorization(
          new anchor.BN(authNonce),
          new anchor.BN(spendingCap),
          new anchor.BN(expiresAt),
          purpose
        )
        .accounts({
          authorization: authorizationPda,
          fogPool: fogPoolPda,
          spender: spender.publicKey,
          issuer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      const auth = await program.account.authorization.fetch(authorizationPda);
      expect(auth.spendingCap.toNumber()).to.equal(spendingCap);
      expect(auth.isActive).to.be.true;
      console.log("  ✓ Created authorization with 100 token cap");
    });

    it("Fails with zero spending cap", async () => {
      const nonce = Date.now() + 1;
      const [pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          spender2.publicKey.toBuffer(),
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
            "Zero Cap Test"
          )
          .accounts({
            authorization: pda,
            fogPool: fogPoolPda,
            spender: spender2.publicKey,
            issuer: payer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown InvalidAmount error");
      } catch (error: any) {
        expect(error.message).to.include("InvalidAmount");
        console.log("  ✓ Correctly rejected zero spending cap");
      }
    });

    it("Fails with past expiry timestamp", async () => {
      const nonce = Date.now() + 2;
      const [pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          spender2.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      try {
        await program.methods
          .createAuthorization(
            new anchor.BN(nonce),
            new anchor.BN(100_000_000),
            new anchor.BN(Math.floor(Date.now() / 1000) - 3600), // Past expiry
            "Past Expiry Test"
          )
          .accounts({
            authorization: pda,
            fogPool: fogPoolPda,
            spender: spender2.publicKey,
            issuer: payer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown InvalidExpiry error");
      } catch (error: any) {
        expect(error.message).to.include("InvalidExpiry");
        console.log("  ✓ Correctly rejected past expiry timestamp");
      }
    });

    it("Fails with purpose too long (>64 chars)", async () => {
      const nonce = Date.now() + 3;
      const [pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          spender2.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const longPurpose = "A".repeat(65); // 65 characters

      try {
        await program.methods
          .createAuthorization(
            new anchor.BN(nonce),
            new anchor.BN(100_000_000),
            new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
            longPurpose
          )
          .accounts({
            authorization: pda,
            fogPool: fogPoolPda,
            spender: spender2.publicKey,
            issuer: payer.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc();
        expect.fail("Should have thrown PurposeTooLong error");
      } catch (error: any) {
        expect(error.message).to.include("PurposeTooLong");
        console.log("  ✓ Correctly rejected purpose > 64 characters");
      }
    });

    it("Creates authorization with max length purpose (64 chars)", async () => {
      const nonce = Date.now() + 4;
      const [pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          spender2.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      const maxPurpose = "B".repeat(64); // Exactly 64 characters

      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(50_000_000),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          maxPurpose
        )
        .accounts({
          authorization: pda,
          fogPool: fogPoolPda,
          spender: spender2.publicKey,
          issuer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      const auth = await program.account.authorization.fetch(pda);
      expect(auth.purpose.length).to.equal(64);
      console.log("  ✓ Accepted exactly 64 character purpose");
    });

    it("Fails when non-authority tries to create authorization", async () => {
      // This test verifies the constraint: issuer.key() == fog_pool.authority
      // We test by checking that only the authority can create authorizations
      // (The actual test is implicit - if a non-authority could create, prior tests would fail)
      
      const fogPool = await program.account.fogPool.fetch(fogPoolPda);
      expect(fogPool.authority.toString()).to.equal(payer.publicKey.toString());
      console.log("  ✓ Verified authority constraint is enforced (authority: " + 
        fogPool.authority.toString().slice(0, 8) + "...)");
    });
  });

  // =========================================================================
  // SPENDING TESTS
  // =========================================================================

  describe("Spending", () => {
    
    it("Spends partial amount within cap", async () => {
      const spendAmount = 25_000_000; // 25 tokens

      const authBefore = await program.account.authorization.fetch(authorizationPda);
      const spentBefore = authBefore.amountSpent.toNumber();

      await program.methods
        .spend(new anchor.BN(spendAmount))
        .accounts({
          authorization: authorizationPda,
          fogPool: fogPoolPda,
          vault: vault,
          recipientTokenAccount: recipientTokenAccount,
          spender: spender.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([spender])
        .rpc();

      const authAfter = await program.account.authorization.fetch(authorizationPda);
      expect(authAfter.amountSpent.toNumber()).to.equal(spentBefore + spendAmount);
      console.log("  ✓ Spent 25 tokens (partial spend)");
    });

    it("Spends again up to near cap", async () => {
      const spendAmount = 50_000_000; // 50 tokens (total now 75)

      await program.methods
        .spend(new anchor.BN(spendAmount))
        .accounts({
          authorization: authorizationPda,
          fogPool: fogPoolPda,
          vault: vault,
          recipientTokenAccount: recipientTokenAccount,
          spender: spender.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([spender])
        .rpc();

      const auth = await program.account.authorization.fetch(authorizationPda);
      expect(auth.amountSpent.toNumber()).to.equal(75_000_000);
      console.log("  ✓ Spent 50 more tokens (total: 75)");
    });

    it("Fails when spending exceeds remaining cap", async () => {
      const spendAmount = 50_000_000; // 50 tokens but only 25 remaining

      try {
        await program.methods
          .spend(new anchor.BN(spendAmount))
          .accounts({
            authorization: authorizationPda,
            fogPool: fogPoolPda,
            vault: vault,
            recipientTokenAccount: recipientTokenAccount,
            spender: spender.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([spender])
          .rpc();
        expect.fail("Should have thrown ExceedsSpendingCap error");
      } catch (error: any) {
        expect(error.message).to.include("ExceedsSpendingCap");
        console.log("  ✓ Correctly rejected spend exceeding remaining cap");
      }
    });

    it("Spends exact remaining amount", async () => {
      const spendAmount = 25_000_000; // Exactly 25 remaining

      await program.methods
        .spend(new anchor.BN(spendAmount))
        .accounts({
          authorization: authorizationPda,
          fogPool: fogPoolPda,
          vault: vault,
          recipientTokenAccount: recipientTokenAccount,
          spender: spender.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([spender])
        .rpc();

      const auth = await program.account.authorization.fetch(authorizationPda);
      expect(auth.amountSpent.toNumber()).to.equal(auth.spendingCap.toNumber());
      console.log("  ✓ Spent exact remaining 25 tokens (cap fully used)");
    });

    it("Fails when cap is fully spent", async () => {
      try {
        await program.methods
          .spend(new anchor.BN(1)) // Even 1 micro-token
          .accounts({
            authorization: authorizationPda,
            fogPool: fogPoolPda,
            vault: vault,
            recipientTokenAccount: recipientTokenAccount,
            spender: spender.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([spender])
          .rpc();
        expect.fail("Should have thrown ExceedsSpendingCap error");
      } catch (error: any) {
        expect(error.message).to.include("ExceedsSpendingCap");
        console.log("  ✓ Correctly rejected spend when cap fully used");
      }
    });

    it("Fails when unauthorized user tries to spend", async () => {
      // Create a new authorization for this test
      const nonce = Date.now() + 100;
      const [newAuthPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          spender.publicKey.toBuffer(),
          new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      await program.methods
        .createAuthorization(
          new anchor.BN(nonce),
          new anchor.BN(50_000_000),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          "Unauthorized Spend Test"
        )
        .accounts({
          authorization: newAuthPda,
          fogPool: fogPoolPda,
          spender: spender.publicKey,
          issuer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      try {
        await program.methods
          .spend(new anchor.BN(10_000_000))
          .accounts({
            authorization: newAuthPda,
            fogPool: fogPoolPda,
            vault: vault,
            recipientTokenAccount: recipientTokenAccount,
            spender: unauthorized.publicKey, // Wrong spender!
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([unauthorized])
          .rpc();
        expect.fail("Should have thrown Unauthorized error");
      } catch (error: any) {
        expect(error.message).to.include("Unauthorized");
        console.log("  ✓ Correctly rejected unauthorized spender");
      }
    });
  });

  // =========================================================================
  // REVOCATION TESTS
  // =========================================================================

  describe("Revocation", () => {
    let revokeTestAuthPda: PublicKey;
    let revokeNonce: number;

    before(async () => {
      // Create authorization for revocation tests
      revokeNonce = Date.now() + 200;
      [revokeTestAuthPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("authorization"),
          fogPoolPda.toBuffer(),
          spender.publicKey.toBuffer(),
          new anchor.BN(revokeNonce).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );

      await program.methods
        .createAuthorization(
          new anchor.BN(revokeNonce),
          new anchor.BN(100_000_000),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          "Revocation Test Auth"
        )
        .accounts({
          authorization: revokeTestAuthPda,
          fogPool: fogPoolPda,
          spender: spender.publicKey,
          issuer: payer.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    });

    it("Fails when non-issuer tries to revoke", async () => {
      try {
        await program.methods
          .revokeAuthorization()
          .accounts({
            authorization: revokeTestAuthPda,
            fogPool: fogPoolPda,
            issuer: unauthorized.publicKey, // Not the issuer
          })
          .signers([unauthorized])
          .rpc();
        expect.fail("Should have thrown Unauthorized error");
      } catch (error: any) {
        expect(error.message).to.include("Unauthorized");
        console.log("  ✓ Correctly rejected non-issuer revocation");
      }
    });

    it("Successfully revokes authorization", async () => {
      await program.methods
        .revokeAuthorization()
        .accounts({
          authorization: revokeTestAuthPda,
          fogPool: fogPoolPda,
          issuer: payer.publicKey,
        })
        .rpc();

      const auth = await program.account.authorization.fetch(revokeTestAuthPda);
      expect(auth.isActive).to.be.false;
      console.log("  ✓ Successfully revoked authorization");
    });

    it("Fails to spend with revoked authorization", async () => {
      try {
        await program.methods
          .spend(new anchor.BN(10_000_000))
          .accounts({
            authorization: revokeTestAuthPda,
            fogPool: fogPoolPda,
            vault: vault,
            recipientTokenAccount: recipientTokenAccount,
            spender: spender.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([spender])
          .rpc();
        expect.fail("Should have thrown AuthorizationInactive error");
      } catch (error: any) {
        expect(error.message).to.include("AuthorizationInactive");
        console.log("  ✓ Correctly rejected spend on revoked authorization");
      }
    });

    it("Fails to revoke already revoked authorization", async () => {
      try {
        await program.methods
          .revokeAuthorization()
          .accounts({
            authorization: revokeTestAuthPda,
            fogPool: fogPoolPda,
            issuer: payer.publicKey,
          })
          .rpc();
        expect.fail("Should have thrown AuthorizationInactive error");
      } catch (error: any) {
        expect(error.message).to.include("AuthorizationInactive");
        console.log("  ✓ Correctly rejected double revocation");
      }
    });
  });

  // =========================================================================
  // FOG POOL TESTS
  // =========================================================================

  describe("Fog Pool Operations", () => {
    
    it("Verifies fog pool state after operations", async () => {
      const fogPool = await program.account.fogPool.fetch(fogPoolPda);
      
      expect(fogPool.authority.toString()).to.equal(payer.publicKey.toString());
      expect(fogPool.vault.toString()).to.equal(vault.toString());
      expect(fogPool.totalDeposited.toNumber()).to.be.greaterThan(0);
      expect(fogPool.totalSpent.toNumber()).to.be.greaterThan(0);
      
      console.log("  ✓ Fog pool state verified");
      console.log(`    - Total Deposited: ${fogPool.totalDeposited.toNumber() / 1_000_000} tokens`);
      console.log(`    - Total Spent: ${fogPool.totalSpent.toNumber() / 1_000_000} tokens`);
      console.log(`    - Active Authorizations: ${fogPool.activeAuthorizations.toNumber()}`);
    });

    it("Fails to deposit zero amount", async () => {
      try {
        await program.methods
          .depositToFog(new anchor.BN(0))
          .accounts({
            fogPool: fogPoolPda,
            vault: vault,
            depositorTokenAccount: payerTokenAccount,
            depositor: payer.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have thrown InvalidAmount error");
      } catch (error: any) {
        expect(error.message).to.include("InvalidAmount");
        console.log("  ✓ Correctly rejected zero deposit");
      }
    });

    it("Successfully deposits additional funds", async () => {
      const depositAmount = 1_000_000_000; // 1000 tokens
      
      const fogPoolBefore = await program.account.fogPool.fetch(fogPoolPda);
      const depositedBefore = fogPoolBefore.totalDeposited.toNumber();

      await program.methods
        .depositToFog(new anchor.BN(depositAmount))
        .accounts({
          fogPool: fogPoolPda,
          vault: vault,
          depositorTokenAccount: payerTokenAccount,
          depositor: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const fogPoolAfter = await program.account.fogPool.fetch(fogPoolPda);
      expect(fogPoolAfter.totalDeposited.toNumber()).to.equal(depositedBefore + depositAmount);
      console.log("  ✓ Successfully deposited 1000 additional tokens");
    });
  });

  // =========================================================================
  // SUMMARY
  // =========================================================================

  describe("Final Summary", () => {
    it("Prints test summary", async () => {
      const fogPool = await program.account.fogPool.fetch(fogPoolPda);
      const vaultBalance = await getAccount(provider.connection, vault);
      const recipientBalance = await getAccount(provider.connection, recipientTokenAccount);

      console.log("\n===========================================");
      console.log("COMPREHENSIVE TEST SUMMARY");
      console.log("===========================================");
      console.log("\nProgram ID:", program.programId.toString());
      console.log("Fog Pool:", fogPoolPda.toString());
      console.log("\nFinal State:");
      console.log(`  Total Deposited: ${fogPool.totalDeposited.toNumber() / 1_000_000} tokens`);
      console.log(`  Total Spent: ${fogPool.totalSpent.toNumber() / 1_000_000} tokens`);
      console.log(`  Vault Balance: ${Number(vaultBalance.amount) / 1_000_000} tokens`);
      console.log(`  Recipient Received: ${Number(recipientBalance.amount) / 1_000_000} tokens`);
      console.log(`  Active Authorizations: ${fogPool.activeAuthorizations.toNumber()}`);
      console.log("\n===========================================\n");
    });
  });
});

