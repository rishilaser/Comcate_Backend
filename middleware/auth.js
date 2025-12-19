const jwt = require('jsonwebtoken');

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];
  
  console.log('Auth Middleware Debug:', {
    url: req.url,
    method: req.method,
    authHeader: authHeader,
    token: token ? `${token.substring(0, 20)}...` : 'Missing',
    fullToken: token
  });
  
  if (!token) {
    console.log('No token provided');
    return res.status(401).json({ 
      success: false,
      message: 'Access token required' 
    });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-super-secret-jwt-key-here-make-it-very-long-and-secure-for-production-use', (err, decoded) => {
    if (err) {
      console.log('Token verification failed:', err.message);
      return res.status(403).json({ 
        success: false,
        message: 'Invalid token' 
      });
    }
    
    console.log('Token verified successfully:', { userId: decoded.userId, role: decoded.role });
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  });
};

// Middleware to check if user is admin/backoffice
const requireAdmin = (req, res, next) => {
  if (!['admin', 'backoffice'].includes(req.userRole)) {
    return res.status(403).json({ 
      success: false,
      message: 'Admin access required' 
    });
  }
  next();
};

// Middleware to check if user is back office/admin/subadmin
const requireBackOffice = (req, res, next) => {
  console.log('=== REQUIRE BACK OFFICE CHECK ===');
  console.log('User role:', req.userRole);
  console.log('User ID:', req.userId);
  
  if (!['admin', 'backoffice', 'subadmin'].includes(req.userRole)) {
    console.log('Access denied - insufficient role:', req.userRole);
    return res.status(403).json({ 
      success: false,
      message: 'Back office access required' 
    });
  }
  
  console.log('Access granted for role:', req.userRole);
  next();
};

// Middleware to check quotation creation permission
const requireQuotationPermission = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Admin and backoffice always have permission
    if (['admin', 'backoffice'].includes(user.role)) {
      return next();
    }

    // Sub-admin needs specific permission
    if (user.role === 'subadmin' && user.permissions.canCreateQuotations) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: 'Insufficient permissions to create quotations'
    });
  } catch (error) {
    console.error('Permission check error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

module.exports = {
  authenticateToken,
  requireAdmin,
  requireBackOffice,
  requireQuotationPermission
};
