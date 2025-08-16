import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, Events, ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionsBitField } from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

// ---- Config
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const BRACKETS_SQUARE = process.env.NICKNAME_PREFIX_BRACKETS !== '0';
const GUILD_ID = process.env.GUILD_ID;

const pool = new Pool();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.GuildMember]
});

function makePrefix(n) {
  return BRACKETS_SQUARE ? `[${n}]` : `(${n})`;
}

function stripPrefix(name) {
  if (!name) return name;
  return name.replace(/^\s*[\[(]\s*\d+\s*[\])]\s*/,'').trim();
}

async function withConn(fn) {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

async function ensureTables() {
  await withConn(async (db) => {
    await db.query(`CREATE SCHEMA IF NOT EXISTS discord_tags`);
    await db.query(`CREATE SEQUENCE IF NOT EXISTS discord_tags.public_seq START 100`);
    await db.query(`CREATE SEQUENCE IF NOT EXISTS discord_tags.staff_seq START 1`);
    await db.query(`CREATE TABLE IF NOT EXISTS discord_tags.user_tags (
      discord_id TEXT PRIMARY KEY,
      tag_number INTEGER NOT NULL,
      is_staff_tag BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await db.query(`CREATE OR REPLACE FUNCTION discord_tags.touch_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await db.query(`DROP TRIGGER IF EXISTS tg_user_tags_updated ON discord_tags.user_tags`);
    await db.query(`CREATE TRIGGER tg_user_tags_updated BEFORE UPDATE ON discord_tags.user_tags FOR EACH ROW EXECUTE FUNCTION discord_tags.touch_updated_at()`);
  });
}

async function getOrCreateTag(discordId, preferStaff=false) {
  return withConn(async (db) => {
    const r = await db.query('SELECT tag_number, is_staff_tag FROM discord_tags.user_tags WHERE discord_id=$1',[discordId]);
    if (r.rowCount) return r.rows[0];

    // criar
    const isStaff = preferStaff === true;
    const seq = isStaff ? 'discord_tags.staff_seq' : 'discord_tags.public_seq';
    const next = await db.query(`SELECT nextval('${seq}') AS n`);
    const n = Number(next.rows[0].n);

    await db.query('INSERT INTO discord_tags.user_tags(discord_id, tag_number, is_staff_tag) VALUES($1,$2,$3)', [discordId, n, isStaff]);
    return { tag_number: n, is_staff_tag: isStaff };
  });
}

async function moveToStaffRangeIfNeeded(discordId) {
  return withConn(async (db) => {
    const r = await db.query('SELECT tag_number, is_staff_tag FROM discord_tags.user_tags WHERE discord_id=$1',[discordId]);
    if (r.rowCount && r.rows[0].is_staff_tag) return r.rows[0];
    if (r.rowCount && r.rows[0].tag_number < 100) {
      await db.query('UPDATE discord_tags.user_tags SET is_staff_tag=TRUE WHERE discord_id=$1',[discordId]);
      return { tag_number: r.rows[0].tag_number, is_staff_tag: true };
    }
    const next = await db.query(`SELECT nextval('discord_tags.staff_seq') AS n`);
    const n = Number(next.rows[0].n);
    await db.query(`INSERT INTO discord_tags.user_tags(discord_id, tag_number, is_staff_tag)
                    VALUES($1,$2,TRUE)
                    ON CONFLICT(discord_id) DO UPDATE SET tag_number=EXCLUDED.tag_number, is_staff_tag=TRUE`, [discordId, n]);
    return { tag_number: n, is_staff_tag: true };
  });
}

function isStaffMember(member) {
  return member.roles.cache.some(r => STAFF_ROLE_IDS.includes(r.id));
}

async function applyNickname(member, tagNumber) {
  const prefix = makePrefix(tagNumber);
  const base = stripPrefix(member.displayName || member.user.username);
  const nick = `${prefix} ${base}`.slice(0, 32);
  await member.setNickname(nick).catch(() => {});
}

async function resetNickname(member) {
  // Limpa o nickname para voltar ao nome original do Discord
  await member.setNickname(null).catch(()=>{});
}

async function scanGuild(guild) {
  await guild.members.fetch();
  const out = { missing: [] };
  guild.members.cache.forEach(m => {
    if (m.user.bot) return;
    const hasPrefix = /^\s*[\[(]\s*\d+\s*[\])]/.test(m.displayName);
    if (!hasPrefix) out.missing.push(m);
  });
  return out;
}

client.once(Events.ClientReady, async () => {
  console.log(`Logado como ${client.user.tag}`);
  await ensureTables();
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  const staff = isStaffMember(member);
  const tag = await getOrCreateTag(member.id, staff);
  await applyNickname(member, tag.tag_number);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() && !i.isButton()) return;

  if (i.isChatInputCommand()) {
    if (i.commandName === 'verificar') {
      if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageNicknames)) {
        return i.reply({ ephemeral: true, content: 'Precisas de permissão Manage Nicknames.' });
      }
      const guild = await client.guilds.fetch(GUILD_ID);
      const { missing } = await scanGuild(guild);
      const list = missing.slice(0, 20).map(m => `• ${m.user.tag}`).join('\n') || 'Tudo OK ✅';
      const btn = new ButtonBuilder().setCustomId('apply_all').setLabel('Aplicar agora').setStyle(ButtonStyle.Primary);
      await i.reply({ content: `Membros sem tag aplicada: ${missing.length}\n${list}`, components: missing.length? [new ActionRowBuilder().addComponents(btn)] : [], ephemeral: true });
    }

    if (i.commandName === 'reset') {
      await i.deferReply({ ephemeral: true });
      const targetUser = i.options.getUser('user');
      const scope = i.options.getString('scope') || 'all';
      const onlyWithPrefix = i.options.getBoolean('only_with_prefix') || false;

      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.members.fetch();

      let candidates = [];
      if (targetUser) {
        const m = await guild.members.fetch(targetUser.id).catch(()=>null);
        if (m && !m.user.bot) candidates = [m];
      } else {
        candidates = Array.from(guild.members.cache.values()).filter(m => !m.user.bot);
        if (scope === 'staff') candidates = candidates.filter(m => isStaffMember(m));
        if (scope === 'nao-staff') candidates = candidates.filter(m => !isStaffMember(m));
      }
      if (onlyWithPrefix) {
        candidates = candidates.filter(m => /^\s*[\[(]\s*\d+\s*[\])]\s*/.test(m.displayName || ''));
      }

      let changed = 0;
      for (const m of candidates) {
        await resetNickname(m); changed++;
        await new Promise(r => setTimeout(r, 200));
      }
      await i.editReply(`Nicknames restaurados: ${changed} ${targetUser ? `(alvo: ${targetUser.tag})` : ''}`);
    }

    if (i.commandName === 'aplicar' || i.commandName === 'aplicarstaff') {
      const onlyStaff = i.commandName === 'aplicarstaff';
      await i.deferReply({ ephemeral: true });
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.members.fetch();
      let applied = 0;
      for (const m of guild.members.cache.values()) {
        if (m.user.bot) continue;
        const staff = isStaffMember(m);
        if (onlyStaff && !staff) continue;
        if (!onlyStaff && staff) continue;
        const tag = staff ? await moveToStaffRangeIfNeeded(m.id) : await getOrCreateTag(m.id, false);
        await applyNickname(m, tag.tag_number); applied++;
        await new Promise(r => setTimeout(r, 200));
      }
      await i.editReply(`Aplicado a ${applied} membros (${onlyStaff? 'staff' : 'não-staff'}).`);
    }

    if (i.commandName === 'staff') {
      const user = i.options.getUser('user', true);
      const role = i.options.getRole('cargo', true);
      const guild = await client.guilds.fetch(GUILD_ID);
      const member = await guild.members.fetch(user.id).catch(()=>null);
      if (!member) return i.reply({ ephemeral:true, content: 'Utilizador não encontrado no servidor.' });
      await member.roles.add(role).catch(()=>{});
      const tag = await moveToStaffRangeIfNeeded(member.id);
      await applyNickname(member, tag.tag_number);
      await i.reply({ ephemeral: true, content: `Cargo atribuído e tag garantida: ${makePrefix(tag.tag_number)} ${member.displayName}` });
    }
  }

  if (i.isButton() && i.customId === 'apply_all') {
    if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageNicknames)) {
      return i.reply({ ephemeral: true, content: 'Sem permissão.' });
    }
    await i.deferReply({ ephemeral: true });
    const guild = await client.guilds.fetch(GUILD_ID);
    const { missing } = await scanGuild(guild);
    let applied = 0;
    for (const m of missing) {
      const staff = isStaffMember(m);
      const tag = staff ? await moveToStaffRangeIfNeeded(m.id) : await getOrCreateTag(m.id, false);
      await applyNickname(m, tag.tag_number); applied++;
      await new Promise(r => setTimeout(r, 200));
    }
    await i.editReply(`Aplicado a ${applied} membros em falta.`);
  }
});

client.login(process.env.DISCORD_TOKEN);
