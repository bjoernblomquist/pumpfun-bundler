import { createKeypairs,createDevKeys, showKeypairs } from "./src/createKeys";
import { buyBundle } from "./src/jitoPool";
import { sender } from "./src/senderUI";
import { sellXPercentagePF } from "./src/sellFunc";
import promptSync from "prompt-sync";
import { sellXPercentageRAY } from "./src/sellRay";

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
	console.log("║ 6. 🚀  Sell % Supply on Pump.Fun              ║");
	console.log("║ 7. 💰  Sell % of Supply on Raydium            ║");
	console.log("╠═══════════════════════════════════════════════╣");
	console.log("║  Type 'exit' to quit.                         ║");
	console.log("╚═══════════════════════════════════════════════╝\n");

	const answer = prompt("👉 Choose between 1–7 or 'exit': ");

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
				await sellXPercentagePF();
				break;
			case "7":
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
