package com.voicekhata.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/** Read-only content URI for the single payment QR image shared with other apps. */
public final class PaymentShareProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }

    private File sharedPaymentQr(Uri uri) throws FileNotFoundException {
        if (getContext() == null || uri == null || uri.getPathSegments().size() != 1
                || !"payment-qr.png".equals(uri.getLastPathSegment())) {
            throw new FileNotFoundException("Unknown shared image");
        }
        File image = new File(getContext().getCacheDir(), "voicekhata-payment-qr.png");
        if (!image.isFile()) throw new FileNotFoundException("Payment QR is unavailable");
        return image;
    }

    @Override public String getType(Uri uri) {
        return "image/png";
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection,
                                  String[] selectionArgs, String sortOrder) {
        try {
            File image = sharedPaymentQr(uri);
            MatrixCursor cursor = new MatrixCursor(new String[] {
                    OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE
            });
            cursor.addRow(new Object[] { "VoiceKhata-payment-QR.png", image.length() });
            return cursor;
        } catch (FileNotFoundException error) {
            return null;
        }
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Read-only provider");
        return ParcelFileDescriptor.open(sharedPaymentQr(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException(); }
}
