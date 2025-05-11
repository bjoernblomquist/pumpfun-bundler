import { connection, wallet, PUMP_PROGRAM, feeRecipient, eventAuthority, global, MPL_TOKEN_METADATA_PROGRAM_ID, mintAuthority, rpc, payer } from "../config";
import {
	PublicKey,
	VersionedTransaction,
	TransactionInstruction,
	SYSVAR_RENT_PUBKEY,
	TransactionMessage,
	SystemProgram,
	Keypair,
	LAMPORTS_PER_SOL,
	AddressLookupTableAccount,
} from "@solana/web3.js";
import { loadKeypairs } from "./createKeys";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import promptSync from "prompt-sync";
import * as spl from "@solana/spl-token";
import bs58 from "bs58";
import path from "path";
import fs from "fs";
import { Program, Idl, AnchorProvider, setProvider } from "@coral-xyz/anchor";
import { getRandomTipAccount } from "./clients/config";
import BN from "bn.js";
import axios from "axios";

// Pfad zur JSON-Datei ( Passe den Dateinamen und Pfad an )
const jsonFilePath = "./metadata/token.json";
const prompt = promptSync();
const keyInfoPath = path.join(__dirname, "keyInfo.json");

interface TokenData {
  name: string;
  symbol: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

async function loadTokenData(): Promise<TokenData> {
  try {
    // Read JSON file synchronously
    const jsonData = fs.readFileSync(jsonFilePath, "utf-8");
    const tokenData: TokenData = JSON.parse(jsonData);

    // Log the loaded data
    console.log(`\n🎉 Token Name: ${tokenData.name} ✨`);
    console.log(`💰 Symbol: ${tokenData.symbol} 🚀`);
    console.log(`📝 Description: ${tokenData.description} 📚`);
    console.log(`🐦 Twitter: ${tokenData.twitter || "N/A"} 🔗`);
    console.log(`📨 Telegram: ${tokenData.telegram || "N/A"} 💬`);
    console.log(`🌐 Website: ${tokenData.website || "N/A"} 🖥️\n`);

    return tokenData;
  } catch (error: any) {
    console.error("❌ Fehler beim Einlesen der JSON-Datei:", error.message);
    throw error; // Rethrow to handle in the caller
  }
}

export async function buyBundle() {
	const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
        setProvider(provider);
	// Initialize pumpfun anchor
	const IDL_PumpFun = JSON.parse(fs.readFileSync("./pumpfun-IDL.json", "utf-8")) as Idl;

	const program = new Program(IDL_PumpFun, provider);

	// Start create bundle
	const bundledTxns: VersionedTransaction[] = [];
	const keypairs: Keypair[] = loadKeypairs();

	let keyInfo: { [key: string]: any } = {};
	if (fs.existsSync(keyInfoPath)) {
		const existingData = fs.readFileSync(keyInfoPath, "utf-8");
		keyInfo = JSON.parse(existingData);
	}

	const lut = new PublicKey(keyInfo.addressLUT.toString());

	const lookupTableAccount = (await connection.getAddressLookupTable(lut)).value;

	if (lookupTableAccount == null) {
		console.log("Lookup table account not found!");
		process.exit(0);
	}

	// -------- step 1: ask nessesary questions for pool build --------
        /* Manuelle Abfrage
	const name = prompt("Name of your token: ");
	const symbol = prompt("Symbol of your token: ");
	const description = prompt("Description of your token: ");
	const twitter = prompt("Twitter of your token: ");
	const telegram = prompt("Telegram of your token: ");
	const website = prompt("Website of your token: ");
        */
        // Automatisch aus File
	// Load token data
	let tokenData: TokenData;
	try {
	tokenData = await loadTokenData();
	} catch (error) {
	console.error("Failed to load token data, exiting...");
	process.exit(1);
	}

	// Abfrage, ob die Token-Daten korrekt sind
	const confirmation = prompt("Token Data correct? (yes/no): ").toLowerCase();
	if (confirmation !== "yes") {
        	console.log("🔙 Exit, back to Menu...");
	        return; // Beendet die Funktion und "springt" zurück
	}

	const { name, symbol, description, twitter, telegram, website } = tokenData;

	const tipAmt = +prompt("Jito tip in SOL: ") * LAMPORTS_PER_SOL;

	// -------- step 2: build pool init + dev snipe --------
	const files = await fs.promises.readdir("./metadata/img");
	if (files.length == 0) {
		console.log("No image found in the img folder");
		return;
	}
	if (files.length > 1) {
		console.log("Multiple images found in the img folder, please only keep one image");
		return;
	}
	const data: Buffer = fs.readFileSync(`./metadata/img/${files[0]}`);

	let formData = new FormData();
	if (data) {
		formData.append("file", new Blob([data], { type: "image/jpeg" }));
	} else {
		console.log("No image found");
		return;
	}

	formData.append("name", name);
	formData.append("symbol", symbol);
	formData.append("description", description);
	// Only append optional fields if they are defined
	if (twitter) formData.append("twitter", twitter);
	if (telegram) formData.append("telegram", telegram);
	if (website) formData.append("website", website);
	formData.append("showName", "true");

	let metadata_uri;
	try {
		const response = await axios.post("https://pump.fun/api/ipfs", formData, {
			headers: {
				"Content-Type": "multipart/form-data",
			},
		});
		metadata_uri = response.data.metadataUri;
		console.log("Metadata URI: ", metadata_uri);
	} catch (error) {
		console.error("Error uploading metadata:", error);
	}

	const mintKp = Keypair.fromSecretKey(Uint8Array.from(bs58.decode(keyInfo.mintPk)));
	console.log(`Mint: ${mintKp.publicKey.toBase58()}`);

	const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKp.publicKey.toBytes()], program.programId);
        const associatedBondingCurve = spl.getAssociatedTokenAddressSync(mintKp.publicKey, bondingCurve, true);
	const [metadata] = PublicKey.findProgramAddressSync(
		[Buffer.from("metadata"), MPL_TOKEN_METADATA_PROGRAM_ID.toBytes(), mintKp.publicKey.toBytes()],
		MPL_TOKEN_METADATA_PROGRAM_ID
	);

	const account1 = mintKp.publicKey;
	const account2 = mintAuthority;
	const account3 = bondingCurve;
	const account5 = global;
	const account6 = MPL_TOKEN_METADATA_PROGRAM_ID;
	const account7 = metadata;

	const createIx = await program.methods
		.create(name, symbol, metadata_uri, wallet.publicKey)
		.accounts({
		        mint: mintKp.publicKey,
        mintAuthority: PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM)[0],
        bondingCurve: bondingCurve,
        associatedBondingCurve: spl.getAssociatedTokenAddressSync(mintKp.publicKey, bondingCurve, true),
        global: PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM)[0],
        mplTokenMetadata: MPL_TOKEN_METADATA_PROGRAM_ID,
        metadata: metadata,
        user: wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: spl.TOKEN_PROGRAM_ID,
        associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        eventAuthority: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"),
        program: PUMP_PROGRAM,
		})
		.instruction();

	// Get the associated token address
	const ata = spl.getAssociatedTokenAddressSync(mintKp.publicKey, wallet.publicKey);
	const ataIx = spl.createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, mintKp.publicKey);

	// Extract tokenAmount from keyInfo for this keypair
	const keypairInfo = keyInfo[wallet.publicKey.toString()];
	if (!keypairInfo) {
		console.log(`No key info found for keypair: ${wallet.publicKey.toString()}`);
	}

	// Calculate SOL amount based on tokenAmount
	const amount = new BN(keypairInfo.tokenAmount);
	const solAmount = new BN(100000 * keypairInfo.solAmount * LAMPORTS_PER_SOL);
	console.log(`Dev Wallet: ${wallet.publicKey.toString()} SolAmount: ${solAmount} Jito: ${tipAmt}`);

	const buyIx = await program.methods
		.buy(amount, solAmount)
		.accounts({
			        global: global, // Aus config importiert
        feeRecipient: feeRecipient, // Aus config importiert
        mint: mintKp.publicKey, // Mint des Tokens
        bondingCurve: bondingCurve, // Berechnet mit PublicKey.findProgramAddressSync
        associatedBondingCurve: spl.getAssociatedTokenAddressSync(mintKp.publicKey, bondingCurve, true), // ATA der Bonding Curve
        associatedUser: ata, // ATA des Käufers (bereits erstellt)
        user: wallet.publicKey, // Käufer-Wallet
        systemProgram: SystemProgram.programId,
			tokenProgram: spl.TOKEN_PROGRAM_ID,
			rent: SYSVAR_RENT_PUBKEY,
			eventAuthority,
			program: PUMP_PROGRAM,
		})
		.instruction();

	const tipIxn = SystemProgram.transfer({
		fromPubkey: wallet.publicKey,
		toPubkey: getRandomTipAccount(),
		lamports: BigInt(tipAmt),
	});

	const initIxs: TransactionInstruction[] = [createIx, ataIx, buyIx, tipIxn];

	const { blockhash } = await connection.getLatestBlockhash();

	const messageV0 = new TransactionMessage({
		payerKey: wallet.publicKey,
		instructions: initIxs,
		recentBlockhash: blockhash,
	}).compileToV0Message();

	const fullTX = new VersionedTransaction(messageV0);
	fullTX.sign([wallet, mintKp]);

	bundledTxns.push(fullTX);

	// -------- step 3: create swap txns --------
	const txMainSwaps: VersionedTransaction[] = await createWalletSwaps(blockhash, keypairs, lookupTableAccount, bondingCurve, associatedBondingCurve, mintKp.publicKey, program);
	bundledTxns.push(...txMainSwaps);

	// -------- step 4: send bundle --------
        // Simulate each transaction
        /*for (const tx of bundledTxns) {
            try {
                const simulationResult = await connection.simulateTransaction(tx, { commitment: "processed" });
                console.log(simulationResult);

                if (simulationResult.value.err) {
                    console.error("Simulation error for transaction:", simulationResult.value.err);
                } else {
                    console.log("Simulation success for transaction. Logs:");
                    simulationResult.value.logs?.forEach(log => console.log(log));
                }
            } catch (error) {
                console.error("Error during simulation:", error);
            }
        }*/

	await sendBundle(bundledTxns);
}

async function createWalletSwaps(
	blockhash: string,
	keypairs: Keypair[],
	lut: AddressLookupTableAccount,
	bondingCurve: PublicKey,
	associatedBondingCurve: PublicKey,
	mint: PublicKey,
	program: Program
): Promise<VersionedTransaction[]> {
	const txsSigned: VersionedTransaction[] = [];
	const chunkedKeypairs = chunkArray(keypairs, 6);

	// Load keyInfo data from JSON file
	let keyInfo: { [key: string]: { solAmount: number; tokenAmount: string; percentSupply: number } } = {};
	if (fs.existsSync(keyInfoPath)) {
		const existingData = fs.readFileSync(keyInfoPath, "utf-8");
		keyInfo = JSON.parse(existingData);
	}

	// Iterate over each chunk of keypairs
	for (let chunkIndex = 0; chunkIndex < chunkedKeypairs.length; chunkIndex++) {
		const chunk = chunkedKeypairs[chunkIndex];
		const instructionsForChunk: TransactionInstruction[] = [];

		// Iterate over each keypair in the chunk to create swap instructions
		for (let i = 0; i < chunk.length; i++) {
			const keypair = chunk[i];
			console.log(`Processing keypair ${i + 1}/${chunk.length}:`, keypair.publicKey.toString());

			const ataAddress = await spl.getAssociatedTokenAddress(mint, keypair.publicKey);

			const createTokenAta = spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ataAddress, keypair.publicKey, mint);

			// Extract tokenAmount from keyInfo for this keypair
			const keypairInfo = keyInfo[keypair.publicKey.toString()];
			if (!keypairInfo) {
				console.log(`No key info found for keypair: ${keypair.publicKey.toString()}`);
				continue;
			}

			// Calculate SOL amount based on tokenAmount
			const amount = new BN(keypairInfo.tokenAmount);
			const solAmount = new BN(100000 * keypairInfo.solAmount * LAMPORTS_PER_SOL);
			console.log(`Bundle ${i} Wallet: ${keypair.publicKey.toString()} SolAmount: ${solAmount}`);


			const buyIx = await program.methods
				.buy(amount, solAmount)
				.accounts({
		global: global,
        feeRecipient: feeRecipient,
        mint: mint,
        bondingCurve: bondingCurve,
        associatedBondingCurve: associatedBondingCurve,
        associatedUser: ataAddress,
        user: keypair.publicKey,
					systemProgram: SystemProgram.programId,
					tokenProgram: spl.TOKEN_PROGRAM_ID,
					rent: SYSVAR_RENT_PUBKEY,
					eventAuthority,
					program: PUMP_PROGRAM,
				})
				.instruction();

			instructionsForChunk.push(createTokenAta, buyIx);
		}


		const message = new TransactionMessage({
			payerKey: payer.publicKey,
			recentBlockhash: blockhash,
			instructions: instructionsForChunk,
		}).compileToV0Message([lut]);
		const versionedTx = new VersionedTransaction(message);

		const serializedMsg = message.serialize();
		console.log("Txn size:", serializedMsg.length);
		if (serializedMsg.length > 1232) {
			console.log("tx too big");
		}

		console.log(
			"Signing transaction with chunk signers",
			chunk.map((kp) => kp.publicKey.toString())
		);

		// Sign with the wallet for tip on the last instruction
		for (const kp of chunk) {
			if (kp.publicKey.toString() in keyInfo) {
				versionedTx.sign([kp]);
			}
		}

		versionedTx.sign([payer]);

		txsSigned.push(versionedTx);
	}

	return txsSigned;
}

function chunkArray<T>(array: T[], size: number): T[][] {
	return Array.from({ length: Math.ceil(array.length / size) }, (v, i) => array.slice(i * size, i * size + size));
}

export async function sendBundle(bundledTxns: VersionedTransaction[]) {
	
    // Simulate each transaction
    for (const tx of bundledTxns) {
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
    

	try {
		const bundleId = await searcherClient.sendBundle(new JitoBundle(bundledTxns, bundledTxns.length));
		console.log(`Bundle ${bundleId} sent.`);

		///*
		// Assuming onBundleResult returns a Promise<BundleResult>
		const result = await new Promise((resolve, reject) => {
			searcherClient.onBundleResult(
				(result) => {
					console.log("Received bundle result:", result);
					resolve(result); // Resolve the promise with the result
				},
				(e: Error) => {
					console.error("Error receiving bundle result:", e);
					reject(e); // Reject the promise if there's an error
				}
			);
		});

		console.log("Result:", result);
		//*/
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
