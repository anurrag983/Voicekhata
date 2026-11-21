package com.voicekhata.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.app.role.RoleManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final int REQUEST_MICROPHONE = 7301;
    private static final int REQUEST_ASSISTANT_ROLE = 7302;
    private static final String PREF_SETUP_VERSION = "phone_setup_version";
    private static final int PHONE_SETUP_VERSION = 1;
    private static final String PREFS = "voicekhata_mobile";
    private static final String PREF_WEB_URL = "web_app_url";
    private static final String DEFAULT_WEB_URL = "https://voicekhata-frontend.vercel.app";

    private WebView webView;
    private View webAppRoot;
    private AudioRecorder audioRecorder;
    private byte[] pendingNativeAudio;
    private boolean lockedAssistantCapture;
    private boolean waitingForKeyguardDismiss;
    private String assistantWebUrl;
    private PermissionRequest pendingWebPermissionRequest;
    private boolean assistantLaunchPending;
    private boolean waitingForAssistantPermission;
    private boolean waitingForSetupPermission;
    private boolean waitingToOpenAfterPermission;
    private String pendingSetupUrl;
    private TextView microphoneStatus;
    private TextView assistantStatus;
    private TextView gestureInstructions;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        assistantLaunchPending = isAssistantIntent(getIntent());
        String savedUrl = preferences().getString(PREF_WEB_URL, "");
        boolean setupComplete = preferences().getInt(PREF_SETUP_VERSION, 0) >= PHONE_SETUP_VERSION;
        if (savedUrl.isEmpty() || !setupComplete) showServerSetup();
        else if (assistantLaunchPending && isDeviceLocked()) startLockedAssistantCapture(savedUrl);
        else showWebApp(savedUrl);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (isAssistantIntent(intent)) {
            assistantLaunchPending = true;
            if (isDeviceLocked() && webView != null) {
                startLockedAssistantCapture(preferences().getString(PREF_WEB_URL, DEFAULT_WEB_URL));
            } else {
                continueAssistantLaunch();
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateSetupStatuses();
        continueAfterDeviceUnlock();
    }

    @Override
    protected void onDestroy() {
        if (audioRecorder != null) audioRecorder.cancel();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_ASSISTANT_ROLE) {
            updateSetupStatuses();
            if (hasAssistantRole()) {
                Toast.makeText(this, "VoiceKhata is now selected as your assistant.", Toast.LENGTH_LONG).show();
            }
        }
    }

    private boolean isAssistantIntent(Intent intent) {
        return intent != null && Intent.ACTION_ASSIST.equals(intent.getAction());
    }

    private SharedPreferences preferences() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private boolean hasMicrophonePermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private TextView text(String value, float size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(0xff26332d);
        return view;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        return button;
    }

    private void showServerSetup() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(0xfff3f2ed);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(24), dp(28), dp(24), dp(28));
        scroll.addView(layout);

        TextView title = text("Set up phone voice access", 25);
        title.setTypeface(null, 1);
        layout.addView(title);

        TextView description = text("Do these one-time steps so VoiceKhata can open from your phone assistant and use the microphone.", 15);
        LinearLayout.LayoutParams descriptionParams = new LinearLayout.LayoutParams(-1, -2);
        descriptionParams.topMargin = dp(12);
        layout.addView(description, descriptionParams);

        addSetupHeading(layout, "1. Allow microphone");
        microphoneStatus = text("Checking microphone permission…", 13);
        layout.addView(microphoneStatus);
        Button microphone = button("Allow microphone access");
        addSetupButton(layout, microphone);
        microphone.setOnClickListener(view -> requestMicrophoneForSetup());

        addSetupHeading(layout, "2. Choose VoiceKhata as your assistant");
        assistantStatus = text("Not selected yet", 13);
        layout.addView(assistantStatus);
        Button assistant = button("Choose VoiceKhata");
        addSetupButton(layout, assistant);
        assistant.setOnClickListener(view -> requestAssistantSelection());

        addSetupHeading(layout, "3. Turn on your phone button gesture");
        gestureInstructions = text(phoneGesturePath(), 13);
        layout.addView(gestureInstructions);
        Button gesture = button("Open phone settings");
        addSetupButton(layout, gesture);
        gesture.setOnClickListener(view -> openGestureSettings());

        addSetupHeading(layout, "VoiceKhata website");
        TextView urlDescription = text("This is the website that connects to your hosted shop account.", 13);
        layout.addView(urlDescription);

        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("https://your-voicekhata-site.example");
        address.setText(preferences().getString(PREF_WEB_URL, DEFAULT_WEB_URL));
        LinearLayout.LayoutParams addressParams = new LinearLayout.LayoutParams(-1, -2);
        addressParams.topMargin = dp(24);
        layout.addView(address, addressParams);

        Button open = button("Save and open VoiceKhata");
        addSetupButton(layout, open);

        open.setOnClickListener(view -> {
            String url = normalizeWebUrl(address.getText().toString());
            if (url == null) {
                address.setError("Enter a valid HTTPS address");
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !hasMicrophonePermission()) {
                pendingSetupUrl = url;
                waitingToOpenAfterPermission = true;
                requestMicrophoneForSetup();
                return;
            }
            preferences().edit().putString(PREF_WEB_URL, url).apply();
            preferences().edit().putInt(PREF_SETUP_VERSION, PHONE_SETUP_VERSION).apply();
            showWebApp(url);
        });
        updateSetupStatuses();
        setContentView(scroll);
    }

    private void addSetupHeading(LinearLayout layout, String value) {
        TextView heading = text(value, 17);
        heading.setTypeface(null, 1);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(22);
        params.bottomMargin = dp(5);
        layout.addView(heading, params);
    }

    private void addSetupButton(LinearLayout layout, Button button) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(7);
        layout.addView(button, params);
    }

    private void requestMicrophoneForSetup() {
        if (hasMicrophonePermission()) {
            updateSetupStatuses();
            Toast.makeText(this, "Microphone access is already allowed.", Toast.LENGTH_SHORT).show();
            return;
        }
        waitingForSetupPermission = true;
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MICROPHONE);
    }

    private boolean hasAssistantRole() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false;
        RoleManager roleManager = getSystemService(RoleManager.class);
        return roleManager != null && roleManager.isRoleAvailable(RoleManager.ROLE_ASSISTANT)
                && roleManager.isRoleHeld(RoleManager.ROLE_ASSISTANT);
    }

    private String phoneGesturePath() {
        return "After choosing VoiceKhata above: " + OemGestureHelper.instructions();
    }

    private void updateSetupStatuses() {
        if (microphoneStatus != null) {
            microphoneStatus.setText(hasMicrophonePermission()
                    ? "Allowed ✓ — voice recording can use the microphone."
                    : "Required — allow this before using voice recording.");
        }
        if (assistantStatus != null) {
            assistantStatus.setText(hasAssistantRole()
                    ? "Selected ✓ — Android will send its assistant gesture to VoiceKhata."
                    : Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? "Required for the system assistant button. Android will ask you to confirm."
                        : "Open Android’s voice input settings and select VoiceKhata if it is listed.");
        }
    }

    private void openGestureSettings() {
        new AlertDialog.Builder(this)
                .setTitle("Enable your phone’s assistant button")
                .setMessage(phoneGesturePath() + "\n\nAndroid does not provide one shared settings page for changing this hardware gesture, so the final button choice must be made in your phone’s own settings.")
                .setNegativeButton("Later", null)
                .setPositiveButton("Open Settings", (dialog, which) -> {
                    try {
                        startActivity(OemGestureHelper.settingsIntent());
                    } catch (Exception ignored) {
                        Toast.makeText(this, "Open Settings and search for assistant gesture.", Toast.LENGTH_LONG).show();
                    }
                })
                .show();
    }

    private String normalizeWebUrl(String value) {
        String url = value == null ? "" : value.trim();
        if (url.isEmpty()) return null;
        if (!url.startsWith("https://")) url = "https://" + url;
        Uri parsed = Uri.parse(url);
        if (!"https".equals(parsed.getScheme()) || parsed.getHost() == null
                || parsed.getUserInfo() != null
                || parsed.getQuery() != null || parsed.getFragment() != null
                || parsed.getPath() != null && !parsed.getPath().isEmpty() && !"/".equals(parsed.getPath())) return null;
        return url.replaceAll("/+$", "");
    }

    private void showWebApp(String url) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xfff3f2ed);

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(8), dp(4), dp(8), dp(4));
        bar.setBackgroundColor(0xffe5e9df);
        TextView brand = text("VoiceKhata", 16);
        brand.setTypeface(null, 1);
        bar.addView(brand, new LinearLayout.LayoutParams(0, -2, 1));
        Button setup = button("Settings");
        setup.setOnClickListener(view -> showServerSetup());
        bar.addView(setup, new LinearLayout.LayoutParams(-2, -2));
        Button assistant = button("Phone assistant");
        assistant.setOnClickListener(view -> showServerSetup());
        bar.addView(assistant, new LinearLayout.LayoutParams(-2, -2));
        root.addView(bar, new LinearLayout.LayoutParams(-1, -2));

        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.addJavascriptInterface(new NativeVoiceBridge(), "VoiceKhataNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri destination = request.getUrl();
                Uri origin = Uri.parse(preferences().getString(PREF_WEB_URL, ""));
                if (sameOrigin(origin, destination)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, destination)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String pageUrl) {
                super.onPageFinished(view, pageUrl);
                continueAssistantLaunch();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean asksForAudio = false;
                    for (String resource : request.getResources()) {
                        if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            request.deny();
                            return;
                        }
                        asksForAudio = true;
                    }
                    if (!asksForAudio) {
                        request.deny();
                        return;
                    }
                    Uri requestedOrigin = Uri.parse(request.getOrigin().toString());
                    Uri appOrigin = Uri.parse(preferences().getString(PREF_WEB_URL, ""));
                    if (!sameOrigin(requestedOrigin, appOrigin)) {
                        request.deny();
                        return;
                    }
                    if (hasMicrophonePermission()) {
                        request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    } else {
                        pendingWebPermissionRequest = request;
                        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MICROPHONE);
                    }
                });
            }
        });
        root.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        webAppRoot = root;
        setContentView(webAppRoot);
        webView.loadUrl(url);
    }

    /** Invoked by the trusted first-party page only after its user is authenticated. */
    public final class NativeVoiceBridge {
        @JavascriptInterface
        public boolean startCapture() {
            if (!hasMicrophonePermission()) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "Allow microphone access in VoiceKhata settings, then try the assistant button again.",
                        Toast.LENGTH_LONG).show());
                return false;
            }
            runOnUiThread(MainActivity.this::beginNativeCapture);
            return true;
        }

        @JavascriptInterface
        public void finishCapture() {
            if (audioRecorder != null) audioRecorder.finish();
        }

        @JavascriptInterface
        public void cancelCapture() {
            if (audioRecorder != null) audioRecorder.cancel();
            runOnUiThread(() -> setContentView(webAppRoot));
        }

        @JavascriptInterface
        public String consumeAudioBase64() {
            byte[] audio = pendingNativeAudio;
            pendingNativeAudio = null;
            return audio == null ? "" : android.util.Base64.encodeToString(audio, android.util.Base64.NO_WRAP);
        }

        @JavascriptInterface
        public boolean hasPendingAudio() {
            return pendingNativeAudio != null;
        }
    }

    private void beginNativeCapture() {
        if (audioRecorder != null) return;
        audioRecorder = new AudioRecorder(this);
        vibrateForCapture();
        showNativeCaptureControls();
        audioRecorder.start((wav, error) -> runOnUiThread(() -> {
            audioRecorder = null;
            if (lockedAssistantCapture) {
                if (error != null) {
                    Toast.makeText(this, error, Toast.LENGTH_LONG).show();
                    setContentView(webAppRoot);
                    return;
                }
                if (wav == null) return;
                pendingNativeAudio = wav;
                waitingForKeyguardDismiss = true;
                requestUnlockBeforeOpeningLedger();
                return;
            }
            setContentView(webAppRoot);
            if (error != null) {
                Toast.makeText(this, error, Toast.LENGTH_LONG).show();
                return;
            }
            if (wav == null || webView == null) return;
            pendingNativeAudio = wav;
            webView.post(() -> webView.evaluateJavascript(
                    "window.voiceKhataNativeAudioReady && window.voiceKhataNativeAudioReady()", null));
        }));
    }

    private boolean isDeviceLocked() {
        KeyguardManager manager = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        return manager != null && manager.isKeyguardLocked();
    }

    private void startLockedAssistantCapture(String url) {
        assistantWebUrl = url;
        enableKeyguardVoiceSurface();
        if (!hasMicrophonePermission()) {
            showLockedUnlockPrompt(url, "Unlock the phone and allow microphone access before using hands-free voice entry.");
            return;
        }
        lockedAssistantCapture = true;
        beginNativeCapture();
    }

    private void enableKeyguardVoiceSurface() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) {
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }

    private void requestUnlockBeforeOpeningLedger() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            KeyguardManager manager = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            if (manager != null) {
                manager.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                    @Override public void onDismissSucceeded() {
                        runOnUiThread(() -> openWebAppAfterUnlock());
                    }

                    @Override public void onDismissCancelled() {
                        runOnUiThread(() -> showLockedUnlockPrompt(assistantWebUrl,
                                "Your recording is ready. Unlock the phone to review and save this entry."));
                    }

                    @Override public void onDismissError() {
                        runOnUiThread(() -> showLockedUnlockPrompt(assistantWebUrl,
                                "Unlock the phone to review and save your voice entry."));
                    }
                });
                return;
            }
        }
        showLockedUnlockPrompt(assistantWebUrl, "Your recording is ready. Unlock the phone to review and save this entry.");
    }

    private void showLockedUnlockPrompt(String url, String message) {
        assistantWebUrl = url;
        lockedAssistantCapture = true;
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(36), dp(28), dp(36));
        panel.setBackgroundColor(0xfff3f2ed);
        TextView title = text("Unlock to continue", 24);
        title.setTypeface(null, 1);
        panel.addView(title);
        TextView body = text(message, 16);
        body.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-1, -2);
        bodyParams.topMargin = dp(16);
        panel.addView(body, bodyParams);
        Button unlock = button("Unlock and review entry");
        addSetupButton(panel, unlock);
        unlock.setOnClickListener(view -> requestUnlockBeforeOpeningLedger());
        setContentView(panel);
    }

    private void continueAfterDeviceUnlock() {
        if (!waitingForKeyguardDismiss || isDeviceLocked()) return;
        waitingForKeyguardDismiss = false;
        openWebAppAfterUnlock();
    }

    private void openWebAppAfterUnlock() {
        if (assistantWebUrl == null) return;
        if (!waitingForKeyguardDismiss && webView != null) return;
        waitingForKeyguardDismiss = false;
        lockedAssistantCapture = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        } else {
            getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        showWebApp(assistantWebUrl);
    }

    private void vibrateForCapture() {
        Vibrator vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (vibrator == null || !vibrator.hasVibrator()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(80, VibrationEffect.DEFAULT_AMPLITUDE));
        } else {
            vibrator.vibrate(80);
        }
    }

    private void showNativeCaptureControls() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(36), dp(28), dp(36));
        panel.setBackgroundColor(0xfff3f2ed);

        TextView brand = text("VoiceKhata", 18);
        brand.setTypeface(null, 1);
        panel.addView(brand);
        TextView prompt = text("बोलिए… जैसे ‘रमेश 500 रुपये उधार’", 22);
        prompt.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams promptParams = new LinearLayout.LayoutParams(-1, -2);
        promptParams.topMargin = dp(34);
        panel.addView(prompt, promptParams);
        TextView hint = text("Recording stops after your pause or 20 seconds. You will confirm before anything is saved.", 15);
        hint.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(-1, -2);
        hintParams.topMargin = dp(14);
        panel.addView(hint, hintParams);

        Button finish = button("Finish recording");
        addSetupButton(panel, finish);
        finish.setOnClickListener(view -> { if (audioRecorder != null) audioRecorder.finish(); });
        Button cancel = button("Cancel");
        addSetupButton(panel, cancel);
        cancel.setOnClickListener(view -> {
            if (audioRecorder != null) audioRecorder.cancel();
            audioRecorder = null;
            pendingNativeAudio = null;
            if (lockedAssistantCapture) {
                finish();
                return;
            }
            setContentView(webAppRoot);
        });
        setContentView(panel);
    }

    private void continueAssistantLaunch() {
        if (!assistantLaunchPending || webView == null) return;
        if (!hasMicrophonePermission()) {
            waitingForAssistantPermission = true;
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MICROPHONE);
            return;
        }
        assistantLaunchPending = false;
        webView.post(() -> webView.evaluateJavascript(
                "window.voiceKhataAssistantLaunch ? window.voiceKhataAssistantLaunch() : false", null));
    }

    private boolean sameOrigin(Uri first, Uri second) {
        return first.getScheme() != null
                && first.getScheme().equalsIgnoreCase(second.getScheme())
                && first.getHost() != null
                && first.getHost().equalsIgnoreCase(second.getHost())
                && first.getPort() == second.getPort();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_MICROPHONE) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (waitingForSetupPermission) {
            waitingForSetupPermission = false;
            updateSetupStatuses();
            if (granted) {
                Toast.makeText(this, "Microphone access is enabled.", Toast.LENGTH_SHORT).show();
                if (waitingToOpenAfterPermission && pendingSetupUrl != null) {
                    preferences().edit()
                            .putString(PREF_WEB_URL, pendingSetupUrl)
                            .putInt(PREF_SETUP_VERSION, PHONE_SETUP_VERSION)
                            .apply();
                    String url = pendingSetupUrl;
                    pendingSetupUrl = null;
                    waitingToOpenAfterPermission = false;
                    showWebApp(url);
                }
            } else {
                waitingToOpenAfterPermission = false;
                pendingSetupUrl = null;
                new AlertDialog.Builder(this)
                        .setTitle("Microphone permission is off")
                        .setMessage("VoiceKhata needs microphone access to record your spoken ledger entry. Turn on Microphone in the app permissions page.")
                        .setNegativeButton("Later", null)
                        .setPositiveButton("Open app permissions", (dialog, which) -> openAppPermissionSettings())
                        .show();
            }
        }
        if (pendingWebPermissionRequest != null) {
            if (granted) pendingWebPermissionRequest.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            else pendingWebPermissionRequest.deny();
            pendingWebPermissionRequest = null;
        }
        if (waitingForAssistantPermission) {
            waitingForAssistantPermission = false;
            if (granted) continueAssistantLaunch();
            else Toast.makeText(this, "Microphone permission is needed for voice entries.", Toast.LENGTH_LONG).show();
        }
    }

    private void requestAssistantSelection() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            RoleManager roleManager = getSystemService(RoleManager.class);
            if (roleManager != null && roleManager.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) {
                if (roleManager.isRoleHeld(RoleManager.ROLE_ASSISTANT)) {
                    Toast.makeText(this, "VoiceKhata is already your selected assistant.", Toast.LENGTH_LONG).show();
                } else {
                    startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT), REQUEST_ASSISTANT_ROLE);
                }
                return;
            }
        }
        try {
            startActivity(new Intent(Settings.ACTION_VOICE_INPUT_SETTINGS));
        } catch (Exception error) {
            new AlertDialog.Builder(this)
                    .setTitle("Assistant setting unavailable")
                    .setMessage("This phone does not expose an assistant selection screen to apps. Use the VoiceKhata app icon as a quick action instead.")
                    .setPositiveButton("OK", null)
                    .show();
        }
    }

    private void openAppPermissionSettings() {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getPackageName(), null));
            startActivity(intent);
        } catch (Exception ignored) {
            Toast.makeText(this, "Open Settings → Apps → VoiceKhata → Permissions.", Toast.LENGTH_LONG).show();
        }
    }
}
