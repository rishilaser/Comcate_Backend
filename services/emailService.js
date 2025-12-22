const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

// Create transporter
const createTransporter = () => {
  console.log('=== EMAIL SERVICE CONFIGURATION ===');
  console.log('SMTP_HOST:', process.env.SMTP_HOST || 'smtp.gmail.com');
  console.log('SMTP_PORT:', process.env.SMTP_PORT || 587);
  console.log('SMTP_USER:', process.env.SMTP_USER ? '✓ Configured' : '✗ Missing');
  console.log('SMTP_PASS:', process.env.SMTP_PASS ? '✓ Configured' : '✗ Missing');
  console.log('SMTP_FROM:', process.env.SMTP_FROM || 'noreply@247cutbend.com');
  console.log('BACKOFFICE_EMAIL:', process.env.BACKOFFICE_EMAIL || 'backoffice@247cutbend.com');
  
  // Check if SMTP configuration is available
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('⚠️ SMTP configuration missing. Email service will be disabled.');
    console.warn('Please configure SMTP_USER and SMTP_PASS in .env file');
    return null;
  }
  
  console.log('✅ Email service initialized successfully');
  
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
};

// Import SMS service
const { 
  sendInquiryNotificationSMS,
  sendQuotationNotificationSMS,
  sendOrderConfirmationSMS,
  sendDispatchNotificationSMS,
  sendPaymentConfirmationSMS
} = require('./smsService');

// Legacy SMS function for backward compatibility
const sendSMS = async (phoneNumber, message) => {
  try {
    // Use the new SMS service
    const result = await sendInquiryNotificationSMS({ inquiryNumber: 'LEGACY' }, { firstName: 'User', lastName: 'User' });
    console.log(`SMS to ${phoneNumber}: ${message}`);
    return true;
  } catch (error) {
    console.error('SMS sending failed:', error);
    return false;
  }
};

// Send welcome email to new customers
const sendWelcomeEmail = async (email, firstName) => {
  try {
    const transporter = createTransporter();
    
    // If no transporter (SMTP not configured), just log and return
    if (!transporter) {
      console.log('SMTP not configured. Welcome email skipped for:', email);
      return;
    }
    
    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@247cutbend.com',
      to: email,
      subject: 'Welcome to 247 CutBend - Your Sheet Metal Manufacturing Partner',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4CAF50; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">247 CUTBEND</h1>
            <p style="margin: 5px 0;">SHEET METAL PARTS ON DEMAND</p>
          </div>
          
          <div style="padding: 20px;">
            <h2>Welcome ${firstName}!</h2>
            <p>Thank you for creating your account with 247 CutBend. We're excited to have you as part of our manufacturing community.</p>
            
            <h3>What's Next?</h3>
            <ul>
              <li>Upload your technical drawings (DWG, DXF, ZIP)</li>
              <li>Specify material requirements and quantities</li>
              <li>Receive competitive quotes</li>
              <li>Place orders with confidence</li>
            </ul>
            
            <h3>Our Expertise:</h3>
            <ul>
              <li>Laser Cutting</li>
              <li>Surface Finishing</li>
              <li>Threading & Chamfering</li>
              <li>Sheet Metal Bending</li>
              <li>Laser Engraving</li>
              <li>CNC Turning</li>
            </ul>
            
            <p>If you have any questions, feel free to reach out to our support team.</p>
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}" 
                 style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
                Get Started
              </a>
            </div>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666;">
            <p>© 2024 247 CutBend. All rights reserved.</p>
            <p>Delivering Factory Direct Quality Sheet Metal Parts Since 2005</p>
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log('Welcome email sent successfully to:', email);
    
  } catch (error) {
    console.error('Welcome email failed:', error);
    // Don't throw error, just log it to prevent signup from failing
  }
};

// Send inquiry notification to back office
const sendInquiryNotification = async (inquiry) => {
  try {
    console.log('=== SENDING INQUIRY NOTIFICATION EMAIL ===');
    console.log('Creating transporter...');
    
    const transporter = createTransporter();
    
    // If no transporter (SMTP not configured), just log and return
    if (!transporter) {
      console.log('❌ SMTP not configured. Inquiry notification skipped.');
      return;
    }
    
    console.log('✅ Transporter created successfully');

    // Get customer information - handle both populated and unpopulated cases
    let customerInfo = {};
    if (inquiry.customer && typeof inquiry.customer === 'object') {
      if (inquiry.customer.firstName) {
        // Customer is populated
        customerInfo = {
          firstName: inquiry.customer.firstName,
          lastName: inquiry.customer.lastName || '',
          companyName: inquiry.customer.companyName || 'N/A',
          email: inquiry.customer.email || 'N/A',
          phoneNumber: inquiry.customer.phoneNumber || 'N/A'
        };
      } else {
        // Customer is an ObjectId, we need to fetch it
        try {
          const User = require('../models/User');
          const customer = await User.findById(inquiry.customer);
          if (customer) {
            customerInfo = {
              firstName: customer.firstName || 'Unknown',
              lastName: customer.lastName || '',
              companyName: customer.companyName || 'N/A',
              email: customer.email || 'N/A',
              phoneNumber: customer.phoneNumber || 'N/A'
            };
          }
        } catch (fetchError) {
          console.error('Failed to fetch customer data:', fetchError);
          customerInfo = {
            firstName: 'Unknown',
            lastName: '',
            companyName: 'N/A',
            email: 'N/A',
            phoneNumber: 'N/A'
          };
        }
      }
    }
    
    // Initialize attachments array - Attach all original files
    const attachments = [];
    
    // Attach all uploaded files (PDF, DWG, DXF, Excel, etc.)
    if (inquiry.files && inquiry.files.length > 0) {
      console.log(`Processing ${inquiry.files.length} files for email attachment...`);
      
      for (const file of inquiry.files) {
        try {
          // Check if file exists
          if (fs.existsSync(file.filePath)) {
            // Determine content type based on file extension
            let contentType = 'application/octet-stream';
            const fileName = file.originalName.toLowerCase();
            
            if (fileName.endsWith('.pdf')) {
              contentType = 'application/pdf';
            } else if (fileName.endsWith('.dwg')) {
              contentType = 'application/dwg';
            } else if (fileName.endsWith('.dxf')) {
              contentType = 'application/dxf';
            } else if (fileName.endsWith('.xls')) {
              contentType = 'application/vnd.ms-excel';
            } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xlsm')) {
              contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            }
            
            attachments.push({
              filename: file.originalName,
              path: file.filePath,
              contentType: contentType
            });
            console.log(`✅ Added attachment: ${file.originalName} (${contentType})`);
          } else {
            console.warn(`⚠️ File not found: ${file.filePath}`);
          }
        } catch (error) {
          console.error(`❌ Error adding attachment ${file.originalName}:`, error);
        }
      }
      
      console.log(`Total files attached: ${attachments.length}/${inquiry.files.length}`);
    }

    // Generate Consolidated Excel file with ALL data
    try {
      console.log('Generating consolidated Excel file with all data...');
      
      // Create workbook
      const wb = xlsx.utils.book_new();
      
      // ========== SHEET 1: Summary ==========
      const summaryData = [
        ['INQUIRY SUMMARY'],
        [],
        ['Inquiry Number:', inquiry.inquiryNumber],
        ['Customer Name:', `${customerInfo.firstName} ${customerInfo.lastName}`],
        ['Company:', customerInfo.companyName],
        ['Email:', customerInfo.email],
        ['Phone:', customerInfo.phoneNumber],
        ['Created Date:', new Date(inquiry.createdAt).toLocaleDateString()],
        ['Total Parts:', inquiry.parts?.length || 0],
        ['Total Files:', inquiry.files?.length || 0],
        ['Total Amount:', `$${inquiry.totalAmount || 0}`],
        [],
        ['Special Instructions:', inquiry.specialInstructions || 'None']
      ];
      
      const wsSummary = xlsx.utils.aoa_to_sheet(summaryData);
      wsSummary['!cols'] = [{ wch: 20 }, { wch: 40 }];
      xlsx.utils.book_append_sheet(wb, wsSummary, 'Summary');
      
      // ========== SHEET 2: Technical Specifications ==========
      const techSpecData = [];
      techSpecData.push(['Part Name', 'Material', 'Thickness', 'Grade', 'Quantity', 'Price', 'Remarks']);
      
      console.log('Inquiry parts data:', JSON.stringify(inquiry.parts, null, 2));
      console.log('Total parts found:', inquiry.parts?.length || 0);
      
      if (inquiry.parts && inquiry.parts.length > 0) {
        inquiry.parts.forEach((part, index) => {
          console.log(`Adding part ${index + 1}:`, {
            partRef: part.partRef,
            material: part.material,
            thickness: part.thickness,
            grade: part.grade,
            quantity: part.quantity,
            price: part.price,
            remarks: part.remarks
          });
          
          techSpecData.push([
            part.partRef || `Part ${index + 1}`,
            part.material || 'N/A',
            part.thickness || 'N/A',
            part.grade || 'N/A',
            part.quantity || 0,
            part.price || 0,
            part.remarks || 'No remarks'
          ]);
        });
      } else {
        console.warn('⚠️ No parts data found in inquiry!');
        techSpecData.push(['No technical specifications available', '', '', '', '', '', '']);
      }
      
      const wsTechSpec = xlsx.utils.aoa_to_sheet(techSpecData);
      wsTechSpec['!cols'] = [
        { wch: 25 }, // Part Name
        { wch: 15 }, // Material
        { wch: 12 }, // Thickness
        { wch: 12 }, // Grade
        { wch: 10 }, // Quantity
        { wch: 12 }, // Price
        { wch: 30 }  // Remarks
      ];
      xlsx.utils.book_append_sheet(wb, wsTechSpec, 'Technical Specifications');
      
      // ========== SHEET 3: Uploaded Files List ==========
      const filesData = [];
      filesData.push(['File Name', 'File Type', 'File Size (KB)', 'Upload Date']);
      
      if (inquiry.files && inquiry.files.length > 0) {
        inquiry.files.forEach(file => {
          filesData.push([
            file.originalName || file.fileName || 'Unknown',
            file.fileType || 'Unknown',
            file.fileSize ? Math.round(file.fileSize / 1024) : 0,
            file.uploadedAt ? new Date(file.uploadedAt).toLocaleDateString() : 'N/A'
          ]);
        });
      } else {
        filesData.push(['No files uploaded', '', '', '']);
      }
      
      const wsFiles = xlsx.utils.aoa_to_sheet(filesData);
      wsFiles['!cols'] = [{ wch: 40 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];
      xlsx.utils.book_append_sheet(wb, wsFiles, 'Uploaded Files');
      
      // ========== SHEET 4: Delivery Information ==========
      const deliveryData = [
        ['DELIVERY INFORMATION'],
        [],
        ['Street Address:', inquiry.deliveryAddress?.street || 'N/A'],
        ['City:', inquiry.deliveryAddress?.city || 'N/A'],
        ['State:', inquiry.deliveryAddress?.state || 'N/A'],
        ['Postal Code:', inquiry.deliveryAddress?.postalCode || 'N/A'],
        ['Country:', inquiry.deliveryAddress?.country || 'N/A'],
        [],
        ['Expected Delivery Date:', inquiry.expectedDeliveryDate ? new Date(inquiry.expectedDeliveryDate).toLocaleDateString() : 'Not specified']
      ];
      
      const wsDelivery = xlsx.utils.aoa_to_sheet(deliveryData);
      wsDelivery['!cols'] = [{ wch: 20 }, { wch: 40 }];
      xlsx.utils.book_append_sheet(wb, wsDelivery, 'Delivery Information');
      
      // Generate buffer
      const excelBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
      
      // Add consolidated Excel file to attachments
      attachments.push({
        filename: `${inquiry.inquiryNumber}_Complete_Data.xlsx`,
        content: excelBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      
      console.log(`✅ Consolidated Excel file generated: ${inquiry.inquiryNumber}_Complete_Data.xlsx`);
      console.log(`   - Summary Sheet: Inquiry details`);
      console.log(`   - Technical Specifications: ${inquiry.parts?.length || 0} parts`);
      console.log(`   - Uploaded Files List: ${inquiry.files?.length || 0} files`);
      console.log(`   - Delivery Information: Address details`);
    } catch (excelError) {
      console.error('Failed to generate consolidated Excel file:', excelError);
      console.error('Error details:', excelError.message);
      // Don't fail the email if Excel generation fails
    }

    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@247cutbend.com',
      to: process.env.BACKOFFICE_EMAIL || 'backoffice@247cutbend.com',
      subject: `New Inquiry Received - ${inquiry.inquiryNumber}`,
      html: `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 700px; margin: 0 auto; background-color: #f8f9fa;">
          <!-- Header with Company Branding -->
          <div style="background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%); color: white; padding: 30px 20px; text-align: center; border-radius: 8px 8px 0 0;">
            <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 15px;">
              <div style="width: 50px; height: 50px; background-color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px;">
                <span style="color: #FF9800; font-size: 24px; font-weight: bold;">K</span>
              </div>
              <div>
                <h1 style="margin: 0; font-size: 28px; font-weight: 700;">247 CUTBEND</h1>
                <p style="margin: 5px 0 0 0; font-size: 14px; opacity: 0.9;">SHEET METAL PARTS ON DEMAND</p>
              </div>
            </div>
            <h2 style="margin: 0; font-size: 24px; font-weight: 600;">New Inquiry Received</h2>
            <p style="margin: 10px 0 0 0; font-size: 16px; opacity: 0.9;">Inquiry Number: <strong>${inquiry.inquiryNumber}</strong></p>
          </div>
          
          <!-- Main Content -->
          <div style="background-color: white; padding: 30px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            
            <!-- Customer Information Card -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #FF9800;">
              <h3 style="margin: 0 0 15px 0; color: #333; font-size: 18px; font-weight: 600;">👤 Customer Information</h3>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <p style="margin: 5px 0; color: #555;"><strong>Name:</strong> ${customerInfo.firstName} ${customerInfo.lastName}</p>
                <p style="margin: 5px 0; color: #555;"><strong>Company:</strong> ${customerInfo.companyName}</p>
                <p style="margin: 5px 0; color: #555;"><strong>Email:</strong> ${customerInfo.email}</p>
                <p style="margin: 5px 0; color: #555;"><strong>Phone:</strong> ${customerInfo.phoneNumber}</p>
              </div>
            </div>
            
            <!-- Inquiry Details Card -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #4CAF50;">
              <h3 style="margin: 0 0 15px 0; color: #333; font-size: 18px; font-weight: 600;">📋 Inquiry Details</h3>
              <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; text-align: center;">
                <div style="background-color: white; padding: 15px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                  <div style="font-size: 24px; font-weight: bold; color: #FF9800;">${inquiry.files.length}</div>
                  <div style="font-size: 12px; color: #666; text-transform: uppercase;">Files Attached</div>
                </div>
                <div style="background-color: white; padding: 15px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                  <div style="font-size: 24px; font-weight: bold; color: #4CAF50;">${inquiry.parts.length}</div>
                  <div style="font-size: 12px; color: #666; text-transform: uppercase;">Parts</div>
                </div>
                <div style="background-color: white; padding: 15px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                  <div style="font-size: 24px; font-weight: bold; color: #2196F3;">$${inquiry.totalAmount || 0}</div>
                  <div style="font-size: 12px; color: #666; text-transform: uppercase;">Total Amount</div>
                </div>
              </div>
            </div>
            
            <!-- Parts Specifications -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #2196F3;">
              <h3 style="margin: 0 0 15px 0; color: #333; font-size: 18px; font-weight: 600;">🔧 Parts Specifications</h3>
              <div style="background-color: white; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                <table style="width: 100%; border-collapse: collapse;">
                  <thead>
                    <tr style="background-color: #f5f5f5;">
                      <th style="padding: 12px; text-align: left; font-weight: 600; color: #333; border-bottom: 2px solid #ddd;">Part Name</th>
                      <th style="padding: 12px; text-align: left; font-weight: 600; color: #333; border-bottom: 2px solid #ddd;">Material</th>
                      <th style="padding: 12px; text-align: left; font-weight: 600; color: #333; border-bottom: 2px solid #ddd;">Thickness</th>
                      <th style="padding: 12px; text-align: left; font-weight: 600; color: #333; border-bottom: 2px solid #ddd;">Qty</th>
                      <th style="padding: 12px; text-align: left; font-weight: 600; color: #333; border-bottom: 2px solid #ddd;">Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${inquiry.parts.map(part => `
                      <tr style="border-bottom: 1px solid #eee;">
                        <td style="padding: 12px; color: #555;">${part.partName || part.partRef || 'Part'}</td>
                        <td style="padding: 12px; color: #555;">${part.material}</td>
                        <td style="padding: 12px; color: #555;">${part.thickness}mm</td>
                        <td style="padding: 12px; color: #555;">${part.quantity}</td>
                        <td style="padding: 12px; color: #555;">${part.remarks || '-'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
            
            <!-- Attached Files Info -->
            <div style="background-color: #e3f2fd; padding: 20px; border-radius: 8px; margin-bottom: 25px; border-left: 4px solid #2196F3;">
              <h3 style="margin: 0 0 15px 0; color: #1976D2; font-size: 18px; font-weight: 600;">📎 Email Attachments (${attachments.length + 1} files)</h3>
              <div style="background-color: white; padding: 15px; border-radius: 6px;">
                
                <!-- Excel File Highlight -->
                <div style="background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); color: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                  <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">
                    📊 ${inquiry.inquiryNumber}_Complete_Data.xlsx
                  </p>
                  <p style="margin: 0; font-size: 13px; opacity: 0.95;">
                    Consolidated Excel with all inquiry data in 4 organized sheets
                  </p>
                </div>
                
                <p style="margin: 0 0 10px 0; color: #555; line-height: 1.6;">
                  <strong>📥 Consolidated Excel File Contains:</strong>
                </p>
                <ul style="margin: 10px 0 15px 0; padding-left: 20px; color: #666;">
                  <li>📋 Complete Inquiry Summary</li>
                  <li>🔧 All Technical Specifications (${inquiry.parts?.length || 0} parts)</li>
                  <li>📁 List of All Uploaded Files (${inquiry.files?.length || 0} files)</li>
                  <li>📍 Delivery Information</li>
                </ul>
                
                <p style="margin: 0 0 10px 0; color: #555; line-height: 1.6;">
                  <strong>📄 Original Files Attached (${attachments.length}):</strong>
                </p>
                <ul style="margin: 10px 0; padding-left: 20px; color: #666; font-size: 13px;">
                  ${attachments.slice(0, 5).map(att => `<li>${att.filename}</li>`).join('')}
                  ${attachments.length > 5 ? `<li><em>... and ${attachments.length - 5} more files</em></li>` : ''}
                </ul>
                
                // <div style="margin-top: 15px; padding: 12px; background-color: #e8f5e9; border-left: 3px solid #4CAF50; color: #2e7d32; font-size: 14px; border-radius: 4px;">
                //   <strong>💡 Quick Access:</strong> Download all ${attachments.length + 1} files at once using Gmail's "Download all" button, or download the Excel file directly for consolidated data.
                // </div>
              </div>
            </div>
            
            <!-- Action Button -->
            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/backoffice" 
                 style="background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(255, 152, 0, 0.3); display: inline-block;">
                🔍 Review Inquiry
              </a>
            </div>
          </div>
          
          <!-- Footer -->
          <div style="background-color: #333; color: white; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px;">
            <p style="margin: 0 0 5px 0;">© 2024 247 CutBend. All rights reserved.</p>
            <p style="margin: 0; opacity: 0.8;">Delivering Factory Direct Quality Sheet Metal Parts Since 2005</p>
          </div>
        </div>
      `,
      attachments: attachments
    };

    console.log('Sending email to:', mailOptions.to);
    console.log('Email subject:', mailOptions.subject);
    console.log('Attachments:', attachments.length);
    
    const result = await transporter.sendMail(mailOptions);
    console.log('✅ Inquiry notification email sent successfully!');
    console.log('Message ID:', result.messageId);
    console.log('Response:', result.response);
    
    // Send SMS notification to back office
    try {
      const smsResult = await sendInquiryNotificationSMS(inquiry, customerInfo);
      if (smsResult.success) {
        console.log('Inquiry SMS notification sent successfully');
      } else {
        console.log('Inquiry SMS notification failed:', smsResult.message);
      }
    } catch (smsError) {
      console.error('SMS notification failed:', smsError);
      // Don't fail the email if SMS fails
    }
    
  } catch (error) {
    console.error('Inquiry notification failed:', error);
    // Don't throw error, just log it to prevent inquiry creation from failing
  }
};

// Send quotation email to customer
const sendQuotationEmail = async (quotation) => {
  try {
    const transporter = createTransporter();
    
    // Get customer information
    let customerInfo = {};
    if (quotation.inquiry && quotation.inquiry.customer) {
      if (typeof quotation.inquiry.customer === 'object' && quotation.inquiry.customer.firstName) {
        customerInfo = quotation.inquiry.customer;
      } else {
        // Customer is an ObjectId, we need to fetch it
        try {
          const User = require('../models/User');
          const customer = await User.findById(quotation.inquiry.customer);
          if (customer) {
            customerInfo = customer;
          }
        } catch (fetchError) {
          console.error('Failed to fetch customer data:', fetchError);
        }
      }
    }
    
    if (!customerInfo.email) {
      console.error('No customer email found for quotation:', quotation._id);
      return;
    }
    
    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@247cutbend.com',
      to: customerInfo.email,
      subject: `Quotation ${quotation.quotationNumber} - Inquiry ${quotation.inquiry.inquiryNumber} - 247 CutBend`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4CAF50; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Quotation Ready</h1>
            <p style="margin: 5px 0;">Quotation Number: ${quotation.quotationNumber}</p>
          </div>
          
          <div style="padding: 20px;">
            <h3>Dear ${customerInfo.firstName || 'Valued Customer'},</h3>
            <p>Thank you for your inquiry. We have prepared a competitive quotation for your sheet metal parts.</p>
            
            <h3>Quotation Summary:</h3>
            <p><strong>Quotation Number:</strong> ${quotation.quotationNumber}</p>
            <p><strong>Inquiry Number:</strong> ${quotation.inquiry.inquiryNumber}</p>
            <p><strong>Total Amount:</strong> ${quotation.currency} ${quotation.totalAmount}</p>
            <p><strong>Valid Until:</strong> ${new Date(quotation.validUntil).toLocaleDateString()}</p>
            
            <h3>Parts & Pricing:</h3>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <thead>
                <tr style="background-color: #f5f5f5;">
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Part Name</th>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Material</th>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Thickness</th>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Qty</th>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Unit Price</th>
                  <th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Total</th>
                </tr>
              </thead>
              <tbody>
                ${quotation.parts.map(part => `
                  <tr>
                    <td style="border: 1px solid #ddd; padding: 8px;">${part.partName || part.partRef || 'Part'}</td>
                    <td style="border: 1px solid #ddd; padding: 8px;">${part.material}</td>
                    <td style="border: 1px solid #ddd; padding: 8px;">${part.thickness}mm</td>
                    <td style="border: 1px solid #ddd; padding: 8px;">${part.quantity}</td>
                    <td style="border: 1px solid #ddd; padding: 8px;">$${part.unitPrice}</td>
                    <td style="border: 1px solid #ddd; padding: 8px;">$${part.totalPrice}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            
            <h3>Terms & Conditions:</h3>
            <p style="background-color: #f9f9f9; padding: 15px; border-left: 4px solid #4CAF50;">
              ${quotation.terms}
            </p>
            
            ${quotation.notes ? `
            <h3>Additional Notes:</h3>
            <p style="background-color: #f0f8ff; padding: 15px; border-left: 4px solid #2196F3;">
              ${quotation.notes}
            </p>
            ` : ''}
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/quotations/${quotation._id}" 
                 style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-right: 10px;">
                 View Quotation
              </a>
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/quotations/${quotation._id}/accept" 
                 style="background-color: #2196F3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
                 Accept Quotation
              </a>
            </div>
            
            <p style="margin-top: 30px;">If you have any questions, please don't hesitate to contact us.</p>
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log('Quotation email sent successfully to:', customerInfo.email);
    
    // Send SMS notification to customer
    try {
      const smsResult = await sendQuotationNotificationSMS(quotation, customerInfo);
      if (smsResult.success) {
        console.log('Quotation SMS notification sent successfully');
      } else {
        console.log('Quotation SMS notification failed:', smsResult.message);
      }
    } catch (smsError) {
      console.error('SMS notification failed:', smsError);
      // Don't fail the email if SMS fails
    }
    
  } catch (error) {
    console.error('Quotation email failed:', error);
    throw error;
  }
};

// Send order confirmation
const sendOrderConfirmation = async (order) => {
  try {
    console.log('=== SENDING ORDER CONFIRMATION EMAIL ===');
    console.log('Order:', order.orderNumber);
    console.log('Customer:', order.customer?.email);
    
    const transporter = createTransporter();
    
    // If no transporter (SMTP not configured), just log and return
    if (!transporter) {
      console.log('SMTP not configured. Order confirmation email skipped for:', order.customer?.email);
      return;
    }
    
    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@247cutbend.com',
      to: order.customer.email,
      subject: `Order Confirmed - ${order.orderNumber}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4CAF50; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">247 CUTBEND</h1>
            <h2 style="margin: 10px 0;">Order Confirmed</h2>
            <p style="margin: 5px 0;">Order Number: ${order.orderNumber}</p>
          </div>
          
          <div style="padding: 20px;">
            <h3>Dear ${order.customer.firstName || 'Customer'},</h3>
            <p>Your order has been confirmed and is now in production!</p>
            
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Order Details:</h3>
              <p><strong>Order Number:</strong> ${order.orderNumber}</p>
              <p><strong>Total Amount:</strong> ${order.currency || 'USD'} ${order.totalAmount}</p>
              <p><strong>Payment Status:</strong> ${order.payment ? order.payment.status : 'Completed'}</p>
              <p><strong>Order Date:</strong> ${new Date(order.createdAt).toLocaleDateString()}</p>
            </div>
            
            <div style="background-color: #e8f5e8; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Production Timeline:</h3>
              <p><strong>Start Date:</strong> ${order.production && order.production.startDate ? new Date(order.production.startDate).toLocaleDateString() : 'TBD'}</p>
              <p><strong>Estimated Completion:</strong> ${order.production && order.production.estimatedCompletion ? new Date(order.production.estimatedCompletion).toLocaleDateString() : 'TBD'}</p>
            </div>
            
            <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0;">What's Next?</h3>
              <ul>
                <li>Your order is now in production</li>
                <li>We will keep you updated on the progress</li>
                <li>You will receive notifications for each milestone</li>
                <li>Track your order using the button below</li>
              </ul>
            </div>
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/order/${order._id}/tracking" 
                 style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                Track Your Order
              </a>
            </div>
            
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
              <p style="font-size: 14px; color: #666;">
                If you have any questions, please contact our support team.<br>
                Thank you for choosing 247 CutBend for your sheet metal manufacturing needs.
              </p>
            </div>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666;">
            <p>© 2024 247 CutBend. All rights reserved.</p>
            <p>Sheet Metal Parts on Demand</p>
          </div>
        </div>
      `
    };

    console.log('Sending email with options:', {
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject
    });

    const result = await transporter.sendMail(mailOptions);
    console.log('Order confirmation email sent successfully:', result.messageId);
    
    // Send SMS notification
    try {
      const smsResult = await sendOrderConfirmationSMS(order, order.customer);
      if (smsResult.success) {
        console.log('Order confirmation SMS notification sent successfully');
      } else {
        console.log('Order confirmation SMS notification failed:', smsResult.message);
      }
    } catch (smsError) {
      console.error('SMS notification failed:', smsError);
      // Don't fail the email if SMS fails
    }
    
  } catch (error) {
    console.error('Order confirmation email failed:', error);
    throw error;
  }
};

// Send dispatch notification
const sendDispatchNotification = async (order) => {
  try {
    const transporter = createTransporter();
    
    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@247cutbend.com',
      to: order.customer.email,
      subject: `Order Dispatched - ${order.orderNumber}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #2196F3; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Order Dispatched</h1>
            <p style="margin: 5px 0;">Order Number: ${order.orderNumber}</p>
          </div>
          
          <div style="padding: 20px;">
            <h3>Dear ${order.customer.firstName},</h3>
            <p>Great news! Your order has been dispatched and is on its way to you.</p>
            
            <h3>Dispatch Details:</h3>
            <p><strong>Tracking Number:</strong> ${order.dispatch ? order.dispatch.trackingNumber : 'N/A'}</p>
            <p><strong>Courier:</strong> ${order.dispatch ? order.dispatch.courier : 'N/A'}</p>
            <p><strong>Dispatched Date:</strong> ${order.dispatch && order.dispatch.dispatchedAt ? new Date(order.dispatch.dispatchedAt).toLocaleDateString() : 'N/A'}</p>
            <p><strong>Estimated Delivery:</strong> ${order.dispatch && order.dispatch.estimatedDelivery ? new Date(order.dispatch.estimatedDelivery).toLocaleDateString() : 'N/A'}</p>
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/orders/${order._id}/tracking" 
                 style="background-color: #2196F3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
                Track Order
              </a>
            </div>
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log('Dispatch notification email sent successfully');
    
    // Send SMS notification
    try {
      const smsResult = await sendDispatchNotificationSMS(order, order.customer);
      if (smsResult.success) {
        console.log('Dispatch SMS notification sent successfully');
      } else {
        console.log('Dispatch SMS notification failed:', smsResult.message);
      }
    } catch (smsError) {
      console.error('SMS notification failed:', smsError);
      // Don't fail the email if SMS fails
    }
    
  } catch (error) {
    console.error('Dispatch notification email failed:', error);
    throw error;
  }
};

// Send payment confirmation to back office
const sendPaymentConfirmation = async (order) => {
  try {
    const transporter = createTransporter();
    
    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@247cutbend.com',
      to: process.env.BACKOFFICE_EMAIL || 'backoffice@247cutbend.com',
      subject: `Payment Confirmed - Order ${order.orderNumber}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4CAF50; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Payment Confirmed</h1>
            <p style="margin: 5px 0;">Order Number: ${order.orderNumber}</p>
          </div>
          
          <div style="padding: 20px;">
            <h3>Payment Details:</h3>
            <p><strong>Order Number:</strong> ${order.orderNumber}</p>
            <p><strong>Customer:</strong> ${order.customer?.firstName || 'Unknown'} ${order.customer?.lastName || ''}</p>
            <p><strong>Amount:</strong> $${order.totalAmount}</p>
            <p><strong>Payment Method:</strong> ${order.payment?.method || 'Online'}</p>
            <p><strong>Transaction ID:</strong> ${order.payment?.transactionId || 'N/A'}</p>
            <p><strong>Paid At:</strong> ${order.payment?.paidAt ? new Date(order.payment.paidAt).toLocaleString() : new Date().toLocaleString()}</p>
            
            <h3>Next Steps:</h3>
            <p>1. Update order status to "confirmed"</p>
            <p>2. Set production timeline</p>
            <p>3. Begin manufacturing process</p>
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/backoffice" 
                 style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
                Manage Order
              </a>
            </div>
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log('Payment confirmation email sent to back office');
    
    // Send SMS notification to back office
    try {
      const smsResult = await sendPaymentConfirmationSMS(order, order.customer);
      if (smsResult.success) {
        console.log('Payment confirmation SMS notification sent successfully');
      } else {
        console.log('Payment confirmation SMS notification failed:', smsResult.message);
      }
    } catch (smsError) {
      console.error('SMS notification failed:', smsError);
      // Don't fail the email if SMS fails
    }
    
  } catch (error) {
    console.error('Payment confirmation email failed:', error);
    throw error;
  }
};

// Send delivery confirmation
const sendDeliveryConfirmation = async (order) => {
  try {
    const transporter = createTransporter();
    
    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@247cutbend.com',
      to: order.customer.email,
      subject: `Order Delivered - ${order.orderNumber}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4CAF50; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">Order Delivered</h1>
            <p style="margin: 5px 0;">Order Number: ${order.orderNumber}</p>
          </div>
          
          <div style="padding: 20px;">
            <h3>Dear ${order.customer.firstName},</h3>
            <p>Your order has been successfully delivered!</p>
            
            <h3>Delivery Details:</h3>
            <p><strong>Order Number:</strong> ${order.orderNumber}</p>
            <p><strong>Delivered Date:</strong> ${new Date(order.dispatch.actualDelivery).toLocaleDateString()}</p>
            <p><strong>Delivery Address:</strong> ${order.deliveryAddress.street}, ${order.deliveryAddress.city}</p>
            
            <h3>Thank You!</h3>
            <p>We appreciate your business and hope you're satisfied with your order. If you have any questions or need assistance, please don't hesitate to contact us.</p>
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/inquiries/new" 
                 style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
                Place New Order
              </a>
            </div>
          </div>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log('Delivery confirmation email sent successfully');
    
    // Send SMS notification
    if (order.customer.phoneNumber) {
      const smsMessage = `Order ${order.orderNumber} delivered successfully! Thank you for choosing 247 CutBend.`;
      await sendSMS(order.customer.phoneNumber, smsMessage);
    }
    
  } catch (error) {
    console.error('Delivery confirmation email failed:', error);
    throw error;
  }
};

// Send delivery time notification to customer
const sendDeliveryTimeNotification = async (order) => {
  try {
    console.log('=== SENDING DELIVERY TIME NOTIFICATION ===');
    console.log('Order:', order.orderNumber);
    console.log('Customer:', order.customer?.email);
    
    const transporter = createTransporter();
    
    // If no transporter (SMTP not configured), just log and return
    if (!transporter) {
      console.log('SMTP not configured. Delivery time notification skipped for:', order.customer?.email);
      return;
    }
    
    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@247cutbend.com',
      to: order.customer.email,
      subject: `Delivery Time Updated - ${order.orderNumber}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #FF9800; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">247 CUTBEND</h1>
            <h2 style="margin: 10px 0;">Delivery Time Updated</h2>
            <p style="margin: 5px 0;">Order Number: ${order.orderNumber}</p>
          </div>
          
          <div style="padding: 20px;">
            <h3>Dear ${order.customer.firstName || 'Customer'},</h3>
            <p>We have updated the delivery time for your order. Here are the latest details:</p>
            
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Order Details:</h3>
              <p><strong>Order Number:</strong> ${order.orderNumber}</p>
              <p><strong>Total Amount:</strong> ${order.currency || 'USD'} ${order.totalAmount}</p>
              <p><strong>Current Status:</strong> ${order.status.charAt(0).toUpperCase() + order.status.slice(1).replace('_', ' ')}</p>
            </div>
            
            <div style="background-color: #e8f5e8; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Updated Delivery Information:</h3>
              <p><strong>Estimated Delivery:</strong> ${order.production?.estimatedCompletion ? new Date(order.production.estimatedCompletion).toLocaleDateString() : 'TBD'}</p>
              <p><strong>Production Start Date:</strong> ${order.production?.startDate ? new Date(order.production.startDate).toLocaleDateString() : 'TBD'}</p>
              <p><strong>Updated On:</strong> ${new Date().toLocaleDateString()}</p>
            </div>
            
            <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0;">What's Next?</h3>
              <ul>
                <li>Your order is currently in production</li>
                <li>We will keep you updated on any changes</li>
                <li>You will receive a notification when it's ready for dispatch</li>
                <li>Track your order using the button below</li>
              </ul>
            </div>
            
            <div style="text-align: center; margin-top: 30px;">
              <a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/order/${order._id}/tracking" 
                 style="background-color: #FF9800; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">
                Track Your Order
              </a>
            </div>
            
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
              <p style="font-size: 14px; color: #666;">
                If you have any questions about the delivery time, please contact our support team.<br>
                Thank you for choosing 247 CutBend for your sheet metal manufacturing needs.
              </p>
            </div>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666;">
            <p>© 2024 247 CutBend. All rights reserved.</p>
            <p>Sheet Metal Parts on Demand</p>
          </div>
        </div>
      `
    };

    console.log('Sending delivery time notification with options:', {
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject
    });

    const result = await transporter.sendMail(mailOptions);
    console.log('Delivery time notification sent successfully:', result.messageId);
    
    // Send SMS notification
    try {
      const { sendDeliveryTimeNotificationSMS } = require('./smsService');
      const smsResult = await sendDeliveryTimeNotificationSMS(order, order.customer);
      if (smsResult.success) {
        console.log('Delivery time SMS notification sent successfully');
      } else {
        console.log('Delivery time SMS notification failed:', smsResult.message);
      }
    } catch (smsError) {
      console.error('SMS notification failed:', smsError);
      // Don't fail the email if SMS fails
    }
    
  } catch (error) {
    console.error('Delivery time notification failed:', error);
    throw error;
  }
};

// Test email service function
const testEmailService = async (testEmail) => {
  try {
    console.log('=== TESTING EMAIL SERVICE ===');
    console.log('Test email:', testEmail);
    
    const transporter = createTransporter();
    
    if (!transporter) {
      console.log('SMTP not configured. Cannot send test email.');
      return { success: false, message: 'SMTP not configured' };
    }
    
    const mailOptions = {
      from: process.env.SMTP_FROM || 'noreply@247cutbend.com',
      to: testEmail,
      subject: '247 CutBend Email Service Test',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #4CAF50; color: white; padding: 20px; text-align: center;">
            <h1 style="margin: 0;">247 CUTBEND</h1>
            <h2 style="margin: 10px 0;">Email Service Test</h2>
          </div>
          
          <div style="padding: 20px;">
            <h3>Email Service is Working!</h3>
            <p>This is a test email to verify that the 247 CutBend email service is functioning correctly.</p>
            
            <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3 style="margin-top: 0;">Test Details:</h3>
              <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
              <p><strong>SMTP Host:</strong> ${process.env.SMTP_HOST || 'smtp.gmail.com'}</p>
              <p><strong>From Email:</strong> ${process.env.SMTP_FROM || 'noreply@247cutbend.com'}</p>
            </div>
            
            <p>If you received this email, the email service is working correctly!</p>
          </div>
          
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; font-size: 12px; color: #666;">
            <p>© 2024 247 CutBend. All rights reserved.</p>
          </div>
        </div>
      `
    };

    const result = await transporter.sendMail(mailOptions);
    console.log('Test email sent successfully:', result.messageId);
    
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    console.error('Test email failed:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendWelcomeEmail,
  sendInquiryNotification,
  sendQuotationEmail,
  sendOrderConfirmation,
  sendDispatchNotification,
  sendPaymentConfirmation,
  sendDeliveryConfirmation,
  sendDeliveryTimeNotification,
  sendSMS,
  testEmailService
};
