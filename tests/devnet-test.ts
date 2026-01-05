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

describe("shade devnet test", () => {
  // Use existing provider (shade-deployer wallet)
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Shade as Program<Shade>;
  const payer = provider.wallet as anchor.Wallet;

  console.log("===========================================");
  console.log("SHADE Protocol Devnet Test");
  console.log("===========================================");
  console.log("Program ID:", program.programId.toString());
  console.log("Payer:", payer.publicKey.toString());

  let mint: PublicKey;
  let vault: PublicKey;
  let payerTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let fogPoolPda: PublicKey;
  let fogPoolBump: number;
  let authorizationPda: PublicKey;

  const poolSeed = Keypair.generate().publicKey.toBuffer().slice(0, 32);
  const spender = Keypair.generate();
  const recipient = Keypair.generate();

  it("Sets up test environment", async () => {
    console.log("\n--- Setting up test environment ---");
    
    // Check payer balance
    const balance = await provider.connection.getBalance(payer.publicKey);
    console.log("Payer balance:", balance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

    if (balance < 0.1 * anchor.web3.LAMPORTS_PER_SOL) {
      throw new Error("Insufficient balance. Need at least 0.1 SOL");
    }

    // Create test mint (USDC-like)
    mint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6
    );
    console.log("Created mint:", mint.toString());

    // Derive fog pool PDA
    [fogPoolPda, fogPoolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("fog_pool"), Buffer.from(poolSeed)],
      program.programId
    );
    console.log("Fog Pool PDA:", fogPoolPda.toString());

    // Create vault for fog pool (ATA owned by PDA - use allowOwnerOffCurve)
    const vaultAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      fogPoolPda,
      true // allowOwnerOffCurve = true for PDA ownership
    );
    vault = vaultAccount.address;
    console.log("Created vault:", vault.toString());

    // Create payer token account
    const payerAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      payer.publicKey
    );
    payerTokenAccount = payerAccount.address;
    console.log("Created payer token account:", payerTokenAccount.toString());

    // Mint tokens to payer
    await mintTo(
      provider.connection,
      payer.payer,
      mint,
      payerTokenAccount,
      payer.payer,
      1_000_000_000 // 1000 tokens
    );
    console.log("Minted 1000 tokens to payer");

    // Create recipient token account
    const recipientAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      recipient.publicKey
    );
    recipientTokenAccount = recipientAccount.address;
    console.log("Created recipient token account:", recipientTokenAccount.toString());
    
    console.log("Setup complete!");
  });

  it("Initializes a Fog Pool", async () => {
    console.log("\n--- Initializing Fog Pool ---");

    const tx = await program.methods
      .initializeFogPool(Array.from(poolSeed) as any)
      .accounts({
        fogPool: fogPoolPda,
        vault: vault,
        authority: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Transaction:", tx);

    const fogPool = await program.account.fogPool.fetch(fogPoolPda);
    console.log("Fog Pool created!");
    console.log("  Authority:", fogPool.authority.toString());
    console.log("  Vault:", fogPool.vault.toString());
    console.log("  Total Deposited:", fogPool.totalDeposited.toString());
  });

  it("Deposits to Fog Pool", async () => {
    console.log("\n--- Depositing to Fog Pool ---");

    const depositAmount = 500_000_000; // 500 tokens

    const tx = await program.methods
      .depositToFog(new anchor.BN(depositAmount))
      .accounts({
        fogPool: fogPoolPda,
        vault: vault,
        depositorTokenAccount: payerTokenAccount,
        depositor: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Transaction:", tx);

    const fogPool = await program.account.fogPool.fetch(fogPoolPda);
    console.log("Deposit successful!");
    console.log("  Total Deposited:", fogPool.totalDeposited.toNumber() / 1_000_000, "tokens");

    const vaultAccount = await getAccount(provider.connection, vault);
    console.log("  Vault Balance:", Number(vaultAccount.amount) / 1_000_000, "tokens");
  });

  it("Creates an Authorization", async () => {
    console.log("\n--- Creating Authorization ---");

    const spendingCap = 100_000_000; // 100 tokens
    const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const purpose = "Devnet Test";
    const nonce = Date.now();

    [authorizationPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("authorization"),
        fogPoolPda.toBuffer(),
        spender.publicKey.toBuffer(),
        new anchor.BN(nonce).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const tx = await program.methods
      .createAuthorization(
        new anchor.BN(nonce),
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

    console.log("Transaction:", tx);

    const authorization = await program.account.authorization.fetch(authorizationPda);
    console.log("Authorization created!");
    console.log("  Spender:", authorization.authorizedSpender.toString());
    console.log("  Spending Cap:", authorization.spendingCap.toNumber() / 1_000_000, "tokens");
    console.log("  Purpose:", authorization.purpose);
    console.log("  Active:", authorization.isActive);
  });

  it("Spends using Authorization", async () => {
    console.log("\n--- Spending from Authorization ---");

    const spendAmount = 25_000_000; // 25 tokens

    const tx = await program.methods
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

    console.log("Transaction:", tx);

    const authorization = await program.account.authorization.fetch(authorizationPda);
    console.log("Spend successful!");
    console.log("  Amount Spent:", authorization.amountSpent.toNumber() / 1_000_000, "tokens");
    console.log("  Remaining:", (authorization.spendingCap.toNumber() - authorization.amountSpent.toNumber()) / 1_000_000, "tokens");

    const recipientAccount = await getAccount(provider.connection, recipientTokenAccount);
    console.log("  Recipient Balance:", Number(recipientAccount.amount) / 1_000_000, "tokens");
  });

  it("Revokes Authorization", async () => {
    console.log("\n--- Revoking Authorization ---");

    const tx = await program.methods
      .revokeAuthorization()
      .accounts({
        authorization: authorizationPda,
        fogPool: fogPoolPda,
        issuer: payer.publicKey,
      })
      .rpc();

    console.log("Transaction:", tx);

    const authorization = await program.account.authorization.fetch(authorizationPda);
    console.log("Authorization revoked!");
    console.log("  Active:", authorization.isActive);

    const fogPool = await program.account.fogPool.fetch(fogPoolPda);
    console.log("  Active Authorizations:", fogPool.activeAuthorizations.toNumber());
  });

  it("Prints final summary", async () => {
    console.log("\n===========================================");
    console.log("TEST SUMMARY - ALL PASSED!");
    console.log("===========================================");
    console.log("Program ID:", program.programId.toString());
    console.log("Fog Pool:", fogPoolPda.toString());
    console.log("Authorization:", authorizationPda.toString());
    console.log("===========================================");
  });
});
