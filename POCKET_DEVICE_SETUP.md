# Pocket AI Device Setup — Cruz Services Field Team

Each crew member follows these steps once on their phone. Takes about 5 minutes.

---

## Part 1 — Get Your Pocket API Key

1. Open the **Pocket AI app** on your phone
2. Tap **Settings** (gear icon)
3. Tap **API Key** (or Developer / Integrations)
4. Copy the key — it starts with `pk_`
5. Send it to Luis via WhatsApp

That's all Luis needs to connect your device to the pipeline.

---

## Part 2 — GPS Auto Check-In

This tells the pipeline which client job site you're at, so recordings get filed to the right client automatically.

Choose your phone type below.

---

## iPhone Setup — Shortcuts Automation

### Step 1: Install the Shortcut

1. Open the **Shortcuts** app
2. Tap the **Automation** tab (bottom)
3. Tap **+** → **New Automation**
4. Tap **Location**
5. Tap **Choose** → search for the client address → set radius to ~100m
6. Set trigger to **Arrives**
7. Tap **Next**
8. Tap **Add Action** → search **Get Contents of URL**
9. Configure it:
   - **URL:** `http://5.161.227.111:3456/set-location`
   - **Method:** POST
   - **Request Body:** JSON
   - Add two fields:
     - `pocket_api_key` → your `pk_...` key
     - `client` → exact client name (e.g. `Brian Harris`)
10. Turn OFF **Ask Before Running**
11. Tap **Done**

Repeat for each client job site.

### Client Addresses for Shortcuts

| Client | Address |
|---|---|
| Lisa and Joe Galan | 6022 SE Oakmont Pl, Stuart FL |
| Brian Harris | 6285 SE Oakmont Pl, Stuart FL |
| Jane Joyce | 5071 SE Brandywine Way, Stuart FL |
| Kathrine Boland | 6320 SE Mariner Sands Dr, Stuart FL |
| Lisa Hannan | 5070 SE Burning Tree Circle, Stuart FL |
| Jack Mennella | 5957 SE Oakmont Pl, Stuart FL |
| Jesse and Eva Gallan | 503 Sabal Palm Lane, Palm Beach Gardens FL |
| Martha Glantz | 5611 SE Winged Foot Dr, Stuart FL |
| Diane Costello | 5243 SE Club Way, Stuart FL |
| Deb Vivian | 7029 SE Golf House Drive, Stuart FL |

---

## Android Setup — MacroDroid

### Step 1: Install MacroDroid

Download **MacroDroid** from the Play Store (free).

### Step 2: Create a Macro for Each Job Site

1. Open MacroDroid → tap **Add Macro**
2. Name it (e.g. "Check in — Brian Harris")

**Trigger:**
- Tap **Triggers** → **Location** → **Enter/Exit Area**
- Search for the client address
- Set radius ~100m
- Select **Enter Area**

**Action:**
- Tap **Actions** → **Networking** → **HTTP Request**
- Configure:
  - **URL:** `http://5.161.227.111:3456/set-location`
  - **Method:** POST
  - **Body type:** JSON
  - **Body:**
    ```json
    {
      "pocket_api_key": "pk_YOUR_KEY_HERE",
      "client": "Brian Harris"
    }
    ```
    (Replace with your actual key and client name)

3. Tap **OK** → **Save Macro**

Repeat for each job site.

### Client Addresses for MacroDroid

Same addresses as the iPhone table above.

---

## Testing Your Check-In

Once set up, you can verify it's working by sending Luis a message. He can check the pipeline log to see if your device checked in.

Or check status yourself by opening a browser and going to:
```
http://5.161.227.111:3456/status
```

It will show all current check-ins with timestamps.

---

## How It Works

When you arrive at a job site:
1. Your phone automatically fires the check-in (no button to press)
2. The pipeline tags your next recording to that client
3. Claude still analyzes the conversation, but the client match is confirmed by GPS — no guessing
4. Notes go to the right Jobber job automatically

The check-in stays active for **12 hours**, so one arrival covers a full work day at that site.
