const sqlite3 = require("sqlite3").verbose();
// --- تم تصحيح هذا السطر ---
const path = require("path");

// --- الاتصال بنفس قاعدة البيانات المستخدمة في server.js ---
// المسار الصحيح للوصول إلى الملف من داخل مجلد middleware
const dbFile = path.join(__dirname, "..", "main_data.db");
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error("Failed to connect to the database from checkSubscription.js", err);
    }
});

// --- دوال مساعدة للتحقق من التواريخ ---
function isSubscriptionActive(user) { 
    if (!user || !user.subscriptionEndsAt) return false;
    return new Date(user.subscriptionEndsAt) > new Date(); 
}

function isTrialActive(user) { 
    if (!user || !user.trialEndsAt) return false;
    return new Date(user.trialEndsAt) > new Date(); 
}

module.exports = (req, res, next) => {
    // التأكد من أن authMiddleware قد عمل بنجاح قبله
    if (!req.userData || !req.userData.userId) {
        return res.status(401).json({ message: 'فشل التحقق من الهوية!' });
    }

    const userId = req.userData.userId;

    // --- البحث عن المستخدم في قاعدة بيانات SQLite بدلاً من ملف JSON ---
    const sql = "SELECT trialEndsAt, subscriptionEndsAt FROM users WHERE id = ?";
    
    db.get(sql, [userId], (err, user) => {
        if (err) {
            console.error("Database error in checkSubscription:", err);
            return res.status(500).json({ message: "خطأ في الخادم عند التحقق من الاشتراك." });
        }
        if (!user) {
            return res.status(404).json({ message: "لم يتم العثور على المستخدم." });
        }

        // --- التحقق من صلاحية الاشتراك أو الفترة التجريبية ---
        const isActive = isSubscriptionActive(user) || isTrialActive(user);

        if (isActive) {
            // إذا كان الحساب فعالاً، اسمح للطلب بالمرور إلى وجهته
            next();
        } else {
            // إذا لم يكن فعالاً، أرسل خطأ "ممنوع"
            // هذا الخطأ هو ما يسبب مشكلة JSON.parse في الواجهة الأمامية
            res.status(403).json({ message: 'الاشتراك منتهي. يرجى تفعيل حسابك.' });
        }
    });
};
