# VoiceKhata for Android

This folder is the native Android companion for the existing VoiceKhata web UI and FastAPI API. The native layer registers VoiceKhata as an Android assistant, receives the system assistant invocation, and starts a short native 16 kHz WAV recording after the authenticated workspace is ready. It hands that clip to the existing Gnani transcription and customer/amount confirmation flow; the backend creates a ledger entry only after confirmation.

## Compatibility

- The app's minimum Android API is 24 (Android 7.0).
- Android 10/API 29 and newer use `RoleManager` to request the assistant role.
- Older supported Android releases open the system voice-input settings for assistant selection.
- Whether a power-button long-press can invoke a selected assistant depends on Android version, manufacturer, and device settings. The VoiceKhata launcher icon remains the fallback quick action.
- The microphone is requested during first-run setup and used only during an explicit assistant invocation or in-app recording. The app does not keep an always-listening microphone service.
- Assistant-triggered recording is mono 16 kHz PCM WAV, ends after 1.5 seconds of detected silence, and has a 20-second maximum. The user can stop or cancel it on screen.
- When Android allows the selected assistant to start from the keyguard, VoiceKhata can show a recording-only surface there. It requests device authentication before opening the shop ledger; it does not bypass or dismiss the user's credential without approval. Ledger information is not shown over the keyguard.
- Offline transcription/ledger sync is not implemented: Gnani transcription and transaction confirmation require a network connection. No transaction is auto-saved from an offline recording.

## Backend address requirement

Android WebView needs a secure HTTPS origin for browser microphone capture. In the first-run setup, use the hosted **frontend** URL (currently `https://voicekhata-frontend.vercel.app`). The frontend's `VOICEKHATA_API_BASE_URL` setting points to the hosted FastAPI backend (`https://voicekhata-gxd0.onrender.com`), and the backend must allow the exact frontend origin in `CORS_ORIGINS`. Keep `GNANI_API_KEY` on the backend; do not put it in the APK.

The Android app remembers the frontend URL on the device; API traffic then goes to the configured backend. Plain HTTP is rejected so WebView microphone capture and ledger traffic use a secure origin.

## Build

Open this `android/` folder in Android Studio with JDK 17 or newer and Android SDK Platform 35 installed. Android Studio can download the required Gradle and Kotlin plugin components. Build the `app` debug variant to produce an installable APK. The project targets API 35 and runs on Android 7+; the system assistant role request is available from Android 10/API 29.

## Assistant setup on a phone

1. Install and open VoiceKhata. The first-run checklist is prefilled with the current Vercel frontend URL.
2. Tap **Allow microphone access** and accept Android's permission prompt.
3. Tap **Choose VoiceKhata** and accept Android's assistant-role prompt.
4. Follow the phone-brand instructions under **Turn on your phone button gesture**. Android has no universal settings deep link for the power/side-button shortcut, so VoiceKhata opens Settings and shows the right menu path for the detected phone brand.
5. Tap **Save and open VoiceKhata**, sign in, then long-press the configured assistant button. A native recorder opens, then VoiceKhata transcribes the WAV with Gnani and asks its existing voice conversation to resolve the customer and confirm before saving.

The system assistant role is available from Android 10/API 29. On Android 8/API 26 through Android 9, the app uses Android's voice-input settings and assistant-activity launch support. Whether a power-button long-press is assignable, and whether an assistant can be invoked from the keyguard, depends on the phone maker and its settings; if unavailable, use the home-screen icon or a launcher shortcut. Android does not provide a universal OEM settings deep link, and an APK cannot force key remapping. Device authentication remains in control before shop data is opened.

## Build from a terminal

From this `android/` directory, run `./gradlew assembleDebug` for the installable debug APK, then install it with `adb install -r app/build/outputs/apk/debug/app-debug.apk`. `./gradlew assembleRelease` enables R8 shrinking/optimization and writes an unsigned release APK; configure a private signing keystore before distributing a production build.
