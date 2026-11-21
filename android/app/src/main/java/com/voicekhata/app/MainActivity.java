package com.voicekhata.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.role.RoleManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final int REQUEST_MICROPHONE = 7301;
    private static final int REQUEST_ASSISTANT_ROLE = 7302;
    private static final String PREFS = "voicekhata_mobile";
    private static final String PREF_WEB_URL = "web_app_url";

    private WebView webView;
    private PermissionRequest pendingWebPermissionRequest;
    private boolean assistantLaunchPending;
    private boolean waitingForAssistantPermission;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        assistantLaunchPending = isAssistantIntent(getIntent());
        String savedUrl = preferences().getString(PREF_WEB_URL, "");
        if (savedUrl.isEmpty()) showServerSetup(); else showWebApp(savedUrl);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (isAssistantIntent(intent)) {
            assistantLaunchPending = true;
            continueAssistantLaunch();
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
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(24), dp(28), dp(24), dp(24));
        layout.setGravity(Gravity.CENTER_VERTICAL);
        layout.setBackgroundColor(0xfff3f2ed);

        TextView title = text("Set up VoiceKhata", 26);
        title.setTypeface(null, 1);
        layout.addView(title);

        TextView description = text("Enter the secure web address where your VoiceKhata app and backend are hosted. The same shop data can then be used on your phone and laptop.", 16);
        LinearLayout.LayoutParams descriptionParams = new LinearLayout.LayoutParams(-1, -2);
        descriptionParams.topMargin = dp(12);
        layout.addView(description, descriptionParams);

        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setHint("https://your-voicekhata-server.example");
        address.setText(preferences().getString(PREF_WEB_URL, ""));
        LinearLayout.LayoutParams addressParams = new LinearLayout.LayoutParams(-1, -2);
        addressParams.topMargin = dp(24);
        layout.addView(address, addressParams);

        Button open = button("Save and open VoiceKhata");
        LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(-1, -2);
        openParams.topMargin = dp(12);
        layout.addView(open, openParams);

        Button assistant = button("Choose VoiceKhata as phone assistant");
        LinearLayout.LayoutParams assistantParams = new LinearLayout.LayoutParams(-1, -2);
        assistantParams.topMargin = dp(8);
        layout.addView(assistant, assistantParams);

        open.setOnClickListener(view -> {
            String url = normalizeWebUrl(address.getText().toString());
            if (url == null) {
                address.setError("Enter a valid HTTPS address");
                return;
            }
            preferences().edit().putString(PREF_WEB_URL, url).apply();
            showWebApp(url);
        });
        assistant.setOnClickListener(view -> requestAssistantSelection());
        setContentView(layout);
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
        assistant.setOnClickListener(view -> requestAssistantSelection());
        bar.addView(assistant, new LinearLayout.LayoutParams(-2, -2));
        root.addView(bar, new LinearLayout.LayoutParams(-1, -2));

        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
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
        setContentView(root);
        webView.loadUrl(url);
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
}
