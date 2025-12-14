// ================================================================= //
// ==================== 1. Libraries & Config ===================== //
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
const sqlite3 = require("sqlite3").verbose();
const { OpenAI } = require("openai");
const { validate } = require('deep-email-validator');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';
const ADMIN_EMAIL = 'abdo140693@gmail.com'; // تأكد من أن هذا الإيميل يطابق إيميل الأدمن المسجل

// Folders
const dbFile = path.join(__dirname, "main_data.db");
const blogUploadFolder = path.join(__dirname, "public", "blog_images");
const uploadsFolder = path.join(__dirname, 'uploads');
// ... (باقي المجلدات كما كانت)

// Create directories
if (!fs.existsSync(blogUploadFolder)) fs.mkdirSync(blogUploadFolder, { recursive: true });

// DB Setup
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error("DB Error", err);
    else console.log("✅ Database connected.");
});

db.serialize(() => {
    // إنشاء جدول المقالات
    db.run(`CREATE TABLE IF NOT EXISTS blog_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        title TEXT, 
        summary TEXT, 
        content TEXT, 
        category TEXT, 
        image TEXT, 
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // إنشاء جدول المستخدمين
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, googleId TEXT, name TEXT, email TEXT UNIQUE, password TEXT, trialEndsAt TEXT, subscriptionEndsAt TEXT, activationRequest TEXT, is_chatbot_active INTEGER DEFAULT 1, chatbot_prompt TEXT, subscription_status TEXT DEFAULT 'trial', activation_code TEXT)`);
});

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // تقديم الملفات الثابتة
app.use('/blog_images', express.static(blogUploadFolder)); // تقديم الصور

// Multer for Blog
const storageBlog = multer.diskStorage({
    destination: (req, file, cb) => cb(null, blogUploadFolder),
    filename: (req, file, cb) => cb(null, 'blog-' + Date.now() + path.extname(file.originalname))
});
const uploadBlogImage = multer({ storage: storageBlog });

// Auth Middleware (مبسط)
const authMiddleware = (req, res, next) => {
    try {
        const token = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userData = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ message: "Auth failed" });
    }
};

function checkAdmin(userId, cb) { 
    db.get("SELECT email FROM users WHERE id = ?", [userId], (err, row) => {
        cb(row && row.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()); 
    }); 
}

// ==================== BLOG API ROUTES (FIXED) ==================== //

// 1. جلب كل المقالات
app.get('/api/blog/posts', (req, res) => {
    db.all("SELECT * FROM blog_posts ORDER BY id DESC", [], (err, rows) => {
        if(err) return res.status(500).json({error: err.message});
        res.json(rows || []);
    });
});

// 2. جلب مقال واحد
app.get('/api/blog/post/:id', (req, res) => {
    db.get("SELECT * FROM blog_posts WHERE id=?", [req.params.id], (err, row) => {
        if(err) return res.status(500).json({error: err.message});
        res.json(row);
    });
});

// 3. إنشاء مقال (تم الإصلاح ليتوافق مع الفرونت إند)
app.post('/api/blog/create', authMiddleware, uploadBlogImage.single('image'), (req, res) => {
    checkAdmin(req.userData.userId, (isAdmin) => {
        if(!isAdmin) return res.status(403).json({message:"Forbidden: Admins only"});

        const title = req.body.title;
        const summary = req.body.summary;
        const content = req.body.content;
        const category = req.body.category || 'General';
        
        // حفظ المسار النسبي للصورة
        const img = req.file ? `blog_images/${req.file.filename}` : null;

        db.run(`INSERT INTO blog_posts (title, summary, content, category, image) VALUES (?,?,?,?,?)`, 
            [title, summary, content, category, img], 
            function(err) {
                if(err) return res.status(500).json({success:false, error: err.message});
                res.json({success:true, id: this.lastID});
            }
        );
    });
});

// 4. حذف مقال
app.delete('/api/blog/delete/:id', authMiddleware, (req, res) => {
    checkAdmin(req.userData.userId, (isAdmin) => {
        if(!isAdmin) return res.status(403).json({message:"Forbidden"});
        db.run("DELETE FROM blog_posts WHERE id=?", [req.params.id], ()=>res.json({success:true}));
    });
});

// API للتحقق من الأدمن
app.get('/api/is-admin', authMiddleware, (req,res) => checkAdmin(req.userData.userId, (isAdmin)=>res.json({isAdmin})));

// Login Route (Basic)
app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email=?", [email.toLowerCase().trim()], async (e, u) => {
        if(!u || !(await bcrypt.compare(password, u.password))) return res.status(401).json({message:'Invalid credentials'});
        res.json({ token: jwt.sign({ userId: u.id }, JWT_SECRET), isAdmin: u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase() });
    });
});

// Signup Route (Basic)
app.post("/api/auth/signup", async (req, res) => {
    const { name, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 12);
    db.run("INSERT INTO users (id,name,email,password) VALUES (?,?,?,?)", [Date.now().toString(), name, email.toLowerCase().trim(), hashedPassword], (err) => {
        if(err) return res.status(400).json({message:'Exists'});
        res.json({message:'Registered'});
    });
});

// توجيهات HTML
app.get('/admin-blog', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-blog.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
