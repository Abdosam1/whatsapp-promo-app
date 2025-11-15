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
const usersDbPath = path.join(__dirname, 'users.json');
const promosUploadFolder = path.join(__dirname, "public", "promos");
const dbFile = path.join(__dirname, "main_data.db");
const uploadsFolder = path.join(__dirname, 'uploads');
const pendingRegistrations = {};
const whatsappClients = {};

// ================================================================= //
// ================= 3. تهيئة الخدمات (Database, Nodemailer, etc) ================= //
// ================================================================= //
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) { console.error("Fatal Error: Could not connect to database.", err); process.exit(1); }
  console.log("✅ Database connected successfully.");
});
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
  db.run(`CREATE TABLE IF NOT EXISTS imported_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
});
const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: ADMIN_EMAIL, pass: process.env.GMAIL_APP_PASS } });
if (!fs.existsSync(promosUploadFolder)) fs.mkdirSync(promosUploadFolder, { recursive: true });
if (!fs.existsSync(uploadsFolder)) fs.mkdirSync(uploadsFolder, { recursive: true });

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
// ======================= 5. الدوال المساعدة (Helpers) ====================== //
// ================================================================= //
const readUsersFromFile = () => { try { if (!fs.existsSync(usersDbPath)) return []; const data = fs.readFileSync(usersDbPath, 'utf-8'); return data ? JSON.parse(data) : []; } catch (e) { console.error("Error reading users file:", e); return []; } };
const writeUsersToFile = (users) => { try { fs.writeFileSync(usersDbPath, JSON.stringify(users, null, 2)); } catch(e) { console.error("Error writing to users file:", e); } };
function generateActivationCode() { const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let code = ''; for (let i = 0; i < 12; i++) { code += chars.charAt(Math.floor(Math.random() * chars.length)); if (i === 3 || i === 7) code += '-'; } return code; }
function getUserDataPath(userId) { const userPath = path.join(__dirname, 'data', `user_${userId}`); if (!fs.existsSync(userPath)) fs.mkdirSync(userPath, { recursive: true }); return userPath; }
function readPromos(userId) { const p = path.join(getUserDataPath(userId), 'promos.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : []; }
function writePromos(userId, promos) { fs.writeFileSync(path.join(getUserDataPath(userId), 'promos.json'), JSON.stringify(promos, null, 2)); }
function isSubscriptionActive(user) { const now = new Date(); const subEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null; return subEnds && subEnds > now; }
function isTrialActive(user) { const now = new Date(); const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null; return trialEnds && trialEnds > now; }

// ================================================================= //
// ================= 6. منطق Socket.IO وإدارة واتساب ================= //
// ================================================================= //
// ... (Socket.IO code remains exactly the same, no changes needed here) ...
io.on('connection', (socket) => { /* ... */ });

// ================================================================= //
// ==================== 7. إعدادات Passport.js (Google Auth) ================== //
// ================================================================= //
// <<<<< TA3DIL: HNA RJE3NA L-CODE L-S7I7 DYAL GOOGLE STRATEGY >>>>>
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/api/auth/google/callback",
  },
  (accessToken, refreshToken, profile, done) => {
    try {
        const email = profile.emails[0].value;
        const users = readUsersFromFile();
        let user = users.find(u => u.email === email);

        if (user) return done(null, user);
        
        const trialEndsAt = new Date();
        trialEndsAt.setMinutes(trialEndsAt.getMinutes() + 15);
        const newUser = {
            id: Date.now().toString(),
            googleId: profile.id,
            email: email,
            name: profile.displayName,
            password: null,
            trialEndsAt: trialEndsAt.toISOString(),
            subscriptionEndsAt: null,
        };
        users.push(newUser);
        writeUsersToFile(users);
        return done(null, newUser);
    } catch(e) {
        return done(e, null);
    }
  }
));

// ================================================================= //
// ======================= 8. مسارات API (Routes) ======================= //
// ================================================================= //
const uploadPromoImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, promosUploadFolder), filename: (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`) }) });
const uploadCSV = multer({ dest: uploadsFolder });

// --- مسارات المصادقة (Authentication) ---
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => {
    const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' });
    res.redirect(`/dashboard.html?token=${token}`);
});
app.post("/api/auth/login", async (req, res) => { /* ... */ });
app.post("/api/auth/signup", async (req, res) => { /* ... */ });

// --- مسارات تفعيل الاشتراك ---
app.post("/api/activate-with-code", authMiddleware, async (req, res) => { /* ... */ });

// --- مسارات محمية (Protected Routes) ---
app.post("/promos", authMiddleware, checkSubscription, uploadPromoImage.single('image'), (req, res) => { /* ... */ });
app.get("/promos", authMiddleware, checkSubscription, (req, res) => { /* ... */ });
app.delete("/promos/:id", authMiddleware, checkSubscription, (req, res) => { /* ... */ });
app.delete("/imported-contacts", authMiddleware, checkSubscription, (req, res) => { /* ... */ });
app.post("/imported-contacts/import", authMiddleware, checkSubscription, uploadCSV.single('csvFile'), (req, res) => { /* ... */ });

// ================================================================= //
// ===================== 9. خدمة الملفات الثابتة والمسارات النهائية =================== //
// ================================================================= //
app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', authMiddleware, checkSubscription, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')) });
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ================================================================= //
// ========================= 10. تشغيل السيرفر ======================== //
// ================================================================= //
server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
