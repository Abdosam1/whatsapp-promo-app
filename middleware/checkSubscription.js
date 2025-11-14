  const fs = require('fs');
    const path = require('path');
    const usersDbPath = path.join(__dirname, '..', 'users.json');

    const readUsersFromFile = () => {
      try {
        if (!fs.existsSync(usersDbPath)) return [];
        const data = fs.readFileSync(usersDbPath, 'utf-8');
        return data ? JSON.parse(data) : [];
      } catch (error) {
        console.error("Error reading or parsing users.json:", error);
        return [];
      }
    };

    module.exports = (req, res, next) => {
      try {
        if (!req.userData || !req.userData.userId) {
          return res.status(401).json({ message: "Auth error, user ID not found." });
        }
        const users = readUsersFromFile();
        const user = users.find(u => u.id === req.userData.userId);
        if (!user) {
          return res.status(404).json({ message: "User not found." });
        }
        const now = new Date();
        const trialEnds = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
        const subscriptionEnds = user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt) : null;
        const hasValidAccess = (subscriptionEnds && subscriptionEnds > now) || (trialEnds && trialEnds > now);

        if (hasValidAccess) {
          return next();
        }
        if (req.accepts('html')) {
          return res.redirect('/activate.html');
        }
        return res.status(403).json({ message: "Subscription or trial has expired." });
      } catch (error) {
        console.error("CRITICAL in checkSubscription:", error);
        return res.status(500).json({ message: "Server error while checking subscription." });
      }
    };
