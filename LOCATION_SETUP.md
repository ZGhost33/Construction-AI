# Location Check-In Setup Guide

When you arrive at a job site, your phone automatically sends a check-in to the pipeline.
The pipeline then tags all your recordings with the correct client — no guessing.

Check-ins expire after 12 hours, so driving to a new site automatically switches you over.

---

## Step 0 — Install Tailscale (everyone, one time)

Tailscale lets your phone reach the pipeline on Luis's Mac from anywhere.

1. Install **Tailscale** from the App Store (iPhone) or Google Play (Android) — it's free
2. Sign in with Google or email — use the **same account** everyone uses (ask Luis for the invite)
3. Once connected, your Mac's Tailscale IP will be something like `100.x.x.x` — Luis will share it

> Replace `YOUR_MAC_IP` in all instructions below with the actual Tailscale IP Luis gives you.

---

## iPhone Setup (Shortcuts app)

### Step 1 — Create the "Job Site Check-In" shortcut

1. Open the **Shortcuts** app
2. Tap **+** to create a new shortcut
3. Tap **Add Action**, search for **"Get Contents of URL"**
4. Configure it:
   - **URL:** `http://YOUR_MAC_IP:3456/set-location`
   - **Method:** POST
   - **Request Body:** JSON
   - Add two fields:
     - `pocket_api_key` → *(your Pocket API key — Luis will give you this)*
     - `client` → *(leave blank for now — the automation will fill this in)*
5. Name the shortcut **"Job Site Check-In"**

### Step 2 — Create one automation per client address

Repeat this for each job site you visit:

1. Go to the **Automation** tab in Shortcuts
2. Tap **+** → **Personal Automation**
3. Choose **Arrive** → tap **Choose** next to Location
4. Search for the client address (e.g. "5070 SE Burning Tree Circle")
5. Set radius to **100 meters**
6. Tap **Next**
7. Add Action → **Run Shortcut** → select "Job Site Check-In"
8. Before the Run Shortcut action, add a **Text** action with the client name (e.g. `Lisa Hannan`)
9. Pass that Text as the `client` field
10. Turn OFF **"Ask Before Running"**
11. Name it (e.g. "Arrive — Lisa Hannan")

**Repeat for every client address.**

### Quick test
Run the shortcut manually once and check:
```
http://YOUR_MAC_IP:3456/status
```
You should see your check-in in the response.

---

## Android Setup (MacroDroid — easier than Tasker)

### Step 1 — Install MacroDroid
Download **MacroDroid** from the Google Play Store (free tier works fine).

### Step 2 — Create a macro for each job site

Repeat for each client address:

1. Open MacroDroid → tap **Add Macro**
2. **TRIGGERS** → tap **+** → choose **Geofence**
   - Enter the client address
   - Set radius to **100 meters**
   - Select **Enter geofence**
3. **ACTIONS** → tap **+** → choose **HTTP Request / Webhook**
   - URL: `http://YOUR_MAC_IP:3456/set-location`
   - Method: **POST**
   - Content Type: **application/json**
   - Body:
     ```json
     {
       "pocket_api_key": "YOUR_POCKET_API_KEY",
       "client": "Lisa Hannan"
     }
     ```
   *(Replace with the actual client name for this macro)*
4. Name the macro (e.g. "Check-In — Lisa Hannan")
5. Tap the checkmark to save

**Repeat for every client address.**

### Quick test
Tap the play button on any macro to test it manually.

---

## Pocket API Keys (per person)

Each person needs their own Pocket API key — this is how the pipeline knows *whose* recording it is.

| Person | Pocket API Key |
|--------|---------------|
| Luis | `pk_c66b00868f13fa...` |
| Jorge | *(add when setting up)* |
| Danilo | *(add when setting up)* |
| Dustin | *(add when setting up)* |

To get a team member's Pocket API key: open their Pocket AI app → Settings → API → copy the key.

---

## Client Addresses

| Client | Address |
|--------|---------|
| Lisa Galan | 6022 SE Oakmont Pl, Stuart FL |
| Joe Galan | 6022 SE Oakmont Pl, Stuart FL |
| Brian Harris | 6285 SE Oakmont Pl, Stuart FL |
| Jane Joyce | 5071 SE Brandywine Way, Stuart FL |
| Kathrine Boland | 6320 SE Mariner Sands Dr, Stuart FL |
| Wendy and Kevin Callery | 5341 SE Burning Tree Circle, Stuart FL |
| Lisa Hannan | 5070 SE Burning Tree Circle, Stuart FL |
| Jack Mennella | 5957 SE Oakmont Pl, Stuart FL |
| Jesse and Eva Gallan | 503 Sabal Palm Lane, Palm Beach Gardens FL |
| Martha Glantz | 5611 SE Winged Foot Dr, Stuart FL |
| Diane Costello | 5243 SE Club Way, Stuart FL |

---

## How to verify it's working

Check the pipeline logs:
```bash
pm2 logs construction-bi
```

When someone arrives at a job site you'll see:
```
[Location] Check-in: pk_c66b00868f13... → "Lisa Hannan"
```

When their recording processes:
```
[Cruz Services] Location confirmed: "Lisa Hannan" (GPS check-in)
[Cruz Services] Client: "Lisa Hannan" (GPS-confirmed)
```
