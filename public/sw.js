// public/sw.js - Service Worker for Background Notifications

const CACHE_NAME = 'gtms-notifications-v1';
const API_BASE_URL = self.location.origin;

// Install event
self.addEventListener('install', event => {
  console.log('Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll([
        '/',
        '/api/sounds/medication-reminder.mp3',
        '/api/sounds/appointment-alert.mp3',
        '/api/sounds/emergency-alert.mp3',
        '/api/sounds/general-notification.mp3',
        '/api/sounds/iop-warning.mp3'
      ]);
    })
  );
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', event => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Background sync for checking notifications
self.addEventListener('sync', event => {
  if (event.tag === 'background-notification-check') {
    event.waitUntil(checkForNewNotifications());
  }
});

// Push notification event
self.addEventListener('push', event => {
  console.log('Push notification received:', event);
  
  if (event.data) {
    const data = event.data.json();
    event.waitUntil(showNotification(data));
  }
});

// Notification click event
self.addEventListener('notificationclick', event => {
  console.log('Notification clicked:', event);
  
  event.notification.close();
  
  event.waitUntil(
    clients.matchAll().then(clientList => {
      // ถ้ามีหน้าต่างเปิดอยู่แล้ว ให้ focus
      for (const client of clientList) {
        if (client.url === API_BASE_URL && 'focus' in client) {
          return client.focus();
        }
      }
      
      // ถ้าไม่มี ให้เปิดหน้าใหม่
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

// Message event from main thread
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CHECK_NOTIFICATIONS') {
    event.waitUntil(checkForNewNotifications());
  }
});

// Function to check for new notifications
async function checkForNewNotifications() {
  try {
    // This would typically fetch from your API
    // For now, we'll simulate checking
    console.log('Checking for new notifications...');
    
    // สามารถเพิ่ม logic สำหรับตรวจสอบการแจ้งเตือนใหม่ที่นี่
    // เช่น ตรวจสอบเวลาการหยอดยา, นัดหมาย, etc.
    
    return Promise.resolve();
  } catch (error) {
    console.error('Error checking notifications:', error);
  }
}

// Function to show notification
async function showNotification(data) {
  const options = {
    body: data.body || 'คุณมีการแจ้งเตือนใหม่',
    icon: '/favicon.ico',
    badge: '/badge-icon.png',
    image: data.image,
    data: data,
    tag: data.tag || 'gtms-notification',
    requireInteraction: data.priority === 'high' || data.priority === 'urgent',
    actions: [
      {
        action: 'view',
        title: 'ดูรายละเอียด',
        icon: '/action-view.png'
      },
      {
        action: 'dismiss',
        title: 'ปิด',
        icon: '/action-dismiss.png'
      }
    ],
    vibrate: data.vibration_enabled ? [200, 100, 200] : undefined,
    silent: !data.sound_enabled
  };

  // Play sound if enabled
  if (data.sound_enabled && data.sound_file) {
    try {
      // Note: Service Worker cannot directly play audio
      // Sound will be handled by the main thread
      self.registration.showNotification(data.title || 'การแจ้งเตือน', options);
      
      // Send message to main thread to play sound
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'PLAY_NOTIFICATION_SOUND',
          soundFile: data.sound_file,
          volume: data.volume || 0.8
        });
      });
    } catch (error) {
      console.error('Error playing notification sound:', error);
      self.registration.showNotification(data.title || 'การแจ้งเตือน', options);
    }
  } else {
    self.registration.showNotification(data.title || 'การแจ้งเตือน', options);
  }
}

// Periodic background check (if supported)
if ('serviceWorker' in navigator && 'sync' in window.ServiceWorkerRegistration.prototype) {
  // Register for background sync
  self.addEventListener('sync', event => {
    if (event.tag === 'medication-reminder-check') {
      event.waitUntil(checkMedicationReminders());
    }
  });
}

// Function to check medication reminders
async function checkMedicationReminders() {
  try {
    console.log('Checking medication reminders...');
    
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM format
    const currentDay = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
    
    // This would typically check stored reminders
    // For demonstration, we'll show how it could work
    
    // Example: If it's 8:00 AM and user has medication reminder
    if (currentTime === '08:00') {
      await showNotification({
        title: 'เวลาหยอดยาตา',
        body: 'ถึงเวลาหยอดยาตาแล้ว กรุณาหยอดยาตามที่แพทย์สั่ง',
        sound_enabled: true,
        sound_file: 'medication-reminder.mp3',
        vibration_enabled: true,
        priority: 'medium',
        tag: 'medication-reminder'
      });
    }
    
  } catch (error) {
    console.error('Error checking medication reminders:', error);
  }
}

// Handle fetch events (for caching)
self.addEventListener('fetch', event => {
  // Cache sound files
  if (event.request.url.includes('/api/sounds/')) {
    event.respondWith(
      caches.match(event.request).then(response => {
        return response || fetch(event.request);
      })
    );
  }
});