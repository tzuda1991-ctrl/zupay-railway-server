const express = require('express');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const Tesseract = require('tesseract.js');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = './config.json';

// Dynamic Config (Android App se automatic set hoga, Railway variables ki zaroorat nahi)
let config = {
    tgBotToken: "",
    tgChatId: "",
    callbackUrl: "",
    secretKey: "zupay123"
};

if (fs.existsSync(CONFIG_FILE)) {
    try {
        config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    } catch (e) {}
}

let lastQrCode = null;
let waReady = false;
const bankUTRs = {};
const pendingOrders = {};

async function sendTG(text) {
    if (!config.tgBotToken || !config.tgChatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${config.tgBotToken}/sendMessage`, {
            chat_id: config.tgChatId,
            text: text,
            parse_mode: "Markdown"
        });
    } catch (e) {
        console.error("TG Error:", e.message);
    }
}

async function sendQrToTG(qr) {
    if (!config.tgBotToken || !config.tgChatId || !qr) return;
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
    try {
        await axios.post(`https://api.telegram.org/bot${config.tgBotToken}/sendPhoto`, {
            chat_id: config.tgChatId,
            photo: qrImageUrl,
            caption: "📱 *Scan this QR from your WhatsApp (Linked Devices) to connect ZuPay Bot!*"
        });
    } catch (e) {
        console.error("QR Send Error:", e.message);
    }
}

app.get('/', (req, res) => {
    res.send(`ZuPay Gateway Running! 🚀 | Configured: ${!!config.tgBotToken} | WhatsApp Ready: ${waReady}`);
});

// 1. ANDROID APP SE CONFIG SAVE KARNE KA ENDPOINT (Zero Railway Variables Needed)
app.post('/api/setup-config', async (req, res) => {
    const { tgBotToken, tgChatId, callbackUrl, secretKey } = req.body;
    if (!tgBotToken || !tgChatId) {
        return res.status(400).json({ error: "Bot Token and Chat ID required" });
    }

    config = {
        tgBotToken: tgBotToken.trim(),
        tgChatId: tgChatId.trim(),
        callbackUrl: (callbackUrl || "").trim(),
        secretKey: (secretKey || "zupay123").trim()
    };

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

    await sendTG(
        `⚙️ *ZuPay Configuration Synced from Android App!*\n` +
        `━━━━━━━━━━━━━━\n` +
        `🔗 *Callback URL:* \`${config.callbackUrl || "Not Set"}\`\n` +
        `📡 *WhatsApp Status:* ${waReady ? "✅ Connected" : "⏳ Generating QR..."}`
    );

    // Agar WhatsApp abhi login nahi hai aur QR taiyar hai, to turant Telegram pe bhej dein
    if (!waReady && lastQrCode) {
        await sendQrToTG(lastQrCode);
    }

    res.json({ success: true, message: "Config saved and Telegram notified!" });
});

// 2. ANDROID SMS READER WEBHOOK
app.post('/api/sms-webhook', async (req, res) => {
    const { secret, sender, message, tgBotToken, tgChatId, callbackUrl } = req.body;

    // Auto-update config agar Android App har SMS ke saath credentials bhej rahi hai
    if (tgBotToken && tgChatId && !config.tgBotToken) {
        config = { tgBotToken, tgChatId, callbackUrl: callbackUrl || "", secretKey: secret || "zupay123" };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }

    if (config.secretKey && secret !== config.secretKey) {
        return res.status(403).json({ error: "Invalid Secret" });
    }

    const utrMatch = message.match(/\b\d{12}\b/);
    const amtMatch = message.match(/(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);

    if (utrMatch && amtMatch) {
        const utr = utrMatch[0];
        const rawAmt = amtMatch[1].replace(/,/g, '');
        const amount = Math.floor(parseFloat(rawAmt)).toString();

        if (!bankUTRs[utr]) {
            bankUTRs[utr] = { amount, status: "UNCLAIMED", time: Date.now() };
            await sendTG(
                `🏦 *Bank SMS Received!*\n` +
                `━━━━━━━━━━━━━━\n` +
                `💰 *Amount:* ₹${amount}\n` +
                `🔢 *UTR:* \`${utr}\`\n` +
                `📱 *Bank:* ${sender}\n` +
                `⏳ *Status:* Unclaimed (Waiting on WhatsApp)`
            );
        }
    }
    res.json({ ok: true });
});

// 3. CREATE ORDER API
app.post('/api/create-order', (req, res) => {
    const { userPhone, orderId, amount } = req.body;
    pendingOrders[userPhone] = { orderId, amount: amount.toString() };
    res.json({ success: true, orderId });
});

// 4. WHATSAPP CLIENT
const wa = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa_session' }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
    }
});

wa.on('qr', async (qr) => {
    lastQrCode = qr;
    waReady = false;
    await sendQrToTG(qr);
});

wa.on('ready', () => {
    waReady = true;
    lastQrCode = null;
    sendTG("✅ *WhatsApp Payment Bot Connected & Ready!*");
});

wa.on('message', async (msg) => {
    const userPhone = msg.from.replace('@c.us', '');
    let textContent = msg.body || "";

    if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media && media.mimetype.startsWith('image/')) {
            await msg.reply("⏳ *Screenshot scan ho raha hai, 5 second rukiye...*");
            const imgBuffer = Buffer.from(media.data, 'base64');
            const { data: { text } } = await Tesseract.recognize(imgBuffer, 'eng');
            textContent += " " + text;
        }
    }

    const utrMatch = textContent.match(/\b\d{12}\b/);
    if (!utrMatch) return;

    const utr = utrMatch[0];
    const record = bankUTRs[utr];

    if (!record) {
        return msg.reply(`❌ *UTR ${utr} Not Found!*\nAbhi tak bank SMS nahi aaya hai. Kripya 30 second baad dobara UTR bhejein.`);
    }

    if (record.status === "CLAIMED") {
        return msg.reply(`⚠️ *Duplicate UTR!*\nUTR \`${utr}\` pehle hi verify ho chuka hai.`);
    }

    record.status = "CLAIMED";
    const order = pendingOrders[userPhone] || { orderId: `AUTO_${Date.now()}`, amount: record.amount };

    await msg.reply(
        `✅ *Payment Successful!*\n` +
        `💰 Amount: ₹${record.amount}\n` +
        `🔢 UTR: ${utr}\n` +
        `🆔 Order ID: ${order.orderId}`
    );

    await sendTG(
        `🎉 *Payment Verified & Callback Sent!*\n` +
        `━━━━━━━━━━━━━━\n` +
        `👤 *User:* +${userPhone}\n` +
        `🆔 *Order ID:* \`${order.orderId}\`\n` +
        `💰 *Amount:* ₹${record.amount}\n` +
        `🔢 *UTR:* \`${utr}\``
    );

    if (config.callbackUrl) {
        try {
            await axios.post(config.callbackUrl, {
                status: "SUCCESS",
                orderId: order.orderId,
                userPhone: userPhone,
                amount: record.amount,
                utr: utr
            });
        } catch (e) {
            sendTG(`⚠️ *Callback Failed for Order ${order.orderId}:* ${e.message}`);
        }
    }
});

wa.initialize();
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
