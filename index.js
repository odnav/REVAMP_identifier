// index.js — REVAMP (admin-only, tags permanentes, segmentos staff, comunicado interativo)
// Requisitos: ativa no Developer Portal os intents "Server Members" e "Message Content".

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionsBitField,
  EmbedBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder
} from 'discord.js';
import pkg from 'pg';
const { Pool } = pkg;

/* ===== Robustez ===== */
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('uncaughtException', e => console.error('uncaughtException:', e));

/* ===== Discord Client ===== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.GuildMember]
});

/* ===== Env/Config ===== */
const pool = new Pool();
const GUILD_ID = process.env.GUILD_ID;
const BRACKETS_SQUARE = process.env.NICKNAME_PREFIX_BRACKETS !== '0';
// (opcional) Roles que também contam como administradores
const ADMIN_ROLE_IDS = (process.env.ADMIN_ROLE_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);

/* ===== Utils ===== */
function parseRange(s) {
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(s || ''));
  if (!m) return null; const a = parseInt(m[1],10), b = parseInt(m[2],10); return a<=b?[a,b]:[b,a];
}
function parseSegments(s) {
  // "ROLEID:1-10;ROLEID2:11-20"
  const out = [];
  String(s||'').split(';').map(x=>x.trim()).filter(Boolean).forEach(pair=>{
    const [roleId, rangeStr] = pair.split(':').map(y=>y.trim());
    const r = parseRange(rangeStr); if (roleId && r) out.push({ roleId, start:r[0], end:r[1] });
  });
  return out;
}
const SEGMENTS = parseSegments(process.env.STAFF_SEGMENTS);
const OVERFLOW = parseRange(process.env.STAFF_OVERFLOW || '61-100');
const EXTRA_STAFF_IDS = (process.env.STAFF_ROLE_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
const ALL_STAFF_ROLE_IDS = [...new Set([...EXTRA_STAFF_IDS, ...SEGMENTS.map(s=>s.roleId)])];

/* ===== Helpers ===== */
function makePrefix(n){ return BRACKETS_SQUARE ? `[${n}]` : `(${n})`; }
function stripPrefix(name){ return String(name||'').replace(/^\s*[\[(]\s*\d+\s*[\])]\s*/, '').trim(); }
function isStaffMember(member){ return member.roles.cache.some(r => ALL_STAFF_ROLE_IDS.includes(r.id)); }
function preferredSegmentFor(member){ return SEGMENTS.find(s => member.roles.cache.has(s.roleId)) || null; }
async function withConn(fn){ const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }

// 🔒 Admin check (também aceita roles na variável ADMIN_ROLE_IDS)
function isAdmin(member){
  return member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
         member?.roles?.cache?.some(r => ADMIN_ROLE_IDS.includes(r.id));
}

// BBCode simples -> Markdown (para comodidade ao escrever textos)
function formatInput(t){
  if (!t) return t;
  return String(t)
    .replace(/\[b\](.*?)\[\/b\]/gis, '**$1**')
    .replace(/\[i\](.*?)\[\/i\]/gis, '*$1*')
    .replace(/\[u\](.*?)\[\/u\]/gis, '__$1__')
    .replace(/\[s\](.*?)\[\/s\]/gis, '~~$1~~')
    .replace(/\[br\]/gi, '\n')
    .replace(/\[code\](.*?)\[\/code\]/gis, '`$1`');
}
function canSendComms(i){
  return isAdmin(i.member) ||
         i.memberPermissions.has(PermissionsBitField.Flags.ManageGuild) ||
         i.memberPermissions.has(PermissionsBitField.Flags.ManageMessages);
}

/* ===== Alocação de tags ===== */
async function nextFreeTagInRange(db, start, end){
  const { rows } = await db.query(
    `SELECT tag_number FROM discord_tags.user_tags WHERE tag_number BETWEEN $1 AND $2 ORDER BY tag_number`,
    [start, end]
  );
  let expected = start;
  for (const r of rows){ const n = Number(r.tag_number); if (n > expected) return expected; if (n === expected) expected++; }
  return expected <= end ? expected : null;
}

async function allocateStaffTag(db, discordId, prefSeg){
  const tryRanges = [];
  if (prefSeg) tryRanges.push([prefSeg.start, prefSeg.end]);
  for (const s of SEGMENTS) if (!prefSeg || s.roleId !== prefSeg.roleId) tryRanges.push([s.start, s.end]);
  if (OVERFLOW) tryRanges.push([OVERFLOW[0], OVERFLOW[1]]);
  tryRanges.push([1, 99]); // fallback absoluto
  for (const [a,b] of tryRanges){ const n = await nextFreeTagInRange(db,a,b); if (n!=null) return n; }
  throw new Error('Sem números livres para staff');
}

async function ensureStaffTag(discordId, member){
  return withConn(async (db) => {
    for (let attempt=0; attempt<5; attempt++){
      try{
        const r = await db.query('SELECT tag_number, is_staff_tag FROM discord_tags.user_tags WHERE discord_id=$1',[discordId]);
        if (r.rowCount && r.rows[0].is_staff_tag) return r.rows[0];
        const pref = member ? preferredSegmentFor(member) : null;
        const n = await allocateStaffTag(db, discordId, pref);
        await db.query(
          `INSERT INTO discord_tags.user_tags(discord_id, tag_number, is_staff_tag)
           VALUES ($1,$2,TRUE)
           ON CONFLICT (discord_id) DO UPDATE SET tag_number=EXCLUDED.tag_number, is_staff_tag=TRUE`,
          [discordId, n]
        );
        return { tag_number:n, is_staff_tag:true };
      } catch(e){ if (String(e.code)==='23505') continue; throw e; }
    }
    throw new Error('Falha a alocar tag staff após várias tentativas');
  });
}

async function getOrCreatePublicTag(discordId){
  return withConn(async (db) => {
    const r = await db.query('SELECT tag_number, is_staff_tag FROM discord_tags.user_tags WHERE discord_id=$1',[discordId]);
    if (r.rowCount) return r.rows[0];
    const { rows } = await db.query(`SELECT tag_number FROM discord_tags.user_tags WHERE tag_number >= 100 ORDER BY tag_number`);
    let n = 100; for (const row of rows){ const t = Number(row.tag_number); if (t>n) break; if (t===n) n++; }
    await db.query(
      `INSERT INTO discord_tags.user_tags(discord_id, tag_number, is_staff_tag)
       VALUES ($1,$2,FALSE)
       ON CONFLICT (discord_id) DO UPDATE SET tag_number=EXCLUDED.tag_number, is_staff_tag=FALSE`,
      [discordId, n]
    );
    return { tag_number:n, is_staff_tag:false };
  });
}

async function ensureOwnerReservedTag(guild){
  try{ const owner = await guild.fetchOwner(); await ensureStaffTag(owner.id, owner); }
  catch(e){ console.error('ensureOwnerReservedTag:', e?.message||e); }
}

/* ===== Nicknames ===== */
async function applyNickname(member, tagNumber){
  const prefix = makePrefix(tagNumber);
  const base = stripPrefix(member.nickname || member.user.username);
  const nick = `${prefix} ${base}`.slice(0,32);
  await member.setNickname(nick);
}
async function resetNickname(member){ await member.setNickname(null); }

/* ===== Scan ===== */
async function scanGuild(guild){
  await guild.members.fetch();
  const out = { missingManageable: [], missingUnmanageable: [] };
  let ownerHasTag = false;
  try{
    const r = await withConn(db => db.query('SELECT 1 FROM discord_tags.user_tags WHERE discord_id=$1 LIMIT 1',[guild.ownerId]));
    ownerHasTag = !!r.rowCount;
  } catch{}
  guild.members.cache.forEach(m => {
    if (m.user.bot) return;
    const hasPrefix = /^\s*[\[(]\s*\d+\s*[\])]\s*/.test(m.nickname || '');
    if (m.id === guild.ownerId){ if (!hasPrefix && !ownerHasTag) out.missingUnmanageable.push(m); return; }
    if (!hasPrefix){ if (m.manageable) out.missingManageable.push(m); else out.missingUnmanageable.push(m); }
  });
  return out;
}

async function getGuildSafe(i){ if (i?.guild) return i.guild; const cached = client.guilds.cache.get(GUILD_ID); if (cached) return cached; try { return await client.guilds.fetch(GUILD_ID); } catch { return null; } }

/* ===== Estado do assistente /comunicado ===== */
const commState = new Map(); // userId -> { guildId, sourceChannelId, step, type, imageUrl, text, targetChannelId, createdAt }
const COMM_TIMEOUT_MS = 5*60*1000;
function clearComm(uid){ commState.delete(uid); }
function getState(uid){ const s = commState.get(uid); if (!s) return null; if (Date.now()-s.createdAt>COMM_TIMEOUT_MS){ commState.delete(uid); return null; } return s; }

/* ===== Ready ===== */
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
    await db.query(`DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_user_tags_tag') THEN ALTER TABLE discord_tags.user_tags ADD CONSTRAINT uq_user_tags_tag UNIQUE(tag_number); END IF; END$$;`);
    await db.query(`CREATE OR REPLACE FUNCTION discord_tags.touch_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await db.query(`DROP TRIGGER IF EXISTS tg_user_tags_updated ON discord_tags.user_tags`);
    await db.query(`CREATE TRIGGER tg_user_tags_updated BEFORE UPDATE ON discord_tags.user_tags FOR EACH ROW EXECUTE FUNCTION discord_tags.touch_updated_at()`);
  });
  for (const [id,g] of client.guilds.cache){ if (!GUILD_ID || id===GUILD_ID) await ensureOwnerReservedTag(g).catch(()=>{}); }
});

/* ===== On Join ===== */
client.on(Events.GuildMemberAdd, async (member) => {
  if (GUILD_ID && member.guild.id !== GUILD_ID) return;
  try{
    if (isStaffMember(member)){
      const tag = await ensureStaffTag(member.id, member);
      if (member.manageable && member.id !== member.guild.ownerId) await applyNickname(member, tag.tag_number);
    } else {
      const tag = await getOrCreatePublicTag(member.id);
      if (member.manageable && member.id !== member.guild.ownerId) await applyNickname(member, tag.tag_number);
    }
  } catch(e){ console.error('GuildMemberAdd erro:', e?.message||e); }
});

/* ===== Interactions ===== */
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() && !i.isButton() && !i.isChannelSelectMenu() && !i.isModalSubmit()) return;

  // 🔒 Guard global: apenas admins
  if (i.guild && !isAdmin(i.member)) {
    return i.reply({ ephemeral: true, content: 'Apenas administradores podem usar estes comandos.' }).catch(()=>{});
  }

  // ----- /verificar
  if (i.isChatInputCommand() && i.commandName === 'verificar') {
    const guild = await getGuildSafe(i); if (!guild) return i.reply({ ephemeral:true, content:'Config inválida: GUILD_ID.' });
    await ensureOwnerReservedTag(guild);
    const { missingManageable, missingUnmanageable } = await scanGuild(guild);
    const list = arr => arr.slice(0,15).map(m=>`• ${m.user.tag}`).join('\n') || '—';
    const txt = `Faltam aplicar: ${missingManageable.length + missingUnmanageable.length}\n`+
      `• Geríveis pelo bot: ${missingManageable.length}\n${list(missingManageable)}\n\n`+
      `• Não geríveis: ${missingUnmanageable.length}\n${list(missingUnmanageable)}\n`+
      `\nNota: o owner tem sempre número reservado na BD (nick pode não ser alterável).`;
    const btn = new ButtonBuilder().setCustomId('apply_all').setLabel('Aplicar agora').setStyle(ButtonStyle.Primary);
    return i.reply({ ephemeral:true, content:txt, components: missingManageable.length ? [new ActionRowBuilder().addComponents(btn)] : [] });
  }

  // ----- /reset
  if (i.isChatInputCommand() && i.commandName === 'reset') {
    await i.deferReply({ ephemeral:true });
    const targetUser = i.options.getUser('user');
    const scope = i.options.getString('scope') || 'all';
    const onlyWithPrefix = i.options.getBoolean('only_with_prefix') || false;
    const guild = await getGuildSafe(i); if (!guild) return i.editReply('Config inválida: GUILD_ID.');
    await guild.members.fetch();
    let candidates = [];
    if (targetUser){ const m = await guild.members.fetch(targetUser.id).catch(()=>null); if (m && !m.user.bot) candidates=[m]; }
    else {
      candidates = Array.from(guild.members.cache.values()).filter(m=>!m.user.bot);
      if (scope==='staff') candidates = candidates.filter(isStaffMember);
      if (scope==='nao-staff') candidates = candidates.filter(m=>!isStaffMember(m));
    }
    if (onlyWithPrefix) candidates = candidates.filter(m => /^\s*[\[(]\s*\d+\s*[\])]\s*/.test(m.nickname || ''));
    let ok=0, fails=[];
    for (const m of candidates){
      if (!m.manageable || m.id === guild.ownerId){ fails.push(`${m.user.tag}: não gerível`); continue; }
      try{ await resetNickname(m); ok++; } catch(e){ fails.push(`${m.user.tag}: ${e?.message||e}`); }
      await new Promise(r=>setTimeout(r,200));
    }
    return i.editReply(`Nicknames restaurados: ${ok}${fails.length?`\nFalhou em ${fails.length}:\n${fails.slice(0,8).join('\n')}${fails.length>8?'\n...':''}`:''}`);
  }

  // ----- /aplicar & /aplicarstaff
  if (i.isChatInputCommand() && (i.commandName==='aplicar' || i.commandName==='aplicarstaff')){
    const onlyStaff = i.commandName === 'aplicarstaff';
    await i.deferReply({ ephemeral:true });
    const guild = await getGuildSafe(i); if (!guild) return i.editReply('Config inválida: GUILD_ID.');
    await ensureOwnerReservedTag(guild);
    await guild.members.fetch();
    let applied=0, fails=[];
    for (const m of guild.members.cache.values()){
      if (m.user.bot) continue; const staff = isStaffMember(m);
      if (onlyStaff && !staff) continue; if (!onlyStaff && staff) continue;
      try{
        if (staff){ const tag = await ensureStaffTag(m.id, m); if (m.manageable && m.id !== guild.ownerId) await applyNickname(m, tag.tag_number); }
        else { const tag = await getOrCreatePublicTag(m.id); if (m.manageable) await applyNickname(m, tag.tag_number); }
        applied++;
      }catch(e){ fails.push(`${m.user.tag}: ${e?.message||e}`); }
      await new Promise(r=>setTimeout(r,200));
    }
    return i.editReply(`Aplicado a ${applied} membro(s) (${onlyStaff?'staff':'não-staff'}).${fails.length?`\nFalhou em ${fails.length}:\n${fails.slice(0,8).join('\n')}${fails.length>8?'\n...':''}`:''}`);
  }

  // ----- /staff
  if (i.isChatInputCommand() && i.commandName==='staff'){
    const user = i.options.getUser('user', true); const role = i.options.getRole('cargo', true);
    const guild = await getGuildSafe(i); if (!guild) return i.reply({ ephemeral:true, content:'Config inválida (GUILD_ID).' });
    const member = await guild.members.fetch(user.id).catch(()=>null); if (!member) return i.reply({ ephemeral:true, content:'Utilizador não encontrado.' });
    await member.roles.add(role).catch(()=>{});
    const tag = await ensureStaffTag(member.id, member);
    if (member.manageable && member.id !== member.guild.ownerId) await applyNickname(member, tag.tag_number).catch(()=>{});
    return i.reply({ ephemeral:true, content:`Cargo atribuído. Tag: ${makePrefix(tag.tag_number)} (nick pode não mudar se não for gerível).` });
  }

  // ----- /corrigir
  if (i.isChatInputCommand() && i.commandName==='corrigir'){
    await i.deferReply({ ephemeral:true });
    const user = i.options.getUser('user', true); const numero = i.options.getInteger('numero', true); const force = i.options.getBoolean('force') || false;
    const guild = await getGuildSafe(i); if (!guild) return i.editReply('Config inválida (GUILD_ID).');
    const member = await guild.members.fetch(user.id).catch(()=>null); if (!member) return i.editReply('Utilizador não encontrado.');
    const wantStaff = numero < 100; if (wantStaff && !isStaffMember(member) && !force) return i.editReply('Número <100 é reservado a staff. Usa `force: true` para forçar.');
    const existing = await withConn(db => db.query('SELECT discord_id FROM discord_tags.user_tags WHERE tag_number=$1',[numero]));
    if (existing.rowCount && existing.rows[0].discord_id !== member.id) return i.editReply('Esse número já está atribuído a outra pessoa.');
    await withConn(db => db.query(
      `INSERT INTO discord_tags.user_tags(discord_id, tag_number, is_staff_tag)
       VALUES ($1,$2,$3)
       ON CONFLICT (discord_id) DO UPDATE SET tag_number=EXCLUDED.tag_number, is_staff_tag=EXCLUDED.is_staff_tag`,
       [member.id, numero, wantStaff]
    ));
    let nickInfo = 'nick não alterado (não gerível ou owner).';
    if (member.manageable && member.id !== guild.ownerId){ try { await applyNickname(member, numero); nickInfo = 'nick atualizado.'; } catch{} }
    return i.editReply(`Tag corrigida para ${makePrefix(numero)} — ${nickInfo}`);
  }

  // ----- /comunicado (assistente único)
  if (i.isChatInputCommand() && i.commandName==='comunicado'){
    if (!canSendComms(i)) return i.reply({ ephemeral:true, content:'Sem permissão (Manage Guild ou Manage Messages).' });
    commState.set(i.user.id, { guildId:i.guildId, sourceChannelId:i.channelId, step:'choose_type', createdAt:Date.now() });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('comm_type:comunicado').setLabel('Comunicado').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('comm_type:informacoes').setLabel('Informação').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('comm_type:custom').setLabel('Custom').setStyle(ButtonStyle.Secondary),
    );
    return i.reply({ ephemeral:true, content:'Que tipo de comunicado queres fazer? Escolhe abaixo.', components:[row] });
  }

  // tipo
  if (i.isButton() && i.customId.startsWith('comm_type:')){
    const s = getState(i.user.id); if (!s || s.guildId !== i.guildId) return i.reply({ ephemeral:true, content:'Sessão expirada. Usa /comunicado novamente.' });
    const type = i.customId.split(':')[1]; s.type = type;
    if (type==='comunicado') s.imageUrl = 'https://i.imgur.com/X71MaK6.png';
    if (type==='informacoes') s.imageUrl = 'https://i.imgur.com/Nhle8lf.png';
    if (type==='custom'){
      const modal = new ModalBuilder().setCustomId('comm_image_modal').setTitle('Imagem do comunicado');
      const input = new TextInputBuilder().setCustomId('img').setLabel('Link da imagem (https://...)').setStyle(TextInputStyle.Short).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return i.showModal(modal);
    }
    s.step='await_text'; s.createdAt=Date.now();
    return i.reply({ ephemeral:true, content:'Ok! **Escreve a mensagem nesta sala** e carrega Enter. Vou captar o próximo texto que enviares.' });
  }

  // modal imagem
  if (i.isModalSubmit() && i.customId==='comm_image_modal'){
    const s = getState(i.user.id); if (!s) return i.reply({ ephemeral:true, content:'Sessão expirada. Usa /comunicado novamente.' });
    const url = i.fields.getTextInputValue('img').trim(); if (!/^https?:\/\//i.test(url)) return i.reply({ ephemeral:true, content:'URL inválido. Tem de começar por http(s)://' });
    s.imageUrl = url; s.step='await_text'; s.createdAt=Date.now();
    return i.reply({ ephemeral:true, content:'Imagem definida. **Escreve a mensagem nesta sala** e carrega Enter. Vou captar o próximo texto que enviares.' });
  }

  // selecionar canal
  if (i.isChannelSelectMenu() && i.customId==='comm_pick_channel'){
    const s = getState(i.user.id); if (!s) return i.reply({ ephemeral:true, content:'Sessão expirada. Usa /comunicado novamente.' });
    const ch = i.channels.first(); s.targetChannelId = ch.id; return i.reply({ ephemeral:true, content:`Destino selecionado: ${ch}` });
  }

  // confirmar/cancelar
  if (i.isButton() && (i.customId==='comm_confirm' || i.customId==='comm_cancel')){
    const s = getState(i.user.id); if (!s) return i.reply({ ephemeral:true, content:'Sessão expirada. Usa /comunicado novamente.' });
    if (i.customId==='comm_cancel'){ clearComm(i.user.id); return i.reply({ ephemeral:true, content:'Cancelado ✅' }); }
    if (!s.targetChannelId) return i.reply({ ephemeral:true, content:'Escolhe primeiro a **sala** (menu acima).' });
    const guild = await getGuildSafe(i); const ch = await guild.channels.fetch(s.targetChannelId).catch(()=>null);
    if (!ch || ch.type !== ChannelType.GuildText) return i.reply({ ephemeral:true, content:'Sala inválida.' });
    const embed = new EmbedBuilder().setDescription(s.text).setImage(s.imageUrl).setTimestamp();
    try{ const msg = await ch.send({ embeds:[embed], allowedMentions:{ parse: [] } }); clearComm(i.user.id); return i.reply({ ephemeral:true, content:`Enviado em ${ch} • [abrir mensagem](${msg.url})` }); }
    catch(e){ return i.reply({ ephemeral:true, content:`Falha a enviar: ${e?.message||e}` }); }
  }

  // botão aplicar tudo
  if (i.isButton() && i.customId==='apply_all'){
    await i.deferReply({ ephemeral:true });
    const guild = await getGuildSafe(i); if (!guild) return i.editReply('Config inválida (GUILD_ID).');
    const { missingManageable } = await scanGuild(guild);
    let applied=0, fails=[];
    for (const m of missingManageable){
      try{
        if (isStaffMember(m)){ const tag = await ensureStaffTag(m.id, m); if (m.manageable && m.id !== guild.ownerId) await applyNickname(m, tag.tag_number); }
        else { const tag = await getOrCreatePublicTag(m.id); if (m.manageable) await applyNickname(m, tag.tag_number); }
        applied++;
      }catch(e){ fails.push(`${m.user.tag}: ${e?.message||e}`); }
      await new Promise(r=>setTimeout(r,200));
    }
    await i.editReply(`Aplicado a ${applied} membros em falta.${fails.length?`\nFalhou em ${fails.length}:\n${fails.slice(0,8).join('\n')}${fails.length>8?'\n...':''}`:''}`);
  }
});

/* ===== Captura do próximo texto (para /comunicado) ===== */
client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot) return;
  const s = getState(m.author.id); if (!s) return;
  if (s.guildId !== m.guildId || s.sourceChannelId !== m.channelId) return;
  if (s.step !== 'await_text') return;
  // apenas admins devem conseguir prosseguir (defensivo)
  const member = await m.guild.members.fetch(m.author.id).catch(()=>null);
  if (!isAdmin(member)) return;

  s.text = formatInput(m.content.trim()); s.step='preview'; s.createdAt=Date.now();
  const embed = new EmbedBuilder().setDescription(s.text).setImage(s.imageUrl).setTimestamp();
  const rowSelect = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('comm_pick_channel').setPlaceholder('Escolhe a sala de destino…').addChannelTypes(ChannelType.GuildText)
  );
  const rowBtns = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('comm_confirm').setLabel('Enviar').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('comm_cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
  );
  try{ await m.reply({ content:'Pré-visualização (só tu vês este aviso). Escolhe a sala e clica **Enviar**.', embeds:[embed], components:[rowSelect,rowBtns], allowedMentions:{ parse: [] } }); } catch{}
});

client.login(process.env.DISCORD_TOKEN);
