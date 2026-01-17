import 'dotenv/config'
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionsBitField,
  SlashCommandBuilder
} from 'discord.js'
import sqlite3 from 'sqlite3'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
})

const AUTH_USERS = [
  '716635883952013353',
  '1359705195864526898',
  '1182916470301282324',
  '1019428950973349988'
]

const lockedChannels = new Set()

const db = new sqlite3.Database('./infractions.db')
db.run('CREATE TABLE IF NOT EXISTS infractions (user TEXT PRIMARY KEY, count INTEGER)')

const badWords = [
  'nigger','nigga','faggot','retard','slut','whore','cunt','rape','bitch'
]

const fuzzy = t =>
  badWords.some(w => [...w].every(c => t.includes(c)))

const getInfractions = id =>
  new Promise(r =>
    db.get('SELECT count FROM infractions WHERE user = ?', [id], (_, row) =>
      r(row ? row.count : 0)
    )
  )

const setInfractions = (id, c) =>
  db.run(
    'INSERT INTO infractions(user,count) VALUES(?,?) ON CONFLICT(user) DO UPDATE SET count=?',
    [id, c, c]
  )

const parseTime = t => {
  const n = parseInt(t)
  if (t.endsWith('m')) return n * 60000
  if (t.endsWith('h')) return n * 3600000
  if (t.endsWith('d')) return n * 86400000
  return null
}

const commands = [
  new SlashCommandBuilder().setName('ban').setDescription('ban')
    .addUserOption(o => o.setName('user').setRequired(true)),
  new SlashCommandBuilder().setName('kick').setDescription('kick')
    .addUserOption(o => o.setName('user').setRequired(true)),
  new SlashCommandBuilder().setName('mute').setDescription('mute')
    .addUserOption(o => o.setName('user').setRequired(true))
    .addStringOption(o => o.setName('time').setRequired(true)),
  new SlashCommandBuilder().setName('lock').setDescription('lock'),
  new SlashCommandBuilder().setName('unlock').setDescription('unlock'),
  new SlashCommandBuilder().setName('purge').setDescription('purge')
    .addIntegerOption(o => o.setName('amount').setRequired(true)),
  new SlashCommandBuilder().setName('slowmode').setDescription('slowmode')
    .addIntegerOption(o => o.setName('seconds').setRequired(true)),
  new SlashCommandBuilder().setName('nuke').setDescription('nuke'),
  new SlashCommandBuilder().setName('lockdown').setDescription('lockdown'),
  new SlashCommandBuilder().setName('unlockdown').setDescription('unlockdown'),
  new SlashCommandBuilder().setName('gamble').setDescription('gamble'),
  new SlashCommandBuilder().setName('whatshouldiwatch').setDescription('watch'),
  new SlashCommandBuilder().setName('infractions').setDescription('infractions')
    .addUserOption(o => o.setName('user').setRequired(true)),
  new SlashCommandBuilder().setName('clearinfractions').setDescription('clear')
    .addUserOption(o => o.setName('user').setRequired(true)),
  new SlashCommandBuilder().setName('massmute').setDescription('massmute')
    .addStringOption(o => o.setName('time').setRequired(true)),
  new SlashCommandBuilder().setName('antiraid').setDescription('antiraid'),
  new SlashCommandBuilder().setName('unlockantiraid').setDescription('unlockantiraid')
]

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN)

client.once('ready', async () => {
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands.map(c => c.toJSON()) }
  )
})

client.on('messageCreate', async m => {
  if (!m.guild || m.author.bot) return

  if (lockedChannels.has(m.channel.id) && !AUTH_USERS.includes(m.author.id)) {
    await m.delete().catch(() => {})
    return
  }

  if (AUTH_USERS.includes(m.author.id)) return

  const text = m.content.toLowerCase().replace(/[^a-z]/g, '')
  if (fuzzy(text)) {
    const c = await getInfractions(m.author.id)
    const n = c + 1
    setInfractions(m.author.id, n)

    if (n === 1) await m.reply('warning').catch(() => {})
    if (n === 2) await m.member.timeout(600000).catch(() => {})
    if (n >= 3) await m.member.timeout(86400000).catch(() => {})
  }
})

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return

  const member = i.member
  const name = i.commandName
  const target = i.options.getUser('user')
  const time = i.options.getString('time')
  const blocked = target && AUTH_USERS.includes(target.id)

  if (
    !member.permissions.has(PermissionsBitField.Flags.Administrator) &&
    !AUTH_USERS.includes(member.id)
  )
    return i.reply({ content: 'no', ephemeral: true })

  if (name === 'ban' && target && !blocked) {
    await i.guild.members.ban(target.id)
    return i.reply('done')
  }

  if (name === 'kick' && target && !blocked) {
    await i.guild.members.kick(target.id)
    return i.reply('done')
  }

  if (name === 'mute' && target && !blocked) {
    const d = parseTime(time)
    if (d) await i.guild.members.fetch(target.id).then(m => m.timeout(d))
    return i.reply('done')
  }

  if (name === 'lock') {
    lockedChannels.add(i.channel.id)
    return i.reply('done')
  }

  if (name === 'unlock') {
    lockedChannels.delete(i.channel.id)
    return i.reply('done')
  }

  if (name === 'purge') {
    const a = i.options.getInteger('amount')
    await i.channel.bulkDelete(a)
    return i.reply({ content: 'done', ephemeral: true })
  }

  if (name === 'slowmode') {
    await i.channel.setRateLimitPerUser(i.options.getInteger('seconds'))
    return i.reply('done')
  }

  if (name === 'nuke') {
    const c = i.channel
    const nc = await c.clone()
    await c.delete()
    return nc.send('done')
  }

  if (name === 'lockdown') {
    i.guild.channels.cache.forEach(c => lockedChannels.add(c.id))
    return i.reply('done')
  }

  if (name === 'unlockdown') {
    lockedChannels.clear()
    return i.reply('done')
  }

  if (name === 'gamble') {
    return i.reply(Math.random() > 0.5 ? 'win' : 'lose')
  }

  if (name === 'whatshouldiwatch') {
    let id
    do {
      id = Math.random().toString(36).slice(2, 13)
    } while (id.length !== 11)
    return i.reply(`https://www.youtube.com/watch?v=${id}`)
  }

  if (name === 'infractions' && target) {
    const c = await getInfractions(target.id)
    return i.reply(`count: ${c}`)
  }

  if (name === 'clearinfractions' && target) {
    setInfractions(target.id, 0)
    return i.reply('done')
  }

  if (name === 'massmute') {
    const d = parseTime(time)
    if (d)
      i.guild.members.cache.forEach(m => {
        if (!m.user.bot && !AUTH_USERS.includes(m.id))
          m.timeout(d).catch(() => {})
      })
    return i.reply('done')
  }

  if (name === 'antiraid') {
    i.guild.setVerificationLevel(4)
    return i.reply('done')
  }

  if (name === 'unlockantiraid') {
    i.guild.setVerificationLevel(0)
    return i.reply('done')
  }
})

client.login(process.env.BOT_TOKEN)
