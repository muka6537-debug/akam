// ============================================================
//  YouTube helpers (B2.a) — one parser for every link format so both
//  Shorts and regular long-form videos embed and play correctly:
//    youtube.com/watch?v=ID (+ &t=, &list=, extra params)
//    youtu.be/ID?si=…            youtube.com/shorts/ID
//    youtube.com/embed/ID         youtube.com/v/ID
//    youtube.com/live/ID          m.youtube.com / music.youtube.com
//    youtube-nocookie.com/embed/ID
// ============================================================
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extract the 11-char video id, or null when the URL is not YouTube. */
export function youtubeId(url = "") {
  if (!url || typeof url !== "string") return null;
  const raw = url.trim();
  if (ID_RE.test(raw)) return raw;
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, "").toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);
  let id = null;
  if (host === "youtu.be") id = seg[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.searchParams.get("v")) id = u.searchParams.get("v");
    else if (["shorts", "embed", "v", "live", "e"].includes(seg[0])) id = seg[1];
  }
  return id && ID_RE.test(id) ? id : null;
}

export function isShort(url = "") {
  return /youtube\.com\/shorts\//i.test(url || "");
}

/** Start offset in seconds from t= / start= (e.g. 90, 1m30s). */
function startSeconds(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const t = u.searchParams.get("t") || u.searchParams.get("start");
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
  } catch { return 0; }
}

/** Embed URL that plays both Shorts and long-form videos inline. */
export function youtubeEmbedUrl(url, { autoplay = false } = {}) {
  const id = youtubeId(url);
  if (!id) return null;
  const p = new URLSearchParams({ rel: "0", modestbranding: "1", playsinline: "1" });
  if (autoplay) p.set("autoplay", "1");
  const start = startSeconds(url);
  if (start) p.set("start", String(start));
  if (typeof window !== "undefined" && window.location?.origin) p.set("origin", window.location.origin);
  return `https://www.youtube-nocookie.com/embed/${id}?${p.toString()}`;
}

export function youtubeThumb(url) {
  const id = youtubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}
