// middleware/checkSubscription.js

const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbFile = path.join(__dirname, "..", "main_data.db");
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error("CRITICAL: Failed to connect to the database from checkSubscription middleware.", err);
    }
});

// دالة موحدة للتحقق من صلاحية الاشتراك
function isSubscriptionValid(user) {
    if (!user) return false;
    const now = new Date();
    // تحقق من الاشتراك المدفوع أولاً
    if (user.subscriptionEndsAt && new Date(user.subscriptionEndsAt) > now) {
        return true;
    }
    // إذا لم يكن هناك اشتراك، تحقق من الفترة التجريبية
    if (user.trialEndsAt && new Date(user.trialEndsAt) > now) {
        return true;
    }
    return false;
}

module.exports = (req, res, next) => {
    if (!req.userData || !req.userData.userId) {
        return res.status(401).json({ message: 'فشل التحقق من الهوية!' });
    }

    const userId = req.userData.userId;
    // [تعديل] نجلب أيضا حالة الاشتراك الحالية من الداتا بايز
    const sql = "SELECT trialEndsAt, subscriptionEndsAt, subscription_status FROM users WHERE id = ?";
    
    db.get(sql, [userId], (err, user) => {
        if (err) {
            console.error("Database error in checkSubscription:", err);
            return res.status(500).json({ message: "خطأ في الخادم عند التحقق من الاشتراك." });
        }
        if (!user) {
            return res.status(401).json({ message: "لم يتم العثور على المستخدم المرتبط بهذا الحساب." });
        }

        const isActive = isSubscriptionValid(user);

        if (isActive) {
            // الاشتراك صالح، اسمح للمستخدم بالمرور
            next();
        } else {
            // الاشتراك منتهي الصلاحية

            // --- [ هذا هو التعديل الإضافي والمهم ] ---
            // إذا كان الاشتراك منتهياً ولكن حالته في الداتا بايز ليست 'expired'
            // نقوم بتحديثها الآن. هذا يضمن أن قاعدة البيانات تعكس دائماً الحقيقة.
            if (user.subscription_status !== 'expired') {
                db.run("UPDATE users SET subscription_status = 'expired' WHERE id = ?", [userId], (updateErr) => {
                    if (updateErr) {
                        console.error(`Failed to update user ${userId} status to expired:`, updateErr);
                    }
                });
            }
            // --- [ نهاية التعديل الإضافي ] ---

            // التعامل مع الطلب كما كان من قبل
            if (req.accepts('html') && !req.path.includes('/activate')) {
                return res.redirect('/activate.html');
            }
            
            res.status(403).json({ 
                message: 'الاشتراك منتهي. يرجى تفعيل حسابك.',
                subscriptionExpired: true
            });
        }
    });
};
