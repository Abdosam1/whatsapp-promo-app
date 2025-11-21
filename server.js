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
const { OpenAI } = require("openai");
const axios = require('axios');

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

const whatsappClients = {};
const activeCampaigns = {};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    addColumnIfNotExists('users', 'chatbot_prompt', 'TEXT');
    addColumnIfNotExists('users', 'is_chatbot_active', "INTEGER DEFAULT 1");
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
                
                client.on("ready", async () => {
                    socket.emit('status', { message: "WhatsApp متصل بنجاح!", ready: true });
                    await syncWhatsAppContacts(client, activeUserId);
                    
                    client.on('message', async (message) => {
                        if (message.fromMe || message.isGroup) return;
                        const campaignInfo = activeCampaigns[activeUserId];
                        if (!campaignInfo) return;
                        db.get("SELECT is_chatbot_active FROM users WHERE id = ?", [activeUserId], async (err, user) => {
                            if (err || !user || !user.is_chatbot_active) { return; }
                            const userMessage = message.body;
                            const fromNumber = message.from;
                            try {
                                const completion = await openai.chat.completions.create({
                                    model: "gpt-3.5-turbo",
                                    messages: [
                                        { role: "system", content: `You are a helpful WhatsApp assistant. Business context: "${campaignInfo.businessPrompt}". You are in a campaign for this promotion: "${campaignInfo.promoText}". Answer questions based ONLY on this context. If unrelated, politely decline. Be concise, friendly, and use the customer's language.` },
                                        { role: "user", content: userMessage }
                                    ]
                                });
                                const replyText = completion.choices[0].message.content;
                                await client.sendMessage(fromNumber, replyText);
                            } catch (error) { console.error("[AI Chatbot] Error:", error.message); }
                        });
                    });
                });

                client.on("disconnected", (reason) => {
                    socket.emit('status', { message: `تم قطع الاتصال: ${reason}`, ready: false, error: true });
                    delete whatsappClients[activeUserId];
                    delete activeCampaigns[activeUserId];
                });

                client.initialize();
                whatsappClients[activeUserId] = client;
            }
        } catch (e) { socket.emit('status', { message: "فشل التحقق من التوكن", ready: false, error: true }); }
    });

    // --- 1. كود فصل الواتساب وحذف البيانات (Disconnect & Wipe) ---
    socket.on('logout-whatsapp', async () => {
        if (!activeUserId) return;

        console.log(`[Switch Account] User ${activeUserId} requested disconnect & data wipe.`);

        if (whatsappClients[activeUserId]) {
            try {
                await whatsappClients[activeUserId].destroy();
            } catch (err) {
                console.error("Error destroying client:", err);
            }
            delete whatsappClients[activeUserId];
            delete activeCampaigns[activeUserId];
        }

        const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-session-${activeUserId}`);
        if (fs.existsSync(sessionPath)) {
            fs.rm(sessionPath, { recursive: true, force: true }, (err) => {
                if (err) console.error("Failed to delete session folder:", err);
            });
        }

        // مسح البيانات من قاعدة البيانات
        db.run(`DELETE FROM clients WHERE ownerId = ?`, [activeUserId]);
        db.run(`DELETE FROM imported_clients WHERE ownerId = ?`, [activeUserId]);

        socket.emit('status', { message: "تم فصل الرقم ومسح البيانات. جاري تجهيز QR...", ready: false });
        socket.emit('whatsapp-logged-out'); 
    });

    // --- 2. كود فلتر الأرقام (الذكي والعالمي) ---
    socket.on('check-numbers', async ({ numbers }) => {
        if (!activeUserId || !whatsappClients[activeUserId]) {
            return socket.emit('filter-error', 'واتساب غير متصل! يرجى ربط الواتساب أولاً.');
        }

        const client = whatsappClients[activeUserId];
        let validCount = 0;
        let invalidCount = 0;

        // قراءة الأسطر
        const rawLines = numbers.split('\n');

        for (const rawLine of rawLines) {
            // 1. تنظيف الرموز الزائدة (فقط أرقام)
            let phone = rawLine.trim().replace(/\D/g, '');

            // 2. معالجة 00 الدولية (تحويلها إلى لا شيء)
            if (phone.startsWith('00')) {
                phone = phone.substring(2);
            }

            // 3. معالجة الأرقام المغربية المحلية (06/07 -> 212...)
            // الشرط: تبدأ بـ 06 أو 07 وطولها 10 أرقام بالضبط
            if ((phone.startsWith('06') || phone.startsWith('07')) && phone.length === 10) {
                phone = '212' + phone.substring(1);
            }

            // تجاهل الأرقام القصيرة جداً (غير منطقية)
            if (phone.length < 7) continue;

            try {
                // استخدام دالة getNumberId للتحقق من وجود الرقم في سيرفرات واتساب
                // هذه الدالة تعمل عالمياً
                const numberId = await client.getNumberId(phone);

                if (numberId) {
                    validCount++;
                    // numberId.user يعطينا الرقم بالتنسيق الصحيح المسجل في واتساب
                    socket.emit('filter-result', { phone: numberId.user, status: 'valid' });
                } else {
                    invalidCount++;
                    socket.emit('filter-result', { phone: phone, status: 'invalid' });
                }

                // انتظار قصير جداً لتجنب الضغط على السيرفر (250ms)
                await new Promise(resolve => setTimeout(resolve, 250));

            } catch (err) {
                console.error("Error checking number:", phone, err);
                // في حالة حدوث خطأ غير متوقع، نعتبره غير صالح لتجنب توقف العملية
                socket.emit('filter-result', { phone: phone, status: 'invalid' });
            }
        }

        socket.emit('filter-complete', { valid: validCount, invalid: invalidCount });
    });

    socket.on('start-campaign-mode', async ({ promoId }) => {
        if (!activeUserId) return;
        const promos = readPromos(activeUserId);
        const selectedPromo = promos.find(p => p.id === promoId);
        if (!selectedPromo) return;
        db.get("SELECT chatbot_prompt FROM users WHERE id = ?", [activeUserId], (err, user) => {
            if (err || !user) return;
            activeCampaigns[activeUserId] = { promoText: selectedPromo.text, businessPrompt: user.chatbot_prompt || "متجر عام" };
            socket.emit('log', { message: '🚀 تم تفعيل وضع الحملة والمساعد الذكي.', color: 'purple' });
        });
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
            const processedText = processSpintax(promo.text);
            if (promo.image && typeof promo.image === 'string') {
                const imagePath = path.join(promosUploadFolder, promo.image);
                if (fs.existsSync(imagePath)) {
                    const media = MessageMedia.fromFilePath(imagePath);
                    await currentClient.sendMessage(numberId, media, { caption: processedText });
                } else if (processedText) {
                    await currentClient.sendMessage(numberId, processedText, { linkPreview: true });
                }
            } else if (processedText) {
                await currentClient.sendMessage(numberId, processedText, { linkPreview: true });
            }
            const table = fromImported ? "imported_clients" : "clients";
            db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone, activeUserId]);
            socket.emit('send-promo-status', { success: true, phone });
        } catch (err) {
            socket.emit('send-promo-status', { success: false, phone, error: err.message });
        }
    });

    socket.on('sync-contacts', async () => {
        if (!activeUserId || !whatsappClients[activeUserId]) { return; }
        const currentClient = whatsappClients[activeUserId];
        await syncWhatsAppContacts(currentClient, activeUserId);
        socket.emit('sync-complete');
    });

    socket.on('disconnect', () => { console.log(`Socket disconnected. WhatsApp session remains active.`); });
});

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

app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err) return res.status(500).json({ message: "خطأ في الخادم." });
        if (!user || (user.googleId && !user.password)) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة أو الحساب مسجل عبر جوجل.' });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ message: 'بيانات الاعتماد غير صالحة' });
        const now = new Date();
        const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
        const subscriptionEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;
        const isActive = (trialEnds && trialEnds > now) || (subscriptionEnds && subscriptionEnds > now);
        if (isActive) {
            const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '8h' });
            res.status(200).json({ token, subscriptionStatus: 'active' });
        } else {
            const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' });
            res.status(200).json({ token, subscriptionStatus: 'expired' });
        }
    });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
    const userId = req.userData.userId;
    delete activeCampaigns[userId];
    const client = whatsappClients[userId];
    if (client) {
        client.destroy().catch(err => console.error(`Error destroying client for user ${userId}:`, err));
        delete whatsappClients[userId];
    }
    const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${userId}`);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    res.status(200).json({ message: 'تم تسجيل الخروج بنجاح.' });
});

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
                const mailOptions = { from: SENDER_EMAIL, to: ADMIN_EMAIL, subject: `طلب تفعيل اشتراك جديد من ${user.email}`, html: `<h1>طلب تفعيل جديد</h1><p>المستخدم: ${user.name} (${user.email})</p><p>المدة: ${durationName}</p><h2>الرمز: ${newActivationCode}</h2>` };
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
        db.run("UPDATE users SET subscriptionEndsAt = ?, subscription_status = 'active', activation_code = NULL, activationRequest = NULL WHERE id = ?", [newSubscriptionEndDate.toISOString(), userId], (err) => {
            if (err) return res.status(500).json({ message: "خطأ في تحديث الاشتراك." });
            res.status(200).json({ success: true, message: "تم تفعيل الاشتراك بنجاح!" });
        });
    });
});

app.get("/contacts", authMiddleware, checkSubscription, (req, res) => { db.all(`SELECT id, name, phone FROM clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => res.json(rows || [])); });
app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => { db.all(`SELECT id, phone FROM imported_clients WHERE ownerId = ?`, [req.userData.userId], (err, rows) => res.json(rows || [])); });
app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => { const { userId } = req.userData; if (!req.file) return res.status(400).json({ error: "No file uploaded" }); const results = []; fs.createReadStream(req.file.path).pipe(csvParser({ headers: ['phone'], skipLines: 0 })).on('data', (data) => { const phone = String(data.phone || "").replace(/\D/g, ""); if (phone.length >= 8) results.push(phone); }).on('end', () => { fs.unlinkSync(req.file.path); if (results.length === 0) return res.status(400).json({ message: "لا يوجد أرقام صالحة." }); const stmt = db.prepare(`INSERT OR IGNORE INTO imported_clients (phone, ownerId) VALUES (?, ?)`); let importedCount = 0; db.serialize(() => { db.run("BEGIN TRANSACTION"); results.forEach(phone => stmt.run(phone, userId, function (err) { if (!err && this.changes > 0) importedCount++; })); stmt.finalize(); db.run("COMMIT", () => res.status(200).json({ message: "تم الاستيراد بنجاح.", imported: importedCount })); }); }); });
app.get("/promos", authMiddleware, checkSubscription, (req, res) => res.json(readPromos(req.userData.userId)));

app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single("image"), (req, res) => {
    const { text } = req.body;
    const { userId } = req.userData;
    const promos = readPromos(userId);
    const newPromo = { id: Date.now(), text: text || "", image: req.file ? req.file.filename : null };
    promos.push(newPromo);
    writePromos(userId, promos);
    res.json({ status: "success", promo: newPromo });
});

app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => {
    const promoId = parseInt(req.params.id);
    const { userId } = req.userData;
    let promos = readPromos(userId);
    const promo = promos.find(p => p.id === promoId);
    if (promo) {
        if (promo.image && typeof promo.image === 'string') {
            const imagePath = path.join(promosUploadFolder, promo.image);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        }
        writePromos(userId, promos.filter(p => p.id !== promoId));
    }
    res.json({ status: "deleted" });
});

app.delete("/api/delete-all-imported", authMiddleware, checkSubscription, (req, res) => {
    const { userId } = req.userData;
    db.run(`DELETE FROM imported_clients WHERE ownerId = ?`, [userId], function(err) {
        if (err) {
            console.error("Database error while deleting imported clients:", err.message);
            return res.status(500).json({ message: "حدث خطأ في الخادم أثناء محاولة الحذف." });
        }
        res.status(200).json({ status: "success", message: `تم حذف ${this.changes} من العملاء المستوردين بنجاح.` });
    });
});

app.get("/api/chatbot-prompt", authMiddleware, (req, res) => {
    db.get("SELECT chatbot_prompt FROM users WHERE id = ?", [req.userData.userId], (err, row) => {
        if (err) return res.status(500).json({ message: "خطأ في قاعدة البيانات." });
        res.json({ prompt: row ? row.chatbot_prompt : "" });
    });
});
app.post("/api/chatbot-prompt", authMiddleware, (req, res) => {
    const { prompt } = req.body;
    db.run("UPDATE users SET chatbot_prompt = ? WHERE id = ?", [prompt, req.userData.userId], (err) => {
        if (err) return res.status(500).json({ message: "فشل حفظ الإعدادات." });
        res.json({ message: "تم حفظ الإعدادات بنجاح!" });
    });
});

app.get("/api/chatbot-status", authMiddleware, (req, res) => {
    db.get("SELECT is_chatbot_active FROM users WHERE id = ?", [req.userData.userId], (err, row) => {
        if (err) return res.status(500).json({ message: "خطأ في قاعدة البيانات." });
        res.json({ isActive: row ? !!row.is_chatbot_active : true });
    });
});
app.post("/api/chatbot-status", authMiddleware, (req, res) => {
    const { isActive } = req.body;
    const statusValue = isActive ? 1 : 0;
    db.run("UPDATE users SET is_chatbot_active = ? WHERE id = ?", [statusValue, req.userData.userId], (err) => {
        if (err) return res.status(500).json({ message: "فشل تحديث الحالة." });
        res.json({ message: `تم ${isActive ? 'تفعيل' : 'إلغاء تفعيل'} المساعد الذكي بنجاح!` });
    });
});
// استبدل المسار القديم بهذا الكود المحسن
app.post("/api/generate-spintax", authMiddleware, async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ message: "النص مطلوب." });
    }
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini", // نموذج أحدث وأكثر إبداعاً
            temperature: 0.8,    // زيادة درجة الإبداع قليلاً
            messages: [
                {
                    role: "system",
                    content: `Your persona is a world-class Moroccan marketing copywriter. You are an expert in writing persuasive, engaging, and creative ad copy in Moroccan Darija.

Your task is to take a core promotional message and transform it into 5 distinct, high-impact variations.

**CRITICAL RULES:**
1.  **Do Not Summarize:** You must paraphrase, not summarize. All key information (like percentages, product names, etc.) from the original text MUST be included in every variation.
2.  **Maintain Length & Detail:** Each variation should be roughly the same length as the original text and contain the same level of detail.
3.  **Be Creative & Use Emojis:** Each variation must have a different tone and angle. Use persuasive language, marketing hooks, and relevant emojis (🚀, 🔥, ✨, 🎁, 💯) to make the copy visually appealing and engaging.
4.  **Language:** Write exclusively in authentic Moroccan Darija.
5.  **Final Format:** The entire output MUST be a single line of text in Spintax format: {variation 1|variation 2|variation 3|variation 4|variation 5}. Do not add any introductions, explanations, or text before or after the spintax string.`
                },
                {
                    role: "user",
                    content: `Paraphrase this promotional message into 5 variations: "${text}"`
                }
            ]
        });
        const spintaxResult = completion.choices[0].message.content;
        res.json({ spintax: spintaxResult });
    } catch (error) {
        console.error("Error generating spintax:", error);
        res.status(500).json({ message: "فشل إنشاء الصيغ الجديدة." });
    }
});

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
