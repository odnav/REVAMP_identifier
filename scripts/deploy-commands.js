// scripts/deploy-commands.js
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

// --- Definição dos comandos (admin-only) ---
const raw = [
  // Painel do fluxo de MR & Deploy
  new SlashCommandBuilder()
    .setName('setup-deploy')
    .setDescription('Publica o painel de MR & Deploy nesta sala (apenas utilizadores autorizados).'),

  new SlashCommandBuilder()
    .setName('verificar')
    .setDescription('Verifica quem não tem tag aplicada (distingue geríveis e não geríveis).'),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Limpa nickname (volta ao nome original do Discord).')
    .addUserOption(o => o.setName('user').setDescription('Utilizador alvo (opcional)').setRequired(false))
    .addStringOption(o =>
      o.setName('scope')
       .setDescription('Âmbito: all/staff/nao-staff')
       .addChoices(
         { name: 'all', value: 'all' },
         { name: 'staff', value: 'staff' },
         { name: 'nao-staff', value: 'nao-staff' }
       )
       .setRequired(false)
    )
    .addBooleanOption(o =>
      o.setName('only_with_prefix')
       .setDescription('Só quem tem prefixo [N]')
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('aplicar')
    .setDescription('Aplica tags apenas a NÃO-staff.'),

  new SlashCommandBuilder()
    .setName('aplicarstaff')
    .setDescription('Aplica tags apenas a STAFF (por segmentos).'),

  new SlashCommandBuilder()
    .setName('staff')
    .setDescription('Atribui cargo a um utilizador e garante tag < 100 se necessário.')
    .addUserOption(o => o.setName('user').setDescription('Utilizador').setRequired(true))
    .addRoleOption(o => o.setName('cargo').setDescription('Cargo a atribuir').setRequired(true)),

  new SlashCommandBuilder()
    .setName('corrigir')
    .setDescription('Corrige a tag numérica de um utilizador.')
    .addUserOption(o => o.setName('user').setDescription('Utilizador').setRequired(true))
    .addIntegerOption(o => o.setName('numero').setDescription('Novo número da tag').setRequired(true).setMinValue(1))
    .addBooleanOption(o => o.setName('force').setDescription('Forçar <100 mesmo se não for staff').setRequired(false)),

  // Fluxo interativo único (comunicado)
  new SlashCommandBuilder()
    .setName('comunicado')
    .setDescription('Assistente para enviar Comunicado/Informação/Custom com pré-visualização.')
];

// 🔒 Admin-only e sem DM
const commands = raw.map(cmd =>
  cmd
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .toJSON()
);

// --- Deploy dos comandos ---
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

try {
  // Usa GUILD_ID para registo rápido a nível de guild
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Comandos registados (guild, admins apenas).');
} catch (err) {
  console.error('❌ Falha ao registar comandos:', err);
  process.exit(1);
}
