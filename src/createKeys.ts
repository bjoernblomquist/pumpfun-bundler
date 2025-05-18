import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import promptSync from 'prompt-sync';
import path from 'path';
import bs58 from 'bs58';
import {NUM_OF_WALLETS, payer, wallet} from "../config";
const configFilePath = path.join(__dirname, '../config.ts');

const prompt = promptSync();

const keypairsDir = path.join(__dirname, 'keypairs');
const keyInfoPath = path.join(__dirname, 'keyInfo.json');
const keysFilePath = path.join(__dirname, 'keyDev.json');

// Definieren des KeyObject-Interfaces
interface KeyObject {
  timestamp: number;
  date: string;
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
    timestamp,
    date: dateString,
    publicKey,
    privateKey,
  };
}

// Funktion zum Speichern eines Key-Objekts
function saveKey(keyObject: KeyObject): void {
  let keys: KeyObject[] = [];
  // Falls die Datei bereits existiert, lade den Inhalt
  if (fs.existsSync(keysFilePath)) {
    try {
      const fileData: string = fs.readFileSync(keysFilePath, 'utf8');
      keys = JSON.parse(fileData) as KeyObject[];
    } catch (err) {
      console.error('Error in reading file:', err);
    }
  }
  // Füge den neuen Key hinzu und speichere die Datei
  keys.push(keyObject);
  fs.writeFileSync(keysFilePath, JSON.stringify(keys, null, 2), 'utf8');
}

interface IPoolInfo {
  [key: string]: any;
  numOfWallets?: number;
}

// Ensure the keypairs directory exists
if (!fs.existsSync(keypairsDir)) {
  fs.mkdirSync(keypairsDir, { recursive: true });
}

function generateWallets(numOfWallets: number): Keypair[] {
  let wallets: Keypair[] = [];
  for (let i = 0; i < numOfWallets; i++) {
    const walletw = Keypair.generate();
    wallets.push(walletw);
  }
  return wallets;
}

// Funktion zum Aktualisieren der config.ts Datei (nur den wallet private key)
function updateConfigFile(newPrivateKey: string): void {
  try {
    // Lese den aktuellen Inhalt der config.ts
    let configContent = fs.readFileSync(configFilePath, 'utf8');

    // Regex, um den private key in export const wallet zu finden
    // Passt auf multiline, whitespace, single/double quotes, und trailing comma
    const walletRegex = /(export\s+const\s+wallet\s*=\s*Keypair\.fromSecretKey\s*\(\s*bs58\.decode\s*\(\s*['"]([^'"]+)['"]\s*,?\s*\)\s*,?\s*\)\s*;)/s;

    // Teste, ob die Regex matched
    const match = configContent.match(walletRegex);
    if (match) {
      // Ersetze den alten private key durch den neuen, behalte die Struktur bei
      const newKeyString = `export const wallet = Keypair.fromSecretKey(bs58.decode("${newPrivateKey}"));`;
      configContent = configContent.replace(walletRegex, newKeyString);
      console.log('Wallet private key found and updated.');
    } else {
      // Debugging: Logge den Inhalt von config.ts (sanitized)
      const sanitizedContent = configContent.replace(/"[^"]+"/g, '"<sanitized-key>"');
      console.error('Debug: config.ts content (sanitized):\n', sanitizedContent);

      // Finde Zeilen mit "wallet" oder "bs58.decode"
      const lines = configContent.split('\n');
      const relevantLines = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes('wallet') || line.includes('bs58.decode'))
        .map(({ line, index }) => `Line ${index + 1}: ${line}`);
      console.error('Debug: Lines containing "wallet" or "bs58.decode":\n', relevantLines.join('\n') || 'None found');

      // Logge die erwartete Regex
      console.error('Debug: Expected pattern: export const wallet = Keypair.fromSecretKey(bs58.decode("..."));');

      throw new Error('Wallet private key not found in config.ts or format unexpected.');
    }

    // Schreibe die aktualisierte Datei zurück
    fs.writeFileSync(configFilePath, configContent, 'utf8');
    console.log('Config file updated with new dev key, please RESTART.');
  } catch (err) {
    console.error('Error updating config file:', err);
    throw err;
  }
}

// Funktion zum Neuladen des config-Moduls
function reloadConfigModule(): typeof import("../config") {
  // Clear the module cache for config
  delete require.cache[require.resolve('../config')];
  // Reload the config module
  return require('../config');
}

function saveKeypairToFile(keypair: Keypair, index: number) {
  const keypairPath = path.join(keypairsDir, `keypair${index + 1}.json`);
  fs.writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)));
}

function readKeypairs(): Keypair[] {
  const files = fs.readdirSync(keypairsDir);
  return files.map(file => {
    const filePath = path.join(keypairsDir, file);
    const secretKey = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
  });
}

function updatePoolInfo(wallets: Keypair[]) {
  let poolInfo: IPoolInfo = {}; // Use the defined type here

  // Check if poolInfo.json exists and read its content
  if (fs.existsSync(keyInfoPath)) {
    const data = fs.readFileSync(keyInfoPath, 'utf8');
    poolInfo = JSON.parse(data);
  }

  // Update wallet-related information
  poolInfo.numOfWallets = wallets.length;
  wallets.forEach((walletw, index) => {
    poolInfo[`pubkey${index + 1}`] = walletw.publicKey.toString();
  });

  // Write updated data back to poolInfo.json
  fs.writeFileSync(keyInfoPath, JSON.stringify(poolInfo, null, 2));
}

export async function createKeypairs() {
  console.log('WARNING: If you create new ones, ensure you don\'t have SOL in old ones OR ELSE IT WILL BE GONE.');
  const action = prompt('Do you want to (c)reate new wallets? Else press ENTER:');
  let wallets: Keypair[] = [];

  if (action === 'c') {
    const numOfWallets = NUM_OF_WALLETS; 
    if (isNaN(numOfWallets) || numOfWallets <= 0) {
      console.log('Invalid number. Please enter a positive integer.');
      return;
    }

    wallets = generateWallets(numOfWallets);
    console.log('\nWallet Information:\n');

    wallets.forEach((walletw, index) => {
      saveKeypairToFile(walletw, index);
      console.log(`Bundle Wallet ${index + 1} Public Key: ${walletw.publicKey.toString()}`);
      console.log(`Bundle Wallet ${index + 1} Private Key: ${bs58.encode(walletw.secretKey)}\n`);
    });
  } else {
    console.log('Invalid option. Please enter "c" for create or "u" for use existing.');
    return;
  }

  updatePoolInfo(wallets);
}

export async function showKeypairs() {
  let wallets: Keypair[] = [];

    wallets = readKeypairs();
    console.log('\nWallet Information:\n');
    wallets.forEach((walletw, index) => {
      console.log(`Bundle Wallet ${index + 1} Public Key: ${walletw.publicKey.toString()}`);
      console.log(`Bundle Wallet ${index + 1} Private Key: ${bs58.encode(walletw.secretKey)}\n`);
    });
      console.log(`Dev Wallet Public Key: ${wallet.publicKey.toString()}\nDev Wallet Private Key: ${bs58.encode(wallet.secretKey)}\n`);
      console.log(`Payer Wallet (SOL from here will be distributed to Dev and Bundle Wallets): ${payer.publicKey.toString()}\n`);

}

function printDevWalletKeys(keyObject: KeyObject): void {
  console.log(`Dev Wallet Public Key: ${keyObject.publicKey}`);
  console.log(`Dev Wallet Private Key: ${keyObject.privateKey}`);
}

export async function createDevKeys() {  
  console.log('\nNew Dev Keys will be generated:\n');
  const newKey = generateKeys();
  printDevWalletKeys(newKey); 
  updateConfigFile(newKey.privateKey);
  saveKey(newKey);
   // Lade das config-Modul neu, um den neuen wallet-Wert zu reflektieren
  try {
    const updatedConfig = reloadConfigModule();
    console.log('Config module reloaded. New Dev Wallet Public Key:', updatedConfig.wallet.publicKey.toString());
  } catch (err) {
    console.error('Error reloading config module:', err);
    console.log('Please restart the application to use the new dev key.');
  }

  console.log('New Dev Key has been saved, old key overwritten, and config updated.\n');
}

export function loadKeypairs(): Keypair[] {
  // Define a regular expression to match filenames like 'keypair1.json', 'keypair2.json', etc.
  const keypairRegex = /^keypair\d+\.json$/;

  return fs.readdirSync(keypairsDir)
    .filter(file => keypairRegex.test(file)) // Use the regex to test each filename
    .map(file => {
      const filePath = path.join(keypairsDir, file);
      const secretKeyString = fs.readFileSync(filePath, { encoding: 'utf8' });
      const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
      return Keypair.fromSecretKey(secretKey);
    });
}
