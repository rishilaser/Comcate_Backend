const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { sendQuotationEmail } = require('../services/emailService');
const { sendSMS } = require('../services/smsService');
const pdfService = require('../services/pdfService');
const Quotation = require('../models/Quotation');
const Inquiry = require('../models/Inquiry');
const { getQuotationsPath, ensureUploadsDirectories } = require('../config/uploadConfig');

// ✅ VPS-Ready: Ensure uploads directory exists before configuring multer
ensureUploadsDirectories();

// Configure multer for file uploads (VPS-compatible paths)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Use absolute path that works on VPS
    const uploadPath = getQuotationsPath();
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
      console.log('✅ Created quotations upload directory:', uploadPath);
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `quotation-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

// @route   POST /api/quotation/create
// @desc    Create a new quotation
// @access  Private (Admin/Back Office)
router.post('/create', [
  authenticateToken,
  upload.single('uploadedFile'), // Add multer middleware for file upload
  body('inquiryId').notEmpty().withMessage('Inquiry ID is required'),
  body('totalAmount').isNumeric().withMessage('Total amount must be a number')
], async (req, res) => {
  try {
    console.log('=== QUOTATION CREATE REQUEST START ===');
    console.log('User ID:', req.userId);
    console.log('User Role:', req.userRole);
    console.log('Request Body:', JSON.stringify(req.body, null, 2));
    console.log('Uploaded File:', req.file ? {
      filename: req.file.filename,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    } : 'No file uploaded');

    console.log('=== STEP 2: VALIDATING REQUEST ===');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }
    console.log('=== STEP 3: VALIDATION PASSED ===');

    const { inquiryId, parts, totalAmount, isUploadQuotation, uploadedFile, terms, notes, validUntil } = req.body;
    console.log('=== STEP 4: EXTRACTED REQUEST DATA ===');
    console.log('inquiryId:', inquiryId);
    console.log('parts:', parts);
    console.log('parts type:', typeof parts);
    console.log('parts is array:', Array.isArray(parts));
    console.log('parts length:', parts ? parts.length : 'undefined');
    console.log('parts content:', JSON.stringify(parts, null, 2));
    console.log('totalAmount:', totalAmount);

    console.log('=== STEP 5: FETCHING INQUIRY ===');
    // Get customer info from inquiry
    const inquiry = await Inquiry.findById(inquiryId).populate('customer', 'firstName lastName email companyName phoneNumber');
    console.log('=== STEP 6: INQUIRY FETCHED ===');
    if (!inquiry) {
      console.log('Inquiry not found:', inquiryId);
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    console.log('Found inquiry:', {
      id: inquiry._id,
      customer: inquiry.customer,
      customerType: typeof inquiry.customer,
      customerKeys: inquiry.customer ? Object.keys(inquiry.customer) : 'No customer object'
    });
    console.log('=== STEP 7: INQUIRY FOUND ===');

    // Check if quotation already exists for this inquiry
    console.log('=== STEP 7.5: CHECKING FOR EXISTING QUOTATION ===');
    const existingQuotation = await Quotation.findOne({ inquiryId: inquiryId.toString() });
    if (existingQuotation) {
      console.log('Quotation already exists for this inquiry:', existingQuotation._id);
      return res.status(400).json({
        success: false,
        message: 'A quotation already exists for this inquiry',
        existingQuotationId: existingQuotation._id,
        quotationNumber: existingQuotation.quotationNumber
      });
    }
    console.log('=== STEP 7.6: NO EXISTING QUOTATION FOUND ===');

    console.log('=== STEP 8: CREATING QUOTATION DATA ===');
    // Create quotation object with proper data structure
    let customerInfo;
    try {
      customerInfo = {
        name: (inquiry.customer?.firstName || '') + ' ' + (inquiry.customer?.lastName || '') || 'Customer',
        company: inquiry.customer?.companyName || 'Company',
        email: inquiry.customer?.email || 'customer@example.com',
        phone: inquiry.customer?.phoneNumber || '+1234567890'
      };
      console.log('Customer info extracted:', customerInfo);
    } catch (customerError) {
      console.error('Error extracting customer info:', customerError);
      customerInfo = {
        name: 'Customer',
        company: 'Company',
        email: 'customer@example.com',
        phone: '+1234567890'
      };
    }
    
    const quotationData = {
      inquiryId: inquiryId.toString(), // Convert ObjectId to string
      customerInfo: customerInfo,
      totalAmount: parseFloat(totalAmount),
      items: Array.isArray(parts) ? parts.map(part => ({
        partRef: part.partRef || '',
        material: part.material || 'Zintec',
        thickness: part.thickness || '1.5',
        grade: part.grade || '',
        quantity: part.quantity || 1,
        unitPrice: part.unitPrice || 0,
        totalPrice: part.totalPrice || 0,
        remark: part.remarks || part.remark || ''
      })) : [],
      quotationPdf: req.file ? req.file.filename : null, // Use actual uploaded filename from multer
      status: 'draft',
      validUntil: req.body.validUntil ? new Date(req.body.validUntil) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now if not provided
      terms: req.body.terms || 'Standard manufacturing terms apply. Payment required before production begins.',
      notes: req.body.notes || '',
      createdBy: req.userId
    };

    console.log('Quotation data to save:', JSON.stringify(quotationData, null, 2));
    console.log('Items array in quotation data:', quotationData.items);
    console.log('Items array length:', quotationData.items ? quotationData.items.length : 'undefined');
    console.log('Quotation PDF filename:', quotationData.quotationPdf);
    console.log('=== STEP 9: QUOTATION DATA CREATED ===');

    console.log('=== STEP 10: SAVING TO DATABASE ===');
    // Save quotation to database
    let savedQuotation;
    try {
      savedQuotation = await Quotation.create(quotationData);
      console.log('Quotation saved successfully:', savedQuotation._id);
      console.log('=== STEP 11: DATABASE SAVE COMPLETE ===');
    } catch (dbError) {
      console.error('Database save error:', dbError);
      console.error('Error name:', dbError.name);
      console.error('Error message:', dbError.message);
      console.error('Error code:', dbError.code);
      if (dbError.name === 'ValidationError') {
        console.error('Validation errors:', dbError.errors);
      }
      throw dbError; // Re-throw to be caught by outer try-catch
    }

    // Generate PDF for the quotation (only if not already uploaded)
    console.log('=== STEP 11.5: CHECKING PDF ===');
    console.log('Uploaded file:', req.file ? req.file.filename : 'None');
    console.log('Current quotationPdf:', savedQuotation.quotationPdf);
    
    if (!savedQuotation.quotationPdf || savedQuotation.quotationPdf === null) {
      console.log('No PDF uploaded, generating PDF...');
      try {
        // Prepare quotation data for PDF generation
        const pdfQuotationData = {
          parts: Array.isArray(parts) ? parts.map(part => ({
            partRef: part.partRef || '',
            material: part.material || 'Zintec',
            thickness: part.thickness || '1.5',
            quantity: part.quantity || 1,
            price: part.unitPrice || 0,
            remarks: part.remarks || part.remark || ''
          })) : [],
          totalAmount: parseFloat(totalAmount),
          currency: 'USD',
          validUntil: validUntil || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          terms: terms || 'Standard manufacturing terms apply. Payment required before production begins.'
        };

        // Generate PDF
        const pdfResult = await pdfService.generateQuotationPDF(inquiry, pdfQuotationData);
        console.log('PDF generated successfully:', pdfResult.fileName);

        // ✅ BEST PRACTICE: Keep generated PDF on disk, store only filename in database
        if (fs.existsSync(pdfResult.filePath)) {
          // Ensure file is in the correct location
          const permanentPath = path.join(__dirname, '../uploads/quotations', pdfResult.fileName);
          if (pdfResult.filePath !== permanentPath) {
            // Move to permanent location if needed
            if (!fs.existsSync(permanentPath)) {
              fs.renameSync(pdfResult.filePath, permanentPath);
              console.log('Generated PDF moved to permanent location');
            }
          }
          
          // Update quotation with filename only (file stays on disk)
          savedQuotation.quotationPdf = pdfResult.fileName; // Store filename - file is on disk
          savedQuotation.quotationPdfFilename = pdfResult.fileName; // Store original filename
          // Note: quotationPdfData (Buffer) is deprecated
          await savedQuotation.save();
          
          console.log('Quotation updated with PDF filename, file stored on disk');
        } else {
          console.warn('Generated PDF file not found at:', pdfResult.filePath);
          // Still save the filename
          savedQuotation.quotationPdf = pdfResult.fileName;
          await savedQuotation.save();
        }
      } catch (pdfError) {
        console.error('PDF generation failed:', pdfError);
        // Don't fail the request if PDF generation fails
      }
    } else {
      console.log('✅ PDF already uploaded, skipping generation:', savedQuotation.quotationPdf);
      
      // ✅ BEST PRACTICE: Keep uploaded PDF on disk, store only filename in database
      if (req.file && req.file.path) {
        try {
          // File is already in the correct location (uploads/quotations/)
          // Just update the filename in database
          savedQuotation.quotationPdf = req.file.filename; // Store filename - file is on disk
          savedQuotation.quotationPdfFilename = req.file.filename;
          // Note: quotationPdfData (Buffer) is deprecated
          await savedQuotation.save();
          
          console.log('Uploaded PDF filename stored, file remains on disk:', req.file.path);
        } catch (readError) {
          console.error('Error reading uploaded PDF file:', readError);
        }
      }
    }

    // Update inquiry status to 'quoted'
    console.log('=== STEP 12: UPDATING INQUIRY STATUS ===');
    try {
      await Inquiry.findByIdAndUpdate(inquiryId, { 
        status: 'quoted',
        quotation: savedQuotation._id 
      });
      console.log('Inquiry status updated to quoted');
    } catch (updateError) {
      console.error('Error updating inquiry status:', updateError);
      // Don't fail the request if inquiry update fails
    }

    // Send email to customer asynchronously (don't wait for it)
    if (quotationData.customerInfo.email && quotationData.customerInfo.email !== 'customer@example.com') {
      console.log('📧 Sending quotation email asynchronously...');
      // Fire and forget - don't await
      setImmediate(async () => {
        try {
          await sendQuotationEmail(savedQuotation);
          console.log('✅ Quotation email sent successfully');
        } catch (emailError) {
          console.error('❌ Email sending failed:', emailError);
        }
      });
    }

    // Send SMS to customer asynchronously (don't wait for it)
    if (quotationData.customerInfo.phone && quotationData.customerInfo.phone !== '+1234567890') {
      console.log('📱 Sending SMS asynchronously...');
      // Fire and forget - don't await
      setImmediate(async () => {
        try {
          await sendSMS(
            quotationData.customerInfo.phone,
            `Your quotation for inquiry ${inquiry.inquiryNumber} has been prepared. Total amount: $${totalAmount}. Please check your email for details.`
          );
          console.log('✅ SMS sent successfully');
        } catch (smsError) {
          console.error('❌ SMS sending failed:', smsError);
        }
      });
    }

    // Create notification for customer
    try {
      const Notification = require('../models/Notification');
      await Notification.createNotification({
        title: 'Quotation Created',
        message: `Your quotation ${savedQuotation.quotationNumber} has been prepared for inquiry ${inquiry.inquiryNumber}. Total amount: $${totalAmount}. Please review and accept.`,
        type: 'info',
        userId: inquiry.customer._id,
        relatedEntity: {
          type: 'quotation',
          entityId: savedQuotation._id
        },
        metadata: {
          quotationNumber: savedQuotation.quotationNumber,
          inquiryNumber: inquiry.inquiryNumber,
          totalAmount: totalAmount,
          createdAt: new Date()
        }
      });
      console.log('Customer notification created for quotation');
    } catch (notificationError) {
      console.error('Failed to create customer notification:', notificationError);
    }

    // Send real-time WebSocket notification to customer
    try {
      const websocketService = require('../services/websocketService');
      websocketService.notifyQuotationCreated(savedQuotation);
      console.log('Real-time quotation notification sent to customer');
    } catch (wsError) {
      console.error('WebSocket notification failed:', wsError);
    }

    res.json({
      success: true,
      message: 'Quotation created and sent successfully',
      quotation: savedQuotation
    });

  } catch (error) {
    console.error('=== QUOTATION CREATION ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Error name:', error.name);
    console.error('Full error object:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// @route   POST /api/quotation/upload
// @desc    Upload quotation PDF
// @access  Private (Admin/Back Office)
router.post('/upload', [
  authenticateToken,
  upload.single('quotationPdf')
], async (req, res) => {
  try {
    console.log('📄 ===== BACKEND: QUOTATION PDF UPLOAD REQUEST START =====');
    console.log('👤 User Details:');
    console.log('   - User ID:', req.userId);
    console.log('   - User Role:', req.userRole);
    console.log('📋 Request Body:');
    console.log('   - inquiryId:', req.body.inquiryId);
    console.log('   - totalAmount:', req.body.totalAmount);
    console.log('   - terms:', req.body.terms);
    console.log('   - notes:', req.body.notes);
    console.log('   - validUntil:', req.body.validUntil);
    console.log('📁 Uploaded File Details:');
    if (req.file) {
      console.log('   - File Name:', req.file.filename);
      console.log('   - Original Name:', req.file.originalname);
      console.log('   - File Path:', req.file.path);
      console.log('   - File Size:', req.file.size, 'bytes');
      console.log('   - File Size (MB):', (req.file.size / (1024 * 1024)).toFixed(2), 'MB');
      console.log('   - MIME Type:', req.file.mimetype);
      console.log('   - Field Name:', req.file.fieldname);
    } else {
      console.log('   ⚠️  NO FILE UPLOADED!');
    }

    // Validate request
    if (!req.body.inquiryId) {
      return res.status(400).json({
        success: false,
        message: 'Inquiry ID is required'
      });
    }

    if (!req.body.totalAmount) {
      return res.status(400).json({
        success: false,
        message: 'Total amount is required'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Quotation PDF file is required'
      });
    }

    const { inquiryId, customerInfo, totalAmount, terms, notes, validUntil } = req.body;
    
    // Get customer info from inquiry
    const inquiry = await Inquiry.findById(inquiryId).populate('customer', 'firstName lastName email companyName phoneNumber');
    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    // Check if quotation already exists
    const existingQuotation = await Quotation.findOne({ inquiryId: inquiryId.toString() });
    if (existingQuotation) {
      return res.status(400).json({
        success: false,
        message: 'A quotation already exists for this inquiry',
        existingQuotationId: existingQuotation._id
      });
    }

    // Prepare customer info
    let parsedCustomerInfo;
    try {
      parsedCustomerInfo = typeof customerInfo === 'string' ? JSON.parse(customerInfo) : customerInfo;
    } catch (e) {
      parsedCustomerInfo = {
        name: `${inquiry.customer?.firstName || ''} ${inquiry.customer?.lastName || ''}`.trim() || 'Customer',
        company: inquiry.customer?.companyName || 'Company',
        email: inquiry.customer?.email || 'customer@example.com',
        phone: inquiry.customer?.phoneNumber || '+1234567890'
      };
    }

    // ✅ BEST PRACTICE: Keep file on disk, store only filename in database
    console.log('💾 ===== BACKEND: VALIDATING PDF FILE =====');
    console.log('📂 File Path:', req.file.path);
    console.log('📂 File Exists?', fs.existsSync(req.file.path));
    
    // Check file stats to validate file
    const fileStats = fs.statSync(req.file.path);
    console.log('📊 File Statistics:');
    console.log('   - File Size (from stats):', fileStats.size, 'bytes');
    console.log('   - File Size (MB):', (fileStats.size / (1024 * 1024)).toFixed(2), 'MB');
    console.log('   - Original File Size (from multer):', req.file.size, 'bytes');
    
    // Validate file size
    if (fileStats.size < 100) {
      console.log('   ⚠️  WARNING: File size is very small (< 100 bytes) - PDF might be corrupted or empty!');
      // Delete invalid file
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
      return res.status(400).json({
        success: false,
        message: 'Invalid PDF file: File size is too small. Please upload a valid PDF file.',
        fileSize: fileStats.size
      });
    }
    
    // Validate PDF header (read first 4 bytes only)
    const pdfHeaderBuffer = Buffer.alloc(4);
    const fd = fs.openSync(req.file.path, 'r');
    fs.readSync(fd, pdfHeaderBuffer, 0, 4, 0);
    fs.closeSync(fd);
    const pdfHeader = pdfHeaderBuffer.toString('ascii');
    
    console.log('   - PDF Header:', pdfHeader);
    if (pdfHeader !== '%PDF') {
      console.log('   ⚠️  WARNING: File does not appear to be a valid PDF! (Header should be "%PDF")');
      // Delete invalid file
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
      return res.status(400).json({
        success: false,
        message: 'Invalid PDF file: File does not have a valid PDF header. Please upload a valid PDF file.',
        detectedHeader: pdfHeader
      });
    }
    console.log('   ✅ Valid PDF header detected');
    
    const pdfFilename = req.file.filename;
    console.log('✅ PDF File Validated Successfully:');
    console.log('   - Filename:', pdfFilename);
    console.log('   - File Path:', req.file.path);
    console.log('   - File Size:', fileStats.size, 'bytes');

    // ✅ Store only filename in database (file stays on disk)
    const quotationData = {
      inquiryId: inquiryId.toString(),
      customerInfo: parsedCustomerInfo,
      totalAmount: parseFloat(totalAmount),
      quotationPdf: pdfFilename, // Store filename only - file is on disk
      quotationPdfFilename: pdfFilename, // Store original filename
      // Note: quotationPdfData (Buffer) is deprecated - files are stored on disk
      items: [],
      status: 'draft',
      validUntil: validUntil ? new Date(validUntil) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      terms: terms || 'Standard manufacturing terms apply. Payment required before production begins.',
      notes: notes || '',
      createdBy: req.userId
    };

    console.log('💾 ===== BACKEND: PREPARING DATABASE SAVE =====');
    console.log('📦 Quotation Data Prepared:');
    console.log('   - quotationPdf (filename):', quotationData.quotationPdf);
    console.log('   - quotationPdfFilename:', quotationData.quotationPdfFilename);
    console.log('   - File stored on disk at:', req.file.path);

    // Save quotation to database (only filename, not file data)
    console.log('💾 ===== BACKEND: SAVING TO DATABASE =====');
    console.log('💾 Saving quotation with PDF filename to MongoDB (file stored on disk)...');
    const savedQuotation = await Quotation.create(quotationData);
    console.log('✅ Quotation Saved Successfully:');
    console.log('   - Quotation ID:', savedQuotation._id);
    console.log('   - Quotation Number:', savedQuotation.quotationNumber);
    console.log('   - Quotation PDF filename:', savedQuotation.quotationPdf);
    console.log('   - PDF file location: /uploads/quotations/' + savedQuotation.quotationPdf);
    
    // Verify file exists on disk (VPS-compatible path)
    console.log('🔍 ===== BACKEND: VERIFYING FILE STORAGE =====');
    const filePath = path.join(getQuotationsPath(), savedQuotation.quotationPdf);
    const fileExists = fs.existsSync(filePath);
    console.log('   - File exists on disk:', fileExists);
    if (fileExists) {
      const stats = fs.statSync(filePath);
      console.log('   - File size:', stats.size, 'bytes');
      console.log('   - File size (MB):', (stats.size / (1024 * 1024)).toFixed(2), 'MB');
      console.log('   ✅ PDF file successfully stored on disk!');
      console.log('   ✅ File accessible at: /uploads/quotations/' + savedQuotation.quotationPdf);
    } else {
      console.log('   ⚠️  WARNING: File not found on disk after save!');
    }
    
    console.log('📄 ===== BACKEND: QUOTATION PDF UPLOAD COMPLETE =====');

    // Update inquiry status
    await Inquiry.findByIdAndUpdate(inquiryId, { 
      status: 'quoted',
      quotation: savedQuotation._id 
    });

    // Create notification for customer
    try {
      const Notification = require('../models/Notification');
      await Notification.createNotification({
        title: 'Quotation Uploaded',
        message: `Your quotation ${savedQuotation.quotationNumber} has been uploaded for inquiry ${inquiry.inquiryNumber}. Total amount: $${totalAmount}.`,
        type: 'info',
        userId: inquiry.customer._id,
        relatedEntity: {
          type: 'quotation',
          entityId: savedQuotation._id
        }
      });
    } catch (notificationError) {
      console.error('Failed to create notification:', notificationError);
    }

    res.json({
      success: true,
      message: 'Quotation uploaded successfully',
      quotation: savedQuotation
    });

  } catch (error) {
    console.error('Quotation upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   GET /api/quotation
// @desc    Get all quotations (Admin/Back Office)
// @access  Private (Admin/Back Office)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { page = 1, limit = 10, status, search } = req.query;
    const skip = (page - 1) * limit;
    
    // Build query
    const query = {};
    if (status) {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { 'customerInfo.name': { $regex: search, $options: 'i' } },
        { 'customerInfo.email': { $regex: search, $options: 'i' } },
        { inquiryId: { $regex: search, $options: 'i' } }
      ];
    }

    // Get quotations with pagination
    const quotations = await Quotation.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('createdBy', 'firstName lastName email');

    // Manually populate inquiry data for each quotation
    const quotationsWithInquiry = await Promise.all(
      quotations.map(async (quotation) => {
        const quotationObj = quotation.toObject();
        try {
          // Find the inquiry using the inquiryId string
          const inquiry = await Inquiry.findById(quotation.inquiryId).populate('customer', 'firstName lastName email companyName');
          if (inquiry) {
            quotationObj.inquiry = {
              _id: inquiry._id,
              inquiryNumber: inquiry.inquiryNumber,
              customer: inquiry.customer
            };
          }
        } catch (error) {
          console.error('Error fetching inquiry for quotation:', quotation._id, error);
          quotationObj.inquiry = null;
        }
        return quotationObj;
      })
    );

    const total = await Quotation.countDocuments(query);

    console.log('=== GET QUOTATIONS DEBUG ===');
    console.log('Found quotations:', quotationsWithInquiry.length);
    console.log('Sample quotation:', quotationsWithInquiry[0] ? {
      id: quotationsWithInquiry[0]._id,
      inquiryId: quotationsWithInquiry[0].inquiryId,
      inquiry: quotationsWithInquiry[0].inquiry,
      customerInfo: quotationsWithInquiry[0].customerInfo,
      totalAmount: quotationsWithInquiry[0].totalAmount,
      status: quotationsWithInquiry[0].status,
      createdBy: quotationsWithInquiry[0].createdBy,
      quotationPdf: quotationsWithInquiry[0].quotationPdf // Added to check PDF field
    } : 'No quotations found');
    
    console.log('Quotations with PDF:');
    quotationsWithInquiry.forEach((q, i) => {
      console.log(`  ${i+1}. ${q.quotationNumber}: quotationPdf = ${q.quotationPdf || 'null'}`);
    });

    res.json({
      success: true,
      quotations: quotationsWithInquiry,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(total / limit),
        total
      }
    });

  } catch (error) {
    console.error('Get quotations error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   GET /api/quotation/customer
// @desc    Get quotations for the current customer
// @access  Private (Customer)
router.get('/customer', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 10, status } = req.query;
    const skip = (page - 1) * limit;
    
    // Get customer's inquiries
    const customerInquiries = await Inquiry.find({ customer: userId }).select('_id');
    const inquiryIds = customerInquiries.map(inquiry => inquiry._id.toString());
    
    // Build query
    const query = { inquiryId: { $in: inquiryIds } };
    if (status) {
      query.status = status;
    }

    // Get quotations with pagination
    const quotations = await Quotation.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Quotation.countDocuments(query);

    // Manually populate inquiry data for each quotation
    const quotationsWithInquiry = await Promise.all(
      quotations.map(async (quotation) => {
        const quotationObj = quotation.toObject();
        try {
          // Find the inquiry using the inquiryId string
          const inquiry = await Inquiry.findById(quotation.inquiryId).select('inquiryNumber _id');
          if (inquiry) {
            quotationObj.inquiry = {
              _id: inquiry._id,
              inquiryNumber: inquiry.inquiryNumber
            };
          }
        } catch (error) {
          console.error('Error fetching inquiry for quotation:', quotation._id, error);
          quotationObj.inquiry = null;
        }
        return quotationObj;
      })
    );

    console.log('=== GET CUSTOMER QUOTATIONS ===');
    console.log('Customer ID:', userId);
    console.log('Customer inquiries found:', customerInquiries.length);
    console.log('Inquiry IDs:', inquiryIds);
    console.log('Query:', query);
    console.log('Found quotations:', quotationsWithInquiry.length);
    console.log('Quotations with inquiry:', quotationsWithInquiry.map(q => ({ 
      id: q._id, 
      status: q.status, 
      inquiryId: q.inquiryId,
      inquiryNumber: q.inquiry?.inquiryNumber 
    })));

    res.json({
      success: true,
      quotations: quotationsWithInquiry,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(total / limit),
        total
      }
    });

  } catch (error) {
    console.error('Get customer quotations error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   GET /api/quotation/:inquiryId
// @desc    Get quotation by inquiry ID
// @access  Private
router.get('/:inquiryId', authenticateToken, async (req, res) => {
  try {
    const { inquiryId } = req.params;

    // Fetch quotation from database
    const quotation = await Quotation.findOne({ inquiryId });

    if (quotation) {
      // Manually populate inquiry data
      const quotationObj = quotation.toObject();
      try {
        // Find the inquiry using the inquiryId string
        const inquiry = await Inquiry.findById(quotation.inquiryId).populate('customer', 'firstName lastName email companyName');
        if (inquiry) {
          quotationObj.inquiry = {
            _id: inquiry._id,
            inquiryNumber: inquiry.inquiryNumber,
            customer: inquiry.customer
          };
        }
      } catch (error) {
        console.error('Error fetching inquiry for quotation:', quotation._id, error);
        quotationObj.inquiry = null;
      }

      res.json({
        success: true,
        quotation: quotationObj
      });
    } else {
      res.json({
        success: false,
        message: 'Quotation not found'
      });
    }

  } catch (error) {
    console.error('Get quotation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   GET /api/quotation/id/:id
// @desc    Get quotation by quotation ID
// @access  Private
router.get('/id/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Find the quotation by ID
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Manually populate inquiry data
    const quotationObj = quotation.toObject();
    try {
      // Find the inquiry using the inquiryId string
      const inquiry = await Inquiry.findById(quotation.inquiryId).populate('customer', 'firstName lastName email companyName');
      if (inquiry) {
        quotationObj.inquiry = {
          _id: inquiry._id,
          inquiryNumber: inquiry.inquiryNumber,
          customer: inquiry.customer
        };
      }
    } catch (error) {
      console.error('Error fetching inquiry for quotation:', quotation._id, error);
      quotationObj.inquiry = null;
    }

    res.json({
      success: true,
      quotation: quotationObj
    });

  } catch (error) {
    console.error('Get quotation by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   POST /api/quotation/:id/send
// @desc    Send quotation to customer
// @access  Private (Admin/Back Office)
router.post('/:id/send', authenticateToken, async (req, res) => {
  try {
    console.log('=== SEND QUOTATION REQUEST START ===');
    const { id } = req.params;
    console.log('Quotation ID:', id);

    // Find the quotation
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      console.log('Quotation not found:', id);
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    console.log('Found quotation:', {
      id: quotation._id,
      status: quotation.status,
      customerInfo: quotation.customerInfo,
      totalAmount: quotation.totalAmount
    });

    // Update quotation status to 'sent'
    quotation.status = 'sent';
    quotation.sentAt = new Date();
    await quotation.save();
    console.log('Quotation status updated to sent');

    // Send email to customer
    try {
      console.log('Attempting to send email...');
      if (quotation.customerInfo.email && quotation.customerInfo.email !== 'customer@example.com') {
        // Create a simple email notification
        const nodemailer = require('nodemailer');
        
        // Create transporter (basic configuration)
        const transporter = nodemailer.createTransporter({
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port: process.env.SMTP_PORT || 587,
          secure: false,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });

        const mailOptions = {
          from: process.env.SMTP_FROM || 'noreply@komacut.com',
          to: quotation.customerInfo.email,
          subject: `Quotation ${quotation.quotationNumber} - Komacut`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Your Quotation is Ready!</h2>
              <p>Dear ${quotation.customerInfo.name},</p>
              <p>Your quotation ${quotation.quotationNumber} has been prepared.</p>
              <p><strong>Total Amount:</strong> $${quotation.totalAmount}</p>
              <p>Please log in to your account to view the full quotation details.</p>
              <p>Thank you for choosing Komacut!</p>
            </div>
          `
        };

        await transporter.sendMail(mailOptions);
        console.log('Quotation email sent successfully');
      } else {
        console.log('No valid customer email for notification');
      }
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
      // Don't fail the request if email fails
    }

    // Send SMS to customer
    try {
      console.log('Attempting to send SMS...');
      console.log('Customer phone:', quotation.customerInfo.phone);
      if (quotation.customerInfo.phone) {
        const smsResult = await sendSMS(
          quotation.customerInfo.phone,
          `Your quotation ${quotation.quotationNumber} has been sent. Total amount: $${quotation.totalAmount}. Please check your email for details.`
        );
        console.log('SMS result:', smsResult);
      } else {
        console.log('No customer phone number available for SMS');
      }
    } catch (smsError) {
      console.error('SMS sending failed:', smsError);
      // Don't fail the request if SMS fails
    }

    console.log('=== SEND QUOTATION COMPLETE ===');
    res.json({
      success: true,
      message: 'Quotation sent successfully',
      quotation: quotation
    });

  } catch (error) {
    console.error('Send quotation error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   GET /api/quotation/customer/:id
// @desc    Get single quotation for customer
// @access  Private (Customer)
router.get('/customer/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;

    // Find the quotation
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Verify this quotation belongs to the customer
    const inquiry = await Inquiry.findById(quotation.inquiryId);
    if (!inquiry || inquiry.customer.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. This quotation does not belong to you.'
      });
    }

    // Manually populate inquiry data
    const quotationObj = quotation.toObject();
    try {
      const populatedInquiry = await Inquiry.findById(quotation.inquiryId).populate('customer', 'firstName lastName email companyName');
      if (populatedInquiry) {
        quotationObj.inquiry = {
          _id: populatedInquiry._id,
          inquiryNumber: populatedInquiry.inquiryNumber,
          customer: populatedInquiry.customer
        };
      }
    } catch (error) {
      console.error('Error fetching inquiry for quotation:', quotation._id, error);
      quotationObj.inquiry = null;
    }

    res.json({
      success: true,
      quotation: quotationObj
    });

  } catch (error) {
    console.error('Get customer quotation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   POST /api/quotation/:id/response
// @desc    Customer response to quotation (accept/reject)
// @access  Private (Customer)
router.post('/:id/response', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { response, notes } = req.body;
    const userId = req.userId;

    console.log('=== QUOTATION RESPONSE REQUEST ===');
    console.log('Quotation ID:', id);
    console.log('User ID:', userId);
    console.log('Response:', response);

    // Find the quotation
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Verify this quotation belongs to the customer
    const inquiry = await Inquiry.findById(quotation.inquiryId);
    if (!inquiry || inquiry.customer.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. This quotation does not belong to you.'
      });
    }

    // Update quotation status based on response
    if (response === 'accepted') {
      quotation.status = 'accepted';
      quotation.acceptedAt = new Date();
    } else if (response === 'rejected') {
      quotation.status = 'rejected';
      quotation.rejectedAt = new Date();
      quotation.rejectionReason = notes || 'No reason provided';
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid response. Must be "accepted" or "rejected"'
      });
    }

    await quotation.save();

    // Update inquiry status
    if (response === 'accepted') {
      inquiry.status = 'accepted';
    } else if (response === 'rejected') {
      inquiry.status = 'rejected';
    }
    await inquiry.save();

    console.log('Quotation response processed successfully');

    res.json({
      success: true,
      message: `Quotation ${response} successfully`,
      quotation: quotation
    });

  } catch (error) {
    console.error('Quotation response error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   GET /api/quotation/:id/pdf
// @desc    Get quotation PDF
// @access  Private
router.get('/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { download } = req.query;

    // Try to find quotation by ID first (if id is a quotation ID)
    // Use lean() to get raw MongoDB document with quotationPdfData Buffer
    let quotation = await Quotation.findById(id).lean();
    
    // If not found, try to find by inquiryId (if id is an inquiry ID)
    if (!quotation) {
      quotation = await Quotation.findOne({ inquiryId: id }).lean();
    }
    
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }
    
    console.log('📄 ===== BACKEND: QUOTATION PDF REQUEST =====');
    console.log('   - Quotation ID:', quotation._id);
    console.log('   - Has quotationPdfData:', !!quotation.quotationPdfData);
    console.log('   - quotationPdfData type:', quotation.quotationPdfData ? typeof quotation.quotationPdfData : 'null');
    console.log('   - quotationPdfData is Buffer:', quotation.quotationPdfData ? Buffer.isBuffer(quotation.quotationPdfData) : false);

    // Check access control: Admin/Back Office can view any PDF, customers can only view their own
    const isAdmin = ['admin', 'backoffice', 'subadmin'].includes(req.userRole);
    if (!isAdmin) {
      // For customers, verify the quotation belongs to them
      const inquiry = await Inquiry.findById(quotation.inquiryId);
      if (!inquiry || inquiry.customer.toString() !== userId.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. This quotation does not belong to you.'
        });
      }
    }

    // Helper function to generate PDF
    const generatePDF = async () => {
      // Get inquiry data for PDF generation
      const inquiry = await Inquiry.findById(quotation.inquiryId).populate('customer', 'firstName lastName email companyName phoneNumber');
      if (!inquiry) {
        throw new Error('Inquiry not found for this quotation');
      }

      // Prepare quotation data for PDF generation
      const pdfQuotationData = {
        parts: quotation.items && quotation.items.length > 0 
          ? quotation.items.map(item => ({
              partRef: item.partRef || '',
              material: item.material || 'Zintec',
              thickness: item.thickness || '1.5',
              quantity: item.quantity || 1,
              price: item.unitPrice || 0,
              remarks: item.remark || ''
            }))
          : [],
        totalAmount: quotation.totalAmount || 0,
        currency: 'USD',
        validUntil: quotation.validUntil || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        terms: quotation.terms || 'Standard manufacturing terms apply. Payment required before production begins.'
      };

      // Generate PDF
      const pdfResult = await pdfService.generateQuotationPDF(inquiry, pdfQuotationData);
      console.log('PDF generated successfully:', pdfResult.fileName);
      console.log('PDF file path:', pdfResult.filePath);
      console.log('PDF file size:', pdfResult.fileSize, 'bytes');

      // Return the full pdfResult object (not just filename)
      return pdfResult;
    };

    // Check if PDF data exists in database (support multiple formats)
    let pdfBuffer = null;
    let pdfFileName = `quotation_${quotation.quotationNumber}.pdf`;
    let contentType = 'application/pdf';

    // Try new format first: quotationPdfData (Buffer)
    if (quotation.quotationPdfData) {
      if (Buffer.isBuffer(quotation.quotationPdfData)) {
        // Direct Buffer format (normal MongoDB/Mongoose format)
        pdfBuffer = quotation.quotationPdfData;
        pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
        console.log('📄 PDF found in database (new format: quotationPdfData as Buffer)');
      } else if (quotation.quotationPdfData.$binary && quotation.quotationPdfData.$binary.base64) {
        // MongoDB export format with $binary.base64
        try {
          const base64String = quotation.quotationPdfData.$binary.base64;
          pdfBuffer = Buffer.from(base64String, 'base64');
          pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
          console.log('📄 PDF found in database (new format: quotationPdfData as $binary.base64)');
          console.log('   - Base64 string length:', base64String.length);
          console.log('   - Decoded buffer size:', pdfBuffer.length, 'bytes');
          
          // Validate decoded buffer
          if (pdfBuffer.length === 0) {
            console.error('❌ Decoded PDF buffer is empty!');
            pdfBuffer = null; // Reset to null so it tries other methods
          }
        } catch (base64Error) {
          console.error('❌ Error decoding base64 PDF:', base64Error);
          pdfBuffer = null; // Reset to null so it tries other methods
        }
      } else if (quotation.quotationPdfData.buffer && Buffer.isBuffer(quotation.quotationPdfData.buffer)) {
        // Mongoose Binary wrapper format
        pdfBuffer = quotation.quotationPdfData.buffer;
        pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
        console.log('📄 PDF found in database (new format: quotationPdfData as Binary wrapper)');
      } else if (quotation.quotationPdfData.subtype !== undefined || quotation.quotationPdfData.type !== undefined) {
        // Mongoose Binary type (has subtype or type property)
        try {
          // Try to convert Mongoose Binary to Buffer
          if (quotation.quotationPdfData.buffer) {
            pdfBuffer = Buffer.from(quotation.quotationPdfData.buffer);
          } else if (quotation.quotationPdfData.toString) {
            // Try converting to string then to buffer (fallback)
            const base64 = quotation.quotationPdfData.toString('base64');
            pdfBuffer = Buffer.from(base64, 'base64');
          } else {
            pdfBuffer = Buffer.from(quotation.quotationPdfData);
          }
          pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
          console.log('📄 PDF found in database (new format: quotationPdfData as Mongoose Binary)');
          console.log('   - Converted buffer size:', pdfBuffer.length, 'bytes');
        } catch (binaryError) {
          console.error('❌ Error converting Mongoose Binary to Buffer:', binaryError);
          pdfBuffer = null;
        }
      } else if (quotation.quotationPdfData.type === 'Buffer' && Array.isArray(quotation.quotationPdfData.data)) {
        // Handle MongoDB export format: { type: 'Buffer', data: [1,2,3...] }
        try {
          pdfBuffer = Buffer.from(quotation.quotationPdfData.data);
          pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
          console.log('📄 PDF found in database (new format: quotationPdfData as Buffer type array)');
          console.log('   - Converted buffer size:', pdfBuffer.length, 'bytes');
        } catch (bufferError) {
          console.error('❌ Error creating buffer from array:', bufferError);
          pdfBuffer = null;
        }
      } else {
        console.log('⚠️  Unknown quotationPdfData format:', JSON.stringify(Object.keys(quotation.quotationPdfData || {})));
      }
    }
    // Try old format: quotationPdfBuffer (Buffer)
    else if (quotation.quotationPdfBuffer && Buffer.isBuffer(quotation.quotationPdfBuffer)) {
      pdfBuffer = quotation.quotationPdfBuffer;
      pdfFileName = quotation.quotationPdf?.fileName || quotation.quotationPdf || pdfFileName;
      contentType = quotation.quotationPdfContentType || 'application/pdf';
      console.log('PDF found in database (old format: quotationPdfBuffer)');
    }
    // Try old format: quotationPdf as object with data
    else if (quotation.quotationPdf && typeof quotation.quotationPdf === 'object' && quotation.quotationPdf.data) {
      // Handle MongoDB Binary format
      if (quotation.quotationPdf.data && quotation.quotationPdf.data.buffer) {
        pdfBuffer = Buffer.from(quotation.quotationPdf.data.buffer);
      } else if (quotation.quotationPdf.data && quotation.quotationPdf.data.$binary) {
        // Handle MongoDB export format with base64
        try {
          const base64String = quotation.quotationPdf.data.$binary.base64;
          pdfBuffer = Buffer.from(base64String, 'base64');
          console.log('   - Base64 decoded, buffer size:', pdfBuffer.length, 'bytes');
          
          // Validate decoded buffer
          if (pdfBuffer.length === 0) {
            console.error('❌ Decoded PDF buffer is empty!');
            pdfBuffer = null;
          }
        } catch (base64Error) {
          console.error('❌ Error decoding base64 PDF:', base64Error);
          pdfBuffer = null;
        }
      }
      pdfFileName = quotation.quotationPdf.fileName || quotation.quotationPdf || pdfFileName;
      contentType = quotation.quotationPdf.contentType || 'application/pdf';
      console.log('PDF found in database (old format: quotationPdf object)');
    }

    // ✅ BEST PRACTICE: Check filesystem first (files are stored on disk) - VPS-compatible
    let pdfPath;
    if (quotation.quotationPdf) {
      pdfPath = path.join(getQuotationsPath(), quotation.quotationPdf);
      if (fs.existsSync(pdfPath)) {
        console.log('📄 ===== BACKEND: SERVING PDF FROM FILESYSTEM =====');
        console.log('   - PDF Path:', pdfPath);
        console.log('   - PDF Filename:', quotation.quotationPdf);
        
        const fileStats = fs.statSync(pdfPath);
        console.log('   - File Size:', fileStats.size, 'bytes');
        console.log('   - File Size (MB):', (fileStats.size / (1024 * 1024)).toFixed(2), 'MB');
        
        // Set appropriate headers
        if (download === 'true') {
          res.setHeader('Content-Disposition', `attachment; filename="${quotation.quotationPdf}"`);
        } else {
          res.setHeader('Content-Disposition', `inline; filename="${quotation.quotationPdf}"`);
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        
        console.log('   ✅ Sending PDF file to client...');
        return res.sendFile(path.resolve(pdfPath));
      }
    }

    // Fallback: If file not on disk, check database (backward compatibility for old records)
    if (pdfBuffer && Buffer.isBuffer(pdfBuffer)) {
      console.log('📄 ===== BACKEND: SERVING PDF FROM DATABASE (LEGACY) =====');
      console.log('   - PDF Buffer Size:', pdfBuffer.length, 'bytes');
      console.log('   - ⚠️  Note: This is legacy data. Consider migrating to filesystem storage.');
      
      // Validate PDF buffer
      if (pdfBuffer.length === 0) {
        console.error('❌ PDF Buffer is empty!');
        return res.status(500).json({
          success: false,
          message: 'PDF file is empty or corrupted'
        });
      }
      
      // Check PDF header to ensure it's a valid PDF
      const pdfHeader = pdfBuffer.toString('ascii', 0, 4);
      if (pdfHeader !== '%PDF') {
        console.error('❌ Invalid PDF header detected:', pdfHeader);
        return res.status(500).json({
          success: false,
          message: 'Invalid PDF file format. PDF may be corrupted.',
          detectedHeader: pdfHeader
        });
      }
      
      // Set appropriate headers
      if (download === 'true') {
        res.setHeader('Content-Disposition', `attachment; filename="${pdfFileName}"`);
      } else {
        res.setHeader('Content-Disposition', `inline; filename="${pdfFileName}"`);
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdfBuffer.length);
      res.setHeader('Cache-Control', 'no-cache');

      // Send the PDF buffer
      console.log('   ✅ Sending PDF buffer to client...');
      return res.send(pdfBuffer);
    }

    // If no PDF exists, try to generate one
    console.log('📄 ===== BACKEND: NO PDF FOUND, GENERATING PDF =====');
    try {
      const pdfResult = await generatePDF();
      
      // Read the generated PDF and store in database
      if (fs.existsSync(pdfResult.filePath)) {
        console.log('✅ Generated PDF file exists, reading into buffer...');
        pdfBuffer = fs.readFileSync(pdfResult.filePath);
        
        // Validate the generated PDF
        if (!pdfBuffer || pdfBuffer.length === 0) {
          throw new Error('Generated PDF file is empty');
        }
        
        const pdfHeader = pdfBuffer.toString('ascii', 0, 4);
        if (pdfHeader !== '%PDF') {
          throw new Error(`Invalid PDF header: ${pdfHeader}. PDF generation may have failed.`);
        }
        
        console.log('✅ Generated PDF is valid, storing in database...');
        console.log('   - PDF Size:', pdfBuffer.length, 'bytes');
        console.log('   - PDF Header:', pdfHeader);
        
        // ✅ BEST PRACTICE: Keep file on disk, store only filename in database (VPS-compatible)
        const permanentPath = path.join(getQuotationsPath(), pdfResult.fileName);
        
        // If file is already in the right place, great. Otherwise, ensure it's there.
        if (pdfResult.filePath !== permanentPath && fs.existsSync(pdfResult.filePath)) {
          // Move file to permanent location
          fs.renameSync(pdfResult.filePath, permanentPath);
          console.log('✅ Generated PDF moved to permanent location:', permanentPath);
        }
        
        // Update quotation with filename only (file stays on disk)
        await Quotation.findByIdAndUpdate(quotation._id, {
          quotationPdfFilename: pdfResult.fileName,
          quotationPdf: pdfResult.fileName // Store filename - file is on disk
          // Note: quotationPdfData (Buffer) is deprecated
        });
        
        console.log('✅ PDF filename stored in database, file on disk');
        
        pdfFileName = pdfResult.fileName;
      } else {
        throw new Error(`Generated PDF file not found at: ${pdfResult.filePath}`);
      }
    } catch (pdfError) {
      console.error('❌ PDF generation failed:', pdfError);
      return res.status(500).json({
        success: false,
        message: 'Failed to generate PDF',
        error: pdfError.message
      });
    }

    // Validate PDF buffer before sending
    if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
      console.error('❌ PDF buffer is invalid or empty');
      return res.status(500).json({
        success: false,
        message: 'PDF buffer is invalid or empty'
      });
    }

    // Set appropriate headers
    if (download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${pdfFileName}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${pdfFileName}"`);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');

    console.log('✅ Sending generated PDF to client, size:', pdfBuffer.length, 'bytes');
    // Send the PDF buffer
    res.send(pdfBuffer);

  } catch (error) {
    console.error('Get quotation PDF error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Download quotation PDF (same logic as inquiry file download)
router.get('/:id/pdf/download', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log('=== QUOTATION PDF DOWNLOAD REQUEST ===');
    console.log('Quotation ID:', id);
    console.log('User ID:', req.userId);
    console.log('User role:', req.userRole);
    
    // Check if user is admin/backoffice - they can access any quotation
    const isAdmin = ['admin', 'backoffice', 'subadmin'].includes(req.userRole);
    console.log('Is admin user:', isAdmin);
    
    // Query quotation with quotationPdfData field included (bypass toJSON using lean)
    let quotation;
    if (isAdmin) {
      // Admin users can access any quotation - use lean to get raw document with quotationPdfData
      quotation = await Quotation.findOne({
        _id: id
      }).lean();
    } else {
      // Regular users can only access their own quotations
      // First find the quotation
      quotation = await Quotation.findOne({
        _id: id
      }).lean();
      
      if (quotation) {
        // Verify the quotation belongs to the user
        const inquiry = await Inquiry.findById(quotation.inquiryId);
        if (!inquiry || inquiry.customer.toString() !== req.userId.toString()) {
          console.log('Quotation exists but user does not have access. Inquiry customer:', inquiry?.customer);
          quotation = null;
        }
      }
    }
    
    // If not found by ID, try to find by inquiryId (if id is an inquiry ID)
    if (!quotation) {
      quotation = await Quotation.findOne({ inquiryId: id }).lean();
      
      if (quotation && !isAdmin) {
        // Verify the quotation belongs to the user
        const inquiry = await Inquiry.findById(quotation.inquiryId);
        if (!inquiry || inquiry.customer.toString() !== req.userId.toString()) {
          quotation = null;
        }
      }
    }

    if (!quotation) {
      console.log('Quotation not found. ID:', id, 'User ID:', req.userId, 'Is Admin:', isAdmin);
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    console.log('Quotation found:', quotation.quotationNumber);
    console.log('Has quotationPdf:', !!quotation.quotationPdf);
    console.log('Has quotationPdfData:', !!quotation.quotationPdfData);
    console.log('quotationPdfData type:', quotation.quotationPdfData ? typeof quotation.quotationPdfData : 'null');
    console.log('quotationPdfData is Buffer:', quotation.quotationPdfData ? Buffer.isBuffer(quotation.quotationPdfData) : false);

    // Get PDF buffer - prioritize database storage, fallback to filesystem
    let pdfBuffer = null;
    let pdfFileName = `quotation_${quotation.quotationNumber || quotation._id}.pdf`;
    let contentType = 'application/pdf';
    
    // First, try to get from database (new format: quotationPdfData)
    if (quotation.quotationPdfData) {
      console.log('📦 Reading PDF from database (quotationPdfData)');
      console.log('   - quotationPdfData type:', typeof quotation.quotationPdfData);
      console.log('   - quotationPdfData constructor:', quotation.quotationPdfData?.constructor?.name);
      console.log('   - Is Buffer:', Buffer.isBuffer(quotation.quotationPdfData));
      
      // Handle different Buffer formats (direct Buffer, Mongoose Binary, $binary.base64)
      if (Buffer.isBuffer(quotation.quotationPdfData)) {
        pdfBuffer = quotation.quotationPdfData;
        pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
        console.log('   ✅ Direct Buffer detected');
      } else if (quotation.quotationPdfData.buffer && Buffer.isBuffer(quotation.quotationPdfData.buffer)) {
        pdfBuffer = quotation.quotationPdfData.buffer;
        pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
        console.log('   ✅ Buffer from .buffer property');
      } else if (quotation.quotationPdfData.$binary && quotation.quotationPdfData.$binary.base64) {
        try {
          pdfBuffer = Buffer.from(quotation.quotationPdfData.$binary.base64, 'base64');
          pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
          console.log('   ✅ Decoded from $binary.base64');
        } catch (e) {
          console.error('   ❌ Error decoding base64:', e);
        }
      } else if (typeof quotation.quotationPdfData === 'string') {
        try {
          pdfBuffer = Buffer.from(quotation.quotationPdfData, 'base64');
          pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
          console.log('   ✅ Decoded from string base64');
        } catch (e) {
          console.error('   ❌ Error decoding string as base64:', e);
        }
      } else if (quotation.quotationPdfData.type === 'Buffer' && Array.isArray(quotation.quotationPdfData.data)) {
        // Handle MongoDB export format: { type: 'Buffer', data: [1,2,3...] }
        try {
          pdfBuffer = Buffer.from(quotation.quotationPdfData.data);
          pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
          console.log('   ✅ Decoded from Buffer type array');
        } catch (e) {
          console.error('   ❌ Error creating buffer from array:', e);
        }
      } else {
        console.log('   ⚠️  Unknown quotationPdfData format:', JSON.stringify(Object.keys(quotation.quotationPdfData || {})));
      }
      
      if (pdfBuffer && pdfBuffer.length > 0) {
        console.log(`✅ PDF buffer loaded from database, size: ${pdfBuffer.length} bytes`);
      } else {
        console.log('⚠️  Could not extract buffer from quotationPdfData, trying filesystem...');
      }
    }
    // Try old format: quotationPdfBuffer
    else if (quotation.quotationPdfBuffer && Buffer.isBuffer(quotation.quotationPdfBuffer)) {
      console.log('📦 Reading PDF from database (quotationPdfBuffer - old format)');
      pdfBuffer = quotation.quotationPdfBuffer;
      pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
      contentType = quotation.quotationPdfContentType || 'application/pdf';
      console.log(`✅ PDF buffer loaded from database (old format), size: ${pdfBuffer.length} bytes`);
    }
    // Try old format: quotationPdf as object
    else if (quotation.quotationPdf && typeof quotation.quotationPdf === 'object' && quotation.quotationPdf.data) {
      console.log('📦 Reading PDF from database (quotationPdf object - old format)');
      // Handle MongoDB Binary format
      if (quotation.quotationPdf.data && quotation.quotationPdf.data.buffer) {
        pdfBuffer = Buffer.from(quotation.quotationPdf.data.buffer);
      } else if (quotation.quotationPdf.data && quotation.quotationPdf.data.$binary) {
        // Handle MongoDB export format with base64
        try {
          const base64String = quotation.quotationPdf.data.$binary.base64;
          pdfBuffer = Buffer.from(base64String, 'base64');
        } catch (base64Error) {
          console.error('❌ Error decoding base64 PDF:', base64Error);
        }
      }
      pdfFileName = quotation.quotationPdf.fileName || quotation.quotationPdf || pdfFileName;
      contentType = quotation.quotationPdf.contentType || 'application/pdf';
      if (pdfBuffer && pdfBuffer.length > 0) {
        console.log(`✅ PDF buffer loaded from database (old format), size: ${pdfBuffer.length} bytes`);
      }
    } else {
      console.log('⚠️  No quotationPdfData in database, trying filesystem...');
    }
    
    // Fallback to filesystem (old format - backward compatibility)
    if (!pdfBuffer && quotation.quotationPdf) {
      const pdfPath = path.join(getQuotationsPath(), quotation.quotationPdf);
      if (fs.existsSync(pdfPath)) {
        console.log('📂 Reading PDF from filesystem (backward compatibility)');
        try {
          pdfBuffer = fs.readFileSync(pdfPath);
          pdfFileName = quotation.quotationPdfFilename || quotation.quotationPdf || pdfFileName;
          console.log(`✅ PDF loaded from filesystem, size: ${pdfBuffer.length} bytes`);
        } catch (readError) {
          console.error('❌ Error reading PDF from filesystem:', readError);
        }
      }
    }
    
    // If still no buffer, return error
    if (!pdfBuffer || pdfBuffer.length === 0) {
      console.log('❌ PDF not found in database or filesystem');
      return res.status(404).json({
        success: false,
        message: 'PDF not found on server'
      });
    }

    console.log('📤 Starting PDF download...');

    // Validate PDF buffer
    if (pdfBuffer.length === 0) {
      console.error('❌ PDF Buffer is empty!');
      return res.status(500).json({
        success: false,
        message: 'PDF file is empty or corrupted'
      });
    }
    
    // Check PDF header to ensure it's a valid PDF
    const pdfHeader = pdfBuffer.toString('ascii', 0, 4);
    if (pdfHeader !== '%PDF') {
      console.error('❌ Invalid PDF header detected:', pdfHeader);
      return res.status(500).json({
        success: false,
        message: 'Invalid PDF file format. PDF may be corrupted.',
        detectedHeader: pdfHeader
      });
    }

    // Set appropriate headers and send file (force download)
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdfFileName)}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    
    res.send(pdfBuffer);

  } catch (error) {
    console.error('Quotation PDF download error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// @route   PUT /api/quotation/:id/upload-pdf
// @desc    Upload or update PDF for existing quotation
// @access  Private (Admin/Back Office)
router.put('/:id/upload-pdf', [
  authenticateToken,
  upload.single('quotationPdf')
], async (req, res) => {
  try {
    console.log('=== UPLOAD PDF TO EXISTING QUOTATION ===');
    const { id } = req.params;
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'PDF file is required'
      });
    }

    // Find the quotation
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // ✅ BEST PRACTICE: Keep file on disk, store only filename in database
    const pdfFilename = req.file.filename;
    
    // Validate PDF file
    const fileStats = fs.statSync(req.file.path);
    if (fileStats.size < 100) {
      // Delete invalid file
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
      return res.status(400).json({
        success: false,
        message: 'Invalid PDF file: File size is too small.'
      });
    }
    
    // Validate PDF header
    const pdfHeaderBuffer = Buffer.alloc(4);
    const fd = fs.openSync(req.file.path, 'r');
    fs.readSync(fd, pdfHeaderBuffer, 0, 4, 0);
    fs.closeSync(fd);
    const pdfHeader = pdfHeaderBuffer.toString('ascii');
    
    if (pdfHeader !== '%PDF') {
      // Delete invalid file
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
      return res.status(400).json({
        success: false,
        message: 'Invalid PDF file: File does not have a valid PDF header.'
      });
    }

    // Delete old PDF file from filesystem if exists (VPS-compatible)
    if (quotation.quotationPdf) {
      const oldPdfPath = path.join(getQuotationsPath(), quotation.quotationPdf);
      if (fs.existsSync(oldPdfPath) && oldPdfPath !== req.file.path) {
        try {
          fs.unlinkSync(oldPdfPath);
          console.log('Old PDF file deleted:', oldPdfPath);
        } catch (unlinkError) {
          console.warn('Could not delete old PDF file:', unlinkError);
        }
      }
    }

    // ✅ Update quotation with filename only (file stays on disk)
    quotation.quotationPdf = pdfFilename; // Store filename - file is on disk
    quotation.quotationPdfFilename = pdfFilename; // Store original filename
    // Note: quotationPdfData (Buffer) is deprecated - files are stored on disk
    quotation.updatedAt = new Date();
    await quotation.save();

    console.log('Quotation PDF updated:', pdfFilename);
    console.log('File stored on disk at:', req.file.path);

    console.log('Quotation PDF updated:', req.file.filename);

    res.json({
      success: true,
      message: 'PDF uploaded successfully',
      quotation: quotation
    });

  } catch (error) {
    console.error('Upload PDF error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   PUT /api/quotation/:id/pricing
// @desc    Update quotation pricing for individual items
// @access  Private (Admin/Back Office)
router.put('/:id/pricing', authenticateToken, [
  body('items').isArray({ min: 1 }).withMessage('Items array is required'),
  body('items.*.unitPrice').isNumeric().withMessage('Unit price must be a number'),
  body('items.*.totalPrice').isNumeric().withMessage('Total price must be a number')
], async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body;
    
    console.log('=== UPDATE QUOTATION PRICING ===');
    console.log('Quotation ID:', id);
    console.log('Items to update:', items);
    
    // Check if user is admin/backoffice
    if (!['admin', 'backoffice', 'subadmin'].includes(req.userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin privileges required.'
      });
    }
    
    // Find the quotation
    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }
    
    // Update items with pricing
    const updatedItems = quotation.items.map((item, index) => {
      const newItem = items[index];
      if (newItem) {
        return {
          ...item,
          unitPrice: parseFloat(newItem.unitPrice) || 0,
          totalPrice: parseFloat(newItem.totalPrice) || 0
        };
      }
      return item;
    });
    
    // Calculate new total amount
    const newTotalAmount = updatedItems.reduce((total, item) => total + (item.totalPrice || 0), 0);
    
    // Update quotation
    quotation.items = updatedItems;
    quotation.totalAmount = newTotalAmount;
    quotation.updatedAt = new Date();
    
    await quotation.save();
    
    console.log('Quotation pricing updated successfully');
    console.log('New total amount:', newTotalAmount);
    
    res.json({
      success: true,
      message: 'Quotation pricing updated successfully',
      quotation: quotation
    });
    
  } catch (error) {
    console.error('Update quotation pricing error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// @route   GET /api/quotation/:id/verify-pdf
// @desc    Verify if PDF is stored in database (for debugging)
// @access  Private (Admin/Back Office)
router.get('/:id/verify-pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is admin
    const isAdmin = ['admin', 'backoffice', 'subadmin'].includes(req.userRole);
    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Admin access required'
      });
    }

    const quotation = await Quotation.findById(id);
    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    // Query directly to get Buffer fields (bypass toJSON)
    const quotationWithData = await Quotation.findById(id)
      .select('quotationPdf quotationPdfData quotationPdfFilename quotationPdfBuffer quotationPdfContentType')
      .lean();

    const hasPdfData = !!(quotationWithData.quotationPdfData);
    const hasPdfBuffer = !!(quotationWithData.quotationPdfBuffer);
    const pdfDataSize = quotationWithData.quotationPdfData ? quotationWithData.quotationPdfData.length : 0;
    const pdfBufferSize = quotationWithData.quotationPdfBuffer ? quotationWithData.quotationPdfBuffer.length : 0;

    res.json({
      success: true,
      quotationId: id,
      quotationNumber: quotation.quotationNumber,
      pdfStorage: {
        hasQuotationPdfData: hasPdfData,
        quotationPdfDataSize: pdfDataSize,
        hasQuotationPdfBuffer: hasPdfBuffer,
        quotationPdfBufferSize: pdfBufferSize,
        quotationPdfFilename: quotationWithData.quotationPdfFilename,
        quotationPdfString: quotationWithData.quotationPdf,
        quotationPdfContentType: quotationWithData.quotationPdfContentType,
        storedInDatabase: hasPdfData || hasPdfBuffer,
        recommendation: hasPdfData || hasPdfBuffer 
          ? 'PDF is stored in database ✅' 
          : 'PDF is NOT stored in database - only filename exists ⚠️'
      }
    });

  } catch (error) {
    console.error('Verify PDF error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

module.exports = router;