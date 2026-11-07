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
      try {update = await request.json()} catch {return new Response("bad request", { status: 400 })}
      ctx.waitUntil(handleUpdate(update, env));
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
      await onCallback(update.callback_query, token);
      return;
    }
    const msg = update.message;
    if (!msg) return;
    if (msg.successful_payment) {
      await onStarsPaid(msg, token);
      return;
    }
    if (msg.text && msg.text.startsWith("/start")) {await showWelcome(msg.chat.id, token, langOf(msg.from))}
  } catch (err) {console.error(JSON.stringify({ err: String(err), stack: err?.stack }))}
}

function mainKb(lang) {return [[{ text: t(lang, "btnDonate"), callback_data: CB.donate },{ text: t(lang, "btnSkip"), callback_data: CB.skip }]]}
async function showWelcome(chatId, token, lang) {await tg(token, "sendMessage", {chat_id: chatId,text: t(lang, "welcome"),reply_markup: { inline_keyboard: mainKb(lang) }})}

async function onCallback(cq, token) {
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
    await deliverApk(token, chatId, messageId, t(lang, "skipThanks"));
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
    await deliverApk(token, chatId, messageId, t(lang, "tonOk"));
    return;
  }

  await tg(token, "answerCallbackQuery", { callback_query_id: cq.id });
}

async function onStarsPaid(msg, token) {
  const sp = msg.successful_payment;
  if (!sp || sp.currency !== "XTR") return;
  const lang = langOf(msg.from);
  const parts = String(sp.invoice_payload || "").split(":");
  if (parts[0] !== "gw" || parts.length < 4) {
    await deliverApk(token, msg.chat.id, null, t(lang, "thanks"));
    return;
  }
  const chatId = Number(parts[1]);
  const messageId = Number(parts[2]);
  await deliverApk(token, chatId || msg.chat.id, messageId || null, t(lang, "thanks"));
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

async function deliverApk(token, chatId, messageId, caption) {
  if (messageId) {await edit(token, chatId, messageId, caption, [])}
  await tg(token, "sendDocument", {chat_id: chatId,document: config.apkUrl,caption: config.apkFilename});
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
