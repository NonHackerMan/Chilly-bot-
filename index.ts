import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Client,
  GatewayIntentBits,
  Collection,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Interaction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  Partials,
  ChannelType,
  TextChannel,
  CategoryChannel,
} from 'discord.js';
import crypto from 'crypto';
import Database from 'better-sqlite3';

type Command = {
  data: any;
  cooldown?: number;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const AUTH = (process.env.AUTH || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!TOKEN || !CLIENT_ID) process.exit(1);
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'bot.db');
const db = new Database(dbPath);
db.exec('CREATE TABLE IF NOT EXISTS snapshots(guild_id TEXT PRIMARY KEY, data TEXT, saved_at INTEGER)');

type Reminder = {
  id: string;
  userId: string;
  channelId: string;
  guildId?: string | null;
  message: string;
  dueAt: number;
  delivered?: boolean;
};

type SavedChannel = {
  id: string;
  name: string;
  type: number;
  parentId?: string | null;
  position?: number;
  topic?: string | null;
  nsfw?: boolean;
  messages: SavedMessage[];
};

type SavedMessage = {
  authorId: string;
  content: string;
  attachments: string[];
  embeds: any[];
  createdAt: number;
};

function loadReminders(): Reminder[] {
  const p = path.join(DATA_DIR, 'reminders.json');
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Reminder[];
  } catch {
    return [];
  }
}
function saveReminders(rems: Reminder[]) {
  fs.writeFileSync(path.join(DATA_DIR, 'reminders.json'), JSON.stringify(rems, null, 2), 'utf8');
}

const reminders = new Collection<string, Reminder>();
for (const r of loadReminders()) {
  if (!r.delivered && r.dueAt > Date.now()) reminders.set(r.id, r);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const commands = new Collection<string, Command>();
function newCid() {
  return crypto.randomUUID();
}
function parseDuration(input: string): number | null {
  const match = input.trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2] || 's';
  switch (unit) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 60 * 60_000;
    case 'd':
      return n * 24 * 60 * 60_000;
    default:
      return null;
  }
}
function msToReadable(ms: number) {
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / (24 * 3600000));
  return `${d}d ${h}h ${m}m ${s}s`;
}
function readableDuration(ms: number) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 24 * 3600_000) return `${Math.round(ms / 3600_000)}h`;
  return `${Math.round(ms / (24 * 3600_000))}d`;
}
const cooldowns = new Map<string, number>();
function isAuthorized(interaction: ChatInputCommandInteraction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) || AUTH.includes(interaction.user.id);
}

commands.set('ping', {
  data: new SlashCommandBuilder().setName('ping').setDescription('Shows bot latency and uptime.'),
  cooldown: 5,
  execute: async (interaction) => {
    const cid = newCid();
    const start = Date.now();
    await interaction.reply({ content: `Pinging... (cid: ${cid})`, ephemeral: true });
    const latency = Date.now() - start;
    const embed = new EmbedBuilder()
      .setTitle('Pong! 🏓')
      .addFields(
        { name: 'Roundtrip', value: `${latency}ms`, inline: true },
        { name: 'API Latency', value: `${Math.round(client.ws.ping)}ms`, inline: true },
        { name: 'Uptime', value: msToReadable(process.uptime() * 1000), inline: false }
      )
      .setFooter({ text: `cid: ${cid}` })
      .setTimestamp();
    await interaction.editReply({ content: '', embeds: [embed] });
  },
});

commands.set('help', {
  data: new SlashCommandBuilder().setName('help').setDescription('Shows available commands and usage.'),
  cooldown: 3,
  execute: async (interaction) => {
    const embed = new EmbedBuilder().setTitle('Commands').setDescription('Available commands:').setTimestamp();
    for (const [name, cmd] of commands.entries()) embed.addFields({ name, value: cmd.data.description ?? 'No description', inline: false });
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
});

commands.set('remind', {
  data: (new SlashCommandBuilder().setName('remind').setDescription('Set a reminder').addStringOption((o) => o.setName('in').setDescription('Duration (e.g. 10m)').setRequired(true)).addStringOption((o) => o.setName('text').setDescription('Reminder message').setRequired(true))) as any,
  cooldown: 5,
  execute: async (interaction) => {
    const cid = newCid();
    const inStr = interaction.options.getString('in', true);
    const text = interaction.options.getString('text', true);
    const ms = parseDuration(inStr);
    if (!ms || ms <= 0) {
      await interaction.reply({ content: `Invalid duration: "${inStr}". Use formats like 10s, 5m, 2h, 1d. (cid: ${cid})`, ephemeral: true });
      return;
    }
    const id = crypto.randomUUID();
    const rem: Reminder = {
      id,
      userId: interaction.user.id,
      channelId: interaction.channelId ?? interaction.user.id,
      guildId: interaction.guildId ?? null,
      message: text,
      dueAt: Date.now() + ms,
    };
    reminders.set(id, rem);
    saveReminders([...reminders.values()]);
    await interaction.reply({ content: `Got it — I'll remind you in ${readableDuration(ms)}. (cid: ${cid})`, ephemeral: true });
  },
});

commands.set('poll', {
  data: (new SlashCommandBuilder().setName('poll').setDescription('Create a quick poll').addStringOption((o) => o.setName('question').setDescription('Poll question').setRequired(true)).addStringOption((o) => o.setName('options').setDescription('Options separated by | (max 5)').setRequired(true)).addIntegerOption((o) => o.setName('duration').setDescription('Duration in seconds (default 60)'))) as any,
  cooldown: 10,
  execute: async (interaction) => {
    const cid = newCid();
    const question = interaction.options.getString('question', true);
    const optsRaw = interaction.options.getString('options', true);
    const duration = interaction.options.getInteger('duration') ?? 60;
    const opts = optsRaw.split('|').map((s) => s.trim()).filter(Boolean).slice(0, 5);
    if (opts.length < 2) {
      await interaction.reply({ content: 'Provide at least two options separated by |', ephemeral: true });
      return;
    }
    const buttons = new ActionRowBuilder<ButtonBuilder>();
    const votes = new Map<string, number>();
    const customIds: string[] = [];
    for (let i = 0; i < opts.length; i++) {
      const id = `poll_${crypto.randomUUID()}`;
      customIds.push(id);
      votes.set(id, 0);
      const b = new ButtonBuilder().setCustomId(id).setLabel(opts[i]).setStyle(ButtonStyle.Primary);
      buttons.addComponents(b);
    }
    const embed = new EmbedBuilder().setTitle('Poll').setDescription(question).addFields({ name: 'Options', value: opts.map((o, i) => `${i + 1}. ${o}`).join('\n') }).setFooter({ text: `Poll duration: ${duration}s • cid: ${cid}` }).setTimestamp();
    await interaction.reply({ embeds: [embed], components: [buttons] });
    const msg = await interaction.fetchReply();
    const filter = (i: Interaction) => i.isButton();
    const collector = (msg as any).createMessageComponentCollector({ filter, time: duration * 1000 });
    const userVote = new Map<string, string>();
    collector.on('collect', async (btnInteraction: Interaction) => {
      if (!btnInteraction.isButton()) return;
      const uid = btnInteraction.user.id;
      const cidBtn = (btnInteraction.customId as string) || '';
      const prev = userVote.get(uid);
      if (prev) votes.set(prev, Math.max(0, (votes.get(prev) ?? 1) - 1));
      userVote.set(uid, cidBtn);
      votes.set(cidBtn, (votes.get(cidBtn) ?? 0) + 1);
      await btnInteraction.reply({ content: `Vote registered. (cid: ${cid})`, ephemeral: true }).catch(() => {});
    });
    collector.on('end', async () => {
      const results = customIds.map((id, idx) => ({ id, votes: votes.get(id) ?? 0, label: opts[idx] }));
      const resultsText = results.map((r, idx) => `${idx + 1}. ${r.label} — ${r.votes} vote(s)`).join('\n');
      const resEmbed = new EmbedBuilder().setTitle('Poll results').setDescription(question).addFields({ name: 'Results', value: resultsText }).setTimestamp();
      await (msg as any).edit({ components: [], embeds: [resEmbed] }).catch(() => {});
    });
  },
});

const YT_IDS = [
  'dQw4w9WgXcQ',
  '3JZ_D3ELwOQ',
  'J---aiyznGQ',
  'hY7m5jjJ9mM',
  'kXYiU_JCYtU',
  'ktvTqknDobU',
  '9bZkp7q19f0',
  'fJ9rUzIMcZQ',
  'e-ORhEE9VVg',
  'RgKAFK5djSk',
  'uelHwf8o7_U',
  'YQHsXMglC9A'
];

commands.set('whattowatch', {
  data: new SlashCommandBuilder().setName('whattowatch').setDescription('Suggest a random YouTube video'),
  cooldown: 5,
  execute: async (interaction) => {
    const cid = newCid();
    const pick = YT_IDS[Math.floor(Math.random() * YT_IDS.length)];
    const url = `https://www.youtube.com/watch?v=${pick}`;
    try {
      const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(oembed);
      if (!res.ok) {
        await interaction.reply({ content: `Failed to validate video (cid: ${cid})`, ephemeral: true });
        return;
      }
      const json = await res.json();
      const title = (json && json.title) ? String(json.title) : 'YouTube Video';
      const author = (json && json.author_name) ? String(json.author_name) : '';
      const embed = new EmbedBuilder().setTitle(title).setDescription(author).setURL(String(url)).setFooter({ text: `cid: ${cid}` }).setTimestamp();
      await interaction.reply({ embeds: [embed] });
    } catch {
      await interaction.reply({ content: `Error validating video (cid: ${cid})`, ephemeral: true });
    }
  },
});

commands.set('lock', {
  data: new SlashCommandBuilder().setName('lock').setDescription('Lock this channel'),
  cooldown: 5,
  execute: async (interaction) => {
    const cid = newCid();
    if (!interaction.inGuild()) {
      await interaction.reply({ content: `Must be used in a guild (cid: ${cid})`, ephemeral: true });
      return;
    }
    if (!isAuthorized(interaction) && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      await interaction.reply({ content: `Missing Manage Channels permission or not authorized (cid: ${cid})`, ephemeral: true });
      return;
    }
    const channel = interaction.channel;
    if (!channel || !('permissionOverwrites' in channel)) {
      await interaction.reply({ content: `Cannot modify this channel (cid: ${cid})`, ephemeral: true });
      return;
    }
    const everyone = interaction.guild!.roles.everyone;
    await (channel as any).permissionOverwrites.edit(everyone, { SendMessages: false }).catch(() => null);
    await interaction.reply({ content: `Channel locked (cid: ${cid})`, ephemeral: true });
  },
});

commands.set('unlock', {
  data: new SlashCommandBuilder().setName('unlock').setDescription('Unlock this channel'),
  cooldown: 5,
  execute: async (interaction) => {
    const cid = newCid();
    if (!interaction.inGuild()) {
      await interaction.reply({ content: `Must be used in a guild (cid: ${cid})`, ephemeral: true });
      return;
    }
    if (!isAuthorized(interaction) && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      await interaction.reply({ content: `Missing Manage Channels permission or not authorized (cid: ${cid})`, ephemeral: true });
      return;
    }
    const channel = interaction.channel;
    if (!channel || !('permissionOverwrites' in channel)) {
      await interaction.reply({ content: `Cannot modify this channel (cid: ${cid})`, ephemeral: true });
      return;
    }
    const everyone = interaction.guild!.roles.everyone;
    await (channel as any).permissionOverwrites.edit(everyone, { SendMessages: null }).catch(() => null);
    await interaction.reply({ content: `Channel unlocked (cid: ${cid})`, ephemeral: true });
  },
});

commands.set('lockall', {
  data: new SlashCommandBuilder().setName('lockall').setDescription('Lock all text channels in this guild'),
  cooldown: 30,
  execute: async (interaction) => {
    const cid = newCid();
    if (!interaction.inGuild()) {
      await interaction.reply({ content: `Must be used in a guild (cid: ${cid})`, ephemeral: true });
      return;
    }
    if (!isAuthorized(interaction)) {
      await interaction.reply({ content: `Missing Manage Guild permission or not authorized (cid: ${cid})`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `Locking channels... (cid: ${cid})`, ephemeral: true });
    const everyone = interaction.guild!.roles.everyone;
    const fetched = await interaction.guild!.channels.fetch();
    for (const ch of fetched.values()) {
      if (!ch) continue;
      if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement || ch.type === ChannelType.GuildForum) {
        await ch.permissionOverwrites.edit(everyone, { SendMessages: false }).catch(() => null);
      }
    }
    await interaction.followUp({ content: `All applicable channels locked (cid: ${cid})`, ephemeral: true });
  },
});

commands.set('unlockall', {
  data: new SlashCommandBuilder().setName('unlockall').setDescription('Unlock all text channels in this guild'),
  cooldown: 30,
  execute: async (interaction) => {
    const cid = newCid();
    if (!interaction.inGuild()) {
      await interaction.reply({ content: `Must be used in a guild (cid: ${cid})`, ephemeral: true });
      return;
    }
    if (!isAuthorized(interaction)) {
      await interaction.reply({ content: `Missing Manage Guild permission or not authorized (cid: ${cid})`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `Unlocking channels... (cid: ${cid})`, ephemeral: true });
    const everyone = interaction.guild!.roles.everyone;
    const fetched = await interaction.guild!.channels.fetch();
    for (const ch of fetched.values()) {
      if (!ch) continue;
      if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement || ch.type === ChannelType.GuildForum) {
        await ch.permissionOverwrites.edit(everyone, { SendMessages: null }).catch(() => null);
      }
    }
    await interaction.followUp({ content: `All applicable channels unlocked (cid: ${cid})`, ephemeral: true });
  },
});

commands.set('recosave', {
  data: new SlashCommandBuilder().setName('recosave').setDescription('Save current channels and last 10 messages per channel (overwrites previous snapshot)'),
  cooldown: 60,
  execute: async (interaction) => {
    const cid = newCid();
    if (!interaction.inGuild()) {
      await interaction.reply({ content: `Must be used in a guild (cid: ${cid})`, ephemeral: true });
      return;
    }
    if (!isAuthorized(interaction)) {
      await interaction.reply({ content: `Missing Manage Guild permission or not authorized (cid: ${cid})`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `Saving snapshot... (cid: ${cid})`, ephemeral: true });
    const guild = interaction.guild!;
    const fetched = await guild.channels.fetch();
    const channelsData: SavedChannel[] = [];
    for (const ch of fetched.values()) {
      if (!ch) continue;
      if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement || ch.type === ChannelType.GuildForum) {
        const saved: SavedChannel = {
          id: ch.id,
          name: ch.name,
          type: ch.type,
          parentId: (ch as any).parentId ?? null,
          position: ch.position,
          topic: (ch as any).topic ?? null,
          nsfw: (ch as any).nsfw ?? false,
          messages: [],
        };
        try {
          const msgs = await (ch as TextChannel).messages.fetch({ limit: 10 });
          const arr = Array.from(msgs.values()).reverse();
          for (const m of arr) {
            const attachments = Array.from(m.attachments.values()).map((a) => a.url);
            saved.messages.push({ authorId: m.author.id, content: m.content, attachments, embeds: m.embeds.map((e) => e.toJSON()), createdAt: m.createdTimestamp });
          }
        } catch {
        }
        channelsData.push(saved);
      } else if (ch.type === ChannelType.GuildCategory) {
        const saved: SavedChannel = {
          id: ch.id,
          name: ch.name,
          type: ch.type,
          parentId: null,
          position: ch.position,
          topic: null,
          nsfw: false,
          messages: [],
        };
        channelsData.push(saved);
      }
    }
    const payload = { guildId: guild.id, savedAt: Date.now(), channels: channelsData };
    const stmt = db.prepare('INSERT INTO snapshots(guild_id,data,saved_at) VALUES(@g,@d,@s) ON CONFLICT(guild_id) DO UPDATE SET data=excluded.data, saved_at=excluded.saved_at');
    stmt.run({ g: guild.id, d: JSON.stringify(payload), s: Date.now() });
    await interaction.followUp({ content: `Snapshot saved for this guild (cid: ${cid})`, ephemeral: true });
  },
});

commands.set('recoload', {
  data: new SlashCommandBuilder().setName('recoload').setDescription('Load the saved snapshot and recreate channels/categories (destructive: existing channels with same name will be deleted)'),
  cooldown: 60,
  execute: async (interaction) => {
    const cid = newCid();
    if (!interaction.inGuild()) {
      await interaction.reply({ content: `Must be used in a guild (cid: ${cid})`, ephemeral: true });
      return;
    }
    if (!isAuthorized(interaction)) {
      await interaction.reply({ content: `Missing Manage Guild permission or not authorized (cid: ${cid})`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `Loading snapshot... (cid: ${cid})`, ephemeral: true });
    const guild = interaction.guild!;
    const row = db.prepare('SELECT data FROM snapshots WHERE guild_id = ?').get(guild.id);
    if (!row) {
      await interaction.followUp({ content: `No snapshot found for this guild (cid: ${cid})`, ephemeral: true });
      return;
    }
    const payload = JSON.parse(row.data) as { guildId: string; savedAt: number; channels: SavedChannel[] };
    const categories = payload.channels.filter((c) => c.type === ChannelType.GuildCategory);
    const texts = payload.channels.filter((c) => c.type !== ChannelType.GuildCategory);
    const createdCategoryMap = new Map<string, CategoryChannel>();
    for (const cat of categories) {
      const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === cat.name);
      if (existing) {
        createdCategoryMap.set(cat.id, existing as CategoryChannel);
        continue;
      }
      const created = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory }).catch(() => null);
      if (created && created.type === ChannelType.GuildCategory) createdCategoryMap.set(cat.id, created as CategoryChannel);
    }
    for (const ch of texts) {
      const existing = guild.channels.cache.find((c) => c.name === ch.name && c.type === ch.type);
      if (existing) {
        await existing.delete().catch(() => null);
      }
      const parent = ch.parentId ? createdCategoryMap.get(ch.parentId) ?? undefined : undefined;
      const created = await guild.channels.create({ name: ch.name, type: ch.type === ChannelType.GuildAnnouncement ? ChannelType.GuildAnnouncement : ChannelType.GuildText, parent: parent?.id ?? undefined }).catch(() => null);
      if (!created) continue;
      for (const m of ch.messages) {
        const parts: any = { content: m.content || '' };
        try {
          await (created as TextChannel).send(parts);
        } catch {
        }
      }
    }
    await interaction.followUp({ content: `Snapshot loaded (cid: ${cid})`, ephemeral: true });
  },
});

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const slashData = Array.from(commands.values()).map((c) => c.data.toJSON());
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: slashData }).catch(() => null);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: slashData }).catch(() => null);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;
  const cmd = commands.get(name);
  if (!cmd) {
    await interaction.reply({ content: 'Unknown command', ephemeral: true });
    return;
  }
  const key = `${interaction.user.id}:${name}`;
  const now = Date.now();
  const expiry = cooldowns.get(key) ?? 0;
  if (expiry > now) {
    const remaining = Math.ceil((expiry - now) / 1000);
    await interaction.reply({ content: `Please wait ${remaining}s before using this command again.`, ephemeral: true });
    return;
  }
  try {
    if (cmd.cooldown) cooldowns.set(key, now + cmd.cooldown * 1000);
    await cmd.execute(interaction);
  } catch (err) {
    const cid = newCid();
    await interaction.reply({ content: `Something went wrong (cid: ${cid}).`, ephemeral: true }).catch(() => null);
  }
});

setInterval(async () => {
  const now = Date.now();
  const due = Array.from(reminders.values()).filter((r) => !r.delivered && r.dueAt <= now);
  for (const r of due) {
    try {
      const channel = await client.channels.fetch(r.channelId).catch(() => null);
      const content = `⏰ Reminder for <@${r.userId}>: ${r.message}`;
      if (channel && 'send' in (channel as any)) {
        await (channel as any).send({ content }).catch(() => {});
      } else {
        const user = await client.users.fetch(r.userId).catch(() => null);
        if (user) await user.send({ content }).catch(() => {});
      }
      r.delivered = true;
      reminders.set(r.id, r);
      saveReminders([...reminders.values()]);
    } catch {
    }
  }
}, 10000);

process.on('SIGINT', () => {
  saveReminders([...reminders.values()]);
  db.close();
  client.destroy();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveReminders([...reminders.values()]);
  db.close();
  client.destroy();
  process.exit(0);
});

client.once('ready', async () => {
  await registerCommands();
});
client.login(TOKEN).catch(() => process.exit(1));
