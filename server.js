// ================================================================= //
// ==================== 1. استدعاء المكتبات والإعدادات الأولية ===================== //
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
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ================================================================= //
// ========================= 2. المتغيرات العامة والتكوينات ======================= //
// ================================================================= //
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'abdo140693@gmail.com';
const SENDER_EMAIL = process.env.SENDER_EMAIL || ADMIN_EMAIL;
const TRIAL_PERIOD_MINUTES = 1440;

const promosUploadFolder = path.join(__dirname, "public", "promos");
const dbFile = path.join(__dirname, "main_data.db");
const uploadsFolder = path.join(__dirname, 'uploads');
const pendingRegistrations = {};

// كائن لتخزين عملاء واتساب النشطين لكل مستخدم
const whatsappClients = {};

// ================================================================= //
// ================= 3. تهيئة الخدمات وقواعد البيانات ================= //
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
        db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`, (err) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`Error adding column ${columnName} to ${tableName}:`, err.message);
            }
        });
    };
    addColumnIfNotExists('users', 'subscription_status', "TEXT DEFAULT 'trial'");
    addColumnIfNotExists('users', 'activation_code', 'TEXT');
});

const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: SENDER_EMAIL, pass: process.env.GMAIL_APP_PASS } });
if (!fs.existsSync(promosUploadFolder)) fs.mkdirSync(promosUploadFolder, { recursive: true });
if (!fs.existsSync(uploadsFolder)) fs.mkdirSync(uploadsFolder, { recursive: true });

const uploadLimits = { fileSize: 3 * 1024 * 1024 };
const uploadPromoImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, promosUploadFolder), filename: (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`) }), limits: uploadLimits });
const uploadCSV = multer({ dest: uploadsFolder, limits: uploadLimits });

// ================================================================= //
// ==================== 4. إعدادات Express Middleware =================== //
// ================================================================= //
app.use(cors());
app.use(express.json());
app.use(passport.initialize());
app.use('/promos', express.static(promosUploadFolder));
const authMiddleware = require('./middleware/auth');
const checkSubscription = require('./middleware/checkSubscription');

// ================================================================= //
// ======================= 5. دوال مساعدة (Helpers) ====================== //
// ================================================================= //
function readPromos(userId) { const userPromoPath = path.join(__dirname, 'user_data', `user_${userId}`); if (!fs.existsSync(userPromoPath)) fs.mkdirSync(userPromoPath, { recursive: true }); const p = path.join(userPromoPath, 'promos.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : []; }
function writePromos(userId, promos) { const userPromoPath = path.join(__dirname, 'user_data', `user_${userId}`); if (!fs.existsSync(userPromoPath)) fs.mkdirSync(userPromoPath, { recursive: true }); fs.writeFileSync(path.join(userPromoPath, 'promos.json'), JSON.stringify(promos, null, 2)); }
async function syncWhatsAppContacts(whatsappClient, ownerId) { try { const chats = await whatsappClient.getChats(); const privateChats = chats.filter(chat => !chat.isGroup && chat.id.user); if (privateChats.length === 0) return; const stmt = db.prepare(`INSERT OR IGNORE INTO clients (name, phone, ownerId) VALUES (?, ?, ?)`); db.serialize(() => { db.run("BEGIN TRANSACTION"); privateChats.forEach(chat => { const phone = chat.id.user; const name = chat.name || chat.contact?.pushname || `+${phone}`; stmt.run(name, phone, ownerId); }); stmt.finalize(); db.run("COMMIT"); }); } catch (err) { console.error(`[Sync] Error for user ${ownerId}:`, err); } }
function generateActivationCode() { const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let code = ''; for (let i = 0; i < 12; i++) { code += chars.charAt(Math.floor(Math.random() * chars.length)); if (i === 3 || i === 7) code += '-'; } return code; }

// ================================================================= //
// ================= 6. منطق Socket.IO وإدارة واتساب ================= //
// ================================================================= //
io.on('connection', (socket) => {
    let activeUserId = null;
    let client = null;
    socket.on('init-whatsapp', (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            activeUserId = decoded.userId;
            if (whatsappClients[activeUserId]) {
                client = whatsappClients[activeUserId];
                if (client.info) { socket.emit('status', { message: "WhatsApp متصل بالفعل!", ready: true }); }
            } else {
                console.log(`Creating new WhatsApp client for user: ${activeUserId}`);
                client = new Client({ authStrategy: new LocalAuth({ clientId: `session-${activeUserId}` }), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } });
                client.on("qr", (qr) => socket.emit('qr', qr));
                client.on("ready", async () => { socket.emit('status', { message: "WhatsApp متصل بنجاح!", ready: true }); await syncWhatsAppContacts(client, activeUserId); });
                client.on("disconnected", (reason) => { socket.emit('status', { message: `تم قطع الاتصال: ${reason}`, ready: false, error: true }); delete whatsappClients[activeUserId]; });
                client.initialize();
                whatsappClients[activeUserId] = client;
            }
        } catch (e) { socket.emit('status', { message: "فشل التحقق من التوكن", ready: false, error: true }); }
    });
    socket.on('send-promo', async (data) => {
        const { phone, promoId, fromImported } = data;
        if (!activeUserId || !whatsappClients[activeUserId]) return;
        const currentClient = whatsappClients[activeUserId];
        const promos = readPromos(activeUserId);
        const promo = promos.find(p => p.id === promoId);
        if (!promo) return socket.emit('send-promo-status', { success: false, phone, error: 'العرض غير موجود' });
        try {
            const numberId = `${phone.replace(/\D/g, "")}@c.us`;
            const media = MessageMedia.fromFilePath(path.join(promosUploadFolder, promo.image));
            await currentClient.sendMessage(numberId, media, { caption: promo.text });
            const table = fromImported ? "imported_clients" : "clients";
            db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone, activeUserId]);
            socket.emit('send-promo-status', { success: true, phone });
        } catch (err) { socket.emit('send-promo-status', { success: false, phone, error: err.message }); }
    });
    socket.on('disconnect', () => { console.log(`Socket disconnected for user: ${activeUserId}. WhatsApp session remains active.`); });
});

// ================================================================= //
// ==================== 7. إعدادات Passport.js ===================== //
// ================================================================= //
passport.use(new GoogleStrategy({ clientID: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, callbackURL: "/api/auth/google/callback" }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
        if (err) return done(err, null);
        if (user) return done(null, user);
        const trialEndsAt = new Date();
        trialEndsAt.setMinutes(trialEndsAt.getMinutes() + TRIAL_PERIOD_MINUTES);
        const newUser = { id: Date.now().toString(), googleId: profile.id, name: profile.displayName, email: email, password: null, trialEndsAt: trialEndsAt.toISOString(), subscriptionEndsAt: null, subscription_status: 'trial' };
        db.run("INSERT INTO users (id, googleId, name, email, password, trialEndsAt, subscriptionEndsAt, subscription_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [newUser.id, newUser.googleId, newUser.name, newUser.email, newUser.password, newUser.trialEndsAt, newUser.subscriptionEndsAt, newUser.subscription_status], (err) => { if (err) return done(err, null); done(null, newUser); });
    });
}));

// ================================================================= //
// ======================= 8. مسارات API (Routes) ======================= //
// ================================================================= //
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => { const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' }); res.redirect(`/dashboard.html?token=${token}`); });
app.post("/api/auth/signup", async (req, res) => { /* ... كود التسجيل يبقى كما هو ... */ });
app.get('/api/auth/verify-email', (req, res) => { /* ... كود التحقق من الإيميل يبقى كما هو ... */ });
app.post("/api/auth/login", async (req, res) => { /* ... كود تسجيل الدخول يبقى كما هو ... */ });
app.post('/api/auth/logout', authMiddleware, (req, res) => { /* ... كود تسجيل الخروج يبقى كما هو ... */ });
app.post("/api/request-code", authMiddleware, async (req, res) => { /* ... كود طلب الرمز يبقى كما هو ... */ });
app.post("/api/activate-with-code", authMiddleware, async (req, res) => { /* ... كود تفعيل الاشتراك يبقى كما هو ... */ });
app.get("/contacts", authMiddleware, checkSubscription, (req, res) => { db.all(`SELECT id, name, phone FROM clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => res.json(rows || [])); });
app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => { db.all(`SELECT id, phone FROM imported_clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => res.json(rows || [])); });
app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => { /* ... كود استيراد CSV يبقى كما هو ... */ });
app.get("/promos", authMiddleware, checkSubscription, (req, res) => res.json(readPromos(req.userData.userId)));
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single("image"), (req, res) => { /* ... كود إضافة عرض يبقى كما هو ... */ });
app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => { /* ... كود حذف عرض يبقى كما هو ... */ });

// ============ مسار جديد لحذف جميع العملاء المستوردين (تمت الإضافة هنا) ============ //
app.delete("/api/delete-all-imported", authMiddleware, checkSubscription, (req, res) => {
    const { userId } = req.userData;
    db.run(`DELETE FROM imported_clients WHERE ownerId = ?`, [userId], function(err) {
        if (err) {
            console.error("Database error while deleting imported clients:", err.message);
            return res.status(500).json({ message: "حدث خطأ في الخادم أثناء محاولة الحذف." });
        }
        res.status(200).json({ 
            status: "success", 
            message: `تم حذف ${this.changes} من العملاء المستوردين بنجاح.` 
        });
    });
});
// =================================================================================

// ================================================================= //
// ===================== 9. خدمة الملفات الثابتة والتشغيل =================== //
// ================================================================= //
app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', authMiddleware, checkSubscription, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/activate', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'activate.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
