# NADRIX ZTECHNOLOGY

NADRIX contains a responsive Firebase-backed website/PWA, Firebase Cloud Functions, and a Flutter application for Android and iOS. Firebase Authentication, Cloud Firestore, Cloud Storage, Cloud Messaging, and callable Functions are the authoritative application backend. The older Python/SQLite API remains in the repository for compatibility; it is not used by the current Firebase website or mobile app.

## Requirements

- Node.js 22 and npm
- Flutter 3.38 or newer with Dart 3.10 or newer
- A Firebase project and the Firebase CLI
- Java 21 or newer to run the Firebase Emulator Suite
- Android Studio/Android SDK for Android builds
- Full Xcode and CocoaPods for iOS builds (the Firebase plugins require iOS 15 or newer)

## Create and configure Firebase

1. Create a Firebase project and choose **asia-south1 (Mumbai)** for Firestore and Cloud Functions. The project ID and all Firebase app configuration must come from your Firebase Console; this repository intentionally contains no real credentials.
2. Enable Email/Password, Google, and Phone providers under **Authentication → Sign-in method**. Configure authorized web domains, Google OAuth consent, Android SHA fingerprints, and iOS URL schemes as required by Firebase and Google Sign-In.
3. Create Firestore and Storage. Deploy the included security rules and indexes with `npm run deploy` after selecting the Firebase project.
4. Register a Firebase Web App and copy its configuration into `web/firebase-config.json`, using `web/firebase-config.example.json` as the shape. Add the Web Push certificate key from Firebase Cloud Messaging if browser push notifications are needed.
5. Add the generated Android `google-services.json` at `mobile/android/app/google-services.json` and iOS `GoogleService-Info.plist` at `mobile/ios/Runner/GoogleService-Info.plist` when configuring Google Sign-In and APNs. These files are local configuration and are ignored by Git.
6. Configure Cloud Messaging credentials for each platform. iOS push requires an Apple Developer account and APNs authentication key uploaded to Firebase. Cloud Functions/Storage deployment may require the Firebase Blaze billing plan.

Firebase Web API keys and app IDs identify a Firebase project; they are not server secrets. Never put service-account private keys or other admin credentials in this client application.

## Website

Install dependencies and build the Firebase web bundle:

```bash
npm install
cp web/firebase-config.example.json web/firebase-config.json
# Edit web/firebase-config.json with the Web App values from Firebase Console.
npm run build:web
```

For local development, serve the repository root over localhost after building:

```bash
python3 server.py
```

Open `http://127.0.0.1:8000`. Firebase account, project, and service-request features require the web configuration above. The root Firebase Hosting route serves `nadrix.html`; the built bundle also generates the Firebase Messaging service-worker code.

## Flutter app

Install Flutter packages from `mobile/`:

```bash
cd mobile
flutter pub get
```

Supply the Firebase app values as Dart defines when running or building. Use values from the same Firebase project; do not commit them into source:

```bash
flutter run \
  --dart-define=FIREBASE_API_KEY=YOUR_FIREBASE_API_KEY \
  --dart-define=FIREBASE_APP_ID=YOUR_PLATFORM_APP_ID \
  --dart-define=FIREBASE_MESSAGING_SENDER_ID=YOUR_SENDER_ID \
  --dart-define=FIREBASE_PROJECT_ID=YOUR_PROJECT_ID \
  --dart-define=FIREBASE_STORAGE_BUCKET=YOUR_STORAGE_BUCKET
```

For Google Sign-In, provide `GOOGLE_SERVER_CLIENT_ID` if your platform configuration requires it, register the Android app as `com.nadrixztechnology.app`, add Android SHA fingerprints, and configure the iOS OAuth URL scheme.

For Android release signing, create and securely back up your own upload keystore, then create `mobile/android/key.properties` (ignored by Git) with `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`. The `storeFile` path is relative to `mobile/android`. The Android release build uses this release key and never falls back to the debug key. Keep the keystore and passwords private and back them up outside this repository.

Use the same Firebase `--dart-define` values shown above with `flutter build appbundle --release` for Google Play or `flutter build ipa --release` for the App Store. Release builds require the Android upload keystore or Apple signing/provisioning profiles and the owner’s developer accounts. Apple builds additionally require full Xcode and CocoaPods.

The mobile app provides email/password registration and login, password reset, Google Sign-In, phone verification, profile controls, service requests, request history, in-app notifications, push enrollment, and admin service/project/user/request tools. Native push delivery depends on Firebase/APNs setup. App Store and Play Store submission require the owner’s developer accounts and signing credentials.

## Delivery checklist

- [x] Responsive website/PWA, Firebase Functions backend, Firestore and Storage rules, and Android/iOS Flutter source are implemented.
- [x] Local Functions, rules-emulator, Python API, Flutter analysis/widget, and responsive browser checks pass.
- [x] Android release configuration no longer signs releases with the debug key; native app icons use the NADRIX artwork.
- [ ] Create/select the Firebase project, configure sign-in providers, add Web/Android/iOS app settings, set the bootstrap admin email, and deploy rules, indexes, Functions, and Hosting.
- [ ] Configure Android SDK and owner-managed upload keystore; build and test signed APK/AAB on supported devices.
- [ ] Install full Xcode and CocoaPods; configure Apple Developer signing, APNs, privacy disclosures, and App Store Connect; build and test a signed archive.
- [ ] Supply the public domain, business support/contact details, privacy-policy URL, store listing text, and device screenshots; then complete store review and production rollout.

## First administrator

Choose the initial administrator email when deploying Functions. Firebase CLI prompts for the `INITIAL_ADMIN_EMAIL` parameter; enter an address that is registered in Firebase Authentication and has completed email verification. Sign in with that account and select **Set up first administrator** in the website or mobile profile. This is a one-time bootstrap protected by a server-side lock; subsequent role changes are available only to admins.

## Deployment

Select the Firebase project first:

```bash
firebase login
firebase use --add
npm run deploy
```

The deploy command checks for a completed Web App configuration and builds the website before deploying Hosting, Firestore rules/indexes, Storage rules, and Functions. `npm run deploy:web` deploys Hosting only. Do not deploy until the project, authentication providers, billing, and platform-specific settings are ready.

## Validation

From the repository root:

```bash
npm run build:web
npm run build:functions
npm run test:functions
npm run test:rules
python3 -m unittest discover -s tests -v
```

For the Flutter source:

```bash
cd mobile
flutter analyze
flutter test
```

The Firestore and Storage rules tests use Firebase emulators and require a supported Java runtime. Native build commands also require the corresponding Android or Apple toolchains and Firebase app configuration.

## Backend boundaries

- Callable Functions validate and create requests, update statuses, manage roles and account state, bootstrap the first admin, and delete user-owned data.
- Clients cannot create or change orders directly. Custom admin claims and active profiles are required for administrative access.
- Role changes, account disabling, and deletion guard the final active administrator transactionally. Account deletion disables the profile before cleanup and can be retried if cleanup is interrupted.
- Firestore and Storage rules constrain profile changes, public catalogs, uploaded file types/sizes, and user-owned data.
- Request creation requires a verified email or verified Firebase phone sign-in. Passwords and authentication credentials are managed by Firebase Authentication.
- Do not use the retained SQLite server as a production Firebase backend; it is a separate legacy implementation.
