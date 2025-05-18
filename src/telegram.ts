import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as fs from 'fs';
import { Api } from 'telegram/tl';
import dotenv from 'dotenv';
import {TELEGRAM_USER_ID,TELEGRAM_API_ID,TELEGRAM_API_HASH,TELEGRAM_PHONE,TELEGRAM_POST_CHANNEL} from "../config";

// Telegram session
const sessionFile = 'session.txt';
const sessionData = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : '';
const stringSession = new StringSession(sessionData);

// Telegram client
let telegramClient: TelegramClient;

// Initialize Telegram client
export async function initializeTelegramClient() {
    telegramClient = new TelegramClient(stringSession, TELEGRAM_API_ID, TELEGRAM_API_HASH, { connectionRetries: 5 });

    if (!sessionData) {
        await telegramClient.start({
            phoneNumber: async () => TELEGRAM_PHONE,
            password: async () => {
                return new Promise((resolve) => {
                    process.stdout.write('Enter your 2FA password (if applicable, otherwise press Enter): ');
                    process.stdin.once('data', (data) => resolve(data.toString().trim()));
                });
            },
            phoneCode: async () => {
                return new Promise((resolve) => {
                    process.stdout.write('Enter the code you received: ');
                    process.stdin.once('data', (data) => resolve(data.toString().trim()));
                });
            },
            onError: (err) => console.log(err),
        });

        const sessionString = telegramClient.session.save() as unknown as string;
        fs.writeFileSync(sessionFile, sessionString);
        console.log('Telegram Client started and session saved.');
    } else {
        await telegramClient.connect();
        console.log('Telegram Client connected with saved session.');
    }
}


// Get current timestamp in ISO format
function nowISO() {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Zurich',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const [{ value: month }, , { value: day }, , { value: year }, , { value: hour }, , { value: minute }, , { value: second }] = formatter.formatToParts(new Date());
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export async function sendTelegramMsg(msg: string){
    // Send start message
    await telegramClient.sendMessage(TELEGRAM_POST_CHANNEL, {
        message: `[${nowISO()}] ${msg}`,
    	linkPreview: false,
	parseMode: 'html'
    });
}
