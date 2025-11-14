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

// --- إعدادات التطبيق ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;

// --- المتغيرات الآمنة (Secrets) ---
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'your-email@gmail.com';
const SENDER_EMAIL = ADMIN_EMAIL;

// --- مسارات الملفات ---
const usersDbPath = path.join(__dirname, 'users.json');
const promosUploadFolder = path.join(__dirname, "public", "promos");
const dbFile = path.join(__dirname, "main_data.db");

// --- كائنات لإدارة الحالة (State Management) ---
const pendingRegistrations = {};
const whatsappClients = {}; // **مهم جداً**: كائن لإدارة اتصالات واتساب النشطة

// ================================================================= //
// ================= 3. تهيئة الخدمات (Database, Nodemailer, etc) ================= //
// ================================================================= //

// --- تهيئة قاعدة بيانات SQLite ---
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error("Fatal Error: Could not connect to database.", err);
    process.exit(1); // إيقاف التطبيق إذا لم يتمكن من الاتصال بقاعدة البيانات
  }
  console.log("✅ Database connected successfully.");
});
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
  db.run(`CREATE TABLE IF NOT EXISTS imported_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
});

// --- تهيئة Nodemailer (لإرسال الإيميلات) ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: ADMIN_EMAIL,
    pass: process.env.GMAIL_APP_PASS // تأكد من استخدام كلمة مرور التطبيقات
  }
});

// --- التأكد من وجود مجلد العروض الترويجية ---
if (!fs.existsSync(promosUploadFolder)) {
  fs.mkdirSync(promosUploadFolder, { recursive: true });
}

// ================================================================= //
// ==================== 4. إعدادات Express Middleware =================== //
// ================================================================= //
app.use(cors());
app.use(express.json());
app.use(passport.initialize());
app.use('/promos', express.static(promosUploadFolder)); // **مهم**: للسماح بعرض صور العروض

// --- استدعاء الـ Middlewares المخصصة ---
const authMiddleware = require('./middleware/auth');
const checkSubscription = require('./middleware/checkSubscription');

// ================================================================= //
// ======================= 5. الدوال المساعدة (Helpers) ====================== //
// ================================================================= //

const readUsersFromFile = () => {
  try {
    if (!fs.existsSync(usersDbPath)) return [];
    const data = fs.readFileSync(usersDbPath, 'utf-8');
    return JSON.parse(data);
  } catch (e) { console.error("Error reading users file:", e); return []; }
};

const writeUsersToFile = (users) => {
  try {
    fs.writeFileSync(usersDbPath, JSON.stringify(users, null, 2));
  } catch(e) { console.error("Error writing to users file:", e); }
};

// ... (باقي الدوال المساعدة مثل generateActivationCode, readPromos, etc. تبقى كما هي)
function generateActivationCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let code = '';
    for (let i = 0; i < 12; i++) { code += chars.charAt(Math.floor(Math.random() * chars.length)); if (i === 3 || i === 7) code += '-'; }
    return code;
}
function getUserDataPath(userId) { const userPath = path.join(__dirname, 'data', `user_${userId}`); if (!fs.existsSync(userPath)) fs.mkdirSync(userPath, { recursive: true }); return userPath; }
function readPromos(userId) { const p = path.join(getUserDataPath(userId), 'promos.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : []; }
function writePromos(userId, promos) { fs.writeFileSync(path.join(getUserDataPath(userId), 'promos.json'), JSON.stringify(promos, null, 2)); }
function isSubscriptionActive(user) { const now = new Date(); const subEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null; return subEnds && subEnds > now; }
function isTrialActive(user) { const now = new Date(); const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null; return trialEnds && trialEnds > now; }


// ================================================================= //
// ================= 6. منطق Socket.IO وإدارة واتساب ================= //
// ================================================================= //

io.on('connection', (socket) => {
  console.log(`🔌 New socket connection: ${socket.id}`);

  socket.on('init-whatsapp', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.userId;

      // **المنطق الجديد والمحسّن لإدارة اتصالات واتساب**
      if (whatsappClients[userId] && await whatsappClients[userId].getState() === 'CONNECTED') {
        console.log(`♻️ Reusing existing WhatsApp connection for user ${userId}`);
        socket.emit('status', { message: "WhatsApp متصل بالفعل!", ready: true });
        return;
      }
      
      console.log(`🚀 Initializing new WhatsApp client for user ${userId}`);
      socket.emit('status', { message: "جاري تهيئة واتساب..." });
      
      const client = new Client({
        authStrategy: new LocalAuth({ clientId: `user-${userId}` }),
        puppeteer: { 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'] 
        }
      });

      whatsappClients[userId] = client; // تخزين الاتصال

      client.on("qr", qr => {
        console.log(`QR code received for user ${userId}`);
        socket.emit('qr', qr);
      });

      client.on("ready", async () => {
        console.log(`✅ WhatsApp client is ready for user ${userId}!`);
        socket.emit('status', { message: "WhatsApp متصل بنجاح!", ready: true });
        // يمكنك إضافة تحديث جهات الاتصال هنا
      });

      client.on("disconnected", (reason) => {
        console.log(`❌ WhatsApp client for user ${userId} disconnected. Reason: ${reason}`);
        socket.emit('status', { message: `تم قطع الاتصال`, ready: false, error: true });
        client.destroy();
        delete whatsappClients[userId];
      });

      client.initialize().catch(err => {
        console.error(`Error initializing WhatsApp for user ${userId}:`, err);
        socket.emit('status', { message: `فشل تهيئة واتساب`, ready: false, error: true });
        delete whatsappClients[userId];
      });

    } catch (error) {
      console.error("Socket auth error:", error.message);
      socket.emit('status', { message: 'فشل التحقق من الهوية.', error: true });
    }
  });

  socket.on('send-promo', async (data) => {
    try {
        const { phone, promoId, fromImported, token } = data;
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        const client = whatsappClients[userId];
        if (!client || await client.getState() !== 'CONNECTED') {
            return socket.emit('send-promo-status', { success: false, phone, error: 'Client not ready' });
        }

        const promos = readPromos(userId);
        const promo = promos.find(p => p.id === promoId);
        if (!promo) return socket.emit('send-promo-status', { success: false, phone, error: 'Promo not found' });
        
        const numberId = `${phone.replace(/\D/g, "")}@c.us`;
        const mediaPath = path.join(promosUploadFolder, promo.image);

        if (!fs.existsSync(mediaPath)) return socket.emit('send-promo-status', { success: false, phone, error: 'Media file not found' });
        
        const media = MessageMedia.fromFilePath(mediaPath);
        await client.sendMessage(numberId, media, { caption: promo.text });
        
        const table = fromImported ? "imported_clients" : "clients";
        db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone.replace(/\D/g, ""), userId]);
        
        socket.emit('send-promo-status', { success: true, phone });

    } catch (err) {
        socket.emit('send-promo-status', { success: false, phone: data.phone, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Socket disconnected: ${socket.id}`);
  });
});

// ================================================================= //
// ==================== 7. إعدادات Passport.js (Google Auth) ================== //
// ================================================================= //
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/api/auth/google/callback",
    scope: ['profile', 'email']
  },
  (accessToken, refreshToken, profile, done) => {
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
  }
));


// ================================================================= //
// ======================= 8. مسارات API (Routes) ======================= //
// ================================================================= //

// --- مسارات المصادقة (Authentication) ---
app.get('/api/auth/google', passport.authenticate('google'));
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => {
    const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' });
    res.redirect(`/dashboard.html?token=${token}`);
});

app.post("/api/auth/signup", async (req, res) => { /* ... كود التسجيل لم يتغير ... */ });
app.get('/api/auth/verify-email', async (req, res) => { /* ... كود التحقق لم يتغير ... */ });
app.post("/api/auth/login", async (req, res) => { /* ... كود تسجيل الدخول لم يتغير ... */ });

// --- مسارات محمية (Protected Routes) ---
app.get("/api/check-status", authMiddleware, (req, res) => {
    const users = readUsersFromFile();
    const user = users.find(u => u.id === req.userData.userId);
    if (!user) return res.status(404).json({ active: false, message: "User not found" });
    const isActive = isSubscriptionActive(user) || isTrialActive(user);
    res.status(200).json({ active: isActive });
});

app.post("/api/whatsapp/logout", authMiddleware, async (req, res) => {
    const { userId } = req.userData;
    const client = whatsappClients[userId];
    try {
        if (client) {
            await client.logout(); // تسجيل الخروج من واتساب
            delete whatsappClients[userId];
        }
        // حذف ملفات الجلسة المحلية لضمان نظافة الخروج
        const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-user-${userId}`);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        res.status(200).json({ message: "تم تسجيل الخروج بنجاح." });
    } catch (error) {
        console.error(`Logout error for user ${userId}:`, error);
        res.status(500).json({ message: "فشل حذف الجلسة." });
    }
});


// ... (باقي مسارات الـ API مثل /promos, /contacts, etc. تبقى كما هي وتستخدم Middlewares)
const uploadPromoImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, promosUploadFolder), filename: (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`) }) });
const uploadCSV = multer({ dest: "uploads/" });
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single('image'), (req, res) => { /* ... الكود ... */ });
app.get("/promos", authMiddleware, checkSubscription, (req, res) => { /* ... الكود ... */ });
// ... etc.

// ================================================================= //
// ===================== 9. خدمة الملفات الثابتة والمسارات النهائية =================== //
// ================================================================= //
app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', authMiddleware, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')) });
app.get('/activate', authMiddleware, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'activate.html')) });

// --- مسار Catch-all (يجب أن يكون في النهاية) ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ================================================================= //
// ========================= 10. تشغيل السيرفر ======================== //
// ================================================================= //
server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
