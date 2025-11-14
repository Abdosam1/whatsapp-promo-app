// middleware/auth.js

const jwt = require('jsonwebtoken');

// قراءة الـ Secret Key من متغيرات البيئة لضمان تطابقه مع المفتاح المستخدم في server.js
// هذا المفتاح السري يجب أن يكون معقدًا ويتم تخزينه بأمان.
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY_FOR_DEVELOPMENT_ONLY';

/**
 * Middleware للتحقق من مصادقة المستخدم عبر JSON Web Token (JWT).
 * يقوم بالتحقق من وجود توكن صالح في هيدر 'Authorization' للطلب.
 */
module.exports = (req, res, next) => {
    try {
        // الخطوة 1: استخراج التوكن من الهيدر.
        // التنسيق المتوقع هو: "Bearer [token]"
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            // إذا لم يتم توفير التوكن أو كان التنسيق خاطئًا، يتم رفض الطلب.
            return res.status(401).json({ 
                message: 'Authentication failed: No valid token provided.',
                code: 'NO_TOKEN' 
            });
        }

        // فصل كلمة "Bearer" عن التوكن نفسه.
        const token = authHeader.split(' ')[1];
        
        // الخطوة 2: التحقق من صحة التوكن.
        // jwt.verify ستقوم بالتحقق من التوقيع وتاريخ انتهاء الصلاحية.
        // إذا كان التوكن غير صالح، ستقوم بإطلاق خطأ (throw an error).
        const decodedToken = jwt.verify(token, JWT_SECRET);
        
        // الخطوة 3: إرفاق البيانات المفككة من التوكن (payload) إلى كائن الطلب (req).
        // هذا يجعل بيانات المستخدم (مثل userId) متاحة للمسارات والـ middlewares اللاحقة.
        req.userData = { userId: decodedToken.userId };
        
        // الخطوة 4: إذا نجح كل شيء، اسمح للطلب بالمرور إلى وجهته التالية.
        next();

    } catch (error) {
        // التعامل مع أي أخطاء تحدث أثناء التحقق.
        // الأسباب الشائعة للخطأ: التوكن منتهي الصلاحية (TokenExpiredError) أو التوقيع غير صالح.
        console.error("Authentication Middleware Error:", error.message);
        
        return res.status(401).json({ 
            message: 'Authentication failed: Your session may have expired. Please log in again.',
            code: 'INVALID_TOKEN'
        });
    }
};
