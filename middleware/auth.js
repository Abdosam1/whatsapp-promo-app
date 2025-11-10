// middleware/auth.js

const jwt = require('jsonwebtoken');

// هذا الوسيط (Middleware) هو "حارس المصادقة"
// دوره هو التحقق من أن الطلب قادم من مستخدم مسجل الدخول ولديه توكن صالح

module.exports = (req, res, next) => {
    try {
        // 1. محاولة استخراج التوكن من هيدر 'Authorization'
        // الهيدر عادة ما يكون بهذا الشكل: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6..."
        const token = req.headers.authorization.split(" ")[1];
        
        if (!token) {
            // هذه الحالة تحدث إذا لم يتم إرسال الهيدر 'Authorization' أصلاً
            throw new Error('Authentication failed!');
        }

        // 2. التحقق من صحة التوكن
        // تستخدم jwt.verify نفس المفتاح السري المستخدم عند إنشاء التوكن
        // إذا كان التوكن غير صالح أو منتهي الصلاحية، سيتم إطلاق خطأ (error)
        const decodedToken = jwt.verify(token, 'YOUR_VERY_SECRET_KEY'); // مهم جداً: تأكد أن هذا المفتاح مطابق للموجود في server.js
        
        // 3. إضافة بيانات المستخدم (ID) إلى كائن الطلب (req)
        // هذا يسمح للمسارات (routes) التي تأتي بعد هذا الوسيط بمعرفة من هو المستخدم الذي قام بالطلب
        req.userData = { userId: decodedToken.userId };
        
        // 4. السماح للطلب بالمرور إلى الخطوة التالية في سلسلة الوسائط
        next();

    } catch (error) {
        // إذا حدث أي خطأ في كتلة 'try' (مثلاً: التوكن غير موجود، التوكن غير صالح)
        // يتم إرجاع خطأ 401 Unauthorized، مما يمنع الوصول إلى المسار المحمي
        res.status(401).json({ message: 'Authentication failed! Please log in again.' });
    }
};