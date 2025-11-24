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

// === BAILEYS IMPORTS ===
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

// ================================================================= //
// ========================= 2. Variables ======================= //
// ================================================================= //
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const SENDER_EMAIL = process.env.SENDER_EMAIL || ADMIN_EMAIL;
const TRIAL_PERIOD_MINUTES = 1440;

const promosUploadFolder = path.join(__dirname, "public", "promos");
const dbFile = path.join(__dirname, "main_data.db");
const uploadsFolder = path.join(__dirname, 'uploads');
const sessionsFolder = path.join(__dirname, 'baileys_user_sessions'); 
const systemSessionFolder = path.join(__dirname, 'baileys_system_session'); 

const pendingRegistrations = {};
const whatsappClients = {}; 
const activeCampaigns = {};
const FILTER_BATCH_SIZE = 1000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let systemSock = null; 

// ================================================================= //
// ================= 3. Database & Setup ================= //
// ================================================================= //
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) { console.error("Fatal Error: Could not connect to database.", err); process.exit(1); }
  console.log("✅ Database connected successfully.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
    db.run(`CREATE TABLE IF NOT EXISTS imported_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, googleId TEXT, name TEXT, email TEXT UNIQUE, password TEXT, trialEndsAt TEXT, subscriptionEndsAt TEXT, activationRequest TEXT)`);
    const addColumnIfNotExists = (tableName, columnName, columnType) => {
        db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`, (err) => { if (err && !err.message.includes('duplicate column name')) {} });
    };
    addColumnIfNotExists('users', 'subscription_status', "TEXT DEFAULT 'trial'");
    addColumnIfNotExists('users', 'activation_code', 'TEXT');
    addColumnIfNotExists('users', 'chatbot_prompt', 'TEXT');
    addColumnIfNotExists('users', 'is_chatbot_active', "INTEGER DEFAULT 1");
});

const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: SENDER_EMAIL, pass: process.env.GMAIL_APP_PASS } });
if (!fs.existsSync(promosUploadFolder)) fs.mkdirSync(promosUploadFolder, { recursive: true });
if (!fs.existsSync(uploadsFolder)) fs.mkdirSync(uploadsFolder, { recursive: true });
if (!fs.existsSync(sessionsFolder)) fs.mkdirSync(sessionsFolder, { recursive: true });
if (!fs.existsSync(systemSessionFolder)) fs.mkdirSync(systemSessionFolder, { recursive: true });

const uploadLimits = { fileSize: 3 * 1024 * 1024 };
const uploadPromoImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, promosUploadFolder), filename: (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`) }), limits: uploadLimits });
const uploadCSV = multer({ dest: uploadsFolder, limits: uploadLimits });

app.use(cors());
app.use(express.json());
app.use(passport.initialize());
app.use('/promos', express.static(promosUploadFolder));
const authMiddleware = require('./middleware/auth');
const checkSubscription = require('./middleware/checkSubscription');

// ================================================================= //
// ======================= 4. Helpers ====================== //
// ================================================================= //
function readPromos(userId) { const userPromoPath = path.join(__dirname, 'user_data', `user_${userId}`); if (!fs.existsSync(userPromoPath)) fs.mkdirSync(userPromoPath, { recursive: true }); const p = path.join(userPromoPath, 'promos.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : []; }
function writePromos(userId, promos) { const userPromoPath = path.join(__dirname, 'user_data', `user_${userId}`); if (!fs.existsSync(userPromoPath)) fs.mkdirSync(userPromoPath, { recursive: true }); fs.writeFileSync(path.join(userPromoPath, 'promos.json'), JSON.stringify(promos, null, 2)); }
function generateActivationCode() { const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let code = ''; for (let i = 0; i < 12; i++) { code += chars.charAt(Math.floor(Math.random() * chars.length)); if (i === 3 || i === 7) code += '-'; } return code; }
function processSpintax(text) {
    if (!text) return "";
    let processedText = text;
    const spintaxRegex = /\{([^{}]+)\}/g;
    let match;
    while ((match = spintaxRegex.exec(processedText))) {
        const options = match[1].split('|');
        const randomChoice = options[Math.floor(Math.random() * options.length)];
        processedText = processedText.replace(match[0], randomChoice);
    }
    return processedText;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ================================================================= //
// ================= 5. SYSTEM BOT (FILTER ONLY) =================== //
// ================================================================= //

async function initSystemBot() {
    console.log('🤖 Starting System Bot (Filter Engine)...');
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
        const { connection, lastDisconnect, qr } = update;
        
        // QR Code for SYSTEM BOT only shows in Terminal
        if (qr) {
            console.log('\n[SYSTEM BOT] Scan this QR for Filtering Service:\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) initSystemBot();
        } else if (connection === 'open') {
            console.log('✅ System Bot is READY for Filtering!');
        }
    });
}

initSystemBot();

// ================================================================= //
// ================= 6. USER BOT (CLIENTS) ========================= //
// ================================================================= //

async function startWhatsAppSession(userId, socket = null) {
    // === Security Check: Ensure userId is valid ===
    if (!userId || userId === 'undefined' || userId === 'null') {
        console.error("❌ Error: Attempted to create session for invalid User ID.");
        if(socket) socket.emit('status', { message: "خطأ في المعرف (ID)", ready: false, error: true });
        return;
    }

    // UNIQUE FOLDER PER USER
    const sessionDir = path.join(sessionsFolder, `session-${userId}`);
    console.log(`📂 Opening Session for User: ${userId} at ${sessionDir}`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // User QR goes to Frontend, NOT terminal
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
    });

    whatsappClients[userId] = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Send QR to FRONTEND (Dashboard)
        if (qr && socket) {
            console.log(`📤 Sending QR to Dashboard for User: ${userId}`);
            socket.emit('qr', qr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startWhatsAppSession(userId, socket);
            } else {
                if (socket) socket.emit('status', { message: "تم تسجيل الخروج", ready: false, error: true });
                delete whatsappClients[userId];
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
            }
        } else if (connection === 'open') {
            console.log(`✅ User ${userId} Connected Successfully!`);
            if (socket) socket.emit('status', { message: "WhatsApp متصل بنجاح!", ready: true });
        }
    });

    // Chatbot Logic for User
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const fromNumber = msg.key.remoteJid;
            if (fromNumber.endsWith('@g.us')) continue;

            db.get("SELECT is_chatbot_active, chatbot_prompt FROM users WHERE id = ?", [userId], async (err, user) => {
                if (err || !user || !user.is_chatbot_active) return;
                const userMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
                if (!userMessage) return;

                const campaignInfo = activeCampaigns[userId];
                const systemPrompt = (campaignInfo && campaignInfo.businessPrompt) ? campaignInfo.businessPrompt : (user.chatbot_prompt || "You are a helpful assistant.");

                try {
                    await sock.sendPresenceUpdate('composing', fromNumber);
                    const completion = await openai.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [ { role: "system", content: systemPrompt }, { role: "user", content: userMessage } ]
                    });
                    await sock.sendMessage(fromNumber, { text: completion.choices[0].message.content });
                } catch (error) { console.error("[AI Chatbot] Error:", error.message); }
            });
        }
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
            const decoded = jwt.verify(token, JWT_SECRET);
            activeUserId = decoded.userId;

            if (!activeUserId) {
                console.error("❌ Token invalid: No userId found.");
                return;
            }

            console.log(`🔌 Client connected: ${activeUserId}`);

            if (whatsappClients[activeUserId]) {
                socket.emit('status', { message: "WhatsApp متصل بالفعل!", ready: true });
            } else {
                await startWhatsAppSession(activeUserId, socket);
            }
        } catch (e) { 
            console.error("Token Error:", e.message);
            socket.emit('status', { message: "فشل التحقق من التوكن", ready: false, error: true }); 
        }
    });

    socket.on('logout-whatsapp', async () => {
        if (!activeUserId) return;
        console.log(`🚪 User ${activeUserId} logging out...`);
        
        const sock = whatsappClients[activeUserId];
        if (sock) { try { await sock.logout(); } catch(e){} delete whatsappClients[activeUserId]; }
        
        // Force Delete Session Folder
        const sessionDir = path.join(sessionsFolder, `session-${activeUserId}`);
        if (fs.existsSync(sessionDir)) { 
            fs.rmSync(sessionDir, { recursive: true, force: true }); 
            console.log(`🗑️ Deleted session folder for ${activeUserId}`);
        }
        
        db.run(`DELETE FROM clients WHERE ownerId = ?`, [activeUserId]);
        db.run(`DELETE FROM imported_clients WHERE ownerId = ?`, [activeUserId]);
        
        socket.emit('status', { message: "تم فصل الرقم ومسح البيانات.", ready: false });
        socket.emit('whatsapp-logged-out');
    });

    socket.on('check-numbers', async ({ numbers }) => {
        if (!systemSock) return socket.emit('filter-error', 'System Bot غير متصل! يرجى الاتصال بالدعم.');
        const allPhones = numbers.split(/\r?\n/).map(line => line.trim().replace(/\D/g, '')).filter(p => p.length >= 6);
        const totalNumbers = allPhones.length;
        let validCount = 0;
        let invalidCount = 0;
        socket.emit('log', { message: `⏳ بدأ فحص ${totalNumbers} رقم...`, color: 'blue' });
        for (let i = 0; i < totalNumbers; i += FILTER_BATCH_SIZE) {
            const batch = allPhones.slice(i, i + FILTER_BATCH_SIZE);
            for (const phone of batch) {
                try {
                    await sleep(300);
                    const id = `${phone}@s.whatsapp.net`;
                    const [result] = await systemSock.onWhatsApp(id);
                    if (result?.exists) { validCount++; socket.emit('filter-result', { phone: phone, status: 'valid' }); } 
                    else { invalidCount++; socket.emit('filter-result', { phone: phone, status: 'invalid' }); }
                } catch (err) { invalidCount++; socket.emit('filter-result', { phone: phone, status: 'invalid' }); }
            }
            if (i + FILTER_BATCH_SIZE < totalNumbers) { socket.emit('log', { message: `⏸️ استراحة لتجنب الحظر...`, color: 'orange' }); await sleep(2000); }
        }
        socket.emit('filter-complete', { valid: validCount, invalid: invalidCount });
    });

    // ... (Baqi les events bhal start-campaign, send-promo kima homa) ...
    socket.on('start-campaign-mode', async ({ promoId }) => {
        if (!activeUserId) return;
        const promos = readPromos(activeUserId);
        const selectedPromo = promos.find(p => p.id === promoId);
        if (!selectedPromo) return;
        db.get("SELECT chatbot_prompt FROM users WHERE id = ?", [activeUserId], (err, user) => {
            if (err || !user) return;
            activeCampaigns[activeUserId] = { promoText: selectedPromo.text, businessPrompt: user.chatbot_prompt || "متجر عام" };
            socket.emit('log', { message: '🚀 تم تفعيل وضع الحملة.', color: 'purple' });
        });
    });

    socket.on('save-valid-contacts', ({ numbers }) => {
        if (!activeUserId) return;
        const stmt = db.prepare(`INSERT OR IGNORE INTO imported_clients (phone, ownerId) VALUES (?, ?)`);
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            numbers.forEach(phone => { stmt.run(phone, activeUserId); });
            stmt.finalize();
            db.run("COMMIT", () => { socket.emit('sync-complete'); });
        });
    });

    socket.on('send-promo', async (data) => {
        const { phone, promoId, fromImported } = data;
        const sock = whatsappClients[activeUserId]; 
        if (!activeUserId || !sock) return socket.emit('send-promo-status', { success: false, phone, error: 'WhatsApp غير متصل' });
        const promos = readPromos(activeUserId);
        const promo = promos.find(p => p.id === promoId);
        if (!promo) return socket.emit('send-promo-status', { success: false, phone, error: 'العرض غير موجود' });
        try {
            const numberJid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
            const processedText = processSpintax(promo.text);
            if (promo.image && typeof promo.image === 'string') {
                const imagePath = path.join(promosUploadFolder, promo.image);
                if (fs.existsSync(imagePath)) { await sock.sendMessage(numberJid, { image: { url: imagePath }, caption: processedText }); } 
                else { await sock.sendMessage(numberJid, { text: processedText }); }
            } else if (processedText) { await sock.sendMessage(numberJid, { text: processedText }); }
            const table = fromImported ? "imported_clients" : "clients";
            db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone, activeUserId]);
            socket.emit('send-promo-status', { success: true, phone });
        } catch (err) { socket.emit('send-promo-status', { success: false, phone, error: err.message }); }
    });

    socket.on('sync-contacts', async () => { socket.emit('sync-complete'); });
    socket.on('disconnect', () => {});
});

// ================================================================= //
// ==================== 8. Routes & Passport ======================= //
// ================================================================= //
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/api/auth/google/callback",
}, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
        if (err) return done(err, null);
        if (user) return done(null, user);
        const trialEndsAt = new Date();
        trialEndsAt.setMinutes(trialEndsAt.getMinutes() + TRIAL_PERIOD_MINUTES);
        // ID must be string and unique
        const newUser = { id: Date.now().toString(), googleId: profile.id, name: profile.displayName, email: email, password: null, trialEndsAt: trialEndsAt.toISOString(), subscriptionEndsAt: null, subscription_status: 'trial' };
        db.run("INSERT INTO users (id, googleId, name, email, password, trialEndsAt, subscriptionEndsAt, subscription_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [newUser.id, newUser.googleId, newUser.name, newUser.email, newUser.password, newUser.trialEndsAt, newUser.subscriptionEndsAt, newUser.subscription_status], (err) => { if (err) return done(err, null); done(null, newUser); });
    });
}));

app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => { const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' }); res.redirect(`/dashboard.html?token=${token}`); });
app.post("/api/auth/signup", async (req, res) => { const { name, email, password } = req.body; if (!name || !email || !password) return res.status(400).json({ message: 'الاسم، البريد، وكلمة المرور مطلوبة' }); db.get("SELECT email FROM users WHERE email = ?", [email], async (err, user) => { if (user || pendingRegistrations[email]) return res.status(400).json({ message: 'هذا البريد الإلكتروني مسجل بالفعل' }); const hashedPassword = await bcrypt.hash(password, 12); const verificationToken = jwt.sign({ email }, JWT_SECRET, { expiresIn: '1h' }); const verificationLink = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verificationToken}`; const trialEndsAt = new Date(); trialEndsAt.setMinutes(trialEndsAt.getMinutes() + TRIAL_PERIOD_MINUTES); pendingRegistrations[email] = { name, email, password: hashedPassword, trialEndsAt: trialEndsAt.toISOString() }; const mailOptions = { from: SENDER_EMAIL, to: email, subject: 'تفعيل حسابك', html: `<p>مرحباً ${name}،</p><p>الرجاء النقر على الرابط أدناه لتفعيل حسابك:</p><a href="${verificationLink}">تفعيل الحساب</a>` }; await transporter.sendMail(mailOptions); res.status(200).json({ message: 'تم إرسال رابط التفعيل إلى بريدك الإلكتروني.' }); }); });
app.get('/api/auth/verify-email', (req, res) => { const { token } = req.query; if (!token) return res.status(400).send('رابط التفعيل غير صالح.'); try { const decoded = jwt.verify(token, JWT_SECRET); const { email } = decoded; const pendingData = pendingRegistrations[email]; if (!pendingData) return res.status(400).send('رمز التفعيل منتهي الصلاحية أو غير صحيح...'); db.get("SELECT email FROM users WHERE email = ?", [email], (err, user) => { if (user) { delete pendingRegistrations[email]; return res.status(400).send('هذا الحساب مسجل بالفعل.'); } const newUser = { id: Date.now().toString(), email: pendingData.email, name: pendingData.name, password: pendingData.password, trialEndsAt: pendingData.trialEndsAt, subscriptionEndsAt: null, subscription_status: 'trial' }; db.run("INSERT INTO users (id, email, name, password, trialEndsAt, subscriptionEndsAt, subscription_status) VALUES (?, ?, ?, ?, ?, ?, ?)", [newUser.id, newUser.email, newUser.name, newUser.password, newUser.trialEndsAt, newUser.subscriptionEndsAt, newUser.subscription_status], (err) => { if (err) return res.status(500).send('خطأ أثناء إنشاء حسابك.'); delete pendingRegistrations[email]; res.send(`<h1>تم تفعيل حسابك بنجاح!</h1><p>يمكنك الآن <a href="/login.html">تسجيل الدخول</a>.</p>`); }); }); } catch (error) { res.status(500).send('خطأ في التحقق من الرمز.'); } });
app.post("/api/auth/login", async (req, res) => { const { email, password } = req.body; db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => { if (err) return res.status(500).json({ message: "خطأ في الخادم." }); if (!user || (user.googleId && !user.password)) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة.' }); const isMatch = await bcrypt.compare(password, user.password); if (!isMatch) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة' }); const now = new Date(); const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null; const subscriptionEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null; const isActive = (trialEnds && trialEnds > now) || (subscriptionEnds && subscriptionEnds > now); const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: isActive ? '8h' : '1h' }); res.status(200).json({ token, subscriptionStatus: isActive ? 'active' : 'expired' }); }); });
app.post('/api/auth/logout', authMiddleware, async (req, res) => { const userId = req.userData.userId; delete activeCampaigns[userId]; const sock = whatsappClients[userId]; if (sock) { try { await sock.logout(); } catch(e){} delete whatsappClients[userId]; } const sessionDir = path.join(sessionsFolder, `session-${userId}`); if (fs.existsSync(sessionDir)) { fs.rmSync(sessionDir, { recursive: true, force: true }); } res.status(200).json({ message: 'تم تسجيل الخروج بنجاح.' }); });
app.post("/api/request-code", authMiddleware, async (req, res) => { const userId = req.userData.userId; const { durationName, durationDays } = req.body; db.get("SELECT name, email FROM users WHERE id = ?", [userId], async (err, user) => { if (err || !user) return res.status(404).json({ message: "لم يتم العثور على المستخدم." }); const newActivationCode = generateActivationCode(); db.run("UPDATE users SET activation_code = ?, activationRequest = ? WHERE id = ?", [newActivationCode, JSON.stringify({ durationName, durationDays }), userId], async (err) => { if (err) return res.status(500).json({ message: "خطأ في تحديث الطلب." }); const mailOptions = { from: SENDER_EMAIL, to: ADMIN_EMAIL, subject: `طلب تفعيل اشتراك جديد`, html: `<h1>طلب تفعيل</h1><p>المستخدم: ${user.name}</p><p>الرمز: ${newActivationCode}</p>` }; await transporter.sendMail(mailOptions); res.status(200).json({ success: true, message: "تم استلام الطلب." }); }); }); });
app.post("/api/activate-with-code", authMiddleware, async (req, res) => { const { activationCode } = req.body; const userId = req.userData.userId; if (!activationCode) return res.status(400).json({ message: "رمز التفعيل مطلوب." }); db.get("SELECT activationRequest, activation_code FROM users WHERE id = ?", [userId], (err, user) => { if (err || !user) return res.status(404).json({ message: "المستخدم غير موجود." }); if (!user.activation_code || user.activation_code !== activationCode.trim()) { return res.status(400).json({ message: "رمز التفعيل غير صحيح." }); } const { durationDays } = JSON.parse(user.activationRequest); const newSubscriptionEndDate = new Date(); newSubscriptionEndDate.setDate(newSubscriptionEndDate.getDate() + parseInt(durationDays, 10)); db.run("UPDATE users SET subscriptionEndsAt = ?, subscription_status = 'active', activation_code = NULL, activationRequest = NULL WHERE id = ?", [newSubscriptionEndDate.toISOString(), userId], (err) => { if (err) return res.status(500).json({ message: "خطأ." }); res.status(200).json({ success: true, message: "تم التفعيل بنجاح!" }); }); }); });

app.get("/contacts", authMiddleware, checkSubscription, (req, res) => { db.all(`SELECT id, name, phone FROM clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => res.json(rows || [])); });
app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => { db.all(`SELECT id, phone FROM imported_clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => res.json(rows || [])); });
app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => { const { userId } = req.userData; if (!req.file) return res.status(400).json({ error: "No file uploaded" }); const results = []; fs.createReadStream(req.file.path).pipe(csvParser({ headers: ['phone'], skipLines: 0 })).on('data', (data) => { const phone = String(data.phone || "").replace(/\D/g, ""); if (phone.length >= 8) results.push(phone); }).on('end', () => { fs.unlinkSync(req.file.path); const stmt = db.prepare(`INSERT OR IGNORE INTO imported_clients (phone, ownerId) VALUES (?, ?)`); let importedCount = 0; db.serialize(() => { db.run("BEGIN TRANSACTION"); results.forEach(phone => stmt.run(phone, userId, function (err) { if (!err && this.changes > 0) importedCount++; })); stmt.finalize(); db.run("COMMIT", () => res.status(200).json({ message: "تم الاستيراد.", imported: importedCount })); }); }); });
app.get("/promos", authMiddleware, checkSubscription, (req, res) => res.json(readPromos(req.userData.userId)));
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single("image"), (req, res) => { const { text } = req.body; const { userId } = req.userData; const promos = readPromos(userId); const newPromo = { id: Date.now(), text: text || "", image: req.file ? req.file.filename : null }; promos.push(newPromo); writePromos(userId, promos); res.json({ status: "success", promo: newPromo }); });
app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => { const promoId = parseInt(req.params.id); const { userId } = req.userData; let promos = readPromos(userId); const promo = promos.find(p => p.id === promoId); if (promo) { if (promo.image && typeof promo.image === 'string') { const imagePath = path.join(promosUploadFolder, promo.image); if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); } writePromos(userId, promos.filter(p => p.id !== promoId)); } res.json({ status: "deleted" }); });
app.delete("/api/delete-all-imported", authMiddleware, checkSubscription, (req, res) => { const { userId } = req.userData; db.run(`DELETE FROM imported_clients WHERE ownerId = ?`, [userId], function(err) { res.status(200).json({ status: "success", message: `تم الحذف.` }); }); });
app.get("/api/chatbot-prompt", authMiddleware, (req, res) => { db.get("SELECT chatbot_prompt FROM users WHERE id = ?", [req.userData.userId], (err, row) => { res.json({ prompt: row ? row.chatbot_prompt : "" }); }); });
app.post("/api/chatbot-prompt", authMiddleware, (req, res) => { db.run("UPDATE users SET chatbot_prompt = ? WHERE id = ?", [req.body.prompt, req.userData.userId], (err) => { res.json({ message: "تم الحفظ" }); }); });
app.get("/api/chatbot-status", authMiddleware, (req, res) => { db.get("SELECT is_chatbot_active FROM users WHERE id = ?", [req.userData.userId], (err, row) => { res.json({ isActive: row ? !!row.is_chatbot_active : true }); }); });
app.post("/api/chatbot-status", authMiddleware, (req, res) => { const statusValue = req.body.isActive ? 1 : 0; db.run("UPDATE users SET is_chatbot_active = ? WHERE id = ?", [statusValue, req.userData.userId], (err) => { res.json({ message: "تم التحديث" }); }); });
app.post("/api/generate-spintax", authMiddleware, async (req, res) => { try { const completion = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: "You are a copywriter..." }, { role: "user", content: req.body.text }] }); res.json({ spintax: completion.choices[0].message.content }); } catch (error) { res.status(500).json({ message: "Error" }); } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', authMiddleware, checkSubscription, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/activate', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'activate.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
