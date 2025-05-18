const { parentPort, workerData } = require("worker_threads");
const { Keypair } = require("@solana/web3.js");

function isValidVanityAddress(address, prefix, suffix, caseSensitive) {
  const addressToCheck = caseSensitive ? address : address.toLowerCase();
  const prefixToCheck = caseSensitive ? prefix : prefix.toLowerCase();
  const suffixToCheck = caseSensitive ? suffix : suffix.toLowerCase();

  return (
    addressToCheck.startsWith(prefixToCheck) &&
    addressToCheck.endsWith(suffixToCheck)
  );
}

function generateVanityAddress(prefix, suffix, caseSensitive, callback) {
  let keypair = Keypair.generate();

  while (
    !isValidVanityAddress(
      keypair.publicKey.toBase58(),
      prefix,
      suffix,
      caseSensitive
    )
  ) {
    callback();
    keypair = Keypair.generate();
  }

  return keypair;
}

const { prefix, suffix, caseSensitive } = workerData;
let localCounter = 0;

const keypair = generateVanityAddress(prefix, suffix, caseSensitive, () => {
  localCounter++;
  if (localCounter >= 1000) {
    parentPort.postMessage({ incrementCounter: localCounter });
    localCounter = 0;
  }
});

if (localCounter > 0) {
  parentPort.postMessage({ incrementCounter: localCounter });
}

parentPort.postMessage({
  keypair: {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: Buffer.from(keypair.secretKey).toString("hex"),
  },
  counter: localCounter,
});
