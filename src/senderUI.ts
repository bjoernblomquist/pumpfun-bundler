import { ComputeBudgetProgram, Transaction, sendAndConfirmTransaction, Keypair, Connection, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction, LAMPORTS_PER_SOL, TransactionMessage, Blockhash } from "@solana/web3.js";
import { loadKeypairs } from "./createKeys";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { SPL_ACCOUNT_LAYOUT, TokenAccount } from "@raydium-io/raydium-sdk";
import { wallet, connection, payer } from "../config";
import * as spl from "@solana/spl-token";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import promptSync from "prompt-sync";
import { createLUT, extendLUT } from "./createLUT";
import fs from "fs";
import path from "path";
import { getRandomTipAccount } from "./clients/config";
import BN from "bn.js";
import base58 from "bs58"
import {NUM_OF_WALLETS} from "../config";

const prompt = promptSync();
const keyInfoPath = path.join(__dirname, "keyInfo.json");

let poolInfo: { [key: string]: any } = {};
if (fs.existsSync(keyInfoPath)) {
	const data = fs.readFileSync(keyInfoPath, "utf-8");
	poolInfo = JSON.parse(data);
}

interface Buy {
	pubkey: PublicKey;
	solAmount: Number;
	tokenAmount: BN;
	percentSupply: number;
}

const printSOLBalance = async (
  connection: Connection,
  pubKey: PublicKey,
  info: string = ""
) => {
  const balance = await connection.getBalance(pubKey);
  console.log(
    `${info ? info + " " : ""}${pubKey.toBase58()}:`,
    balance / LAMPORTS_PER_SOL,
    `SOL`
  );
};



function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function calculateLaunchFees(numBundlerWallets: number, jitoTip: number = 0.001 * LAMPORTS_PER_SOL): Promise<{
  devWalletFees: number;
  bundlerWalletFees: number[];
  payerWalletFees: number;
  totalFees: number;
}> {
  const LAMPORTS_PER_SOL = 1_000_000_000;
  const SIGNATURE_FEE = 0.000005 * LAMPORTS_PER_SOL; // 0.000005 SOL per signature
  const COMPUTE_UNIT_PRICE = 220_000; // microLamports
  const COMPUTE_UNIT_LIMIT = 350_000; // units
  const COMPUTE_FEE = (COMPUTE_UNIT_PRICE * COMPUTE_UNIT_LIMIT) / 1_000_000; // ~0.000077 SOL
  const ATA_FEE = 0.00203928 * LAMPORTS_PER_SOL; // ~0.00203928 SOL per ATA
  const BONDING_CURVE_FEE = 0.00203928 * LAMPORTS_PER_SOL; // Assume same as ATA for simplicity
  const METADATA_FEE = 0.008 * LAMPORTS_PER_SOL; // Rough estimate for metadata account

  // Dev Wallet: Pool creation + buy transaction
  const devPoolCreation = {
    signatures: 4, // Payer, dev, mint, program (rough estimate)
    atas: 1, // Dev wallet ATA
    otherAccounts: 2, // Bonding curve + metadata
    computeUnits: 1, // One transaction
  };
  const devBuy = {
    signatures: 2, // Payer, dev
    atas: 0, // ATA already created
    otherAccounts: 0,
    computeUnits: 1,
  };
  const lutCreation = {
        signatures: 2,
        accounts: 1, // LUT account
        computeUnits: 1,
    };
  const lutFees =
        lutCreation.signatures * SIGNATURE_FEE +
        0.00089088 * LAMPORTS_PER_SOL + // LUT rent exemption
        lutCreation.computeUnits * COMPUTE_FEE +
        jitoTip; // Jito tip for 1 bundle
  const devFees =
    (devPoolCreation.signatures + devBuy.signatures) * SIGNATURE_FEE +
    (devPoolCreation.atas + devBuy.atas) * ATA_FEE +
    devPoolCreation.otherAccounts * BONDING_CURVE_FEE +
    METADATA_FEE +
    (devPoolCreation.computeUnits + devBuy.computeUnits) * COMPUTE_FEE;

  // Bundler Wallets: Each has one buy transaction
  const bundlerBuy = {
    signatures: 2, // Payer, bundler
    atas: 1, // One ATA per wallet
    otherAccounts: 0,
    computeUnits: 1,
  };
  const bundlerFees = Array(numBundlerWallets).fill(
    bundlerBuy.signatures * SIGNATURE_FEE +
      bundlerBuy.atas * ATA_FEE +
      bundlerBuy.otherAccounts * BONDING_CURVE_FEE +
      bundlerBuy.computeUnits * COMPUTE_FEE
  );

  // Payer Wallet: Signs all transactions + pays Jito tips
  const numBundles = 1 + Math.ceil(numBundlerWallets / 6); // 1 for pool creation + buy, additional for bundler wallet chunks (6 per chunk)
  const payerFees =
    (devPoolCreation.signatures + devBuy.signatures + numBundlerWallets * bundlerBuy.signatures) * SIGNATURE_FEE +
    numBundles * jitoTip;

  // Total Fees
  const totalFees = devFees + bundlerFees.reduce((sum, fee) => sum + fee, 0) + payerFees + lutFees;

  return {
    devWalletFees: devFees / LAMPORTS_PER_SOL, // Convert to SOL
    bundlerWalletFees: bundlerFees.map(fee => fee / LAMPORTS_PER_SOL), // Array of fees in SOL
    payerWalletFees: payerFees + lutFees / LAMPORTS_PER_SOL, // In SOL
    totalFees: totalFees / LAMPORTS_PER_SOL, // In SOL
  };
}

async function showBundleAndDevBalance() {
    const keypairs: Keypair[] = loadKeypairs();
    let existingData: any = {};
    if (fs.existsSync(keyInfoPath)) {
        existingData = JSON.parse(fs.readFileSync(keyInfoPath, "utf-8"));
    }

    const fees = await calculateLaunchFees(keypairs.length, 0.001 * LAMPORTS_PER_SOL);

    let totalSolRequiredForPayer = 0; // Variable zur Speicherung des Gesamt-SOL-Bedarfs

    // Dev Wallet
    const devSolAmount = parseFloat(existingData[wallet.publicKey.toString()]?.solAmount || 0);
    const devBalance = await connection.getBalance(wallet.publicKey);
    const devTotalRequired = devSolAmount + fees.devWalletFees + fees.devWalletFees; // Erwartete SOL + Fees
    totalSolRequiredForPayer += devTotalRequired; // Zum Gesamtbedarf hinzufügen
    console.log(`\n=== Dev Wallet ===`);
    console.log(`Public Key: ${wallet.publicKey.toBase58()}`);
    console.log(`Current Balance: ${(devBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    console.log(`Buy SOL: ${devSolAmount.toFixed(3)} SOL`);
    console.log(`Total Required (Expected + Fees): ${devTotalRequired.toFixed(3)} SOL`);

    // Bundle Wallets
    for (let i = 0; i < keypairs.length; i++) {
        const keypair = keypairs[i];
        const keypairPubkeyStr = keypair.publicKey.toString();

        if (!existingData[keypairPubkeyStr] || !existingData[keypairPubkeyStr].solAmount) {
            console.log(`Missing solAmount for wallet ${i + 1}, skipping.`);
            continue;
        }
        const solAmount = parseFloat(existingData[keypairPubkeyStr].solAmount);
        const balance = await connection.getBalance(keypair.publicKey);
        const bundlerTotalRequired = solAmount + fees.bundlerWalletFees[i] + fees.bundlerWalletFees[i]; // Erwartete SOL + Fees
        totalSolRequiredForPayer += bundlerTotalRequired; // Zum Gesamtbedarf hinzufügen
        console.log(`\nBundler Wallet ${i + 1}`);
        console.log(`Public Key: ${keypair.publicKey.toBase58()}`);
        console.log(`Current Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
        console.log(`Buy SOL: ${solAmount.toFixed(3)} SOL`);
        console.log(`Total Required (Expected + Fees): ${bundlerTotalRequired.toFixed(3)} SOL`);
    }

    // Payer Wallet
    console.log(`\n=== Payer Wallet ===`);
    const payerBalance = await connection.getBalance(payer.publicKey);
    console.log(`Public Key: ${payer.publicKey.toBase58()}`);
    console.log(`Current Balance: ${(payerBalance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    console.log(`Total SOL Required for All Wallets (Expected + Fees) on Payer Wallet for Launch: ${totalSolRequiredForPayer.toFixed(3)} SOL`);
    console.log(`\n=== Total Estimated Fees for Launch ===`);
    console.log(`Total Fees with jitoTip 0.001 used for Launch: ${fees.totalFees.toFixed(3)} SOL`);
}

async function generateSOLTransferForKeypairs(tipAmt: number, steps: number = NUM_OF_WALLETS): Promise<TransactionInstruction[]> {
	const keypairs: Keypair[] = loadKeypairs();
	const ixs: TransactionInstruction[] = [];

	let existingData: any = {};
	if (fs.existsSync(keyInfoPath)) {
		existingData = JSON.parse(fs.readFileSync(keyInfoPath, "utf-8"));
	}

	// Dev wallet send first
	if (!existingData[wallet.publicKey.toString()] || !existingData[wallet.publicKey.toString()].solAmount) {
		console.log(`Missing solAmount for dev wallet, skipping.`);
	}
	
	await printSOLBalance(
	    connection,
	    payer.publicKey,
	    "Payer Wallet"
	  );

        let completeSolAmountKeypairs = 0;
	for (let i = 0; i < Math.min(steps, keypairs.length); i++) {
                const keypair = keypairs[i];
                const keypairPubkeyStr = keypair.publicKey.toString();

                if (!existingData[keypairPubkeyStr] || !existingData[keypairPubkeyStr].solAmount) {
                        console.log(`Missing solAmount for wallet ${i + 1}, skipping.`);
                        continue;
                }

                completeSolAmountKeypairs += parseFloat(existingData[keypairPubkeyStr].solAmount);
        }

	const solAmount = parseFloat(existingData[wallet.publicKey.toString()].solAmount);

        let completeSolNeeded = (solAmount * 1.015 + 0.0025) + completeSolAmountKeypairs;

	let currentSolBalance = await connection.getBalance(payer.publicKey);

	const currentSolBalanceInSol = currentSolBalance / 1_000_000_000; // Umrechnung in SOL
	
	if (currentSolBalanceInSol < completeSolNeeded) {
	    console.log(`Insufficient SOL balance. Required: ${completeSolNeeded} SOL, Available: ${currentSolBalanceInSol} SOL`);
	    console.log(`Please top up your Dev wallet (${payer.publicKey.toBase58()}) with at least ${(completeSolNeeded - currentSolBalanceInSol).toFixed(4)} SOL.`);

	    const proceed = prompt("Type 'check' to recheck the balance after topping up, or 'exit' to abort: ").toLowerCase();
	    
	    if (proceed === 'exit') {
		console.log("Aborting SOL transfer process.");
		return []; // Rückgabe einer leeren Anweisungsliste, um den Prozess zu beenden
	    } else if (proceed === 'check') {
		// Saldo erneut prüfen
		currentSolBalance = await connection.getBalance(payer.publicKey);
		const newSolBalanceInSol = currentSolBalance / LAMPORTS_PER_SOL;
		if (newSolBalanceInSol < completeSolNeeded) {
		    console.log(`Still insufficient SOL balance. Required: ${completeSolNeeded} SOL, Available: ${newSolBalanceInSol} SOL`);
		    console.log("Please try again later.");
		    return []; // Abbruch, falls der Saldo immer noch nicht ausreicht
		} else {
		    console.log(`Sufficient SOL balance detected: ${newSolBalanceInSol} SOL. Proceeding...`);
		}
	    } else {
		console.log("Invalid input. Aborting SOL transfer process.");
		return [];
	    }
	}
	ixs.push(
		SystemProgram.transfer({
			fromPubkey: payer.publicKey,
			toPubkey: wallet.publicKey,
			lamports: Math.floor((solAmount * 1.015 + 0.0025) * LAMPORTS_PER_SOL),
		})
	);
	console.log(`\nSent ${(solAmount * 1.015 + 0.0025).toFixed(3)} SOL to Dev Wallet (${wallet.publicKey.toString()})`);


	// Loop through the keypairs and process each one
	for (let i = 0; i < Math.min(steps, keypairs.length); i++) {
		const keypair = keypairs[i];
		const keypairPubkeyStr = keypair.publicKey.toString();

		if (!existingData[keypairPubkeyStr] || !existingData[keypairPubkeyStr].solAmount) {
			console.log(`Missing solAmount for wallet ${i + 1}, skipping.`);
			continue;
		}

		const solAmount = parseFloat(existingData[keypairPubkeyStr].solAmount);

		try {
			ixs.push(
				SystemProgram.transfer({
					fromPubkey: payer.publicKey,
					toPubkey: keypair.publicKey,
					lamports: Math.floor((solAmount * 1.015 + 0.0025) * LAMPORTS_PER_SOL),
				})
			);
			console.log(`Sent ${(solAmount * 1.015 + 0.0025).toFixed(3)} SOL to Wallet ${i + 1} (${keypair.publicKey.toString()})`);
		} catch (error) {
			console.error(`Error creating transfer instruction for wallet ${i + 1}:`, error);
			continue;
		}
	}

	ixs.push(
		SystemProgram.transfer({
			fromPubkey: payer.publicKey,
			toPubkey: getRandomTipAccount(),
			lamports: BigInt(tipAmt),
		})
	);

	return ixs;
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
	const chunks = [];
	for (let i = 0; i < array.length; i += chunkSize) {
		chunks.push(array.slice(i, i + chunkSize));
	}
	return chunks;
}

async function createAndSignVersionedTxWithKeypairs(instructionsChunk: TransactionInstruction[], blockhash: Blockhash | string): Promise<VersionedTransaction> {
	let poolInfo: { [key: string]: any } = {};
	if (fs.existsSync(keyInfoPath)) {
		const data = fs.readFileSync(keyInfoPath, "utf-8");
		poolInfo = JSON.parse(data);
	}

	const lut = new PublicKey(poolInfo.addressLUT.toString());

	const lookupTableAccount = (await connection.getAddressLookupTable(lut)).value;

	if (lookupTableAccount == null) {
		console.log("Lookup table account not found!");
		process.exit(0);
	}

	const addressesMain: PublicKey[] = [];
	instructionsChunk.forEach((ixn) => {
		ixn.keys.forEach((key) => {
			addressesMain.push(key.pubkey);
		});
	});

	const message = new TransactionMessage({
		payerKey: payer.publicKey,
		recentBlockhash: blockhash,
		instructions: instructionsChunk,
	}).compileToV0Message([lookupTableAccount]);

	const versionedTx = new VersionedTransaction(message);

	versionedTx.sign([payer]);

	/*
    // Simulate each txn
    const simulationResult = await connection.simulateTransaction(versionedTx, { commitment: "processed" });

    if (simulationResult.value.err) {
    console.log("Simulation error:", simulationResult.value.err);
    } else {
    console.log("Simulation success. Logs:");
    simulationResult.value.logs?.forEach(log => console.log(log));
    }
    */

	return versionedTx;
}

async function processInstructionsSOL(ixs: TransactionInstruction[], blockhash: string | Blockhash): Promise<VersionedTransaction[]> {
	const txns: VersionedTransaction[] = [];
	const instructionChunks = chunkArray(ixs, 45);

	for (let i = 0; i < instructionChunks.length; i++) {
		const versionedTx = await createAndSignVersionedTxWithKeypairs(instructionChunks[i], blockhash);
		txns.push(versionedTx);
	}

	return txns;
}

async function sendBundle(txns: VersionedTransaction[]) {
/*	
    // Simulate each transaction
    for (const tx of txns) {
        try {
            const simulationResult = await connection.simulateTransaction(tx, { commitment: "processed" });

            if (simulationResult.value.err) {
                console.error("Simulation error for transaction:", simulationResult.value.err);
            } else {
                console.log("Simulation success for transaction. Logs:");
                simulationResult.value.logs?.forEach(log => console.log(log));
            }
        } catch (error) {
            console.error("Error during simulation:", error);
        }
    }
    
*/
	try {
		const bundleId = await searcherClient.sendBundle(new JitoBundle(txns, txns.length));
		console.log(`Bundle ${bundleId} sent.`);
	} catch (error) {
		const err = error as any;
		console.error("Error sending bundle:", err.message);

		if (err?.message?.includes("Bundle Dropped, no connected leader up soon")) {
			console.error("Error sending bundle: Bundle Dropped, no connected leader up soon.");
		} else {
			console.error("An unexpected error occurred:", err.message);
		}
	}
}

async function generateATAandSOL() {
	const jitoTipAmt = +prompt("Jito tip in Sol (Ex. 0.01): ") * LAMPORTS_PER_SOL;

	const solIxs = await generateSOLTransferForKeypairs(jitoTipAmt);

	const { blockhash } = await connection.getLatestBlockhash();
	const sendTxns: VersionedTransaction[] = [];
	const solTxns = await processInstructionsSOL(solIxs, blockhash);
	sendTxns.push(...solTxns);

	await sendBundle(sendTxns);
}

async function gather() {
  const walletsKP = loadKeypairs();
  console.log(`Starting gather process for ${walletsKP.length} wallets`);

  // Process wallets in parallel
  await Promise.all(walletsKP.map((kp, i) => processWallet(kp, i, walletsKP.length)));

  console.log(`Gather process completed for all wallets`);
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      console.warn(`Retry ${i + 1}/${retries} failed. Retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("Retry logic failed");
}

async function processWallet(kp: Keypair, index: number, totalWallets: number): Promise<void> {
  console.log(`Processing wallet ${index + 1}/${totalWallets} - PublicKey: ${kp.publicKey.toBase58()}`);

  try {
    // Fetch account info with retry
    const accountInfo = await withRetry(() => connection.getAccountInfo(kp.publicKey));
    const ixs: TransactionInstruction[] = [];
    const accounts: TokenAccount[] = [];

    // Fetch SOL balance and add transfer instruction
    if (accountInfo) {
      const solBal = await withRetry(() => connection.getBalance(kp.publicKey));
      console.log(`Wallet ${index + 1} SOL balance: ${solBal / 1_000_000_000} SOL`);
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: payer.publicKey,
          lamports: solBal,
        })
      );
    } else {
      console.log(`No account info found for wallet ${index + 1}`);
    }

    // Fetch token accounts with retry
    const tokenAccounts = await withRetry(() =>
      connection.getTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM_ID }, "confirmed")
    );

    if (tokenAccounts.value.length > 0) {
      console.log(`Found ${tokenAccounts.value.length} token accounts for wallet ${index + 1}`);
      for (const { pubkey, account } of tokenAccounts.value) {
        accounts.push({
          pubkey,
          programId: account.owner,
          accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
        });
      }
    } else {
      console.log(`No token accounts found for wallet ${index + 1}`);
    }

    // Process token accounts
    for (const account of accounts) {
      const baseAta = await getAssociatedTokenAddress(account.accountInfo.mint, payer.publicKey);
      const tokenAccount = account.pubkey;
      const tokenBalance = await withRetry(() => connection.getTokenAccountBalance(account.pubkey));
      console.log(`Token balance: ${tokenBalance.value.amount} (decimals: ${tokenBalance.value.decimals})`);

      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, baseAta, payer.publicKey, account.accountInfo.mint),
        createTransferCheckedInstruction(
          tokenAccount,
          account.accountInfo.mint,
          baseAta,
          kp.publicKey,
          BigInt(tokenBalance.value.amount),
          tokenBalance.value.decimals
        ),
        createCloseAccountInstruction(tokenAccount, payer.publicKey, kp.publicKey)
      );
    }

    // Send transaction if there are instructions
    if (ixs.length) {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 220_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }),
        ...ixs
      );
      tx.feePayer = payer.publicKey;

      // Fetch fresh blockhash to avoid expiration
      tx.recentBlockhash = (await withRetry(() => connection.getLatestBlockhash())).blockhash;

      // console.log(await connection.simulateTransaction(tx))

      // Send and confirm transaction with retry
      const sig = await withRetry(() =>
        sendAndConfirmTransaction(connection, tx, [payer, kp], { commitment: "confirmed",skipPreflight: true, })
      );
      console.log(`Closed and gathered SOL & Token from wallet ${index + 1}: https://solscan.io/tx/${sig}`);
    } else {
      console.log(`No instructions to process for wallet ${index + 1}`);
    }
  } catch (error) {
    console.error(`Error processing wallet ${index + 1}:`, error);
  }
}

async function simulateAndWriteBuys() {
	const keypairs = loadKeypairs();

	const tokenDecimals = 10 ** 6;
	const tokenTotalSupply = 1000000000 * tokenDecimals;
	let initialRealSolReserves = 0;
	let initialVirtualTokenReserves = 1073000000 * tokenDecimals;
	let initialRealTokenReserves = 793100000 * tokenDecimals;
	let totalTokensBought = 0;
	const buys: { pubkey: PublicKey; solAmount: Number; tokenAmount: BN; percentSupply: number }[] = [];

        // Variables to store min and max SOL for bundle wallets
        let minSol: number | undefined;
        let maxSol: number | undefined;

	for (let it = 0; it <= NUM_OF_WALLETS; it++) { 
		let keypair;

		let solInput;
		if (it === 0) {
			solInput = prompt(`Enter the amount of SOL for dev wallet: \n`);
			solInput = Number(solInput) * 1.21;
			keypair = wallet;
		} else {
	          if (it === 1) {
			// Prompt for min and max SOL only once before processing bundle wallets
			minSol = +prompt(`Enter the minimum SOL amount for bundle wallets: `);
			maxSol = +prompt(`Enter the maximum SOL amount for bundle wallets: \n`);
			
			// Validate min and max inputs
			if (isNaN(minSol) || isNaN(maxSol) || minSol < 0 || maxSol < minSol) {
			    console.log(`Invalid min/max SOL values, skipping wallet ${it}.`);
			    continue;
			}
			
		    }

		    // Ensure minSol and maxSol are defined before using them
		    if (minSol === undefined || maxSol === undefined) {
			console.log(`Min/max SOL values not set, skipping wallet ${it}.`);
			continue;
		    }
		    // Generate random SOL amount between min and max (2 decimal places)
		    const randomSol = Number(
			(Math.random() * (maxSol - minSol) + minSol).toFixed(2)
		    );
		    solInput = randomSol;
		    keypair = keypairs[it - 1];
		
		}

		const solAmount = solInput * LAMPORTS_PER_SOL;

		if (isNaN(solAmount) || solAmount <= 0) {
			console.log(`Invalid input for wallet ${it}, skipping.`);
			continue;
		}

		const e = new BN(solAmount);
		const initialVirtualSolReserves = 30 * LAMPORTS_PER_SOL + initialRealSolReserves;
		const a = new BN(initialVirtualSolReserves).mul(new BN(initialVirtualTokenReserves));
		const i = new BN(initialVirtualSolReserves).add(e);
		const l = a.div(i).add(new BN(1));
		let tokensToBuy = new BN(initialVirtualTokenReserves).sub(l);
		tokensToBuy = BN.min(tokensToBuy, new BN(initialRealTokenReserves));

		const tokensBought = tokensToBuy.toNumber();
		const percentSupply = (tokensBought / tokenTotalSupply) * 100;

		console.log(`Wallet ${it}: Bought ${tokensBought / tokenDecimals} tokens for ${e.toNumber() / LAMPORTS_PER_SOL} SOL`);
		console.log(`Wallet ${it}: Owns ${percentSupply.toFixed(4)}% of total supply\n`);

		buys.push({ pubkey: keypair.publicKey, solAmount: Number(solInput), tokenAmount: tokensToBuy, percentSupply });

		initialRealSolReserves += e.toNumber();
		initialRealTokenReserves -= tokensBought;
		initialVirtualTokenReserves -= tokensBought;
		totalTokensBought += tokensBought;
	}

	console.log("Final real sol reserves:", initialRealSolReserves / LAMPORTS_PER_SOL);
	console.log("Final real token reserves:", initialRealTokenReserves / tokenDecimals);
	console.log("Final virtual token reserves:", initialVirtualTokenReserves / tokenDecimals);
	console.log("Total tokens bought:", totalTokensBought / tokenDecimals);
	console.log(`Total % of tokens bought: ${((totalTokensBought / tokenTotalSupply) * 100).toFixed(2)}%`);
	console.log(); // \n

	const confirm = prompt("Do you want to use these buys? (yes/no): ").toLowerCase();
	if (confirm === "yes") {
		writeBuysToFile(buys);
	} else {
		console.log("Simulation aborted. Restarting...");
		simulateAndWriteBuys(); // Restart the simulation
	}
}

function writeBuysToFile(buys: Buy[]) {
	let existingData: any = {};

	if (fs.existsSync(keyInfoPath)) {
		existingData = JSON.parse(fs.readFileSync(keyInfoPath, "utf-8"));
	}

	// Convert buys array to an object keyed by public key
	const buysObj = buys.reduce((acc, buy) => {
		acc[buy.pubkey.toString()] = {
			solAmount: buy.solAmount.toString(),
			tokenAmount: buy.tokenAmount.toString(),
			percentSupply: buy.percentSupply,
		};
		return acc;
	}, existingData); // Initialize with existing data

	// Write updated data to file
	fs.writeFileSync(keyInfoPath, JSON.stringify(buysObj, null, 2), "utf8");
	console.log("Buys have been successfully saved to keyinfo.json");
}

export async function sender() {
	let running = true;

	while (running) {
		console.log("╔═══════════════════════════════════════════════╗");
		console.log("║       🛒  Options  🛒                         ║");
		console.log("╠═══════════════════════════════════════════════╣");
		console.log("║ 1. 📝  Create LUT                             ║");
		console.log("║ 2. 📚  Extend LUT Bundle                      ║");
		console.log("║ 3. 🔄  Simulate Buys                          ║");
		console.log("║ 4. 💸  Send Sim SOL from Payer to real Bundle ║");
		console.log("║ 5. 📊  Show Simulated & Real Balance          ║");
		console.log("║ 6. 🔙  Gather ALL SOL&Tok -> Payer            ║");
		console.log("╠═══════════════════════════════════════════════╣");
		console.log("║  Type 'exit' to quit.                         ║");
		console.log("╚═══════════════════════════════════════════════╝\n");

		const answer = prompt("👉 Choose between 1–6 or 'exit': ");

		switch (answer) {
			case "1":
				await createLUT();
				break;
			case "2":
				await extendLUT();
				break;
			case "3":
				await simulateAndWriteBuys();
				break;
			case "4":
				await generateATAandSOL();
				break;
			case "5":
				await showBundleAndDevBalance();
				break;
			case "6":
				await gather();
				break;
			case "exit":
				running = false;
				break;
			default:
				console.log("Invalid option, please choose again.");
		}
	}

	console.log("Exiting...");
}
