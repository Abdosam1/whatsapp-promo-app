// ================================================================= //
// ==================== 1. Libraries & Config ===================== //
// ================================================================= //
require('dotenv').config();

const http = require('http');
const express = require("express");
const socketIo = require('socket.io');
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const csvParser = require("csv-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require('nodemailer');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const sqlite3 = require("sqlite3").verbose();
const { OpenAI } = require("openai");

const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers,
    fetchLatestBaileysVersion,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal'); // تأكد أن هذه المكتبة مثبتة

// ================================================================= //
// ========================= 2. Variables ======================= //
// ================================================================= //
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';

// === ADMIN SETTINGS ===
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@gmail.com'; 
const TRIAL_PERIOD_MINUTES = 1440;

// === SYSTEM BOTS SETTINGS (1 بوت للفحص) ===
const NUMBER_OF_SYSTEM_BOTS = 1; 

// Folders
const promosUploadFolder = path.join(__dirname, "public", "promos");
const dbFile = path.join(__dirname, "main_data.db");
const uploadsFolder = path.join(__dirname, 'uploads');
const sessionsFolder = path.join(__dirname, 'baileys_user_sessions'); 
const userDataFolder = path.join(__dirname, 'user_data');

// Create directories if not exist
[promosUploadFolder, uploadsFolder, sessionsFolder, userDataFolder].forEach(dir => { 
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); 
});

// State Variables
const whatsappClients = {}; 
const activeCampaigns = {};
const systemSocks = new Array(NUMBER_OF_SYSTEM_BOTS).fill(null); 
const stopFilterFlags = {}; 

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ================================================================= //
// ================= 3. Database & Setup ================= //
// ================================================================= //
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) { console.error("Fatal Error: DB Connect Failed", err); process.exit(1); }
  console.log("✅ Database connected.");
});

db.serialize(() => {
    // Clients Table
    db.run(`CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        name TEXT, 
        phone TEXT, 
        last_sent DATE, 
        ownerId TEXT NOT NULL, 
        last_interaction INTEGER DEFAULT 0,
        UNIQUE(phone, ownerId)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS imported_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        phone TEXT, 
        name TEXT,
        last_sent DATE, 
        ownerId TEXT NOT NULL, 
        UNIQUE(phone, ownerId)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, googleId TEXT, name TEXT, email TEXT UNIQUE, password TEXT, trialEndsAt TEXT, subscriptionEndsAt TEXT, activationRequest TEXT)`);
    
    // Filtered Numbers Table
    db.run(`CREATE TABLE IF NOT EXISTS filtered_numbers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        phone TEXT, 
        status TEXT, 
        ownerId TEXT, 
        created_at DATE DEFAULT CURRENT_TIMESTAMP
    )`);

    const addColumn = (t, c, type) => { 
        db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`, (err) => {}); 
    };

    addColumn('imported_clients', 'name', 'TEXT'); 
    addColumn('users', 'subscription_status', "TEXT DEFAULT 'trial'");
    addColumn('users', 'activation_code', 'TEXT');
    addColumn('users', 'chatbot_prompt', 'TEXT');
    addColumn('users', 'is_chatbot_active', "INTEGER DEFAULT 1");
    addColumn('clients', 'last_interaction', 'INTEGER DEFAULT 0');
});

const uploadPromoImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, promosUploadFolder), filename: (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`) }), limits: { fileSize: 3*1024*1024 } });
const uploadCSV = multer({ dest: uploadsFolder, limits: { fileSize: 50*1024*1024 } }); 

app.use(cors()); 
app.use(express.json()); 
app.use(passport.initialize()); 
app.use('/promos', express.static(promosUploadFolder));

const authMiddleware = (req, res, next) => {
    try {
        const token = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userData = decoded;
        next();
    } catch (error) { return res.status(401).json({ message: "Auth failed" }); }
};

const checkSubscription = (req, res, next) => { next(); };

function readPromos(userId) { 
    const p = path.join(userDataFolder, `user_${userId}`, 'promos.json'); 
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : []; 
}
function processSpintax(text) { 
    if (!text) return ""; 
    return text.replace(/\{([^{}]+)\}/g, (match, options) => { 
        const choices = options.split('|'); 
        return choices[Math.floor(Math.random() * choices.length)]; 
    }); 
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getRandomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1) + min); }
function checkAdmin(userId, cb) { db.get("SELECT email FROM users WHERE id = ?", [userId], (err, row) => { cb(row && row.email === ADMIN_EMAIL); }); }

// ================================================================= //
// ================= 5. SYSTEM BOTS (FIXED QR LOGIC) =============== //
// ================================================================= //

async function startSingleSystemBot(botIndex) {
    const folderName = `baileys_system_session_${botIndex}`;
    const folderPath = path.join(__dirname, folderName);
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(folderPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // <=== جعلناها false لأننا سنطبع الكود يدوياً
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // === طباعة QR Code يدوياً ===
        if (qr) {
            console.log(`\nScan this QR Code for System Bot #${botIndex + 1}:\n`);
            qrcodeTerminal.generate(qr, { small: true });
        }
        // ============================

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startSingleSystemBot(botIndex);
        } else if (connection === 'open') {
            console.log(`✅ System Bot #${botIndex + 1} Ready`);
            systemSocks[botIndex] = sock;
        }
    });
    systemSocks[botIndex] = sock;
}

async function initAllSystemBots() {
    for (let i = 0; i < NUMBER_OF_SYSTEM_BOTS; i++) {
        await startSingleSystemBot(i);
        await sleep(2000); 
    }
}
initAllSystemBots();

// ================================================================= //
// ================= 6. USER BOT (CLIENTS & SYNC) ================== //
// ================================================================= //

async function startWhatsAppSession(userId, socket = null) {
    if (!userId) return;

    const sessionDir = path.join(sessionsFolder, `session-${userId}`);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, 
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: true
    });

    whatsappClients[userId] = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && socket) socket.emit('qr', qr);

        if (connection === 'close') {
            if ((lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut) {
                startWhatsAppSession(userId, socket);
            } else {
                if (socket) socket.emit('status', { message: "Logged out", ready: false, error: true });
                delete whatsappClients[userId];
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
            }
        } else if (connection === 'open') {
            if (socket) socket.emit('status', { message: "Connected!", ready: true });
            if(socket) setTimeout(() => socket.emit('sync-complete'), 5000);
        }
    });

    const upsertClient = (id, name, timestamp) => {
        if (!id || id.includes('g.us') || id.includes('status') || id.includes('broadcast')) return;
        const phone = id.split('@')[0];
        
        db.serialize(() => {
            if (timestamp) {
                db.run(`INSERT INTO clients (phone, ownerId, last_interaction, name) VALUES (?, ?, ?, ?)
                        ON CONFLICT(phone, ownerId) DO UPDATE SET last_interaction = excluded.last_interaction`, 
                        [phone, userId, timestamp, name || null]); 
            } 
            if (name) {
                db.run(`UPDATE clients SET name = ? WHERE phone = ? AND ownerId = ?`, [name, phone, userId]);
                db.run(`INSERT INTO clients (phone, ownerId, name, last_interaction) 
                        SELECT ?, ?, ?, 0 WHERE (SELECT Changes() = 0)`, [phone, userId, name]);
            }
        });
    };

    sock.ev.on('messaging-history.set', async (history) => {
        const { chats, contacts } = history;
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            if (contacts) contacts.forEach(c => upsertClient(c.id, c.name || c.notify, null));
            if (chats) chats.forEach(c => {
                const ts = c.conversationTimestamp ? (typeof c.conversationTimestamp === 'object' ? c.conversationTimestamp.low : c.conversationTimestamp) : Date.now();
                upsertClient(c.id, c.name, ts * 1000);
            });
            db.run("COMMIT");
        });
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
            
            const senderPhone = msg.key.remoteJid;
            const senderName = msg.pushName;
            const ts = msg.messageTimestamp ? (typeof msg.messageTimestamp === 'object' ? msg.messageTimestamp.low : msg.messageTimestamp) : Date.now();
            upsertClient(senderPhone, senderName, ts * 1000);

            // Chatbot Logic
             db.get("SELECT is_chatbot_active, chatbot_prompt FROM users WHERE id = ?", [userId], async (err, user) => {
                if (err || !user || !user.is_chatbot_active) return;
                const userMsg = msg.message.conversation || msg.message.extendedTextMessage?.text;
                if (!userMsg) return;
                const prompt = activeCampaigns[userId]?.businessPrompt || user.chatbot_prompt || "Helpful Assistant";
                try {
                    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                    const completion = await openai.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [ { role: "system", content: prompt }, { role: "user", content: userMsg } ]
                    });
                    await sock.sendMessage(msg.key.remoteJid, { text: completion.choices[0].message.content });
                } catch (error) {}
            });
        }
    });

    sock.ev.on('contacts.upsert', async (contacts) => {
        for (const contact of contacts) upsertClient(contact.id, contact.name || contact.notify, null);
    });

    return sock;
}

// ================================================================= //
// ==================== 7. Socket.IO Logic ======================== //
// ================================================================= //
io.on('connection', (socket) => {
    let activeUserId = null;

    socket.on('init-whatsapp', async (token) => {
        try {
            if(!token) return;
            const d = jwt.verify(token, JWT_SECRET);
            activeUserId = d.userId;
            
            const existing = whatsappClients[activeUserId];
            if (existing && existing.user) {
                socket.emit('status', { message: "Connected!", ready: true });
            } else {
                if(existing) { try{existing.end();}catch(e){} delete whatsappClients[activeUserId]; }
                await startWhatsAppSession(activeUserId, socket);
            }
        } catch (e) { socket.emit('status', { message: "Token Error", ready: false, error: true }); }
    });

    socket.on('logout-whatsapp', async () => {
        if (!activeUserId) return;
        try { await whatsappClients[activeUserId].logout(); } catch(e){} 
        delete whatsappClients[activeUserId];
        const dir = path.join(sessionsFolder, `session-${activeUserId}`);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        
        db.run(`DELETE FROM clients WHERE ownerId=?`, [activeUserId]);
        db.run(`DELETE FROM imported_clients WHERE ownerId=?`, [activeUserId]);
        
        socket.emit('whatsapp-logged-out');
    });

    socket.on('sync-contacts', () => { setTimeout(() => { socket.emit('sync-complete'); }, 3000); });

    // FILTER LOGIC
    socket.on('check-numbers', async ({ numbers }) => {
        const activeBots = systemSocks.filter(s => s && s.user);
        
        if (activeBots.length === 0) return socket.emit('filter-error', 'System Bots Offline. Please check server logs and scan QR.');

        const allPhones = numbers.split(/\r?\n/).map(l => l.trim().replace(/\D/g, '')).filter(p => p.length >= 6);
        let valid = 0, invalid = 0;
        stopFilterFlags[activeUserId] = false;

        socket.emit('log', { message: `⏳ Checking ${allPhones.length} numbers...`, color: 'blue' });

        for (let i = 0; i < allPhones.length; i++) {
            if (stopFilterFlags[activeUserId]) {
                socket.emit('filter-stopped');
                break;
            }
            const phone = allPhones[i];
            
            await sleep(getRandomDelay(300, 1000));

            const bot = activeBots[i % activeBots.length];
            try {
                const id = `${phone}@s.whatsapp.net`;
                const [result] = await bot.onWhatsApp(id);
                
                let status = 'invalid';
                if (result?.exists) {
                    status = 'valid';
                    valid++;
                } else {
                    invalid++;
                }

                // حفظ النتيجة في الداتابيس
                if (activeUserId) {
                    db.run(`INSERT INTO filtered_numbers (phone, status, ownerId) VALUES (?, ?, ?)`, 
                           [phone, status, activeUserId]);
                }

                socket.emit('filter-result', { phone, status });

            } catch (err) {
                invalid++;
                socket.emit('filter-result', { phone, status: 'invalid' });
            }
        }
        if (!stopFilterFlags[activeUserId]) socket.emit('filter-complete', { valid, invalid });
    });

    socket.on('stop-filter', () => { if(activeUserId) stopFilterFlags[activeUserId] = true; });

    socket.on('start-campaign-mode', ({ promoId }) => {
        socket.emit('log', { message: `Campaign Started with Promo #${promoId}`, color: 'purple' });
    });

    socket.on('send-promo', async (data) => {
        const { phone, promoId, fromImported } = data;
        const sock = whatsappClients[activeUserId];
        
        if(!activeUserId || !sock) return socket.emit('send-promo-status', {success:false, phone, error:'Not Connected'});
        
        const promos = readPromos(activeUserId);
        const promo = promos.find(p => p.id === promoId);
        
        if(!promo) return socket.emit('send-promo-status', {success:false, phone, error:'Promo Not Found'});

        try {
            const jid = `${phone.replace(/\D/g,'')}@s.whatsapp.net`;
            const txt = processSpintax(promo.text);
            
            if(promo.image) {
                const imgPath = path.join(promosUploadFolder, promo.image);
                if(fs.existsSync(imgPath)) {
                    await sock.sendMessage(jid, { image: { url: imgPath }, caption: txt });
                } else {
                    await sock.sendMessage(jid, { text: txt });
                }
            } else {
                await sock.sendMessage(jid, { text: txt });
            }
            
            const t = fromImported ? 'imported_clients' : 'clients';
            db.run(`UPDATE ${t} SET last_sent=? WHERE phone=? AND ownerId=?`, [new Date().toISOString(), phone, activeUserId]);
            
            socket.emit('send-promo-status', {success:true, phone});
        } catch(e) { 
            socket.emit('send-promo-status', {success:false, phone, error:e.message}); 
        }
    });
});

// ================================================================= //
// ==================== 8. ROUTES (API) ========================== //
// ================================================================= //

passport.use(new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: "/api/auth/google/callback" }, (a,r,p,d) => {
    const email = p.emails[0].value;
    db.get("SELECT * FROM users WHERE email=?", [email], (e,u) => {
        if(e) return d(e);
        if(u) return d(null,u);
        const id=Date.now().toString(); 
        db.run("INSERT INTO users (id,googleId,name,email,trialEndsAt) VALUES (?,?,?,?,?)", [id,p.id,p.displayName,email,new Date(Date.now()+TRIAL_PERIOD_MINUTES*60000).toISOString()], (err)=>d(err,{id,email}));
    });
}));

app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => {
    const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' });
    res.redirect(req.user.email === ADMIN_EMAIL ? `/admin.html?token=${token}` : `/dashboard.html?token=${token}`);
});

app.post("/api/auth/signup", async (req, res) => {
    const { name, email, password } = req.body;
    db.get("SELECT email FROM users WHERE email=?", [email], async (err, user) => {
        if (user) return res.status(400).json({ message: 'User exists' });
        const id = Date.now().toString();
        const hash = await bcrypt.hash(password, 12);
        db.run("INSERT INTO users (id,email,name,password,trialEndsAt) VALUES (?,?,?,?,?)", 
            [id,email,name,hash,new Date(Date.now()+TRIAL_PERIOD_MINUTES*60000).toISOString()], 
            (err) => {
                if(err) return res.status(500).json({message:"Error"});
                res.json({ message: 'Registered' });
            }
        );
    });
});

app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email=?", [email], async (err, user) => {
        if (!user || !user.password || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: 'Invalid credentials' });
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, isAdmin: user.email === ADMIN_EMAIL });
    });
});

// ============================================
// FIX: CONTACTS & IMPORT API (With Sorting)
// ============================================

app.get('/contacts', authMiddleware, (req, res) => {
    db.all("SELECT * FROM clients WHERE ownerId = ? ORDER BY last_interaction DESC", [req.userData.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/imported-contacts', authMiddleware, (req, res) => {
    db.all("SELECT * FROM imported_clients WHERE ownerId = ?", [req.userData.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/import-csv', authMiddleware, uploadCSV.single('csv'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csvParser())
        .on('data', (data) => {
            const values = Object.values(data);
            if (values.length > 0) {
                const phone = values[0].toString().replace(/\D/g, '');
                const name = values[1] || ''; 
                if (phone.length > 5) results.push({ phone, name });
            }
        })
        .on('end', () => {
            fs.unlinkSync(req.file.path);
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                const stmt = db.prepare("INSERT OR IGNORE INTO imported_clients (phone, name, ownerId) VALUES (?, ?, ?)");
                let count = 0;
                results.forEach(row => {
                    stmt.run(row.phone, row.name, req.userData.userId);
                    count++;
                });
                stmt.finalize();
                db.run("COMMIT", () => {
                    res.json({ message: "Import complete", imported: count });
                });
            });
        });
});

app.delete('/api/delete-all-imported', authMiddleware, (req, res) => {
    db.run("DELETE FROM imported_clients WHERE ownerId = ?", [req.userData.userId], (err) => {
        if(err) return res.status(500).json({message: "Error"});
        res.json({message: "Deleted all imported contacts"});
    });
});

// ============================================
// PROMOS API
// ============================================

app.get('/promos', authMiddleware, (req, res) => {
    try {
        const userPromos = readPromos(req.userData.userId);
        res.json(userPromos);
    } catch (e) { res.json([]); }
});

app.post('/addPromo', authMiddleware, uploadPromoImage.single('image'), (req, res) => {
    const { text } = req.body;
    const userId = req.userData.userId;
    const userDir = path.join(userDataFolder, `user_${userId}`);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    
    const promosFile = path.join(userDir, 'promos.json');
    let userPromos = fs.existsSync(promosFile) ? JSON.parse(fs.readFileSync(promosFile)) : [];

    const newPromo = {
        id: Date.now().toString(),
        text: text || "",
        image: req.file ? req.file.filename : null
    };

    userPromos.push(newPromo);
    fs.writeFileSync(promosFile, JSON.stringify(userPromos, null, 2));
    res.json({ success: true });
});

app.delete('/deletePromo/:id', authMiddleware, (req, res) => {
    const userId = req.userData.userId;
    const promosFile = path.join(userDataFolder, `user_${userId}`, 'promos.json');
    if (!fs.existsSync(promosFile)) return res.json({ success: false });

    let userPromos = JSON.parse(fs.readFileSync(promosFile));
    userPromos = userPromos.filter(p => p.id !== req.params.id);
    fs.writeFileSync(promosFile, JSON.stringify(userPromos, null, 2));
    res.json({ success: true });
});

app.get('/api/chatbot-prompt', authMiddleware, (req,res) => {
    db.get("SELECT chatbot_prompt FROM users WHERE id=?", [req.userData.userId], (err,r)=>res.json({prompt:r?.chatbot_prompt||''}));
});
app.post('/api/chatbot-prompt', authMiddleware, (req,res) => {
    db.run("UPDATE users SET chatbot_prompt=? WHERE id=?", [req.body.prompt, req.userData.userId], ()=>res.json({success:true}));
});
app.get('/api/chatbot-status', authMiddleware, (req,res) => {
    db.get("SELECT is_chatbot_active FROM users WHERE id=?", [req.userData.userId], (err,r)=>res.json({isActive:r?.is_chatbot_active===1}));
});
app.post('/api/chatbot-status', authMiddleware, (req,res) => {
    db.run("UPDATE users SET is_chatbot_active=? WHERE id=?", [req.body.isActive?1:0, req.userData.userId], ()=>res.json({success:true}));
});
app.post('/api/generate-spintax', authMiddleware, async (req,res) => {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{role:"user", content: `Rewrite this as Spintax {word|synonym}: ${req.body.text}`}]
        });
        res.json({spintax: completion.choices[0].message.content});
    } catch(e){ res.status(500).json({message:"Error"}); }
});

app.get('/api/is-admin', authMiddleware, (req,res) => checkAdmin(req.userData.userId, (isAdmin)=>res.json({isAdmin})));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', authMiddleware, (req, res) => { checkAdmin(req.userData.userId, (isAdmin) => { if(!isAdmin) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); }); });
app.get('/dashboard', authMiddleware, checkSubscription, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/activate', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'activate.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
