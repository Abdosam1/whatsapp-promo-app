const fs = require('fs');
const path = require('path');

const usersDbPath = path.join(__dirname, '..', 'users.json');
const readUsersFromFile = () => {
  try {
    if (fs.existsSync(usersDbPath)) {
      const data = fs.readFileSync(usersDbPath, 'utf-8');
      return JSON.parse(data);
    }
    return [];
  } catch (error) {
    console.error("Error reading or parsing users.json:", error);
    return [];
  }
};

module.exports = (req, res, next) => {
  try {
    // تأكد من وجود userId
    if (!req.userData || !req.userData.userId) {
      return res.status(401).json({ message: "Auth error, user ID not found." });
    }

    const users = readUsersFromFile();
    const user = users.find(u => u.id === req.userData.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // حساب التواريخ
    const now = new Date();
    const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
    const subscriptionEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;

    let hasValidAccess = false;
    if (subscriptionEnds && subscriptionEnds > now) {
      hasValidAccess = true;
    } else if (trialEnds && trialEnds > now) {
      hasValidAccess = true;
    }

    if (hasValidAccess) {
      return next();
    }

    // إذا ماعندوش حقّ الوصول
    // 1) لو طلب صفحة ويب → redirect
    if (req.accepts('html')) {
      console.log(`⏭️ Redirecting user ${user.email} to /activate (no valid subscription)`);
      return res.redirect('/activate');
    }

    // 2) لو طلب API → JSON 403
    return res.status(403).json({ message: "Subscription or trial has expired." });

  } catch (error) {
    console.error("CRITICAL in checkSubscription:", error);
    return res.status(500).json({ message: "Server error while checking subscription." });
  }
};