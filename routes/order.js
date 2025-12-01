const express = require('express');
const { body, validationResult } = require('express-validator');
const Order = require('../models/Order');
const Notification = require('../models/Notification');
const { sendOrderConfirmation } = require('../services/emailService');

const router = express.Router();

// Import middleware from auth.js
const { authenticateToken, requireBackOffice } = require('../middleware/auth');

// Get customer orders (Customer access)
router.get('/customer', authenticateToken, async (req, res) => {
  try {
    // Only allow customers to access their own orders
    if (req.userRole !== 'customer') {
      return res.status(403).json({
        success: false,
        message: 'Customer access required'
      });
    }

    const orders = await Order.find({ customer: req.userId })
      .populate('customer', 'firstName lastName email companyName')
      .populate('quotation', 'quotationNumber createdAt')
      .populate('inquiry', 'inquiryNumber')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      orders
    });

  } catch (error) {
    console.error('Get customer orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get all orders (Back Office)
router.get('/', authenticateToken, requireBackOffice, async (req, res) => {
  try {
    const orders = await Order.find()
      .populate('customer', 'firstName lastName email companyName')
      .populate('quotation', 'quotationNumber createdAt')
      .populate('inquiry', 'inquiryNumber')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      orders
    });

  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Create order from quotation
router.post('/', authenticateToken, [
  body('quotationId').notEmpty().withMessage('Quotation ID is required'),
  body('paymentMethod').isIn(['online', 'cod', 'direct']).withMessage('Valid payment method is required'),
  body('totalAmount').isFloat({ min: 0 }).withMessage('Valid total amount is required')
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

    const { quotationId, paymentMethod, totalAmount, parts, customer, deliveryAddress } = req.body;

    // Check if quotation exists and is accepted
    const Quotation = require('../models/Quotation');
    const quotation = await Quotation.findById(quotationId);

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: 'Quotation not found'
      });
    }

    if (quotation.status !== 'accepted') {
      return res.status(400).json({
        success: false,
        message: 'Quotation must be accepted before creating order'
      });
    }

    // Get inquiry data separately since quotation.inquiryId is a string
    const Inquiry = require('../models/Inquiry');
    const inquiry = await Inquiry.findById(quotation.inquiryId)
      .populate('customer', 'firstName lastName email companyName phoneNumber');

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Associated inquiry not found'
      });
    }

    console.log('=== ORDER CREATION DEBUG ===');
    console.log('Quotation items:', quotation.items);
    console.log('Quotation items length:', quotation.items ? quotation.items.length : 0);
    console.log('Inquiry parts:', inquiry.parts);
    console.log('Inquiry parts length:', inquiry.parts ? inquiry.parts.length : 0);

    // Determine parts to use for order
    let orderParts = parts || quotation.items;
    
    // If quotation has no items, use inquiry parts
    if (!orderParts || orderParts.length === 0) {
      console.log('Quotation has no items, using inquiry parts');
      if (inquiry.parts && inquiry.parts.length > 0) {
        const totalAmount = quotation.totalAmount || 0;
        const totalQuantity = inquiry.parts.reduce((sum, part) => sum + (part.quantity || 0), 0);
        
        // Calculate prices proportionally based on quantity
        orderParts = inquiry.parts.map(part => {
          const quantity = part.quantity || 0;
          const itemTotalPrice = totalQuantity > 0 
            ? (totalAmount * quantity) / totalQuantity 
            : totalAmount / inquiry.parts.length;
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
        console.log('Calculated order parts from inquiry:', orderParts);
      }
    }

    console.log('Final order parts:', orderParts);
    console.log('Final order parts length:', orderParts ? orderParts.length : 0);
    console.log('Final order parts JSON:', JSON.stringify(orderParts, null, 2));

    // Create order
    const order = new Order({
      quotation: quotationId,
      inquiry: inquiry._id,
      customer: req.userId,
      parts: orderParts || [],
      totalAmount: totalAmount || quotation.totalAmount,
      payment: {
        method: paymentMethod === 'online' ? 'credit_card' : paymentMethod === 'direct' ? 'direct' : 'pending',
        status: paymentMethod === 'online' ? 'pending' : 'completed',
        amount: totalAmount || quotation.totalAmount,
        paidAt: paymentMethod !== 'online' ? new Date() : null
      },
      status: paymentMethod === 'online' ? 'pending' : 'confirmed',
      confirmedAt: paymentMethod !== 'online' ? new Date() : null,
      deliveryAddress: deliveryAddress || inquiry.deliveryAddress,
      specialInstructions: inquiry.specialInstructions
    });

    await order.save();
    
    console.log('✅ Order saved! Order ID:', order._id);
    console.log('✅ Order parts after save:', order.parts);
    console.log('✅ Order parts length after save:', order.parts ? order.parts.length : 0);

    // Populate customer data for email
    await order.populate('customer', 'firstName lastName email companyName phoneNumber');

    // Update quotation status
    quotation.status = 'order_created';
    quotation.order = order._id;
    quotation.orderCreatedAt = new Date();
    await quotation.save();

    // Send payment confirmation email to admin (as per requirement)
    try {
      const { sendPaymentConfirmation } = require('../services/emailService');
      await sendPaymentConfirmation(order);
    } catch (emailError) {
      console.error('Payment confirmation email failed:', emailError);
      // Don't fail the operation if email fails
    }

    // Send order confirmation email to customer
    try {
      await sendOrderConfirmation(order);
    } catch (emailError) {
      console.error('Order confirmation email failed:', emailError);
      // Don't fail the operation if email fails
    }

    // Create notification for customer about order confirmation
    try {
      const Notification = require('../models/Notification');
      await Notification.createNotification({
        title: 'Order Confirmed',
        message: `Your order ${order.orderNumber} has been confirmed and is now in production. ${paymentMethod === 'cod' ? 'Payment will be collected on delivery.' : 'Payment completed successfully.'} We will keep you updated on the progress.`,
        type: 'success',
        userId: order.customer,
        relatedEntity: {
          type: 'order',
          entityId: order._id
        },
        metadata: {
          orderNumber: order.orderNumber,
          totalAmount: order.totalAmount,
          paymentMethod: paymentMethod,
          status: order.status,
          confirmedAt: new Date()
        }
      });
    } catch (notificationError) {
      console.error('Failed to create customer order confirmation notification:', notificationError);
    }

    // Create notification for all admin users about payment received
    try {
      const User = require('../models/User');
      const Notification = require('../models/Notification');
      const adminUsers = await User.find({ role: { $in: ['admin', 'backoffice', 'subadmin'] } });
      
      for (const admin of adminUsers) {
        await Notification.createNotification({
          title: 'Payment Received',
          message: `Payment of $${order.totalAmount} received for order ${order.orderNumber}. Customer: ${order.customer?.firstName || 'Unknown'} ${order.customer?.lastName || ''}. Payment method: ${paymentMethod}`,
          type: 'success',
          userId: admin._id,
          relatedEntity: {
            type: 'order',
            entityId: order._id
          },
          metadata: {
            orderNumber: order.orderNumber,
            paymentAmount: order.totalAmount,
            paymentMethod: paymentMethod,
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
      console.error('WebSocket order notification failed:', wsError);
    }

    // Send real-time WebSocket notification to admin users
    try {
      const websocketService = require('../services/websocketService');
      websocketService.notifyPaymentReceived(order, order.totalAmount, `dummy_${order._id}`);
    } catch (wsError) {
      console.error('WebSocket admin payment notification failed:', wsError);
    }

    console.log('✅ ORDER CREATED SUCCESSFULLY - Sending response');
    console.log('Order ID:', order._id);
    console.log('Order Number:', order.orderNumber);
    
    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      order: {
        _id: order._id,
        id: order._id.toString(),
        orderNumber: order.orderNumber,
        status: order.status,
        totalAmount: order.totalAmount,
        parts: order.parts
      }
    });

  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Get order by ID or Order Number
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    let order;

    console.log('=== FETCHING ORDER ===');
    console.log('Order ID:', id);

    // Check if id is a MongoDB ObjectId (24 hex characters) or order number
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    
    if (isObjectId) {
      // Search by MongoDB ObjectId
      order = await Order.findById(id)
        .populate('customer', 'firstName lastName email companyName phone address')
        .populate('quotation', 'quotationNumber parts totalAmount createdAt')
        .populate('inquiry', 'inquiryNumber files parts deliveryAddress specialInstructions');
    } else {
      // Search by order number
      order = await Order.findOne({ orderNumber: id })
        .populate('customer', 'firstName lastName email companyName phone address')
        .populate('quotation', 'quotationNumber parts totalAmount createdAt')
        .populate('inquiry', 'inquiryNumber files parts deliveryAddress specialInstructions');
    }

    if (!order) {
      console.log('Order not found!');
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    console.log('Order found:', order.orderNumber);
    console.log('Order parts:', order.parts);
    console.log('Order parts length:', order.parts ? order.parts.length : 0);
    console.log('Quotation items:', order.quotation?.items);
    console.log('Inquiry parts:', order.inquiry?.parts);
    console.log('Order deliveryAddress:', order.deliveryAddress);
    console.log('Inquiry deliveryAddress:', order.inquiry?.deliveryAddress);
    console.log('Customer address:', order.customer?.address);
    console.log('Customer phone:', order.customer?.phoneNumber);

    // Check if user has access to this order
    if (req.userRole !== 'admin' && req.userRole !== 'backoffice' && order.customer._id.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    console.log('Sending order response with', order.parts?.length || 0, 'parts');
    res.json({
      success: true,
      order
    });

  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

// Update order delivery time (Back Office)
router.put('/:id/delivery-time', authenticateToken, requireBackOffice, [
  body('estimatedDelivery').isISO8601().withMessage('Valid delivery date is required'),
  body('notes').optional().isString()
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

    const { estimatedDelivery, notes } = req.body;

    const order = await Order.findById(req.params.id)
      .populate('customer', 'firstName lastName email phoneNumber');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Update order with delivery time
    order.production.estimatedCompletion = new Date(estimatedDelivery);
    if (notes) {
      order.production.notes = notes;
    }
    order.status = 'in_production';
    order.updatedAt = new Date();

    await order.save();

    // Send delivery time notification to customer
    try {
      const { sendDeliveryTimeNotification } = require('../services/emailService');
      await sendDeliveryTimeNotification(order);
      console.log('Delivery time notification sent to customer:', order.customer.email);
    } catch (emailError) {
      console.error('Delivery time notification failed:', emailError);
      // Don't fail the operation if email fails
    }

    // Create notification for customer about delivery time update
    try {
      const Notification = require('../models/Notification');
      await Notification.createNotification({
        title: 'Delivery Time Updated',
        message: `Delivery time has been updated for order ${order.orderNumber}. Estimated delivery: ${new Date(estimatedDelivery).toLocaleDateString()}. Your order is now in production.`,
        type: 'info',
        userId: order.customer._id,
        relatedEntity: {
          type: 'order',
          entityId: order._id
        },
        metadata: {
          orderNumber: order.orderNumber,
          estimatedDelivery: estimatedDelivery,
          status: order.status,
          updatedAt: new Date()
        }
      });
    } catch (notificationError) {
      console.error('Failed to create delivery time notification:', notificationError);
    }

    res.json({
      success: true,
      message: 'Delivery time updated and customer notified',
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        estimatedDelivery: order.production.estimatedCompletion
      }
    });

  } catch (error) {
    console.error('Update delivery time error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Update order status (Back Office)
router.put('/:id/status', authenticateToken, requireBackOffice, [
  body('status').isIn(['pending', 'confirmed', 'in_production', 'ready_for_dispatch', 'dispatched', 'delivered', 'cancelled']).withMessage('Invalid status'),
  body('notes').optional().isString()
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

    const { status, notes } = req.body;

    const order = await Order.findById(req.params.id)
      .populate('customer', 'firstName lastName email phoneNumber');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const oldStatus = order.status;
    order.status = status;
    order.updatedAt = new Date();

    // Update payment status based on order status
    if (!order.payment) {
      order.payment = {};
    }
    
    // Set payment status based on order status
    if (status === 'delivered' || status === 'dispatched' || status === 'ready_for_dispatch' || status === 'in_production' || status === 'confirmed') {
      order.payment.status = 'completed';
      if (!order.payment.paidAt) {
        order.payment.paidAt = new Date();
      }
      if (!order.payment.method || order.payment.method === 'pending') {
        order.payment.method = 'bank_transfer';
      }
    } else if (status === 'cancelled') {
      order.payment.status = 'refunded';
    }

    // Set specific timestamps based on status
    if (status === 'confirmed' && !order.confirmedAt) {
      order.confirmedAt = new Date();
    } else if (status === 'in_production' && !order.production.startDate) {
      order.production.startDate = new Date();
    } else if (status === 'ready_for_dispatch') {
      order.production.actualCompletion = new Date();
    } else if (status === 'dispatched') {
      order.dispatch.dispatchedAt = new Date();
    } else if (status === 'delivered') {
      order.dispatch.actualDelivery = new Date();
    }

    if (notes) {
      order.notes = notes;
    }

    await order.save();

    // Send real-time WebSocket notification for status update
    try {
      const websocketService = require('../services/websocketService');
      websocketService.notifyOrderStatusUpdate(order, oldStatus, status);
    } catch (wsError) {
      console.error('WebSocket status update notification failed:', wsError);
    }

    // Send status update email to customer
    try {
      await sendOrderConfirmation(order);
      console.log('Order status update email sent to customer:', order.customer.email);
    } catch (emailError) {
      console.error('Status update email failed:', emailError);
      // Don't fail the operation if email fails
    }

    // Send delivery time notification if delivery time was updated
    if (status === 'confirmed' && order.production?.estimatedCompletion) {
      try {
        const { sendDeliveryTimeNotification } = require('../services/emailService');
        await sendDeliveryTimeNotification(order);
        console.log('Delivery time notification sent to customer:', order.customer.email);
      } catch (deliveryEmailError) {
        console.error('Delivery time notification failed:', deliveryEmailError);
        // Don't fail the operation if email fails
      }
    }

    // Create notification for customer if status changed to dispatched
    // Note: Dispatch notifications are handled in dispatch.js to avoid duplicates
    if (status === 'dispatched' && oldStatus !== 'dispatched') {
      // Only create notification if dispatch details are not available (manual status update)
      if (!order.dispatch || !order.dispatch.trackingNumber) {
        await Notification.createNotification({
          title: 'Order Dispatched',
          message: `Your order ${order.orderNumber} has been dispatched! We will update you with tracking details soon.`,
          type: 'success',
          userId: order.customer._id,
          relatedEntity: {
            type: 'order',
            entityId: order._id
          },
          metadata: {
            orderNumber: order.orderNumber,
            dispatchedAt: new Date()
          }
        });
      }
    }

    res.json({
      success: true,
      message: 'Order status updated and customer notified',
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        updatedAt: order.updatedAt
      }
    });

  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Update dispatch details (Back Office)
router.put('/:id/dispatch', authenticateToken, requireBackOffice, [
  body('courier').notEmpty().withMessage('Courier name is required'),
  body('trackingNumber').notEmpty().withMessage('Tracking number is required'),
  body('estimatedDelivery').optional().isISO8601().withMessage('Valid delivery date is required'),
  body('notes').optional().isString()
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

    const { courier, trackingNumber, estimatedDelivery, notes } = req.body;

    const order = await Order.findById(req.params.id)
      .populate('customer', 'firstName lastName email phoneNumber');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Update dispatch details
    order.dispatch.courier = courier;
    order.dispatch.trackingNumber = trackingNumber;
    order.dispatch.dispatchedAt = new Date();
    order.status = 'dispatched';
    
    if (estimatedDelivery) {
      order.dispatch.estimatedDelivery = new Date(estimatedDelivery);
    }
    
    if (notes) {
      order.dispatch.notes = notes;
    }

    order.updatedAt = new Date();
    await order.save();

    // Send real-time WebSocket notification for dispatch update
    try {
      const websocketService = require('../services/websocketService');
      websocketService.notifyDispatchUpdate(order);
    } catch (wsError) {
      console.error('WebSocket dispatch notification failed:', wsError);
    }

    // Send dispatch notification email to customer
    try {
      await sendOrderConfirmation(order);
      console.log('Dispatch notification email sent to customer:', order.customer.email);
    } catch (emailError) {
      console.error('Dispatch notification email failed:', emailError);
      // Don't fail the operation if email fails
    }

    // Create notification for customer about dispatch details update
    try {
      await Notification.createNotification({
        title: 'Dispatch Details Updated',
        message: `Dispatch details have been updated for order ${order.orderNumber}. Tracking Number: ${order.dispatch.trackingNumber}, Courier: ${order.dispatch.courier}. Estimated delivery: ${order.dispatch.estimatedDelivery ? new Date(order.dispatch.estimatedDelivery).toLocaleDateString() : 'TBD'}.`,
        type: 'info',
        userId: order.customer._id,
        relatedEntity: {
          type: 'order',
          entityId: order._id
        },
        metadata: {
          orderNumber: order.orderNumber,
          trackingNumber: order.dispatch.trackingNumber,
          courier: order.dispatch.courier,
          estimatedDelivery: order.dispatch.estimatedDelivery,
          updatedAt: new Date()
        }
      });
      
      console.log(`Created dispatch details update notification for customer: ${order.customer.email}`);
    } catch (notificationError) {
      console.error('Failed to create dispatch details update notification:', notificationError);
      // Don't fail the operation if notification creation fails
    }

    res.json({
      success: true,
      message: 'Dispatch details updated and customer notified',
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        dispatch: order.dispatch
      }
    });

  } catch (error) {
    console.error('Update dispatch details error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get customer orders
router.get('/customer/:customerId', authenticateToken, async (req, res) => {
  try {
    const { customerId } = req.params;

    // Check if user is accessing their own orders or is admin/backoffice
    if (req.userId !== customerId && !['admin', 'backoffice'].includes(req.userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const orders = await Order.find({ customer: customerId })
      .populate('quotation', 'quotationNumber')
      .populate('inquiry', 'inquiryNumber')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      orders
    });

  } catch (error) {
    console.error('Get customer orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;