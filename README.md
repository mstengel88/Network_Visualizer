# Ubiquiti Network Visualizer

A starter React app for visualizing UniFi network racks, devices, port labels, uplinks, and future planning items.

## Run locally

```sh
npm install
npm run dev
```

## Build before pushing to GitHub

```sh
npm install
npm run build
```

The production build is written to `dist/`. The `dist/` folder is ignored by git because Docker and GitHub users should rebuild it from source.

## Run on a Raspberry Pi with Docker

This project includes a `Dockerfile` and `docker-compose.yml`. The container runs the Vite server so the app and the local `/api/unifi/*` proxy endpoints both work.

On the Pi:

```sh
sudo apt update
sudo apt install -y git docker.io docker-compose-plugin
sudo usermod -aG docker $USER
```

Log out and back in so the Docker group change applies, then clone and run:

```sh
git clone https://github.com/YOUR-USERNAME/YOUR-REPO.git
cd YOUR-REPO
docker compose up -d --build
```

Open the app from another machine on the same network:

```text
http://YOUR-PI-IP:5173
```

To view logs:

```sh
docker compose logs -f
```

To update after pushing new code:

```sh
git pull
docker compose up -d --build
```

Plan snapshots saved from the app are stored on the Pi in `./data/plans`.

## Move your current rack plan to the Pi

Before moving computers or browsers, open the app on your current machine and click **Export plan JSON** in the top-right toolbar. Keep that JSON file as your backup.

After the app is running on the Pi:

1. Open `http://YOUR-PI-IP:5173`.
2. Click **Restore plan JSON** in the top-right toolbar or in the Ubiquiti Sync panel.
3. Pick the JSON file you exported.
4. Confirm the restore.
5. Click **Save plan** so the Pi also writes a server-side copy into `./data/plans`.

The restore replaces the current browser project, clears stale local rack overrides, and then saves the restored inventory back into browser storage. The JSON export is the portable backup you can keep, commit elsewhere, or restore into another browser.

## Current capabilities

- Business and site rack selection
- Rack elevation view with U positions
- Device status, model, and IP-ready inventory model
- Searchable port map with VLAN and endpoint labels
- Multi-rack connection summary
- UniFi account connection profile with controller URL, site ID, and API token
- Connection test hook for API-token based access
- Ubiquiti sync panel ready for future API or exported configuration import

## Adding your UniFi account

Open the Ubiquiti Sync panel and save a connection profile with:

- A profile name
- Connection mode, either cloud/site manager or local console
- Controller URL:
  - Cloud: `https://api.ui.com`
  - Local console: your local UniFi OS console URL, such as `https://192.168.1.1`
- Site ID, often `default` for single-site controllers
- API token

For cloud access, create the key from UniFi Site Manager at `https://unifi.ui.com/settings/api-keys`. The official Site Manager API uses `https://api.ui.com` and sends the key as an `X-API-Key` header.

The current starter app stores the token in browser local storage so the UI can be tested without a backend. Before production use, move token storage and UniFi API calls behind a local backend or hosted proxy so secrets are not exposed to the browser.

During local development, the connection test goes through Vite's `/api/unifi/test` proxy. That avoids browser CORS failures and also allows testing local UniFi consoles that use self-signed HTTPS certificates.

If the cloud test reports `HTTP 302`, the URL is still pointing at the UniFi web dashboard instead of the API host. Use `https://api.ui.com` for cloud mode. Local mode still uses direct UniFi console paths.

## Next integration step

Replace the sample data in `src/data.ts` with a UniFi Network import adapter that maps sites, devices, ports, VLANs, clients, and topology records into the types in `src/types.ts`.
