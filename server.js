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
const whatsappClients = {}; // **مهم جداً**: كائن لإدارة اتصالات واتساب النشطة

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
app.use('/promos', express.static(promosUploadFolder)); // للسماح بعرض صور العروض

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

// ... (Socket.IO code remains exactly the same, no changes needed here) ...
io.on('connection', (socket) => {
  console.log(`🔌 New socket connection: ${socket.id}`);

  socket.on('init-whatsapp', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.userId;

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

      whatsappClients[userId] = client;

      client.on("qr", qr => { socket.emit('qr', qr); });
      client.on("ready", async () => {
        console.log(`✅ WhatsApp client is ready for user ${userId}!`);
        socket.emit('status', { message: "WhatsApp متصل بنجاح!", ready: true });
      });
      client.on("disconnected", (reason) => {
        console.log(`❌ WhatsApp client for user ${userId} disconnected. Reason: ${reason}`);
        socket.emit('status', { message: `تم قطع الاتصال`, ready: false, error: true });
        client.destroy().catch(()=>{});
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
        const { phone, promoId } = data; // Token is now sent via headers, not socket
        const authHeader = socket.handshake.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) throw new Error('Authentication error');
        
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
        
        const fromImported = await new Promise((resolve, reject) => {
            db.get('SELECT 1 FROM imported_clients WHERE phone = ? AND ownerId = ?', [phone.replace(/\D/g, ""), userId], (err, row) => {
                if(err) reject(err);
                resolve(!!row);
            });
        });

        const table = fromImported ? "imported_clients" : "clients";
        db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone.replace(/\D/g, ""), userId]);
        
        socket.emit('send-promo-status', { success: true, phone });

    } catch (err) {
        socket.emit('send-promo-status', { success: false, phone: data.phone, error: err.message });
    }
  });

  socket.on('disconnect', () => { console.log(`🔌 Socket disconnected: ${socket.id}`); });
});


// ================================================================= //
// ==================== 7. إعدادات Passport.js (Google Auth) ================== //
// ================================================================= //
// ... (Passport.js code remains exactly the same) ...
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

// --- إعدادات Multer لرفع الملفات ---
const uploadPromoImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, promosUploadFolder), filename: (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`) }) });
const uploadCSV = multer({ dest: uploadsFolder });

// --- مسارات المصادقة (Authentication) ---
// ... (Auth routes remain the same) ...
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => {
    const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' });
    res.redirect(`/dashboard.html?token=${token}`);
});
app.post("/api/auth/signup", async (req, res) => { /* ... NO CHANGE ... */ });
app.get('/api/auth/verify-email', (req, res) => { /* ... NO CHANGE ... */ });
app.post("/api/auth/login", async (req, res) => { /* ... NO CHANGE ... */ });


// --- مسارات تفعيل الاشتراك ---
// ... (Subscription routes remain the same) ...
app.post("/api/request-code", authMiddleware, async (req, res) => { /* ... NO CHANGE ... */ });
app.post("/api/activate-with-code", authMiddleware, async (req, res) => { /* ... NO CHANGE ... */ });


// --- مسارات محمية (Protected Routes) ---
app.get("/api/check-status", authMiddleware, (req, res) => { /* ... NO CHANGE ... */ });
app.post("/api/whatsapp/logout", authMiddleware, async (req, res) => { /* ... NO CHANGE ... */ });

// <<<<< TA3DIL HNA 1: L-ROUTE TWELLI /promos BLA /addPromo >>>>>
app.post("/promos", authMiddleware, checkSubscription, uploadPromoImage.single('image'), (req, res) => {
    const { userId } = req.userData;
    const { text } = req.body;
    const image = req.file ? req.file.filename : null;
    if (!text || !image) return res.status(400).json({ message: "نص العرض والصورة مطلوبان." });
    try {
        const promos = readPromos(userId);
        const newPromo = { id: Date.now(), text, image, createdAt: new Date().toISOString() };
        promos.push(newPromo);
        writePromos(userId, promos);
        res.status(201).json({ message: "تم إضافة العرض بنجاح", promo: newPromo });
    } catch (error) {
        res.status(500).json({ message: "خطأ في السيرفر." });
    }
});

app.get("/promos", authMiddleware, checkSubscription, (req, res) => {
    try {
        res.status(200).json(readPromos(req.userData.userId));
    } catch (error) {
        res.status(500).json({ message: "خطأ في السيرفر." });
    }
});

// <<<<< TA3DIL HNA 2: L-ROUTE TWELLI /promos/:id BLA /deletePromo/:id >>>>>
app.delete("/promos/:id", authMiddleware, checkSubscription, (req, res) => {
    const { userId } = req.userData;
    const promoId = parseInt(req.params.id, 10);
    try {
        let promos = readPromos(userId);
        const promoIndex = promos.findIndex(p => p.id === promoId);
        if (promoIndex === -1) return res.status(404).json({ message: "العرض غير موجود." });
        
        const imagePath = path.join(promosUploadFolder, promos[promoIndex].image);
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        
        promos.splice(promoIndex, 1);
        writePromos(userId, promos);
        res.status(200).json({ message: "تم حذف العرض بنجاح." });
    } catch (error) {
        res.status(500).json({ message: "خطأ في السيرفر." });
    }
});

app.get("/contacts", authMiddleware, checkSubscription, (req, res) => { /* ... NO CHANGE ... */ });

app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => { /* ... NO CHANGE ... */ });

// <<<<< TA3DIL HNA 3: ZIDNA ROUTE JDIDA BACH N7EDFO L-IMPORTED CONTACTS >>>>>
app.delete("/imported-contacts", authMiddleware, checkSubscription, (req, res) => {
    const { userId } = req.userData;
    db.run(`DELETE FROM imported_clients WHERE ownerId = ?`, [userId], function(err) {
        if (err) return res.status(500).json({ message: "خطأ في قاعدة البيانات أثناء الحذف." });
        res.status(200).json({ message: `تم حذف ${this.changes} عميل مستورد بنجاح.` });
    });
});


// <<<<< TA3DIL HNA 4: L-ROUTE TWELLI /imported-contacts/import O L-FIELD YWELLI 'csvFile' >>>>>
app.post("/imported-contacts/import", authMiddleware, checkSubscription, uploadCSV.single('csvFile'), (req, res) => {
    const { userId } = req.userData;
    if (!req.file) {
        return res.status(400).json({ message: "لم يتم رفع أي ملف." });
    }
    const filePath = req.file.path;
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csvParser({ headers: ['phone'], skipLines: 0 }))
      .on('data', (data) => {
        const phone = String(data.phone).replace(/\D/g, "");
        if (phone.length >= 8) results.push(phone);
      })
      .on('end', () => {
        fs.unlinkSync(filePath); // N7ydo l-fichier temporaire
        if (results.length === 0) return res.status(400).json({ message: "لا يوجد أرقام صالحة في الملف." });
        
        const stmt = db.prepare(`INSERT OR IGNORE INTO imported_clients (phone, ownerId) VALUES (?, ?)`);
        let importedCount = 0;
        db.serialize(() => {
            results.forEach(phone => {
                stmt.run(phone, userId, function(err) {
                    if (!err && this.changes > 0) importedCount++;
                });
            });
            stmt.finalize((err) => {
                if(err) return res.status(500).json({ message: "خطأ أثناء الحفظ في قاعدة البيانات." });
                res.status(200).json({ message: "تم الاستيراد بنجاح.", imported: importedCount });
            });
        });
      })
      .on('error', (err) => {
        fs.unlinkSync(filePath);
        res.status(500).json({ message: "خطأ في معالجة الملف." });
      });
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
