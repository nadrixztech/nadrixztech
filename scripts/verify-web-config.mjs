import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const configPath = "web/firebase-config.json";
if (!existsSync(configPath)) {
  throw new Error(`Create ${configPath} from web/firebase-config.example.json before deploying.`);
}

const { firebaseConfig } = JSON.parse(await readFile(configPath, "utf8"));
const requiredKeys = [
  "apiKey",
  "authDomain",
  "projectId",
  "storageBucket",
  "messagingSenderId",
  "appId",
];
if (!firebaseConfig || requiredKeys.some((key) => !firebaseConfig[key])) {
  throw new Error(`Complete all Firebase Web App fields in ${configPath} before deploying.`);
}
