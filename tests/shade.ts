import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Shade } from "../target/types/shade";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("shade", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Shade as Program<Shade>;

  let mint: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;
  let depositorTokenAccount: anchor.web3.PublicKey;
  let recipientTokenAccount: anchor.web3.PublicKey;
  let fogPoolPda: anchor.web3.PublicKey;
  let authorizationPda: anchor.web3.PublicKey;

  const poolSeed = anchor.web3.Keypair.generate().publicKey.toBuffer().slice(0, 32);
  const authority = anchor.web3.Keypair.generate();
  const depositor = anchor.web3.Keypair.generate();
  const spender = anchor.web3.Keypair.generate();
  const recipient = anchor.web3.Keypair.generate();

  before(async () => {
    // Airdrop SOL to test accounts
    const airdropAmount = 10 * anchor.web3.LAMPORTS_PER_SOL;
    
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(authority.publicKey, airdropAmount)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(depositor.publicKey, airdropAmount)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(spender.publicKey, airdropAmount)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(recipient.publicKey, airdropAmount)
    );

    // Create mint
    mint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6 // USDC-like decimals
    );

    // Derive fog pool PDA
    [fogPoolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fog_pool"), Buffer.from(poolSeed)],
      program.programId
    );

    // Create vault token account for the fog pool
    vault = await createAccount(
      provider.connection,
      authority,
      mint,
      fogPoolPda,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Create depositor token account and mint tokens
    depositorTokenAccount = await createAccount(
      provider.connection,
      depositor,
      mint,
      depositor.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      mint,
      depositorTokenAccount,
      authority,
      1_000_000_000 // 1000 USDC
    );

    // Create recipient token account
    recipientTokenAccount = await createAccount(
      provider.connection,
      recipient,
      mint,
      recipient.publicKey
    );
  });

  it("Initializes a Fog Pool", async () => {
    await program.methods
      .initializeFogPool(Array.from(poolSeed) as any)
      .accounts({
        fogPool: fogPoolPda,
        vault: vault,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const fogPool = await program.account.fogPool.fetch(fogPoolPda);
    expect(fogPool.authority.toString()).to.equal(authority.publicKey.toString());
    expect(fogPool.vault.toString()).to.equal(vault.toString());
    expect(fogPool.totalDeposited.toNumber()).to.equal(0);
    expect(fogPool.activeAuthorizations.toNumber()).to.equal(0);
  });

  it("Deposits to Fog Pool", async () => {
    const depositAmount = 500_000_000; // 500 USDC

    await program.methods
      .depositToFog(new anchor.BN(depositAmount))
      .accounts({
        fogPool: fogPoolPda,
        vault: vault,
        depositorTokenAccount: depositorTokenAccount,
        depositor: depositor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    const fogPool = await program.account.fogPool.fetch(fogPoolPda);
    expect(fogPool.totalDeposited.toNumber()).to.equal(depositAmount);

    const vaultAccount = await getAccount(provider.connection, vault);
    expect(Number(vaultAccount.amount)).to.equal(depositAmount);
  });

  it("Creates an Authorization", async () => {
    const spendingCap = 100_000_000; // 100 USDC
    const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const purpose = "Test Purchase";
    const nonce = Date.now(); // Use timestamp as nonce

    [authorizationPda] = anchor.web3.PublicKey.findProgramAddressSync(
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
        new anchor.BN(spendingCap),
        new anchor.BN(expiresAt),
        purpose
      )
      .accounts({
        authorization: authorizationPda,
        fogPool: fogPoolPda,
        spender: spender.publicKey,
        issuer: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const authorization = await program.account.authorization.fetch(authorizationPda);
    expect(authorization.fogPool.toString()).to.equal(fogPoolPda.toString());
    expect(authorization.authorizedSpender.toString()).to.equal(spender.publicKey.toString());
    expect(authorization.spendingCap.toNumber()).to.equal(spendingCap);
    expect(authorization.amountSpent.toNumber()).to.equal(0);
    expect(authorization.isActive).to.be.true;
    expect(authorization.purpose).to.equal(purpose);
  });

  it("Spends using Authorization", async () => {
    const spendAmount = 25_000_000; // 25 USDC

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

    const authorization = await program.account.authorization.fetch(authorizationPda);
    expect(authorization.amountSpent.toNumber()).to.equal(spendAmount);

    const recipientAccount = await getAccount(provider.connection, recipientTokenAccount);
    expect(Number(recipientAccount.amount)).to.equal(spendAmount);

    const fogPool = await program.account.fogPool.fetch(fogPoolPda);
    expect(fogPool.totalSpent.toNumber()).to.equal(spendAmount);
  });

  it("Fails to spend more than spending cap", async () => {
    const exceedAmount = 100_000_000; // Exceeds remaining cap

    try {
      await program.methods
        .spend(new anchor.BN(exceedAmount))
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
      expect.fail("Should have thrown error");
    } catch (error) {
      expect(error.message).to.include("ExceedsSpendingCap");
    }
  });

  it("Revokes Authorization", async () => {
    await program.methods
      .revokeAuthorization()
      .accounts({
        authorization: authorizationPda,
        fogPool: fogPoolPda,
        issuer: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const authorization = await program.account.authorization.fetch(authorizationPda);
    expect(authorization.isActive).to.be.false;

    const fogPool = await program.account.fogPool.fetch(fogPoolPda);
    expect(fogPool.activeAuthorizations.toNumber()).to.equal(0);
  });

  it("Fails to spend with revoked authorization", async () => {
    const spendAmount = 10_000_000;

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
      expect.fail("Should have thrown error");
    } catch (error) {
      expect(error.message).to.include("AuthorizationInactive");
    }
  });
});
