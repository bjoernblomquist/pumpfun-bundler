import { connection, rpc, NUM_OF_WALLETS, global, feeRecipient, PUMP_PROGRAM, payer } from "../config";
import { PublicKey, VersionedTransaction, SYSVAR_RENT_PUBKEY, TransactionMessage, SystemProgram, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { loadKeypairs } from "./createKeys";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import promptSync from "prompt-sync";
import * as spl from "@solana/spl-token";
import bs58 from "bs58";
import path from "path";
import fs from "fs";
import { randomInt } from "crypto";
import { getRandomTipAccount } from "./clients/config";
import BN from "bn.js";
import { Program, Idl, AnchorProvider, setProvider } from "@coral-xyz/anchor";
import {loadDevKeypair} from "./createKeys";

const prompt = promptSync();
const keyInfoPath = path.join(__dirname, "keyInfo.json");

function chunkArray<T>(array: T[], size: number): T[][] {
	return Array.from({ length: Math.ceil(array.length / size) }, (v, i) => array.slice(i * size, i * size + size));
}

async function sendBundle(bundledTxns: VersionedTransaction[]) {
	/*
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
    */

	try {
		const bundleId = await searcherClient.sendBundle(new JitoBundle(bundledTxns, bundledTxns.length));
		console.log(`Bundle ${bundleId} sent.`);

		/*
        // Assuming onBundleResult returns a Promise<BundleResult>
        const result = await new Promise((resolve, reject) => {
            searcherClient.onBundleResult(
            (result) => {
                console.log('Received bundle result:', result);
                resolve(result); // Resolve the promise with the result
            },
            (e: Error) => {
                console.error('Error receiving bundle result:', e);
                reject(e); // Reject the promise if there's an error
            }
            );
        });
    
        console.log('Result:', result);
        */
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

export async function sellBundleWalletsPF() {
	  const wallet = loadDevKeypair();
          if (!wallet) {
            console.error('Dev wallet is required to proceed.');
            return;
          }

    const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
    setProvider(provider);

    const IDL_PumpFun = JSON.parse(fs.readFileSync("./pumpfun-IDL.json", "utf-8")) as Idl;
    const pfprogram = new Program(IDL_PumpFun, provider);

    const bundledTxns = [];
    const keypairs = loadKeypairs();

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

    const mintKp = Keypair.fromSecretKey(Uint8Array.from(bs58.decode(poolInfo.mintPk)));
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKp.publicKey.toBytes()], pfprogram.programId);
    let [associatedBondingCurve] = PublicKey.findProgramAddressSync(
        [bondingCurve.toBytes(), spl.TOKEN_PROGRAM_ID.toBytes(), mintKp.publicKey.toBytes()],
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const supplyPercent = +prompt("Percentage to sell (Ex. 1 for 1%): ") / 100;
    const jitoTipAmt = +prompt("Jito tip in Sol (Ex. 0.01): ") * LAMPORTS_PER_SOL;

    const PayerTokenATA = await spl.getAssociatedTokenAddress(new PublicKey(poolInfo.mint), payer.publicKey);
    const { blockhash } = await connection.getLatestBlockhash();

    let sellTotalAmount = 0;
    const chunkedKeypairs = chunkArray(keypairs, 6);

    for (let chunkIndex = 0; chunkIndex < chunkedKeypairs.length; chunkIndex++) {
        const chunk = chunkedKeypairs[chunkIndex];
        const instructionsForChunk = [];

        for (let keypair of chunk) {
            const transferAmount = await getSellBalance(keypair, new PublicKey(poolInfo.mint), supplyPercent);
            sellTotalAmount += transferAmount;
            console.log(`Sending ${transferAmount / 1e6} from ${keypair.publicKey.toString()}.`);

            const TokenATA = await spl.getAssociatedTokenAddress(new PublicKey(poolInfo.mint), keypair.publicKey);
            const transferIx = spl.createTransferInstruction(TokenATA, PayerTokenATA, keypair.publicKey, transferAmount);
            instructionsForChunk.push(transferIx);
        }

        if (instructionsForChunk.length > 0) {
            const message = new TransactionMessage({
                payerKey: payer.publicKey,
                recentBlockhash: blockhash,
                instructions: instructionsForChunk,
            }).compileToV0Message([lookupTableAccount]);

            const versionedTx = new VersionedTransaction(message);

            const serializedMsg = versionedTx.serialize();
            console.log("Txn size:", serializedMsg.length);
            if (serializedMsg.length > 1232) {
                console.log("tx too big");
            }

            versionedTx.sign([payer]);
            for (let keypair of chunk) {
                versionedTx.sign([keypair]);
            }

            bundledTxns.push(versionedTx);
        }
    }

    const payerNum = randomInt(0, NUM_OF_WALLETS);
    const payerKey = keypairs[payerNum];
    const sellPayerIxs = [];

    console.log(`TOTAL: Selling ${sellTotalAmount / 1e6}.`);

    const sellIx = await pfprogram.methods
        .sell(new BN(sellTotalAmount), new BN(0))
        .accounts({
            global,
            feeRecipient,
            mint: new PublicKey(poolInfo.mint),
            bondingCurve,
            associatedBondingCurve,
            associatedUser: PayerTokenATA,
            user: payer.publicKey,
            systemProgram: SystemProgram.programId,
            associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: spl.TOKEN_PROGRAM_ID,
            event_authority: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"),
            program: PUMP_PROGRAM,
        })
        .instruction();

    sellPayerIxs.push(
        sellIx,
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: getRandomTipAccount(),
            lamports: BigInt(jitoTipAmt),
        })
    );

    const sellMessage = new TransactionMessage({
        payerKey: payerKey.publicKey,
        recentBlockhash: blockhash,
        instructions: sellPayerIxs,
    }).compileToV0Message([lookupTableAccount]);

    const sellTx = new VersionedTransaction(sellMessage);

    const serializedMsg = sellTx.serialize();
    console.log("Txn size:", serializedMsg.length);
    if (serializedMsg.length > 1232) {
        console.log("tx too big");
    }

    sellTx.sign([payer, payerKey]);
    bundledTxns.push(sellTx);

    await sendBundle(bundledTxns);
}

export async function sellDevWalletPF() {
	  const wallet = loadDevKeypair();
          if (!wallet) {
            console.error('Dev wallet is required to proceed.');
            return;
          }

    const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
    setProvider(provider);

    const IDL_PumpFun = JSON.parse(fs.readFileSync("./pumpfun-IDL.json", "utf-8")) as Idl;
    const pfprogram = new Program(IDL_PumpFun, provider);

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

    const mintKp = Keypair.fromSecretKey(Uint8Array.from(bs58.decode(poolInfo.mintPk)));
    const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mintKp.publicKey.toBytes()], pfprogram.programId);
    let [associatedBondingCurve] = PublicKey.findProgramAddressSync(
        [bondingCurve.toBytes(), spl.TOKEN_PROGRAM_ID.toBytes(), mintKp.publicKey.toBytes()],
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const jitoTipAmt = 0.001 * LAMPORTS_PER_SOL; // Fixed Jito tip of 0.001 SOL
    const PayerTokenATA = await spl.getAssociatedTokenAddress(new PublicKey(poolInfo.mint), wallet.publicKey); // Use dev wallet for ATA
    const { blockhash } = await connection.getLatestBlockhash();

    const bundledTxns = [];

    // Get dev wallet balance (100%)
    const transferAmount = await getSellBalance(wallet, new PublicKey(poolInfo.mint), 1); // 100% = 1
    console.log(`Selling ${transferAmount / 1e6} from dev wallet.`);

    const instructions = [];
    const ataIx = spl.createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, // Dev wallet as owner
        PayerTokenATA,
        wallet.publicKey,
        new PublicKey(poolInfo.mint),
        spl.TOKEN_PROGRAM_ID,
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const TokenATA = await spl.getAssociatedTokenAddress(new PublicKey(poolInfo.mint), wallet.publicKey);
    const transferIx = spl.createTransferInstruction(TokenATA, PayerTokenATA, wallet.publicKey, transferAmount);
    instructions.push(ataIx, transferIx);

    // Create sell instruction
    const sellIx = await pfprogram.methods
        .sell(new BN(transferAmount), new BN(0))
        .accounts({
            global,
            feeRecipient,
            mint: new PublicKey(poolInfo.mint),
            bondingCurve,
            associatedBondingCurve,
            associatedUser: PayerTokenATA,
            user: wallet.publicKey, // Dev wallet receives SOL proceeds
            systemProgram: SystemProgram.programId,
            associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
            tokenProgram: spl.TOKEN_PROGRAM_ID,
            event_authority: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"),
            program: PUMP_PROGRAM,
        })
        .instruction();

    instructions.push(
        sellIx,
        SystemProgram.transfer({
            fromPubkey: wallet.publicKey, // Dev wallet pays Jito tip
            toPubkey: getRandomTipAccount(),
            lamports: BigInt(jitoTipAmt),
        })
    );

    const message = new TransactionMessage({
        payerKey: wallet.publicKey, // Dev wallet as payer
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message([lookupTableAccount]);

    const versionedTx = new VersionedTransaction(message);

    const serializedMsg = versionedTx.serialize();
    console.log("Txn size:", serializedMsg.length);
    if (serializedMsg.length > 1232) {
        console.log("tx too big");
    }

    versionedTx.sign([wallet]); // Sign only with dev wallet
    bundledTxns.push(versionedTx);

    await sendBundle(bundledTxns);
}

async function getSellBalance(keypair: Keypair, mint: PublicKey, supplyPercent: number) {
	let amount;
	try {
		const tokenAccountPubKey = spl.getAssociatedTokenAddressSync(mint, keypair.publicKey);
		const balance = await connection.getTokenAccountBalance(tokenAccountPubKey);
		amount = Math.floor(Number(balance.value.amount) * supplyPercent);
	} catch (e) {
		amount = 0;
	}

	return amount;
}
