const express = require('express');
const { body, validationResult } = require('express-validator');
const Order = require('../models/Order');
const Quotation = require('../models/Quotation'); // Added Quotation model
const { sendPaymentConfirmation } = require('../services/emailService');
const { 
  createPaymentOrder, 
  verifyPayment, 
  getPaymentDetails, 
  refundPayment,
  isRazorpayConfigured 
} = require('../services/paymentService');

const router = express.Router();

// Import middleware from auth.js
const { authenticateToken } = require('../middleware/auth');

// Get payment methods available
router.get('/methods', authenticateToken, async (req, res) => {
  try {
    const paymentMethods = [
      {
        id: 'credit_card',
        name: 'Credit Card',
        description: 'Visa, MasterCard, American Express',
        icon: '💳',
        enabled: true
      },
      {
        id: 'debit_card',
        name: 'Debit Card',
        description: 'Direct bank account debit',
        icon: '🏦',
        enabled: true
      },
      {
        id: 'bank_transfer',
        name: 'Bank Transfer',
        description: 'Direct bank transfer',
        icon: '🏛️',
        enabled: true
      },
      {
        id: 'paypal',
        name: 'PayPal',
        description: 'PayPal account payment',
        icon: '📧',
        enabled: true
      },
      {
        id: 'razorpay',
        name: 'Razorpay',
        description: 'Indian payment gateway',
        icon: '🇮🇳',
        enabled: true
      }
    ];

    res.json({
      success: true,
      paymentMethods
    });

  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Initialize payment for order
router.post('/initialize', authenticateToken, [
  body('orderId').notEmpty().withMessage('Order ID is required'),
  body('paymentMethod').isIn(['credit_card', 'debit_card', 'bank_transfer', 'paypal', 'razorpay']).withMessage('Invalid payment method'),
  body('amount').isFloat({ min: 0.01 }).withMessage('Valid amount is required')
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

    const { orderId, paymentMethod, amount } = req.body;

    // Find the order
    const order = await Order.findById(orderId)
      .populate('customer', 'firstName lastName email phoneNumber');
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Check if user owns this order
    if (order.customer.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Check if order is in correct status
    if (order.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Order is not in correct status for payment'
      });
    }

    // Check if amount matches order total
    if (Math.abs(amount - order.totalAmount) > 0.01) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount does not match order total'
      });
    }

    // Generate payment intent (this would integrate with actual payment gateway)
    const paymentIntent = {
      id: `pi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      amount: amount,
      currency: order.currency,
      paymentMethod: paymentMethod,
      status: 'requires_payment_method',
      clientSecret: `pi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_secret_${Math.random().toString(36).substr(2, 9)}`,
      createdAt: new Date()
    };

    // Update order payment details
    order.payment.method = paymentMethod;
    order.payment.status = 'processing';
    order.payment.amount = amount;
    order.payment.gateway = paymentMethod;
    await order.save();

    res.json({
      success: true,
      message: 'Payment initialized successfully',
      paymentIntent: {
        id: paymentIntent.id,
        clientSecret: paymentIntent.clientSecret,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency
      }
    });

  } catch (error) {
    console.error('Initialize payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Process payment (simulate payment gateway response)
router.post('/process', authenticateToken, [
  body('orderId').notEmpty().withMessage('Order ID is required'),
  body('paymentIntentId').notEmpty().withMessage('Payment intent ID is required'),
  body('paymentMethod').isIn(['credit_card', 'debit_card', 'bank_transfer', 'paypal', 'razorpay']).withMessage('Invalid payment method')
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

    const { orderId, paymentIntentId, paymentMethod } = req.body;

    // Find the order
    const order = await Order.findById(orderId)
      .populate('customer', 'firstName lastName email phoneNumber');
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Check if user owns this order
    if (order.customer.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Simulate payment processing
    const paymentSuccess = Math.random() > 0.1; // 90% success rate for demo

    if (paymentSuccess) {
      // Payment successful
      order.payment.status = 'completed';
      order.payment.paidAt = new Date();
      order.payment.transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      order.status = 'confirmed';
      order.confirmedAt = new Date();
      
      await order.save();


      // Send payment confirmation email to back office
      try {
        await sendPaymentConfirmation(order);
      } catch (emailError) {
        console.error('Payment confirmation email failed:', emailError);
        // Don't fail the operation if email fails
      }

      // Send order confirmation email to customer
      try {
        const { sendOrderConfirmation } = require('../services/emailService');
        await sendOrderConfirmation(order);
      } catch (emailError) {
        console.error('Order confirmation email failed:', emailError);
        // Don't fail the operation if email fails
      }

      res.json({
        success: true,
        message: 'Payment processed successfully',
        payment: {
          status: 'completed',
          transactionId: order.payment.transactionId,
          amount: order.payment.amount,
          paidAt: order.payment.paidAt
        },
        order: {
          id: order._id,
          orderNumber: order.orderNumber,
          status: order.status
        }
      });

    } else {
      // Payment failed
      order.payment.status = 'failed';
      await order.save();

      res.status(400).json({
        success: false,
        message: 'Payment failed. Please try again.',
        payment: {
          status: 'failed',
          amount: order.payment.amount
        }
      });
    }

  } catch (error) {
    console.error('Process payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get payment status
router.get('/:orderId/status', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Check if user owns this order
    if (order.customer.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.json({
      success: true,
      payment: {
        status: order.payment.status,
        method: order.payment.method,
        amount: order.payment.amount,
        transactionId: order.payment.transactionId,
        paidAt: order.payment.paidAt,
        gateway: order.payment.gateway
      }
    });

  } catch (error) {
    console.error('Get payment status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Refund payment (Back Office only)
router.post('/:orderId/refund', authenticateToken, [
  body('reason').notEmpty().withMessage('Refund reason is required'),
  body('amount').optional().isFloat({ min: 0.01 }).withMessage('Valid refund amount is required')
], async (req, res) => {
  try {
    // Check if user is back office/admin
    if (!['admin', 'backoffice'].includes(req.userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Back office access required'
      });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { orderId } = req.params;
    const { reason, amount } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    if (order.payment.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Order payment is not completed'
      });
    }

    // Process refund
    const refundAmount = amount || order.payment.amount;
    
    // Update payment status
    order.payment.status = 'refunded';
    order.notes = `Refund processed: ${reason}. Amount: ${refundAmount}`;
    await order.save();

    res.json({
      success: true,
      message: 'Refund processed successfully',
      refund: {
        amount: refundAmount,
        reason: reason,
        processedAt: new Date()
      }
    });

  } catch (error) {
    console.error('Process refund error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get payment history for order
router.get('/:orderId/history', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Check if user has access to this order
    if (req.userRole !== 'admin' && req.userRole !== 'backoffice' && order.customer.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const paymentHistory = [
      {
        action: 'Payment Initiated',
        timestamp: order.createdAt,
        status: 'completed',
        amount: order.totalAmount,
        currency: order.currency
      }
    ];

    if (order.payment.paidAt) {
      paymentHistory.push({
        action: 'Payment Completed',
        timestamp: order.payment.paidAt,
        status: 'completed',
        amount: order.payment.amount,
        currency: order.currency,
        transactionId: order.payment.transactionId
      });
    }

    if (order.payment.status === 'refunded') {
      paymentHistory.push({
        action: 'Payment Refunded',
        timestamp: order.updatedAt,
        status: 'refunded',
        amount: order.payment.amount,
        currency: order.currency,
        reason: order.notes
      });
    }

    res.json({
      success: true,
      paymentHistory
    });

  } catch (error) {
    console.error('Get payment history error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Update order after successful payment
router.post('/update-order', authenticateToken, async (req, res) => {
  try {
    const { quotationId, paymentMethod, transactionId, paymentAmount } = req.body;

    // Validate required fields
    if (!quotationId || !paymentMethod || !paymentAmount) {
      return res.status(400).json({
        success: false,
        message: 'Quotation ID, payment method, and amount are required'
      });
    }

    // Find the accepted quotation
    const quotation = await Quotation.findById(quotationId);

    console.log('=== QUOTATION DEBUG ===');
    console.log('Quotation ID:', quotationId);
    
    if (!quotation) {
      console.log('❌ Quotation not found!');
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }
    
    console.log('✅ Quotation found:', quotation._id);
    console.log('Quotation items:', quotation.items);
    console.log('Quotation inquiryId (String):', quotation.inquiryId);
    
    // Fetch inquiry separately since inquiryId is a String, not ObjectId reference
    const Inquiry = require('../models/Inquiry');
    const inquiry = await Inquiry.findById(quotation.inquiryId);
    
    console.log('Inquiry fetched:', inquiry ? inquiry._id : 'not found');
    console.log('Inquiry parts:', inquiry?.parts);

    // Check if quotation is accepted
    if (quotation.status !== 'accepted') {
      return res.status(400).json({
        success: false,
        message: 'Quotation must be accepted before creating order'
      });
    }

    // Verify payment amount matches quotation amount
    if (paymentAmount !== quotation.totalAmount) {
      return res.status(400).json({
        success: false,
        message: 'Payment amount does not match quotation amount'
      });
    }

    // Find existing order for this quotation
    const existingOrder = await Order.findOne({ quotation: quotationId })
      .populate('customer', 'firstName lastName email phoneNumber');
    
    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: 'No order found for this quotation. Please accept the quotation first.'
      });
    }

    console.log('=== UPDATE ORDER PAYMENT DEBUG ===');
    console.log('Existing order ID:', existingOrder._id);
    console.log('Existing order number:', existingOrder.orderNumber);
    console.log('Existing order parts:', existingOrder.parts);
    console.log('Existing order parts length:', existingOrder.parts ? existingOrder.parts.length : 0);
    console.log('Quotation ID:', quotation._id);
    console.log('Quotation items:', quotation.items);
    console.log('Quotation items length:', quotation.items ? quotation.items.length : 0);
    console.log('Inquiry parts:', inquiry?.parts);
    console.log('Inquiry parts length:', inquiry?.parts ? inquiry.parts.length : 0);

    // Ensure parts data is populated if missing
    if (!existingOrder.parts || existingOrder.parts.length === 0) {
      console.log('⚠️ Order has no parts, populating from quotation/inquiry...');
      
      // Get parts from quotation items
      let orderParts = quotation.items;
      
      // If quotation has no items, use inquiry parts
      if (!orderParts || orderParts.length === 0) {
        console.log('⚠️ Quotation has no items, using inquiry parts');
        if (inquiry?.parts && inquiry.parts.length > 0) {
          const parts = inquiry.parts;
          const totalAmount = paymentAmount || quotation.totalAmount;
          const totalQuantity = parts.reduce((sum, part) => sum + (part.quantity || 0), 0);
          
          console.log('Calculating prices from inquiry parts...');
          console.log('Total amount:', totalAmount);
          console.log('Total quantity:', totalQuantity);
          
          // Calculate prices proportionally based on quantity
          orderParts = parts.map(part => {
            const quantity = part.quantity || 0;
            const itemTotalPrice = totalQuantity > 0 
              ? (totalAmount * quantity) / totalQuantity 
              : totalAmount / parts.length;
            const unitPrice = quantity > 0 ? itemTotalPrice / quantity : itemTotalPrice;
            
            return {
              partName: part.partName || part.partRef || 'N/A',
              partRef: part.partRef || part.partName || 'N/A',
              material: part.material || 'N/A',
              thickness: part.thickness || 'N/A',
              quantity: quantity,
              remarks: part.remarks || '',
              unitPrice: unitPrice,
              totalPrice: itemTotalPrice
            };
          });
          console.log('✅ Calculated order parts from inquiry:', JSON.stringify(orderParts, null, 2));
        } else {
          console.log('❌ No inquiry parts found!');
        }
      } else {
        console.log('✅ Using quotation items:', JSON.stringify(orderParts, null, 2));
      }
      
      // Update order with parts
      if (orderParts && orderParts.length > 0) {
        existingOrder.parts = orderParts;
        console.log('✅ Order parts updated:', existingOrder.parts.length, 'items');
      } else {
        console.log('❌ No parts found to update!');
      }
    } else {
      console.log('✅ Order already has parts:', existingOrder.parts.length, 'items');
    }

    // Update the existing order with payment information
    existingOrder.status = 'confirmed';
    existingOrder.payment = {
      method: paymentMethod,
      status: 'completed',
      transactionId: transactionId,
      amount: paymentAmount,
      paidAt: new Date(),
      gateway: 'manual'
    };
    existingOrder.confirmedAt = new Date();

    await existingOrder.save();


    // Update quotation status to indicate order created
    quotation.status = 'order_created';
    quotation.orderCreatedAt = new Date();
    await quotation.save();

    // Send payment confirmation email to back office
    try {
      await sendPaymentConfirmation(existingOrder);
    } catch (emailError) {
      console.error('Payment confirmation email failed:', emailError);
      // Don't fail the operation if email fails
    }

    // Send order confirmation email to customer
    try {
      const { sendOrderConfirmation } = require('../services/emailService');
      await sendOrderConfirmation(existingOrder);
    } catch (emailError) {
      console.error('Order confirmation email failed:', emailError);
      // Don't fail the operation if email fails
    }

    // Create notification for customer about order confirmation
    try {
      const Notification = require('../models/Notification');
      await Notification.createNotification({
        title: 'Order Confirmed',
        message: `Your order ${existingOrder.orderNumber} has been confirmed and is now in production. We will keep you updated on the progress.`,
        type: 'success',
        userId: existingOrder.customer,
        relatedEntity: {
          type: 'order',
          entityId: existingOrder._id
        },
        metadata: {
          orderNumber: existingOrder.orderNumber,
          totalAmount: existingOrder.totalAmount,
          status: existingOrder.status,
          confirmedAt: new Date()
        }
      });
    } catch (notificationError) {
      console.error('Failed to create customer order confirmation notification:', notificationError);
    }

    // Create notification for all admin users about payment completion
    try {
      const User = require('../models/User');
      const Notification = require('../models/Notification');
      const adminUsers = await User.find({ role: { $in: ['admin', 'backoffice', 'subadmin'] } });
      
      for (const admin of adminUsers) {
        await Notification.createNotification({
          title: 'Payment Received',
          message: `Payment of $${paymentAmount} received for order ${existingOrder.orderNumber}. Customer: ${existingOrder.customer?.firstName || 'Unknown'} ${existingOrder.customer?.lastName || ''}. Transaction ID: ${transactionId}`,
          type: 'success',
          userId: admin._id,
          relatedEntity: {
            type: 'order',
            entityId: existingOrder._id
          },
          metadata: {
            orderNumber: existingOrder.orderNumber,
            paymentAmount: paymentAmount,
            paymentMethod: paymentMethod,
            transactionId: transactionId,
            customerName: `${existingOrder.customer?.firstName || 'Unknown'} ${existingOrder.customer?.lastName || ''}`,
            paidAt: new Date()
          }
        });
      }
    } catch (notificationError) {
      console.error('Failed to create admin payment notifications:', notificationError);
    }

    // Send real-time WebSocket notification to admin users
    try {
      const websocketService = require('../services/websocketService');
      websocketService.notifyPaymentReceived(existingOrder, paymentAmount, transactionId);
    } catch (wsError) {
      console.error('WebSocket admin payment notification failed:', wsError);
    }

    res.json({
      success: true,
      message: 'Order confirmed successfully after payment',
      order: {
        id: existingOrder._id,
        orderNumber: existingOrder.orderNumber,
        totalAmount: existingOrder.totalAmount,
        status: existingOrder.status,
        paymentStatus: existingOrder.payment.status
      }
    });

  } catch (error) {
    console.error('Update order after payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Create Razorpay payment order
router.post('/create-order', authenticateToken, [
  body('amount').isNumeric().withMessage('Amount is required'),
  body('quotationId').notEmpty().withMessage('Quotation ID is required')
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

    const { amount, quotationId } = req.body;

    if (!isRazorpayConfigured) {
      return res.status(400).json({
        success: false,
        message: 'Payment gateway not configured'
      });
    }

    // Create Razorpay order
    const paymentOrder = await createPaymentOrder(amount, 'INR', `quotation_${quotationId}`);
    
    if (!paymentOrder.success) {
      return res.status(400).json({
        success: false,
        message: paymentOrder.message || 'Failed to create payment order'
      });
    }

    res.json({
      success: true,
      message: 'Payment order created successfully',
      order: paymentOrder
    });

  } catch (error) {
    console.error('Create payment order error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Verify Razorpay payment
router.post('/verify', authenticateToken, [
  body('razorpayOrderId').notEmpty().withMessage('Order ID is required'),
  body('razorpayPaymentId').notEmpty().withMessage('Payment ID is required'),
  body('razorpaySignature').notEmpty().withMessage('Signature is required'),
  body('quotationId').notEmpty().withMessage('Quotation ID is required')
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

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, quotationId } = req.body;

    // Verify payment signature
    const verification = verifyPayment(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    
    if (!verification.success) {
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed',
        error: verification.message
      });
    }

    // Get payment details
    const paymentDetails = await getPaymentDetails(razorpayPaymentId);
    
    if (!paymentDetails.success) {
      return res.status(400).json({
        success: false,
        message: 'Failed to fetch payment details'
      });
    }

    // Get the quotation
    const quotation = await Quotation.findById(quotationId);

    if (!quotation) {
      console.log('❌ Quotation not found for Razorpay payment!');
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }
    
    console.log('✅ Quotation found for Razorpay payment:', quotation._id);
    console.log('Quotation items:', quotation.items);
    console.log('Quotation inquiryId:', quotation.inquiryId);
    
    // Fetch inquiry separately since inquiryId is a String, not ObjectId reference
    const Inquiry = require('../models/Inquiry');
    const inquiry = await Inquiry.findById(quotation.inquiryId);
    
    console.log('Inquiry fetched for Razorpay:', inquiry ? inquiry._id : 'not found');
    console.log('Inquiry parts for Razorpay:', inquiry?.parts);

    // Update order with payment information
    const order = await Order.findOne({ quotation: quotationId })
      .populate('customer', 'firstName lastName email phoneNumber');
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Ensure parts data is populated if missing
    if (!order.parts || order.parts.length === 0) {
      console.log('⚠️ Order has no parts during Razorpay verification, populating from quotation/inquiry...');
      
      // Get parts from quotation items
      let orderParts = quotation.items;
      
      // If quotation has no items, use inquiry parts
      if (!orderParts || orderParts.length === 0) {
        console.log('⚠️ Quotation has no items for Razorpay, using inquiry parts');
        if (inquiry?.parts && inquiry.parts.length > 0) {
          const parts = inquiry.parts;
          const totalAmount = paymentDetails.payment.amount || quotation.totalAmount;
          const totalQuantity = parts.reduce((sum, part) => sum + (part.quantity || 0), 0);
          
          // Calculate prices proportionally based on quantity
          orderParts = parts.map(part => {
            const quantity = part.quantity || 0;
            const itemTotalPrice = totalQuantity > 0 
              ? (totalAmount * quantity) / totalQuantity 
              : totalAmount / parts.length;
            const unitPrice = quantity > 0 ? itemTotalPrice / quantity : itemTotalPrice;
            
            return {
              partName: part.partName || part.partRef || 'N/A',
              partRef: part.partRef || part.partName || 'N/A',
              material: part.material || 'N/A',
              thickness: part.thickness || 'N/A',
              quantity: quantity,
              remarks: part.remarks || '',
              unitPrice: unitPrice,
              totalPrice: itemTotalPrice
            };
          });
          console.log('Calculated order parts from inquiry for payment verification:', orderParts);
        }
      }
      
      // Update order with parts
      if (orderParts && orderParts.length > 0) {
        order.parts = orderParts;
        console.log('Order parts updated during payment verification:', order.parts.length, 'items');
      }
    }

    // Update order payment status
    order.payment = {
      method: 'razorpay',
      status: 'completed',
      transactionId: razorpayPaymentId,
      amount: paymentDetails.payment.amount,
      paidAt: new Date(),
      gateway: 'razorpay',
      gatewayOrderId: razorpayOrderId
    };
    order.status = 'confirmed';
    order.confirmedAt = new Date();

    await order.save();

    // Send payment confirmation email
    try {
      await sendPaymentConfirmation(order);
    } catch (emailError) {
      console.error('Payment confirmation email failed:', emailError);
    }

    // Create notification for customer about order confirmation (not payment)
    try {
      const Notification = require('../models/Notification');
      await Notification.createNotification({
        title: 'Order Confirmed',
        message: `Your order ${order.orderNumber} has been confirmed and is now in production. We will keep you updated on the progress.`,
        type: 'success',
        userId: order.customer,
        relatedEntity: {
          type: 'order',
          entityId: order._id
        },
        metadata: {
          orderNumber: order.orderNumber,
          totalAmount: order.totalAmount,
          status: order.status,
          confirmedAt: new Date()
        }
      });
    } catch (notificationError) {
      console.error('Failed to create customer order confirmation notification:', notificationError);
    }

    // Create notification for all admin users about payment completion
    try {
      const User = require('../models/User');
      const Notification = require('../models/Notification');
      const adminUsers = await User.find({ role: { $in: ['admin', 'backoffice', 'subadmin'] } });
      
      for (const admin of adminUsers) {
        await Notification.createNotification({
          title: 'Payment Received',
          message: `Payment of $${paymentDetails.payment.amount} received for order ${order.orderNumber}. Customer: ${order.customer?.firstName || 'Unknown'} ${order.customer?.lastName || ''}. Transaction ID: ${razorpayPaymentId}`,
          type: 'success',
          userId: admin._id,
          relatedEntity: {
            type: 'order',
            entityId: order._id
          },
          metadata: {
            orderNumber: order.orderNumber,
            paymentAmount: paymentDetails.payment.amount,
            paymentMethod: 'razorpay',
            transactionId: razorpayPaymentId,
            customerName: `${order.customer?.firstName || 'Unknown'} ${order.customer?.lastName || ''}`,
            paidAt: new Date()
          }
        });
      }
    } catch (notificationError) {
      console.error('Failed to create admin payment notifications:', notificationError);
    }

    // Send real-time WebSocket notification to customer
    try {
      const websocketService = require('../services/websocketService');
      websocketService.notifyOrderCreated(order);
    } catch (wsError) {
      console.error('WebSocket payment notification failed:', wsError);
    }

    // Send real-time WebSocket notification to admin users
    try {
      const websocketService = require('../services/websocketService');
      websocketService.notifyPaymentReceived(order, paymentDetails.payment.amount, razorpayPaymentId);
    } catch (wsError) {
      console.error('WebSocket admin payment notification failed:', wsError);
    }

    res.json({
      success: true,
      message: 'Payment verified and order confirmed',
      payment: {
        id: razorpayPaymentId,
        amount: paymentDetails.payment.amount,
        status: paymentDetails.payment.status,
        method: paymentDetails.payment.method
      },
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status
      }
    });

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get payment status
router.get('/status/:paymentId', authenticateToken, async (req, res) => {
  try {
    const { paymentId } = req.params;

    if (!isRazorpayConfigured) {
      return res.status(400).json({
        success: false,
        message: 'Payment gateway not configured'
      });
    }

    const paymentDetails = await getPaymentDetails(paymentId);
    
    if (!paymentDetails.success) {
      return res.status(400).json({
        success: false,
        message: paymentDetails.message || 'Failed to fetch payment details'
      });
    }

    res.json({
      success: true,
      payment: paymentDetails.payment
    });

  } catch (error) {
    console.error('Get payment status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Refund payment (Admin only)
router.post('/refund', authenticateToken, [
  body('paymentId').notEmpty().withMessage('Payment ID is required'),
  body('amount').optional().isNumeric().withMessage('Amount must be numeric'),
  body('reason').optional().isString().withMessage('Reason must be string')
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

    const { paymentId, amount, reason } = req.body;

    if (!isRazorpayConfigured) {
      return res.status(400).json({
        success: false,
        message: 'Payment gateway not configured'
      });
    }

    const refund = await refundPayment(paymentId, amount, reason);
    
    if (!refund.success) {
      return res.status(400).json({
        success: false,
        message: refund.message || 'Refund failed'
      });
    }

    res.json({
      success: true,
      message: 'Refund processed successfully',
      refund: {
        id: refund.refundId,
        amount: refund.amount,
        status: refund.status,
        paymentId: refund.paymentId
      }
    });

  } catch (error) {
    console.error('Refund error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;
