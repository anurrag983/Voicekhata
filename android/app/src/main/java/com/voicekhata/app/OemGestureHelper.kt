package com.voicekhata.app

import android.content.Intent
import android.provider.Settings
import java.util.Locale

/** Gives version-qualified guidance; Android exposes no universal key-remap intent. */
object OemGestureHelper {
    @JvmOverloads
    @JvmStatic
    fun instructions(manufacturerValue: String = android.os.Build.MANUFACTURER.orEmpty()): String {
        val manufacturer = manufacturerValue.lowercase(Locale.ROOT)
        return when {
            manufacturer.contains("samsung") ->
                "Samsung: Settings → Advanced features → Side button → Press and hold → Digital assistant. Menu names vary by One UI version."
            manufacturer.contains("xiaomi") || manufacturer.contains("redmi") || manufacturer.contains("poco") ->
                "Xiaomi/Redmi/POCO: Settings → Additional settings → Gesture shortcuts (or Button shortcuts) → Launch assistant. Menu names vary by MIUI/HyperOS version."
            manufacturer.contains("oneplus") ->
                "OnePlus: Settings → Additional settings or System settings → Power button → Press and hold → Voice assistant. Menu names vary by OxygenOS version."
            manufacturer.contains("oppo") || manufacturer.contains("realme") ->
                "OPPO/realme: Settings → System settings or Convenience tools → Power button / Side button → Voice assistant. Menu names vary by ColorOS version."
            manufacturer.contains("google") || manufacturer.contains("motorola") ->
                "Pixel/Motorola: Settings → System → Gestures → Press and hold power button → Digital assistant. Menu names vary by Android version."
            else ->
                "Open Settings and search for “assistant”, “power button”, or “side button”. The available shortcut depends on your phone model and Android version."
        }
    }

    @JvmStatic
    fun settingsIntent(): Intent = Intent(Settings.ACTION_SETTINGS)
}
