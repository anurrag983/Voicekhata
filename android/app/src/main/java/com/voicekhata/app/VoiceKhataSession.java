package com.voicekhata.app;

import android.content.Intent;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;

/** Hands the system assistant gesture to the VoiceKhata screen. */
public final class VoiceKhataSession extends VoiceInteractionSession {
    public VoiceKhataSession(VoiceKhataSessionService service) {
        super(service);
    }

    @Override
    public void onShow(Bundle args, int showFlags) {
        super.onShow(args, showFlags);
        Intent intent = new Intent(getContext(), MainActivity.class);
        intent.setAction(Intent.ACTION_ASSIST);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        getContext().startActivity(intent);
        hide();
    }
}
