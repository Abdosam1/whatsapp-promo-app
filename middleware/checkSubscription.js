const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbFile = path.join(__dirname, "..", "main_data.db");
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        // لا يمكننا فعل الكثير هنا، ولكن على الأقل نسجل الخطأ
        console.error("CRITICAL: Failed to connect to the database from checkSubscription middleware.", err);
    }
});

function isSubscriptionActive(user) { 
    if (!user || !user.subscriptionEndsAt) return false;
    return new Date(user.subscriptionEndsAt) > new Date(); 
}

function isTrialActive(user) { 
    if (!user || !user.trialEndsAt) return false;
    return new Date(user.trialEndsAt) > new Date(); 
}

module.exports = (req, res, next) => {
    if (!req.userData || !req.userData.userId) {
        // هذا يجب أن يتم التعامل معه بواسطة authMiddleware، ولكنه حماية إضافية
        return res.status(401).json({ message: 'فشل التحقق من الهوية!' });
    }

    const userId = req.userData.userId;
    const sql = "SELECT trialEndsAt, subscriptionEndsAt FROM users WHERE id = ?";
    
    db.get(sql, [userId], (err, user) => {
        if (err) {
            console.error("Database error in checkSubscription:", err);
            return res.status(500).json({ message: "خطأ في الخادم عند التحقق من الاشتراك." });
        }
        if (!user) {
            // إذا لم يتم العثور على المستخدم، قم بتسجيل خروجه بالقوة
            // هذا يمنع وجود توكنات قديمة لمستخدمين تم حذفهم
            return res.status(401).json({ message: "لم يتم العثور على المستخدم المرتبط بهذا الحساب." });
        }

        const isActive = isSubscriptionActive(user) || isTrialActive(user);

        if (isActive) {
            // إذا كان الحساب فعالاً، اسمح للطلب بالمرور
            next();
        } else {
            // إذا كان الحساب غير فعال
            
            // --- هذا هو التعديل المهم ---
            // تحقق مما إذا كان الطلب يريد صفحة HTML وكان يحاول الوصول إلى لوحة التحكم
            if (req.accepts('html') && req.path.includes('/dashboard')) {
                // قم بتوجيهه إلى صفحة التفعيل
                return res.redirect('/activate.html');
            }
            
            // إذا كان الطلب هو API (يريد JSON)، أرسل خطأ "ممنوع"
            res.status(403).json({ message: 'الاشتراك منتهي. يرجى تفعيل حسابك.' });
        }
    });
};
