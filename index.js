
'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const N8N_WEBHOOK =
  process.env.N8N_WEBHOOK ||
  'http://localhost:5678/webhook/auto-reply';

const TARGET_CONTACT = normalizePhone(
  process.env.TARGET_CONTACT || '917991234682'
);

const HISTORY_LIMIT = 30;
const WEBHOOK_TIMEOUT_MS = 15000;

// ============================================================
// HELPERS
// ============================================================

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function logSection(title, details) {
  console.log(`\n${'='.repeat(12)} ${title} ${'='.repeat(12)}`);

  if (details !== undefined) {
    console.log(details);
  }
}

// ============================================================
// WHATSAPP CLIENT
// ============================================================

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'main'
  }),

  takeoverOnConflict: true,
  takeoverTimeoutMs: 10000,
  restartOnAuthFail: true
});

// ============================================================
// EXPRESS API
// n8n uses this endpoint to send WhatsApp replies.
// ============================================================

const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/', async (_req, res) => {
  let state = 'UNKNOWN';

  try {
    state = await client.getState();
  } catch {
    // Client may not be ready yet.
  }

  res.json({
    success: true,
    state,
    historyLimit: HISTORY_LIMIT,
    targetConfigured: Boolean(TARGET_CONTACT)
  });
});

app.post('/send-message', async (req, res) => {
  const chatId = String(req.body?.chatId || '').trim();
  const message = String(req.body?.message || '').trim();

  if (!chatId || !message) {
    return res.status(400).json({
      success: false,
      error: 'chatId and message are required'
    });
  }

  try {
    const state = await client.getState();

    if (state !== 'CONNECTED') {
      return res.status(503).json({
        success: false,
        error: `WhatsApp is not connected. State: ${state}`
      });
    }

    await client.sendMessage(chatId, message);

    logSection('MESSAGE SENT SUCCESSFULLY', {
      chatId,
      message
    });

    return res.json({
      success: true,
      chatId
    });
  } catch (err) {
    console.error(
      'SEND MESSAGE ERROR:',
      err?.stack || err
    );

    return res.status(500).json({
      success: false,
      error: err?.message || 'Failed to send message'
    });
  }
});

const server = app.listen(PORT, () => {
  logSection('EXPRESS SERVER STARTED', `Port: ${PORT}`);
});

// ============================================================
// WHATSAPP EVENTS
// ============================================================

client.on('qr', (qr) => {
  logSection('SCAN QR CODE');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  logSection('AUTHENTICATED');
});

client.on('auth_failure', (message) => {
  console.error('WHATSAPP AUTH FAILURE:', message);
});

client.on('loading_screen', (percent, message) => {
  console.log(
    `WhatsApp loading: ${percent}% ${message || ''}`
  );
});

client.on('change_state', (state) => {
  console.log('WhatsApp state:', state);
});

client.on('ready', async () => {
  logSection('WHATSAPP READY');

  try {
    console.log('State:', await client.getState());

    console.log(
      'Account:',
      client.info?.wid?._serialized || 'available'
    );
  } catch (err) {
    console.error(
      'Could not read WhatsApp client info:',
      err.message
    );
  }
});

client.on('disconnected', (reason) => {
  console.error('WHATSAPP DISCONNECTED:', reason);
});

// ============================================================
// RESOLVE SENDER PHONE NUMBER
// WhatsApp may provide a LID instead of a phone number.
// ============================================================

async function resolveSenderNumber(msg, contact) {
  const contactNumber = normalizePhone(
    contact?.id?.user
  );

  if (contactNumber) {
    return contactNumber;
  }

  const senderId = String(msg.from || '');

  if (!senderId.endsWith('@lid')) {
    return normalizePhone(senderId.split('@')[0]);
  }

  try {
    const mappings = await client.getContactLidAndPhone([
      senderId
    ]);

    const mapping = Array.isArray(mappings)
      ? mappings.find((item) => item.lid === senderId)
      : null;

    return normalizePhone(mapping?.pn);
  } catch (err) {
    console.warn(
      'Could not resolve sender LID:',
      err.message
    );

    return '';
  }
}
// ============================================================
// LOCAL HISTORY BUFFER
// Fallback for when chat.fetchMessages() is broken.
// ============================================================

const chatBuffers = new Map(); // chatId -> [{ id, fromMe, body, timestamp }]

function rememberMessage(msg) {
  if (typeof msg.body !== 'string' || !msg.body.trim()) return;

  const chatId = msg.fromMe ? msg.to : msg.from;
  if (!chatId || chatId === 'status@broadcast') return;

  const id = msg.id?._serialized;
  const buf = chatBuffers.get(chatId) || [];

  if (id && buf.some((m) => m.id === id)) return;

  buf.push({
    id,
    fromMe: Boolean(msg.fromMe),
    body: msg.body.trim(),
    timestamp: msg.timestamp || Math.floor(Date.now() / 1000)
  });

  chatBuffers.set(chatId, buf.slice(-HISTORY_LIMIT));
}

client.on('message_create', rememberMessage);
// ============================================================
// GET LAST 30 MESSAGES
// Includes incoming and outgoing messages.
// ============================================================

async function getRecentHistory(msg, chat) {
  let fetched = [];

  if (chat) {
    try {
      fetched = await chat.fetchMessages({ limit: HISTORY_LIMIT });
    } catch (err) {
      console.warn('Could not fetch chat history:', err.message);
    }
  }

  let history = fetched
    .filter((m) => typeof m.body === 'string' && m.body.trim())
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .map((m) => ({ fromMe: Boolean(m.fromMe), body: m.body.trim() }));

  // Fallback: use messages remembered locally
  if (history.length < 2) {
    const buf = chatBuffers.get(msg.from) || [];
    history = buf.map(({ fromMe, body }) => ({ fromMe, body }));
    console.log(`Using local buffer: ${history.length} message(s)`);
  }

  // Make sure the current message is last
  const current = String(msg.body || '').trim();
  const last = history[history.length - 1];
  if (!last || last.fromMe || last.body !== current) {
    history.push({ fromMe: false, body: current });
  }

  return history.slice(-HISTORY_LIMIT);
}
// ============================================================
// INCOMING MESSAGE QUEUE
// ============================================================

let messageQueue = Promise.resolve();

client.on('message', (msg) => {
  messageQueue = messageQueue
    .then(() => handleIncomingMessage(msg))
    .catch((err) => {
      console.error(
        'MESSAGE HANDLER ERROR:',
        err?.stack || err
      );
    });
});

// ============================================================
// PROCESS INCOMING MESSAGE
// ============================================================

async function handleIncomingMessage(msg) {
  logSection('MESSAGE RECEIVED', {
    from: msg.from,
    body: msg.body,
    fromMe: msg.fromMe
  });

  // Ignore outgoing messages and status broadcasts.
  if (msg.fromMe) return;

  if (
    !msg.from ||
    msg.from === 'status@broadcast'
  ) {
    return;
  }

  // This bot processes text messages only.
  if (
    typeof msg.body !== 'string' ||
    !msg.body.trim()
  ) {
    console.log('Skipping message without text.');
    return;
  }

  let chat = null;
  let contact = null;

  // First attempt: use the incoming message's chat.
  try {
    chat = await msg.getChat();
    contact = await chat.getContact();
  } catch (err) {
    console.warn(
      'Could not load chat/contact directly:',
      err.message
    );
  }

  // Second attempt: look up the chat using the sender ID.
  if (!chat) {
    try {
      chat = await client.getChatById(msg.from);

      if (chat) {
        try {
          contact = await chat.getContact();
        } catch {
          // Continue even if contact details are unavailable.
        }
      }
    } catch (err) {
      console.warn(
        'Chat lookup by sender ID failed:',
        err.message
      );
    }
  }

  // Verify that the sender is the intended contact.
  const senderNumber = await resolveSenderNumber(
    msg,
    contact
  );

  if (
    !senderNumber ||
    senderNumber !== TARGET_CONTACT
  ) {
    console.log(
      'Skipping non-target or unidentified sender:',
      msg.from,
      senderNumber || '(unresolved)'
    );

    return;
  }

  console.log(
    'Target contact verified:',
    senderNumber
  );

  // If the LID chat was unavailable, try its mapped phone ID.
  if (!chat && msg.from.endsWith('@lid')) {
    try {
      const mappings =
        await client.getContactLidAndPhone([msg.from]);

      const mapping = Array.isArray(mappings)
        ? mappings.find(
            (item) => item.lid === msg.from
          )
        : null;

      if (mapping?.pn) {
        chat = await client.getChatById(mapping.pn);

        console.log(
          'Tried mapped phone chat:',
          mapping.pn
        );
      }
    } catch (err) {
      console.warn(
        'Phone-number chat lookup failed:',
        err.message
      );
    }
  }

  // Fetch recent history for this conversation.
  const history = await getRecentHistory(msg, chat);

  console.log(
    `History prepared: ${history.length} message(s)`
  );

  if (history.length === 1) {
    console.warn(
      'Only one message is available. Check whether WhatsApp chat history can be loaded.'
    );
  }

  // Prepare data for the n8n Webhook.
  const payload = {
    type: 'auto_reply',
    chatId: msg.from,
    name:
      contact?.pushname ||
      contact?.name ||
      'Unknown',
    history
  };

  try {
    const response = await axios.post(
      N8N_WEBHOOK,
      payload,
      {
        timeout: WEBHOOK_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json'
        },
        maxBodyLength: 2 * 1024 * 1024
      }
    );

    console.log(
      'History sent to n8n. HTTP status:',
      response.status
    );
  } catch (err) {
    console.error(
      'Failed to send message to n8n:',
      err.response?.status || '',
      err.response?.data || err.message
    );
  }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(
    `\n${signal} received. Shutting down...`
  );

  server.close();

  try {
    await client.destroy();
  } catch (err) {
    console.warn(
      'Error while closing WhatsApp client:',
      err.message
    );
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error(
    'UNHANDLED REJECTION:',
    reason
  );
});

process.on('uncaughtException', (err) => {
  console.error(
    'UNCAUGHT EXCEPTION:',
    err?.stack || err
  );

  process.exit(1);
});

// ============================================================
// START
// ============================================================

logSection('STARTING WHATSAPP CLIENT');

client.initialize().catch((err) => {
  console.error(
    'WhatsApp initialization failed:',
    err?.stack || err
  );
});
