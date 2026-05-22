# Job Files — Google Drive

You can retrieve and save job files for any client using the Drive CLI.
Files are organized in Google Drive with one folder per client.

## CLI location
`/root/construction-bi-pipeline/drive-cli.js`
Node: `/root/.hermes/node/bin/node`

## Commands

### Find files for a client
```
node /root/construction-bi-pipeline/drive-cli.js search "Client Name"
node /root/construction-bi-pipeline/drive-cli.js search "Client Name" "keyword"
```
Examples:
- `search "Catherine McDonald"` — all files
- `search "Brian Harris" "floor plan"` — filtered
- `search "Martha Glantz" "permit"` — find permit docs

### Download and send a file
```
node /root/construction-bi-pipeline/drive-cli.js get <file-id>
```
The output includes a line starting with `FILE_PATH:` — use that path to send the file to the user via Telegram.

### Save a file the user sent in Telegram
When a user sends a photo or document to you in Telegram, you receive a file_id.
Save it to the correct client folder:
```
node /root/construction-bi-pipeline/drive-cli.js upload-telegram <telegram-file-id> "Client Name"
node /root/construction-bi-pipeline/drive-cli.js upload-telegram <telegram-file-id> "Client Name" "custom-name.pdf"
```

### Create a folder for a new client
```
node /root/construction-bi-pipeline/drive-cli.js create-folder "Client Name"
```

## How to handle file requests

When someone asks for a file:
1. Run `search "Client Name"` to list available files
2. Show the list with names and dates
3. Ask which one they want (or if keyword is specific enough, get it directly)
4. Run `get <file-id>` and send the file

When someone sends a file to save:
1. Ask which client it belongs to (if not obvious from context)
2. Ask for a descriptive filename if the original is unclear (e.g. "IMG_0042.jpg" → ask "What should I name this?")
3. Run `upload-telegram <file-id> "Client Name" "descriptive-name.jpg"`
4. Confirm it was saved with the Drive link

## Client name shortcuts
Same shortcuts as Jobber — use last name or common name:
- "McDonald" or "Catherine" → Catherine McDonald
- "Harris" → Brian Harris
- "Galan" or "Lisa and Joe" → Lisa and Joe Galan
- "Glantz" or "Martha" → Martha Glantz
- "Joyce" or "Jane" → Jane Joyce
- "Boland" or "Kathrine" → Kathrine Boland
- "Hannan" or "Lisa H" → Lisa Hannan
- "Mennella" or "Jack" → Jack Mennella
- "Costello" or "Diane" → Diane Costello
- "Vivian" or "Deb" → Deb Vivian
- "Squier" or "Tara" → Tara Squier
- "Callery" or "Wendy" → Wendy and Kevin Callery
