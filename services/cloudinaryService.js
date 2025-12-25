const cloudinary = require('../config/cloudinary');
const fs = require('fs');

/**
 * Upload PDF file to Cloudinary
 * @param {Buffer|String} fileData - File buffer or file path
 * @param {String} originalName - Original filename
 * @param {String} folder - Cloudinary folder (optional)
 * @returns {Promise<Object>} Cloudinary upload result with URL
 */
const uploadPdfToCloudinary = async (fileData, originalName, folder = 'pdfs') => {
  try {
    let buffer;
    
    // If fileData is a path, read the file
    if (typeof fileData === 'string' && fs.existsSync(fileData)) {
      buffer = fs.readFileSync(fileData);
    } else if (Buffer.isBuffer(fileData)) {
      buffer = fileData;
    } else {
      throw new Error('Invalid file data provided');
    }

    console.log('\n📤 Uploading PDF to Cloudinary:');
    console.log('   File Name:', originalName);
    console.log('   File Size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');

    // Upload to Cloudinary
    const uploadPromise = new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'raw',
          folder: folder,
          public_id: `pdf_${Date.now()}_${Math.round(Math.random() * 1E9)}`,
          filename_override: originalName,
        },
        (error, uploadResult) => {
          if (error) {
            reject(error);
          } else {
            resolve(uploadResult);
          }
        }
      );

      // Write the buffer to the stream
      uploadStream.end(buffer);
    });

    const result = await uploadPromise;

    console.log('   ✅ Upload Successful!');
    console.log('   Public ID:', result.public_id);
    console.log('   URL:', result.secure_url);
    console.log('   Size:', (result.bytes / 1024 / 1024).toFixed(2), 'MB\n');

    return {
      success: true,
      url: result.secure_url,
      public_id: result.public_id,
      bytes: result.bytes,
      format: result.format,
      originalName: originalName
    };

  } catch (error) {
    console.error('   ❌ Cloudinary Upload Failed!');
    console.error('   Error:', error.message);
    console.log('');
    throw error;
  }
};

/**
 * Delete PDF from Cloudinary
 * @param {String} publicId - Cloudinary public ID
 * @returns {Promise<Object>} Deletion result
 */
const deletePdfFromCloudinary = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'raw'
    });

    if (result.result === 'ok') {
      console.log('✅ PDF deleted from Cloudinary:', publicId);
      return { success: true };
    } else {
      console.log('⚠️  PDF not found in Cloudinary:', publicId);
      return { success: false, message: 'PDF not found' };
    }
  } catch (error) {
    console.error('❌ Error deleting PDF from Cloudinary:', error.message);
    throw error;
  }
};

module.exports = {
  uploadPdfToCloudinary,
  deletePdfFromCloudinary
};

