const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbFile = path.join(__dirname, "..", "main_data.db");
const db = new sqlite3.Database(dbFile);

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
        return res.status(401).json({ message: 'فشل التحقق من الهوية!' });
    }

    const userId = req.userData.userId;
    const sql = "SELECT trialEndsAt, subscriptionEndsAt FROM users WHERE id = ?";
    
    db.get(sql, [userId], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ message: "لم يتم العثور على المستخدم." });
        }

        const isActive = isSubscriptionActive(user) || isTrialActive(user);

        if (isActive) {
            // إذا كان الحساب فعالاً، اسمح للطلب بالمرور
            next();
        } else {
            // إذا كان الحساب غير فعال
            // تحقق مما إذا كان الطلب يريد صفحة HTML (مثل /dashboard)
            if (req.accepts('html')) {
                // قم بتوجيهه إلى صفحة التفعيل
                return res.redirect('/activate.html');
            }
            
            // إذا كان الطلب هو API (يريد JSON)، أرسل خطأ
            res.status(403).json({ message: 'الاشتراك منتهي. يرجى تفعيل حسابك.' });
        }
    });
};
