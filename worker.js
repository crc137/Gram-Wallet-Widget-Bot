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
const CB = {donate: "d",skip: "s",stars: "st",ton: "tn",check: "ck",back: "bk"}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {return json({ ok: true, service: "gram-wallet-widget-bot" })}
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
      await onStarsPaid(msg, token, env);
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
    await edit(token, chatId, messageId, t(lang, "donateMenu"), [[{ text: t(lang, "btnStars"), callback_data: CB.stars },{ text: t(lang, "btnTon"), callback_data: CB.ton }],[{ text: t(lang, "btnBack"), callback_data: CB.back }]]);
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

  if (data === CB.check) {
    const found = await findTonPayment(userId);
    if (!found) {
      await tg(token, "answerCallbackQuery", {callback_query_id: cq.id,text: t(lang, "tonWait"),show_alert: true});
      return;
    }
    await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
    await deliverApk(token, chatId, messageId, t(lang, "tonOk"), lang, env);
    return;
  }

  await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
}

async function onStarsPaid(msg, token, env) {
  const sp = msg.successful_payment;
  if (!sp || sp.currency !== "XTR") return;
  const lang = langOf(msg.from);
  const parts = String(sp.invoice_payload || "").split(":");
  if (parts[0] !== "gw" || parts.length < 4) {
    await deliverApk(token, msg.chat.id, null, t(lang, "thanks"), lang, env);
    return;
  }
  const chatId = Number(parts[1]);
  const messageId = Number(parts[2]);
  await deliverApk(token, chatId || msg.chat.id, messageId || null, t(lang, "thanks"), lang, env);
}

async function createStarsLink(token, chatId, messageId, userId, lang) {
  const r = await tg(token, "createInvoiceLink", {title: t(lang, "invoiceTitle"),description: t(lang, "invoiceDesc"),payload: `gw:${chatId}:${messageId}:${userId}`,provider_token: "",currency: "XTR",prices: [{ label: t(lang, "invoiceLabel"), amount: config.starsAmount }]});
  return r?.ok ? r.result : null;
}

function tonMemo(userId) {return `gw${userId}`}

async function findTonPayment(userId) {
  const memo = tonMemo(userId);
  const addr = encodeURIComponent(config.tonWallet);
  const res = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${addr}&limit=40`,{ headers: { accept: "application/json" } });
  if (!res.ok) return false;
  const data = await res.json();
  const txs = data.result || [];
  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;
    if (Number(inMsg.value || 0) < config.tonMinNanoton) continue;
    if (String(inMsg.message || "").trim() === memo) return true;
  }
  return false;
}

let apkFileId = null;
let releaseCache = { at: 0, data: null };

async function getLatestRelease() {
  if (releaseCache.data && Date.now() - releaseCache.at < 60_000) return releaseCache.data;
  const res = await fetch(`https://api.github.com/repos/${config.githubRepo}/releases/latest`, {headers: { accept: "application/vnd.github+json", "user-agent": "gram-wallet-widget-bot" }});
  if (!res.ok) return releaseCache.data;
  const data = await res.json();
  releaseCache = { at: Date.now(), data };
  return data;
}

function apkFromRelease(rel) {
  const asset = (rel?.assets || []).find((a) => String(a.name || "").toLowerCase().endsWith(".apk"));
  return {url: asset?.browser_download_url || config.apkUrl,name: asset?.name || config.apkFilename,tag: rel?.tag_name || "",body: String(rel?.body || "").trim()};
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
  if (env && rel?.tag_name && await alreadyGot(env, chatId, rel.tag_name)) {
    const text = formatChangelog(lang, rel) || t(lang, "updateTitle", { version: rel.tag_name });
    const doneText = notesJoin(caption, text);
    if (messageId) await edit(token, chatId, messageId, doneText, []);
    else await tg(token, "sendMessage", { chat_id: chatId, text: doneText });
    return;
  }
  const notes = formatChangelog(lang, rel);
  const doneText = notesJoin(caption, notes);
  const sent = await sendApkDocument(token, chatId, apk, apkFileId);
  const fileId = sent?.result?.document?.file_id;
  if (fileId) apkFileId = fileId;
  if (!sent?.ok) return;
  if (env && rel?.tag_name) await markGot(env, chatId, rel.tag_name);
  if (messageId) await edit(token, chatId, messageId, doneText, []);
  else await tg(token, "sendMessage", { chat_id: chatId, text: doneText });
}

function notesJoin(caption, notes) {return notes ? `${caption}\n\n${notes}` : caption;}

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
  apkFileId = null;
  const apk = apkFromRelease(rel);
  if (!apk.url) {
    console.error(JSON.stringify({ noApk: rel.tag_name }));
    return;
  }
  const keys = await listSubs(env);
  let fileId = null;
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
  if (fileId) apkFileId = fileId;
  await env.KV.put("last_tag", rel.tag_name);
  console.log(JSON.stringify({ notified: true, tag: rel.tag_name, subs: keys.length, ok, fail, skipped }));
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

function json(data, status = 200) {return new Response(JSON.stringify(data), {status,headers: { "content-type": "application/json" }})}
