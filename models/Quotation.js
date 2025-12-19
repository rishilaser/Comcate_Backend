const mongoose = require('mongoose');

const quotationSchema = new mongoose.Schema({
  quotationNumber: {
    type: String,
    unique: true,
    sparse: true
  },
  inquiryId: {
    type: String,
    required: true,
    unique: true
  },
  customerInfo: {
    name: {
      type: String,
      required: true
    },
    company: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true
    },
    phone: {
      type: String,
      required: true
    }
  },
  totalAmount: {
    type: Number,
    required: true
  },
  items: [{
    partRef: String,
    material: String,
    thickness: String,
    grade: String,
    quantity: Number,
    unitPrice: Number,
    totalPrice: Number,
    remark: String
  }],
  quotationPdf: {
    data: {
      type: Buffer,
      required: false
    },
    contentType: {
      type: String,
      default: 'application/pdf'
    },
    fileName: {
      type: String,
      required: false
    },
    generatedAt: {
      type: Date,
      required: false
    }
  },
  status: {
    type: String,
    enum: ['draft', 'created', 'uploaded', 'sent', 'accepted', 'rejected', 'order_created'],
    default: 'draft'
  },
  sentAt: {
    type: Date
  },
  acceptedAt: {
    type: Date
  },
  rejectedAt: {
    type: Date
  },
  rejectionReason: {
    type: String
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  },
  orderCreatedAt: {
    type: Date
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  validUntil: {
    type: Date,
    required: false
  },
  terms: {
    type: String,
    default: 'Standard manufacturing terms apply. Payment required before production begins.'
  },
  notes: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Generate quotation number using nomenclature config
quotationSchema.pre('save', async function() {
  if (this.isNew && !this.quotationNumber) {
    try {
      const NomenclatureConfig = require('./NomenclatureConfig');
      this.quotationNumber = await NomenclatureConfig.generateId('quotation');
    } catch (error) {
      console.error('Error generating quotation number:', error);
      // Fallback to old format if nomenclature fails
      const date = new Date();
      const year = date.getFullYear().toString().slice(-2);
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      this.quotationNumber = `QUO${year}${month}${day}${random}`;
    }
  }
});

// Index for better query performance
quotationSchema.index({ inquiryId: 1 });
quotationSchema.index({ quotationNumber: 1 });
quotationSchema.index({ 'customerInfo.email': 1 });
quotationSchema.index({ status: 1 });
quotationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Quotation', quotationSchema);