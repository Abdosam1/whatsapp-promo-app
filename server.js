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
io.on('connection', (socket) => { let activeUserId = null; const client = new Client({ authStrategy: new LocalAuth({ clientId: `session-${socket.id}` }), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] } }); socket.on('init-whatsapp', (token) => { try { const decoded = jwt.verify(token, JWT_SECRET); activeUserId = decoded.userId; client.initialize(); } catch (e) { socket.emit('status', { message: "فشل التحقق", ready: false, error: true }); } }); client.on("qr", (qr) => socket.emit('qr', qr)); client.on("ready", async () => { socket.emit('status', { message: "WhatsApp متصل!", ready: true }); await syncWhatsAppContacts(client, activeUserId); }); client.on("disconnected", () => socket.emit('status', { message: "تم قطع الاتصال!", ready: false, error: true })); socket.on('send-promo', async (data) => { const { phone, promoId, fromImported } = data; if (!activeUserId) return; const promos = readPromos(activeUserId); const promo = promos.find(p => p.id === promoId); if (!promo) return socket.emit('send-promo-status', { success: false, phone, error: 'العرض غير موجود' }); try { const numberId = `${phone.replace(/\D/g, "")}@c.us`; const media = MessageMedia.fromFilePath(path.join(promosUploadFolder, promo.image)); await client.sendMessage(numberId, media, { caption: promo.text }); const table = fromImported ? "imported_clients" : "clients"; db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone, activeUserId]); socket.emit('send-promo-status', { success: true, phone }); } catch (err) { socket.emit('send-promo-status', { success: false, phone, error: err.message }); } }); socket.on('disconnect', () => { client.destroy().catch(console.error); const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-session-${socket.id}`); if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true }); }); });

// ================================================================= //
// ==================== 7. إعدادات Passport.js ===================== //
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
        const newUser = { id: Date.now().toString(), googleId: profile.id, name: profile.displayName, email: email, password: null, trialEndsAt: trialEndsAt.toISOString(), subscriptionEndsAt: null, subscription_status: 'trial' };
        db.run("INSERT INTO users (id, googleId, name, email, password, trialEndsAt, subscriptionEndsAt, subscription_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [newUser.id, newUser.googleId, newUser.name, newUser.email, newUser.password, newUser.trialEndsAt, newUser.subscriptionEndsAt, newUser.subscription_status],
            (err) => { if (err) return done(err, null); done(null, newUser); }
        );
    });
}));

// ================================================================= //
// ======================= 8. مسارات API (Routes) ======================= //
// ================================================================= //

// --- 8.1: مسارات المصادقة والتسجيل ---
app.get('/api/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/api/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html', session: false }), (req, res) => {
    const token = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '8h' });
    res.redirect(`/dashboard.html?token=${token}`);
});

app.post("/api/auth/signup", async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'الاسم، البريد، وكلمة المرور مطلوبة' });
    db.get("SELECT email FROM users WHERE email = ?", [email], async (err, user) => {
        if (user || pendingRegistrations[email]) return res.status(400).json({ message: 'هذا البريد الإلكتروني مسجل بالفعل' });
        const hashedPassword = await bcrypt.hash(password, 12);
        const verificationToken = jwt.sign({ email }, JWT_SECRET, { expiresIn: '1h' });
        const verificationLink = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verificationToken}`;
        const trialEndsAt = new Date();
        trialEndsAt.setMinutes(trialEndsAt.getMinutes() + TRIAL_PERIOD_MINUTES);
        pendingRegistrations[email] = { name, email, password: hashedPassword, trialEndsAt: trialEndsAt.toISOString() };
        const mailOptions = { from: SENDER_EMAIL, to: email, subject: 'تفعيل حسابك', html: `<p>مرحباً ${name}،</p><p>الرجاء النقر على الرابط أدناه لتفعيل حسابك:</p><a href="${verificationLink}">تفعيل الحساب</a>` };
        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: 'تم إرسال رابط التفعيل إلى بريدك الإلكتروني.' });
    });
});

app.get('/api/auth/verify-email', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('رابط التفعيل غير صالح.');
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const { email } = decoded;
        const pendingData = pendingRegistrations[email];
        if (!pendingData) return res.status(400).send('رمز التفعيل منتهي الصلاحية أو غير صحيح. ربما تم إعادة تشغيل الخادم، يرجى التسجيل مرة أخرى.');
        db.get("SELECT email FROM users WHERE email = ?", [email], (err, user) => {
            if (user) { delete pendingRegistrations[email]; return res.status(400).send('هذا الحساب مسجل بالفعل.'); }
            const newUser = { id: Date.now().toString(), email: pendingData.email, name: pendingData.name, password: pendingData.password, trialEndsAt: pendingData.trialEndsAt, subscriptionEndsAt: null, subscription_status: 'trial' };
            db.run("INSERT INTO users (id, email, name, password, trialEndsAt, subscriptionEndsAt, subscription_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [newUser.id, newUser.email, newUser.name, newUser.password, newUser.trialEndsAt, newUser.subscriptionEndsAt, newUser.subscription_status],
                (err) => {
                    if (err) return res.status(500).send('حدث خطأ أثناء إنشاء حسابك في قاعدة البيانات.');
                    delete pendingRegistrations[email];
                    res.send(`<h1>تم تفعيل حسابك بنجاح!</h1><p>يمكنك الآن <a href="/login.html">تسجيل الدخول</a>.</p>`);
                }
            );
        });
    } catch (error) { res.status(500).send('خطأ في التحقق من الرمز.'); }
});

// --- [ هذا هو التعديل الأهم الذي طلبته ] ---
app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) return res.status(500).json({ message: "خطأ في الخادم." });
        if (!user || (user.googleId && !user.password)) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة أو الحساب مسجل عبر جوجل.' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة' });

        // التحقق من صلاحية الاشتراك قبل إعطاء التوكن
        const now = new Date();
        const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
        const subscriptionEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;
        const isActive = (trialEnds && trialEnds > now) || (subscriptionEnds && subscriptionEnds > now);

        if (isActive) {
            const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '8h' });
            res.status(200).json({ token, subscriptionStatus: 'active' });
        } else {
            const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' }); // توكن قصير فقط لصفحة التفعيل
            res.status(200).json({ token, subscriptionStatus: 'expired' });
        }
    });
});

// --- 8.2: مسارات تفعيل الاشتراك ---
app.post("/api/request-code", authMiddleware, async (req, res) => {
    const userId = req.userData.userId;
    const { durationName, durationDays } = req.body;
    db.get("SELECT name, email FROM users WHERE id = ?", [userId], async (err, user) => {
        if (err || !user) return res.status(404).json({ message: "لم يتم العثور على المستخدم." });
        const newActivationCode = generateActivationCode();
        db.run("UPDATE users SET activation_code = ?, activationRequest = ? WHERE id = ?",
            [newActivationCode, JSON.stringify({ durationName, durationDays }), userId],
            async (err) => {
                if (err) return res.status(500).json({ message: "خطأ في تحديث الطلب." });
                const mailOptions = {
                    from: SENDER_EMAIL,
                    to: ADMIN_EMAIL,
                    subject: `طلب تفعيل اشتراك جديد من ${user.email}`,
                    html: `<h1>طلب تفعيل جديد</h1><p>المستخدم: ${user.name} (${user.email})</p><p>المدة: ${durationName}</p><h2>الرمز: ${newActivationCode}</h2>`
                };
                await transporter.sendMail(mailOptions);
                res.status(200).json({ success: true, message: "تم استلام طلب التفعيل بنجاح. سيتم التواصل معك." });
            }
        );
    });
});

app.post("/api/activate-with-code", authMiddleware, async (req, res) => {
    const { activationCode } = req.body;
    const userId = req.userData.userId;
    if (!activationCode) return res.status(400).json({ message: "رمز التفعيل مطلوب." });
    db.get("SELECT activationRequest, activation_code FROM users WHERE id = ?", [userId], (err, user) => {
        if (err || !user) return res.status(404).json({ message: "المستخدم غير موجود." });
        if (!user.activation_code || user.activation_code !== activationCode.trim()) { return res.status(400).json({ message: "رمز التفعيل غير صحيح." }); }
        const activationRequest = user.activationRequest ? JSON.parse(user.activationRequest) : null;
        if (!activationRequest || !activationRequest.durationDays) { return res.status(400).json({ message: "لم يتم العثور على طلب تفعيل. يرجى طلب رمز جديد." }); }
        const { durationDays } = activationRequest;
        const newSubscriptionEndDate = new Date();
        newSubscriptionEndDate.setDate(newSubscriptionEndDate.getDate() + parseInt(durationDays, 10));
        db.run("UPDATE users SET subscriptionEndsAt = ?, subscription_status = 'active', activation_code = NULL, activationRequest = NULL WHERE id = ?",
            [newSubscriptionEndDate.toISOString(), userId], (err) => {
                if (err) return res.status(500).json({ message: "خطأ في تحديث الاشتراك." });
                res.status(200).json({ success: true, message: "تم تفعيل الاشتراك بنجاح!" });
            }
        );
    });
});

// --- 8.3: المسارات المحمية (التي تتطلب اشتراكاً صالحاً) ---
app.get("/contacts", authMiddleware, checkSubscription, (req, res) => { db.all(`SELECT id, name, phone FROM clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => res.json(rows || [])); });
app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => { db.all(`SELECT id, phone FROM imported_clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => res.json(rows || [])); });
app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => { const { userId } = req.userData; if (!req.file) return res.status(400).json({ error: "No file uploaded" }); const results = []; fs.createReadStream(req.file.path).pipe(csvParser({ headers: ['phone'], skipLines: 0 })).on('data', (data) => { const phone = String(data.phone || "").replace(/\D/g, ""); if (phone.length >= 8) results.push(phone); }).on('end', () => { fs.unlinkSync(req.file.path); if (results.length === 0) return res.status(400).json({ message: "لا يوجد أرقام صالحة." }); const stmt = db.prepare(`INSERT OR IGNORE INTO imported_clients (phone, ownerId) VALUES (?, ?)`); let importedCount = 0; db.serialize(() => { db.run("BEGIN TRANSACTION"); results.forEach(phone => stmt.run(phone, userId, function (err) { if (!err && this.changes > 0) importedCount++; })); stmt.finalize(); db.run("COMMIT", () => res.status(200).json({ message: "تم الاستيراد بنجاح.", imported: importedCount })); }); }); });
app.get("/promos", authMiddleware, checkSubscription, (req, res) => res.json(readPromos(req.userData.userId)));
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single("image"), (req, res) => { const { text } = req.body; const { userId } = req.userData; if (!req.file) return res.status(400).json({ message: "Image file is required." }); const promos = readPromos(userId); const newPromo = { id: Date.now(), text, image: req.file.filename }; promos.push(newPromo); writePromos(userId, promos); res.json({ status: "success", promo: newPromo }); });
app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => { const promoId = parseInt(req.params.id); const { userId } = req.userData; let promos = readPromos(userId); const promo = promos.find(p => p.id === promoId); if (promo) { const imagePath = path.join(promosUploadFolder, promo.image); if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); writePromos(userId, promos.filter(p => p.id !== promoId)); } res.json({ status: "deleted" }); });

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
