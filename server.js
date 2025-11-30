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

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com'; 
const SENDER_EMAIL = process.env.SENDER_EMAIL || ADMIN_EMAIL;
const TRIAL_PERIOD_MINUTES = 1440;

// === PATHS ===
const promosUploadFolder = path.join(__dirname, "public", "promos");
const uploadsFolder = path.join(__dirname, 'uploads');
const dbFile = path.join(__dirname, "main_data.db");
const blogFile = path.join(__dirname, 'blog_posts.json');

// === SESSIONS FOLDERS ===
const sessionsFolder = path.join(__dirname, 'baileys_user_sessions'); 
const systemSessionFolder = path.join(__dirname, 'baileys_system_session'); 

// === ENSURE FOLDERS EXIST ===
[promosUploadFolder, uploadsFolder, sessionsFolder, systemSessionFolder].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Created directory: ${dir}`);
    }
});
if (!fs.existsSync(blogFile)) fs.writeFileSync(blogFile, '[]');

const pendingRegistrations = {};
const whatsappClients = {}; 
const activeCampaigns = {};
const stopFilterFlags = {}; 

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let systemSock = null; 

// ================================================================= //
// ================= 2. Multer Setup (Upload Fixed) ================ //
// ================================================================= //
const storagePromo = multer.diskStorage({
    destination: (req, file, cb) => cb(null, promosUploadFolder),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadPromoImage = multer({ 
    storage: storagePromo,
    limits: { fileSize: 5 * 1024 * 1024 } 
});

const uploadCSV = multer({ 
    dest: uploadsFolder,
    limits: { fileSize: 50 * 1024 * 1024 } 
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
app.use(passport.initialize());
app.use('/promos', express.static(promosUploadFolder));

const authMiddleware = require('./middleware/auth');
const checkSubscription = require('./middleware/checkSubscription');

// ================================================================= //
// ================= 3. Database & Helpers ========================= //
// ================================================================= //
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) { console.error("Fatal Error: DB Connect Failed", err); process.exit(1); }
  console.log("✅ Database connected.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
    db.run(`CREATE TABLE IF NOT EXISTS imported_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, googleId TEXT, name TEXT, email TEXT UNIQUE, password TEXT, trialEndsAt TEXT, subscriptionEndsAt TEXT, activationRequest TEXT)`);
    const addColumn = (t, c, type) => { db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`, (err) => {}); };
    addColumn('users', 'subscription_status', "TEXT DEFAULT 'trial'");
    addColumn('users', 'activation_code', 'TEXT');
    addColumn('users', 'chatbot_prompt', 'TEXT');
    addColumn('users', 'is_chatbot_active', "INTEGER DEFAULT 1");
});

function readPromos(userId) { const p = path.join(__dirname, 'user_data', `user_${userId}`, 'promos.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : []; }
function writePromos(userId, promos) { 
    const dir = path.join(__dirname, 'user_data', `user_${userId}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'promos.json'), JSON.stringify(promos, null, 2)); 
}
function generateActivationCode() { const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let code = ''; for (let i = 0; i < 12; i++) { code += chars.charAt(Math.floor(Math.random() * chars.length)); if (i === 3 || i === 7) code += '-'; } return code; }
function processSpintax(text) { if (!text) return ""; return text.replace(/\{([^{}]+)\}/g, (match, options) => { const choices = options.split('|'); return choices[Math.floor(Math.random() * choices.length)]; }); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function getRandomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1) + min); }
function checkAdmin(userId, cb) { db.get("SELECT email FROM users WHERE id = ?", [userId], (err, row) => { cb(row && row.email === ADMIN_EMAIL); }); }

const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: SENDER_EMAIL, pass: process.env.GMAIL_APP_PASS } });

// ================================================================= //
// ================= 5. SYSTEM BOT (SINGLE FILTER) ================= //
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
        
        if (qr) {
            console.log(`\n⚠️ [SYSTEM BOT] SCAN QR BELOW:\n`);
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) initSystemBot();
            else console.log('❌ System Bot Logged Out.');
        } else if (connection === 'open') {
            console.log('✅ System Bot is READY for Filtering!');
        }
    });
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
        }
    });

    // === SYNC CONTACTS TO DB ===
    sock.ev.on('contacts.upsert', async (contacts) => {
        if (!contacts || contacts.length === 0) return;
        const stmt = db.prepare(`INSERT OR IGNORE INTO clients (name, phone, ownerId) VALUES (?, ?, ?)`);
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            for (const contact of contacts) {
                if (contact.id.endsWith('@s.whatsapp.net')) {
                    const phone = contact.id.replace('@s.whatsapp.net', '');
                    const name = contact.name || contact.notify || phone;
                    stmt.run(name, phone, userId);
                }
            }
            stmt.finalize();
            db.run("COMMIT", () => {
                if(socket) socket.emit('sync-complete'); 
                console.log(`✅ Contacts synced for user ${userId}`);
            });
        });
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;
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
            if(!activeUserId) return;

            // Check if Session exists in File System
            const sessionDir = path.join(sessionsFolder, `session-${activeUserId}`);
            const hasSession = fs.existsSync(path.join(sessionDir, 'creds.json'));

            if (whatsappClients[activeUserId] && hasSession) {
                socket.emit('status', { message: "WhatsApp متصل بالفعل!", ready: true });
            } else {
                await startWhatsAppSession(activeUserId, socket);
            }
        } catch (e) { socket.emit('status', { message: "Token Error", ready: false, error: true }); }
    });

    socket.on('logout-whatsapp', async () => {
        if (!activeUserId) return;
        try { await whatsappClients[activeUserId].logout(); } catch(e){} delete whatsappClients[activeUserId];
        const dir = path.join(sessionsFolder, `session-${activeUserId}`);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        db.run(`DELETE FROM clients WHERE ownerId=?`, [activeUserId]);
        db.run(`DELETE FROM imported_clients WHERE ownerId=?`, [activeUserId]);
        socket.emit('whatsapp-logged-out');
    });

    // =======================================================
    // === FILTER LOGIC (STOP + PIC STRATEGY) ================
    // =======================================================
    socket.on('check-numbers', async ({ numbers }) => {
        if (!systemSock || !systemSock.user) {
            return socket.emit('filter-error', 'System Bot غير متصل! يرجى مسح QR في السيرفر.');
        }

        const allPhones = numbers.split(/\r?\n/).map(l => l.trim().replace(/\D/g, '')).filter(p => p.length >= 6);
        const totalNumbers = allPhones.length;
        let validCount = 0;
        let invalidCount = 0;

        stopFilterFlags[activeUserId] = false;

        socket.emit('log', { message: `⏳ بدأ الفحص الذكي (${totalNumbers} رقم)...`, color: 'purple' });

        for (let i = 0; i < totalNumbers; i++) {
            // STOP CHECK
            if (stopFilterFlags[activeUserId] === true) {
                socket.emit('filter-stopped');
                socket.emit('log', { message: "🛑 تم الإيقاف يدوياً.", color: 'red' });
                break;
            }

            const phone = allPhones[i];
            const jid = `${phone}@s.whatsapp.net`;

            // Anti-Ban
            if (i > 0 && i % 1000 === 0) await sleep(getRandomDelay(300000, 600000));
            else if (i > 0 && i % 100 === 0) await sleep(getRandomDelay(60000, 120000));
            
            await sleep(getRandomDelay(500, 2000));

            try {
                let found = false;
                
                // Strategy 1: Profile Picture
                try {
                    const ppUrl = await systemSock.profilePictureUrl(jid, 'image');
                    if (ppUrl) {
                        validCount++;
                        socket.emit('filter-result', { phone: phone, status: 'valid' });
                        console.log(`✅ FOUND (Pic): ${phone}`);
                        found = true;
                    }
                } catch (e) {}

                // Strategy 2: Presence Check (Fallback)
                if (!found) {
                    try {
                        const [result] = await systemSock.onWhatsApp(jid);
                        if (result?.exists) {
                            validCount++;
                            socket.emit('filter-result', { phone: phone, status: 'valid' });
                            console.log(`✅ FOUND (Presence): ${phone}`);
                        } else {
                            invalidCount++;
                            socket.emit('filter-result', { phone: phone, status: 'invalid' });
                        }
                    } catch (err2) {
                        invalidCount++;
                        socket.emit('filter-result', { phone: phone, status: 'invalid' });
                    }
                }
            } catch (err) {
                invalidCount++;
                socket.emit('filter-result', { phone, status: 'invalid' });
            }
        }

        if (!stopFilterFlags[activeUserId]) {
            socket.emit('filter-complete', { valid: validCount, invalid: invalidCount });
        }
    });

    socket.on('stop-filter', () => { if(activeUserId) stopFilterFlags[activeUserId] = true; });

    socket.on('start-campaign-mode', async ({ promoId }) => { /* ... */ });
    socket.on('send-promo', async (data) => {
        const { phone, promoId, fromImported } = data;
        const sock = whatsappClients[activeUserId];
        if(!activeUserId || !sock) return socket.emit('send-promo-status', {success:false, phone, error:'Not Connected'});
        
        const promos = readPromos(activeUserId);
        const promo = promos.find(p => p.id === promoId);
        if(!promo) return;

        try {
            const jid = `${phone.replace(/\D/g,'')}@s.whatsapp.net`;
            const txt = processSpintax(promo.text);
            if(promo.image) {
                const imgPath = path.join(promosUploadFolder, promo.image);
                if(fs.existsSync(imgPath)) await sock.sendMessage(jid, { image: { url: imgPath }, caption: txt });
                else await sock.sendMessage(jid, { text: txt });
            } else await sock.sendMessage(jid, { text: txt });
            
            const t = fromImported ? 'imported_clients' : 'clients';
            db.run(`UPDATE ${t} SET last_sent=? WHERE phone=? AND ownerId=?`, [new Date().toISOString(), phone, activeUserId]);
            socket.emit('send-promo-status', {success:true, phone});
        } catch(e) { socket.emit('send-promo-status', {success:false, phone, error:e.message}); }
    });
    
    socket.on('sync-contacts', () => socket.emit('sync-complete'));
    socket.on('disconnect', () => {});
});

// ==================== ROUTES ====================
passport.use(new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: "/api/auth/google/callback" }, (a,r,p,d) => {
    const email = p.emails[0].value;
    db.get("SELECT * FROM users WHERE email=?", [email], (e,u) => {
        if(e) return d(e);
        if(u) return d(null,u);
        const id=Date.now().toString(); db.run("INSERT INTO users (id,googleId,name,email,trialEndsAt) VALUES (?,?,?,?,?)", [id,p.id,p.displayName,email,new Date(Date.now()+TRIAL_PERIOD_MINUTES*60000).toISOString()], (err)=>d(err,{id,email}));
    });
}));

app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => {
    const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' });
    res.redirect(req.user.email === ADMIN_EMAIL ? `/admin.html?token=${token}` : `/dashboard.html?token=${token}`);
});

app.post("/api/auth/signup", async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'البيانات ناقصة' });
    const domains = ['moondyal.com','tempmail.com','10minutemail.com','guerrillamail.com','yopmail.com'];
    if (domains.includes(email.split('@')[1])) return res.status(400).json({ message: 'إيميل مؤقت غير مقبول' });
    
    try { const v = await validate({ email, validateDisposable:true, validateSMTP:false }); if(!v.valid) return res.status(400).json({message:'إيميل غير صالح'}); } catch(e){}
    
    db.get("SELECT email FROM users WHERE email=?", [email], async (err, user) => {
        if (user || pendingRegistrations[email]) return res.status(400).json({ message: 'مسجل مسبقاً' });
        pendingRegistrations[email] = { name, email, password: await bcrypt.hash(password,12), trialEndsAt: new Date(Date.now()+TRIAL_PERIOD_MINUTES*60000).toISOString() };
        const link = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${jwt.sign({email}, JWT_SECRET, {expiresIn:'1h'})}`;
        await transporter.sendMail({ from: SENDER_EMAIL, to: email, subject: 'Activate', html: `<a href="${link}">Click to activate</a>` });
        res.json({ message: 'تم الإرسال.' });
    });
});

app.get('/api/auth/verify-email', (req, res) => {
    try {
        const { email } = jwt.verify(req.query.token, JWT_SECRET);
        const p = pendingRegistrations[email];
        if (!p) return res.status(400).send('Invalid');
        const id = Date.now().toString();
        db.run("INSERT INTO users (id,email,name,password,trialEndsAt) VALUES (?,?,?,?,?)", [id,p.email,p.name,p.password,p.trialEndsAt], (err) => {
            if(err) return res.status(500).send('Error'); delete pendingRegistrations[email]; res.send('Account Active! <a href="/login.html">Login</a>');
        });
    } catch (e) { res.status(500).send('Expired'); }
});

app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email=?", [email], async (err, user) => {
        if (!user || !user.password || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: 'بيانات خاطئة' });
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, isAdmin: user.email === ADMIN_EMAIL });
    });
});

app.get("/promos", authMiddleware, checkSubscription, (req, res) => res.json(readPromos(req.userData.userId)));

app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single("image"), (req, res) => {
    try {
        const { text } = req.body;
        const { userId } = req.userData;
        const promos = readPromos(userId);
        const newPromo = { id: Date.now(), text: text || "", image: req.file ? req.file.filename : null };
        promos.push(newPromo);
        writePromos(userId, promos);
        res.json({ status: "success", promo: newPromo });
    } catch (err) { res.status(500).json({ message: "Server Error during upload." }); }
});

// === CSV Import ===
app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { userId } = req.userData;
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csvParser({ headers: ['phone'], skipLines: 0 }))
        .on('data', (data) => {
            const phone = String(data.phone || Object.values(data)[0] || "").replace(/\D/g, "");
            if (phone.length >= 8) results.push(phone);
        })
        .on('end', () => {
            fs.unlinkSync(req.file.path);
            const stmt = db.prepare(`INSERT OR IGNORE INTO imported_clients (phone, ownerId) VALUES (?, ?)`);
            let importedCount = 0;
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                results.forEach(phone => stmt.run(phone, userId, function(err) { if(!err && this.changes>0) importedCount++; }));
                stmt.finalize();
                db.run("COMMIT", () => res.status(200).json({ message: "Imported", imported: importedCount }));
            });
        });
});

app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => {
    const promoId = parseInt(req.params.id);
    const { userId } = req.userData;
    let promos = readPromos(userId);
    const promo = promos.find(p => p.id === promoId);
    if (promo) {
        if (promo.image) {
            const imgPath = path.join(promosUploadFolder, promo.image);
            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        }
        writePromos(userId, promos.filter(p => p.id !== promoId));
    }
    res.json({ status: "deleted" });
});

app.get('/api/blog-posts', (req, res) => { try{ res.json(JSON.parse(fs.readFileSync(blogFile))); } catch(e){res.json([]);} });
app.post('/api/blog-post', authMiddleware, (req, res) => { checkAdmin(req.userData.userId, (isAdmin) => { if(!isAdmin) return res.status(403).json({message:"Forbidden"}); try { const {title,summary,content,image}=req.body; const posts=fs.existsSync(blogFile)?JSON.parse(fs.readFileSync(blogFile)):[]; posts.unshift({id:Date.now(),title,summary,content,image,date:new Date().toISOString().split('T')[0]}); fs.writeFileSync(blogFile, JSON.stringify(posts,null,2)); res.json({success:true}); } catch(e){res.status(500).json({message:"Error"});} }); });
app.delete('/api/blog-post/:id', authMiddleware, (req, res) => { checkAdmin(req.userData.userId, (isAdmin) => { if(!isAdmin) return res.status(403).json({message:"Forbidden"}); try { let posts=JSON.parse(fs.readFileSync(blogFile)); posts=posts.filter(p=>p.id!==parseInt(req.params.id)); fs.writeFileSync(blogFile, JSON.stringify(posts,null,2)); res.json({success:true}); } catch(e){res.status(500).json({message:"Error"});} }); });
app.get('/api/is-admin', authMiddleware, (req,res) => checkAdmin(req.userData.userId, (isAdmin)=>res.json({isAdmin})));

app.delete("/api/delete-all-imported", authMiddleware, checkSubscription, (req, res) => { const { userId } = req.userData; db.run(`DELETE FROM imported_clients WHERE ownerId = ?`, [userId], function(err) { res.status(200).json({ status: "success", message: `تم الحذف.` }); }); });
app.get("/api/chatbot-prompt", authMiddleware, (req, res) => { db.get("SELECT chatbot_prompt FROM users WHERE id = ?", [req.userData.userId], (err, row) => { res.json({ prompt: row ? row.chatbot_prompt : "" }); }); });
app.post("/api/chatbot-prompt", authMiddleware, (req, res) => { db.run("UPDATE users SET chatbot_prompt = ? WHERE id = ?", [req.body.prompt, req.userData.userId], (err) => { res.json({ message: "تم الحفظ" }); }); });
app.get("/api/chatbot-status", authMiddleware, (req, res) => { db.get("SELECT is_chatbot_active FROM users WHERE id = ?", [req.userData.userId], (err, row) => { res.json({ isActive: row ? !!row.is_chatbot_active : true }); }); });
app.post("/api/chatbot-status", authMiddleware, (req, res) => { const statusValue = req.body.isActive ? 1 : 0; db.run("UPDATE users SET is_chatbot_active = ? WHERE id = ?", [statusValue, req.userData.userId], (err) => { res.json({ message: "تم التحديث" }); }); });
app.post("/api/generate-spintax", authMiddleware, async (req, res) => { try { const completion = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "system", content: "You are a copywriter..." }, { role: "user", content: req.body.text }] }); res.json({ spintax: completion.choices[0].message.content }); } catch (error) { res.status(500).json({ message: "Error" }); } });

app.post("/api/request-code", authMiddleware, async (req, res) => { const userId = req.userData.userId; const { durationName, durationDays } = req.body; db.get("SELECT name, email FROM users WHERE id = ?", [userId], async (err, user) => { if (err || !user) return res.status(404).json({ message: "User Not Found" }); const newActivationCode = generateActivationCode(); db.run("UPDATE users SET activation_code = ?, activationRequest = ? WHERE id = ?", [newActivationCode, JSON.stringify({ durationName, durationDays }), userId], async (err) => { if (err) return res.status(500).json({ message: "Error" }); const mailOptions = { from: SENDER_EMAIL, to: ADMIN_EMAIL, subject: `New Request`, html: `User: ${user.name} Code: ${newActivationCode}` }; await transporter.sendMail(mailOptions); res.status(200).json({ success: true }); }); }); });
app.post("/api/activate-with-code", authMiddleware, async (req, res) => { const { activationCode } = req.body; const userId = req.userData.userId; if (!activationCode) return res.status(400).json({ message: "Code required" }); db.get("SELECT activationRequest, activation_code FROM users WHERE id = ?", [userId], (err, user) => { if (err || !user || user.activation_code !== activationCode.trim()) return res.status(400).json({ message: "Invalid Code" }); const { durationDays } = JSON.parse(user.activationRequest); const newDate = new Date(); newDate.setDate(newDate.getDate() + parseInt(durationDays)); db.run("UPDATE users SET subscriptionEndsAt = ?, subscription_status = 'active', activation_code = NULL, activationRequest = NULL WHERE id = ?", [newDate.toISOString(), userId], (err) => { if (err) return res.status(500).json({ message: "Error" }); res.status(200).json({ success: true }); }); }); });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', authMiddleware, (req, res) => { checkAdmin(req.userData.userId, (isAdmin) => { if(!isAdmin) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); }); });
app.get('/dashboard', authMiddleware, checkSubscription, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/activate', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'activate.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
