import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Shade } from "../target/types/shade";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";

async function main() {
  // Set up provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Shade as Program<Shade>;

  // Load deployer
  const deployerKeyfile = fs.readFileSync("D:/Dev/Keys/shade-deployer.json", "utf-8");
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(deployerKeyfile)));

  // Get protocol config PDA
  const [protocolConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    program.programId
  );

  console.log("\n=== Updating Tier Thresholds ===\n");

  // Get current thresholds
  const configBefore = await program.account.protocolConfig.fetch(protocolConfigPda);
  console.log("Current Thresholds:");
  console.log(`  Bronze: ${configBefore.bronzeThreshold.toNumber() / 1_000_000} $SHADE`);
  console.log(`  Silver: ${configBefore.silverThreshold.toNumber() / 1_000_000} $SHADE`);
  console.log(`  Gold:   ${configBefore.goldThreshold.toNumber() / 1_000_000} $SHADE\n`);

  // New thresholds
  const newBronze = 10_000_000_000;   // 10,000 $SHADE
  const newSilver = 100_000_000_000;  // 100,000 $SHADE
  const newGold = 500_000_000_000;    // 500,000 $SHADE

  console.log("Updating to:");
  console.log(`  Bronze: 10,000 $SHADE`);
  console.log(`  Silver: 100,000 $SHADE`);
  console.log(`  Gold:   500,000 $SHADE\n`);

  // Call update_tiers (using any to bypass type checking issues)
  const tx = await (program.methods as any)
    .updateTiers(
      new anchor.BN(newBronze),
      new anchor.BN(newSilver),
      new anchor.BN(newGold)
    )
    .accounts({
      protocolConfig: protocolConfigPda,
      authority: deployer.publicKey,
    })
    .signers([deployer])
    .rpc();

  console.log(`Transaction: ${tx}`);

  // Verify update
  const configAfter = await program.account.protocolConfig.fetch(protocolConfigPda);
  console.log("\nNew Thresholds:");
  console.log(`  Bronze: ${configAfter.bronzeThreshold.toNumber() / 1_000_000} $SHADE`);
  console.log(`  Silver: ${configAfter.silverThreshold.toNumber() / 1_000_000} $SHADE`);
  console.log(`  Gold:   ${configAfter.goldThreshold.toNumber() / 1_000_000} $SHADE`);
  console.log("\n✅ Tier thresholds updated successfully!");
}

main().catch(console.error);

