import { createKeypairs,createDevKeys, showKeypairs } from "./createKeys";
import { buyBundle, startVolumeMaker } from "./jitoPool";
import { sender } from "./senderUI";
import { sellBundleWalletsPF } from "./sellFunc";
import promptSync from "prompt-sync";
import { sellXPercentageRAY } from "./sellRay";
import {TELEGRAM_USER_ID,TELEGRAM_API_ID,TELEGRAM_API_HASH,TELEGRAM_PHONE,TELEGRAM_POST_CHANNEL} from "../config";
import {initializeTelegramClient, sendTelegramMsg} from "./telegram"

const prompt = promptSync();


const title = `

██████  ██    ██ ███    ███ ██████  ███████ ██    ██ ███    ██     ██████  ██    ██ ███    ██ ██████  ██      ███████ ██████
██   ██ ██    ██ ████  ████ ██   ██ ██      ██    ██ ████   ██     ██   ██ ██    ██ ████   ██ ██   ██ ██      ██      ██   ██
██████  ██    ██ ██ ████ ██ ██████  █████   ██    ██ ██ ██  ██     ██████  ██    ██ ██ ██  ██ ██   ██ ██      █████   ██████
██      ██    ██ ██  ██  ██ ██      ██      ██    ██ ██  ██ ██     ██   ██ ██    ██ ██  ██ ██ ██   ██ ██      ██      ██   ██
██       ██████  ██      ██ ██      ██       ██████  ██   ████     ██████   ██████  ██   ████ ██████  ███████ ███████ ██   ██

--------------------------------------- Version 0.1.0 by bjoernblomquist ----------------------------------------------------
`;

async function main() {
	let running = true;
        console.log("Starting Pump.fun Bundler...");

        if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH || !TELEGRAM_PHONE || !TELEGRAM_POST_CHANNEL) {
          console.error('Missing Telegram configuration in .env');
          process.exit(1);
        }
        
	await initializeTelegramClient();

        console.log(title, '\n');
	while (running) {
	console.log("╔═══════════════════════════════════════════════╗");
	console.log("║              🪙  PF Bundler  🪙               ║");
	console.log("╠═══════════════════════════════════════════════╣");
	console.log("║ 1. 🗝️   Create Bundle Keypairs                 ║");
	console.log("║ 2. 🔐  Create Dev Keypair                     ║");
	console.log("║ 3. 🔍  Show all Keypairs                      ║");
	console.log("║ 4. 📋  Launch Tools                           ║");
	console.log("║ 5. 🛠️   Create Pool Bundle                     ║");
	console.log("║ 6. 🔔  Start Volume Bot Pump.Fun              ║");
	console.log("║ 7. 🚀  Sell % Supply on Pump.Fun              ║");
	console.log("║ 8. 💰  Sell % of Supply on Raydium            ║");
	console.log("╠═══════════════════════════════════════════════╣");
	console.log("║  Type 'exit' to quit.                         ║");
	console.log("╚═══════════════════════════════════════════════╝\n");

	const answer = prompt("👉 Choose between 1–8 or 'exit': ");

		switch (answer) {
			case "1":
				await createKeypairs();
				break;
			case "2":
				await createDevKeys();
				break;
			case "3":
				await showKeypairs();
				break;
			case "4":
				await sender();
				break;
			case "5":
				await buyBundle();
				break;
			case "6":
				await startVolumeMaker();
				break;
			case "7":
				await sellBundleWalletsPF();
				break;
			case "8":
				await sellXPercentageRAY();
				break;
			case "exit":
				running = false;
				break;
			default:
				console.log("Invalid option, please choose again.");
		}
	}

	console.log("Exiting...");
	process.exit(0);
}

main().catch((err) => {
	console.error("Error:", err);
});
