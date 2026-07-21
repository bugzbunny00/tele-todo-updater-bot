/**
 * Telegram Task Bot — Cloudflare Workers + D1
 *
 * ===== Setup =====
 * To register the bot commands in the Telegram UI, visit:
 * https://<your-worker-url>/setup
 */

// ---------- small helpers ----------

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

const MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

function formatDateForDay(date) {
  const d = pad2(date.getUTCDate());
  const m = MONTHS[date.getUTCMonth()];
  const y = date.getUTCFullYear();
  return `${d} ${m} ${y}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function callTelegram(env, method, payload = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  const data = await res.json();
  if (!res.ok || !data.ok) {
    console.error(`Telegram API Error (${method}):`, data);
  }
  return data;
}

function sendMessage(env, chatId, text, extra = {}) {
  return callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

function editMessageText(env, chatId, messageId, text, extra = {}) {
  return callTelegram(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function tryPinMessage(env, chatId, messageId) {
  try {
    await callTelegram(env, "pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
  } catch (err) {
    console.warn("Failed to pin message. Bot may lack admin rights.");
  }
}

async function tryUnpinMessage(env, chatId, messageId) {
  if (!messageId) return;
  try {
    await callTelegram(env, "unpinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (err) {
    // non-fatal
  }
}

function displayName(from = {}) {
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || "someone";
}

function parseCommand(text) {
  const lines = text.split("\n");
  const firstLineMatch = lines[0].match(/^\/([a-zA-Z0-9_]+)(@\w+)?\s*(.*)$/);
  if (!firstLineMatch) return null;
  const command = firstLineMatch[1].toLowerCase();
  const inlineArgs = firstLineMatch[3] || "";
  const restLines = lines.slice(1).join("\n");
  const args = [inlineArgs, restLines].filter(Boolean).join("\n").trim();
  return { command, args };
}

const DONE_REGEX =
  /(?:task\s*|chapter\s*)?#?(\d+)\s*(?:is\s+|was\s+)?(?:done|complete|completed|finished)\b|\b(?:done|complete|completed|finished)\s*(?:task\s*|chapter\s*)?#?(\d+)/i;

function extractDoneItemNumber(text) {
  const match = text.match(DONE_REGEX);
  if (!match) return null;
  const num = match[1] || match[2];
  return num ? parseInt(num, 10) : null;
}

function parseKeyValueBlock(args) {
  const out = {};
  for (const line of args.split("\n")) {
    const m = line.match(/^\s*([A-Za-z ]+?)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    out[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

// ---------- Bot Setup & Commands Registration ----------

async function setupBotCommands(env) {
  const commands = [
    { command: "start", description: "Show help and bot info" },
    { command: "status", description: "Show current tasks or reading board" },
    { command: "addtask", description: "Add a single task" },
    { command: "addtasks", description: "Add multiple tasks at once" },
    { command: "newplan", description: "Create a new reading plan" },
    { command: "addreader", description: "Add a reader to the rotation" },
    { command: "removereader", description: "Remove a reader from rotation" },
    { command: "readers", description: "List the current reading rotation order" },
    { command: "setincrement", description: "Change chapters-per-reader-per-day" },
    { command: "nextday", description: "Advance to the next reading day" },
    { command: "endplan", description: "End the current reading plan" },
    { command: "header", description: "Set a custom header for the status board" },
    { command: "footer", description: "Set a custom footer for the status board" }
  ];

  return callTelegram(env, "setMyCommands", { commands });
}

// ---------- D1 helpers: chats / generic tasks ----------

async function ensureChat(env, chat) {
  await env.DB.prepare(
    `INSERT INTO chats (chat_id, chat_type, chat_title)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET chat_type = excluded.chat_type, chat_title = excluded.chat_title`
  )
    .bind(chat.id, chat.type, chat.title || chat.username || "")
    .run();
}

async function getChatRow(env, chatId) {
  return env.DB.prepare(`SELECT * FROM chats WHERE chat_id = ?`)
    .bind(chatId)
    .first();
}

async function addSingleTask(env, chatId, description, createdBy) {
  const chat = await getChatRow(env, chatId);
  const nextNumber = (chat?.task_counter || 0) + 1;

  await env.DB.batch([
    env.DB.prepare(`UPDATE chats SET task_counter = ? WHERE chat_id = ?`).bind(
      nextNumber,
      chatId
    ),
    env.DB.prepare(
      `INSERT INTO tasks (chat_id, task_number, description, created_by)
       VALUES (?, ?, ?, ?)`
    ).bind(chatId, nextNumber, description, createdBy),
  ]);

  return nextNumber;
}

async function isChatAdmin(env, chatId, userId, chatType) {
  if (chatType === "private") return true;
  try {
    const result = await callTelegram(env, "getChatMember", {
      chat_id: chatId,
      user_id: userId,
    });
    const status = result?.result?.status;
    return status === "administrator" || status === "creator";
  } catch (err) {
    return false;
  }
}

// ---------- D1 helpers: reading plan ----------

async function getActivePlan(env, chatId) {
  return env.DB.prepare(
    `SELECT * FROM reading_plans WHERE chat_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
  )
    .bind(chatId)
    .first();
}

async function getReaders(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM readers WHERE chat_id = ? ORDER BY position ASC`
  )
    .bind(chatId)
    .all();
  return results || [];
}

async function insertReaderAtPosition(env, chatId, name, position) {
  const readers = await getReaders(env, chatId);
  const targetIndex = position && position >= 1 ? Math.min(position - 1, readers.length) : readers.length;

  const shifts = [];
  for (let i = readers.length - 1; i >= targetIndex; i--) {
    shifts.push(
      env.DB.prepare(`UPDATE readers SET position = ? WHERE id = ?`).bind(i + 1, readers[i].id)
    );
  }
  if (shifts.length) await env.DB.batch(shifts);

  await env.DB.prepare(`INSERT INTO readers (chat_id, name, position) VALUES (?, ?, ?)`)
    .bind(chatId, name, targetIndex)
    .run();

  return targetIndex + 1;
}

async function compactReaderPositions(env, chatId) {
  const readers = await getReaders(env, chatId);
  const updates = readers
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => r.position !== i)
    .map(({ r, i }) => env.DB.prepare(`UPDATE readers SET position = ? WHERE id = ?`).bind(i, r.id));
  if (updates.length) await env.DB.batch(updates);
}

async function moveReaderPosition(env, chatId, name, newPosition) {
  const readers = await getReaders(env, chatId);
  const idx = readers.findIndex((r) => r.name === name);
  if (idx === -1) return null;

  const [reader] = readers.splice(idx, 1);
  const targetIndex = Math.max(0, Math.min(newPosition - 1, readers.length));
  readers.splice(targetIndex, 0, reader);

  const updates = readers.map((r, i) =>
    env.DB.prepare(`UPDATE readers SET position = ? WHERE id = ?`).bind(i, r.id)
  );
  await env.DB.batch(updates);
  return targetIndex + 1;
}

async function getLatestDay(env, planId) {
  return env.DB.prepare(
    `SELECT * FROM reading_days WHERE plan_id = ? ORDER BY day_number DESC LIMIT 1`
  )
    .bind(planId)
    .first();
}

async function getDayItems(env, dayId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM reading_items WHERE day_id = ? ORDER BY item_number ASC`
  )
    .bind(dayId)
    .all();
  return results || [];
}

function formatDayMessage(plan, day, items) {
  const doneCount = items.filter((i) => i.status === "done").length;
  const lines = [];
  lines.push(`📚 <b>${escapeHtml(plan.title)}</b>`, "");
  lines.push(`Day ${pad2(day.day_number)} - ${day.day_date}`, "");
  for (const item of items) {
    const emoji = item.status === "done" ? "✅" : "🔳";
    lines.push(
      `${pad2(item.item_number)}. ${emoji} Chapter ${pad2(item.chapter_number)}-${escapeHtml(
        item.reader_name
      )}`
    );
  }
  lines.push("");
  lines.push(`${doneCount} Out of ${items.length} Completed.`);
  if (plan.footer) {
    lines.push("");
    lines.push(escapeHtml(plan.footer));
  }
  return lines.join("\n");
}

async function advanceDay(env, chatId, plan) {
  const readers = await getReaders(env, chatId);
  if (readers.length === 0) {
    return { error: "No readers yet. Add some with /addreader <name> first." };
  }

  const nextDayNumber = plan.current_day + 1;
  if (nextDayNumber > plan.total_days) {
    await env.DB.prepare(`UPDATE reading_plans SET status = 'finished' WHERE id = ?`)
      .bind(plan.id)
      .run();
    return { error: `🎉 "${plan.title}" is already complete — all ${plan.total_days} days done!` };
  }

  const prevDay = await getLatestDay(env, plan.id);
  if (prevDay?.message_id) {
    await tryUnpinMessage(env, chatId, prevDay.message_id);
  }

  let chapterPointer = plan.last_chapter;
  const items = [];
  let itemNumber = 1;
  for (const reader of readers) {
    for (let i = 0; i < plan.increment; i++) {
      chapterPointer += 1;
      const chapterNumber = ((chapterPointer - 1) % plan.total_chapters) + 1;
      items.push({
        item_number: itemNumber++,
        chapter_number: chapterNumber,
        reader_name: reader.name,
      });
    }
  }

  const dayDate = formatDateForDay(new Date());

  const dayInsert = await env.DB.prepare(
    `INSERT INTO reading_days (chat_id, plan_id, day_number, day_date) VALUES (?, ?, ?, ?)`
  )
    .bind(chatId, plan.id, nextDayNumber, dayDate)
    .run();
  const dayId = dayInsert.meta.last_row_id;

  const inserts = items.map((item) =>
    env.DB.prepare(
      `INSERT INTO reading_items (day_id, item_number, chapter_number, reader_name) VALUES (?, ?, ?, ?)`
    ).bind(dayId, item.item_number, item.chapter_number, item.reader_name)
  );
  await env.DB.batch(inserts);

  await env.DB.prepare(
    `UPDATE reading_plans SET current_day = ?, last_chapter = ? WHERE id = ?`
  )
    .bind(nextDayNumber, chapterPointer, plan.id)
    .run();

  const dayRow = { id: dayId, day_number: nextDayNumber, day_date: dayDate };
  const text = formatDayMessage(plan, dayRow, items);
  const sent = await sendMessage(env, chatId, text);
  const messageId = sent?.result?.message_id;

  if (messageId) {
    await env.DB.prepare(`UPDATE reading_days SET message_id = ? WHERE id = ?`)
      .bind(messageId, dayId)
      .run();
    await tryPinMessage(env, chatId, messageId);
  }

  return { dayId, dayNumber: nextDayNumber };
}

async function advanceAllActivePlans(env) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT chat_id FROM reading_plans WHERE status = 'active'`
  ).all();
  for (const row of results || []) {
    try {
      const plan = await getActivePlan(env, row.chat_id);
      if (!plan) continue;
      await advanceDay(env, row.chat_id, plan);
    } catch (err) {
      console.error("advanceAllActivePlans error for chat", row.chat_id, err);
    }
  }
}

// ---------- command handlers ----------

async function handleStart(env, chatId) {
  const text = `👋 <b>Task &amp; Reading Bot</b>

<b>Simple tasks</b>
/addtask <i>text</i> — add one task
/addtasks — add many tasks (one per line)
/header <i>text</i> / /footer <i>text</i> — customize /status

<b>Reading plan</b>
/newplan — set up a rotating reading roster
/addreader <i>name</i> [position] — add someone to the rotation
/setposition <i>name position</i> — move an existing reader
/readers — show rotation order
/setincrement <i>n</i> — chapters per reader per day
/nextday — start Day 1 or force the next day
/endplan — finish the plan early

<b>Shared</b>
/status — show the current board

To mark something done, just send a message like:
<code>task 1 done</code> or <code>chapter 3 done</code>`;
  await sendMessage(env, chatId, text);
}

async function handleAddTask(env, chatId, args, createdBy) {
  const description = args.trim();
  if (!description) {
    await sendMessage(env, chatId, "Usage: <code>/addtask Buy groceries</code>");
    return;
  }
  const number = await addSingleTask(env, chatId, description, createdBy);
  await sendMessage(env, chatId, `✅ Task #${number} added: ${escapeHtml(description)}`);
}

async function handleAddTasks(env, chatId, args, createdBy) {
  let items = args.split("\n").map((s) => s.trim()).filter(Boolean);
  if (items.length === 1 && items[0].includes(",")) {
    items = items[0].split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (items.length === 0) {
    await sendMessage(
      env,
      chatId,
      "Usage:\n<code>/addtasks\nBuy milk\nCall John\nFinish report</code>"
    );
    return;
  }
  const numbers = [];
  for (const item of items) {
    const number = await addSingleTask(env, chatId, item, createdBy);
    numbers.push(`#${number} ${escapeHtml(item)}`);
  }
  await sendMessage(env, chatId, `✅ Added ${items.length} task(s):\n` + numbers.join("\n"));
}

async function handleHeaderFooter(env, chatId, field, args) {
  if (!args.trim()) {
    const chat = await getChatRow(env, chatId);
    const current = chat?.[field] || "(not set)";
    await sendMessage(env, chatId, `Current ${field}: ${escapeHtml(current)}`);
    return;
  }
  await env.DB.prepare(`UPDATE chats SET ${field} = ? WHERE chat_id = ?`)
    .bind(args.trim(), chatId)
    .run();
  await sendMessage(env, chatId, `✅ ${field} updated.`);
}

async function handleGenericStatus(env, chatId) {
  const chat = await getChatRow(env, chatId);
  const { results: tasks } = await env.DB.prepare(
    `SELECT * FROM tasks WHERE chat_id = ? ORDER BY task_number ASC`
  )
    .bind(chatId)
    .all();

  if (!tasks || tasks.length === 0) {
    await sendMessage(env, chatId, "No tasks yet. Add one with /addtask.");
    return;
  }

  const pending = tasks.filter((t) => t.status === "pending");
  const done = tasks.filter((t) => t.status === "done");

  const lines = [];
  if (chat?.header) lines.push(escapeHtml(chat.header), "");
  lines.push(`📋 <b>Task Status</b> (${done.length}/${tasks.length} done)`, "");

  if (pending.length) {
    lines.push("⏳ <b>Pending</b>");
    for (const t of pending) lines.push(`${t.task_number}. ${escapeHtml(t.description)}`);
    lines.push("");
  }
  if (done.length) {
    lines.push("✅ <b>Done</b>");
    for (const t of done) lines.push(`${t.task_number}. ${escapeHtml(t.description)}`);
    lines.push("");
  }
  if (chat?.footer) lines.push(escapeHtml(chat.footer));

  await sendMessage(env, chatId, lines.join("\n").trim());
}

async function handleMarkTaskDone(env, chatId, taskNumber, doneBy) {
  const task = await env.DB.prepare(
    `SELECT * FROM tasks WHERE chat_id = ? AND task_number = ?`
  )
    .bind(chatId, taskNumber)
    .first();

  if (!task) {
    await sendMessage(env, chatId, `⚠️ No task #${taskNumber} found here.`);
    return;
  }
  if (task.status === "done") {
    await sendMessage(env, chatId, `Task #${taskNumber} was already marked done.`);
    return;
  }
  await env.DB.prepare(
    `UPDATE tasks SET status = 'done', done_by = ?, done_at = CURRENT_TIMESTAMP
     WHERE chat_id = ? AND task_number = ?`
  )
    .bind(doneBy, chatId, taskNumber)
    .run();
  await sendMessage(
    env,
    chatId,
    `✅ Task #${taskNumber} (${escapeHtml(task.description)}) marked done by ${escapeHtml(doneBy)}.`
  );
}

async function handleNewPlan(env, chatId, args) {
  const fields = parseKeyValueBlock(args);
  const title = fields.title;
  const totalDays = parseInt(fields.days, 10);
  const totalChapters = parseInt(fields.chapters, 10);
  const increment = fields.increment ? parseInt(fields.increment, 10) : 1;

  if (!title || !totalDays || !totalChapters || !increment) {
    await sendMessage(
      env,
      chatId,
      `Usage:\n<code>/newplan\nTitle: 40 Days Book Reading\nDays: 40\nChapters: 40\nIncrement: 2</code>`
    );
    return;
  }

  await env.DB.prepare(
    `UPDATE reading_plans SET status = 'archived' WHERE chat_id = ? AND status = 'active'`
  )
    .bind(chatId)
    .run();

  await env.DB.prepare(
    `INSERT INTO reading_plans (chat_id, title, total_days, total_chapters, increment)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(chatId, title, totalDays, totalChapters, increment)
    .run();

  await sendMessage(
    env,
    chatId,
    `✅ Plan created: <b>${escapeHtml(title)}</b> — ${totalDays} days, ${totalChapters} chapters, ${increment}/reader/day.\nAdd readers with /addreader, then run /nextday to start Day 1.`
  );
}

async function handleAddReader(env, chatId, args) {
  const trimmed = args.trim();
  if (!trimmed) {
    await sendMessage(
      env,
      chatId,
      "Usage: <code>/addreader @username</code> or <code>/addreader @username 2</code> to insert at position 2"
    );
    return;
  }

  const parts = trimmed.split(/\s+/);
  let name = trimmed;
  let position = null;
  if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
    position = parseInt(parts[parts.length - 1], 10);
    name = parts.slice(0, -1).join(" ");
  }

  const finalPosition = await insertReaderAtPosition(env, chatId, name, position);
  await sendMessage(
    env,
    chatId,
    `✅ Added reader: ${escapeHtml(name)} at position ${finalPosition}`
  );
}

async function handleRemoveReader(env, chatId, args) {
  const name = args.trim();
  if (!name) {
    await sendMessage(env, chatId, "Usage: <code>/removereader @username</code>");
    return;
  }
  const result = await env.DB.prepare(`DELETE FROM readers WHERE chat_id = ? AND name = ?`)
    .bind(chatId, name)
    .run();
  if (result.meta.changes > 0) {
    await compactReaderPositions(env, chatId);
    await sendMessage(env, chatId, `✅ Removed reader: ${escapeHtml(name)}`);
  } else {
    await sendMessage(env, chatId, `⚠️ No reader named "${escapeHtml(name)}" found.`);
  }
}

async function handleSetPosition(env, chatId, args) {
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/);
  const position = parseInt(parts[parts.length - 1], 10);
  const name = parts.slice(0, -1).join(" ");

  if (!name || !position || position < 1) {
    await sendMessage(env, chatId, "Usage: <code>/setposition Linda 2</code>");
    return;
  }

  const finalPosition = await moveReaderPosition(env, chatId, name, position);
  if (finalPosition === null) {
    await sendMessage(env, chatId, `⚠️ No reader named "${escapeHtml(name)}" found.`);
    return;
  }
  await sendMessage(env, chatId, `✅ Moved ${escapeHtml(name)} to position ${finalPosition}`);
}

async function handleListReaders(env, chatId) {
  const readers = await getReaders(env, chatId);
  if (readers.length === 0) {
    await sendMessage(env, chatId, "No readers yet. Add one with /addreader <name>.");
    return;
  }
  const lines = readers.map((r, i) => `${i + 1}. ${escapeHtml(r.name)}`);
  await sendMessage(env, chatId, `👥 <b>Readers</b>\n` + lines.join("\n"));
}

async function handleSetIncrement(env, chatId, args) {
  const n = parseInt(args.trim(), 10);
  if (!n || n < 1) {
    await sendMessage(env, chatId, "Usage: <code>/setincrement 2</code>");
    return;
  }
  const plan = await getActivePlan(env, chatId);
  if (!plan) {
    await sendMessage(env, chatId, "No active plan. Create one with /newplan first.");
    return;
  }
  await env.DB.prepare(`UPDATE reading_plans SET increment = ? WHERE id = ?`)
    .bind(n, plan.id)
    .run();
  await sendMessage(env, chatId, `✅ Increment set to ${n} chapters/reader/day (applies from the next day).`);
}

async function handleNextDay(env, chatId) {
  const plan = await getActivePlan(env, chatId);
  if (!plan) {
    await sendMessage(env, chatId, "No active plan. Create one with /newplan first.");
    return;
  }
  const result = await advanceDay(env, chatId, plan);
  if (result?.error) {
    await sendMessage(env, chatId, result.error);
  }
}

async function handleEndPlan(env, chatId) {
  const plan = await getActivePlan(env, chatId);
  if (!plan) {
    await sendMessage(env, chatId, "No active plan to end.");
    return;
  }
  await env.DB.prepare(`UPDATE reading_plans SET status = 'finished' WHERE id = ?`)
    .bind(plan.id)
    .run();
  await sendMessage(env, chatId, `🏁 "${escapeHtml(plan.title)}" ended at Day ${plan.current_day}/${plan.total_days}.`);
}

async function handleReadingStatus(env, chatId, plan) {
  const day = await getLatestDay(env, plan.id);
  if (!day) {
    await sendMessage(env, chatId, `Plan "${escapeHtml(plan.title)}" hasn't started yet. Run /nextday to begin.`);
    return;
  }
  const items = await getDayItems(env, day.id);
  const text = formatDayMessage(plan, day, items);
  await sendMessage(env, chatId, text);
}

async function handleMarkReadingDone(env, chatId, plan, itemNumber, doneBy) {
  const day = await getLatestDay(env, plan.id);
  if (!day) {
    await sendMessage(env, chatId, "The plan hasn't started yet — run /nextday first.");
    return;
  }
  const item = await env.DB.prepare(
    `SELECT * FROM reading_items WHERE day_id = ? AND item_number = ?`
  )
    .bind(day.id, itemNumber)
    .first();

  if (!item) {
    await sendMessage(env, chatId, `⚠️ No item #${itemNumber} in today's list.`);
    return;
  }
  if (item.status !== "done") {
    await env.DB.prepare(
      `UPDATE reading_items SET status = 'done', done_by = ?, done_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
      .bind(doneBy, item.id)
      .run();
  }

  const items = await getDayItems(env, day.id);
  const text = formatDayMessage(plan, day, items);
  if (day.message_id) {
    await editMessageText(env, chatId, day.message_id, text);
  } else {
    const sent = await sendMessage(env, chatId, text);
    const messageId = sent?.result?.message_id;
    if (messageId) {
      await env.DB.prepare(`UPDATE reading_days SET message_id = ? WHERE id = ?`)
        .bind(messageId, day.id)
        .run();
    }
  }
}

// ---------- update dispatch ----------

const WRITE_COMMANDS = new Set([
  "addtask", "addtasks", "header", "footer",
  "newplan", "addreader", "removereader", "setposition", "setincrement", "nextday", "endplan",
]);

async function handleUpdate(env, update) {
  const message = update.message;
  if (!message || !message.text) return;

  const chat = message.chat;
  const chatId = chat.id;
  const from = message.from || {};
  const who = displayName(from);
  const text = message.text.trim();

  await ensureChat(env, chat);

  const parsed = text.startsWith("/") ? parseCommand(text) : null;

  if (parsed) {
    const { command, args } = parsed;

    if (
      env.ADMIN_ONLY === "true" &&
      WRITE_COMMANDS.has(command) &&
      !(await isChatAdmin(env, chatId, from.id, chat.type))
    ) {
      await sendMessage(env, chatId, "🚫 Only group admins can do that.");
      return;
    }

    switch (command) {
      case "start": return handleStart(env, chatId);
      case "addtask": return handleAddTask(env, chatId, args, who);
      case "addtasks": return handleAddTasks(env, chatId, args, who);
      case "header": return handleHeaderFooter(env, chatId, "header", args);
      case "footer": return handleHeaderFooter(env, chatId, "footer", args);
      case "newplan": return handleNewPlan(env, chatId, args);
      case "addreader": return handleAddReader(env, chatId, args);
      case "removereader": return handleRemoveReader(env, chatId, args);
      case "setposition": return handleSetPosition(env, chatId, args);
      case "readers": return handleListReaders(env, chatId);
      case "setincrement": return handleSetIncrement(env, chatId, args);
      case "nextday": return handleNextDay(env, chatId);
      case "endplan": return handleEndPlan(env, chatId);
      case "status": {
        const plan = await getActivePlan(env, chatId);
        if (plan) return handleReadingStatus(env, chatId, plan);
        return handleGenericStatus(env, chatId);
      }
      default:
        return sendMessage(env, chatId, "Unknown command. Send /start to see what I can do.");
    }
  }

  const doneNumber = extractDoneItemNumber(text);
  if (doneNumber !== null) {
    const plan = await getActivePlan(env, chatId);
    if (plan) {
      return handleMarkReadingDone(env, chatId, plan, doneNumber, who);
    }
    return handleMarkTaskDone(env, chatId, doneNumber, who);
  }
}

// ---------- Worker entrypoint ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Endpoint for bot registration
    if (url.pathname === "/setup" && request.method === "GET") {
      try {
        const result = await setupBotCommands(env);
        return jsonResponse({ ok: true, message: "Commands registered successfully", telegram_response: result });
      } catch (error) {
        return jsonResponse({ ok: false, error: error.message }, 500);
      }
    }

    if (request.method === "GET") {
      return new Response("Telegram task bot is running. Visit /setup to register UI commands.", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let update;
    try {
      update = await request.json();
    } catch (err) {
      return jsonResponse({ ok: false, error: "bad json" }, 400);
    }

    ctx.waitUntil(
      handleUpdate(env, update).catch((err) => {
        console.error("handleUpdate error", err);
      })
    );

    return jsonResponse({ ok: true });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(advanceAllActivePlans(env));
  },
};