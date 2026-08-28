importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDrFnhFaTJ41H2n5l5lVXT8XONJF1m10fo",
  authDomain: "air-watch-2635a.firebaseapp.com",
  databaseURL: "https://air-watch-2635a-default-rtdb.firebaseio.com",
  projectId: "air-watch-2635a",
  storageBucket: "air-watch-2635a.firebasestorage.app",
  messagingSenderId: "295549508237",
  appId: "1:295549508237:web:2fd5297bc7efc58576a0c4"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Notificación recibida:', payload);
  
  const notificationTitle = payload.notification.title || '⚠️ Alerta de Calidad del Aire';
  const notificationOptions = {
    body: payload.notification.body || 'Se ha detectado un cambio en la calidad del aire.'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});