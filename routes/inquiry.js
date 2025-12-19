const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const Inquiry = require('../models/Inquiry');
const User = require('../models/User');
const Notification = require('../models/Notification');
const Quotation = require('../models/Quotation');
const { sendInquiryNotification } = require('../services/emailService');
const { processExcelFile } = require('../services/excelService');
const mongoose = require('mongoose');
const { requireBackOffice } = require('../middleware/auth');
const websocketService = require('../services/websocketService');
const archiver = require('archiver');

const router = express.Router();

// Import authentication middleware
const { authenticateToken } = require('../middleware/auth');


// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Inquiry API is healthy',
    timestamp: new Date().toISOString()
  });
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads', 'inquiries');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['.dwg', '.dxf', '.zip', '.pdf', '.xlsx', '.xls'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only DWG, DXF, ZIP, PDF, XLSX, and XLS files are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 10, // Maximum 10 files
    fieldSize: 10 * 1024 * 1024 // 10MB for text fields
  }
});

// Error handling middleware for Multer
const handleMulterErrors = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: `File too large. Maximum file size is 100MB. File "${error.field}" exceeded the limit.`,
        error: 'FILE_TOO_LARGE',
        maxSize: '100MB'
      });
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json({
        success: false,
        message: 'Too many files. Maximum 10 files allowed.',
        error: 'TOO_MANY_FILES',
        maxFiles: 10
      });
    } else if (error.code === 'LIMIT_FIELD_COUNT') {
      return res.status(413).json({
        success: false,
        message: 'Too many form fields.',
        error: 'TOO_MANY_FIELDS'
      });
    } else {
      return res.status(413).json({
        success: false,
        message: `Upload error: ${error.message}`,
        error: error.code
      });
    }
  }
  next(error);
};

// Test endpoint to debug data format
router.post('/test', upload.array('files', 10), handleMulterErrors, (req, res) => {
  res.json({
    success: true,
    message: 'Test endpoint working',
    body: req.body,
    files: req.files ? req.files.map(f => ({ name: f.originalname, size: f.size })) : [],
    contentType: req.headers['content-type']
  });
});

// Test Inquiry model creation
router.post('/test-model', async (req, res) => {
  try {
    // Create a minimal test inquiry
    const testInquiry = new Inquiry({
      customer: '507f1f77bcf86cd799439011', // Mock ObjectId
      files: [{
        originalName: 'test.pdf',
        fileName: 'test.pdf',
        filePath: '/test/path',
        fileSize: 1024,
        fileType: '.pdf'
      }],
      parts: [{
        material: 'Steel',
        thickness: '2mm',
        quantity: 10,
        remarks: 'Test part'
      }],
      deliveryAddress: {
        street: 'Test Street',
        city: 'Test City',
        country: 'Test Country'
      },
      specialInstructions: 'Test instructions'
    });
    
    await testInquiry.save();
    
    res.json({
      success: true,
      message: 'Inquiry model test successful',
      inquiry: {
        id: testInquiry._id,
        inquiryNumber: testInquiry.inquiryNumber,
        status: testInquiry.status
      }
    });
    
  } catch (error) {
    console.error('Inquiry model test failed:', error);
    res.status(500).json({
      success: false,
      message: 'Inquiry model test failed',
      error: error.message,
      stack: error.stack
    });
  }
});

// Debug endpoint - no authentication required
router.post('/debug', upload.array('files', 10), handleMulterErrors, (req, res) => {
  try {
    // Validate required fields
    const { parts, deliveryAddress, specialInstructions } = req.body;
    
    if (!parts) {
      return res.status(400).json({
        success: false,
        message: 'Parts data is required',
        received: { parts, deliveryAddress, specialInstructions },
        analysis: {
          partsType: typeof parts,
          partsValue: parts,
          partsLength: parts ? parts.length : 'undefined'
        }
      });
    }
    
    if (!deliveryAddress) {
      return res.status(400).json({
        success: false,
        message: 'Delivery address is required',
        received: { parts, deliveryAddress, specialInstructions },
        analysis: {
          partsType: typeof parts,
          partsValue: parts,
          partsLength: parts ? parts.length : 'undefined'
        }
      });
    }
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one file is required',
        received: { parts, deliveryAddress, specialInstructions, filesCount: req.files ? req.files.length : 0 },
        analysis: {
          partsType: typeof parts,
          partsValue: parts,
          partsLength: parts ? parts.length : 'undefined'
        }
      });
    }
    
    // Try to parse JSON fields
    let parsedParts, parsedDeliveryAddress;
    try {
      parsedParts = typeof parts === 'string' ? JSON.parse(parts) : parts;
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: 'Invalid parts JSON format',
        error: e.message,
        received: parts,
        analysis: {
          partsType: typeof parts,
          partsValue: parts,
          partsLength: parts ? parts.length : 'undefined'
        }
      });
    }
    
    try {
      parsedDeliveryAddress = typeof deliveryAddress === 'string' ? JSON.parse(deliveryAddress) : deliveryAddress;
    } catch (e) {
      return res.status(400).json({
        success: false,
        message: 'Invalid delivery address JSON format',
        error: e.message,
        received: deliveryAddress
      });
    }
    
    // Additional validation to match the main endpoint
    if (!Array.isArray(parsedParts) || parsedParts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Parts must be a non-empty array (debug validation)',
        analysis: {
          partsType: typeof parsedParts,
          partsValue: parsedParts,
          partsIsArray: Array.isArray(parsedParts),
          partsLength: Array.isArray(parsedParts) ? parsedParts.length : 'not an array',
          originalParts: parts
        }
      });
    }
    
    res.json({
      success: true,
      message: 'Debug endpoint working - all data received correctly',
      data: {
        parts: parsedParts,
        deliveryAddress: parsedDeliveryAddress,
        specialInstructions,
        files: req.files.map(f => ({ name: f.originalname, size: f.size, type: f.mimetype })),
        contentType: req.headers['content-type']
      },
      analysis: {
        partsType: typeof parsedParts,
        partsIsArray: Array.isArray(parsedParts),
        partsLength: parsedParts.length,
        originalParts: parts
      }
    });
    
  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({
      success: false,
      message: 'Debug endpoint error',
      error: error.message,
      stack: error.stack
    });
  }
});

// Create new inquiry
router.post('/', authenticateToken, upload.array('files', 10), handleMulterErrors, [
  body('parts').notEmpty().withMessage('Parts data is required'),
  body('deliveryAddress').notEmpty().withMessage('Delivery address is required'),
  body('specialInstructions').optional()
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

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one file is required'
      });
    }

    const { parts, deliveryAddress, specialInstructions, expectedDeliveryDate } = req.body;

    // Validate required fields
    if (!parts || !deliveryAddress) {
      return res.status(400).json({
        success: false,
        message: 'Parts and delivery address are required'
      });
    }

    // Process uploaded files
    const files = req.files.map(file => ({
      originalName: file.originalname,
      fileName: file.filename,
      filePath: file.path,
      fileSize: file.size,
      fileType: path.extname(file.originalname).toLowerCase()
    }));


    // Process Excel files to extract component data (optimized)
    let excelComponents = [];
    const excelFiles = files.filter(file => ['.xlsx', '.xls'].includes(file.fileType));
    
    // Process Excel files in parallel for better performance
    if (excelFiles.length > 0) {
      const excelPromises = excelFiles.map(async (excelFile) => {
        try {
          const excelResult = await processExcelFile(excelFile.filePath);
          if (excelResult.success && excelResult.components.length > 0) {
            return excelResult.components;
          }
          return [];
        } catch (error) {
          console.error(`Error processing Excel file ${excelFile.originalname}:`, error);
          return [];
        }
      });
      
      const excelResults = await Promise.all(excelPromises);
      excelComponents = excelResults.flat();
    }

    // Process parts data - handle both string and object formats
    let processedParts;
    try {
      if (typeof parts === 'string') {
        processedParts = JSON.parse(parts);
      } else {
        processedParts = parts;
      }
      
      // Validate parts structure
      if (!Array.isArray(processedParts) || processedParts.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Parts must be a non-empty array'
        });
      }

      // Validate each part
      for (let i = 0; i < processedParts.length; i++) {
        const part = processedParts[i];
        if (!part.material || !part.thickness || !part.quantity) {
          return res.status(400).json({
            success: false,
            message: `Part ${i + 1} is missing required fields (material, thickness, quantity)`
          });
        }
      }
      
      processedParts = processedParts.map(part => ({
        ...part,
        material: part.material.toString().trim(),
        thickness: part.thickness.toString().trim(),
        quantity: parseInt(part.quantity),
        remarks: part.remarks ? part.remarks.toString().trim() : ''
      }));

      // Merge Excel components with form parts if available
      if (excelComponents.length > 0) {
        
        // Create a map of existing parts to avoid duplicates
        const existingPartsMap = new Map();
        processedParts.forEach(part => {
          const key = `${part.material}-${part.thickness}-${part.grade || ''}`;
          existingPartsMap.set(key, part);
        });
        
        // Add Excel components that don't conflict
        excelComponents.forEach(excelPart => {
          const key = `${excelPart.material}-${excelPart.thickness}-${excelPart.grade || ''}`;
          if (!existingPartsMap.has(key)) {
            processedParts.push({
              ...excelPart,
              material: excelPart.material.toString().trim(),
              thickness: excelPart.thickness.toString().trim(),
              quantity: parseInt(excelPart.quantity) || 1,
              remarks: excelPart.remarks ? excelPart.remarks.toString().trim() : '',
              source: 'excel'
            });
          }
        });
        
      }

    } catch (parseError) {
      console.error('Parts parsing error:', parseError);
      return res.status(400).json({
        success: false,
        message: 'Invalid parts data format - must be valid JSON array'
      });
    }

    // Process delivery address - handle both string and object formats
    let processedDeliveryAddress;
    try {
      if (typeof deliveryAddress === 'string') {
        processedDeliveryAddress = JSON.parse(deliveryAddress);
      } else {
        processedDeliveryAddress = deliveryAddress;
      }

      // Validate delivery address structure
      if (!processedDeliveryAddress.street || !processedDeliveryAddress.city || !processedDeliveryAddress.country) {
        return res.status(400).json({
          success: false,
          message: 'Delivery address must include street, city, and country'
        });
      }

    } catch (parseError) {
      console.error('Delivery address parsing error:', parseError);
      return res.status(400).json({
        success: false,
        message: 'Invalid delivery address format - must be valid JSON object'
      });
    }


    // Create inquiry
    const inquiry = new Inquiry({
      customer: req.userId,
      files,
      parts: processedParts,
      deliveryAddress: processedDeliveryAddress,
      specialInstructions: specialInstructions || '',
      expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null
    });

    await inquiry.save();

    // Populate customer data for notification
    await inquiry.populate('customer', 'firstName lastName email companyName phoneNumber');

    // Send response immediately to user
    res.status(201).json({
      success: true,
      message: 'Inquiry created successfully',
      inquiry: {
        _id: inquiry._id,
        inquiryNumber: inquiry.inquiryNumber,
        status: inquiry.status,
        totalAmount: inquiry.totalAmount
      }
    });

    // Send notifications asynchronously (don't block response)
    setImmediate(async () => {
      try {
        console.log('=== ATTEMPTING TO SEND INQUIRY EMAIL NOTIFICATION ===');
        console.log('Inquiry Number:', inquiry.inquiryNumber);
        console.log('Customer:', inquiry.customer?.email);
        console.log('Parts count:', inquiry.parts?.length);
        console.log('Files count:', inquiry.files?.length);
        
        // Send email notification to back office
        await sendInquiryNotification(inquiry);
        console.log('✅ Inquiry email notification sent successfully');
      } catch (emailError) {
        console.error('❌ Inquiry notification failed:', emailError);
        console.error('Error details:', emailError.message);
        console.error('Stack trace:', emailError.stack);
      }

      // Create notification for all back office users
      try {
        const backOfficeUsers = await User.find({ role: { $in: ['admin', 'backoffice'] } });
        
        for (const user of backOfficeUsers) {
          await Notification.createNotification({
            title: 'New Inquiry Received',
            message: `Inquiry ${inquiry.inquiryNumber} received from ${inquiry.customer.firstName} ${inquiry.customer.lastName}. ${inquiry.parts.length} parts, ${inquiry.files.length} files. Please review.`,
            type: 'info',
            userId: user._id,
            relatedEntity: {
              type: 'inquiry',
              entityId: inquiry._id
            },
            metadata: {
              inquiryNumber: inquiry.inquiryNumber,
              customerName: `${inquiry.customer.firstName} ${inquiry.customer.lastName}`,
              customerEmail: inquiry.customer.email,
              partsCount: inquiry.parts.length,
              filesCount: inquiry.files.length
            }
          });
        }
        
        
        // Send real-time WebSocket notification
        try {
          websocketService.notifyNewInquiry(inquiry);
        } catch (wsError) {
          console.error('WebSocket notification failed:', wsError);
        }
        
      } catch (notificationError) {
        console.error('Failed to create notifications:', notificationError);
      }
    });

  } catch (error) {
    console.error('Create inquiry error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Get customer inquiries
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, sortBy = 'createdAt', sortOrder = 'desc', search } = req.query;
    
    // Build query
    let query = { customer: req.userId };
    
    // Add status filter if provided
    if (status && status !== 'all') {
      query.status = status;
    }
    
    // Add search functionality
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { inquiryNumber: searchRegex },
        { specialInstructions: searchRegex }
      ];
    }
    
    // Build sort object
    let sort = {};
    if (sortBy === 'customer.companyName') {
      sort['customer.companyName'] = sortOrder === 'asc' ? 1 : -1;
    } else if (sortBy === 'inquiryNumber') {
      sort['inquiryNumber'] = sortOrder === 'asc' ? 1 : -1;
    } else {
      sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
    }

    const inquiries = await Inquiry.find(query)
      .sort(sort)
      .populate('customer', 'firstName lastName companyName')
      .populate('quotation', 'quotationNumber status totalAmount validUntil');

    res.json({
      success: true,
      inquiries
    });

  } catch (error) {
    console.error('Get inquiries error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get all inquiries (Back Office)
router.get('/admin/all', authenticateToken, requireBackOffice, async (req, res) => {
  try {
    const inquiries = await Inquiry.find()
      .sort({ createdAt: -1 })
      .populate('customer', 'firstName lastName companyName email phoneNumber');

    res.json({
      success: true,
      inquiries
    });

  } catch (error) {
    console.error('Get all inquiries error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get specific inquiry (Back Office - can access any inquiry)
router.get('/admin/:id', authenticateToken, requireBackOffice, async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log('=== ADMIN INQUIRY REQUEST ===');
    console.log('Inquiry ID:', id);
    console.log('User ID:', req.userId);
    console.log('User role:', req.userRole);
    
    // Check if ID is valid
    if (!id || id === 'undefined' || id === 'null' || id.trim() === '') {
      console.log('Invalid ID provided:', id);
      return res.status(400).json({
        success: false,
        message: 'Invalid inquiry ID provided',
        receivedId: id,
        error: 'ID cannot be undefined, null, or empty'
      });
    }
    
    console.log('Fetching inquiry (admin) with ID:', id);
    
    let inquiry;
    
    // Check if ID is a MongoDB ObjectId or inquiry number
    if (mongoose.Types.ObjectId.isValid(id)) {
      // Search by ObjectId
      inquiry = await Inquiry.findOne({
        _id: id
      })
      .populate('customer', 'firstName lastName companyName email phoneNumber')
      .populate('quotation', 'quotationNumber status totalAmount validUntil');
    } else {
      // Search by inquiry number
      inquiry = await Inquiry.findOne({
        inquiryNumber: id
      })
      .populate('customer', 'firstName lastName companyName email phoneNumber')
      .populate('quotation', 'quotationNumber status totalAmount validUntil');
    }

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found',
        searchedId: id
      });
    }

    res.json({
      success: true,
      inquiry
    });

  } catch (error) {
    console.error('Get inquiry (admin) error:', error);
    console.error('Request params:', req.params);
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Get user's own inquiries (for profile page)
// Get customer inquiries (for customer profile)
router.get('/customer', authenticateToken, async (req, res) => {
  try {
    // Only allow customers to access their own inquiries
    if (req.userRole !== 'customer') {
      return res.status(403).json({
        success: false,
        message: 'Customer access required'
      });
    }

    const inquiries = await Inquiry.find({ customer: req.userId })
      .populate('quotation', 'quotationNumber totalAmount status')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      inquiries
    });

  } catch (error) {
    console.error('Get customer inquiries error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

router.get('/my-inquiries', authenticateToken, async (req, res) => {
  try {
    const inquiries = await Inquiry.find({ customer: req.userId })
      .sort({ createdAt: -1 })
      .select('_id inquiryNumber status createdAt specialInstructions parts files');

    // Map inquiries to include description field for Profile page compatibility
    const mappedInquiries = inquiries.map(inquiry => ({
      _id: inquiry._id,
      inquiryNumber: inquiry.inquiryNumber,
      status: inquiry.status,
      createdAt: inquiry.createdAt,
      specialInstructions: inquiry.specialInstructions,
      description: inquiry.specialInstructions || 'No description provided',
      partsCount: inquiry.parts ? inquiry.parts.length : 0,
      filesCount: inquiry.files ? inquiry.files.length : 0
    }));

    res.json({
      success: true,
      inquiries: mappedInquiries
    });

  } catch (error) {
    console.error('Get my inquiries error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Download Excel template
router.get('/excel-template', async (req, res) => {
  try {
    const { generateExcelTemplate, saveExcelTemplate } = require('../services/excelService');
    
    // Create temporary file path
    const tempPath = path.join(__dirname, '..', 'uploads', 'templates', 'component-template.xlsx');
    
    // Ensure directory exists
    const templateDir = path.dirname(tempPath);
    if (!fs.existsSync(templateDir)) {
      fs.mkdirSync(templateDir, { recursive: true });
    }
    
    // Generate and save template
    const success = saveExcelTemplate(tempPath);
    
    if (success) {
      res.download(tempPath, 'component-specification-template.xlsx', (err) => {
        // Clean up temp file after download
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to generate Excel template'
      });
    }
    
  } catch (error) {
    console.error('Excel template download error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get specific inquiry
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log('=== REGULAR INQUIRY REQUEST ===');
    console.log('Inquiry ID:', id);
    console.log('User ID:', req.userId);
    console.log('User role:', req.userRole);
    
    // Check if ID is valid
    if (!id || id === 'undefined' || id === 'null' || id.trim() === '') {
      console.log('Invalid ID provided:', id);
      return res.status(400).json({
        success: false,
        message: 'Invalid inquiry ID provided',
        receivedId: id,
        error: 'ID cannot be undefined, null, or empty'
      });
    }
    
    console.log('Fetching inquiry with ID:', id);
    
    let inquiry;
    
    // Check if ID is a MongoDB ObjectId or inquiry number
    if (mongoose.Types.ObjectId.isValid(id)) {
      // Search by ObjectId
      inquiry = await Inquiry.findOne({
        _id: id,
        customer: req.userId
      })
      .populate('customer', 'firstName lastName companyName')
      .populate('quotation', 'quotationNumber status totalAmount validUntil');
    } else {
      // Search by inquiry number
      inquiry = await Inquiry.findOne({
        inquiryNumber: id,
        customer: req.userId
      })
      .populate('customer', 'firstName lastName companyName')
      .populate('quotation', 'quotationNumber status totalAmount validUntil');
    }

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found',
        searchedId: id,
        userId: req.userId
      });
    }

    res.json({
      success: true,
      inquiry
    });

  } catch (error) {
    console.error('Get inquiry error:', error);
    console.error('Request params:', req.params);
    console.error('User ID:', req.userId);
    
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Download file from inquiry
router.get('/:id/files/:filename/download', authenticateToken, async (req, res) => {
  try {
    const { id, filename } = req.params;
    
    console.log('=== FILE DOWNLOAD REQUEST ===');
    console.log('Inquiry ID:', id);
    console.log('Filename:', filename);
    console.log('User ID:', req.userId);
    console.log('User role:', req.userRole);
    
    // Check if user is admin/backoffice - they can access any inquiry
    const isAdmin = ['admin', 'backoffice', 'subadmin'].includes(req.userRole);
    console.log('Is admin user:', isAdmin);
    
    let inquiry;
    if (isAdmin) {
      // Admin users can access any inquiry
      inquiry = await Inquiry.findOne({
        _id: id
      }).populate('customer', 'firstName lastName companyName');
    } else {
      // Regular users can only access their own inquiries
      inquiry = await Inquiry.findOne({
        _id: id,
        customer: req.userId
      }).populate('customer', 'firstName lastName companyName');
    }

    if (!inquiry) {
      console.log('Inquiry not found. ID:', id, 'User ID:', req.userId, 'Is Admin:', isAdmin);
      
      // Let's also check if the inquiry exists at all
      const anyInquiry = await Inquiry.findOne({ _id: id });
      if (anyInquiry) {
        console.log('Inquiry exists but user does not have access. Inquiry customer:', anyInquiry.customer);
      } else {
        console.log('Inquiry does not exist in database');
      }
      
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    console.log('Inquiry found:', inquiry.inquiryNumber);
    console.log('Files in inquiry:', inquiry.files.length);

    // Find the file in the inquiry
    const file = inquiry.files.find(f => f.fileName === filename || f.originalName === filename);
    
    if (!file) {
      console.log('File not found in inquiry. Available files:', inquiry.files.map(f => ({ fileName: f.fileName, originalName: f.originalName })));
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    console.log('File found:', file.originalName, 'Path:', file.filePath);

    // Check if file exists on disk
    if (!fs.existsSync(file.filePath)) {
      console.log('File does not exist on disk:', file.filePath);
      return res.status(404).json({
        success: false,
        message: 'File not found on server'
      });
    }

    console.log('File exists, starting download...');

    // Set appropriate headers and send file
    res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    res.download(file.filePath, file.originalName, (err) => {
      if (err) {
        console.error('File download error:', err);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error downloading file'
          });
        }
      } else {
        console.log('File download completed successfully');
      }
    });

  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Upload additional files to existing inquiry
router.post('/:id/upload', authenticateToken, upload.array('files', 10), handleMulterErrors, async (req, res) => {
  try {
    const inquiry = await Inquiry.findOne({
      _id: req.params.id,
      customer: req.userId
    });

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded'
      });
    }

    const uploadedFiles = [];
    
    for (const file of req.files) {
      // Process Excel files to extract component data
      if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
          file.mimetype === 'application/vnd.ms-excel') {
        try {
          const excelComponents = await processExcelFile(file.path);
          // Merge with existing parts, avoiding duplicates
          const existingPartRefs = inquiry.parts.map(part => part.partRef);
          const newComponents = excelComponents.filter(comp => !existingPartRefs.includes(comp.partRef));
          
          inquiry.parts = [...inquiry.parts, ...newComponents];
        } catch (error) {
          console.error('Error processing Excel file:', error);
        }
      }

      const fileData = {
        originalName: file.originalname,
        fileName: file.filename,
        filePath: file.path,
        fileSize: file.size,
        fileType: file.mimetype,
        uploadedAt: new Date()
      };

      uploadedFiles.push(fileData);
    }

    inquiry.files = [...inquiry.files, ...uploadedFiles];
    inquiry.updatedAt = new Date();
    await inquiry.save();

    res.json({
      success: true,
      message: 'Files uploaded successfully',
      files: uploadedFiles,
      totalParts: inquiry.parts.length
    });

  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Update inquiry (before order acceptance)
router.put('/:id', authenticateToken, [
  body('parts').isArray({ min: 1 }),
  body('parts.*.material').notEmpty().trim(),
  body('parts.*.thickness').notEmpty().trim(),
  body('parts.*.quantity').isInt({ min: 1 })
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

    const inquiry = await Inquiry.findOne({
      _id: req.params.id,
      customer: req.userId,
      status: { $in: ['pending', 'reviewed', 'quoted'] }
    });

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found or cannot be modified'
      });
    }

    const { parts, specialInstructions, expectedDeliveryDate } = req.body;

    // Update parts with new timestamps
    inquiry.parts = parts.map(part => ({
      ...part,
      modified: new Date()
    }));

    if (specialInstructions) inquiry.specialInstructions = specialInstructions;
    if (expectedDeliveryDate) inquiry.expectedDeliveryDate = new Date(expectedDeliveryDate);

    inquiry.updatedAt = new Date();
    await inquiry.save();

    res.json({
      success: true,
      message: 'Inquiry updated successfully',
      inquiry
    });

  } catch (error) {
    console.error('Update inquiry error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Delete inquiry
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const inquiry = await Inquiry.findOne({
      _id: req.params.id,
      customer: req.userId,
      status: 'pending'
    });

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found or cannot be deleted'
      });
    }

    // Delete uploaded files
    inquiry.files.forEach(file => {
      if (fs.existsSync(file.filePath)) {
        fs.unlinkSync(file.filePath);
      }
    });

    await Inquiry.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Inquiry deleted successfully'
    });

  } catch (error) {
    console.error('Delete inquiry error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Admin route to update inquiry parts
router.put('/admin/:id', authenticateToken, requireBackOffice, [
  body('parts').isArray({ min: 1 }),
  body('parts.*.material').notEmpty().trim(),
  body('parts.*.thickness').notEmpty().trim(),
  body('parts.*.quantity').isInt({ min: 1 })
], async (req, res) => {
  try {
    console.log('=== ADMIN UPDATE INQUIRY ===');
    console.log('Inquiry ID:', req.params.id);
    console.log('User ID:', req.userId);
    console.log('User role:', req.userRole);
    console.log('Parts to update:', req.body.parts);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const inquiry = await Inquiry.findOne({
      _id: req.params.id
    });

    if (!inquiry) {
      console.log('Inquiry not found:', req.params.id);
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    console.log('Inquiry found:', inquiry.inquiryNumber);

    const { parts, specialInstructions, expectedDeliveryDate } = req.body;

    // Update inquiry
    inquiry.parts = parts;
    if (specialInstructions !== undefined) {
      inquiry.specialInstructions = specialInstructions;
    }
    if (expectedDeliveryDate !== undefined) {
      inquiry.expectedDeliveryDate = expectedDeliveryDate;
    }

    await inquiry.save();

    console.log('Inquiry updated successfully');

    res.json({
      success: true,
      message: 'Inquiry updated successfully',
      inquiry: inquiry
    });

  } catch (error) {
    console.error('Admin update inquiry error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Download all files from inquiry as ZIP
router.get('/:id/files/download-all', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log('=== ZIP DOWNLOAD REQUEST ===');
    console.log('Inquiry ID:', id);
    console.log('User ID:', req.userId);
    console.log('User role:', req.userRole);
    
    // Check if user is admin/backoffice - they can access any inquiry
    const isAdmin = ['admin', 'backoffice', 'subadmin'].includes(req.userRole);
    console.log('Is admin user:', isAdmin);
    
    let inquiry;
    if (isAdmin) {
      // Admin users can access any inquiry
      inquiry = await Inquiry.findOne({
        _id: id
      }).populate('customer', 'firstName lastName companyName');
    } else {
      // Regular users can only access their own inquiries
      inquiry = await Inquiry.findOne({
        _id: id,
        customer: req.userId
      }).populate('customer', 'firstName lastName companyName');
    }

    if (!inquiry) {
      console.log('Inquiry not found. ID:', id, 'User ID:', req.userId, 'Is Admin:', isAdmin);
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    console.log('Inquiry found:', inquiry.inquiryNumber);
    console.log('Files in inquiry:', inquiry.files.length);

    // Check if there are files to download
    if (!inquiry.files || inquiry.files.length === 0) {
      console.log('No files found in inquiry');
      return res.status(404).json({
        success: false,
        message: 'No files found in this inquiry'
      });
    }

    // Filter out files that exist on disk
    const existingFiles = inquiry.files.filter(file => {
      const exists = fs.existsSync(file.filePath);
      if (!exists) {
        console.log('File not found on disk:', file.filePath);
      }
      return exists;
    });

    if (existingFiles.length === 0) {
      console.log('No files exist on disk');
      return res.status(404).json({
        success: false,
        message: 'No files found on server'
      });
    }

    console.log(`Creating ZIP with ${existingFiles.length} files...`);

    // Set response headers
    const zipFilename = `${inquiry.inquiryNumber || inquiry._id}_files.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    // Create archiver instance
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Handle archiver errors
    archive.on('error', (err) => {
      console.error('Archiver error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error creating ZIP file'
        });
      }
    });

    // Handle archiver warnings
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('Archiver warning:', err);
      } else {
        console.error('Archiver error:', err);
        throw err;
      }
    });

    // Log progress
    archive.on('progress', (progress) => {
      console.log(`ZIP Progress: ${progress.entries.processed}/${progress.entries.total} files`);
    });

    // Pipe archive to response
    archive.pipe(res);

    // Add files to archive
    existingFiles.forEach((file, index) => {
      console.log(`Adding file ${index + 1}/${existingFiles.length}: ${file.originalName}`);
      archive.file(file.filePath, { name: file.originalName });
    });

    // Finalize the archive
    console.log('Finalizing ZIP archive...');
    await archive.finalize();

    console.log('ZIP download completed successfully');

  } catch (error) {
    console.error('ZIP download error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
});

module.exports = router;
