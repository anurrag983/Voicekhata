package com.voicekhata.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;

/** Hands the system assistant gesture to the VoiceKhata screen. */
public final class VoiceKhataSession extends VoiceInteractionSession {
    public VoiceKhataSession(VoiceKhataSessionService service) {
        super(service);
    }

    @Override
    public void onPrepareShow(Bundle args, int showFlags) {
        super.onPrepareShow(args, showFlags);
        // VoiceKhata uses its own app screen as the assistant surface. Avoid
        // briefly showing Android's otherwise-empty default assistant panel.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) setUiEnabled(false);
    }

    @Override
    public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        Intent intent = new Intent(getContext(), MainActivity.class);
        intent.setAction(Intent.ACTION_ASSIST);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Android 8+ requires assistant activities to be launched through
            // this API when the system invokes us from a background gesture.
            startAssistantActivity(intent);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            startVoiceActivity(intent);
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        hide();
    }
}
