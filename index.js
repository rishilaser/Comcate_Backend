const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const http = require('http');
const websocketService = require('./services/websocketService');
require('dotenv').config();

// Routes will be imported after mongoose connection

const app = express();
const PORT = process.env.PORT || 5000;

// Increase timeout for large file uploads
app.timeout = 300000; // 5 minutes
app.keepAliveTimeout = 300000; // 5 minutes
app.headersTimeout = 300000; // 5 minutes

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Ensure inquiries subdirectory exists
const inquiriesDir = path.join(uploadsDir, 'inquiries');
if (!fs.existsSync(inquiriesDir)) {
  fs.mkdirSync(inquiriesDir, { recursive: true });
}

// Security middleware with CSP configuration
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
}));


// CORS configuration for production
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000', // Development
      'http://localhost:3001', // Alternative development port
      // 'http://127.0.0.1:3000', // Alternative localhost
      // 'http://127.0.0.1:3001', // Alternative localhost port
      // 'https://komacut-frontend.onrender.com', // Production frontend
      // 'https://comcat-frontend.onrender.com', // Alternative frontend URL
      // 'https://comcat-frontends.onrender.com', // Your actual frontend URL
      process.env.CLIENT_URL, // From environment variable
    ].filter(Boolean); // Remove undefined values
    
    // Check if origin matches any allowed origin
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else if (origin.includes('.onrender.com') || origin.includes('.netlify.app') || origin.includes('.vercel.app')) {
      // Allow all Render, Netlify, and Vercel subdomains
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

// Use more permissive CORS in development
if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
  app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
  }));
} else {
  app.use(cors(corsOptions));
}
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// File upload middleware - Use absolute paths with proper headers
app.use('/uploads', (req, res, next) => {
  // Set proper CORS headers for file access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Content-Type', 'application/pdf');
  next();
}, express.static(path.join(__dirname, 'uploads')));

app.use('/test-files', express.static(path.join(__dirname, 'test-files')));

// Routes will be loaded after mongoose connection

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Cutbend Server is running' });
});

// Test endpoint for debugging
app.get('/api/test', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Test endpoint working',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development'
  });
});

// Serve test HTML file
app.get('/test-inquiry', (req, res) => {
  res.sendFile(path.join(__dirname, 'test-inquiry.html'));
});

// Serve role change tool
app.get('/change-role', (req, res) => {
  res.sendFile(path.join(__dirname, 'change-role.html'));
});

// Serve role change JavaScript file
app.get('/change-role.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'change-role.js'));
});

// Serve test files download page
app.get('/download-test-files', (req, res) => {
  res.sendFile(path.join(__dirname, 'download-test-files.html'));
});

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://abhishekm:ouRpXr0E4NnlT7Me@cluster0.mwqeffk.mongodb.net/komacut?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI, {
  // Modern MongoDB driver options
  serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
})
.then(() => {
  
  // Import models first
  require('./models/User');
  require('./models/Inquiry');
  require('./models/Quotation');
  require('./models/Order');
  require('./models/Notification');
  
  // Import routes after mongoose connection
  const authRoutes = require('./routes/auth');
  const inquiryRoutes = require('./routes/inquiry');
  const quotationRoutes = require('./routes/quotation');
  const orderRoutes = require('./routes/order');
  const paymentRoutes = require('./routes/payment');
  const dispatchRoutes = require('./routes/dispatch');
  const notificationRoutes = require('./routes/notifications');
  const contactRoutes = require('./routes/contact');
  const adminRoutes = require('./routes/admin');
  const pdfExtractRoutes = require('./routes/pdfExtract');
  const zipExtractRoutes = require('./routes/zipExtract');
  const dashboardRoutes = require('./routes/dashboard');
  const analyticsRoutes = require('./routes/analytics');
  
  // Use routes
  app.use('/api/auth', authRoutes);
  app.use('/api/inquiry', inquiryRoutes);
  app.use('/api/quotation', quotationRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/payment', paymentRoutes);
  app.use('/api/dispatch', dispatchRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/contact', contactRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/inquiry', pdfExtractRoutes);
  app.use('/api/inquiry', zipExtractRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/analytics', analyticsRoutes);
  
  // Error handling middleware (must be last)
  const errorHandler = require('./middleware/errorHandler');
  app.use(errorHandler);
  
  // Create HTTP server
  const server = http.createServer(app);
  
  // Initialize WebSocket service
  websocketService.initialize(server);
  
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server running on /ws`);
    console.log(`Uploads directory: ${uploadsDir}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`MongoDB URI: ${MONGODB_URI}`);
  });
})
.catch((error) => {
  console.error('MongoDB connection error:', error);
 
  // Exit process if MongoDB connection fails
  process.exit(1);
});
