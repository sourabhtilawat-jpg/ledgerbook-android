# Ledgerbook: GST billing for Android tablets and Windows PCs

Developed by **Sourabh Tilawat**.

An offline Android app for small shops. It covers items with HSN codes, customers and vendors,
purchases that add stock, live inventory, GST sales invoices numbered in sequence, and reports
(sales register, purchase register, GSTR-1, item-wise sales, stock summary).

After you save an invoice, the app opens WhatsApp on the customer's chat with the invoice PDF
already attached, so the shopkeeper only taps **Send**. You can also print any invoice with the
**Print** button, on an A4 printer or a 3-inch thermal printer.

## Get the APK (no software to install)

1. Create a free account at github.com and make a **new private repository**.
2. Click **uploading an existing file** and drag in **everything inside this folder**, including
   the hidden `.github` folder. (On a Mac, press Cmd+Shift+. in Finder to show hidden folders.)
   Then click **Commit changes**.
   If the **Actions** tab shows nothing, the hidden folder was skipped. Click *Add file → Create
   new file*, type `.github/workflows/build-apk.yml` as the name, paste in the contents of that
   file from this folder, and commit.
3. Open the **Actions** tab. The *Build Ledgerbook APK* job starts on its own and takes about
   5 minutes.
4. Open the finished run. Under **Artifacts**, download **Ledgerbook-APK**. It is a zip file that
   contains `Ledgerbook.apk`.

**For a permanent download link** you can send to shopkeepers: go to *Releases → Draft a new
release*, create a tag such as `v1.0` and publish it. The workflow attaches `Ledgerbook.apk` to
that release.

You can also open this folder in Android Studio and choose *Build → Build APK(s)*.

## Install on a tablet

Copy `Ledgerbook.apk` to the tablet (WhatsApp, Google Drive or USB) and tap it. Android asks you
to allow installs from that app once. The app needs Android 7.0 or newer.

## Keep these safe

- The signing key (`ledgerbook-release.jks` and `keystore.properties`) is deliberately **not** in
  this repository. Keep your copy from the project zip safe: every update must be signed with the
  same key, or tablets will refuse to install it over the old version. Without the key, GitHub builds
  `Ledgerbook-unsigned.apk`, which gets signed outside GitHub. To let GitHub sign it, add the
  repository secrets `KEYSTORE_BASE64` (the .jks file, base64-encoded) and `KEYSTORE_PASSWORD`.
- Shop data lives on the tablet. Uninstalling the app or using *Clear data* deletes it. Use
  **Settings → Download backup** regularly. Backups are saved in *Downloads/Ledgerbook*.

## WhatsApp

- **One-tap (default):** works with WhatsApp or WhatsApp Business on the tablet. It needs the
  customer's mobile number in their profile. Ten-digit numbers get +91 added.
- **Fully automatic (optional):** uses the WhatsApp Business Cloud API from Meta. In Meta Business
  Manager, set up a WhatsApp Business number and an approved message template with a **Document**
  header. Example body: `Dear {{1}}, your invoice {{2}} for Rs. {{3}} is attached.` Then enter the
  phone number ID, a permanent access token and the template name in
  **Settings → WhatsApp & printing**. Meta charges per message. If an automatic send fails, the
  app falls back to the one-tap flow.

## Updating the app

Edit `app/src/main/assets/www/index.html`, raise `versionCode` (and `versionName`) in
`app/build.gradle`, then upload the changes. A new APK is built automatically. If you change the
web version (`ledgerbook.html`), rebuild the page with
`python3 tools/build_index.py web/ledgerbook.html`.

## Windows app (EXE)

The same workflow builds `Ledgerbook-Setup-<version>.exe` on a Windows machine and saves it to the
`builds-exe` branch. The installer is not code-signed, so Windows SmartScreen may say "Windows
protected your PC". Click **More info → Run anyway**. Data is kept on that PC (back up from Settings).
Invoices are saved to *Downloads\\Ledgerbook*. *Send on WhatsApp* opens the customer's chat with the
message typed and opens the folder holding the PDF, so you can drag the PDF into the chat.
