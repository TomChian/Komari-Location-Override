/**
 * Komari 地区识别手动修正插件 1.1.5
 * 可选按节点名称或 UUID 匹配；覆盖 HTTP API 与 WebSocket/RPC 数据。
 */
const server = require("server");
let rules = {};
let matchMode = "name";

function parseRules(raw) {
  const out = {};
  String(raw || "").split(/\r?\n/).forEach((line) => {
    const pos = line.lastIndexOf("=");
    if (pos < 1) return;
    const key = line.slice(0, pos).trim();
    const code = line.slice(pos + 1).trim().toUpperCase();
    if (key && /^[A-Z]{2}$/.test(code)) out[key] = code;
  });
  return out;
}

function firstString(obj, keys) {
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
  }
  return "";
}

function nodeName(obj) {
  return firstString(obj, ["name", "hostname", "client_name", "clientName", "title", "remark", "display_name", "displayName", "server_name", "serverName"]);
}

function nodeUUID(obj) {
  // 只读取明确表示 UUID 的字段，避免把普通数据库 id 误当作 UUID。
  return firstString(obj, ["uuid", "UUID", "client_uuid", "clientUuid", "agent_uuid", "agentUuid", "clientUUID", "agentUUID"]);
}

function codeFor(obj) {
  if (!obj || typeof obj !== "object") return "";
  if (matchMode === "uuid") {
    const uuid = nodeUUID(obj);
    return uuid && Object.prototype.hasOwnProperty.call(rules, uuid) ? rules[uuid] : "";
  }
  const name = nodeName(obj);
  if (!name) return "";
  if (Object.prototype.hasOwnProperty.call(rules, name)) return rules[name];
  const keys = Object.keys(rules).sort((a, b) => b.length - a.length);
  for (const key of keys) if (name.includes(key)) return rules[key];
  return "";
}

function applyCode(obj, code) {
  const fields = ["country_code", "countryCode", "country", "region_code", "regionCode", "region", "location_code", "locationCode"];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(obj, field) && (typeof obj[field] === "string" || obj[field] == null)) obj[field] = code;
  }
  if (!("country_code" in obj) && !("countryCode" in obj) && !("country" in obj)) obj.country_code = code;
  if (typeof obj.flag === "string") obj.flag = code;
  if (typeof obj.country === "string") obj.country = code;
}

function patchTree(root) {
  let changed = 0;
  const seen = new Set();
  function walk(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 40 || seen.has(obj)) return;
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    const code = codeFor(obj);
    if (code) {
      applyCode(obj, code);
      changed++;
    }
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value && typeof value === "object") walk(value, depth + 1);
      else if (typeof value === "string" && value.length < 4 * 1024 * 1024) {
        const s = value.trim();
        if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
          try {
            const parsed = JSON.parse(value);
            const before = changed;
            walk(parsed, depth + 1);
            if (changed > before) obj[key] = JSON.stringify(parsed);
          } catch (_) {}
        }
      }
    }
  }
  walk(root, 0);
  return changed;
}

function patchText(text, source) {
  if (typeof text !== "string" || !text.trim() || !Object.keys(rules).length) return text;
  try {
    const parsed = JSON.parse(text);
    const count = patchTree(parsed);
    if (count) console.log("[override-location] mode=" + matchMode + "; patched " + count + " node object(s) in " + source);
    return count ? JSON.stringify(parsed) : text;
  } catch (_) {
    return text;
  }
}

async function load() {
  try {
    const cfg = await server.getConfig();
    matchMode = cfg && (cfg.match_mode === "uuid" || cfg.match_mode === "按 UUID 匹配") ? "uuid" : "name";
    rules = parseRules(cfg && cfg.rules_text);
  } catch (e) {
    rules = {};
    matchMode = "name";
    console.log("[override-location] config read failed: " + String(e));
  }

  console.log("[override-location] loaded " + Object.keys(rules).length + " rule(s), mode=" + matchMode);

  server.hook("response", "/api/*", (req, res) => {
    if (!Object.keys(rules).length || !res || typeof res.body !== "string") return;
    const contentType = String((res.headers && res.headers["content-type"]) || "").toLowerCase();
    if (contentType && !contentType.includes("json")) return;
    res.body = patchText(res.body, "HTTP " + String(req && req.url || ""));
  });

  server.hook("wsSend", "/api/*", (_ctx, msg) => {
    if (!Object.keys(rules).length || !msg) return;
    if (typeof msg === "string") {
      const updated = patchText(msg, "WebSocket send");
      if (updated !== msg) return updated;
      return;
    }
    if (typeof msg.data === "string") {
      const updated = patchText(msg.data, "WebSocket send");
      if (updated !== msg.data) return { data: updated };
      return;
    }
    if (msg.data && typeof msg.data === "object") {
      const before = JSON.stringify(msg.data);
      const count = patchTree(msg.data);
      if (count) {
        console.log("[override-location] mode=" + matchMode + "; patched " + count + " node object(s) in WebSocket send");
        if (JSON.stringify(msg.data) !== before) return { data: msg.data };
      }
    }
  });
}

function unload() {
  rules = {};
  matchMode = "name";
  console.log("[override-location] unloaded");
}
