const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { sendWelcomeEmail } = require('../services/emailService');

const router = express.Router();

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-here-make-it-very-long-and-secure-for-production-use';

// Generate JWT Token
const generateToken = (userId, role) => {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '7d' });
};

// Customer Signup
router.post('/signup', [
  body('email').isEmail().normalizeEmail(),
  body('firstName').trim().isLength({ min: 1 }),
  body('lastName').trim().isLength({ min: 1 }),
  body('phoneNumber').trim().isLength({ min: 10 }),
  body('companyName').trim().isLength({ min: 2 }),
  body('department').isIn(['Engineering', 'Procurement', 'Design', 'Manufacturing', 'Quality Control', 'Other']),
  body('country').trim().isLength({ min: 2 }),
  body('address.street').optional().trim(),
  body('address.city').optional().trim(),
  body('address.state').optional().trim(),
  body('address.zipCode').optional().trim(),
  body('address.country').optional().trim(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
], async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation failed',
        errors: errors.array() 
      });
    }

    const { email, firstName, lastName, phoneNumber, companyName, department, country, address, password } = req.body;

    console.log('=== SIGNUP REQUEST ===');
    console.log('Email:', email);
    console.log('Address data:', address);
    console.log('=====================');

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists'
      });
    }

    // Process address data
    const processedAddress = {
      street: address?.street || '',
      city: address?.city || '',
      state: address?.state || '',
      zipCode: address?.zipCode || '',
      country: address?.country || country || ''
    };

    console.log('Processed address:', processedAddress);

    // Create new user
    const user = new User({
      email,
      firstName,
      lastName,
      phoneNumber,
      companyName,
      department,
      country,
      address: processedAddress,
      password
    });

    await user.save();

    // Send welcome email
    try {
      await sendWelcomeEmail(user.email, user.firstName);
    } catch (emailError) {
      console.error('Welcome email failed:', emailError);
      // Don't fail the signup if email fails
    }

    // Generate token
    const token = generateToken(user._id, user.role);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: user.getProfile()
    });

  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Customer Login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated'
      });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate token
    const token = generateToken(user._id, user.role);
    console.log('Login successful for user:', user.email);
    console.log('User role:', user.role);
    console.log('Token generated:', token ? 'Yes' : 'No');

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: user.getProfile()
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get user profile
router.get('/profile', async (req, res) => {
  try {
    console.log('=== GET PROFILE REQUEST ===');
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token required'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('Decoded token:', decoded);
    const user = await User.findById(decoded.id || decoded.userId);
    
    if (!user) {
      console.log('⚠️ User not found for ID:', decoded.id || decoded.userId);
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userProfile = user.getProfile();
    console.log('Sending user profile:', userProfile);
    res.json(userProfile);

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }
    
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Update user profile
router.put('/profile', async (req, res) => {
  try {
    console.log('=== UPDATE PROFILE REQUEST ===');
    console.log('Request body:', req.body);
    
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token required'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('Decoded token:', decoded);
    const user = await User.findById(decoded.id || decoded.userId);
    
    if (!user) {
      console.log('⚠️ User not found for ID:', decoded.id || decoded.userId);
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    console.log('Current user data:', {
      firstName: user.firstName,
      lastName: user.lastName,
      phoneNumber: user.phoneNumber,
      companyName: user.companyName,
      address: user.address
    });

    // Update allowed fields
    const { firstName, lastName, phoneNumber, companyName, department, country, address } = req.body;
    
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (phoneNumber) user.phoneNumber = phoneNumber;
    if (companyName) user.companyName = companyName;
    if (department) user.department = department;
    if (country) user.country = country;
    
    // Update address if provided
    if (address) {
      console.log('Updating address with:', address);
      if (address.street !== undefined) user.address.street = address.street;
      if (address.city !== undefined) user.address.city = address.city;
      if (address.state !== undefined) user.address.state = address.state;
      if (address.zipCode !== undefined) user.address.zipCode = address.zipCode;
      if (address.country !== undefined) user.address.country = address.country;
    }

    await user.save();
    console.log('✅ Profile updated successfully!');
    console.log('Updated user data:', {
      firstName: user.firstName,
      lastName: user.lastName,
      phoneNumber: user.phoneNumber,
      companyName: user.companyName,
      address: user.address
    });

    const updatedProfile = user.getProfile();
    console.log('Sending updated profile:', updatedProfile);
    
    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: updatedProfile
    });

  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;
