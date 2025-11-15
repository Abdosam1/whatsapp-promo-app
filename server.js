// ================================================================= //
// ==================== 1. استدعاء المكتبات والإعدادات الأولية ===================== //
// ================================================================= //
require('dotenv').config();

// --- الوحدات الأساسية ---
const http = require('http');
const express = require("express");
const socketIo = require('socket.io');
const cors = require("cors");
const path = require("path");
const fs = require("fs");

// --- وحدات الأدوات والـ Middleware ---
const multer = require("multer");
const csvParser = require("csv-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require('nodemailer');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

// --- وحدات قاعدة البيانات والواتساب ---
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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'your-email@gmail.com';
const SENDER_EMAIL = ADMIN_EMAIL;
const promosUploadFolder = path.join(__dirname, "public", "promos");
const dbFile = path.join(__dirname, "main_data.db");
const uploadsFolder = path.join(__dirname, 'uploads');
const pendingRegistrations = {};

// ================================================================= //
// ================= 3. تهيئة الخدمات وقواعد البيانات ================= //
// ================================================================= //
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) { console.error("Fatal Error: Could not connect to database.", err); process.exit(1); }
  console.log("✅ Database connected successfully.");
});

db.serialize(() => {
  db.run(`PRAGMA journal_mode = WAL;`);
  db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
  db.run(`CREATE TABLE IF NOT EXISTS imported_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
  db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, googleId TEXT, name TEXT, email TEXT UNIQUE, password TEXT, trialEndsAt TEXT, subscriptionEndsAt TEXT, activationRequest TEXT)`);
});

const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: ADMIN_EMAIL, pass: process.env.GMAIL_APP_PASS } });
if (!fs.existsSync(promosUploadFolder)) fs.mkdirSync(promosUploadFolder, { recursive: true });
if (!fs.existsSync(uploadsFolder)) fs.mkdirSync(uploadsFolder, { recursive: true });
const uploadPromoImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, promosUploadFolder), filename: (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`) }) });
const uploadCSV = multer({ dest: uploadsFolder });

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
function readPromos(userId) {
    const userPromoPath = path.join(__dirname, 'user_data', `user_${userId}`);
    if (!fs.existsSync(userPromoPath)) fs.mkdirSync(userPromoPath, { recursive: true });
    const p = path.join(userPromoPath, 'promos.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
}
function writePromos(userId, promos) {
    const userPromoPath = path.join(__dirname, 'user_data', `user_${userId}`);
    if (!fs.existsSync(userPromoPath)) fs.mkdirSync(userPromoPath, { recursive: true });
    fs.writeFileSync(path.join(userPromoPath, 'promos.json'), JSON.stringify(promos, null, 2));
}

// ================================================================= //
// ================= 6. منطق Socket.IO وإدارة واتساب ================= //
// ================================================================= //
io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);
  let activeUserId = null;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `session-${socket.id}` }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  });

  socket.on('init-whatsapp', (token) => {
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        activeUserId = decoded.userId;
        console.log(`🚀 Initializing WhatsApp for user ${activeUserId}`);
        client.initialize();
    } catch (e) {
        socket.emit('status', { message: "فشل التحقق من الهوية", ready: false, error: true });
    }
  });

  client.on("qr", (qr) => socket.emit('qr', qr));
  client.on("ready", () => socket.emit('status', { message: "WhatsApp متصل وجاهز!", ready: true }));
  client.on("disconnected", () => socket.emit('status', { message: "تم قطع الاتصال!", ready: false, error: true }));

  socket.on('send-promo', async (data) => {
    const { phone, promoId, fromImported } = data;
    if (!activeUserId) return socket.emit('send-promo-status', { success: false, phone, error: 'User not authenticated' });

    const promos = readPromos(activeUserId);
    const promo = promos.find(p => p.id === promoId);
    
    if (!promo) return socket.emit('send-promo-status', { success: false, phone, error: 'العرض غير موجود' });

    try {
        const numberId = `${phone.replace(/\D/g, "")}@c.us`;
        const mediaPath = path.join(promosUploadFolder, promo.image);
        if (!fs.existsSync(mediaPath)) throw new Error('ملف الصورة غير موجود');
        
        const media = MessageMedia.fromFilePath(mediaPath);
        await client.sendMessage(numberId, media, { caption: promo.text });
        
        const table = fromImported ? "imported_clients" : "clients";
        db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone, activeUserId]);
        
        socket.emit('send-promo-status', { success: true, phone });
    } catch (err) {
        socket.emit('send-promo-status', { success: false, phone, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Disconnected: ${socket.id}. Destroying client.`);
    client.destroy().catch(console.error);
    const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-session-${socket.id}`);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
  });
});

// ================================================================= //
// ==================== 7. إعدادات Passport.js ===================== //
// ================================================================= //
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback", // تم تعديل المسار
  },
  (accessToken, refreshToken, profile, done) => {
    try {
        const email = profile.emails[0].value;
        db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
            if (err) return done(err, null);
            if (user) return done(null, user);

            const trialEndsAt = new Date(); trialEndsAt.setMinutes(trialEndsAt.getMinutes() + 15);
            const newUser = {
                id: Date.now().toString(), googleId: profile.id, email: email, name: profile.displayName,
                password: null, trialEndsAt: trialEndsAt.toISOString(), subscriptionEndsAt: null,
            };
            
            db.run("INSERT INTO users (id, googleId, email, name, password, trialEndsAt, subscriptionEndsAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [newUser.id, newUser.googleId, newUser.email, newUser.name, newUser.password, newUser.trialEndsAt, newUser.subscriptionEndsAt],
                (err) => { if (err) return done(err, null); done(null, newUser); }
            );
        });
    } catch(e) { return done(e, null); }
  }
));

// ================================================================= //
// ======================= 8. مسارات API (Routes) ======================= //
// ================================================================= //

// --- مسارات المصادقة والاشتراك (بدون /api) ---
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => {
    const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' });
    res.redirect(`/dashboard.html?token=${token}`);
});

app.post("/signup", async (req, res) => { /* ... كود إنشاء الحساب هنا ... */ });
app.post("/login", async (req, res) => { /* ... كود تسجيل الدخول هنا ... */ });
// ... بقية مسارات المصادقة هنا ...

// --- المسارات التي تطابق مشروعك المحلي ---
app.get("/contacts", authMiddleware, checkSubscription, (req, res) => {
    db.all(`SELECT id, name, phone FROM clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => {
        res.json(rows || []);
    });
});

app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => {
    db.all(`SELECT id, phone FROM imported_clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => {
        res.json(rows || []);
    });
});

app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => { /* ... كود الاستيراد هنا ... */ });
app.get("/promos", authMiddleware, (req, res) => { res.json(readPromos(req.userData.userId)); });
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single("image"), (req, res) => { /* ... كود إضافة العرض هنا ... */ });
app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => { /* ... كود حذف العرض هنا ... */ });

// ================================================================= //
// ===================== 9. خدمة الملفات الثابتة والتشغيل =================== //
// ================================================================= //
app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', authMiddleware, checkSubscription, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/activate', authMiddleware, (req, res) => res.sendFile(path.join(__dirname, 'public', 'activate.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
