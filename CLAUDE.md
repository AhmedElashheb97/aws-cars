# AWS cars: developer handoff for Claude Code

You are taking over development of this app from another Claude session. Read this file fully before changing anything.

## The owner and how he works

- **Owner:** Moayed Alremih (Tripoli, Libya), who runs the car import business **AWS** (Alashhab Washurakauh Co. for the Import of Cars & Spare Parts). **Ahmed Ismaeil Ahmed Alashhab** is General Manager, owns the GitHub repo the live site deploys from, and is the app's main admin.
- **Language:** Moayed writes in English or Libyan Arabic. Reply in the language he used, short and plain. The app UI is Arabic first (RTL) with English.
- **No emojis** anywhere in the app. Icons are SVG line icons via `ic(name)` (see `ICN` in `index.html`).
- **Before a big or risky change** (money formulas, data migration, deleting data), explain what you will change and get his OK. Small UI fixes: just do them.
- **After every change:** test in demo mode (below), commit, push, and give him the compare link so Ahmed can merge.

## Repo, deploy and git workflow

- **This repo:** `Nazoi99/aws-cars` (Moayed's fork). **Upstream:** `AhmedElashheb97/aws-cars`.
- **Live site:** https://aws-cars.vercel.app, deployed by Vercel from **Ahmed's repo** `main` (Vercel team `ahmed-7513`, project `aws-cars`). Changes go live only after Ahmed merges a PR.
- **Workflow:**
  1. `git fetch https://github.com/AhmedElashheb97/aws-cars main` and merge it first, because Ahmed sometimes edits `index.html` directly.
  2. Make the change, test, commit, push to `Nazoi99/aws-cars` `main`.
  3. Give Moayed this link to open the PR: https://github.com/AhmedElashheb97/aws-cars/compare/main...Nazoi99:aws-cars:main
- **Commit author must be** `-c user.name="Nazoi99" -c user.email="106674546+Nazoi99@users.noreply.github.com"`. Vercel blocked a deploy once when the author was different.
- **Merge conflicts with Ahmed:** keep both sides' features. When he and we changed the same block, ask Moayed which to keep.

## Architecture

| File | What it is |
|---|---|
| `index.html` | The whole app (~2,800 lines): HTML, CSS and one `<script type="module">`. Firebase JS SDK v10.12.2 from gstatic. |
| `ports-data.js` | `window.AWS_PORTS`: yards, towing prices and ocean rates (Atlantic Express) for the port map, lazy-loaded. Prices include our markup (+$25 towing, +$25 per car ocean). |
| `api/mcp/[key].js` | Vercel serverless function: MCP connector for Claude (JSON-RPC over HTTP). |
| `lib/tools.js` | The connector tools (read/write customers, cars, payments, treasury...). |
| `lib/calc.js` | **Copy of the money formulas from `index.html`.** If you change a formula in the app, change it here too. |
| `lib/db.js` | Firestore via Firebase Admin; env `FIREBASE_SERVICE_ACCOUNT`. |
| `API_SETUP.md` | Connector setup for the owner. |
| `logo.png`, `logo-light.png`, icons | Brand assets (logo "AXS"). |

**Inside `index.html`:**
- **`L(ar, en)`** returns the string for the current language. Every UI string uses it.
- **`S`** is global state: `customers`, `vehicles`, `payments`, `expenses`, `treasury`, `internal` (vinternal by car id), `settings`, `users`, `apikeys`, `me`, `route`.
- **`A`** holds all actions, called from inline `onclick="A.x()"`. Helpers used inline must be exposed on `window` (for example `window.exRow`, `window.S`, `window.render`).
- **`DB`** wraps Firestore: `watch / add / update / merge / del / get`. In **demo mode** it uses `localStorage` keys `cop_<collection>`.
- **Routing** is by hash (`#/vehicles`, `#/vehicle/<id>`, `#/customer/<id>`, `#/payments`, `#/collect`, `#/ports`, `#/profit`, `#/expenses`, `#/treasury`, `#/connector`, `#/logs`, `#/settings`, `#/users`). The view functions are `vXxx()`, and `shell()` builds the sidebar and bottom nav.
- **Permissions:**
  - The `PERMS` list holds `edit, payments, delete, profit, expenses, logs, settings`. `can(p)` checks them; `isAdmin()` is true for `ADMIN_EMAIL` = ahmedesmal97@gmail.com.
  - `ROUTE_PERM` gates pages. The `NEED` map gates actions: `applyPerms()` hides buttons whose `onclick` calls an action the user can't do.
  - Elements with class `pf` are hidden for users without `profit`.
- **`logAct(act, details, ref)`** writes to the activity log. Add a label for any new `act` key in the log label map.

## Data model (Firestore)

- **`customers`:** `code` (4-digit, starts at 4478, `nextCode()`), `full_name`, `phone`, `alternate_phone`, `city`, `notes`.
- **`vehicles`:**
  - Details: `customer_id`, `vin`, `lot_number`, make/model/year…, `auction_name`, `auction_location`, `us_port`, `ship_port` (ship from another port), `yard`, `cars_per_container`, `container_number`, `status` + `status_history`, `purchase_date`, `auction_paid_by` ('office' = office advance), `auction_invoice` (chunked in `tracking`), `images`.
  - Money: `fin` {`bid_price, auction_fees, inland_shipping, ocean_shipping, office_commission, transfer_commission, other_fees`}, `extras` [{d, a}] (pass-through charges to the customer, **not profit**).
  - `transfers` ("how we paid"): [{id, purpose: auction/shipping/towing/other, payee, method, src (account used, e.g. "moayed card 5541"), amount (USD), cur, cur_amount, rate, status: pending/sent/confirmed, items, receipt…}].
- **`vinternal/{carId}`** (profit permission only): `shipping_cost_actual`, `wire` {rate, lyd, agent}, `tcost` {transferId: net cost}, `tcostd` {transferId: {method, rate, card_back, pp_pct, lyd_cost, agent_fee, disc_pct, other_cost}}.
- **`payments`** (from customers): `customer_id`, `vehicle_id`, `amount`, `currency` (USD/LYD), `rate`, `amount_usd`, `date`, `method`, `ref`.
- **`expenses`:** `category`, `amount`, `currency`, `rate`, `amount_usd`, `date`, `notes`.
- **`treasury`:** `kind` (open/in/out/move), `box`, `cur`, `amount`, `cat`, `party`, `desc`, `ref`, `to_box`, `to_cur`, `to_amount`, `date`. All entries are manual. Open to every user; deleting needs `delete`.
- **`tracking/{VIN}`:** public customer tracking page data, plus `office_invoice` snapshot (auto-synced by `queueInvSync`).
- **`settings/main`:** office info, `rate` (LYD per USD), `fee_cust` 1.5, `disc_copart` 3.5, `fee_paypal` 2.5, `card_back` 0.08, `wire_lyd` 0.12, `agent_k` 0.
- **`users/{email}`:** `role`, `perms`, `active`. **`logs`**. **`receipts`** (chunked receipt files).
- **`apikeys/{sha256(key)}`:** `name`, `access` (full/read), `owner` (email), `active`, `prefix`, `last_used`. The key itself is never stored.
- **Firestore security rules:** published by hand in the Firebase console. The current set is in the comment at the top of `index.html`. If you add a collection, add a rule there **and** tell Moayed to publish it.

## Money rules (the business)

- **Customer pays in two stages** (`stages(v)`):
  1. **On purchase:** bid + auction fees + auction extras (`st: 1`, e.g. auction storage) + office commission ($150) + other fees + **the transfer fee share for this stage**.
  2. **On arrival:** towing + ocean + other extras + **the transfer fee share for this stage**.
  - The transfer fee is one field (`transfer_commission`), split by `feeSplit(v)` in proportion to what is sent to the US in each stage.
  - Customer payments cover stage 1 first. About 80% of customers pay stage 1 up front.
- **Transfer fee** = `fee_cust`% (1.5%) × (bid + fees + towing + ocean + extras). It's auto-filled in the car form unless edited by hand.
- **Extras** (`extras` [{d, a, st, rc}]):
  - `st: 1` = paid with the auction in the US (auction storage): billed in stage 1, a pass-through (not profit, no shipping wire).
  - `rc: true` = pays back a cost **we** already paid: counted as income that offsets the payment cost.
  - Otherwise a shipping pass-through in stage 2 (we pay it onward by wire).
- **Who pays payment-method losses:** PayPal fees and card/FX losses are the **company's loss** (booked on the payment in `tcostd`), not charged to the customer.
- **Payment methods (how we pay the auction):**
  - Wire, MoneyGram and WU cost an LYD premium (about 0.12 LYD per USD, entered by hand) plus an agent fee. **Copart only** gives a 3.5% discount for these; IAAI gives none.
  - **Card** returns about 0.08 LYD per USD. That's a **gain**, and it varies per payment.
  - **PayPal** charges about 2.5% (one Copart payment showed 4.5%).
  - **Towing and shipping are paid by wire only.**
- **Expected profit** = office + transfer fee − recorded payment costs − expected shipping wire cost (`wireEst`) + shipping margin (charged towing+ocean+extras − actual cost).
- **Actual profit received** (`received(v)`): counts gains only.
  - The office fee and the stage-1 transfer fee count once stage 1 is paid. The stage-2 transfer fee and shipping margin count once fully paid. Card returns and Copart discounts count from recorded payments.
  - **Costs are deducted only once the car has arrived (status ≥ ARRIVED_LOCAL_PORT) and is fully paid.**
- **Profit** is shown only on the Profit page and the car page (with `profit` permission), never on the dashboard.
- **Moving a car** to another Atlantic Express port: the "move" select in the transfers box keeps the yard towing, switches ocean to the new port's rate and adds a transfer line (an extra, not profit).

## Testing (demo mode)

1. Copy `index.html` with the Firebase `apiKey` replaced by `PASTE` (that switches to demo mode with `localStorage`).
2. Serve the folder: `python3 -m http.server 8765`.
3. Open `http://localhost:8765/index.html?as=demo@local` (main admin) or `?as=someone@x.com` (a normal user; seed `cop_users`).
4. Seed data by writing `localStorage` keys (`cop_customers`, `cop_vehicles`, `cop_vinternal`, `cop_payments`, `cop_settings`...).
5. Use Playwright (pre-installed) to click through and take screenshots. Look at them before saying it works.

**Reference check:** the Kona test car should give these numbers:
- Inputs: bid 1250, fees 675, office 150, towing 145, ocean 1600 (LAX), extra 1600, actual cost 1695, wire rate 7.35, card payment 1925 with return 0.08, customer paid 2075.
- Results: total **$5,499.05**, fee **$79.05** (stage 1 $28.88, stage 2 $50.17), stage 1 **$2,103.88**, expected profit **$246.20**, received **$20.95** (the customer paid $2,075, less than stage 1, so the office fee is not received yet).

Test the API with a mock DB: call `require('./lib/db').setDb(mock)`, set `FIREBASE_SERVICE_ACCOUNT='{}'`, and call the handler with fake `req`/`res`.

## Open items (not done yet)

1. **Connector setup.** `FIREBASE_SERVICE_ACCOUNT` in Vercel currently holds a wrong value. The endpoint answers `server_error ... is not valid JSON`, so it must be the **whole** service-account `.json` content. Moayed must paste it himself, then redeploy; never handle the key yourself. Then test with **Claude connector > Test connection**.
2. **Accounting audit findings, waiting for Moayed's decision.** None are fixed yet:
   1. **Expected profit inflates when shipping is partly paid.** `actCost` uses recorded shipping/towing payments as the whole cost (towing $145 paid made the profit $3,375). Also, an extra paid with purpose "other" counts as profit. **Fix:** cost = max(recorded, expected) per part, and count extras as cost regardless of purpose.
   2. **The office advance stays "owed"** after the customer pays stage 1 (`advOut` uses the whole balance). **Fix:** advance owed = bid + fees − paid.
   3. **The invoice / tracking page merges the transfer fee into the bid price** ("Purchase & transfer"), but the fee is now stage 2. Ahmed added an invoice-options dialog with a merge toggle; check it before changing.
   4. **A customer payment without a car** never completes any car's stages.
   5. **Pending "how we paid" payments** count in expected profit but not in received profit.
   6. **Monthly profit:** costs are deducted in the full-payment month, not the arrival month.
   7. **The Profit list modal** still shows old per-stage columns.
   8. **Collections** counts stage 2 as owed before the car arrives.
   9. **Needs Moayed's answer:** should extras be included in the 1.5% fee base? (He gave the formula without extras.)
   10. **Needs Moayed's answer:** is the Copart discount calculated on the amount before or after the discount?
   11. **Needs Moayed's answer:** what is "other fees" (pass-through or office income)?
   12. **Needs Moayed's answer:** should an expected cost or gain be shown before the auction payment is recorded?
3. **Treasury** is manual. A later idea is to link customer payments and "how we paid" to treasury boxes automatically. Ask before building it.

## Don'ts

- **Don't put secrets in the repo:** no service-account JSON, connector keys or passwords. The repo is public through the static site.
- **Don't** change the money formulas in only one place: update `index.html` and `lib/calc.js` together.
- **Don't** delete or migrate real data without a backup (Settings > Download backup) and Moayed's OK.
- **Don't** add emojis.
