# Keystone Moulding Tracker

## Install through GitHub and Cloudflare

1. On GitHub, create a private repository named `keystone-moulding-tracker` and initialize it with a README. Open the repository, select **Add file → Upload files**, and drag in the contents of the extracted `moulding-tracker-web` folder. Keep the subfolders intact. Commit to `main`. The repository root should show `wrangler.jsonc`, `package.json`, `public/`, `src/`, `scripts/`, and `drawing-packs/`.
2. In Cloudflare, create a **D1 SQL Database** named `keystone-moulding-tracker` and copy its database ID. In **Zero Trust → Access controls → Applications**, create a **Self-hosted** application for the full hostname you want to use, such as `moulding.yourcompany.com`. Add an **Allow** policy that includes your setup email and any authorized shop staff. Copy the Access team domain and the application's audience tag from **Edit → Additional settings**.
3. On GitHub, open `wrangler.jsonc`, click the pencil icon, and enter the D1 ID under `database_id`. Enter the Access team hostname (without `https://`), audience tag, setup email, and the exact hostname from the Access application in the `routes` entry. Commit the change.
4. In **Cloudflare → Workers & Pages → Create application**, choose GitHub and select the repository. Set the Worker name to `keystone-moulding-tracker`, the branch to `main`, and the root directory to `/`. Use `npm run build` as the build command and `npx wrangler deploy` as the deploy command. Select **Save and Deploy**. The build unpacks the profile drawings into static assets.
5. Open the custom hostname and sign in with the email used in `TRACKER_SETUP_EMAIL`. Choose the initial tracking JSON in the setup form and click **Import tracking data**. Use the supplied Nov. 18 import or a newer export if the shop has made additional changes. The setup import creates the tables and loads the data once. The form disappears after a successful import. Keep the tracking JSON outside GitHub.
6. If you used the supplied Nov. 18 import, check **Already Run** for moulding **4002**, order **487827**, quantity **4**. If you used a newer export saved before strikethrough detection, re-import both report PDFs in the tracker to classify crossed-off rows.

## Daily use

Upload the MFG and Order Entry PDFs and select **Generate**. The browser reads the PDFs and saves the parsed schedule. Crossed-off rows stay off new requests and appear under **Already Run**. Saves are shared among signed-in operators. If someone saves first, review the refreshed list and repeat your intended action. Use one operator for the physical printing of each run.

## Cloudflare documentation

- [D1 database setup](https://developers.cloudflare.com/d1/configuration/data-location/)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
