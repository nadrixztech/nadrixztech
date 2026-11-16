'use strict';

try {
  importScripts('./firebase-messaging-sw.js');
} catch (error) {
  console.error('Firebase background messaging is unavailable until the web bundle is built.', error);
}

const CACHE_NAME = 'nadrix-shell-v2';
const SHELL_FILES = [
  './',
  './nadrix.html',
  './style.css',
  './firebase-web.bundle.js',
  './firebase-messaging-sw.js',
  './manifest.webmanifest',
  './assets/app-icon.svg',
  './assets/logo.png/1.png',
  './assets/logo.png/hero-banner.jpg/4.png',
  './assets/logo.png/business-website.jpg/business-website.jpg.png',
  './assets/logo.png/student-project.png/student%20project.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('nadrix-shell-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put('./nadrix.html', copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('./nadrix.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
