  // middleware/auth.js
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'YOUR_VERY_SECRET_KEY';

    module.exports = (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                throw new Error('Authentication failed: No token provided or malformed header.');
            }
            const token = authHeader.split(" ")[1];
            const decodedToken = jwt.verify(token, JWT_SECRET); 
            req.userData = { userId: decodedToken.userId };
            next();
        } catch (error) {
            console.error("Auth Middleware Error:", error.message);
            res.status(401).json({ message: 'Authentication failed! Please log in again.' });
        }
    };
