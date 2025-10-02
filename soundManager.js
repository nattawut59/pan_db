// soundManager.js - ระบบจัดการเสียงแจ้งเตือน GTMS
const fs = require('fs');
const path = require('path');

// 🎵 การกำหนดค่าเสียงแจ้งเตือน
const SOUND_CONFIG = {
    // ไดเรกทอรีเสียง
    BASE_SOUND_DIR: path.join(__dirname, 'assets', 'sounds'),
    
    // ภาษาที่รองรับ
    SUPPORTED_LANGUAGES: ['th', 'en'],
    
    // ประเภทเสียง
    SOUND_TYPES: {
        medication: {
            files: {
                th: 'medication.mp3',
                en: 'medication.mp3',
                beep: 'soft-beep.mp3'
            },
            description: 'เสียงแจ้งเตือนยา - นุ่มนวล',
            volume: 0.7,
            priority: 'medium',
            vibration: [200, 100, 200]
        },
        appointment: {
            files: {
                th: 'appointment.mp3', 
                en: 'appointment.mp3',
                beep: 'clear-beep.mp3'
            },
            description: 'เสียงแจ้งเตือนนัดหมาย - ชัดเจน',
            volume: 0.8,
            priority: 'high',
            vibration: [300, 200, 300]
        },
        emergency: {
            files: {
                th: 'emergency.mp3',
                en: 'emergency.mp3', 
                beep: 'urgent-beep.mp3'
            },
            description: 'เสียงแจ้งเตือนฉุกเฉิน - เร่งด่วน',
            volume: 1.0,
            priority: 'urgent',
            vibration: [500, 100, 500, 100, 500]
        },
        general: {
            files: {
                th: 'general.mp3',
                en: 'general.mp3',
                beep: 'general-beep.mp3'
            },
            description: 'เสียงแจ้งเตือนทั่วไป - อ่อนโยน',
            volume: 0.6,
            priority: 'low',
            vibration: [150, 100, 150]
        },
        iop_warning: {
            files: {
                th: 'iop-warning.mp3',
                en: 'iop-warning.mp3',
                beep: 'warning-beep.mp3'
            },
            description: 'เสียงแจ้งเตือน IOP สูง - เตือน',
            volume: 0.9,
            priority: 'high',
            vibration: [400, 150, 400]
        }
    }
};

// 🗣️ ข้อความสำหรับ Text-to-Speech (สำรอง)
const SPEECH_MESSAGES = {
    medication: {
        th: 'ถึงเวลาหยอดยาตาแล้วครับ กรุณาหยอดยาตามที่แพทย์สั่ง',
        en: 'Time for your eye drops medication'
    },
    appointment: {
        th: 'คุณมีนัดหมายกับแพทย์ กรุณาเตรียมตัวมาโรงพยาบาล',
        en: 'You have an appointment with your doctor'
    },
    emergency: {
        th: 'กรุณาตรวจสอบค่าความดันลูกตาและติดต่อแพทย์ทันที',
        en: 'Please check your eye pressure and contact your doctor immediately'
    },
    general: {
        th: 'คุณมีการแจ้งเตือนใหม่ กรุณาตรวจสอบ',
        en: 'You have a new notification'
    },
    iop_warning: {
        th: 'ค่าความดันลูกตาสูงกว่าปกติ กรุณาพักผ่อนและติดต่อแพทย์',
        en: 'Your eye pressure is higher than normal. Please rest and contact your doctor'
    }
};

class SoundManager {
    constructor() {
        this.config = SOUND_CONFIG;
        this.speechMessages = SPEECH_MESSAGES;
        this.initializeSoundDirectories();
    }

    // 📁 สร้างโฟลเดอร์เสียงถ้ายังไม่มี
    initializeSoundDirectories() {
        try {
            // สร้างโฟลเดอร์หลัก
            if (!fs.existsSync(this.config.BASE_SOUND_DIR)) {
                fs.mkdirSync(this.config.BASE_SOUND_DIR, { recursive: true });
                console.log(`📁 Created main sound directory: ${this.config.BASE_SOUND_DIR}`);
            }

            // สร้างโฟลเดอร์ย่อย
            const subDirs = ['th', 'en', 'beeps'];
            subDirs.forEach(dir => {
                const fullPath = path.join(this.config.BASE_SOUND_DIR, dir);
                if (!fs.existsSync(fullPath)) {
                    fs.mkdirSync(fullPath, { recursive: true });
                    console.log(`📁 Created directory: ${fullPath}`);
                }
            });

            console.log('✅ Sound directories initialized successfully');
        } catch (error) {
            console.error('❌ Error creating sound directories:', error);
        }
    }

    // 🎵 รับ URL ของไฟล์เสียง
    getSoundUrl(type, language = 'th', fallback = 'beep') {
        try {
            const soundType = this.config.SOUND_TYPES[type];
            if (!soundType) {
                console.warn(`⚠️ Unknown sound type: ${type}`);
                return this.getSoundUrl('general', language, fallback);
            }

            // ลองใช้ภาษาที่ระบุ
            if (soundType.files[language]) {
                const filename = soundType.files[language];
                const fullPath = path.join(this.config.BASE_SOUND_DIR, language, filename);
                
                if (fs.existsSync(fullPath)) {
                    return `/api/sounds/${language}/${filename}`;
                }
            }

            // ใช้ fallback
            if (fallback && soundType.files[fallback]) {
                const filename = soundType.files[fallback];
                const fallbackDir = fallback === 'beep' ? 'beeps' : fallback;
                const fullPath = path.join(this.config.BASE_SOUND_DIR, fallbackDir, filename);
                
                if (fs.existsSync(fullPath)) {
                    return `/api/sounds/${fallbackDir}/${filename}`;
                }
            }

            console.warn(`⚠️ No sound file found for type: ${type}, language: ${language}`);
            return null;
        } catch (error) {
            console.error(`❌ Error getting sound URL for ${type}:`, error);
            return null;
        }
    }

    // 🔊 รับข้อมูลเสียงแบบครบถ้วน
    getSoundConfig(type, language = 'th') {
        const soundType = this.config.SOUND_TYPES[type];
        if (!soundType) {
            return null;
        }

        return {
            type: type,
            url: this.getSoundUrl(type, language),
            volume: soundType.volume,
            priority: soundType.priority,
            vibration: soundType.vibration,
            description: soundType.description,
            speechText: this.speechMessages[type] ? this.speechMessages[type][language] : null
        };
    }

    // 📱 รับ vibration pattern
    getVibrationPattern(type) {
        const soundType = this.config.SOUND_TYPES[type];
        return soundType ? soundType.vibration : [200, 100, 200];
    }

    // 🗣️ รับข้อความสำหรับ Text-to-Speech
    getSpeechText(type, language = 'th') {
        if (this.speechMessages[type] && this.speechMessages[type][language]) {
            return this.speechMessages[type][language];
        }
        return null;
    }

    // 📋 รับรายการเสียงทั้งหมด
    getAllSoundTypes() {
        return Object.keys(this.config.SOUND_TYPES).map(type => ({
            type: type,
            config: this.getSoundConfig(type),
            ...this.config.SOUND_TYPES[type]
        }));
    }

    // ✅ ตรวจสอบว่าไฟล์เสียงมีอยู่จริง
    checkSoundFile(type, language = 'th') {
        try {
            const soundType = this.config.SOUND_TYPES[type];
            if (!soundType || !soundType.files[language]) {
                return false;
            }

            const filename = soundType.files[language];
            const dir = language === 'beep' ? 'beeps' : language;
            const fullPath = path.join(this.config.BASE_SOUND_DIR, dir, filename);
            
            return fs.existsSync(fullPath);
        } catch (error) {
            console.error(`Error checking sound file: ${error}`);
            return false;
        }
    }

    // 📊 รายงานสถานะไฟล์เสียง
    getSoundStatus() {
        const status = {
            totalTypes: Object.keys(this.config.SOUND_TYPES).length,
            missingFiles: [],
            availableFiles: [],
            summary: {}
        };

        Object.keys(this.config.SOUND_TYPES).forEach(type => {
            status.summary[type] = {};
            
            ['th', 'en', 'beep'].forEach(lang => {
                const exists = this.checkSoundFile(type, lang);
                status.summary[type][lang] = exists;
                
                if (exists) {
                    status.availableFiles.push(`${type}-${lang}`);
                } else {
                    status.missingFiles.push(`${type}-${lang}`);
                }
            });
        });

        return status;
    }

    // 🔧 ตั้งค่าระดับเสียง
    setVolume(type, volume) {
        if (this.config.SOUND_TYPES[type]) {
            this.config.SOUND_TYPES[type].volume = Math.max(0, Math.min(1, volume));
            return true;
        }
        return false;
    }

    // 📝 บันทึกการตั้งค่า
    saveConfig() {
        try {
            const configPath = path.join(__dirname, 'sound-config.json');
            fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
            console.log('✅ Sound configuration saved');
            return true;
        } catch (error) {
            console.error('❌ Error saving sound configuration:', error);
            return false;
        }
    }

    // 📖 โหลดการตั้งค่า
    loadConfig() {
        try {
            const configPath = path.join(__dirname, 'sound-config.json');
            if (fs.existsSync(configPath)) {
                const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                this.config = { ...this.config, ...savedConfig };
                console.log('✅ Sound configuration loaded');
                return true;
            }
        } catch (error) {
            console.error('❌ Error loading sound configuration:', error);
        }
        return false;
    }
}

// 🎵 สร้าง instance และ export
const soundManager = new SoundManager();

// 📤 Export functions สำหรับใช้ใน Express
module.exports = {
    soundManager,
    
    // Middleware สำหรับ serve ไฟล์เสียง
    serveSoundFile: (req, res) => {
        try {
            const { lang, filename } = req.params;
            
            // Security check
            const allowedLangs = ['th', 'en', 'beeps'];
            const allowedExtensions = ['.mp3', '.wav', '.ogg'];
            
            if (!allowedLangs.includes(lang)) {
                return res.status(400).json({ error: 'Invalid language' });
            }
            
            const ext = path.extname(filename).toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                return res.status(400).json({ error: 'Invalid file type' });
            }
            
            const filePath = path.join(soundManager.config.BASE_SOUND_DIR, lang, filename);
            
            if (fs.existsSync(filePath)) {
                // ตั้งค่า headers สำหรับไฟล์เสียง
                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 1 วัน
                res.setHeader('Accept-Ranges', 'bytes');
                
                res.sendFile(filePath);
            } else {
                res.status(404).json({ error: 'Sound file not found' });
            }
        } catch (error) {
            console.error('Error serving sound file:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    },
    
    // API endpoints
    getSoundConfig: (type, language) => soundManager.getSoundConfig(type, language),
    getAllSoundTypes: () => soundManager.getAllSoundTypes(),
    getSoundStatus: () => soundManager.getSoundStatus(),
    getVibrationPattern: (type) => soundManager.getVibrationPattern(type),
    getSpeechText: (type, language) => soundManager.getSpeechText(type, language)
};

console.log('🎵 Sound Manager initialized');
console.log('📁 Base sound directory:', soundManager.config.BASE_SOUND_DIR);
console.log('🔊 Available sound types:', Object.keys(soundManager.config.SOUND_TYPES));