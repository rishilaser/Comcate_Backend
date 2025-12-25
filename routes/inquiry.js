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
const { uploadPdfToCloudinary } = require('../services/cloudinaryService');
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
    fileSize: 5 * 1024 * 1024, // 5MB limit per file (all file types)
    files: 100, // Maximum 100 files
    fieldSize: 10 * 1024 * 1024 // 10MB for text fields
  }
});

// Error handling middleware for Multer
const handleMulterErrors = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: `File too large. Maximum file size is 5MB. File "${error.field}" exceeded the limit.`,
        error: 'FILE_TOO_LARGE',
        maxSize: '5MB'
      });
    } else if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json({
        success: false,
        message: 'Too many files. Maximum 100 files allowed.',
        error: 'TOO_MANY_FILES',
        maxFiles: 100
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
router.post('/test', upload.array('files', 100), handleMulterErrors, (req, res) => {
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
router.post('/debug', upload.array('files', 100), handleMulterErrors, (req, res) => {
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
router.post('/', authenticateToken, upload.array('files', 100), handleMulterErrors, [
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

    const MAX_FILES = 100;
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one file is required'
      });
    }
    
    if (req.files.length > MAX_FILES) {
      return res.status(400).json({
        success: false,
        message: `Maximum ${MAX_FILES} files allowed. You uploaded ${req.files.length} file(s). Please remove ${req.files.length - MAX_FILES} file(s).`
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

    // Process uploaded files - read into Buffer and save to database
    // Only log in development
    if (process.env.NODE_ENV === 'development') {
      console.log('💾 ===== BACKEND: PROCESSING INQUIRY FILES =====');
    }
    const files = [];
    
    // OPTIMIZED: Process files quickly - store PDFs temporarily, upload to Cloudinary async
    const filePromises = req.files.map(async (file) => {
      const fileType = path.extname(file.originalname).toLowerCase();
      const isPdf = fileType === '.pdf';
      
      // Validate ALL file types - 5MB limit for all files
      if (file.size > 5 * 1024 * 1024) {
        throw new Error(`File "${file.originalname}" exceeds 5MB limit. File size: ${(file.size / 1024 / 1024).toFixed(2)}MB`);
      }
      
      // If PDF, store file path temporarily (upload to Cloudinary async after response)
      if (isPdf) {
        // Store file path temporarily - will upload to Cloudinary async
        return {
          originalName: file.originalname,
          fileName: file.filename,
          filePath: file.path, // Temporary path - will be replaced with Cloudinary URL
          fileSize: file.size,
          fileType: fileType,
          cloudinaryUrl: null, // Will be set async
          cloudinaryPublicId: null, // Will be set async
          fileData: null, // Don't store PDF in MongoDB
          uploadedAt: new Date(),
          _tempPath: file.path, // Mark for async Cloudinary upload
          _isPdf: true
        };
      } else {
        // For non-PDF files, keep existing behavior (store in MongoDB)
        let fileBuffer = null;
        try {
          if (fs.existsSync(file.path)) {
            fileBuffer = fs.readFileSync(file.path);
          }
        } catch (readError) {
          if (process.env.NODE_ENV === 'development') {
            console.error(`   ❌ Error reading file: ${readError.message}`);
          }
        }
        
        const fileData = {
          originalName: file.originalname,
          fileName: file.filename,
          filePath: file.path, // Keep for backward compatibility
          fileSize: file.size,
          fileType: fileType,
          fileData: fileBuffer, // Store file as binary in database
          uploadedAt: new Date()
        };
        
        // Delete file from filesystem after reading (only if successfully read)
        if (fileBuffer && fs.existsSync(file.path)) {
          try {
            fs.unlinkSync(file.path);
          } catch (deleteError) {
            if (process.env.NODE_ENV === 'development') {
              console.error(`   ⚠️  Error deleting file: ${deleteError.message}`);
            }
          }
        }
        
        return fileData;
      }
    });
    
    // Wait for all files to be processed
    const processedFiles = await Promise.all(filePromises);
    files.push(...processedFiles);

    // OPTIMIZED: Excel processing moved to async (after response) for faster API
    const excelFiles = files.filter(file => ['.xlsx', '.xls'].includes(file.fileType));
    // Note: Excel components will be processed async and merged later

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

      // Note: Excel components processing moved to async (after response)
      // Form parts are used immediately for faster response

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


    // OPTIMIZED: Create inquiry with cleaned files (remove temp properties)
    const cleanedFiles = files.map(f => {
      const { _tempPath, _isPdf, ...fileData } = f;
      return fileData;
    });

    const inquiry = new Inquiry({
      customer: req.userId,
      files: cleanedFiles,
      parts: processedParts,
      deliveryAddress: processedDeliveryAddress,
      specialInstructions: specialInstructions || '',
      expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null
    });

    // Save inquiry quickly (without waiting for Cloudinary)
    await inquiry.save();

    // Send response immediately to user (before any async operations)
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

    // OPTIMIZED: Upload PDFs to Cloudinary asynchronously (after response sent)
    const pdfFilesToUpload = files.filter(f => f._isPdf && f._tempPath);
    if (pdfFilesToUpload.length > 0) {
      setImmediate(async () => {
        try {
          const uploadPromises = pdfFilesToUpload.map(async (fileData) => {
            try {
              if (fs.existsSync(fileData._tempPath)) {
                const fileBuffer = fs.readFileSync(fileData._tempPath);
                const cloudinaryResult = await uploadPdfToCloudinary(
                  fileBuffer,
                  fileData.originalName,
                  'inquiries/pdfs'
                );
                
                // Update inquiry with Cloudinary URL
                await Inquiry.updateOne(
                  { _id: inquiry._id, 'files.fileName': fileData.fileName },
                  {
                    $set: {
                      'files.$.filePath': cloudinaryResult.url,
                      'files.$.cloudinaryUrl': cloudinaryResult.url,
                      'files.$.cloudinaryPublicId': cloudinaryResult.public_id
                    }
                  }
                );
                
                // Delete temp file
                try {
                  fs.unlinkSync(fileData._tempPath);
                } catch (e) {}
              }
            } catch (error) {
              console.error(`Error uploading PDF ${fileData.originalName} to Cloudinary:`, error.message);
            }
          });
          
          await Promise.all(uploadPromises);
        } catch (error) {
          console.error('Error in async Cloudinary upload:', error);
        }
      });
    }

    // OPTIMIZED: Process Excel files asynchronously (after response)
    if (excelFiles.length > 0) {
      setImmediate(async () => {
        try {
          const excelPromises = excelFiles.map(async (excelFile) => {
            try {
              if (!excelFile.fileData) return [];
              
              const tempPath = path.join(__dirname, '..', 'uploads', 'temp', `excel-${Date.now()}-${Math.random().toString(36).substring(7)}.xlsx`);
              const tempDir = path.dirname(tempPath);
              if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
              }
              
              fs.writeFileSync(tempPath, excelFile.fileData);
              const excelResult = await processExcelFile(tempPath);
              
              // Delete temp file after processing
              if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
              }
              
              if (excelResult.success && excelResult.components && excelResult.components.length > 0) {
                // Update inquiry with Excel components
                await Inquiry.updateOne(
                  { _id: inquiry._id },
                  { $push: { parts: { $each: excelResult.components } } }
                );
              }
              
              return excelResult.components || [];
            } catch (error) {
              console.error(`Error processing Excel file ${excelFile.originalName}:`, error);
              return [];
            }
          });
          
          await Promise.all(excelPromises);
        } catch (error) {
          console.error('Error in async Excel processing:', error);
        }
      });
    }

    // OPTIMIZED: Send notifications asynchronously (don't block response)
    setImmediate(async () => {
      try {
        // Populate customer data for notification (async)
        await inquiry.populate('customer', 'firstName lastName email companyName phoneNumber');
        
        // Send email notification to back office (async)
        try {
          await sendInquiryNotification(inquiry);
        } catch (emailError) {
          console.error('❌ Inquiry email notification failed:', emailError.message);
        }

        // OPTIMIZED: Create notifications in parallel
        try {
          const backOfficeUsers = await User.find({ role: { $in: ['admin', 'backoffice'] } }).lean().select('_id');
          
          const notificationPromises = backOfficeUsers.map(user => 
            Notification.createNotification({
              title: 'New Inquiry Received',
              message: `Inquiry ${inquiry.inquiryNumber} received from ${inquiry.customer?.firstName || 'Customer'} ${inquiry.customer?.lastName || ''}. ${inquiry.parts.length} parts, ${inquiry.files.length} files. Please review.`,
              type: 'info',
              userId: user._id,
              relatedEntity: {
                type: 'inquiry',
                entityId: inquiry._id
              },
              metadata: {
                inquiryNumber: inquiry.inquiryNumber,
                customerName: `${inquiry.customer?.firstName || ''} ${inquiry.customer?.lastName || ''}`.trim() || 'Customer',
                customerEmail: inquiry.customer?.email || '',
                partsCount: inquiry.parts.length,
                filesCount: inquiry.files.length
              }
            })
          );
          
          await Promise.all(notificationPromises);
          
          // Send real-time WebSocket notification
          try {
            websocketService.notifyNewInquiry(inquiry);
          } catch (wsError) {
            console.error('WebSocket notification failed:', wsError);
          }
          
        } catch (notificationError) {
          console.error('Failed to create notifications:', notificationError);
        }
      } catch (error) {
        console.error('Error in async notification processing:', error);
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

// Get customer inquiries - ULTRA OPTIMIZED for <1s response
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, sortBy = 'createdAt', sortOrder = 'desc', search, limit = 500 } = req.query;
    
    // Build query
    let query = { customer: req.userId };
    
    // Add status filter if provided
    if (status && status !== 'all') {
      query.status = status;
    }
    
    // Add search functionality (optimized with index hint)
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

    // ULTRA OPTIMIZED: Limit results, select only essential fields, minimal populate
    const inquiries = await Inquiry.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .populate('customer', 'firstName lastName companyName')
      .populate('quotation', 'quotationNumber status totalAmount validUntil')
      .lean() // Use lean for better performance
      .select('inquiryNumber status customer quotation parts deliveryAddress specialInstructions expectedDeliveryDate createdAt files.originalName files.fileType files.fileSize files.cloudinaryUrl'); // Select only needed fields

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

// Get all inquiries (Back Office) - ULTRA OPTIMIZED
router.get('/admin/all', authenticateToken, requireBackOffice, async (req, res) => {
  try {
    const { limit = 500 } = req.query; // Default limit to 500 for faster response
    
    // OPTIMIZED: Limit results and select only essential fields
    const inquiries = await Inquiry.find()
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .populate('customer', 'firstName lastName companyName email phoneNumber')
      .lean()
      .select('inquiryNumber status customer parts deliveryAddress specialInstructions expectedDeliveryDate createdAt quotation files.originalName files.fileType files.fileSize files.cloudinaryUrl'); // Select only needed fields

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
    
    // OPTIMIZED: Use lean() for faster queries
    if (mongoose.Types.ObjectId.isValid(id)) {
      // Search by ObjectId
      inquiry = await Inquiry.findOne({
        _id: id
      })
      .populate('customer', 'firstName lastName companyName email phoneNumber')
      .populate('quotation', 'quotationNumber status totalAmount validUntil')
      .lean()
      .select('-files.fileData'); // Exclude file data
    } else {
      // Search by inquiry number
      inquiry = await Inquiry.findOne({
        inquiryNumber: id
      })
      .populate('customer', 'firstName lastName companyName email phoneNumber')
      .populate('quotation', 'quotationNumber status totalAmount validUntil')
      .lean()
      .select('-files.fileData'); // Exclude file data
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

// Get specific inquiry - Allow both customers and admins
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if ID is valid
    if (!id || id === 'undefined' || id === 'null' || id.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Invalid inquiry ID provided',
        receivedId: id,
        error: 'ID cannot be undefined, null, or empty'
      });
    }
    
    // Check if user is admin/backoffice - they can access any inquiry
    const isAdmin = ['admin', 'backoffice', 'subadmin'].includes(req.userRole);
    
    let inquiry;
    
    // OPTIMIZED: Use lean() for faster queries
    if (mongoose.Types.ObjectId.isValid(id)) {
      // Search by ObjectId
      if (isAdmin) {
        // Admin can access any inquiry
        inquiry = await Inquiry.findOne({
          _id: id
        })
        .populate('customer', 'firstName lastName companyName email phoneNumber')
        .populate('quotation', 'quotationNumber status totalAmount validUntil')
        .lean()
        .select('-files.fileData');
      } else {
        // Customer can only access their own inquiries
        inquiry = await Inquiry.findOne({
          _id: id,
          customer: req.userId
        })
        .populate('customer', 'firstName lastName companyName')
        .populate('quotation', 'quotationNumber status totalAmount validUntil')
        .lean()
        .select('-files.fileData');
      }
    } else {
      // Search by inquiry number
      if (isAdmin) {
        // Admin can access any inquiry
        inquiry = await Inquiry.findOne({
          inquiryNumber: id
        })
        .populate('customer', 'firstName lastName companyName email phoneNumber')
        .populate('quotation', 'quotationNumber status totalAmount validUntil')
        .lean()
        .select('-files.fileData');
      } else {
        // Customer can only access their own inquiries
        inquiry = await Inquiry.findOne({
          inquiryNumber: id,
          customer: req.userId
        })
        .populate('customer', 'firstName lastName companyName')
        .populate('quotation', 'quotationNumber status totalAmount validUntil')
        .lean()
        .select('-files.fileData');
      }
    }

    if (!inquiry) {
      // Check if inquiry exists but user doesn't have access
      const inquiryExists = await Inquiry.findOne(
        mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { inquiryNumber: id }
      ).lean().select('_id customer');
      
      if (inquiryExists && !isAdmin) {
        // Inquiry exists but doesn't belong to user
        return res.status(403).json({
          success: false,
          message: 'Access denied. This inquiry does not belong to you.',
          searchedId: id
        });
      }
      
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
    console.error('Get inquiry error:', error);
    console.error('Request params:', req.params);
    console.error('User ID:', req.userId);
    console.error('User role:', req.userRole);
    
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
    
    // Query inquiry with fileData field included (bypass toJSON using lean)
    let inquiry;
    if (isAdmin) {
      // Admin users can access any inquiry - use lean to get raw document with fileData
      inquiry = await Inquiry.findOne({
        _id: id
      })
      .lean() // Get raw MongoDB document, bypass toJSON
      .populate('customer', 'firstName lastName companyName');
    } else {
      // Regular users can only access their own inquiries
      inquiry = await Inquiry.findOne({
        _id: id,
        customer: req.userId
      })
      .lean() // Get raw MongoDB document, bypass toJSON
      .populate('customer', 'firstName lastName companyName');
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
    console.log('Files in inquiry:', inquiry.files ? inquiry.files.length : 0);

    // Find the file in the inquiry
    const file = inquiry.files.find(f => f.fileName === filename || f.originalName === filename);
    
    if (!file) {
      console.log('File not found in inquiry. Available files:', inquiry.files.map(f => ({ fileName: f.fileName, originalName: f.originalName })));
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    console.log('File found:', file.originalName);
    console.log('File has fileData:', !!file.fileData);
    console.log('File fileData type:', file.fileData ? typeof file.fileData : 'null');
    console.log('File fileData is Buffer:', file.fileData ? Buffer.isBuffer(file.fileData) : false);
    console.log('File path (for backward compatibility):', file.filePath);

    // Get file buffer - prioritize database storage, fallback to filesystem
    let fileBuffer = null;
    
    // First, try to get from database (new format)
    if (file.fileData) {
      console.log('📦 Reading file from database (Buffer)');
      console.log('   - fileData type:', typeof file.fileData);
      console.log('   - fileData constructor:', file.fileData?.constructor?.name);
      console.log('   - Is Buffer:', Buffer.isBuffer(file.fileData));
      
      // Handle different Buffer formats (direct Buffer, Mongoose Binary, $binary.base64)
      if (Buffer.isBuffer(file.fileData)) {
        fileBuffer = file.fileData;
        console.log('   ✅ Direct Buffer detected');
      } else if (file.fileData.buffer && Buffer.isBuffer(file.fileData.buffer)) {
        fileBuffer = file.fileData.buffer;
        console.log('   ✅ Buffer from .buffer property');
      } else if (file.fileData.$binary && file.fileData.$binary.base64) {
        try {
          fileBuffer = Buffer.from(file.fileData.$binary.base64, 'base64');
          console.log('   ✅ Decoded from $binary.base64');
        } catch (e) {
          console.error('   ❌ Error decoding base64:', e);
        }
      } else if (typeof file.fileData === 'string') {
        try {
          fileBuffer = Buffer.from(file.fileData, 'base64');
          console.log('   ✅ Decoded from string base64');
        } catch (e) {
          console.error('   ❌ Error decoding string as base64:', e);
        }
      } else if (file.fileData.type === 'Buffer' && Array.isArray(file.fileData.data)) {
        // Handle MongoDB export format: { type: 'Buffer', data: [1,2,3...] }
        try {
          fileBuffer = Buffer.from(file.fileData.data);
          console.log('   ✅ Decoded from Buffer type array');
        } catch (e) {
          console.error('   ❌ Error creating buffer from array:', e);
        }
      } else {
        console.log('   ⚠️  Unknown fileData format:', JSON.stringify(Object.keys(file.fileData || {})));
      }
      
      if (fileBuffer && fileBuffer.length > 0) {
        console.log(`✅ File buffer loaded from database, size: ${fileBuffer.length} bytes`);
      } else {
        console.log('⚠️  Could not extract buffer from fileData, trying filesystem...');
      }
    } else {
      console.log('⚠️  No fileData in database, trying filesystem...');
    }
    
    // Fallback to filesystem (old format - backward compatibility)
    if (!fileBuffer && file.filePath && fs.existsSync(file.filePath)) {
      console.log('📂 Reading file from filesystem (backward compatibility)');
      try {
        fileBuffer = fs.readFileSync(file.filePath);
        console.log(`✅ File loaded from filesystem, size: ${fileBuffer.length} bytes`);
      } catch (readError) {
        console.error('❌ Error reading file from filesystem:', readError);
      }
    }
    
    // If still no buffer, return error
    if (!fileBuffer || fileBuffer.length === 0) {
      console.log('❌ File not found in database or filesystem');
      return res.status(404).json({
        success: false,
        message: 'File not found on server'
      });
    }

    console.log('📤 Starting file download...');

    // Determine content type
    const contentType = file.fileType || 'application/octet-stream';
    
    // Set appropriate headers and send file
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fileBuffer.length);
    
    res.send(fileBuffer);

  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Upload additional files to existing inquiry
router.post('/:id/upload', authenticateToken, upload.array('files', 100), handleMulterErrors, async (req, res) => {
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

    console.log('💾 ===== BACKEND: UPLOADING ADDITIONAL FILES TO INQUIRY =====');
    const uploadedFiles = [];
    
    for (const file of req.files) {
      const fileType = path.extname(file.originalname).toLowerCase();
      const isPdf = fileType === '.pdf';
      
      // Validate PDF file size (5MB limit)
      if (isPdf && file.size > 5 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          message: `PDF file "${file.originalname}" exceeds 5MB limit. File size: ${(file.size / 1024 / 1024).toFixed(2)}MB`
        });
      }
      
      console.log(`📄 Processing file: ${file.originalname}`);
      console.log(`   - Path: ${file.path}`);
      console.log(`   - Size: ${file.size} bytes`);
      console.log(`   - Type: ${isPdf ? 'PDF → Cloudinary' : 'Other → MongoDB'}`);
      
      // If PDF, upload to Cloudinary
      if (isPdf) {
        try {
          // Read file buffer
          let fileBuffer = null;
          if (fs.existsSync(file.path)) {
            fileBuffer = fs.readFileSync(file.path);
            console.log(`   ✅ File read successfully, Buffer size: ${fileBuffer.length} bytes`);
          } else {
            console.log(`   ⚠️  File not found at path: ${file.path}`);
            continue;
          }
          
          // Upload to Cloudinary
          const cloudinaryResult = await uploadPdfToCloudinary(
            fileBuffer,
            file.originalname,
            'inquiries/pdfs'
          );
          
          // Delete file from filesystem after upload
          if (fs.existsSync(file.path)) {
            try {
              fs.unlinkSync(file.path);
              console.log(`   🗑️  File deleted from filesystem: ${file.path}`);
            } catch (deleteError) {
              console.error(`   ⚠️  Error deleting file: ${deleteError.message}`);
            }
          }
          
          // Store file data with Cloudinary URL
          const fileData = {
            originalName: file.originalname,
            fileName: file.filename,
            filePath: cloudinaryResult.url, // Store Cloudinary URL
            fileSize: file.size,
            fileType: fileType,
            cloudinaryUrl: cloudinaryResult.url,
            cloudinaryPublicId: cloudinaryResult.public_id,
            fileData: null, // Don't store PDF in MongoDB
            uploadedAt: new Date()
          };
          
          uploadedFiles.push(fileData);
          
        } catch (cloudinaryError) {
          console.error(`❌ Error uploading PDF to Cloudinary: ${cloudinaryError.message}`);
          // Fallback: store in MongoDB if Cloudinary fails
          let fileBuffer = null;
          try {
            if (fs.existsSync(file.path)) {
              fileBuffer = fs.readFileSync(file.path);
            }
          } catch (readError) {
            console.error(`   ❌ Error reading file: ${readError.message}`);
          }
          
          const fileData = {
            originalName: file.originalname,
            fileName: file.filename,
            filePath: file.path,
            fileSize: file.size,
            fileType: fileType,
            fileData: fileBuffer,
            uploadedAt: new Date()
          };
          
          uploadedFiles.push(fileData);
          
          if (fileBuffer && fs.existsSync(file.path)) {
            try {
              fs.unlinkSync(file.path);
            } catch (deleteError) {
              console.error(`   ⚠️  Error deleting file: ${deleteError.message}`);
            }
          }
        }
      } else {
        // For non-PDF files, keep existing behavior
        let fileBuffer = null;
        try {
          if (fs.existsSync(file.path)) {
            fileBuffer = fs.readFileSync(file.path);
            console.log(`   ✅ File read successfully, Buffer size: ${fileBuffer.length} bytes`);
          } else {
            console.log(`   ⚠️  File not found at path: ${file.path}`);
          }
        } catch (readError) {
          console.error(`   ❌ Error reading file: ${readError.message}`);
        }
        
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
          filePath: file.path, // Keep for backward compatibility
          fileSize: file.size,
          fileType: file.mimetype,
          fileData: fileBuffer, // Store file as binary in database
          uploadedAt: new Date()
        };

        uploadedFiles.push(fileData);
        
        // Delete file from filesystem after reading (only if successfully read)
        if (fileBuffer && fs.existsSync(file.path)) {
          try {
            fs.unlinkSync(file.path);
            console.log(`   🗑️  File deleted from filesystem: ${file.path}`);
          } catch (deleteError) {
            console.error(`   ⚠️  Error deleting file: ${deleteError.message}`);
          }
        }
      }
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

    // Delete uploaded files from filesystem (only if they exist - backward compatibility)
    // Note: Files are now stored in database, but we still clean up old filesystem files
    inquiry.files.forEach(file => {
      if (file.filePath && fs.existsSync(file.filePath)) {
        try {
          fs.unlinkSync(file.filePath);
        } catch (error) {
          console.error('Error deleting file from filesystem:', error);
        }
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
    
    // Query inquiry with fileData field included (bypass toJSON using lean)
    let inquiry;
    if (isAdmin) {
      // Admin users can access any inquiry - use lean to get raw document with fileData
      inquiry = await Inquiry.findOne({
        _id: id
      })
      .lean() // Get raw MongoDB document, bypass toJSON
      .populate('customer', 'firstName lastName companyName');
    } else {
      // Regular users can only access their own inquiries
      inquiry = await Inquiry.findOne({
        _id: id,
        customer: req.userId
      })
      .lean() // Get raw MongoDB document, bypass toJSON
      .populate('customer', 'firstName lastName companyName');
    }

    if (!inquiry) {
      console.log('Inquiry not found. ID:', id, 'User ID:', req.userId, 'Is Admin:', isAdmin);
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    console.log('Inquiry found:', inquiry.inquiryNumber);
    console.log('Files in inquiry:', inquiry.files ? inquiry.files.length : 0);

    // Check if there are files to download
    if (!inquiry.files || inquiry.files.length === 0) {
      console.log('No files found in inquiry');
      return res.status(404).json({
        success: false,
        message: 'No files found in this inquiry'
      });
    }

    // Get files with buffers - prioritize database, fallback to filesystem
    const filesWithBuffers = [];
    
    for (const file of inquiry.files) {
      let fileBuffer = null;
      
      // First, try to get from database (new format)
      if (file.fileData) {
        console.log(`📦 Reading file from database: ${file.originalName}`);
        // Handle different Buffer formats
        if (Buffer.isBuffer(file.fileData)) {
          fileBuffer = file.fileData;
        } else if (file.fileData.buffer) {
          fileBuffer = Buffer.from(file.fileData.buffer);
        } else if (file.fileData.$binary && file.fileData.$binary.base64) {
          try {
            fileBuffer = Buffer.from(file.fileData.$binary.base64, 'base64');
          } catch (e) {
            console.error('Error decoding base64:', e);
          }
        } else if (typeof file.fileData === 'string') {
          try {
            fileBuffer = Buffer.from(file.fileData, 'base64');
          } catch (e) {
            console.error('Error decoding string as base64:', e);
          }
        }
        
        if (fileBuffer && fileBuffer.length > 0) {
          console.log(`✅ File buffer loaded from database: ${file.originalName}, size: ${fileBuffer.length} bytes`);
        }
      }
      
      // Fallback to filesystem (old format - backward compatibility)
      if (!fileBuffer && file.filePath && fs.existsSync(file.filePath)) {
        console.log(`📂 Reading file from filesystem: ${file.originalName}`);
        try {
          fileBuffer = fs.readFileSync(file.filePath);
          console.log(`✅ File loaded from filesystem: ${file.originalName}, size: ${fileBuffer.length} bytes`);
        } catch (readError) {
          console.error(`❌ Error reading file from filesystem: ${readError.message}`);
        }
      }
      
      if (fileBuffer && fileBuffer.length > 0) {
        filesWithBuffers.push({
          ...file,
          buffer: fileBuffer
        });
      } else {
        console.log(`⚠️  Skipping file (no buffer available): ${file.originalName}`);
      }
    }

    if (filesWithBuffers.length === 0) {
      console.log('No files found in database or filesystem');
      return res.status(404).json({
        success: false,
        message: 'No files found on server'
      });
    }

    console.log(`Creating ZIP with ${filesWithBuffers.length} files...`);

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

    // Add files to archive from buffers
    filesWithBuffers.forEach((file, index) => {
      console.log(`Adding file ${index + 1}/${filesWithBuffers.length}: ${file.originalName} (${file.buffer.length} bytes)`);
      archive.append(file.buffer, { name: file.originalName });
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
