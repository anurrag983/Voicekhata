# WebView invokes these bridge methods by their JavaScript interface names.
-keepclassmembers class com.voicekhata.app.MainActivity$NativeVoiceBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Android creates these components from manifest/service metadata.
-keep public class com.voicekhata.app.VoiceKhataVoiceInteractionService
-keep public class com.voicekhata.app.VoiceKhataSessionService
-keep public class com.voicekhata.app.VoiceKhataSession
