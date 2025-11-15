const sqlite3 = require("sqlite3").verbose();
const path = require("path"); // <-- هذا هو السطر المصحح

// --- الاتصال بنفس قاعدة البيانات المستخدمة في server.js ---
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
    if (!req.userData || !req.userData.userId) {
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
            return res.status(404).json({ message: "لم يتم العثور على المستخدم." });
        }

        const isActive = isSubscriptionActive(user) || isTrialActive(user);

        if (isActive) {
            next();
        } else {
            res.status(403).json({ message: 'الاشتراك منتهي. يرجى تفعيل حسابك.' });
        }
    });
};
```4.  **احفظ الملف**.

**الخطوة الثالثة: تشغيل الخادم بالطريقة الصحيحة (باستخدام PM2 فقط)**

في الـ Terminal، تأكد من أنك في مجلد المشروع (`cd ~/whatsapp-promo-app`) ثم اكتب:
```bash
pm2 start server.js --name whatsapp-app```

**الخطوة الرابعة: التحقق من الحالة**
```bash
pm2 logs
