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

### 2. Vercel environment variable (one time)
In vercel.com > the **aws-cars** project > **Settings** > **Environment Variables**, add for *Production*:

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | the whole content of the `.json` file from step 1 (open it in a text editor, copy all) |

Then **Deployments** > the latest one > **Redeploy**.

### 3. Firestore rule (one time)
In Firestore > Rules, add this line next to the other `match` lines, then **Publish**:
```
match /apikeys/{id}   { allow read, write: if isAdmin(); }
```

### 4. Create a key in the app
The main admin opens **Settings** > **Claude connector (API)**:
- **Test connection** checks that the server and Firebase key are set up.
- **New key**: pick a name and the access (full or read only). Copy the link; it is shown only once.
- **Turn off** or delete a key at any time; any connection using it stops.

### 5. Add the connector in Claude
1. In Claude: **Settings** > **Connectors** > **Add custom connector**.
2. Name: `AWS cars`. URL: the link from the app.
3. Save, then turn it on in a chat from the tools menu.

The link is the password. Anyone with it can reach the data, so don't share it.
Changes made through a key appear in the Activity log as **Claude API · key name**.
Optional: `MCP_SECRET` in Vercel works as an extra full-access key (`/api/mcp/<MCP_SECRET>`).

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
