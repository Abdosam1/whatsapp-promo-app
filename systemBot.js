// FILE: systemBot.js
require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal'); // <--- Zidna hadi

let sock;
const SESSION_FOLDER = process.env.SESSION_NAME || 'auth_system_session';

// 1. Démarrage dyal Bot
const startSystemBot = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        // printQRInTerminal: true, <--- 7ayyedna hadi hit mabaqach khdama
        auth: state,
        browser: ["Filter System", "Chrome", "10.0"], 
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // === HNA FINA KAN-RSMO QR CODE ===
        if (qr) {
            console.log('\nScan had QR Code b l-app dyal WhatsApp:');
            qrcode.generate(qr, { small: true }); // <--- Hadi hiya li katbayen QR
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('System Bot Disconnected. Reconnecting...', shouldReconnect);
            if (shouldReconnect) startSystemBot();
        } else if (connection === 'open') {
            console.log('✅ SYSTEM FILTER NUMBER CONNECTED!');
        }
    });
};

// 2. Function dyal Filter
const filterNumber = async (phone) => {
    if (!sock) return false; 

    const cleanPhone = phone.toString().replace(/\D/g, ''); 
    const jid = cleanPhone + "@s.whatsapp.net";

    try {
        const [result] = await sock.onWhatsApp(jid);
        return result?.exists ? true : false;
    } catch (err) {
        // console.error("Error checking number:", err);
        return false;
    }
};

// Lance l-bot
startSystemBot();

module.exports = { filterNumber };