import geoip from "geoip-lite";
import Bowser from "bowser";
import { isIP } from "node:net";

export function visitDetails(req, event) {
  const rawIp = (req.ip || "").replace(/^::ffff:/, "");
  const ip = isIP(rawIp) ? rawIp : null;
  const ua = String(req.headers["user-agent"] || "").slice(0, 1000);
  const details = Bowser.parse(ua || "unknown");
  const geo = ip ? geoip.lookup(ip) : null;
  let referrer = "";
  try {
    referrer = new URL(event.referrer).origin;
  } catch {
    /* Direct visit. */
  }
  return {
    id: event.eventId,
    session_id: event.sessionId,
    path: event.path,
    referrer,
    ip,
    country: geo?.country || "",
    region: geo?.region || "",
    city: geo?.city || "",
    location_accuracy: geo ? "Approximate IP location" : "Unavailable",
    device: details.platform?.type || "unknown",
    device_model: [details.platform?.vendor, details.platform?.model]
      .filter(Boolean)
      .join(" "),
    browser: details.browser?.name || "",
    browser_version: details.browser?.version || "",
    os: details.os?.name || "",
    os_version: details.os?.version || "",
    user_agent: ua,
    language: event.language,
    timezone: event.timezone,
    screen: event.screen || "",
    notes: "",
  };
}
