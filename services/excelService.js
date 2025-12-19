const XLSX = require('xlsx');
const fs = require('fs');

// Process Excel file and extract component data (works with buffer or file path)
const processExcelFile = async (filePathOrBuffer) => {
  try {
    // Read the Excel file - handle both buffer and file path
    let workbook;
    if (Buffer.isBuffer(filePathOrBuffer)) {
      // If it's a buffer, read from buffer
      workbook = XLSX.read(filePathOrBuffer, { type: 'buffer' });
    } else {
      // If it's a file path, read from file (backward compatibility)
      workbook = XLSX.readFile(filePathOrBuffer);
    }
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    // Extract headers and data
    const headers = jsonData[0];
    const rows = jsonData.slice(1);
    
    // Map Excel columns to our data structure
    const componentMapping = {
      'Part Reference': 'partRef',
      'Part Reference Number': 'partRef',
      'Material': 'material',
      'Thickness': 'thickness',
      'Grade': 'grade',
      'Quantity': 'quantity',
      'Remarks': 'remarks',
      'Notes': 'remarks',
      'Description': 'remarks'
    };
    
    // Find column indices
    const columnIndices = {};
    headers.forEach((header, index) => {
      if (header) {
        const cleanHeader = header.toString().trim();
        for (const [excelKey, ourKey] of Object.entries(componentMapping)) {
          if (cleanHeader.toLowerCase().includes(excelKey.toLowerCase())) {
            columnIndices[ourKey] = index;
            break;
          }
        }
      }
    });
    
    // Process rows into components
    const components = [];
    rows.forEach((row, rowIndex) => {
      if (row.some(cell => cell !== null && cell !== undefined && cell !== '')) {
        const component = {};
        
        // Extract data based on column mapping
        if (columnIndices.partRef !== undefined && row[columnIndices.partRef]) {
          component.partRef = row[columnIndices.partRef].toString().trim();
        }
        
        if (columnIndices.material !== undefined && row[columnIndices.material]) {
          component.material = row[columnIndices.material].toString().trim();
        }
        
        if (columnIndices.thickness !== undefined && row[columnIndices.thickness]) {
          component.thickness = row[columnIndices.thickness].toString().trim();
        }
        
        if (columnIndices.grade !== undefined && row[columnIndices.grade]) {
          component.grade = row[columnIndices.grade].toString().trim();
        }
        
        if (columnIndices.quantity !== undefined && row[columnIndices.quantity]) {
          const qty = parseInt(row[columnIndices.quantity]);
          component.quantity = isNaN(qty) ? 1 : qty;
        }
        
        if (columnIndices.remarks !== undefined && row[columnIndices.remarks]) {
          component.remarks = row[columnIndices.remarks].toString().trim();
        }
        
        // Only add component if it has essential data
        if (component.material && component.thickness && component.quantity) {
          components.push(component);
        }
      }
    });
    
    return {
      success: true,
      components,
      totalComponents: components.length,
      headers: headers.filter(h => h),
      columnMapping: columnIndices
    };
    
  } catch (error) {
    console.error('Excel processing error:', error);
    return {
      success: false,
      error: error.message,
      components: []
    };
  }
};

// Generate Excel template for customers
const generateExcelTemplate = () => {
  const templateData = [
    ['Part Reference', 'Material', 'Thickness', 'Grade', 'Quantity', 'Remarks'],
    ['PART001', 'Steel', '2mm', 'A36', '100', 'Standard finish'],
    ['PART002', 'Aluminum', '1.5mm', '6061', '50', 'Anodized finish'],
    ['PART003', 'Stainless Steel', '3mm', '304', '25', 'Polished surface']
  ];
  
  const worksheet = XLSX.utils.aoa_to_sheet(templateData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Component Specifications');
  
  // Style the header row
  worksheet['A1'].s = { font: { bold: true }, fill: { fgColor: { rgb: "CCCCCC" } } };
  worksheet['B1'].s = { font: { bold: true }, fill: { fgColor: { rgb: "CCCCCC" } } };
  worksheet['C1'].s = { font: { bold: true }, fill: { fgColor: { rgb: "CCCCCC" } } };
  worksheet['D1'].s = { font: { bold: true }, fill: { fgColor: { rgb: "CCCCCC" } } };
  worksheet['E1'].s = { font: { bold: true }, fill: { fgColor: { rgb: "CCCCCC" } } };
  worksheet['F1'].s = { font: { bold: true }, fill: { fgColor: { rgb: "CCCCCC" } } };
  
  return workbook;
};

// Generate Excel template as buffer (for direct download, no file system)
const generateExcelTemplateBuffer = () => {
  try {
    const workbook = generateExcelTemplate();
    // Generate buffer instead of saving to file
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    return buffer;
  } catch (error) {
    console.error('Error generating Excel template buffer:', error);
    return null;
  }
};

module.exports = {
  processExcelFile,
  generateExcelTemplate,
  generateExcelTemplateBuffer
};
