/*
✨ CoonDev • https://dev.coonlink.com/

 ▄█▄    ████▄ ████▄    ▄   ██▄   ▄███▄      ▄
 █▀ ▀▄  █   █ █   █     █  █  █  █▀   ▀      █
 █   ▀  █   █ █   █ ██   █ █   █ ██▄▄   █     █
 █▄  ▄▀ ▀████ ▀████ █ █  █ █  █  █▄   ▄▀ █    █
 ▀███▀              █  █ █ ███▀  ▀███▀    █  █
                    █   ██                 █▐
                                           ▐
*/

import { config, t, langOf } from "./confg.js"
const CB = {donate: "d",skip: "s",stars: "st",ton: "tn",card: "cd",check: "ck",cardCheck: "cc",back: "bk"}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {return json({ ok: true, service: "gram-wallet-widget-bot" })}
    if (request.method === "GET" && url.pathname === "/tasks") {
      const tasks = await loadTasks(env);
      return json({ ok: true, tasks }, 200, { "cache-control": "public, max-age=60" });
    }
    if (request.method === "GET" && url.pathname === "/donor") {
      const address = String(url.searchParams.get("address") || "").trim();
      if (!address) return json({ ok: false, donor: false, error: "address required" }, 400);
      const donor = await isDonorAddress(env, address);
      return json({ ok: true, donor });
    }
    if (request.method === "POST" && url.pathname === "/donor/claim") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, donor: false, error: "bad json" }, 400); }
      const address = String(body?.address || "").trim();
      const code = String(body?.code || "").trim().toUpperCase();
      if (!address || !code) return json({ ok: false, donor: false, error: "address and code required" }, 400);
      const donor = await claimDonorCode(env, address, code);
      return json({ ok: true, donor });
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      if (env.WEBHOOK_SECRET && url.searchParams.get("s") !== env.WEBHOOK_SECRET) {return new Response("forbidden", { status: 403 })}
      let update;
      try { update = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
      await handleUpdate(update, env);
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/setup") {
      if (!env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN missing" }, 500);
      const secret = env.WEBHOOK_SECRET || "";
      const hook = `${url.origin}/webhook${secret ? `?s=${encodeURIComponent(secret)}` : ""}`;
      const r = await tg(env.BOT_TOKEN, "setWebhook", {url: hook,allowed_updates: ["message", "callback_query", "pre_checkout_query"],drop_pending_updates: true});
      return json(r);
    }
    if (request.method === "POST" && url.pathname === "/push-channel") {
      if (!env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN missing" }, 500);
      const out = await pushReleaseToChannel(env);
      return json(out, out.ok ? 200 : 502);
    }
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) {ctx.waitUntil(checkNewRelease(env))}
};

async function handleUpdate(update, env) {
  const token = env.BOT_TOKEN;
  if (!token) return;
  try {
    if (update.pre_checkout_query) {
      await tg(token, "answerPreCheckoutQuery", {pre_checkout_query_id: update.pre_checkout_query.id,ok: true});
      return;
    }
    if (update.callback_query) {
      await onCallback(update.callback_query, token, env);
      return;
    }
    const msg = update.message;
    if (!msg) return;
    if (msg.successful_payment) {
      await onPaid(msg, token, env);
      return;
    }
    if (msg.text && msg.text.startsWith("/start")) {
      const lang = langOf(msg.from);
      await rememberSub(env, msg.chat.id, lang);
      await showWelcome(msg.chat.id, token, lang);
    }
  } catch (err) {console.error(JSON.stringify({ err: String(err), stack: err?.stack }))}
}

function mainKb(lang) {return [[{ text: t(lang, "btnDonate"), callback_data: CB.donate }, { text: t(lang, "btnSkip"), callback_data: CB.skip }]]}

async function showWelcome(chatId, token, lang) {
  const text = t(lang, "welcome");
  const r = await tg(token, "sendMessage", {chat_id: chatId,text,reply_markup: { inline_keyboard: mainKb(lang) }});
  console.log(JSON.stringify({ start: true, lang, text, tg: r }));
  if (!r?.ok) console.error(JSON.stringify({ startFail: r }));
}

async function onCallback(cq, token, env) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const userId = cq.from?.id;
  const lang = langOf(cq.from);
  if (!chatId || !messageId || !userId) {
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }
  const data = cq.data || "";

  if (data === CB.donate) {
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    const cardLabel = t(lang, "btnCard");
    await edit(token, chatId, messageId, t(lang, "donateMenu"), [[{ text: t(lang, "btnStars"), callback_data: CB.stars },{ text: t(lang, "btnTon"), callback_data: CB.ton }],[{ text: cardLabel === "btnCard" ? (lang === "ru" ? "💳 Карта Credit/Debit" : "💳 Credit/Debit Card") : cardLabel, callback_data: CB.card }],[{ text: t(lang, "btnBack"), callback_data: CB.back }]]);
    return;
  }

  if (data === CB.back) {
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    await edit(token, chatId, messageId, t(lang, "welcome"), mainKb(lang));
    return;
  }

  if (data === CB.skip) {
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    await deliverApk(token, chatId, messageId, t(lang, "skipThanks"), lang, env);
    return;
  }

  if (data === CB.stars) {
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    const link = await createStarsLink(token, chatId, messageId, userId, lang);
    if (!link) {
      await edit(token, chatId, messageId, t(lang, "invoiceError"), [[{ text: t(lang, "btnBack"), callback_data: CB.donate }]]);
      return;
    }
    await edit(token, chatId, messageId, t(lang, "starsPay"), [[{ text: t(lang, "btnPayStars", { amount: config.starsAmount }), url: link }],[{ text: t(lang, "btnBack"), callback_data: CB.donate }]]);
    return;
  }

  if (data === CB.ton) {
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    const memo = tonMemo(userId);
    const text = t(lang, "tonPay", { wallet: config.tonWallet, memo });
    const payUrl =`https://app.tonkeeper.com/transfer/${config.tonWallet}` +`?text=${encodeURIComponent(memo)}`;
    await edit(token, chatId, messageId, text, [[{ text: t(lang, "btnOpenWallet"), url: payUrl }],[{ text: t(lang, "btnCheck"), callback_data: CB.check }],[{ text: t(lang, "btnBack"), callback_data: CB.donate }]], "HTML");
    return;
  }

  if (data === CB.card) {
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    const amount = (config.cardAmount / 100).toFixed(2);
    const checkout = await createSumUpCheckout(env, userId, lang);
    if (!checkout?.url) {
      const detail = checkout?.error ? `\n\n(${checkout.error})` : "";
      await edit(token, chatId, messageId, t(lang, "invoiceError") + detail, [[{ text: t(lang, "btnBack"), callback_data: CB.donate }]]);
      return;
    }
    const rows = [[{ text: t(lang, "btnPayCard", { amount, currency: config.cardCurrency }), url: checkout.url }],[{ text: t(lang, "btnCheck"), callback_data: CB.cardCheck }],[{ text: t(lang, "btnBack"), callback_data: CB.donate }]];
    const edited = await edit(token, chatId, messageId, t(lang, "cardPay"), rows);
    if (!edited?.ok) {
      console.error(JSON.stringify({ cardEdit: edited }));
      await tg(token, "sendMessage", {chat_id: chatId,text: t(lang, "cardPay"),reply_markup: { inline_keyboard: rows }});
    }
    return;
  }

  if (data === CB.cardCheck) {
    const paid = await findSumUpPayment(env, userId);
    if (!paid) {
      await tg(token, "answerCallbackQuery", {callback_query_id: cq.id,text: t(lang, "cardWait"),show_alert: true});
      return;
    }
    await markDonorTg(env, userId);
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    const code = await issueDonorCode(env, userId);
    await deliverApk(token, chatId, messageId, notesJoin(t(lang, "cardOk"), t(lang, "donorCode", { code })), lang, env);
    return;
  }

  if (data === CB.check) {
    const found = await findTonPayment(userId);
    if (!found) {
      await tg(token, "answerCallbackQuery", {callback_query_id: cq.id,text: t(lang, "tonWait"),show_alert: true});
      return;
    }
    await markDonorTg(env, userId);
    if (found.source) await markDonorAddr(env, found.source);
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    const code = await issueDonorCode(env, userId);
    await deliverApk(token, chatId, messageId, notesJoin(t(lang, "tonOk"), t(lang, "donorCode", { code })), lang, env);
    return;
  }

  await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
}

async function onPaid(msg, token, env) {
  const sp = msg.successful_payment;
  if (!sp || sp.currency !== "XTR") return;
  const lang = langOf(msg.from);
  const userId = msg.from?.id;
  if (userId) await markDonorTg(env, userId);
  const code = userId ? await issueDonorCode(env, userId) : "";
  const caption = code ? notesJoin(t(lang, "thanks"), t(lang, "donorCode", { code })) : t(lang, "thanks");
  const parts = String(sp.invoice_payload || "").split(":");
  if (parts[0] !== "gw" || parts.length < 4) {
    await deliverApk(token, msg.chat.id, null, caption, lang, env);
    return;
  }
  const chatId = Number(parts[1]);
  const messageId = Number(parts[2]);
  await deliverApk(token, chatId || msg.chat.id, messageId || null, caption, lang, env);
}

async function createStarsLink(token, chatId, messageId, userId, lang) {
  const r = await tg(token, "createInvoiceLink", {title: t(lang, "invoiceTitle"),description: t(lang, "invoiceDesc"),payload: `gw:${chatId}:${messageId}:${userId}`,provider_token: "",currency: "XTR",prices: [{ label: t(lang, "invoiceLabel"), amount: config.starsAmount }]});
  return r?.ok ? r.result : null;
}

function sumupPendingKey(userId) {return `sumup:pending:${userId}`}

async function sumupAuth(env) {
  const apiKey = String(env.SUMUP_API_KEY || "").trim();
  const merchant = String(env.SUMUP_MERCHANT_CODE || config.sumupMerchantCode || "MCRLPU2Q").trim();
  const email = String(config.sumupPayToEmail || "admin@coonlink.com").trim();
  return { apiKey, merchant, email };
}

async function createSumUpCheckout(env, userId, lang) {
  const { apiKey, merchant, email } = await sumupAuth(env);
  if (!apiKey) return { error: "no_api_key" };
  if (!merchant && !email) return { error: "no_merchant" };
  const amount = Math.round(config.cardAmount) / 100;
  const checkout_reference = `gw${userId}-${Date.now()}`.slice(0, 64);
  const body = {amount,currency: config.cardCurrency,checkout_reference,description: t(lang, "invoiceDesc"),hosted_checkout: { enabled: true }};
  if (merchant) body.merchant_code = merchant;
  if (email) body.pay_to_email = email;
  let res;
  try {res = await fetch("https://api.sumup.com/v0.1/checkouts", {method: "POST",headers: {authorization: `Bearer ${apiKey}`,"content-type": "application/json"},body: JSON.stringify(body)});} catch (err) {
    console.error(JSON.stringify({ sumupCreate: "fetch", err: String(err) }));
    return { error: "sumup_fetch" };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(JSON.stringify({ sumupCreate: res.status, body: text }));
    let msg = `sumup_${res.status}`;
    try {
      const err = JSON.parse(text);
      msg = String(err?.error_code || err?.title || err?.message || msg).slice(0, 80);
    } catch {}
    return { error: msg };
  }
  let data = {};
  try { data = JSON.parse(text); } catch { return { error: "bad_json" }; }
  const url = data.hosted_checkout_url || null;
  const id = data.id || null;
  if (!url || !id) {
    console.error(JSON.stringify({ sumupCreate: "no_url", data }));
    return { error: "no_checkout_url" };
  }
  try {if (env.KV) await env.KV.put(sumupPendingKey(userId), JSON.stringify({ id, ref: checkout_reference }), { expirationTtl: 60 * 60 });} catch (err) {console.error(JSON.stringify({ sumupKv: String(err) }));}
  return { url, id };
}

async function findSumUpPayment(env, userId) {
  const apiKey = String(env.SUMUP_API_KEY || "").trim();
  if (!apiKey || !env.KV) return false;
  const raw = await env.KV.get(sumupPendingKey(userId));
  if (!raw) return false;
  let pending;
  try { pending = JSON.parse(raw); } catch { return false; }
  if (!pending?.id) return false;
  const res = await fetch(`https://api.sumup.com/v0.1/checkouts/${encodeURIComponent(pending.id)}`, {headers: {authorization: `Bearer ${apiKey}`,accept: "application/json"}});
  if (!res.ok) {
    console.error(JSON.stringify({ sumupGet: res.status, body: await res.text().catch(() => "") }));
    return false;
  }
  const data = await res.json();
  if (String(data.status || "").toUpperCase() !== "PAID") return false;
  await env.KV.delete(sumupPendingKey(userId));
  return true;
}

function tonMemo(userId) {return `gw${userId}`}

async function findTonPayment(userId) {
  const memo = tonMemo(userId);
  const addr = encodeURIComponent(config.tonWallet);
  const res = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${addr}&limit=40`,{ headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  const txs = data.result || [];
  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;
    if (Number(inMsg.value || 0) < config.tonMinNanoton) continue;
    if (String(inMsg.message || "").trim() === memo) return { source: String(inMsg.source || "").trim() || null };
  }
  return null;
}

function addrKeys(address) {
  const s = String(address || "").trim();
  if (!s) return [];
  const keys = new Set([s]);
  if (/^[EeUu][Qq]/.test(s) && s.length >= 2) {
    keys.add("UQ" + s.slice(2));
    keys.add("EQ" + s.slice(2));
    keys.add("Uq" + s.slice(2));
    keys.add("Eq" + s.slice(2));
  }
  return [...keys];
}

function sameAddr(a, b) {
  const left = new Set(addrKeys(a));
  for (const k of addrKeys(b)) if (left.has(k)) return true;
  return false;
}

async function markDonorTg(env, userId) {
  if (!env?.KV || userId == null) return;
  await env.KV.put(`donor:tg:${userId}`, "1");
}

async function markDonorAddr(env, address) {
  if (!env?.KV || !address) return;
  for (const key of addrKeys(address)) await env.KV.put(`donor:addr:${key}`, "1");
}

async function issueDonorCode(env, userId) {
  if (!env?.KV || userId == null) return "";
  const existing = await env.KV.get(`donor:tgcode:${userId}`);
  if (existing) return existing;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  await env.KV.put(`donor:code:${code}`, String(userId));
  await env.KV.put(`donor:tgcode:${userId}`, code);
  return code;
}

async function claimDonorCode(env, address, code) {
  if (!env?.KV) return false;
  const userId = await env.KV.get(`donor:code:${code}`);
  if (!userId) return false;
  await markDonorTg(env, userId);
  await markDonorAddr(env, address);
  return true;
}

async function isDonorAddress(env, address) {
  if (env?.KV) {for (const key of addrKeys(address)) {if (await env.KV.get(`donor:addr:${key}`)) return true;}}
  if (await donatedFromAddress(address)) {
    if (env?.KV) await markDonorAddr(env, address);
    return true;
  }
  return false;
}

async function donatedFromAddress(address) {
  const addr = encodeURIComponent(address);
  const res = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${addr}&limit=50`, { headers: { accept: "application/json" } });
  if (!res.ok) return false;
  const data = await res.json();
  for (const tx of data.result || []) {
    for (const msg of tx.out_msgs || []) {
      if (Number(msg.value || 0) < config.tonMinNanoton) continue;
      if (sameAddr(msg.destination, config.tonWallet)) return true;
    }
  }
  return false;
}

let apkCache = { tag: "", fileId: null };
let releaseCache = { at: 0, data: null };

const ghHeaders = { accept: "application/vnd.github+json", "user-agent": "gram-wallet-widget-bot" };

async function getLatestRelease() {
  if (releaseCache.data && Date.now() - releaseCache.at < 60_000) return releaseCache.data;
  const res = await fetch(`https://api.github.com/repos/${config.githubRepo}/releases/latest`, { headers: ghHeaders });
  if (res.ok) {
    const data = await res.json();
    releaseCache = { at: Date.now(), data };
    return data;
  }
  console.error(JSON.stringify({ githubLatest: res.status }));
  const fromTags = await releaseFromTags();
  if (fromTags) {
    releaseCache = { at: Date.now(), data: fromTags };
    return fromTags;
  }
  return releaseCache.data;
}

async function releaseFromTags() {
  const tagsRes = await fetch(config.githubTags, { headers: ghHeaders });
  if (!tagsRes.ok) {
    console.error(JSON.stringify({ githubTags: tagsRes.status }));
    return null;
  }
  const tags = await tagsRes.json();
  const tag = Array.isArray(tags) ? tags.find((item) => item?.name)?.name : "";
  if (!tag) return null;
  const relRes = await fetch(`https://api.github.com/repos/${config.githubRepo}/releases/tags/${encodeURIComponent(tag)}`, { headers: ghHeaders });
  if (relRes.ok) return relRes.json();
  console.error(JSON.stringify({ githubTagRelease: relRes.status, tag }));
  return { tag_name: tag, name: tag, body: "", assets: [] };
}

function cachedApkFileId(tag) {return tag && apkCache.tag === tag ? apkCache.fileId : null;}

function rememberApkFileId(tag, fileId) {
  if (!tag || !fileId) return;
  apkCache = { tag, fileId };
}

function apkMetaFromTag(tag) {
  const name = `GramWallet.${String(tag).replace("(", ".").replace(")", "")}.apk`;
  return {url: `https://github.com/${config.githubRepo}/releases/download/${encodeURIComponent(tag)}/${name}`, name, tag};
}

function apkFromRelease(rel) {
  const tag = rel?.tag_name || "";
  const asset = (rel?.assets || []).find((a) => String(a.name || "").toLowerCase().endsWith(".apk"));
  if (asset?.browser_download_url) return {url: asset.browser_download_url, name: asset.name, tag, body: String(rel?.body || "").trim()};
  if (tag) return {...apkMetaFromTag(tag), body: String(rel?.body || "").trim()};
  return {url: "", name: "", tag: "", body: ""};
}

function formatChangelog(lang, rel) {
  const apk = apkFromRelease(rel);
  if (!apk.tag && !apk.body) return "";
  const lines = [t(lang, "updateTitle", { version: apk.tag || rel?.name || "" })];
  const body = apk.body;
  if (!body) return lines.join("\n");
  const fixed = [];
  const added = [];
  let mode = "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const low = line.toLowerCase();
    if (low.startsWith("### fixed") || low.startsWith("## fixed") || low === "fixed:" || low.startsWith("исправлено")) { mode = "f"; continue; }
    if (low.startsWith("### added") || low.startsWith("## added") || low === "added:" || low.startsWith("добавлено")) { mode = "a"; continue; }
    const item = line.replace(/^[-*•]\s*/, "").trim();
    if (!item || item === "-") continue;
    if (mode === "f") fixed.push(`• ${item}`);
    else if (mode === "a") added.push(`• ${item}`);
    else lines.push(line);
  }
  if (fixed.length) { lines.push(""); lines.push(t(lang, "updateFixed")); lines.push(...fixed); }
  if (added.length) { lines.push(""); lines.push(t(lang, "updateAdded")); lines.push(...added); }
  return lines.join("\n").trim();
}

async function rememberSub(env, chatId, lang) {
  if (!env?.KV || chatId == null) return;
  await env.KV.put(`sub:${chatId}`, lang || config.defaultLang);
}

async function markGot(env, chatId, tag) {
  if (!env?.KV || chatId == null || !tag) return;
  await env.KV.put(`got:${chatId}`, tag);
}

async function alreadyGot(env, chatId, tag) {
  if (!env?.KV || chatId == null || !tag) return false;
  return (await env.KV.get(`got:${chatId}`)) === tag;
}

async function sendApkDocument(token, chatId, apk, fileId) {
  let sent = await tg(token, "sendDocument", { chat_id: chatId, document: fileId || apk.url });
  if (!sent?.ok && fileId) {
    sent = await tg(token, "sendDocument", { chat_id: chatId, document: apk.url });
  }
  if (!sent?.ok) {
    const fileRes = await fetch(apk.url, { redirect: "follow" });
    if (!fileRes.ok) {
      console.error(JSON.stringify({ apkFetch: fileRes.status, sendErr: sent, chatId }));
      return sent;
    }
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", await fileRes.blob(), apk.name);
    sent = await (await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form })).json();
    if (!sent?.ok) console.error(JSON.stringify({ apkUpload: sent, chatId }));
  }
  return sent;
}

async function deliverApk(token, chatId, messageId, caption, lang, env) {
  if (env) await rememberSub(env, chatId, lang);
  if (messageId) await edit(token, chatId, messageId, t(lang, "sending"), []);
  const rel = await getLatestRelease();
  const apk = apkFromRelease(rel);
  const html = /<code>/.test(caption || "");
  const notes = formatChangelog(lang, rel);
  const doneText = notesJoin(caption, html && notes ? htmlEscape(notes) : notes);
  if (!apk.url) {
    console.error(JSON.stringify({ noApkUrl: true, tag: apk.tag || null }));
    await sendDoneText(token, chatId, messageId, doneText || caption, html);
    return;
  }
  const sent = await sendApkDocument(token, chatId, apk, cachedApkFileId(apk.tag));
  const fileId = sent?.result?.document?.file_id;
  if (fileId) rememberApkFileId(apk.tag, fileId);
  if (!sent?.ok) return;
  if (env && rel?.tag_name) await markGot(env, chatId, rel.tag_name);
  await sendDoneText(token, chatId, messageId, doneText, html);
}

function notesJoin(caption, notes) {return notes ? `${caption}\n\n${notes}` : caption;}
function htmlEscape(s) {return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");}
async function sendDoneText(token, chatId, messageId, text, html) {
  const mode = html ? "HTML" : undefined;
  if (messageId) await edit(token, chatId, messageId, text, [], mode);
  else {
    const body = { chat_id: chatId, text };
    if (mode) body.parse_mode = mode;
    await tg(token, "sendMessage", body);
  }
}

async function listSubs(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: "sub:", cursor });
    keys.push(...(page.keys || []));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys;
}

function channelTargets() {
  const ids = Array.isArray(config.channelChatIds) ? config.channelChatIds.slice() : [];
  if (config.channelChatId && !ids.includes(config.channelChatId)) ids.unshift(config.channelChatId);
  return ids.map((x) => String(x || "").trim()).filter(Boolean);
}

async function postReleaseToChannel(token, rel, apk, fileId) {
  const targets = channelTargets();
  if (!targets.length) return { ok: false, error: "no_channel", fileId: fileId || null };
  const lang = config.channelLang || "ru";
  const text = formatChangelog(lang, rel) || t(lang, "updateTitle", { version: rel.tag_name });
  let last = null;
  let used = null;
  let nextFileId = fileId || null;
  for (const chatId of targets) {
    try {
      await tg(token, "sendMessage", { chat_id: chatId, text });
      const sent = await sendApkDocument(token, chatId, apk, nextFileId);
      last = sent;
      if (sent?.ok) {
        used = chatId;
        if (sent.result?.document?.file_id) nextFileId = sent.result.document.file_id;
        break;
      }
      console.error(JSON.stringify({ channelSend: sent, chatId }));
    } catch (err) {
      console.error(JSON.stringify({ channelFail: String(err), chatId }));
    }
  }
  return { ok: !!last?.ok, chatId: used, fileId: nextFileId, result: last };
}

async function pushReleaseToChannel(env) {
  const rel = await getLatestRelease();
  if (!rel?.tag_name) return { ok: false, error: "no_release" };
  const apk = apkFromRelease(rel);
  if (!apk.url) return { ok: false, error: "no_apk", tag: rel.tag_name };
  const out = await postReleaseToChannel(env.BOT_TOKEN, rel, apk, cachedApkFileId(apk.tag));
  if (out.fileId) rememberApkFileId(apk.tag, out.fileId);
  return { ok: !!out.ok, tag: rel.tag_name, chatId: out.chatId || null, error: out.error || null };
}

async function checkNewRelease(env) {
  if (!env.BOT_TOKEN || !env.KV) return;
  const rel = await getLatestRelease();
  if (!rel?.tag_name) return;
  const last = await env.KV.get("last_tag");
  if (last === rel.tag_name) return;
  if (!last) {
    await env.KV.put("last_tag", rel.tag_name);
    return;
  }
  apkCache = { tag: "", fileId: null };
  const apk = apkFromRelease(rel);
  if (!apk.url) {
    console.error(JSON.stringify({ noApk: rel.tag_name }));
    return;
  }
  let fileId = null;
  const channel = await postReleaseToChannel(env.BOT_TOKEN, rel, apk, null);
  if (channel.fileId) fileId = channel.fileId;
  if (!channel.ok) console.error(JSON.stringify({ channelNotify: channel }));
  const keys = await listSubs(env);
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  for (const key of keys) {
    const chatId = key.name.slice(4);
    try {
      if (await alreadyGot(env, chatId, rel.tag_name)) {skipped += 1; continue;}
      const lang = (await env.KV.get(key.name)) || config.defaultLang;
      const text = formatChangelog(lang, rel) || t(lang, "updateTitle", { version: rel.tag_name });
      await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text });
      const sent = await sendApkDocument(env.BOT_TOKEN, chatId, apk, fileId);
      if (sent?.ok) {
        ok += 1;
        await markGot(env, chatId, rel.tag_name);
        if (sent.result?.document?.file_id) fileId = sent.result.document.file_id;
      } else {fail += 1;}
    } catch (err) {
      fail += 1;
      console.error(JSON.stringify({ notifyFail: String(err), chatId }));
    }
  }
  if (fileId) rememberApkFileId(rel.tag_name, fileId);
  await env.KV.put("last_tag", rel.tag_name);
  console.log(JSON.stringify({ notified: true, tag: rel.tag_name, channel: !!channel.ok, subs: keys.length, ok, fail, skipped }));
}

async function edit(token, chatId, messageId, text, rows, parseMode) {
  const body = {chat_id: chatId,message_id: messageId,text,reply_markup: { inline_keyboard: rows || [] }};
  if (parseMode) body.parse_mode = parseMode;
  const r = await tg(token, "editMessageText", body);
  if (!r?.ok && String(r?.description || "").includes("message is not modified")) return r;
  return r;
}

async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {method: "POST",headers: { "content-type": "application/json" },body: JSON.stringify(body)});
  return res.json();
}

const DEFAULT_TASKS = [{id: "chat", icon: "group", url: "https://t.me/GramWalletWidgetChat", title: "Join the chat", title_ru: "Вступить в чат", hint: "Community chat · @GramWalletWidgetChat", hint_ru: "Чат сообщества · @GramWalletWidgetChat"},{id: "boost", icon: "channel", url: "https://t.me/boost/GramWalletWidget", title: "Boost the channel", title_ru: "Забустить канал", hint: "Telegram Boost · @GramWalletWidget", hint_ru: "Telegram Boost · @GramWalletWidget"},{id: "channel", icon: "channel", url: "https://t.me/GramWalletWidget", title: "Subscribe to the channel", title_ru: "Подписаться на канал", hint: "News and updates · @GramWalletWidget", hint_ru: "Новости и обновления · @GramWalletWidget"},{id: "gifts", icon: "nfts", url: "https://t.me/GiftChanges", title: "Follow GiftChanges", title_ru: "Подписаться на GiftChanges", hint: "Gift stickers · @GiftChanges", hint_ru: "Стикеры подарков · @GiftChanges"},{id: "coonlink", icon: "channel", url: "https://t.me/coonlink", title: "Follow CoonLink", title_ru: "Подписаться на CoonLink", hint: "Author channel · @coonlink", hint_ru: "Канал автора · @coonlink"},{id: "coondev", icon: "coondev", url: "https://t.me/coondev", title: "Follow CoonDev", title_ru: "Подписаться на CoonDev", hint: "Dev channel · @coondev", hint_ru: "Канал разработки · @coondev"}];

async function loadTasks(env) {
  try {
    const raw = env?.KV ? await env.KV.get("tasks:list") : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {return parsed.filter(t => t && t.id && t.url);}
      if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length) {return parsed.tasks.filter(t => t && t.id && t.url);}
    }
  } catch (err) {console.error(JSON.stringify({ tasksLoad: String(err) }));}
  return DEFAULT_TASKS;
}

function json(data, status = 200, extraHeaders = {}) {return new Response(JSON.stringify(data), {status, headers: {"content-type": "application/json", ...extraHeaders}});}
