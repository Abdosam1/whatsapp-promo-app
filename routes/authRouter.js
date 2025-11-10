// routes/authRouter.js

const express = require('express');
const bcrypt = require('bcryptjs'); // مازال غادي نحتاجوه لتشفير كلمة المرور
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const router = express.Router();

// تحديد مسار ملف قاعدة البيانات المؤقتة
const usersDbPath = path.join(__dirname, '..', 'users.json');

// --- دوال مساعدة للتعامل مع الملف ---

// دالة لقراءة المستخدمين من الملف
const readUsersFromFile = () => {
    try {
        const data = fs.readFileSync(usersDbPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        // إذا كان الملف غير موجود أو فيه مشكل، نرجع لائحة فارغة
        return [];
    }
};

// دالة لكتابة المستخدمين في الملف
const writeUsersToFile = (users) => {
    fs.writeFileSync(usersDbPath, JSON.stringify(users, null, 2));
};


// --- Endpoints ---

// 1. Endpoint لإنشاء حساب (Signup)
router.post('/signup', async (req, res) => {
    try {
        const { email, password } = req.body;
        const users = readUsersFromFile();

        // تحقق إذا كان الإيميل موجود ديجا
        if (users.find(u => u.email === email)) {
            return res.status(400).json({ message: 'هذا البريد الإلكتروني مستخدم بالفعل' });
        }

        // تشفير كلمة المرور (مهم جداً حتى في الوضع المحلي)
        const hashedPassword = await bcrypt.hash(password, 12);

        const newUser = {
            id: Date.now().toString(), // نعطيوه ID فريد بسيط
            email,
            password: hashedPassword
        };
        
        users.push(newUser);
        writeUsersToFile(users);

        res.status(201).json({ message: 'تم إنشاء الحساب بنجاح' });

    } catch (error) {
        res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
});


// 2. Endpoint لتسجيل الدخول (Login)
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const users = readUsersFromFile();

        const user = users.find(u => u.email === email);
        if (!user) {
            return res.status(401).json({ message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
        }

        // مقارنة كلمة المرور المدخلة مع الكلمة المشفرة
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
        }

        // إنشاء Token
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            'YOUR_VERY_SECRET_KEY_SHOULD_BE_LONG_AND_RANDOM', // بدل هادي
            { expiresIn: '1h' }
        );

        res.status(200).json({ token });

    } catch (error) {
        res.status(500).json({ message: 'حدث خطأ في الخادم' });
    }
});

module.exports = router;