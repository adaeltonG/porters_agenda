// Web Push: free notifications through the browsers' own push services (Apple, Google, Mozilla).
// The key pair is created once and kept in the database, so there is nothing to configure.
import * as webpush from "web-push";

let ready = false;
let publicKey = "";

export function initPush(store) {
  let keys = store.getMeta("vapid");
  if (!keys) {
    keys = JSON.stringify(webpush.generateVAPIDKeys());
    store.setMeta("vapid", keys);
  }
  const { publicKey: pub, privateKey } = JSON.parse(keys);
  // Apple rejects pushes whose contact isn't a real https:// or mailto: address.
  const subject = process.env.VAPID_SUBJECT || "https://zetahub.co.uk/porters/";
  webpush.setVapidDetails(subject, pub, privateKey);
  publicKey = pub;
  ready = true;
}

export const pushPublicKey = () => publicKey;

/**
 * Sends one notification to every phone registered to these porters.
 * Phones that unsubscribed or reinstalled are removed from the list.
 */
export async function notify(store, porters, { title, body, tag, url = "./" }) {
  if (!ready || !porters.length) return 0;
  const payload = JSON.stringify({ title, body, tag, url });
  let sent = 0;
  await Promise.all(store.subsFor(porters).map(async ({ sub }) => {
    try {
      await webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: "high" });
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) store.deleteSub(sub.endpoint);
      else console.error("Push failed:", e.statusCode || "", e.body || e.message);
    }
  }));
  return sent;
}
