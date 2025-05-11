import { createKeypairs } from "./src/createKeys";
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
	console.log("║ 1. 🔑  Create Keypairs                        ║");
	console.log("║ 2. 📋  Launch Tools                           ║");
	console.log("║ 3. 🛠️   Create Pool Bundle                     ║");
	console.log("║ 4. 🚀  Sell % Supply on Pump.Fun              ║");
	console.log("║ 5. 💰  Sell % of Supply on Raydium            ║");
	console.log("╠═══════════════════════════════════════════════╣");
	console.log("║  Type 'exit' to quit.                         ║");
	console.log("╚═══════════════════════════════════════════════╝\n");

	const answer = prompt("👉 Choose between 1–5 or 'exit': ");

		switch (answer) {
			case "1":
				await createKeypairs();
				break;
			case "2":
				await sender();
				break;
			case "3":
				await buyBundle();
				break;
			case "4":
				await sellXPercentagePF();
				break;
			case "5":
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
