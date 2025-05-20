import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import promptSync from 'prompt-sync';
import path from 'path';
import bs58 from 'bs58';
import {NUM_OF_WALLETS, payer} from "../config";
const configFilePath = path.join(__dirname, '../config.ts');

const prompt = promptSync();

const keyInfoPath = path.join(__dirname, 'keyInfo.json');

interface KeyObject {
  publicKey: string;
  privateKey: string;
}

// Funktion zum Generieren eines Keypairs
function generateKeys(): KeyObject {
  // Generiere einen neuen Keypair
  const keypair: Keypair = Keypair.generate();
  const publicKey: string = keypair.publicKey.toBase58();
  const privateKey: string = bs58.encode(keypair.secretKey);

  const now: Date = new Date();
  const timestamp: number = now.getTime();
  const dateString: string = now.toISOString();

  return {
    publicKey,
    privateKey,
  };
}

interface IPoolInfo {
  [key: string]: any;
  numOfWallets?: number;
  devWallet?: {
    publicKey: string;
    privateKey: string;
  };
  [key: `wallet${number}`]: {
    publicKey: string;
    privateKey: string;
  };
}

function generateWallets(numOfWallets: number): Keypair[] {
  let wallets: Keypair[] = [];
  for (let i = 0; i < numOfWallets; i++) {
    const walletw = Keypair.generate();
    wallets.push(walletw);
  }
  return wallets;
}

function updatePoolInfo(wallets: Keypair[]) {
  let poolInfo: IPoolInfo = {};

  // Check if keyInfo.json exists and read its content
  if (fs.existsSync(keyInfoPath)) {
    const data = fs.readFileSync(keyInfoPath, 'utf8');
    poolInfo = JSON.parse(data);
  }

  // Update wallet-related information
  poolInfo.numOfWallets = wallets.length;
  wallets.forEach((walletw, index) => {
    const walletIndex = index + 1;
    poolInfo[`wallet${walletIndex}`] = {
      publicKey: walletw.publicKey.toString(),
      privateKey: bs58.encode(walletw.secretKey),
    };
  });

  // Write updated data back to keyInfo.json
  fs.writeFileSync(keyInfoPath, JSON.stringify(poolInfo, null, 2));
}

export async function createKeypairs() {
  console.log('WARNING: If you create new ones, ensure you don\'t have SOL in old ones OR ELSE IT WILL BE GONE.');
    const overwrite = prompt('Do you want to overwrite the existing Bundle Wallets? (y/n): ').toLowerCase();
    if (overwrite !== 'y') {
      console.log('Bundle Wallets creation aborted. Existing Bundle Wallet preserved.\n');
      return;
    }
  let wallets: Keypair[] = [];

    const numOfWallets = NUM_OF_WALLETS;
    if (isNaN(numOfWallets) || numOfWallets <= 0) {
      console.log('Invalid number. Please enter a positive integer.');
      return;
    }

    wallets = generateWallets(numOfWallets);
    console.log('\nWallet Information:\n');

    wallets.forEach((walletw, index) => {
      console.log(`Bundle Wallet ${index + 1} Public Key: ${walletw.publicKey.toString()}`);
      console.log(`Bundle Wallet ${index + 1} Private Key: ${bs58.encode(walletw.secretKey)}\n`);
    });

    updatePoolInfo(wallets); // Store both public and private keys in keyInfo.json
}

function readKeypairs(): Keypair[] {
  if (!fs.existsSync(keyInfoPath)) {
    console.log('keyInfo.json does not exist. No wallets found.');
    return [];
  }

  const poolInfo = JSON.parse(fs.readFileSync(keyInfoPath, 'utf8')) as IPoolInfo;
  const wallets: Keypair[] = [];

  // Iterate through wallet entries in poolInfo
  for (let i = 1; i <= (poolInfo.numOfWallets || 0); i++) {
    const walletInfo = poolInfo[`wallet${i}`];
    if (walletInfo && walletInfo.privateKey) {
      const secretKey = bs58.decode(walletInfo.privateKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      wallets.push(keypair);
    }
  }

  return wallets;
}

export async function showKeypairs() {
  let wallets: Keypair[] = readKeypairs();
  console.log('\nWallet Information:\n');
  wallets.forEach((walletw, index) => {
    console.log(`Bundle Wallet ${index + 1} Public Key: ${walletw.publicKey.toString()}`);
    console.log(`Bundle Wallet ${index + 1} Private Key: ${bs58.encode(walletw.secretKey)}\n`);
  });

  const devWallet = loadDevKeypair();
  if (devWallet) {
    console.log(`Dev Wallet Public Key: ${devWallet.publicKey.toString()}`);
    console.log(`Dev Wallet Private Key: ${bs58.encode(devWallet.secretKey)}\n`);
  } else {
    console.log('No Dev Wallet found in keyInfo.json.\n');
  }

  console.log(`Payer Wallet (SOL from here will be distributed to Dev and Bundle Wallets): ${payer.publicKey.toString()}\n`);
}

function printDevWalletKeys(keyObject: KeyObject): void {
  console.log(`Dev Wallet Public Key: ${keyObject.publicKey}`);
  console.log(`Dev Wallet Private Key: ${keyObject.privateKey}`);
}

export async function createDevKeys() {
  console.log('\nNew Dev Keys will be generated:\n');
  const newKey = generateKeys();

  // Save to keyInfo.json
  let poolInfo: IPoolInfo = {};
  if (fs.existsSync(keyInfoPath)) {
    poolInfo = JSON.parse(fs.readFileSync(keyInfoPath, 'utf8'));
  }

 // Prüfe, ob ein devWallet bereits existiert
  if (poolInfo.devWallet) {
    console.log('A Dev Wallet already exists in keyInfo.json:');
    console.log(`Public Key: ${poolInfo.devWallet.publicKey}`);
    const overwrite = prompt('Do you want to overwrite the existing Dev Wallet? (y/n): ').toLowerCase();
    if (overwrite !== 'y') {
      console.log('Dev Wallet creation aborted. Existing Dev Wallet preserved.\n');
      return;
    }
  }

  poolInfo.devWallet = {
    publicKey: newKey.publicKey,
    privateKey: newKey.privateKey,
  };
  fs.writeFileSync(keyInfoPath, JSON.stringify(poolInfo, null, 2));
  printDevWalletKeys(newKey);

  console.log('New Dev Key has been saved to keyInfo.json.\n');
}

export function loadDevKeypair(): Keypair | null {
  if (!fs.existsSync(keyInfoPath)) {
    console.log('keyInfo.json does not exist. No dev wallet found.');
    return null;
  }

  const poolInfo = JSON.parse(fs.readFileSync(keyInfoPath, 'utf8')) as IPoolInfo;
  const devWallet = poolInfo.devWallet;
  if (!devWallet || !devWallet.privateKey) {
    console.log('Dev wallet not found in keyInfo.json.');
    return null;
  }

  const secretKey = bs58.decode(devWallet.privateKey);
  return Keypair.fromSecretKey(secretKey);
}

export function loadKeypairs(): Keypair[] {
  if (!fs.existsSync(keyInfoPath)) {
    console.log('keyInfo.json does not exist. No wallets found.');
    return [];
  }

  const poolInfo = JSON.parse(fs.readFileSync(keyInfoPath, 'utf8')) as IPoolInfo;
  const wallets: Keypair[] = [];

  // Iterate through wallet entries in poolInfo
  for (let i = 1; i <= (poolInfo.numOfWallets || 0); i++) {
    const walletInfo = poolInfo[`wallet${i}`];
    if (walletInfo && walletInfo.privateKey) {
      const secretKey = bs58.decode(walletInfo.privateKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      wallets.push(keypair);
    }
  }

  return wallets;
}
