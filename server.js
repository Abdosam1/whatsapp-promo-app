// أضف هذا السطر في البداية جداً ليتم تحميل المتغيرات من ملف .env
require('dotenv').config(); 

// ================================================================= //
// ==================== 1. الإعدادات والمكتبات ===================== //
// ================================================================= //
const http        = require('http');
const express     = require("express");
const socketIo    = require('socket.io');
const cors        = require("cors");
const path        = require("path");
const fs          = require("fs");
const multer      = require("multer");
const csvParser   = require("csv-parser");
const sqlite3     = require("sqlite3").verbose();
const bcrypt      = require("bcryptjs");
const jwt         = require("jsonwebtoken");
const nodemailer  = require('nodemailer');
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3001; 

// secrets & configs
const JWT_SECRET          = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';
const ADMIN_EMAIL         = process.env.ADMIN_EMAIL || 'abdo140693@gmail.com'; 
const SENDER_EMAIL        = ADMIN_EMAIL;
const usersDbPath         = path.join(__dirname, 'users.json');
const pendingRegistrations = {}; 

const transporter = nodemailer.createTransport({
  service: 'gmail', 
  auth: {
    user: ADMIN_EMAIL,
    pass: process.env.GMAIL_APP_PASS || 'YOUR_GMAIL_APP_PASSWORD'
  }
});

// ===================== 2. إعداد قاعدة SQLite ===================== //
const dbFile = path.join(__dirname, "main_data.db");
const db     = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
  db.run(`CREATE TABLE IF NOT EXISTS imported_clients (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, last_sent DATE, ownerId TEXT NOT NULL, UNIQUE(phone, ownerId))`);
});

// ========================= 3. Middlewares ========================= //
app.use(cors());
app.use(express.json());

const authMiddleware       = require('./middleware/auth');
const checkSubscription    = require('./middleware/checkSubscription');

const promosUploadFolder = path.join(__dirname, "public", "promos");
if (!fs.existsSync(promosUploadFolder)) fs.mkdirSync(promosUploadFolder, { recursive: true });

const uploadPromoImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, promosUploadFolder), filename: (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`) }) });
const uploadCSV = multer({ dest: "uploads/" });

// ======================= 4. دوال مساعدة =========================== //
function readUsersFromFile() {
  try { return JSON.parse(fs.readFileSync(usersDbPath, 'utf-8')); } catch { return []; }
};
const writeUsersToFile = (users) => { fs.writeFileSync(usersDbPath, JSON.stringify(users, null, 2)); };
function isSubscriptionActive(user) { const now = new Date(); const subEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null; return subEnds && subEnds > now; }
function isTrialActive(user) { const now = new Date(); const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null; return trialEnds && trialEnds > now; }
// ... (باقي الدوال المساعدة تبقى كما هي)
function generateActivationCode() { const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let code = ''; for (let i = 0; i < 12; i++) { code += chars.charAt(Math.floor(Math.random() * chars.length)); if (i === 3 || i === 7) code += '-'; } return code; }
function getUserDataPath(userId) { const userPath = path.join(__dirname, 'data', `user_${userId}`); if (!fs.existsSync(userPath)) fs.mkdirSync(userPath, { recursive: true }); return userPath; }
function readPromos(userId) { const p = path.join(getUserDataPath(userId), 'promos.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : []; }
function writePromos(userId, promos) { fs.writeFileSync(path.join(getUserDataPath(userId), 'promos.json'), JSON.stringify(promos, null, 2)); }
function dbRun(sql, params = []) { return new Promise((resolve, reject) => { db.run(sql, params, function(err) { if (err) { reject(err); } else { resolve(this.changes); } }); }); }
async function updateClientsFromWhatsApp(whatsappClient, database, ownerId) { try { const chats = await whatsappClient.getChats(); const privateContacts = chats.filter(c => !c.isGroup && c.id.user && !c.isSupport).map(chat => ({ phone: chat.id.user, name: chat.name || chat.contact?.pushname || "Unknown" })); console.log(`[Clients Sync] Found ${privateContacts.length} contacts for user ${ownerId}.`); database.serialize(() => { database.run(`DELETE FROM clients WHERE ownerId = ?`, [ownerId]); const stmt = database.prepare(`INSERT INTO clients (name, phone, ownerId) VALUES (?, ?, ?)`); privateContacts.forEach(contact => stmt.run(contact.name, contact.phone, ownerId)); stmt.finalize(); console.log(`💾 Clients list fully synchronized for user ${ownerId}.`); }); } catch (err) { console.error(`Error updating clients for ${ownerId}:`, err); } }

// ================= منطق Socket.IO & WhatsApp ==================== //
io.on('connection', (socket) => {
  let client = null, connectedUserId = null, isInitializing = false;
  socket.on('init-whatsapp', async (token) => {
    if (client || isInitializing) return; isInitializing = true;
    try {
      const decoded = jwt.verify(token, JWT_SECRET); connectedUserId = decoded.userId;
      client = new Client({ authStrategy: new LocalAuth({ clientId: `user-${connectedUserId}` }), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'] } });
      client.on("ready", async () => { isInitializing = false; socket.emit('status', { message: "WhatsApp متصل!", ready: true }); await updateClientsFromWhatsApp(client, db, connectedUserId); });
      client.on("qr", qr => socket.emit('qr', qr));
      client.on("disconnected", () => { isInitializing = false; socket.emit('status', { message: `تم قطع الاتصال`, ready: false, error: true }); client = null; });
      client.initialize().catch(err => { console.error(`Init error:`, err); isInitializing = false; });
    } catch { isInitializing = false; }
  });
  socket.on('send-promo', async (data) => {
    if (!client || !connectedUserId) return socket.emit('send-promo-status', { success: false, phone: data.phone, error: 'Client not ready' });
    const { phone, promoId, fromImported } = data;
    const promos = readPromos(connectedUserId); const promo = promos.find(p => p.id === promoId);
    if (!promo) return;
    const numberId = `${phone.replace(/\D/g, "")}@c.us`; const mediaPath = path.join(promosUploadFolder, promo.image);
    if (!fs.existsSync(mediaPath)) return;
    try {
      const media = MessageMedia.fromFilePath(mediaPath); await client.sendMessage(numberId, media, { caption: promo.text });
      const table = fromImported ? "imported_clients" : "clients";
      db.run(`UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`, [new Date().toISOString().split("T")[0], phone.replace(/\D/g, ""), connectedUserId]);
      socket.emit('send-promo-status', { success: true, phone });
    } catch (err) { socket.emit('send-promo-status', { success: false, phone, error: err.message }); }
  });
  socket.on('disconnect', () => { if (client) client.destroy().catch(console.error); });
});


// =============== 6. مسارات المصادقة (Auth Routes) - نسخة مؤقتة للاختبار =============== //
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body; 
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'الاسم، البريد، وكلمة المرور مطلوبة' });
    }

    const users = readUsersFromFile();
    if (users.find(u => u.email === email)) {
      return res.status(400).json({ message: 'هذا البريد الإلكتروني مسجل بالفعل' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    
    // ================== TEST CODE ==================
    // الخطوة 1: إنشاء المستخدم مباشرة في users.json (بدون انتظار تأكيد)
    console.log(`[TEST MODE] Creating user ${email} directly.`);
    const trialEndsAt = new Date();
    trialEndsAt.setMinutes(trialEndsAt.getMinutes() + 15); // 15 دقيقة تجريبية

    const newUser = {
        id: Date.now().toString(),
        email: email,
        name: name, 
        password: hashedPassword, 
        trialEndsAt: trialEndsAt.toISOString(),
        subscriptionEndsAt: null,
        activationCode: null,
        activationDurationDays: null
    };
    
    users.push(newUser);
    writeUsersToFile(users);
    
    console.log(`[TEST MODE] User ${email} created successfully.`);
    // ===============================================

    // تم تعطيل إرسال الإيميل مؤقتاً
    // const mailOptions = { ... };
    // await transporter.sendMail(mailOptions);

    // إرجاع رسالة نجاح مختلفة للاختبار
    res.status(201).json({ message: 'تم إنشاء الحساب بنجاح (وضع الاختبار).' });
    
  } catch (error) {
    console.error("Signup Error (Test Mode):", error);
    res.status(500).json({ message: 'فشل التسجيل في السيرفر.' });
  }
});


app.get('/api/auth/verify-email', async (req, res) => {
    // هذا المسار لم يعد مستخدماً في وضع الاختبار، لكن نتركه
    res.status(404).send('Email verification is disabled in test mode.');
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const users = readUsersFromFile();
    const user  = users.find(u => u.email === email);
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '8h' });
    try {
        await dbRun(`DELETE FROM clients WHERE ownerId = ?`, [user.id]);
    } catch(e) {
        console.error(`[Login Clean] Failed to delete clients for user ${user.id}:`, e);
    }
    return res.status(200).json({ token });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ================= 7. مسارات التفعيل والاشتراك ===================== //
app.post("/api/request-code", authMiddleware, async (req, res) => {
  const { durationName, durationDays } = req.body;
  const userId = req.userData.userId; const users = readUsersFromFile(); const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return res.status(404).json({ message: "User not found" });
  const newCode = generateActivationCode(); const duration = parseInt(durationDays, 10) || 30;
  users[idx].activationCode = newCode; users[idx].activationDurationDays = duration; writeUsersToFile(users);
  const mailOptions = { from: SENDER_EMAIL, to: ADMIN_EMAIL, subject: `طلب اشتراك جديد: ${durationName}`, html: `<h2>طلب اشتراك جديد:</h2><ul><li><strong>بريد المستخدم:</strong> ${users[idx].email}</li><li><strong>المدة:</strong> ${durationName} (${duration} أيام)</li><li><strong>رمز التفعيل:</strong> <b>${newCode}</b></li></ul>` };
  try { await transporter.sendMail(mailOptions); res.status(200).json({ message: 'Activation request sent' }); } catch (err) { console.error("Nodemailer Error:", err); users[idx].activationCode = null; users[idx].activationDurationDays = null; writeUsersToFile(users); res.status(500).json({ message: 'Failed to send email' }); }
});
app.post("/api/activate-with-code", authMiddleware, (req, res) => {
  const { activationCode } = req.body; const userId = req.userData.userId;
  if (!activationCode) return res.status(400).json({ message: "Code is required" });
  try {
    const users = readUsersFromFile(); const idx = users.findIndex(u => u.id === userId);
    if (idx === -1) return res.status(404).json({ message: "User not found" });
    const user = users[idx]; if (!user.activationCode || user.activationCode !== activationCode) return res.status(400).json({ message: "Invalid code" });
    const durationDays = user.activationDurationDays || 30; const endsAt = new Date(); endsAt.setDate(endsAt.getDate() + durationDays);
    users[idx].subscriptionEndsAt = endsAt.toISOString(); users[idx].trialEndsAt = null; users[idx].activationCode = null; users[idx].activationDurationDays = null;
    writeUsersToFile(users); res.status(200).json({ message: 'Subscription activated!' });
  } catch (err) { console.error("Activation Error:", err); res.status(500).json({ message: 'Server error' }); }
});
app.get("/api/check-status", authMiddleware, (req, res) => {
  const users = readUsersFromFile(); const user = users.find(u => u.id === req.userData.userId);
  if (!user) return res.status(404).json({ active: false, message: "User not found" });
  let isActive = isSubscriptionActive(user) || isTrialActive(user);
  res.status(200).json({ active: isActive });
});

// ================== 8. مسارات الـ CRUD و الـ API ==================== //
// ... (جميع مسارات CRUD تبقى كما هي)
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single('image'), (req, res) => { const userId = req.userData.userId; const text = req.body.text; const image = req.file ? req.file.filename : null; if (!text || !image) return res.status(400).json({ message: "نص العرض والصورة مطلوبان." }); try { const promos = readPromos(userId); const newPromo = { id: Date.now(), text, image, createdAt: new Date().toISOString() }; promos.push(newPromo); writePromos(userId, promos); res.status(201).json({ message: "تم إضافة العرض بنجاح", promo: newPromo }); } catch (error) { res.status(500).json({ message: "خطأ في السيرفر أثناء إضافة العرض." }); } });
app.get("/promos", authMiddleware, checkSubscription, (req, res) => { try { const promos = readPromos(req.userData.userId); res.status(200).json(promos || []); } catch (error) { res.status(500).json({ message: "خطأ في السيرفر أثناء جلب العروض." }); } });
app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => { const userId = req.userData.userId; const promoId = parseInt(req.params.id, 10); try { const promos = readPromos(userId); const promoIndex = promos.findIndex(p => p.id === promoId); if (promoIndex === -1) return res.status(404).json({ message: "العرض غير موجود." }); const imagePath = path.join(promosUploadFolder, promos[promoIndex].image); if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); promos.splice(promoIndex, 1); writePromos(userId, promos); res.status(200).json({ message: "تم حذف العرض بنجاح." }); } catch (error) { res.status(500).json({ message: "خطأ في السيرفر أثناء حذف العرض." }); } });
app.get("/contacts", authMiddleware, checkSubscription, (req, res) => { const ownerId = req.userData.userId; db.all(`SELECT id, name, phone, last_sent FROM clients WHERE ownerId = ?`, [ownerId], (err, rows) => { if (err) return res.status(500).json({ message: "خطأ في قاعدة البيانات." }); res.status(200).json(rows || []); }); });
app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => { const ownerId = req.userData.userId; db.all(`SELECT id, phone, last_sent FROM imported_clients WHERE ownerId = ?`, [ownerId], (err, rows) => { if (err) return res.status(500).json({ message: "خطأ في قاعدة البيانات." }); res.status(200).json(rows || []); }); });
app.delete("/delete/:table/:id", authMiddleware, checkSubscription, (req, res) => { const { table, id } = req.params; const userId = req.userData.userId; if (table !== 'clients' && table !== 'imported_clients') return res.status(400).json({ message: "جدول غير صالح." }); db.run(`DELETE FROM ${table} WHERE id = ? AND ownerId = ?`, [id, userId], function(err) { if (err) return res.status(500).json({ message: "خطأ في قاعدة البيانات أثناء الحذف." }); if (this.changes === 0) return res.status(404).json({ message: "لم يتم العثور على العميل." }); res.status(200).json({ message: "تم حذف العميل بنجاح." }); }); });
app.delete("/deleteAll/imported_clients", authMiddleware, checkSubscription, (req, res) => { const userId = req.userData.userId; db.run(`DELETE FROM imported_clients WHERE ownerId = ?`, [userId], function(err) { if (err) return res.status(500).json({ message: "خطأ في قاعدة البيانات." }); res.status(200).json({ message: `تم حذف ${this.changes} عميل مستورد.` }); }); });
app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => { const userId = req.userData.userId; const filePath = req.file.path; const results = []; let importedCount = 0; fs.createReadStream(filePath).pipe(csvParser({ headers: ['phone'], skipLines: 0 })).on('data', (data) => { const phone = String(data.phone).replace(/\D/g, ""); if (phone.length >= 8) results.push(phone); }).on('end', () => { fs.unlinkSync(filePath); if (results.length === 0) return res.status(400).json({ message: "لا يوجد أرقام." }); db.serialize(() => { const stmt = db.prepare(`INSERT OR IGNORE INTO imported_clients (phone, ownerId) VALUES (?, ?)`); results.forEach(phone => stmt.run(phone, userId, function(err) { if (!err && this.changes > 0) importedCount++; })); stmt.finalize(() => res.status(200).json({ message: "تم الاستيراد.", imported: importedCount })); }); }).on('error', () => { fs.unlinkSync(filePath); res.status(500).json({ message: "خطأ." }); }); });
app.post("/api/whatsapp/logout", authMiddleware, (req, res) => { const userId = req.userData.userId; const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-user-${userId}`); try { if (fs.existsSync(sessionPath)) { fs.rmSync(sessionPath, { recursive: true, force: true }); } res.status(200).json({ message: "Session deleted." }); } catch (error) { res.status(500).json({ message: "Failed to delete session." }); } });


// ================================================================= //
// ========= 9. صفحات الويب: Activate & Dashboard + Static ========== //
// ================================================================= //
app.get('/dashboard', authMiddleware, (req, res) => {
  const users = readUsersFromFile();
  const user  = users.find(u => u.id === req.userData.userId);
  if (!user) return res.redirect('/login.html'); 
  if (!isSubscriptionActive(user) && !isTrialActive(user)) return res.redirect('/activate');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/activate', authMiddleware, (req, res) => {
  const users = readUsersFromFile();
  const user  = users.find(u => u.id === req.userData.userId);
  if (!user) return res.sendFile(path.join(__dirname, 'public', 'activate.html'));
  if (isSubscriptionActive(user) || isTrialActive(user)) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'activate.html'));
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ================================================================= //
// ========================= 10. تشغيل التطبيق ======================= //
// ================================================================= //
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});```

---

### **الخطوات التالية**

1.  Bdel l'fichier l'qdim b had l'code l'jdid kaml.
2.  3awed demarrer l'server dyalek b tariqa n9iya. 7it 7yedna l'process l'qdim, khassek t3awed t'startih:
    ```bash
    pm2 start server.js --name whatsapp-promo-app
    ```
3.  Jereb daba dir signup.

**Gouli liya natija:**
*   **Ila kheddem:** L'mochkil 100% f l'configuration dyal Gmail dyalek. T2ekked men `GMAIL_APP_PASS` f fichier `.env`.
*   **Ila baqi nafs l'mochkil:** Hada kay3ni l'mochkil f chi blassa khra ma 3endha 3ala9a b l'email, o dik sa3a khassna nchoufo l'logs jdad.
