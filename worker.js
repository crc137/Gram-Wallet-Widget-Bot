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
    if (request.method === "GET" && (url.pathname === "/stats" || url.pathname === "/ru/stats" || url.pathname === "/en/stats")) {
      const data = await loadStats(env);
      const lang = url.pathname.startsWith("/ru/") ? "ru" : "en";
      const accept = String(request.headers.get("accept") || "");
      if (url.searchParams.get("format") === "json" || accept.includes("application/json")) {return json({ ok: true, lang, ...data }, 200, { "cache-control": "no-store" });}
      return new Response(statsHtml(data, lang), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === "/stats/wallet") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }
      const out = await trackWalletHash(env, body?.hash, body?.address);
      return json(out, out.ok ? 200 : 400);
    }
    if (request.method === "POST" && url.pathname === "/stats/open") {
      let body = {};
      try { body = await request.json(); } catch {}
      await trackOpen(env, body);
      return json({ ok: true });
    }
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
  if (env) await trackDownload(env, apk.tag || rel?.tag_name || "");
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
  const fallback = ["@GramWalletWidget", "-1003916775056"];
  const ids = Array.isArray(config.channelChatIds) ? config.channelChatIds.slice() : [];
  if (config.channelChatId && !ids.includes(config.channelChatId)) ids.unshift(config.channelChatId);
  for (const id of fallback) if (!ids.includes(id)) ids.push(id);
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
        await trackDownload(env, rel.tag_name);
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

const DEFAULT_TASKS = [{id: "boost", icon: "boost", url: "https://t.me/boost/coondev", title: "Boost the Group", title_ru: "Забустить Группа", hint: "Telegram Boost · @coondev", hint_ru: "Telegram Boost · @coondev"},{id: "channel", icon: "channel", url: "https://t.me/GramWalletWidget", title: "Subscribe to the channel", title_ru: "Подписаться на канал", hint: "News and updates · @GramWalletWidget", hint_ru: "Новости и обновления · @GramWalletWidget"},{id: "gifts", icon: "nfts", url: "https://t.me/GiftChanges", title: "Follow GiftChanges", title_ru: "Подписаться на GiftChanges", hint: "Gift stickers · @GiftChanges", hint_ru: "Стикеры подарков · @GiftChanges"},{id: "coonlink", icon: "channel", url: "https://t.me/coonlink", title: "Follow CoonLink", title_ru: "Подписаться на CoonLink", hint: "Author channel · @coonlink", hint_ru: "Канал автора · @coonlink"},{id: "coondev", icon: "coondev", url: "https://t.me/coondev", title: "Follow CoonDev", title_ru: "Подписаться на CoonDev", hint: "Dev channel · @coondev", hint_ru: "Канал разработки · @coondev"}];

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

async function incrStat(env, key, by = 1) {
  if (!env?.KV || !key) return 0;
  const n = Number(await env.KV.get(key)) || 0;
  const next = n + by;
  await env.KV.put(key, String(next));
  return next;
}

async function trackDownload(env, tag) {
  if (!env?.KV) return;
  const clean = String(tag || "").trim() || "unknown";
  await incrStat(env, "stat:dl:total");
  await incrStat(env, `stat:dl:v:${clean}`);
}

async function trackOpen(env, body) {
  await incrStat(env, "stat:opens");
  if (!env?.KV) return;
  const model = cleanDevice(body?.model || body?.device);
  if (!model) return;
  await incrStat(env, `stat:dev:${model}`);
}

function cleanDevice(raw) {
  return String(raw || "").trim().slice(0, 72).replace(/[^\w.\-+() /]/gi, "_").replace(/\s+/g, " ").trim();
}

function shortAddr(a) {
  const s = String(a || "");
  if (s.length <= 14) return s;
  return s.slice(0, 6) + "…" + s.slice(-4);
}

function formatGram(nano) {
  const n = Number(nano);
  if (!Number.isFinite(n)) return "—";
  const g = n / 1e9;
  if (g >= 1000) return g.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (g >= 1) return g.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return g.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

async function fetchBalanceNano(address) {
  try {
    const res = await fetch(`https://tonapi.io/v2/accounts/${encodeURIComponent(address)}`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const j = await res.json();
    if (j?.balance == null) return null;
    return String(j.balance);
  } catch { return null; }
}

async function readJsonList(env, key) {
  try {
    const raw = env?.KV ? await env.KV.get(key) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeJsonList(env, key, list) {
  if (!env?.KV) return;
  await env.KV.put(key, JSON.stringify(list.slice(0, 40)));
}

async function trackWalletHash(env, hash, address) {
  const h = String(hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(h)) return { ok: false, error: "hash required", added: false };
  if (!env?.KV) return { ok: false, error: "kv missing", added: false };
  const key = `stat:w:${h}`;
  const existed = await env.KV.get(key);
  let added = false;
  let total = Number((await env.KV.get("stat:wallets")) || 0) || 0;
  if (!existed) {
    await env.KV.put(key, "1");
    total = await incrStat(env, "stat:wallets");
    added = true;
  }
  const addr = String(address || "").trim();
  if (addr && /^[UE]Q[A-Za-z0-9_-]{46}$/.test(addr)) {
    const now = Date.now();
    const balance = await fetchBalanceNano(addr);
    const row = { hash: h, address: addr, balance: balance || "0", addedAt: now, lastAt: now };
    const detailKey = `stat:wa:${h}`;
    try {
      const prev = await env.KV.get(detailKey);
      if (prev) {
        const old = JSON.parse(prev);
        row.addedAt = old.addedAt || now;
        if (!balance && old.balance) row.balance = old.balance;
      }
    } catch {}
    await env.KV.put(detailKey, JSON.stringify(row));
    let recent = await readJsonList(env, "stat:wallets:recent");
    recent = recent.filter((x) => x && x.hash !== h);
    recent.unshift({ hash: h, address: addr, balance: row.balance, addedAt: row.addedAt, lastAt: now });
    await writeJsonList(env, "stat:wallets:recent", recent);
    let top = await readJsonList(env, "stat:wallets:top");
    top = top.filter((x) => x && x.hash !== h);
    top.push({ hash: h, address: addr, balance: row.balance, addedAt: row.addedAt, lastAt: now });
    top.sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0));
    await writeJsonList(env, "stat:wallets:top", top.slice(0, 25));
  }
  return { ok: true, added, wallets: total };
}

async function loadStats(env) {
  const downloadsTotal = Number((env?.KV && await env.KV.get("stat:dl:total")) || 0) || 0;
  const wallets = Number((env?.KV && await env.KV.get("stat:wallets")) || 0) || 0;
  const opens = Number((env?.KV && await env.KV.get("stat:opens")) || 0) || 0;
  const versions = [];
  const devices = [];
  if (env?.KV) {
    let cursor;
    do {
      const page = await env.KV.list({ prefix: "stat:dl:v:", cursor });
      for (const item of page.keys || []) {
        const tag = item.name.slice("stat:dl:v:".length);
        const count = Number(await env.KV.get(item.name)) || 0;
        if (tag) versions.push({ tag, count });
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    cursor = undefined;
    do {
      const page = await env.KV.list({ prefix: "stat:dev:", cursor });
      for (const item of page.keys || []) {
        const model = item.name.slice("stat:dev:".length);
        const count = Number(await env.KV.get(item.name)) || 0;
        if (model) devices.push({ model, count });
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  versions.sort((a, b) => b.count - a.count || String(b.tag).localeCompare(String(a.tag)));
  devices.sort((a, b) => b.count - a.count || String(a.model).localeCompare(String(b.model)));
  const hot = (await readJsonList(env, "stat:wallets:top")).slice(0, 12);
  const recent = (await readJsonList(env, "stat:wallets:recent")).slice(0, 12);
  const deviceUsers = devices.reduce((s, d) => s + (Number(d.count) || 0), 0);
  return {
    downloadsTotal, wallets, opens, versions, devices: devices.slice(0, 16),
    deviceUsers, hot, recent, updatedAt: new Date().toISOString(),
  };
}

function statsHtml(data, lang = "en") {
  const ru = lang === "ru";
  const t = ru ? {
    title: "Gram Wallet · Статистика",
    brand: "Gram Wallet",
    cycle: "Статистика приложения",
    goal: "Скачивания, устройства и кошельки в Gram Wallet",
    doneOf: "открытий · {d} скачиваний",
    dl: "Скачивания",
    wallets: "Кошельки",
    opens: "Открытия",
    devicesTitle: "Устройства",
    versions: "Версии",
    workload: "Телефоны",
    people: "моделей",
    hot: "Крупнейшие балансы",
    recent: "Новые кошельки",
    activity: "Активность",
    empty: "Пока пусто",
    gram: "GRAM",
    lang: "EN", langHref: "/stats",
    added: "добавлен",
  } : {
    title: "Gram Wallet · Stats",
    brand: "Gram Wallet",
    cycle: "App analytics",
    goal: "Downloads, devices and wallets inside Gram Wallet",
    doneOf: "opens · {d} downloads",
    dl: "Downloads",
    wallets: "Wallets",
    opens: "Opens",
    devicesTitle: "Devices",
    versions: "Versions",
    workload: "Phones",
    people: "models",
    hot: "Largest balances",
    recent: "New wallets",
    activity: "Activity",
    empty: "Nothing yet",
    gram: "GRAM",
    lang: "RU", langHref: "/ru/stats",
    added: "added",
  };
  const downloads = Number(data.downloadsTotal) || 0;
  const wallets = Number(data.wallets) || 0;
  const opens = Number(data.opens) || 0;
  const versions = data.versions || [];
  const devices = data.devices || [];
  const hot = data.hot || [];
  const recent = data.recent || [];
  const deviceUsers = Number(data.deviceUsers) || 0;
  const latest = versions[0];
  const latestPct = downloads && latest ? Math.round((100 * latest.count) / downloads) : 0;
  const colors = ["#6b7280", "#f59e0b", "#3b82f6", "#a78bfa", "#22c55e", "#06b6d4", "#f97316", "#eab308"];
  const seg = versions.length
    ? versions.map((v, i) => {
        const pct = downloads ? (100 * v.count) / downloads : 0;
        return `<i style="width:${Math.max(pct, 0.8)}%;background:${colors[i % colors.length]}" title="${esc(v.tag)}"></i>`;
      }).join("")
    : `<i style="width:100%;background:#222"></i>`;
  const verList = versions.length
    ? versions.map((v, i) => {
        const pct = downloads ? Math.round((100 * v.count) / downloads) : 0;
        return `<li><span class="dot" style="background:${colors[i % colors.length]}"></span><span class="lab">${esc(v.tag)}</span><span class="num">${v.count}</span><span class="pct">${pct}%</span></li>`;
      }).join("")
    : `<li class="empty">${esc(t.empty)}</li>`;
  const maxDev = devices.reduce((m, d) => Math.max(m, Number(d.count) || 0), 0) || 1;
  const devList = devices.length
    ? devices.map((d, i) => {
        const count = Number(d.count) || 0;
        const w = Math.max(8, Math.round((100 * count) / maxDev));
        const over = count === maxDev && devices.length > 1;
        const initials = String(d.model || "?").split(/\s+/).slice(0, 2).map((x) => x[0] || "").join("").toUpperCase().slice(0, 2) || "?";
        return `<li class="${over ? "over" : ""}"><span class="av">${esc(initials)}</span><div class="who"><b>${esc(d.model)}</b><div class="track"><i style="width:${w}%"></i></div></div><span class="open">${count}</span></li>`;
      }).join("")
    : `<li class="empty">${esc(t.empty)}</li>`;
  const hotList = hot.length
    ? hot.map((w, i) => {
        const bal = formatGram(w.balance);
        return `<li><span class="pri">#${i + 1}</span><a href="https://gram.org/address/${encodeURIComponent(w.address)}" target="_blank" rel="noopener"><code>${esc(shortAddr(w.address))}</code> <span class="ttl">${esc(bal)} ${t.gram}</span></a><span class="pill green">${t.gram}</span></li>`;
      }).join("")
    : `<li class="empty">${esc(t.empty)}</li>`;
  const actList = recent.length
    ? recent.map((w) => {
        const when = w.addedAt ? relTime(w.addedAt, ru) : "";
        const bal = formatGram(w.balance);
        return `<li><span class="av sm">${esc((w.address || "?").slice(2, 4).toUpperCase())}</span><div><a href="https://gram.org/address/${encodeURIComponent(w.address)}" target="_blank" rel="noopener"><code>${esc(shortAddr(w.address))}</code></a> ${esc(t.added)} · ${esc(bal)} ${t.gram}<div class="ago">${esc(when)}</div></div></li>`;
      }).join("")
    : `<li class="empty">${esc(t.empty)}</li>`;
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString(ru ? "ru-RU" : "en-US") : "";
  const doneLine = t.doneOf.replace("{d}", String(downloads));
  return `<!doctype html>
<html lang="${ru ? "ru" : "en"}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(t.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#050505;--panel:#111;--panel2:#161616;--line:#222;--ink:#f5f5f5;--muted:#9ca3af;--faint:#6b7280;--green:#22c55e;--orange:#f59e0b;--blue:#3b82f6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Sora,system-ui,sans-serif}
main{max-width:1120px;margin:0 auto;padding:28px 20px 64px}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}
h1{margin:0;font-size:28px;letter-spacing:-.03em;font-weight:700}
.sub{margin:6px 0 0;color:var(--muted);font-size:14px}
.btn{appearance:none;border:0;background:#fff;color:#000;font:inherit;font-weight:700;font-size:13px;border-radius:10px;padding:10px 14px;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.hero{display:flex;gap:18px;align-items:stretch;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;margin-bottom:14px}
@media(max-width:860px){.hero{flex-direction:column}}
.hero-main{flex:1;min-width:0}
.goal{margin:0 0 14px;font-size:15px;line-height:1.45;color:#e5e7eb}
.pct-row{display:flex;align-items:flex-end;gap:14px}
.pct{font-size:42px;font-weight:700;letter-spacing:-.04em;line-height:1}
.prog{flex:1;height:8px;background:#1f1f1f;border-radius:999px;overflow:hidden;margin-bottom:8px}
.prog>i{display:block;height:100%;background:linear-gradient(90deg,#22c55e,#4ade80);border-radius:inherit}
.done{color:var(--muted);font-size:13px;margin-top:8px}
.hero-side{display:grid;grid-template-columns:repeat(3,minmax(88px,1fr));gap:10px}
@media(max-width:860px){.hero-side{grid-template-columns:repeat(3,1fr)}}
.stat{background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:12px 12px 10px;min-width:0}
.stat b{display:block;font-size:22px;letter-spacing:-.03em;margin-top:4px}
.stat span{color:var(--faint);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:14px;margin-bottom:14px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px;min-height:240px}
.card h2{margin:0 0 4px;font-size:16px}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}
.head .meta{color:var(--muted);font-size:12px}
.warn{color:var(--orange);font-size:12px;font-weight:600}
.seg{display:flex;height:10px;border-radius:999px;overflow:hidden;background:#1a1a1a;margin:8px 0 14px}
.seg i{display:block;height:100%}
.versions{list-style:none;margin:0;padding:0}
.versions li{display:grid;grid-template-columns:10px 1fr auto auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #1c1c1c;font-size:13px}
.versions li:last-child{border-bottom:0}
.dot{width:8px;height:8px;border-radius:50%}
.lab{color:#e5e7eb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.num{color:var(--ink);font-weight:600}
.pct{color:var(--faint);width:42px;text-align:right}
.phones{list-style:none;margin:0;padding:0}
.phones li{display:grid;grid-template-columns:32px 1fr auto;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid #1c1c1c}
.phones li:last-child{border-bottom:0}
.av{width:32px;height:32px;border-radius:50%;background:#262626;display:grid;place-items:center;font-size:11px;font-weight:700;color:#ddd}
.av.sm{width:28px;height:28px;font-size:10px;flex:0 0 auto}
.who b{display:block;font-size:13px;font-weight:600;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{height:6px;background:#1f1f1f;border-radius:999px;overflow:hidden}
.track>i{display:block;height:100%;background:var(--blue);border-radius:inherit}
.phones li.over .track>i{background:var(--orange)}
.open{color:var(--muted);font-size:12px;white-space:nowrap}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #1c1c1c;font-size:13px}
.list li:last-child{border-bottom:0}
.list a{color:inherit;text-decoration:none;display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.list a:hover{color:#fff}
.pri{color:var(--faint);font-size:11px;font-weight:700;width:28px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#cbd5e1}
.ttl{color:#e5e7eb}
.pill{border-radius:999px;padding:4px 8px;font-size:11px;font-weight:600;background:#1f2937;color:#d1d5db;white-space:nowrap}
.pill.green{background:#052e1a;color:#4ade80}
.act{list-style:none;margin:0;padding:0}
.act li{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #1c1c1c;font-size:13px;color:#d1d5db}
.act li:last-child{border-bottom:0}
.act a{color:#fff;text-decoration:none}
.act .ago{color:var(--faint);font-size:11px;margin-top:3px}
.empty{color:var(--faint)!important;border:0!important;padding:18px 0!important;display:block!important}
.foot{margin-top:8px;color:var(--faint);font-size:12px}
</style>
</head>
<body>
<main>
  <div class="top">
    <div>
      <h1>${esc(t.brand)}</h1>
      <p class="sub">${esc(t.cycle)} · ${esc(updated)}</p>
    </div>
    <a class="btn" href="${t.langHref}">${t.lang}</a>
  </div>

  <section class="hero">
    <div class="hero-main">
      <p class="goal">${esc(t.goal)}</p>
      <div class="pct-row">
        <div class="pct">${latestPct}%</div>
        <div class="prog"><i style="width:${latestPct}%"></i></div>
      </div>
      <div class="done">${latest ? esc(latest.tag) : "—"} · ${opens} ${esc(doneLine)}</div>
    </div>
    <div class="hero-side">
      <div class="stat"><span>${esc(t.dl)}</span><b>${downloads}</b></div>
      <div class="stat"><span>${esc(t.wallets)}</span><b>${wallets}</b></div>
      <div class="stat"><span>${esc(t.opens)}</span><b>${opens}</b></div>
    </div>
  </section>

  <section class="grid">
    <div class="card">
      <div class="head"><h2>${esc(t.versions)}</h2><span class="meta">${versions.length}</span></div>
      <div class="seg">${seg}</div>
      <ul class="versions">${verList}</ul>
    </div>
    <div class="card">
      <div class="head"><h2>${esc(t.workload)}</h2><span class="meta">${devices.length} ${esc(t.people)}${deviceUsers ? ` · ${deviceUsers}` : ""}</span></div>
      <ul class="phones">${devList}</ul>
    </div>
  </section>

  <section class="grid">
    <div class="card">
      <div class="head"><h2>${esc(t.hot)}</h2><span class="meta">${hot.length}</span></div>
      <ul class="list">${hotList}</ul>
    </div>
    <div class="card">
      <div class="head"><h2>${esc(t.recent)}</h2><span class="meta">${recent.length}</span></div>
      <ul class="act">${actList}</ul>
    </div>
  </section>
  <p class="foot">${esc(updated)}</p>
</main>
</body>
</html>`;
}

function relTime(ts, ru) {
  const diff = Math.max(0, Date.now() - Number(ts || 0));
  const m = Math.floor(diff / 60000);
  if (m < 1) return ru ? "только что" : "just now";
  if (m < 60) return ru ? `${m} мин назад` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return ru ? `${h} ч назад` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return ru ? `${d} дн назад` : `${d}d ago`;
}

function esc(s) {return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
