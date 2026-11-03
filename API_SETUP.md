# Claude connector for AWS cars

The folder `api/` adds a connector so Claude can read and change the system directly from a chat
(cars, customers, payments, how we paid, expenses, treasury, profit). It uses the same formulas as the app.

Every change Claude makes appears in the Activity log as **Claude API**.

## One-time setup

### 1. Firebase service account key
1. Open console.firebase.google.com > project **aws-cars**.
2. Gear icon > **Project settings** > **Service accounts**.
3. Click **Generate new private key** > **Generate key**. A `.json` file downloads.
   Keep it private: it gives full access to the database.

### 2. Vercel environment variables
In vercel.com > the **aws-cars** project > **Settings** > **Environment Variables**, add for *Production*:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | the whole content of the `.json` file from step 1 (open it in a text editor, copy all) |
| `MCP_SECRET` | a long random password, at least 16 characters, letters and numbers only |

Then **Deployments** > the latest one > **Redeploy**, so the variables take effect.

### 3. Add the connector in Claude
1. In Claude: **Settings** > **Connectors** > **Add custom connector**.
2. Name: `AWS cars`
3. URL: `https://aws-cars.vercel.app/api/mcp/<MCP_SECRET>`, with your `MCP_SECRET` value at the end.
4. Save, then enable it in a chat from the tools menu.

The secret in the URL is the password. Anyone with the full URL can change the data, so don't share it.
To cut access, change `MCP_SECRET` in Vercel and redeploy.

## What Claude can do

- **Read:** overview, customers, cars, customer payments, how we paid, expenses, treasury, profit report, activity log, settings.
- **Add:** customers, cars, customer payments, how-we-paid payments with their costs, expenses, treasury entries.
- **Change:** customers, cars (details, money, extras, internal cost), car status (also updates the customer tracking page), or any record directly.
- **Delete:** customers, cars, payments, expenses, treasury entries. Claude must ask you to confirm first.

## Files
- `api/mcp/[key].js` is the connector endpoint (MCP over HTTP).
- `lib/tools.js` holds the tools.
- `lib/calc.js` holds the money formulas, copied from `index.html`. If a formula changes in the app, change it here too.
- `lib/db.js` is the Firestore access.
