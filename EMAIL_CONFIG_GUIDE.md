# Email Configuration Guide - Quick Setup

## Problem
Email nahi ja rahi kyunki SMTP configuration missing hai.

## Solution - 3 Simple Steps

### Step 1: Gmail App Password Generate Karein
1. Google Account mein jayein: https://myaccount.google.com/
2. **Security** section mein jayein
3. **2-Step Verification** enable karein (agar nahi hai)
4. **App Passwords** par click karein: https://myaccount.google.com/apppasswords
5. **Mail** select karein
6. **Other (Custom name)** select karein
7. Name: "247 CutBend Server" type karein
8. **Generate** click karein
9. 16-character password copy karein (spaces remove karein)

### Step 2: .env File Update Karein
`Comcate_Backend/.env` file khol kar ye lines update karein:

```env
SMTP_USER=apna-email@gmail.com
SMTP_PASS=abcdefghijklmnop    # App Password (16 characters, no spaces)
```

**Example:**
```env
SMTP_USER=myemail@gmail.com
SMTP_PASS=abcd efgh ijkl mnop    # Remove spaces: abcdefghijklmnop
```

### Step 3: Server Restart Karein
```bash
# Stop server (Ctrl+C)
# Then restart:
npm start
```

## Test Karein
1. New inquiry create karein
2. Console mein dikhna chahiye: `✅ Email service initialized successfully`
3. Email back office ko jayegi

## Important Notes
- ❌ Regular Gmail password kaam nahi karega
- ✅ App Password zaroori hai
- ✅ App Password mein spaces nahi hone chahiye
- ✅ 2-Step Verification enable hona chahiye

## Troubleshooting
Agar email nahi ja rahi:
1. Check `.env` file - `SMTP_USER` aur `SMTP_PASS` properly set hain?
2. App Password correct hai? (16 characters, no spaces)
3. 2-Step Verification enable hai?
4. Server restart kiya?

