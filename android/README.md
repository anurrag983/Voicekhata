# VoiceKhata for Android

This folder is the native Android companion for the existing VoiceKhata web UI and FastAPI API. The native layer registers VoiceKhata as an Android assistant, receives the system assistant invocation, requests microphone permission, and asks the web UI to begin its normal confirmed voice-entry flow.

## Compatibility

- The app's minimum Android API is 21 (Android 5.0), matching the introduction of `VoiceInteractionService`.
- Android 10/API 29 and newer use `RoleManager` to request the assistant role.
- Older supported Android releases open the system voice-input settings for assistant selection.
- Whether a power-button long-press can invoke a selected assistant depends on Android version, manufacturer, and device settings. The VoiceKhata launcher icon remains the fallback quick action.
- The microphone is requested only after the app is opened by the user or Android assistant gesture. The app does not keep an always-listening microphone service.

## Backend address requirement

The web app and API currently run together on the development Mac. A phone cannot use the Mac's `127.0.0.1` address, and Android WebView needs a secure HTTPS origin for browser microphone capture. Before a usable phone APK can connect to the shop database, serve the FastAPI app at a stable HTTPS address and enter that root URL in the app's first-run setup. Keep `GNANI_API_KEY` on that backend; do not put it in the APK.

The configured root should serve both the frontend and `/api/v1/...` endpoints from the same HTTPS origin. The Android app remembers this root URL on the device. Plain HTTP is rejected so WebView microphone capture and ledger traffic use a secure origin.

## Build

Open this `android/` folder in Android Studio with JDK 17 and Android SDK Platform 36 installed. Android Studio can download the required Gradle plugin and SDK components. Build the `app` debug variant to produce an installable APK. This workspace currently has no Android SDK, ADB, or Gradle installation, so an APK cannot be compiled or device-tested here yet.

## Assistant setup on a phone

1. Install and open VoiceKhata.
2. Enter the hosted HTTPS root URL, sign in, and allow microphone access when asked.
3. Tap **Phone assistant** in the app and choose VoiceKhata in Android's system dialog/settings.
4. If the phone offers assistant invocation for a power-button long-press, select that action in the phone's own button settings.
5. Long-press the configured button. VoiceKhata opens and starts the existing Hindi/Hinglish voice flow; the app confirms the transaction before saving it.

If Android does not offer a hardware assistant gesture, open VoiceKhata from its home-screen icon. Hardware-key remapping is controlled by each manufacturer and cannot be forced by an APK.
