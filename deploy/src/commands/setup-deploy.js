// commands/setup-deploy.js
import { SlashCommandBuilder } from 'discord.js';
import { postInitialPanel } from '../handlers/deployFlow.js';

export const data = new SlashCommandBuilder()
  .setName('setup-deploy')
  .setDescription('Publica o painel de MR & Deploy nesta sala (apenas utilizadores autorizados).');

export async function execute(interaction) {
  const allowed = (process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(interaction.user.id)) {
    return interaction.reply({ content: '🚫 Não tens permissões.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  await postInitialPanel(interaction.channel);
  await interaction.editReply('✅ Painel publicado/atualizado.');
}
