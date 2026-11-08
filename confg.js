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

export const config = {githubRepo: "crc137/Gram-Wallet-Widget-Bot",githubTags: "https://api.github.com/repos/crc137/Gram-Wallet-Widget-Bot/tags",tonWallet: "UQCdxFNpC5j-bkMNVd_HB0QQY6AADviQN2mpChp8-hNgI9KT",starsAmount: 1,tonMinNanoton: 1,defaultLang: "en"};

export const i18n = {
  en: {
    welcome:"Gram Wallet Widget\n\nYou can support the project with a donation or skip and get the APK right away.",
    donateMenu: "Choose a donation method:",
    starsPay: "Pay with Telegram Stars.\nTap the button below — 1 ⭐ is enough.",
    tonPay:"Send any amount of TON (even the smallest) to the wallet.\n\nAddress:\n<code>{wallet}</code>\n\nComment (required):\n<code>{memo}</code>\n\nAfter sending, tap “Check payment”.",
    thanks: "Thank you for your donation! Here is your file.",
    donorCode: "Supporter code for the app badge:\n<code>{code}</code>\n\nIn Gram Wallet: long-press GRAM WALLET ➜ enter the code.",
    skipThanks: "Here is your file.",
    sending: "Please wait, sending the file…",
    tonOk: "Payment found. Thank you for your donation! Here is your file.",
    tonWait:"Payment not found yet. Make sure you included the comment, then try again in a minute.",
    invoiceError: "Could not create the invoice. Please try again later.",
    invoiceTitle: "Gram Wallet Widget",
    invoiceDesc: "Donation to support the project",
    invoiceLabel: "Donate",
    btnDonate: "Donate",
    btnSkip: "Skip",
    btnStars: "⭐ Stars",
    btnTon: "💎 TON",
    btnBack: "« Back",
    btnPayStars: "Pay {amount} ⭐",
    btnOpenWallet: "Open wallet",
    btnCheck: "Check payment",
    updateTitle: "New version {version}",
    updateFixed: "Fixed:",
    updateAdded: "Added:",
  },
  ru: {
    welcome:"Gram Wallet Widget\n\nМожете поддержать проект пожертвованием или пропустить и сразу получить APK.",
    donateMenu: "Выберите способ пожертвования:",
    starsPay: "Оплата Telegram Stars.\nНажмите кнопку ниже — достаточно 1 ⭐.",
    tonPay:"Переведите любую сумму TON (хоть минимальную) на кошелёк.\n\nАдрес:\n<code>{wallet}</code>\n\nКомментарий (обязательно):\n<code>{memo}</code>\n\nПосле перевода нажмите «Проверить оплату».",
    thanks: "Благодарим за пожертвование! Вот ваш файл.",
    donorCode: "Код спонсора для значка в приложении:\n<code>{code}</code>\n\nВ Gram Wallet: долгий тап по GRAM WALLET ➜ введите код.",
    skipThanks: "Вот ваш файл.",
    sending: "Ожидайте отправки файла…",
    tonOk: "Оплата найдена. Благодарим за пожертвование! Вот ваш файл.",
    tonWait:"Платёж пока не найден. Убедитесь, что указали комментарий, и попробуйте снова через минуту.",
    invoiceError: "Не удалось создать счёт. Попробуйте позже.",
    invoiceTitle: "Gram Wallet Widget",
    invoiceDesc: "Пожертвование на развитие проекта",
    invoiceLabel: "Donate",
    btnDonate: "Пожертвовать",
    btnSkip: "Пропустить",
    btnStars: "⭐ Звёздами",
    btnTon: "💎 TON",
    btnBack: "« Назад",
    btnPayStars: "Оплатить {amount} ⭐",
    btnOpenWallet: "Открыть кошелёк",
    btnCheck: "Проверить оплату",
    updateTitle: "Новая версия {version}",
    updateFixed: "Исправлено:",
    updateAdded: "Добавлено:",
  },
};

export function t(lang, key, vars) {
  const pack = i18n[lang] || i18n[config.defaultLang];
  let s = pack[key] ?? i18n[config.defaultLang][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function langOf(user) {
  const code = String(user?.language_code || config.defaultLang).toLowerCase();
  return code.startsWith("ru") ? "ru" : "en";
}
