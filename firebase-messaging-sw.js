// This file must live at the ROOT of the site (same folder as index.html)
// so the browser can register it with scope "/". It receives push
// messages while the app/tab is closed or in the background.

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBXhWZf6e7V9mmKhFoG1wJzCKHcbwpj2Qo",
  authDomain: "armynoisymanagerapp.firebaseapp.com",
  projectId: "armynoisymanagerapp",
  storageBucket: "armynoisymanagerapp.firebasestorage.app",
  messagingSenderId: "95639638697",
  appId: "1:95639638697:web:17b0de353bbdac0a588fb8"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'ARMY NOÏSY';
  const options = {
    body: (payload.notification && payload.notification.body) || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png'
  };
  self.registration.showNotification(title, options);
});
