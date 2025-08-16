import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionsBitField
} from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

/* ===== Util ===== */
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('uncaughtException', e => console.error('uncaughtException:', e));

const pool = new Pool();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember]
});

const GUILD_ID = process.env.GUILD_ID;
const BRACKETS_SQUARE = process.env.NICKNAME_PREFIX_BRACKETS !== '0';

/* ===== Config de staff/segmentos ===== */
function parseRange(s) {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(String(s || '').trim());
  if (!m) return null;
  const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
  return a <= b ? [a, b] : [b, a];
}
function parseSegments(s) {
  // "ROLEID:1-10;ROLEID2:11-20"
  const out = [];
  String(s || '').split(';').map(x => x.trim()).filter(Boolean).forEach(pair => {
    const [roleId, rangeStr] = pair.split(':').map(y => y.trim());
    const range = parseRange(rangeStr);
    if (roleId && range) out.push({ roleId, start: range[0], end: range[1] });
  });
  return out;
}
const SEGMENTS = parseSegments(process.env.STAFF_SEGMENTS);
const OVERFLOW = parseRange(process.env.STAFF_OVERFLOW || '61-100');
const EXTRA_STAFF_IDS = (process.env.STAFF_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALL_STAFF_ROLE_IDS = [...new Set([...EXTRA_STAFF_IDS, ...SEGMENTS.map(s => s.roleId)])];

function makePrefix(n) { return BRACKETS_SQUARE ? `[${n}]` : `(${n})`; }
function stripPrefix(name) {
  if (!name) return name;
  return String(name).replace(/^\s*[\[(]\s*\d+\s*[\])]\s*/,'').trim();
}
function isStaffMember(member) {
  return member.roles.cache.some(r => ALL_STAFF_ROLE_IDS.includes(r.id));
}
function preferredSegmentFor(member) {
  for (const seg of SEGMENTS) {
    if (member.roles.cache.has(seg.roleId)) return seg;
  }
  return null;
}

async function withConn(fn) {
  const c = await pool.connect();
  try { return await fn(c); }
  finally { c.release(); }
}

/* ===== Alocação de tags ===== */

async function nextFreeTagInRange(db, start, end) {
  const { rows } = await db.query(
    `SELECT tag_number FROM discord_tags.user_tags
     WHERE tag_number BETWEEN $1 AND $2
     ORDER BY tag_number`, [start, end]
  );
  let expected = start;
  for (const r of rows) {
    const n = Number(r.tag_number);
    if (n > expected) return expected;
    if (n === expected) expected++;
  }
  return expected <= end ? expected : null;
}

async function allocateStaffTag(db, discordId, prefSeg) {
  // Tentar: segmento preferido -> outros segmentos por ordem -> overflow -> todos <100
  const tried = [];
  const tryRanges = [];

  if (prefSeg) tryRanges.push([prefSeg.start, prefSeg.end, 'preferido']);
  for (const s of SEGMENTS) {
    if (!prefSeg || s.roleId !== prefSeg.roleId) tryRanges.push([s.start, s.end, 'segmento']);
  }
  if (OVERFLOW) tryRanges.push([OVERFLOW[0], OVERFLOW[1], 'overflow']);
  // fallback absoluto
  tryRanges.push([1, 99, 'fallback']);

  for (const [a, b] of tryRanges) {
    const n = await nextFreeTagInRange(db, a, b);
    if (n != null) return n;
    tried.push(`${a}-${b}`);
  }
  throw new Error(`Sem números livres em: ${tried.join(', ')}`);
}

async function getOrCreatePublicTag(discordId) {
  return withConn(async (db) => {
    const r = await db.query('SELECT tag_number, is_staff_tag FROM discord_tags.user_tags WHERE discord_id=$1', [discordId]);
    if (r.rowCount) return r.rows[0];

    // público começa em 100, procurar o próximo livre >=100 (mantemos ordem crescente)
    const { rows } = await db.query(
      `SELECT tag_number FROM discord_tags.user_tags WHERE tag_number >= 100 ORDER BY tag_number`
    );
    let n = 100;
    for (const row of rows) {
      const t = Number(row.tag_number);
      if (t > n) break;
      if (t === n) n++;
    }
    await db.query(
      `INSERT INTO discord_tags.user_tags(discord_id, tag_number, is_staff_tag)
       VALUES ($1,$2,FALSE) ON CONFLICT (discord_id) DO UPDATE SET tag_number=EXCLUDED.tag_number, is_staff_tag=FALSE`,
      [discordId, n]
    );
    return { tag_number: n, is_staff_tag: false };
  });
}

async function ensureStaffTag(discordId, member) {
  // Se já tem <100 → mantém
  return withConn(async (db) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await db.query('SELECT tag_number, is_staff_tag FROM discord_tags.user_tags WHERE discord_id=$1', [discordId]);
        if (r.rowCount && r.rows[0].is_staff_tag) return r.rows[0];

        const pref = preferredSegmentFor(member);
        const n = await allocateStaffTag(db, discordId, pref);

        await db.query(
          `INSERT INTO discord_tags.user_tags(discord_id, tag_number, is_staff_tag)
           VALUES ($1,$2,TRUE)
           ON CONFLICT (discord_id)
           DO UPDATE SET tag_number=EXCLUDED.tag_number, is_staff_tag=TRUE`,
          [discordId, n]
        );
        return { tag_number: n, is_staff_tag: true };
      } catch (e) {
        // conflito único -> volta a tentar
        if (String(e.code) === '23505') continue;
        throw e;
      }
    }
    throw new Error('Falha a alocar tag staff após várias tentativas');
  });
}

/* ===== Nicknames ===== */
async function applyNickname(member, tagNumber) {
  const prefix = makePrefix(tagNumber);
  const base = stripPrefix(member.nickname || member.user.username);
  const nick = `${prefix} ${base}`.slice(0, 32);
  await member.setNickname(nick); // se falhar, atira erro
}

async function resetNickname(member) {
  await member.setNickname(null);
}

/* ===== Scan ===== */
async function scanGuild(guild) {
  await guild.members.fetch();
  const out = { missingManageable: [], missingUnmanageable: [] };
  guild.members.cache.forEach(m => {
    if (m.user.bot) return;
    const hasPrefix = /^\s*[\[(]\s*\d+\s*[\])]\s*/.test(m.nickname || '');
    if (!hasPrefix) {
      if (m.manageable && m.id !== guild.ownerId) out.missingManageable.push(m);
      else out.missingUnmanageable.push(m);
    }
  });
  return out;
}

async function getGuildSafe(i) {
  if (i?.guild) return i.guild;
  const cached = client.guilds.cache.get(GUILD_ID);
  if (cached) return cached;
  try { return await client.guilds.fetch(GUILD_ID); } catch { return null; }
}

/* ===== Eventos ===== */
client.once(Events.ClientReady, async () => {
  console.log(`Logado como ${client.user.tag}`);
  await withConn(async (db) => {
    await db.query(`CREATE SCHEMA IF NOT EXISTS discord_tags`);
    await db.query(`CREATE TABLE IF NOT EXISTS discord_tags.user_tags (
      discord_id TEXT PRIMARY KEY,
      tag_number INTEGER NOT NULL,
      is_staff_tag BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await db.query(`DO $$BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_user_tags_tag') THEN
        ALTER TABLE discord_tags.user_tags ADD CONSTRAINT uq_user_tags_tag UNIQUE(tag_number);
      END IF; END$$;`);
    await db.query(`CREATE OR REPLACE FUNCTION discord_tags.touch_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await db.query(`DROP TRIGGER IF EXISTS tg_user_tags_updated ON discord_tags.user_tags`);
    await db.query(`CREATE TRIGGER tg_user_tags_updated BEFORE UPDATE ON discord_tags.user_tags FOR EACH ROW EXECUTE FUNCTION discord_tags.touch_updated_at()`);
  });
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (GUILD_ID && member.guild.id !== GUILD_ID) return;
  try {
    if (isStaffMember(member)) {
      const tag = await ensureStaffTag(member.id, member);
      await applyNickname(member, tag.tag_number);
    } else {
      const tag = await getOrCreatePublicTag(member.id);
      await applyNickname(member, tag.tag_number);
    }
  } catch (e) {
    console.error('GuildMemberAdd erro:', e?.message || e);
  }
});

/* ===== Slash / Botões ===== */
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() && !i.isButton()) return;

  if (i.isChatInputCommand()) {
    if (i.commandName === 'verificar') {
      if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageNicknames)) {
        return i.reply({ ephemeral: true, content: 'Precisas de permissão Manage Nicknames.' });
      }
      const guild = await getGuildSafe(i);
      if (!guild) return i.reply({ ephemeral: true, content: 'Config inválida: GUILD_ID não corresponde a nenhum servidor do bot.' });
      const { missingManageable, missingUnmanageable } = await scanGuild(guild);
      const list = arr => arr.slice(0, 15).map(m => `• ${m.user.tag}`).join('\n') || '—';
      const txt =
        `Faltam aplicar: ${missingManageable.length + missingUnmanageable.length}\n`+
        `• Geríveis pelo bot: ${missingManageable.length}\n${list(missingManageable)}\n\n`+
        `• Não geríveis: ${missingUnmanageable.length}\n${list(missingUnmanageable)}\n`+
        (missingUnmanageable.length ? '\nMotivos: owner do servidor; role do membro ≥ role do bot.' : '');
      const btn = new ButtonBuilder().setCustomId('apply_all').setLabel('Aplicar agora').setStyle(ButtonStyle.Primary);
      return i.reply({ content: txt, components: missingManageable.length ? [new ActionRowBuilder().addComponents(btn)] : [], ephemeral: true });
    }

    if (i.commandName === 'reset') {
      await i.deferReply({ ephemeral: true });
      const targetUser = i.options.getUser('user');
      const scope = i.options.getString('scope') || 'all';
      const onlyWithPrefix = i.options.getBoolean('only_with_prefix') || false;

      const guild = await getGuildSafe(i);
      if (!guild) return i.editReply('Config inválida: GUILD_ID não corresponde a nenhum servidor do bot.');

      await guild.members.fetch();
      let candidates = [];
      if (targetUser) {
        const m = await guild.members.fetch(targetUser.id).catch(()=>null);
        if (m && !m.user.bot) candidates = [m];
      } else {
        candidates = Array.from(guild.members.cache.values()).filter(m => !m.user.bot);
        if (scope === 'staff') candidates = candidates.filter(isStaffMember);
        if (scope === 'nao-staff') candidates = candidates.filter(m => !isStaffMember(m));
      }
      if (onlyWithPrefix) {
        candidates = candidates.filter(m => /^\s*[\[(]\s*\d+\s*[\])]\s*/.test(m.nickname || ''));
      }

      let ok = 0, fails = [];
      for (const m of candidates) {
        if (!m.manageable || m.id === guild.ownerId) { fails.push(`${m.user.tag}: não gerível`); continue; }
        try { await resetNickname(m); ok++; }
        catch (e) { fails.push(`${m.user.tag}: ${e?.message || e}`); }
        await new Promise(r => setTimeout(r, 200));
      }
      return i.editReply(`Nicknames restaurados: ${ok}${fails.length ? `\nFalhou em ${fails.length}:\n${fails.slice(0,8).join('\n')}${fails.length>8?'\n...':''}`:''}`);
    }

    if (i.commandName === 'aplicar' || i.commandName === 'aplicarstaff') {
      const onlyStaff = i.commandName === 'aplicarstaff';
      await i.deferReply({ ephemeral: true });
      const guild = await getGuildSafe(i);
      if (!guild) return i.editReply('Config inválida: GUILD_ID não corresponde a nenhum servidor do bot.');

      await guild.members.fetch();
      let applied = 0, fails = [];
      for (const m of guild.members.cache.values()) {
        if (m.user.bot) continue;
        const staff = isStaffMember(m);
        if (onlyStaff && !staff) continue;
        if (!onlyStaff && staff) continue;
        if (!m.manageable || m.id === guild.ownerId) { fails.push(`${m.user.tag}: não gerível`); continue; }

        try {
          if (staff) {
            const tag = await ensureStaffTag(m.id, m);
            await applyNickname(m, tag.tag_number);
          } else {
            const tag = await getOrCreatePublicTag(m.id);
            await applyNickname(m, tag.tag_number);
          }
          applied++;
        } catch (e) {
          fails.push(`${m.user.tag}: ${e?.message || e}`);
        }
        await new Promise(r => setTimeout(r, 200));
      }
      return i.editReply(`Aplicado a ${applied} membro(s) (${onlyStaff? 'staff':'não-staff'}).${fails.length?`\nFalhou em ${fails.length}:\n${fails.slice(0,8).join('\n')}${fails.length>8?'\n...':''}`:''}`);
    }

    if (i.commandName === 'staff') {
      const user = i.options.getUser('user', true);
      const role = i.options.getRole('cargo', true);
      const guild = await getGuildSafe(i);
      if (!guild) return i.reply({ ephemeral: true, content: 'Config inválida (GUILD_ID).' });
      const member = await guild.members.fetch(user.id).catch(()=>null);
      if (!member) return i.reply({ ephemeral:true, content: 'Utilizador não encontrado no servidor.' });

      await member.roles.add(role).catch(()=>{});
      if (member.manageable && member.id !== guild.ownerId) {
        const tag = await ensureStaffTag(member.id, member);
        await applyNickname(member, tag.tag_number).catch(()=>{});
        return i.reply({ ephemeral: true, content: `Cargo atribuído e tag garantida: ${makePrefix(tag.tag_number)} ${member.displayName || member.user.username}` });
      } else {
        return i.reply({ ephemeral: true, content: 'Cargo atribuído. Nota: não consigo alterar o nickname deste membro.' });
      }
    }
  }

  if (i.isButton() && i.customId === 'apply_all') {
    if (!i.memberPermissions.has(PermissionsBitField.Flags.ManageNicknames)) {
      return i.reply({ ephemeral: true, content: 'Sem permissão.' });
    }
    await i.deferReply({ ephemeral: true });
    const guild = await getGuildSafe(i);
    if (!guild) return i.editReply('Config inválida (GUILD_ID).');

    const { missingManageable } = await scanGuild(guild);
    let applied = 0, fails = [];
    for (const m of missingManageable) {
      const staff = isStaffMember(m);
      try {
        if (staff) {
          const tag = await ensureStaffTag(m.id, m);
          await applyNickname(m, tag.tag_number);
        } else {
          const tag = await getOrCreatePublicTag(m.id);
          await applyNickname(m, tag.tag_number);
        }
        applied++;
      } catch (e) {
        fails.push(`${m.user.tag}: ${e?.message || e}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    await i.editReply(`Aplicado a ${applied} membros em falta.${fails.length?`\nFalhou em ${fails.length}:\n${fails.slice(0,8).join('\n')}${fails.length>8?'\n...':''}`:''}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
