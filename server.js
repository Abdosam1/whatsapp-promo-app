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

// --- تعديل: تمت إضافة جداول جديدة للمستخدمين والعروض ---
db.serialize(() => {
  db.run(`PRAGMA journal_mode = WAL;`); // تحسين الأداء والتزامن
  db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
  db.run(`CREATE TABLE IF NOT EXISTS imported_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
  
  // --- الجداول الجديدة ---
  db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, 
      googleId TEXT, 
      name TEXT, 
      email TEXT UNIQUE, 
      password TEXT, 
      trialEndsAt TEXT, 
      subscriptionEndsAt TEXT,
      activationRequest TEXT 
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS promos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, 
      text TEXT, 
      image TEXT, 
      createdAt TEXT, 
      ownerId TEXT NOT NULL,
      FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
  )`);
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

const authMiddleware = require('./middleware/auth');
const checkSubscription = require('./middleware/checkSubscription');

// ================================================================= //
// ======================= 5. الدوال المساعدة (Helpers) ====================== //
// ================================================================= //

// --- تعديل: تمت إضافة دالة sleep ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function generateActivationCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let code = '';
    for (let i = 0; i < 12; i++) { code += chars.charAt(Math.floor(Math.random() * chars.length)); if (i === 3 || i === 7) code += '-'; }
    return code;
}

function isSubscriptionActive(user) { 
    if (!user || !user.subscriptionEndsAt) return false;
    const now = new Date(); 
    const subEnds = new Date(user.subscriptionEndsAt);
    return subEnds && subEnds > now; 
}

function isTrialActive(user) { 
    if (!user || !user.trialEndsAt) return false;
    const now = new Date();
    const trialEnds = new Date(user.trialEndsAt);
    return trialEnds && trialEnds > now; 
}


// ================================================================= //
// ================= 6. منطق Socket.IO وإدارة واتساب ================= //
// ================================================================= //

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

  // --- تعديل كبير: تم تحسين منطق إرسال العروض بشكل كامل ---
  socket.on('send-promo', async (data) => {
    try {
        const { phone, promoId, fromImported, token } = data;
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.userId;

        const client = whatsappClients[userId];
        if (!client || await client.getState() !== 'CONNECTED') {
            return socket.emit('send-promo-status', { success: false, phone, error: 'Client not ready' });
        }

        // جلب العرض من قاعدة البيانات بدلاً من ملف JSON
        const promo = await new Promise((resolve, reject) => {
            db.get("SELECT * FROM promos WHERE id = ? AND ownerId = ?", [promoId, userId], (err, row) => {
                if (err) return reject(new Error("Database error fetching promo."));
                resolve(row);
            });
        });

        if (!promo) return socket.emit('send-promo-status', { success: false, phone, error: 'Promo not found' });
        
        const numberId = `${phone.replace(/\D/g, "")}@c.us`;
        const mediaPath = path.join(promosUploadFolder, promo.image);

        if (!fs.existsSync(mediaPath)) return socket.emit('send-promo-status', { success: false, phone, error: 'Media file not found' });
        
        const media = MessageMedia.fromFilePath(mediaPath);
        await client.sendMessage(numberId, media, { caption: promo.text });
        
        const table = fromImported ? "imported_clients" : "clients";
        db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone.replace(/\D/g, ""), userId]);
        
        socket.emit('send-promo-status', { success: true, phone });

        // --- إضافة مهمة جداً: تأخير عشوائي لمنع الحظر ---
        const delay = Math.floor(Math.random() * 13000) + 7000; // بين 7 و 20 ثانية
        console.log(`Waiting for ${delay / 1000} seconds before next message...`);
        await sleep(delay);

    } catch (err) {
        console.error(`[SEND-PROMO-ERROR] to ${data.phone}:`, err);
        socket.emit('send-promo-status', { success: false, phone: data.phone, error: err.message });
    }
  });

  socket.on('disconnect', () => { console.log(`🔌 Socket disconnected: ${socket.id}`); });
});

// ================================================================= //
// ==================== 7. إعدادات Passport.js (Google Auth) ================== //
// ================================================================= //
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/api/auth/google/callback",
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
        const email = profile.emails[0].value;
        
        // --- تعديل: استخدام قاعدة البيانات ---
        db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
            if (err) return done(err, null);
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
            
            db.run("INSERT INTO users (id, googleId, email, name, password, trialEndsAt, subscriptionEndsAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [newUser.id, newUser.googleId, newUser.email, newUser.name, newUser.password, newUser.trialEndsAt, newUser.subscriptionEndsAt],
                (err) => {
                    if (err) return done(err, null);
                    return done(null, newUser);
                }
            );
        });
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

app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => {
    const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' });
    res.redirect(`/dashboard.html?token=${token}`);
});

// --- تعديل: استخدام قاعدة البيانات ---
app.post("/api/auth/signup", async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ message: 'الاسم، البريد، وكلمة المرور مطلوبة' });
        
        db.get("SELECT email FROM users WHERE email = ?", [email], async (err, user) => {
            if (err) return res.status(500).json({ message: 'خطأ في قاعدة البيانات' });
            if (user || pendingRegistrations[email]) {
                return res.status(400).json({ message: 'هذا البريد الإلكتروني مسجل بالفعل' });
            }
            
            const hashedPassword = await bcrypt.hash(password, 12);
            const verificationToken = jwt.sign({ email }, JWT_SECRET, { expiresIn: '1h' });
            const verificationLink = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verificationToken}`;
            
            const trialEndsAt = new Date();
            trialEndsAt.setMinutes(trialEndsAt.getMinutes() + 15);
            pendingRegistrations[email] = { name, email, password: hashedPassword, token: verificationToken, trialEndsAt: trialEndsAt.toISOString() };

            const mailOptions = {
                from: SENDER_EMAIL, to: email, subject: 'تفعيل حسابك',
                html: `<p>مرحباً ${name}،</p><p>الرجاء النقر على الرابط أدناه لتفعيل حسابك:</p><a href="${verificationLink}">تفعيل الحساب</a>`
            };
            
            await transporter.sendMail(mailOptions);
            res.status(200).json({ message: 'تم إرسال رابط التفعيل إلى بريدك الإلكتروني.' });
        });
    } catch (error) {
        res.status(500).json({ message: 'فشل التسجيل في السيرفر.', error: error.message });
    }
});

// --- تعديل: استخدام قاعدة البيانات ---
app.get('/api/auth/verify-email', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('رابط التفعيل غير صالح.');
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const { email } = decoded;
        const pendingData = pendingRegistrations[email];

        if (!pendingData || pendingData.token !== token) return res.status(400).send('رمز التفعيل منتهي الصلاحية أو غير صحيح.');
        
        db.get("SELECT email FROM users WHERE email = ?", [email], (err, user) => {
            if (err) return res.status(500).send('خطأ في قاعدة البيانات.');
            if (user) {
                delete pendingRegistrations[email];
                return res.status(400).send('الحساب مسجل بالفعل. يرجى تسجيل الدخول.');
            }

            const newUser = {
                id: Date.now().toString(),
                email: pendingData.email,
                name: pendingData.name,
                password: pendingData.password,
                trialEndsAt: pendingData.trialEndsAt,
                subscriptionEndsAt: null,
            };
            
            db.run("INSERT INTO users (id, email, name, password, trialEndsAt, subscriptionEndsAt) VALUES (?, ?, ?, ?, ?, ?)",
                [newUser.id, newUser.email, newUser.name, newUser.password, newUser.trialEndsAt, newUser.subscriptionEndsAt],
                (err) => {
                    if (err) return res.status(500).send('خطأ في قاعدة البيانات.');
                    delete pendingRegistrations[email];
                    res.send(`<h1>تم تفعيل حسابك بنجاح!</h1><p>يمكنك الآن <a href="/login.html">تسجيل الدخول</a>.</p>`);
                }
            );
        });
    } catch (error) {
        res.status(500).send('خطأ في التحقق من الإيميل.');
    }
});

// --- تعديل: استخدام قاعدة البيانات ---
app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
            if (err) return res.status(500).json({ message: 'خطأ في السيرفر' });
            if (!user) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة' });
            if (user.googleId && !user.password) return res.status(401).json({ message: 'هذا الحساب مسجل عبر جوجل.' });

            const isMatch = await bcrypt.compare(password, user.password);
            if (!isMatch) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة' });

            const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '8h' });
            res.status(200).json({ token });
        });
    } catch(e) {
        res.status(500).json({ message: 'خطأ في السيرفر' });
    }
});


// --- تعديل: استخدام قاعدة البيانات ---
app.post("/api/request-code", authMiddleware, async (req, res) => {
    try {
        const userId = req.userData.userId;
        const { durationName, durationDays } = req.body;

        db.get("SELECT * FROM users WHERE id = ?", [userId], async (err, user) => {
            if (err) return res.status(500).json({ message: "خطأ في الخادم." });
            if (!user) return res.status(404).json({ message: "لم يتم العثور على المستخدم." });
        
            const newActivationCode = generateActivationCode();
            const activationRequest = { code: newActivationCode, durationName, durationDays, requestedAt: new Date().toISOString() };
            
            db.run("UPDATE users SET activationRequest = ? WHERE id = ?", [JSON.stringify(activationRequest), userId], async (err) => {
                if (err) return res.status(500).json({ message: "خطأ في تحديث الطلب." });

                const mailOptions = {
                    from: SENDER_EMAIL, to: ADMIN_EMAIL,
                    subject: `طلب تفعيل اشتراك جديد من ${user.email}`,
                    html: `<h1>طلب تفعيل جديد</h1><p>المستخدم: ${user.name} (${user.email})</p><p>المدة: ${durationName}</p><h2>الرمز: ${newActivationCode}</h2>`
                };
                await transporter.sendMail(mailOptions);
                res.status(200).json({ success: true, message: "تم استلام طلب التفعيل بنجاح." });
            });
        });
    } catch (error) {
        res.status(500).json({ message: "حدث خطأ في الخادم أثناء طلب الرمز." });
    }
});

// --- تعديل: استخدام قاعدة البيانات ---
app.post("/api/activate-with-code", authMiddleware, async (req, res) => {
    try {
        const { activationCode } = req.body;
        const userId = req.userData.userId;
        if (!activationCode) return res.status(400).json({ message: "رمز التفعيل مطلوب." });

        db.get("SELECT * FROM users WHERE id = ?", [userId], (err, user) => {
            if (err) return res.status(500).json({ message: "خطأ في الخادم." });
            if (!user) return res.status(404).json({ message: "المستخدم غير موجود." });
            
            const activationRequest = user.activationRequest ? JSON.parse(user.activationRequest) : null;
            if (!activationRequest || activationRequest.code !== activationCode) {
                return res.status(400).json({ message: "رمز التفعيل غير صحيح أو منتهي الصلاحية." });
            }

            const { durationDays } = activationRequest;
            const today = new Date();
            const newSubscriptionEndDate = new Date(today.setDate(today.getDate() + parseInt(durationDays, 10)));
            
            db.run("UPDATE users SET subscriptionEndsAt = ?, activationRequest = NULL WHERE id = ?", [newSubscriptionEndDate.toISOString(), userId], (err) => {
                if (err) return res.status(500).json({ message: "خطأ في تحديث الاشتراك." });
                console.log(`Subscription activated for user ${user.email} until ${newSubscriptionEndDate.toISOString()}`);
                res.status(200).json({ success: true, message: "تم تفعيل الاشتراك بنجاح!" });
            });
        });
    } catch (error) {
        res.status(500).json({ message: "حدث خطأ في الخادم أثناء تفعيل الرمز." });
    }
});


// --- تعديل: استخدام قاعدة البيانات ---
app.get("/api/check-status", authMiddleware, (req, res) => {
    db.get("SELECT trialEndsAt, subscriptionEndsAt FROM users WHERE id = ?", [req.userData.userId], (err, user) => {
        if (err || !user) return res.status(404).json({ active: false, message: "User not found" });
        const isActive = isSubscriptionActive(user) || isTrialActive(user);
        res.status(200).json({ active: isActive });
    });
});

app.post("/api/whatsapp/logout", authMiddleware, async (req, res) => {
    const { userId } = req.userData;
    const client = whatsappClients[userId];
    try {
        if (client) {
            await client.logout();
            delete whatsappClients[userId];
        }
        const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-user-${userId}`);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        res.status(200).json({ message: "تم تسجيل الخروج بنجاح." });
    } catch (error) {
        res.status(500).json({ message: "فشل حذف الجلسة." });
    }
});

// --- تعديل: استخدام قاعدة البيانات ---
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single('image'), (req, res) => {
    const { userId } = req.userData;
    const { text } = req.body;
    const image = req.file ? req.file.filename : null;
    if (!text || !image) return res.status(400).json({ message: "نص العرض والصورة مطلوبان." });

    const sql = `INSERT INTO promos (text, image, createdAt, ownerId) VALUES (?, ?, ?, ?)`;
    const createdAt = new Date().toISOString();
    
    db.run(sql, [text, image, createdAt, userId], function(err) {
        if (err) return res.status(500).json({ message: "خطأ في السيرفر." });
        const newPromo = { id: this.lastID, text, image, createdAt };
        res.status(201).json({ message: "تم إضافة العرض بنجاح", promo: newPromo });
    });
});

// --- تعديل: استخدام قاعدة البيانات ---
app.get("/promos", authMiddleware, checkSubscription, (req, res) => {
    db.all("SELECT * FROM promos WHERE ownerId = ?", [req.userData.userId], (err, rows) => {
        if (err) return res.status(500).json({ message: "خطأ في السيرفر." });
        res.status(200).json(rows || []);
    });
});

// --- تعديل: استخدام قاعدة البيانات ---
app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => {
    const { userId } = req.userData;
    const promoId = parseInt(req.params.id, 10);

    db.get("SELECT image FROM promos WHERE id = ? AND ownerId = ?", [promoId, userId], (err, promo) => {
        if (err) return res.status(500).json({ message: "خطأ في السيرفر." });
        if (!promo) return res.status(404).json({ message: "العرض غير موجود." });

        const imagePath = path.join(promosUploadFolder, promo.image);
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        
        db.run("DELETE FROM promos WHERE id = ?", [promoId], (err) => {
            if (err) return res.status(500).json({ message: "خطأ في السيرفر." });
            res.status(200).json({ message: "تم حذف العرض بنجاح." });
        });
    });
});

app.get("/contacts", authMiddleware, checkSubscription, (req, res) => {
    db.all(`SELECT id, name, phone, last_sent FROM clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => {
        if (err) return res.status(500).json({ message: "خطأ في قاعدة البيانات." });
        res.status(200).json(rows || []);
    });
});

app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => {
    db.all(`SELECT id, phone, last_sent FROM imported_clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => {
        if (err) return res.status(500).json({ message: "خطأ في قاعدة البيانات." });
        res.status(200).json(rows || []);
    });
});

// --- تعديل: تحسين أداء استيراد CSV باستخدام TRANSACTION ---
app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => {
    const { userId } = req.userData;
    const filePath = req.file.path;
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csvParser({ headers: ['phone'], skipLines: 0 }))
      .on('data', (data) => {
        const phone = String(data.phone).replace(/\D/g, "");
        if (phone.length >= 8) results.push(phone);
      })
      .on('end', () => {
        fs.unlinkSync(filePath);
        if (results.length === 0) return res.status(400).json({ message: "لا يوجد أرقام صالحة." });
        
        let importedCount = 0;
        const stmt = db.prepare(`INSERT OR IGNORE INTO imported_clients (phone, ownerId) VALUES (?, ?)`);
        
        db.serialize(() => {
            db.run("BEGIN TRANSACTION");
            results.forEach(phone => {
                stmt.run(phone, userId, function(err) {
                    if (!err && this.changes > 0) importedCount++;
                });
            });
            stmt.finalize();
            db.run("COMMIT", (err) => {
                if (err) return res.status(500).json({ message: "خطأ أثناء الاستيراد." });
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================================================================= //
// ========================= 10. تشغيل السيرفر ======================== //
// ================================================================= //
server.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
