package dev.bunaway.host;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.widget.TextView;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

/**
 * Android Activity entrypoint that connects one Bun backend and one WebView to the screen
 * lifecycle.
 *
 * <p>App subclasses can add native lifecycle handling in Java. Overrides must call the {@code
 * super} methods: {@link #onCreate} starts or reattaches the backend and {@link #onDestroy}
 * releases it.
 *
 * <p>A configuration change such as rotation recreates the Activity and WebView but keeps the Bun
 * process and Core state. Finishing the Activity shuts Bun down. Any startup, backend or WebView
 * failure closes both owners and shows the message instead of the app UI.
 */
public class BunawayActivity extends Activity {
    private BunProcess runtime;
    private Renderer renderer;
    private OnBackInvokedCallback backCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Back ends this single-view host, including root tasks opened by the home launcher.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            backCallback = this::finish;
            getOnBackInvokedDispatcher()
                    .registerOnBackInvokedCallback(
                            OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        try {
            // Reuse the backend retained across a configuration change; otherwise start one.
            Object retained = getLastNonConfigurationInstance();
            BunProcess owner =
                    retained instanceof BunProcess
                            ? (BunProcess) retained
                            : new BunProcess(new AppAssets(getApplicationContext()));
            runtime = owner;
            AppAssets assets = owner.assets;
            setTitle(assets.title);
            // Create the WebView only after the backend is ready, so the first document can
            // open its session immediately. A retained ready backend runs this synchronously.
            owner.attach(
                    () -> {
                        if (isFinishing() || isDestroyed()) return;
                        try {
                            Renderer created = new Renderer(this, assets, owner, this::showFailure);
                            renderer = created;
                            setContentView(created.view);
                            created.load();
                        } catch (Exception error) {
                            showFailure(
                                    error.getMessage() == null
                                            ? "WebView initialization failed"
                                            : error.getMessage());
                        }
                    },
                    (context, message) -> {
                        if (renderer != null) renderer.receive(context, message);
                    },
                    frame -> {
                        if (renderer != null) renderer.receiveChannel(frame);
                    },
                    this::showFailure);
            if (!(retained instanceof BunProcess)) owner.start();
        } catch (Exception error) {
            showFailure(error.getMessage() == null ? "App startup failed" : error.getMessage());
        }
    }

    /** Closes the document and backend, then replaces the UI with a plain failure message. */
    private void showFailure(String message) {
        if (renderer != null) renderer.close();
        renderer = null;
        if (runtime != null) runtime.close();
        TextView failure = new TextView(this);
        failure.setText(message);
        setContentView(failure);
    }

    /** Hands the backend to the recreated Activity during a configuration change. */
    @Override
    public Object onRetainNonConfigurationInstance() {
        return runtime;
    }

    /**
     * Preserves the same Back-to-finish contract before Android 13 and when predictive Back is
     * disabled.
     */
    @Override
    public void onBackPressed() {
        finish();
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
            backCallback = null;
        }
        // The WebView belongs to this Activity instance and is always destroyed with it.
        if (renderer != null) renderer.close();
        renderer = null;
        if (runtime != null) {
            runtime.detach();
            if (!isChangingConfigurations()) runtime.close();
        }
        super.onDestroy();
    }
}
