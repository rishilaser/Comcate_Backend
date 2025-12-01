const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const createAdminUser = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect('mongodb+srv://damsole:Damsole@cluster0.mwqeffk.mongodb.net/komacut?retryWrites=true&w=majority');
    console.log('Connected to MongoDB');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://damsole:Damsole@cluster0.mwqeffk.mongodb.net/komacut?retryWrites=true&w=majority';

    // Hash password
    const hashedPassword = await bcrypt.hash('admin123', 10);

    // Create admin user
    const adminUser = new User({
      firstName: 'Admin',
      lastName: 'User',
      email: 'admin@247cutbend.com',
      password: hashedPassword,
      phoneNumber: '9876543210',
      companyName: '247 Cutbend',
      department: 'Other',
      country: 'India',
      role: 'admin',
      isActive: true
    });

    await adminUser.save();
    console.log('✅ Admin user created successfully!');
    console.log('Email: admin@247cutbend.com');
    console.log('Password: admin123');
    console.log('Role: admin');

  } catch (error) {
    console.error('Error creating admin user:', error);
  } finally {
    process.exit(0);
  }
};

createAdminUser();