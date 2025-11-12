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
// استخدام متغير البيئة أو القيمة الافتراضية
const PORT   = process.env.PORT || 3001; 

// secrets & configs
const JWT_SECRET          = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';
const ADMIN_SECRET_KEY    = process.env.ADMIN_SECRET_KEY || 'MySuperAdminSecretForActivation_2025_xyz789';
const ADMIN_EMAIL         = process.env.ADMIN_EMAIL || 'abdo140693@gmail.com'; 
const SENDER_EMAIL        = ADMIN_EMAIL; // استخدام نفس الإيميل كمرسل (Gmail)
const usersDbPath         = path.join(__dirname, 'users.json');

// ----------------------------------------------------
// *** الإضافة الضرورية: تخزين مؤقت لبيانات التسجيل (Email Verification) ***
// ----------------------------------------------------
const pendingRegistrations = {}; 

// nodemailer transporter (الاعتماد على Gmail Service و App Password)
const transporter = nodemailer.createTransport({
  service: 'gmail', 
  auth: {
    user: ADMIN_EMAIL,
    pass: process.env.GMAIL_APP_PASS || 'YOUR_GMAIL_APP_PASSWORD' // ⚠️ يجب استخدام App Password
  }
});

// ================================================================= //
// ===================== 2. إعداد قاعدة SQLite ===================== //
const dbFile = path.join(__dirname, "main_data.db");
const db     = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT,
      last_sent DATE,
      ownerId TEXT NOT NULL,
      UNIQUE(phone, ownerId)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS imported_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      last_sent DATE,
      ownerId TEXT NOT NULL,
      UNIQUE(phone, ownerId)
    )
  `);
});

// ================================================================= //
// ========================= 3. Middlewares ========================= //
app.use(cors());
app.use(express.json());

const authMiddleware       = require('./middleware/auth');
const checkSubscription    = require('./middleware/checkSubscription'); 

const promosUploadFolder = path.join(__dirname, "public", "promos");
if (!fs.existsSync(promosUploadFolder)) {
  fs.mkdirSync(promosUploadFolder, { recursive: true });
}

const uploadPromoImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, promosUploadFolder),
    filename:    (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`)
  })
});
const uploadCSV = multer({ dest: "uploads/" });

// ================================================================= //
// ======================= 4. دوال مساعدة =========================== //
function generateActivationCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i === 3 || i === 7) code += '-';
  }
  return code;
}

function getUserDataPath(userId) {
  const userPath = path.join(__dirname, 'data', `user_${userId}`);
  if (!fs.existsSync(userPath)) fs.mkdirSync(userPath, { recursive: true });
  return userPath;
}

function readPromos(userId) {
  const p = path.join(getUserDataPath(userId), 'promos.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
}

function writePromos(userId, promos) {
  fs.writeFileSync(path.join(getUserDataPath(userId), 'promos.json'),
                   JSON.stringify(promos, null, 2));
}

const readUsersFromFile = () => {
  try {
    return JSON.parse(fs.readFileSync(usersDbPath, 'utf-8'));
  } catch {
    return [];
  }
};

const writeUsersToFile = (users) => {
  fs.writeFileSync(usersDbPath, JSON.stringify(users, null, 2));
};

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(this.changes); 
            }
        });
    });
}

async function updateClientsFromWhatsApp(whatsappClient, database, ownerId) {
  try {
    const chats = await whatsappClient.getChats();
    const privateContacts = chats
        .filter(c => !c.isGroup && c.id.user && !c.isSupport)
        .map(chat => {
            const phone = chat.id.user;
            const name = chat.name || chat.contact?.pushname || "Unknown";
            return { phone, name };
        });

    console.log(`[Clients Sync] Found ${privateContacts.length} contacts on WhatsApp for user ${ownerId}.`);

    database.serialize(() => {
        database.run(`DELETE FROM clients WHERE ownerId = ?`, [ownerId], (err) => {
             if(err) console.error(`Error deleting old clients for ${ownerId}:`, err);
        });

        const stmt = database.prepare(`INSERT INTO clients (name, phone, ownerId) VALUES (?, ?, ?)`);
        privateContacts.forEach(contact => {
            stmt.run(contact.name, contact.phone, ownerId);
        });
        stmt.finalize();
        
        console.log(`💾 Clients list fully synchronized for user ${ownerId}.`);
    });

  } catch (err) {
    console.error(`Error updating clients for ${ownerId}:`, err);
  }
}

function isSubscriptionActive(user) {
  const now = new Date();
  const subscriptionEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;
  return subscriptionEnds && subscriptionEnds > now; 
}

function isTrialActive(user) {
  const now = new Date();
  const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
  return trialEnds && trialEnds > now;
}

// ================================================================= //
// ================= منطق Socket.IO & WhatsApp ==================== //
io.on('connection', (socket) => {
  let client = null;
  let connectedUserId = null;
  let isInitializing = false;

  // تهيئة واتساب
  socket.on('init-whatsapp', async (token) => {
    if (client || isInitializing) return;
    isInitializing = true;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      connectedUserId = decoded.userId;
      client = new Client({
        authStrategy: new LocalAuth({ clientId: `user-${connectedUserId}` }),
        puppeteer:    { 
            headless: true, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // حل مشكل الذاكرة المؤقتة (VPS)
                '--single-process' // حل مشكل الـ Process (VPS)
            ] 
        }
      });

      client.on("ready", async () => {
        isInitializing = false;
        socket.emit('status', { message: "WhatsApp متصل!", ready: true });
        await updateClientsFromWhatsApp(client, db, connectedUserId); 
      });

      client.on("qr", qr => socket.emit('qr', qr));
      client.on("disconnected", reason => {
        isInitializing = false;
        socket.emit('status', { message: `تم قطع الاتصال`, ready: false, error: true });
        client = null;
      });

      client.initialize({ timeout: 60000 }).catch(err => { 
        console.error(`Init error:`, err);
        isInitializing = false;
      });
      
    } catch {
      isInitializing = false;
    }
  });

  // إرسال برومو
  socket.on('send-promo', async (data) => {
    if (!client || !connectedUserId) {
      return socket.emit('send-promo-status', {
        success: false,
        phone: data.phone,
        error: 'Client not ready'
      });
    }

    const { phone, promoId, fromImported } = data;
    const promos = readPromos(connectedUserId);
    const promo  = promos.find(p => p.id === promoId);
    if (!promo) return;

    const numberId = `${phone.replace(/\D/g, "")}@c.us`;
    const mediaPath = path.join(promosUploadFolder, promo.image);
    if (!fs.existsSync(mediaPath)) return;

    try {
      const media = MessageMedia.fromFilePath(mediaPath);
      await client.sendMessage(numberId, media, { caption: promo.text });

      const table = fromImported ? "imported_clients" : "clients";
      db.run(
        `UPDATE ${table} SET last_sent = ? WHERE phone = ? AND ownerId = ?`,
        [new Date().toISOString().split("T")[0], phone.replace(/\D/g, ""), connectedUserId]
      );

      socket.emit('send-promo-status', { success: true, phone });
    } catch (err) {
      socket.emit('send-promo-status', {
        success: false,
        phone,
        error: err.message
      });
    }
  });

  socket.on('disconnect', () => {
    if (client) client.destroy().catch(console.error);
  });
});

// ================================================================= //
// =============== 6. مسارات المصادقة (Auth Routes) ================ //
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
    
    // 1. توليد رمز التفعيل المؤقت ورابط الـ Verification
    const verificationToken = jwt.sign({ email }, JWT_SECRET, { expiresIn: '1h' });
    const verificationLink = `${req.protocol}://${req.get('host')}/api/auth/verify-email?token=${verificationToken}`;

    // 2. تخزين البيانات مؤقتاً
    const trialEndsAt = new Date();
    trialEndsAt.setMinutes(trialEndsAt.getMinutes() + 15); // 15 دقيقة تجريبية
    pendingRegistrations[email] = { name, email, password: hashedPassword, token: verificationToken, trialEndsAt: trialEndsAt.toISOString() };

    // 3. إرسال رابط التفعيل عبر الإيميل
    const mailOptions = {
      from: SENDER_EMAIL, // abdo140693@gmail.com
      to: email,
      subject: 'تفعيل حسابك في ' + req.get('host'),
      html: `
        <p>مرحباً بك ${name}،</p>
        <p>الرجاء النقر على الرابط أدناه لتفعيل حسابك وإكمال التسجيل:</p>
        <a href="${verificationLink}" style="padding: 10px 20px; background-color: #25D366; color: white; text-decoration: none; border-radius: 5px; display: inline-block;">تفعيل الحساب الآن</a>
        <p>الرابط صالح لمدة ساعة واحدة.</p>
      `
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({ message: 'تم إرسال رابط التفعيل إلى بريدك الإلكتروني.' });
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({ message: 'فشل التسجيل في السيرفر.' });
  }
});


// --- مسار التحقق من الإيميل وإكمال التسجيل ---
app.get('/api/auth/verify-email', async (req, res) => {
    const token = req.query.token;
    
    if (!token) {
        return res.status(400).send('رابط التفعيل غير صالح.');
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const email = decoded.email;
        const pendingData = pendingRegistrations[email];

        if (!pendingData || pendingData.token !== token) {
            return res.status(400).send('رمز التفعيل منتهي الصلاحية أو غير صحيح.');
        }

        // 1. إكمال عملية التسجيل وحفظ المستخدم في users.json
        const users = readUsersFromFile();
        if (users.find(u => u.email === email)) {
            delete pendingRegistrations[email];
            return res.status(400).send('الحساب مسجل بالفعل. يرجى تسجيل الدخول.');
        }

        const newUser = {
            id: Date.now().toString(),
            email: pendingData.email,
            name: pendingData.name, 
            password: pendingData.password, 
            trialEndsAt: pendingData.trialEndsAt, // استخدام فترة التجربة المخزنة
            subscriptionEndsAt: null,
            activationCode: null,
            activationDurationDays: null
        };
        
        users.push(newUser);
        writeUsersToFile(users);

        // 2. مسح البيانات المؤقتة
        delete pendingRegistrations[email];

        // 3. إظهار رسالة النجاح
        res.send(`
            <!DOCTYPE html><html lang="ar" dir="rtl"><head><title>تم التفعيل</title><style>body { font-family: 'Cairo', sans-serif; text-align: center; padding-top: 50px; background-color: #f0f2f5; } .success-box { background-color: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: inline-block; } h1 { color: #25D366; } a { color: #128C7E; text-decoration: none; }</style></head>
            <body><div class="success-box"><h1>✅ تم تفعيل حسابك بنجاح!</h1><p>يمكنك الآن تسجيل الدخول.</p><a href="/login.html">اضغط هنا لتسجيل الدخول</a></div></body></html>
        `);

    } catch (error) {
        console.error("Verification Error:", error);
        res.status(500).send('خطأ في التحقق من الإيميل. يرجى المحاولة مرة أخرى.');
    }
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
    
    // ----------------------------------------------------
    // *** الحل: استخدام await لضمان الحذف قبل إرجاع التوكن ***
    // ----------------------------------------------------
    try {
        const deletedRows = await dbRun(`DELETE FROM clients WHERE ownerId = ?`, [user.id]);
        console.log(`[Login Clean] Cleared ${deletedRows} old clients for user ${user.id}.`);
    } catch(e) {
        console.error(`[Login Clean] Failed to delete clients for user ${user.id}:`, e);
    }
    // ----------------------------------------------------

    return res.status(200).json({ token });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ================================================================= //
// ================= 7. مسارات التفعيل والاشتراك ===================== //
// ... (باقي كود Section 7)
app.post("/api/request-code", authMiddleware, async (req, res) => {
  const { durationName, durationDays } = req.body;
  const userId = req.userData.userId;
  const users  = readUsersFromFile();
  const idx    = users.findIndex(u => u.id === userId);

  if (idx === -1) {
    return res.status(404).json({ message: "User not found" });
  }

  const newCode = generateActivationCode();
  const duration = parseInt(durationDays, 10) || 30;

  users[idx].activationCode         = newCode;
  users[idx].activationDurationDays = duration;
  writeUsersToFile(users);

  const mailOptions = {
    from: SENDER_EMAIL, // abdo140693@gmail.com
    to: ADMIN_EMAIL,
    subject: `طلب اشتراك جديد: ${durationName}`,
    html: `
      <h2>طلب اشتراك جديد:</h2>
      <ul>
        <li><strong>بريد المستخدم:</strong> ${users[idx].email}</li>
        <li><strong>المدة:</strong> ${durationName} (${duration} أيام)</li>
        <li><strong>رمز التفعيل:</strong> <b>${newCode}</b></li>
      </ul>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({
      message: 'Activation request sent to admin and code generated successfully'
    });
  } catch (err) {
    console.error("Nodemailer Error:", err);
    users[idx].activationCode         = null;
    users[idx].activationDurationDays = null;
    writeUsersToFile(users);
    res.status(500).json({
      message: 'Code generated but failed to send email. Contact admin.'
    });
  }
});

app.post("/api/activate-with-code", authMiddleware, (req, res) => {
  // ...
});

app.get("/api/check-status", authMiddleware, (req, res) => {
  // ...
});

// ================================================================= //
// ================== 8. مسارات الـ CRUD و الـ API ==================== //
// ... (باقي كود Section 8)
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single('image'), (req, res) => {
    // ...
});

app.get("/promos", authMiddleware, checkSubscription, (req, res) => {
    // ...
});

app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => {
    // ...
});

app.get("/contacts", authMiddleware, checkSubscription, (req, res) => {
    // ...
});

app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => {
    // ...
});

app.delete("/delete/:table/:id", authMiddleware, checkSubscription, (req, res) => {
    // ...
});

app.delete("/deleteAll/imported_clients", authMiddleware, checkSubscription, (req, res) => {
    // ...
});

app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => {
    // ...
});


// --- مسار لحذف جلسة واتساب (WhatsApp Logout) ---
app.post("/api/whatsapp/logout", authMiddleware, (req, res) => {
    // ...
});


// ================================================================= //
// ========= 9. صفحات الويب: Activate & Dashboard + Static ========== //
// ... (باقي كود Section 9)
app.get('/dashboard', authMiddleware, (req, res) => {
  // ...
});

app.get('/activate', authMiddleware, (req, res) => {
  // ...
});


app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================================================================= //
// ========================= 10. تشغيل التطبيق ======================= //
// ================================================================= //
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
