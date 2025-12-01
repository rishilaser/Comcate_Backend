const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Razorpay
let razorpayInstance = null;
let isRazorpayConfigured = false;

const initializeRazorpay = () => {
  try {
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && 
        process.env.RAZORPAY_KEY_ID !== 'your-razorpay-key-id') {
      razorpayInstance = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      });
      isRazorpayConfigured = true;
      console.log('Razorpay payment gateway initialized successfully');
    } else {
      console.warn('Razorpay credentials not configured. Payment gateway will be disabled.');
      isRazorpayConfigured = false;
    }
  } catch (error) {
    console.error('Failed to initialize Razorpay:', error);
    isRazorpayConfigured = false;
  }
};

// Create payment order
const createPaymentOrder = async (amount, currency = 'INR', receipt = null) => {
  try {
    if (!isRazorpayConfigured || !razorpayInstance) {
      return { 
        success: false, 
        message: 'Payment gateway not configured',
        error: 'Razorpay not initialized'
      };
    }

    const options = {
      amount: amount * 100, // Razorpay expects amount in paise
      currency: currency,
      receipt: receipt || `receipt_${Date.now()}`,
      payment_capture: 1 // Auto capture payment
    };

    const order = await razorpayInstance.orders.create(options);
    
    console.log('Payment order created:', order.id);
    return {
      success: true,
      orderId: order.id,
      amount: amount,
      currency: currency,
      receipt: order.receipt,
      keyId: process.env.RAZORPAY_KEY_ID
    };

  } catch (error) {
    console.error('Payment order creation failed:', error);
    return {
      success: false,
      error: error.message,
      code: error.code
    };
  }
};

// Verify payment signature
const verifyPayment = (razorpayOrderId, razorpayPaymentId, razorpaySignature) => {
  try {
    if (!isRazorpayConfigured) {
      return { success: false, message: 'Payment gateway not configured' };
    }

    const body = razorpayOrderId + '|' + razorpayPaymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isAuthentic = expectedSignature === razorpaySignature;

    if (isAuthentic) {
      console.log('Payment verification successful:', razorpayPaymentId);
      return {
        success: true,
        paymentId: razorpayPaymentId,
        orderId: razorpayOrderId,
        verified: true
      };
    } else {
      console.error('Payment verification failed: Invalid signature');
      return {
        success: false,
        message: 'Invalid payment signature',
        verified: false
      };
    }

  } catch (error) {
    console.error('Payment verification error:', error);
    return {
      success: false,
      error: error.message,
      verified: false
    };
  }
};

// Get payment details
const getPaymentDetails = async (paymentId) => {
  try {
    if (!isRazorpayConfigured || !razorpayInstance) {
      return { success: false, message: 'Payment gateway not configured' };
    }

    const payment = await razorpayInstance.payments.fetch(paymentId);
    
    return {
      success: true,
      payment: {
        id: payment.id,
        amount: payment.amount / 100, // Convert from paise to rupees
        currency: payment.currency,
        status: payment.status,
        method: payment.method,
        description: payment.description,
        created_at: payment.created_at,
        captured: payment.captured,
        email: payment.email,
        contact: payment.contact
      }
    };

  } catch (error) {
    console.error('Get payment details failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Refund payment
const refundPayment = async (paymentId, amount = null, reason = 'Customer request') => {
  try {
    if (!isRazorpayConfigured || !razorpayInstance) {
      return { success: false, message: 'Payment gateway not configured' };
    }

    const refundOptions = {
      payment_id: paymentId,
      amount: amount ? amount * 100 : null, // Convert to paise if amount specified
      notes: {
        reason: reason,
        refunded_at: new Date().toISOString()
      }
    };

    const refund = await razorpayInstance.payments.refund(paymentId, refundOptions);
    
    console.log('Refund processed:', refund.id);
    return {
      success: true,
      refundId: refund.id,
      amount: refund.amount / 100,
      status: refund.status,
      paymentId: paymentId
    };

  } catch (error) {
    console.error('Refund failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Get payment analytics
const getPaymentAnalytics = async (fromDate, toDate) => {
  try {
    if (!isRazorpayConfigured || !razorpayInstance) {
      return { success: false, message: 'Payment gateway not configured' };
    }

    const payments = await razorpayInstance.payments.all({
      from: Math.floor(new Date(fromDate).getTime() / 1000),
      to: Math.floor(new Date(toDate).getTime() / 1000),
      count: 100
    });

    const analytics = {
      totalPayments: payments.items.length,
      totalAmount: payments.items.reduce((sum, payment) => sum + (payment.amount / 100), 0),
      successfulPayments: payments.items.filter(p => p.status === 'captured').length,
      failedPayments: payments.items.filter(p => p.status === 'failed').length,
      pendingPayments: payments.items.filter(p => p.status === 'authorized').length
    };

    return {
      success: true,
      analytics,
      payments: payments.items
    };

  } catch (error) {
    console.error('Payment analytics failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Initialize Razorpay when module is loaded
initializeRazorpay();

module.exports = {
  createPaymentOrder,
  verifyPayment,
  getPaymentDetails,
  refundPayment,
  getPaymentAnalytics,
  isRazorpayConfigured,
  razorpayInstance
};
