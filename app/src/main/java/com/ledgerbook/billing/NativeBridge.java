package com.ledgerbook.billing;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Methods the web app calls as window.LBNative.*  (all arguments are strings).
 */
public class NativeBridge {
    private static final String GRAPH = "https://graph.facebook.com/v23.0/";
    private static final String[] WHATSAPP_PACKAGES = {"com.whatsapp.w4b", "com.whatsapp"};

    private final Activity act;
    private final WebView web;
    private WebView printView; // kept so it is not garbage-collected while printing

    NativeBridge(Activity act, WebView web) {
        this.act = act;
        this.web = web;
    }

    private static String safeName(String name) {
        String n = name == null ? "file" : name.replaceAll("[\\\\/:*?\"<>|]", "-").trim();
        return n.isEmpty() ? "file" : n;
    }

    private File writeShared(String b64, String name) throws Exception {
        byte[] data = Base64.decode(b64, Base64.DEFAULT);
        File dir = SharedFileProvider.sharedDir(act);
        File[] old = dir.listFiles();
        if (old != null) for (File o : old) {
            if (System.currentTimeMillis() - o.lastModified() > 24L * 3600 * 1000) o.delete();
        }
        File f = new File(dir, safeName(name));
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(data);
        }
        return f;
    }

    private boolean installed(String pkg) {
        try {
            act.getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** Saves a file to Downloads/Ledgerbook. Returns where it went, or "error:...". */
    @JavascriptInterface
    public String saveFile(String b64, String name, String mime) {
        try {
            byte[] data = Base64.decode(b64, Base64.DEFAULT);
            String fname = safeName(name);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = act.getContentResolver();
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, fname);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Ledgerbook");
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) return "error:could not create file";
                try (OutputStream out = cr.openOutputStream(uri)) {
                    if (out == null) return "error:could not open file";
                    out.write(data);
                }
                return "Downloads/Ledgerbook/" + fname;
            }
            File dir;
            String label;
            if (act.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
                dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Ledgerbook");
                label = "Download/Ledgerbook/";
            } else {
                act.runOnUiThread(() -> act.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 7));
                dir = act.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                label = "Android/data/" + act.getPackageName() + "/files/Download/";
            }
            if (dir != null && !dir.exists()) dir.mkdirs();
            File f = new File(dir, fname);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(data);
            }
            return label + fname;
        } catch (Exception e) {
            return "error:" + e.getMessage();
        }
    }

    /**
     * Opens WhatsApp (Business first, then regular) straight to the customer's chat
     * with the PDF attached. Returns "ok", or "no_whatsapp" when it fell back to the
     * system share sheet.
     */
    @JavascriptInterface
    public String shareToWhatsApp(String b64, String name, String phone, String text) {
        try {
            File f = writeShared(b64, name);
            Uri uri = SharedFileProvider.uriFor(f);
            for (String pkg : WHATSAPP_PACKAGES) {
                if (!installed(pkg)) continue;
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("application/pdf");
                i.putExtra(Intent.EXTRA_STREAM, uri);
                i.putExtra(Intent.EXTRA_TEXT, text);
                if (phone != null && !phone.isEmpty()) i.putExtra("jid", phone + "@s.whatsapp.net");
                i.setClipData(ClipData.newRawUri(name, uri));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                i.setPackage(pkg);
                act.runOnUiThread(() -> {
                    try {
                        act.startActivity(i);
                    } catch (Exception e) {
                        openChooser(uri, text, "application/pdf");
                    }
                });
                return "ok";
            }
            act.runOnUiThread(() -> openChooser(uri, text, "application/pdf"));
            return "no_whatsapp";
        } catch (Exception e) {
            return "error:" + e.getMessage();
        }
    }

    /** Share any file through the system share sheet. */
    @JavascriptInterface
    public String shareFile(String b64, String name, String mime, String text) {
        try {
            File f = writeShared(b64, name);
            Uri uri = SharedFileProvider.uriFor(f);
            act.runOnUiThread(() -> openChooser(uri, text, mime));
            return "ok";
        } catch (Exception e) {
            return "error:" + e.getMessage();
        }
    }

    private void openChooser(Uri uri, String text, String mime) {
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType(mime);
        i.putExtra(Intent.EXTRA_STREAM, uri);
        if (text != null) i.putExtra(Intent.EXTRA_TEXT, text);
        i.setClipData(ClipData.newRawUri("file", uri));
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent c = Intent.createChooser(i, "Send invoice");
        c.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        act.startActivity(c);
    }

    /** Opens Android's print screen for the given HTML (any installed printer, or Save as PDF). */
    @JavascriptInterface
    public void printHtml(String html, String jobName) {
        final String job = safeName(jobName);
        act.runOnUiThread(() -> {
            WebView pv = new WebView(act);
            printView = pv;
            pv.setWebViewClient(new WebViewClient() {
                private boolean started = false;

                @Override
                public void onPageFinished(WebView view, String url) {
                    if (started) return;
                    started = true;
                    PrintManager pm = (PrintManager) act.getSystemService(Context.PRINT_SERVICE);
                    PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(job);
                    // Paper size is left to the printer dialog: A4 for office printers,
                    // 80 mm roll for thermal receipt printers.
                    PrintAttributes attrs = new PrintAttributes.Builder().build();
                    pm.print(job, adapter, attrs);
                }
            });
            pv.loadDataWithBaseURL(MainActivity.ORIGIN + "/", html, "text/html", "UTF-8", null);
        });
    }

    @JavascriptInterface
    public void openUrl(String url) {
        act.runOnUiThread(() -> {
            try {
                act.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
            }
        });
    }

    @JavascriptInterface
    public String appVersion() {
        try {
            return act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * Sends the invoice PDF through the WhatsApp Business Cloud API using an approved
     * template whose header is a Document. Runs off the UI thread and answers through
     * window.__lbCb(id, json).
     */
    @JavascriptInterface
    public void waCloudSend(String id, String json) {
        new Thread(() -> {
            JSONObject result = new JSONObject();
            try {
                JSONObject req = new JSONObject(json);
                String phoneId = req.getString("phoneId");
                String token = req.getString("token");
                byte[] pdf = Base64.decode(req.getString("pdf"), Base64.DEFAULT);
                String filename = req.optString("filename", "invoice.pdf");

                String mediaId = uploadMedia(phoneId, token, pdf, filename);

                JSONObject doc = new JSONObject().put("id", mediaId).put("filename", filename);
                JSONArray components = new JSONArray();
                components.put(new JSONObject().put("type", "header").put("parameters",
                        new JSONArray().put(new JSONObject().put("type", "document").put("document", doc))));
                JSONArray vars = req.optJSONArray("bodyParams");
                if (vars != null && vars.length() > 0) {
                    JSONArray params = new JSONArray();
                    for (int i = 0; i < vars.length(); i++)
                        params.put(new JSONObject().put("type", "text").put("text", vars.getString(i)));
                    components.put(new JSONObject().put("type", "body").put("parameters", params));
                }
                JSONObject msg = new JSONObject()
                        .put("messaging_product", "whatsapp")
                        .put("to", req.getString("to"))
                        .put("type", "template")
                        .put("template", new JSONObject()
                                .put("name", req.getString("template"))
                                .put("language", new JSONObject().put("code", req.optString("lang", "en")))
                                .put("components", components));
                String resp = postJson(GRAPH + phoneId + "/messages", token, msg.toString());
                JSONObject r = new JSONObject(resp);
                result.put("ok", true);
                if (r.has("messages")) result.put("messageId", r.getJSONArray("messages").getJSONObject(0).optString("id"));
            } catch (Exception e) {
                try {
                    result.put("ok", false).put("error", e.getMessage());
                } catch (Exception ignored) {
                }
            }
            final String out = result.toString();
            act.runOnUiThread(() -> web.evaluateJavascript(
                    "window.__lbCb && window.__lbCb(" + JSONObject.quote(id) + "," + JSONObject.quote(out) + ")", null));
        }).start();
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        in.close();
        return bo.toString("UTF-8");
    }

    private static String graphError(int code, String body) {
        try {
            JSONObject e = new JSONObject(body).getJSONObject("error");
            return e.optString("message", "HTTP " + code);
        } catch (Exception x) {
            return "HTTP " + code;
        }
    }

    private static String uploadMedia(String phoneId, String token, byte[] pdf, String filename) throws Exception {
        String boundary = "----lb" + System.currentTimeMillis();
        HttpURLConnection c = (HttpURLConnection) new URL(GRAPH + phoneId + "/media").openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        c.setDoOutput(true);
        c.setRequestMethod("POST");
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (OutputStream out = c.getOutputStream()) {
            String crlf = "\r\n";
            StringBuilder sb = new StringBuilder();
            sb.append("--").append(boundary).append(crlf)
                    .append("Content-Disposition: form-data; name=\"messaging_product\"").append(crlf).append(crlf)
                    .append("whatsapp").append(crlf);
            sb.append("--").append(boundary).append(crlf)
                    .append("Content-Disposition: form-data; name=\"type\"").append(crlf).append(crlf)
                    .append("application/pdf").append(crlf);
            sb.append("--").append(boundary).append(crlf)
                    .append("Content-Disposition: form-data; name=\"file\"; filename=\"").append(filename.replace("\"", "")).append("\"").append(crlf)
                    .append("Content-Type: application/pdf").append(crlf).append(crlf);
            out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
            out.write(pdf);
            out.write((crlf + "--" + boundary + "--" + crlf).getBytes(StandardCharsets.UTF_8));
        }
        int code = c.getResponseCode();
        String body = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
        if (code >= 400) throw new Exception(graphError(code, body));
        return new JSONObject(body).getString("id");
    }

    private static String postJson(String url, String token, String json) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setDoOutput(true);
        c.setRequestMethod("POST");
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = c.getOutputStream()) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
        }
        int code = c.getResponseCode();
        String body = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
        if (code >= 400) throw new Exception(graphError(code, body));
        return body;
    }
}
