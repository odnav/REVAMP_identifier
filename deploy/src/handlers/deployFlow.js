// handlers/deployFlow.js
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { Octokit } from '@octokit/rest';
import { NodeSSH } from 'node-ssh';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const allowedUserIds = (process.env.ALLOWED_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const deployChannelId   = process.env.DEPLOY_CHANNEL_ID;
const adminLogChannelId = process.env.ADMIN_LOG_CHANNEL_ID;
const notifyUserId      = process.env.DEPLOY_NOTIFY_USER_ID;
const dryRun            = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';

const owner       = process.env.GITHUB_OWNER;
const repo        = process.env.GITHUB_REPO;
const baseBranch  = process.env.MAIN_BRANCH || 'main';
const headBranch  = process.env.DEV_BRANCH  || 'dev';
const mergeMethod = (process.env.MERGE_METHOD || 'squash').toLowerCase(); // merge|squash|rebase

// Versão / info.json
const VERSION_FILE_PATH = process.env.VERSION_FILE_PATH || (
  process.env.DEPLOY_PATH ? `${process.env.DEPLOY_PATH.replace(/\/$/, '')}/config/version.cfg` : null
);
const INFO_JSON_PATH          = process.env.INFO_JSON_PATH;        // e.g., /opt/fivem/server-data/info.json
const INFO_JSON_KEY           = process.env.INFO_JSON_KEY || 'git_sha';
const INFO_JSON_POLL_INTERVAL = parseInt(process.env.INFO_JSON_POLL_INTERVAL_MS || '5000', 10);
const INFO_JSON_POLL_TIMEOUT  = parseInt(process.env.INFO_JSON_POLL_TIMEOUT_MS  || '240000', 10);

// ---------- utils ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

function isAllowed(interaction) {
  return allowedUserIds.includes(interaction.user.id);
}
function isRightChannel(interaction) {
  return !deployChannelId || interaction.channelId === deployChannelId;
}
async function logAdmin(client, msg) {
  if (!adminLogChannelId) return;
  try {
    const ch = await client.channels.fetch(adminLogChannelId);
    await ch.send(msg);
  } catch {}
}

// ---------- UI ----------
function homeButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('DEPLOY_CREATE_MR')
      .setLabel('🧩 Criar MR DEV → main')
      .setStyle(ButtonStyle.Primary)
  );
}
function confirmButtons(prNumber) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`DEPLOY_MERGE_${b64({ pr: prNumber })}`)
      .setLabel('✅ Fazer merge')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('DEPLOY_CANCEL')
      .setLabel('❌ Cancelar')
      .setStyle(ButtonStyle.Danger)
  );
}

// ---------- GitHub helpers ----------
async function ensurePullRequest() {
  const prs = await octokit.pulls.list({
    owner, repo, state: 'open', base: baseBranch, head: `${owner}:${headBranch}`
  });
  if (prs.data.length) return prs.data[0];
  const pr = await octokit.pulls.create({
    owner, repo, title: `Merge ${headBranch} → ${baseBranch}`,
    head: headBranch, base: baseBranch, body: 'Merge iniciado via Discord.'
  });
  return pr.data;
}
async function getCompare() {
  const { data } = await octokit.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${baseBranch}...${headBranch}`
  });
  return data;
}
async function mergePR(prNumber) {
  const { data } = await octokit.pulls.merge({
    owner, repo, pull_number: prNumber, merge_method: mergeMethod
  });
  return data; // { merged, sha, message }
}

// ---------- SSH ----------
function sshConnectParams() {
  const host = process.env.DEPLOY_HOST;
  const port = parseInt(process.env.DEPLOY_PORT || '22', 10);
  const username = process.env.DEPLOY_USER;
  const params = { host, port, username };
  if (process.env.SSH_PRIVATE_KEY_PATH) params.privateKey = process.env.SSH_PRIVATE_KEY_PATH;
  if (process.env.SSH_PASSWORD)        params.password  = process.env.SSH_PASSWORD;
  return params;
}
function deployCommands() {
  const cwd    = process.env.DEPLOY_PATH;
  const remote = process.env.DEPLOY_GIT_REMOTE || 'origin';
  const branch = process.env.DEPLOY_GIT_BRANCH || 'main';
  if (!cwd) throw new Error('DEPLOY_PATH em falta');
  return [
    `cd ${cwd}`,
    `git fetch --all --prune`,
    `git checkout ${branch}`,
    `git reset --hard ${remote}/${branch}`,
    `git pull --ff-only ${remote} ${branch}`
  ].join(' && ');
}
async function runSSH(cmd) {
  if (dryRun) return { code: 0, stdout: `[DRY-RUN] ${cmd}`, stderr: '' };
  const ssh = new NodeSSH();
  await ssh.connect(sshConnectParams());
  const res = await ssh.execCommand(cmd);
  await ssh.dispose();
  return res;
}
async function writeVersionCfg(sha) {
  if (!VERSION_FILE_PATH) throw new Error('VERSION_FILE_PATH não definido.');
  const now = new Date().toISOString();
  const content = `version=${sha}\ndate=${now}\n`;
  const cmd = `printf %s ${JSON.stringify(content)} > ${VERSION_FILE_PATH}`;
  return runSSH(cmd);
}
async function readInfoJson() {
  if (!INFO_JSON_PATH) throw new Error('INFO_JSON_PATH não definido.');
  const cmd = `cat ${INFO_JSON_PATH}`;
  const res = await runSSH(cmd);
  if (res.code !== 0) throw new Error(res.stderr || 'Falha ao ler info.json');
  let json;
  try { json = JSON.parse(res.stdout); } catch {
    throw new Error('Conteúdo de info.json não é JSON válido.');
  }
  return json;
}
function versionMatches(json, expectSha) {
  const v = (json?.[INFO_JSON_KEY] || '').toString();
  return !!v && v.startsWith(expectSha.substring(0, 7));
}

// ---------- Painel inicial ----------
export async function postInitialPanel(channel) {
  const embed = new EmbedBuilder()
    .setTitle('REVAMP • MR & Deploy (sem restart automático)')
    .setDescription(`Fluxo: **DEV → main** → Pull por SSH → *restart manual no txAdmin* → Validação.${dryRun ? '\n🧪 *DRY-RUN ATIVO*' : ''}`)
    .setColor(0x5865F2);
  return channel.send({ embeds: [embed], components: [homeButtons()] });
}

// ---------- Handler ----------
export async function handleInteraction(interaction) {
  if (!interaction.isButton()) return;

  if (!isAllowed(interaction)) {
    return interaction.reply({ content: '🚫 Sem permissões.', ephemeral: true });
  }
  if (!isRightChannel(interaction)) {
    return interaction.reply({ content: '⚠️ Usa este fluxo na sala configurada.', ephemeral: true });
  }

  // 1) Criar MR
  if (interaction.customId === 'DEPLOY_CREATE_MR') {
    await interaction.deferUpdate();
    const compare = await getCompare();
    const lines = compare.commits.map(c =>
      `• \`${c.sha.substring(0,7)}\` ${c.commit.message.split('\n')[0]} — _${c.commit.author?.name || 'autor'}_`
    );
    const limited = lines.slice(-20);
    const emb = new EmbedBuilder()
      .setTitle('Commits a entrar (DEV → main)')
      .setDescription(limited.length ? limited.join('\n') : 'Sem diferenças.')
      .setFooter({ text: `Total: ${compare.total_commits}` })
      .setColor(0xFAA81A);
    const pr = await ensurePullRequest();
    await logAdmin(interaction.client, `🧩 PR garantido/criado #${pr.number} ${headBranch} → ${baseBranch} por <@${interaction.user.id}>`);
    await interaction.editReply({ embeds: [emb], components: [confirmButtons(pr.number)] });
    return;
  }

  // 2) Merge
  if (interaction.customId.startsWith('DEPLOY_MERGE_')) {
    const { pr } = unb64(interaction.customId.replace('DEPLOY_MERGE_', ''));
    await interaction.deferUpdate();

    const res = await mergePR(pr);
    if (!res.merged) {
      await logAdmin(interaction.client, `❌ Merge falhou PR #${pr}: ${res.message || 'erro'}`);
      return interaction.editReply({ content: '❌ Merge não efetuado (conflitos/permissões).', embeds: [], components: [homeButtons()] });
    }

    const emb = new EmbedBuilder()
      .setTitle('Merge concluído ✅')
      .setDescription(`PR #${pr} unido. Commit final: \`${(res.sha || '').substring(0,7)}\``)
      .setColor(0x57F287);

    await logAdmin(interaction.client, `✅ Merge concluído PR #${pr} → SHA ${res.sha?.substring(0,7)}`);

    // 3) PULL por SSH (sem restart) + escrever version.cfg com o SHA
    const cmd = deployCommands();
    const pullRes = await runSSH(cmd);
    if (pullRes.code !== 0) {
      const msg = `❌ Pull falhou: ${pullRes.stderr || 'sem stderr'}`;
      await logAdmin(interaction.client, `🚨 ${msg}`);
      await interaction.editReply({ content: msg, embeds: [], components: [homeButtons()] });
      if (notifyUserId) { try { await interaction.client.users.send(notifyUserId, `🚨 ${msg}`); } catch {} }
      return;
    }

    let versionMsg = 'ℹ️ version.cfg não escrito (caminho não configurado).';
    if (VERSION_FILE_PATH) {
      try {
        const r = await writeVersionCfg(res.sha);
        if (r.code !== 0) throw new Error(r.stderr || 'erro');
        versionMsg = `✍️ version.cfg atualizado em \`${VERSION_FILE_PATH}\` com \`${res.sha.substring(0,7)}\`.`;
        await logAdmin(interaction.client, `✍️ version.cfg escrito com ${res.sha.substring(0,7)} por <@${interaction.user.id}>`);
      } catch (e) {
        versionMsg = `⚠️ Falha a escrever version.cfg: ${e.message}`;
      }
    }

    const emb2 = new EmbedBuilder()
      .setTitle(dryRun ? 'Dry-run (pull não executado)' : 'Ficheiros atualizados 📦')
      .setDescription(
        `${versionMsg}\n\nAgora faz **restart manual** no **txAdmin**.\n` +
        `Depois, clica em **“✅ Já reiniciei no txAdmin”** para eu validar o \`info.json\` com o SHA esperado.`
      )
      .addFields({ name: 'Output (pull)', value: '```\n' + (pullRes.stdout || '').slice(0, 1500) + '\n```' })
      .setColor(0x5865F2);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`DEPLOY_CONFIRM_RESTART_${b64({ expect: res.sha })}`)
        .setLabel('✅ Já reiniciei no txAdmin')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('DEPLOY_CANCEL')
        .setLabel('❌ Cancelar')
        .setStyle(ButtonStyle.Danger),
    );

    await logAdmin(interaction.client, `📦 Pull concluído por <@${interaction.user.id}> (SHA ${res.sha.substring(0,7)})`);
    await interaction.editReply({ embeds: [emb, emb2], components: [row] });
    return;
  }

  if (interaction.customId === 'DEPLOY_CANCEL') {
    await interaction.update({ content: 'Operação cancelada. 👌', embeds: [], components: [homeButtons()] });
    return;
  }

  // 4) Confirmar restart → esperar info.json corresponder; se falhar, avisar
  if (interaction.customId.startsWith('DEPLOY_CONFIRM_RESTART_')) {
    const { expect } = unb64(interaction.customId.replace('DEPLOY_CONFIRM_RESTART_', ''));
    await interaction.deferUpdate();

    if (!INFO_JSON_PATH) {
      await logAdmin(interaction.client, `♻️ Restart confirmado, mas INFO_JSON_PATH não está definido.`);
      const flowId = Date.now().toString(36);
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Restart manual confirmado ♻️')
            .setDescription('⚠️ Não foi possível validar info.json (caminho não configurado). Continua para validação.')
            .setColor(0xFAA81A)
        ],
        components: [validationButtons(flowId)]
      });
    }

    const progress = new EmbedBuilder()
      .setTitle('A validar versão no info.json ⏳')
      .setDescription(`A aguardar que **${INFO_JSON_KEY}** em \`${INFO_JSON_PATH}\` corresponda a \`${expect.substring(0,7)}\`…`)
      .setColor(0x5865F2);
    await interaction.editReply({ embeds: [progress], components: [] });

    const start = Date.now();
    let ok = false, lastSeen = 'n/d', errorMsg = '';
    while (Date.now() - start < INFO_JSON_POLL_TIMEOUT) {
      try {
        const json = await readInfoJson();
        lastSeen = (json?.[INFO_JSON_KEY] || 'n/d').toString();
        if (versionMatches(json, expect)) { ok = true; break; }
      } catch (e) { errorMsg = e.message; }
      await new Promise(r => setTimeout(r, INFO_JSON_POLL_INTERVAL));
    }

    if (!ok) {
      const msg = `⚠️ Após o restart, o \`info.json\` **não** corresponde a \`${expect.substring(0,7)}\` (atual: \`${lastSeen}\`). ` +
                  `Isto indica que o **pull não funcionou corretamente** ou que o servidor ainda não carregou a nova versão.`;
      try { await interaction.user.send(`🚨 ${msg}`); } catch {}
      if (notifyUserId) { try { await interaction.client.users.send(notifyUserId, `🚨 ${msg}`); } catch {} }
      await logAdmin(interaction.client, `🚨 Validação falhou (esperado ${expect.substring(0,7)}, atual ${lastSeen}).`);
      return interaction.editReply({ content: msg, embeds: [], components: [homeButtons()] });
    }

    const flowId = Date.now().toString(36);
    await logAdmin(interaction.client, `✅ info.json OK para ${expect.substring(0,7)} após restart.`);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Versão confirmada ✅')
          .setDescription(`\`${INFO_JSON_KEY}\` em \`${INFO_JSON_PATH}\` corresponde a \`${expect.substring(0,7)}\`.`)
          .setColor(0x57F287)
      ],
      components: [validationButtons(flowId)]
    });
  }

  // 5) Validação
  if (interaction.customId.startsWith('DEPLOY_VALID_OK_')) {
    await logAdmin(interaction.client, `✅ Validação OK por <@${interaction.user.id}>`);
    await interaction.update({ content: '✅ Validado! Painel pronto para novo ciclo.', embeds: [], components: [homeButtons()] });
    return;
  }
  if (interaction.customId.startsWith('DEPLOY_VALID_FAIL_')) {
    await logAdmin(interaction.client, `❌ Validação FALHOU por <@${interaction.user.id}>`);
    if (notifyUserId) { try { await interaction.client.users.send(notifyUserId, '🚨 A validação do deploy foi marcada como **FALHOU**.'); } catch {} }
    await interaction.update({ content: '❌ Validação marcou falha. Responsável notificado.', embeds: [], components: [homeButtons()] });
    return;
  }
}

function validationButtons(flowId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`DEPLOY_VALID_OK_${b64({ flow: flowId })}`)
      .setLabel('✅ Validado')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`DEPLOY_VALID_FAIL_${b64({ flow: flowId })}`)
      .setLabel('❌ Falhou')
      .setStyle(ButtonStyle.Danger)
  );
}
