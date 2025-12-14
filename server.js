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
const { validate } = require('deep-email-validator');

const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';

const ADMIN_EMAIL = 'abdo140693@gmail.com';
const TRIAL_PERIOD_MINUTES = 1440;

const NUMBER_OF_SYSTEM_BOTS = 1;

const promosUploadFolder = path.join(__dirname, "public", "promos");
const dbFile = path.join(__dirname, "main_data.db");
const uploadsFolder = path.join(__dirname, 'uploads');
const blogFile = path.join(__dirname, 'blog_posts.json');
const sessionsFolder = path.join(__dirname, 'baileys_user_sessions');
const systemSessionFolder = path.join(__dirname, 'baileys_system_session');
const userDataFolder = path.join(__dirname, 'user_data');
const blogUploadFolder = path.join(__dirname, "public", "blog_images");

// Create directories
[promosUploadFolder, uploadsFolder, sessionsFolder, systemSessionFolder, userDataFolder, blogUploadFolder].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(blogFile)) fs.writeFileSync(blogFile, '[]');

const pendingRegistrations = {};
const whatsappClients = {};
const activeCampaigns = {};
const stopFilterFlags = {};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let systemSock = null;

// ================================================================= //
// ================= 2. Multer & DB Setup ========================== //
// ================================================================= //
const storagePromo = multer.diskStorage({
    destination: (req, file, cb) => cb(null, promosUploadFolder),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadPromoImage = multer({ storage: storagePromo, limits: { fileSize: 5 * 1024 * 1024 } });

const storageBlog = multer.diskStorage({
    destination: (req, file, cb) => cb(null, blogUploadFolder),
    filename: (req, file, cb) => cb(null, 'blog-' + Date.now() + path.extname(file.originalname))
});
const uploadBlogImage = multer({ storage: storageBlog, limits: { fileSize: 5 * 1024 * 1024 } });

const uploadCSV = multer({ dest: uploadsFolder, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());
app.use('/promos', express.static(promosUploadFolder));
app.use('/blog_images', express.static(blogUploadFolder)); // Important line

const authMiddleware = require('./middleware/auth');
const checkSubscription = require('./middleware/checkSubscription');

const db = new sqlite3.Database(dbFile, (err) => {
    if (err) { console.error("Fatal Error: DB Connect Failed", err); process.exit(1); }
    console.log("✅ Database connected.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
    db.run(`CREATE TABLE IF NOT EXISTS imported_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, googleId TEXT, name TEXT, email TEXT UNIQUE, password TEXT, trialEndsAt TEXT, subscriptionEndsAt TEXT, activationRequest TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS blog_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, summary TEXT, content TEXT, category TEXT, image TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    const addColumn = (t, c, type) => { db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`, (err) => {}); };
    addColumn('users', 'subscription_status', "TEXT DEFAULT 'trial'");
    addColumn('users', 'activation_code', 'TEXT');
    addColumn('users', 'chatbot_prompt', 'TEXT');
    addColumn('users', 'is_chatbot_active', "INTEGER DEFAULT 1");
    addColumn('imported_clients', 'name', "TEXT");
});

const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SENDER_EMAIL || ADMIN_EMAIL, pass: process.env.GMAIL_APP_PASS } });

function readPromos(userId) { const p = path.join(userDataFolder, `user_${userId}`, 'promos.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : []; }
function writePromos(userId, promos) { const d = path.join(userDataFolder, `user_${userId}`); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'promos.json'), JSON.stringify(promos, null, 2)); }
function generateActivationCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function processSpintax(text) { if (!text) return ""; return text.replace(/{([^{}]+)}/g, (m, o) => o.split('|')[Math.floor(Math.random() * o.split('|').length)]); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getRandomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1) + min); }
function checkAdmin(userId, cb) { db.get("SELECT email FROM users WHERE id = ?", [userId], (err, row) => cb(row && row.email.toLowerCase() === ADMIN_EMAIL.toLowerCase())); }

// ================================================================= //
// ================= 5. SYSTEM BOT (SINGLE) ======================== //
// ================================================================= //

async function initSystemBot() {
    try {
        console.log('🤖 System Bot: Initializing...');
        const { state, saveCreds } = await useMultiFileAuthState(systemSessionFolder);
        const { version } = await fetchLatestBaileysVersion();

        systemSock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS('Desktop'),
        });

        systemSock.ev.on('creds.update', saveCreds);
        systemSock.ev.on('connection.update', (update) => {
            const { connection, qr } = update;
            if (qr) {
                console.log(`\n⚠️ [SYSTEM BOT] SCAN QR BELOW:\n`);
                qrcodeTerminal.generate(qr, { small: true });
            }
            if (connection === 'close') {
                const shouldReconnect = (update.lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) setTimeout(initSystemBot, 5000);
                else { console.log('❌ System Bot Logged Out.'); systemSock = null; }
            } else if (connection === 'open') {
                console.log('✅ System Bot READY!');
            }
        });
    } catch (e) { console.error("System Bot Error:", e); }
}
initSystemBot();

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
        getMessage: async (key) => { return { conversation: 'hello' } }
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
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) { }
            }
        } else if (connection === 'open') {
            if (socket) socket.emit('status', { message: "Connected!", ready: true });
            syncContactsToDB(userId, socket);
        }
    });

    sock.ev.on('contacts.upsert', async (contacts) => {
        syncContactsToDB(userId, socket, contacts);
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
            db.get("SELECT is_chatbot_active, chatbot_prompt FROM users WHERE id = ?", [userId], async (err, user) => {
                if (err || !user || !user.is_chatbot_active) return;
                const userMsg = msg.message.conversation || msg.message.extendedTextMessage?.text;
                if (!userMsg) return;
                const prompt = activeCampaigns[userId]?.businessPrompt || user.chatbot_prompt || "Assistant";
                try {
                    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                    const completion = await openai.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [{ role: "system", content: prompt }, { role: "user", content: userMsg }]
                    });
                    await sock.sendMessage(msg.key.remoteJid, { text: completion.choices[0].message.content });
                } catch (error) { }
            });
        }
    });
    return sock;
}

function syncContactsToDB(userId, socket, specificContacts = null) {
    if (!specificContacts) return;

    const stmt = db.prepare(`INSERT OR IGNORE INTO clients (name, phone, ownerId) VALUES (?, ?, ?)`);
    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        specificContacts.forEach(c => {
            if (c.id && c.id.endsWith('@s.whatsapp.net')) {
                const phone = c.id.replace('@s.whatsapp.net', '');
                const name = c.name || c.notify || c.verifiedName || phone;
                stmt.run(name, phone, userId);
            }
        });
        stmt.finalize();
        db.run("COMMIT", () => {
            if (socket) socket.emit('sync-complete');
        });
    });
}

// ================================================================= //
// ==================== 7. SOCKET.IO LOGIC ========================= //
// ================================================================= //
io.on('connection', (socket) => {
    let activeUserId = null;

    socket.on('init-whatsapp', async (token) => {
        try {
            const d = jwt.verify(token, JWT_SECRET);
            activeUserId = d.userId;

            const sessionDir = path.join(sessionsFolder, `session-${activeUserId}`);
            const hasSession = fs.existsSync(path.join(sessionDir, 'creds.json'));

            if (whatsappClients[activeUserId] && hasSession) {
                socket.emit('status', { message: "WhatsApp متصل!", ready: true });
            } else {
                await startWhatsAppSession(activeUserId, socket);
            }
        } catch (e) { socket.emit('status', { message: "Token Error", ready: false }); }
    });

    socket.on('logout-whatsapp', async () => {
        if (whatsappClients[activeUserId]) { try { await whatsappClients[activeUserId].logout(); } catch (e) { } delete whatsappClients[activeUserId]; }
        try { fs.rmSync(path.join(sessionsFolder, `session-${activeUserId}`), { recursive: true, force: true }); } catch (e) { }
        db.run(`DELETE FROM clients WHERE ownerId=?`, [activeUserId]);
        db.run(`DELETE FROM imported_clients WHERE ownerId=?`, [activeUserId]);
        socket.emit('whatsapp-logged-out');
    });

    // FILTER LOGIC
    socket.on('check-numbers', async ({ numbers }) => {
        if (!systemSock || !systemSock.user) return socket.emit('filter-error', 'System Bot Offline');
        const list = numbers.split(/\r?\n/).map(l => l.replace(/\D/g, '')).filter(p => p.length >= 6);
        stopFilterFlags[activeUserId] = false;
        socket.emit('log', { message: `Checking ${list.length}...`, color: 'blue' });

        for (let i = 0; i < list.length; i++) {
            if (stopFilterFlags[activeUserId]) { socket.emit('filter-stopped'); break; }
            const phone = list[i];
            await sleep(500 + Math.random() * 1000);

            try {
                // Pic Strategy
                const pp = await systemSock.profilePictureUrl(`${phone}@s.whatsapp.net`, 'image').catch(() => null);
                if (pp) {
                    socket.emit('filter-result', { phone, status: 'valid' });
                } else {
                    const [res] = await systemSock.onWhatsApp(`${phone}@s.whatsapp.net`);
                    if (res?.exists) socket.emit('filter-result', { phone, status: 'valid' });
                    else socket.emit('filter-result', { phone, status: 'invalid' });
                }
            } catch (e) { socket.emit('filter-result', { phone, status: 'invalid' }); }
        }
        if (!stopFilterFlags[activeUserId]) socket.emit('filter-complete', { valid: 0, invalid: 0 });
    });

    socket.on('stop-filter', () => { stopFilterFlags[activeUserId] = true; });

    // PROMO LOGIC
    socket.on('send-promo', async (data) => {
        let sock = whatsappClients[activeUserId];
        // Auto Restore
        if (!sock) {
            const sessionDir = path.join(sessionsFolder, `session-${activeUserId}`);
            if (fs.existsSync(path.join(sessionDir, 'creds.json'))) {
                sock = await startWhatsAppSession(activeUserId, socket);
                await sleep(2000);
            }
        }

        if (!sock) return socket.emit('send-promo-status', { success: false, phone: data.phone, error: 'No WA' });

        const p = readPromos(activeUserId).find(x => x.id == data.promoId);
        if (!p) return;

        try {
            const jid = `${data.phone}@s.whatsapp.net`;
            const txt = processSpintax(p.text);
            const msgContent = p.image && fs.existsSync(path.join(promosUploadFolder, p.image))
                ? { image: { url: path.join(promosUploadFolder, p.image) }, caption: txt }
                : { text: txt };
            await sock.sendMessage(jid, msgContent);
            db.run(`UPDATE ${data.fromImported ? 'imported_clients' : 'clients'} SET last_sent=? WHERE phone=? AND ownerId=?`, [new Date().toISOString(), data.phone, activeUserId]);
            socket.emit('send-promo-status', { success: true, phone: data.phone });
        } catch (e) { socket.emit('send-promo-status', { success: false, phone: data.phone, error: e.message }); }
    });

    socket.on('sync-contacts', () => { if (activeUserId) syncContactsToDB(activeUserId, socket); });

});

// ==================== ROUTES & API ====================

app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email=?", [email.toLowerCase().trim()], async (e, u) => {
        if (!u || !(await bcrypt.compare(password, u.password))) return res.status(401).json({ message: 'Invalid' });
        res.json({ token: jwt.sign({ userId: u.id }, JWT_SECRET), isAdmin: u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase() });
    });
});

app.post("/api/auth/signup", async (req, res) => {
    const { name, email, password } = req.body;
    try { const v = await validate({ email, validateDisposable: true, validateSMTP: false }); if (!v.valid) return res.status(400).json({ message: 'Invalid Email' }); } catch (e) { }
    const hashedPassword = await bcrypt.hash(password, 12);
    db.run("INSERT INTO users (id,name,email,password) VALUES (?,?,?,?)", [Date.now().toString(), name, email.toLowerCase().trim(), hashedPassword], (err) => {
        if (err) return res.status(400).json({ message: 'Exists' });
        res.json({ message: 'Registered' });
    });
});

// === ROUTES PROTECTION (FIXED AUTH REDIRECTS) ===
app.use(express.static(path.join(__dirname, 'public')));

app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/login', (req, res) => res.redirect('/auth'));
app.get('/signup', (req, res) => res.redirect('/auth'));

app.get('/admin', authMiddleware, (req, res) => {
    checkAdmin(req.userData.userId, (isAdmin) => {
        if (!isAdmin) return res.redirect('/dashboard.html');
        res.sendFile(path.join(__dirname, 'public', 'admin-blog.html'));
    });
});

app.get('/dashboard', authMiddleware, checkSubscription, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/activate', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'activate.html')));


// === DATA API ROUTES ===
app.get("/contacts", authMiddleware, (req, res) => db.all("SELECT * FROM clients WHERE ownerId=?", [req.userData.userId], (e, r) => res.json(r || [])));
app.get("/imported-contacts", authMiddleware, (req, res) => db.all("SELECT * FROM imported_clients WHERE ownerId=?", [req.userData.userId], (e, r) => res.json(r || [])));
app.get("/promos", authMiddleware, (req, res) => res.json(readPromos(req.userData.userId)));

app.post("/import-csv", authMiddleware, uploadCSV.single('csv'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csvParser())
        .on('data', (d) => {
            const p = String(d.phone || Object.values(d)[0]).replace(/\D/g, "");
            if (p.length >= 8) results.push({ phone: p, name: d.name || '' });
        })
        .on('end', () => {
            fs.unlinkSync(req.file.path);
            const stmt = db.prepare("INSERT OR IGNORE INTO imported_clients (phone, name, ownerId) VALUES (?,?,?)");
            db.serialize(() => {
                db.run("BEGIN");
                results.forEach(r => stmt.run(r.phone, r.name, req.userData.userId));
                db.run("COMMIT", () => res.json({ message: "Imported", imported: results.length }));
            });
        });
});

app.post("/addPromo", authMiddleware, uploadPromoImage.single("image"), (req, res) => {
    try {
        const ps = readPromos(req.userData.userId);
        ps.push({ id: Date.now(), text: req.body.text, image: req.file ? req.file.filename : null });
        writePromos(req.userData.userId, ps);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.delete("/deletePromo/:id", authMiddleware, (req, res) => {
    const ps = readPromos(req.userData.userId).filter(p => p.id !== parseInt(req.params.id));
    writePromos(req.userData.userId, ps);
    res.json({ status: "deleted" });
});

app.delete("/api/delete-all-imported", authMiddleware, (req, res) => db.run(`DELETE FROM imported_clients WHERE ownerId=?`, [req.userData.userId], () => res.json({ success: true })));

// ========================================== //
// ============ BLOG API (FIXED) ============ //
// ========================================== //
app.get('/api/blog/posts', (req, res) => db.all("SELECT * FROM blog_posts ORDER BY id DESC", [], (e, r) => res.json(r || [])));
app.get('/api/blog/post/:id', (req, res) => db.get("SELECT * FROM blog_posts WHERE id=?", [req.params.id], (e, r) => res.json(r)));

// [MODIFIED] Create Blog Post Endpoint (FIXED HERE)
app.post('/api/blog/create', authMiddleware, uploadBlogImage.single('image'), (req, res) => {
    checkAdmin(req.userData.userId, (isAdmin) => {
        if (!isAdmin) return res.status(403).json({ message: "Forbidden" });

        console.log("📝 DATA RECEIVED:", req.body);
        if (req.file) console.log("🖼️ IMAGE:", req.file.filename);

        // FIX: Accept both naming conventions
        const title = req.body.title || req.body.title_ar;
        const summary = req.body.summary || req.body.excerpt || req.body.excerpt_ar;
        const content = req.body.content || req.body.content_ar;
        const category = req.body.category || 'General';

        if (!title) {
            console.error("❌ ERROR: Title is missing!");
            return res.status(400).json({ success: false, message: "Title is required" });
        }

        // FIX: Store relative path
        const img = req.file ? `blog_images/${req.file.filename}` : null;

        db.run(`INSERT INTO blog_posts (title, summary, content, category, image) VALUES (?,?,?,?,?)`,
            [title, summary, content, category, img],
            function (err) {
                if (err) {
                    console.error("❌ DB ERROR:", err.message);
                    return res.status(500).json({ success: false, error: err.message });
                }
                console.log("✅ Blog Post Created! ID:", this.lastID);
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

app.delete('/api/blog/delete/:id', authMiddleware, (req, res) => {
    checkAdmin(req.userData.userId, (isAdmin) => {
        if (!isAdmin) return res.status(403).json({ message: "Forbidden" });
        db.run("DELETE FROM blog_posts WHERE id=?", [req.params.id], () => res.json({ success: true }));
    });
});
app.get('/api/is-admin', authMiddleware, (req, res) => checkAdmin(req.userData.userId, (isAdmin) => res.json({ isAdmin })));

// API Misc
app.get("/api/chatbot-prompt", authMiddleware, (req, res) => db.get("SELECT chatbot_prompt FROM users WHERE id=?", [req.userData.userId], (err, r) => res.json({ prompt: r?.chatbot_prompt || '' })));
app.post("/api/chatbot-prompt", authMiddleware, (req, res) => db.run("UPDATE users SET chatbot_prompt=? WHERE id=?", [req.body.prompt, req.userData.userId], () => res.json({ success: true })));
app.get("/api/chatbot-status", authMiddleware, (req, res) => db.get("SELECT is_chatbot_active FROM users WHERE id=?", [req.userData.userId], (err, r) => res.json({ isActive: r?.is_chatbot_active === 1 })));
app.post("/api/chatbot-status", authMiddleware, (req, res) => db.run("UPDATE users SET is_chatbot_active=? WHERE id=?", [req.body.isActive ? 1 : 0, req.userData.userId], () => res.json({ success: true })));
app.post("/api/generate-spintax", authMiddleware, async (req, res) => { try { const completion = await openai.chat.completions.create({ model: "gpt-3.5-turbo", messages: [{ role: "user", content: `Rewrite this as Spintax {word|synonym}: ${req.body.text}` }] }); res.json({ spintax: completion.choices[0].message.content }); } catch (e) { res.status(500).json({ message: "Error" }); } });
app.post("/api/request-code", authMiddleware, async (req, res) => { const userId = req.userData.userId; const { durationName, durationDays } = req.body; db.get("SELECT name, email FROM users WHERE id = ?", [userId], async (err, user) => { if (err || !user) return res.status(404).json({ message: "User Not Found" }); const newActivationCode = generateActivationCode(); db.run("UPDATE users SET activation_code = ?, activationRequest = ? WHERE id = ?", [newActivationCode, JSON.stringify({ durationName, durationDays }), userId], async (err) => { if (err) return res.status(500).json({ message: "Error" }); const mailOptions = { from: process.env.SENDER_EMAIL, to: ADMIN_EMAIL, subject: `New Request`, html: `User: ${user.name} Code: ${newActivationCode}` }; await transporter.sendMail(mailOptions); res.status(200).json({ success: true }); }); }); });
app.post("/api/activate-with-code", authMiddleware, async (req, res) => { const { activationCode } = req.body; const userId = req.userData.userId; if (!activationCode) return res.status(400).json({ message: "Code required" }); db.get("SELECT activationRequest, activation_code FROM users WHERE id = ?", [userId], (err, user) => { if (err || !user || user.activation_code !== activationCode.trim()) return res.status(400).json({ message: "Invalid Code" }); const { durationDays } = JSON.parse(user.activationRequest); const newDate = new Date(); newDate.setDate(newDate.getDate() + parseInt(durationDays)); db.run("UPDATE users SET subscriptionEndsAt = ?, subscription_status = 'active', activation_code = NULL, activationRequest = NULL WHERE id = ?", [newDate.toISOString(), userId], (err) => { if (err) return res.status(500).json({ message: "Error" }); res.status(200).json({ success: true }); }); }); });

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
