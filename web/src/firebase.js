import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
} from "firebase/auth";
import {
  getFirestore,
} from "firebase/firestore";
import {
  getFunctions,
} from "firebase/functions";
import {
  getStorage,
} from "firebase/storage";
import {
  getMessaging,
  isSupported,
} from "firebase/messaging";

const requiredConfigKeys = [
  "apiKey",
  "authDomain",
  "projectId",
  "storageBucket",
  "messagingSenderId",
  "appId",
];

export async function connectFirebase() {
  if (requiredConfigKeys.some((key) => !__NADRIX_FIREBASE_CONFIG__[key])) {
    throw new Error(
      "Firebase is not configured. Copy web/firebase-config.example.json to web/firebase-config.json, "
      + "fill it with your Firebase Web App settings, and rebuild.",
    );
  }

  const app = initializeApp(__NADRIX_FIREBASE_CONFIG__);
  const auth = getAuth(app);
  await setPersistence(auth, browserLocalPersistence);
  const db = getFirestore(app);
  const functions = getFunctions(app, "asia-south1");
  const storage = getStorage(app);
  let messaging = null;
  if (await isSupported()) {
    messaging = getMessaging(app);
  }
  return { app, auth, db, functions, storage, messaging };
}

export const webPushVapidKey = __NADRIX_WEB_PUSH_VAPID_KEY__;
