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
const uploadsFolder = path.join(__dirname, 'uploads');


// --- كائنات لإدارة الحالة (State Management) ---
const pendingRegistrations = {};
const whatsappClients = {};

// ================================================================= //
// ================= 3. تهيئة الخدمات (Database, Nodemailer, etc) ================= //
// ================================================================= //

// --- تهيئة قاعدة بيانات SQLite ---
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error("Fatal Error: Could not connect to database.", err);
    process.exit(1);
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
    pass: process.env.GMAIL_APP_PASS
  }
});

// --- التأكد من وجود مجلدات الرفع ---
if (!fs.existsSync(promosUploadFolder)) fs.mkdirSync(promosUploadFolder, { recursive: true });
if (!fs.existsSync(uploadsFolder)) fs.mkdirSync(uploadsFolder, { recursive: true });


// ================================================================= //
// ==================== 4. إعدادات Express Middleware =================== //
// ================================================================= //
app.use(cors());
app.use(express.json());
app.use(passport.initialize());
app.use('/promos', express.static(promosUploadFolder));

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
    return data ? JSON.parse(data) : [];
  } catch (e) { console.error("Error reading users file:", e); return []; }
};

const writeUsersToFile = (users) => {
  try {
    fs.writeFileSync(usersDbPath, JSON.stringify(users, null, 2));
  } catch(e) { console.error("Error writing to users file:", e); }
};

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
  // ... (Your existing socket.io logic remains unchanged)
  console.log(`🔌 New socket connection: ${socket.id}`);
  socket.on('init-whatsapp', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.userId;
      if (whatsappClients[userId] && await whatsappClients[userId].getState() === 'CONNECTED') {
        socket.emit('status', { message: "WhatsApp متصل بالفعل!", ready: true }); return;
      }
      socket.emit('status', { message: "جاري تهيئة واتساب..." });
      const client = new Client({ authStrategy: new LocalAuth({ clientId: `user-${userId}` }), puppeteer: { headless: true, args: ['--no-sandbox'] } });
      whatsappClients[userId] = client;
      client.on("qr", qr => { socket.emit('qr', qr); });
      client.on("ready", () => { socket.emit('status', { message: "WhatsApp متصل بنجاح!", ready: true }); });
      client.on("disconnected", (reason) => { socket.emit('status', { message: `تم قطع الاتصال`, ready: false, error: true }); client.destroy().catch(()=>{}); delete whatsappClients[userId]; });
      client.initialize().catch(err => { socket.emit('status', { message: `فشل تهيئة واتساب`, ready: false, error: true }); delete whatsappClients[userId]; });
    } catch (error) { socket.emit('status', { message: 'فشل التحقق من الهوية.', error: true }); }
  });
  socket.on('send-promo', async (data) => {
    // ... (Your send-promo logic remains unchanged)
  });
  socket.on('disconnect', () => { console.log(`🔌 Socket disconnected: ${socket.id}`); });
});

// ================================================================= //
// ==================== 7. إعدادات Passport.js (Google Auth) ================== //
// ================================================================= //
passport.use(new GoogleStrategy({
    // ... (Your Google Strategy logic remains unchanged)
  },
  (accessToken, refreshToken, profile, done) => {
    // ...
  }
));

// ================================================================= //
// ======================= 8. مسارات API (Routes) ======================= //
// ================================================================= //

// --- إعدادات Multer لرفع الملفات ---
const uploadPromoImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, promosUploadFolder), filename: (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`) }) });
const uploadCSV = multer({ dest: uploadsFolder });

// --- مسارات المصادقة (Authentication) ---
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', /* ... */ );
app.post("/api/auth/signup", async (req, res) => { /* ... */ });
app.get('/api/auth/verify-email', (req, res) => { /* ... */ });
app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        const users = readUsersFromFile();
        const user = users.find(u => u.email === email);
        if (!user) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة' });
        if (user.googleId && !user.password) return res.status(401).json({ message: 'هذا الحساب مسجل عبر جوجل.' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة' });

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '8h' });
        // ملاحظة: لقد قمت بإزالة userId من هنا لتتناسب مع الكود الأخير لـ auth.js
        res.status(200).json({ token }); 
    } catch(e) {
        res.status(500).json({ message: 'خطأ في السيرفر' });
    }
});

// =============================================================================
// ====================   بداية كود تفعيل الاشتراك   ============================
// =============================================================================

// --- 1. مسار طلب رمز التفعيل ---
app.post("/api/request-code", authMiddleware, async (req, res) => {
    try {
        const userId = req.userData.userId;
        const { durationName, durationDays } = req.body;
        const users = readUsersFromFile();
        const user = users.find(u => u.id === userId);

        if (!user) {
            return res.status(404).json({ message: "لم يتم العثور على المستخدم." });
        }
        
        const newActivationCode = generateActivationCode();
        
        user.activationRequest = {
            code: newActivationCode,
            durationName: durationName,
            durationDays: durationDays,
            requestedAt: new Date().toISOString()
        };
        writeUsersToFile(users);

        const mailOptions = {
            from: SENDER_EMAIL,
            to: ADMIN_EMAIL,
            subject: `طلب تفعيل اشتراك جديد من ${user.email}`,
            html: `<h1>طلب تفعيل جديد</h1><p>المستخدم: ${user.name} (${user.email})</p><p>المدة: ${durationName}</p><h2>الرمز: ${newActivationCode}</h2>`
        };
        await transporter.sendMail(mailOptions);
        
        res.status(200).json({ success: true, message: "تم استلام طلب التفعيل بنجاح." });
    } catch (error) {
        console.error("Error in /api/request-code:", error);
        res.status(500).json({ message: "حدث خطأ في الخادم أثناء طلب الرمز." });
    }
});

// --- 2. مسار التحقق من الرمز وتفعيل الاشتراك ---
app.post("/api/activate-with-code", authMiddleware, async (req, res) => {
    try {
        const { activationCode } = req.body;
        const userId = req.userData.userId;

        if (!activationCode) {
            return res.status(400).json({ message: "رمز التفعيل مطلوب." });
        }

        const users = readUsersFromFile();
        const user = users.find(u => u.id === userId);

        if (!user) {
            return res.status(404).json({ message: "المستخدم غير موجود." });
        }

        if (!user.activationRequest || user.activationRequest.code !== activationCode) {
            return res.status(400).json({ message: "رمز التفعيل غير صحيح أو منتهي الصلاحية." });
        }

        const { durationDays } = user.activationRequest;
        
        const today = new Date();
        const newSubscriptionEndDate = new Date(today.setDate(today.getDate() + durationDays));
        
        user.subscriptionEndsAt = newSubscriptionEndDate.toISOString();
        delete user.activationRequest;
        writeUsersToFile(users);

        console.log(`Subscription activated for user ${user.email} until ${user.subscriptionEndsAt}`);

        res.status(200).json({ success: true, message: "تم تفعيل الاشتراك بنجاح!" });
    } catch (error) {
        console.error("Error in /api/activate-with-code:", error);
        res.status(500).json({ message: "حدث خطأ في الخادم أثناء تفعيل الرمز." });
    }
});

// =============================================================================
// ====================    نهاية كود تفعيل الاشتراك   ============================
// =============================================================================


// --- مسارات محمية (Protected Routes) ---
app.get("/api/check-status", authMiddleware, (req, res) => {
    // ... (Your existing check-status logic)
});
app.post("/api/whatsapp/logout", authMiddleware, async (req, res) => {
    // ... (Your existing logout logic)
});
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single('image'), (req, res) => {
    // ... (Your existing addPromo logic)
});
app.get("/promos", authMiddleware, checkSubscription, (req, res) => {
    // ... (Your existing get promos logic)
});
app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => {
    // ... (Your existing delete promo logic)
});
app.get("/contacts", authMiddleware, checkSubscription, (req, res) => {
    // ... (Your existing get contacts logic)
});
app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => {
    // ... (Your existing get imported contacts logic)
});
app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => {
    // ... (Your existing import csv logic)
});

// ================================================================= //
// ===================== 9. خدمة الملفات الثابتة والمسارات النهائية =================== //
// ================================================================= //
app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', authMiddleware, checkSubscription, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')) });
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
