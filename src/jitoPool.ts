import { connection, devWalletSellDelay, PUMP_PROGRAM, feeRecipient, eventAuthority, global, MPL_TOKEN_METADATA_PROGRAM_ID, mintAuthority, rpc, payer } from "../config";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
         getAssociatedTokenAddressSync,
         createAssociatedTokenAccountIdempotentInstruction }
  from "@solana/spl-token";
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
import {sendTelegramMsg} from "./telegram";
import { sellDevWalletPF } from "./sellFunc"; 
import { getMC } from "./utils/getMarketCapSol"; 
import { Metaplex } from "@metaplex-foundation/js";
import { createCloseAccountInstruction, getMinimumBalanceForRentExemptAccount, getMint } from "@solana/spl-token";
import { u8, struct } from '@solana/buffer-layout';
import { u64, publicKey } from '@solana/buffer-layout-utils';
import {loadDevKeypair} from "./createKeys";

// Pfad zur JSON-Datei ( Passe den Dateinamen und Pfad an )
const jsonFilePath = "./metadata/token.json";
const prompt = promptSync();
const keyInfoPath = path.join(__dirname, "keyInfo.json");
const volumeFilePath = path.join(__dirname, "volume.json");

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


const monitorMarketCap = (bondingCurvePub: PublicKey): Promise<boolean> => {
    console.log("Monitoring MarketCap...");
    return new Promise((resolve) => {
        const monitor = setInterval(async () => {
            const mc = await getMC(connection, bondingCurvePub);
            //console.log("🚀 Current Market Cap Sol:", mc);
/*            if (mc >= MARKET_CAP) {
                clearInterval(monitor);
                resolve(true);
            }*/
        }, 500);
    });
};


export async function buyBundle() {
	  const wallet = loadDevKeypair();
	  if (!wallet) {
	    console.error('Dev wallet is required to proceed.');
	    return;
	  }

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
	console.log("\n");
	console.log(`Mint: ${mintKp.publicKey.toBase58()}`);
	console.log("\n");

	const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKp.publicKey.toBytes()], program.programId);
        const associatedBondingCurve = spl.getAssociatedTokenAddressSync(
  mintKp.publicKey,
  bondingCurve,
  true,
  TOKEN_PROGRAM_ID
);
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
			mintAuthority: mintAuthority,
			bondingCurve: bondingCurve,
			associatedBondingCurve: associatedBondingCurve,
			global:  global,
			mplTokenMetadata: MPL_TOKEN_METADATA_PROGRAM_ID,
			metadata: metadata,
			user: wallet.publicKey,
			systemProgram: SystemProgram.programId,
			tokenProgram: TOKEN_PROGRAM_ID,
			associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
			rent: SYSVAR_RENT_PUBKEY,
			eventAuthority: eventAuthority, 
			program: PUMP_PROGRAM,
		})
		.instruction();

	// Get the associated token address
	const ata = getAssociatedTokenAddressSync(
	  mintKp.publicKey,
	  wallet.publicKey,
	  false,                  // owner is on‐curve
	  TOKEN_PROGRAM_ID,
	  ASSOCIATED_TOKEN_PROGRAM_ID
	);
	const ataIx = createAssociatedTokenAccountIdempotentInstruction(
	  wallet.publicKey,       // funding account
	  ata,
	  wallet.publicKey,
	  mintKp.publicKey,
	  TOKEN_PROGRAM_ID,      // make extra sure these are SPL’s
	  ASSOCIATED_TOKEN_PROGRAM_ID
	);

	// Extract tokenAmount from keyInfo for this keypair
	const keypairInfo = keyInfo[wallet.publicKey.toString()];
	if (!keypairInfo) {
		console.log(`No key info found for keypair: ${wallet.publicKey.toString()}`);
	}

	// Calculate SOL amount based on tokenAmount
	const amount = new BN(keypairInfo.tokenAmount);
	const solAmount = new BN(100000 * keypairInfo.solAmount * LAMPORTS_PER_SOL);
	console.log(`Dev Wallet: ${wallet.publicKey.toString()} SolAmount: ${keypairInfo.solAmount} plus Jito`);
	console.log("\n");
	const [creatorVault] = PublicKey.findProgramAddressSync(
	  [Buffer.from("creator-vault"), wallet.publicKey.toBytes()],
	  PUMP_PROGRAM,
	);
	//NEW
	const associatedBondingCurveNew = spl.getAssociatedTokenAddressSync(
	  mintKp.publicKey,
	  bondingCurve,
	  true, // allowOwnerOffCurve (bonding curve is a PDA)
	  TOKEN_PROGRAM_ID // Legacy Token Program
	);
	const buyIx = await program.methods
		.buy(amount, solAmount)
		.accounts({
		feeRecipient: feeRecipient, // Aus config importiert
		mint: mintKp.publicKey, // Mint des Tokens
		bondingCurve: bondingCurve, // Berechnet mit PublicKey.findProgramAddressSync
		associatedBondingCurve: associatedBondingCurveNew, 
		associatedUser: ata, // ATA des Käufers (bereits erstellt)
		user: wallet.publicKey, // Käufer-Wallet
		systemProgram: SystemProgram.programId,
		tokenProgram: TOKEN_PROGRAM_ID,
		creatorVault:creatorVault,               // NEW
		eventAuthority: eventAuthority,
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
	const txMainSwaps: VersionedTransaction[] = await createWalletSwaps(blockhash, keypairs, lookupTableAccount, bondingCurve, associatedBondingCurve, mintKp.publicKey, program, wallet);
	bundledTxns.push(...txMainSwaps);

	// -------- step 4: send bundle --------
	await sendBundle(bundledTxns, mintKp);
}

/*async function createWalletSwaps(
	blockhash: string,
	keypairs: Keypair[],
	lut: AddressLookupTableAccount,
	bondingCurve: PublicKey,
	associatedBondingCurve: PublicKey,
	mint: PublicKey,
	program: Program
): Promise<VersionedTransaction[]> {
	const txsSigned: VersionedTransaction[] = [];
	const chunkedKeypairs = chunkArray(keypairs, 6); //6

	// Load keyInfo data from JSON file
	let keyInfo: { [key: string]: { solAmount: number; tokenAmount: string; percentSupply: number } } = {};
	if (fs.existsSync(keyInfoPath)) {
		const existingData = fs.readFileSync(keyInfoPath, "utf-8");
		keyInfo = JSON.parse(existingData);
	}
			const [creatorVault] = PublicKey.findProgramAddressSync(
			  [Buffer.from("creator-vault"), wallet.publicKey.toBytes()],
			  PUMP_PROGRAM,
			);

	// Iterate over each chunk of keypairs
	for (let chunkIndex = 0; chunkIndex < chunkedKeypairs.length; chunkIndex++) {
		const chunk = chunkedKeypairs[chunkIndex];
		const instructionsForChunk: TransactionInstruction[] = [];

		// Iterate over each keypair in the chunk to create swap instructions
		for (let i = 0; i < chunk.length; i++) {
			const keypair = chunk[i];
			console.log(`Processing keypair ${i + 1}/${chunk.length}:`, keypair.publicKey.toString());

		const ataAddress = getAssociatedTokenAddressSync(
			  mint,
			  keypair.publicKey,
			  false,                  // owner is on‐curve
			  TOKEN_PROGRAM_ID,
			  ASSOCIATED_TOKEN_PROGRAM_ID
			);
			const createTokenAta = createAssociatedTokenAccountIdempotentInstruction(
			  payer.publicKey,       // funding account
			  ataAddress,
			  keypair.publicKey,
			  mint,
			  TOKEN_PROGRAM_ID,      // make extra sure these are SPL’s
			  ASSOCIATED_TOKEN_PROGRAM_ID
			);
		      // Explicitly use TOKEN_PROGRAM_ID for ATA derivation

			// Extract tokenAmount from keyInfo for this keypair
			const keypairInfo = keyInfo[keypair.publicKey.toString()];
			if (!keypairInfo) {
				console.log(`No key info found for keypair: ${keypair.publicKey.toString()}`);
				continue;
			}

			// Calculate SOL amount based on tokenAmount
			const amount = new BN(keypairInfo.tokenAmount);
			const solAmount = new BN(100000 * keypairInfo.solAmount * LAMPORTS_PER_SOL);
			console.log(`Bundle ${i} Wallet: ${keypair.publicKey.toString()} SolAmount: ${keypairInfo.solAmount}\n`);
			const buyIx = await program.methods
				.buy(amount, solAmount)
				.accounts({
					systemProgram: SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
					feeRecipient: feeRecipient,
				    	bondingCurve: bondingCurve,
					associatedUser: ataAddress,
					user: keypair.publicKey,
					mint: mint,
					associatedBondingCurve: associatedBondingCurve,
					creatorVault: creatorVault,               // NEW
					eventAuthority: eventAuthority,
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
        }

	return txsSigned;
}*/

async function createWalletSwaps(
    blockhash: string,
    keypairs: Keypair[],
    lut: AddressLookupTableAccount,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    mint: PublicKey,
    program: Program,
    wallet: Keypair 
): Promise<VersionedTransaction[]> {
    const txsSigned: VersionedTransaction[] = [];
    const chunkedKeypairs = chunkArray(keypairs, 2); // Chunk into pairs for two buy instructions per tx

    // Load keyInfo data from JSON file
    let keyInfo: { [key: string]: { solAmount: number; tokenAmount: string; percentSupply: number } } = {};
    if (fs.existsSync(keyInfoPath)) {
        const existingData = fs.readFileSync(keyInfoPath, "utf-8");
        keyInfo = JSON.parse(existingData);
    }

    const [creatorVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("creator-vault"), wallet.publicKey.toBytes()],
        PUMP_PROGRAM,
    );

    // Iterate over each chunk of keypairs (2 keypairs per chunk)
    for (let chunkIndex = 0; chunkIndex < chunkedKeypairs.length; chunkIndex++) {
        const chunk = chunkedKeypairs[chunkIndex];
        const instructionsForChunk: TransactionInstruction[] = [];

        // Determine payerKey: use second keypair if available, otherwise first
        const payerKey = chunk.length === 2 ? chunk[1].publicKey : chunk[0].publicKey;

        // Iterate over each keypair in the chunk to create swap instructions
        for (let i = 0; i < chunk.length; i++) {
            const keypair = chunk[i];
            console.log(`Processing keypair ${i + 1}/${chunk.length}:`, keypair.publicKey.toString());

            const ataAddress = getAssociatedTokenAddressSync(
                mint,
                keypair.publicKey,
                false,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            );
            const createTokenAta = createAssociatedTokenAccountIdempotentInstruction(
                payerKey, // Use selected payerKey for funding
                ataAddress,
                keypair.publicKey,
                mint,
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID
            );

            // Extract tokenAmount from keyInfo for this keypair
            const keypairInfo = keyInfo[keypair.publicKey.toString()];
            if (!keypairInfo) {
                console.log(`No key info found for keypair: ${keypair.publicKey.toString()}`);
                continue;
            }

            // Calculate SOL amount based on tokenAmount
            const amount = new BN(keypairInfo.tokenAmount);
            const solAmount = new BN(100000 * keypairInfo.solAmount * LAMPORTS_PER_SOL);
            console.log(`Bundle ${i} Wallet: ${keypair.publicKey.toString()} SolAmount: ${keypairInfo.solAmount}\n`);

            const buyIx = await program.methods
                .buy(amount, solAmount)
                .accounts({
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    feeRecipient: feeRecipient,
                    bondingCurve: bondingCurve,
                    associatedUser: ataAddress,
                    user: keypair.publicKey,
                    mint: mint,
                    associatedBondingCurve: associatedBondingCurve,
                    creatorVault: creatorVault,
                    eventAuthority: eventAuthority,
                    program: PUMP_PROGRAM,
                })
                .instruction();

            instructionsForChunk.push(createTokenAta, buyIx);
        }

        // Skip if no instructions were created (e.g., due to missing keyInfo)
        if (instructionsForChunk.length === 0) {
            console.log(`Skipping chunk ${chunkIndex} due to no valid instructions`);
            continue;
        }

        const message = new TransactionMessage({
            payerKey: payerKey,
            recentBlockhash: blockhash,
            instructions: instructionsForChunk,
        }).compileToV0Message([lut]);
        const versionedTx = new VersionedTransaction(message);

        const serializedMsg = message.serialize();
        console.log("Txn size:", serializedMsg.length);
        if (serializedMsg.length > 1232) {
            console.log("tx too big");
            continue;
        }

        console.log(
            "Signing transaction with chunk signers",
            chunk.map((kp) => kp.publicKey.toString())
        );

        // Sign with all keypairs in the chunk
        for (const kp of chunk) {
            if (kp.publicKey.toString() in keyInfo) {
                versionedTx.sign([kp]);
            }
        }

        txsSigned.push(versionedTx);
    }

    return txsSigned;
}

function chunkArray<T>(array: T[], size: number): T[][] {
	return Array.from({ length: Math.ceil(array.length / size) }, (v, i) => array.slice(i * size, i * size + size));
}

const getTokenMetadata = async (mintAddress: string, retries: number = 5, delay: number = 100): Promise<any> => {
    const metaplex = Metaplex.make(connection);
    const mintPublicKey = new PublicKey(mintAddress);

    const delayFunction = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const nft = await metaplex.nfts().findByMint({ mintAddress: mintPublicKey });
            return nft.json;
        } catch (error) {
            if (attempt < retries) {
                await delayFunction(delay);
            } else {
                return false;
            }
        }
    }
};

interface VolumeData {
  [iteration: number]: {
    buyer: string;
    seller1: string;
    seller2: string;
  };
}

// Define the structure of the Pump.fun bonding curve
interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: number;
  mint: PublicKey;
  global: PublicKey;
}

// Pump.fun Bonding Curve Layout
const PUMP_FUN_BONDING_CURVE_LAYOUT = struct<BondingCurveState>([
  u64('virtualTokenReserves'),
  u64('virtualSolReserves'),
  u64('realTokenReserves'),
  u64('realSolReserves'),
  u64('tokenTotalSupply'),
  u8('complete'), // 1 if the bonding curve is complete, 0 if not
]);

// Function to fetch and decode Pump.fun bonding curve state on-chain
async function getPumpFunBondingCurveState(tokenMint: PublicKey): Promise<BondingCurveState | null> {
  const bondingCurve = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), tokenMint.toBuffer()],
    PUMP_PROGRAM
  )[0];

  const account = await connection.getAccountInfo(bondingCurve);
  if (!account) {
    console.log(`No account info for bonding curve: ${bondingCurve.toBase58()}`);
    return null;
  }
  if (!account.owner.equals(PUMP_PROGRAM)) {
    console.log(`Account ${bondingCurve.toBase58()} is not owned by Pump.fun program`);
    return null;
  }

  const decoded = PUMP_FUN_BONDING_CURVE_LAYOUT.decode(account.data);
  console.log('Bonding Curve State:', {
    virtualTokenReserves: decoded.virtualTokenReserves.toString(),
    virtualSolReserves: decoded.virtualSolReserves.toString(),
    realTokenReserves: decoded.realTokenReserves.toString(),
    realSolReserves: decoded.realSolReserves.toString(),
    tokenTotalSupply: decoded.tokenTotalSupply.toString(),
    complete: decoded.complete === 1,
  });

  return decoded;
}


// Function to estimate tokens out for a given SOL amount on Pump.fun
async function estimatePumpFunTokensOut(
  bondingCurveInfo: any,
  solAmount: BN
): Promise<BN> {
  const virtualSolReserves = new BN(bondingCurveInfo.virtualSolReserves);
  const virtualTokenReserves = new BN(bondingCurveInfo.virtualTokenReserves);
  const solAmountLamports = solAmount;

  // Simplified constant product formula: (x * y) = k
  // Tokens out = (virtualTokenReserves * solAmount) / (virtualSolReserves + solAmount)
  const numerator = virtualTokenReserves.mul(solAmountLamports);
  const denominator = virtualSolReserves.add(solAmountLamports);
  if (denominator.eq(new BN(0))) {
    throw new Error('Denominator cannot be zero in token out calculation');
  }
  return numerator.div(denominator);
}

// Function to estimate SOL out for a given token amount on Pump.fun
async function estimatePumpFunSolOut(
  bondingCurveInfo: any,
  tokenAmount: BN
): Promise<BN> {
  const virtualSolReserves = new BN(bondingCurveInfo.virtualSolReserves);
  const virtualTokenReserves = new BN(bondingCurveInfo.virtualTokenReserves);

  // Simplified constant product formula: (x * y) = k
  // SOL out = (virtualSolReserves * tokenAmount) / (virtualTokenReserves + tokenAmount)
  const numerator = virtualSolReserves.mul(tokenAmount);
  const denominator = virtualTokenReserves.add(tokenAmount);
  if (denominator.eq(new BN(0))) {
    throw new Error('Denominator cannot be zero in SOL out calculation');
  }
  return numerator.div(denominator);
}

export async function startVolumeMaker() {
// Configuration constants
  const MIN_SOL_BUY = 0.01; // Minimum SOL to buy
  const MAX_SOL_BUY = 0.03; // Maximum SOL to buy
  const INTERVAL_SECONDS = 15; // Wait time between cycles
  const JITO_TIP_LAMPORTS = 0.001 * LAMPORTS_PER_SOL; // Jito tip amount
  const MAX_ITERATIONS = 10; // Total number of iterations (configurable)

  // Load keyInfo
  let keyInfo: { [key: string]: any } = {};
  if (fs.existsSync(keyInfoPath)) {
    const existingData = fs.readFileSync(keyInfoPath, 'utf-8');
    keyInfo = JSON.parse(existingData);
  }

  const mintPK = keyInfo.mint;
  const mint = new PublicKey(mintPK);
  console.log(`🚀 Mint: ${mint.toString()}`);

  // Fetch bonding curve state on-chain
  const bondingCurveState = await getPumpFunBondingCurveState(mint);
  if (!bondingCurveState) {
    console.log('Failed to fetch Pump.fun bonding curve state. Exiting...');
    return;
  }

  // Check if the bonding curve is complete
  if (bondingCurveState.complete === 1) {
    console.log('Bonding curve is complete. Token is no longer on Pump.fun. Exiting...');
    return;
  }

  // Derive bonding curve addresses
  const bondingCurve = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM
  )[0];
  const associatedBondingCurve = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID
  );

  // Initialize Pump.fun program for buy/sell instructions
  const provider = new AnchorProvider(connection, payer as any, { commitment: 'confirmed' });
  setProvider(provider);
  const program = new Program(JSON.parse(fs.readFileSync('./pumpfun-IDL.json', 'utf-8')) as Idl, provider);

  // Load or initialize volume data
  let volumeData: VolumeData = {};
  if (fs.existsSync(volumeFilePath)) {
    const existingData = fs.readFileSync(volumeFilePath, 'utf-8');
    volumeData = JSON.parse(existingData);
  }

  let iteration = Object.keys(volumeData).length + 1;

  // Run for MAX_ITERATIONS or until iteration count is reached
  for (let currentIteration = 0; currentIteration < MAX_ITERATIONS; currentIteration++) {
    try {
      const bundledTxns: VersionedTransaction[] = [];
      const latestBlockhash = await connection.getLatestBlockhash();

      // 1. Create new wallets
      const buyerKp = Keypair.generate();
      const sellerKp1 = Keypair.generate();
      const sellerKp2 = Keypair.generate();

      // Save wallet keys to volume.json
      volumeData[iteration] = {
        buyer: bs58.encode(buyerKp.secretKey),
        seller1: bs58.encode(sellerKp1.secretKey),
        seller2: bs58.encode(sellerKp2.secretKey),
      };
      fs.writeFileSync(volumeFilePath, JSON.stringify(volumeData, null, 2));

      // 2. Fund buyer wallet with random SOL amount
      const solBuyAmount = MIN_SOL_BUY + Math.random() * (MAX_SOL_BUY - MIN_SOL_BUY);
      const solBuyLamports = Math.floor(solBuyAmount * LAMPORTS_PER_SOL);

      const fundBuyerIx = SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: buyerKp.publicKey,
        lamports: solBuyLamports + 1062304, // Include fee for tx
      });

      // 3. Create ATAs for all wallets
      const buyerAta = getAssociatedTokenAddressSync(mint, buyerKp.publicKey, false, TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID);
      const seller1Ata = getAssociatedTokenAddressSync(mint, sellerKp1.publicKey, false, TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID);
      const seller2Ata = getAssociatedTokenAddressSync(mint, sellerKp2.publicKey, false, TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID);

      const createBuyerAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        buyerAta,
        buyerKp.publicKey,
        mint,
        TOKEN_PROGRAM_ID,
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const createSeller1AtaIx = createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        seller1Ata,
        sellerKp1.publicKey,
        mint,
        TOKEN_PROGRAM_ID,
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const createSeller2AtaIx = createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        seller2Ata,
        sellerKp2.publicKey,
        mint,
        TOKEN_PROGRAM_ID,
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // 4. Pump.fun buy logic
      const solAmountBN = new BN(solBuyLamports);
      const amountOut = await estimatePumpFunTokensOut(bondingCurveState, solAmountBN);

      const [creatorVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('creator-vault'), payer.publicKey.toBytes()],
        PUMP_PROGRAM
      );

      const buyIx = await program.methods
        .buy(amountOut, solAmountBN)
        .accounts({
          feeRecipient,
          mint,
          bondingCurve,
          associatedBondingCurve,
          associatedUser: buyerAta,
          user: buyerKp.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          creatorVault,
          eventAuthority,
          program: PUMP_PROGRAM,
        })
        .instruction();

      // 5. Split tokens randomly between two seller wallets
      const fraction = 0.1 + Math.random() * 0.8; // 10-90% split
      const firstAmount = new BN(Math.floor(amountOut.toNumber() * fraction));
      const secondAmount = amountOut.sub(firstAmount);

      const transferToSeller1Ix = spl.createTransferInstruction(
        buyerAta,
        seller1Ata,
        buyerKp.publicKey,
        firstAmount.toNumber(),
        [],
        TOKEN_PROGRAM_ID
      );

      const transferToSeller2Ix = spl.createTransferInstruction(
        buyerAta,
        seller2Ata,
        buyerKp.publicKey,
        secondAmount.toNumber(),
        [],
        TOKEN_PROGRAM_ID
      );

      // 6. Pump.fun sell logic
      const sellIx1 = await program.methods
        .sell(firstAmount, new BN(0))
        .accounts({
          feeRecipient,
          mint,
          bondingCurve,
          associatedBondingCurve,
          associatedUser: seller1Ata,
          user: sellerKp1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          creatorVault,
          eventAuthority,
          program: PUMP_PROGRAM,
        })
        .instruction();

      const sellIx2 = await program.methods
        .sell(secondAmount, new BN(0))
        .accounts({
          feeRecipient,
          mint,
          bondingCurve,
          associatedBondingCurve,
          associatedUser: seller2Ata,
          user: sellerKp2.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          creatorVault,
          eventAuthority,
          program: PUMP_PROGRAM,
        })
        .instruction();

      // 7. Close ATAs and return SOL
      const closeBuyerAtaIx = createCloseAccountInstruction(
        buyerAta,
        payer.publicKey,
        buyerKp.publicKey,
        [],
        TOKEN_PROGRAM_ID
      );

      const closeSeller1AtaIx = createCloseAccountInstruction(
        seller1Ata,
        payer.publicKey,
        sellerKp1.publicKey,
        [],
        TOKEN_PROGRAM_ID
      );

      const closeSeller2AtaIx = createCloseAccountInstruction(
        seller2Ata,
        payer.publicKey,
        sellerKp2.publicKey,
        [],
        TOKEN_PROGRAM_ID
      );

      // 8. Return remaining SOL from all wallets
      const returnSolBuyerIx = SystemProgram.transfer({
        fromPubkey: buyerKp.publicKey,
        toPubkey: payer.publicKey,
        lamports: 0, // Will be updated after simulation
      });

      const returnSolSeller1Ix = SystemProgram.transfer({
        fromPubkey: sellerKp1.publicKey,
        toPubkey: payer.publicKey,
        lamports: 0, // Will be updated after simulation
      });

      const returnSolSeller2Ix = SystemProgram.transfer({
        fromPubkey: sellerKp2.publicKey,
        toPubkey: payer.publicKey,
        lamports: 0, // Will be updated after simulation
      });

      // 9. Jito tip
      const tipIx = SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: getRandomTipAccount(),
        lamports: JITO_TIP_LAMPORTS,
      });

      // Create transaction
      const instructions = [
        fundBuyerIx,
        createBuyerAtaIx,
        createSeller1AtaIx,
        createSeller2AtaIx,
        buyIx,
        transferToSeller1Ix,
        transferToSeller2Ix,
        sellIx1,
        sellIx2,
        closeBuyerAtaIx,
        closeSeller1AtaIx,
        closeSeller2AtaIx,
        returnSolBuyerIx,
        returnSolSeller1Ix,
        returnSolSeller2Ix,
        tipIx,
      ];

      const message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message();

      const tx = new VersionedTransaction(message);
      tx.sign([payer, buyerKp, sellerKp1, sellerKp2]);

      // Update SOL return amounts after simulation
      const simulation = await connection.simulateTransaction(tx, { commitment: 'processed' });
      if (simulation.value.err) {
        console.log('Simulation failed:', simulation.value.err);
        continue;
      }

      // Get final balances for all wallets
      const buyerBalance = await connection.getBalance(buyerKp.publicKey);
      const seller1Balance = await connection.getBalance(sellerKp1.publicKey);
      const seller2Balance = await connection.getBalance(sellerKp2.publicKey);

      // Update return SOL instructions
      const minRentExempt = await getMinimumBalanceForRentExemptAccount(connection);
      instructions[instructions.length - 4] = SystemProgram.transfer({
        fromPubkey: buyerKp.publicKey,
        toPubkey: payer.publicKey,
        lamports: buyerBalance > minRentExempt ? buyerBalance - 5000 : 0,
      });

      instructions[instructions.length - 3] = SystemProgram.transfer({
        fromPubkey: sellerKp1.publicKey,
        toPubkey: payer.publicKey,
        lamports: seller1Balance > minRentExempt ? seller1Balance - 5000 : 0,
      });

      instructions[instructions.length - 2] = SystemProgram.transfer({
        fromPubkey: sellerKp2.publicKey,
        toPubkey: payer.publicKey,
        lamports: seller2Balance > minRentExempt ? seller2Balance - 5000 : 0,
      });

      // Recreate transaction with updated instructions
      const finalMessage = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message();

      const finalTx = new VersionedTransaction(finalMessage);
      finalTx.sign([payer, buyerKp, sellerKp1, sellerKp2]);
      bundledTxns.push(finalTx);

      // Send bundle
      const bundleId = await searcherClient.sendBundle(new JitoBundle(bundledTxns, bundledTxns.length));
      console.log(`Volume maker bundle ${bundleId} sent for iteration ${iteration}`);

      // Increment iteration
      iteration++;

      // Wait for interval (skip for last iteration)
      if (currentIteration < MAX_ITERATIONS - 1) {
        console.log(`Waiting for ${INTERVAL_SECONDS} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, INTERVAL_SECONDS * 1000));
      }
    } catch (error) {
      console.error(`Error in volume maker cycle ${iteration}:`, error);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      iteration++;
    }
  }

  console.log(`Completed ${MAX_ITERATIONS} volume maker iterations`);
}


export async function sendBundle(bundledTxns: VersionedTransaction[], mintKp: Keypair) {
	
    // Simulate each transaction
/*    for (const tx of bundledTxns) {
        try {
            const simulationResult = await connection.simulateTransaction(tx, { commitment: "processed" });

            if (simulationResult.value.err) {
                console.error("Simulation error for transaction:", simulationResult.value.err);
                simulationResult.value.logs?.forEach(log => console.log(log));
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
		const bundleId = await searcherClient.sendBundle(new JitoBundle(bundledTxns, bundledTxns.length));
		console.log(`Bundle ${bundleId} sent.`);

		// Get bonding curve public key for market cap monitoring
		const [bondingCurve] = PublicKey.findProgramAddressSync(
		    [Buffer.from("bonding-curve"), mintKp.publicKey.toBytes()],
		    PUMP_PROGRAM
		);

		// Define the three tasks to run in parallel
		const devSalePromise = new Promise<void>((resolve, reject) => {
		    setTimeout(async () => {
			try {
			    console.log("\nExecuting dev wallet sale...");
			    await sellDevWalletPF();
			    console.log("\nDev wallet tokens sold successfully.");
			    await sendTelegramMsg(`✅ Dev wallet tokens sold for mint: ${mintKp.publicKey.toString()}`);
			    resolve();
			} catch (error: any) {
			    console.error("\nError during dev wallet sale:", error.message, error.stack);
			    await sendTelegramMsg(
				`❌ Failed to sell dev wallet tokens for mint: ${mintKp.publicKey.toString()}\nError: ${error.message}`
			    );
			    reject(error);
			}
		    }, devWalletSellDelay * 1000); // Convert seconds to milliseconds
		});

		const telegramPromise = async () => {
		    const tokenInfo = await getTokenMetadata(mintKp.publicKey.toString());
		    if (tokenInfo) {
			await sendTelegramMsg(
			    `🎉 New Pump.fun Token Mint is LIVE on Solana Chain!\n 🚀 <b>Mint:</b> ${mintKp.publicKey.toString()}\n🔖 <b>Symbol:</b> ${tokenInfo.symbol}\n📛 <b>Name:</b> ${tokenInfo.name}\n🪙 <b>Description:</b> ${tokenInfo.description}\n\nCheck it out:\n` +
			    `🌐 <a href="https://axiom.trade/t/${mintKp.publicKey.toString()}">Axiom Trade</a>\n` +
			    `📊 <a href="https://gmgn.ai/sol/token/${mintKp.publicKey.toString()}">GMGN</a>\n` +
			    `🔍 <a href="https://dexscreener.com/solana/${mintKp.publicKey.toString()}">Dexscreener</a>`
			);
		    } else {
			await sendTelegramMsg(
			    `🎉 New Pump.fun Token Mint is LIVE on Solana Chain! 🚀\nMint: ${mintKp.publicKey.toString()}\n\nCheck it out:\n` +
			    `🌐 <a href="https://axiom.trade/t/${mintKp.publicKey.toString()}">Axiom Trade</a>\n` +
			    `📊 <a href="https://gmgn.ai/sol/token/${mintKp.publicKey.toString()}">GMGN</a>\n` +
			    `🔍 <a href="https://dexscreener.com/solana/${mintKp.publicKey.toString()}">Dexscreener</a>`
			);
		    }
		};

		const monitorMarketCapPromise = async () => {
		    return new Promise<void>(async(resolve) => {
			console.log("Starting market cap monitoring...");
			// Get initial market cap
			let previousMc = await getMC(connection, bondingCurve);
			console.log(`Initial Market Cap (SOL): ${previousMc.toFixed(4)}`);

			// Continuously update current market cap
			const monitor = setInterval(async () => {
			    const currentMc = await getMC(connection, bondingCurve);
			    const percentChange = ((currentMc - previousMc) / previousMc) * 100;
			    console.log(
				`Current Market Cap (SOL): ${currentMc.toFixed(4)} | Change: ${percentChange.toFixed(2)}%`
			    );
			    previousMc = currentMc;
			}, 500);

			// Stop monitoring after 60 seconds
			setTimeout(() => {
			    clearInterval(monitor);
			    console.log("Market cap monitoring stopped after 60 seconds.");
			    resolve(); // Resolve the promise
			}, 40_000);
		    });
		};

		// Run all tasks in parallel
		await Promise.allSettled([
		    devSalePromise,
		    telegramPromise(),
		    monitorMarketCapPromise()
		]).then((results) => {
		    results.forEach((result, index) => {
			if (result.status === 'rejected') {
			    console.error(`Task ${index + 1} failed: ${result.reason}`);
			}
		    });
		});

		// Assuming onBundleResult returns a Promise<BundleResult>
	/*	const result = await new Promise((resolve, reject) => {
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
        */
		//console.log("Result:", result);
		
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
