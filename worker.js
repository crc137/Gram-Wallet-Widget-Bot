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
      const out = await trackWalletHash(env, body?.hash, body?.address, body?.gram);
      return json(out, out.ok ? 200 : 400);
    }
    if (request.method === "POST" && url.pathname === "/stats/open") {
      let body = {};
      try { body = await request.json(); } catch {}
      const out = await trackOpen(env, body?.device || body?.model || "");
      return json(out);
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
      ctx.waitUntil(handleUpdateOnce(update, env));
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/setup") {
      if (!env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN missing" }, 500);
      const secret = env.WEBHOOK_SECRET || "";
      const origin = String(env.PUBLIC_BASE || "https://gramwalletwidget.coonlink.com").replace(/\/$/, "");
      const hook = `${origin}/webhook${secret ? `?s=${encodeURIComponent(secret)}` : ""}`;
      const r = await tg(env.BOT_TOKEN, "setWebhook", {url: hook,allowed_updates: ["message", "callback_query", "pre_checkout_query"],drop_pending_updates: true});
      return json({ ...r, webhook: hook });
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

async function handleUpdateOnce(update, env) {
  const id = update?.update_id;
  if (id != null && env?.KV) {
    const key = `upd:${id}`;
    const prev = await env.KV.get(key);
    if (prev) return;
    await env.KV.put(key, "1", { expirationTtl: 60 * 60 * 24 });
  }
  return handleUpdate(update, env);
}

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
  const ids = Array.isArray(config.channelChatIds) ? config.channelChatIds.slice() : [];
  if (config.channelChatId && !ids.includes(config.channelChatId)) ids.unshift(config.channelChatId);
  const out = [];
  for (const raw of ids) {
    const id = String(raw || "").trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out.length ? out.slice(0, 1) : ["@GramWalletWidget"];
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
  const already = env?.KV ? await env.KV.get("last_channel_tag") : null;
  if (already === rel.tag_name) return { ok: true, tag: rel.tag_name, chatId: null, skipped: true };
  const apk = apkFromRelease(rel);
  if (!apk.url) return { ok: false, error: "no_apk", tag: rel.tag_name };
  const out = await postReleaseToChannel(env.BOT_TOKEN, rel, apk, cachedApkFileId(apk.tag));
  if (out.fileId) rememberApkFileId(apk.tag, out.fileId);
  if (out.ok && env?.KV) await env.KV.put("last_channel_tag", rel.tag_name);
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
    await env.KV.put("last_channel_tag", rel.tag_name);
    return;
  }
  apkCache = { tag: "", fileId: null };
  const apk = apkFromRelease(rel);
  if (!apk.url) {
    console.error(JSON.stringify({ noApk: rel.tag_name }));
    return;
  }
  let fileId = null;
  const lastChannel = await env.KV.get("last_channel_tag");
  if (lastChannel !== rel.tag_name) {
    const channel = await postReleaseToChannel(env.BOT_TOKEN, rel, apk, null);
    if (channel.fileId) fileId = channel.fileId;
    if (channel.ok) await env.KV.put("last_channel_tag", rel.tag_name);
    else console.error(JSON.stringify({ channelNotify: channel }));
  }
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

async function trackWalletHash(env, hash, address, gram) {
  let h = String(hash || "").trim().toLowerCase();
  const addr = String(address || "").trim();
  if (!/^[a-f0-9]{64}$/.test(h) && addr) {
    const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(addr));
    h = [...new Uint8Array(dig)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  if (!/^[a-f0-9]{64}$/.test(h)) return { ok: false, error: "hash required", added: false };
  if (!env?.KV) return { ok: false, error: "kv missing", added: false };
  const key = `stat:w:${h}`;
  const prev = await env.KV.get(key);
  const now = Date.now();
  const bal = gramToNano(gram);
  if (prev) {
    let row = { a: addr || "", t: now, h, b: bal };
    try {
      const old = JSON.parse(prev);
      row = { a: addr || old?.a || "", t: old?.t || now, h, b: bal || old?.b || "0" };
    } catch { row = { a: addr || "", t: now, h, b: bal }; }
    await env.KV.put(key, JSON.stringify(row));
    if (row.a) await pushRecentAppWallet(env, row);
    return { ok: true, added: false };
  }
  const row = { a: addr || "", t: now, h, b: bal };
  await env.KV.put(key, JSON.stringify(row));
  const total = await incrStat(env, "stat:wallets");
  if (row.a) await pushRecentAppWallet(env, row);
  return { ok: true, added: true, wallets: total };
}

async function trackOpen(env, device) {
  if (!env?.KV) return { ok: false };
  await incrStat(env, "stat:opens");
  const model = sanitizeDevice(device);
  if (model) await incrStat(env, `stat:dev:${model}`);
  return { ok: true, device: model || null };
}

function sanitizeDevice(raw) {
  const s = String(raw || "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
  return s;
}

function gramToNano(gram) {
  const n = Number(gram);
  if (!Number.isFinite(n) || n < 0) return "";
  try { return String(BigInt(Math.round(n * 1e9))); } catch { return ""; }
}

async function pushRecentAppWallet(env, row) {
  if (!env?.KV || !row?.a) return;
  let list = [];
  try { list = JSON.parse(await env.KV.get("stat:w:recent") || "[]") || []; } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  list = [{ a: row.a, t: row.t || Date.now(), h: row.h || "", b: row.b || "0" }, ...list.filter(x => x && x.a !== row.a)].slice(0, 40);
  await env.KV.put("stat:w:recent", JSON.stringify(list));
}

async function listKvPrefix(env, prefix) {
  const out = [];
  if (!env?.KV) return out;
  let cursor;
  do {
    const page = await env.KV.list({ prefix, cursor });
    for (const item of page.keys || []) out.push(item.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function fetchOneBalance(address) {
  const headers = { accept: "application/json", "user-agent": "GramWalletStats/1.0" };
  try {
    const res = await fetch(`https://tonapi.io/v2/accounts/${encodeURIComponent(address)}`, { headers });
    if (res.ok) {
      const j = await res.json();
      if (j?.balance != null && String(j.balance) !== "") return String(j.balance);
    }
  } catch {}
  try {
    const res = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${encodeURIComponent(address)}`, { headers });
    if (res.ok) {
      const j = await res.json();
      if (j?.ok && j.result != null) return String(j.result);
    }
  } catch {}
  return "";
}

async function fetchTonBalances(rows) {
  const list = (rows || []).filter(r => r?.a).slice(0, 12);
  const out = await Promise.all(list.map(async (row) => {
    const fetched = await fetchOneBalance(row.a);
    const stored = String(row.b || "0");
    let balance = stored;
    if (fetched !== "") {
      try { balance = BigInt(fetched) > BigInt(stored || "0") ? fetched : stored; }
      catch { balance = fetched || stored; }
    }
    return { address: row.a, balance: String(balance || "0") };
  }));
  out.sort((a, b) => {
    try {
      const left = BigInt(b.balance || "0");
      const right = BigInt(a.balance || "0");
      return left > right ? 1 : left < right ? -1 : 0;
    } catch { return 0; }
  });
  return out;
}

async function loadStats(env) {
  const downloadsTotal = Number((env?.KV && await env.KV.get("stat:dl:total")) || 0) || 0;
  const wallets = Number((env?.KV && await env.KV.get("stat:wallets")) || 0) || 0;
  const opens = Number((env?.KV && await env.KV.get("stat:opens")) || 0) || 0;
  const versions = [];
  const devices = [];
  if (env?.KV) {
    for (const name of await listKvPrefix(env, "stat:dl:v:")) {
      const tag = name.slice("stat:dl:v:".length);
      const count = Number(await env.KV.get(name)) || 0;
      if (tag) versions.push({ tag, count });
    }
    for (const name of await listKvPrefix(env, "stat:dev:")) {
      const model = name.slice("stat:dev:".length);
      const count = Number(await env.KV.get(name)) || 0;
      if (model) devices.push({ model, count });
    }
  }
  versions.sort((a, b) => b.count - a.count || String(b.tag).localeCompare(String(a.tag)));
  devices.sort((a, b) => b.count - a.count || String(a.model).localeCompare(String(b.model)));
  let recentApp = [];
  try { recentApp = JSON.parse((env?.KV && await env.KV.get("stat:w:recent")) || "[]") || []; } catch { recentApp = []; }
  if (!Array.isArray(recentApp)) recentApp = [];
  const byAddr = new Map();
  for (const row of recentApp) {if (row?.a) byAddr.set(row.a, { a: row.a, t: Number(row.t) || 0, h: row.h || "", b: row.b || "0" });}
  if (env?.KV) {
    for (const name of await listKvPrefix(env, "stat:w:")) {
      if (name === "stat:w:recent") continue;
      const raw = await env.KV.get(name);
      if (!raw || raw === "1") continue;
      try {
        const row = JSON.parse(raw);
        if (!row?.a) continue;
        const prev = byAddr.get(row.a);
        byAddr.set(row.a, {
          a: row.a,
          t: Number(row.t || prev?.t) || 0,
          h: row.h || name.slice(7),
          b: row.b || prev?.b || "0"
        });
      } catch {}
    }
  }
  recentApp = [...byAddr.values()].sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0));
  let hotApp = await fetchTonBalances(recentApp);
  if (!hotApp.length && recentApp.length) {
    hotApp = recentApp.map(r => ({ address: r.a, balance: String(r.b || "0") }));
    hotApp.sort((a, b) => {
      try {
        const left = BigInt(b.balance || "0");
        const right = BigInt(a.balance || "0");
        return left > right ? 1 : left < right ? -1 : 0;
      } catch { return 0; }
    });
  }
  const usdRate = await fetchGramUsd(env);
  return {downloadsTotal, wallets, opens, versions, devices,deviceModels: devices.length,recentApp: recentApp.slice(0, 20),hotApp,usdRate,updatedAt: new Date().toISOString()};
}

async function fetchGramUsd(env) {
  let cached = 0;
  try { cached = Number(await env.KV.get("stat:gram_usd")) || 0; } catch {}
  const tryParse = async (url, pick) => {
    try {
      const rr = await fetch(url, { headers: { accept: "application/json" } });
      if (!rr.ok) return 0;
      return Number(pick(await rr.json())) || 0;
    } catch { return 0; }
  };
  let rate = await tryParse("https://api.coinbase.com/v2/prices/TON-USD/spot", j => j?.data?.amount);
  if (!(rate > 0)) rate = await tryParse("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd", j => j?.["the-open-network"]?.usd);
  if (!(rate > 0)) rate = await tryParse("https://tonapi.io/v2/rates?tokens=gram&currencies=usd", j => j?.rates?.GRAM?.prices?.USD);
  if (rate > 0) {
    try { await env.KV.put("stat:gram_usd", String(rate), { expirationTtl: 3600 }); } catch {}
    return rate;
  }
  return cached;
}

function nanoToGram(nano) {
  const p = nanoToGramParts(nano);
  return p.frac ? `${p.whole}.${p.frac}` : p.whole;
}

function nanoToGramParts(nano) {
  try {
    const n = BigInt(String(nano || "0"));
    const whole = n / 1000000000n;
    const frac = n % 1000000000n;
    const f = frac.toString().padStart(9, "0").replace(/0+$/, "").slice(0, 2);
    const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return { whole: w, frac: f };
  } catch { return { whole: "0", frac: "" }; }
}

function shortAddr(a) {
  const s = String(a || "");
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function midAddr(a) {
  const s = String(a || "");
  if (s.length < 16) return { head: s, tail: "" };
  return { head: s.slice(0, 8), tail: s.slice(-6) };
}

function deviceBrand(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("xiaomi") || m.includes("redmi") || m.includes("poco")) return "xiaomi";
  if (m.includes("samsung") || m.startsWith("sm-") || m.includes("galaxy")) return "samsung";
  if (m.includes("google") || m.includes("pixel")) return "google";
  if (m.includes("honor")) return "honor";
  if (m.includes("huawei")) return "huawei";
  if (m.includes("oneplus")) return "oneplus";
  if (m.includes("oppo")) return "oppo";
  if (m.includes("vivo") || m.includes("iqoo")) return "vivo";
  if (m.includes("realme")) return "realme";
  if (m.includes("motorola") || m.includes("moto ")) return "motorola";
  if (m.includes("nothing")) return "nothing";
  if (m.includes("sony") || m.includes("xperia")) return "sony";
  if (m.includes("asus")) return "asus";
  if (m.includes("nokia")) return "nokia";
  if (m.includes("tecno") || m.includes("infinix")) return "tecno";
  if (m.includes("apple") || m.includes("iphone")) return "apple";
  if (m.includes("meizu")) return "meizu";
  if (m.includes("lenovo")) return "lenovo";
  return "phone";
}

function brandMeta(brand) {
  const map = {
    xiaomi: { bg: "#FF6900", icon: "xiaomi", color: "white" },
    samsung: { bg: "#1428A0", icon: "samsung", color: "white" },
    google: { bg: "#F1F3F4", icon: "google", color: "4285F4" },
    huawei: { bg: "#CF0A2C", icon: "huawei", color: "white" },
    honor: { bg: "#111111", icon: "honor", color: "white" },
    oneplus: { bg: "#F50537", icon: "oneplus", color: "white" },
    oppo: { bg: "#000000", icon: "oppo", color: "white" },
    vivo: { bg: "#415FFF", icon: "vivo", color: "white" },
    realme: { bg: "#FFC915", icon: "realme", color: "111111" },
    motorola: { bg: "#111111", icon: "motorola", color: "white" },
    nothing: { bg: "#111111", icon: "nothing", color: "white" },
    sony: { bg: "#111111", icon: "sony", color: "white" },
    asus: { bg: "#111111", icon: "asus", color: "white" },
    nokia: { bg: "#124191", icon: "nokia", color: "white" },
    apple: { bg: "#F4F4F5", icon: "apple", color: "111111" },
    lenovo: { bg: "#E2231A", icon: "lenovo", color: "white" },
    tecno: { bg: "#015AFF", icon: "tecno", color: "white" },
    meizu: { bg: "#111111", icon: "meizu", color: "white" },
    phone: { bg: "#F4F4F5", icon: "", color: "71717A" }
  };
  return map[brand] || map.phone;
}

function brandLogo(brand) {
  const meta = brandMeta(brand);
  if (brand === "xiaomi") {return `<svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><path fill="#FF6900" d="M12 0C8.016 0 4.756.255 2.493 2.516.23 4.776 0 8.033 0 12.012c0 3.98.23 7.235 2.494 9.497C4.757 23.77 8.017 24 12 24c3.983 0 7.243-.23 9.506-2.491C23.77 19.247 24 15.99 24 12.012c0-3.984-.233-7.243-2.502-9.504C19.234.252 15.978 0 12 0zM4.906 7.405h5.624c1.47 0 3.007.068 3.764.827.746.746.827 2.233.83 3.676v4.54a.15.15 0 0 1-.152.147h-1.947a.15.15 0 0 1-.152-.148V11.83c-.002-.806-.048-1.634-.464-2.051-.358-.36-1.026-.441-1.72-.458H7.158a.15.15 0 0 0-.151.147v6.98a.15.15 0 0 1-.152.148H4.906a.15.15 0 0 1-.15-.148V7.554a.15.15 0 0 1 .15-.149zm12.131 0h1.949a.15.15 0 0 1 .15.15v8.892a.15.15 0 0 1-.15.148h-1.949a.15.15 0 0 1-.151-.148V7.554a.15.15 0 0 1 .151-.149zM8.92 10.948h2.046c.083 0 .15.066.15.147v5.352a.15.15 0 0 1-.15.148H8.92a.15.15 0 0 1-.152-.148v-5.352a.15.15 0 0 1 .152-.147Z"/></svg>`;}
  if (!meta.icon) {return `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2" fill="none" stroke="#a1a1aa" stroke-width="1.6"/><circle cx="12" cy="17.5" r=".9" fill="#a1a1aa"/></svg>`;}
  const src = `https://cdn.simpleicons.org/${meta.icon}/${meta.color}`;
  return `<img class="brand" src="${src}" width="18" height="18" alt="" loading="lazy"/>`;
}

function gramMark() {return `<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path fill="#0098EA" d="M12 2.2 20.2 7v10L12 21.8 3.8 17V7L12 2.2Zm0 2.9L6.6 8.2v7.6L12 19l5.4-3.2V8.2L12 5.1Z"/></svg>`;}
function rankTone(i) { return i === 0 ? "r1" : i === 1 ? "r2" : i === 2 ? "r3" : "rn"; }
function prettyDevice(model) {return String(model || "").trim().replace(/^xiaomi\s+/i, "Xiaomi ").replace(/^samsung\s+/i, "Samsung ").replace(/^google\s+/i, "Google ");}

function statsHtml(data, lang = "en") {
  const ru = lang === "ru";
  const t = ru ? {
    title: "Gram Wallet",
    sub: "Статистика приложения",
    hero: "Обзор",
    heroHint: "Скачивания, открытия и кошельки внутри приложения",
    live: "live",
    dl: "Скачивания", wallets: "Кошельки", opens: "Открытия", models: "Модели",
    doneOf: "скачиваний релизов",
    releases: "Релизы", phones: "Телефоны", devices: "устройств",
    hot: "Крупнейшие балансы", neu: "Новые кошельки",
    gram: "GRAM", empty: "Пока пусто", opensShort: "открытий",
    other: "EN", otherHref: "/stats"
  } : {
    title: "Gram Wallet",
    sub: "App analytics",
    hero: "Overview",
    heroHint: "Downloads, opens and wallets inside the app",
    live: "live",
    dl: "Downloads", wallets: "Wallets", opens: "Opens", models: "Models",
    doneOf: "release downloads",
    releases: "Releases", phones: "Phones", devices: "devices",
    hot: "Largest balances", neu: "New wallets",
    gram: "GRAM", empty: "Nothing yet", opensShort: "opens",
    other: "RU", otherHref: "/ru/stats"
  };

  const downloads = Number(data.downloadsTotal) || 0;
  const wallets = Number(data.wallets) || 0;
  const opens = Number(data.opens) || 0;
  const models = Number(data.deviceModels) || 0;
  const versions = data.versions || [];
  const verTotal = versions.reduce((s, v) => s + (Number(v.count) || 0), 0) || 1;
  const deviceTotal = (data.devices || []).reduce((s, d) => s + (Number(d.count) || 0), 0) || 0;
  const maxDevice = Math.max(1, ...(data.devices || []).map(d => Number(d.count) || 0));
  const usdRate = Number(data.usdRate) || 0;
  const progress = Math.min(100, downloads ? Math.max(8, Math.min(92, downloads * 8)) : 6);

  const releaseSeg = versions.slice(0, 5).map((v, i) => {
    const c = Number(v.count) || 0;
    const grow = c / verTotal;
    const colors = ["var(--fg)", "var(--fg-35)", "var(--fg-15)", "#08f", "var(--mute)"];
    return `<span style="flex-grow:${grow};background:${colors[i % colors.length]}"></span>`;
  }).join("") || `<span style="flex-grow:1;background:var(--fg-15)"></span>`;

  const releaseRows = versions.map(v => {
    const c = Number(v.count) || 0;
    const pct = Math.round(c * 100 / verTotal);
    return `<li><span class="name">${esc(v.tag)}</span><span class="n">${c}</span><span class="p">${pct}%</span></li>`;
  }).join("") || `<li class="empty">${esc(t.empty)}</li>`;

  const phoneRows = (data.devices || []).slice(0, 12).map(d => {
    const c = Number(d.count) || 0;
    const brand = deviceBrand(d.model);
    const meta = brandMeta(brand);
    const pct = Math.round(c * 100 / maxDevice);
    const avStyle = brand === "xiaomi" ? "background:transparent;padding:0" : `background:${meta.bg}`;
    return `<li><button type="button"><span class="av" style="${avStyle}">${brandLogo(brand)}</span><div class="who"><div class="line"><span class="nm">${esc(prettyDevice(d.model))}</span><span class="cnt"><b>${c}</b> ${esc(t.opensShort)}</span></div></div></button></li>`;
  }).join("") || `<li class="empty">${esc(t.empty)}</li>`;

  const maxBal = (data.hotApp || []).reduce((m, w) => {try { const n = BigInt(w.balance || "0"); return n > m ? n : m; } catch { return m; }}, 0n);

  const hotRows = (data.hotApp || []).filter(w => { try { return BigInt(w.balance || "0") > 0n; } catch { return false; } }).slice(0, 10).map((w, i) => {
    let pct = 0;
    try { if (maxBal > 0n) pct = Number((BigInt(w.balance || "0") * 10000n) / maxBal) / 100; } catch {}
    const parts = nanoToGramParts(w.balance);
    const mid = midAddr(w.address);
    let usd = "";
    if (usdRate > 0) {
      try {
        const v = ((Number(BigInt(w.balance || "0")) / 1e9) * usdRate);
        usd = `≈ ${v.toLocaleString(ru ? "ru-RU" : "en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} $`;
      } catch {}
    }
    const tone = i === 0 ? "r1" : i === 1 ? "r2" : i === 2 ? "r3" : "rn";
    const fracHtml = parts.frac ? `<span class="frac">.${esc(parts.frac)}</span>` : "";
    const title = mid.tail? `<span class="title mono" title="${esc(w.address)}"><span class="head">${esc(mid.head)}</span><span class="dots">…</span><span class="tail">${esc(mid.tail)}</span></span>`: `<span class="title mono">${esc(mid.head)}</span>`;
    return `<a class="row" href="https://gram.org/address/${esc(w.address)}" target="_blank" rel="noopener"><span class="rank ${tone}">${i + 1}</span><span class="who">${title}</span></span><span class="amount"><span class="ton"><span class="num">${esc(parts.whole)}${fracHtml}</span><span class="unit"> ${t.gram}</span><img class="coin" src="https://gram.org/assets/gem-blue.v1.webp" alt="" width="16" height="16" decoding="async"/></span>${usd ? `<small class="muted">${esc(usd)}</small>` : ""}</span></a>`;
  }).join("") || `<div class="empty">${esc(t.empty)}</div>`;

  const newRows = (data.recentApp || []).slice(0, 10).map(w => {
    const when = w.t ? new Date(Number(w.t)).toISOString().replace("T", " ").slice(0, 16) : "";
    return `<li class="act"><span class="rail"></span><span class="pill">${esc(shortAddr(w.a).slice(0, 2).toUpperCase())}</span><div><p><b>${esc(shortAddr(w.a))}</b></p><p class="when">${esc(when)}</p></div></li>`;
  }).join("") || `<li class="empty">${esc(t.empty)}</li>`;

  return `<!doctype html>
<html lang="${ru ? "ru" : "en"}" class="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#212121" media="(prefers-color-scheme: dark)" />
<meta name="description" content="${esc(ru ? "Статистика приложения Gram Wallet: скачивания, открытия, кошельки и устройства." : "Gram Wallet app analytics: downloads, opens, wallets and devices.")}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Gram Wallet" />
<meta property="og:title" content="${esc(t.title)}" />
<meta property="og:description" content="${esc(t.sub)}" />
<meta property="og:image" content="https://gram.org/og-image.jpg" />
<meta property="og:image:width" content="1280" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Gram Wallet" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(t.title)}" />
<meta name="twitter:description" content="${esc(t.sub)}" />
<meta name="twitter:image" content="https://gram.org/og-image.jpg" />
<script id="seo-schema" type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Gram Wallet","alternateName":["Gram Wallet","Gram"],"url":"https://gramwalletwidget.coonlink.com/","description":"${esc(ru ? "Статистика приложения Gram Wallet: скачивания, открытия, кошельки и устройства." : "Gram Wallet app analytics: downloads, opens, wallets and devices.")}"}</script>
<link rel="icon" href="https://gram.org/icons/favicon-32.png" sizes="32x32" type="image/png" />
<link rel="icon" href="https://gram.org/icons/favicon-64.png" sizes="64x64" type="image/png" />
<link rel="preload" as="image" href="https://gram.org/assets/gem-white.v1.webp" type="image/webp" />
<link rel="manifest" href="https://gram.org/manifest.json" />
<link rel="apple-touch-icon" href="https://gram.org/icons/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-title" content="Gram Wallet" />
<title>${esc(t.title)}</title>
<style>
@import url("https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap");
:root{
  --page:#0a0a0a;--bg:#0a0a0a;--muted:#171717;--shell:rgba(23,23,23,.6);
  --fg:#ededed;--fg-15:rgba(237,237,237,.15);--fg-35:rgba(237,237,237,.35);--fg-07:rgba(237,237,237,.07);
  --mute:#a3a3a3;--mute2:#737373;--border:#262626;--sky:#08f;
}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--fg);font:14px/1.45 Geist,ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1200px;margin:0 auto;padding:16px 16px 64px;display:flex;flex-direction:column;gap:16px}
@media(min-width:640px){main{padding:32px 32px 80px;gap:20px}}
.top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px 24px;margin-bottom:2px}
h1{margin:0;font-size:24px;font-weight:600;letter-spacing:-.025em}
.sub{margin:4px 0 0;color:var(--mute);font-size:14px;font-weight:400}
a.lang{display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:10px;background:var(--fg);color:var(--bg);text-decoration:none;font-size:13px;font-weight:500}
.shell{background:var(--shell);border-radius:24px;padding:6px;display:flex;flex-direction:column;min-width:0;height:100%}
.shell>header{min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 4px 0 12px}
.shell>header h2{margin:0;font-size:14px;font-weight:500}
.shell>header .meta{color:var(--mute);font-size:13px;font-variant-numeric:tabular-nums}
.badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;background:var(--bg);font-size:12px;font-weight:500;margin-right:4px}
.badge i{width:6px;height:6px;border-radius:99px;background:var(--mute);display:inline-block}
.panel{background:var(--bg);border-radius:18px;overflow:hidden;min-width:0;flex:1}
.hero-grid{display:grid;gap:20px;padding:16px}
@media(min-width:900px){.hero-grid{grid-template-columns:minmax(0,1fr) 400px;align-items:center;gap:40px;padding:20px}}
.hero-copy{color:var(--fg);font-size:14px;margin:0;max-width:42ch}
.hero-metrics{margin-top:16px;display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.hero-metrics b{font-size:24px;font-weight:600;letter-spacing:-.025em;font-variant-numeric:tabular-nums}
.hero-metrics span{font-size:13px;color:var(--mute);font-variant-numeric:tabular-nums}
.progress{margin-top:10px;height:6px;width:100%;overflow:hidden;border-radius:999px;background:var(--fg-07)}
.progress>i{display:block;height:100%;border-radius:999px;background:var(--fg)}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.tile{min-width:0;border-radius:12px;background:var(--muted);padding:10px 12px}
.tile dt{margin:0;color:var(--mute);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile dd{margin:2px 0 0;font-size:15px;font-weight:500;font-variant-numeric:tabular-nums}
.grid2{display:grid;gap:16px}
@media(min-width:900px){.grid2{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:20px}}
.seg{display:flex;height:8px;width:100%;gap:3px;overflow:hidden;border-radius:999px;padding:16px;box-sizing:content-box}
.seg>span{height:100%;border-radius:999px;min-width:4px;flex-basis:0}
ul{list-style:none;margin:0;padding:0}
ul li.empty{padding:14px 16px;color:var(--mute2);font-size:13px}
.releases li{display:flex;align-items:center;gap:10px;padding:14px 16px}
.releases .dot{width:14px;height:14px;border-radius:99px;border:1.5px solid var(--mute);flex:none}
.releases .dot.done{background:var(--fg);border:0;box-shadow:none;position:relative}
.releases .dot.done:after{content:"";position:absolute;inset:3.5px;border-radius:99px;background:var(--bg)}
.releases .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.releases .n{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}
.releases .p{width:40px;text-align:right;font-size:12px;color:var(--mute);font-variant-numeric:tabular-nums}
.phones button{width:100%;display:flex;align-items:center;gap:12px;padding:10px 16px;border:0;background:transparent;color:inherit;text-align:left;cursor:default;font:inherit}
.phones button:hover{background:rgba(23,23,23,.5)}
.av{width:28px;height:28px;border-radius:999px;display:grid;place-items:center;overflow:hidden;flex:none;background:var(--muted)}
.av img,.av svg{display:block}
.av img{width:14px;height:14px}
.av svg{width:28px;height:28px}
.who{min-width:0;flex:1}
.who .line{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.who .nm{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who .cnt{font-size:12px;color:var(--mute);font-variant-numeric:tabular-nums;flex:none}
.who .cnt b{color:var(--fg);font-weight:500}
.bar{margin-top:6px;height:4px;width:100%;overflow:hidden;border-radius:999px;background:var(--fg-07)}
.bar>i{display:block;height:100%;border-radius:999px;background:var(--fg)}
.list-card{overflow:hidden}
.list-card .row{position:relative;display:flex;align-items:center;gap:12px;min-height:60px;padding:9px 16px;color:var(--fg);text-decoration:none;white-space:nowrap;transition:background .15s}
.list-card .row:hover{background:rgba(23,23,23,.55)}
.list-card .row+.row:before{content:"";position:absolute;top:0;left:68px;right:0;border-top:1px solid var(--border)}
.rank{display:grid;flex:none;place-items:center;width:32px;height:32px;margin:0 4px;border-radius:50%;background:var(--muted);color:var(--mute);font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.rank.r1{background:linear-gradient(135deg,#ffe08a,#f5b400);color:#6b4a00}
.rank.r2{background:linear-gradient(135deg,#eef1f5,#b9c1cc);color:#4a5361}
.rank.r3{background:linear-gradient(135deg,#f6c9a1,#d08a4f);color:#5c3315}
.who{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}
.title{overflow:hidden;font-weight:600;font-size:15px;text-overflow:ellipsis}
.title.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:500;display:inline-flex;align-items:baseline;min-width:0;max-width:100%;overflow:hidden}
.title.mono .head,.title.mono .dots,.title.mono .tail{flex:none}
.share{height:3px;overflow:hidden;border-radius:2px;background:var(--muted)}
.share>span{display:block;height:100%;border-radius:2px;background:#08f;opacity:.55}
.amount{display:flex;flex:none;flex-direction:column;align-items:flex-end;gap:1px}
.amount .ton{display:inline-flex;align-items:center;gap:4px;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.amount .num{font-variant-numeric:tabular-nums}
.amount .frac{font-weight:600;opacity:.72}
.amount .unit{color:var(--mute);font-weight:500;font-size:13px}
.amount .coin{display:block;width:16px;height:16px;flex:none}
.amount .muted{font-size:12px;color:var(--mute2)}
.list-card .empty{padding:14px 16px;color:var(--mute2);font-size:13px}
.act{position:relative;display:flex;gap:12px;padding:0 16px 16px}
.act:first-child{padding-top:14px}
.act .rail{position:absolute;left:27px;top:28px;bottom:0;width:1px;background:var(--border)}
.act:last-child .rail{display:none}
.act .pill{width:24px;height:24px;border-radius:999px;background:var(--muted);color:var(--mute);display:grid;place-items:center;font-size:9px;font-weight:600;flex:none;position:relative;z-index:1}
.act p{margin:0;font-size:13px;color:var(--mute);line-height:1.35}
.act b{color:var(--fg);font-weight:500}
.act .when{margin-top:2px;font-size:12px;color:var(--mute2);font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<main>
  <div class="top">
    <div><h1>${esc(t.title)}</h1><p class="sub">${esc(t.sub)}</p></div>
    <a class="lang" href="${t.otherHref}">${t.other}</a>
  </div>

  <section class="shell">
    <header>
      <div style="display:flex;align-items:baseline;gap:8px;min-width:0">
        <h2>${esc(t.hero)}</h2>
        <span class="meta">${esc(t.dl)}</span>
      </div>
    </header>
    <div class="panel">
      <div class="hero-grid">
        <div>
          <p class="hero-copy">${esc(t.heroHint)}</p>
          <div class="hero-metrics"><b>${downloads}</b><span>${esc(t.doneOf)}</span></div>
        </div>
        <dl class="tiles">
          <div class="tile"><dt>${esc(t.wallets)}</dt><dd>${wallets}</dd></div>
          <div class="tile"><dt>${esc(t.opens)}</dt><dd>${opens}</dd></div>
          <div class="tile"><dt>${esc(t.models)}</dt><dd>${models}</dd></div>
        </dl>
      </div>
    </div>
  </section>

  <div class="grid2">
    <section class="shell">
      <header>
        <div style="display:flex;align-items:baseline;gap:8px"><h2>${esc(t.releases)}</h2><span class="meta">${versions.length}</span></div>
      </header>
      <div class="panel">
        <ul class="releases">${releaseRows}</ul>
      </div>
    </section>

    <section class="shell">
      <header>
        <div style="display:flex;align-items:baseline;gap:8px"><h2>${esc(t.phones)}</h2><span class="meta">${deviceTotal} ${esc(t.devices)}</span></div>
      </header>
      <div class="panel">
        <ul class="phones">${phoneRows}</ul>
      </div>
    </section>
  </div>

  <div class="grid2">
    <section class="shell">
      <header><div style="display:flex;align-items:baseline;gap:8px"><h2>${esc(t.hot)}</h2></div></header>
      <div class="panel"><div class="list-card">${hotRows}</div></div>
    </section>
    <section class="shell">
      <header><div style="display:flex;align-items:baseline;gap:8px"><h2>${esc(t.neu)}</h2><span class="meta">${(data.recentApp||[]).length}</span></div></header>
      <div class="panel"><ul>${newRows}</ul></div>
    </section>
  </div>
</main>
</body>
</html>`;
}

function esc(s) {return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
