import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { build } from "esbuild";

const configPath = existsSync("web/firebase-config.json")
  ? "web/firebase-config.json"
  : "web/firebase-config.example.json";
const config = JSON.parse(await readFile(configPath, "utf8"));
const firebaseConfig = config.firebaseConfig;
const requiredKeys = [
  "apiKey",
  "authDomain",
  "projectId",
  "storageBucket",
  "messagingSenderId",
  "appId",
];
if (!firebaseConfig || requiredKeys.some((key) => typeof firebaseConfig[key] !== "string")) {
  throw new Error(`Firebase configuration is missing or invalid in ${configPath}.`);
}

await build({
  entryPoints: ["web/src/main.js"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: "firebase-web.bundle.js",
  define: {
    __NADRIX_FIREBASE_CONFIG__: JSON.stringify(firebaseConfig),
    __NADRIX_WEB_PUSH_VAPID_KEY__: JSON.stringify(config.webPushVapidKey || ""),
  },
});

await build({
  entryPoints: ["web/src/firebase-messaging-sw.js"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: "firebase-messaging-sw.js",
  define: {
    __NADRIX_FIREBASE_CONFIG__: JSON.stringify(firebaseConfig),
  },
});
