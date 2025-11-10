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
// const chromium    = require('chrome-aws-lambda'); // <--- تم التعليق أو الحذف
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*' } });
const PORT   = 3001; // <--- PORT معدل لـ VPS

// secrets & configs
const JWT_SECRET          = 'YOUR_VERY_SECRET_KEY';
const ADMIN_SECRET_KEY    = 'MySuperAdminSecretForActivation_2025_xyz789';
const ADMIN_EMAIL         = 'abdo140693@gmail.com';
const usersDbPath         = path.join(__dirname, 'users.json');

// nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: ADMIN_EMAIL,
    pass: 'sggc rkdz pqth cetm'
  }
});

// ================================================================= //
// ===================== 2. إعداد قاعدة SQLite ===================== //
// ================================================================= //
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
// ================================================================= //
app.use(cors());
app.use(express.json());

const authMiddleware       = require('./middleware/auth');
const checkSubscription    = require('./middleware/checkSubscription'); // هذا للمسارات الـ API (JSON 403)

// إنشاء مجلد promos إذا لم يكن موجود
const promosUploadFolder = path.join(__dirname, "public", "promos");
if (!fs.existsSync(promosUploadFolder)) {
  fs.mkdirSync(promosUploadFolder, { recursive: true });
}

// multer للصور و CSV
const uploadPromoImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, promosUploadFolder),
    filename:    (req, file, cb) => cb(null, `promo-${Date.now()}${path.extname(file.originalname)}`)
  })
});
const uploadCSV = multer({ dest: "uploads/" });

// ================================================================= //
// ======================= 4. دوال مساعدة =========================== //
// ================================================================= //
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

// ----------------------------------------------------
// *** دالة مساعدة جديدة لتحويل db.run إلى Promise (لحل مشكل التزامن) ***
// ----------------------------------------------------
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) {
                reject(err);
            } else {
                // this.changes هو عدد الصفوف المتأثرة
                resolve(this.changes); 
            }
        });
    });
}

// ----------------------------------------------------
// *** دالة التزامن (Synchronization) الجديدة (DELETE & INSERT) ***
// ----------------------------------------------------
async function updateClientsFromWhatsApp(whatsappClient, database, ownerId) {
  try {
    const chats = await whatsappClient.getChats();
    const privateContacts = chats
        .filter(c => !c.isGroup && c.id.user && !c.isSupport) // تصفية الدردشات الخاصة وغير الدعم
        .map(chat => {
            const phone = chat.id.user;
            const name = chat.name || chat.contact?.pushname || "Unknown";
            return { phone, name };
        });

    console.log(`[Clients Sync] Found ${privateContacts.length} contacts on WhatsApp for user ${ownerId}.`);

    // بدأ عملية Transaction لضمان السلامة
    database.serialize(() => {
        // 1. حذف جميع العملاء الحاليين لهذا المستخدم (Clients Table)
        database.run(`DELETE FROM clients WHERE ownerId = ?`, [ownerId], (err) => {
             if(err) console.error(`Error deleting old clients for ${ownerId}:`, err);
        });

        // 2. إدراج العملاء المحدثين (Clients Table)
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

// دالة مساعدة للتحقق من حالة الاشتراك (True فقط للاشتراك المدفوع)
function isSubscriptionActive(user) {
  const now = new Date();
  const subscriptionEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;
  return subscriptionEnds && subscriptionEnds > now; 
}

// دالة مساعدة للتحقق من حالة الفترة التجريبية 
function isTrialActive(user) {
  const now = new Date();
  const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
  return trialEnds && trialEnds > now;
}

// ================================================================= //
// ================= منطق Socket.IO & WhatsApp ==================== //
// ================================================================= //
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
        // التعديل لحل مشاكل Puppeteer/Chromium و إضافة Arguments
        puppeteer:    { 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        }
      });

      client.on("ready", async () => {
        isInitializing = false;
        socket.emit('status', { message: "WhatsApp متصل!", ready: true });
        // تحديث العملاء عند كل Initialisation ناجحة
        await updateClientsFromWhatsApp(client, db, connectedUserId); 
      });

      client.on("qr", qr => socket.emit('qr', qr));
      client.on("disconnected", reason => {
        isInitializing = false;
        socket.emit('status', { message: `تم قطع الاتصال`, ready: false, error: true });
        client = null;
      });

      // إضافة timeout لحل مشكل Target Closed
      client.initialize({ timeout: 60000 }).catch(err => { 
        console.error(`Init error:`, err);
        isInitializing = false;
      });
      
      // *** إضافة هذا اللوجيك لحالة الـ Client اللي ديجا متصل (Synchronization) ***
      setTimeout(async () => {
          if (client && (await client.getState()) === 'CONNECTED') {
              console.log(`[WhatsApp Sync] Re-syncing for existing connected client ${connectedUserId}`);
              socket.emit('status', { message: "WhatsApp متصل!", ready: true }); 
              await updateClientsFromWhatsApp(client, db, connectedUserId);
          }
      }, 5000); // 5 ثواني بعد محاولة الـ Initialize

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
// ================================================================= //
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const users = readUsersFromFile();
    if (users.find(u => u.email === email)) {
      return res.status(400).json({ message: 'This email is already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    
    // ----------------------------------------------------
    // التعديل هنا: من 24 ساعة إلى 15 دقيقة
    const trialEndsAt = new Date();
    trialEndsAt.setMinutes(trialEndsAt.getMinutes() + 15); // الكود الجديد (15 دقيقة)
    // ----------------------------------------------------

    const newUser = {
      id: Date.now().toString(),
      email,
      password: hashedPassword,
      trialEndsAt: trialEndsAt.toISOString(),
      subscriptionEndsAt: null,
      activationCode: null,
      activationDurationDays: null
    };

    users.push(newUser);
    writeUsersToFile(users);
    res.status(201).json({ message: 'Account created successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
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
        // استخدام الدالة المساعدة الجديدة dbRun
        const deletedRows = await dbRun(`DELETE FROM clients WHERE ownerId = ?`, [user.id]);
        console.log(`[Login Clean] Cleared ${deletedRows} old clients for user ${user.id}.`);
    } catch(e) {
        console.error(`[Login Clean] Failed to delete clients for user ${user.id}:`, e);
        // لا توقف العملية حتى لو فشل الحذف
    }
    // ----------------------------------------------------

    return res.status(200).json({ token });
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

// ================================================================= //
// ================= 7. مسارات التفعيل والاشتراك ===================== //
// ================================================================= //
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
    from: ADMIN_EMAIL,
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
  const { activationCode } = req.body;
  const userId = req.userData.userId;
  if (!activationCode) {
    return res.status(400).json({ message: "Activation code is required" });
  }

  try {
    const users = readUsersFromFile();
    const idx   = users.findIndex(u => u.id === userId);
    if (idx === -1) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = users[idx];
    if (!user.activationCode || user.activationCode !== activationCode) {
      return res.status(400).json({ message: "Invalid or expired activation code" });
    }

    // نفّعل الاشتراك
    const durationDays = user.activationDurationDays || 30;
    const endsAt = new Date();
    endsAt.setDate(endsAt.getDate() + durationDays);

    users[idx].subscriptionEndsAt      = endsAt.toISOString();
    users[idx].trialEndsAt             = null;
    users[idx].activationCode         = null;
    users[idx].activationDurationDays = null;
    writeUsersToFile(users);

    res.status(200).json({ message: 'Subscription activated successfully!' });
  } catch (err) {
    console.error("Activation Error:", err);
    res.status(500).json({ message: 'Server error during activation' });
  }
});

// --- مسارات الـ API المحمية (تستخدم checkSubscription الذي يرجع 403 JSON) ---
app.get("/api/check-status", authMiddleware, (req, res) => {
  // هذا المسار لا يحتاج لـ checkSubscription لأنه هو من يقوم بالتحقق
  const users = readUsersFromFile();
  const user  = users.find(u => user.id === req.userData.userId); // Fix: user.id
  let isActive = isSubscriptionActive(user) || isTrialActive(user); // هنا يجب أن تشمل الـ Trial
  res.status(200).json({ active: isActive });
});

// ================================================================= //
// ================== 8. مسارات الـ CRUD و الـ API ==================== //
// ================================================================= //

// --- مسار لإضافة عرض جديد (POST /addPromo) ---
app.post("/addPromo", authMiddleware, checkSubscription, uploadPromoImage.single('image'), (req, res) => {
    const userId = req.userData.userId;
    const text   = req.body.text;
    const image  = req.file ? req.file.filename : null; // اسم الملف من multer

    if (!text || !image) {
        return res.status(400).json({ message: "نص العرض والصورة مطلوبان." });
    }

    try {
        const promos = readPromos(userId);
        const newPromo = {
            id: Date.now(),
            text,
            image,
            createdAt: new Date().toISOString()
        };
        promos.push(newPromo);
        writePromos(userId, promos);

        res.status(201).json({ message: "تم إضافة العرض بنجاح", promo: newPromo });
    } catch (error) {
        console.error("Error adding promo:", error);
        res.status(500).json({ message: "خطأ في السيرفر أثناء إضافة العرض." });
    }
});

// --- مسار للحصول على العروض (GET /promos) ---
app.get("/promos", authMiddleware, checkSubscription, (req, res) => {
    try {
        const promos = readPromos(req.userData.userId);
        // التعديل: التأكد من إرجاع Array حتى لو كانت فارغة
        res.status(200).json(promos || []); 
    } catch (error) {
        console.error("Error fetching promos:", error);
        res.status(500).json({ message: "خطأ في السيرفر أثناء جلب العروض." });
    }
});

// --- مسار لحذف عرض (DELETE /deletePromo/:id) ---
app.delete("/deletePromo/:id", authMiddleware, checkSubscription, (req, res) => {
    const userId = req.userData.userId;
    const promoId = parseInt(req.params.id, 10);
    try {
        const promos = readPromos(userId);
        const promoIndex = promos.findIndex(p => p.id === promoId);

        if (promoIndex === -1) {
            return res.status(404).json({ message: "العرض غير موجود." });
        }

        // حذف الصورة من القرص
        const imagePath = path.join(promosUploadFolder, promos[promoIndex].image);
        if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
        }

        promos.splice(promoIndex, 1);
        writePromos(userId, promos);
        res.status(200).json({ message: "تم حذف العرض بنجاح." });
    } catch (error) {
        console.error("Error deleting promo:", error);
        res.status(500).json({ message: "خطأ في السيرفر أثناء حذف العرض." });
    }
});

// --- مسار جلب العملاء الأساسيين (GET /contacts) ---
app.get("/contacts", authMiddleware, checkSubscription, (req, res) => {
    const ownerId = req.userData.userId;
    db.all(`SELECT id, name, phone, last_sent FROM clients WHERE ownerId = ?`, [ownerId], (err, rows) => {
        if (err) {
            console.error("Error fetching contacts:", err);
            return res.status(500).json({ message: "خطأ في قاعدة البيانات." });
        }
        res.status(200).json(rows || []);
    });
});

// --- مسار جلب العملاء المستوردين (GET /imported-contacts) ---
app.get("/imported-contacts", authMiddleware, checkSubscription, (req, res) => {
    const ownerId = req.userData.userId;
    db.all(`SELECT id, phone, last_sent FROM imported_clients WHERE ownerId = ?`, [ownerId], (err, rows) => {
        if (err) {
            console.error("Error fetching imported contacts:", err);
            return res.status(500).json({ message: "خطأ في قاعدة البيانات." });
        }
        res.status(200).json(rows || []);
    });
});

// --- مسار لحذف عميل (DELETE /delete/:table/:id) ---
app.delete("/delete/:table/:id", authMiddleware, checkSubscription, (req, res) => {
    const userId = req.userData.userId;
    const table = req.params.table;
    const id = parseInt(req.params.id, 10);

    if (table !== 'clients' && table !== 'imported_clients') {
        return res.status(400).json({ message: "جدول غير صالح." });
    }

    db.run(`DELETE FROM ${table} WHERE id = ? AND ownerId = ?`, [id, userId], function(err) {
        if (err) {
            console.error(`Error deleting from ${table}:`, err);
            return res.status(500).json({ message: "خطأ في قاعدة البيانات أثناء الحذف." });
        }
        if (this.changes === 0) {
            return res.status(404).json({ message: "لم يتم العثور على العميل." });
        }
        res.status(200).json({ message: "تم حذف العميل بنجاح." });
    });
});

// --- مسار لحذف جميع العملاء المستوردين (DELETE /deleteAll/imported_clients) ---
app.delete("/deleteAll/imported_clients", authMiddleware, checkSubscription, (req, res) => {
    const userId = req.userData.userId;
    db.run(`DELETE FROM imported_clients WHERE ownerId = ?`, [userId], function(err) {
        if (err) {
            console.error("Error deleting all imported clients:", err);
            return res.status(500).json({ message: "خطأ في قاعدة البيانات أثناء حذف الكل." });
        }
        res.status(200).json({ message: `تم حذف ${this.changes} عميل مستورد.` });
    });
});

// --- مسار استيراد ملف CSV (POST /import-csv) ---
app.post("/import-csv", authMiddleware, checkSubscription, uploadCSV.single('csv'), (req, res) => {
    const userId = req.userData.userId;
    const filePath = req.file.path;
    const results = [];
    let importedCount = 0;

    fs.createReadStream(filePath)
        .pipe(csvParser({ headers: ['phone'], skipLines: 0 }))
        .on('data', (data) => {
            const phone = String(data.phone).replace(/\D/g, ""); // إزالة أي شيء غير رقم
            if (phone.length >= 8) { // تحقق من طول رقم الهاتف
                results.push(phone);
            }
        })
        .on('end', () => {
            fs.unlinkSync(filePath); // حذف الملف المؤقت

            if (results.length === 0) {
                return res.status(400).json({ message: "لا يوجد أرقام هواتف صالحة للاستيراد." });
            }

            db.serialize(() => {
                const stmt = db.prepare(`INSERT OR IGNORE INTO imported_clients (phone, ownerId) VALUES (?, ?)`);
                results.forEach(phone => {
                    stmt.run(phone, userId, function(err) {
                        if (!err && this.changes > 0) {
                            importedCount++;
                        }
                    });
                });
                stmt.finalize(() => {
                    res.status(200).json({ message: "تم الاستيراد بنجاح.", imported: importedCount });
                });
            });
        })
        .on('error', (err) => {
            fs.unlinkSync(filePath);
            console.error("CSV Parsing Error:", err);
            res.status(500).json({ message: "خطأ أثناء معالجة ملف CSV." });
        });
});


// --- مسار لحذف جلسة واتساب (WhatsApp Logout) ---
app.post("/api/whatsapp/logout", authMiddleware, (req, res) => {
    const userId = req.userData.userId;
    const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-user-${userId}`);
    
    try {
        // حذف مجلد الجلسة بالكامل
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[WhatsApp Logout] Session deleted for user ${userId}`);
        }
        res.status(200).json({ message: "WhatsApp session deleted." });
    } catch (error) {
        console.error(`Error deleting WhatsApp session for ${userId}:`, error);
        res.status(500).json({ message: "Failed to delete WhatsApp session." });
    }
});


// ================================================================= //
// ========= 9. صفحات الويب: Activate & Dashboard + Static ========== //
// ================================================================= //

// صفحة الداشبورد (for browser)
app.get('/dashboard', authMiddleware, (req, res) => {
  const users = readUsersFromFile();
  const user  = users.find(u => u.id === req.userData.userId);
  
  if (!user) return res.redirect('/activate'); 
  
  // التحقق: إذا لم يكن لديه اشتراك مدفوع فعال، حوله للتفعيل
  if (!isSubscriptionActive(user)) {
    return res.redirect('/activate');
  }
  
  // إذا كان لديه اشتراك مدفوع، يظهر له الداشبورد
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// صفحة التفعيل (for browser)
app.get('/activate', authMiddleware, (req, res) => {
  const users = readUsersFromFile();
  const user  = users.find(u => u.id === req.userData.userId);
  
  if (!user) return res.sendFile(path.join(__dirname, 'public', 'activate.html'));

  // التحقق: إذا كان لديه اشتراك مدفوع فعال، حوله للداشبورد
  if (isSubscriptionActive(user)) {
    return res.redirect('/dashboard');
  }
  
  // إذا لم يكن لديه اشتراك مدفوع، يظهر له صفحة التفعيل (حتى لو كان في فترة تجريبية)
  res.sendFile(path.join(__dirname, 'public', 'activate.html'));
});


// ملفات الواجهة الستاتيكية (CSS, JS, صور…)
app.use(express.static(path.join(__dirname, 'public')));

// SPA catch-all: أي GET غير معروف يرجع index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================================================================= //
// ========================= 10. تشغيل التطبيق ======================= //
// ================================================================= //
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
