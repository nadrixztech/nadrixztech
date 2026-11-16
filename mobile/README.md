# NADRIX mobile app

The Flutter app targets Android and iOS and uses the Firebase project and Cloud
Functions described in the [project setup guide](../README.md/README.md).

Run `flutter pub get`, then `flutter run` with the Firebase `--dart-define`
values documented in that guide. Android release builds require a private
upload keystore configured in `android/key.properties`; iOS release builds
require Xcode, CocoaPods, and Apple signing. Never commit Firebase platform
configuration files, signing keys, or passwords.
