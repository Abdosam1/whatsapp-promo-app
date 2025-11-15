// middleware/checkSubscription.js

const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbFile = path.join(__dirname, "..", "main_data.db");
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
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
            return res.status(401).json({ message: "لم يتم العثور على المستخدم المرتبط بهذا الحساب." });
        }

        const isActive = isSubscriptionActive(user) || isTrialActive(user);

        if (isActive) {
            // Subscription is good, continue.
            next();
        } else {
            // Subscription is EXPIRED.
            
            // --- HADA HOWA T-TA3DIL L-MOHIM ---
            
            // Ila kan l-user kaytalab chi page (kayaccepti HTML), o makanch déja f page d activate
            // Redirectih l page d activate.
            if (req.accepts('html') && !req.path.includes('/activate')) {
                return res.redirect('/activate.html');
            }
            
            // Ila kan kaytalab data men API (matalan /contacts, /promos)
            // Sifet lih error 403 (Forbidden), l-frontend khasso yfhemha o yredirectih.
            // L-message khasso ykoun fih chi code bach l-frontend y3ref ach ydir.
            res.status(403).json({ 
                message: 'الاشتراك منتهي. يرجى تفعيل حسابك.',
                subscriptionExpired: true // <--- HADI MOHIMA L FRONTEND
            });
        }
    });
};
