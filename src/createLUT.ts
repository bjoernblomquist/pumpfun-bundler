import { AddressLookupTableProgram, Transaction,sendAndConfirmTransaction, Keypair,ComputeBudgetProgram, PublicKey, VersionedTransaction, TransactionMessage, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL, Blockhash, AddressLookupTableAccount, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { connection, PUMP_PROGRAM, payer } from '../config';
import promptSync from 'prompt-sync';
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import { getRandomTipAccount } from "./clients/config";
import { lookupTableProvider } from "./clients/LookupTableProvider";
import { loadKeypairs } from './createKeys';
import * as spl from '@solana/spl-token';
import idl from "../pumpfun-IDL.json";
import { Program, Idl, AnchorProvider, setProvider } from "@coral-xyz/anchor";
import bs58 from "bs58";
import {sendTelegramMsg} from "./telegram"
import * as readline from "readline";
import {loadDevKeypair} from "./createKeys";

const prompt = promptSync();
const keyInfoPath = path.join(__dirname, 'keyInfo.json');
const wallet = loadDevKeypair();

const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });

setProvider(provider);

// Initialize pumpfun anchor
const IDL_PumpFun = JSON.parse(fs.readFileSync("./pumpfun-IDL.json", "utf-8")) as Idl;

const program = new Program(IDL_PumpFun, provider);

export async function closeLUTS() {
        // Assuming you have the LUT address stored in poolInfo
        let poolInfo: { [key: string]: any } = {};
        if (fs.existsSync(keyInfoPath)) {
           const data = fs.readFileSync(keyInfoPath, 'utf-8');
           poolInfo = JSON.parse(data);
        }
  if (!poolInfo.addressLUT) {
      console.error("LUT address not found in poolInfo");
    return false;
  }

  const lookupTableAddress = new PublicKey(poolInfo.addressLUT.toString());
  console.log("Lookup Table Address:", lookupTableAddress.toBase58());

  // Check LUT state
  const lutAccount = await connection.getAddressLookupTable(lookupTableAddress);
  if (!lutAccount.value) {
      console.error("LUT does not exist");
    return false;
  }

if (lutAccount.value.state.deactivationSlot === 0xffffffffffffffffn) {
      const cooldownTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 15_000_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
        AddressLookupTableProgram.deactivateLookupTable({
          lookupTable: lookupTableAddress,
          authority: payer.publicKey,
        })
      );
    // Send cooldownTx without confirmation
    const coolDownSig = await connection.sendTransaction(cooldownTx, [payer], {
      skipPreflight: true,
    });

        console.log("Cool Down Sig (sent, not confirmed):", coolDownSig);
        console.log("Waiting for cooldown period...");

        // Timer für die Cooldown-Periode (200 Sekunden)
        const cooldownDuration = 200000; // 200 Sekunden in Millisekunden
        const startTime = Date.now();
        const updateLine = (elapsedSeconds: number, remainingSeconds: number) => {
            readline.cursorTo(process.stdout, 0); // Cursor an den Zeilenanfang setzen
            process.stdout.write(`Elapsed: ${elapsedSeconds} seconds, Remaining: ${remainingSeconds} seconds`);
            readline.clearLine(process.stdout, 1); // Rest der Zeile löschen
        };

        const interval = setInterval(() => {
            const elapsedTime = Date.now() - startTime;
            const elapsedSeconds = Math.floor(elapsedTime / 1000);
            const remainingSeconds = Math.floor((cooldownDuration - elapsedTime) / 1000);
            if (elapsedTime < cooldownDuration) {
               updateLine(elapsedSeconds, remainingSeconds);
	    }
        }, 1000); // Alle Sekunde aktualisieren

        // Warte auf die Cooldown-Periode
        await new Promise((resolve) => setTimeout(resolve, cooldownDuration));
        clearInterval(interval); // Timer stoppen

       // Letzte Zeile abschließen und neue Zeile für die nächste Ausgabe
        const finalElapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`Cooldown period ended, elapsed time: ${finalElapsedSeconds} seconds\n`);
        readline.clearLine(process.stdout, 1);

        // Nach der Cooldown-Periode closeLUTS erneut aufrufen
        console.log("Attempting to close LUT again...");
        return await closeLUTS(); // Rekursiver Aufruf

  } else {
    console.log("LUT is already deactivated at slot:", lutAccount.value.state.deactivationSlot.toString());
  }

      // Verify LUT state before closing
    const currentSlot = await connection.getSlot();
    if (currentSlot <= lutAccount.value.state.deactivationSlot) {
        console.log(`LUT not yet closable. Current slot: ${currentSlot}, Deactivation slot: ${lutAccount.value.state.deactivationSlot}`);
        return false;
    }
  // Fetch a fresh recentBlockhash for the close transaction
  const { blockhash } = await connection.getLatestBlockhash();
  
    // Proceed to close the LUT
  const closeTx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: payer.publicKey,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 15_000_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    AddressLookupTableProgram.closeLookupTable({
      lookupTable: lookupTableAddress,
      authority: payer.publicKey,
      recipient: payer.publicKey,
    })
  );

  const closeSig = await connection.sendTransaction(closeTx, [payer]);
  console.log("Close LUT Sig:", closeSig);

}

function promptNew(question: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

export async function extendLUT() {
    // -------- step 1: ask nessesary questions for LUT build --------
    let vanityPK = null;

    const vanityPrompt = prompt('Do you want to import a custom vanity address? (y/n): ').toLowerCase();
    // const jitoTipAmt = +prompt('Jito tip in Sol (Ex. 0.01): ') * LAMPORTS_PER_SOL;
    const jitoTipAmt = 0.001 * LAMPORTS_PER_SOL; // Jito tip amount

    if (vanityPrompt === 'y') {
        vanityPK = await promptNew(`Enter the private key of the vanity address (bs58): `);
    }

    // Read existing data from poolInfo.json
    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(keyInfoPath)) {
        const data = fs.readFileSync(keyInfoPath, 'utf-8');
        poolInfo = JSON.parse(data);
    }

    const bundledTxns1: VersionedTransaction[] = [];
    


    // -------- step 2: get all LUT addresses --------
    const accounts: PublicKey[] = []; // Array with all new keys to push to the new LUT
    const lut = new PublicKey(poolInfo.addressLUT.toString());

    const lookupTableAccount = (
        await connection.getAddressLookupTable(lut)
    ).value;

    if (lookupTableAccount == null) {
        console.log("Lookup table account not found!");
        process.exit(0);
    }

    // Write mint info to json
    let mintKp;

    if (vanityPK === null) {
        mintKp = Keypair.generate();
    } else {
        mintKp = Keypair.fromSecretKey(bs58.decode(vanityPK));
    }

    console.log(`Mint: ${mintKp.publicKey.toString()}`);
    await sendTelegramMsg(`✅ New Pump.fun Token Mint for Snipe (will launch soon): ${mintKp.publicKey.toString()}`);
    
    poolInfo.mint = mintKp.publicKey.toString();
    poolInfo.mintPk = bs58.encode(mintKp.secretKey);
    fs.writeFileSync(keyInfoPath, JSON.stringify(poolInfo, null, 2));  

    // Fetch accounts for LUT
    const mintAuthority = new PublicKey(
        "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
    );
    const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
        "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    );
    const global = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
    const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintKp.publicKey.toBytes()],
        program.programId,
    );
    const [metadata] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("metadata"),
          MPL_TOKEN_METADATA_PROGRAM_ID.toBytes(),
          mintKp.publicKey.toBytes(),
        ],
        MPL_TOKEN_METADATA_PROGRAM_ID,
    );
      let [associatedBondingCurve] = PublicKey.findProgramAddressSync(
        [
          bondingCurve.toBytes(),
          spl.TOKEN_PROGRAM_ID.toBytes(),
          mintKp.publicKey.toBytes(),
        ],
        spl.ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const eventAuthority = new PublicKey(
        "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
      );
      const feeRecipient = new PublicKey(
        "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
      );


    // These values vary based on the new market created
    accounts.push(
        spl.ASSOCIATED_TOKEN_PROGRAM_ID,
        spl.TOKEN_PROGRAM_ID,
        MPL_TOKEN_METADATA_PROGRAM_ID,
        mintAuthority,
        global,
        program.programId,
        PUMP_PROGRAM,
        metadata,
        associatedBondingCurve,
        bondingCurve,
        eventAuthority,
        SystemProgram.programId,
        SYSVAR_RENT_PUBKEY,
        mintKp.publicKey,
        feeRecipient,
    );   // DO NOT ADD PROGRAM OR JITO TIP ACCOUNT??

    // Loop through each keypair and push its pubkey and ATAs to the accounts array
    const keypairs = loadKeypairs();
    for (const keypair of keypairs) {
        const ataToken = await spl.getAssociatedTokenAddress(
            mintKp.publicKey,
            keypair.publicKey,
        );
        accounts.push(keypair.publicKey, ataToken);
    }
          if (!wallet) {
            console.error('Dev wallet is required to proceed.');
            return;
          }

    // Push wallet and payer ATAs and pubkey JUST IN CASE (not sure tbh)
    const ataTokenwall = await spl.getAssociatedTokenAddress(
        mintKp.publicKey,
        wallet.publicKey,
    );

    const ataTokenpayer = await spl.getAssociatedTokenAddress(
        mintKp.publicKey,
        payer.publicKey,
    );

    // Add just in case
    accounts.push(
        wallet.publicKey,
        payer.publicKey,
        ataTokenwall,
        ataTokenpayer,
        lut, 
        spl.NATIVE_MINT, 
    );



    
    // -------- step 5: push LUT addresses to a txn --------
    const extendLUTixs1: TransactionInstruction[] = [];
    const extendLUTixs2: TransactionInstruction[] = [];
    const extendLUTixs3: TransactionInstruction[] = [];
    const extendLUTixs4: TransactionInstruction[] = [];

    // Chunk accounts array into groups of 30
    const accountChunks = Array.from({ length: Math.ceil(accounts.length / 30) }, (v, i) => accounts.slice(i * 30, (i + 1) * 30));
    console.log("Num of chunks:", accountChunks.length);
    console.log("Num of accounts:", accounts.length);

    for (let i = 0; i < accountChunks.length; i++) {
        const chunk = accountChunks[i];
        const extendInstruction = AddressLookupTableProgram.extendLookupTable({
            lookupTable: lut,
            authority: payer.publicKey,
            payer: payer.publicKey,
            addresses: chunk,
        });
        if (i == 0) {
            extendLUTixs1.push(extendInstruction);
            console.log("Chunk:", i);
        } else if (i == 1) {
            extendLUTixs2.push(extendInstruction);
            console.log("Chunk:", i);
        } else if (i == 2) {
            extendLUTixs3.push(extendInstruction);
            console.log("Chunk:", i);
        } else if (i == 3) {
            extendLUTixs4.push(extendInstruction);
            console.log("Chunk:", i);
        }
    }
    
    // Add the jito tip to the last txn
    extendLUTixs3.push( //4
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: getRandomTipAccount(),
            lamports: BigInt(jitoTipAmt),
        })
    );




    // -------- step 6: seperate into 2 different bundles to complete all txns --------
    const { blockhash: block1 } = await connection.getLatestBlockhash();

    const extend1 = await buildTxn(extendLUTixs1, block1, lookupTableAccount);
    const extend2 = await buildTxn(extendLUTixs2, block1, lookupTableAccount);
    const extend3 = await buildTxn(extendLUTixs3, block1, lookupTableAccount);
  //  const extend4 = await buildTxn(extendLUTixs4, block1, lookupTableAccount);

    bundledTxns1.push(
        extend1,
        extend2,
        extend3,
    //    extend4,
    );
    


    // -------- step 7: send bundle --------
    await sendBundle(bundledTxns1);
    
}

export async function createLUT() {

    // -------- step 1: ask nessesary questions for LUT build --------
    const jitoTipAmt = 0.001 * LAMPORTS_PER_SOL; // Jito tip amount
    //const jitoTipAmt = +prompt('Jito tip in Sol (Ex. 0.01): ') * LAMPORTS_PER_SOL;

    // Read existing data from poolInfo.json
    let poolInfo: { [key: string]: any } = {};
    if (fs.existsSync(keyInfoPath)) {
        const data = fs.readFileSync(keyInfoPath, 'utf-8');
        poolInfo = JSON.parse(data);
    }

    const bundledTxns: VersionedTransaction[] = [];



    // -------- step 2: create a new LUT every time there is a new launch --------
    const createLUTixs: TransactionInstruction[] = [];

    const [ create, lut ] = AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: await connection.getSlot("finalized")
    });

    createLUTixs.push(
        create,
        SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: getRandomTipAccount(),
            lamports: jitoTipAmt,
        }),
    );

    const addressesMain: PublicKey[] = [];
    createLUTixs.forEach((ixn) => {
        ixn.keys.forEach((key) => {
            addressesMain.push(key.pubkey);
        });
    });

    const lookupTablesMain1 =
        lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain);

    const { blockhash } = await connection.getLatestBlockhash();

    const messageMain1 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: createLUTixs,
    }).compileToV0Message(lookupTablesMain1);
    const createLUT = new VersionedTransaction(messageMain1);

    // Append new LUT info
    poolInfo.addressLUT = lut.toString(); // Using 'addressLUT' as the field name

    try {
        const serializedMsg = createLUT.serialize();
        console.log('Txn size:', serializedMsg.length);
        if (serializedMsg.length > 1232) {
            console.log('tx too big');
        }
        createLUT.sign([payer]);
    } catch (e) {
        console.log(e, 'error signing createLUT');
        process.exit(0);
    }

    // Write updated content back to poolInfo.json
    fs.writeFileSync(keyInfoPath, JSON.stringify(poolInfo, null, 2));

    // Push to bundle
    bundledTxns.push(createLUT);


    // -------- step 3: SEND BUNDLE --------
    await sendBundle(bundledTxns);
}


async function buildTxn(extendLUTixs: TransactionInstruction[], blockhash: string | Blockhash, lut: AddressLookupTableAccount): Promise<VersionedTransaction> {
    const messageMain = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: extendLUTixs,
        }).compileToV0Message([lut]);
        const txn = new VersionedTransaction(messageMain);
    
        try {
            const serializedMsg = txn.serialize();
            console.log('Txn size:', serializedMsg.length);
            if (serializedMsg.length > 1232) {
                console.log('tx too big');
            }
            txn.sign([payer]);
        } catch (e) {
            const serializedMsg = txn.serialize();
            console.log('txn size:', serializedMsg.length);
            console.log(e, 'error signing extendLUT');
            process.exit(0);
        }
        return txn;
}



async function sendBundle(bundledTxns: VersionedTransaction[]) {
    try {
        const bundleId = await searcherClient.sendBundle(new JitoBundle(bundledTxns, bundledTxns.length));
        console.log(`Bundle ${bundleId} sent.`);
    } catch (error) {
        const err = error as any;
        console.error("Error sending bundle:", err.message);
    
        if (err?.message?.includes('Bundle Dropped, no connected leader up soon')) {
            console.error("Error sending bundle: Bundle Dropped, no connected leader up soon.");
        } else {
            console.error("An unexpected error occurred:", err.message);
        }
    }
}


/*
async function createAndSignVersionedTxNOLUT(
    instructionsChunk: TransactionInstruction[], 
    blockhash: Blockhash | string,
): Promise<VersionedTransaction> {
    const addressesMain: PublicKey[] = [];
    instructionsChunk.forEach((ixn) => {
        ixn.keys.forEach((key) => {
            addressesMain.push(key.pubkey);
        });
    });

    const lookupTablesMain1 =
        lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain);

    const message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: instructionsChunk,
    }).compileToV0Message(lookupTablesMain1);

    const versionedTx = new VersionedTransaction(message);
    const serializedMsg = versionedTx.serialize();

    console.log("Txn size:", serializedMsg.length);
    if (serializedMsg.length > 1232) { console.log('tx too big'); }
    versionedTx.sign([wallet]);

    
    // Simulate each txn
    const simulationResult = await connection.simulateTransaction(versionedTx, { commitment: "processed" });

    if (simulationResult.value.err) {
    console.log("Simulation error:", simulationResult.value.err);
    } else {
    console.log("Simulation success. Logs:");
    simulationResult.value.logs?.forEach(log => console.log(log));
    }
    

    return versionedTx;
}
*/
