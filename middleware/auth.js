// middleware/auth.js

const jwt = require('jsonwebtoken');

// ------------------------------------------------------------------
// *** الحل: قراءة الـ Secret Key من المتغيرات (يجب أن يكون مطابقاً لـ server.js) ***
// ------------------------------------------------------------------
// استخدام نفس الـ Logic ديال Fallback لي كاين في server.js
const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY'; 
// ------------------------------------------------------------------


// هذا الوسيط (Middleware) هو "حارس المصادقة"
// دوره هو التحقق من أن الطلب قادم من مستخدم مسجل الدخول ولديه توكن صالح

module.exports = (req, res, next) => {
    try {
        // 1. محاولة استخراج التوكن من هيدر 'Authorization'
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            // هذه الحالة تحدث إذا لم يتم إرسال الهيدر 'Authorization' أصلاً أو كان خاطئاً
            throw new Error('Authentication failed: No token provided or malformed header.');
        }

        const token = authHeader.split(" ")[1];
        
        // 2. التحقق من صحة التوكن (باستخدام الـ Secret Key الصحيح)
        const decodedToken = jwt.verify(token, JWT_SECRET); 
        
        // 3. إضافة بيانات المستخدم (ID) إلى كائن الطلب (req)
        req.userData = { userId: decodedToken.userId };
        
        // 4. السماح للطلب بالمرور
        next();

    } catch (error) {
        // إذا حدث أي خطأ في كتلة 'try' (مثلاً: التوكن غير موجود، التوكن غير صالح)
        // يتم إرجاع خطأ 401 Unauthorized، مما يمنع الوصول إلى المسار المحمي
        res.status(401).json({ message: 'Authentication failed! Please log in again.' });
    }
};
