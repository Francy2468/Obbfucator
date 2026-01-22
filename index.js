const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ===== CONFIG =====
const BOT_TOKEN = "MTQ2MzU3Njk1MzgzNDQzODcyMA.GZiov4.RWrmAHoBCgfmdIrWrKi_MKxfYdTp_xwr4RLNwU";

const PREFIX = ".obf";

const ALLOWED_GUILD_ID = "1442884507995869257";
const OBF_CHANNEL_ID = "1463543343647687001";
const LOG_CHANNEL_ID = "1455650314911879281";
const PING_CHANNEL_ID = "1463986741911359719";

const BOT_ID = "1463576953834438720";
const SAFE_USER_ID = "1361747820943642874";

const MAX_SIZE = 500 * 1024; // 500 KB
const DELETE_DELAY = 30 * 1000; // 30 seconds
const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes

// ===== QUEUE SYSTEM =====
const obfQueue = [];
let isProcessing = false;

// ===== CLIENT =====
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ===== SHINRA OBFUSCATOR =====
function generateObfuscation(source) {
    const genVar = (len = 6) => {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_';
        let result = '';
        for (let i = 0; i < len; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
        return result;
    };

    const vTable = genVar(8);
    const vKey = genVar(6);
    const vLoader = genVar(7);
    const vBit = genVar(3);

    let bytes = [];
    let key = Math.floor(Math.random() * 255);
    const initialKey = key;

    for (let i = 0; i < source.length; i++) {
        let charCode = source.charCodeAt(i);
        key = (key * 1664525 + 1013904223) % 256;
        let encrypted = (charCode ^ key);
        bytes.push(encrypted);
    }

    let junkCode = '';
    for (let i = 0; i < 15; i++) {
        if (Math.random() > 0.5) {
            junkCode += `local ${genVar()} = {}; `;
        } else {
            junkCode += `local function ${genVar()}(...) return bit32.bxor(..., ${Math.floor(Math.random() * 999)}) end; `;
        }
    }

    const vmCode = `--[[
SHINRA v1.0.0
obfuscated with shinra
]]
local ${vBit} = bit32 or require('bit');
local ${vBit}_bxor = ${vBit}.bxor;
local string_char = string.char;
local table_insert = table.insert;
${junkCode}
local ${vTable} = {${bytes.join(', ')}};
local function ${vLoader}()
    local ${vKey} = ${initialKey};
    local decoded = {};
    for i = 1, #${vTable} do
        ${vKey} = (${vKey} * 1664525 + 1013904223) % 256;
        local val = ${vBit}_bxor(${vTable}[i], ${vKey});
        table_insert(decoded, string_char(val));
    end
    return table.concat(decoded);
end
local function Run()
    local step = 1;
    while true do
        if step == 1 then
            if not getgenv then step = 3 else step = 2 end
        elseif step == 2 then
            if hookfunction and islclosure(hookfunction) then end
            step = 3;
        elseif step == 3 then
            local code = ${vLoader}();
            if code and #code > 0 then
                local func, err = loadstring(code);
                if func then pcall(func); end
            end
            break;
        end
    end
end
if not pcall(Run) then end`;

    return vmCode;
}

// ===== DOWNLOAD HELPER =====
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on("finish", () => {
                file.close(resolve);
            });
        }).on("error", (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

// ===== READY EVENT (AUTO PING) =====
client.on("ready", async () => {
    console.log(`Bot logged in as ${client.user.tag}`);

    let pingChannel = null;

    try {
        pingChannel = await client.channels.fetch(PING_CHANNEL_ID);
        console.log("Ping channel loaded successfully");
    } catch (err) {
        console.error("Failed to fetch ping channel:", err);
    }

    // 🔁 FIRST PING IMMEDIATELY
    try {
        if (pingChannel) {
            await pingChannel.send("<@1463576953834438720>");
            console.log("First self-ping sent immediately");
        }
    } catch (err) {
        console.error("Error sending first self-ping:", err);
    }

    // ⏱️ EVERY 10 MINUTES
    setInterval(async () => {
        try {
            if (!pingChannel) {
                pingChannel = await client.channels.fetch(PING_CHANNEL_ID);
            }

            if (pingChannel) {
                await pingChannel.send("<@1463576953834438720>");
                console.log("Self-ping sent");
            }
        } catch (err) {
            console.error("Error sending self-ping:", err);
        }
    }, PING_INTERVAL);
});

// ===== MESSAGE HANDLER =====
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Only in allowed server
    if (message.guild?.id !== ALLOWED_GUILD_ID) return;

    // Only control messages in obf channel
    if (message.channel.id !== OBF_CHANNEL_ID) return;

    // Only allow .obf in this channel
    if (!message.content.startsWith(PREFIX) && message.attachments.size === 0) {

        // Do not delete messages from safe user
        if (message.author.id !== SAFE_USER_ID) {
            if (message.deletable) {
                message.delete().catch(() => {});
            }
        }

        return;
    }

    // Push to queue
    obfQueue.push(message);
    console.log(`Job added. Queue size: ${obfQueue.length}`);

    processQueue();
});

// ===== QUEUE PROCESSOR =====
async function processQueue() {
    if (isProcessing) return;
    if (obfQueue.length === 0) return;

    isProcessing = true;

    const message = obfQueue.shift();

    try {
        let sourceCode = "";
        let originalFileName = "text_input.lua";

        // Attachment case
        if (message.attachments.size > 0) {
            const attachment = message.attachments.first();
            const ext = path.extname(attachment.name).toLowerCase();

            if (ext !== ".lua" && ext !== ".txt") {
                const warn = await message.reply("Only .lua or .txt files are allowed.");
                setTimeout(() => warn.delete().catch(() => {}), DELETE_DELAY);
                return finishJob();
            }

            if (attachment.size > MAX_SIZE) {
                const warn = await message.reply("File too large (max 500 KB).");
                setTimeout(() => warn.delete().catch(() => {}), DELETE_DELAY);
                return finishJob();
            }

            originalFileName = attachment.name;

            const tempFile = `input_${Date.now()}${ext}`;
            await downloadFile(attachment.url, tempFile);

            sourceCode = fs.readFileSync(tempFile, "utf8");
            fs.unlinkSync(tempFile);

        } else {
            // Text case
            sourceCode = message.content.slice(PREFIX.length).trim();

            if (!sourceCode) {
                const warn = await message.reply("Send code after .obf or attach a file.");
                setTimeout(() => warn.delete().catch(() => {}), DELETE_DELAY);
                return finishJob();
            }

            if (Buffer.byteLength(sourceCode, "utf8") > MAX_SIZE) {
                const warn = await message.reply("Text too large (max 500 KB).");
                setTimeout(() => warn.delete().catch(() => {}), DELETE_DELAY);
                return finishJob();
            }
        }

        // ===== OBFUSCATE =====
        const obfuscated = generateObfuscation(sourceCode);

        const obfFileName = `obfuscated_${Date.now()}.txt`;
        fs.writeFileSync(obfFileName, obfuscated, "utf8");

        const sent = await message.reply({
            content: " Obfuscation complete:",
            files: [obfFileName]
        });

        // Delete after 30s
        setTimeout(() => {
            message.delete().catch(() => {});
            sent.delete().catch(() => {});
        }, DELETE_DELAY);

        // ===== LOG EMBED =====
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);

        const embed = new EmbedBuilder()
            .setTitle("🔒 Obfuscation Log")
            .setColor(0x00ff99)
            .addFields(
                { name: "User", value: `${message.author.tag} (${message.author.id})` },
                { name: "Original File", value: originalFileName },
                { name: "Obfuscated File", value: obfFileName },
                { name: "Date", value: new Date().toLocaleString() }
            )
            .setTimestamp();

        if (logChannel) {
            await logChannel.send({ embeds: [embed] });
        }

        fs.unlinkSync(obfFileName);

    } catch (err) {
        console.error("Error processing job:", err);
    } finally {
        finishJob();
    }
}

function finishJob() {
    isProcessing = false;
    if (obfQueue.length > 0) {
        processQueue();
    }
}

// ===== LOGIN =====
client.login(BOT_TOKEN);
