package com.voicekhata.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.app.role.RoleManager;
import android.content.Intent;
import android.content.ClipData;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.PermissionRequest;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String LOG_TAG = "VoiceKhata";
    private static final int REQUEST_MICROPHONE = 7301;
    private static final int REQUEST_ASSISTANT_ROLE = 7302;
    private static final String PREF_SETUP_VERSION = "phone_setup_version";
    private static final int PHONE_SETUP_VERSION = 2;
    private static final String PREFS = "voicekhata_mobile";
    private static final String PREF_WEB_URL = "web_app_url";
    private static final String DEFAULT_WEB_URL = "https://voicekhata-frontend.vercel.app";
    private static final String DEFAULT_API_URL = "https://voicekhata-gxd0.onrender.com";

    private WebView webView;
    private View webAppRoot;
    private FrameLayout appFrame;
    private View handsFreeOverlay;
    private TextView handsFreeStatus;
    private AudioRecorder audioRecorder;
    private volatile byte[] pendingNativeAudio;
    private volatile boolean nativeUploadInProgress;
    private final ExecutorService nativeUploadExecutor = Executors.newSingleThreadExecutor();
    private boolean lockedAssistantCapture;
    private boolean handsFreeAssistantSession;
    private boolean finishedHandsFreeSession;
    private Runnable handsFreeCompletionPoll;
    private TextToSpeech nativeTts;
    private boolean nativeTtsReady;
    private boolean nativePromptInProgress;
    private boolean nativeReplyCaptureInProgress;
    private boolean waitingForKeyguardDismiss;
    private String assistantWebUrl;
    private PermissionRequest pendingWebPermissionRequest;
    private boolean assistantLaunchPending;
    private boolean webPageReady;
    private boolean waitingForAssistantPermission;
    private boolean waitingForSetupPermission;
    private boolean waitingToOpenAfterPermission;
    private boolean setupWizardActive;
    private boolean setupWizardScheduled;
    private boolean waitingForWizardRole;
    private boolean waitingForGestureSettings;
    private String pendingSetupUrl;
    private TextView microphoneStatus;
    private TextView assistantStatus;
    private TextView gestureInstructions;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        nativeTts = new TextToSpeech(this, status -> {
            if (status != TextToSpeech.SUCCESS) return;
            int languageStatus = nativeTts.setLanguage(new Locale("hi", "IN"));
            nativeTtsReady = languageStatus != TextToSpeech.LANG_MISSING_DATA
                    && languageStatus != TextToSpeech.LANG_NOT_SUPPORTED;
        });
        applySystemBarStyle();
        assistantLaunchPending = isAssistantIntent(getIntent());
        handsFreeAssistantSession = assistantLaunchPending;
        lockedAssistantCapture = assistantLaunchPending && isDeviceLocked();
        Log.i(LOG_TAG, "Activity created; assistantLaunch=" + assistantLaunchPending + ", keyguardLocked=" + isDeviceLocked());
        String savedUrl = preferences().getString(PREF_WEB_URL, DEFAULT_WEB_URL);
        if (assistantLaunchPending && isDeviceLocked()) enableKeyguardVoiceSurface();
        if (assistantLaunchPending && !hasMicrophonePermission() && isDeviceLocked()) showLockedUnlockPrompt(savedUrl,
                "Unlock once and allow microphone access before using hands-free voice entry.");
        else showWebApp(savedUrl);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (isAssistantIntent(intent)) {
            assistantLaunchPending = true;
            handsFreeAssistantSession = true;
            finishedHandsFreeSession = false;
            lockedAssistantCapture = isDeviceLocked();
            if (lockedAssistantCapture) enableKeyguardVoiceSurface();
            showHandsFreeOverlay("Starting VoiceKhata…");
            Log.i(LOG_TAG, "Assistant intent received; keyguardLocked=" + isDeviceLocked());
            if (webView != null) {
                continueAssistantLaunch();
            } else {
                showWebApp(preferences().getString(PREF_WEB_URL, DEFAULT_WEB_URL));
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateSetupStatuses();
        continueAfterDeviceUnlock();
        if (waitingForGestureSettings) {
            waitingForGestureSettings = false;
            showGestureCompletePrompt();
        } else if (waitingForWizardRole && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            waitingForWizardRole = false;
            showGestureWizardPrompt();
        }
    }

    @Override
    protected void onDestroy() {
        if (audioRecorder != null) audioRecorder.cancel();
        nativeUploadExecutor.shutdownNow();
        if (nativeTts != null) nativeTts.shutdown();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_ASSISTANT_ROLE) {
            updateSetupStatuses();
            if (waitingForWizardRole) {
                waitingForWizardRole = false;
                if (hasAssistantRole()) showGestureWizardPrompt();
                else showAssistantWizardPrompt();
                return;
            }
            if (hasAssistantRole()) {
                Toast.makeText(this, "VoiceKhata is selected as your assistant.", Toast.LENGTH_LONG).show();
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
        view.setFontFeatureSettings("kern");
        return view;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextSize(15);
        button.setTextColor(0xff315d45);
        button.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        button.setPadding(dp(18), dp(12), dp(18), dp(12));
        button.setMinHeight(dp(50));
        button.setElevation(0);
        button.setBackground(roundedBackground(0xffffffff, 0xffd9e1d8, 1));
        return button;
    }

    private GradientDrawable roundedBackground(int fill, int stroke, int strokeWidth) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(dp(13));
        shape.setStroke(dp(strokeWidth), stroke);
        return shape;
    }

    private void makePrimary(Button button) {
        button.setTextColor(Color.WHITE);
        button.setBackground(roundedBackground(0xff3f6c51, 0xff3f6c51, 1));
    }

    private void applySystemBarStyle() {
        getWindow().setStatusBarColor(0xfff3f2ed);
        getWindow().setNavigationBarColor(0xfff3f2ed);
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    private void applySystemBarInsets(View root) {
        final int left = root.getPaddingLeft();
        final int top = root.getPaddingTop();
        final int right = root.getPaddingRight();
        final int bottom = root.getPaddingBottom();
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int insetLeft;
            int insetTop;
            int insetRight;
            int insetBottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                insetLeft = bars.left;
                insetTop = bars.top;
                insetRight = bars.right;
                insetBottom = bars.bottom;
            } else {
                insetLeft = insets.getSystemWindowInsetLeft();
                insetTop = insets.getSystemWindowInsetTop();
                insetRight = insets.getSystemWindowInsetRight();
                insetBottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(left + insetLeft, top + insetTop, right + insetRight, bottom + insetBottom);
            return insets;
        });
        root.requestApplyInsets();
    }

    private void completeFirstRunAndOpen(String url) {
        preferences().edit()
                .putString(PREF_WEB_URL, url)
                .putInt(PREF_SETUP_VERSION, PHONE_SETUP_VERSION)
                .apply();
        showWebApp(url);
    }

    private void showServerSetup() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(0xfff3f2ed);
        applySystemBarInsets(scroll);
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

        addSetupHeading(layout, "2. Choose or change your assistant");
        assistantStatus = text("Not selected yet", 13);
        layout.addView(assistantStatus);
        Button assistant = button("Open assistant selection");
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
        makePrimary(open);
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
            completeFirstRunAndOpen(url);
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
            if (setupWizardActive) showAssistantWizardPrompt();
            else Toast.makeText(this, "Microphone access is already allowed.", Toast.LENGTH_SHORT).show();
            return;
        }
        waitingForSetupPermission = true;
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MICROPHONE);
    }

    private void beginSetupWizard() {
        setupWizardActive = true;
        if (!hasMicrophonePermission()) showMicrophoneWizardPrompt();
        else showAssistantWizardPrompt();
    }

    private void showMicrophoneWizardPrompt() {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Step 1 of 3 · Microphone")
                .setMessage("Allow microphone access so VoiceKhata can record a voice entry when you ask it to.")
                .setNegativeButton("Later", (d, w) -> finishSetupWizard())
                .setPositiveButton("Allow microphone", (d, w) -> requestMicrophoneForSetup())
                .create();
        showGreenDialog(dialog);
    }

    private void showAssistantWizardPrompt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || hasAssistantRole()) {
            showGestureWizardPrompt();
            return;
        }
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Step 2 of 3 · Default assistant")
                .setMessage("Choose VoiceKhata on Android’s next screen. This lets your phone send its supported assistant shortcut to the app.")
                .setNegativeButton("Later", (d, w) -> finishSetupWizard())
                .setPositiveButton("Choose VoiceKhata", (d, w) -> {
                    waitingForWizardRole = true;
                    requestAssistantSelection();
                })
                .create();
        showGreenDialog(dialog);
    }

    private void showGestureWizardPrompt() {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Step 3 of 3 · Phone button")
                .setMessage(OemGestureHelper.instructions() + "\n\nPhone makers control this shortcut; VoiceKhata cannot change it automatically.")
                .setNegativeButton("Skip for now", (d, w) -> finishSetupWizard())
                .setPositiveButton("Open phone settings", (d, w) -> {
                    waitingForGestureSettings = true;
                    try { startActivity(OemGestureHelper.settingsIntent()); }
                    catch (Exception error) {
                        waitingForGestureSettings = false;
                        Toast.makeText(this, "Open Settings and search for assistant or power button.", Toast.LENGTH_LONG).show();
                        showGestureCompletePrompt();
                    }
                })
                .create();
        showGreenDialog(dialog);
    }

    private void showGestureCompletePrompt() {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Phone settings")
                .setMessage("If you enabled VoiceKhata for the power/side-button assistant shortcut, tap Done. Otherwise, open Settings again and follow the menu path.")
                .setNegativeButton("Open settings again", (d, w) -> showGestureWizardPrompt())
                .setPositiveButton("Done", (d, w) -> finishSetupWizard())
                .create();
        showGreenDialog(dialog);
    }

    private void showGreenDialog(AlertDialog dialog) {
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(0xff3f6c51);
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(0xff68786d);
        });
        dialog.show();
    }

    private void finishSetupWizard() {
        setupWizardActive = false;
        preferences().edit()
                .putString(PREF_WEB_URL, preferences().getString(PREF_WEB_URL, DEFAULT_WEB_URL))
                .putInt(PREF_SETUP_VERSION, PHONE_SETUP_VERSION)
                .apply();
        Toast.makeText(this, "Setup saved. VoiceKhata login is ready.", Toast.LENGTH_SHORT).show();
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
        applySystemBarInsets(root);

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(16), dp(3), dp(12), dp(3));
        bar.setBackgroundColor(0xffe5e9df);
        TextView brand = text("VoiceKhata", 16);
        brand.setTypeface(null, 1);
        bar.addView(brand, new LinearLayout.LayoutParams(0, -2, 1));
        Button setup = button("Setup");
        setup.setTextSize(12);
        setup.setMinHeight(dp(40));
        setup.setPadding(dp(10), dp(6), dp(10), dp(6));
        setup.setOnClickListener(view -> beginSetupWizard());
        bar.addView(setup, new LinearLayout.LayoutParams(-2, -2));
        root.addView(bar, new LinearLayout.LayoutParams(-1, -2));

        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.addJavascriptInterface(new NativeVoiceBridge(), "VoiceKhataNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String pageUrl, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, pageUrl, favicon);
                webPageReady = false;
            }

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
                webPageReady = true;
                boolean launchedByAssistant = assistantLaunchPending;
                installNativeAudioHandoff(view);
                continueAssistantLaunch();
                if (!launchedByAssistant && !setupWizardScheduled
                        && preferences().getInt(PREF_SETUP_VERSION, 0) < PHONE_SETUP_VERSION) {
                    setupWizardScheduled = true;
                    view.postDelayed(MainActivity.this::beginSetupWizard, 900);
                }
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
        appFrame = new FrameLayout(this);
        appFrame.setBackgroundColor(Color.WHITE);
        appFrame.addView(root, new FrameLayout.LayoutParams(-1, -1));
        webAppRoot = root;
        if (handsFreeAssistantSession) addHandsFreeOverlay("Starting VoiceKhata…");
        setContentView(appFrame);
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
            runOnUiThread(() -> {
                if (handsFreeAssistantSession) speakPromptThenCapture();
                else beginNativeCapture();
            });
            return true;
        }

        /** Native capture for a spoken follow-up answer (for example, existing or new customer). */
        @JavascriptInterface
        public boolean startReplyCapture() {
            if (!handsFreeAssistantSession || finishedHandsFreeSession || !hasMicrophonePermission()) return false;
            runOnUiThread(MainActivity.this::beginNativeReplyCapture);
            return true;
        }

        @JavascriptInterface
        public void cancelReplyCapture() {
            runOnUiThread(() -> {
                if (!nativeReplyCaptureInProgress) return;
                nativeReplyCaptureInProgress = false;
                if (audioRecorder != null) audioRecorder.cancel();
            });
        }

        @JavascriptInterface
        public void finishCapture() {
            if (audioRecorder != null) audioRecorder.finish();
        }

        @JavascriptInterface
        public void cancelCapture() {
            if (audioRecorder != null) audioRecorder.cancel();
            runOnUiThread(() -> {
                if (handsFreeAssistantSession) finishHandsFreeSession();
                else showWebRoot();
            });
        }

        @JavascriptInterface
        public boolean isHandsFreeSession() { return handsFreeAssistantSession && !finishedHandsFreeSession; }

        @JavascriptInterface
        public void setHandsFreeStatus(String status) {
            runOnUiThread(() -> updateHandsFreeStatus(status));
        }

        @JavascriptInterface
        public void finishHandsFreeSession() {
            runOnUiThread(MainActivity.this::finishHandsFreeSession);
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

        @JavascriptInterface
        public void transcribePendingAudio(String apiBaseUrl, String accessToken) {
            uploadPendingNativeAudio(apiBaseUrl, accessToken);
        }

        @JavascriptInterface
        public boolean sharePaymentQr(String imageBase64, String message) {
            if (imageBase64 == null || imageBase64.isBlank() || imageBase64.length() > 100_000) return false;
            runOnUiThread(() -> launchPaymentQrShare(imageBase64, message));
            return true;
        }
    }

    private void launchPaymentQrShare(String imageBase64, String message) {
        try {
            byte[] image = android.util.Base64.decode(imageBase64, android.util.Base64.DEFAULT);
            File sharedImage = new File(getCacheDir(), "voicekhata-payment-qr.png");
            try (FileOutputStream output = new FileOutputStream(sharedImage, false)) {
                output.write(image);
            }
            Uri imageUri = new Uri.Builder()
                    .scheme("content")
                    .authority(getPackageName() + ".paymentshare")
                    .appendPath("payment-qr.png")
                    .build();
            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("image/png");
            share.putExtra(Intent.EXTRA_STREAM, imageUri);
            share.putExtra(Intent.EXTRA_TEXT, message == null ? "" : message);
            share.setClipData(ClipData.newUri(getContentResolver(), "VoiceKhata payment QR", imageUri));
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(share, "Send payment request"));
        } catch (Exception error) {
            Log.e(LOG_TAG, "Could not open payment QR share sheet.", error);
            Toast.makeText(this, "Could not share the QR image. Please try WhatsApp again.", Toast.LENGTH_LONG).show();
        }
    }

    private void speakPromptThenCapture() {
        if (nativePromptInProgress || audioRecorder != null) return;
        nativePromptInProgress = true;
        updateHandsFreeStatus("बोलिए…");
        if (nativeTts == null || !nativeTtsReady) {
            nativePromptInProgress = false;
            beginNativeCapture();
            return;
        }
        nativeTts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) { }
            @Override public void onDone(String utteranceId) {
                runOnUiThread(() -> {
                    nativePromptInProgress = false;
                    if (handsFreeAssistantSession && !finishedHandsFreeSession) beginNativeCapture();
                });
            }
            @Override public void onError(String utteranceId) {
                runOnUiThread(() -> {
                    nativePromptInProgress = false;
                    if (handsFreeAssistantSession && !finishedHandsFreeSession) beginNativeCapture();
                });
            }
        });
        int result = nativeTts.speak("बोलिए", TextToSpeech.QUEUE_FLUSH, null, "voicekhata-assistant-prompt");
        if (result == TextToSpeech.ERROR) {
            nativePromptInProgress = false;
            beginNativeCapture();
        } else if (appFrame != null) {
            appFrame.postDelayed(() -> {
                if (nativePromptInProgress && handsFreeAssistantSession && !finishedHandsFreeSession) {
                    nativePromptInProgress = false;
                    beginNativeCapture();
                }
            }, 3500);
        }
    }

    private void beginNativeCapture() {
        if (audioRecorder != null) return;
        Log.i(LOG_TAG, "Native microphone capture starting; keyguardCapture=" + lockedAssistantCapture);
        audioRecorder = new AudioRecorder(this);
        vibrateForCapture();
        showNativeCaptureControls();
        audioRecorder.start((wav, error) -> runOnUiThread(() -> {
            audioRecorder = null;
            if (handsFreeAssistantSession) {
                if (error != null) {
                    Log.e(LOG_TAG, "Assistant capture failed: " + error);
                    updateHandsFreeStatus("आवाज़ रिकॉर्ड नहीं हो पाई। दोबारा assistant button दबाएँ।");
                    speakNativeMessage("आवाज़ रिकॉर्ड नहीं हो पाई। दोबारा कोशिश करें।", true);
                    return;
                }
                if (wav == null) { Log.i(LOG_TAG, "Locked capture was cancelled."); return; }
                Log.i(LOG_TAG, "Assistant capture finished; WAV bytes=" + wav.length + ", processing without opening the ledger UI.");
                pendingNativeAudio = wav;
                updateHandsFreeStatus("आपकी बात समझ रहा हूँ…");
                handlePendingNativeAudioInWebView();
                startHandsFreeCompletionPoll();
                return;
            }
            showWebRoot();
            if (error != null) {
                Log.e(LOG_TAG, "Capture failed: " + error);
                Toast.makeText(this, error, Toast.LENGTH_LONG).show();
                return;
            }
            if (wav == null || webView == null) { Log.i(LOG_TAG, "Capture cancelled or WebView not ready."); return; }
            Log.i(LOG_TAG, "Capture finished; WAV bytes=" + wav.length + ", handing to WebView.");
            pendingNativeAudio = wav;
            handlePendingNativeAudioInWebView();
        }));
    }

    private void beginNativeReplyCapture() {
        if (!handsFreeAssistantSession || finishedHandsFreeSession || audioRecorder != null) {
            notifyNativeReplyError("माइक्रोफ़ोन शुरू नहीं हो पाया। कृपया फिर से बोलें।");
            return;
        }
        nativeReplyCaptureInProgress = true;
        Log.i(LOG_TAG, "Starting native microphone capture for a spoken follow-up answer.");
        audioRecorder = new AudioRecorder(this);
        vibrateForCapture();
        showHandsFreeOverlay("जवाब सुन रहा हूँ…");
        AudioRecorder replyRecorder = audioRecorder;
        replyRecorder.start((wav, error) -> runOnUiThread(() -> {
            if (audioRecorder == replyRecorder) audioRecorder = null;
            if (!nativeReplyCaptureInProgress) return;
            nativeReplyCaptureInProgress = false;
            if (!handsFreeAssistantSession || finishedHandsFreeSession) return;
            if (error != null || wav == null) {
                Log.w(LOG_TAG, "Native follow-up recording failed: " + (error == null ? "no audio" : error));
                notifyNativeReplyError(error == null ? "आपका जवाब सुनाई नहीं दिया। फिर से बोलें।" : error);
                return;
            }
            pendingNativeAudio = wav;
            Log.i(LOG_TAG, "Native follow-up recording finished; WAV bytes=" + wav.length + ".");
            updateHandsFreeStatus("आपका जवाब समझ रहा हूँ…");
            if (webView != null) webView.evaluateJavascript(
                    "window.voiceKhataNativeReplyAudioReady ? window.voiceKhataNativeReplyAudioReady() : false", null);
            else notifyNativeReplyError("VoiceKhata फिर से खोलकर जवाब दें।");
        }));
    }

    private void notifyNativeReplyError(String message) {
        if (webView == null) return;
        webView.evaluateJavascript("window.voiceKhataNativeReplyError && window.voiceKhataNativeReplyError("
                + JSONObject.quote(message) + ")", null);
    }

    private void installNativeAudioHandoff(WebView target) {
        String script = "(function(){"
                + "if(window.__voiceKhataNativeHandoff)return true;window.__voiceKhataNativeHandoff=true;"
                + "window.voiceKhataNativeBeginUpload=function(){"
                + "if(!window.VoiceKhataNative||!VoiceKhataNative.hasPendingAudio())return false;"
                + "var token=localStorage.getItem('voicekhata.access_token')||'';"
                + "var base=(window.VOICEKHATA_CONFIG&&VOICEKHATA_CONFIG.apiBaseUrl)||'" + DEFAULT_API_URL + "';"
                + "if(!token)return false;VoiceKhataNative.transcribePendingAudio(base,token);return true;};"
                + "if(typeof window.startListening==='function'&&!window.__voiceKhataOriginalStartListening){"
                + "window.__voiceKhataOriginalStartListening=window.startListening;"
                + "window.startListening=function(){if(window.voiceKhataNativeBeginUpload&&window.voiceKhataNativeBeginUpload())return Promise.resolve();"
                + "return window.__voiceKhataOriginalStartListening.apply(this,arguments);};}"
                + "return true;})()";
        target.evaluateJavascript(script, null);
    }

    private void handlePendingNativeAudioInWebView() {
        if (webView == null) return;
        String script = "(function(){if(window.voiceKhataNativeAudioReady){window.voiceKhataNativeAudioReady();return true;}"
                + "if(window.voiceKhataNativeBeginUpload)return window.voiceKhataNativeBeginUpload();return false;})()";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private void showWebRoot() {
        if (appFrame == null || webAppRoot == null) return;
        appFrame.removeAllViews();
        appFrame.addView(webAppRoot, new FrameLayout.LayoutParams(-1, -1));
    }

    private void addHandsFreeOverlay(String status) {
        if (appFrame == null) return;
        if (handsFreeOverlay != null && handsFreeOverlay.getParent() == appFrame) {
            updateHandsFreeStatus(status);
            return;
        }
        LinearLayout overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setPadding(dp(28), dp(36), dp(28), dp(36));
        overlay.setBackgroundColor(0xfff3f2ed);
        TextView brand = text("VoiceKhata", 20);
        brand.setTypeface(null, 1);
        overlay.addView(brand);
        TextView prompt = text("बोलिए… जैसे ‘रमेश 500 रुपये उधार’", 24);
        prompt.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams promptParams = new LinearLayout.LayoutParams(-1, -2);
        promptParams.topMargin = dp(32);
        overlay.addView(prompt, promptParams);
        handsFreeStatus = text(status, 16);
        handsFreeStatus.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(-1, -2);
        statusParams.topMargin = dp(18);
        overlay.addView(handsFreeStatus, statusParams);
        handsFreeOverlay = overlay;
        appFrame.addView(handsFreeOverlay, new FrameLayout.LayoutParams(-1, -1));
    }

    private void showHandsFreeOverlay(String status) {
        if (appFrame != null) addHandsFreeOverlay(status);
    }

    private void updateHandsFreeStatus(String status) {
        if (status == null || status.isBlank()) return;
        if (handsFreeStatus != null) handsFreeStatus.setText(status);
        Log.i(LOG_TAG, "Hands-free state: " + status);
    }

    private void finishHandsFreeSession() {
        if (finishedHandsFreeSession) return;
        if (nativeReplyCaptureInProgress && audioRecorder != null) {
            nativeReplyCaptureInProgress = false;
            audioRecorder.cancel();
            audioRecorder = null;
        }
        finishedHandsFreeSession = true;
        handsFreeAssistantSession = false;
        assistantLaunchPending = false;
        if (handsFreeCompletionPoll != null && appFrame != null) appFrame.removeCallbacks(handsFreeCompletionPoll);
        handsFreeCompletionPoll = null;
        if (lockedAssistantCapture || isDeviceLocked()) {
            Log.i(LOG_TAG, "Hands-free session complete; returning to keyguard.");
            finish();
            return;
        }
        lockedAssistantCapture = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        }
        getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        if (appFrame != null && handsFreeOverlay != null) appFrame.removeView(handsFreeOverlay);
        handsFreeOverlay = null;
        handsFreeStatus = null;
    }

    // Compatibility with an already-deployed Vercel page: finish the assistant surface
    // when its existing voice UI reports that the transaction has been saved/cancelled.
    private void startHandsFreeCompletionPoll() {
        if (webView == null || appFrame == null) return;
        if (handsFreeCompletionPoll != null) appFrame.removeCallbacks(handsFreeCompletionPoll);
        handsFreeCompletionPoll = new Runnable() {
            int elapsed;
            @Override public void run() {
                if (!handsFreeAssistantSession || finishedHandsFreeSession || webView == null) return;
                webView.evaluateJavascript("(function(){if(window.__voiceKhataHandsFreeSpeechActive)return '__SPEAKING__';var c=document.querySelector('#voice-caption');return c?c.textContent:''})()", value -> {
                    String caption = value == null ? "" : value.toLowerCase();
                    if (caption.contains("__speaking__")) {
                        if (elapsed++ < 180) appFrame.postDelayed(this, 1000);
                        return;
                    }
                    boolean done = caption.contains("up to date") || caption.contains("nothing was saved")
                            || caption.contains("entry saved") || caption.contains("entries saved");
                    if (done) appFrame.postDelayed(MainActivity.this::finishHandsFreeSession, 8000);
                    else if (elapsed++ < 180) appFrame.postDelayed(this, 1000);
                });
            }
        };
        appFrame.postDelayed(handsFreeCompletionPoll, 1200);
    }

    private void speakNativeMessage(String message, boolean finishAfter) {
        // Fallback UI remains visible and private. The web app's Hindi voice is preferred
        // for normal dialogue; this is only used if the initial native recording fails.
        updateHandsFreeStatus(message);
        if (nativeTtsReady && nativeTts != null) {
            nativeTts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) { }
                @Override public void onDone(String utteranceId) {
                    if (finishAfter) runOnUiThread(MainActivity.this::finishHandsFreeSession);
                }
                @Override public void onError(String utteranceId) {
                    if (finishAfter) runOnUiThread(MainActivity.this::finishHandsFreeSession);
                }
            });
            nativeTts.speak(message, TextToSpeech.QUEUE_FLUSH, null, "voicekhata-failure-message");
        } else if (finishAfter && appFrame != null) appFrame.postDelayed(this::finishHandsFreeSession, 3500);
    }

    private void uploadPendingNativeAudio(String apiBaseUrl, String accessToken) {
        byte[] audio = pendingNativeAudio;
        if (audio == null || audio.length == 0 || nativeUploadInProgress) return;
        Uri api = Uri.parse(apiBaseUrl == null ? "" : apiBaseUrl.trim());
        if (!"https".equalsIgnoreCase(api.getScheme())
                || !"voicekhata-gxd0.onrender.com".equalsIgnoreCase(api.getHost())
                || (api.getPath() != null && !api.getPath().isEmpty() && !"/".equals(api.getPath()))
                || api.getUserInfo() != null || api.getQuery() != null || api.getFragment() != null
                || accessToken == null || accessToken.isBlank()) {
            reportNativeUploadFailure("VoiceKhata could not connect securely. Please try the assistant again.");
            return;
        }
        nativeUploadInProgress = true;
        Log.i(LOG_TAG, "Starting authenticated WAV upload; bytes=" + audio.length + ". Token and transcript are not logged.");
        if (webView != null) webView.post(() -> webView.evaluateJavascript(
                "(function(){var t=document.querySelector('#voice-title');if(t)t.textContent='Transcribing your voice';"
                        + "var c=document.querySelector('#voice-caption');if(c)c.textContent='Sending your recording to Gnani…';})()", null));
        nativeUploadExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                String boundary = "VoiceKhata" + System.nanoTime();
                connection = (HttpURLConnection) new URL(DEFAULT_API_URL + "/api/v1/voice/sessions").openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(25_000);
                connection.setReadTimeout(100_000);
                connection.setInstanceFollowRedirects(false);
                connection.setDoOutput(true);
                connection.setRequestProperty("Authorization", "Bearer " + accessToken);
                connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                connection.setRequestProperty("Accept", "application/json");

                try (BufferedOutputStream output = new BufferedOutputStream(connection.getOutputStream())) {
                    writeMultipartText(output, boundary, "language_code", "hi-IN");
                    output.write(("--" + boundary + "\r\n"
                            + "Content-Disposition: form-data; name=\"audio\"; filename=\"voice-command.wav\"\r\n"
                            + "Content-Type: audio/wav\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    output.write(audio);
                    output.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
                }

                int status = connection.getResponseCode();
                Log.i(LOG_TAG, "Voice session endpoint responded with HTTP " + status + ".");
                InputStream responseStream = status >= 200 && status < 300
                        ? connection.getInputStream() : connection.getErrorStream();
                String responseBody = readResponse(responseStream);
                if (status < 200 || status >= 300) {
                    throw new IllegalStateException(status == 401 || status == 403
                            ? "Your login expired. Sign in again, then repeat the voice entry."
                            : "Voice transcription failed. Check your connection and try again.");
                }
                JSONObject session = new JSONObject(responseBody);
                String transcript = session.getString("transcript");
                String sessionId = session.getString("id");
                if (transcript.isBlank() || sessionId.isBlank()) throw new IllegalStateException("Gnani returned an empty transcript. Please repeat the entry.");
                Log.i(LOG_TAG, "Transcription returned; opening existing confirmation flow.");
                if (pendingNativeAudio == audio) pendingNativeAudio = null;
                runOnUiThread(() -> {
                    nativeUploadInProgress = false;
                    if (webView == null) return;
                    String callback = "(function(){if(typeof window.prepareVoiceEntry==='function'){window.prepareVoiceEntry("
                            + JSONObject.quote(transcript) + "," + JSONObject.quote(sessionId)
                            + ");return true;}return false;})()";
                    webView.evaluateJavascript(callback, result -> {
                        if ("false".equals(result)) reportNativeUploadFailure("Transcript arrived, but the confirmation screen is unavailable. Reopen VoiceKhata and retry.");
                    });
                });
            } catch (Exception error) {
                String message = error.getMessage() == null ? "Voice transcription failed. Please try again." : error.getMessage();
                Log.e(LOG_TAG, "Native voice handoff failed: " + message);
                runOnUiThread(() -> {
                    nativeUploadInProgress = false;
                    reportNativeUploadFailure(message);
                });
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void writeMultipartText(BufferedOutputStream output, String boundary, String name, String value) throws Exception {
        output.write(("--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n"
                + value + "\r\n").getBytes(StandardCharsets.UTF_8));
    }

    private String readResponse(InputStream stream) throws Exception {
        if (stream == null) return "";
        try (InputStream input = new BufferedInputStream(stream);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
                if (output.size() > 128 * 1024) throw new IllegalStateException("Backend response was too large.");
            }
            return output.toString(StandardCharsets.UTF_8);
        }
    }

    private void reportNativeUploadFailure(String message) {
        if (webView != null) {
            String script = "(function(){var t=document.querySelector('#voice-title');if(t)t.textContent='Voice entry not transcribed';"
                    + "var c=document.querySelector('#voice-caption');if(c)c.textContent=" + JSONObject.quote(message)
                    + ";if(typeof window.voiceKhataNativeError==='function')window.voiceKhataNativeError(" + JSONObject.quote(message) + ");"
                    + "else if(typeof window.toast==='function')window.toast(" + JSONObject.quote(message) + ");})()";
            webView.post(() -> webView.evaluateJavascript(script, null));
        } else {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        }
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
        handsFreeAssistantSession = true;
        showWebApp(url);
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
        applySystemBarInsets(panel);
        TextView title = text("Unlock to continue", 24);
        title.setTypeface(null, 1);
        panel.addView(title);
        TextView body = text(message, 16);
        body.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(-1, -2);
        bodyParams.topMargin = dp(16);
        panel.addView(body, bodyParams);
        Button unlock = button("Unlock and review entry");
        makePrimary(unlock);
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
        if (handsFreeAssistantSession) {
            showHandsFreeOverlay("सुन रहा हूँ… अपनी एंट्री बोलिए।");
            return;
        }
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(36), dp(28), dp(36));
        panel.setBackgroundColor(0xfff3f2ed);
        applySystemBarInsets(panel);

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
        makePrimary(finish);
        addSetupButton(panel, finish);
        finish.setOnClickListener(view -> { if (audioRecorder != null) audioRecorder.finish(); });
        Button cancel = button("Cancel");
        addSetupButton(panel, cancel);
        cancel.setOnClickListener(view -> {
            if (audioRecorder != null) audioRecorder.cancel();
            audioRecorder = null;
            pendingNativeAudio = null;
            if (handsFreeAssistantSession || lockedAssistantCapture) {
                finish();
                return;
            }
            showWebRoot();
        });
        setContentView(panel);
    }

    private void continueAssistantLaunch() {
        if (!assistantLaunchPending || webView == null || !webPageReady) return;
        Log.i(LOG_TAG, "Assistant launch continuing; microphonePermission=" + hasMicrophonePermission());
        if (!hasMicrophonePermission()) {
            waitingForAssistantPermission = true;
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MICROPHONE);
            return;
        }
        webView.post(() -> webView.evaluateJavascript(
                "window.voiceKhataAssistantLaunch ? window.voiceKhataAssistantLaunch() : false", result -> {
                    if ("true".equals(result)) {
                        assistantLaunchPending = false;
                    } else if (assistantLaunchPending && webPageReady && webView != null) {
                        // The page can finish loading before its final app.js bootstrap has
                        // installed the bridge callback. Keep the hardware gesture pending.
                        webView.postDelayed(this::continueAssistantLaunch, 250);
                    }
                }));
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
                if (setupWizardActive) {
                    showAssistantWizardPrompt();
                } else if (waitingToOpenAfterPermission && pendingSetupUrl != null) {
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
                // Always reopen Android's assistant picker from this setup task, even
                // after VoiceKhata was selected, so the user can review/change it.
                startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT), REQUEST_ASSISTANT_ROLE);
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
