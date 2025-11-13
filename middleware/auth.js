const jwt = require('jsonwebtoken');

// قراءة الـ Secret Key من ملف .env (نفس القيمة في server.js)
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';

// Middleware للتحقق من التوكن وصلاحية المستخدم
module.exports = (req, res, next) => {
    try {
        // استخراج هيدر Authorization
        const authHeader = req.headers.authorization;

        // التحقق من وجود الهيدر وبداية القيمة بـ "Bearer "
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new Error('Authentication failed: No token provided or malformed header.');
        }

        // استخراج التوكن من الهيدر
        const token = authHeader.split(" ")[1];

        // التحقق من صحة التوكن
        const decodedToken = jwt.verify(token, JWT_SECRET);

        // إضافة بيانات المستخدم (userId) إلى الطلب
        req.userData = { userId: decodedToken.userId };

        // السماح للطلب بالمرور
        next();

    } catch (error) {
        // في حالة الخطأ، إرجاع 401 Unauthorized
        res.status(401).json({ message: 'Authentication failed! Please log in again.' });
    }
};
