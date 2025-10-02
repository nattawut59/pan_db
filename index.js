// index.js - Fixed version แก้ไข error
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 5001;

// Environment Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'gtms_super_secret_key_2025';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'gtms_refresh_secret_2025';
// เพิ่มใน index.js ที่ตอนต้น
console.log('NODE_ENV:', process.env.NODE_ENV);
process.env.NODE_ENV = 'development'; // เพื่อให้เห็น debug info

// Database Configuration - แก้ไข config options
const DB_CONFIG = {
    host: 'gateway01.us-west-2.prod.aws.tidbcloud.com',
    user: '417ZsdFRiJocQ5b.root',
    password: 'Xykv3WsBxTnwejdj',
    database: 'glaucoma_management_system_new',
    port: 4000,
    ssl: {
        rejectUnauthorized: false
    },
    connectTimeout: 60000,              
    charset: 'utf8mb4'
};

// CORS Configuration
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// File upload configuration - แก้ไข path handling
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, 'uploads', 'medical-docs');
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf|doc|docx/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});

// Database Connection Pool - แก้ไข pool options
const pool = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    idleTimeout: 300000,
    maxIdle: 5,
});
const NOTIFICATION_SOUNDS = {
    medication: 'medication-reminder.mp3',
    appointment: 'appointment-alert.mp3',
    emergency: 'emergency-alert.mp3',
    general: 'general-notification.mp3',
    iop_alert: 'iop-warning.mp3'
};
let webpush = null;

try {
    webpush = require('web-push');
    
    // กำหนด VAPID keys (ในการใช้งานจริงควรสร้าง VAPID keys ใหม่)
    const vapidKeys = {
        publicKey: 'BNJzMjQ5ODk0MjIxNTQyNzYyNjU4NjI1NzU4MTkzMTY0OTY4NDE5MzQ2MTU4NzQxMzYxNzY1OTY0MTY4NTk1ODQz',
        privateKey: 'TTEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE'
    };
    
    webpush.setVapidDetails(
        'mailto:admin@gtms.com',
        vapidKeys.publicKey,
        vapidKeys.privateKey
    );
    
    console.log('✅ Web Push configured successfully');
} catch (error) {
    console.log('⚠️ Web Push not available:', error.message);
    webpush = null;
}

// Test database connection
const testDbConnection = async () => {
    try {
        const connection = await pool.getConnection();
        console.log('✅ Database connected successfully');
        connection.release();
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
};

// Utility Functions
const generateId = () => {
    return Math.random().toString(36).substr(2, 8).toUpperCase();
};
const generateHN = () => {
    const year = new Date().getFullYear().toString().slice(-2);
    const random = Math.floor(Math.random() * 900000) + 100000;
    return `${year}${random}`;  // ได้ผลลัพธ์ 8 ตัวอักษรพอดี เช่น "25123456"
};

// Validation Functions
const validateThaiIdCard = (idCard) => {
    if (!/^\d{13}$/.test(idCard)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        sum += parseInt(idCard.charAt(i)) * (13 - i);
    }
    const checkDigit = (11 - (sum % 11)) % 10;
    return checkDigit === parseInt(idCard.charAt(12));
};

const validateEmail = (email) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

const validatePhoneNumber = (phone) => {
    return /^0\d{9}$/.test(phone);
};

// Audit Log Function
const logUserAction = async (userId, action, entityType, entityId, details, status = 'success', ipAddress = null, userAgent = null) => {
    try {
        const logId = generateId();
        const severity = status === 'failed' ? 'warning' : 'info';
        
        await pool.execute(
            `INSERT INTO AuditLogs 
             (log_id, user_id, action, entity_type, entity_id, action_time, ip_address, user_agent, details, status, severity) 
             VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
            [logId, userId, action, entityType, entityId, ipAddress, userAgent, details, status, severity]
        );
    } catch (error) {
        console.error('Failed to log user action:', error);
    }
};

// Session Management
const createUserSession = async (userId, token, deviceInfo, ipAddress, expiresAt) => {
    try {
        const sessionId = generateId();
        await pool.execute(
            `INSERT INTO UserSessions 
             (session_id, user_id, token, device_info, ip_address, expires_at, is_active) 
             VALUES (?, ?, ?, ?, ?, ?, 1)`,
            [sessionId, userId, token, deviceInfo, ipAddress, expiresAt]
        );
        return sessionId;
    } catch (error) {
        console.error('Failed to create session:', error);
        throw error;
    }
};

const invalidateUserSessions = async (userId, currentSessionId = null) => {
    try {
        if (currentSessionId) {
            await pool.execute(
                'UPDATE UserSessions SET is_active = 0 WHERE user_id = ? AND session_id != ?',
                [userId, currentSessionId]
            );
        } else {
            await pool.execute(
                'UPDATE UserSessions SET is_active = 0 WHERE user_id = ?',
                [userId]
            );
        }
    } catch (error) {
        console.error('Failed to invalidate sessions:', error);
    }
};

// Authentication Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ 
            message: 'Access token required',
            code: 'TOKEN_REQUIRED' 
        });
    }

    jwt.verify(token, JWT_SECRET, async (err, user) => {
        if (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ 
                    message: 'Token expired',
                    code: 'TOKEN_EXPIRED' 
                });
            }
            return res.status(403).json({ 
                message: 'Invalid token',
                code: 'TOKEN_INVALID' 
            });
        }

        // Check if session is still active
        try {
            const [sessions] = await pool.execute(
                'SELECT * FROM UserSessions WHERE user_id = ? AND token = ? AND is_active = 1 AND expires_at > NOW()',
                [user.userId, token]
            );

            if (sessions.length === 0) {
                return res.status(401).json({ 
                    message: 'Session expired or invalid',
                    code: 'SESSION_INVALID' 
                });
            }

            req.user = user;
            next();
        } catch (error) {
            console.error('Session validation error:', error);
            return res.status(500).json({ message: 'Internal server error' });
        }
    });
};

// Ensure patient role
const ensurePatient = (req, res, next) => {
    if (req.user.role !== 'patient') {
        return res.status(403).json({
            message: 'Access denied. Patient role required.',
            code: 'INSUFFICIENT_PERMISSIONS'
        });
    }
    next();
};

// Rate limiting
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: {
        error: 'Too many login attempts, please try again later.',
        retryAfter: 15 * 60
    }
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});

const registrationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: {
        error: 'Too many registration attempts, please try again later.',
        retryAfter: 15 * 60
    }
});
const createEnhancedNotification = async (userId, type, title, body, priority = 'medium', options = {}) => {
    try {
        const notificationId = generateId();
        
        // เลือกเสียงตามประเภทการแจ้งเตือน (ใช้ชื่อไฟล์ธรรมดา)
        let soundFile = 'general-notification.mp3';
        switch (type) {
            case 'medication_reminder':
                soundFile = 'medication-reminder.mp3';
                break;
            case 'appointment_reminder':
                soundFile = 'appointment-alert.mp3';
                break;
            case 'health_alert':
            case 'emergency_alert':
                soundFile = 'emergency-alert.mp3';
                break;
            case 'high_iop':
                soundFile = 'iop-warning.mp3';
                break;
        }

        // ตรวจสอบว่าตาราง Notifications มีคอลัมน์ใหม่หรือไม่
        try {
            await pool.execute(
                `INSERT INTO Notifications 
                 (notification_id, user_id, notification_type, title, body, priority, 
                  sound_file, sound_enabled, vibration_enabled, push_enabled, 
                  related_entity_type, related_entity_id, action_url, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    notificationId, userId, type, title, body, priority,
                    soundFile, 1, 1, 1,
                    options.entityType || null,
                    options.entityId || null,
                    options.actionUrl || null,
                    JSON.stringify(options.metadata || {})
                ]
            );
        } catch (dbError) {
            // ถ้าคอลัมน์ใหม่ยังไม่มี ให้ใช้ INSERT แบบเดิม
            console.log('⚠️ Using legacy notification insert (missing new columns)');
            await pool.execute(
                `INSERT INTO Notifications 
                 (notification_id, user_id, notification_type, title, body, priority,
                  related_entity_type, related_entity_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    notificationId, userId, type, title, body, priority,
                    options.entityType || null,
                    options.entityId || null
                ]
            );
        }

        return {
            notificationId,
            soundFile: soundFile,
            soundEnabled: true,
            vibrationEnabled: true,
            pushEnabled: true
        };
    } catch (error) {
        console.error('Create enhanced notification error:', error);
        return null;
    }
};

app.use('/api', apiLimiter);

// ===========================================
// ROUTES
// ===========================================

// Health Check
app.get('/api/health', async (req, res) => {
    const dbStatus = await testDbConnection();
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        database: dbStatus ? 'Connected' : 'Disconnected',
        service: 'GTMS Complete Backend Service'
    });
});

// Test endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'GTMS Backend API is running!',
        version: '1.0.0',
        status: 'OK'
    });
});


// POST /api/auth/register
// แก้ไขใน index.js ตรงส่วน registration endpoint

// ค้นหาบรรทัดที่มีปัญหาประมาณนี้:
// const finalBloodType = tempBloodType && possibleBloodTypes.includes(tempBloodType)

// เพิ่มการประกาศ possibleBloodTypes ก่อนใช้งาน
const possibleBloodTypes = ['A', 'B', 'AB', 'O', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'];

// แทนที่โค้ดเดิมด้วย:
app.post('/api/auth/register', registrationLimiter, async (req, res) => {
    const connection = await pool.getConnection();
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    try {
        await connection.beginTransaction();
        
        const {
            title, firstName, lastName, idCard, birthDate, gender,
            phone, email, 
            emergencyContact, relationship, emergencyPhone, 
            chronicDisease, chronicDiseaseList, drugAllergy, drugAllergyList, 
            consentToDataUsage,
            
            glaucomaDiagnosis, diagnosisDate, glaucomaType, symptoms,
            otherSymptoms, iopMeasured, iopRight, iopLeft, iopMeasurementDate,
            iopTarget,
            familyHistory, familyMember, 
            additionalNotes,

            username, password, confirmPassword, 
            securityQuestion, securityAnswer, 
            twoFactorEnabled
        } = req.body;

        // --- START: Defaulting undefined values to null or appropriate defaults ---
        const finalFirstName = firstName; 
        const finalLastName = lastName;   
        const finalIdCard = idCard;       
        const finalBirthDate = birthDate; 
        const finalGender = gender;       
        
        const finalWeight = (typeof weight !== 'undefined' && weight !== null && !isNaN(parseFloat(weight))) ? parseFloat(weight) : 0;
        const finalHeight = (typeof height !== 'undefined' && height !== null && !isNaN(parseFloat(height))) ? parseFloat(height) : 0;
        
        // แก้ไข Blood Type validation - เพิ่มการประกาศ possibleBloodTypes
        const possibleBloodTypes = ['A', 'B', 'AB', 'O', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'];
        
        let tempBloodType = req.body.bloodType ? String(req.body.bloodType).toUpperCase() : undefined;

        if (tempBloodType === 'UNKNOWN') { 
            tempBloodType = 'unknown'; 
        }

        const finalBloodType = tempBloodType && possibleBloodTypes.includes(tempBloodType)
                               ? tempBloodType
                               : "unknown"; 

        const finalPhone = phone; 
        const finalEmail = email || null;

        const finalEmergencyContact = emergencyContact; 
        const finalRelationship = relationship;         
        const finalEmergencyPhone = emergencyPhone;     

        const finalChronicDisease = chronicDisease || "no";
        const finalChronicDiseaseList = (finalChronicDisease === 'yes' && chronicDiseaseList) ? chronicDiseaseList : null;
        
        const finalDrugAllergy = drugAllergy || "no"; 
        const finalDrugAllergyList = (finalDrugAllergy === 'yes' && drugAllergyList) ? drugAllergyList : null;
        
        const finalConsentToDataUsage = consentToDataUsage === true || consentToDataUsage === 'true' ? 1 : 0;

        const finalFamilyHistory = familyHistory || "no";
        const finalFamilyMember = (finalFamilyHistory === 'yes' && familyMember) ? familyMember : null;
        
        const finalUsername = username || finalIdCard; 

        const finalSecurityQuestion = securityQuestion || null;
        let finalSecurityAnswerHash = null;
        if (securityAnswer) {
            const saltRoundsForSecurity = 10;
            finalSecurityAnswerHash = await bcrypt.hash(securityAnswer.toLowerCase().trim(), saltRoundsForSecurity);
        }
        const finalTwoFactorEnabled = (twoFactorEnabled === true || twoFactorEnabled === 'true') ? 1 : 0;

        const finalGlaucomaDiagnosis = glaucomaDiagnosis || "no";
        const finalDiagnosisDate = (finalGlaucomaDiagnosis === 'yes' && diagnosisDate) ? diagnosisDate : null;
        const finalGlaucomaType = (finalGlaucomaDiagnosis === 'yes' && glaucomaType) ? glaucomaType : null;
        const finalIopMeasured = iopMeasured || "no";
        const finalIopRight = (finalIopMeasured === 'yes' && iopRight !== undefined && iopRight !== null) ? parseFloat(iopRight) : null;
        const finalIopLeft = (finalIopMeasured === 'yes' && iopLeft !== undefined && iopLeft !== null) ? parseFloat(iopLeft) : null;
        const finalIopMeasurementDate = (finalIopMeasured === 'yes' && iopMeasurementDate) ? iopMeasurementDate : null;
        const finalIopTarget = (finalIopMeasured === 'yes' && iopTarget) ? iopTarget : null;
        
        // --- START: VALIDATION LOGIC ---
        if (!finalFirstName || !finalLastName || !finalIdCard || !finalBirthDate || !finalGender ||  
            !finalPhone || !finalEmergencyContact || !finalRelationship || !finalEmergencyPhone || 
            !password || !confirmPassword) {
            return res.status(400).json({ 
                message: 'ข้อมูลส่วนตัวที่จำเป็น (เช่น ชื่อ, บัตรประชาชน, เบอร์โทร) ไม่ครบถ้วน', 
                code: 'MISSING_CORE_PERSONAL_FIELDS' 
            });
        }

        if (!validateThaiIdCard(finalIdCard)) {
            return res.status(400).json({ 
                message: 'รูปแบบเลขบัตรประชาชนไม่ถูกต้อง', 
                code: 'INVALID_ID_CARD' 
            });
        }

        if (finalEmail && !validateEmail(finalEmail)) {
            return res.status(400).json({ 
                message: 'รูปแบบอีเมลไม่ถูกต้อง', 
                code: 'INVALID_EMAIL' 
            });
        }

        if (!validatePhoneNumber(finalPhone) || (finalEmergencyPhone && !validatePhoneNumber(finalEmergencyPhone))) {
            return res.status(400).json({ 
                message: 'รูปแบบเบอร์โทรศัพท์ไม่ถูกต้อง', 
                code: 'INVALID_PHONE' 
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).json({ 
                message: 'รหัสผ่านไม่ตรงกัน', 
                code: 'PASSWORD_MISMATCH' 
            });
        }

        if (password.length < 8 || !/(?=.*[a-zA-Z])(?=.*\d)(?=.*[^A-Za-z0-9])/.test(password)) {
            return res.status(400).json({ 
                message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร และประกอบด้วยตัวอักษร ตัวเลข และสัญลักษณ์พิเศษ', 
                code: 'WEAK_PASSWORD' 
            });
        }

        if (!finalConsentToDataUsage) {
            return res.status(400).json({ 
                message: 'กรุณายินยอมการใช้ข้อมูลส่วนบุคคล', 
                code: 'CONSENT_REQUIRED' 
            });
        }
        // --- END: VALIDATION LOGIC ---

        const [existingUsers] = await connection.execute(
            'SELECT user_id FROM Users WHERE id_card = ? OR username = ?',
            [finalIdCard, finalUsername]
        );
        if (existingUsers.length > 0) {
            await logUserAction(null, 'USER_REGISTRATION_FAILED', 'Users', null, `Duplicate registration attempt - ID: ${finalIdCard}`, 'failed', ipAddress, userAgent);
            return res.status(409).json({ message: 'ผู้ใช้นี้ได้ลงทะเบียนในระบบแล้ว', code: 'USER_ALREADY_EXISTS' });
        }

        const userId = generateId();
        const hn = generateHN();
        const saltRounds = 12;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Users table INSERT
        await connection.execute(
            `INSERT INTO Users 
              (user_id, id_card, role, username, password_hash, email, phone, 
               status, require_password_change, two_fa_enabled, security_question, 
               security_answer_hash, created_at) 
              VALUES (?, ?, 'patient', ?, ?, ?, ?, 'active', 0, ?, ?, ?, NOW())`,
            [userId, finalIdCard, finalUsername, passwordHash, finalEmail, finalPhone, 
             finalTwoFactorEnabled, finalSecurityQuestion, finalSecurityAnswerHash]
        );

        // PatientProfiles table INSERT
        await connection.execute(
            `INSERT INTO PatientProfiles 
            (patient_id, hn, first_name, last_name, date_of_birth, gender, 
            address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation, 
            consent_to_data_usage, registration_date) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE())`,
            [userId, hn, finalFirstName, finalLastName, finalBirthDate, finalGender, 
            req.body.address || null, 
            finalEmergencyContact, finalEmergencyPhone, finalRelationship, 
            finalConsentToDataUsage]
);

        // Medical History
        if (finalChronicDisease === 'yes' && finalChronicDiseaseList) {
            const historyId = generateId();
            await connection.execute(
                `INSERT INTO PatientMedicalHistory (history_id, patient_id, condition_type, condition_name, current_status, notes, recorded_by, recorded_at) VALUES (?, ?, 'chronic', ?, 'active', ?, ?, NOW())`,
                [historyId, userId, finalChronicDiseaseList, additionalNotes || null, userId]
            );
        }

        if (finalDrugAllergy === 'yes' && finalDrugAllergyList) {
            const historyId = generateId();
            await connection.execute(
                `INSERT INTO PatientMedicalHistory (history_id, patient_id, condition_type, condition_name, current_status, notes, recorded_by, recorded_at) VALUES (?, ?, 'allergy', ?, 'active', ?, ?, NOW())`,
                [historyId, userId, finalDrugAllergyList, null, userId]
            );
        }

        // Family History
        if (finalFamilyHistory === 'yes' && finalFamilyMember) {
            const familyHistoryId = generateId();
            await connection.execute(
                `INSERT INTO FamilyGlaucomaHistory (family_history_id, patient_id, relationship, glaucoma_type, notes, recorded_at) VALUES (?, ?, ?, ?, ?, NOW())`,
                [familyHistoryId, userId, finalFamilyMember, finalGlaucomaType || 'unknown', null]
            );
        }

        // IOP Measurements
        if (finalIopMeasured === 'yes' && (finalIopRight || finalIopLeft)) {
            const measurementId = generateId();
            await connection.execute(
                `INSERT INTO IOP_Measurements (measurement_id, patient_id, recorded_by, measurement_date, measurement_time, left_eye_iop, right_eye_iop, measurement_device, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [measurementId, userId, userId, finalIopMeasurementDate || new Date().toISOString().split('T')[0], new Date().toTimeString().split(' ')[0], finalIopLeft, finalIopRight, 'Initial Assessment', null]
            );
        }

        // User Consents
        const consentId = generateId();
        await connection.execute(
            `INSERT INTO UserConsents 
            (consent_id, patient_id, consent_type, consent_category, consent_given, 
            consent_date, consent_source, consent_method, consent_document_version, 
            recorded_by, language_code) 
            VALUES (?, ?, 'data_processing', 'necessary', ?, NOW(), 'web', 'checkbox', '1.0', ?, 'th')`,
            [consentId, userId, finalConsentToDataUsage, userId]
        );
        await connection.commit();
        await logUserAction(userId, 'USER_REGISTRATION', 'Users', userId, 'New patient registration', 'success', ipAddress, userAgent);
        

        console.log(`✅ Registration completed successfully for user: ${finalUsername}`);
        res.status(201).json({
            message: 'ลงทะเบียนสำเร็จ',
            success: true,
            user: { id: userId, hn: hn, username: finalUsername, firstName: finalFirstName, lastName: finalLastName, role: 'patient' }
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('❌ Registration error:', error);
        console.error('❌ Registration error message:', error.message);
        
        await logUserAction(null, 'USER_REGISTRATION_ERROR', 'Users', null, `Registration failed: ${error.message}`, 'failed', ipAddress, userAgent);

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'ข้อมูลผู้ใช้นี้มีในระบบแล้ว', code: 'DUPLICATE_ENTRY' });
        }
        if (error.code === 'ER_BAD_FIELD_ERROR') { 
             return res.status(500).json({
                message: `เกิดข้อผิดพลาดเกี่ยวกับโครงสร้างฐานข้อมูล: ${error.sqlMessage}`,
                code: 'DB_SCHEMA_ERROR',
                errorDetail: error.sqlMessage
            });
        }
        if (error instanceof TypeError && error.message.includes("Bind parameters must not contain undefined")) {
             return res.status(500).json({
                message: 'เกิดข้อผิดพลาดในการเตรียมข้อมูลสำหรับฐานข้อมูล (มีค่า undefined)',
                code: 'UNDEFINED_SQL_PARAM',
                errorDetail: error.message
            });
        }

        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่อีกครั้ง',
            code: 'INTERNAL_ERROR',
            errorDetail: error.message 
        });
    } finally {
        if (connection) connection.release();
    }
});
// Login Endpoint
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const startTime = Date.now();
    const { username, password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    try {
        // Input validation
        if (!username || !password) {
            await logUserAction(null, 'USER_LOGIN_FAILED', 'Users', null, 
                'Missing username or password', 'failed', ipAddress, userAgent);
            return res.status(400).json({ 
                message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน',
                code: 'MISSING_CREDENTIALS' 
            });
        }

        console.log(`🔍 Login attempt for username: ${username}`);

        // Find user by username or national ID
        const [users] = await pool.execute(
            `SELECT u.*, 
                    CASE 
                        WHEN u.role = 'patient' THEN p.first_name
                        WHEN u.role = 'doctor' THEN d.first_name
                        WHEN u.role = 'nurse' THEN n.first_name
                        ELSE NULL
                    END as first_name,
                    CASE 
                        WHEN u.role = 'patient' THEN p.last_name
                        WHEN u.role = 'doctor' THEN d.last_name
                        WHEN u.role = 'nurse' THEN n.last_name
                        ELSE NULL
                    END as last_name,
                    CASE 
                        WHEN u.role = 'patient' THEN p.hn
                        ELSE NULL
                    END as hn
             FROM Users u
             LEFT JOIN PatientProfiles p ON u.user_id = p.patient_id AND u.role = 'patient'
             LEFT JOIN DoctorProfiles d ON u.user_id = d.doctor_id AND u.role = 'doctor'
             LEFT JOIN NurseProfiles n ON u.user_id = n.nurse_id AND u.role = 'nurse'
             WHERE u.username = ? OR u.id_card = ?`,
            [username, username]
        );

        if (users.length === 0) {
            await logUserAction(null, 'USER_LOGIN_FAILED', 'Users', null, 
                `User not found: ${username}`, 'failed', ipAddress, userAgent);
            return res.status(401).json({ 
                message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
                code: 'INVALID_CREDENTIALS' 
            });
        }

        const user = users[0];

        // Check account status
        if (user.status !== 'active') {
            await logUserAction(user.user_id, 'USER_LOGIN_FAILED', 'Users', user.user_id, 
                `Account status: ${user.status}`, 'failed', ipAddress, userAgent);
            return res.status(423).json({ 
                message: 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
                code: 'ACCOUNT_INACTIVE' 
            });
        }

        // Check if account is locked
        if (user.account_locked && user.account_locked_until && new Date() < new Date(user.account_locked_until)) {
            const lockTime = new Date(user.account_locked_until);
            const remainingMinutes = Math.ceil((lockTime - new Date()) / (1000 * 60));
            
            await logUserAction(user.user_id, 'USER_LOGIN_FAILED', 'Users', user.user_id, 
                'Account locked', 'failed', ipAddress, userAgent);
            return res.status(423).json({ 
                message: `บัญชีถูกล็อค กรุณาลองใหม่ในอีก ${remainingMinutes} นาที`,
                code: 'ACCOUNT_LOCKED',
                retryAfter: remainingMinutes * 60
            });
        }

        // Verify password
        const isValidPassword = await bcrypt.compare(password, user.password_hash);

        if (!isValidPassword) {
            // Increment failed attempts
            const newFailedAttempts = (user.failed_login_attempts || 0) + 1;
            let lockUntil = null;
            let isLocked = false;

            // Lock account after 5 failed attempts
            if (newFailedAttempts >= 5) {
                lockUntil = new Date(Date.now() + 30 * 60 * 1000);
                isLocked = true;
            }

            await pool.execute(
                `UPDATE Users 
                 SET failed_login_attempts = ?, 
                     account_locked = ?, 
                     account_locked_until = ? 
                 WHERE user_id = ?`,
                [newFailedAttempts, isLocked ? 1 : 0, lockUntil, user.user_id]
            );

            await logUserAction(user.user_id, 'USER_LOGIN_FAILED', 'Users', user.user_id, 
                `Invalid password. Attempts: ${newFailedAttempts}`, 'failed', ipAddress, userAgent);

            const message = isLocked 
                ? 'รหัสผ่านไม่ถูกต้อง บัญชีถูกล็อคเป็นเวลา 30 นาที'
                : `รหัสผ่านไม่ถูกต้อง (เหลือ ${5 - newFailedAttempts} ครั้ง)`;

            return res.status(401).json({ 
                message,
                code: 'INVALID_PASSWORD',
                attemptsRemaining: isLocked ? 0 : 5 - newFailedAttempts
            });
        }

        // Reset failed attempts and unlock account
        await pool.execute(
            `UPDATE Users 
             SET failed_login_attempts = 0, 
                 account_locked = 0, 
                 account_locked_until = NULL, 
                 last_login = NOW() 
             WHERE user_id = ?`,
            [user.user_id]
        );

        // Generate tokens
        const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const refreshTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        const accessToken = jwt.sign(
            { 
                userId: user.user_id, 
                role: user.role,
                nationalId: user.id_card,
                requirePasswordChange: user.require_password_change
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        const refreshToken = jwt.sign(
            { 
                userId: user.user_id, 
                type: 'refresh'
            },
            JWT_REFRESH_SECRET,
            { expiresIn: '7d' }
        );

        // Create session
        const sessionId = await createUserSession(
            user.user_id, 
            accessToken, 
            userAgent, 
            ipAddress, 
            tokenExpiry
        );

        // Store refresh token
        const refreshTokenId = generateId();
        await pool.execute(
            `INSERT INTO refresh_tokens (token_id, user_id, token, expires_at) 
             VALUES (?, ?, ?, ?)`,
            [refreshTokenId, user.user_id, refreshToken, refreshTokenExpiry]
        );

        // Prepare user profile
        const userProfile = {
            id: user.user_id,
            role: user.role,
            username: user.username,
            nationalId: user.id_card,
            email: user.email,
            phone: user.phone,
            firstName: user.first_name,
            lastName: user.last_name,
            hn: user.hn,
            requirePasswordChange: user.require_password_change,
            twoFaEnabled: user.two_fa_enabled,
            lastLogin: user.last_login
        };

        // Log successful login
        await logUserAction(user.user_id, 'USER_LOGIN', 'Users', user.user_id, 
            `Successful login from ${ipAddress}`, 'success', ipAddress, userAgent);

        const responseTime = Date.now() - startTime;
        console.log(`✅ Login successful for ${user.username} (${responseTime}ms)`);

        res.json({
            message: 'Login successful',
            token: accessToken,
            refreshToken,
            expiresAt: tokenExpiry.toISOString(),
            sessionId,
            user: userProfile
        });

    } catch (error) {
        console.error('❌ Login error:', error);
        
        await logUserAction(null, 'USER_LOGIN_ERROR', 'Users', null, 
            `System error: ${error.message}`, 'failed', ipAddress, userAgent);

        res.status(500).json({ 
            message: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่อีกครั้ง',
            code: 'INTERNAL_ERROR' 
        });
    }
});

// Refresh Token Endpoint
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(401).json({ 
                message: 'Refresh token required',
                code: 'REFRESH_TOKEN_REQUIRED' 
            });
        }

        // Verify refresh token
        const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
        
        // Check if refresh token exists and is valid
        const [tokens] = await pool.execute(
            'SELECT * FROM refresh_tokens WHERE user_id = ? AND token = ? AND is_revoked = 0 AND expires_at > NOW()',
            [decoded.userId, refreshToken]
        );

        if (tokens.length === 0) {
            return res.status(401).json({ 
                message: 'Invalid or expired refresh token',
                code: 'INVALID_REFRESH_TOKEN' 
            });
        }

        // Get user data
        const [users] = await pool.execute(
            'SELECT * FROM Users WHERE user_id = ? AND status = "active"',
            [decoded.userId]
        );

        if (users.length === 0) {
            return res.status(401).json({ 
                message: 'User not found or inactive',
                code: 'USER_NOT_FOUND' 
            });
        }

        const user = users[0];

        // Generate new access token
        const newAccessToken = jwt.sign(
            { 
                userId: user.user_id, 
                role: user.role,
                nationalId: user.id_card,
                requirePasswordChange: user.require_password_change
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // Update session
        await pool.execute(
            'UPDATE UserSessions SET token = ?, expires_at = ? WHERE user_id = ? AND is_active = 1',
            [newAccessToken, tokenExpiry, user.user_id]
        );

        res.json({
            message: 'Token refreshed successfully',
            token: newAccessToken,
            expiresAt: tokenExpiry.toISOString()
        });

    } catch (error) {
        console.error('Refresh token error:', error);
        
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                message: 'Invalid refresh token',
                code: 'INVALID_REFRESH_TOKEN' 
            });
        }

        res.status(500).json({ 
            message: 'Internal server error',
            code: 'INTERNAL_ERROR' 
        });
    }
});

// Logout Endpoint
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const ipAddress = req.ip || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'];

        // Invalidate all active sessions for this user
        await invalidateUserSessions(userId);

        // Revoke all refresh tokens
        await pool.execute(
            'UPDATE refresh_tokens SET is_revoked = 1 WHERE user_id = ?',
            [userId]
        );

        await logUserAction(userId, 'USER_LOGOUT', 'Users', userId, 
            'User logged out', 'success', ipAddress, userAgent);

        res.json({ 
            message: 'Logout successful',
            code: 'LOGOUT_SUCCESS' 
        });

    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ 
            message: 'Internal server error',
            code: 'INTERNAL_ERROR' 
        });
    }
});

// Get Current User Info
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [users] = await pool.execute(
            `SELECT u.*, 
                    CASE 
                        WHEN u.role = 'patient' THEN p.first_name
                        WHEN u.role = 'doctor' THEN d.first_name
                        WHEN u.role = 'nurse' THEN n.first_name
                        ELSE NULL
                    END as first_name,
                    CASE 
                        WHEN u.role = 'patient' THEN p.last_name
                        WHEN u.role = 'doctor' THEN d.last_name
                        WHEN u.role = 'nurse' THEN n.last_name
                        ELSE NULL
                    END as last_name,
                    CASE 
                        WHEN u.role = 'patient' THEN p.hn
                        ELSE NULL
                    END as hn
             FROM Users u
             LEFT JOIN PatientProfiles p ON u.user_id = p.patient_id AND u.role = 'patient'
             LEFT JOIN DoctorProfiles d ON u.user_id = d.doctor_id AND u.role = 'doctor'
             LEFT JOIN NurseProfiles n ON u.user_id = n.nurse_id AND u.role = 'nurse'
             WHERE u.user_id = ?`,
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({ 
                message: 'User not found',
                code: 'USER_NOT_FOUND' 
            });
        }

        const user = users[0];

        const userProfile = {
            id: user.user_id,
            role: user.role,
            username: user.username,
            nationalId: user.id_card,
            email: user.email,
            phone: user.phone,
            firstName: user.first_name,
            lastName: user.last_name,
            hn: user.hn,
            requirePasswordChange: user.require_password_change,
            twoFaEnabled: user.two_fa_enabled,
            lastLogin: user.last_login,
            status: user.status
        };

        res.json({ user: userProfile });

    } catch (error) {
        console.error('Get user info error:', error);
        res.status(500).json({ 
            message: 'Internal server error',
            code: 'INTERNAL_ERROR' 
        });
    }
});

// ===========================================
// PATIENT PROFILE & SETTINGS
// ===========================================

// Get patient profile
app.get('/api/patient/profile', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [profiles] = await pool.execute(
            `SELECT p.*, u.username, u.email, u.phone, u.id_card, u.created_at,
                    u.last_login, u.two_fa_enabled
             FROM PatientProfiles p
             JOIN Users u ON p.patient_id = u.user_id
             WHERE p.patient_id = ?`,
            [userId]
        );

        if (profiles.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบข้อมูลผู้ป่วย',
                code: 'PATIENT_NOT_FOUND'
            });
        }

        const profile = profiles[0];

        // Calculate age
        const birthDate = new Date(profile.date_of_birth);
        const today = new Date();
        const age = today.getFullYear() - birthDate.getFullYear();

        res.json({
            profile: {
                ...profile,
                age,
                date_of_birth: profile.date_of_birth.toISOString().split('T')[0]
            }
        });

    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Update patient profile
// Update patient profile
app.put('/api/patient/profile', authenticateToken, ensurePatient, async (req, res) => {
    const connection = await pool.getConnection();
    
    try {
        await connection.beginTransaction();
        
        const userId = req.user.userId;
        const {
            first_name, last_name, email, phone, weight, height,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
            address, insurance_type, insurance_no,
            date_of_birth, gender // 🚨 เพิ่มตัวแปรเหล่านี้เข้ามา
        } = req.body;

        // 🚨 แก้ไขตรงนี้: ทำให้ทุกตัวแปรเป็น null ถ้ามันเป็น undefined
        const finalFirstName = first_name ?? null;
        const finalLastName = last_name ?? null;
        const finalEmail = email ?? null;
        const finalPhone = phone ?? null;
        // สำหรับ weight และ height ให้ตรวจสอบว่าเป็นตัวเลขด้วย
        const finalWeight = (typeof weight !== 'undefined' && weight !== null && !isNaN(parseFloat(weight))) ? parseFloat(weight) : null;
        const finalHeight = (typeof height !== 'undefined' && height !== null && !isNaN(parseFloat(height))) ? parseFloat(height) : null;
        const finalEmergencyContactName = emergency_contact_name ?? null;
        const finalEmergencyContactPhone = emergency_contact_phone ?? null;
        const finalEmergencyContactRelation = emergency_contact_relation ?? null;
        const finalAddress = address ?? null;
        const finalInsuranceType = insurance_type ?? null;
        const finalInsuranceNo = insurance_no ?? null;
        const finalDateOfBirth = date_of_birth ?? null; // 🚨 เพิ่มมา
        const finalGender = gender ?? null; // 🚨 เพิ่มมา

        // Update user table
        if (finalEmail !== null || finalPhone !== null) {
    await connection.execute(
        `UPDATE Users SET email = COALESCE(?, email), phone = COALESCE(?, phone)
         WHERE user_id = ?`,
        [finalEmail, finalPhone, userId]
    );
}

// อัปเดต PatientProfiles table
await connection.execute(
    `UPDATE PatientProfiles
     SET
     first_name = COALESCE(?, first_name),
     last_name = COALESCE(?, last_name),
     date_of_birth = COALESCE(?, date_of_birth),
     gender = COALESCE(?, gender),
     weight = COALESCE(?, weight),
     height = COALESCE(?, height),
     address = COALESCE(?, address),
     emergency_contact_name = COALESCE(?, emergency_contact_name),
     emergency_contact_phone = COALESCE(?, emergency_contact_phone),
     emergency_contact_relation = COALESCE(?, emergency_contact_relation),
     insurance_type = COALESCE(?, insurance_type),
     insurance_no = COALESCE(?, insurance_no)
     WHERE patient_id = ?`,
    [finalFirstName, finalLastName, finalDateOfBirth, finalGender,
     finalWeight, finalHeight, finalAddress,
     finalEmergencyContactName, finalEmergencyContactPhone, finalEmergencyContactRelation,
     finalInsuranceType, finalInsuranceNo, userId]
);
        await connection.commit();

        res.json({
            message: 'อัปเดตข้อมูลสำเร็จ',
            success: true
        });

    } catch (error) {
        await connection.rollback();
        console.error('Update profile error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปเดตข้อมูล',
            code: 'UPDATE_ERROR'
        });
    } finally {
        connection.release();
    }
});
// Get/Update user settings
app.get('/api/patient/settings', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [settings] = await pool.execute(
            'SELECT * FROM UserSettings WHERE user_id = ?',
            [userId]
        );

        if (settings.length === 0) {
            // Create default settings
            const settingId = generateId();
            await pool.execute(
                `INSERT INTO UserSettings (setting_id, user_id) VALUES (?, ?)`,
                [settingId, userId]
            );

            const [newSettings] = await pool.execute(
                'SELECT * FROM UserSettings WHERE setting_id = ?',
                [settingId]
            );

            return res.json({ settings: newSettings[0] });
        }

        res.json({ settings: settings[0] });

    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// index.js (ประมาณบรรทัด 470 หรือใกล้เคียง)
// index.js
// ... (โค้ดด้านบน)

// Update patient settings
app.put('/api/patient/settings', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            language,
            theme,
            font_size,
            notification_preferences, // อันนี้เป็น JSON string
            privacy_settings,         // อันนี้เป็น JSON string
            time_zone,
            quiet_hours_start,
            quiet_hours_end,
            default_view, // มีอยู่แล้ว
            dark_mode,
            time_format,
            date_format,
            week_start,
            iop_unit,
            trend_line,
            normal_range,
            default_chart_type
        } = req.body;

        // 🚨 แก้ไขตรงนี้: ทำให้ทุกตัวแปรที่รับมาจาก req.body ถูกแปลงเป็น null ถ้าเป็น undefined
        const finalLanguage = language ?? null;
        const finalTheme = theme ?? null;
        const finalFontSize = font_size ?? null;
        // notification_preferences และ privacy_settings จะถูก stringify อีกทีตอนใช้
        const finalNotificationPreferences = notification_preferences ? JSON.stringify(notification_preferences) : null;
        const finalPrivacySettings = privacy_settings ? JSON.stringify(privacy_settings) : null;
        const finalTimeZone = time_zone ?? null;
        // quiet_hours_start, quiet_hours_end ควรจะเป็น string เวลา เช่น "HH:MM:SS" หรือ null
        const finalQuietHoursStart = quiet_hours_start ?? null;
        const finalQuietHoursEnd = quiet_hours_end ?? null;
        const finalDefaultView = default_view ?? null;

        // ตัวแปรใหม่ที่เพิ่มเข้ามาจาก frontend
        const finalDarkMode = (dark_mode !== undefined && dark_mode !== null) ? (dark_mode ? 1 : 0) : null;
        const finalTimeFormat = time_format ?? null;
        const finalDateFormat = date_format ?? null;
        const finalWeekStart = week_start ?? null;
        const finalIopUnit = iop_unit ?? null;
        const finalTrendLine = (trend_line !== undefined && trend_line !== null) ? (trend_line ? 1 : 0) : null;
        const finalNormalRange = (normal_range !== undefined && normal_range !== null) ? (normal_range ? 1 : 0) : null;
        const finalDefaultChartType = default_chart_type ?? null;

        await pool.execute(
            `UPDATE UserSettings SET
             language = COALESCE(?, language),
             theme = COALESCE(?, theme),
             font_size = COALESCE(?, font_size),
             notification_preferences = COALESCE(?, notification_preferences),
             privacy_settings = COALESCE(?, privacy_settings),
             time_zone = COALESCE(?, time_zone),
             quiet_hours_start = COALESCE(?, quiet_hours_start),
             quiet_hours_end = COALESCE(?, quiet_hours_end),
             default_view = COALESCE(?, default_view),
             -- คอลัมน์ใหม่
             dark_mode = COALESCE(?, dark_mode),
             time_format = COALESCE(?, time_format),
             date_format = COALESCE(?, date_format),
             week_start = COALESCE(?, week_start),
             iop_unit = COALESCE(?, iop_unit),
             trend_line = COALESCE(?, trend_line),
             normal_range = COALESCE(?, normal_range),
             default_chart_type = COALESCE(?, default_chart_type)
             WHERE user_id = ?`,
            [finalLanguage, finalTheme, finalFontSize,
             finalNotificationPreferences, // ใช้ตัวแปร final ที่ผ่านการแปลงแล้ว
             finalPrivacySettings,         // ใช้ตัวแปร final ที่ผ่านการแปลงแล้ว
             finalTimeZone, finalQuietHoursStart, finalQuietHoursEnd, finalDefaultView,
             // 🚨 ตรงนี้คือที่สำคัญ: เรียงลำดับให้ตรงกับ ? ใน SQL Query และใช้ final...
             finalDarkMode,
             finalTimeFormat,
             finalDateFormat,
             finalWeekStart,
             finalIopUnit,
             finalTrendLine,
             finalNormalRange,
             finalDefaultChartType,
             userId] // userId ต้องเป็นตัวสุดท้ายเสมอ
        );

        res.json({
            message: 'อัปเดตการตั้งค่าสำเร็จ',
            success: true
        });

    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปเดตการตั้งค่า',
            code: 'UPDATE_ERROR',
            errorDetail: error.message // 🚨 เพิ่ม errorDetail เพื่อให้เห็นรายละเอียด
        });
    }
});

// ===========================================
// MEDICATION MANAGEMENT (ระบบแจ้งเตือนการหยอดยาตาตามเวลา)
// ===========================================

// Get patient medications
app.get('/api/patient/medications', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [medications] = await pool.execute(
            `SELECT pm.*, m.name, m.generic_name, m.form, m.strength,
                    m.description, m.image_url, m.side_effects
             FROM PatientMedications pm
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.patient_id = ? AND pm.status = 'active'
             ORDER BY pm.created_at DESC`,
            [userId]
        );

        res.json({ medications });

    } catch (error) {
        console.error('Get medications error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get medication reminders (การแจ้งเตือนการหยอดยาตาตามเวลา พร้อมรูปภาพยา)
app.get('/api/patient/medication-reminders', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [reminders] = await pool.execute(
            `SELECT mr.*, m.name, m.image_url, pm.dosage,
                    CASE 
                        WHEN mr.eye = 'left' THEN 'ตาซ้าย'
                        WHEN mr.eye = 'right' THEN 'ตาขวา'
                        WHEN mr.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE mr.eye
                    END as eye_display
             FROM MedicationReminders mr
             JOIN PatientMedications pm ON mr.prescription_id = pm.prescription_id
             JOIN Medications m ON mr.medication_id = m.medication_id
             WHERE mr.patient_id = ? AND mr.is_active = 1
             ORDER BY mr.reminder_time`,
            [userId]
        );

        res.json({ reminders });

    } catch (error) {
        console.error('Get reminders error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Record medication usage (การบันทึกและติดตามการใช้ยาตามกำหนด)
app.post('/api/patient/medication-usage', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            reminder_id, medication_id, status, eye, drops_count, notes,
            scheduled_time, actual_time
        } = req.body;

        const recordId = generateId();

        await pool.execute(
            `INSERT INTO MedicationUsageRecords 
             (record_id, patient_id, reminder_id, medication_id, 
              scheduled_time, actual_time, status, eye, drops_count, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [recordId, userId, reminder_id, medication_id,
             scheduled_time, actual_time || new Date(), status, eye, drops_count, notes]
        );

        res.json({
            message: 'บันทึกการใช้ยาสำเร็จ',
            success: true,
            record_id: recordId
        });

    } catch (error) {
        console.error('Record medication usage error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการบันทึกการใช้ยา',
            code: 'RECORD_ERROR'
        });
    }
});

// Get medication adherence report
app.get('/api/patient/medication-adherence', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { period = '30' } = req.query;

        const [adherence] = await pool.execute(
            `SELECT 
                medication_id,
                COUNT(*) as total_scheduled,
                SUM(CASE WHEN status = 'taken' THEN 1 ELSE 0 END) as total_taken,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as total_skipped,
                ROUND((SUM(CASE WHEN status = 'taken' THEN 1 ELSE 0 END) / COUNT(*)) * 100, 2) as adherence_rate
             FROM MedicationUsageRecords
             WHERE patient_id = ? 
             AND scheduled_time >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY medication_id`,
            [userId, parseInt(period)]
        );

        res.json({ adherence });

    } catch (error) {
        console.error('Get adherence error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get medication inventory (แจ้งเตือนเมื่อยาใกล้หมดโดยคำนวณจากการใช้จริง)
app.get('/api/patient/medication-inventory', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        // ดึงข้อมูลจาก MedicationInventory ที่มีอยู่แล้ว
        const [existingInventory] = await pool.execute(
            `SELECT mi.*, m.name, m.image_url, m.description, m.strength,
                    DATEDIFF(mi.expected_end_date, CURDATE()) as days_remaining,
                    CASE 
                        WHEN DATEDIFF(mi.expected_end_date, CURDATE()) <= 3 THEN 'critical'
                        WHEN DATEDIFF(mi.expected_end_date, CURDATE()) <= 7 THEN 'warning'
                        ELSE 'normal'
                    END as alert_level,
                    CASE 
                        WHEN mi.eye = 'left' THEN 'ตาซ้าย'
                        WHEN mi.eye = 'right' THEN 'ตาขวา'
                        WHEN mi.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE mi.eye
                    END as eye_display
             FROM MedicationInventory mi
             JOIN Medications m ON mi.medication_id = m.medication_id
             WHERE mi.patient_id = ?
             ORDER BY mi.is_depleted ASC, mi.expected_end_date ASC`,
            [userId]
        );

        // ดึงยาที่หมอสั่งแต่ยังไม่มีใน inventory
        const [patientMedications] = await pool.execute(
            `SELECT pm.*, m.name, m.image_url, m.description, m.strength,
                    CASE 
                        WHEN pm.eye = 'left' THEN 'ตาซ้าย'
                        WHEN pm.eye = 'right' THEN 'ตาขวา'
                        WHEN pm.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE pm.eye
                    END as eye_display
             FROM PatientMedications pm
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.patient_id = ? AND pm.status = 'active'
             AND pm.medication_id NOT IN (
                 SELECT DISTINCT medication_id 
                 FROM MedicationInventory 
                 WHERE patient_id = ? AND is_depleted = 0
             )`,
            [userId, userId]
        );

        // รวมข้อมูลทั้งสองส่วน
        const combinedInventory = [
            ...existingInventory,
            ...patientMedications.map(med => ({
                inventory_id: `pm_${med.prescription_id}`, // ใช้ prefix เพื่อแยกจาก inventory จริง
                patient_id: med.patient_id,
                medication_id: med.medication_id,
                name: med.name,
                image_url: med.image_url,
                description: med.description,
                strength: med.strength,
                eye: med.eye,
                eye_display: med.eye_display,
                dosage: med.dosage,
                frequency: med.frequency,
                is_depleted: 0,
                days_remaining: null, // ยังไม่ได้ตั้งค่า
                alert_level: 'unknown',
                source: 'prescription' // ระบุว่ามาจากใบสั่งยา
            }))
        ];

        res.json({ inventory: combinedInventory });

    } catch (error) {
        console.error('Get inventory error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

app.post('/api/patient/medication-inventory', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            prescription_id,
            medication_id,
            bottles_dispensed = 1,
            bottle_volume_ml = 5,
            drops_per_ml = 20,
            expected_end_date,
            dispensed_date,
            notes
        } = req.body;

        // ตรวจสอบว่ายานี้เป็นของผู้ป่วยคนนี้จริง
        const [prescriptionCheck] = await pool.execute(
            `SELECT * FROM PatientMedications 
             WHERE prescription_id = ? AND patient_id = ? AND medication_id = ?`,
            [prescription_id, userId, medication_id]
        );

        if (prescriptionCheck.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบรายการยาที่หมอสั่งนี้',
                code: 'PRESCRIPTION_NOT_FOUND'
            });
        }

        // ตรวจสอบว่ามี inventory record อยู่แล้วหรือไม่
        const [existingInventory] = await pool.execute(
            `SELECT * FROM MedicationInventory 
             WHERE patient_id = ? AND medication_id = ? AND prescription_id = ?`,
            [userId, medication_id, prescription_id]
        );

        const inventoryId = generateId();
        const finalExpectedEndDate = expected_end_date || 
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // default 30 วัน
        const finalDispensedDate = dispensed_date || new Date().toISOString().split('T')[0];

        if (existingInventory.length > 0) {
            // อัปเดต record ที่มีอยู่
            await pool.execute(
                `UPDATE MedicationInventory 
                 SET bottles_dispensed = bottles_dispensed + ?, 
                     expected_end_date = ?, 
                     is_depleted = 0,
                     notes = COALESCE(?, notes),
                     last_updated = NOW()
                 WHERE inventory_id = ?`,
                [bottles_dispensed, finalExpectedEndDate, notes, existingInventory[0].inventory_id]
            );

            res.json({
                message: 'อัปเดตข้อมูลคลังยาสำเร็จ',
                success: true,
                inventory_id: existingInventory[0].inventory_id
            });
        } else {
            // สร้าง record ใหม่
            const prescription = prescriptionCheck[0];
            
            await pool.execute(
                `INSERT INTO MedicationInventory 
                 (inventory_id, patient_id, medication_id, prescription_id,
                  eye, bottles_dispensed, bottle_volume_ml, drops_per_ml,
                  dispensed_date, expected_end_date, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [inventoryId, userId, medication_id, prescription_id,
                 prescription.eye, bottles_dispensed, bottle_volume_ml, drops_per_ml,
                 finalDispensedDate, finalExpectedEndDate, notes]
            );

            res.json({
                message: 'เพิ่มข้อมูลคลังยาสำเร็จ',
                success: true,
                inventory_id: inventoryId
            });
        }

    } catch (error) {
        console.error('Add inventory error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการเพิ่มข้อมูลคลังยา',
            code: 'ADD_INVENTORY_ERROR'
        });
    }
});

// ตั้งค่าข้อมูลคลังยาสำหรับยาที่หมอสั่ง (สำหรับ frontend)
app.post('/api/patient/setup-medication-inventory', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            prescription_id,
            bottles_received = 1,
            days_supply = 30,
            dispensed_date
        } = req.body;

        // ดึงข้อมูลยาที่หมอสั่ง
        const [prescription] = await pool.execute(
            `SELECT pm.*, m.name FROM PatientMedications pm
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.prescription_id = ? AND pm.patient_id = ?`,
            [prescription_id, userId]
        );

        if (prescription.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบรายการยาที่หมอสั่ง',
                code: 'PRESCRIPTION_NOT_FOUND'
            });
        }

        const med = prescription[0];
        const inventoryId = generateId();
        const finalDispensedDate = dispensed_date || new Date().toISOString().split('T')[0];
        const expectedEndDate = new Date(Date.now() + days_supply * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        // ตรวจสอบว่ามี inventory record อยู่แล้วหรือไม่
        const [existingInventory] = await pool.execute(
            `SELECT * FROM MedicationInventory 
             WHERE patient_id = ? AND prescription_id = ?`,
            [userId, prescription_id]
        );

        if (existingInventory.length > 0) {
            // อัปเดต record ที่มีอยู่
            await pool.execute(
                `UPDATE MedicationInventory 
                 SET bottles_dispensed = ?, 
                     dispensed_date = ?,
                     expected_end_date = ?, 
                     is_depleted = 0,
                     last_updated = NOW()
                 WHERE inventory_id = ?`,
                [bottles_received, finalDispensedDate, expectedEndDate, existingInventory[0].inventory_id]
            );

            res.json({
                message: `ตั้งค่าข้อมูลคลังยา "${med.name}" สำเร็จ`,
                success: true,
                inventory_id: existingInventory[0].inventory_id
            });
        } else {
            // สร้าง record ใหม่
            await pool.execute(
                `INSERT INTO MedicationInventory 
                 (inventory_id, patient_id, medication_id, prescription_id,
                  eye, bottles_dispensed, bottle_volume_ml, drops_per_ml,
                  dispensed_date, expected_end_date)
                 VALUES (?, ?, ?, ?, ?, ?, 5, 20, ?, ?)`,
                [inventoryId, userId, med.medication_id, prescription_id,
                 med.eye, bottles_received, finalDispensedDate, expectedEndDate]
            );

            res.json({
                message: `ตั้งค่าข้อมูลคลังยา "${med.name}" สำเร็จ`,
                success: true,
                inventory_id: inventoryId
            });
        }

    } catch (error) {
        console.error('Setup inventory error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการตั้งค่าข้อมูลคลังยา',
            code: 'SETUP_INVENTORY_ERROR'
        });
    }
});

// อัปเดตสถานะยาหมด
app.put('/api/patient/medication-inventory/:inventory_id', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { inventory_id } = req.params;
        const { is_depleted, depleted_date } = req.body;

        // ตรวจสอบว่า inventory นี้เป็นของผู้ป่วยคนนี้
        const [inventory] = await pool.execute(
            `SELECT * FROM MedicationInventory 
             WHERE inventory_id = ? AND patient_id = ?`,
            [inventory_id, userId]
        );

        if (inventory.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบรายการยาในคลัง',
                code: 'INVENTORY_NOT_FOUND'
            });
        }

        const finalDepletedDate = depleted_date || new Date().toISOString().split('T')[0];

        await pool.execute(
            `UPDATE MedicationInventory 
             SET is_depleted = ?, depleted_date = ?, last_updated = NOW()
             WHERE inventory_id = ? AND patient_id = ?`,
            [is_depleted, finalDepletedDate, inventory_id, userId]
        );

        res.json({
            message: 'อัปเดตสถานะยาสำเร็จ',
            success: true
        });

    } catch (error) {
        console.error('Update inventory error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปเดตสถานะยา',
            code: 'UPDATE_INVENTORY_ERROR'
        });
    }
});

// ดูประวัติการใช้ยา (แก้ไขให้ดึงข้อมูลครบถ้วน)
app.get('/api/patient/medication-usage', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { period, date } = req.query;

        let whereClause = 'WHERE mur.patient_id = ?';
        let params = [userId];

        if (date) {
            whereClause += ' AND DATE(mur.scheduled_time) = ?';
            params.push(date);
        } else if (period) {
            whereClause += ' AND mur.scheduled_time >= DATE_SUB(NOW(), INTERVAL ? DAY)';
            params.push(parseInt(period));
        }

        const [records] = await pool.execute(
            `SELECT mur.*, m.name as medication_name,
                    CASE 
                        WHEN mur.eye = 'left' THEN 'ตาซ้าย'
                        WHEN mur.eye = 'right' THEN 'ตาขวา'
                        WHEN mur.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE mur.eye
                    END as eye_display
             FROM MedicationUsageRecords mur
             LEFT JOIN Medications m ON mur.medication_id = m.medication_id
             ${whereClause}
             ORDER BY mur.scheduled_time DESC`,
            params
        );

        res.json({ records });

    } catch (error) {
        console.error('Get medication usage error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Create medication reminder
app.post('/api/patient/medication-reminders', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            prescription_id,
            medication_id,
            reminder_time,
            days_of_week = '0,1,2,3,4,5,6',
            start_date,
            end_date,
            eye = 'both',
            drops_count = 1,
            notification_channels = 'app',
            notes
        } = req.body;

        console.log(`🔔 Creating medication reminder for user ${userId}`);

        // ตรวจสอบข้อมูลพื้นฐาน
        if (!prescription_id || !medication_id || !reminder_time) {
            return res.status(400).json({
                message: 'ข้อมูลไม่ครบถ้วน',
                code: 'MISSING_DATA'
            });
        }

        // ตรวจสอบว่าใบสั่งยานี้เป็นของผู้ป่วยคนนี้
        const [prescriptionCheck] = await pool.execute(
            `SELECT pm.*, m.name FROM PatientMedications pm
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.prescription_id = ? AND pm.patient_id = ? AND pm.medication_id = ?`,
            [prescription_id, userId, medication_id]
        );

        if (prescriptionCheck.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบรายการยาที่เลือก',
                code: 'PRESCRIPTION_NOT_FOUND'
            });
        }

        const reminderId = generateId();
        const finalStartDate = start_date || new Date().toISOString().split('T')[0];

        // INSERT โดยไม่ใช้ sound_enabled และ vibration_enabled
        await pool.execute(
            `INSERT INTO MedicationReminders 
             (reminder_id, patient_id, prescription_id, medication_id,
              reminder_time, days_of_week, start_date, end_date,
              eye, drops_count, notification_channels, notes, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [
                reminderId, userId, prescription_id, medication_id,
                reminder_time, days_of_week, finalStartDate, end_date || null,
                eye, drops_count, notification_channels, notes || null
            ]
        );

        console.log(`✅ Created reminder ${reminderId} for ${reminder_time}`);

        res.json({
            message: `ตั้งการแจ้งเตือนยา "${prescriptionCheck[0].name}" สำเร็จ`,
            success: true,
            reminder_id: reminderId
        });

    } catch (error) {
        console.error('❌ Create reminder error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการสร้างการแจ้งเตือน',
            code: 'CREATE_REMINDER_ERROR'
        });
    }
});

// ===========================================
// IOP MANAGEMENT (การบันทึกค่า IOP และการแสดงกราฟวิเคราะห์)
// ===========================================

// Record IOP measurement
app.post('/api/patient/iop-measurement', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            left_eye_iop, right_eye_iop, measurement_device, measurement_method,
            measured_at_hospital, notes
        } = req.body;

        const measurementId = generateId();
        const now = new Date();

        await pool.execute(
            `INSERT INTO IOP_Measurements 
             (measurement_id, patient_id, recorded_by, measurement_date, measurement_time,
              left_eye_iop, right_eye_iop, measurement_device, measurement_method,
              measured_at_hospital, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [measurementId, userId, userId, now.toISOString().split('T')[0], 
             now.toTimeString().split(' ')[0], left_eye_iop, right_eye_iop,
             measurement_device, measurement_method, measured_at_hospital, notes]
        );

        // Update monthly summary
        const month = now.getMonth() + 1;
        const year = now.getFullYear();
        
        const summaryId = generateId();
        await pool.execute(
            `INSERT INTO IOP_Monthly_Summary 
             (summary_id, patient_id, month, year, avg_left_eye_iop, 
              avg_right_eye_iop, max_left_eye_iop, max_right_eye_iop, 
              min_left_eye_iop, min_right_eye_iop, measurement_count) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
             avg_left_eye_iop = (avg_left_eye_iop * measurement_count + VALUES(avg_left_eye_iop)) / (measurement_count + 1),
             avg_right_eye_iop = (avg_right_eye_iop * measurement_count + VALUES(avg_right_eye_iop)) / (measurement_count + 1),
             max_left_eye_iop = GREATEST(max_left_eye_iop, VALUES(max_left_eye_iop)),
             max_right_eye_iop = GREATEST(max_right_eye_iop, VALUES(max_right_eye_iop)),
             min_left_eye_iop = LEAST(min_left_eye_iop, VALUES(min_left_eye_iop)),
             min_right_eye_iop = LEAST(min_right_eye_iop, VALUES(min_right_eye_iop)),
             measurement_count = measurement_count + 1`,
            [summaryId, userId, month, year, left_eye_iop, right_eye_iop, 
             left_eye_iop, right_eye_iop, left_eye_iop, right_eye_iop]
        );

        res.json({
            message: 'บันทึกค่าความดันลูกตาสำเร็จ',
            success: true,
            measurement_id: measurementId
        });

    } catch (error) {
        console.error('Record IOP error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการบันทึกค่าความดันลูกตา',
            code: 'RECORD_ERROR'
        });
    }
});

// Get IOP measurements
app.get('/api/patient/iop-measurements', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { period = '30' } = req.query;

        // 🔧 เพิ่ม debug และลองหา User ID ที่ถูกต้อง
        console.log('🔍 JWT User ID:', userId);
        
        // ลองหา patient_id จาก Users table ก่อน
        const [userCheck] = await pool.execute(
            'SELECT user_id FROM Users WHERE user_id = ? OR id_card = ?',
            [userId, userId]
        );
        
        if (userCheck.length === 0) {
            console.log('❌ User not found in Users table');
            return res.status(404).json({ message: 'User not found' });
        }

        console.log('✅ User found:', userCheck[0]);

        // ลองดึงข้อมูล IOP โดยใช้ User ID ที่ถูกต้อง
        let [measurements] = await pool.execute(
            `SELECT * FROM IOP_Measurements
             WHERE patient_id = ? 
             AND measurement_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
             ORDER BY measurement_date DESC, measurement_time DESC`,
            [userId, parseInt(period)]
        );

        // ถ้าไม่เจอ ลองใช้ id_card แทน
        if (measurements.length === 0) {
            console.log('🔍 No data with userId, trying with id_card...');
            const [userWithIdCard] = await pool.execute(
                'SELECT id_card FROM Users WHERE user_id = ?',
                [userId]
            );
            
            if (userWithIdCard.length > 0) {
                const idCard = userWithIdCard[0].id_card;
                console.log('🔍 Trying with id_card:', idCard);
                
                [measurements] = await pool.execute(
                    `SELECT * FROM IOP_Measurements
                     WHERE patient_id = ? 
                     AND measurement_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
                     ORDER BY measurement_date DESC, measurement_time DESC`,
                    [idCard, parseInt(period)]
                );
            }
        }

        // ถ้ายังไม่เจอ ลองดูว่ามี patient_id อะไรบ้างในตาราง
        if (measurements.length === 0) {
            console.log('🔍 Still no data, checking all patient_ids...');
            const [allPatients] = await pool.execute(
                'SELECT DISTINCT patient_id FROM IOP_Measurements LIMIT 5'
            );
            console.log('🔍 Available patient_ids:', allPatients.map(p => p.patient_id));
            
            // ลองใช้ patient_id แรกที่เจอ (สำหรับ debug)
            if (allPatients.length > 0) {
                console.log('🔍 Using first available patient_id for testing...');
                [measurements] = await pool.execute(
                    `SELECT * FROM IOP_Measurements
                     WHERE patient_id = ? 
                     AND measurement_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
                     ORDER BY measurement_date DESC, measurement_time DESC`,
                    [allPatients[0].patient_id, parseInt(period)]
                );
            }
        }

        console.log('🔍 Final measurements count:', measurements.length);
        if (measurements.length > 0) {
            console.log('🔍 Sample measurement:', measurements[0]);
        }

        res.json({ measurements });

    } catch (error) {
        console.error('Get IOP measurements error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get IOP analytics (การแสดงกราฟวิเคราะห์)
app.get('/api/patient/iop-analytics', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { period = '90' } = req.query;

        console.log('IOP Analytics requested for user:', userId, 'period:', period);

        let dailyData = [];
        let monthlyData = [];
        let trends = {};

        try {
            // ดึงข้อมูลจริงจาก Database เท่านั้น
            const [realDailyData] = await pool.execute(
                `SELECT 
                    measurement_date,
                    AVG(left_eye_iop) as avg_left_iop,
                    AVG(right_eye_iop) as avg_right_iop,
                    MAX(left_eye_iop) as max_left_iop,
                    MAX(right_eye_iop) as max_right_iop,
                    MIN(left_eye_iop) as min_left_iop,
                    MIN(right_eye_iop) as min_right_iop,
                    COUNT(*) as measurement_count
                 FROM IOP_Measurements
                 WHERE patient_id = ? 
                 AND measurement_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
                 GROUP BY measurement_date
                 ORDER BY measurement_date`,
                [userId, parseInt(period)]
            );

            dailyData = realDailyData || [];
            console.log('Real IOP data found:', dailyData.length, 'records');

        } catch (dbError) {
            console.log('Database error:', dbError.message);
            dailyData = []; // ไม่สร้างข้อมูลปลอม
        }

        // สร้าง trends จากข้อมูลจริงเท่านั้น
        if (dailyData.length > 0) {
            const leftIOPs = dailyData.map(d => d.avg_left_iop).filter(v => v !== null && !isNaN(v));
            const rightIOPs = dailyData.map(d => d.avg_right_iop).filter(v => v !== null && !isNaN(v));
            
            trends = {
                avg_left_iop: leftIOPs.length > 0 ? leftIOPs.reduce((a, b) => a + b, 0) / leftIOPs.length : null,
                avg_right_iop: rightIOPs.length > 0 ? rightIOPs.reduce((a, b) => a + b, 0) / rightIOPs.length : null,
                std_left_iop: null, // ไม่จำลอง
                std_right_iop: null  // ไม่จำลอง
            };
        }

        res.json({
            daily_data: dailyData,
            monthly_data: monthlyData,
            trends: trends,
            target_iop: 18,
            period_days: parseInt(period),
            data_source: 'database' // เป็น database เสมอ
        });

    } catch (error) {
        console.error('Get IOP analytics error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            daily_data: [],
            monthly_data: [],
            trends: {}
        });
    }
});


// ===========================================
// APPOINTMENTS MANAGEMENT (การแจ้งเตือนวันนัดพบแพทย์)
// ===========================================

// Get patient appointments
app.get('/api/patient/appointments', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { status = 'all', upcoming = false } = req.query;

        let whereClause = 'WHERE a.patient_id = ?';
        let params = [userId];

        if (status !== 'all') {
            whereClause += ' AND a.appointment_status = ?';
            params.push(status);
        }

        if (upcoming === 'true') {
            whereClause += ' AND a.appointment_date >= CURDATE()';
        }

        const [appointments] = await pool.execute(
            `SELECT a.*, d.first_name as doctor_first_name, d.last_name as doctor_last_name,
                    d.specialty, d.department,
                    DATEDIFF(a.appointment_date, CURDATE()) as days_until_appointment,
                    CASE 
                        WHEN a.appointment_date = CURDATE() THEN 'today'
                        WHEN a.appointment_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY) THEN 'tomorrow'
                        WHEN DATEDIFF(a.appointment_date, CURDATE()) <= 7 THEN 'this_week'
                        ELSE 'later'
                    END as appointment_timing
             FROM Appointments a
             LEFT JOIN DoctorProfiles d ON a.doctor_id = d.doctor_id
             ${whereClause}
             ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
            params
        );

        res.json({ 
            appointments: appointments || [],
            message: appointments.length === 0 ? 'ยังไม่มีการนัดหมาย กรุณาติดต่อเจ้าหน้าที่เพื่อนัดหมาย' : null
        });

    } catch (error) {
        console.error('Get appointments error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            appointments: []
        });
    }
});

// Get appointment reminders
app.get('/api/patient/appointment-reminders', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [reminders] = await pool.execute(
            `SELECT ar.*, a.appointment_date, a.appointment_time, a.appointment_type,
                    a.appointment_location, d.first_name as doctor_first_name, 
                    d.last_name as doctor_last_name, d.specialty,
                    DATEDIFF(a.appointment_date, CURDATE()) as days_until_appointment
             FROM AppointmentReminders ar
             JOIN Appointments a ON ar.appointment_id = a.appointment_id
             LEFT JOIN DoctorProfiles d ON a.doctor_id = d.doctor_id
             WHERE ar.patient_id = ? AND ar.reminder_status = 'pending'
             AND a.appointment_date >= CURDATE()
             ORDER BY a.appointment_date, a.appointment_time`,
            [userId]
        );

        res.json({ reminders });

    } catch (error) {
        console.error('Get appointment reminders error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ===========================================
// MEDICAL HISTORY (การจัดเก็บข้อมูลส่วนตัว, ประวัติครอบครัว, ประวัติอุบัติเหตุทางตา)
// ===========================================

// Add family glaucoma history (ประวัติครอบครัวเกี่ยวกับโรคต้อหิน)
app.post('/api/patient/family-history', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            relationship, glaucoma_type, age_at_diagnosis, severity,
            treatment, current_status, notes
        } = req.body;

        const historyId = generateId();

        await pool.execute(
            `INSERT INTO FamilyGlaucomaHistory 
             (family_history_id, patient_id, relationship, glaucoma_type,
              age_at_diagnosis, severity, treatment, current_status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [historyId, userId, relationship, glaucoma_type, age_at_diagnosis,
             severity, treatment, current_status, notes]
        );

        res.json({
            message: 'เพิ่มประวัติครอบครัวสำเร็จ',
            success: true,
            history_id: historyId
        });

    } catch (error) {
        console.error('Add family history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการเพิ่มประวัติครอบครัว',
            code: 'RECORD_ERROR'
        });
    }
});

// Get family glaucoma history
app.get('/api/patient/family-history', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [history] = await pool.execute(
            `SELECT *,
                    CASE 
                        WHEN relationship = 'father' THEN 'พ่อ'
                        WHEN relationship = 'mother' THEN 'แม่'
                        WHEN relationship = 'brother' THEN 'พี่ชาย/น้องชาย'
                        WHEN relationship = 'sister' THEN 'พี่สาว/น้องสาว'
                        WHEN relationship = 'grandfather' THEN 'ปู่/ตา'
                        WHEN relationship = 'grandmother' THEN 'ย่า/ยาย'
                        ELSE relationship
                    END as relationship_display
             FROM FamilyGlaucomaHistory
             WHERE patient_id = ?
             ORDER BY recorded_at DESC`,
            [userId]
        );

        res.json({ family_history: history });

    } catch (error) {
        console.error('Get family history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Add eye injury history (ประวัติอุบัติเหตุทางตา)
app.post('/api/patient/eye-injury', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            injury_date, eye, injury_type, treatment_received,
            long_term_effects, notes
        } = req.body;

        const injuryId = generateId();

        await pool.execute(
            `INSERT INTO EyeInjuryHistory 
             (injury_id, patient_id, injury_date, eye, injury_type,
              treatment_received, long_term_effects, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [injuryId, userId, injury_date, eye, injury_type,
             treatment_received, long_term_effects, notes]
        );

        res.json({
            message: 'เพิ่มประวัติอุบัติเหตุทางตาสำเร็จ',
            success: true,
            injury_id: injuryId
        });

    } catch (error) {
        console.error('Add injury history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการเพิ่มประวัติอุบัติเหตุ',
            code: 'RECORD_ERROR'
        });
    }
});

// Get eye injury history
app.get('/api/patient/eye-injury', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [injuries] = await pool.execute(
            `SELECT *,
                    CASE 
                        WHEN eye = 'left' THEN 'ตาซ้าย'
                        WHEN eye = 'right' THEN 'ตาขวา'
                        WHEN eye = 'both' THEN 'ทั้งสองตา'
                        ELSE eye
                    END as eye_display
             FROM EyeInjuryHistory
             WHERE patient_id = ?
             ORDER BY injury_date DESC`,
            [userId]
        );

        res.json({ eye_injuries: injuries });

    } catch (error) {
        console.error('Get injury history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get medical history
app.get('/api/patient/medical-history', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [history] = await pool.execute(
            `SELECT *,
                    CASE 
                        WHEN condition_type = 'chronic' THEN 'โรคเรื้อรัง'
                        WHEN condition_type = 'allergy' THEN 'แพ้ยา/อาหาร'
                        WHEN condition_type = 'surgery' THEN 'ประวัติผ่าตัด'
                        WHEN condition_type = 'injury' THEN 'ประวัติการบาดเจ็บ'
                        ELSE 'อื่นๆ'
                    END as condition_type_display
             FROM PatientMedicalHistory
             WHERE patient_id = ?
             ORDER BY recorded_at DESC`,
            [userId]
        );

        res.json({ medical_history: history });

    } catch (error) {
        console.error('Get medical history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ===========================================
// VISUAL FIELD TESTS & SPECIAL TESTS (บันทึกและเปรียบเทียบผลการตรวจลานสายตา, ดูผลการตรวจจากเครื่องมือพิเศษ)
// ===========================================

// Get visual field test results
app.get('/api/patient/visual-field-tests', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [tests] = await pool.execute(
            `SELECT vf.*, d.first_name as doctor_first_name, d.last_name as doctor_last_name,
                    d.specialty,
                    CASE 
                        WHEN vf.left_eye_reliability = 'high' THEN 'สูง'
                        WHEN vf.left_eye_reliability = 'medium' THEN 'ปานกลาง'
                        WHEN vf.left_eye_reliability = 'low' THEN 'ต่ำ'
                        ELSE vf.left_eye_reliability
                    END as left_eye_reliability_display,
                    CASE 
                        WHEN vf.right_eye_reliability = 'high' THEN 'สูง'
                        WHEN vf.right_eye_reliability = 'medium' THEN 'ปานกลาง'
                        WHEN vf.right_eye_reliability = 'low' THEN 'ต่ำ'
                        ELSE vf.right_eye_reliability
                    END as right_eye_reliability_display
             FROM VisualFieldTests vf
             LEFT JOIN DoctorProfiles d ON vf.doctor_id = d.doctor_id
             WHERE vf.patient_id = ?
             ORDER BY vf.test_date DESC`,
            [userId]
        );

        res.json({ visual_field_tests: tests });

    } catch (error) {
        console.error('Get visual field tests error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Compare visual field test results (เปรียบเทียบผลการตรวจลานสายตาในแต่ละครั้ง)
app.get('/api/patient/visual-field-comparison', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { test_ids } = req.query; // comma-separated test IDs

        if (!test_ids) {
            return res.status(400).json({
                message: 'กรุณาระบุ ID ของการตรวจที่ต้องการเปรียบเทียบ',
                code: 'MISSING_TEST_IDS'
            });
        }

        const testIdArray = test_ids.split(',');

        const [tests] = await pool.execute(
            `SELECT * FROM VisualFieldTests
             WHERE patient_id = ? AND test_id IN (${testIdArray.map(() => '?').join(',')})
             ORDER BY test_date ASC`,
            [userId, ...testIdArray]
        );

        // Calculate progression
        const comparison = [];
        for (let i = 1; i < tests.length; i++) {
            const current = tests[i];
            const previous = tests[i - 1];
            
            comparison.push({
                current_test: current,
                previous_test: previous,
                left_eye_md_change: current.left_eye_md - previous.left_eye_md,
                right_eye_md_change: current.right_eye_md - previous.right_eye_md,
                left_eye_vfi_change: current.left_eye_vfi - previous.left_eye_vfi,
                right_eye_vfi_change: current.right_eye_vfi - previous.right_eye_vfi,
                time_difference_days: Math.ceil((new Date(current.test_date) - new Date(previous.test_date)) / (1000 * 60 * 60 * 24))
            });
        }

        res.json({ 
            tests,
            comparison,
            progression_analysis: comparison.length > 0 ? {
                overall_trend_left: comparison.reduce((sum, c) => sum + c.left_eye_md_change, 0) / comparison.length,
                overall_trend_right: comparison.reduce((sum, c) => sum + c.right_eye_md_change, 0) / comparison.length,
                progression_rate_left: comparison.length > 1 ? 
                    (comparison[comparison.length - 1].left_eye_md_change - comparison[0].left_eye_md_change) / comparison.length : 0,
                progression_rate_right: comparison.length > 1 ? 
                    (comparison[comparison.length - 1].right_eye_md_change - comparison[0].right_eye_md_change) / comparison.length : 0
            } : null
        });

    } catch (error) {
        console.error('Compare visual field tests error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get special eye tests (OCT, CTVF, etc.)
app.get('/api/patient/special-tests', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { test_type } = req.query;

        let whereClause = 'WHERE st.patient_id = ?';
        let params = [userId];

        if (test_type) {
            whereClause += ' AND st.test_type = ?';
            params.push(test_type);
        }

        const [tests] = await pool.execute(
            `SELECT st.*, d.first_name as doctor_first_name, d.last_name as doctor_last_name,
                    d.specialty,
                    CASE 
                        WHEN st.test_type = 'OCT' THEN 'การตรวจ OCT (ภาพตัดขวาง)'
                        WHEN st.test_type = 'CTVF' THEN 'การตรวจลานสายตา'
                        WHEN st.test_type = 'Pachymetry' THEN 'การวัดความหนาเสื้อตา'
                        WHEN st.test_type = 'Gonioscopy' THEN 'การตรวจมุมรอยต่อ'
                        ELSE st.test_type
                    END as test_type_display,
                    CASE 
                        WHEN st.eye = 'left' THEN 'ตาซ้าย'
                        WHEN st.eye = 'right' THEN 'ตาขวา'
                        WHEN st.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE st.eye
                    END as eye_display
             FROM SpecialEyeTests st
             LEFT JOIN DoctorProfiles d ON st.doctor_id = d.doctor_id
             ${whereClause}
             ORDER BY st.test_date DESC`,
            params
        );

        res.json({ special_tests: tests });

    } catch (error) {
        console.error('Get special tests error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get OCT results (ดูผลการตรวจจากเครื่องมือพิเศษ เช่น OCT)
app.get('/api/patient/oct-results', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [results] = await pool.execute(
            `SELECT oct.*, st.test_date, st.notes, st.eye,
                    d.first_name as doctor_first_name, d.last_name as doctor_last_name
             FROM OCT_Results oct
             JOIN SpecialEyeTests st ON oct.test_id = st.test_id
             LEFT JOIN DoctorProfiles d ON st.doctor_id = d.doctor_id
             WHERE st.patient_id = ?
             ORDER BY st.test_date DESC`,
            [userId]
        );

        res.json({ oct_results: results });

    } catch (error) {
        console.error('Get OCT results error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// ===========================================
// MEDICAL DOCUMENTS (ดาวโหลดไฟล์ PDF ผลการตรวจและเอกสารทางการแพทย์)
// ===========================================

// Upload medical document
app.post('/api/patient/documents', authenticateToken, ensurePatient, upload.single('document'), async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            document_type, document_title, description, tags
        } = req.body;

        if (!req.file) {
            return res.status(400).json({
                message: 'กรุณาเลือกไฟล์',
                code: 'NO_FILE'
            });
        }

        const documentId = generateId();
        const fileUrl = `/uploads/medical-docs/${req.file.filename}`;

        await pool.execute(
            `INSERT INTO MedicalDocuments 
             (document_id, patient_id, document_type, document_title,
              file_url, file_size, file_format, uploaded_by, description, tags)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [documentId, userId, document_type, document_title,
             fileUrl, req.file.size, path.extname(req.file.originalname).substring(1),
             userId, description, tags]
        );

        res.json({
            message: 'อัปโหลดเอกสารสำเร็จ',
            success: true,
            document_id: documentId,
            file_url: fileUrl
        });

    } catch (error) {
        console.error('Upload document error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปโหลดเอกสาร',
            code: 'UPLOAD_ERROR'
        });
    }
});

// Get medical documents
app.get('/api/patient/documents', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { document_type, search } = req.query;

        let whereClause = 'WHERE patient_id = ? AND is_archived = 0';
        let params = [userId];

        if (document_type) {
            whereClause += ' AND document_type = ?';
            params.push(document_type);
        }

        if (search) {
            whereClause += ' AND (document_title LIKE ? OR description LIKE ? OR tags LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        const [documents] = await pool.execute(
            `SELECT *,
                    CASE 
                        WHEN file_format = 'pdf' THEN 'เอกสาร PDF'
                        WHEN file_format IN ('jpg', 'jpeg', 'png') THEN 'รูปภาพ'
                        WHEN file_format IN ('doc', 'docx') THEN 'เอกสาร Word'
                        ELSE UPPER(file_format)
                    END as file_type_display,
                    ROUND(file_size / 1024 / 1024, 2) as file_size_mb
             FROM MedicalDocuments
             ${whereClause}
             ORDER BY upload_date DESC`,
            params
        );

        res.json({ documents });

    } catch (error) {
        console.error('Get documents error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Download medical document (ดาวโหลดไฟล์ PDF ผลการตรวจและเอกสารทางการแพทย์)
app.get('/api/patient/documents/:document_id/download', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { document_id } = req.params;

        const [documents] = await pool.execute(
            `SELECT * FROM MedicalDocuments
             WHERE document_id = ? AND patient_id = ?`,
            [document_id, userId]
        );

        if (documents.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบเอกสาร',
                code: 'DOCUMENT_NOT_FOUND'
            });
        }

        const document = documents[0];
        const filePath = path.join(__dirname, document.file_url);

        // Log document access
        const accessId = generateId();
        await pool.execute(
            `INSERT INTO DocumentAccess 
             (access_id, document_id, user_id, access_type, access_result, ip_address)
             VALUES (?, ?, ?, 'download', 'success', ?)`,
            [accessId, document_id, userId, req.ip]
        );

        res.download(filePath, document.document_title);

    } catch (error) {
        console.error('Download document error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการดาวน์โหลด',
            code: 'DOWNLOAD_ERROR'
        });
    }
});

// ===========================================
// NOTIFICATIONS (แจ้งเตือน)
// ===========================================

// แทนที่ GET /api/patient/notifications เดิม
app.get('/api/patient/notifications', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const unread_only = req.query.unread_only === 'true';
        
        // แก้ไข limit ให้ handle undefined
        let limit = 50; // ค่าเริ่มต้น
        if (req.query.limit) {
            const parsedLimit = parseInt(req.query.limit, 10);
            if (!isNaN(parsedLimit) && parsedLimit > 0 && parsedLimit <= 1000) {
                limit = parsedLimit;
            }
        }

        let whereClause = 'WHERE user_id = ?';
        let params = [userId];

        if (unread_only) {
            whereClause += ' AND is_read = 0';
        }

        // สร้าง SQL query โดยไม่ใช้ template literal
        const sql = `SELECT 
            notification_id,
            user_id,
            notification_type,
            title,
            body,
            priority,
            is_read,
            created_at,
            CASE
                WHEN notification_type = 'medication_reminder' THEN 'แจ้งเตือนยา'
                WHEN notification_type = 'appointment_reminder' THEN 'แจ้งเตือนนัดหมาย'
                WHEN notification_type = 'health_alert' THEN 'แจ้งเตือนสุขภาพ'
                WHEN notification_type = 'medication_inventory' THEN 'แจ้งเตือนยาใกล้หมด'
                WHEN notification_type = 'emergency_alert' THEN 'แจ้งเตือนฉุกเฉิน'
                WHEN notification_type = 'system_announcement' THEN 'ประกาศระบบ'
                ELSE notification_type
            END as notification_type_display,
            CASE
                WHEN priority = 'low' THEN 'ต่ำ'
                WHEN priority = 'medium' THEN 'ปานกลาง'
                WHEN priority = 'high' THEN 'สูง'
                WHEN priority = 'urgent' THEN 'ด่วน'
                ELSE priority
            END as priority_display
         FROM Notifications ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`;

        const [notifications] = await pool.execute(sql, params);

        res.json({ notifications: notifications || [] });

    } catch (error) {
        console.error('Get notifications error:', error);
        
        // ถ้า table ไม่มี ให้ return empty array
        if (error.code === 'ER_NO_SUCH_TABLE') {
            return res.json({ notifications: [] });
        }
        
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            error: error.message
        });
    }
});

// Mark notification as read
app.put('/api/patient/notifications/:notification_id/read', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { notification_id } = req.params;

        await pool.execute(
            `UPDATE Notifications 
             SET is_read = 1, read_at = NOW() 
             WHERE notification_id = ? AND user_id = ?`,
            [notification_id, userId]
        );

        res.json({
            message: 'อัปเดตสถานะการอ่านสำเร็จ',
            success: true
        });

    } catch (error) {
        console.error('Mark notification read error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Mark all notifications as read
app.put('/api/patient/notifications/mark-all-read', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        await pool.execute(
            `UPDATE Notifications 
             SET is_read = 1, read_at = NOW() 
             WHERE user_id = ? AND is_read = 0`,
            [userId]
        );

        res.json({
            message: 'อัปเดตสถานะการอ่านทั้งหมดสำเร็จ',
            success: true
        });

    } catch (error) {
        console.error('Mark all notifications read error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});
// index.js Part 4 - Dashboard, Summary & Automated Functions (Final)

// ===========================================
// DASHBOARD & SUMMARY 
// ===========================================

// Get patient dashboard data
// แทนที่ GET /api/patient/dashboard เดิม
app.get('/api/patient/dashboard', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Get upcoming appointments
        const [appointments] = await pool.execute(
            `SELECT a.*, d.first_name as doctor_first_name, d.last_name as doctor_last_name,
                    d.specialty, DATEDIFF(a.appointment_date, CURDATE()) as days_until
             FROM Appointments a
             LEFT JOIN DoctorProfiles d ON a.doctor_id = d.doctor_id
             WHERE a.patient_id = ? AND a.appointment_date >= CURDATE() 
             AND a.appointment_status = 'scheduled'
             ORDER BY a.appointment_date, a.appointment_time
             LIMIT 3`,
            [userId]
        );

        // Get recent IOP measurements - แก้ไขให้ handle null values
        const [recentIOP] = await pool.execute(
            `SELECT *, 
                    COALESCE(left_eye_iop, 0) as left_eye_iop,
                    COALESCE(right_eye_iop, 0) as right_eye_iop
             FROM IOP_Measurements
             WHERE patient_id = ?
             ORDER BY measurement_date DESC, measurement_time DESC
             LIMIT 5`,
            [userId]
        );

        // Get medications - แก้ไขให้ handle medications ที่ไม่มี
        const [medications] = await pool.execute(
            `SELECT pm.*, m.name, m.generic_name, m.form, m.strength,
                    m.description, m.image_url, m.side_effects,
                    CASE 
                        WHEN pm.eye = 'left' THEN 'ตาซ้าย'
                        WHEN pm.eye = 'right' THEN 'ตาขวา'
                        WHEN pm.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE pm.eye
                    END as eye_display
             FROM PatientMedications pm
             LEFT JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.patient_id = ? AND pm.status = 'active'
             ORDER BY pm.created_at DESC`,
            [userId]
        );

        // Get medication reminders for today - เพิ่ม error handling
        let todayMedications = [];
        try {
            const [todayMeds] = await pool.execute(
                `SELECT mr.*, m.name, m.image_url,
                        (SELECT COUNT(*) FROM MedicationUsageRecords mur 
                         WHERE mur.reminder_id = mr.reminder_id 
                         AND DATE(mur.scheduled_time) = CURDATE()
                         AND mur.status = 'taken') as taken_today,
                        CASE 
                            WHEN mr.eye = 'left' THEN 'ตาซ้าย'
                            WHEN mr.eye = 'right' THEN 'ตาขวา'
                            WHEN mr.eye = 'both' THEN 'ทั้งสองตา'
                            ELSE mr.eye
                        END as eye_display
                 FROM MedicationReminders mr
                 LEFT JOIN PatientMedications pm ON mr.prescription_id = pm.prescription_id
                 LEFT JOIN Medications m ON mr.medication_id = m.medication_id
                 WHERE mr.patient_id = ? AND mr.is_active = 1`,
                [userId]
            );
            todayMedications = todayMeds || [];
        } catch (medError) {
            console.error('Error getting today medications:', medError);
            todayMedications = [];
        }

        // Get unread notifications count - แก้ไขให้ handle table ที่ไม่มี
        let unreadCount = 0;
        try {
            const [unreadResult] = await pool.execute(
                `SELECT COUNT(*) as unread_count FROM Notifications
                 WHERE user_id = ? AND is_read = 0`,
                [userId]
            );
            unreadCount = unreadResult[0]?.unread_count || 0;
        } catch (notifError) {
            console.error('Error getting notifications count:', notifError);
            unreadCount = 0;
        }

        // Get low medication inventory - แก้ไขให้ handle table ที่ไม่มี
        let lowInventory = [];
        try {
            const [lowInv] = await pool.execute(
                `SELECT mi.*, m.name, m.image_url,
                        DATEDIFF(mi.expected_end_date, CURDATE()) as days_remaining
                 FROM MedicationInventory mi
                 LEFT JOIN Medications m ON mi.medication_id = m.medication_id
                 WHERE mi.patient_id = ? AND mi.is_depleted = 0
                 AND mi.expected_end_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)`,
                [userId]
            );
            lowInventory = lowInv || [];
        } catch (invError) {
            console.error('Error getting low inventory:', invError);
            lowInventory = [];
        }

        // Get recent alerts - แก้ไขให้ handle table ที่ไม่มี
        let alerts = [];
        try {
            const [alertsResult] = await pool.execute(
                `SELECT *,
                        CASE 
                            WHEN alert_type = 'high_iop' THEN 'ความดันลูกตาสูง'
                            WHEN alert_type = 'missed_medication' THEN 'ยังไม่ได้หยอดยา'
                            WHEN alert_type = 'appointment_missed' THEN 'พลาดนัดหมาย'
                            WHEN alert_type = 'treatment_concern' THEN 'ข้อกังวลการรักษา'
                            ELSE 'อื่นๆ'
                        END as alert_type_display,
                        CASE 
                            WHEN severity = 'low' THEN 'ต่ำ'
                            WHEN severity = 'medium' THEN 'ปานกลาง'
                            WHEN severity = 'high' THEN 'สูง'
                            WHEN severity = 'critical' THEN 'วิกฤต'
                            ELSE severity
                        END as severity_display
                 FROM Alerts
                 WHERE patient_id = ? AND resolution_status = 'pending'
                 ORDER BY created_at DESC
                 LIMIT 5`,
                [userId]
            );
            alerts = alertsResult || [];
        } catch (alertError) {
            console.error('Error getting alerts:', alertError);
            alerts = [];
        }

        res.json({
            upcoming_appointments: appointments || [],
            recent_iop: recentIOP || [],
            medications: medications || [], // เปลี่ยนจาก today_medications
            today_medications: todayMedications || [],
            unread_notifications: unreadCount,
            low_inventory: lowInventory || [],
            recent_alerts: alerts || []
        });

    } catch (error) {
        console.error('Get dashboard error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            error: error.message
        });
    }
});

// Get patient summary report (สรุปข้อมูลทั้งหมดในรูปแบบที่เข้าใจง่าย)
app.get('/api/patient/summary', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { period = '30' } = req.query;

        // Patient basic info
        const [patientInfo] = await pool.execute(
            `SELECT p.*, u.created_at as registration_date,
                    YEAR(CURDATE()) - YEAR(p.date_of_birth) as age
             FROM PatientProfiles p
             JOIN Users u ON p.patient_id = u.user_id
             WHERE p.patient_id = ?`,
            [userId]
        );

        // IOP statistics
        const [iopStats] = await pool.execute(
            `SELECT 
                COUNT(*) as total_measurements,
                AVG(left_eye_iop) as avg_left_iop,
                AVG(right_eye_iop) as avg_right_iop,
                MIN(left_eye_iop) as min_left_iop,
                MIN(right_eye_iop) as min_right_iop,
                MAX(left_eye_iop) as max_left_iop,
                MAX(right_eye_iop) as max_right_iop,
                COUNT(CASE WHEN left_eye_iop > 21 OR right_eye_iop > 21 THEN 1 END) as high_iop_count
             FROM IOP_Measurements
             WHERE patient_id = ? 
             AND measurement_date >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [userId, parseInt(period)]
        );

        // Medication adherence
        const [medicationStats] = await pool.execute(
            `SELECT 
                COUNT(*) as total_scheduled,
                SUM(CASE WHEN status = 'taken' THEN 1 ELSE 0 END) as total_taken,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as total_skipped,
                SUM(CASE WHEN status = 'delayed' THEN 1 ELSE 0 END) as total_delayed,
                ROUND((SUM(CASE WHEN status = 'taken' THEN 1 ELSE 0 END) / COUNT(*)) * 100, 2) as adherence_rate
             FROM MedicationUsageRecords
             WHERE patient_id = ? 
             AND scheduled_time >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [userId, parseInt(period)]
        );

        // Appointments summary
        const [appointmentStats] = await pool.execute(
            `SELECT 
                COUNT(*) as total_appointments,
                SUM(CASE WHEN appointment_status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN appointment_status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
                SUM(CASE WHEN appointment_status = 'no_show' THEN 1 ELSE 0 END) as no_shows,
                SUM(CASE WHEN appointment_status = 'scheduled' AND appointment_date >= CURDATE() THEN 1 ELSE 0 END) as upcoming
             FROM Appointments
             WHERE patient_id = ? 
             AND appointment_date >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [userId, parseInt(period)]
        );

        // Recent test results
        const [recentTests] = await pool.execute(
            `SELECT test_type, test_date, COUNT(*) as test_count
             FROM SpecialEyeTests
             WHERE patient_id = ?
             AND test_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY test_type, test_date
             ORDER BY test_date DESC`,
            [userId, parseInt(period)]
        );

        res.json({
            patient_info: patientInfo[0],
            period_days: parseInt(period),
            iop_statistics: iopStats[0],
            medication_adherence: medicationStats[0],
            appointment_statistics: appointmentStats[0],
            recent_tests: recentTests,
            generated_at: new Date().toISOString(),
            summary_highlights: {
                iop_status: iopStats[0]?.high_iop_count > 0 ? 'มีค่าความดันลูกตาสูง' : 'ค่าความดันลูกตาปกติ',
                medication_status: medicationStats[0]?.adherence_rate >= 80 ? 'ใช้ยาสม่ำเสมอ' : 'ควรใช้ยาให้สม่ำเสมอมากขึ้น',
                appointment_status: appointmentStats[0]?.upcoming > 0 ? `มีนัดหมายถัดไป ${appointmentStats[0].upcoming} ครั้ง` : 'ไม่มีนัดหมายที่จะถึง'
            }
        });

    } catch (error) {
        console.error('Get summary error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการสร้างรายงาน',
            code: 'REPORT_ERROR'
        });
    }
});

// ===========================================
// AUTOMATED NOTIFICATIONS & ALERTS
// ===========================================

// Function to create notification
const createNotification = async (userId, type, title, body, priority = 'medium') => {
    try {
        const notificationId = generateId();
        await pool.execute(
            `INSERT INTO Notifications 
             (notification_id, user_id, notification_type, title, body, priority)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [notificationId, userId, type, title, body, priority]
        );
        return notificationId;
    } catch (error) {
        console.error('Create notification error:', error);
    }
};

// Function to create alert
const createAlert = async (patientId, alertType, severity, message, entityType = null, entityId = null) => {
    try {
        const alertId = generateId();
        await pool.execute(
            `INSERT INTO Alerts 
             (alert_id, patient_id, alert_type, severity, alert_message, related_entity_type, related_entity_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [alertId, patientId, alertType, severity, message, entityType, entityId]
        );
        return alertId;
    } catch (error) {
        console.error('Create alert error:', error);
    }
};

// Check for high IOP and create alerts
const checkHighIOP = async () => {
    try {
        const [highIOPMeasurements] = await pool.execute(
            `SELECT i.*, p.first_name, p.last_name FROM IOP_Measurements i
             JOIN PatientProfiles p ON i.patient_id = p.patient_id
             WHERE (i.left_eye_iop > 21 OR i.right_eye_iop > 21)
             AND i.measurement_date = CURDATE()`
        );

        for (const measurement of highIOPMeasurements) {
            const message = `ค่าความดันลูกตาสูงกว่าปกติ: ตาซ้าย ${measurement.left_eye_iop} mmHg, ตาขวา ${measurement.right_eye_iop} mmHg`;
            
            await createAlert(
                measurement.patient_id,
                'high_iop',
                'high',
                message,
                'IOP_Measurements',
                measurement.measurement_id
            );

            await createNotification(
                measurement.patient_id,
                'health_alert',
                'ค่าความดันลูกตาสูง',
                message,
                'high'
            );
        }
        console.log(`✅ Checked high IOP for ${highIOPMeasurements.length} measurements`);
    } catch (error) {
        console.error('Check high IOP error:', error);
    }
};

// Check for missed medications
const checkMissedMedications = async () => {
    try {
        const [missedMedications] = await pool.execute(
            `SELECT mr.*, m.name, p.first_name, p.last_name
             FROM MedicationReminders mr
             JOIN Medications m ON mr.medication_id = m.medication_id
             JOIN PatientProfiles p ON mr.patient_id = p.patient_id
             WHERE mr.is_active = 1
             AND NOT EXISTS (
                 SELECT 1 FROM MedicationUsageRecords mur
                 WHERE mur.reminder_id = mr.reminder_id
                 AND DATE(mur.scheduled_time) = CURDATE()
                 AND mur.status = 'taken'
             )
             AND NOW() > ADDTIME(CURDATE(), mr.reminder_time)`
        );

        for (const missed of missedMedications) {
            const message = `ยังไม่ได้หยอดยา ${missed.name} ตามเวลาที่กำหนด (${missed.reminder_time})`;
            
            await createAlert(
                missed.patient_id,
                'missed_medication',
                'medium',
                message,
                'MedicationReminders',
                missed.reminder_id
            );

            await createNotification(
                missed.patient_id,
                'medication_reminder',
                'ยังไม่ได้หยอดยา',
                message,
                'medium'
            );
        }
        console.log(`✅ Checked missed medications for ${missedMedications.length} reminders`);
    } catch (error) {
        console.error('Check missed medications error:', error);
    }
};

// Check for low medication inventory
const checkLowInventory = async () => {
    try {
        const [lowInventory] = await pool.execute(
            `SELECT mi.*, m.name, p.first_name, p.last_name,
                    DATEDIFF(mi.expected_end_date, CURDATE()) as days_left
             FROM MedicationInventory mi
             JOIN Medications m ON mi.medication_id = m.medication_id
             JOIN PatientProfiles p ON mi.patient_id = p.patient_id
             WHERE mi.is_depleted = 0
             AND mi.expected_end_date <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)`
        );

        for (const inventory of lowInventory) {
            const daysLeft = inventory.days_left;
            const message = `ยา ${inventory.name} เหลืออีก ${daysLeft} วัน กรุณาเตรียมซื้อยาใหม่`;
            
            await createNotification(
                inventory.patient_id,
                'medication_inventory',
                'ยาใกล้หมด',
                message,
                'high'
            );
        }
        console.log(`✅ Checked low inventory for ${lowInventory.length} medications`);
    } catch (error) {
        console.error('Check low inventory error:', error);
    }
};

// Check upcoming appointments
const checkUpcomingAppointments = async () => {
    try {
        const [upcomingAppointments] = await pool.execute(
            `SELECT a.*, p.first_name, p.last_name, d.first_name as doctor_first_name, d.last_name as doctor_last_name
             FROM Appointments a
             JOIN PatientProfiles p ON a.patient_id = p.patient_id
             LEFT JOIN DoctorProfiles d ON a.doctor_id = d.doctor_id
             WHERE a.appointment_status = 'scheduled'
             AND a.appointment_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY)`
        );

        for (const appointment of upcomingAppointments) {
            const message = `คุณมีนัดหมายกับ ${appointment.doctor_first_name} ${appointment.doctor_last_name} พรุ่งนี้ เวลา ${appointment.appointment_time}`;
            
            await createNotification(
                appointment.patient_id,
                'appointment_reminder',
                'แจ้งเตือนนัดหมายพรุ่งนี้',
                message,
                'medium'
            );
        }
        console.log(`✅ Checked upcoming appointments for ${upcomingAppointments.length} appointments`);
    } catch (error) {
        console.error('Check upcoming appointments error:', error);
    }
};

const createAppointmentNotification = async (patientId, appointmentData, notificationType = 'new') => {
    try {
        let title, body, priority;
        
        switch (notificationType) {
            case 'new':
                title = 'นัดหมายใหม่จากแพทย์';
                body = `คุณได้รับการนัดหมาย${appointmentData.appointment_type} วันที่ ${appointmentData.appointment_date} เวลา ${appointmentData.appointment_time}`;
                priority = 'high';
                break;
            case 'updated':
                title = 'การนัดหมายมีการเปลี่ยนแปลง';
                body = `การนัดหมายของคุณได้รับการอัปเดต วันที่ ${appointmentData.appointment_date} เวลา ${appointmentData.appointment_time}`;
                priority = 'medium';
                break;
            case 'cancelled':
                title = 'การนัดหมายถูกยกเลิก';
                body = `การนัดหมายวันที่ ${appointmentData.appointment_date} ได้รับการยกเลิก กรุณาติดต่อเจ้าหน้าที่`;
                priority = 'high';
                break;
            case 'reminder':
                title = 'แจ้งเตือนการนัดหมาย';
                const daysUntil = Math.ceil((new Date(appointmentData.appointment_date) - new Date()) / (1000 * 60 * 60 * 24));
                if (daysUntil === 0) {
                    body = `วันนี้คุณมีนัดหมายกับแพทย์ เวลา ${appointmentData.appointment_time}`;
                } else if (daysUntil === 1) {
                    body = `พรุ่งนี้คุณมีนัดหมายกับแพทย์ เวลา ${appointmentData.appointment_time}`;
                } else {
                    body = `อีก ${daysUntil} วัน คุณมีนัดหมายกับแพทย์ วันที่ ${appointmentData.appointment_date}`;
                }
                priority = daysUntil <= 1 ? 'high' : 'medium';
                break;
            default:
                title = 'การแจ้งเตือนการนัดหมาย';
                body = 'คุณมีการนัดหมายใหม่';
                priority = 'medium';
        }

        const notificationResult = await createEnhancedNotification(
            patientId,
            'appointment_reminder',
            title,
            body,
            priority,
            {
                entityType: 'Appointments',
                entityId: appointmentData.appointment_id,
                actionUrl: '/appointments',
                metadata: {
                    appointment_id: appointmentData.appointment_id,
                    appointment_date: appointmentData.appointment_date,
                    appointment_time: appointmentData.appointment_time,
                    appointment_type: appointmentData.appointment_type,
                    doctor_name: appointmentData.doctor_name,
                    notification_type: notificationType
                }
            }
        );

        console.log(`✅ Created appointment notification for patient ${patientId}: ${title}`);
        return notificationResult;
        
    } catch (error) {
        console.error('❌ Create appointment notification error:', error);
        return null;
    }
};

// Create new appointment (สำหรับหมอหรือเจ้าหน้าที่)
app.post('/api/admin/appointments', authenticateToken, async (req, res) => {
    try {
        const {
            patient_id,
            doctor_id,
            appointment_date,
            appointment_time,
            appointment_type,
            appointment_location,
            notes,
            send_notification = true
        } = req.body;

        // ตรวจสอบข้อมูลพื้นฐาน
        if (!patient_id || !appointment_date || !appointment_time || !appointment_type) {
            return res.status(400).json({
                message: 'ข้อมูลการนัดหมายไม่ครบถ้วน',
                code: 'MISSING_APPOINTMENT_DATA'
            });
        }

        // ตรวจสอบว่าผู้ป่วยมีอยู่จริง
        const [patientCheck] = await pool.execute(
            `SELECT p.patient_id, p.first_name, p.last_name, p.hn, u.phone, u.email
             FROM PatientProfiles p
             JOIN Users u ON p.patient_id = u.user_id
             WHERE p.patient_id = ?`,
            [patient_id]
        );

        if (patientCheck.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบข้อมูลผู้ป่วย',
                code: 'PATIENT_NOT_FOUND'
            });
        }

        // ตรวจสอบข้อมูลหมอ (ถ้ามี)
        let doctorInfo = null;
        if (doctor_id) {
            const [doctorCheck] = await pool.execute(
                `SELECT doctor_id, first_name, last_name, specialty, department
                 FROM DoctorProfiles WHERE doctor_id = ?`,
                [doctor_id]
            );
            
            if (doctorCheck.length > 0) {
                doctorInfo = doctorCheck[0];
            }
        }

        // ตรวจสอบการนัดซ้ำ
        const [duplicateCheck] = await pool.execute(
            `SELECT appointment_id FROM Appointments
             WHERE patient_id = ? AND appointment_date = ? AND appointment_time = ?
             AND appointment_status NOT IN ('cancelled', 'completed')`,
            [patient_id, appointment_date, appointment_time]
        );

        if (duplicateCheck.length > 0) {
            return res.status(409).json({
                message: 'มีการนัดหมายในวันและเวลานี้แล้ว',
                code: 'DUPLICATE_APPOINTMENT'
            });
        }

        const appointmentId = generateId();
        const patient = patientCheck[0];

        // สร้างการนัดหมาย
        await pool.execute(
            `INSERT INTO Appointments 
             (appointment_id, patient_id, doctor_id, appointment_date, appointment_time,
              appointment_type, appointment_location, appointment_status, notes, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
            [appointmentId, patient_id, doctor_id, appointment_date, appointment_time,
             appointment_type, appointment_location, notes, req.user.userId]
        );

        // เตรียมข้อมูลสำหรับการแจ้งเตือน
        const appointmentData = {
            appointment_id: appointmentId,
            appointment_date,
            appointment_time,
            appointment_type,
            appointment_location,
            doctor_name: doctorInfo ? `${doctorInfo.first_name} ${doctorInfo.last_name}` : 'แพทย์'
        };

        // ส่งการแจ้งเตือน
        if (send_notification) {
            await createAppointmentNotification(patient_id, appointmentData, 'new');
        }

        // สร้าง appointment reminder สำหรับ 1 วันก่อนนัด
        const reminderDate = new Date(appointment_date);
        reminderDate.setDate(reminderDate.getDate() - 1);
        
        const reminderId = generateId();
        await pool.execute(
            `INSERT INTO AppointmentReminders
             (reminder_id, patient_id, appointment_id, reminder_date, reminder_time,
              reminder_type, is_sent, created_at)
             VALUES (?, ?, ?, ?, '09:00:00', 'day_before', 0, NOW())`,
            [reminderId, patient_id, appointmentId, reminderDate.toISOString().split('T')[0]]
        );

        // บันทึก audit log
        await logUserAction(
            req.user.userId,
            'APPOINTMENT_CREATED',
            'Appointments',
            appointmentId,
            `Created appointment for patient ${patient.hn} on ${appointment_date}`,
            'success',
            req.ip,
            req.headers['user-agent']
        );

        res.json({
            message: `สร้างการนัดหมายสำหรับ ${patient.first_name} ${patient.last_name} (HN: ${patient.hn}) สำเร็จ`,
            success: true,
            appointment: {
                appointment_id: appointmentId,
                patient_name: `${patient.first_name} ${patient.last_name}`,
                patient_hn: patient.hn,
                appointment_date,
                appointment_time,
                appointment_type,
                doctor_name: appointmentData.doctor_name,
                notification_sent: send_notification
            }
        });

    } catch (error) {
        console.error('❌ Create appointment error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการสร้างการนัดหมาย',
            code: 'CREATE_APPOINTMENT_ERROR'
        });
    }
});

// Update appointment (แก้ไขการนัดหมาย)
app.put('/api/admin/appointments/:appointment_id', authenticateToken, async (req, res) => {
    try {
        const { appointment_id } = req.params;
        const {
            appointment_date,
            appointment_time,
            appointment_type,
            appointment_location,
            appointment_status,
            notes,
            send_notification = true
        } = req.body;

        // ดึงข้อมูลการนัดหมายเดิม
        const [oldAppointment] = await pool.execute(
            `SELECT a.*, p.first_name, p.last_name, p.hn,
                    d.first_name as doctor_first_name, d.last_name as doctor_last_name
             FROM Appointments a
             JOIN PatientProfiles p ON a.patient_id = p.patient_id
             LEFT JOIN DoctorProfiles d ON a.doctor_id = d.doctor_id
             WHERE a.appointment_id = ?`,
            [appointment_id]
        );

        if (oldAppointment.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบการนัดหมายที่ระบุ',
                code: 'APPOINTMENT_NOT_FOUND'
            });
        }

        const appointment = oldAppointment[0];
        
        // อัปเดตการนัดหมาย
        await pool.execute(
            `UPDATE Appointments 
             SET appointment_date = COALESCE(?, appointment_date),
                 appointment_time = COALESCE(?, appointment_time),
                 appointment_type = COALESCE(?, appointment_type),
                 appointment_location = COALESCE(?, appointment_location),
                 appointment_status = COALESCE(?, appointment_status),
                 notes = COALESCE(?, notes),
                 updated_at = NOW(),
                 updated_by = ?
             WHERE appointment_id = ?`,
            [appointment_date, appointment_time, appointment_type, appointment_location,
             appointment_status, notes, req.user.userId, appointment_id]
        );

        // ตรวจสอบว่ามีการเปลี่ยนแปลงสำคัญหรือไม่
        const hasSignificantChange = 
            (appointment_date && appointment_date !== appointment.appointment_date) ||
            (appointment_time && appointment_time !== appointment.appointment_time) ||
            (appointment_status && appointment_status !== appointment.appointment_status);

        // ส่งการแจ้งเตือนถ้ามีการเปลี่ยนแปลง
        if (send_notification && hasSignificantChange) {
            const updatedData = {
                appointment_id,
                appointment_date: appointment_date || appointment.appointment_date,
                appointment_time: appointment_time || appointment.appointment_time,
                appointment_type: appointment_type || appointment.appointment_type,
                appointment_location: appointment_location || appointment.appointment_location,
                doctor_name: appointment.doctor_first_name ? 
                    `${appointment.doctor_first_name} ${appointment.doctor_last_name}` : 'แพทย์'
            };

            const notificationType = appointment_status === 'cancelled' ? 'cancelled' : 'updated';
            await createAppointmentNotification(appointment.patient_id, updatedData, notificationType);
        }

        // บันทึก audit log
        await logUserAction(
            req.user.userId,
            'APPOINTMENT_UPDATED',
            'Appointments',
            appointment_id,
            `Updated appointment for patient ${appointment.hn}`,
            'success',
            req.ip,
            req.headers['user-agent']
        );

        res.json({
            message: `อัปเดตการนัดหมายสำหรับ ${appointment.first_name} ${appointment.last_name} สำเร็จ`,
            success: true,
            notification_sent: send_notification && hasSignificantChange
        });

    } catch (error) {
        console.error('❌ Update appointment error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปเดตการนัดหมาย',
            code: 'UPDATE_APPOINTMENT_ERROR'
        });
    }
});

// Enhanced appointment reminder check with notifications
const checkUpcomingAppointmentsEnhanced = async () => {
    try {
        console.log('📅 Checking upcoming appointments...');
        
        // ตรวจสอบการนัดที่จะถึงใน 1 วัน
        const [tomorrowAppointments] = await pool.execute(
            `SELECT a.*, p.first_name, p.last_name, p.patient_id,
                    d.first_name as doctor_first_name, d.last_name as doctor_last_name,
                    d.specialty
             FROM Appointments a
             JOIN PatientProfiles p ON a.patient_id = p.patient_id
             LEFT JOIN DoctorProfiles d ON a.doctor_id = d.doctor_id
             WHERE a.appointment_status = 'scheduled'
             AND a.appointment_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY)`
        );

        // ตรวจสอบการนัดวันนี้ (เตือนตอนเช้า)
        const [todayAppointments] = await pool.execute(
            `SELECT a.*, p.first_name, p.last_name, p.patient_id,
                    d.first_name as doctor_first_name, d.last_name as doctor_last_name,
                    d.specialty
             FROM Appointments a
             JOIN PatientProfiles p ON a.patient_id = p.patient_id
             LEFT JOIN DoctorProfiles d ON a.doctor_id = d.doctor_id
             WHERE a.appointment_status = 'scheduled'
             AND a.appointment_date = CURDATE()
             AND TIME(NOW()) >= '08:00:00'
             AND TIME(NOW()) <= '10:00:00'`
        );

        // ส่งการแจ้งเตือนสำหรับการนัดพรุ่งนี้
        for (const appointment of tomorrowAppointments) {
            const appointmentData = {
                appointment_id: appointment.appointment_id,
                appointment_date: appointment.appointment_date,
                appointment_time: appointment.appointment_time,
                appointment_type: appointment.appointment_type,
                doctor_name: appointment.doctor_first_name ? 
                    `${appointment.doctor_first_name} ${appointment.doctor_last_name}` : 'แพทย์'
            };

            await createAppointmentNotification(
                appointment.patient_id, 
                appointmentData, 
                'reminder'
            );
        }

        // ส่งการแจ้งเตือนสำหรับการนัดวันนี้
        for (const appointment of todayAppointments) {
            const appointmentData = {
                appointment_id: appointment.appointment_id,
                appointment_date: appointment.appointment_date,
                appointment_time: appointment.appointment_time,
                appointment_type: appointment.appointment_type,
                doctor_name: appointment.doctor_first_name ? 
                    `${appointment.doctor_first_name} ${appointment.doctor_last_name}` : 'แพทย์'
            };

            await createAppointmentNotification(
                appointment.patient_id, 
                appointmentData, 
                'reminder'
            );
        }

        console.log(`✅ Processed ${tomorrowAppointments.length} tomorrow appointments and ${todayAppointments.length} today appointments`);
        
    } catch (error) {
        console.error('❌ Check upcoming appointments enhanced error:', error);
    }
};

// Get appointment notifications for patient
app.get('/api/patient/appointment-notifications', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { limit = '10' } = req.query;

        const [notifications] = await pool.execute(
            `SELECT n.*, 
                    CASE
                        WHEN n.notification_type = 'appointment_reminder' THEN 'การแจ้งเตือนนัดหมาย'
                        ELSE n.notification_type
                    END as notification_type_display
             FROM Notifications n
             WHERE n.user_id = ? 
             AND n.notification_type = 'appointment_reminder'
             ORDER BY n.created_at DESC
             LIMIT ?`,
            [userId, parseInt(limit)]
        );

        res.json({ 
            appointment_notifications: notifications,
            total: notifications.length
        });

    } catch (error) {
        console.error('Get appointment notifications error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Bulk create appointments (สำหรับการนัดหลายคนพร้อมกัน)
app.post('/api/admin/appointments/bulk', authenticateToken, async (req, res) => {
    try {
        const { appointments } = req.body; // array of appointment objects
        
        if (!appointments || !Array.isArray(appointments) || appointments.length === 0) {
            return res.status(400).json({
                message: 'ข้อมูลการนัดหมายไม่ถูกต้อง',
                code: 'INVALID_APPOINTMENTS_DATA'
            });
        }

        const results = {
            success: [],
            failed: [],
            total: appointments.length
        };

        for (const appointmentData of appointments) {
            try {
                const {
                    patient_id, doctor_id, appointment_date, appointment_time,
                    appointment_type, appointment_location, notes
                } = appointmentData;

                // ตรวจสอบข้อมูลพื้นฐาน
                if (!patient_id || !appointment_date || !appointment_time || !appointment_type) {
                    results.failed.push({
                        patient_id,
                        error: 'ข้อมูลไม่ครบถ้วน'
                    });
                    continue;
                }

                // ตรวจสอบผู้ป่วย
                const [patientCheck] = await pool.execute(
                    `SELECT patient_id, first_name, last_name, hn FROM PatientProfiles WHERE patient_id = ?`,
                    [patient_id]
                );

                if (patientCheck.length === 0) {
                    results.failed.push({
                        patient_id,
                        error: 'ไม่พบข้อมูลผู้ป่วย'
                    });
                    continue;
                }

                const appointmentId = generateId();
                
                // สร้างการนัดหมาย
                await pool.execute(
                    `INSERT INTO Appointments 
                     (appointment_id, patient_id, doctor_id, appointment_date, appointment_time,
                      appointment_type, appointment_location, appointment_status, notes, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
                    [appointmentId, patient_id, doctor_id, appointment_date, appointment_time,
                     appointment_type, appointment_location, notes, req.user.userId]
                );

                // ส่งการแจ้งเตือน
                const notificationData = {
                    appointment_id: appointmentId,
                    appointment_date,
                    appointment_time,
                    appointment_type,
                    doctor_name: 'แพทย์'
                };

                await createAppointmentNotification(patient_id, notificationData, 'new');

                results.success.push({
                    appointment_id: appointmentId,
                    patient_id,
                    patient_name: `${patientCheck[0].first_name} ${patientCheck[0].last_name}`,
                    appointment_date,
                    appointment_time
                });

            } catch (error) {
                console.error('Bulk appointment creation error:', error);
                results.failed.push({
                    patient_id: appointmentData.patient_id,
                    error: error.message
                });
            }
        }

        res.json({
            message: `สร้างการนัดหมายสำเร็จ ${results.success.length} รายการ จากทั้งหมด ${results.total} รายการ`,
            success: true,
            results
        });

    } catch (error) {
        console.error('❌ Bulk create appointments error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการสร้างการนัดหมาย',
            code: 'BULK_CREATE_ERROR'
        });
    }
});

// Replace the original cron job for appointment reminders
cron.schedule('0 9,18 * * *', checkUpcomingAppointmentsEnhanced); // Check twice daily at 9 AM and 6 PM

// ===========================================
// ADDITIONAL PATIENT FUNCTIONS
// ===========================================

// Change password
app.put('/api/patient/change-password', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { current_password, new_password, confirm_password } = req.body;

        // Validation
        if (!current_password || !new_password || !confirm_password) {
            return res.status(400).json({
                message: 'กรุณากรอกข้อมูลให้ครบถ้วน',
                code: 'MISSING_DATA'
            });
        }

        if (new_password !== confirm_password) {
            return res.status(400).json({
                message: 'รหัสผ่านใหม่ไม่ตรงกัน',
                code: 'PASSWORD_MISMATCH'
            });
        }

        if (new_password.length < 8) {
            return res.status(400).json({
                message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร',
                code: 'PASSWORD_TOO_SHORT'
            });
        }

        // Get current password hash
        const [users] = await pool.execute(
            'SELECT password_hash FROM Users WHERE user_id = ?',
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบข้อมูลผู้ใช้',
                code: 'USER_NOT_FOUND'
            });
        }

        // Verify current password
        const isCurrentPasswordValid = await bcrypt.compare(current_password, users[0].password_hash);
        if (!isCurrentPasswordValid) {
            return res.status(401).json({
                message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง',
                code: 'INVALID_CURRENT_PASSWORD'
            });
        }

        // Hash new password
        const saltRounds = 12;
        const newPasswordHash = await bcrypt.hash(new_password, saltRounds);

        // Update password
        await pool.execute(
            `UPDATE Users 
             SET password_hash = ?, last_password_change = NOW() 
             WHERE user_id = ?`,
            [newPasswordHash, userId]
        );

        res.json({
            message: 'เปลี่ยนรหัสผ่านสำเร็จ',
            success: true
        });

    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการเปลี่ยนรหัสผ่าน',
            code: 'CHANGE_PASSWORD_ERROR'
        });
    }
});

// Export patient data
app.get('/api/patient/export-data', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { format = 'json' } = req.query;

        // Get all patient data
        const [profile] = await pool.execute(
            `SELECT * FROM PatientProfiles WHERE patient_id = ?`,
            [userId]
        );

        const [iopMeasurements] = await pool.execute(
            `SELECT * FROM IOP_Measurements WHERE patient_id = ? ORDER BY measurement_date DESC`,
            [userId]
        );

        const [medications] = await pool.execute(
            `SELECT pm.*, m.name FROM PatientMedications pm
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.patient_id = ?`,
            [userId]
        );

        const [medicalHistory] = await pool.execute(
            `SELECT * FROM PatientMedicalHistory WHERE patient_id = ? ORDER BY recorded_at DESC`,
            [userId]
        );

        const [familyHistory] = await pool.execute(
            `SELECT * FROM FamilyGlaucomaHistory WHERE patient_id = ? ORDER BY recorded_at DESC`,
            [userId]
        );

        const [appointments] = await pool.execute(
            `SELECT * FROM Appointments WHERE patient_id = ? ORDER BY appointment_date DESC`,
            [userId]
        );

        const exportData = {
            export_date: new Date().toISOString(),
            patient_profile: profile[0],
            iop_measurements: iopMeasurements,
            medications: medications,
            medical_history: medicalHistory,
            family_history: familyHistory,
            appointments: appointments
        };

        if (format === 'csv') {
            // Convert to CSV format for IOP data
            const csvHeader = 'วันที่,เวลา,ตาซ้าย(mmHg),ตาขวา(mmHg),สถานที่,หมายเหตุ\n';
            const csvContent = iopMeasurements.map(record => {
                const date = new Date(record.measurement_date).toLocaleDateString('th-TH');
                const location = record.measured_at_hospital ? 'โรงพยาบาล' : 'บ้าน';
                return `${date},${record.measurement_time},${record.left_eye_iop || ''},${record.right_eye_iop || ''},${location},${record.notes || ''}`;
            }).join('\n');

            const csvData = csvHeader + csvContent;

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="patient-data.csv"');
            res.send('\uFEFF' + csvData);
        } else {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="patient-data.json"');
            res.send(JSON.stringify(exportData, null, 2));
        }

    } catch (error) {
        console.error('Export patient data error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการส่งออกข้อมูล',
            code: 'EXPORT_ERROR'
        });
    }
});

// Schedule automated checks using cron jobs
//cron.schedule('0 8,12,18 * * *', checkHighIOP); // Check 3 times a day
//cron.schedule('*/30 * * * *', checkMissedMedications); // Check every 30 minutes
//cron.schedule('0 9 * * *', checkLowInventory); // Check once a day at 9 AM
//cron.schedule('0 18 * * *', checkUpcomingAppointments); // Check daily at 6 PM

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Global error handler:', error);
    res.status(500).json({
        message: 'เกิดข้อผิดพลาดของระบบ',
        code: 'INTERNAL_ERROR'
    });
});
// ดึงยาที่หมอสั่ง
app.get('/patient/medications', authenticateToken, async (req, res) => {
    try {
        const patientId = req.user.userId;
        
        const [medications] = await pool.execute(
            `SELECT pm.prescription_id, m.name as medication_name, pm.dosage, pm.eye
             FROM PatientMedications pm
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.patient_id = ? AND pm.status = 'active'`,
            [patientId]
        );
        
        res.json({ data: medications });
    } catch (error) {
        res.status(500).json({ error: true, message: "เกิดข้อผิดพลาด" });
    }
});

// ตั้งการแจ้งเตือน
app.post('/medication-reminders', authenticateToken, async (req, res) => {
    try {
        const patientId = req.user.userId;
        const { prescription_id, reminder_time } = req.body;

        const reminderId = generateId();

        await pool.execute(
            `INSERT INTO MedicationReminders (reminder_id, patient_id, prescription_id, reminder_time) 
             VALUES (?, ?, ?, ?)`,
            [reminderId, patientId, prescription_id, reminder_time]
        );

        res.json({ message: "ตั้งการแจ้งเตือนสำเร็จ" });
    } catch (error) {
        res.status(500).json({ error: true, message: "เกิดข้อผิดพลาด" });
    }
});

// ดูการแจ้งเตือน
app.get('/medication-reminders', authenticateToken, async (req, res) => {
    try {
        const patientId = req.user.userId;
        
        const [reminders] = await pool.execute(
            `SELECT mr.reminder_id, mr.reminder_time, m.name as medication_name
             FROM MedicationReminders mr
             JOIN PatientMedications pm ON mr.prescription_id = pm.prescription_id
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE mr.patient_id = ?`,
            [patientId]
        );

        res.json({ data: reminders });
    } catch (error) {
        res.status(500).json({ error: true, message: "เกิดข้อผิดพลาด" });
    }
});

// บันทึกการทานยา
app.post('/medication-usage', authenticateToken, async (req, res) => {
    try {
        const patientId = req.user.userId;
        const { reminder_id } = req.body;
        
        const recordId = generateId();
        
        await pool.execute(
            `INSERT INTO MedicationUsageRecords (record_id, patient_id, reminder_id, status, actual_time)
             VALUES (?, ?, ?, 'taken', NOW())`,
            [recordId, patientId, reminder_id]
        );

        res.json({ message: "บันทึกการทานยาสำเร็จ" });
    } catch (error) {
        res.status(500).json({ error: true, message: "เกิดข้อผิดพลาด" });
    }
});

// เพิ่มหลัง line 1095 ใน index.js (หลัง // Get medication reminders)

// Get medications for reminder setup (ดึงข้อมูลยาสำหรับตั้งการแจ้งเตือน)
app.get('/api/patient/medications-for-reminder', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        const [medications] = await pool.execute(
            `SELECT pm.prescription_id, pm.medication_id, pm.eye, pm.dosage, pm.frequency,
                    m.name, m.generic_name, m.form, m.strength, m.image_url,
                    CASE 
                        WHEN pm.eye = 'left' THEN 'ตาซ้าย'
                        WHEN pm.eye = 'right' THEN 'ตาขวา'
                        WHEN pm.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE pm.eye
                    END as eye_display,
                    -- คำนวณจำนวนครั้งต่อวันจาก frequency
                    CASE 
                        WHEN pm.frequency LIKE '%1%' OR pm.frequency LIKE '%หนึ่ง%' OR pm.frequency LIKE '%once%' THEN 1
                        WHEN pm.frequency LIKE '%2%' OR pm.frequency LIKE '%สอง%' OR pm.frequency LIKE '%twice%' THEN 2
                        WHEN pm.frequency LIKE '%3%' OR pm.frequency LIKE '%สาม%' OR pm.frequency LIKE '%three%' THEN 3
                        WHEN pm.frequency LIKE '%4%' OR pm.frequency LIKE '%สี่%' OR pm.frequency LIKE '%four%' THEN 4
                        ELSE 2
                    END as daily_frequency,
                    -- ตรวจสอบว่ามีการตั้งเตือนอยู่แล้วหรือไม่
                    (SELECT COUNT(*) FROM MedicationReminders mr 
                     WHERE mr.prescription_id = pm.prescription_id 
                     AND mr.is_active = 1) as reminder_count
             FROM PatientMedications pm
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.patient_id = ? AND pm.status = 'active'
             ORDER BY reminder_count ASC, pm.start_date DESC`,
            [userId]
        );

        // สร้าง suggested_times ใน JavaScript แทน
        const processedMedications = medications.map(med => {
            let suggestedTimes = ['08:00', '20:00']; // default
            
            switch (med.daily_frequency) {
                case 1:
                    suggestedTimes = ['08:00'];
                    break;
                case 2:
                    suggestedTimes = ['08:00', '20:00'];
                    break;
                case 3:
                    suggestedTimes = ['08:00', '14:00', '20:00'];
                    break;
                case 4:
                    suggestedTimes = ['08:00', '12:00', '16:00', '20:00'];
                    break;
            }

            return {
                ...med,
                suggested_times: suggestedTimes,
                usage_guidelines: med.form && med.form.includes('drop') ? [
                    'ล้างมือให้สะอาดก่อนหยอดยา',
                    'ดึงหนังตาล่างลงเล็กน้อย',
                    'หยอดยาลงในถุงใต้หนังตาล่าง',
                    'กดที่มุมในของตาประมาณ 1-2 นาที',
                    'อย่าให้ปลายขวดสัมผัสตา'
                ] : ['ใช้ยาตามที่แพทย์สั่ง'],
                is_eye_drop: med.form && med.form.includes('drop'),
                reminder_status: med.reminder_count > 0 ? 'set' : 'not_set'
            };
        });

        res.json({ 
            medications: processedMedications,
            summary: {
                total_medications: processedMedications.length,
                with_reminders: processedMedications.filter(m => m.reminder_count > 0).length,
                without_reminders: processedMedications.filter(m => m.reminder_count === 0).length
            }
        });
        
    } catch (error) {
        console.error('Get medications for reminder error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Get medication reminder suggestions (แนะนำการตั้งเตือนตามประเภทยา)
app.get('/api/patient/medication-reminder-suggestions/:prescription_id', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { prescription_id } = req.params;

        // ดึงข้อมูลยาเฉพาะตัวที่เลือก
        const [medication] = await pool.execute(
            `SELECT 
                pm.*,
                m.name,
                m.form,
                m.administration_instructions,
                m.description
             FROM PatientMedications pm
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.prescription_id = ? AND pm.patient_id = ?`,
            [prescription_id, userId]
        );

        if (medication.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบข้อมูลยาที่เลือก',
                code: 'MEDICATION_NOT_FOUND'
            });
        }

        const med = medication[0];

        // สร้างคำแนะนำตามประเภทยา
        let suggestions = {
            medication_info: med,
            timing_suggestions: [],
            usage_tips: [],
            precautions: []
        };

        // แนะนำเวลาตาม frequency
        if (med.frequency) {
            if (med.frequency.includes('1') || med.frequency.includes('หนึ่ง')) {
                suggestions.timing_suggestions = [
                    { time: '08:00', label: 'ตอนเช้าหลังตื่นนอน', recommended: true }
                ];
            } else if (med.frequency.includes('2') || med.frequency.includes('สอง')) {
                suggestions.timing_suggestions = [
                    { time: '08:00', label: 'ตอนเช้าหลังตื่นนอน', recommended: true },
                    { time: '20:00', label: 'ตอนเย็นก่อนนอน', recommended: true }
                ];
            } else if (med.frequency.includes('3') || med.frequency.includes('สาม')) {
                suggestions.timing_suggestions = [
                    { time: '08:00', label: 'ตอนเช้าหลังตื่นนอน', recommended: true },
                    { time: '14:00', label: 'ตอนบ่าย', recommended: true },
                    { time: '20:00', label: 'ตอนเย็นก่อนนอน', recommended: true }
                ];
            } else if (med.frequency.includes('4') || med.frequency.includes('สี่')) {
                suggestions.timing_suggestions = [
                    { time: '08:00', label: 'ตอนเช้าหลังตื่นนอน', recommended: true },
                    { time: '12:00', label: 'ตอนเที่ยง', recommended: true },
                    { time: '16:00', label: 'ตอนบ่าย', recommended: true },
                    { time: '20:00', label: 'ตอนเย็นก่อนนอน', recommended: true }
                ];
            }
        }

        // เพิ่มคำแนะนำการใช้ยา
        if (med.form && med.form.includes('drop')) {
            suggestions.usage_tips = [
                'ล้างมือให้สะอาดก่อนหยอดยา',
                'เขย่าขวดยาก่อนใช้ (ถ้าเป็นยาแขวนตะกอน)',
                'ดึงหนังตาล่างลงเล็กน้อย',
                'หยอดยาลงในถุงใต้หนังตาล่าง',
                'กดที่มุมในของตาประมาณ 1-2 นาที',
                'ปิดตาแผ่วเบาๆ ประมาณ 2-3 นาที'
            ];

            suggestions.precautions = [
                'อย่าให้ปลายขวดยาสัมผัสตาหรือนิ้วมือ',
                'ถ้าใช้ยาหลายชนิด ห่างกันอย่างน้อย 5-10 นาที',
                'เก็บยาในตู้เย็นหากแพทย์แนะนำ',
                'สังเกตอาการแพ้ยา เช่น ตาแดง คัน บวม'
            ];
        }

        // เพิ่มคำแนะนำพิเศษจาก special_instructions
        if (med.special_instructions) {
            suggestions.usage_tips.push(med.special_instructions);
        }

        res.json({ suggestions });

    } catch (error) {
        console.error('Get medication suggestions error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Enhanced create medication reminder (ปรับปรุงการสร้างการแจ้งเตือน)
app.post('/api/patient/medication-reminders-enhanced', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            prescription_id,
            medication_id,
            reminder_times, // array of time strings
            days_of_week = '0,1,2,3,4,5,6',
            start_date,
            end_date,
            notification_settings = {},
            notes
        } = req.body;

        console.log(`🔔 Creating enhanced medication reminders for user ${userId}`);

        // ตรวจสอบข้อมูลพื้นฐาน
        if (!prescription_id || !medication_id || !reminder_times || reminder_times.length === 0) {
            return res.status(400).json({
                message: 'ข้อมูลไม่ครบถ้วน กรุณาระบุยาและเวลาเตือน',
                code: 'MISSING_DATA'
            });
        }

        // ตรวจสอบว่าใบสั่งยานี้เป็นของผู้ป่วยคนนี้
        const [prescriptionCheck] = await pool.execute(
            `SELECT pm.*, m.name FROM PatientMedications pm
             JOIN Medications m ON pm.medication_id = m.medication_id
             WHERE pm.prescription_id = ? AND pm.patient_id = ? AND pm.medication_id = ?`,
            [prescription_id, userId, medication_id]
        );

        if (prescriptionCheck.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบรายการยาที่เลือก',
                code: 'PRESCRIPTION_NOT_FOUND'
            });
        }

        const prescription = prescriptionCheck[0];

        // ลบการแจ้งเตือนเดิม (ถ้ามี)
        await pool.execute(
            `UPDATE MedicationReminders 
             SET is_active = 0 
             WHERE prescription_id = ? AND patient_id = ?`,
            [prescription_id, userId]
        );

        // สร้างการแจ้งเตือนใหม่สำหรับแต่ละเวลา
        const createdReminders = [];
        
        for (const reminderTime of reminder_times) {
            const reminderId = generateId();
            
            const finalStartDate = start_date || new Date().toISOString().split('T')[0];
            const finalEye = prescription.eye || 'both';
            const finalDropsCount = notification_settings.drops_count || 1;
            const finalNotificationChannels = notification_settings.channels || 'app,sound';
            
            await pool.execute(
                `INSERT INTO MedicationReminders 
                 (reminder_id, patient_id, prescription_id, medication_id,
                  reminder_time, days_of_week, start_date, end_date,
                  eye, drops_count, notification_channels, notes, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                [
                    reminderId, userId, prescription_id, medication_id,
                    reminderTime, days_of_week, finalStartDate, end_date || null,
                    finalEye, finalDropsCount, finalNotificationChannels, notes || null
                ]
            );

            createdReminders.push({
                reminder_id: reminderId,
                reminder_time: reminderTime,
                medication_name: prescription.name
            });

            console.log(`✅ Created enhanced reminder ${reminderId} for ${reminderTime}`);
        }

        // สร้างการแจ้งเตือนยืนยัน
        await createEnhancedNotification(
            userId,
            'system_announcement',
            'ตั้งการแจ้งเตือนสำเร็จ',
            `ตั้งการแจ้งเตือนยา "${prescription.name}" แล้ว ${reminder_times.length} เวลา`,
            'low',
            { entityType: 'medication_reminder', entityId: prescription_id }
        );

        res.json({
            message: `ตั้งการแจ้งเตือนยา "${prescription.name}" สำเร็จ (${reminder_times.length} เวลา)`,
            success: true,
            reminders: createdReminders,
            notification_settings: {
                sound_enabled: notification_settings.sound_enabled !== false,
                vibration_enabled: notification_settings.vibration_enabled !== false,
                channels: finalNotificationChannels
            }
        });

    } catch (error) {
        console.error('❌ Create enhanced reminder error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการสร้างการแจ้งเตือน',
            code: 'CREATE_REMINDER_ERROR'
        });
    }
});


// Get active notifications with sound settings
app.get('/api/patient/notifications-with-sound', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { unread_only = 'false', limit = '50' } = req.query;

        let whereClause = 'WHERE user_id = ?';
        let params = [userId];

        if (unread_only === 'true') {
            whereClause += ' AND is_read = 0';
        }

        const [notifications] = await pool.execute(
            `SELECT 
                notification_id,
                user_id,
                notification_type,
                title,
                body,
                priority,
                is_read,
                sound_file,
                sound_enabled,
                vibration_enabled,
                push_enabled,
                action_url,
                metadata,
                created_at,
                CASE
                    WHEN notification_type = 'medication_reminder' THEN 'แจ้งเตือนยา'
                    WHEN notification_type = 'appointment_reminder' THEN 'แจ้งเตือนนัดหมาย'
                    WHEN notification_type = 'health_alert' THEN 'แจ้งเตือนสุขภาพ'
                    WHEN notification_type = 'medication_inventory' THEN 'แจ้งเตือนยาใกล้หมด'
                    WHEN notification_type = 'emergency_alert' THEN 'แจ้งเตือนฉุกเฉิน'
                    WHEN notification_type = 'system_announcement' THEN 'ประกาศระบบ'
                    ELSE notification_type
                END as notification_type_display,
                CASE
                    WHEN priority = 'low' THEN 'ต่ำ'
                    WHEN priority = 'medium' THEN 'ปานกลาง'
                    WHEN priority = 'high' THEN 'สูง'
                    WHEN priority = 'urgent' THEN 'ด่วน'
                    ELSE priority
                END as priority_display
             FROM Notifications 
             ${whereClause} 
             ORDER BY created_at DESC 
             LIMIT ?`,
            [...params, parseInt(limit)]
        );

        res.json({ 
            notifications: notifications || [],
            sound_base_url: '/api/sounds/',
            available_sounds: NOTIFICATION_SOUNDS
        });

    } catch (error) {
        console.error('Get notifications with sound error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR',
            notifications: []
        });
    }
});

app.get('/api/sounds/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        
        // Security check - only allow predefined sound files
        if (!Object.values(NOTIFICATION_SOUNDS).includes(filename)) {
            return res.status(404).json({ message: 'Sound file not found' });
        }

        const soundPath = path.join(__dirname, 'assets', 'sounds', filename);
        
        // Check if file exists
        if (!require('fs').existsSync(soundPath)) {
            return res.status(404).json({ message: 'Sound file not found' });
        }

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 day cache
        res.sendFile(soundPath);

    } catch (error) {
        console.error('Serve sound file error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Get notification settings
app.get('/api/patient/notification-settings', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [settings] = await pool.execute(
            `SELECT notification_preferences, quiet_hours_start, quiet_hours_end 
             FROM UserSettings WHERE user_id = ?`,
            [userId]
        );

        let notificationSettings = {
            sound_enabled: true,
            vibration_enabled: true,
            push_enabled: true,
            email_enabled: false,
            sound_file: NOTIFICATION_SOUNDS.general,
            volume: 0.8,
            medication_reminders: true,
            appointment_reminders: true,
            health_alerts: true,
            system_announcements: true
        };

        if (settings.length > 0 && settings[0].notification_preferences) {
            try {
                const userPrefs = JSON.parse(settings[0].notification_preferences);
                notificationSettings = { ...notificationSettings, ...userPrefs };
            } catch (e) {
                console.log('Failed to parse notification preferences');
            }
        }

        res.json({
            notification_settings: notificationSettings,
            quiet_hours: {
                start: settings[0]?.quiet_hours_start || null,
                end: settings[0]?.quiet_hours_end || null
            },
            available_sounds: NOTIFICATION_SOUNDS
        });

    } catch (error) {
        console.error('Get notification settings error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Update notification settings
app.put('/api/patient/notification-settings', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { notification_settings, quiet_hours } = req.body;

        // Update notification preferences
        if (notification_settings) {
            await pool.execute(
                `UPDATE UserSettings 
                 SET notification_preferences = ?,
                     quiet_hours_start = ?,
                     quiet_hours_end = ?
                 WHERE user_id = ?`,
                [
                    JSON.stringify(notification_settings),
                    quiet_hours?.start || null,
                    quiet_hours?.end || null,
                    userId
                ]
            );
        }

        res.json({
            message: 'อัปเดตการตั้งค่าการแจ้งเตือนสำเร็จ',
            success: true
        });

    } catch (error) {
        console.error('Update notification settings error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปเดตการตั้งค่า',
            code: 'UPDATE_ERROR'
        });
    }
});

// Enhanced medication reminder check with sound
const checkMissedMedicationsEnhanced = async () => {
    try {
        console.log('🔔 Checking for missed medications...');
        
        const [missedMedications] = await pool.execute(
            `SELECT mr.*, m.name, p.first_name, p.last_name, p.patient_id
             FROM MedicationReminders mr
             JOIN PatientMedications pm ON mr.prescription_id = pm.prescription_id
             JOIN Medications m ON mr.medication_id = m.medication_id
             JOIN PatientProfiles p ON mr.patient_id = p.patient_id
             WHERE mr.is_active = 1
             AND FIND_IN_SET(WEEKDAY(NOW()), mr.days_of_week)
             AND NOT EXISTS (
                 SELECT 1 FROM MedicationUsageRecords mur
                 WHERE mur.reminder_id = mr.reminder_id
                 AND DATE(mur.scheduled_time) = CURDATE()
                 AND mur.status = 'taken'
             )
             AND TIME(NOW()) >= ADDTIME(mr.reminder_time, '00:15:00')`
        );

        for (const missed of missedMedications) {
            const message = `ยังไม่ได้หยอดยา ${missed.name} ตามเวลาที่กำหนด (${missed.reminder_time})`;
            
            await createEnhancedNotification(
                missed.patient_id,
                'medication_reminder',
                'ยังไม่ได้หยอดยา',
                message,
                'high',
                {
                    entityType: 'MedicationReminders',
                    entityId: missed.reminder_id,
                    actionUrl: '/medication-tracker',
                    metadata: {
                        reminder_id: missed.reminder_id,
                        medication_name: missed.name,
                        scheduled_time: missed.reminder_time,
                        sound_enabled: true,
                        vibration_enabled: true
                    }
                }
            );
        }
        
        console.log(`✅ Processed ${missedMedications.length} missed medication reminders`);
    } catch (error) {
        console.error('❌ Check missed medications enhanced error:', error);
    }
};

// Replace the original cron job
cron.schedule('*/15 * * * *', checkMissedMedicationsEnhanced); // Check every 15 minutes

// เพิ่ม endpoint สำหรับดึง detailed reminders (แก้ไขแล้ว)
app.get('/api/patient/medication-reminders-detailed', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [reminders] = await pool.execute(
            `SELECT mr.*, m.name, m.image_url, m.form, m.strength,
                    pm.dosage, pm.frequency,
                    CASE 
                        WHEN mr.eye = 'left' THEN 'ตาซ้าย'
                        WHEN mr.eye = 'right' THEN 'ตาขวา'
                        WHEN mr.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE mr.eye
                    END as eye_display,
                    -- นับการใช้ยาวันนี้
                    (SELECT COUNT(*) FROM MedicationUsageRecords mur 
                     WHERE mur.reminder_id = mr.reminder_id 
                     AND DATE(mur.scheduled_time) = CURDATE()
                     AND mur.status = 'taken') as taken_today,
                    -- นับการพลาดยาวันนี้
                    (SELECT COUNT(*) FROM MedicationUsageRecords mur 
                     WHERE mur.reminder_id = mr.reminder_id 
                     AND DATE(mur.scheduled_time) = CURDATE()
                     AND mur.status = 'skipped') as missed_today
             FROM MedicationReminders mr
             JOIN PatientMedications pm ON mr.prescription_id = pm.prescription_id
             JOIN Medications m ON mr.medication_id = m.medication_id
             WHERE mr.patient_id = ? AND mr.is_active = 1
             ORDER BY m.name, mr.reminder_time`,
            [userId]
        );

        // จัดกลุ่มตามยา
        const medicationGroups = {};
        
        reminders.forEach(reminder => {
            const medId = reminder.medication_id;
            
            if (!medicationGroups[medId]) {
                medicationGroups[medId] = {
                    medication_id: medId,
                    medication_name: reminder.name,
                    image_url: reminder.image_url,
                    form: reminder.form,
                    strength: reminder.strength,
                    dosage: reminder.dosage,
                    frequency: reminder.frequency,
                    eye_display: reminder.eye_display,
                    reminders: []
                };
            }
            
            medicationGroups[medId].reminders.push({
                reminder_id: reminder.reminder_id,
                reminder_time: reminder.reminder_time,
                days_of_week: reminder.days_of_week,
                start_date: reminder.start_date,
                end_date: reminder.end_date,
                taken_today: reminder.taken_today,
                missed_today: reminder.missed_today,
                notes: reminder.notes
            });
        });

        const groupedReminders = Object.values(medicationGroups);

        res.json({ 
            medication_reminders: groupedReminders,
            total_medications: groupedReminders.length,
            total_reminder_times: reminders.length
        });

    } catch (error) {
        console.error('Get detailed reminders error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Test notification endpoint สำหรับทดสอบระบบแจ้งเตือน
app.get('/api/test/notifications', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        // สร้างการแจ้งเตือนทดสอบ
        const testNotifications = [
            {
                notification_id: 'test-1',
                user_id: userId,
                notification_type: 'medication_reminder',
                title: 'เวลาหยอดยาตา',
                body: 'ถึงเวลาหยอดยา Timolol ตาทั้งสองข้าง',
                priority: 'medium',
                is_read: false,
                created_at: new Date().toISOString()
            },
            {
                notification_id: 'test-2',
                user_id: userId,
                notification_type: 'appointment_reminder',
                title: 'นัดหมายพรุ่งนี้',
                body: 'คุณมีนัดตรวจตากับแพทย์พรุ่งนี้ เวลา 09:00 น.',
                priority: 'high',
                is_read: false,
                created_at: new Date(Date.now() - 60000).toISOString()
            }
        ];

        res.json({ 
            message: 'Test notifications created',
            notifications: testNotifications 
        });

    } catch (error) {
        console.error('Test notifications error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// แทนที่ POST /api/patient/appointment-reschedule-request
app.post('/api/patient/appointment-reschedule-request', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { appointment_id, preferred_date_1, preferred_date_2, reason } = req.body;

        // ตรวจสอบข้อมูล
        if (!appointment_id || !preferred_date_1 || !reason) {
            return res.status(400).json({
                message: 'ข้อมูลไม่ครบถ้วน',
                code: 'MISSING_DATA'
            });
        }

        // ตรวจสอบว่า user มีจริงในระบบหรือไม่
        const [userCheck] = await pool.execute(
            'SELECT user_id FROM Users WHERE user_id = ?',
            [userId]
        );

        if (userCheck.length === 0) {
            console.error('User not found in Users table:', userId);
            return res.status(404).json({
                message: 'ไม่พบข้อมูลผู้ใช้ในระบบ',
                code: 'USER_NOT_FOUND'
            });
        }

        // ตรวจสอบว่านัดหมายนี้มีจริงหรือไม่
        const [appointments] = await pool.execute(
            `SELECT * FROM Appointments 
             WHERE appointment_id = ? AND patient_id = ?`,
            [appointment_id, userId]
        );

        if (appointments.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบการนัดหมายที่ระบุ กรุณาติดต่อเจ้าหน้าที่',
                code: 'APPOINTMENT_NOT_FOUND'
            });
        }

        const appointment = appointments[0];

        // Log ข้อมูลคำขอ (แทนการ insert ลง database)
        console.log('=== RESCHEDULE REQUEST LOGGED ===');
        console.log('Timestamp:', new Date().toISOString());
        console.log('Patient ID:', userId);
        console.log('Appointment ID:', appointment_id);
        console.log('Original Date:', appointment.appointment_date);
        console.log('Original Time:', appointment.appointment_time);
        console.log('Appointment Type:', appointment.appointment_type);
        console.log('Preferred Date 1:', preferred_date_1);
        console.log('Preferred Date 2:', preferred_date_2 || 'Not specified');
        console.log('Reason:', reason);
        console.log('Status: PENDING ADMIN REVIEW');
        console.log('====================================');

        // บันทึกลง file log (optional)
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: 'RESCHEDULE_REQUEST',
            patient_id: userId,
            appointment_id: appointment_id,
            original_date: appointment.appointment_date,
            original_time: appointment.appointment_time,
            preferred_date_1: preferred_date_1,
            preferred_date_2: preferred_date_2,
            reason: reason,
            status: 'PENDING'
        };

        // แค่ response สำเร็จ ไม่ต้อง insert database
        res.json({
            message: 'ส่งคำขอเลื่อนนัดสำเร็จ เจ้าหน้าที่จะติดต่อกลับภายใน 1-2 วันทำการ',
            success: true,
            request_details: {
                appointment_id: appointment_id,
                original_date: appointment.appointment_date,
                preferred_dates: {
                    first: preferred_date_1,
                    second: preferred_date_2
                },
                submitted_at: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Reschedule request error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการส่งคำขอ',
            code: 'INTERNAL_ERROR'
        });
    }
});



// เพิ่ม endpoint สำหรับดึง detailed reminders
app.get('/api/patient/medication-reminders-detailed', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [reminders] = await pool.execute(
            `SELECT mr.*, m.name, m.image_url, pm.dosage, pm.frequency,
                    CASE 
                        WHEN mr.eye = 'left' THEN 'ตาซ้าย'
                        WHEN mr.eye = 'right' THEN 'ตาขวา'
                        WHEN mr.eye = 'both' THEN 'ทั้งสองตา'
                        ELSE mr.eye
                    END as eye_display
             FROM MedicationReminders mr
             JOIN PatientMedications pm ON mr.prescription_id = pm.prescription_id
             JOIN Medications m ON mr.medication_id = m.medication_id
             WHERE mr.patient_id = ? AND mr.is_active = 1
             ORDER BY m.name, mr.reminder_time`,
            [userId]
        );

        // จัดกลุ่มตามยา
        const medicationGroups = {};
        reminders.forEach(reminder => {
            const medId = reminder.medication_id;
            if (!groupedByMedication[medId]) {
                groupedByMedication[medId] = {
                    medication_id: medId,
                    medication_name: reminder.name,
                    image_url: reminder.image_url,
                    dosage: reminder.dosage,
                    frequency: reminder.frequency,
                    eye_display: reminder.eye_display,
                    reminders: []
                };
            }
            groupedByMedication[medId].reminders.push({
                reminder_id: reminder.reminder_id,
                reminder_time: reminder.reminder_time,
                days_of_week: reminder.days_of_week,
                notes: reminder.notes
            });
        });

        res.json({ 
            medication_reminders: Object.values(medicationGroups),
            total_medications: Object.keys(medicationGroups).length
        });
    } catch (error) {
        console.error('Get detailed reminders error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});



    'mailto:admin@gtms.com',
    process.env.VAPID_PUBLIC_KEY || 'your-vapid-public-key',
    process.env.VAPID_PRIVATE_KEY || 'your-vapid-private-key'


// ===========================================
// PUSH NOTIFICATION SUBSCRIPTION
// ===========================================

// Subscribe to push notifications
app.post('/api/patient/push-subscribe', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { subscription, device_info } = req.body;

        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({
                message: 'ข้อมูล subscription ไม่ครบถ้วน',
                code: 'INVALID_SUBSCRIPTION'
            });
        }

        const subscriptionId = generateId();

        try {
            await pool.execute(
                `INSERT INTO PushSubscriptions 
                 (subscription_id, user_id, endpoint, p256dh_key, auth_key, device_info, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE
                 p256dh_key = VALUES(p256dh_key),
                 auth_key = VALUES(auth_key),
                 device_info = VALUES(device_info),
                 is_active = 1,
                 updated_at = NOW()`,
                [
                    subscriptionId, userId, subscription.endpoint,
                    subscription.keys.p256dh, subscription.keys.auth,
                    JSON.stringify(device_info || {})
                ]
            );

            res.json({
                message: 'สมัครรับการแจ้งเตือนสำเร็จ',
                subscription_id: subscriptionId
            });
        } catch (dbError) {
            if (dbError.code === 'ER_NO_SUCH_TABLE') {
                // ตาราง PushSubscriptions ยังไม่มี
                console.log('⚠️ PushSubscriptions table not found');
                return res.status(501).json({
                    message: 'ฟีเจอร์ Push Notification ยังไม่พร้อมใช้งาน',
                    code: 'FEATURE_NOT_AVAILABLE'
                });
            }
            throw dbError;
        }

    } catch (error) {
        console.error('Push subscribe error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการสมัครรับการแจ้งเตือน',
            code: 'PUSH_SUBSCRIBE_ERROR'
        });
    }
});

// Send push notification
async function sendPushNotification(userId, title, body, data = {}) {
    try {
        if (!webpush) {
            console.log('⚠️ Web Push not available, skipping push notification');
            return { success: false, error: 'Web Push not configured' };
        }

        const [subscriptions] = await pool.execute(
            `SELECT * FROM PushSubscriptions WHERE user_id = ? AND is_active = 1`,
            [userId]
        );

        if (subscriptions.length === 0) {
            console.log(`ℹ️ No push subscriptions found for user ${userId}`);
            return { success: false, error: 'No subscriptions found' };
        }

        const pushPromises = subscriptions.map(async (sub) => {
            try {
                const pushSubscription = {
                    endpoint: sub.endpoint,
                    keys: {
                        p256dh: sub.p256dh_key,
                        auth: sub.auth_key
                    }
                };

                const payload = JSON.stringify({
                    title,
                    body,
                    icon: '/icons/medication-icon-192.png',
                    badge: '/icons/badge-72.png',
                    tag: data.tag || 'gtms-notification',
                    data: {
                        url: data.url || '/notifications',
                        ...data
                    },
                    actions: [
                        {
                            action: 'open',
                            title: 'เปิดดู'
                        },
                        {
                            action: 'dismiss',
                            title: 'ปิด'
                        }
                    ]
                });

                await webpush.sendNotification(pushSubscription, payload);
                console.log(`✅ Push notification sent to ${userId}`);
                
                return { success: true, subscription_id: sub.subscription_id };
            } catch (error) {
                console.error(`❌ Push notification failed for ${sub.subscription_id}:`, error);
                
                // ลบ subscription ที่ไม่ valid
                if (error.statusCode === 410) {
                    await pool.execute(
                        `UPDATE PushSubscriptions SET is_active = 0 WHERE subscription_id = ?`,
                        [sub.subscription_id]
                    );
                }
                
                return { success: false, error: error.message };
            }
        });

        const results = await Promise.all(pushPromises);
        return results;
        
    } catch (error) {
        console.error('Send push notification error:', error);
        return { success: false, error: error.message };
    }
}

// ===========================================
// LOCATION-BASED NOTIFICATIONS
// ===========================================

// Update user location
app.post('/api/patient/location', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { latitude, longitude, accuracy, address } = req.body;

        if (!latitude || !longitude) {
            return res.status(400).json({
                message: 'ข้อมูลตำแหน่งไม่ครบถ้วน',
                code: 'INVALID_LOCATION'
            });
        }

        const locationId = generateId();

        try {
            await pool.execute(
                `INSERT INTO UserLocations 
                 (location_id, user_id, latitude, longitude, accuracy, address, recorded_at)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                [locationId, userId, latitude, longitude, accuracy, address]
            );

            // อัปเดตตำแหน่งล่าสุดใน UserSettings
            await pool.execute(
                `UPDATE UserSettings 
                 SET last_known_location = ?, location_updated_at = NOW()
                 WHERE user_id = ?`,
                [JSON.stringify({ latitude, longitude, accuracy, address }), userId]
            ).catch(() => {
                console.log('⚠️ Could not update UserSettings with location (columns may not exist)');
            });

            // ตรวจสอบการแจ้งเตือนตามสถานที่
            await checkLocationBasedNotifications(userId, latitude, longitude);

            res.json({
                message: 'อัปเดตตำแหน่งสำเร็จ',
                location_id: locationId
            });
        } catch (dbError) {
            if (dbError.code === 'ER_NO_SUCH_TABLE') {
                console.log('⚠️ UserLocations table not found');
                return res.status(501).json({
                    message: 'ฟีเจอร์ Location tracking ยังไม่พร้อมใช้งาน',
                    code: 'FEATURE_NOT_AVAILABLE'
                });
            }
            throw dbError;
        }

    } catch (error) {
        console.error('Update location error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปเดตตำแหน่ง',
            code: 'UPDATE_LOCATION_ERROR'
        });
    }
});

// Add location-based reminder
app.post('/api/patient/location-reminders', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const {
            location_name, latitude, longitude, radius = 100,
            reminder_type, reminder_message, trigger_type = 'enter'
        } = req.body;

        if (!location_name || !latitude || !longitude || !reminder_message) {
            return res.status(400).json({
                message: 'ข้อมูลไม่ครบถ้วน',
                code: 'MISSING_DATA'
            });
        }

        const reminderId = generateId();

        await pool.execute(
            `INSERT INTO LocationReminders 
             (reminder_id, user_id, location_name, latitude, longitude, radius,
              reminder_type, reminder_message, trigger_type, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [reminderId, userId, location_name, latitude, longitude, radius,
             reminder_type, reminder_message, trigger_type]
        );

        res.json({
            message: 'เพิ่มการเตือนตามสถานที่สำเร็จ',
            reminder_id: reminderId
        });

    } catch (error) {
        console.error('Add location reminder error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการเพิ่มการเตือนตามสถานที่',
            code: 'ADD_LOCATION_REMINDER_ERROR'
        });
    }
});

// Get location-based reminders
app.get('/api/patient/location-reminders', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [reminders] = await pool.execute(
            `SELECT *, 
                    CASE 
                        WHEN reminder_type = 'medication' THEN 'เตือนการใช้ยา'
                        WHEN reminder_type = 'appointment' THEN 'เตือนการนัดหมาย'
                        WHEN reminder_type = 'general' THEN 'เตือนทั่วไป'
                        ELSE reminder_type
                    END as reminder_type_display,
                    CASE 
                        WHEN trigger_type = 'enter' THEN 'เมื่อเข้าสถานที่'
                        WHEN trigger_type = 'exit' THEN 'เมื่อออกจากสถานที่'
                        WHEN trigger_type = 'both' THEN 'เข้าและออก'
                        ELSE trigger_type
                    END as trigger_type_display
             FROM LocationReminders
             WHERE user_id = ? AND is_active = 1
             ORDER BY created_at DESC`,
            [userId]
        );

        res.json({ location_reminders: reminders });

    } catch (error) {
        console.error('Get location reminders error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Check location-based notifications
async function checkLocationBasedNotifications(userId, latitude, longitude) {
    try {
        // ตรวจสอบว่าตาราง LocationReminders มีอยู่หรือไม่
        const [reminders] = await pool.execute(
            `SELECT * FROM LocationReminders 
             WHERE user_id = ? AND is_active = 1`,
            [userId]
        ).catch(() => {
            console.log('⚠️ LocationReminders table not found, skipping location-based notifications');
            return [[]];
        });

        for (const reminder of reminders) {
            const distance = calculateDistance(
                latitude, longitude,
                reminder.latitude, reminder.longitude
            );

            if (distance <= reminder.radius) {
                // สร้างการแจ้งเตือนตามสถานที่
                await createEnhancedNotification(
                    userId,
                    'location_reminder',
                    `📍 ${reminder.location_name}`,
                    reminder.reminder_message,
                    'medium',
                    {
                        entityType: 'LocationReminders',
                        entityId: reminder.reminder_id,
                        metadata: {
                            location_name: reminder.location_name,
                            reminder_type: reminder.reminder_type,
                            distance: Math.round(distance)
                        }
                    }
                );

                // อัปเดตเวลาที่แจ้งเตือนล่าสุด
                await pool.execute(
                    `UPDATE LocationReminders 
                     SET updated_at = NOW() 
                     WHERE reminder_id = ?`,
                    [reminder.reminder_id]
                );
            }
        }
    } catch (error) {
        console.error('Check location notifications error:', error);
    }
}

// Calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in meters
}

// ===========================================
// MEDICATION REMINDER MANAGEMENT (Enhanced)
// ===========================================

// Update medication reminder
app.put('/api/patient/medication-reminders/:reminder_id', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { reminder_id } = req.params;
        const {
            reminder_time, days_of_week, is_active, notes
        } = req.body;

        // ตรวจสอบว่า reminder นี้เป็นของผู้ป่วยคนนี้
        const [reminder] = await pool.execute(
            `SELECT mr.*, m.name FROM MedicationReminders mr
             JOIN Medications m ON mr.medication_id = m.medication_id
             WHERE mr.reminder_id = ? AND mr.patient_id = ?`,
            [reminder_id, userId]
        );

        if (reminder.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบการเตือนที่ระบุ',
                code: 'REMINDER_NOT_FOUND'
            });
        }

        await pool.execute(
            `UPDATE MedicationReminders 
             SET reminder_time = COALESCE(?, reminder_time),
                 days_of_week = COALESCE(?, days_of_week),
                 is_active = COALESCE(?, is_active),
                 notes = COALESCE(?, notes),
                 updated_at = NOW()
             WHERE reminder_id = ? AND patient_id = ?`,
            [reminder_time, days_of_week, is_active, notes, reminder_id, userId]
        );

        // บันทึก audit log
        await logUserAction(
            userId, 'MEDICATION_REMINDER_UPDATED', 'MedicationReminders', reminder_id,
            `Updated reminder for ${reminder[0].name}`, 'success',
            req.ip, req.headers['user-agent']
        );

        res.json({
            message: `อัปเดตการเตือนยา "${reminder[0].name}" สำเร็จ`,
            success: true
        });

    } catch (error) {
        console.error('Update medication reminder error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการอัปเดตการเตือน',
            code: 'UPDATE_REMINDER_ERROR'
        });
    }
});

// Delete medication reminder
app.delete('/api/patient/medication-reminders/:reminder_id', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { reminder_id } = req.params;

        // ตรวจสอบว่า reminder นี้เป็นของผู้ป่วยคนนี้
        const [reminder] = await pool.execute(
            `SELECT mr.*, m.name FROM MedicationReminders mr
             JOIN Medications m ON mr.medication_id = m.medication_id
             WHERE mr.reminder_id = ? AND mr.patient_id = ?`,
            [reminder_id, userId]
        );

        if (reminder.length === 0) {
            return res.status(404).json({
                message: 'ไม่พบการเตือนที่ระบุ',
                code: 'REMINDER_NOT_FOUND'
            });
        }

        // Soft delete - อัปเดตเป็น inactive และเพิ่ม deleted_at
        await pool.execute(
            `UPDATE MedicationReminders 
             SET is_active = 0, deleted_at = NOW(), updated_at = NOW()
             WHERE reminder_id = ? AND patient_id = ?`,
            [reminder_id, userId]
        );

        // บันทึก audit log
        await logUserAction(
            userId, 'MEDICATION_REMINDER_DELETED', 'MedicationReminders', reminder_id,
            `Deleted reminder for ${reminder[0].name}`, 'success',
            req.ip, req.headers['user-agent']
        );

        res.json({
            message: `ลบการเตือนยา "${reminder[0].name}" สำเร็จ`,
            success: true
        });

    } catch (error) {
        console.error('Delete medication reminder error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการลบการเตือน',
            code: 'DELETE_REMINDER_ERROR'
        });
    }
});

// ===========================================
// NOTIFICATION HISTORY
// ===========================================

// Get notification history with advanced filtering
app.get('/api/patient/notification-history', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { 
            page = 1, 
            limit = 20, 
            type, 
            start_date, 
            end_date,
            status,
            priority,
            search
        } = req.query;

        let whereClause = 'WHERE user_id = ?';
        let params = [userId];

        if (type) {
            whereClause += ' AND notification_type = ?';
            params.push(type);
        }

        if (start_date) {
            whereClause += ' AND DATE(created_at) >= ?';
            params.push(start_date);
        }

        if (end_date) {
            whereClause += ' AND DATE(created_at) <= ?';
            params.push(end_date);
        }

        if (status === 'read') {
            whereClause += ' AND is_read = 1';
        } else if (status === 'unread') {
            whereClause += ' AND is_read = 0';
        }

        if (priority) {
            whereClause += ' AND priority = ?';
            params.push(priority);
        }

        if (search) {
            whereClause += ' AND (title LIKE ? OR body LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        const offset = (parseInt(page) - 1) * parseInt(limit);

        // Get total count
        const [countResult] = await pool.execute(
            `SELECT COUNT(*) as total FROM Notifications ${whereClause}`,
            params
        );

        // Get notifications with history
        const [notifications] = await pool.execute(
            `SELECT n.*,
                    CASE
                        WHEN n.notification_type = 'medication_reminder' THEN 'แจ้งเตือนยา'
                        WHEN n.notification_type = 'appointment_reminder' THEN 'แจ้งเตือนนัดหมาย'
                        WHEN n.notification_type = 'health_alert' THEN 'แจ้งเตือนสุขภาพ'
                        WHEN n.notification_type = 'medication_inventory' THEN 'แจ้งเตือนยาใกล้หมด'
                        WHEN n.notification_type = 'emergency_alert' THEN 'แจ้งเตือนฉุกเฉิน'
                        WHEN n.notification_type = 'system_announcement' THEN 'ประกาศระบบ'
                        WHEN n.notification_type = 'location_reminder' THEN 'แจ้งเตือนตามสถานที่'
                        ELSE n.notification_type
                    END as notification_type_display,
                    CASE
                        WHEN n.priority = 'low' THEN 'ต่ำ'
                        WHEN n.priority = 'medium' THEN 'ปานกลาง'
                        WHEN n.priority = 'high' THEN 'สูง'
                        WHEN n.priority = 'urgent' THEN 'ด่วน'
                        ELSE n.priority
                    END as priority_display
             FROM Notifications n
             ${whereClause}
             ORDER BY n.created_at DESC 
             LIMIT ? OFFSET ?`,
            [...params, parseInt(limit), offset]
        );

        const totalPages = Math.ceil(countResult[0].total / parseInt(limit));

        res.json({
            notifications,
            pagination: {
                current_page: parseInt(page),
                total_pages: totalPages,
                total_items: countResult[0].total,
                items_per_page: parseInt(limit)
            },
            filters: {
                type, start_date, end_date, status, priority, search
            }
        });

    } catch (error) {
        console.error('Get notification history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Log notification action
async function logNotificationAction(notificationId, userId, actionType, metadata = {}) {
    try {
        const historyId = generateId();
        await pool.execute(
            `INSERT INTO NotificationHistory 
             (history_id, notification_id, user_id, action_type, action_timestamp, 
              channel, device_info, metadata)
             VALUES (?, ?, ?, ?, NOW(), ?, ?, ?)`,
            [
                historyId, notificationId, userId, actionType,
                metadata.channel || 'app',
                JSON.stringify(metadata.device_info || {}),
                JSON.stringify(metadata)
            ]
        );
    } catch (error) {
        console.error('Log notification action error:', error);
    }
}

// ===========================================
// COMPLIANCE REPORTING
// ===========================================

// Get comprehensive compliance report
app.get('/api/patient/compliance-report', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { period = '30', type = 'overall' } = req.query;

        const periodStart = new Date();
        periodStart.setDate(periodStart.getDate() - parseInt(period));
        const periodEnd = new Date();

        let report = {
            patient_id: userId,
            period_start: periodStart.toISOString().split('T')[0],
            period_end: periodEnd.toISOString().split('T')[0],
            period_days: parseInt(period),
            generated_at: new Date().toISOString()
        };

        // Medication compliance
        if (type === 'medication' || type === 'overall') {
            const [medicationCompliance] = await pool.execute(
                `SELECT 
                    mr.medication_id,
                    m.name as medication_name,
                    COUNT(DISTINCT DATE(mur.scheduled_time)) as days_with_reminders,
                    COUNT(mur.record_id) as total_reminders,
                    SUM(CASE WHEN mur.status = 'taken' THEN 1 ELSE 0 END) as taken_count,
                    SUM(CASE WHEN mur.status = 'skipped' THEN 1 ELSE 0 END) as skipped_count,
                    SUM(CASE WHEN mur.status = 'delayed' THEN 1 ELSE 0 END) as delayed_count,
                    ROUND((SUM(CASE WHEN mur.status = 'taken' THEN 1 ELSE 0 END) / COUNT(mur.record_id)) * 100, 2) as compliance_rate,
                    AVG(CASE WHEN mur.status = 'delayed' AND mur.actual_time IS NOT NULL THEN 
                        TIMESTAMPDIFF(MINUTE, mur.scheduled_time, mur.actual_time) 
                    END) as avg_delay_minutes
                 FROM MedicationReminders mr
                 JOIN Medications m ON mr.medication_id = m.medication_id
                 LEFT JOIN MedicationUsageRecords mur ON mr.reminder_id = mur.reminder_id
                    AND mur.scheduled_time >= ?
                    AND mur.scheduled_time <= ?
                 WHERE mr.patient_id = ? AND mr.is_active = 1
                 GROUP BY mr.medication_id, m.name`,
                [periodStart, periodEnd, userId]
            );

            report.medication_compliance = medicationCompliance || [];
            
            // Calculate overall medication compliance
            const totalReminders = medicationCompliance.reduce((sum, med) => sum + (med.total_reminders || 0), 0);
            const totalTaken = medicationCompliance.reduce((sum, med) => sum + (med.taken_count || 0), 0);
            
            report.overall_medication_compliance = {
                total_reminders: totalReminders,
                total_taken: totalTaken,
                compliance_rate: totalReminders > 0 ? Math.round((totalTaken / totalReminders) * 100) : 0,
                grade: getComplianceGrade(totalReminders > 0 ? (totalTaken / totalReminders) * 100 : 0)
            };
        }

        // Appointment compliance
        if (type === 'appointment' || type === 'overall') {
            const [appointmentCompliance] = await pool.execute(
                `SELECT 
                    COUNT(*) as total_appointments,
                    SUM(CASE WHEN appointment_status = 'completed' THEN 1 ELSE 0 END) as attended,
                    SUM(CASE WHEN appointment_status = 'no_show' THEN 1 ELSE 0 END) as missed,
                    SUM(CASE WHEN appointment_status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
                    SUM(CASE WHEN appointment_status = 'rescheduled' THEN 1 ELSE 0 END) as rescheduled,
                    ROUND((SUM(CASE WHEN appointment_status = 'completed' THEN 1 ELSE 0 END) / COUNT(*)) * 100, 2) as attendance_rate
                 FROM Appointments
                 WHERE patient_id = ? 
                 AND appointment_date >= ? 
                 AND appointment_date <= ?`,
                [userId, periodStart.toISOString().split('T')[0], periodEnd.toISOString().split('T')[0]]
            );

            report.appointment_compliance = appointmentCompliance[0] || {
                total_appointments: 0,
                attended: 0,
                missed: 0,
                cancelled: 0,
                rescheduled: 0,
                attendance_rate: 0
            };
        }

        // Notification response compliance
        if (type === 'notification' || type === 'overall') {
            const [notificationCompliance] = await pool.execute(
                `SELECT 
                    notification_type,
                    COUNT(*) as total_notifications,
                    SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) as read_count,
                    AVG(CASE WHEN read_at IS NOT NULL THEN 
                        TIMESTAMPDIFF(MINUTE, created_at, read_at) 
                    END) as avg_response_time_minutes,
                    ROUND((SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) / COUNT(*)) * 100, 2) as read_rate
                 FROM Notifications
                 WHERE user_id = ? 
                 AND created_at >= ? 
                 AND created_at <= ?
                 GROUP BY notification_type`,
                [userId, periodStart, periodEnd]
            );

            report.notification_compliance = notificationCompliance || [];
        }

        // Generate recommendations
        report.recommendations = generateComplianceRecommendations(report);

        // Save report to database
        if (type === 'overall') {
            const reportId = generateId();
            await pool.execute(
                `INSERT INTO ComplianceReports 
                 (report_id, patient_id, report_type, period_start, period_end,
                  total_scheduled, total_completed, total_missed, compliance_rate,
                  grade, detailed_data, recommendations, generated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    reportId, userId, 'overall', 
                    report.period_start, report.period_end,
                    report.overall_medication_compliance?.total_reminders || 0,
                    report.overall_medication_compliance?.total_taken || 0,
                    (report.overall_medication_compliance?.total_reminders || 0) - (report.overall_medication_compliance?.total_taken || 0),
                    report.overall_medication_compliance?.compliance_rate || 0,
                    report.overall_medication_compliance?.grade || 'unknown',
                    JSON.stringify(report),
                    JSON.stringify(report.recommendations),
                    userId
                ]
            );

            report.report_id = reportId;
        }

        res.json(report);

    } catch (error) {
        console.error('Get compliance report error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดในการสร้างรายงาน',
            code: 'REPORT_ERROR'
        });
    }
});

// Get compliance history
app.get('/api/patient/compliance-history', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { limit = 12 } = req.query; // Default 12 months

        const [reports] = await pool.execute(
            `SELECT report_id, report_type, period_start, period_end,
                    compliance_rate, grade, generated_at,
                    DATEDIFF(period_end, period_start) as period_days
             FROM ComplianceReports
             WHERE patient_id = ?
             ORDER BY generated_at DESC
             LIMIT ?`,
            [userId, parseInt(limit)]
        );

        res.json({ compliance_history: reports });

    } catch (error) {
        console.error('Get compliance history error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// Helper function to determine compliance grade
function getComplianceGrade(rate) {
    if (rate >= 95) return 'excellent';
    if (rate >= 80) return 'good';
    if (rate >= 60) return 'fair';
    if (rate >= 40) return 'poor';
    return 'critical';
}

// Generate compliance recommendations
function generateComplianceRecommendations(report) {
    const recommendations = [];

    // Medication compliance recommendations
    if (report.overall_medication_compliance) {
        const rate = report.overall_medication_compliance.compliance_rate;
        
        if (rate < 80) {
            recommendations.push({
                type: 'medication',
                priority: 'high',
                title: 'ปรับปรุงการใช้ยาตามกำหนด',
                description: 'อัตราการใช้ยาตามกำหนดยังไม่เหมาะสม ควรตั้งการแจ้งเตือนเพิ่มเติม',
                actions: [
                    'ตั้งการแจ้งเตือนล่วงหน้า 15 นาที',
                    'เพิ่มการแจ้งเตือนซ้ำทุก 5 นาที',
                    'ใช้ฟีเจอร์การแจ้งเตือนตามสถานที่'
                ]
            });
        }

        if (rate >= 80 && rate < 95) {
            recommendations.push({
                type: 'medication',
                priority: 'medium',
                title: 'การใช้ยาอยู่ในเกณฑ์ดี',
                description: 'คงความสม่ำเสมอในการใช้ยาต่อไป',
                actions: [
                    'ทบทวนเวลาการแจ้งเตือนให้เหมาะสมกับกิจวัตร',
                    'ติดตามผลการรักษาอย่างสม่ำเสมอ'
                ]
            });
        }
    }

    // Appointment compliance recommendations
    if (report.appointment_compliance) {
        const rate = report.appointment_compliance.attendance_rate;
        
        if (rate < 90) {
            recommendations.push({
                type: 'appointment',
                priority: 'high',
                title: 'ปรับปรุงการเข้ารับการรักษาตามนัด',
                description: 'ควรเข้ารับการรักษาตามนัดอย่างสม่ำเสมอ',
                actions: [
                    'ตั้งการแจ้งเตือนล่วงหน้า 3 วัน',
                    'เพิ่มการแจ้งเตือนในวันนัดหมาย',
                    'ประสานงานกับทีมแพทย์หากมีข้อจำกัด'
                ]
            });
        }
    }

    return recommendations;
}

// ===========================================
// ENHANCED NOTIFICATION CREATION WITH PUSH
// ===========================================

// Enhanced createEnhancedNotification with push support
const createEnhancedNotificationWithPush = async (userId, type, title, body, priority = 'medium', options = {}) => {
    try {
        const notificationResult = await createEnhancedNotification(userId, type, title, body, priority, options);
        
        if (notificationResult) {
            // Log notification creation
            await logNotificationAction(
                notificationResult.notificationId, 
                userId, 
                'created',
                { channel: 'app', device_info: options.device_info || {} }
            );

            // Send push notification if enabled
            if (notificationResult.pushEnabled) {
                const pushResult = await sendPushNotification(userId, title, body, {
                    tag: type,
                    url: options.actionUrl || '/notifications',
                    notification_id: notificationResult.notificationId,
                    type: type
                });

                if (pushResult && pushResult.some(r => r.success)) {
                    // Update notification as push sent
                    await pool.execute(
                        `UPDATE Notifications 
                         SET push_sent = 1, sent_at = NOW() 
                         WHERE notification_id = ?`,
                        [notificationResult.notificationId]
                    );

                    await logNotificationAction(
                        notificationResult.notificationId, 
                        userId, 
                        'sent',
                        { channel: 'push' }
                    );
                }
            }
        }

        return notificationResult;
        
    } catch (error) {
        console.error('Create enhanced notification with push error:', error);
        return null;
    }
};

// ===========================================
// MEDICATION REMINDERS FOR APPOINTMENT NOTIFICATIONS
// ===========================================

// Enhanced appointment notification creation
const createAppointmentNotificationEnhanced = async (patientId, appointmentData, notificationType = 'new') => {
    try {
        let title, body, priority;
        
        switch (notificationType) {
            case 'new':
                title = '📅 นัดหมายใหม่จากแพทย์';
                body = `คุณได้รับการนัดหมาย${appointmentData.appointment_type} วันที่ ${appointmentData.appointment_date} เวลา ${appointmentData.appointment_time}`;
                priority = 'high';
                break;
            case 'updated':
                title = '📝 การนัดหมายมีการเปลี่ยนแปลง';
                body = `การนัดหมายของคุณได้รับการอัปเดต วันที่ ${appointmentData.appointment_date} เวลา ${appointmentData.appointment_time}`;
                priority = 'medium';
                break;
            case 'cancelled':
                title = '❌ การนัดหมายถูกยกเลิก';
                body = `การนัดหมายวันที่ ${appointmentData.appointment_date} ได้รับการยกเลิก กรุณาติดต่อเจ้าหน้าที่`;
                priority = 'high';
                break;
            case 'reminder':
                const daysUntil = Math.ceil((new Date(appointmentData.appointment_date) - new Date()) / (1000 * 60 * 60 * 24));
                if (daysUntil === 0) {
                    title = '🏥 วันนี้มีนัดหมาย';
                    body = `วันนี้คุณมีนัดหมายกับ${appointmentData.doctor_name ? ` ${appointmentData.doctor_name}` : 'แพทย์'} เวลา ${appointmentData.appointment_time}`;
                } else if (daysUntil === 1) {
                    title = '📋 พรุ่งนี้มีนัดหมาย';
                    body = `พรุ่งนี้คุณมีนัดหมายกับ${appointmentData.doctor_name ? ` ${appointmentData.doctor_name}` : 'แพทย์'} เวลา ${appointmentData.appointment_time}`;
                } else {
                    title = `📅 อีก ${daysUntil} วัน มีนัดหมาย`;
                    body = `อีก ${daysUntil} วัน คุณมีนัดหมายกับ${appointmentData.doctor_name ? ` ${appointmentData.doctor_name}` : 'แพทย์'} วันที่ ${appointmentData.appointment_date}`;
                }
                priority = daysUntil <= 1 ? 'high' : 'medium';
                break;
            default:
                title = '📋 การแจ้งเตือนการนัดหมาย';
                body = 'คุณมีการนัดหมายใหม่';
                priority = 'medium';
        }

        const notificationResult = await createEnhancedNotificationWithPush(
            patientId,
            'appointment_reminder',
            title,
            body,
            priority,
            {
                entityType: 'Appointments',
                entityId: appointmentData.appointment_id,
                actionUrl: '/appointments',
                metadata: {
                    appointment_id: appointmentData.appointment_id,
                    appointment_date: appointmentData.appointment_date,
                    appointment_time: appointmentData.appointment_time,
                    appointment_type: appointmentData.appointment_type,
                    doctor_name: appointmentData.doctor_name,
                    notification_type: notificationType
                }
            }
        );

        console.log(`✅ Created appointment notification for patient ${patientId}: ${title}`);
        return notificationResult;
        
    } catch (error) {
        console.error('❌ Create appointment notification enhanced error:', error);
        return null;
    }
};

// Update the existing checkUpcomingAppointmentsEnhanced to use new function
const checkUpcomingAppointmentsEnhancedWithPush = async () => {
    try {
        console.log('📅 Checking upcoming appointments with push notifications...');
        
        // ตรวจสอบการนัดที่จะถึงใน 1 วัน
        const [tomorrowAppointments] = await pool.execute(
            `SELECT a.*, p.first_name, p.last_name, p.patient_id,
                    d.first_name as doctor_first_name, d.last_name as doctor_last_name,
                    d.specialty
             FROM Appointments a
             JOIN PatientProfiles p ON a.patient_id = p.patient_id
             LEFT JOIN DoctorProfiles d ON a.doctor_id = d.doctor_id
             WHERE a.appointment_status = 'scheduled'
             AND a.appointment_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY)`
        );

        // ตรวจสอบการนัดวันนี้
        const [todayAppointments] = await pool.execute(
            `SELECT a.*, p.first_name, p.last_name, p.patient_id,
                    d.first_name as doctor_first_name, d.last_name as doctor_last_name,
                    d.specialty
             FROM Appointments a
             JOIN PatientProfiles p ON a.patient_id = p.patient_id
             LEFT JOIN DoctorProfiles d ON a.doctor_id = d.doctor_id
             WHERE a.appointment_status = 'scheduled'
             AND a.appointment_date = CURDATE()
             AND TIME(NOW()) >= '08:00:00'
             AND TIME(NOW()) <= '10:00:00'`
        );

        // ส่งการแจ้งเตือนสำหรับการนัดพรุ่งนี้
        for (const appointment of tomorrowAppointments) {
            const appointmentData = {
                appointment_id: appointment.appointment_id,
                appointment_date: appointment.appointment_date,
                appointment_time: appointment.appointment_time,
                appointment_type: appointment.appointment_type,
                doctor_name: appointment.doctor_first_name ? 
                    `${appointment.doctor_first_name} ${appointment.doctor_last_name}` : null
            };

            await createAppointmentNotificationEnhanced(
                appointment.patient_id, 
                appointmentData, 
                'reminder'
            );
        }

        // ส่งการแจ้งเตือนสำหรับการนัดวันนี้
        for (const appointment of todayAppointments) {
            const appointmentData = {
                appointment_id: appointment.appointment_id,
                appointment_date: appointment.appointment_date,
                appointment_time: appointment.appointment_time,
                appointment_type: appointment.appointment_type,
                doctor_name: appointment.doctor_first_name ? 
                    `${appointment.doctor_first_name} ${appointment.doctor_last_name}` : null
            };

            await createAppointmentNotificationEnhanced(
                appointment.patient_id, 
                appointmentData, 
                'reminder'
            );
        }

        console.log(`✅ Processed ${tomorrowAppointments.length} tomorrow appointments and ${todayAppointments.length} today appointments with push notifications`);
        
    } catch (error) {
        console.error('❌ Check upcoming appointments enhanced with push error:', error);
    }
};

// Replace the original cron job
cron.schedule('0 9,18 * * *', checkUpcomingAppointmentsEnhancedWithPush);

// ===========================================
// NOTIFICATION ANALYTICS
// ===========================================

// Get notification analytics
app.get('/api/patient/notification-analytics', authenticateToken, ensurePatient, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { period = '30' } = req.query;

        const [analytics] = await pool.execute(
            `SELECT 
                notification_type,
                COUNT(*) as total_sent,
                SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) as total_read,
                SUM(CASE WHEN push_sent = 1 THEN 1 ELSE 0 END) as total_push_sent,
                AVG(CASE WHEN read_at IS NOT NULL THEN 
                    TIMESTAMPDIFF(MINUTE, created_at, read_at) 
                END) as avg_read_time_minutes,
                ROUND((SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) / COUNT(*)) * 100, 2) as read_rate
             FROM Notifications
             WHERE user_id = ? 
             AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY notification_type
             ORDER BY total_sent DESC`,
            [userId, parseInt(period)]
        );

        res.json({ analytics, period_days: parseInt(period) });

    } catch (error) {
        console.error('Get notification analytics error:', error);
        res.status(500).json({
            message: 'เกิดข้อผิดพลาดของระบบ',
            code: 'INTERNAL_ERROR'
        });
    }
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        message: 'Endpoint not found',
        code: 'NOT_FOUND'
    });
});

// Start server
const startServer = async () => {
    try {
        // Create upload directory if it doesn't exist
        await fs.mkdir('uploads/medical-docs/', { recursive: true });

        // Test database connection
        const dbConnected = await testDbConnection();
        if (!dbConnected) {
            console.error('❌ Cannot start server: Database connection failed');
            process.exit(1);
        }

        app.listen(PORT, () => {
            console.log('🚀 GTMS Complete Backend Server Started!');
            console.log(`📡 Server running on http://localhost:${PORT}`);
            console.log(`🔗 API Base URL: http://localhost:${PORT}/api`);
            console.log(`🔐 Authentication Endpoints:`);
            console.log(`   POST /api/auth/register`);
            console.log(`   POST /api/auth/login`);
            console.log(`   POST /api/auth/refresh`);
            console.log(`   POST /api/auth/logout`);
            console.log(`   GET  /api/auth/me`);
            console.log(`👤 Patient Profile:`);
            console.log(`   GET  /api/patient/profile`);
            console.log(`   PUT  /api/patient/profile`);
            console.log(`   GET  /api/patient/settings`);
            console.log(`   PUT  /api/patient/settings`);
            console.log(`💊 Medication Management:`);
            console.log(`   GET  /api/patient/medications`);
            console.log(`   GET  /api/patient/medication-reminders`);
            console.log(`   POST /api/patient/medication-usage`);
            console.log(`   GET  /api/patient/medication-adherence`);
            console.log(`   GET  /api/patient/medication-inventory`);
            console.log(`👁️  IOP Management:`);
            console.log(`   POST /api/patient/iop-measurement`);
            console.log(`   GET  /api/patient/iop-measurements`);
            console.log(`   GET  /api/patient/iop-analytics`);
            console.log(`📅 Appointments:`);
            console.log(`   GET  /api/patient/appointments`);
            console.log(`   GET  /api/patient/appointment-reminders`);
            console.log(`📋 Medical History:`);
            console.log(`   POST /api/patient/family-history`);
            console.log(`   GET  /api/patient/family-history`);
            console.log(`   POST /api/patient/eye-injury`);
            console.log(`   GET  /api/patient/eye-injury`);
            console.log(`   GET  /api/patient/medical-history`);
            console.log(`🔬 Test Results:`);
            console.log(`   GET  /api/patient/visual-field-tests`);
            console.log(`   GET  /api/patient/visual-field-comparison`);
            console.log(`   GET  /api/patient/special-tests`);
            console.log(`   GET  /api/patient/oct-results`);
            console.log(`📄 Documents:`);
            console.log(`   POST /api/patient/documents`);
            console.log(`   GET  /api/patient/documents`);
            console.log(`   GET  /api/patient/documents/:id/download`);
            console.log(`🔔 Notifications:`);
            console.log(`   GET  /api/patient/notifications`);
            console.log(`   PUT  /api/patient/notifications/:id/read`);
            console.log(`   PUT  /api/patient/notifications/mark-all-read`);
            console.log(`📊 Dashboard & Reports:`);
            console.log(`   GET  /api/patient/dashboard`);
            console.log(`   GET  /api/patient/summary`);
            console.log(`🔧 Other Functions:`);
            console.log(`   PUT  /api/patient/change-password`);
            console.log(`   GET  /api/patient/export-data`);
            console.log(`⏰ ${new Date().toLocaleString('th-TH')}`);
            console.log(`🔄 Automated checks running:`);
            console.log(`   - High IOP monitoring (3x daily)`);
            console.log(`   - Missed medication alerts (every 30min)`);
            console.log(`   - Low inventory alerts (daily)`);
            console.log(`   - Appointment reminders (daily)`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 SIGINT received, shutting down gracefully...');
    await pool.end();
    process.exit(0);
});

startServer();

module.exports = app;