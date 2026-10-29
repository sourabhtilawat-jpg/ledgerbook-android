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

## Several people at once: Ledgerbook Server (v1.4)

All devices of one business (for example the shopkeeper's Android tablet and the accountant's PC)
connect to **one Ledgerbook Server**. Everyone signs in with their own username and password, sees
changes live, and every change goes into the audit trail.

### Option 1: on the shop network (no internet needed)
1. Install the Windows app on the shop PC. Open **Settings → Multi-user & network → Host the server
   on this computer → Start server**. Tick *Start automatically with the app*.
2. Click **Create the admin account** and choose the admin's username and password.
3. Settings shows addresses like `http://192.168.1.10:8787`. On the Android tablet, open
   **Settings → Connect to a server**, enter that address and sign in. Any other computer can
   simply open that address in Chrome/Edge, no install needed.
4. If Windows asks about the firewall, allow access on **private** networks.
The server's data lives in *Documents\\Ledgerbook Server* on that PC. Back that folder up.

### Option 2: in the cloud (work from anywhere)
The repository includes a `Dockerfile` and `render.yaml`.
- **Render.com:** New → Blueprint → choose this repository. It creates the service with a
  persistent disk (the Starter plan is needed for the disk). You get an address like
  `https://ledgerbook-server.onrender.com`.
- **Any VPS (DigitalOcean, AWS Lightsail, Hostinger…):**
  `docker build -t ledgerbook . && docker run -d -p 8787:8787 -v ledgerbook-data:/data --restart unless-stopped ledgerbook`
  and put HTTPS in front of it (for example Caddy or Nginx with Let's Encrypt).
- Without Docker: install Node.js 18+, then run `node server/server.js` (data goes to `./ledgerbook-data`).
Then open the address in a browser, create the admin account, and connect the apps to it.
Always use **https://** for a cloud server.

### Users, rights and audit trail
- The admin adds users under **Users & rights**. Pick a role (Admin, Accountant, Cashier /
  Salesperson, Store manager, Viewer), then tick or untick individual rights. The server checks
  every change against the user's rights.
- **Audit trail** records every create, edit, cancel, delete, sign-in, failed sign-in and blocked
  attempt, with user, time, device, IP and old → new values. Each entry is hash-chained to the
  previous one; the screen shows whether the chain is intact. Entries can't be edited or deleted.
- Two people editing the same record: the second save is refused with a message and the record
  refreshes, so nobody overwrites someone else's work. Invoice numbers come from the server, so two
  counters billing at once never get the same number.

## GST portal, e-way bills and e-invoices (v1.5)

Ledgerbook prepares the files the government portals accept; you sign in and upload them there.

- **GSTR-1**: Reports → GSTR-1 (or the *GST & E-way* page) → *Download GSTR-1 JSON*. On gst.gov.in: Returns Dashboard → GSTR-1 → Prepare Offline → Upload.
- **E-way bill**: open an invoice → *E-way bill* → fill Part B (vehicle / transporter) → *Download e-way bill JSON*. On ewaybillgst.gov.in: E-waybill → Generate Bulk. Type the 12-digit EWB number back into Ledgerbook and it prints on the invoice.
- **E-invoice (IRN)**: turn it on in Settings if your turnover is above ₹5 crore. Download the INV-01 JSON, upload on the IRP, then paste the IRN, Ack no and signed QR back. The QR prints on the invoice.
- Filing straight from the app (no upload) needs a GST Suvidha Provider (GSP) account and an API user on the portal.

Also new: credit notes (sales returns), debit notes (purchase returns), quotations that convert to invoices, outstanding receivables/payables with ageing and WhatsApp reminders, day book, GSTIN checksum validation, and MRP-style prices that include GST.

## Ledgerbook 2.0

**Easier to use:** a new home screen with quick actions, a "needs attention" list (low stock, expiring batches, overdue payments, GST due dates, recurring invoices), a getting-started checklist, search everything (Ctrl+K or the Search button), and a grouped menu. Hindi (हिन्दी) is available in Settings.

**Turn features on in Settings → Features** so the screens stay simple:

| Feature | What it adds |
|---|---|
| Orders & delivery challans | Sales orders → delivery challans → invoices; purchase orders → "Receive goods" fills the purchase bill |
| Recurring invoices | Open an invoice → Repeat. Due invoices are created in one tap from the home screen |
| Barcodes | Barcode labels (A4 sheets or label printer rolls), billing with a USB scanner or the camera |
| Banking | Bank statement import (CSV) with auto-matching, reconciliation, cheque printing (CTS-2010) |
| Price lists | Wholesale / dealer prices, picked automatically for each customer |
| Batches & expiry | Batch and expiry on purchases, first-expiry-first-out billing, expiry alerts |
| Godowns | Stock per location and transfers between them |
| Manufacturing | Bill of materials and production entries, valued at component cost |
| Payroll | Employees, salary runs, PF, ESI, professional tax, TDS, payslips on WhatsApp |
| Exports | Export invoices in foreign currency, with or without IGST (LUT), in GSTR-1 table 6A |
| TCS | Tax collected at source on invoices, with a TCS register |
| Cost centres & budgets | Profit by branch or project, and budget vs actual |

Also new: stock count / adjustment, item ledger, GSTR-2B reconciliation, GSTR-9 working, composition scheme (bill of supply, CMP-08 and GSTR-4 working), cash flow statement, financial ratios, several companies on one device, and a "scan to pay" UPI QR printed on unpaid invoices.
