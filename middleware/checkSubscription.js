const fs = require('fs');
const path = require('path');

// تحديد مسار ملف المستخدمين بشكل صحيح بالنسبة لمجلد 'middleware'
const usersDbPath = path.join(__dirname, '..', 'users.json');

/**
 * دالة لقراءة ملف المستخدمين من القرص.
 * @returns {Array} - قائمة المستخدمين أو مصفوفة فارغة في حالة الخطأ.
 */
const readUsersFromFile = () => {
  try {
    // التحقق من وجود الملف قبل محاولة قراءته لتجنب الأخطاء
    if (!fs.existsSync(usersDbPath)) {
      console.error("users.json file not found at:", usersDbPath);
      return [];
    }
    const data = fs.readFileSync(usersDbPath, 'utf-8');
    // التأكد من أن الملف ليس فارغًا قبل تحويله إلى JSON
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error("Critical error reading or parsing users.json:", error);
    return []; // إرجاع مصفوفة فارغة لتجنب تعطل التطبيق
  }
};

/**
 * Middleware للتحقق مما إذا كان لدى المستخدم اشتراك فعال أو فترة تجريبية سارية.
 */
module.exports = (req, res, next) => {
  try {
    // الخطوة 1: التأكد من أن middleware المصادقة قد أضاف بيانات المستخدم للطلب
    if (!req.userData || !req.userData.userId) {
      // هذا الخطأ يجب ألا يحدث إذا تم وضع 'authMiddleware' قبل هذا الـ middleware
      return res.status(401).json({ message: "Authentication error: User ID is missing." });
    }

    const userId = req.userData.userId;
    const users = readUsersFromFile();
    const user = users.find(u => u.id === userId);

    // الخطوة 2: التأكد من وجود المستخدم في قاعدة البيانات
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // الخطوة 3: التحقق من صلاحية الوصول (اشتراك أو فترة تجريبية)
    const now = new Date();
    const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
    const subscriptionEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;

    // تبسيط الشرط: هل الاشتراك فعال أو هل الفترة التجريبية فعالة؟
    const hasValidAccess = (subscriptionEnds && subscriptionEnds > now) || (trialEnds && trialEnds > now);

    if (hasValidAccess) {
      // إذا كان لدى المستخدم صلاحية، اسمح له بالمرور إلى الطلب التالي
      return next();
    }

    // الخطوة 4: إذا لم يكن لدى المستخدم صلاحية، التعامل مع الطلب
    console.log(`Access denied for user ${user.email}. Reason: Subscription/trial expired.`);

    // إذا كان الطلب يتوقع صفحة HTML (مثل طلب من المتصفح مباشرة)
    if (req.accepts('html')) {
      // قم بإعادة توجيهه إلى صفحة التفعيل
      return res.redirect('/activate.html');
    }

    // إذا كان الطلب هو طلب API (يتوقع JSON)
    return res.status(403).json({ 
        message: "Your subscription or trial period has expired. Please activate your subscription.",
        code: "SUBSCRIPTION_EXPIRED" 
    });

  } catch (error) {
    // التعامل مع أي أخطاء غير متوقعة أثناء تنفيذ الـ middleware
    console.error("Critical error in checkSubscription middleware:", error);
    return res.status(500).json({ message: "A server error occurred while checking your subscription status." });
  }
};
