import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('verificar')
    .setDescription('Verifica quem não tem tag aplicada (distingue geríveis e não geríveis).'),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Limpa nickname (volta ao nome original do Discord).')
    .addUserOption(o =>
      o.setName('user').setDescription('Utilizador alvo (opcional)').setRequired(false)
    )
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
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.GUILD_ID),
  { body: commands }
);

console.log('✓ Comandos registados');
